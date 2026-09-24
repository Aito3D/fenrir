"""Which Zoho Books document a counter payment is for, verified against the
project it was requested from. Every payment route takes `(kind, document_id)`
from the browser and must not trust it: a quote id must be THIS project's
quote, an invoice id must be one Books raised from that quote."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_project import AitoProject
from backend.app.services.zoho import zoho_service


class DocumentMismatch(Exception):
    """The document is not this project's (or the kind is unknown)."""


@dataclass(frozen=True)
class PaymentDocument:
    kind: str
    id: str
    number: str
    customer_id: str
    balance: int | None


async def resolve_document(db: AsyncSession, project: AitoProject, kind: str, document_id: str) -> PaymentDocument:
    quote_id = project.quote_id or ""
    client_id = project.client_id or ""
    if not quote_id or not document_id:
        raise DocumentMismatch("This project has no Zoho quote")
    if kind == "quote":
        if document_id != quote_id:
            raise DocumentMismatch("That quote is not this project's")
        estimate = await zoho_service.get_estimate(db, quote_id)
        return PaymentDocument(
            kind="quote",
            id=quote_id,
            number=project.quote_number or "",
            customer_id=str(estimate.get("customer_id") or client_id),
            balance=None,
        )
    if kind == "invoice":
        invoices = await zoho_service.list_project_invoices(db, quote_id, client_id)
        if not any(str(i.get("id") or "") == document_id for i in invoices):
            raise DocumentMismatch("That invoice was not raised from this project's quote")
        raw = await zoho_service.get_invoice_raw(db, document_id)
        return PaymentDocument(
            kind="invoice",
            id=document_id,
            number=str(raw.get("invoice_number") or document_id),
            customer_id=str(raw.get("customer_id") or client_id),
            balance=int(round(float(raw.get("balance") or 0))),
        )
    raise DocumentMismatch(f"Unknown document kind {kind!r}")
