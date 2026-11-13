"""The stored board as the page reads it: rows with their stamps and latest events, and the Books links."""

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.models.order_board_event import OrderBoardEvent
from backend.app.services.order_board_sync._common import (
    _find_state,
    _pass_lock,
    _pending_count,
    load_settings,
)
from backend.app.services.zoho import ZohoNotConfiguredError, zoho_service


async def _rows_with_prep(db: AsyncSession, state: dict) -> list[dict]:
    """The stored rows, each with its print stamp and its pickup-SMS stamp (``{"at", "by"}`` or None)."""
    stamps: dict[str, dict[str, dict]] = {"prep": {}, "contact": {}}
    query = select(OrderBoardDoc).where(OrderBoardDoc.kind.in_(stamps))
    for d in (await db.execute(query)).scalars():
        stamps[d.kind][d.zoho_id] = d.header
    return [
        {**r, "prep": stamps["prep"].get(r["id"]), "contacted": stamps["contact"].get(r["id"])}
        for r in state.get("rows") or []
    ]


async def find_board_row(db: AsyncSession, salesorder_id: str) -> dict | None:
    row = await _find_state(db)
    found = next(
        (r for r in await _rows_with_prep(db, (row.detail if row else None) or {}) if r["id"] == salesorder_id), None
    )
    if found is not None:  # every single-row result carries it, so a replaced row keeps its subtitle
        found["last_event"] = (await _latest_events(db, [salesorder_id])).get(salesorder_id)
    return found


async def read_board(db: AsyncSession) -> dict:
    """The stored board and the sync status: one local read, no Zoho call."""
    row = await _find_state(db)
    state = (row.detail if row else None) or {}
    rows = await _rows_with_prep(db, state)
    latest = await _latest_events(db, [r["id"] for r in rows])
    settings = await load_settings(db)
    return {
        "rows": [{**r, "last_event": latest.get(r["id"])} for r in rows],
        "computed_at": state.get("computed_at"),
        "stock_loaded_at": state.get("stock_loaded_at"),
        "scan": settings.scan_enabled,
        "sync": {
            "enabled": settings.sync_enabled,
            "configured": await zoho_service.is_configured(db),
            "running": _pass_lock.locked(),
            "pending": await _pending_count(db),
            "last_error": state.get("last_error"),
            "last_error_at": state.get("last_error_at"),
            "last_success_at": state.get("last_success_at"),
        },
    }


async def _latest_events(db: AsyncSession, salesorder_ids: list[str]) -> dict[str, dict]:
    """Each order's newest event (by occurred_at, then id), in one windowed query."""
    if not salesorder_ids:
        return {}
    e = OrderBoardEvent
    rank = (
        func.row_number().over(partition_by=e.salesorder_id, order_by=(e.occurred_at.desc(), e.id.desc())).label("rank")
    )
    ranked = (
        select(e.salesorder_id, e.kind, e.actor_name, e.occurred_at, e.detail, rank)
        .where(e.salesorder_id.in_(salesorder_ids))
        .subquery()
    )
    result = await db.execute(select(ranked).where(ranked.c.rank == 1))
    return {
        r.salesorder_id: {"kind": r.kind, "actor_name": r.actor_name, "occurred_at": r.occurred_at, "detail": r.detail}
        for r in result
    }


async def _add_links(db: AsyncSession, rows: list[dict], details: list[dict | None] | None = None) -> None:
    """Books deep links on the rows; all None when Zoho is not configured. One lookup per call, not per row.
    ``details``: the stored order details already in hand, so the Shopify store handle needs no extra read."""
    try:
        order_base = await zoho_service.books_salesorder_url_base(db)
        invoice_base = await zoho_service.books_invoice_url(db, "")
        quote_base = await zoho_service.books_app_url(db, "")
    except ZohoNotConfiguredError:
        order_base = invoice_base = quote_base = None
    store = ""
    if any(r["facts"]["shopify_order"] for r in rows):
        store = _store_handle(details) if details is not None else await _shopify_store(db)
    for row in rows:
        row["zoho_url"] = f"{order_base}{row['id']}" if order_base else None
        facts = row["facts"]
        if store and facts["shopify_order"] and not facts["shopify_url"]:
            facts["shopify_url"] = f"https://admin.shopify.com/store/{store}/orders?query={facts['shopify_order']}"
        for invoice in (row.get("payment") or {}).get("invoices", []):
            invoice["url"] = f"{invoice_base}{invoice['id']}" if invoice_base and invoice["id"] else None
        facts = row["facts"]
        facts["quote_url"] = f"{quote_base}{facts['estimate_id']}" if quote_base and facts["estimate_id"] else None


def _store_handle(details) -> str:
    return next((d["account_identifier"] for d in details if d and d.get("account_identifier")), "")


async def _shopify_store(db: AsyncSession) -> str:
    """The shop's Shopify store handle, as Books' Shopify sync writes it on the orders it creates."""
    return _store_handle(
        (await db.execute(select(OrderBoardDoc.detail).where(OrderBoardDoc.kind == "salesorder"))).scalars()
    )
