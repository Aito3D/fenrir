"""Rebuilding the board from the local copy, and the writers that must do it right after: settings and one order."""

import json
import time
from datetime import date
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services.inbox import broadcast_pending
from backend.app.services.order_board import compute_board
from backend.app.services.order_board_sync import _common
from backend.app.services.order_board_sync._board import _add_links
from backend.app.services.order_board_sync._common import (
    OrderBoardSettings,
    OrderNotStored,
    _find_state,
    _is_candidate,
    _now,
    _pending_count,
    _stored_query,
    _unconfirmed,
    _written_at,
    announce_board_change,
    load_settings,
)
from backend.app.services.order_board_sync._events import _observe, _record_board_events
from backend.app.services.order_board_sync._retainers import _retainers
from backend.app.services.zoho import zoho_service


async def save_settings(db: AsyncSession, settings: OrderBoardSettings) -> None:
    """Store the settings and rebuild the board from the local copy (no Zoho call)."""
    from backend.app.api.routes.settings import set_setting

    await set_setting(db, "order_board_sync_enabled", "true" if settings.sync_enabled else "false")
    await set_setting(db, "order_board_sync_minutes", str(settings.sync_minutes))
    await set_setting(db, "order_board_max_age_days", str(settings.max_age_days))
    await set_setting(db, "order_board_core_brands", json.dumps(settings.core_brands))
    await set_setting(db, "order_board_scan_enabled", "true" if settings.scan_enabled else "false")
    changed = await recompute(db)
    await db.commit()
    await broadcast_pending(db)
    if changed:
        await announce_board_change(finished=True)
    # Sync switched on, or the age limit raised: run a pass now rather than
    # leave the page loading until the interval ends.
    if _common._wake is not None:
        _common._wake.set()


async def refresh_order(db: AsyncSession, salesorder_id: str) -> None:
    """Re-read one order from Books after a write here, store it and rebuild the board."""
    doc = (await db.execute(_stored_query(salesorder_id))).scalar_one_or_none()
    if doc is None:
        raise OrderNotStored(salesorder_id)
    fetched = await zoho_service.get_salesorder(db, salesorder_id)
    _written_at[salesorder_id] = time.monotonic()
    # Fresh retainers: a write here (hand-over, invoice) may just have spent one; a stale unused amount would count twice.
    doc.detail = {**fetched, "_fetched_at": _now(), **await _retainers(db, fetched, doc.detail, {})}
    doc.pending = True  # the next pass re-reads it once the list row has caught up
    # A write here only moves credit onto an invoice: the refreshed row is the next pass's baseline, not a payment.
    changed = await recompute(db, quiet={salesorder_id})
    await db.commit()
    await broadcast_pending(db)
    _unconfirmed.discard(salesorder_id)
    if changed:
        await announce_board_change(finished=changed == "orders")


async def recompute(
    db: AsyncSession, *, quiet: frozenset[str] | set[str] = frozenset()
) -> Literal["", "rows", "orders"]:
    """Rebuild the board from the local copy. Truthy when its rows changed (the caller announces it after its
    commit): "orders" when an order joined or left the board, which may change the finished list, else "rows".
    Orders in ``quiet`` (just re-read after a write here) record no ``payment.received``.

    Does nothing until the first complete load: a board built from half the
    documents, or against no stock, would read as fact and be wrong.
    """
    state = await _find_state(db)
    current = (state.detail if state else None) or {}
    if state is None or not current.get("stock_loaded_at"):
        return ""
    if not current.get("computed_at") and await _pending_count(db):
        return ""
    settings = await load_settings(db)
    docs = (
        (
            await db.execute(
                select(OrderBoardDoc)
                .where(OrderBoardDoc.kind.in_(("salesorder", "purchaseorder", "item")))
                .execution_options(populate_existing=True)
            )
        )
        .scalars()
        .all()
    )
    rows = compute_board(
        [d.detail for d in docs if d.kind == "salesorder" and d.detail and _is_candidate(d.kind, d.header, settings)],
        [d.detail for d in docs if d.kind == "purchaseorder" and d.detail],
        {d.zoho_id: d.header for d in docs if d.kind == "item"},
        date.today(),
        max_age_days=settings.max_age_days,
        core_brands=settings.core_brands,
    )
    await _add_links(db, rows, [d.detail for d in docs if d.kind == "salesorder"])
    state.detail = {**current, "rows": rows, "computed_at": _now()}
    if current.get("computed_at"):  # the first computation has nothing to compare with
        headers = {d.zoho_id: d.header for d in docs if d.kind == "salesorder"}
        await _observe(db, "board", _record_board_events, current, rows, headers, quiet)
    old = current.get("rows") or []
    if {r["id"] for r in rows} != {r["id"] for r in old}:
        return "orders"
    return "rows" if rows != old else ""
