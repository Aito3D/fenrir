"""Edit the order's lines in Books."""

import logging
import math
import re

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
from backend.app.services.order_board_actions.create import _check_discount_fits, _discount
from backend.app.services.order_board_quotes import editable_here
from backend.app.services.order_board_sync._quotes import _aito_quote_ids
from backend.app.services.zoho import ZohoRateLimited, ZohoUpstreamError, zoho_service
from backend.app.services.zoho_filaments import FILAMENT_CATEGORY
from backend.app.utils.text import fold_text

logger = logging.getLogger(__name__)

_BARCODE = re.compile(r"\d{8,14}")
_FILAMENT_DIAMETER = re.compile(r"\b(1[.,]75|2[.,]85)\s?mm\b", re.IGNORECASE)
SEARCH_LIMIT = 8
_SO_LINE_FIELDS = ("line_item_id", "item_id", "name", "description", "rate", "quantity", "unit", "tax_id", "discount")


async def search_items(db: AsyncSession, query: str) -> list[dict]:
    """Goods (not services) matching ``query``, best first, at most ``SEARCH_LIMIT``: from the local catalogue copy
    when there is one. Without it, or for a barcode-shaped query (8 to 14 digits) the copy does not know, Books is
    asked; a barcode also by UPC and EAN, and those items come first."""
    local = await sync.search_catalog(db, query, SEARCH_LIMIT)
    if local is not None and (local or not _BARCODE.fullmatch(query)):
        return [_hit(item) for item in local]
    if sync.zoho_busy():
        raise sync.ZohoBusy(query)
    # Books matches search_text as one phrase ("petg jaune" misses "PETG Basic Jaune"): ask by the longest word,
    # then keep the items whose name or SKU holds every word, in any order, accents and case aside.
    words = fold_text(query).split()
    try:
        coded = await zoho_service.list_items_by_code(db, query) if _BARCODE.fullmatch(query) else []
        found = await zoho_service.list_items(db, max(words, key=len) if len(words) > 1 else query)
    except ZohoRateLimited as e:
        sync.open_rate_limit_window(e)
        raise sync.ZohoBusy(query) from e
    if len(words) > 1:
        found = [i for i in found if all(w in fold_text(f"{i.get('name') or ''} {i.get('sku') or ''}") for w in words)]
    merged: dict[str, dict] = {}
    for item in [*coded, *found]:
        merged.setdefault(item.get("item_id") or "", item)
    return [_hit(item) for item in merged.values() if not (item.get("product_type") or "").endswith("service")][
        :SEARCH_LIMIT
    ]


def _hit(item: dict) -> dict:
    return {
        "id": item.get("item_id") or "",
        "name": item.get("name") or "",
        "sku": item.get("sku") or "",
        "upc": item.get("upc") or "",
        "ean": item.get("ean") or "",
        "part_number": item.get("part_number") or "",
        "reference": item.get("cf_r_f_rence") or "",
        "rate": float(_num(item.get("rate"))),
        "stock_on_hand": None if item.get("stock_on_hand") is None else float(_num(item.get("stock_on_hand"))),
        # What can be sold: on hand minus what other confirmed orders committed (Books' available_for_sale, not
        # actual_available_stock, which ignores commitments), negative when over-committed, shown as 0.
        "available": None
        if item.get("available_for_sale") is None
        else max(0.0, float(_num(item.get("available_for_sale")))),
        "product_type": item.get("product_type") or "",
        # Not every filament is filed under the category in Books (the Bambu Lab ones are not): its diameter says it too.
        "filament": item.get("cf_nature_du_produit") == FILAMENT_CATEGORY
        or bool(_FILAMENT_DIAMETER.search(item.get("name") or "")),
    }


async def edit_lines(
    db: AsyncSession, salesorder_id: str, version: str, lines: list[dict], *, by: str | None = None
) -> dict:
    """Set the quantities of an order's live goods lines (and, when given, their unit price and discount), drop the
    ones left out and add new items, in Books. The order's quote, when it has one the board can write, is then given
    the same goods lines (``_quote`` on the answer: "updated", "skipped" or "failed"). The
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
        rates: dict[str, float] = {}  # by line id, or by item id for an added item
        discounts: dict[str, str] = {}  # "" clears
        for entry in lines:
            key = entry.get("line_id") or entry.get("item_id") or ""
            if "rate" in entry:
                rate = entry["rate"]
                if not isinstance(rate, int | float) or not math.isfinite(rate) or rate < 0:
                    raise OrderActionRefused("bad_quantity")
                rates[key] = float(rate)
            if "discount" in entry:
                _discount(entry["discount"])  # refuses a malformed one
                discounts[key] = entry["discount"]
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
        by_id = {raw.get("line_item_id"): raw for raw in raws}

        def _stated(raw: dict) -> str:
            return "" if raw.get("discount") in (None, "", 0) else str(raw["discount"])

        repriced = {i: r for i, r in rates.items() if i in by_id and r != _num(by_id[i].get("rate"))}
        rediscounted = {
            i: d for i, d in discounts.items() if i in by_id and _discount(d) != _discount(_stated(by_id[i]))
        }
        # Books has invoiced these units at the old price: the invoice would no longer match the order.
        if any(_num(by_id[i].get("quantity_invoiced")) > 0 for i in {*repriced, *rediscounted}):
            raise OrderActionRefused("line_invoiced")
        # A whole-order discount and line discounts do not mix in Books.
        if any(discounts.values()) and detail.get("discount_type") not in (None, "", "item_level"):
            raise OrderActionRefused("bad_discount")
        if (
            not new
            and not repriced
            and not rediscounted
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
                if line_id in rates:
                    kept["rate"] = rates[line_id]
                if line_id in discounts:
                    kept["discount"] = discounts[line_id] or 0  # always stated: a removed discount is cleared
                _check_discount_fits(_discount(_stated(kept)), kept["quantity"], _num(kept.get("rate")))
            body_lines.append(kept)
        for i, q in new.items():
            rate = rates.get(i, float(_num(items[i].get("rate"))))
            _check_discount_fits(_discount(discounts.get(i)), q, rate)
            body_lines.append(
                {"item_id": i, "quantity": q, "rate": rate, **({"discount": discounts[i]} if discounts.get(i) else {})}
            )
        body: dict = {"line_items": body_lines}
        if any(discounts.values()):  # what the board's own orders carry: line discounts, taken before tax
            body |= {"discount_type": "item_level", "is_discount_before_tax": True}
        try:
            await _write(
                salesorder_id,
                number,
                "lines",
                zoho_service.update_salesorder(db, salesorder_id, body),
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
        prices = [
            {"name": names.get(i) or i, "from": float(_num(by_id[i].get("rate"))), "to": r} for i, r in repriced.items()
        ]
        rebates = [{"name": names.get(i) or i, "from": _stated(by_id[i]), "to": d} for i, d in rediscounted.items()]
        quote = await _mirror_on_quote(db, detail, body_lines, raws, live)
        total_from = detail.get("total")
        refreshed = await _best_effort_refresh(db, salesorder_id, number)
        stored = await sync.find_stored(db, salesorder_id)
        await _log(
            db,
            salesorder_id,
            "order.edited",
            by,
            changes=changes,
            total_from=total_from,
            total_to=((stored.detail or {}).get("total") if refreshed and stored is not None else None),
            **({"prices": prices} if prices else {}),
            **({"discounts": rebates} if rebates else {}),
            **({"quote": quote} if quote else {}),
        )
    try:
        row = await _row(db, salesorder_id)
    except OrderNotOnBoard:
        row = {}  # the edit took it off the board; the write is done
    return {**row, "_quote": quote} if quote else row


async def _mirror_on_quote(
    db: AsyncSession, order: dict, sent: list[dict], raws: list[dict], live: set[str]
) -> str | None:
    """Give the order's quote the goods lines just saved on the order: matched by item, the quote line takes the
    order line's quantity, price and discount; an item dropped from the order leaves the quote; a new one joins it.
    Every other quote line stays as it is. The order is already saved, so nothing here raises: the answer is
    "updated", "skipped" (no quote the board can write: other tax or discount mode, a free-text line, an item on two
    lines) or "failed" (Books refused or was unreachable; the quote keeps its old lines). None without a quote."""
    estimate_id = str(order.get("estimate_id") or "")
    if not estimate_id:
        return None
    try:
        if estimate_id in await _aito_quote_ids(db):  # an Aito card owns it and writes its own lines
            return "skipped"
        estimate = await zoho_service.get_estimate(db, estimate_id)
        if not editable_here(estimate):
            return "skipped"
        goods = {raw.get("item_id") for raw in raws if raw.get("line_item_id") in live}  # before the edit
        now = {
            line.get("item_id"): line for line in sent if line.get("line_item_id") in live or "line_item_id" not in line
        }
        lines: list[dict] = []
        on_quote: set = set()
        for q_line in estimate.get("line_items") or []:
            item_id = q_line.get("item_id")
            kept = {
                k: q_line[k]
                for k in (
                    "line_item_id",
                    "item_id",
                    "name",
                    "description",
                    "rate",
                    "tax_id",
                    "unit",
                    "quantity",
                    "discount",
                )
                if k in q_line
            }
            if item_id in now:
                on_quote.add(item_id)
                kept |= {
                    "quantity": now[item_id]["quantity"],
                    "rate": now[item_id]["rate"],
                    "discount": now[item_id].get("discount") or 0,
                }
            elif item_id in goods:
                continue  # dropped from the order
            lines.append(kept)
        lines += [
            {k: line[k] for k in ("item_id", "quantity", "rate", "discount") if k in line}
            for item_id, line in now.items()
            if item_id not in on_quote
        ]
        sync.note_write(estimate_id)
        await zoho_service.update_estimate_lines(db, estimate_id, lines)
        logger.info(
            "Order board write: quote=%s step=lines (from order %s)", estimate_id, order.get("salesorder_number")
        )
        return "updated"
    except Exception as e:
        logger.warning(
            "Order board: mirroring order %s on quote %s failed (%s)",
            order.get("salesorder_number"),
            estimate_id,
            type(e).__name__,
        )
        return "failed"
