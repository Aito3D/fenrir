"""Box what a picklist holds: the parcel (package) in Books."""

import logging
from datetime import date

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services import order_board_sync as sync
from backend.app.services.order_board import picked_waiting
from backend.app.services.order_board_actions._common import (
    _best_effort_refresh,
    _lines,
    _log,
    _picklist,
    _row,
    _stored_order,
    _to_box,
    _wanted,
    _within,
    _write,
    confirm_stored_copy,
    writing,
)
from backend.app.services.zoho import ZohoUpstreamError, zoho_service

logger = logging.getLogger(__name__)


async def picklist_content(db: AsyncSession, salesorder_id: str, picklist_id: str) -> dict:
    """What a parcel made from this picklist may hold. Reads only."""
    order = await _stored_order(db, salesorder_id)
    if sync.zoho_busy():
        raise sync.ZohoBusy(salesorder_id)
    picklist = await _picklist(db, order, picklist_id)
    return {
        "id": picklist_id,
        "number": picklist.get("picklist_number") or "",
        "status": picklist.get("status") or "",
        "lines": _lines(
            {line_id: units for line_id, (units, _, _) in _to_box(picklist, salesorder_id).items() if units > 0}
        ),
    }


def _parcel_allowed(row: dict, doc_detail: dict, on_list: dict, done: bool) -> dict[str, float]:
    # Never more than the order still has to box; and for a completed picklist never more than the order
    # counts as picked and not boxed, so a parcel Books created without telling the picklist is not repeated.
    unboxed = {line["id"]: line["remaining"] - line["packed_waiting"] for line in row["lines"]}
    held = picked_waiting(doc_detail)
    return {
        line_id: min(units, unboxed.get(line_id, 0.0), held.get(line_id, 0.0) if done else units)
        for line_id, (units, _, _) in on_list.items()
    }


def _picklist_update_body(picklist: dict, on_list: dict, wanted: dict[str, float]) -> dict:
    return {
        "date": picklist.get("date") or date.today().isoformat(),
        "location_id": picklist.get("location_id"),
        "group_by": picklist.get("group_by"),
        # Books removes the rows left out: the picklist becomes exactly what was picked
        # (a row with units already in a parcel stays, at those units).
        "line_items": [
            {
                "line_item_id": row_id,
                "quantity_to_be_picked": boxed + wanted.get(line_id, 0.0),
                "quantity_picked": boxed + wanted.get(line_id, 0.0),
            }
            for line_id, (_, boxed, row_id) in on_list.items()
            if boxed + wanted.get(line_id, 0.0) > 0
        ],
    }


async def _forget_prep_stamp(db: AsyncSession, salesorder_id: str, number: str) -> None:
    # The parcel exists in Books: nothing here may turn that into an error.
    try:
        await db.execute(
            delete(OrderBoardDoc).where(OrderBoardDoc.kind == "prep", OrderBoardDoc.zoho_id == salesorder_id)
        )
        await db.commit()
    except Exception as e:
        logger.warning("Order board: bookkeeping after a parcel failed for %s (%s)", number, type(e).__name__)
        await db.rollback()


async def create_parcel(
    db: AsyncSession, salesorder_id: str, picklist_id: str, quantities: dict[str, float], *, by: str | None = None
) -> str:
    """Box what was picked; returns Books' package number.

    The picklist is cut down to the confirmed quantities and completed, then its package is created. A step whose
    result Books already shows is skipped, so the same request repeated finishes the job.
    """
    with writing(salesorder_id):
        doc = await confirm_stored_copy(db, salesorder_id)
        row = await _row(db, salesorder_id)
        number = row.get("number") or ""
        wanted = _wanted(quantities)
        picklist = await _picklist(db, doc.detail or {}, picklist_id)
        on_list = _to_box(picklist, salesorder_id)
        done = picklist.get("status") == "completed"
        allowed = _parcel_allowed(row, doc.detail or {}, on_list, done)
        _within(wanted, allowed, set(on_list))
        try:
            if not done:
                body = _picklist_update_body(picklist, on_list, wanted)
                updated = await _write(
                    salesorder_id,
                    number,
                    "picklist_picked",
                    zoho_service.update_picklist(db, picklist_id, {k: v for k, v in body.items() if v}),
                )
                if updated.get("status") != "completed":
                    await _write(
                        salesorder_id, number, "picklist_completed", zoho_service.complete_picklist(db, picklist_id)
                    )
            package = await _write(
                salesorder_id,
                number,
                "parcel",
                zoho_service.create_package(
                    db,
                    salesorder_id,
                    date=date.today().isoformat(),
                    line_items=[
                        {"so_line_item_id": line_id, "quantity": q, "picklist_item_id": on_list[line_id][2]}
                        for line_id, q in wanted.items()
                    ],
                ),
            )
        except ZohoUpstreamError:
            # A timeout can mean Books did it: look once, keep the original error.
            await _best_effort_refresh(db, salesorder_id, number)
            raise
        # The parcel exists in Books: nothing below may turn that into an error.
        await _log(
            db,
            salesorder_id,
            "package.created",
            by,
            package=package.get("package_number") or "",
            picklist=picklist.get("picklist_number") or "",
            units=sum(wanted.values()),
        )
        await _forget_prep_stamp(db, salesorder_id, number)
        await _best_effort_refresh(db, salesorder_id, number)
    return package.get("package_number") or ""
