"""The Order Board: which open sales orders can ship today.

Reading is one local read of the stored board. Refresh runs one bounded sync
pass against Zoho Books (GETs only). The settings routes are their own
endpoints, not the general settings API, because Operators hold
``settings:read`` only and must still be able to tune the board.
"""

import logging
import time
from collections.abc import Awaitable
from dataclasses import asdict
from datetime import datetime
from typing import Literal, TypeVar

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.aito import _EMAIL_GUARD, _check_zoho_email_rate_limit, _email_guard_key_or_409
from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.models.user import User
from backend.app.services import aito_tracking, order_board_actions, order_board_sync
from backend.app.services.order_board_payment import order_contact
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


class ParcelBody(BaseModel):
    lines: list[ParcelLine] = Field(min_length=1, max_length=200)

    @field_validator("lines")
    @classmethod
    def _no_duplicates(cls, lines: list[ParcelLine]) -> list[ParcelLine]:
        if len({line.line_id for line in lines}) != len(lines):
            raise ValueError("a line may appear only once")
        return lines


class PackBody(ParcelBody):
    picklist_id: str = Field(min_length=1, max_length=64)


class HandoverBody(BaseModel):
    mode: Literal["pickup", "delivery"]
    apply_credit: bool


class InvoiceBody(BaseModel):
    apply_credit: bool


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


def _logged(user: User | None, salesorder_id: str, action: str) -> None:
    logger.info("Order board: user=%s order=%s action=%s", user.id if user else "-", salesorder_id, action)


@router.post("/orders/{salesorder_id}/prep-sheet")
async def print_prep_sheet(
    salesorder_id: str,
    picklist_id: str | None = Query(default=None, min_length=1, max_length=64),
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> Response:
    """Stamp the order as printed and return its prep sheet: the units of one picklist, or everything packable."""
    content = await _run(order_board_actions.picklist_content(db, salesorder_id, picklist_id)) if picklist_id else None
    row = await _run(order_board_actions.stamp_print(db, salesorder_id, user.username if user else ""))
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
        order_board_actions.create_picklist(db, salesorder_id, {line.line_id: line.quantity for line in body.lines})
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
            db, salesorder_id, body.picklist_id, {line.line_id: line.quantity for line in body.lines}
        )
    )
    _logged(user, salesorder_id, "create_parcel")
    return {"board": await order_board_sync.read_board(db), "package_number": number}


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
        order_board_actions.hand_over(db, salesorder_id, package_id, mode=body.mode, apply_credit=body.apply_credit)
    )
    _logged(user, salesorder_id, "hand_over")
    return {"board": await order_board_sync.read_board(db), "outcome": outcome}


@router.post("/orders/{salesorder_id}/invoice")
async def invoice_order(
    salesorder_id: str,
    body: InvoiceBody,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    outcome = await _run(order_board_actions.invoice_shipped(db, salesorder_id, apply_credit=body.apply_credit))
    _logged(user, salesorder_id, "invoice")
    return {"board": await order_board_sync.read_board(db), "outcome": outcome}


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
                db, salesorder_id, order.get("salesorder_number") or salesorder_id, invoice_id, to
            )
        except ZohoUnreachable:
            raise  # Books may have sent it all the same: the guard stays armed
        except Exception:
            _EMAIL_GUARD.release(key)
            raise

    await _run(send())
    _logged(user, salesorder_id, "invoice_email")
    return {"board": await order_board_sync.read_board(db)}
