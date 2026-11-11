"""Edit the order's lines in Books."""

import math

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services import order_board_sync as sync
from backend.app.services.order_board import _LIVE_STATES
from backend.app.services.order_board_actions._common import (
    OrderActionRefused,
    OrderNotOnBoard,
    _best_effort_refresh,
    _log,
    _num,
    _open_picklists,
    _reread,
    _row,
    _write,
    confirm_stored_copy,
    writing,
)
from backend.app.services.zoho import ZohoRateLimited, ZohoUpstreamError, zoho_service

_SO_LINE_FIELDS = ("line_item_id", "item_id", "name", "description", "rate", "quantity", "unit", "tax_id", "discount")


async def search_items(db: AsyncSession, query: str) -> list[dict]:
    """Books items matching ``query`` that are goods, not services; the first five."""
    if sync.zoho_busy():
        raise sync.ZohoBusy(query)
    try:
        found = await zoho_service.list_items(db, query)
    except ZohoRateLimited as e:
        sync.open_rate_limit_window(e)
        raise sync.ZohoBusy(query) from e
    return [
        {
            "id": item.get("item_id") or "",
            "name": item.get("name") or "",
            "sku": item.get("sku") or "",
            "rate": float(_num(item.get("rate"))),
            "stock_on_hand": None if item.get("stock_on_hand") is None else float(_num(item.get("stock_on_hand"))),
            "product_type": item.get("product_type") or "",
        }
        for item in found
        if not (item.get("product_type") or "").endswith("service")
    ][:5]


async def edit_lines(
    db: AsyncSession, salesorder_id: str, version: str, lines: list[dict], *, by: str | None = None
) -> dict:
    """Set the quantities of an order's live goods lines, drop the ones left out and add new items, in Books. The
    whole line list is sent back. Only a line the board shows as live (ready, backorder, to order) is editable;
    every other line (service, untracked, cancelled, fully shipped) goes back untouched, and naming one is refused
    ``service_line`` (service or untracked) or ``unknown_line`` (cancelled, shipped). ``version`` is the order's
    ``last_modified_time`` the operator saw: an order saved in Books since is refused. Lines already packed, picked
    or invoiced cannot go below that."""
    with writing(salesorder_id):
        doc = await confirm_stored_copy(db, salesorder_id)
        number = doc.header.get("salesorder_number") or ""
        if _open_picklists(doc.detail or {}):
            raise OrderActionRefused("picklist_open")
        detail = await _reread(db, salesorder_id)  # the comparison and the floors must come from Books as it is now
        if detail.get("last_modified_time", "") != version:
            raise OrderActionRefused("version")
        if _open_picklists(detail):  # Books may hold one the stored copy did not
            raise OrderActionRefused("picklist_open")
        board = {line["id"]: line for line in (await _row(db, salesorder_id))["lines"]}
        floors = {line_id: line["floor"] for line_id, line in board.items()}
        raws = detail.get("line_items") or []
        live = {
            raw["line_item_id"]
            for raw in raws
            if raw.get("line_item_id") in board and board[raw["line_item_id"]]["state"] in _LIVE_STATES
        }
        edits: dict[str, float] = {}
        new: dict[str, float] = {}
        for entry in lines:
            q = entry.get("quantity")
            if not isinstance(q, int | float) or not math.isfinite(q) or q <= 0 or round(q, 3) != q:
                raise OrderActionRefused("bad_quantity")
            if "line_id" in entry:
                line_id = entry["line_id"]
                if line_id not in live and (board.get(line_id) or {}).get("state") == "service":
                    raise OrderActionRefused("service_line")
                if line_id not in live:
                    raise OrderActionRefused("unknown_line")
                if line_id in edits:
                    raise OrderActionRefused("unknown_line")
                if q < floors.get(line_id, 0.0) - 1e-9:
                    raise OrderActionRefused("below_floor")
                edits[line_id] = q
            else:
                item_id = entry.get("item_id")
                if not item_id or item_id in new or any(raw.get("item_id") == item_id for raw in raws):
                    raise OrderActionRefused("unknown_item")
                new[item_id] = q
        if any(floors.get(line_id, 0.0) > 0 and line_id not in edits for line_id in live):
            raise OrderActionRefused("below_floor")
        items: dict = {}
        if new:
            try:
                found = await zoho_service.list_items_by_ids(db, list(new))
            except ZohoRateLimited as e:
                sync.open_rate_limit_window(e)
                raise sync.ZohoBusy(salesorder_id) from e
            items = {item.get("item_id"): item for item in found}
            if any(i not in items or (items[i].get("product_type") or "").endswith("service") for i in new):
                raise OrderActionRefused("unknown_item")
        if (
            not new
            and len(edits) == len(live)
            and all(
                _num(raw.get("quantity")) == edits[raw["line_item_id"]] for raw in raws if raw["line_item_id"] in live
            )
        ):
            raise OrderActionRefused("nothing_changed")
        body_lines = []
        for raw in raws:
            line_id = raw.get("line_item_id")
            if line_id in live and line_id not in edits:
                continue
            kept = {k: raw[k] for k in _SO_LINE_FIELDS if k in raw}
            if line_id in edits:
                kept["quantity"] = edits[line_id]
            body_lines.append(kept)
        body_lines += [{"item_id": i, "quantity": q, "rate": float(_num(items[i].get("rate")))} for i, q in new.items()]
        try:
            await _write(
                salesorder_id,
                number,
                "lines",
                zoho_service.update_salesorder(db, salesorder_id, {"line_items": body_lines}),
            )
        except ZohoUpstreamError:
            await _best_effort_refresh(db, salesorder_id, number)  # a timeout can mean Books saved it
            raise
        names = {
            raw.get("line_item_id"): raw.get("name") or board.get(raw.get("line_item_id"), {}).get("name")
            for raw in raws
        }
        was = {raw.get("line_item_id"): _num(raw.get("quantity")) for raw in raws}
        changes = [
            {"field": names.get(i) or i, "from": was.get(i, 0.0), "to": edits.get(i, 0.0)}
            for i in live
            if was.get(i, 0.0) != edits.get(i, 0.0)
        ] + [{"field": items[i].get("name") or i, "from": 0, "to": q} for i, q in new.items()]
        total_from = detail.get("total")
        await _best_effort_refresh(db, salesorder_id, number)
        stored = (await db.execute(sync._stored_query(salesorder_id))).scalar_one_or_none()
        await _log(
            db,
            salesorder_id,
            "order.edited",
            by,
            changes=changes,
            total_from=total_from,
            total_to=((stored.header or {}).get("total") if stored is not None else None),
        )
    try:
        return await _row(db, salesorder_id)
    except OrderNotOnBoard:
        return {}  # the edit took it off the board; the write is done
