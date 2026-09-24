"""Counter payments for a project card: a card charge on the Heimdall
terminal, a payment recorded by hand into Zoho Books, and an on-demand
payment link for an invoice. Split out of routes/aito.py (4000+ lines);
shares its helpers. Spec: docs/superpowers/specs/2026-09-23-aito-counter-payments-design.md."""

from __future__ import annotations

import logging
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.aito import (
    _actor,
    _check_rate_limit,
    _get_active_project_or_404,
    _project_response,
)
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
)
from backend.app.services.aito_manual_payments import (
    AmountAboveBalance,
    DuplicateManualPayment,
    ManualPaymentPartial,
    ManualPaymentUnrecorded,
    record_manual_payment,
)
from backend.app.services.aito_payment_documents import DocumentMismatch, resolve_document
from backend.app.services.aito_payment_links import (
    InvoiceLinkExists,
    QuoteLinkManaged,
    cancel_invoice_link,
    create_invoice_link,
    current_link,
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
)
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoUpstreamError

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


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


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
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    """Fire the counter terminal for this project's quote deposit or invoice
    balance. 201 with the ledger row (`processing`); poll the GET below."""
    _check_counter_payment_rate_limit(request, current_user)
    project = await _get_active_project_or_404(db, project_id)
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
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_READ),
):
    """The row, refreshed from Heimdall when it is still open (throttled)."""
    await _get_active_project_or_404(db, project_id)
    row = await db.get(AitoTerminalPayment, payment_id)
    if row is None or row.project_id != project_id:
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
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    _check_counter_payment_rate_limit(request, current_user)
    if body.mode == "cheque" and not (body.reference or "").strip():
        raise _refuse(422, "reference_required", "A cheque needs its number as reference")
    project = await _get_active_project_or_404(db, project_id)
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
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    """An OSB link for this project's invoice (quote links are minted by the
    reconciler and never through here)."""
    from backend.app.services.aito_quote_sync import quote_validity_days

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
            validity_days=await quote_validity_days(db),
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
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    project = await _get_active_project_or_404(db, project_id)
    row = await db.get(AitoPaymentLink, link_id)
    if row is None or row.project_id != project_id:
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
