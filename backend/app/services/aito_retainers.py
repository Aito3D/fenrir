"""Which of a customer's retainer invoices belong to THIS project.

A retainer invoice is a customer document in Books. It appears on the
estimate's own ``retainerinvoices`` list only when it was raised FROM the
estimate; a deposit taken at the counter (aito_manual_payments) or booked by
Heimdall for a paid payment link is raised against the customer with the
quote number as its ``reference_number`` and nothing else. The Billing card
wants both, so this reads the customer's retainers and keeps the ones that
are attached OR reference the quote — the same two signals
``aito_quote_sync._referenced_retainer_total`` and
``aito_invoice_sweep.linked_credits`` trust, with the reference rule imported
rather than re-implemented so the three cannot drift.

Two Books reads per call (the estimate, then the customer's retainers). The
panel only asks once a project can plausibly have a retainer — see
``mayHaveRetainers`` in the frontend — so a quoted, unpaid job costs nothing.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services.aito_invoice_sweep import _same_reference
from backend.app.services.zoho import zoho_service


def _num(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def map_retainer(row: dict, fallback_currency: str) -> dict:
    """Zoho retainer row (list entry or estimate summary) -> the flat row the
    Billing card renders. ``number`` falls back to the id: an unfinalised
    draft has no number yet, and a row with nothing to show is worse than one
    named by its id. Numbers are coerced so one sloppy row cannot blank the
    list; the estimate's summary entries carry no ``date``/``balance``, which
    read as empty/zero.
    """
    retainer_id = str(row.get("retainerinvoice_id") or "")
    return {
        "id": retainer_id,
        "number": str(row.get("retainerinvoice_number") or retainer_id),
        "date": str(row.get("date") or ""),
        "total": _num(row.get("total")),
        "balance": _num(row.get("balance")),
        "currency_code": str(row.get("currency_code") or fallback_currency),
        "status": str(row.get("status") or ""),
    }


async def list_project_retainers(db: AsyncSession, project) -> list[dict]:
    """This project's retainer invoices, in Books' list order, deduplicated.

    ``project`` is any object with ``quote_id``, ``quote_number`` and
    ``client_id`` (an ``AitoProject`` row in production). An empty
    ``quote_id`` returns ``[]`` without touching Books — the empty-filter
    hazard ``list_project_invoices`` documents applies to ``/retainerinvoices``
    too, and the estimate read would 404 anyway.

    The ESTIMATE's customer is queried, not ``project.client_id``: the
    estimate is what was paid for, and a card whose client drifted from the
    quote it was imported from must not list a different contact's deposits.
    """
    if not project.quote_id:
        return []
    estimate = await zoho_service.get_estimate(db, project.quote_id)
    customer_id = str(estimate.get("customer_id") or project.client_id or "")
    currency = str(estimate.get("currency_code") or "")
    quote_number = str(estimate.get("estimate_number") or project.quote_number or "")
    attached_entries = {str(e.get("retainerinvoice_id") or ""): e for e in estimate.get("retainerinvoices") or []}
    attached_entries.pop("", None)

    rows = await zoho_service.list_customer_retainers(db, customer_id)
    out: list[dict] = []
    seen: set[str] = set()
    for row in rows:
        retainer_id = str(row.get("retainerinvoice_id") or "")
        if not retainer_id or retainer_id in seen:
            continue
        referenced = _same_reference(str(row.get("reference_number") or ""), quote_number)
        if retainer_id in attached_entries or referenced:
            seen.add(retainer_id)
            out.append(map_retainer(row, currency))
    # An attached retainer the customer list did not return (customer drift,
    # or Books paging it away) is still this project's: keep it from the
    # estimate's own summary rather than let it vanish from the card.
    for retainer_id, entry in attached_entries.items():
        if retainer_id not in seen:
            seen.add(retainer_id)
            out.append(map_retainer(entry, currency))
    return out
