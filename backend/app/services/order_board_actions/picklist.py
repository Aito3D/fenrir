"""A new picklist in Books for an order on the board."""

from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services import order_board_sync as sync
from backend.app.services.order_board import picked_waiting
from backend.app.services.order_board_actions._common import (
    OrderActionRefused,
    _best_effort_refresh,
    _lines,
    _log,
    _num,
    _open_picklists,
    _row,
    _stored_order,
    _wanted,
    _within,
    _write,
    confirm_stored_copy,
    writing,
)
from backend.app.services.order_board_payment import _r
from backend.app.services.zoho import ZohoUpstreamError, zoho_service


async def _pickable(db: AsyncSession, salesorder_id: str, row: dict, order: dict) -> tuple[dict, dict[str, float]]:
    """Books' own picklist draft for the order and, per line, what a new picklist may hold: what Books still
    offers (units already on a picklist are not), never above what the shelf covers once the units picked and
    not boxed yet are set aside."""
    with sync._busy_on_rate_limit(salesorder_id):
        prefill = await zoho_service.picklist_prefill(db, salesorder_id) or {}
    shelf = {line["id"]: line["packable"] for line in row["lines"]}
    held = picked_waiting(order)
    books: dict[str, float] = {}
    for line in prefill.get("line_items") or []:
        if line.get("salesorder_id") == salesorder_id and line.get("so_line_item_id"):
            line_id = line["so_line_item_id"]
            books[line_id] = books.get(line_id, 0.0) + _num(line.get("quantity_to_be_picked"))
    offered = {
        line_id: _r(min(units, shelf.get(line_id, 0.0) - held.get(line_id, 0.0))) for line_id, units in books.items()
    }
    return prefill, {line_id: units for line_id, units in offered.items() if units > 0}


async def picklist_preview(db: AsyncSession, salesorder_id: str) -> dict:
    """What a new picklist of this order may hold. Reads only."""
    order = await _stored_order(db, salesorder_id)
    row = await _row(db, salesorder_id)
    if _open_picklists(order):
        raise OrderActionRefused("picklist_open")
    if sync.zoho_busy():
        raise sync.ZohoBusy(salesorder_id)
    return {"lines": _lines((await _pickable(db, salesorder_id, row, order))[1])}


async def create_picklist(
    db: AsyncSession, salesorder_id: str, quantities: dict[str, float], *, by: str | None = None
) -> dict:
    """Create a picklist in Books for the given line quantities; returns its ``id`` and ``number``."""
    with writing(salesorder_id):
        doc = await confirm_stored_copy(db, salesorder_id)
        row = await _row(db, salesorder_id)
        number = row.get("number") or ""
        wanted = _wanted(quantities)
        # One at a time: what an open picklist holds is not on the stored order, so the shelf could not be shared.
        if _open_picklists(doc.detail or {}):
            raise OrderActionRefused("picklist_open")
        prefill, offered = await _pickable(db, salesorder_id, row, doc.detail or {})
        _within(wanted, offered, {line["id"] for line in row["lines"]})
        body = {
            "date": date.today().isoformat(),
            "location_id": prefill.get("location_id"),
            "parent_entity": "salesorder",
            "group_by": "none",
            "line_items": [
                {
                    "salesorder_id": salesorder_id,
                    "so_line_item_id": line_id,
                    "quantity_to_be_picked": q,
                    "quantity_picked": 0,
                }
                for line_id, q in wanted.items()
            ],
        }
        try:
            picklist = await _write(salesorder_id, number, "picklist", zoho_service.create_picklist(db, body))
        except ZohoUpstreamError:
            await _best_effort_refresh(db, salesorder_id, number)  # a timeout can mean Books did create it
            raise
        await _log(
            db,
            salesorder_id,
            "picklist.created",
            by,
            picklist=picklist.get("picklist_number") or "",
            units=_r(sum(wanted.values())),
        )
        await _best_effort_refresh(db, salesorder_id, number)
    return {"id": picklist.get("picklist_id") or "", "number": picklist.get("picklist_number") or ""}
