"""Payment, contact and reference facts of an open sales order. Pure: no I/O, no clock, no database.

Two facts about what Zoho Books gives us shape this module:

* A sales order carries its invoices, so what is invoiced and what is settled on those invoices is exact.
* A customer's advance payments are one pool (``contact.unused_customer_credits``) that Books does not
  attribute to any order. ``board_payments`` therefore shares each customer's pool between their orders,
  oldest first, after setting aside the paid retainer invoices of each order's quote (``_retainers``, stored
  by the sync): a retainer counts on its own order.
"""

from datetime import date

_IGNORED_INVOICE_STATUSES = ("void", "draft")


def _num(value) -> float:
    return float(value or 0)


def _r(value: float) -> float:
    """Keep float noise out of money values and quantities (fractional, e.g. rope by the metre)."""
    return round(value, 6)


def _text(value) -> str:
    return str(value or "").strip()


def _overdue(invoice: dict, today: date) -> bool:
    try:
        return date.fromisoformat(invoice.get("due_date") or "") < today
    except (TypeError, ValueError):
        return False


def order_payment(order: dict, today: date, credit: float = 0.0) -> dict | None:
    """Payment state of one order; ``credit`` is the advance available to it. None without a total.

    ``retainer`` is the unspent money of the order's quote's retainers (each ``_retainers`` row's ``unused``, read
    from the retainer's customer payments by the sync): a retainer drawn on an invoice counts through that invoice.
    ``retainer_known`` is False for an order made from a quote whose retainers were never read.
    """
    total = _num(order.get("total"))
    if total <= 0:
        return None
    everything = [i for i in order.get("invoices") or [] if i.get("status") != "void"]
    invoices = [i for i in everything if i.get("status") not in _IGNORED_INVOICE_STATUSES]
    listed = invoices + [i for i in everything if i.get("status") in _IGNORED_INVOICE_STATUSES]
    invoiced = sum(_num(i.get("total")) for i in invoices)
    overdue_invoices = [i for i in invoices if _overdue(i, today)]
    overdue = sum(_num(i.get("balance")) for i in overdue_invoices)
    due = sum(_num(i.get("balance")) for i in invoices if i not in overdue_invoices)
    settled = sum(_num(i.get("total")) - _num(i.get("balance")) for i in invoices)
    invoice_paid = max(0.0, min(total - due - overdue, settled))
    room = max(0.0, total - invoice_paid - due - overdue)
    retainer = min(room, sum(_num(r.get("unused")) for r in order.get("_retainers") or []))
    advance = min(_num(credit), room - retainer)
    paid = min(total, invoice_paid + retainer + advance)
    next_due = min((i["due_date"] for i in invoices if _num(i.get("balance")) > 0 and i.get("due_date")), default=None)
    return {
        "state": "paid" if paid >= total else "partial" if paid > 0 else "unpaid",
        "pct": int(paid * 100 // total),
        "paid": _r(paid),
        "invoice_paid": _r(invoice_paid),
        "retainer": _r(retainer),
        "retainer_known": "_retainers" in order or not order.get("estimate_id"),
        "advance": _r(advance),
        "due": _r(due),
        "overdue": _r(overdue),
        "rest": _r(max(0.0, total - invoiced - retainer - advance)),
        "left": _r(total - paid),
        "next_due": next_due,
        "invoices": [
            {
                "id": i.get("invoice_id"),
                "number": i.get("invoice_number"),
                "date": i.get("date"),
                "due_date": i.get("due_date"),
                "total": _num(i.get("total")),
                "balance": _num(i.get("balance")),
                "status": i.get("status") or "",
                "url": None,
            }
            for i in listed
        ],
    }


def board_payments(orders: list[dict], today: date) -> dict[str, dict | None]:
    """Payment per ``salesorder_id``; ``orders`` in board sequence share each customer's advance pool, once each
    order's own retainers are taken out of it."""
    pools: dict[str, tuple[str, float]] = {}
    for order in orders:
        customer = order.get("customer_id")
        stamp = order.get("_fetched_at") or ""
        if customer and (customer not in pools or stamp >= pools[customer][0]):
            pools[customer] = (stamp, _num((order.get("contact") or {}).get("unused_customer_credits")))
    for order in orders:  # unspent retainer money is in the pool: it belongs to its own order
        customer = order.get("customer_id")
        payment = order_payment(order, today)
        if customer and payment:
            pools[customer] = (pools[customer][0], pools[customer][1] - payment["retainer"])
    result: dict[str, dict | None] = {}
    for order in orders:
        customer = order.get("customer_id")
        payment = order_payment(order, today, max(0.0, pools[customer][1]) if customer else 0.0)
        if customer and payment:
            pools[customer] = (pools[customer][0], pools[customer][1] - payment["advance"])
        result[order.get("salesorder_id") or ""] = payment
    return result


def order_contact(order: dict) -> dict | None:
    """The order's contact person, trimmed; the phone falls back to the billing address."""
    people = order.get("contact_person_details") or []
    if not people:
        return None
    person = people[0]
    phone, mobile = _text(person.get("phone")), _text(person.get("mobile"))
    if not phone and not mobile:
        phone = _text((order.get("billing_address") or {}).get("phone"))
    return {
        "name": " ".join(filter(None, (_text(person.get("first_name")), _text(person.get("last_name"))))),
        "email": _text(person.get("email")),
        "phone": phone,
        "mobile": mobile,
    }


def order_facts(order: dict) -> dict:
    """Channel, reference and links; missing Zoho fields read as empty."""
    terms = _text(order.get("payment_terms_label"))
    store, shop_order = _text(order.get("account_identifier")), _text(order.get("marketplace_so_id"))
    reference = _text(order.get("reference_number"))
    # Books fills the reference with the quote's number when it converts a quote; the Shopify sync and the
    # POS fill it with the Shopify order number. A quote's number is read separately (quote_number_missing).
    shopify_order = reference if reference.isdigit() else ""
    return {
        "channel": _text(order.get("sales_channel_formatted")),
        "reference": reference,
        "shopify_order": shopify_order,
        "quote_number": _text(order.get("estimate_number")) or ("" if shopify_order else reference),
        "delivery_method": _text(order.get("delivery_method")),
        "payment_terms": "" if terms == "-" else terms,
        "estimate_id": order.get("estimate_id") or None,
        "shopify_url": f"https://admin.shopify.com/store/{store}/orders/{shop_order}" if store and shop_order else None,
        "quote_url": None,
    }


def quote_number_missing(order: dict) -> bool:
    """A sales order whose quote number is known only to Books: it has a quote, but its reference is not it."""
    return (
        bool(order.get("estimate_id"))
        and "estimate_number" not in order
        and _text(order.get("reference_number")).isdigit()
    )
