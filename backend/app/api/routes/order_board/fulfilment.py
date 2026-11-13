"""Picklist, parcel, invoice and cancel routes of the Order Board."""

import time
from typing import Literal

from fastapi import Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.aito import (
    _EMAIL_GUARD,
    _check_zoho_email_rate_limit,
    _email_guard_key_or_409,
)
from backend.app.api.routes.order_board._common import _by, _logged, _pdf, _run, router
from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.models.user import User
from backend.app.services import (
    order_board_actions,
    order_board_sync,
)
from backend.app.services.order_board_payment import order_contact
from backend.app.services.zoho import ZohoUnreachable, zoho_service


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
