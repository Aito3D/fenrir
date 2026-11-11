"""Edit a packed parcel in Books, its picklist kept in step."""

import math
from collections.abc import Mapping
from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

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


async def package_content(db: AsyncSession, salesorder_id: str, package_id: str) -> dict:
    """What a packed parcel holds and may hold, for its editor. Reads only."""
    order = await _stored_order(db, salesorder_id)
    row = await _row(db, salesorder_id)
    if sync.zoho_busy():
        raise sync.ZohoBusy(salesorder_id)
    package, picklist, boxed, ceiling = await _parcel(db, salesorder_id, package_id, order, row)
    # A picklist-down step left undone by a failure: the parcel matches, its picklist rows are still above it.
    pending = (
        not _PARCEL_EDIT_REPLACES and not _picklist_rows(picklist, package, boxed, boxed, False, salesorder_id, True)[2]
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
    settle: bool = False,
) -> tuple[list[dict], dict[str, float], bool]:
    """The picklist rows to send, the units per order line, and whether Books already shows them.

    A line this edit changes holds the units the other parcels boxed from its row plus this parcel's: the larger of
    its old and new units while rising (never under what is picked), its new units otherwise. Every other row stays
    as it is. Counted from what Books shows now, so the same request repeated finds a done step done. ``settle``
    (the package already holds what is asked) brings the rows of the parcel's own lines down to what the parcels
    hold, never up: it finishes a picklist-down step that failed after the package step, and leaves the units
    picked for another parcel on the other rows alone.
    """
    in_parcel = _boxed(package)
    rows, units, same = [], {}, True
    for r in picklist.get("line_items") or []:
        line_id = r.get("so_line_item_id") or ""
        picked = _num(r.get("quantity_picked"))
        target = picked
        before, after = old.get(line_id, 0.0), new.get(line_id, 0.0)
        if (settle and line_id in in_parcel) or abs(before - after) > 1e-9:
            others = max(0.0, _num(r.get("quantity_packed")) - in_parcel.get(line_id, 0.0))
            if settle:
                target = min(picked, others + after)
            else:
                target = max(picked, others + max(before, after)) if rising else others + after
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
        picklist = await _picklist(db, order, picklist_id)
        if not any(_num(r.get("quantity_packed")) > 0 for r in picklist.get("line_items") or []):
            await _write(salesorder_id, number, "delete_picklist", zoho_service.delete_picklist(db, picklist_id))
            return
        package = {}
    if any(q > old.get(line_id, 0.0) + 1e-9 for line_id, q in new.items()):  # A: picklist up
        rows, _, same = _picklist_rows(picklist, package, old, new, True, salesorder_id)
        if not same:
            picklist = await update_picklist("picklist_up", rows)
    if new and not _same(_boxed(package), new):  # B: the package
        parcel = {"date": package.get("date") or date.today().isoformat(), "line_items": _package_lines(picklist, new)}
        await _write(
            salesorder_id, number, "parcel", zoho_service.update_package(db, package_id, salesorder_id, parcel)
        )
        package = await _package(db, package_id)
        picklist = await _picklist(db, order, picklist_id)
    settle = _same(old, new)  # the package step is done; only a picklist-down step that failed is left
    if settle or any(q > new.get(line_id, 0.0) + 1e-9 for line_id, q in old.items()):  # C: picklist down
        rows, _, same = _picklist_rows(picklist, package, old, new, False, salesorder_id, settle)
        if not same:
            await update_picklist("picklist_down", rows)


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
        # The parcel already holding what is asked is a done package step; the picklist may still be above it.
        if _same(old, new) and (
            _PARCEL_EDIT_REPLACES or _picklist_rows(picklist, package, old, new, False, salesorder_id, True)[2]
        ):
            raise OrderActionRefused("nothing_changed")
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
