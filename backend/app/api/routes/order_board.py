"""The Order Board: which open sales orders can ship today.

Reading is one local read of the stored board. Refresh runs one bounded sync
pass against Zoho Books (GETs only). The settings routes are their own
endpoints, not the general settings API, because Operators hold
``settings:read`` only and must still be able to tune the board.
"""

import logging
import math
import time
from collections.abc import Awaitable
from dataclasses import asdict
from datetime import datetime
from typing import Literal, TypeVar

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.aito import _EMAIL_GUARD, _check_zoho_email_rate_limit, _email_guard_key_or_409
from backend.app.api.routes.aito_payments import _check_counter_payment_rate_limit, _heimdall_refusal, _refuse
from backend.app.core.auth import RequireAdminIfAuthEnabled, RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.models.order_board_event import OrderBoardEvent
from backend.app.models.user import User
from backend.app.schemas.aito import AitoNoteCreate, AitoPaymentLinkView, AitoTerminalPaymentView
from backend.app.services import aito_tracking, order_board_actions, order_board_sms, order_board_sync
from backend.app.services.aito_events import utc_now_naive
from backend.app.services.aito_payment_documents import DocumentMismatch, resolve_order_document
from backend.app.services.aito_payment_links import (
    InvoiceLinkExists,
    cancel_order_link,
    create_order_invoice_link,
    current_link,
    link_view,
)
from backend.app.services.aito_terminal_payments import (
    TerminalInProgress,
    current_terminal_payment,
    refresh_terminal_payment,
    start_order_terminal_payment,
    terminal_view,
)
from backend.app.services.heimdall import HeimdallNotConfigured, HeimdallRateLimited, HeimdallUpstreamError
from backend.app.services.order_board_actions._common import _log
from backend.app.services.order_board_events import kinds_for_depth, record
from backend.app.services.order_board_payment import order_contact, order_facts
from backend.app.services.order_board_prep_sheet import render_prep_sheet
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoUnreachable, ZohoUpstreamError, zoho_service
from backend.app.utils.http import build_content_disposition

logger = logging.getLogger(__name__)
_T = TypeVar("_T")
router = APIRouter(prefix="/order-board", tags=["order-board"])


class OrderBoardSettingsBody(BaseModel):
    sync_enabled: bool
    sync_minutes: Literal[5, 15, 60]
    max_age_days: int = Field(ge=0, le=3650)
    core_brands: list[str] = Field(max_length=30)

    @field_validator("core_brands")
    @classmethod
    def _clean_brands(cls, brands: list[str]) -> list[str]:
        cleaned: list[str] = []
        for brand in (b.strip() for b in brands):
            if not 1 <= len(brand) <= 60:
                raise ValueError("a brand must be 1 to 60 characters")
            if brand.casefold() not in {c.casefold() for c in cleaned}:
                cleaned.append(brand)
        return cleaned


@router.get("")
async def get_order_board(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    """The stored board, when it was computed, and the sync status."""
    return await order_board_sync.read_board(db)


@router.get("/finished")
async def get_finished_orders(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    """Shipped orders, newest first, from the stored list rows (no Zoho call)."""
    return await order_board_sync.read_finished(db)


@router.get("/finished/{salesorder_id}")
async def get_finished_order(
    salesorder_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    """One shipped order in full; fetched from Zoho the first time it is opened, then kept."""
    try:
        return await order_board_sync.read_finished_order(db, salesorder_id)
    except order_board_sync.OrderNotFinished:
        raise HTTPException(status_code=404, detail="Finished order not found.") from None
    except order_board_sync.ZohoBusy:
        raise HTTPException(status_code=503, detail="Zoho is busy, try again shortly.") from None
    except ZohoNotConfiguredError:
        raise HTTPException(status_code=503, detail="Zoho Books is not connected.") from None
    except ZohoUpstreamError as e:
        logger.warning("Finished order fetch failed (%s)", type(e).__name__)
        raise HTTPException(status_code=502, detail="Zoho Books did not answer.") from None


@router.post("/refresh")
async def refresh_order_board(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    """One bounded sync pass, then the board. A pass already running is left
    to finish; the caller gets the board as it stands."""
    await order_board_sync.run_pass(db)
    return await order_board_sync.read_board(db)


@router.get("/settings", response_model=OrderBoardSettingsBody)
async def get_order_board_settings(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    return asdict(await order_board_sync.load_settings(db))


@router.put("/settings", response_model=OrderBoardSettingsBody)
async def update_order_board_settings(
    body: OrderBoardSettingsBody,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    """Save the settings and rebuild the board from the local copy."""
    await order_board_sync.save_settings(db, order_board_sync.OrderBoardSettings(**body.model_dump()))
    return asdict(await order_board_sync.load_settings(db))


class ParcelLine(BaseModel):
    line_id: str = Field(min_length=1, max_length=64)
    quantity: float = Field(gt=0, allow_inf_nan=False)


def _no_duplicate_line_ids(lines: list) -> list:
    if len({line.line_id for line in lines}) != len(lines):
        raise ValueError("a line may appear only once")
    return lines


class ParcelBody(BaseModel):
    lines: list[ParcelLine] = Field(min_length=1, max_length=200)

    _no_duplicates = field_validator("lines")(_no_duplicate_line_ids)


class PackBody(ParcelBody):
    picklist_id: str = Field(min_length=1, max_length=64)


class EditLine(BaseModel):
    line_id: str | None = Field(default=None, min_length=1, max_length=64)
    item_id: str | None = Field(default=None, min_length=1, max_length=64)
    quantity: float = Field(gt=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def _one_target(self) -> "EditLine":
        if (self.line_id is None) == (self.item_id is None):
            raise ValueError("a line names exactly one of line_id or item_id")
        return self


class LinesBody(BaseModel):
    version: str = Field(max_length=64)
    lines: list[EditLine] = Field(min_length=1, max_length=200)

    @field_validator("lines")
    @classmethod
    def _no_duplicates(cls, lines: list[EditLine]) -> list[EditLine]:
        keys = [line.line_id or line.item_id for line in lines]
        if len(set(keys)) != len(keys):
            raise ValueError("a line may appear only once")
        return lines


class ParcelQty(BaseModel):
    line_id: str = Field(min_length=1, max_length=64)
    quantity: float = Field(ge=0, allow_inf_nan=False)


class ParcelEditBody(BaseModel):
    version: str = Field(max_length=64)
    was: list[ParcelLine] = Field(min_length=1, max_length=200)
    lines: list[ParcelQty] = Field(max_length=200)  # empty: the parcel is emptied

    _no_duplicates = field_validator("was", "lines")(_no_duplicate_line_ids)


class HandoverBody(BaseModel):
    mode: Literal["pickup", "delivery"]
    apply_credit: bool


class InvoiceBody(BaseModel):
    apply_credit: bool
    scope: Literal["shipped", "packed", "whole"] = "shipped"


class InvoiceEmailBody(BaseModel):
    to: str = Field(min_length=3, max_length=320)


async def _run(call: Awaitable[_T]) -> _T:
    """Await an order action and turn its failures into the statuses the board shows the operator."""
    try:
        return await call
    except (order_board_actions.OrderNotOnBoard, order_board_sync.OrderNotStored):
        raise HTTPException(status_code=404, detail="Order not found.") from None
    except order_board_actions.OrderActionRefused as e:
        raise HTTPException(status_code=400, detail=e.args[0]) from None
    except order_board_actions.OrderBusy:
        raise HTTPException(status_code=409, detail="Another action on this order is still running.") from None
    except order_board_sync.ZohoBusy:
        raise HTTPException(status_code=503, detail="Zoho is busy, try again shortly.") from None
    except ZohoNotConfiguredError:
        raise HTTPException(status_code=503, detail="Zoho Books is not connected.") from None
    except ZohoUpstreamError as e:
        # Books' message can name a customer or an item: the log keeps the step and the class only.
        logger.warning("Order board Zoho call failed: step=%s (%s)", getattr(call, "__name__", "?"), type(e).__name__)
        raise HTTPException(status_code=502, detail=str(e)[:300]) from None  # Books' own reason, for the operator


def _pdf(content: bytes, filename: str) -> Response:
    """Inline PDF with a fixed name; it holds customer data, so no cache keeps it."""
    return Response(
        content=content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": build_content_disposition(filename, disposition="inline"),
            "Cache-Control": "no-store",
        },
    )


def _by(user: User | None) -> str | None:
    return user.username if user else None


def _logged(user: User | None, salesorder_id: str, action: str) -> None:
    logger.info("Order board: user=%s order=%s action=%s", user.id if user else "-", salesorder_id, action)


class OrderEventResponse(BaseModel):
    id: int
    occurred_at: datetime
    kind: str
    actor_class: str
    actor_name: str | None
    changes: list[dict] | None
    detail: dict | None
    note: str | None

    model_config = {"from_attributes": True}


class OrderEventPage(BaseModel):
    events: list[OrderEventResponse]
    has_more: bool


async def _require_order(db: AsyncSession, salesorder_id: str) -> None:
    """On the board, or a stored finished order; anything else is unknown."""
    if await order_board_sync.find_board_row(db, salesorder_id) is not None:
        return
    stored = await db.execute(
        select(OrderBoardDoc.id).where(OrderBoardDoc.kind == "salesorder", OrderBoardDoc.zoho_id == salesorder_id)
    )
    if stored.first() is None:
        raise HTTPException(status_code=404, detail="Order not found.")


@router.get("/orders/{salesorder_id}/events", response_model=OrderEventPage)
async def list_order_events(
    salesorder_id: str,
    depth: Literal["story", "detail", "everything"] = "detail",
    before: int | None = None,
    before_at: datetime | None = None,
    limit: int = 50,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> OrderEventPage:
    """The order's timeline, newest first; the cursor is the pair (occurred_at, id), as on Aito."""
    await _require_order(db, salesorder_id)
    if (before is None) != (before_at is None):
        raise HTTPException(status_code=422, detail="The cursor needs both 'before' and 'before_at'")
    limit = max(1, min(limit, 200))
    query = (
        select(OrderBoardEvent)
        .where(OrderBoardEvent.salesorder_id == salesorder_id, OrderBoardEvent.kind.in_(kinds_for_depth(depth)))
        .order_by(OrderBoardEvent.occurred_at.desc(), OrderBoardEvent.id.desc())
        .limit(limit + 1)  # one extra row answers has_more without a count
    )
    if before is not None:
        query = query.where(
            or_(
                OrderBoardEvent.occurred_at < before_at,
                and_(OrderBoardEvent.occurred_at == before_at, OrderBoardEvent.id < before),
            )
        )
    rows = list((await db.execute(query)).scalars().all())
    return OrderEventPage(
        events=[OrderEventResponse.model_validate(r) for r in rows[:limit]], has_more=len(rows) > limit
    )


@router.post("/orders/{salesorder_id}/events", response_model=OrderEventResponse, status_code=201)
async def add_order_note(
    salesorder_id: str,
    payload: AitoNoteCreate,
    db: AsyncSession = Depends(get_db, scope="function"),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> OrderEventResponse:
    """Append a local note; kind and actor are fixed here so a client cannot fabricate other events."""
    await _require_order(db, salesorder_id)
    event = await record(
        db,
        salesorder_id,
        "note.added",
        actor_class="user",
        actor_name=current_user.username if current_user is not None else "Admin",
        note=payload.note,
    )
    await db.commit()
    await db.refresh(event)
    return OrderEventResponse.model_validate(event)


@router.post("/orders/{salesorder_id}/prep-sheet")
async def print_prep_sheet(
    salesorder_id: str,
    picklist_id: str | None = Query(default=None, min_length=1, max_length=64),
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> Response:
    """Stamp the order as printed and return its prep sheet: the units of one picklist, or everything packable."""
    content = await _run(order_board_actions.picklist_content(db, salesorder_id, picklist_id)) if picklist_id else None
    row = await _run(
        order_board_actions.stamp_print(
            db, salesorder_id, user.username if user else "", content["number"] if content else None
        )
    )
    base = await aito_tracking.external_url(db)
    pdf = render_prep_sheet(
        row,
        printed_at=datetime.now(),
        order_url=f"{base}/orders?order={salesorder_id}" if base else None,
        quantities={line["line_id"]: line["quantity"] for line in content["lines"]} if content else None,
        picklist_number=content["number"] if content else "",
    )
    _logged(user, salesorder_id, "prep_sheet")
    return _pdf(pdf, "bon-de-preparation.pdf")


@router.get("/orders/{salesorder_id}/sms-draft")
async def get_pickup_sms_draft(
    salesorder_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequireAdminIfAuthEnabled(),
) -> dict:
    """The pickup SMS text for this order, from a fixed template (no AI, no Zoho call). Admins only."""
    return await _run(order_board_sms.draft(db, salesorder_id))


class SmsSentBody(BaseModel):
    # The draft's payment link, sent only when the text that went out still holds its URL.
    payment_link_id: int | None = None


@router.post("/orders/{salesorder_id}/sms")
async def record_pickup_sms(
    salesorder_id: str,
    body: SmsSentBody | None = None,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequireAdminIfAuthEnabled(),
) -> dict:
    """Mark the order as contacted after the browser sent the pickup SMS through the relay on the
    operator's Mac (scripts/sms_relay_mac.py); the server never sends it. Admins only. Returns the row."""
    row = await _run(order_board_actions.stamp_contact(db, salesorder_id, _by(user) or ""))
    link = await db.get(AitoPaymentLink, body.payment_link_id) if body and body.payment_link_id else None
    if link is not None and link.salesorder_id == salesorder_id and link.heimdall_id and link.status == "pending":
        await _log(db, salesorder_id, "payment_link.sent", _by(user), amount=link.amount, document=link.document_number)
    _logged(user, salesorder_id, "pickup_sms")
    return row


# --- Payments: a payment link or the counter terminal, on the order's invoice or its quote's retainer ---------


class OrderPaymentBody(BaseModel):
    amount: int = Field(ge=1, le=999_999_999_999)


class OrderTerminalBody(OrderPaymentBody):
    # A pending payment link refuses the terminal (409 link_open) unless this asks to cancel it first.
    cancel_link: bool = False


class OrderPaymentLinkView(AitoPaymentLinkView):
    document_number: str | None


class OrderPaymentTarget(BaseModel):
    kind: Literal["invoice", "retainer", "quote"] | None
    document_id: str | None
    number: str | None
    max_amount: int | None
    left: float
    link: OrderPaymentLinkView | None


def _balance(doc: dict) -> float:
    try:
        return float(doc.get("balance") or 0)
    except (TypeError, ValueError):
        return 0.0


def _payable(docs: list[dict] | None) -> dict | None:
    """The newest document with something left to pay; void and draft ones cannot take a payment."""
    open_docs = [d for d in docs or [] if d.get("status") not in ("void", "draft") and _balance(d) > 0]
    return max(open_docs, key=lambda d: str(d.get("date") or ""), default=None)


async def _order_for_payment(db: AsyncSession, salesorder_id: str) -> tuple[dict, dict]:
    """The board row and the stored sales order; an order off the board takes no payment from here."""
    row = await order_board_sync.find_board_row(db, salesorder_id)
    doc = (await db.execute(order_board_sync._stored_query(salesorder_id))).scalar_one_or_none()
    if row is None or doc is None or not doc.detail:
        raise HTTPException(status_code=404, detail="Order not found.")
    return row, doc.detail


def _target(detail: dict, left: int | None) -> tuple[Literal["invoice", "retainer", "quote"], dict] | None:
    """Design §3: the newest invoice with a balance; else, for an order made from a quote, its open retainer; else
    that quote itself, as in Aito: Heimdall books the payment as a new retainer invoice on it. A quote has no balance
    of its own: it takes at most what the order has left to pay."""
    invoice = _payable(detail.get("invoices"))
    if invoice is not None:
        return "invoice", {**invoice, "id": invoice.get("invoice_id"), "number": invoice.get("invoice_number")}
    estimate_id = str(detail.get("estimate_id") or "")
    if estimate_id:
        retainer = _payable(detail.get("_retainers"))
        if retainer is not None:
            return "retainer", retainer
        if left:
            number = order_facts(detail)["quote_number"] or estimate_id
            return "quote", {"id": estimate_id, "number": number, "balance": left}
    return None


def _link_out(link: AitoPaymentLink | None) -> OrderPaymentLinkView | None:
    view = link_view(link)
    if view is None or link is None:
        return None
    return OrderPaymentLinkView(**view.model_dump(), document_number=link.document_number)


def _order_left(row: dict) -> int | None:
    """What is left to pay on the order, rounded like the dialogs' prefill; None for an order without a payment."""
    payment = row.get("payment")
    if not payment:
        return None
    return max(0, math.floor(_balance({"balance": payment.get("left")}) + 0.5))


async def _payment_document(db: AsyncSession, salesorder_id: str, amount: int):
    """The document a charge goes on, and the money guard: never more than its balance, nor than the order has left
    to pay (an invoice raised without drawing the quote's deposit has a balance above what the order still owes)."""
    row, detail = await _order_for_payment(db, salesorder_id)
    left = _order_left(row)
    if left is not None and amount > left:
        raise _refuse(422, "amount_above_left", f"Amount exceeds what is left to pay on the order ({left})")
    target = _target(detail, left)
    if target is None:
        raise _refuse(409, "no_document", "This order has no invoice or quote left to pay")
    kind, doc = target
    try:
        document = await resolve_order_document(db, detail, kind, str(doc.get("id") or ""))
    except DocumentMismatch as e:
        raise _refuse(422, "document_mismatch", str(e)) from e
    except (ZohoNotConfiguredError, ZohoUpstreamError) as e:
        raise _refuse(502, "upstream", str(e)) from e
    if document.balance is not None and amount > document.balance:
        raise _refuse(422, "amount_above_balance", f"Amount exceeds the balance of {document.balance}")
    return document


@router.get("/orders/{salesorder_id}/payment-target", response_model=OrderPaymentTarget)
async def get_payment_target(
    salesorder_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> OrderPaymentTarget:
    """What the payment buttons would charge (from the stored order, no Zoho call), and the order's current link."""
    row, detail = await _order_for_payment(db, salesorder_id)
    target = _target(detail, _order_left(row))
    link = _link_out(await current_link(db, ("order", salesorder_id), kind=None))
    left = float((row.get("payment") or {}).get("left") or 0)
    if target is None:
        return OrderPaymentTarget(kind=None, document_id=None, number=None, max_amount=None, left=left, link=link)
    kind, doc = target
    return OrderPaymentTarget(
        kind=kind,
        document_id=str(doc.get("id") or ""),
        number=str(doc.get("number") or doc.get("id") or ""),
        max_amount=int(round(_balance(doc))),
        left=left,
        link=link,
    )


@router.post("/orders/{salesorder_id}/payment-link", response_model=OrderPaymentLinkView)
async def create_order_payment_link(
    salesorder_id: str,
    body: OrderPaymentBody,
    request: Request,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> OrderPaymentLinkView:
    """An online payment link on the order's document. One link slot per order: a stranded reservation is
    replayed as it was (its document and amount, not this request's), so the answer says what it holds."""
    _check_counter_payment_rate_limit(request, user)
    document = await _payment_document(db, salesorder_id, body.amount)
    existing = await current_link(db, ("order", salesorder_id), kind=None)
    if existing is not None and existing.heimdall_id is not None and existing.status == "pending":
        raise _refuse(409, "link_exists", "A payment link is already open for this order")
    try:
        link = await create_order_invoice_link(
            db, salesorder_id, document=document, amount=body.amount, actor_name=_by(user), now=utc_now_naive()
        )
    except InvoiceLinkExists as e:
        raise _refuse(409, "link_exists", str(e)) from e
    except HeimdallNotConfigured as e:
        raise _refuse(502, "not_configured", str(e)) from e
    except HeimdallUpstreamError as e:
        raise _heimdall_refusal(e, invalid_code="invalid") from e
    _logged(user, salesorder_id, "payment_link")
    view = _link_out(link)
    assert view is not None  # a row always has a view
    return view


def _open_link(link: AitoPaymentLink | None) -> bool:
    return link is not None and link.heimdall_id is not None and link.status == "pending"


async def _cancel_link(db: AsyncSession, link: AitoPaymentLink, user: User | None) -> None:
    """The operator's cancel of the order's open link; 409 `link_paid` when it turned out paid instead."""
    try:
        paid = await cancel_order_link(
            db, link, actor_class="user", actor_name=_by(user), reason="operator", now=utc_now_naive()
        )
    except HeimdallNotConfigured as e:
        raise _refuse(502, "not_configured", str(e)) from e
    except HeimdallUpstreamError as e:
        raise _heimdall_refusal(e) from e
    if paid:
        raise _refuse(409, "link_paid", "The payment link has just been paid")


@router.post("/orders/{salesorder_id}/payment-link/cancel", response_model=OrderPaymentLinkView)
async def cancel_order_payment_link(
    salesorder_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> OrderPaymentLinkView:
    """Cancel the order's open payment link (Aito's invoice-link cancel, with the order's history line)."""
    _check_counter_payment_rate_limit(request, user)
    link = await current_link(db, ("order", salesorder_id), kind=None)
    if link is None:
        raise HTTPException(status_code=404, detail="Payment link not found")
    if not _open_link(link):  # dead, or an unminted reservation with nothing at Heimdall to cancel
        raise _refuse(409, "not_cancellable", "This payment link is not open and cannot be cancelled")
    await _cancel_link(db, link, user)
    _logged(user, salesorder_id, "payment_link_cancel")
    await db.refresh(link)
    view = _link_out(link)
    assert view is not None  # a row always has a view
    return view


@router.post("/orders/{salesorder_id}/terminal-payment", response_model=AitoTerminalPaymentView, status_code=201)
async def start_order_terminal_payment_route(
    salesorder_id: str,
    body: OrderTerminalBody,
    request: Request,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
):
    """Fire the counter terminal on the order's document. 201 with the row (`processing`); poll the GET below.
    A pending payment link answers 409 `link_open` (the client could pay twice) unless `cancel_link` cancels it first."""
    _check_counter_payment_rate_limit(request, user)
    document = await _payment_document(db, salesorder_id, body.amount)
    link = await current_link(db, ("order", salesorder_id), kind=None)
    if _open_link(link):
        if not body.cancel_link:
            raise _refuse(409, "link_open", "A payment link is open for this order")
        assert link is not None
        await _cancel_link(db, link, user)
    try:
        row = await start_order_terminal_payment(
            db, salesorder_id, document=document, amount=body.amount, actor_name=_by(user), now=utc_now_naive()
        )
    except TerminalInProgress as e:
        raise _refuse(409, "terminal_in_progress", str(e)) from e
    except HeimdallNotConfigured as e:
        raise _refuse(502, "not_configured", str(e)) from e
    except HeimdallUpstreamError as e:
        raise _heimdall_refusal(e) from e
    view = terminal_view(row)
    try:  # the terminal is already asking for the card: a lost history line must not read as a failed start
        await _log(db, salesorder_id, "terminal.started", _by(user), amount=row.amount, document=row.document_number)
    except Exception:
        logger.exception("Order board: recording terminal.started failed for %s", salesorder_id)
    _logged(user, salesorder_id, "terminal_payment")
    return view


@router.get("/orders/{salesorder_id}/terminal-payment", response_model=AitoTerminalPaymentView | None)
async def get_order_terminal_payment(
    salesorder_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
):
    """The order's newest terminal charge, refreshed from Heimdall while it is open (throttled); null if none."""
    row = await current_terminal_payment(db, ("order", salesorder_id))
    if row is None:
        return None
    try:
        row = await refresh_terminal_payment(db, row, now=utc_now_naive())
    except HeimdallRateLimited as e:
        raise _refuse(429, "rate_limited", str(e)) from e
    return terminal_view(row)


@router.get("/orders/{salesorder_id}/picklist")
async def get_picklist_preview(
    salesorder_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    """What a new picklist of this order may hold (asks Books; writes nothing)."""
    return await _run(order_board_actions.picklist_preview(db, salesorder_id))


@router.post("/orders/{salesorder_id}/picklists")
async def create_picklist(
    salesorder_id: str,
    body: ParcelBody,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    picklist = await _run(
        order_board_actions.create_picklist(
            db, salesorder_id, {line.line_id: line.quantity for line in body.lines}, by=_by(user)
        )
    )
    _logged(user, salesorder_id, "create_picklist")
    return {"board": await order_board_sync.read_board(db), "picklist": picklist}


@router.get("/orders/{salesorder_id}/picklists/{picklist_id}")
async def get_picklist_content(
    salesorder_id: str,
    picklist_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    """What a parcel made from this picklist may hold (asks Books; writes nothing)."""
    return await _run(order_board_actions.picklist_content(db, salesorder_id, picklist_id))


@router.post("/orders/{salesorder_id}/packages")
async def create_parcel(
    salesorder_id: str,
    body: PackBody,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    number = await _run(
        order_board_actions.create_parcel(
            db, salesorder_id, body.picklist_id, {line.line_id: line.quantity for line in body.lines}, by=_by(user)
        )
    )
    _logged(user, salesorder_id, "create_parcel")
    return {"board": await order_board_sync.read_board(db), "package_number": number}


@router.get("/items")
async def search_items(
    q: str = Query(min_length=2, max_length=80),
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    """Books items matching a search, for adding a line to an order."""
    return {"items": await _run(order_board_actions.search_items(db, q))}


@router.put("/orders/{salesorder_id}/lines")
async def edit_order_lines(
    salesorder_id: str,
    body: LinesBody,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    row = await _run(
        order_board_actions.edit_lines(
            db, salesorder_id, body.version, [line.model_dump(exclude_none=True) for line in body.lines], by=_by(user)
        )
    )
    _logged(user, salesorder_id, "edit_lines")
    return {"board": await order_board_sync.read_board(db), "row": row or None}


@router.get("/orders/{salesorder_id}/packages/{package_id}")
async def get_package_content(
    salesorder_id: str,
    package_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    """What a packed parcel holds and may be changed to (asks Books; writes nothing)."""
    return await _run(order_board_actions.package_content(db, salesorder_id, package_id))


@router.put("/orders/{salesorder_id}/packages/{package_id}")
async def edit_parcel(
    salesorder_id: str,
    package_id: str,
    body: ParcelEditBody,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    row = await _run(
        order_board_actions.edit_parcel(
            db,
            salesorder_id,
            package_id,
            body.version,
            {line.line_id: line.quantity for line in body.was},
            {line.line_id: line.quantity for line in body.lines},
            by=_by(user),
        )
    )
    _logged(user, salesorder_id, "edit_parcel")
    return {"board": await order_board_sync.read_board(db), "row": row or None}


@router.get("/orders/{salesorder_id}/packages/{package_id}/handover")
async def get_handover_preview(
    salesorder_id: str,
    package_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    return await _run(order_board_actions.handover_preview(db, salesorder_id, package_id))


@router.post("/orders/{salesorder_id}/packages/{package_id}/handover")
async def hand_over_parcel(
    salesorder_id: str,
    package_id: str,
    body: HandoverBody,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    outcome = await _run(
        order_board_actions.hand_over(
            db, salesorder_id, package_id, mode=body.mode, apply_credit=body.apply_credit, by=_by(user)
        )
    )
    _logged(user, salesorder_id, "hand_over")
    return {"board": await order_board_sync.read_board(db), "outcome": outcome}


@router.get("/orders/{salesorder_id}/invoice")
async def get_invoice_preview(
    salesorder_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    return await _run(order_board_actions.invoice_preview(db, salesorder_id))


@router.post("/orders/{salesorder_id}/invoice")
async def invoice_order(
    salesorder_id: str,
    body: InvoiceBody,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    outcome = await _run(
        order_board_actions.invoice_shipped(
            db, salesorder_id, apply_credit=body.apply_credit, scope=body.scope, by=_by(user)
        )
    )
    _logged(user, salesorder_id, "invoice")
    return {"board": await order_board_sync.read_board(db), "outcome": outcome}


@router.post("/orders/{salesorder_id}/cancel")
async def cancel_order(
    salesorder_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    await _run(order_board_actions.cancel_order(db, salesorder_id, by=_by(user)))
    _logged(user, salesorder_id, "cancel")
    return {"board": await order_board_sync.read_board(db)}


@router.get("/invoices/{invoice_id}/pdf")
async def get_invoice_pdf(
    invoice_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> Response:
    """An invoice PDF, only for an invoice that a stored order lists (no open proxy to every Books invoice)."""
    await _listed_invoice(db, invoice_id)
    pdf = await _run(zoho_service.get_invoice_pdf(db, invoice_id))
    return _pdf(pdf, "facture.pdf")


async def _listed_invoice(db: AsyncSession, invoice_id: str) -> tuple[str, dict, dict]:
    """The stored order that lists this invoice (its id and detail) and the invoice entry itself, or a 404."""
    # Scan of the salesorder docs that have a detail: a few hundred rows, no JSON index worth building.
    docs = await db.execute(
        select(OrderBoardDoc.zoho_id, OrderBoardDoc.detail).where(
            OrderBoardDoc.kind == "salesorder", OrderBoardDoc.detail.is_not(None)
        )
    )
    for salesorder_id, detail in docs:
        for invoice in (detail or {}).get("invoices") or []:
            if invoice.get("invoice_id") == invoice_id:
                return salesorder_id, detail or {}, invoice
    raise HTTPException(status_code=404, detail="Invoice not found.")


async def _invoice_email(db: AsyncSession, invoice_id: str) -> tuple[str, dict, dict]:
    """The order that lists the invoice, and what Books would email for it right now.

    The address to preselect is the order's own contact when Books offers it, else Books' first.
    """
    salesorder_id, order, invoice = await _listed_invoice(db, invoice_id)
    content = await _run(zoho_service.get_invoice_email_content(db, invoice_id))
    emails = [r["email"] for r in content["recipients"]]
    own = ((order_contact(order) or {}).get("email") or "").lower()
    content = {
        **content,
        "default_email": next((e for e in emails if e.lower() == own), emails[0] if emails else None),
        "invoice_id": invoice_id,
        "invoice_number": invoice.get("invoice_number") or invoice_id,
    }
    return salesorder_id, order, content


@router.get("/invoices/{invoice_id}/email")
async def get_invoice_email(
    invoice_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    """What Books would send if this invoice were emailed now: subject, body and the addresses Books offers."""
    return (await _invoice_email(db, invoice_id))[2]


@router.post("/invoices/{invoice_id}/email")
async def send_invoice_email(
    invoice_id: str,
    body: InvoiceEmailBody,
    request: Request,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    """Email the invoice through Books to one of the addresses Books offers for it; answers with the fresh board."""
    _check_zoho_email_rate_limit(request, user)
    salesorder_id, order, content = await _invoice_email(db, invoice_id)
    to = body.to.strip()
    # Re-read, never taken from the request: otherwise any holder of orders:update could mail anyone from the
    # shop's Books account, on the shop's own template.
    if to.lower() not in {r["email"].lower() for r in content["recipients"]}:
        raise HTTPException(status_code=422, detail="That address is not a recipient of this invoice")
    # Same one-minute guard as the Aito card: a second tap must not mail the client the same invoice twice.
    key = _email_guard_key_or_409("order-invoice", 0, invoice_id, to)
    _EMAIL_GUARD.arm(key, time.monotonic())

    async def send() -> None:
        try:
            await order_board_actions.email_invoice(
                db,
                salesorder_id,
                order.get("salesorder_number") or salesorder_id,
                invoice_id,
                to,
                by=_by(user),
                invoice_number=content["invoice_number"],
            )
        except ZohoUnreachable:
            raise  # Books may have sent it all the same: the guard stays armed
        except Exception:
            _EMAIL_GUARD.release(key)
            raise

    await _run(send())
    _logged(user, salesorder_id, "invoice_email")
    return {"board": await order_board_sync.read_board(db)}
