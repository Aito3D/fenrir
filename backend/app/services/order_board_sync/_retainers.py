"""The retainers stored with each order's detail."""

import logging
from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services.aito_invoice_sweep import _same_reference
from backend.app.services.aito_retainers import list_project_retainers, map_retainer
from backend.app.services.order_board_payment import order_facts
from backend.app.services.order_board_sync._common import (
    open_rate_limit_window,
)
from backend.app.services.zoho import ZohoRateLimited, ZohoUpstreamError, zoho_service

logger = logging.getLogger(__name__)


def _kept_retainers(detail: dict | None) -> dict:
    return {"_retainers": detail["_retainers"]} if detail and "_retainers" in detail else {}


async def _retainers(db: AsyncSession, detail: dict, previous: dict | None, payments: dict[str, list[dict]]) -> dict:
    """``{"_retainers": [...]}``: the retainers of the order's quote or, for an order without a quote, the
    customer's retainers whose reference is the order number (what Heimdall writes on a sales-order payment), each
    with its ``unused`` money (the sum of its customer payments' ``unused_amount``). ``payments`` caches each
    customer's payments for the pass. A Zoho failure keeps the previous retainers; a 429 opens the back-off and is
    re-raised."""
    customer_id = str(detail.get("customer_id") or "")
    if not detail.get("estimate_id"):
        number = str(detail.get("salesorder_number") or "")
        if not number or not customer_id:
            return {}
        return await _with_unused(
            db, customer_id, previous, payments, f"order {number}", lambda: _order_retainers(db, customer_id, number)
        )
    quote = SimpleNamespace(
        quote_id=str(detail["estimate_id"]),
        quote_number=order_facts(detail)["quote_number"] or (previous or {}).get("estimate_number") or "",
        client_id=customer_id,
    )
    return await _with_unused(
        db, customer_id, previous, payments, f"quote {quote.quote_id}", lambda: list_project_retainers(db, quote)
    )


async def _order_retainers(db: AsyncSession, customer_id: str, number: str) -> list[dict]:
    rows = await zoho_service.list_customer_retainers(db, customer_id)
    return [map_retainer(r, "") for r in rows if _same_reference(str(r.get("reference_number") or ""), number)]


async def _with_unused(
    db: AsyncSession, customer_id: str, previous: dict | None, payments: dict, what: str, read
) -> dict:
    try:
        retainers = await read()
        if retainers and customer_id not in payments:
            payments[customer_id] = await zoho_service.list_customer_payments(db, customer_id)
    except ZohoUpstreamError as e:
        if isinstance(e, ZohoRateLimited):
            open_rate_limit_window(e)
            raise  # the pass stops here rather than sending its next call into the back-off
        logger.warning("Order board: retainers of %s not read, the previous ones stay: %s", what, e)
        return _kept_retainers(previous)
    unused: dict[str, float] = {}
    for p in payments.get(customer_id) or []:
        key = str(p.get("retainerinvoice_id") or "")
        try:
            amount = float(p.get("unused_amount") or 0)
        except (TypeError, ValueError):  # one sloppy row must not abort the pass
            amount = 0.0
        unused[key] = unused.get(key, 0.0) + amount
    return {"_retainers": [{**r, "unused": round(unused.get(r["id"], 0.0), 2)} for r in retainers]}
