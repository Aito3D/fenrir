"""An order's quote and deposit documents, its sync, credit, rating and contact: the Aito card's tools on an order."""

import time
from typing import Literal

from fastapi import Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
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
from backend.app.models.user import User
from backend.app.schemas.aito import AitoClientRatingResponse
from backend.app.services import order_board_actions, order_board_sync
from backend.app.services.aito_client_rating import read_client_rating
from backend.app.services.aito_customer_credit import read_customer_credit
from backend.app.services.order_board_payment import order_contact
from backend.app.services.zoho import ZohoUnreachable

Kind = Literal["quote", "retainer"]


class DocumentEmailBody(BaseModel):
    to: str = Field(min_length=3, max_length=254)


class ContactBody(BaseModel):
    email: str = Field(default="", max_length=200)
    phone: str = Field(default="", max_length=50)
    phone_field: Literal["phone", "mobile"] = "mobile"


@router.get("/orders/{salesorder_id}/documents/{kind}/{document_id}/pdf")
async def get_document_pdf(
    salesorder_id: str,
    kind: Kind,
    document_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> Response:
    """The order's quote or deposit invoice as a PDF."""
    pdf = await _run(order_board_actions.document_pdf(db, salesorder_id, kind, document_id))
    return _pdf(pdf, "devis.pdf" if kind == "quote" else "facture-acompte.pdf")


async def _document_email(db: AsyncSession, salesorder_id: str, kind: Kind, document_id: str) -> tuple[dict, dict]:
    """The document, and what Books would email for it now; the order's own contact is preselected when offered."""
    document = await _run(order_board_actions.listed_document(db, salesorder_id, kind, document_id))
    content = await _run(order_board_actions.document_email_content(db, kind, document_id))
    stored = await order_board_sync.find_stored(db, salesorder_id)
    own = ((order_contact((stored.detail if stored else None) or {}) or {}).get("email") or "").lower()
    emails = [r["email"] for r in content["recipients"]]
    content = {
        **content,
        "default_email": next((e for e in emails if e.lower() == own), emails[0] if emails else None),
        "document_id": document_id,
        "document_number": document["number"],
    }
    return document, content


@router.get("/orders/{salesorder_id}/documents/{kind}/{document_id}/email")
async def get_document_email(
    salesorder_id: str,
    kind: Kind,
    document_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    return (await _document_email(db, salesorder_id, kind, document_id))[1]


@router.post("/orders/{salesorder_id}/documents/{kind}/{document_id}/email")
async def send_document_email(
    salesorder_id: str,
    kind: Kind,
    document_id: str,
    body: DocumentEmailBody,
    request: Request,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    """Email the quote or deposit invoice through Books, only to an address Books offers for it."""
    _check_zoho_email_rate_limit(request, user)
    document, content = await _document_email(db, salesorder_id, kind, document_id)
    to = body.to.strip()
    # Re-read, never taken from the request: otherwise any holder of orders:update could mail anyone.
    if to.lower() not in {r["email"].lower() for r in content["recipients"]}:
        raise HTTPException(status_code=422, detail="That address is not a recipient of this document")
    key = _email_guard_key_or_409(f"order-{kind}", 0, document_id, to)
    _EMAIL_GUARD.arm(key, time.monotonic())

    async def send() -> None:
        try:
            await order_board_actions.email_document(db, salesorder_id, kind, document, to, by=_by(user))
        except ZohoUnreachable:
            raise  # Books may have sent it all the same: the guard stays armed
        except Exception:
            _EMAIL_GUARD.release(key)
            raise

    await _run(send())
    _logged(user, salesorder_id, f"{kind}_email")
    return {"board": await order_board_sync.read_board(db)}


def _sync_facts(row: dict) -> dict:
    """What an operator checks after a sync: totals, payment, documents, parcels."""
    payment = row.get("payment") or {}
    return {
        "total": row.get("total"),
        "paid": payment.get("paid"),
        "left": payment.get("left"),
        "state": payment.get("state"),
        "invoices": sorted(i.get("number") or "" for i in payment.get("invoices") or []),
        "retainers": sorted(r.get("number") or "" for r in row.get("retainers") or []),
        "packages": sorted(p.get("number") or "" for p in row.get("packages") or []),
    }


@router.post("/orders/{salesorder_id}/sync")
async def sync_order(
    salesorder_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    """Re-read one order from Books now; answers with what changed and the fresh board."""
    if order_board_sync.zoho_busy():
        raise HTTPException(status_code=503, detail="Zoho is busy, try again shortly.")
    before = _sync_facts(await _run(order_board_actions.order_row_any(db, salesorder_id)))
    await _run(order_board_sync.refresh_order(db, salesorder_id))
    after = _sync_facts(await _run(order_board_actions.order_row_any(db, salesorder_id)))
    _logged(user, salesorder_id, "sync")
    return {
        "changes": [{"field": k, "from": before[k], "to": after[k]} for k in after if before[k] != after[k]],
        "board": await order_board_sync.read_board(db),
    }


async def _customer_id(db: AsyncSession, salesorder_id: str) -> str:
    stored = await order_board_sync.find_stored(db, salesorder_id)
    customer_id = str(((stored.detail if stored else None) or {}).get("customer_id") or "")
    if not customer_id:
        raise HTTPException(status_code=404, detail="Order not found.")
    return customer_id


@router.get("/orders/{salesorder_id}/customer-credit")
async def get_customer_credit(
    salesorder_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    """The customer's unspent deposits across every order and quote; null when Books could not say."""
    return {"credit": await read_customer_credit(db, await _customer_id(db, salesorder_id))}


@router.get("/orders/{salesorder_id}/client-rating", response_model=AitoClientRatingResponse)
async def get_order_client_rating(
    salesorder_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
):
    """The customer's payment rating, as on the Aito card. The id is the stored order's, never the caller's."""
    return await read_client_rating(db, await _customer_id(db, salesorder_id))


@router.put("/orders/{salesorder_id}/contact")
async def edit_order_contact(
    salesorder_id: str,
    body: ContactBody,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    await _run(
        order_board_actions.edit_contact(
            db, salesorder_id, email=body.email, phone=body.phone, phone_field=body.phone_field, by=_by(user)
        )
    )
    _logged(user, salesorder_id, "contact")
    return {"board": await order_board_sync.read_board(db)}


@router.post("/orders/{salesorder_id}/invoices/{invoice_id}/apply-credit")
async def apply_order_credit(
    salesorder_id: str,
    invoice_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    """Spend the order's deposits and advance on one of its open invoices in Books."""
    applied = await _run(order_board_actions.apply_credit(db, salesorder_id, invoice_id, by=_by(user)))
    _logged(user, salesorder_id, "apply_credit")
    return {"applied": applied, "board": await order_board_sync.read_board(db)}
