"""Edit a packed parcel in Books, its picklist kept in step."""

import logging
import math
from collections.abc import Mapping
from datetime import date

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services import order_board_sync as sync
from backend.app.services.order_board import picked_waiting
from backend.app.services.order_board_actions._common import (
    OrderActionRefused,
    OrderNotOnBoard,
    _best_effort_refresh,
    _boxed,
    _num,
    _open_picklists,
    _picklist,
    _reread,
    _row,
    _stored_order,
    _to_box,
    _within,
    _write,
    confirm_stored_copy,
    writing,
)
from backend.app.services.zoho import (
    ZohoNotFound,
    ZohoRateLimited,
    ZohoRequestRejected,
    ZohoUpstreamError,
    zoho_service,
)

logger = logging.getLogger(__name__)

# False: edit the package and its completed picklist in place. True: the spec's fallback (delete the package, fix
# the picklist, create the package again), for when the first live run shows Books refuses a completed picklist.
_PARCEL_EDIT_REPLACES = False


def _units(quantities: Mapping[str, float]) -> dict[str, float]:
    if any(not isinstance(q, int | float) or not math.isfinite(q) or q < 0 for q in quantities.values()):
        raise OrderActionRefused("bad_quantity")
    return {line_id: q for line_id, q in quantities.items() if q > 0}


def _same(a: Mapping[str, float], b: Mapping[str, float]) -> bool:
    return a.keys() == b.keys() and all(abs(a[k] - b[k]) <= 1e-9 for k in a)


async def _package(db: AsyncSession, package_id: str) -> dict:
    try:
        return await zoho_service.get_package(db, package_id)
    except ZohoNotFound as e:
        raise OrderActionRefused("unknown_package") from e
    except ZohoRateLimited as e:
        sync.open_rate_limit_window(e)
        raise sync.ZohoBusy(package_id) from e


async def _parcel(db: AsyncSession, salesorder_id: str, package_id: str, order: dict, row: dict):
    """The package and its picklist as Books has them now, and per order line the most the parcel may hold: its
    own units plus what the shelf still covers once the units picked for another parcel are set aside."""
    if not any(p.get("package_id") == package_id for p in order.get("packages") or []):
        raise OrderActionRefused("unknown_package")
    # An open picklist's units are outside the shelf figure, whichever picklist it is.
    if _open_picklists(order):
        raise OrderActionRefused("picklist_open")
    package = await _package(db, package_id)
    if package.get("status") != "not_shipped":
        raise OrderActionRefused("package_shipped")
    boxed = _boxed(package)
    known = {line["id"] for line in row["lines"]}
    rows = {line.get("picklist_item_id") for line in package.get("line_items") or []}
    if any(line_id not in known for line_id in boxed) or not rows or "" in rows or None in rows:
        raise OrderActionRefused("picklist_shared")
    picklist = None
    for entry in order.get("picklists") or []:
        found = await _picklist(db, order, entry.get("picklist_id") or "")
        hit = rows & {r.get("line_item_id") for r in found.get("line_items") or []}
        if hit:
            if hit != rows:  # the parcel's lines point to two picklists
                raise OrderActionRefused("picklist_shared")
            picklist = found
            break
    if picklist is None:
        raise OrderActionRefused("picklist_shared")
    # Units picked on the parcel's own picklist and not boxed (a step A whose step B failed) may go in it.
    here = {line_id: units for line_id, (units, _, _) in _to_box(picklist, salesorder_id).items()}
    held = picked_waiting(order)
    ceiling = {
        line["id"]: round(
            boxed.get(line["id"], 0.0)
            + max(0.0, line["packable"] - max(0.0, held.get(line["id"], 0.0) - here.get(line["id"], 0.0))),
            6,
        )
        for line in row["lines"]
    }
    return package, picklist, boxed, {line_id: q for line_id, q in ceiling.items() if q > 0}


# --- What the operator meant, while a lowering edit's last step (picklist down) is not done -----------------------
# Books cannot tell a picklist-down step that failed from a picklist boxed in part on purpose (units picked and
# waiting for a second parcel): only this marker, written before the package step and dropped after the picklist
# step, says a step is owed, which units the edit was going from and to, and once the picklist step is worked out,
# the row units it sends (``down``): a picklist step that went through behind a timeout is then not taken twice.


def _marker_query(package_id: str):
    return select(OrderBoardDoc).where(OrderBoardDoc.kind == "parcel_edit", OrderBoardDoc.zoho_id == package_id)


async def _marker(db: AsyncSession, package_id: str) -> dict | None:
    """``{"old", "new", "down"?}`` of a lowering edit of this package whose picklist step is still owed."""
    doc = (await db.execute(_marker_query(package_id))).scalar_one_or_none()
    return doc.header if doc is not None else None


async def _mark(db: AsyncSession, package_id: str, header: dict) -> None:
    doc = (await db.execute(_marker_query(package_id))).scalar_one_or_none()
    if doc is None:
        db.add(OrderBoardDoc(kind="parcel_edit", zoho_id=package_id, header=header))
    else:
        doc.header = header
    await db.commit()  # before the Books write: it must outlive a failure after it


async def _unmark(db: AsyncSession, package_id: str) -> None:
    # Books is done: a marker left behind only offers a save that finds nothing to do.
    try:
        await db.execute(
            delete(OrderBoardDoc).where(OrderBoardDoc.kind == "parcel_edit", OrderBoardDoc.zoho_id == package_id)
        )
        await db.commit()
    except Exception as e:
        logger.warning("Order board: clearing a parcel edit marker failed for %s (%s)", package_id, type(e).__name__)
        await db.rollback()


def _owed(marker: dict | None, picklist: dict, package: dict, boxed: Mapping[str, float], salesorder_id: str) -> bool:
    """Whether the marked edit still owes its picklist step: the package holds what it asked, the picklist does not."""
    if marker is None or not _same(boxed, marker["new"]):
        return False
    return not _rows_at(picklist, _down(marker, picklist, package, marker["old"], marker["new"], salesorder_id))[1]


def _down(
    marker: dict | None, picklist: dict, package: dict, old: dict[str, float], new: dict[str, float], salesorder_id: str
) -> dict[str, float]:
    """The units per changed line the picklist-down step sets: the marker's when it already worked them out for this
    same edit, else counted from what Books shows now."""
    if marker and marker.get("down") is not None and _same(marker["old"], old) and _same(marker["new"], new):
        return marker["down"]
    units = _picklist_rows(picklist, package, old, new, False, salesorder_id)[1]
    return {line_id: q for line_id, q in units.items() if abs(old.get(line_id, 0.0) - new.get(line_id, 0.0)) > 1e-9}


def _rows_at(picklist: dict, down: Mapping[str, float]) -> tuple[list[dict], bool]:
    """The picklist rows with the changed lines at ``down`` (the others as they are), and whether Books shows that."""
    rows, same = [], True
    for r in picklist.get("line_items") or []:
        picked = _num(r.get("quantity_picked"))
        target = down.get(r.get("so_line_item_id") or "", picked)
        same = same and abs(target - picked) <= 1e-9
        if target > 0:  # Books removes the rows left out
            rows.append({"line_item_id": r["line_item_id"], "quantity_to_be_picked": target, "quantity_picked": target})
    return rows, same


async def package_content(db: AsyncSession, salesorder_id: str, package_id: str) -> dict:
    """What a packed parcel holds and may hold, for its editor. Reads only."""
    order = await _stored_order(db, salesorder_id)
    row = await _row(db, salesorder_id)
    if sync.zoho_busy():
        raise sync.ZohoBusy(salesorder_id)
    package, picklist, boxed, ceiling = await _parcel(db, salesorder_id, package_id, order, row)
    # A picklist-down step left undone by a failure: a save with no change finishes it.
    pending = not _PARCEL_EDIT_REPLACES and _owed(
        await _marker(db, package_id), picklist, package, boxed, salesorder_id
    )
    return {
        "id": package_id,
        "number": package.get("package_number") or "",
        "version": order.get("last_modified_time", ""),
        "picklist_id": picklist.get("picklist_id") or "",
        "lines": [
            {"line_id": line_id, "quantity": boxed.get(line_id, 0.0), "max": q} for line_id, q in ceiling.items()
        ],
        "pending": pending,
    }


def _picklist_rows(
    picklist: dict,
    package: dict,
    old: Mapping[str, float],
    new: Mapping[str, float],
    rising: bool,
    salesorder_id: str,
) -> tuple[list[dict], dict[str, float], bool]:
    """The picklist rows to send, the units per order line, and whether Books already shows them.

    A line this edit changes holds the units the other parcels boxed from its row plus this parcel's: the larger of
    its old and new units while rising (never under what is picked). Going down, it gives up only the units taken out
    of this parcel, so units picked and waiting for another parcel keep their pick, never below what is boxed. Every
    other row stays as it is. Counted from what Books shows now, so the same request repeated finds a done step done.
    """
    in_parcel = _boxed(package)
    rows, units, same = [], {}, True
    for r in picklist.get("line_items") or []:
        line_id = r.get("so_line_item_id") or ""
        picked = _num(r.get("quantity_picked"))
        target = picked
        before, after = old.get(line_id, 0.0), new.get(line_id, 0.0)
        if abs(before - after) > 1e-9:
            others = max(0.0, _num(r.get("quantity_packed")) - in_parcel.get(line_id, 0.0))
            boxed_now = others + after
            target = (
                max(picked, others + max(before, after))
                if rising
                else max(boxed_now, picked - max(0.0, before - after))
            )
        target = round(target, 6)
        same = same and abs(target - picked) <= 1e-9
        units[line_id] = target
        if target > 0:  # Books removes the rows left out
            rows.append({"line_item_id": r["line_item_id"], "quantity_to_be_picked": target, "quantity_picked": target})
    for line_id, q in new.items():
        if line_id not in units:  # a line new to the parcel and to its picklist
            same = False
            units[line_id] = q
            rows.append(
                {
                    "salesorder_id": salesorder_id,
                    "so_line_item_id": line_id,
                    "quantity_to_be_picked": q,
                    "quantity_picked": q,
                }
            )
    return rows, units, same


def _package_lines(picklist: dict, new: Mapping[str, float]) -> list[dict]:
    row_ids = {r.get("so_line_item_id"): r.get("line_item_id") for r in picklist.get("line_items") or []}
    if any(not row_ids.get(line_id) for line_id in new):
        raise ZohoUpstreamError("picklist row missing for a parcel line")
    return [
        {"so_line_item_id": line_id, "quantity": q, "picklist_item_id": row_ids[line_id]} for line_id, q in new.items()
    ]


async def _rewrite_parcel(
    db: AsyncSession,
    salesorder_id: str,
    number: str,
    order: dict,
    package: dict,
    picklist: dict,
    old: dict[str, float],
    new: dict[str, float],
) -> None:
    """The Books writes of a parcel edit, in an order that never shows a package row above its picklist row. Each
    step is skipped when Books already shows its result; a step that ran is followed by a re-read."""
    package_id, picklist_id = package["package_id"], picklist["picklist_id"]

    def body(rows: list[dict]) -> dict:
        head = {"date": picklist.get("date"), "location_id": picklist.get("location_id")}
        return {**{k: v for k, v in head.items() if v}, "group_by": picklist.get("group_by"), "line_items": rows}

    async def update_picklist(step: str, rows: list[dict]) -> dict:
        await _write(salesorder_id, number, step, zoho_service.update_picklist(db, picklist_id, body(rows)))
        return await _picklist(db, order, picklist_id)

    if _PARCEL_EDIT_REPLACES:
        await _write(salesorder_id, number, "delete_package", zoho_service.delete_package(db, package_id))
        picklist = await _picklist(db, order, picklist_id)
        rows, units, same = _picklist_rows(picklist, {}, old, new, False, salesorder_id)
        if not rows:  # no parcel holds anything from it any more
            await _write(salesorder_id, number, "delete_picklist", zoho_service.delete_picklist(db, picklist_id))
            return
        if not same:
            try:
                picklist = await update_picklist("picklist", rows)
            except ZohoRequestRejected:  # Books will not change a completed picklist: make it again
                held = await _picklist(db, order, picklist_id)
                if any(_num(r.get("quantity_packed")) > 0 for r in held.get("line_items") or []):
                    raise  # another parcel boxed from it: keep it (picklist ≥ package), "Créer le colis" finishes
                await _write(salesorder_id, number, "delete_picklist", zoho_service.delete_picklist(db, picklist_id))
                fresh = {
                    "date": date.today().isoformat(),
                    "location_id": picklist.get("location_id"),
                    "parent_entity": "salesorder",
                    "group_by": "none",
                    "line_items": [
                        {
                            "salesorder_id": salesorder_id,
                            "so_line_item_id": k,
                            "quantity_to_be_picked": q,
                            "quantity_picked": q,
                        }
                        for k, q in units.items()
                        if q > 0
                    ],
                }
                picklist = await _write(salesorder_id, number, "picklist", zoho_service.create_picklist(db, fresh))
                if picklist.get("status") != "completed":
                    await _write(
                        salesorder_id,
                        number,
                        "picklist_completed",
                        zoho_service.complete_picklist(db, picklist.get("picklist_id") or ""),
                    )
        if new:
            await _write(
                salesorder_id,
                number,
                "parcel",
                zoho_service.create_package(
                    db, salesorder_id, date=date.today().isoformat(), line_items=_package_lines(picklist, new)
                ),
            )
        return

    if not new:
        await _write(salesorder_id, number, "delete_package", zoho_service.delete_package(db, package_id))
        await _unmark(db, package_id)  # no parcel left to finish an edit of
        picklist = await _picklist(db, order, picklist_id)
        if not any(_num(r.get("quantity_packed")) > 0 for r in picklist.get("line_items") or []):
            await _write(salesorder_id, number, "delete_picklist", zoho_service.delete_picklist(db, picklist_id))
            return
        package = {}
    if any(q > old.get(line_id, 0.0) + 1e-9 for line_id, q in new.items()):  # A: picklist up
        rows, _, same = _picklist_rows(picklist, package, old, new, True, salesorder_id)
        if not same:
            picklist = await update_picklist("picklist_up", rows)
    lowering = any(q > new.get(line_id, 0.0) + 1e-9 for line_id, q in old.items())
    marker = await _marker(db, package_id) if new and lowering else None
    if new and lowering and not (marker and _same(marker["old"], old) and _same(marker["new"], new)):
        marker = {"old": old, "new": new}
        await _mark(db, package_id, marker)
    if new and not _same(_boxed(package), new):  # B: the package
        parcel = {"date": package.get("date") or date.today().isoformat(), "line_items": _package_lines(picklist, new)}
        await _write(
            salesorder_id, number, "parcel", zoho_service.update_package(db, package_id, salesorder_id, parcel)
        )
        package = await _package(db, package_id)
        picklist = await _picklist(db, order, picklist_id)
    if lowering:  # C: picklist down
        down = _down(marker, picklist, package, old, new, salesorder_id)
        if marker is not None and marker.get("down") is None:
            marker = {**marker, "down": down}
            await _mark(db, package_id, marker)
        rows, same = _rows_at(picklist, down)
        if not same:
            await update_picklist("picklist_down", rows)
        if new:
            await _unmark(db, package_id)


async def edit_parcel(
    db: AsyncSession, salesorder_id: str, package_id: str, version: str, was: dict[str, float], lines: dict[str, float]
) -> dict:
    """Set what a packed parcel holds, in Books, its picklist kept in step; returns the recomputed row. ``version``
    is the order's ``last_modified_time`` and ``was`` the parcel's units the operator saw; an empty ``lines`` deletes
    the parcel. The same request repeated after a failure finishes the job: a parcel that already holds ``lines``
    is not "changed", it is a step done."""
    with writing(salesorder_id):
        old, new = _units(was), _units(lines)
        doc = await confirm_stored_copy(db, salesorder_id)
        number = doc.header.get("salesorder_number") or ""
        detail = await _reread(db, salesorder_id)
        if detail.get("last_modified_time", "") != version:
            raise OrderActionRefused("version")
        row = await _row(db, salesorder_id)
        package, picklist, boxed, ceiling = await _parcel(db, salesorder_id, package_id, detail, row)
        if not _same(boxed, old) and not _same(boxed, new):
            raise OrderActionRefused("package_changed")
        _within(new, ceiling, {line["id"] for line in row["lines"]})
        if _same(old, new):
            # No change asked: only a marked edit whose picklist step is still owed has something to finish.
            marker = None if _PARCEL_EDIT_REPLACES else await _marker(db, package_id)
            if marker is None or not _owed(marker, picklist, package, boxed, salesorder_id):
                if marker is not None:
                    await _unmark(db, package_id)  # done or out of date
                raise OrderActionRefused("nothing_changed")
            old, new = marker["old"], marker["new"]
        try:
            await _rewrite_parcel(db, salesorder_id, number, detail, package, picklist, old, new)
        except Exception:
            await _best_effort_refresh(db, salesorder_id, number)  # a timeout can mean Books did it
            raise
        await _best_effort_refresh(db, salesorder_id, number)
    try:
        return await _row(db, salesorder_id)
    except OrderNotOnBoard:
        return {}  # the edit took it off the board; the write is done
