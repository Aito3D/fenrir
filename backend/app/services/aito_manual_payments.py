"""A payment the operator took by hand — card on another device, a cheque,
cash — written into Zoho Books from the project card. Bambuddy mirrors the
recipe Heimdall uses for its own bookings (spec §5): an invoice takes the
payment directly; a quote first gets a retainer invoice raised against it
(reference = the quote number, which the invoice sweep matches) and the
payment lands on that retainer."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_project import AitoProject
from backend.app.services.aito_events import record
from backend.app.services.aito_payment_documents import PaymentDocument
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoUpstreamError, zoho_service

logger = logging.getLogger(__name__)

DUPLICATE_WINDOW_SECONDS = 60.0
MODE_SETTINGS = {
    "card": ("aito_payment_mode_card", "creditcard"),
    "cheque": ("aito_payment_mode_cheque", "check"),
    "cash": ("aito_payment_mode_cash", "cash"),
}
# (project_id, kind, document_id, amount, reference) -> time.monotonic() of the last success.
_recent: dict[tuple, float] = {}


class DuplicateManualPayment(Exception):
    """The same document, amount and reference were recorded seconds ago."""


class AmountAboveBalance(Exception):
    def __init__(self, balance: int) -> None:
        super().__init__(f"Amount exceeds the invoice balance of {balance}")
        self.balance = balance


class ManualPaymentPartial(Exception):
    """The retainer invoice exists in Books but the payment on it failed."""

    def __init__(self, retainer_number: str, cause: Exception) -> None:
        super().__init__(f"Retainer {retainer_number} was raised but its payment failed: {cause}")
        self.retainer_number = retainer_number
        self.cause = cause


@dataclass(frozen=True)
class ManualPaymentResult:
    zoho_payment_id: str
    retainer_number: str | None
    mode_name: str


async def _mode_name(db: AsyncSession, mode: str) -> str:
    from backend.app.api.routes.settings import get_setting

    key, default = MODE_SETTINGS[mode]
    return (await get_setting(db, key) or "").strip() or default


def _guard_key(project_id: int, document: PaymentDocument, amount: int, reference: str | None) -> tuple:
    return (project_id, document.kind, document.id, int(amount), (reference or "").strip())


async def record_manual_payment(
    db: AsyncSession,
    project: AitoProject,
    *,
    document: PaymentDocument,
    mode: str,
    amount: int,
    reference: str | None,
    actor_name: str | None,
    today: date,
) -> ManualPaymentResult:
    project_id = project.id
    key = _guard_key(project_id, document, amount, reference)
    last = _recent.get(key)
    if last is not None and time.monotonic() - last < DUPLICATE_WINDOW_SECONDS:
        raise DuplicateManualPayment("This payment was recorded a moment ago")
    if document.kind == "invoice" and document.balance is not None and amount > document.balance:
        raise AmountAboveBalance(document.balance)
    mode_name = await _mode_name(db, mode)
    ref = (reference or "").strip()
    today_s = today.isoformat()
    retainer_number: str | None = None
    if document.kind == "invoice":
        payment = await zoho_service.record_customer_payment(
            db,
            customer_id=document.customer_id,
            payment_mode=mode_name,
            amount=amount,
            reference_number=ref,
            description=f"{document.number} · {mode}",
            today=today_s,
            invoice_id=document.id,
        )
    else:
        retainer = await zoho_service.create_retainer_invoice(
            db,
            customer_id=document.customer_id,
            reference_number=document.number,
            description=f"Acompte {document.number}",
            amount=amount,
            today=today_s,
        )
        retainer_id = str(retainer.get("retainerinvoice_id") or "")
        retainer_number = str(retainer.get("retainerinvoice_number") or retainer_id)
        try:
            payment = await zoho_service.record_customer_payment(
                db,
                customer_id=document.customer_id,
                payment_mode=mode_name,
                amount=amount,
                reference_number=ref,
                description=document.number,
                today=today_s,
                retainerinvoice_id=retainer_id,
            )
        except (ZohoNotConfiguredError, ZohoUpstreamError) as exc:
            await record(
                db,
                project_id,
                "payment.manual.partial",
                actor_class="user",
                actor_name=actor_name,
                subject_type="project",
                subject_id=project_id,
                detail={
                    "document_kind": document.kind,
                    "document_number": document.number,
                    "retainer_number": retainer_number,
                    "mode": mode,
                    "amount": int(amount),
                    "reference": ref,
                    "error": str(exc)[:500],
                },
            )
            await db.commit()
            raise ManualPaymentPartial(retainer_number, exc) from exc
    zoho_payment_id = str(payment.get("payment_id") or "")
    await record(
        db,
        project_id,
        "payment.manual.recorded",
        actor_class="user",
        actor_name=actor_name,
        subject_type="project",
        subject_id=project_id,
        detail={
            "document_kind": document.kind,
            "document_number": document.number,
            "mode": mode,
            "mode_name": mode_name,
            "amount": int(amount),
            "reference": ref,
            "zoho_payment_id": zoho_payment_id,
            "retainer_number": retainer_number,
        },
    )
    await db.commit()
    _recent[key] = time.monotonic()
    await refresh_after_payment(db, project_id, document.kind)
    return ManualPaymentResult(zoho_payment_id=zoho_payment_id, retainer_number=retainer_number, mode_name=mode_name)


async def refresh_after_payment(db: AsyncSession, project_id: int, kind: str) -> None:
    """Move the card's figures NOW rather than at the next sweep. Best
    effort: any failure is logged and the sweep corrects it within the
    hour. Invoice: re-read the newest invoice and the customer's credit,
    as `aito_invoice_sweep` does. Quote: the quote sweep's own per-project
    unit, which refreshes retainer_paid_total, customer_credit_total and
    runs the paid-deposit auto-accept."""
    try:
        project = await db.get(AitoProject, project_id)
        if project is None:
            return
        if kind == "invoice":
            from backend.app.services.aito_customer_credit import read_customer_credit

            invoices = await zoho_service.list_project_invoices(db, project.quote_id or "", project.client_id or "")
            if invoices:
                newest = invoices[0]
                project.invoice_status = newest.get("status") or None
                project.invoice_balance = float(newest.get("balance") or 0)
                project.invoice_due_date = newest.get("due_date") or None
            credit = await read_customer_credit(db, project.client_id)
            if credit is not None:
                project.customer_credit_total = credit
            await db.commit()
        else:
            from backend.app.services.aito_quote_sync import sync_project

            await sync_project(db, project)
    except Exception as exc:  # noqa: BLE001 — a figures refresh must never fail the payment that triggered it
        # No `db.rollback()` here: this session is the CALLER's, still in use
        # after this returns (`_after_invoice_paid`, `apply_terminal_state`),
        # and SQLAlchemy's rollback() expires every attached instance —
        # turning the caller's very next attribute read into a lazy-load
        # outside the async greenlet (`MissingGreenlet`). Nothing above
        # writes to the session before `db.commit()` succeeds, so there is
        # no dirty state here to undo; same "leave the stored figure alone"
        # contract as `read_customer_credit`.
        logger.warning("figures refresh after a %s payment on project %s failed: %s", kind, project_id, exc)
