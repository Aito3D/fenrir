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
from backend.app.services.aito_send_guard import DuplicateSendGuard
from backend.app.services.zoho import (
    ZohoAmbiguous,
    ZohoNotConfiguredError,
    ZohoUnreachable,
    ZohoUpstreamError,
    zoho_service,
)

logger = logging.getLogger(__name__)

DUPLICATE_WINDOW_SECONDS = 60.0
MODE_SETTINGS = {
    "card": ("aito_payment_mode_card", "creditcard"),
    "cheque": ("aito_payment_mode_cheque", "check"),
    "cash": ("aito_payment_mode_cash", "cash"),
}
# (project_id, kind, document_id, amount, reference) -> time.monotonic() of the last success.
# Entries past DUPLICATE_WINDOW_SECONDS are pruned on the next call (see
# record_manual_payment), so this never grows past the tuples active within
# the window.
_GUARD = DuplicateSendGuard(DUPLICATE_WINDOW_SECONDS)
_recent = _GUARD.entries


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


class ManualPaymentUnrecorded(Exception):
    """Zoho Books took the payment and Bambuddy could not write its own
    record of it (a failed flush/commit — "database is locked", a constraint
    violation elsewhere in the session). The money moved: this is reported,
    never retried behind the operator's back, and the duplicate guard is
    deliberately KEPT so a reflex click cannot pay twice."""

    def __init__(self, zoho_payment_id: str, cause: Exception) -> None:
        super().__init__(
            f"The payment {zoho_payment_id} was recorded in Zoho Books but the local record failed: {cause}"
        )
        self.zoho_payment_id = zoho_payment_id
        self.cause = cause


class ManualPaymentOutcomeUnknown(Exception):
    """The Books call that writes the payment itself failed at the transport
    level (``ZohoUnreachable`` -- typically a read timeout) or got an answer
    that does not say whether it was applied (``ZohoAmbiguous`` -- a 5xx, or
    an edge gateway's HTML 502/504). Books may have recorded the payment
    before the connection dropped or the gateway gave up, so this is neither a
    success nor a failure: the duplicate guard is KEPT (an identical retry
    within the window is refused) and the operator is told to check Books
    before trying again. ``retainer_number`` is set on the quote path, where
    the retainer invoice was raised before the payment call.

    ``stage`` is ``"retainer"`` when it is the quote path's retainer-invoice
    CREATION that went unanswered (T-079): no payment was attempted, but
    Books may hold a retainer invoice nothing in Bambuddy knows about, so a
    retry would raise a second one. ``retainer_number`` is then ``None``."""

    def __init__(self, retainer_number: str | None, cause: Exception, *, stage: str = "payment") -> None:
        if stage == "retainer":
            super().__init__(f"A retainer invoice may already be in Zoho Books: {cause}")
        else:
            super().__init__(f"The payment may already be in Zoho Books: {cause}")
        self.retainer_number = retainer_number
        self.cause = cause
        self.stage = stage


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


def _log_outcome_unknown(project_id: int, kind: str, number: str, retainer_number: str | None, exc: Exception) -> None:
    logger.error(
        "manual payment on project %s (%s %s, retainer %s): Books did not answer the payment call, "
        "it may already be recorded there: %s",
        project_id,
        kind,
        number,
        retainer_number,
        exc,
    )


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
    now = time.monotonic()
    # Prune first: an entry past the window is already ignored by the check
    # below, so dropping it here changes nothing a caller can observe and
    # keeps the dict from growing forever (every distinct project/document/
    # amount/reference tuple ever paid, for the life of the process). Same
    # guard as _recent_sms's in routes/aito.py (DuplicateSendGuard). After the
    # prune, a key still present is by construction inside the window.
    if _GUARD.is_recent(key, now):
        raise DuplicateManualPayment("This payment was recorded a moment ago")
    # Reserved HERE, before any Zoho call -- not just after a successful one.
    # Two requests for the same document/amount/reference a few hundred ms
    # apart both pass the read above under async concurrency (FastAPI runs
    # them concurrently, not one-at-a-time); reserving only after the round
    # trip would let both reach Books. A failure below releases the key
    # again, except the two where something already landed in Books and a
    # retry would double it: `ManualPaymentPartial` (the retainer exists),
    # `ManualPaymentUnrecorded` (the payment itself exists) and
    # `ManualPaymentOutcomeUnknown` (the payment call -- or the retainer
    # invoice creation -- timed out, or got a 5xx / non-JSON answer -- it
    # may exist). Those KEEP the key, and their
    # message names what to check or finish by hand -- the prune above cannot
    # drop them early: it only ever removes entries already past the window.
    _GUARD.arm(key, now)
    try:
        if document.kind == "invoice" and document.balance is not None and amount > document.balance:
            raise AmountAboveBalance(document.balance)
        mode_name = await _mode_name(db, mode)
        ref = (reference or "").strip()
        today_s = today.isoformat()
        retainer_number: str | None = None
        if document.kind == "invoice":
            try:
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
            except (ZohoUnreachable, ZohoAmbiguous) as exc:
                _log_outcome_unknown(project_id, document.kind, document.number, None, exc)
                raise ManualPaymentOutcomeUnknown(None, exc) from exc
        else:
            try:
                retainer = await zoho_service.create_retainer_invoice(
                    db,
                    customer_id=document.customer_id,
                    reference_number=document.number,
                    description=f"Acompte {document.number}",
                    amount=amount,
                    today=today_s,
                )
            except (ZohoUnreachable, ZohoAmbiguous) as exc:
                # T-079: a timeout (or 5xx / non-JSON answer) can land after
                # Books created the retainer. Releasing the guard would let a
                # reflex retry raise a second, orphaned retainer invoice, so
                # the key is KEPT and the operator is told to check Books.
                # A clean refusal (4xx JSON) still releases it below.
                logger.error(
                    "manual payment on project %s (%s %s): Books did not answer the retainer invoice creation, "
                    "a retainer may already exist there: %s",
                    project_id,
                    document.kind,
                    document.number,
                    exc,
                )
                raise ManualPaymentOutcomeUnknown(None, exc, stage="retainer") from exc
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
            except (ZohoUnreachable, ZohoAmbiguous) as exc:
                # Not `ManualPaymentPartial`: its "payment could not be
                # recorded -- record it by hand" would have the operator book
                # a payment Books may already hold. Nor its
                # `payment.manual.partial` event, which says the same thing.
                _log_outcome_unknown(project_id, document.kind, document.number, retainer_number, exc)
                raise ManualPaymentOutcomeUnknown(retainer_number, exc) from exc
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
        # Past this point the money HAS moved. A failure here is not a
        # failure of the payment, and must not read like one: the guard key
        # stays (a reflex retry would write a second payment into Books),
        # the Books payment id is named so a human can reconcile by hand,
        # and the session is left usable for the route's own response.
        try:
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
        except Exception as exc:
            logger.error(
                "manual payment %s is in Zoho Books (project %s, %s %s) but the local record failed: %s",
                zoho_payment_id,
                project_id,
                document.kind,
                document.number,
                exc,
                exc_info=True,
            )
            if not db.is_active:
                try:
                    await db.rollback()
                except Exception:  # noqa: BLE001 — nothing left to salvage, the error below is the story
                    pass
            raise ManualPaymentUnrecorded(zoho_payment_id, exc) from exc
    except (ManualPaymentPartial, ManualPaymentUnrecorded, ManualPaymentOutcomeUnknown):
        raise
    except Exception:
        _GUARD.release(key)
        raise
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
        logger.warning("figures refresh after a %s payment on project %s failed: %s", kind, project_id, exc)
        # `db.rollback()` is NOT called unconditionally: this session is the
        # CALLER's, still in use after this returns (`_after_invoice_paid`,
        # `apply_terminal_state`), and SQLAlchemy's rollback() expires every
        # attached instance — turning the caller's very next attribute read
        # into a lazy-load outside the async greenlet (`MissingGreenlet`). A
        # Zoho-READ failure (the common case — not configured, upstream
        # error) never touches the session, so `is_active` stays True and no
        # rollback is needed or wanted (same "leave the stored figure alone"
        # contract as `read_customer_credit`). But `db.commit()` itself can
        # fail (e.g. SQLite "database is locked") *after* the Zoho payment
        # was already written — SQLAlchemy answers that by deactivating the
        # session (`is_active` False), and the caller's very next statement
        # on it would then raise `PendingRollbackError` rather than a clean
        # lazy-load error. Only that poisoned-session case gets a rollback.
        if not db.is_active:
            try:
                await db.rollback()
            except Exception:  # noqa: BLE001
                pass
