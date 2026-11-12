"""Counter payments for a project card: a card charge on the Heimdall
terminal, a payment recorded by hand into Zoho Books, and an on-demand
payment link for an invoice. Split out of routes/aito.py (4000+ lines);
shares its helpers. Spec: docs/superpowers/specs/2026-09-23-aito-counter-payments-design.md."""

from __future__ import annotations

import hmac
import json
import logging
import re
import time
from datetime import date

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.aito import (
    _actor,
    _check_rate_limit,
    _get_active_project_or_404,
    _project_response,
)
from backend.app.api.routes.settings import get_setting
from backend.app.core import database as core_database
from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.models.aito_terminal_payment import AitoTerminalPayment
from backend.app.models.user import User
from backend.app.schemas.aito import (
    AitoInvoiceLinkCreate,
    AitoManualPaymentCreate,
    AitoProjectResponse,
    AitoTerminalPaymentCreate,
    AitoTerminalPaymentView,
    AitoUnlinkedRetainer,
)
from backend.app.services import aito_payment_links, aito_quote_sync
from backend.app.services.aito_customer_credit import unlinked_retainers
from backend.app.services.aito_events import utc_now_naive as _now
from backend.app.services.aito_manual_payments import (
    AmountAboveBalance,
    DuplicateManualPayment,
    ManualPaymentOutcomeUnknown,
    ManualPaymentPartial,
    ManualPaymentUnrecorded,
    record_manual_payment,
    refresh_after_payment,
)
from backend.app.services.aito_payment_documents import DocumentMismatch, resolve_document
from backend.app.services.aito_payment_links import (
    InvoiceLinkExists,
    QuoteLinkManaged,
    cancel_invoice_link,
    create_invoice_link,
    current_link,
    reconcile_payment_links,
)
from backend.app.services.aito_terminal_payments import (
    TerminalInProgress,
    refresh_terminal_payment,
    start_terminal_payment,
    terminal_view,
)
from backend.app.services.heimdall import (
    HeimdallAuthError,
    HeimdallConflict,
    HeimdallInvalid,
    HeimdallNotConfigured,
    HeimdallNotFound,
    HeimdallRateLimited,
    HeimdallUpstreamError,
    sign,
)
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoRateLimited, ZohoUpstreamError, zoho_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/aito", tags=["aito"])

_COUNTER_PAYMENT_MAX_CALLS = 10
_COUNTER_PAYMENT_DETAIL = "Too many payment requests. Please wait a moment and try again."


def _check_counter_payment_rate_limit(request: Request, current_user: User | None) -> None:
    """`_check_rate_limit` answers its own 429 with a plain-string `detail`
    (aito.py's convention); this module's binding rule is a structured
    `{"code","message"}` body on every 4xx/5xx, so its 429 is re-raised
    through `_refuse` rather than propagated as-is."""
    try:
        _check_rate_limit(
            request,
            current_user,
            bucket="counter_payment",
            max_calls=_COUNTER_PAYMENT_MAX_CALLS,
            detail=_COUNTER_PAYMENT_DETAIL,
        )
    except HTTPException as e:
        raise _refuse(429, "rate_limited", _COUNTER_PAYMENT_DETAIL) from e


def _refuse(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


async def _document(db: AsyncSession, project, kind: str, document_id: str):
    try:
        return await resolve_document(db, project, kind, document_id)
    except DocumentMismatch as e:
        raise _refuse(422, "document_mismatch", str(e)) from e
    except (ZohoNotConfiguredError, ZohoUpstreamError) as e:
        raise _refuse(502, "upstream", str(e)) from e


def _heimdall_refusal(e: HeimdallUpstreamError, *, invalid_code: str = "amount_above_balance") -> HTTPException:
    """`invalid_code`: what a Heimdall 422 means on THIS route. On the
    terminal create it is essentially always the balance cap, so the code
    says so; on the link create it can be any invalid field, so it stays the
    neutral `invalid` and the frontend shows Heimdall's own message."""
    if isinstance(e, HeimdallAuthError) and e.status == 403:
        return _refuse(502, "forbidden", "The Heimdall key has no permission to charge the terminal")
    if isinstance(e, HeimdallConflict):
        code = "terminal_busy" if e.code == "terminal_busy" else "conflict"
        return _refuse(409, code, str(e))
    if isinstance(e, HeimdallInvalid):
        return _refuse(422, invalid_code, str(e))
    if isinstance(e, HeimdallNotFound):
        return _refuse(422, "document_unknown", str(e))
    if isinstance(e, HeimdallRateLimited):
        return _refuse(429, "rate_limited", str(e))
    return _refuse(502, "upstream", str(e))


@router.post(
    "/{project_id}/terminal-payment",
    response_model=AitoTerminalPaymentView,
    status_code=201,
    name="start_terminal_payment",  # the permission tests look the route up by this name
)
async def start_terminal_payment_route(
    project_id: int,
    body: AitoTerminalPaymentCreate,
    request: Request,
    db: AsyncSession = Depends(get_db, scope="function"),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    """Fire the counter terminal for this project's quote deposit or invoice
    balance. 201 with the ledger row (`processing`); poll the GET below."""
    _check_counter_payment_rate_limit(request, current_user)
    project = await _get_active_project_or_404(db, project_id)
    if body.document_kind == "quote" and project.quote_invoiced:
        # The deposit is moot once the job is billed: collect on the invoice.
        raise _refuse(409, "quote_invoiced", "This quote is invoiced: collect the invoice balance instead")
    document = await _document(db, project, body.document_kind, body.document_id)
    try:
        row = await start_terminal_payment(
            db, project, document=document, amount=body.amount, actor_name=_actor(current_user), now=_now()
        )
    except TerminalInProgress as e:
        raise _refuse(409, "terminal_in_progress", str(e)) from e
    except HeimdallNotConfigured as e:
        raise _refuse(502, "not_configured", str(e)) from e
    except HeimdallUpstreamError as e:
        raise _heimdall_refusal(e) from e
    return terminal_view(row)


@router.get("/{project_id}/terminal-payment/{payment_id}", response_model=AitoTerminalPaymentView)
async def get_terminal_payment(
    project_id: int,
    payment_id: int,
    db: AsyncSession = Depends(get_db, scope="function"),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_READ),
):
    """The row, refreshed from Heimdall when it is still open (throttled)."""
    await _get_active_project_or_404(db, project_id)
    row = await db.get(AitoTerminalPayment, payment_id)
    if row is None or row.project_id != project_id or row.salesorder_id is not None:
        raise HTTPException(status_code=404, detail="Terminal payment not found")
    try:
        row = await refresh_terminal_payment(db, row, now=_now())
    except HeimdallRateLimited as e:
        raise _refuse(429, "rate_limited", str(e)) from e
    return terminal_view(row)


@router.post("/{project_id}/manual-payment", response_model=AitoProjectResponse)
async def record_manual_payment_route(
    project_id: int,
    body: AitoManualPaymentCreate,
    request: Request,
    db: AsyncSession = Depends(get_db, scope="function"),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    _check_counter_payment_rate_limit(request, current_user)
    if body.mode == "cheque" and not (body.reference or "").strip():
        raise _refuse(422, "reference_required", "A cheque needs its number as reference")
    project = await _get_active_project_or_404(db, project_id)
    if body.document_kind == "quote" and project.quote_invoiced:
        # The deposit is moot once the job is billed: collect on the invoice.
        raise _refuse(409, "quote_invoiced", "This quote is invoiced: collect the invoice balance instead")
    document = await _document(db, project, body.document_kind, body.document_id)
    try:
        await record_manual_payment(
            db,
            project,
            document=document,
            mode=body.mode,
            amount=body.amount,
            reference=body.reference,
            actor_name=_actor(current_user),
            today=date.today(),
        )
    except DuplicateManualPayment as e:
        raise _refuse(409, "duplicate", str(e)) from e
    except AmountAboveBalance as e:
        raise _refuse(422, "amount_above_balance", str(e)) from e
    except ManualPaymentPartial as e:
        raise _refuse(
            502,
            "manual_partial",
            f"Retainer {e.retainer_number} was raised in Zoho Books but its payment could not be recorded: "
            f"{e.cause}. Record the payment on it in Books.",
        ) from e
    except ManualPaymentOutcomeUnknown as e:
        # Books did not answer the payment call (a timeout can land after
        # Books applied it). The guard stays armed, so an identical retry
        # inside the window answers 409; the message says to look first.
        if e.stage == "retainer":
            # T-079: the retainer invoice creation itself went unanswered --
            # no payment was attempted, but a retainer may exist in Books.
            raise _refuse(
                502,
                "manual_outcome_unknown",
                f"Zoho Books did not answer the retainer invoice creation ({e.cause}). "
                "A retainer invoice may already be in Books — check before retrying.",
            ) from e
        prefix = (
            f"Retainer {e.retainer_number} was raised in Zoho Books but Books did not answer the payment on it"
            if e.retainer_number
            else "Zoho Books did not answer the payment"
        )
        raise _refuse(
            502,
            "manual_outcome_unknown",
            f"{prefix} ({e.cause}). The payment may already be in Books — check before retrying.",
        ) from e
    except ManualPaymentUnrecorded as e:
        # The money moved. Never a 500 (spec §8: once an upstream side effect
        # has landed the route reports it rather than looking like nothing
        # happened) — and the Books payment id is in the message so the
        # operator can reconcile it by hand.
        raise _refuse(
            502,
            "manual_unrecorded",
            f"The payment {e.zoho_payment_id} was recorded in Zoho Books but the local record failed: {e.cause}",
        ) from e
    except (ZohoNotConfiguredError, ZohoUpstreamError) as e:
        await db.rollback()
        raise _refuse(502, "upstream", str(e)) from e
    project = await _get_active_project_or_404(db, project_id)
    return await _project_response(db, project)


@router.post("/{project_id}/payment-link", response_model=AitoProjectResponse)
async def create_invoice_payment_link(
    project_id: int,
    body: AitoInvoiceLinkCreate,
    request: Request,
    db: AsyncSession = Depends(get_db, scope="function"),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    """An OSB link for this project's invoice (quote links are minted by the
    reconciler and never through here)."""
    _check_counter_payment_rate_limit(request, current_user)
    project = await _get_active_project_or_404(db, project_id)
    document = await _document(db, project, "invoice", body.document_id)
    # A live, minted link is the refusal the operator cannot clear by
    # editing the amount, so it is checked before the balance cap (spec
    # §6.2). create_invoice_link's own InvoiceLinkExists guard stays as the
    # backstop for the other cases (an in-flight reservation, a replay).
    existing = await current_link(db, project_id, kind="invoice")
    if existing is not None and existing.heimdall_id is not None and existing.status == "pending":
        raise _refuse(409, "link_exists", "A payment link is already open for this invoice")
    if document.balance is not None and body.amount > document.balance:
        raise _refuse(422, "amount_above_balance", f"Amount exceeds the invoice balance of {document.balance}")
    try:
        await create_invoice_link(
            db,
            project,
            document=document,
            amount=body.amount,
            actor_name=_actor(current_user),
            now=_now(),
            today=date.today(),
        )
    except InvoiceLinkExists as e:
        raise _refuse(409, "link_exists", str(e)) from e
    except HeimdallNotConfigured as e:
        raise _refuse(502, "not_configured", str(e)) from e
    except HeimdallUpstreamError as e:
        raise _heimdall_refusal(e, invalid_code="invalid") from e
    project = await _get_active_project_or_404(db, project_id)
    return await _project_response(db, project)


@router.post("/{project_id}/payment-link/{link_id}/cancel", response_model=AitoProjectResponse)
async def cancel_invoice_payment_link(
    project_id: int,
    link_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db, scope="function"),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    _check_counter_payment_rate_limit(request, current_user)
    project = await _get_active_project_or_404(db, project_id)
    row = await db.get(AitoPaymentLink, link_id)
    if row is None or row.project_id != project_id or row.salesorder_id is not None:
        raise HTTPException(status_code=404, detail="Payment link not found")
    # Only a live link can be cancelled. A dead one (paid, expired, already
    # cancelled) would answer Heimdall's own 409 as an opaque `conflict`, and
    # an unminted reservation has no Heimdall id to cancel at all — it would
    # have gone out as `POST /payments/None/cancel`.
    if row.heimdall_id is None or row.status != "pending":
        raise _refuse(409, "not_cancellable", "This payment link is not open and cannot be cancelled")
    try:
        await cancel_invoice_link(db, project, row, actor_name=_actor(current_user), now=_now())
    except QuoteLinkManaged as e:
        raise _refuse(409, "quote_link_managed", str(e)) from e
    except HeimdallNotConfigured as e:
        raise _refuse(502, "not_configured", str(e)) from e
    except HeimdallUpstreamError as e:
        raise _heimdall_refusal(e) from e
    project = await _get_active_project_or_404(db, project_id)
    return await _project_response(db, project)


async def _unlinked_retainers(db: AsyncSession, project) -> list[dict]:
    try:
        return await unlinked_retainers(db, project.client_id)
    except ZohoRateLimited as e:
        aito_quote_sync._arm_rate_limit_throttle(e)
        raise _refuse(429, "rate_limited", str(e)) from e
    except (ZohoNotConfiguredError, ZohoUpstreamError) as e:
        raise _refuse(502, "upstream", str(e)) from e


@router.get("/{project_id}/unlinked-retainers", response_model=list[AitoUnlinkedRetainer])
async def get_unlinked_retainers(
    project_id: int,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_READ),
):
    """The customer's paid deposits that name no quote, so the panel can warn
    that they do not count toward this quote's deposit. Live from Books."""
    project = await _get_active_project_or_404(db, project_id)
    return await _unlinked_retainers(db, project)


@router.post("/{project_id}/unlinked-retainers/{retainer_id}/link", response_model=AitoProjectResponse)
async def link_retainer(
    project_id: int,
    retainer_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db, scope="function"),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    """Tie an unlinked deposit to this quote by writing the quote number into
    the retainer's reference in Books, then re-sync the card so the deposit
    due, the payment link and the auto-accept see it at once."""
    _check_counter_payment_rate_limit(request, current_user)
    project = await _get_active_project_or_404(db, project_id)
    if not project.quote_number:
        raise _refuse(409, "no_quote", "This card has no quote to link a deposit to")
    # Re-read rather than trust the id: only a deposit of THIS customer that
    # still names no quote may be re-pointed.
    if retainer_id not in {row["id"] for row in await _unlinked_retainers(db, project)}:
        raise _refuse(409, "not_unlinked", "This deposit is not an unlinked deposit of this customer")
    try:
        await zoho_service.set_retainer_reference(db, retainer_id, project.quote_number)
    except ZohoRateLimited as e:
        aito_quote_sync._arm_rate_limit_throttle(e)
        raise _refuse(429, "rate_limited", str(e)) from e
    except (ZohoNotConfiguredError, ZohoUpstreamError) as e:
        raise _refuse(502, "upstream", str(e)) from e
    await refresh_after_payment(db, project_id, "quote")
    # The deposit may now be covered: cancel the online link now rather than
    # at the loop's next pass, so the customer is not offered it meanwhile
    # (same pattern as the quote-extend route).
    if not aito_payment_links._pass_lock.locked():
        try:
            await reconcile_payment_links(db, only_project_id=project_id, force=True)
        except Exception:
            logger.exception("Aito retainer link: payment link reconcile failed for project %s", project_id)
            await db.rollback()
    project = await _get_active_project_or_404(db, project_id)
    return await _project_response(db, project)


# --- Heimdall webhook (payment-links spec §9, "phase 3 — instant") ----------

_WEBHOOK_WINDOW_SECONDS = 300
_WEBHOOK_MAX_BODY_BYTES = 4096
_WEBHOOK_MAX_CALLS = 120  # per client IP per minute; Heimdall sends a handful per payment
_WEBHOOK_NONCE_RE = re.compile(r"[A-Za-z0-9_-]{16,128}")
_WEBHOOK_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,36}")  # the ledgers' heimdall_id is String(36)


def _webhook_signature_ok(request: Request, body: bytes, secret: str) -> bool:
    """True when the three X-Heimdall-* headers sign this exact request with
    `secret`, inside the timestamp window. Constant-time on the digest."""
    timestamp = request.headers.get("x-heimdall-timestamp", "")
    nonce = request.headers.get("x-heimdall-nonce", "")
    presented = request.headers.get("x-heimdall-signature", "")
    if not (timestamp.isascii() and timestamp.isdigit() and len(timestamp) <= 13 and str(int(timestamp)) == timestamp):
        return False
    if abs(time.time() - int(timestamp)) > _WEBHOOK_WINDOW_SECONDS:
        return False
    if not _WEBHOOK_NONCE_RE.fullmatch(nonce):
        return False
    path = request.url.path + (f"?{request.url.query}" if request.url.query else "")
    expected = sign("POST", path, body, secret, int(timestamp), nonce)
    return hmac.compare_digest(expected.encode("utf-8"), presented.encode("utf-8"))


async def _wake_payment(heimdall_id: str) -> None:
    """Re-read one Heimdall payment NOW, through the code the poller uses:
    the link pass for a ledger link (`reconcile_payment_links`, one row,
    under its pass lock) and `refresh_terminal_payment` for a terminal
    payment (whose settle is claimed, so a concurrent poll cannot settle it
    twice). Order Board rows live in the same two ledgers. Runs after the
    response, on its own session; an id in neither ledger does nothing."""
    try:
        async with core_database.async_session() as db:
            link_id = (
                await db.execute(select(AitoPaymentLink.id).where(AitoPaymentLink.heimdall_id == heimdall_id))
            ).scalar()
            if link_id is not None:
                await reconcile_payment_links(db, only_link_id=link_id, force=True)
            terminal = (
                await db.execute(select(AitoTerminalPayment).where(AitoTerminalPayment.heimdall_id == heimdall_id))
            ).scalar()
            if terminal is not None:
                await refresh_terminal_payment(db, terminal, now=_now(), force=True)
    except Exception as exc:  # noqa: BLE001 — a wake is best effort; the poll is the fallback
        logger.warning("Heimdall webhook: waking payment %s failed: %s", heimdall_id, exc)


@router.post("/payments/webhook", status_code=204)
async def heimdall_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db, scope="function"),
) -> Response:
    """Heimdall's "this payment changed" notification. PUBLIC: no session, the
    signature is the credential. Off (404) until `heimdall_webhook_secret` is
    saved under Settings → Heimdall.

    The payload is NEVER trusted for money. A valid call only wakes the
    poller's own code path for that one payment (`_wake_payment`), which
    reads the status and amount from Heimdall itself; polling stays the
    fallback, and a webhook racing a poll settles once.

    Signing scheme (identical in heimdall/docs/API.md, "Payment webhook"):

        POST <webhook URL>, Content-Type: application/json
        X-Heimdall-Timestamp: Unix seconds
        X-Heimdall-Nonce:     [A-Za-z0-9_-]{16,128}, fresh on every attempt
        X-Heimdall-Signature: "sha256=" + lowercase hex HMAC-SHA256(secret, signed string)

        signed string = these six fields joined by "\n":
            POST
            path of the webhook URL, with its query string, exactly as sent
            timestamp
            nonce
            SHA-256(raw request body), lowercase hex
            (empty string — there is no Idempotency-Key)

        body = {"id": <Heimdall payment id>, "kind": "link" | "terminal",
                "status": <Heimdall public status>, "occurred_at": <ISO 8601 UTC>}

    Verified over the raw body bytes, compared in constant time, timestamp
    within ±300 s. Every refusal — missing or malformed header, stale
    timestamp, wrong signature, oversized body — is the same 401. A valid
    call always answers 204, whether or not the id is one of ours: nothing
    here says which ids exist. No nonce table: a replay inside the window
    can only repeat a wake, which is idempotent and rate limited (per IP).
    """
    _check_rate_limit(
        request, None, bucket="heimdall_webhook", max_calls=_WEBHOOK_MAX_CALLS, detail="Too many requests"
    )
    secret = (await get_setting(db, "heimdall_webhook_secret") or "").strip()
    if not secret:
        raise HTTPException(status_code=404, detail="Not Found")
    refused = HTTPException(status_code=401, detail="Unauthorized")
    declared = request.headers.get("content-length", "")
    if not declared.isdigit() or int(declared) > _WEBHOOK_MAX_BODY_BYTES:
        raise refused
    body = await request.body()
    if len(body) > _WEBHOOK_MAX_BODY_BYTES or not _webhook_signature_ok(request, body, secret):
        raise refused
    try:
        heimdall_id = json.loads(body)["id"]
    except (ValueError, KeyError, TypeError):
        heimdall_id = None
    if isinstance(heimdall_id, str) and _WEBHOOK_ID_RE.fullmatch(heimdall_id):
        background_tasks.add_task(_wake_payment, heimdall_id)
    return Response(status_code=204)
