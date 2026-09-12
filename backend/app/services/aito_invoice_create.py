"""Raising the real invoice from a finished project's quote.

Zoho has no "convert estimate to invoice" endpoint — Books' own KB says so
outright — so this builds the invoice itself and links it back with
``estimate_id``, which is the field ``list_project_invoices`` filters on and
therefore the only thing that makes the new invoice visible to the Invoice
card at all.

The line items are COPIED FROM THE ESTIMATE rather than re-derived from the
project's tasks. Those two are normally identical, but not always: a quote
can carry lines this app did not write (retail items, a laser cut, a line
typed by hand in Books — see ``aito_quote_export.is_foreign``), and a
re-derivation would silently drop every one of them from the bill. Copying
also means the client is invoiced for exactly the document they accepted,
down to the rounding, which is the only defensible thing to put on an
invoice.

The retainers come from ``estimate["retainerinvoices"]`` — the same field
``aito_quote_sync._is_locked`` already trusts. A retainer is a deposit the
client has already paid; Books records that payment as a customer ADVANCE,
and applying it to an invoice means pointing that advance payment at the
invoice (``POST /invoices/{id}/credits``), which is why this module chases
``retainer -> payments[] -> payment_id`` rather than sending an amount.
Verified against the live org (project 35, RET-00269, FA-26-4100).
"""

import logging
from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_project import AitoProject
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoUpstreamError, zoho_service

logger = logging.getLogger(__name__)

# Line-item fields Books will accept back on a create. Everything else it
# returns (line_item_id, item_total, tax_name, stock figures, the fifty
# inventory keys) is derived or belongs to the estimate's own lines, and
# echoing a foreign `line_item_id` into an INVOICE create would either be
# ignored or bind the new line to the estimate's row — neither is wanted.
#
# `name` earns its place for the lines that have no `item_id` (ad-hoc lines
# typed in Books), which would otherwise arrive nameless. `header_name` is
# how Books stores a line-item header on both estimates and invoices (see
# aito_quote_export.build_line_items), so the invoice PDF keeps the same
# per-task grouping the quote had.
_LINE_FIELDS = ("item_id", "name", "description", "rate", "quantity", "unit", "tax_id", "item_order")


@dataclass
class RetainerCredit:
    """One retainer invoice hanging off the quote, and what of it can be spent.

    ``applicable`` is the sum of its payments' UNUSED amounts, not its total:
    a retainer already drawn against an earlier invoice still reads
    ``status: paid`` with a full ``total``, and treating that as money would
    ask Books to spend the same deposit twice. ``total - applicable`` is
    therefore what the operator is shown as "not applied", whether the cause
    is an unpaid retainer or one already consumed.
    """

    id: str
    number: str
    status: str
    total: float
    applicable: float
    # (payment_id, unused amount), in the order Books listed them.
    payments: list[tuple[str, float]] = field(default_factory=list)


@dataclass
class InvoicePlan:
    """Everything the confirm dialog shows and the create path then uses.

    Built by one pass over Books so the preview and the create agree about
    what is about to happen — the alternative, letting the create recompute
    its own view, is how a dialog ends up promising one thing and doing
    another.
    """

    # The estimate as Books returned it, kept whole so build_invoice_payload
    # can copy the fields that decide the total without a second read.
    estimate: dict
    estimate_id: str
    estimate_number: str
    customer_id: str
    currency_code: str
    total: float
    line_items: list[dict]
    retainers: list[RetainerCredit]


@dataclass
class RetainerApplication:
    """What actually happened to one retainer when the invoice was raised."""

    number: str
    total: float
    applied: float


def build_line_items(estimate_lines: list[dict]) -> list[dict]:
    """The estimate's lines, reduced to what an invoice create accepts.

    Optional fields are omitted rather than sent empty: Books echoes
    ``header_name: ""`` and ``discount: 0`` on every ordinary line, and
    sending those back would put an empty header and a pointless discount
    column on the invoice PDF. ``discount`` is copied VERBATIM because Books
    echoes the long form it accepts (``"10.00%"`` for a ``"10%"`` push — see
    ``aito_quote_export.build_line_items``); re-deriving it as a bare number
    would be read as an amount, not a percent.
    """
    lines: list[dict] = []
    for source in estimate_lines:
        line = {key: source[key] for key in _LINE_FIELDS if source.get(key) not in (None, "")}
        if source.get("header_name"):
            line["header_name"] = source["header_name"]
        if source.get("discount"):
            line["discount"] = source["discount"]
        lines.append(line)
    return lines


async def _retainer_credit(db: AsyncSession, entry: dict) -> RetainerCredit:
    """One summary entry from the estimate, enriched with its payments.

    The estimate's own ``retainerinvoices`` entries carry the number, status
    and total but no payment ids, so each one costs a detail read. That is
    one call per retainer, and a project has one — this is not the sweep.
    """
    retainer_id = str(entry.get("retainerinvoice_id") or "")
    number = str(entry.get("retainerinvoice_number") or retainer_id)
    total = float(entry.get("total") or 0)
    credit = RetainerCredit(
        id=retainer_id, number=number, status=str(entry.get("status") or ""), total=total, applicable=0.0
    )
    if not retainer_id:
        # No id, no detail read, no payments: reported as fully unapplied
        # rather than dropped, so the operator still sees the deposit exists.
        return credit
    detail = await zoho_service.get_retainer_invoice(db, retainer_id)
    for payment in detail.get("payments") or []:
        payment_id = str(payment.get("payment_id") or "")
        unused = float(payment.get("unused_payment_amount") or 0)
        if payment_id and unused > 0:
            credit.payments.append((payment_id, unused))
            credit.applicable += unused
    return credit


async def plan_invoice(db: AsyncSession, project: AitoProject) -> InvoicePlan:
    """Read Books and work out what invoicing this project would do.

    Pure reads. Safe to call from the preview route and again from the create
    route — and the create route DOES call it again rather than trusting
    whatever the dialog echoes back, for the same reason ``send_invoice_email``
    re-reads its recipients: a client-supplied plan is not a plan.
    """
    estimate = await zoho_service.get_estimate(db, project.quote_id or "")
    retainers = [await _retainer_credit(db, entry) for entry in estimate.get("retainerinvoices") or []]
    return InvoicePlan(
        estimate=estimate,
        estimate_id=str(estimate.get("estimate_id") or project.quote_id or ""),
        estimate_number=str(estimate.get("estimate_number") or project.quote_number or ""),
        # The estimate's customer, not the project's: the estimate is what is
        # being billed, and a project row whose client_id drifted from the
        # quote it was imported from must not bill a different contact.
        customer_id=str(estimate.get("customer_id") or ""),
        currency_code=str(estimate.get("currency_code") or ""),
        total=float(estimate.get("total") or 0),
        line_items=build_line_items(estimate.get("line_items") or []),
        retainers=retainers,
    )


def build_invoice_payload(plan: InvoicePlan) -> dict:
    """The body of ``POST /invoices``.

    Deliberately minimal. Notes, terms and template are NOT copied from the
    estimate: Books fills those from the INVOICE defaults, which is what the
    org's own quote-to-invoice conversion does (verified on FA-26-4100, whose
    terms are the invoice template's reserve-of-property clause, not the
    estimate's deposit clause). Copying them would put quote wording on a
    bill.

    What is copied is everything that decides the TOTAL — currency, inclusive
    tax, and the two discount switches — so the invoice adds up to the figure
    the client accepted rather than to whatever the org default would make of
    the same lines.
    """
    payload: dict = {
        "customer_id": plan.customer_id,
        # The link. Without it the invoice exists but no Aito surface can
        # find it: `list_project_invoices` filters `GET /invoices` by
        # estimate_id and nothing else.
        "estimate_id": plan.estimate_id,
        "line_items": plan.line_items,
    }
    for key in ("currency_id", "is_inclusive_tax", "discount_type", "is_discount_before_tax"):
        if plan.estimate.get(key) not in (None, ""):
            payload[key] = plan.estimate[key]
    return payload


def share_out(retainers: list[RetainerCredit], balance: float) -> list[tuple[RetainerCredit, list[dict]]]:
    """How much of each retainer goes on an invoice with this balance.

    Every application is capped at what is STILL owed after the retainers
    ahead of it — Books rejects an over-application outright, and two
    deposits that together exceed a job that shrank is a real case. First
    listed, first spent: Books orders an estimate's retainers by date, and
    spending the oldest deposit first is what an accountant would do.

    Shared by the preview and the create so the confirm dialog cannot
    promise a split the create then does differently. Returns each retainer
    with the ``invoice_payments`` entries it contributes — empty for one with
    nothing left to spend, which the callers still report rather than drop.
    """
    shares: list[tuple[RetainerCredit, list[dict]]] = []
    remaining = balance
    for retainer in retainers:
        payments: list[dict] = []
        for payment_id, unused in retainer.payments:
            if remaining <= 0:
                break
            amount = min(unused, remaining)
            payments.append({"payment_id": payment_id, "amount_applied": amount})
            remaining -= amount
        shares.append((retainer, payments))
    return shares


async def apply_retainers(
    db: AsyncSession, invoice_id: str, balance: float, retainers: list[RetainerCredit]
) -> list[RetainerApplication]:
    """Point each retainer's unused advance payments at the new invoice.

    One Books call per retainer, each carrying all of that retainer's
    payments, so a failure costs one deposit rather than all of them.

    Never raises. The invoice already exists at this point; a failure here
    leaves an unpaid invoice and a report saying so, which the operator can
    settle in Books in one click. Blowing up instead would tell them the
    whole thing failed while a real invoice sat in their books.
    """
    applications: list[RetainerApplication] = []
    # Computed up front, in one pass, rather than re-derived as we go: a
    # retainer whose application FAILS must not hand its share to the ones
    # behind it. Books would accept that (the balance really is still owed),
    # but it would silently spend a different deposit than the dialog named.
    for retainer, payments in share_out(retainers, balance):
        applied = sum(p["amount_applied"] for p in payments)
        if payments:
            try:
                await zoho_service.apply_invoice_credits(db, invoice_id, payments)
            except (ZohoNotConfiguredError, ZohoUpstreamError) as e:
                # Nothing was applied. The share is NOT handed to the
                # retainers behind it — see the comment above the loop.
                applied = 0.0
                logger.warning(
                    "Aito invoice %s: applying retainer %s failed, invoice left unpaid by it: %s",
                    invoice_id,
                    retainer.number,
                    e,
                )
        applications.append(RetainerApplication(number=retainer.number, total=retainer.total, applied=applied))
    return applications
