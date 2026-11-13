"""Payment routes of the Order Board."""

import math
from typing import Literal

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.aito_payments import _check_counter_payment_rate_limit, _heimdall_refusal, _refuse
from backend.app.api.routes.order_board._common import _by, _logged, logger, router
from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.models.user import User
from backend.app.schemas.aito import AitoPaymentLinkView, AitoTerminalPaymentView
from backend.app.services import (
    order_board_sync,
)
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
from backend.app.services.order_board_payment import order_facts
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoUpstreamError


class OrderPaymentBody(BaseModel):
    amount: int = Field(ge=1, le=999_999_999_999)


class OrderTerminalBody(OrderPaymentBody):
    # A pending payment link refuses the terminal (409 link_open) unless this asks to cancel it first.
    cancel_link: bool = False


class OrderPaymentLinkView(AitoPaymentLinkView):
    document_number: str | None


class OrderPaymentTarget(BaseModel):
    kind: Literal["invoice", "retainer", "quote", "salesorder"] | None
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


def _target(
    detail: dict, left: int | None
) -> tuple[Literal["invoice", "retainer", "quote", "salesorder"], dict] | None:
    """Design §3: the newest invoice with a balance; else, for an order made from a quote, its open retainer; else
    that quote itself, as in Aito: Heimdall books the payment as a new retainer invoice on it. An order without a
    quote is paid on the sales order itself, booked the same way (the retainer's reference is the order number).
    A quote or a sales order has no balance of its own: it takes at most what the order has left to pay."""
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
    elif left and detail.get("salesorder_id") and detail.get("salesorder_number"):
        return "salesorder", {"id": detail["salesorder_id"], "number": detail["salesorder_number"], "balance": left}
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
