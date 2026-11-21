"""Product quotes (Books estimates) as board rows. Pure: no database, no Zoho."""

from datetime import date

from backend.app.services.order_board import age_days

QUOTE_STATES = ("draft", "sent", "accepted", "expired", "declined")


def quote_state(header: dict, today: date) -> str | None:
    """The quote's board state, or None for a Books status the board does not show (invoiced, ...)."""
    status = header.get("status")
    if status not in QUOTE_STATES:
        return None
    if status in ("draft", "sent") and (header.get("expiry_date") or "") and header["expiry_date"] < today.isoformat():
        return "expired"
    return status


def is_converted(detail: dict) -> bool:
    """True when the estimate has an invoice or an order past draft/void (a missing status counts as converted)."""
    return bool(detail.get("invoice_ids")) or any(
        so.get("salesorder_order_status") not in ("draft", "void") for so in detail.get("salesorders") or []
    )


def draft_order_id(detail: dict) -> str | None:
    """The id of a linked order still in draft."""
    for so in detail.get("salesorders") or []:
        if so.get("salesorder_order_status") == "draft":
            return so.get("salesorder_id")
    return None


def is_quote_candidate(header: dict, today: date, max_age_days: int, aito_quote_ids: set[str]) -> bool:
    if header.get("estimate_id") in aito_quote_ids or quote_state(header, today) is None:
        return False
    return not (max_age_days > 0 and age_days(header.get("date"), today) > max_age_days)


def editable_here(detail: dict) -> bool:
    """Every line is a stocked item, so the board can edit it."""
    return all(line.get("item_id") for line in detail.get("line_items") or [])


def held_by_orders(board_rows: list[dict]) -> dict[str, float]:
    """Stock already covered for orders, per item."""
    held: dict[str, float] = {}
    for row in board_rows:
        for line in row.get("lines") or []:
            if line.get("item_id"):
                held[line["item_id"]] = held.get(line["item_id"], 0.0) + (line.get("covered") or 0)
    return held


def quote_row(
    header: dict,
    detail: dict | None,
    items: dict[str, dict],
    held: dict[str, float],
    today: date,
    core: set[str],
) -> dict | None:
    state = quote_state(header, today)
    if state == "accepted" and (detail is None or is_converted(detail)):
        return None
    src = {**header, **(detail or {})}
    total = src.get("total")
    lines = None
    is_core = None
    if detail is not None:
        raw_lines = detail.get("line_items") or []
        lines = []
        for raw in raw_lines:
            item_id = raw.get("item_id") or ""
            item = items.get(item_id)
            lines.append(
                {
                    "id": raw.get("line_item_id") or "",
                    "item_id": item_id,
                    "name": raw.get("name") or "",
                    "sku": raw.get("sku") or "",
                    "quantity": raw.get("quantity"),
                    "rate": raw.get("rate"),
                    "discount": raw.get("discount"),
                    "total": raw.get("item_total"),
                    "available": None
                    if item is None
                    else max(0, float(item.get("stock_on_hand") or 0) - held.get(item_id, 0)),
                }
            )
        brands = ((items.get(r.get("item_id") or "") or {}).get("brand") or "" for r in raw_lines)
        is_core = any(brand.casefold() in core for brand in brands if brand)
    return {
        "id": src.get("estimate_id") or "",
        "number": src.get("estimate_number") or "",
        "customer": src.get("customer_name") or "",
        "customer_id": src.get("customer_id") or "",
        "date": src.get("date") or "",
        "expiry_date": src.get("expiry_date") or "",
        "state": state,
        "total": None if total is None else float(total),
        "currency": src.get("currency_code") or "",
        "reference": src.get("reference_number") or "",
        "age_days": age_days(src.get("date"), today),
        "is_core": is_core,
        "editable": detail is not None and editable_here(detail),
        "has_draft_order": detail is not None and draft_order_id(detail) is not None,
        "modified": src.get("last_modified_time") or "",
        "lines": lines,
    }
