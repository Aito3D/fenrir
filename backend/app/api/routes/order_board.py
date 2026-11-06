"""The Order Board: which open sales orders can ship today.

Reading is one local read of the stored board. Refresh runs one bounded sync
pass against Zoho Books (GETs only). The settings routes are their own
endpoints, not the general settings API, because Operators hold
``settings:read`` only and must still be able to tune the board.
"""

import logging
from collections.abc import Awaitable
from dataclasses import asdict
from datetime import datetime
from typing import Literal, TypeVar

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.models.user import User
from backend.app.services import aito_tracking, order_board_actions, order_board_sync
from backend.app.services.order_board_prep_sheet import render_prep_sheet
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoUpstreamError, zoho_service
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
        logger.warning("Finished order fetch failed: %s", e)
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


class HandoverBody(BaseModel):
    mode: Literal["pickup", "delivery"]
    apply_credit: bool


class InvoiceBody(BaseModel):
    apply_credit: bool


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
        logger.warning("Order board Zoho call failed: %s", e)
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
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> Response:
    """Stamp the order as printed and return its prep sheet."""
    row = await _run(order_board_actions.stamp_print(db, salesorder_id, user.username if user else ""))
    base = await aito_tracking.external_url(db)
    pdf = render_prep_sheet(
        row, printed_at=datetime.now(), order_url=f"{base}/orders?order={salesorder_id}" if base else None
    )
    _logged(user, salesorder_id, "prep_sheet")
    return _pdf(pdf, "bon-de-preparation.pdf")


@router.post("/orders/{salesorder_id}/packages")
async def create_parcel(
    salesorder_id: str,
    body: ParcelBody,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    number = await _run(
        order_board_actions.create_parcel(db, salesorder_id, {line.line_id: line.quantity for line in body.lines})
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
    # Scan of the salesorder docs that have a detail: a few hundred rows, no JSON index worth building.
    details = (
        await db.execute(
            select(OrderBoardDoc.detail).where(OrderBoardDoc.kind == "salesorder", OrderBoardDoc.detail.is_not(None))
        )
    ).scalars()
    if not any(inv.get("invoice_id") == invoice_id for d in details if d for inv in (d.get("invoices") or [])):
        raise HTTPException(status_code=404, detail="Invoice not found.")
    pdf = await _run(zoho_service.get_invoice_pdf(db, invoice_id))
    return _pdf(pdf, "facture.pdf")
