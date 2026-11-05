"""The Order Board's allocation: which open sales orders can ship today.

Stock is shared between orders, so a line cannot be judged alone. Stock is
handed out oldest order first, and a line's readiness is what is left once
every older order has taken its share. ``compute_board`` is pure (no I/O, no
clock): Zoho Books documents in, board rows out.

Two things go beyond "oldest first":

* Units already in a package but not delivered are reserved for their order
  before the walk starts. They are physically in a box, yet Books still counts
  them in stock on hand, so an older order would otherwise claim them. A boxed
  unit is never short, even when Books shows no stock for it.
* Units invoiced but not shipped have already left stock on hand (Books lowers
  stock when the invoice is created), so they count as ready and take nothing.
"""

from collections.abc import Sequence
from datetime import date

from backend.app.services.order_board_payment import board_payments, order_contact, order_facts, order_payment

_SKIPPED_STATUSES = ("draft", "void")
_OPEN_PO_STATUSES = ("open", "partially_billed")
_LIVE_STATES = ("ready", "backorder", "to_order")


def _num(value) -> float:
    return float(value or 0)


def _r(value: float) -> float:
    """Quantities can be fractional (rope by the metre); keep float noise out."""
    return round(value, 6)


def age_days(day: str, today: date) -> int:
    """Whole days from an ISO day to today, never negative; 0 when unparseable."""
    try:
        return max(0, (today - date.fromisoformat(day)).days)
    except (TypeError, ValueError):
        return 0


def _incoming(purchase_orders: list[dict]) -> tuple[dict[str, float], dict[str, list[str]]]:
    """Units still to arrive per item, and the purchase orders bringing them.

    Books records billed and received quantities separately; the larger of the
    two is what has arrived, so a PO received before its bill is not counted
    as still incoming.
    """
    incoming: dict[str, float] = {}
    numbers: dict[str, list[str]] = {}
    for po in purchase_orders:
        if po.get("status") not in _OPEN_PO_STATUSES:
            continue
        for po_line in po.get("line_items") or []:
            item_id = po_line.get("item_id")
            arrived = max(_num(po_line.get("quantity_billed")), _num(po_line.get("quantity_received")))
            units = _num(po_line.get("quantity")) - arrived - _num(po_line.get("quantity_cancelled"))
            if not item_id or units <= 0:
                continue
            incoming[item_id] = incoming.get(item_id, 0.0) + units
            po_numbers = numbers.setdefault(item_id, [])
            if po.get("purchaseorder_number") not in po_numbers:
                po_numbers.append(po.get("purchaseorder_number") or "")
    return incoming, numbers


def _line(raw: dict, items: dict[str, dict]) -> dict:
    item_id = raw.get("item_id") or None
    item = items.get(item_id) if item_id else None
    quantity, shipped, cancelled = (_num(raw.get(k)) for k in ("quantity", "quantity_shipped", "quantity_cancelled"))
    remaining = max(0.0, quantity - shipped - cancelled)
    return {
        "id": raw.get("line_item_id") or "",
        "item_id": item_id,
        "name": raw.get("name") or "",
        "sku": raw.get("sku") or "",
        "state": "",
        "quantity": _r(quantity),
        "shipped": _r(shipped),
        "cancelled": _r(cancelled),
        "remaining": _r(remaining),
        "invoiced": _r(min(remaining, max(0.0, _num(raw.get("quantity_invoiced")) - shipped))),
        "packed_waiting": _r(min(remaining, max(0.0, _num(raw.get("quantity_packed")) - shipped))),
        "stock_available": None,
        "covered": 0.0,
        "shortfall": 0.0,
        "covered_by_po": 0.0,
        "po_numbers": [],
        # A line with no item is a service. So is a known item Books does not
        # track. An item id missing from the local copy stays tracked, stock 0.
        "_tracked": bool(item_id) and (item is None or bool(item.get("track_inventory", True))),
        "_reserved": 0.0,
    }


def _take(pool: dict[str, float], item_id: str, wanted: float) -> float:
    taken = max(0.0, min(wanted, pool.get(item_id, 0.0)))
    pool[item_id] = pool.get(item_id, 0.0) - taken
    return taken


def _allocate(line: dict, stock: dict[str, float], incoming: dict[str, float], numbers: dict[str, list[str]]) -> None:
    if not line["_tracked"]:
        line["state"] = "service"
    elif line["quantity"] - line["cancelled"] <= 0:
        line["state"] = "cancelled"
    elif line["remaining"] <= 0:
        line["state"] = "shipped"
    else:
        item_id = line["item_id"]
        line["stock_available"] = _r(stock.get(item_id, 0.0) + line["_reserved"])
        # Invoiced units have left stock on hand; boxed units exist because the
        # box does, whatever Books says the shelf holds (pass 1 already took
        # from the pool what it could for them). Neither can be short. The two
        # overlap: an invoiced unit is taken to be a boxed one first.
        set_aside = max(line["invoiced"], line["packed_waiting"])
        line["covered"] = _r(set_aside + _take(stock, item_id, line["remaining"] - set_aside))
        line["shortfall"] = _r(line["remaining"] - line["covered"])
        if line["shortfall"] <= 0:
            line["state"] = "ready"
            return
        line["covered_by_po"] = _r(_take(incoming, item_id, line["shortfall"]))
        if line["covered_by_po"] > 0:
            # Only when this line drew from them: a PO used up by an older
            # order must not suggest goods are coming for this one.
            line["po_numbers"] = list(numbers.get(item_id, []))
        line["state"] = "backorder" if line["covered_by_po"] >= line["shortfall"] else "to_order"


def _status(live: list[dict]) -> str:
    ready = sum(1 for line in live if line["state"] == "ready")
    if ready == len(live):
        return "to_ship"
    if ready:
        return "partial"
    return "to_order" if any(line["state"] == "to_order" for line in live) else "incoming"


def _units(lines: list[dict]) -> dict[str, float]:
    tracked = [line for line in lines if line["state"] != "service"]
    short = [line for line in tracked if line["state"] in ("backorder", "to_order")]
    return {
        "total": _r(sum(line["quantity"] - line["cancelled"] for line in tracked)),
        "shipped": _r(sum(line["shipped"] for line in tracked)),
        "ready": _r(
            sum(line["remaining"] for line in tracked if line["state"] == "ready")
            + sum(line["covered"] for line in short)
        ),
        "backordered": _r(sum(line["shortfall"] for line in short if line["state"] == "backorder")),
        "to_order": _r(sum(line["shortfall"] for line in short if line["state"] == "to_order")),
    }


def _row(order: dict, age: int, lines: list[dict], status: str, items: dict[str, dict], core: set[str]) -> dict:
    """One board row; ``payment`` is filled in by the caller (it depends on the other orders)."""
    units = _units(lines)
    owed = units["ready"] + units["backordered"] + units["to_order"]
    brands = ((items.get(line["item_id"]) or {}).get("brand") or "" for line in lines if line["state"] != "service")
    total = order.get("total")
    live = [line for line in lines if line["state"] in _LIVE_STATES]
    return {
        "id": order.get("salesorder_id") or "",
        "number": order.get("salesorder_number") or "",
        "customer": order.get("customer_name") or "",
        "customer_id": order.get("customer_id") or "",
        "date": order.get("date") or "",
        "total": None if total is None else float(total),
        "currency": order.get("currency_code") or "",
        "status": status,
        "age_days": age,
        "is_core": any(brand.casefold() in core for brand in brands if brand),
        "ready_ratio": units["ready"] / owed if owed else 1.0,
        "packed": _r(sum(line["packed_waiting"] for line in live)),
        "units": units,
        "packages": [
            {
                "number": p.get("package_number") or "",
                "status": p.get("status") or "",
                "date": p.get("date") or "",
            }
            for p in order.get("packages") or []
        ],
        "lines": [{k: v for k, v in line.items() if not k.startswith("_")} for line in lines],
        "payment": None,
        "contact": order_contact(order),
        "facts": order_facts(order),
    }


def order_row(order: dict, items: dict[str, dict], today: date) -> dict:
    """The row for one order outside the allocation (a finished order): no stock, no incoming goods."""
    lines = [_line(raw, items) for raw in order.get("line_items") or []]
    for line in lines:
        _allocate(line, {}, {}, {})
    row = _row(order, age_days(order.get("date") or "", today), lines, "finished", items, set())
    row["payment"] = order_payment(order, today)
    return row


def compute_board(
    orders: list[dict],
    purchase_orders: list[dict],
    items: dict[str, dict],
    today: date,
    *,
    max_age_days: int = 0,
    core_brands: Sequence[str] = (),
) -> list[dict]:
    """Board rows for every unfinished sales order, in allocation sequence.

    ``orders`` and ``purchase_orders`` are Zoho Books detail documents,
    ``items`` maps item id to the Books item. Draft and void orders, and orders
    older than ``max_age_days`` (0 = no limit), are left out and take no stock.
    """
    stock = {item_id: max(0.0, _num(item.get("stock_on_hand"))) for item_id, item in items.items()}
    incoming, numbers = _incoming(purchase_orders)
    core = {brand.casefold() for brand in core_brands}

    kept: list[tuple[dict, int, list[dict]]] = []
    for order in sorted(orders, key=lambda o: (o.get("date") or "", o.get("salesorder_number") or "")):
        age = age_days(order.get("date") or "", today)
        if order.get("status") in _SKIPPED_STATUSES or (max_age_days > 0 and age > max_age_days):
            continue
        kept.append((order, age, [_line(raw, items) for raw in order.get("line_items") or []]))

    # Pass 1: goods already in a box stay with their order.
    for _, _, lines in kept:
        for line in lines:
            if line["_tracked"] and line["remaining"] > 0:
                line["_reserved"] = _take(stock, line["item_id"], line["packed_waiting"] - line["invoiced"])

    rows: list[dict] = []
    row_orders: list[dict] = []
    for order, age, lines in kept:
        for line in lines:
            _allocate(line, stock, incoming, numbers)
        live = [line for line in lines if line["state"] in _LIVE_STATES]
        if not live:
            continue  # finished: everything shipped, cancelled or a service
        rows.append(_row(order, age, lines, _status(live), items, core))
        row_orders.append(order)
    payments = board_payments(row_orders, today)
    for row in rows:
        row["payment"] = payments[row["id"]]
    return rows
