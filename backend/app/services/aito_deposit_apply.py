"""Spend this quote's own deposit on its open invoice, by hand.

The hourly sweep (aito_invoice_sweep.settle_with_deposits) does this
automatically and always as much as it can; this is the operator's version:
now, and for the amount they choose. Same eligibility rule as the sweep
(`linked_credits`), and every figure is re-read from Books at apply time —
the client's numbers only say what the operator MEANT, never what is true."""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_project import AitoProject
from backend.app.services import aito_events
from backend.app.services.aito_customer_credit import read_customer_credit
from backend.app.services.aito_invoice_create import RetainerCredit, customer_credits, share_out
from backend.app.services.aito_invoice_sweep import linked_credits
from backend.app.services.zoho import (
    ZohoAmbiguous,
    ZohoNotConfiguredError,
    ZohoUnreachable,
    ZohoUpstreamError,
    zoho_service,
)

logger = logging.getLogger(__name__)

# Books keeps cents; a client-side float may differ in the last digit.
_CENT = 0.005


class DepositNotFound(Exception):
    pass


class DepositAmountTooHigh(Exception):
    def __init__(self, cap: float):
        super().__init__(f"At most {cap:.2f} can be applied")
        self.cap = cap


class DepositAmountTooSmall(Exception):
    """Below one cent once rounded: Books keeps cents, there is nothing to send."""


class DepositOutcomeUnknown(Exception):
    """Books did not say whether the application landed (read timeout, gateway
    5xx). The attempt is on record; a blind retry could apply it twice."""

    MESSAGE = "The deposit may have been applied; check the invoice before retrying."

    def __init__(self, cause: Exception):
        super().__init__(self.MESSAGE)
        self.cause = cause


async def project_deposits(db: AsyncSession, project: AitoProject) -> tuple[dict | None, list[RetainerCredit]]:
    """(newest invoice or None, this quote's spendable deposits oldest first)."""
    if not (project.quote_id and project.quote_invoiced):
        return None, []
    invoices = await zoho_service.list_project_invoices(db, project.quote_id, project.client_id or "")
    if not invoices:
        return None, []
    estimate = await zoho_service.get_estimate(db, project.quote_id)
    credits = linked_credits(estimate, await customer_credits(db, estimate), project.quote_number)
    return invoices[0], [c for c in credits if c.applicable > 0]


async def apply_deposit(
    db: AsyncSession,
    project: AitoProject,
    *,
    invoice_id: str,
    retainer_id: str,
    amount: float,
    actor_name: str | None,
) -> dict:
    amount = round(amount, 2)
    if amount < 0.01:
        raise DepositAmountTooSmall("The amount must be at least 0.01")
    project_id, client_id = project.id, project.client_id
    invoice, credits = await project_deposits(db, project)
    if invoice is None or str(invoice.get("id")) != invoice_id:
        raise DepositNotFound("That invoice is not this project's open invoice")
    credit = next((c for c in credits if c.id == retainer_id), None)
    if credit is None:
        raise DepositNotFound("That deposit is not one of this quote's")
    cap = round(min(float(invoice.get("balance") or 0), credit.applicable), 2)
    if cap < 0.01 or amount > cap + _CENT:
        raise DepositAmountTooHigh(max(cap, 0.0))
    amount = min(amount, cap)

    [(_, payments)] = share_out([credit], amount)
    if not payments:
        raise DepositAmountTooHigh(cap)
    sent = round(sum(float(p["amount_applied"]) for p in payments), 2)
    detail = {
        "retainer_number": credit.number,
        "invoice_number": str(invoice.get("number") or ""),
        "amount": sent,
        "source": "manual",
    }
    try:
        await zoho_service.apply_invoice_credits(db, invoice_id, payments)
    except (ZohoUnreachable, ZohoAmbiguous) as exc:
        # The write may have landed: keep the attempt on record (same rule as
        # record_manual_payment) and tell the operator to look before retrying.
        logger.error(
            "Deposit %s on invoice %s (project %s): Books did not say whether the application landed: %s",
            credit.number,
            invoice_id,
            project_id,
            exc,
        )
        await aito_events.record(
            db,
            project_id,
            "invoice.deposit_applied",
            actor_class="user",
            actor_name=actor_name,
            subject_type="project",
            subject_id=project_id,
            detail={**detail, "outcome": "unknown"},
        )
        await db.commit()
        raise DepositOutcomeUnknown(exc) from exc
    await aito_events.record(
        db,
        project_id,
        "invoice.deposit_applied",
        actor_class="user",
        actor_name=actor_name,
        subject_type="project",
        subject_id=project_id,
        detail=detail,
    )
    # The money has moved: keep the record before anything else can fail, so a
    # retry never sees a deposit that was spent without a trace.
    await db.commit()

    # Everything below is a best-effort refresh (same stance as the sweep): a
    # Books hiccup must not turn a successful application into an error.
    try:
        fresh = await zoho_service.get_invoice(db, invoice_id)
    except (ZohoNotConfiguredError, ZohoUpstreamError) as exc:
        logger.warning("Deposit applied to invoice %s but it could not be re-read: %s", invoice_id, exc)
        fresh = None
    if not fresh:
        balance = max(float(invoice.get("balance") or 0) - sent, 0.0)
        fresh = {**invoice, "balance": round(balance, 2)}
    project.invoice_status = fresh.get("status") or None
    project.invoice_balance = float(fresh.get("balance") or 0)
    project.invoice_due_date = fresh.get("due_date") or None
    try:
        credit_total = await read_customer_credit(db, client_id)
    except (ZohoNotConfiguredError, ZohoUpstreamError) as exc:
        logger.warning("Deposit applied to invoice %s but customer credit could not be read: %s", invoice_id, exc)
        credit_total = None
    if credit_total is not None:
        project.customer_credit_total = credit_total
    await db.commit()
    return fresh
