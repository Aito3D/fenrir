"""A payment the operator took by hand — card on another device, a cheque,
cash — written into Zoho Books from the project card. Bambuddy mirrors the
recipe Heimdall uses for its own bookings (spec §5): an invoice takes the
payment directly; a quote first gets a retainer invoice raised against it
(reference = the quote number, which the invoice sweep matches) and the
payment lands on that retainer."""

from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date, datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_project import AitoProject
from backend.app.services.aito_events import record
from backend.app.services.aito_invoice_cache import invoice_total_of
from backend.app.services.aito_payment_documents import PaymentDocument
from backend.app.services.aito_search import remember_document_numbers
from backend.app.services.aito_send_guard import DuplicateSendGuard
from backend.app.services.inbox import broadcast_pending
from backend.app.services.zoho import (
    ZohoAmbiguous,
    ZohoNotConfiguredError,
    ZohoRateLimited,
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
# (project_id or ("order", salesorder_id), kind, document_id, amount, reference) -> time.monotonic() of the last success.
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


def _guard_key(owner: object, document: PaymentDocument, amount: int, reference: str | None) -> tuple:
    return (owner, document.kind, document.id, int(amount), (reference or "").strip())


def _log_outcome_unknown(owner: str, kind: str, number: str, retainer_number: str | None, exc: Exception) -> None:
    logger.error(
        "manual payment on %s (%s %s, retainer %s): Books did not answer the payment call, "
        "it may already be recorded there: %s",
        owner,
        kind,
        number,
        retainer_number,
        exc,
    )


async def _book(
    db: AsyncSession,
    *,
    document: PaymentDocument,
    mode: str,
    amount: int,
    ref: str,
    today: date,
    owner: str,
) -> ManualPaymentResult:
    """The Books writes of a manual payment. An invoice, or an open retainer, takes the payment directly; a quote or a
    sales order first gets a retainer invoice raised against it (reference = its number) and the payment lands on
    that. `owner` names the caller in the logs ("project 12", "order SO-00248")."""
    if document.kind in ("invoice", "retainer") and document.balance is not None and amount > document.balance:
        raise AmountAboveBalance(document.balance)
    mode_name = await _mode_name(db, mode)
    today_s = today.isoformat()
    if document.kind in ("invoice", "retainer"):
        target = {"invoice_id": document.id} if document.kind == "invoice" else {"retainerinvoice_id": document.id}
        try:
            payment = await zoho_service.record_customer_payment(
                db,
                customer_id=document.customer_id,
                payment_mode=mode_name,
                amount=amount,
                reference_number=ref,
                description=f"{document.number} · {mode}",
                today=today_s,
                **target,
            )
        except (ZohoUnreachable, ZohoAmbiguous) as exc:
            _log_outcome_unknown(owner, document.kind, document.number, None, exc)
            raise ManualPaymentOutcomeUnknown(None, exc) from exc
        return ManualPaymentResult(str(payment.get("payment_id") or ""), None, mode_name)
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
            "manual payment on %s (%s %s): Books did not answer the retainer invoice creation, "
            "a retainer may already exist there: %s",
            owner,
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
        # a payment Books may already hold.
        _log_outcome_unknown(owner, document.kind, document.number, retainer_number, exc)
        raise ManualPaymentOutcomeUnknown(retainer_number, exc) from exc
    except (ZohoNotConfiguredError, ZohoUpstreamError) as exc:
        raise ManualPaymentPartial(retainer_number, exc) from exc
    return ManualPaymentResult(str(payment.get("payment_id") or ""), retainer_number, mode_name)


async def _guarded(key: tuple, run: Callable[[], Awaitable[ManualPaymentResult]]) -> ManualPaymentResult:
    """Run a manual payment under the duplicate guard.

    The key is reserved BEFORE any Zoho call, not just after a successful one:
    two requests for the same document/amount/reference a few hundred ms apart
    both pass the check under async concurrency, and reserving only after the
    round trip would let both reach Books. A failure releases the key again,
    except the three where something already landed in Books and a retry would
    double it: `ManualPaymentPartial` (the retainer exists),
    `ManualPaymentUnrecorded` (the payment itself exists) and
    `ManualPaymentOutcomeUnknown` (a call timed out or got a 5xx / non-JSON
    answer -- it may exist). Those KEEP the key, and their message names what
    to check or finish by hand. The guard prunes entries past the window
    first, so the dict never grows past the tuples active within it."""
    now = time.monotonic()
    if _GUARD.is_recent(key, now):
        raise DuplicateManualPayment("This payment was recorded a moment ago")
    _GUARD.arm(key, now)
    try:
        return await run()
    except (ManualPaymentPartial, ManualPaymentUnrecorded, ManualPaymentOutcomeUnknown):
        raise
    except Exception:
        _GUARD.release(key)
        raise


async def _keep_record(db: AsyncSession, payment_id: str, owner: str, write: Callable[[], Awaitable[None]]) -> None:
    """Write and commit the local record of a payment Books already holds. Past this point the money HAS moved: a
    failure here is not a failure of the payment and must not read like one. The guard key stays (a reflex retry
    would write a second payment into Books), the Books payment id is named so a human can reconcile by hand, and
    the session is left usable for the route's own response."""
    try:
        await write()
        await db.commit()
        await broadcast_pending(db)
    except Exception as exc:
        logger.error(
            "manual payment %s is in Zoho Books (%s) but the local record failed: %s",
            payment_id,
            owner,
            exc,
            exc_info=True,
        )
        if not db.is_active:
            try:
                await db.rollback()
            except Exception:  # noqa: BLE001 — nothing left to salvage, the error below is the story
                pass
        raise ManualPaymentUnrecorded(payment_id, exc) from exc


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
    owner = f"project {project_id}"
    ref = (reference or "").strip()
    base = {"document_kind": document.kind, "document_number": document.number, "mode": mode, "amount": int(amount)}

    async def run() -> ManualPaymentResult:
        try:
            result = await _book(db, document=document, mode=mode, amount=amount, ref=ref, today=today, owner=owner)
        except ManualPaymentPartial as exc:
            await record(
                db,
                project_id,
                "payment.manual.partial",
                actor_class="user",
                actor_name=actor_name,
                subject_type="project",
                subject_id=project_id,
                detail={
                    **base,
                    "retainer_number": exc.retainer_number,
                    "reference": ref,
                    "error": str(exc.cause)[:500],
                },
            )
            await db.commit()
            raise

        async def write() -> None:
            await record(
                db,
                project_id,
                "payment.manual.recorded",
                actor_class="user",
                actor_name=actor_name,
                subject_type="project",
                subject_id=project_id,
                detail={
                    **base,
                    "mode_name": result.mode_name,
                    "reference": ref,
                    "zoho_payment_id": result.zoho_payment_id,
                    "retainer_number": result.retainer_number,
                },
            )

        await _keep_record(db, result.zoho_payment_id, owner, write)
        return result

    result = await _guarded(_guard_key(project_id, document, amount, reference), run)
    await refresh_after_payment(db, project_id, document.kind)
    return result


async def record_order_manual_payment(
    db: AsyncSession,
    salesorder_id: str,
    *,
    document: PaymentDocument,
    mode: str,
    amount: int,
    reference: str | None,
    today: date,
) -> ManualPaymentResult:
    """`record_manual_payment` for an Order Board order: the same Books writes and guard; the order's
    `payment.received` (with its method) is its history line, then the order is re-read so the board shows the
    money. Like the terminal's settle, the event is recorded before the re-read so the board tells it once."""
    from backend.app.services.aito_payment_documents import record_order_payment, refresh_order_after_payment

    owner = f"order {document.number if document.kind == 'salesorder' else salesorder_id}"
    ref = (reference or "").strip()
    started = datetime.now(timezone.utc).replace(tzinfo=None)

    async def run() -> ManualPaymentResult:
        result = await _book(db, document=document, mode=mode, amount=amount, ref=ref, today=today, owner=owner)

        async def write() -> None:
            await record_order_payment(db, salesorder_id, amount=int(amount), method=mode, since=started)

        await _keep_record(db, result.zoho_payment_id, owner, write)
        return result

    result = await _guarded(_guard_key(("order", salesorder_id), document, amount, reference), run)
    await refresh_order_after_payment(db, salesorder_id)
    return result


async def settle_invoiced_deposits(db: AsyncSession, project: AitoProject) -> None:
    """A deposit paid AFTER the invoice was raised: spend it on the invoice now
    rather than at the hourly sweep. Same rules as the sweep (only this quote's
    own deposits, newest invoice only). Raises like the Zoho calls it makes;
    the caller's best-effort wrapper owns the logging."""
    from backend.app.services import aito_invoice_sweep

    if not (project.quote_invoiced and project.quote_id):
        return
    invoices = await zoho_service.list_project_invoices(db, project.quote_id, project.client_id or "")
    if not invoices or float(invoices[0].get("balance") or 0) <= 0:
        return
    fresh, remaining = await aito_invoice_sweep.settle_with_deposits(
        db, project.id, project.quote_id, invoices[0], project.quote_number
    )
    project.invoice_status = fresh.get("status") or None
    project.invoice_balance = float(fresh.get("balance") or 0)
    project.invoice_total = invoice_total_of(fresh)
    project.invoice_due_date = fresh.get("due_date") or None
    remember_document_numbers(project, fresh.get("number"))
    if remaining is not None:
        project.customer_credit_total = remaining


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
        # A payment is what moves the client's rating: without this the panel
        # read the pre-payment tier ("Bad") until the hourly cache ran out.
        # Committed on its own so a failed Books read below cannot drop it.
        from backend.app.services.aito_client_rating import expire_client_rating

        await expire_client_rating(db, project.client_id)
        await db.commit()
        if kind == "invoice":
            from backend.app.services.aito_customer_credit import read_customer_credit

            invoices = await zoho_service.list_project_invoices(db, project.quote_id or "", project.client_id or "")
            if invoices:
                newest = invoices[0]
                project.invoice_status = newest.get("status") or None
                project.invoice_balance = float(newest.get("balance") or 0)
                project.invoice_total = invoice_total_of(newest)
                project.invoice_due_date = newest.get("due_date") or None
                remember_document_numbers(project, newest.get("number"))
            credit = await read_customer_credit(db, project.client_id)
            if credit is not None:
                project.customer_credit_total = credit
            await db.commit()
        else:
            from backend.app.services import aito_quote_sync

            await aito_quote_sync.sync_project(db, project)
            # Its own catch: the settle can raise AFTER Books took the money
            # and its `invoice.deposit_applied` events were recorded (a 429
            # on the re-read). Escaping to the outer catch would skip the
            # commit below and leave those events -- and sync_project's work
            # -- uncommitted for the next rollback on this session to drop.
            try:
                await settle_invoiced_deposits(db, project)
            except ZohoRateLimited as exc:
                aito_quote_sync._arm_rate_limit_throttle(exc)
                logger.warning("deposit settle after a quote payment on project %s was rate limited", project_id)
            except Exception as exc:  # noqa: BLE001 — the sweep retries within the hour
                logger.warning("deposit settle after a quote payment on project %s failed: %s", project_id, exc)
            # The paid-deposit auto-accept records quote.accepted, an inbox
            # row for the card's watchers: commit and push it here, as the
            # sweep does after its own sync_project.
            await db.commit()
        await broadcast_pending(db)
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
