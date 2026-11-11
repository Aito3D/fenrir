"""Shared pieces of the Order Board's Books writes: the per-order writer lock, the refusals, the entry check, the
logged write, and the picklist and parcel readers."""

import contextlib
import logging
import math
from collections.abc import Mapping
from contextlib import contextmanager

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services import order_board_sync as sync
from backend.app.services.order_board_payment import _r
from backend.app.services.zoho import ZohoNotFound, ZohoRateLimited, zoho_service

logger = logging.getLogger(__name__)

_writing: set[str] = set()


class OrderNotOnBoard(Exception):
    """The order has no row on the stored board."""


class OrderBusy(Exception):
    """Another write on this order is still running."""


class OrderActionRefused(Exception):
    """args[0] is one of "nothing_to_pack", "unknown_line", "too_many", "bad_quantity", "unknown_package",
    "picklist_open", "unknown_picklist", "picklist_shared", and from an order edit "version", "service_line",
    "below_floor", "unknown_item", "nothing_changed", and from a parcel edit "package_shipped", "package_changed"."""


@contextmanager
def writing(salesorder_id: str):
    if salesorder_id in _writing:
        raise OrderBusy(salesorder_id)
    _writing.add(salesorder_id)
    try:
        yield
    finally:
        _writing.discard(salesorder_id)


async def _row(db: AsyncSession, salesorder_id: str) -> dict:
    row = await sync.find_board_row(db, salesorder_id)
    if row is None:
        raise OrderNotOnBoard(salesorder_id)
    return row


async def confirm_stored_copy(db: AsyncSession, salesorder_id: str) -> OrderBoardDoc:
    """Entry check of every Books write, inside the writer lock: an order whose last write was never confirmed
    by a re-read, or whose stored copy is pending (that flag survives a restart), is re-read first, and a failure
    here stops the action before anything is sent. Returns the stored order."""
    if sync.zoho_busy():
        raise sync.ZohoBusy(salesorder_id)
    doc = (await db.execute(sync._stored_query(salesorder_id))).scalar_one_or_none()
    if doc is None:
        raise OrderNotOnBoard(salesorder_id)
    if doc.pending or sync.needs_refresh(salesorder_id):
        try:
            with sync._busy_on_rate_limit(salesorder_id):
                await sync.refresh_order(db, salesorder_id)
        except sync.OrderNotStored as e:
            raise OrderNotOnBoard(salesorder_id) from e
    return doc


async def _best_effort_refresh(db: AsyncSession, salesorder_id: str, number: str) -> None:
    try:
        await sync.refresh_order(db, salesorder_id)
    except Exception as e:
        logger.warning("Order board: re-read after a write failed for %s (%s)", number, type(e).__name__)
        try:  # the next pass, and the next write, re-read it
            await db.rollback()
            doc = (await db.execute(sync._stored_query(salesorder_id))).scalar_one_or_none()
            if doc is not None:
                doc.pending = True
                await db.commit()
        except Exception:
            with contextlib.suppress(Exception):
                await db.rollback()


def _num(value) -> float:
    # Deliberately tolerant, unlike the raising _num of order_board_payment: garbage reads as 0.0 here.
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


async def _write(salesorder_id: str, number: str, step: str, call):
    """One Books write: logged, and fenced so that no sync pass stores a copy fetched while it ran."""
    logger.info("Order board write: order=%s step=%s", number, step)
    sync.note_write(salesorder_id)
    try:
        return await call
    except ZohoRateLimited as e:
        sync.open_rate_limit_window(e)
        raise
    finally:
        sync.note_write(salesorder_id)


def _wanted(quantities: Mapping[str, float]) -> dict[str, float]:
    if any(not math.isfinite(q) or q < 0 for q in quantities.values()):
        raise OrderActionRefused("bad_quantity")
    wanted = {line_id: q for line_id, q in quantities.items() if q > 0}
    if not wanted:
        raise OrderActionRefused("nothing_to_pack")
    return wanted


def _within(wanted: Mapping[str, float], allowed: Mapping[str, float], known: set[str]) -> None:
    if any(line_id not in known for line_id in wanted):
        raise OrderActionRefused("unknown_line")
    if any(q > allowed.get(line_id, 0.0) + 1e-9 for line_id, q in wanted.items()):
        raise OrderActionRefused("too_many")


def _open_picklists(order: dict) -> list[dict]:
    return [p for p in order.get("picklists") or [] if p.get("status") != "completed"]


async def _stored_order(db: AsyncSession, salesorder_id: str) -> dict:
    doc = (await db.execute(sync._stored_query(salesorder_id))).scalar_one_or_none()
    if doc is None or not doc.detail:
        raise OrderNotOnBoard(salesorder_id)
    return doc.detail


async def _reread(db: AsyncSession, salesorder_id: str) -> dict:
    """The order as Books has it now, stored and returned: an edit compares and validates against this."""
    try:
        await sync.refresh_order(db, salesorder_id)
    except sync.OrderNotStored as e:
        raise OrderNotOnBoard(salesorder_id) from e
    except ZohoRateLimited as e:
        sync.open_rate_limit_window(e)
        raise sync.ZohoBusy(salesorder_id) from e
    return await _stored_order(db, salesorder_id)


def _lines(units: Mapping[str, float]) -> list[dict]:
    return [{"line_id": line_id, "quantity": q} for line_id, q in units.items()]


async def _picklist(db: AsyncSession, order: dict, picklist_id: str) -> dict:
    """A picklist of this order, as Books has it now."""
    if not any(p.get("picklist_id") == picklist_id for p in order.get("picklists") or []):
        raise OrderActionRefused("unknown_picklist")
    try:
        with sync._busy_on_rate_limit(picklist_id):
            return await zoho_service.get_picklist(db, picklist_id)
    except ZohoNotFound as e:
        raise OrderActionRefused("unknown_picklist") from e


def _to_box(picklist: dict, salesorder_id: str) -> dict[str, tuple[float, float, str]]:
    """Per order line of a picklist: the units no parcel holds yet, the units already boxed, and the picklist
    row id. A completed picklist counts what was picked, an open one what is to be picked. A picklist that also
    holds another order, or two rows for one line, is left to Books ("picklist_shared")."""
    done = picklist.get("status") == "completed"
    result: dict[str, tuple[float, float, str]] = {}
    for line in picklist.get("line_items") or []:
        if line.get("salesorder_id") != salesorder_id or line.get("so_line_item_id") in result:
            raise OrderActionRefused("picklist_shared")  # cutting it down here would touch rows it cannot tell apart
        boxed = _num(line.get("quantity_packed"))
        units = _r(_num(line.get("quantity_picked" if done else "quantity_to_be_picked")) - boxed)
        if line.get("so_line_item_id") and line.get("line_item_id"):
            result[line["so_line_item_id"]] = (max(0.0, units), boxed, line["line_item_id"])
    return result


def _boxed(package: dict) -> dict[str, float]:
    """Units per order line in a package."""
    result: dict[str, float] = {}
    for line in package.get("line_items") or []:
        line_id = line.get("so_line_item_id") or ""
        result[line_id] = result.get(line_id, 0.0) + _num(line.get("quantity"))
    return result
