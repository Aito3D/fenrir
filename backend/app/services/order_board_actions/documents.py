"""An order's quote and deposit documents, its contact and its credit: the Aito card's billing tools, on an order.

Every document id is checked against the stored order before Books is asked: no open proxy to every Books document.
"""

import logging
from datetime import date
from typing import Any, Literal

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services import order_board_sync as sync
from backend.app.services.order_board import order_row
from backend.app.services.order_board_actions._common import (
    OrderActionRefused,
    _best_effort_refresh,
    _log,
    _num,
    _on_account,
    _stored_order,
    _write,
    confirm_stored_copy,
    writing,
)
from backend.app.services.order_board_actions.invoice import _credit
from backend.app.services.zoho import zoho_service

logger = logging.getLogger(__name__)

DocumentKind = Literal["quote", "retainer"]


async def order_row_any(db: AsyncSession, salesorder_id: str) -> dict:
    """The board row, or for an order off the board (a finished one) its row from the stored detail."""
    row = await sync.find_board_row(db, salesorder_id)
    return row if row is not None else order_row(await _stored_order(db, salesorder_id), {}, date.today())


async def listed_document(db: AsyncSession, salesorder_id: str, kind: DocumentKind, document_id: str) -> dict:
    """The order's quote or one of its deposit invoices as ``{"id", "number"}``; refused when the order has no such
    document."""
    order = await _stored_order(db, salesorder_id)
    if kind == "quote":
        if document_id and str(order.get("estimate_id") or "") == document_id:
            number = order.get("estimate_number") or order.get("reference_number") or document_id
            return {"id": document_id, "number": str(number)}
    else:
        for retainer in order.get("_retainers") or []:
            if document_id and str(retainer.get("id") or "") == document_id:
                return {"id": document_id, "number": str(retainer.get("number") or document_id)}
    raise OrderActionRefused("unknown_document")


async def document_pdf(db: AsyncSession, salesorder_id: str, kind: DocumentKind, document_id: str) -> bytes:
    await listed_document(db, salesorder_id, kind, document_id)
    if kind == "quote":
        return await zoho_service.get_estimate_pdf(db, document_id)
    return await zoho_service.get_retainer_invoice_pdf(db, document_id)


async def document_email_content(db: AsyncSession, kind: DocumentKind, document_id: str) -> dict:
    if kind == "quote":
        return await zoho_service.get_estimate_email_content(db, document_id)
    return await zoho_service.get_retainer_email_content(db, document_id)


async def email_document(
    db: AsyncSession,
    salesorder_id: str,
    kind: DocumentKind,
    document: dict,
    to: str,
    *,
    by: str | None = None,
) -> None:
    """Email the order's quote or deposit invoice through Books, then re-read the order (Books marks it sent)."""
    number = (await _stored_order(db, salesorder_id)).get("salesorder_number") or salesorder_id
    with writing(salesorder_id):
        send = zoho_service.email_estimate if kind == "quote" else zoho_service.email_retainer
        await _write(salesorder_id, number, f"{kind}_email", send(db, document["id"], to_mail_ids=[to]))
        await _log(db, salesorder_id, "document.emailed", by, document_kind=kind, document=document["number"], to=to)
        await _best_effort_refresh(db, salesorder_id, number)


async def apply_credit(db: AsyncSession, salesorder_id: str, invoice_id: str, *, by: str | None = None) -> float:
    """Spend the customer's credit on one of the order's open invoices, by hand: what the hand-over's "apply credit"
    does at invoice time. Capped at the invoice's live balance and at the credit the board counts for this order
    (its quote's deposits, then its advance). Returns the amount applied."""
    with writing(salesorder_id):
        order = (await confirm_stored_copy(db, salesorder_id)).detail or {}
        number = order.get("salesorder_number") or salesorder_id
        listed = next((i for i in order.get("invoices") or [] if i.get("invoice_id") == invoice_id), None)
        if listed is None or listed.get("status") in ("draft", "void"):
            raise OrderActionRefused("unknown_invoice")
        advance = _on_account(await order_row_any(db, salesorder_id))
        live = await zoho_service.get_invoice(db, invoice_id) or {}
        cap = round(min(_num(live.get("balance")), advance), 2)
        if cap < 0.01:
            raise OrderActionRefused("no_credit")
        applied = await _credit(
            db, salesorder_id, number, {"invoice_id": invoice_id}, order.get("customer_id") or "", cap
        )
        if applied > 0:
            invoice_number = listed.get("invoice_number") or invoice_id
            await _log(db, salesorder_id, "credit.applied", by, invoice=invoice_number, amount=applied)
        await _best_effort_refresh(db, salesorder_id, number)
        return applied


async def edit_contact(
    db: AsyncSession,
    salesorder_id: str,
    *,
    email: str,
    phone: str,
    phone_field: Literal["phone", "mobile"],
    by: str | None = None,
) -> None:
    """Rewrite the email and phone of the order's contact person in Books, then re-read the order. No name: Books
    writes a name to the client's primary person, which may not be the order's."""
    with writing(salesorder_id):
        order = (await confirm_stored_copy(db, salesorder_id)).detail or {}
        number = order.get("salesorder_number") or salesorder_id
        customer_id = str(order.get("customer_id") or "")
        person = (order.get("contact_person_details") or [{}])[0]
        if not customer_id:
            raise OrderActionRefused("no_contact")
        await _write(
            salesorder_id,
            number,
            "contact",
            zoho_service.update_contact_person(
                db,
                customer_id,
                email=email.strip(),
                phone=phone.strip(),
                phone_field=phone_field,
                contact_person_id=str(person.get("contact_person_id") or "") or None,
            ),
        )
        new_email = email.strip().lower()
        # Recorded only for an address that changed: the email guard refuses to mail it for a few minutes.
        changed = new_email and new_email != str(person.get("email") or "").strip().lower()
        detail: dict[str, Any] = {"email": new_email} if changed else {}
        await _log(db, salesorder_id, "contact.edited", by, **detail)
        await _best_effort_refresh(db, salesorder_id, number)
