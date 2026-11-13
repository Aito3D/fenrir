"""What a pass records in the order history: new orders, outside edits, ready, paid and finished."""

import logging
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.models.order_board_event import OrderBoardEvent
from backend.app.services import order_board_events
from backend.app.services.order_board_payment import order_facts
from backend.app.services.order_board_sync._common import (
    _is_finished,
    _naive_utc,
    needs_refresh,
)

logger = logging.getLogger(__name__)


async def _observe(db: AsyncSession, what: str, write, *args) -> None:
    """Run ``write(db, *args)`` (it records history events) in a savepoint: a failure there is logged and dropped, never
    fails the pass. The flush first is outside the guard, so the pass's own pending changes still raise."""
    await db.flush()
    try:
        async with db.begin_nested():
            await write(db, *args)
    except Exception:
        logger.warning("Order board: recording history events failed (%s)", what, exc_info=True)


async def _has_event(db: AsyncSession, salesorder_id: str, kind: str, after: datetime | None = None) -> bool:
    query = select(OrderBoardEvent.id).where(
        OrderBoardEvent.salesorder_id == salesorder_id, OrderBoardEvent.kind == kind
    )
    if after is not None:
        query = query.where(OrderBoardEvent.occurred_at > after)
    return (await db.execute(query.limit(1))).first() is not None


def _line_changes(previous: dict, fetched: dict) -> list[dict]:
    """Line (name, quantity) and shipment-date differences, in the writers' ``{field, from, to}`` shape."""

    def lines(order: dict) -> dict[str, tuple[str, float]]:
        return {
            str(raw["line_item_id"]): (raw.get("name") or raw.get("item_id") or "", float(raw.get("quantity") or 0))
            for raw in order.get("line_items") or []
            if raw.get("line_item_id")
        }

    old, new = lines(previous), lines(fetched)
    changes: list[dict] = []
    for line_id in sorted(old.keys() | new.keys()):
        was, now = old.get(line_id), new.get(line_id)
        if was == now:
            continue
        if was and now and was[0] == now[0]:
            changes.append({"field": now[0], "from": was[1], "to": now[1]})
            continue
        if was:
            changes.append({"field": was[0], "from": was[1], "to": 0})
        if now:
            changes.append({"field": now[0], "from": 0, "to": now[1]})
    if (previous.get("shipment_date") or None) != (fetched.get("shipment_date") or None):
        changes.append(
            {"field": "shipment_date", "from": previous.get("shipment_date"), "to": fetched.get("shipment_date")}
        )
    return changes


async def _record_fetch_events(db: AsyncSession, salesorder_id: str, previous: dict | None, fetched: dict) -> None:
    """What a freshly stored sales-order detail shows: a new order, or an edit made in Books (not by Fenrir).

    The new order rings the bell only when ``_reconcile_listings`` marked it (``alert_new``): orders already open
    before, and a first load, record history without alerting. The marker goes with the event."""
    if not await _has_event(db, salesorder_id, "order.received"):
        facts = order_facts(fetched)
        source = "quote" if facts["estimate_id"] else "shopify" if facts["shopify_order"] else "direct"
        marker = (
            await db.execute(
                select(OrderBoardDoc).where(OrderBoardDoc.kind == "alert_new", OrderBoardDoc.zoho_id == salesorder_id)
            )
        ).scalar_one_or_none()
        await order_board_events.record(
            db,
            salesorder_id,
            "order.received",
            actor_class="system",
            occurred_at=_naive_utc(fetched.get("created_time") or "") or _naive_utc(fetched.get("date") or ""),
            alert=marker is not None,
            detail={
                "source": source,
                "reference": facts["reference"],
                "total": float(fetched.get("total") or 0),
                "units": sum(float(raw.get("quantity") or 0) for raw in fetched.get("line_items") or []),
                "pickup": facts["delivery_method"].upper() == "PICK UP",
            },
        )
        if marker is not None:
            await db.delete(marker)
    # An order Fenrir wrote whose re-read has not landed yet: the difference is ours, not an outside edit.
    if previous is not None and not needs_refresh(salesorder_id):
        changes = _line_changes(previous, fetched)
        if changes:
            await order_board_events.record(db, salesorder_id, "zoho.edited", actor_class="system", changes=changes)


async def _record_board_events(
    db: AsyncSession, current: dict, rows: list[dict], headers: dict[str, dict], quiet: frozenset[str] | set[str]
) -> None:
    """Ready, paid and finished, read off the difference between the previous board and the new one. Orders in
    ``quiet`` record no payment."""
    before = {r["id"]: r for r in current.get("rows") or []}
    after = {r["id"]: r for r in rows}
    computed_at = _naive_utc(current["computed_at"])
    for salesorder_id, row in after.items():
        was = before.get(salesorder_id)
        if was is None:  # a new order, or one brought in by a settings change: no transition to tell
            continue
        if was["status"] != "to_ship" and row["status"] == "to_ship":
            await order_board_events.record(db, salesorder_id, "order.ready", actor_class="system")
        payment = row.get("payment") or {}
        # Invoice and retainer payments only: shared customer credit moving between orders, or applied at hand-over, is
        # not new money. A retainer drawn on the order's invoice moves from one figure to the other: no delta.
        # Retainers never read before (an order stored before they were, or every read failed so far) are not new money.
        old = was.get("payment") or {}
        delta = (payment.get("invoice_paid") or 0) - (old.get("invoice_paid") or 0)
        if old.get("retainer_known") and payment.get("retainer_known"):
            delta += (payment.get("retainer") or 0) - (old.get("retainer") or 0)
        # A terminal or link payment settled here records itself: skip what it already logged since the last board.
        if (
            delta > 0
            and salesorder_id not in quiet
            and not await _has_event(db, salesorder_id, "payment.received", computed_at)
        ):
            await order_board_events.record(
                db,
                salesorder_id,
                "payment.received",
                actor_class="system",
                detail={"amount": round(delta, 2), "paid": payment.get("paid"), "total": row.get("total")},
            )
    for salesorder_id in before.keys() - after.keys():
        if _is_finished(headers.get(salesorder_id) or {}) and not await _has_event(db, salesorder_id, "order.finished"):
            await order_board_events.record(db, salesorder_id, "order.finished", actor_class="system")
