"""compute_board: stock handed out oldest order first (the Order Board brief),
plus this app's additions — the purchase-order "arrived" rule, the age limit
and the reservation of units already in a package."""

from datetime import date
from itertools import count

import pytest

from backend.app.services.order_board import compute_board, order_row, picked_waiting, units_to_invoice

TODAY = date(2026, 1, 20)
_ids = count(1)


def line(item_id, qty, *, shipped=0, packed=0, cancelled=0, invoiced=0, sku="SKU"):
    return {
        "line_item_id": f"L{next(_ids)}",
        "item_id": item_id,
        "name": f"Item {item_id}",
        "sku": sku,
        "quantity": qty,
        "quantity_shipped": shipped,
        "quantity_packed": packed,
        "quantity_cancelled": cancelled,
        "quantity_invoiced": invoiced,
    }


def so(number, day, lines, *, status="open", total=100.0, customer_id="", credit=0.0, invoices=()):
    return {
        "customer_id": customer_id,
        "contact": {"unused_customer_credits": credit},
        "invoices": list(invoices),
        "salesorder_id": f"id-{number}",
        "salesorder_number": number,
        "customer_name": f"Customer {number}",
        "date": day,
        "status": status,
        "total": total,
        "currency_code": "XPF",
        "line_items": lines,
    }


def po(number, lines, *, status="open"):
    """lines: (item_id, quantity, billed, received, cancelled)."""
    return {
        "purchaseorder_number": number,
        "status": status,
        "line_items": [
            {"item_id": i, "quantity": q, "quantity_billed": b, "quantity_received": r, "quantity_cancelled": c}
            for i, q, b, r, c in lines
        ],
    }


def item(stock, *, brand="", tracked=True):
    return {"stock_on_hand": stock, "brand": brand, "track_inventory": tracked}


def only_line(row):
    (single,) = row["lines"]
    return single


def test_worked_case_from_the_brief():
    rows = compute_board(
        [
            so("SO-1", "2026-01-03", [line("A", 4)]),
            so("SO-2", "2026-01-05", [line("A", 3)]),
            so("SO-3", "2026-01-09", [line("A", 5)]),
            so("SO-4", "2026-01-10", [line("A", 1)]),
        ],
        [po("PO-0012", [("A", 4, 0, 0, 0)])],
        {"A": item(5)},
        TODAY,
    )
    l1, l2, l3, l4 = (only_line(r) for r in rows)
    assert (l1["state"], l1["covered"], l1["shortfall"], l1["po_numbers"]) == ("ready", 4, 0, [])
    assert (l2["state"], l2["covered"], l2["shortfall"], l2["covered_by_po"], l2["po_numbers"]) == (
        "backorder",
        1,
        2,
        2,
        ["PO-0012"],
    )
    assert (l3["state"], l3["shortfall"], l3["covered_by_po"], l3["po_numbers"]) == ("to_order", 5, 2, ["PO-0012"])
    assert (l4["state"], l4["covered_by_po"], l4["po_numbers"]) == ("to_order", 0, [])
    assert [ln["stock_available"] for ln in (l1, l2, l3, l4)] == [5, 1, 0, 0]
    assert [r["status"] for r in rows] == ["to_ship", "incoming", "to_order", "to_order"]
    assert rows[1]["units"]["ready"] == 1 and rows[1]["units"]["backordered"] == 2
    assert rows[1]["ready_ratio"] == pytest.approx(1 / 3)


def test_same_date_orders_are_served_by_order_number():
    orders = [so("SO-B", "2026-01-05", [line("A", 1)]), so("SO-A", "2026-01-05", [line("A", 1)])]
    rows = compute_board(orders, [], {"A": item(1)}, TODAY)
    assert [(r["number"], only_line(r)["state"]) for r in rows] == [("SO-A", "ready"), ("SO-B", "to_order")]


def test_invoiced_units_are_ready_without_touching_the_pool():
    rows = compute_board(
        [so("SO-1", "2026-01-03", [line("A", 3, invoiced=3)]), so("SO-2", "2026-01-04", [line("A", 2)])],
        [],
        {"A": item(2)},
        TODAY,
    )
    first, second = (only_line(r) for r in rows)
    assert (first["state"], first["invoiced"], first["covered"]) == ("ready", 3, 3)
    assert (second["state"], second["stock_available"]) == ("ready", 2)


def test_service_cancelled_and_shipped_lines():
    no_item = {**line(None, 1), "item_id": None}
    rows = compute_board(
        [
            so(
                "SO-1",
                "2026-01-03",
                [
                    no_item,
                    line("SVC", 1),
                    line("A", 2, cancelled=2),
                    line("A", 2, shipped=2),
                    line("A", 1),
                ],
            )
        ],
        [],
        {"A": item(1), "SVC": item(0, tracked=False)},
        TODAY,
    )
    (row,) = rows
    assert [ln["state"] for ln in row["lines"]] == ["service", "service", "cancelled", "shipped", "ready"]
    assert row["lines"][0]["stock_available"] is None and row["lines"][1]["stock_available"] is None


@pytest.mark.parametrize("product_type", ["service", "digital_service"])
def test_a_service_line_missing_from_the_items_cache_is_not_live(product_type):
    rows = compute_board(
        [so("SO-1", "2026-01-03", [{**line("GONE", 1), "product_type": product_type}, line("A", 1)])],
        [],
        {"A": item(1)},
        TODAY,
    )
    (row,) = rows
    assert [ln["state"] for ln in row["lines"]] == ["service", "ready"]
    assert row["status"] == "to_ship"


@pytest.mark.parametrize(
    ("stock_a", "stock_b", "incoming_b", "expected"),
    [
        (1, 1, 0, "to_ship"),  # every live line ready
        (1, 0, 0, "partial"),  # some ready, some not
        (0, 0, 1, "to_order"),  # none ready, one to order (A has no PO)
        (1, 0, 1, "partial"),
    ],
)
def test_roll_up_branches(stock_a, stock_b, incoming_b, expected):
    pos = [po("PO-1", [("B", incoming_b, 0, 0, 0)])] if incoming_b else []
    (row,) = compute_board(
        [so("SO-1", "2026-01-03", [line("A", 1), line("B", 1)])],
        pos,
        {"A": item(stock_a), "B": item(stock_b)},
        TODAY,
    )
    assert row["status"] == expected


def test_all_backorder_reads_incoming():
    (row,) = compute_board(
        [so("SO-1", "2026-01-03", [line("A", 1), line("B", 2)])],
        [po("PO-1", [("A", 1, 0, 0, 0), ("B", 2, 0, 0, 0)])],
        {"A": item(0), "B": item(0)},
        TODAY,
    )
    assert row["status"] == "incoming"


def test_finished_order_is_left_out():
    orders = [so("SO-1", "2026-01-03", [line("A", 2, shipped=2), line("A", 1, cancelled=1), line("SVC", 1)])]
    assert compute_board(orders, [], {"A": item(9), "SVC": item(0, tracked=False)}, TODAY) == []


@pytest.mark.parametrize("status", ["draft", "void"])
def test_draft_and_void_orders_are_ignored_and_take_no_stock(status):
    rows = compute_board(
        [so("SO-1", "2026-01-03", [line("A", 1)], status=status), so("SO-2", "2026-01-04", [line("A", 1)])],
        [],
        {"A": item(1)},
        TODAY,
    )
    assert [(r["number"], r["status"]) for r in rows] == [("SO-2", "to_ship")]


def test_unit_counts_and_age():
    (row,) = compute_board(
        [
            so(
                "SO-1",
                "2026-01-10",
                [
                    line("A", 6, shipped=2),  # 4 left: 1 on the shelf, 3 on a PO
                    line("B", 2),  # ready
                    line("C", 3),  # nothing anywhere
                    line("D", 2, cancelled=2),
                    line("SVC", 1),
                ],
            )
        ],
        [po("PO-1", [("A", 3, 0, 0, 0)])],
        {"A": item(1), "B": item(5), "C": item(0), "D": item(5), "SVC": item(0, tracked=False)},
        TODAY,
    )
    assert row["units"] == {"total": 11, "shipped": 2, "ready": 3, "backordered": 3, "to_order": 3}
    assert row["ready_ratio"] == pytest.approx(3 / 9)
    assert row["age_days"] == 10
    assert (row["id"], row["customer"], row["date"], row["total"], row["currency"]) == (
        "id-SO-1",
        "Customer SO-1",
        "2026-01-10",
        100.0,
        "XPF",
    )


def test_age_is_never_negative():
    (row,) = compute_board([so("SO-1", "2026-02-01", [line("A", 1)])], [], {"A": item(1)}, TODAY)
    assert row["age_days"] == 0


def test_negative_stock_counts_as_zero():
    (row,) = compute_board([so("SO-1", "2026-01-03", [line("A", 1)])], [], {"A": item(-4)}, TODAY)
    assert (only_line(row)["stock_available"], only_line(row)["state"]) == (0, "to_order")


def test_po_arrived_is_the_larger_of_billed_and_received():
    (row,) = compute_board(
        [so("SO-1", "2026-01-03", [line("A", 5)])],
        [
            po("PO-1", [("A", 10, 2, 6, 1)], status="partially_billed"),  # 10 - 6 - 1 = 3 still to come
            po("PO-2", [("A", 10, 0, 0, 0)], status="billed"),
            po("PO-3", [("A", 10, 0, 0, 0)], status="cancelled"),
        ],
        {"A": item(0)},
        TODAY,
    )
    single = only_line(row)
    assert (single["state"], single["covered_by_po"], single["po_numbers"]) == ("to_order", 3, ["PO-1"])


def test_po_numbers_list_every_contributing_po_once():
    (row,) = compute_board(
        [so("SO-1", "2026-01-03", [line("A", 3)])],
        [po("PO-1", [("A", 1, 0, 0, 0), ("A", 1, 0, 0, 0)]), po("PO-2", [("A", 1, 0, 0, 0)])],
        {"A": item(0)},
        TODAY,
    )
    assert (only_line(row)["state"], only_line(row)["po_numbers"]) == ("backorder", ["PO-1", "PO-2"])


def test_orders_past_the_age_limit_are_dropped_and_take_no_stock():
    orders = [so("SO-OLD", "2025-12-01", [line("A", 1)]), so("SO-NEW", "2026-01-15", [line("A", 1)])]
    items = {"A": item(1)}
    limited = compute_board(orders, [], items, TODAY, max_age_days=10)
    assert [(r["number"], r["status"]) for r in limited] == [("SO-NEW", "to_ship")]
    unlimited = compute_board(orders, [], items, TODAY, max_age_days=0)
    assert [(r["number"], r["status"]) for r in unlimited] == [("SO-OLD", "to_ship"), ("SO-NEW", "to_order")]


def test_packed_units_are_reserved_ahead_of_older_orders():
    rows = compute_board(
        [so("SO-1", "2026-01-03", [line("A", 2)]), so("SO-2", "2026-01-05", [line("A", 2, packed=2)])],
        [],
        {"A": item(2)},
        TODAY,
    )
    older, newer = (only_line(r) for r in rows)
    assert (older["state"], older["shortfall"], older["stock_available"]) == ("to_order", 2, 0)
    assert (newer["state"], newer["packed_waiting"], newer["stock_available"]) == ("ready", 2, 2)
    assert rows[1]["packed"] == 2


def test_packed_and_invoiced_units_are_not_reserved_twice():
    rows = compute_board(
        [
            so("SO-1", "2026-01-03", [line("A", 2, packed=2, invoiced=2)]),
            so("SO-2", "2026-01-04", [line("A", 5)]),
        ],
        [],
        {"A": item(5)},
        TODAY,
    )
    assert only_line(rows[0])["state"] == "ready"
    assert (only_line(rows[1])["stock_available"], only_line(rows[1])["state"]) == (5, "ready")


def test_packed_waiting_excludes_units_already_shipped():
    (row,) = compute_board([so("SO-1", "2026-01-03", [line("A", 6, shipped=2, packed=3)])], [], {"A": item(9)}, TODAY)
    assert (only_line(row)["remaining"], only_line(row)["packed_waiting"]) == (4, 1)


def test_packages_are_carried_on_the_row():
    order = so("SO-1", "2026-01-03", [line("A", 1)])
    order["packages"] = [{"package_number": "PKG-1", "status": "not_shipped", "date": "2026-01-04", "quantity": 1}]
    (row,) = compute_board([order], [], {"A": item(1)}, TODAY)
    assert row["packages"] == [
        {"id": "", "shipment_id": "", "number": "PKG-1", "status": "not_shipped", "date": "2026-01-04"}
    ]


def test_packages_carry_their_books_ids():
    order = so("SO-1", "2026-01-03", [line("A", 1)])
    order["packages"] = [
        {"package_id": "p1", "shipment_id": "s1", "package_number": "PKG-1", "status": "shipped", "date": "2026-01-04"}
    ]
    (row,) = compute_board([order], [], {"A": item(1)}, TODAY)
    assert row["packages"] == [
        {"id": "p1", "shipment_id": "s1", "number": "PKG-1", "status": "shipped", "date": "2026-01-04"}
    ]


def test_packable_is_what_is_covered_and_not_boxed():
    # qty 5, 1 already in a parcel, shelf holds 3 -> covered 3 (1 boxed + 2), packable 2
    (row,) = compute_board([so("SO-1", "2026-01-03", [line("A", 5, packed=1)])], [], {"A": item(3)}, TODAY)
    assert (only_line(row)["packable"], only_line(row)["covered"]) == (2, 3)


def test_packable_is_zero_for_service_shipped_and_cancelled_lines():
    order = so(
        "SO-1",
        "2026-01-03",
        [line(None, 1), line("A", 2, shipped=2), line("A", 2, cancelled=2), line("A", 1)],
    )
    (row,) = compute_board([order], [], {"A": item(1)}, TODAY)
    assert [ln["packable"] for ln in row["lines"]] == [0, 0, 0, 1]


def test_unbilled_units_counts_shipped_units_no_invoice_covers():
    (row,) = compute_board([so("SO-1", "2026-01-03", [line("A", 3, shipped=2, invoiced=1)])], [], {"A": item(0)}, TODAY)
    assert row["unbilled_units"] == 1 and row["prep"] is None
    (ahead,) = compute_board(
        [so("SO-2", "2026-01-03", [line("A", 3, shipped=1, invoiced=3)])], [], {"A": item(0)}, TODAY
    )
    assert ahead["unbilled_units"] == 0


def test_units_to_invoice():
    order = so("SO-1", "2026-01-03", [line("A", 3, shipped=1), line("A", 2, shipped=2, invoiced=2), line(None, 2)])
    l1, done, s1 = (raw["line_item_id"] for raw in order["line_items"])
    assert units_to_invoice(order, service_line_ids=[s1]) == {l1: 1, s1: 2}
    assert units_to_invoice(order, {l1: 2}, [s1]) == {l1: 3, s1: 2}
    assert units_to_invoice(order, {l1: 9}) == {l1: 3} and done not in units_to_invoice(order)


def test_is_core_matches_brand_case_insensitively():
    orders = [
        so("SO-1", "2026-01-03", [line("A", 1)]),
        so("SO-2", "2026-01-04", [line("B", 1)]),  # no brand
        so("SO-3", "2026-01-05", [line("GHOST", 1)]),  # not in the catalogue
        so("SO-4", "2026-01-06", [line("SVC", 1), line("B", 1)]),  # core brand only on a service line
    ]
    items = {"A": item(9, brand="bambu lab"), "B": item(9), "SVC": item(0, brand="Bambu Lab", tracked=False)}
    rows = compute_board(orders, [], items, TODAY, core_brands=["Bambu Lab", "eSUN"])
    assert [r["is_core"] for r in rows] == [True, False, False, False]


def test_an_item_missing_from_the_catalogue_is_tracked_with_no_stock():
    (row,) = compute_board([so("SO-1", "2026-01-03", [line("GHOST", 1)])], [], {}, TODAY)
    assert (only_line(row)["state"], only_line(row)["stock_available"]) == ("to_order", 0)


def test_fractional_quantities_survive():
    rows = compute_board(
        [
            so("SO-1", "2026-01-03", [line("ROPE", 2.5)]),
            so("SO-2", "2026-01-04", [line("ROPE", 0.1), line("ROPE", 0.2)]),
        ],
        [],
        {"ROPE": item(4.5)},
        TODAY,
    )
    assert only_line(rows[0])["covered"] == 2.5
    assert rows[1]["lines"][0]["stock_available"] == 2.0
    assert rows[1]["units"]["total"] == 0.3  # not 0.30000000000000004


def test_missing_zoho_fields_do_not_raise():
    order = {
        "salesorder_id": "1",
        "salesorder_number": "SO-1",
        "date": "2026-01-03",
        "status": "open",
        "line_items": [{"line_item_id": "L", "item_id": "A", "quantity": 1}],
    }
    (row,) = compute_board([order], [{"purchaseorder_number": "PO-1", "status": "open"}], {"A": {}}, TODAY)
    assert (row["customer"], row["total"], row["currency"], row["packages"]) == ("", None, "", [])
    assert (only_line(row)["sku"], only_line(row)["name"], only_line(row)["state"]) == ("", "", "to_order")


def test_boxed_units_are_covered_even_when_books_shows_no_stock():
    """Seen on real data: a package exists, so the goods exist, yet Books'
    stock on hand is 0 (e.g. the supplier bill is not entered yet). A boxed
    line must not read "To order"."""
    (row,) = compute_board([so("SO-1", "2026-01-03", [line("A", 3, packed=3)])], [], {"A": item(0)}, TODAY)
    single = only_line(row)
    assert (single["state"], single["covered"], single["shortfall"]) == ("ready", 3, 0)
    assert row["status"] == "to_ship"


def test_only_the_unboxed_part_of_a_line_can_be_short():
    (row,) = compute_board([so("SO-1", "2026-01-03", [line("A", 5, packed=3)])], [], {"A": item(0)}, TODAY)
    single = only_line(row)
    assert (single["state"], single["covered"], single["shortfall"]) == ("to_order", 3, 2)
    assert row["units"]["ready"] == 3 and row["units"]["to_order"] == 2


def test_boxed_units_without_stock_take_nothing_from_a_later_delivery():
    """The box is already filled: it must not also eat the incoming units."""
    rows = compute_board(
        [so("SO-1", "2026-01-03", [line("A", 2, packed=2)]), so("SO-2", "2026-01-04", [line("A", 2)])],
        [po("PO-1", [("A", 2, 0, 0, 0)])],
        {"A": item(0)},
        TODAY,
    )
    assert only_line(rows[0])["state"] == "ready"
    assert (only_line(rows[1])["state"], only_line(rows[1])["covered_by_po"]) == ("backorder", 2)


def test_rows_carry_payment_contact_and_facts():
    row = compute_board([so("SO-1", "2026-01-10", [line("A", 1)], total=1000.0)], [], {"A": item(5)}, TODAY)[0]
    assert row["payment"]["state"] == "unpaid" and row["contact"] is None
    assert row["facts"]["reference"] == "" and row["customer_id"] == ""


def test_an_order_past_the_age_limit_takes_no_credit():
    old = so("SO-OLD", "2025-11-21", [line("A", 1)], total=1000.0, customer_id="c1", credit=1000)
    new = so("SO-NEW", "2026-01-15", [line("A", 1)], total=1000.0, customer_id="c1", credit=1000)
    rows = compute_board([old, new], [], {"A": item(5)}, TODAY, max_age_days=30)
    assert [r["number"] for r in rows] == ["SO-NEW"] and rows[0]["payment"]["advance"] == 1000


def test_order_row_for_a_finished_order():
    row = order_row(so("SO-9", "2026-01-02", [line("A", 2, shipped=2)], total=500.0), {}, TODAY)
    assert row["status"] == "finished" and only_line(row)["state"] == "shipped" and row["payment"]["advance"] == 0


def test_row_lists_its_picklists_and_the_units_picked_and_not_boxed():
    order = so("SO-1", "2026-01-03", [line("A", 5, packed=1), line("A", 2)])
    order["line_items"][0]["quantity_picked"] = 3
    order["picklists"] = [
        {"picklist_id": "pl1", "picklist_number": "PL-00001", "status": "completed", "date": "2026-01-10"},
        {"picklist_id": "pl2", "picklist_number": "PL-00002", "status": "yet_to_start", "date": "2026-01-12"},
    ]
    (row,) = compute_board([order], [], {"A": item(9)}, TODAY)
    assert row["picked"] == 2
    assert row["picklists"] == [
        {"id": "pl1", "number": "PL-00001", "status": "completed", "date": "2026-01-10"},
        {"id": "pl2", "number": "PL-00002", "status": "yet_to_start", "date": "2026-01-12"},
    ]
    assert picked_waiting(order) == {order["line_items"][0]["line_item_id"]: 2}
    (plain,) = compute_board([so("SO-2", "2026-01-03", [line("A", 1, packed=1)])], [], {"A": item(9)}, TODAY)
    assert (plain["picked"], plain["picklists"]) == (0, [])


def _raw_line(**kw):
    base = {
        "line_item_id": "l1",
        "item_id": "A",
        "quantity": 5,
        "quantity_shipped": 2,
        "quantity_packed": 3,
        "quantity_picked": 3,
        "quantity_invoiced": 1,
        "quantity_cancelled": 0,
        "rate": 3400,
    }
    return {**base, **kw}


def test_line_carries_rate_and_books_cumulative_floor():
    (row,) = compute_board([so("SO-1", "2026-01-03", [_raw_line()])], [], {"A": item(9)}, TODAY)
    assert (only_line(row)["rate"], only_line(row)["floor"]) == (3400.0, 3.0)


def test_floor_is_the_picked_units_when_they_exceed_packed():
    raw = _raw_line(quantity_packed=1, quantity_picked=4, quantity_invoiced=0)
    (row,) = compute_board([so("SO-1", "2026-01-03", [raw])], [], {"A": item(9)}, TODAY)
    assert only_line(row)["floor"] == 4.0


def test_row_version_and_estimable():
    def row_for(extra, line_discount=0):
        order = {**so("SO-1", "2026-01-03", [line("A", 1)]), **extra}
        order["line_items"][0]["discount"] = line_discount
        return order_row(order, {"A": item(1)}, TODAY)

    version = "2026-11-01T08:00:00-1000"
    assert row_for({"is_inclusive_tax": True, "last_modified_time": version})["version"] == version
    assert row_for({"is_inclusive_tax": True})["version"] == ""
    assert row_for({"is_inclusive_tax": True})["estimable"] is True
    assert row_for({"is_inclusive_tax": True, "shipping_charge": 500})["estimable"] is False
    assert row_for({"is_inclusive_tax": True}, line_discount=10)["estimable"] is False
    assert row_for({"is_inclusive_tax": False})["estimable"] is False
