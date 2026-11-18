"""Order Board campaign (O3) golden probe: the pure rules, on fixed fixtures (deterministic JSON).

compute_board (stock allocation across orders by age, boxed/invoiced set-aside, PO coverage,
draft/void/old skips, service/cancelled/shipped lines, core brands, estimable, payment pooling),
order_row, units_to_invoice, picked_waiting, finished_is_core, age_days; order_payment /
board_payments / order_contact / order_facts / quote_number_missing; invoice_payload;
sms.compose; derive_tracking / is_expired / tracking_url_for; kinds_for_depth / KINDS.
"""
import copy
import json
import sys
from datetime import date, datetime

sys.path.insert(0, "tools")
import probe_orders_lib  # noqa: E402,F401  (temp DATA_DIR before the app is imported)

from backend.app.services import order_board as ob  # noqa: E402
from backend.app.services import order_board_events as ev  # noqa: E402
from backend.app.services import order_board_payment as pay  # noqa: E402
from backend.app.services import order_board_sms as sms  # noqa: E402
from backend.app.services import order_board_tracking as trk  # noqa: E402
from backend.app.services.order_board_actions import invoice_payload  # noqa: E402

TODAY = date(2026, 11, 10)


def call(fn, *a, **k):
    try:
        return fn(*a, **k)
    except Exception as e:  # noqa: BLE001  (the probe records what raises)
        return {"__raised__": f"{type(e).__name__}: {e}"}


def ln(lid, item, qty=1, shipped=0, packed=0, cancelled=0, invoiced=0, picked=0, rate=1000, **extra):
    return {"line_item_id": lid, "item_id": item, "name": f"Thing {lid}", "sku": f"SKU-{item}", "quantity": qty,
            "quantity_shipped": shipped, "quantity_packed": packed, "quantity_cancelled": cancelled,
            "quantity_invoiced": invoiced, "quantity_picked": picked, "rate": rate, **extra}


def so(n, day, lines, **extra):
    base = {"salesorder_id": f"so{n}", "salesorder_number": f"SO-{n:05d}", "customer_name": f"Customer {n}",
            "customer_id": extra.pop("customer", f"c{n}"), "date": day, "status": "open", "total": 1000.0,
            "currency_code": "XPF", "invoices": [], "estimate_id": "", "is_inclusive_tax": True,
            "last_modified_time": "2026-11-01T08:00:00-1000", "line_items": lines, "packages": []}
    base.update(extra)
    return base


ITEMS = {
    "A": {"item_id": "A", "stock_on_hand": 9, "brand": "eSUN", "track_inventory": True, "upc": "0123", "ean": " 456 ", "part_number": ""},
    "B": {"item_id": "B", "stock_on_hand": 3, "brand": "Bambu Lab", "track_inventory": True, "sku": "SKU-B"},
    "C": {"item_id": "C", "stock_on_hand": 0, "brand": "Other", "track_inventory": True},
    "U": {"item_id": "U", "stock_on_hand": 0, "brand": "eSUN", "track_inventory": False},
    "N": {"item_id": "N", "stock_on_hand": -3, "brand": "", "track_inventory": True},
}
PEOPLE = [{"first_name": " Hina ", "last_name": "Tane", "email": "hina@example.test", "phone": "", "mobile": ""}]
ORDERS = [
    so(1, "2026-10-01", [ln("l1", "A", qty=3), ln("l1b", "B", qty=2)], customer="cA",
       contact={"unused_customer_credits": 700}, contact_person_details=PEOPLE, billing_address={"phone": "40 50 60 70"},
       reference_number="1079", sales_channel_formatted="Shopify", account_identifier="shop", marketplace_so_id="555",
       payment_terms_label="-", delivery_method="Pick Up",
       invoices=[{"invoice_id": "i1", "invoice_number": "INV-1", "status": "sent", "total": 400, "balance": 100, "date": "2026-10-02", "due_date": "2026-10-05"},
                 {"invoice_id": "i2", "invoice_number": "INV-2", "status": "draft", "total": 300, "balance": 300, "date": "2026-10-03"},
                 {"invoice_id": "i3", "invoice_number": "INV-3", "status": "void", "total": 999, "balance": 999}],
       picklists=[{"picklist_id": "pl1", "picklist_number": "PL-1", "status": "completed", "date": "2026-10-04"}]),
    so(2, "2026-10-15", [ln("l2", "A", qty=4, packed=2, picked=3), ln("l2s", "", qty=1, product_type="service", name="Design"),
                         ln("l2c", "C", qty=2, cancelled=2)], customer="cA", estimate_id="e2", estimate_number="DEV26-2",
       _retainers=[{"unused": 250}], total=2000.0, discount="10%",
       packages=[{"package_id": "pk2", "package_number": "PKG-2", "status": "not_shipped", "shipment_id": "", "date": "2026-10-20"}]),
    so(3, "2026-11-01", [ln("l3", "A", qty=2), ln("l3c", "C", qty=5), ln("l3u", "U", qty=1)], customer="cB",
       total=0, reference_number="DEV26-0003"),
    so(4, "2026-11-05", [ln("l4", "C", qty=3, shipped=1, invoiced=2), ln("l4n", "N", qty=1), ln("l4x", "X", qty=2)],
       customer="cB", estimate_id="e4", reference_number="1080", shipping_charge="0", adjustment=5),
    so(5, "2025-01-01", [ln("l5", "A", qty=1)]),  # older than max_age_days below
    so(6, "2026-11-02", [ln("l6", "A", qty=1)], status="draft"),
    so(7, "2026-11-03", [ln("l7", "A", qty=2, shipped=2, invoiced=2)]),  # finished: everything shipped
    so(8, "2026-11-04", [ln("l8", "B", qty=1.5)], total=None),
    so(9, "2026-11-06", [ln("l9", "C", qty=1)], customer="cB"),  # all of it on a PO: incoming
]
POS = [
    {"purchaseorder_id": "po1", "purchaseorder_number": "PO-0001", "status": "open",
     "line_items": [{"item_id": "C", "quantity": 6, "quantity_billed": 1, "quantity_received": 0, "quantity_cancelled": 0},
                    {"item_id": "B", "quantity": 1, "quantity_billed": 0, "quantity_received": 1, "quantity_cancelled": 0}]},
    {"purchaseorder_id": "po2", "purchaseorder_number": "PO-0002", "status": "partially_billed",
     "line_items": [{"item_id": "C", "quantity": 2, "quantity_billed": 0, "quantity_received": 0, "quantity_cancelled": 0}]},
    {"purchaseorder_id": "po3", "purchaseorder_number": "PO-0003", "status": "closed",
     "line_items": [{"item_id": "C", "quantity": 50}]},
]

out = {}
out["age_days"] = [ob.age_days(d, TODAY) for d in ("2026-11-10", "2026-11-11", "2026-01-01", "", "bad")]
out["compute_board"] = ob.compute_board(copy.deepcopy(ORDERS), POS, ITEMS, TODAY)
out["compute_board_max_age_core"] = [
    (r["id"], r["status"], r["is_core"], r["age_days"])
    for r in ob.compute_board(copy.deepcopy(ORDERS), POS, ITEMS, TODAY, max_age_days=60, core_brands=["ESUN", "nope"])
]
out["compute_board_no_po_no_items"] = ob.compute_board(copy.deepcopy(ORDERS[:2]), [], {}, TODAY)
out["order_row_finished"] = ob.order_row(copy.deepcopy(ORDERS[6]), ITEMS, TODAY)
out["units_to_invoice"] = {
    "plain": ob.units_to_invoice(ORDERS[3]),
    "extra": ob.units_to_invoice(ORDERS[0], {"l1": 2, "l1b": 5}),
    "service": ob.units_to_invoice(ORDERS[1], {"l2": 1}, {"l2s"}),
}
out["picked_waiting"] = [ob.picked_waiting(o) for o in ORDERS[:3]]
out["finished_is_core"] = [ob.finished_is_core(o, ITEMS, {"esun"}) for o in (None, {}, ORDERS[0], ORDERS[3], ORDERS[1])]

out["order_payment"] = {o["salesorder_id"]: pay.order_payment(o, TODAY) for o in ORDERS}
out["order_payment_credit"] = pay.order_payment(ORDERS[0], TODAY, credit=10_000)
out["board_payments"] = pay.board_payments(copy.deepcopy(ORDERS[:4]), TODAY)
out["order_contact"] = [pay.order_contact(o) for o in (ORDERS[0], {}, {"contact_person_details": [{"mobile": "87"}], "billing_address": {"phone": "x"}})]
out["order_facts"] = [pay.order_facts(o) for o in ORDERS[:4]]
out["quote_number_missing"] = [pay.quote_number_missing(o) for o in ORDERS[:4]]

PREFILL = {
    "customer_id": "c1", "is_inclusive_tax": True, "date": "2020-01-01", "discount": 0, "shipping_charge": 0, "adjustment": "",
    "notes": "n", "template_id": "tpl", "salesorder_id": "so1", "reference_number": None,
    "line_items": [
        {"line_item_id": "", "salesorder_item_id": "l1", "item_id": "A", "name": "Thing", "description": "", "rate": 500.0, "quantity": 3, "tax_id": "t1", "discount": 0, "item_total": 0},
        {"line_item_id": "", "salesorder_item_id": "l2", "item_id": "B", "name": "Other", "description": "d", "rate": 250.0, "quantity": 1, "tax_id": "t1", "discount": "10%", "item_total": 0},
    ],
}
out["invoice_payload"] = {
    "all": invoice_payload(PREFILL, {"l1": 3, "l2": 1}, "2026-11-10"),
    "reduced": invoice_payload(PREFILL, {"l1": 2}, "2026-11-10"),
    "above_offer": invoice_payload(PREFILL, {"l1": 9, "l2": 1}, "2026-11-10"),
    "nothing": invoice_payload(PREFILL, {"zz": 1}, "2026-11-10"),
    "order_money": invoice_payload({**PREFILL, "shipping_charge": 500}, {"l1": 3}, "2026-11-10"),
    "line_discount": invoice_payload({**PREFILL, "line_items": [{**PREFILL["line_items"][0], "discount": 50}]}, {"l1": 1}, "2026-11-10"),
}

board = out["compute_board"]
natures = {"A": sms.FILAMENTS, "B": sms.PRINTERS, "C": "", "U": sms.FILAMENTS}
srow = {"number": "SO-00009", "ready_ratio": 1, "currency": "XPF", "facts": {"shopify_order": ""}, "payment": {"left": 12345.6},
        "lines": [{"item_id": "A", "state": "ready", "quantity": 2, "cancelled": 0, "name": "PLA"}]}
printer = {"item_id": "B", "state": "ready", "quantity": 1, "cancelled": 0, "name": "Bambu Lab - P1S"}
out["sms_compose"] = {
    "board_rows": {r["id"]: sms.compose(r, natures) for r in board},
    "filaments": sms.compose(srow, natures),
    "printer": sms.compose({**srow, "lines": [printer], "payment": None}, natures),
    "printer_filaments": sms.compose({**srow, "lines": [printer, srow["lines"][0]], "facts": {"shopify_order": "1079"}}, natures),
    "two_printers": sms.compose({**srow, "lines": [printer, {**printer, "item_id": "B"}]}, natures),
    "partial_links": sms.compose({**srow, "ready_ratio": 0.5, "currency": "EUR"}, natures, "https://pay.example/l/1", "https://shop.example/t/ABC123"),
    "other": sms.compose({**srow, "lines": [{**srow["lines"][0], "item_id": "C"}], "payment": {"left": 0}}, natures),
    "service_only": sms.compose({**srow, "lines": [{"item_id": "", "state": "service", "quantity": 1, "cancelled": 0, "name": "S"}]}, natures),
}

out["derive_tracking"] = {r["id"]: trk.derive_tracking(r) for r in board}
started = {**board[0], "prep": {"at": "x", "by": "y"}}
out["derive_tracking_started"] = trk.derive_tracking(started, ["2026-11-03", "2026-11-03T10:00:00"])
out["derive_tracking_two_days"] = trk.derive_tracking(out["order_row_finished"], ["2026-11-03", "2026-11-04"])
out["derive_tracking_one_day"] = trk.derive_tracking(out["order_row_finished"], ["2026-11-04"])
out["derive_tracking_none"] = trk.derive_tracking({"lines": [{"state": "service"}]})
now = datetime(2026, 11, 10, 12, 0)
out["is_expired"] = [trk.is_expired(x, now) for x in (None, datetime(2026, 10, 11, 12, 0), datetime(2026, 10, 11, 11, 59), datetime(2026, 11, 9))]
out["tracking_url_for"] = [trk.tracking_url_for(b, t) for b, t in (("https://s.example", "ABC123"), ("", "ABC"), ("https://s.example", ""))]
out["tracking_constants"] = {"TRACK_KIND": trk.TRACK_KIND, "TTL_AFTER_HANDOVER": str(trk.TTL_AFTER_HANDOVER), "VIEW_DEDUP_WINDOW": str(trk.VIEW_DEDUP_WINDOW)}
out["kinds_for_depth"] = {d: ev.kinds_for_depth(d) for d in ("story", "detail", "everything", "bogus")}
out["KINDS"] = ev.KINDS
out["sms_constants"] = [sms.FILAMENTS, sms.PRINTERS, sms.SIGNATURE]
print(json.dumps(out, indent=1, sort_keys=True, ensure_ascii=False, default=str))
