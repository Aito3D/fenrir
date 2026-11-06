"""Order-board campaign golden probe: the allocation, payment and invoice rules, pure.

Table-driven calls of the public pure functions: order_board (compute_board,
order_row, units_to_invoice, picked_waiting, age_days), order_board_payment
(order_payment, board_payments, order_contact, order_facts) and
order_board_actions.invoice_payload. Edge inputs on purpose: fractional and
negative quantities, missing keys, void/draft/overdue invoices, a shared
customer credit, amount vs percent discounts, order-level money.

Feeds services/order_board.compute_board one fixed set of Books documents that
exercises every line state and order status — oldest-first allocation, boxed
units reserved before the walk, invoiced-not-shipped units, purchase orders
(billed vs received, cancelled, closed), services, untracked and unknown
items, fractional and negative stock, draft/void/old orders, missing fields —
under four settings combinations, plus age_days on its edge inputs. Fixed
``today``; no clock, no I/O.
"""

import json
import sys
from datetime import date

sys.path.insert(0, ".")
from backend.app.services.order_board import (  # noqa: E402
    age_days,
    compute_board,
    order_row,
    picked_waiting,
    units_to_invoice,
)
from backend.app.services.order_board_actions import invoice_payload  # noqa: E402
from backend.app.services.order_board_payment import (  # noqa: E402
    board_payments,
    order_contact,
    order_facts,
    order_payment,
)

TODAY = date(2026, 11, 5)


def line(n, item, qty, *, shipped=0, packed=0, invoiced=0, cancelled=0, name=None, sku=None):
    return {
        "line_item_id": f"L{n}",
        "item_id": item,
        "name": name or f"Product {item}",
        "sku": sku or f"SKU-{item}",
        "quantity": qty,
        "quantity_shipped": shipped,
        "quantity_packed": packed,
        "quantity_invoiced": invoiced,
        "quantity_cancelled": cancelled,
    }


def so(n, day, lines, *, status="open", total=1000.0, packages=None, customer=None):
    return {
        "salesorder_id": f"so{n}",
        "salesorder_number": f"SO-{n:05d}",
        "customer_name": customer or f"Customer {n}",
        "date": day,
        "status": status,
        "total": total,
        "currency_code": "XPF",
        "line_items": lines,
        "packages": packages or [],
    }


ITEMS = {
    "A": {"item_id": "A", "stock_on_hand": 10, "brand": "eSUN", "track_inventory": True},
    "B": {"item_id": "B", "stock_on_hand": 0, "brand": "Marlow", "track_inventory": True},
    "C": {"item_id": "C", "stock_on_hand": "2.5", "brand": "Bambu Lab", "track_inventory": True},
    "D": {"item_id": "D", "stock_on_hand": 99, "brand": "eSUN", "track_inventory": False},
    "F": {"item_id": "F", "stock_on_hand": -4, "brand": "", "track_inventory": True},
    "G": {"item_id": "G", "stock_on_hand": None},
    "H": {"item_id": "H", "stock_on_hand": 0, "brand": "Polymaker", "track_inventory": True},
}

PURCHASES = [
    {"purchaseorder_number": "PO-0001", "status": "open", "line_items": [
        {"item_id": "B", "quantity": 5, "quantity_billed": 1, "quantity_received": 2, "quantity_cancelled": 0},
        {"item_id": None, "quantity": 3},
    ]},
    {"purchaseorder_number": "PO-0002", "status": "partially_billed", "line_items": [
        {"item_id": "B", "quantity": 2, "quantity_billed": 0, "quantity_received": 0, "quantity_cancelled": 0},
        {"item_id": "E", "quantity": 4, "quantity_billed": 0, "quantity_received": 0, "quantity_cancelled": 3},
        {"item_id": "A", "quantity": 2, "quantity_billed": 2, "quantity_received": 0, "quantity_cancelled": 0},
    ]},
    {"purchaseorder_number": "PO-0003", "status": "billed", "line_items": [{"item_id": "A", "quantity": 50}]},
    {"purchaseorder_number": "PO-0004", "status": "draft", "line_items": [{"item_id": "F", "quantity": 50}]},
    {"purchaseorder_number": None, "status": "open", "line_items": [{"item_id": "G", "quantity": "1.5"}]},
    {"purchaseorder_number": "PO-0006", "status": "open"},
    {"purchaseorder_number": "PO-0007", "status": "open", "line_items": [{"item_id": "H", "quantity": 3}]},
    {"purchaseorder_number": "PO-0007", "status": "open", "line_items": [{"item_id": "H", "quantity": 1}]},
]

ORDERS = [
    so(9, "2026-10-20", [line(91, "A", 5, shipped=2, cancelled=1), line(92, "A", 2, cancelled=2), line(93, "C", 1, shipped=1)]),
    so(3, "2026-10-03", [line(31, "B", 3), line(32, "C", 1.5)]),
    so(1, "2026-10-01", [line(11, "A", 4), line(12, "B", 2)], total="1234.5", customer="Lycée Agricole"),
    so(2, "2026-10-02", [line(21, "A", 8), line(22, None, 1, name="Main d'oeuvre", sku=""), line(23, "D", 2)]),
    so(4, "2026-09-01", [line(41, "A", 100)], status="draft"),
    so(5, "2026-09-02", [line(51, "A", 100)], status="void"),
    so(6, "2026-10-25", [line(61, "A", 3, packed=3), line(62, "B", 1, packed=1)],
       packages=[{"package_number": "PKG-00012", "status": "not_shipped", "date": "2026-10-26"}, {}]),
    so(7, "2026-10-26", [line(71, "B", 2, invoiced=2), line(72, "B", 2, invoiced=1, packed=2), line(73, "F", 1)]),
    so(8, "2026-08-01", [line(81, "A", 2, shipped=2), line(82, None, 1)]),
    so(10, "2026-10-28", [line(101, "E", 2), line(102, "G", 1), line(103, "", 1)]),
    so(11, "2025-01-01", [line(111, "A", 1)], total=None),
    {"salesorder_id": "so12", "status": "open"},
    {"salesorder_number": "SO-00013", "date": "not-a-day", "status": "open", "line_items": [{"item_id": "C", "quantity": "0.75"}]},
    so(14, "2026-10-02", [line(141, "C", 0.4), line(142, "C", 0.1)]),
    so(15, "2026-10-30", [line(151, "H", 2)]),
    so(16, "2026-10-31", [line(161, "H", 5)]),
]

out = {
    "age_days": {repr(d): age_days(d, TODAY) for d in ("2026-11-05", "2026-11-04", "2025-11-05", "2026-12-01", "", "nope", None, "2026-02-30")},
    "boards": {},
}
for label, kwargs in (
    ("defaults", {}),
    ("max-age-365", {"max_age_days": 365}),
    ("max-age-10-core", {"max_age_days": 10, "core_brands": ["ESUN", "bambu lab"]}),
    ("core-only-marlow", {"core_brands": ("Marlow",)}),
):
    out["boards"][label] = compute_board(ORDERS, PURCHASES, ITEMS, TODAY, **kwargs)
out["empty"] = compute_board([], [], {}, TODAY)


def call(fn, *args, **kwargs):
    """The result, or how the call failed: a crash on odd input is behaviour too."""
    try:
        return fn(*args, **kwargs)
    except Exception as e:
        return {"__raised__": f"{type(e).__name__}: {e}"}


# --- units_to_invoice / picked_waiting -------------------------------------------------------------------------


def raw(line_id, qty, *, shipped=0, invoiced=0, picked=0, packed=0, **extra):
    return {"line_item_id": line_id, "item_id": "A", "quantity": qty, "quantity_shipped": shipped,
            "quantity_invoiced": invoiced, "quantity_picked": picked, "quantity_packed": packed, **extra}


UNITS_ORDER = {"line_items": [
    raw("a", 5, shipped=2),
    raw("b", 3, shipped=3, invoiced=3),
    raw("c", 2.5, shipped=1.25, invoiced=0.5, picked=2, packed=1.25),
    raw("d", 4, invoiced=1, picked=4, packed=4),
    raw("svc", 1, product_type="service"),
    raw("svc2", 2, invoiced=2, product_type="service"),
    raw("", 9, shipped=9),
    raw("over", 2, shipped=5, picked="3", packed=None),
    raw("neg", -1, shipped=-1, picked=-2),
    raw("str", "2", shipped="1.5", invoiced="0.25", picked="0.1", packed="0.3"),
    {"line_item_id": "bare"},
    {"quantity": 3, "quantity_shipped": 3},
    raw("noise", 0.3, shipped=0.1 + 0.2, picked=0.1 + 0.2, packed=0.3),
]}
out["units_to_invoice"] = {
    "plain": call(units_to_invoice, UNITS_ORDER),
    "extra-shipped": call(units_to_invoice, UNITS_ORDER, {"a": 2, "d": 10, "c": 0.75, "unknown": 4, "neg": 5}),
    "extra-shipped-none": call(units_to_invoice, UNITS_ORDER, None),
    "service-lines": call(units_to_invoice, UNITS_ORDER, service_line_ids={"svc", "svc2", "a", ""}),
    "service-lines-as-list": call(units_to_invoice, UNITS_ORDER, {"a": 1}, ["svc"]),
    "no-lines": call(units_to_invoice, {}),
    "null-lines": call(units_to_invoice, {"line_items": None}),
    "bad-number": call(units_to_invoice, {"line_items": [raw("x", "many")]}),
}
out["picked_waiting"] = {
    "mixed": call(picked_waiting, UNITS_ORDER),
    "no-lines": call(picked_waiting, {}),
    "null-lines": call(picked_waiting, {"line_items": None}),
    "bad-number": call(picked_waiting, {"line_items": [raw("x", 1, picked="some")]}),
}

# --- order_payment / board_payments ----------------------------------------------------------------------------


def inv(n, total, balance, *, status="sent", due="2026-12-01", **extra):
    return {"invoice_id": f"inv{n}", "invoice_number": f"INV-{n}", "date": "2026-10-15", "due_date": due,
            "total": total, "balance": balance, "status": status, **extra}


PAY_CASES = {
    "no-total": ({"total": 0, "invoices": [inv(1, 100, 100)]}, 0.0),
    "missing-total": ({}, 50.0),
    "negative-total": ({"total": -5}, 0.0),
    "string-total": ({"total": "1000.50"}, 0.0),
    "no-invoice": ({"total": 1000}, 0.0),
    "no-invoice-credit": ({"total": 1000}, 250.0),
    "credit-above-total": ({"total": 1000}, 5000.0),
    "negative-credit": ({"total": 1000}, -40.0),
    "one-unpaid": ({"total": 1000, "invoices": [inv(1, 1000, 1000)]}, 0.0),
    "one-unpaid-with-credit": ({"total": 1000, "invoices": [inv(1, 1000, 1000)]}, 300.0),
    "one-partly-paid": ({"total": 1000, "invoices": [inv(1, 1000, 400)]}, 0.0),
    "one-paid": ({"total": 1000, "invoices": [inv(1, 1000, 0, status="paid")]}, 0.0),
    "partial-invoice-and-credit": ({"total": 1000, "invoices": [inv(1, 400, 100)]}, 250.0),
    "overdue": ({"total": 1000, "invoices": [inv(1, 600, 600, due="2026-11-04", status="overdue")]}, 0.0),
    "due-today-is-not-overdue": ({"total": 1000, "invoices": [inv(1, 600, 600, due="2026-11-05")]}, 0.0),
    "overdue-and-due": ({"total": 1000, "invoices": [inv(1, 300, 300, due="2026-10-01"), inv(2, 300, 120, due="2026-11-20"), inv(3, 100, 0, due="2026-09-01")]}, 100.0),
    "void-and-draft": ({"total": 1000, "invoices": [inv(1, 1000, 1000, status="void"), inv(2, 400, 400, status="draft"), inv(3, 200, 50)]}, 0.0),
    "invoiced-above-total": ({"total": 1000, "invoices": [inv(1, 800, 0), inv(2, 800, 800)]}, 100.0),
    "bad-due-date": ({"total": 1000, "invoices": [inv(1, 500, 500, due="soon"), inv(2, 500, 500, due=None), inv(3, 0, 0, due="")]}, 0.0),
    "fractions": ({"total": 99.99, "invoices": [inv(1, 33.33, 0.01)]}, 0.005),
    "sparse-invoice": ({"total": 10, "invoices": [{}, {"status": None, "total": "4", "balance": "1"}]}, 0.0),
    "null-invoices": ({"total": 10, "invoices": None}, 0.0),
}
out["order_payment"] = {label: call(order_payment, order, TODAY, credit) for label, (order, credit) in PAY_CASES.items()}
out["order_payment"]["credit-defaults-to-zero"] = call(order_payment, {"total": 1000}, TODAY)
out["order_payment"]["bad-total"] = call(order_payment, {"total": "a lot"}, TODAY)


def pso(n, customer, total, *, credits=None, fetched="", invoices=()):
    doc = {"salesorder_id": f"so{n}", "customer_id": customer, "total": total, "invoices": list(invoices)}
    if credits is not None:
        doc["contact"] = {"unused_customer_credits": credits}
    if fetched:
        doc["_fetched_at"] = fetched
    return doc


BOARD_PAY_CASES = {
    "one-pool-shared-oldest-first": [pso(1, "c1", 1000, credits=1500), pso(2, "c1", 1000, credits=1500), pso(3, "c1", 1000, credits=1500)],
    "newest-fetch-states-the-pool": [pso(1, "c1", 1000, credits=100, fetched="2026-11-01T00:00:00+00:00"), pso(2, "c1", 1000, credits=700, fetched="2026-11-02T00:00:00+00:00"), pso(3, "c1", 1000, credits=5, fetched="2026-10-01T00:00:00+00:00")],
    "same-stamp-later-order-wins": [pso(1, "c1", 1000, credits=100), pso(2, "c1", 1000, credits=300)],
    "two-customers": [pso(1, "c1", 500, credits=200), pso(2, "c2", 500, credits="50.5"), pso(3, "c1", 500), pso(4, "c2", 0, credits=50.5)],
    "no-customer-no-credit": [pso(1, "", 500, credits=400), pso(2, None, 500, credits=400), {"total": 5}],
    "invoices-leave-less-room": [pso(1, "c1", 1000, credits=900, invoices=[inv(1, 600, 600)]), pso(2, "c1", 1000, credits=900)],
    "missing-contact": [pso(1, "c1", 1000), {"salesorder_id": "so2", "customer_id": "c1", "total": 10, "contact": None}],
    "empty": [],
}
out["board_payments"] = {label: call(board_payments, orders, TODAY) for label, orders in BOARD_PAY_CASES.items()}

# --- order_contact / order_facts -------------------------------------------------------------------------------

out["order_contact"] = {
    "none": call(order_contact, {}),
    "empty-list": call(order_contact, {"contact_person_details": []}),
    "full": call(order_contact, {"contact_person_details": [{"first_name": " Hina ", "last_name": "Teriitahi", "email": " hina@example.pf ", "phone": "40 12 34 56", "mobile": " 87 11 22 33 "}, {"first_name": "Second"}]}),
    "first-name-only": call(order_contact, {"contact_person_details": [{"first_name": "Hina", "last_name": None, "mobile": 87112233}]}),
    "phone-falls-back-to-billing": call(order_contact, {"contact_person_details": [{"last_name": "Teriitahi", "phone": " ", "mobile": ""}], "billing_address": {"phone": " 40 99 88 77 "}}),
    "mobile-stops-the-fallback": call(order_contact, {"contact_person_details": [{"mobile": "87 00 00 00"}], "billing_address": {"phone": "40 99 88 77"}}),
    "no-phone-anywhere": call(order_contact, {"contact_person_details": [{}], "billing_address": None}),
    "person-is-not-a-dict": call(order_contact, {"contact_person_details": ["Hina"]}),
}
out["order_facts"] = {
    "empty": call(order_facts, {}),
    "full": call(order_facts, {"sales_channel_formatted": " Shopify ", "reference_number": " #1042 ", "delivery_method": " PICK UP ", "payment_terms_label": " Net 30 ", "estimate_id": "est9", "account_identifier": "aito3d", "marketplace_so_id": 5551234}),
    "dash-terms": call(order_facts, {"payment_terms_label": " - ", "estimate_id": "", "account_identifier": "aito3d"}),
    "shop-order-without-store": call(order_facts, {"marketplace_so_id": "5551234", "reference_number": 1042, "estimate_id": 0}),
    "nulls": call(order_facts, {"sales_channel_formatted": None, "reference_number": None, "delivery_method": None, "payment_terms_label": None, "estimate_id": None, "account_identifier": None, "marketplace_so_id": None}),
}

# --- order_row (a finished order, outside the allocation) -------------------------------------------------------

FINISHED = so(20, "2026-10-10", [line(201, "A", 2, shipped=2, invoiced=1), line(202, "C", 1.5, shipped=1.5, invoiced=1.5), line(203, None, 1, name="Main d'oeuvre", sku=""), line(204, "D", 1, shipped=1), line(205, "B", 2, cancelled=2)],
              total=4200, packages=[{"package_id": "pk9", "shipment_id": "sh9", "package_number": "PKG-00009", "status": "delivered", "date": "2026-10-12"}])
FINISHED.update(customer_id="c20", picklists=[{"picklist_id": "pl9", "picklist_number": "PL-00009", "status": "completed", "date": "2026-10-11"}, {}],
                invoices=[inv(9, 3000, 500, due="2026-10-20")], contact={"unused_customer_credits": 999},
                contact_person_details=[{"first_name": "Hina", "last_name": "Teriitahi", "mobile": "87 11 22 33"}],
                reference_number="#1042", sales_channel_formatted="Shopify", estimate_id="est20")
out["order_row"] = {
    "finished": call(order_row, FINISHED, ITEMS, TODAY),
    "finished-no-items-known": call(order_row, FINISHED, {}, TODAY),
    "still-open-lines-get-no-stock": call(order_row, so(21, "2026-11-01", [line(211, "A", 3, shipped=1, packed=2), line(212, "B", 1, invoiced=1)]), ITEMS, TODAY),
    "empty-order": call(order_row, {}, {}, TODAY),
    "null-lines-bad-date": call(order_row, {"salesorder_id": "so22", "date": "tomorrow", "line_items": None, "total": "12.5"}, ITEMS, TODAY),
    "future-date": call(order_row, so(23, "2026-12-25", []), ITEMS, TODAY),
}

# --- invoice_payload -------------------------------------------------------------------------------------------


def pline(line_id, qty, *, rate=500.0, discount=0, **extra):
    return {"line_item_id": "", "salesorder_item_id": line_id, "item_id": f"item-{line_id}", "name": f"Thing {line_id}",
            "description": "", "rate": rate, "quantity": qty, "unit": "pcs", "tax_id": "t1", "discount": discount,
            "item_total": rate * qty if isinstance(qty, (int, float)) else 0, **extra}


def prefill(lines, **head):
    return {"customer_id": "c1", "is_inclusive_tax": True, "date": "2020-01-01", "discount": 0, "discount_type": "entity_level",
            "is_discount_before_tax": True, "shipping_charge": 0, "adjustment": 0, "adjustment_description": "", "reference_number": "#1042",
            "payment_terms": 30, "payment_terms_label": "Net 30", "notes": "", "terms": "Merci", "template_id": "tpl", "salesorder_id": "so1",
            "line_items": lines, **head}


TWO = [pline("a", 3), pline("b", 2, rate=120.5)]
PAYLOAD_CASES = {
    "everything": (prefill(TWO), {"a": 3, "b": 2}),
    "keep-above-the-offer-is-capped": (prefill(TWO), {"a": 30, "b": 2}),
    "one-line-reduced": (prefill(TWO), {"a": 1.5, "b": 2}),
    "one-line-dropped": (prefill(TWO), {"a": 3}),
    "kept-line-not-offered": (prefill(TWO), {"zzz": 4}),
    "nothing-kept": (prefill(TWO), {}),
    "zero-and-negative-keep": (prefill(TWO), {"a": 0, "b": -1}),
    "string-quantities": (prefill([pline("a", "3"), pline("b", None)]), {"a": "2", "b": 1}),
    "fractional": (prefill([pline("a", 2.5, rate=99.99)]), {"a": 0.75}),
    "percent-line-discount-reduced": (prefill([pline("a", 3, discount="10.00%")]), {"a": 1}),
    "amount-line-discount-reduced": (prefill([pline("a", 3, discount=50)]), {"a": 1}),
    "amount-line-discount-as-string-reduced": (prefill([pline("a", 3, discount=" 50.00 ")]), {"a": 1}),
    "amount-line-discount-whole": (prefill([pline("a", 3, discount=50)]), {"a": 3}),
    "zero-percent-discount-reduced": (prefill([pline("a", 3, discount="0%")]), {"a": 1}),
    "unreadable-discount-reduced": (prefill([pline("a", 3, discount="half")]), {"a": 1}),
    "amount-discount-on-a-dropped-line": (prefill([pline("a", 3), pline("b", 2, discount=50)]), {"a": 3}),
    "shipping-charge-whole": (prefill(TWO, shipping_charge=1500), {"a": 3, "b": 2}),
    "shipping-charge-reduced": (prefill(TWO, shipping_charge=1500), {"a": 1, "b": 2}),
    "shipping-charge-dropped": (prefill(TWO, shipping_charge="1500.00"), {"a": 3}),
    "order-discount-percent-reduced": (prefill(TWO, discount="5%"), {"a": 1, "b": 2}),
    "order-discount-amount-whole": (prefill(TWO, discount=200), {"a": 3, "b": 2}),
    "adjustment-reduced": (prefill(TWO, adjustment=-0.5, adjustment_description="Arrondi"), {"a": 3, "b": 1}),
    "zero-money-as-strings-reduced": (prefill(TWO, discount="0.00%", shipping_charge="0", adjustment=""), {"a": 1, "b": 2}),
    "dropped-line-already-at-zero": (prefill([pline("a", 3), pline("b", 0)], shipping_charge=1500), {"a": 3}),
    "tax-exclusive-keeps-the-flag-out": (prefill(TWO, is_inclusive_tax=False, notes="Livraison jeudi", payment_terms=0), {"a": 3, "b": 2}),
    "empty-line-fields-are-left-out": (prefill([pline("a", 3, description=None, unit="", tax_id=None, discount="")]), {"a": 3}),
    "no-lines-key": ({"customer_id": "c1"}, {"a": 1}),
    "null-lines": (prefill(None), {"a": 1}),
    "line-without-order-link": (prefill([{"item_id": "x", "quantity": 2, "rate": 1}]), {"a": 1}),
    "bad-offer-quantity": (prefill([pline("a", "three")]), {"a": 1}),
}
out["invoice_payload"] = {label: call(invoice_payload, p, keep, "2026-11-05") for label, (p, keep) in PAYLOAD_CASES.items()}

print(json.dumps(out, indent=1, sort_keys=True, default=str))
