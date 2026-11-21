"""The cash read model's pure parts: who counts in full, an invoice's 3D share, and the two aggregations."""

from backend.app.services.revenue import cash
from backend.app.services.revenue.scope import RevenueDecision, ScopeItem
from backend.app.services.revenue.series import RevenueLine

ITEMS = {
    "pla": ScopeItem("pla", "PLA", nature="Filaments"),
    "kayak": ScopeItem("kayak", "Kayak", nature="Boats"),
    "x1": ScopeItem("x1", "X1", brand="Bambu Lab", tax_percentage=16),
}


def pay(pid, customer, date, amount, applications=None):
    return {
        "paymentId": pid,
        "customerId": customer,
        "date": date,
        "amount": amount,
        "unapplied": 0,
        "applications": applications,
    }


def inv(iid, customer, balance, share=None, due="2026-11-30", date="2026-11-01", number=None, name="Client"):
    return {
        "invoiceId": iid,
        "number": number or f"INV-{iid}",
        "customerId": customer,
        "customerName": name,
        "date": date,
        "dueDate": due,
        "total": balance,
        "balance": balance,
        "share": share,
    }


def test_months_and_cursor_start():
    assert cash.last_months("2026-11-20", 3) == ["2026-09", "2026-10", "2026-11"]
    assert cash.last_months("2026-02-01")[0] == "2025-03"
    # 1 Nov 2025 00:00 in Tahiti (UTC-10) is 10:00 UTC, in Books' spelling
    assert cash.cursor_start("2026-11-20") == "2025-11-01T10:00:00+0000"


def test_classify_customers_from_the_whole_cache_with_decisions():
    pairs = [("a", "pla"), ("a", "x1"), ("b", "kayak"), ("c", "pla"), ("c", "kayak"), ("d", "kayak"), ("", "pla")]
    decisions = [RevenueDecision("kayak", True, "t")]
    assert cash.classify_customers(pairs[:5], ITEMS, []) == {"a": "only3d", "b": "none", "c": "mixed"}
    assert cash.classify_customers([("d", "kayak")], ITEMS, decisions) == {"d": "only3d"}
    assert cash.classify_customers([("e", "unknown-item")], ITEMS, []) == {"e": "none"}


def test_invoice_share_counts_lines_without_item_only_in_the_total():
    lines = [
        {"item_id": "pla", "item_total": 300},
        {"item_id": "kayak", "item_total": "500"},
        {"item_id": "", "item_total": 200},  # shipping, a free-text line
    ]
    assert cash.invoice_share(lines, ITEMS, []) == 0.3
    assert cash.invoice_share([], ITEMS, []) == 0
    assert cash.invoice_share([{"item_id": "pla", "item_total": 0}], ITEMS, []) == 0


def test_detail_queue_only_unsettled_customers_newest_first_payments_then_invoices():
    classes = {"only": "only3d", "none": "none", "mix": "mixed"}
    payments = [
        pay("p-old", "mix", "2026-01-05", 100),
        pay("p-new", "unknown", "2026-10-05", 100),
        pay("p-done", "mix", "2026-09-01", 100, [{"invoiceId": "i-paid", "amount": 100}]),
        pay("p-before-window", "mix", "2025-10-01", 100),
        pay("p-only", "only", "2026-10-06", 100),
        pay("p-none", "none", "2026-10-06", 100),
    ]
    invoices = [
        inv("i-open", "mix", 50, date="2026-08-01"),
        inv("i-known", "mix", 50, share=0.5),
        inv("i-only", "only", 50),
        inv("i-zero", "mix", 0),
    ]
    payment_ids, invoice_ids = cash.detail_queue(payments, invoices, classes, "2025-12-01")
    assert payment_ids == ["p-new", "p-old"]
    assert invoice_ids == ["i-paid", "i-open"]


def test_collected_by_month_shares_and_the_unknown_bucket():
    classes = {"only": "only3d", "none": "none", "mix": "mixed"}
    shares = {"i1": 0.5, "i2": None}
    payments = [
        pay("a", "only", "2026-10-03", 1000),
        pay("b", "none", "2026-10-04", 700),
        pay("c", "mix", "2026-10-05", 900, [{"invoiceId": "i1", "amount": 400}, {"invoiceId": "i2", "amount": 300}]),
        pay("d", "mix", "2026-11-01", 250),  # applications not read yet
        pay("e", "only", "2026-08-01", 5000),  # outside the months
    ]
    out, known, unknown = cash.collected_by_month(payments, shares, classes, ["2026-10", "2026-11"])
    # 1000 + 400 × 0.5; unknown: 300 (share unknown) + 200 unapplied
    assert out == {"2026-10": {"collected": 1200, "unknown": 500}, "2026-11": {"collected": 0, "unknown": 250}}
    assert (known, unknown) == (1000 + 700 + 400, 300 + 200 + 250)


def test_outstanding_applies_the_share_splits_overdue_and_ranks_the_late():
    classes = {"only": "only3d", "none": "none", "mix": "mixed"}
    invoices = [
        inv("1", "only", 1000, due="2026-11-10", name="A"),
        inv("2", "none", 800, due="2026-10-01"),
        inv("3", "mix", 600, share=0.5, due="2026-11-01", name="C"),
        inv("4", "mix", 400, due="2026-01-01"),  # share unknown
        inv("5", "only", 0, due="2026-01-01"),  # paid
        inv("6", "only", 200, due="2026-12-01"),
    ]
    owed, top, known = cash.outstanding(invoices, classes, "2026-11-20")
    assert owed == {
        "total": 1500,
        "overdue": 1300,
        "invoices": 4,
        "unknown": 400,
        "dueSoon": 200,
        "lateRecent": 1300,
        "lateOld": 0,
    }
    assert top == [
        {"number": "INV-1", "customerName": "A", "dueDate": "2026-11-10", "daysOverdue": 10, "balance": 1000},
        {"number": "INV-3", "customerName": "C", "dueDate": "2026-11-01", "daysOverdue": 19, "balance": 300},
    ]
    assert known == 1000 + 800 + 600 + 200


def test_invoiced_ttc_by_month_counts_in_scope_lines_with_tax():
    lines = [
        RevenueLine("2026-10-02", "x1", "a", "X1", "", 1, 1000),
        RevenueLine("2026-10-03", "kayak", "a", "Kayak", "", 1, 9999),
        RevenueLine("2026-11-01", "pla", "a", "PLA", "", 1, 100, tax_percentage=13),
    ]
    got = cash.invoiced_ttc_by_month(lines, ITEMS, [])
    assert round(got["2026-10"], 6) == 1160 and round(got["2026-11"], 6) == 113


def test_build_cash_shape_rounds_and_coverage():
    body = cash.build_cash(
        payments=[pay("a", "mix", "2026-11-02", 100.4, [{"invoiceId": "i", "amount": 100.4}])],
        invoices=[inv("i", "mix", 50, share=0.5, due="2026-11-01")],
        classes={"mix": "mixed"},
        invoiced_ttc={"2026-11": 1234.5},
        months=["2026-10", "2026-11"],
        today="2026-11-20",
        synced_at=None,
        error=None,
    )
    assert body["months"] == [
        {"month": "2026-10", "invoicedTtc": 0, "collected": 0, "collectedUnknown": 0},
        {"month": "2026-11", "invoicedTtc": 1235, "collected": 50, "collectedUnknown": 0},
    ]
    assert {k: body["outstanding"][k] for k in ("total", "overdue", "invoices", "unknown")} == {
        "total": 25,
        "overdue": 25,
        "invoices": 1,
        "unknown": 0,
    }
    assert body["coverage"] == {"known": 150, "unknown": 0}
    assert [r["number"] for r in body["topOverdue"]] == ["INV-i"]


TODAY = "2026-11-20"
ALL_3D = {"c1": cash.ONLY_3D, "c2": cash.ONLY_3D}


def _aged():
    return [
        inv("a", "c1", 100, due="2026-12-01"),
        inv("b", "c1", 200, due="2026-11-05"),
        inv("c", "c1", 300, due="2026-10-01"),
        inv("d", "c1", 400, due="2026-09-01"),
        inv("e", "c1", 500, due="2026-06-01"),
        inv("f", "c1", 50, due=""),
    ]


def test_aging_puts_each_balance_in_its_overdue_bucket():
    assert cash.aging(_aged(), ALL_3D, TODAY)["buckets"] == {
        "notDue": 150,
        "d30": 200,
        "d60": 300,
        "d90": 400,
        "over": 500,
    }


def test_aging_applies_the_share_and_leaves_unknown_and_non_3d_out():
    invoices = [
        inv("a", "mixed", 1000, share=0.5, due="2026-11-05"),
        inv("b", "mixed", 700, share=None, due="2026-11-05"),
        inv("c", "sail", 900, due="2026-11-05"),
    ]
    out = cash.aging(invoices, {"mixed": cash.MIXED, "sail": cash.NO_3D}, TODAY)
    assert out["buckets"] == {"notDue": 0, "d30": 500, "d60": 0, "d90": 0, "over": 0}
    assert [r["balance"] for r in out["byCustomer"]] == [500]


def test_aging_buckets_sum_to_the_outstanding_total():
    owed, _top, _known = cash.outstanding(_aged(), ALL_3D, TODAY)
    assert sum(cash.aging(_aged(), ALL_3D, TODAY)["buckets"].values()) == owed["total"]


def test_aging_by_customer_ranks_by_overdue_and_keeps_ten():
    invoices = [
        inv("a", "c1", 100, due="2026-11-10", name="Alice"),
        inv("b", "c1", 300, due="2026-10-01", name="Alice"),
        inv("c", "c2", 900, due="2026-11-15", name="Bob"),
        inv("d", "c2", 5000, due="2026-12-15", name="Bob"),
    ]
    rows = cash.aging(invoices, ALL_3D, TODAY)["byCustomer"]
    assert rows == [
        {"customerName": "Bob", "balance": 5900, "overdue": 900, "oldestDays": 5},
        {"customerName": "Alice", "balance": 400, "overdue": 400, "oldestDays": 50},
    ]
    many = [inv(f"i{n}", f"k{n}", 10 + n, due="2026-11-01") for n in range(12)]
    assert len(cash.aging(many, {f"k{n}": cash.ONLY_3D for n in range(12)}, TODAY)["byCustomer"]) == 10


def test_dso_is_outstanding_over_ninety_days_of_invoicing():
    assert cash.dso(300_000, 900_000) == 30
    assert cash.dso(100, 0) is None


def test_forecast_spreads_open_balances_by_due_date_and_adds_the_order_book_to_the_first_window():
    invoices = [
        inv("a", "c1", 100, due="2026-11-30"),
        inv("b", "c1", 200, due="2026-11-05"),
        inv("c", "c1", 300, due="2027-01-04"),
        inv("d", "c1", 400, due="2027-02-08"),
        inv("e", "c1", 500, due="2027-03-20"),
        inv("f", "c1", 60, due=""),
    ]
    assert cash.forecast(invoices, ALL_3D, TODAY, 1000) == [
        {"window": "d30", "invoices": 360, "orders": 1000},
        {"window": "d60", "invoices": 300, "orders": 0},
        {"window": "d90", "invoices": 400, "orders": 0},
    ]


def test_accepted_open_is_what_accepted_quotes_still_have_to_bring_in():
    from types import SimpleNamespace as C

    cards = [
        C(quote_status="accepted", quote_invoiced=False, quote_total=1000.0, retainer_paid_total=300.0),
        C(quote_status="accepted", quote_invoiced=False, quote_total=200.0, retainer_paid_total=500.0),
        C(quote_status="accepted", quote_invoiced=False, quote_total=None, retainer_paid_total=None),
        C(quote_status="accepted", quote_invoiced=True, quote_total=900.0, retainer_paid_total=0.0),
        C(quote_status="sent", quote_invoiced=False, quote_total=800.0, retainer_paid_total=0.0),
    ]
    assert cash.accepted_open(cards) == 700


def test_outstanding_forecast_buckets_due_soon_young_and_stale_overdue():
    invoices = [
        inv("1", "only", 100, due="2026-11-20"),  # due today
        inv("2", "only", 200, due="2026-12-20"),  # 30 days out
        inv("3", "only", 400, due="2026-12-21"),  # past the window
        inv("4", "only", 800, due=None),  # due on receipt
        inv("5", "only", 1600, due="2026-08-22"),  # 90 days late
        inv("6", "only", 3200, due="2026-08-21"),  # 91 days late
    ]
    owed, _top, _known = cash.outstanding(invoices, {"only": "only3d"}, "2026-11-20")
    assert (owed["dueSoon"], owed["lateRecent"], owed["lateOld"]) == (1100, 1600, 3200)
