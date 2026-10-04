"""Spend this quote's own deposit on its open invoice, by hand.

The hourly sweep (aito_invoice_sweep.settle_with_deposits) does this
automatically and always as much as it can; this is the operator's version:
now, and for the amount they choose. Same eligibility rule as the sweep
(`linked_credits`), and every figure is re-read from Books at apply time —
the client's numbers only say what the operator MEANT, never what is true."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_project import AitoProject
from backend.app.services import aito_events
from backend.app.services.aito_customer_credit import read_customer_credit
from backend.app.services.aito_invoice_create import RetainerCredit, customer_credits, share_out
from backend.app.services.aito_invoice_sweep import linked_credits
from backend.app.services.zoho import zoho_service

# Books keeps cents; a client-side float may differ in the last digit.
_CENT = 0.005


class DepositNotFound(Exception):
    pass


class DepositAmountTooHigh(Exception):
    def __init__(self, cap: float):
        super().__init__(f"At most {cap:.2f} can be applied")
        self.cap = cap


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
    invoice, credits = await project_deposits(db, project)
    if invoice is None or str(invoice.get("id")) != invoice_id:
        raise DepositNotFound("That invoice is not this project's open invoice")
    credit = next((c for c in credits if c.id == retainer_id), None)
    if credit is None:
        raise DepositNotFound("That deposit is not one of this quote's")
    cap = min(float(invoice.get("balance") or 0), credit.applicable)
    if amount > cap + _CENT:
        raise DepositAmountTooHigh(cap)
    amount = min(amount, cap)

    [(_, payments)] = share_out([credit], amount)
    await zoho_service.apply_invoice_credits(db, invoice_id, payments)
    await aito_events.record(
        db,
        project.id,
        "invoice.deposit_applied",
        actor_class="user",
        actor_name=actor_name,
        subject_type="project",
        subject_id=project.id,
        detail={
            "retainer_number": credit.number,
            "invoice_number": str(invoice.get("number") or ""),
            "amount": round(amount, 2),
            "source": "manual",
        },
    )
    fresh = await zoho_service.get_invoice(db, invoice_id) or invoice
    project.invoice_status = fresh.get("status") or None
    project.invoice_balance = float(fresh.get("balance") or 0)
    project.invoice_due_date = fresh.get("due_date") or None
    credit_total = await read_customer_credit(db, project.client_id)
    if credit_total is not None:
        project.customer_credit_total = credit_total
    await db.commit()
    return fresh
