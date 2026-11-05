"""Payment, contact and reference facts of the Order Board."""

import subprocess
import sys
from datetime import date
from pathlib import Path

import pytest

from backend.app.services.order_board_payment import board_payments, order_contact, order_facts, order_payment

TODAY = date(2026, 1, 20)


def inv(total, balance, *, due="2026-01-31", status="sent", n=1):
    return {
        "invoice_id": f"i{n}",
        "invoice_number": f"FAC-{n}",
        "date": "2026-01-05",
        "due_date": due,
        "total": total,
        "balance": balance,
        "status": status,
    }


def so(n, total, *, customer="c1", invoices=(), credit=0.0, fetched="2026-01-19T00:00:00+00:00"):
    return {
        "salesorder_id": f"so{n}",
        "customer_id": customer,
        "total": total,
        "invoices": list(invoices),
        "contact": {"unused_customer_credits": credit},
        "_fetched_at": fetched,
    }


@pytest.mark.parametrize(
    "order, expected",
    [
        (so(1, 1000), {"state": "unpaid", "pct": 0, "paid": 0, "rest": 1000, "left": 1000, "next_due": None}),
        (
            so(1, 128400, invoices=[inv(128400, 64200, due="2026-02-02")]),
            {
                "state": "partial",
                "pct": 50,
                "invoice_paid": 64200,
                "due": 64200,
                "overdue": 0,
                "rest": 0,
                "next_due": "2026-02-02",
            },
        ),
        (
            so(1, 714000, invoices=[inv(300000, 300000, due="2026-01-11")]),
            {"state": "unpaid", "overdue": 300000, "due": 0, "rest": 414000},
        ),
        (so(1, 4000, invoices=[inv(4000, 0, status="paid")]), {"state": "paid", "pct": 100, "left": 0}),
        (so(1, 1000, invoices=[inv(999, 0)]), {"state": "partial", "pct": 99}),  # floor, never rounds to 100
        (so(1, 20500, invoices=[inv(44939, 0)]), {"state": "paid", "pct": 100, "invoice_paid": 20500, "rest": 0}),
        (
            so(1, 20500, invoices=[inv(44939, 20000)]),
            {"state": "partial", "invoice_paid": 500, "due": 20000, "left": 20000, "rest": 0, "pct": 2},
        ),
        (so(1, 1000, invoices=[inv(5000, 5000)]), {"state": "unpaid", "invoice_paid": 0, "paid": 0, "left": 1000}),
        (
            so(1, 1000, invoices=[inv(1000, 0, status="void"), inv(1000, 1000, status="draft", n=2)]),
            {"state": "unpaid", "due": 0, "invoices": []},
        ),
    ],
)
def test_payment_cases(order, expected):
    payment = order_payment(order, TODAY)
    assert {k: payment[k] for k in expected} == expected


@pytest.mark.parametrize("total", [0, None])
def test_no_total_means_no_payment(total):
    assert order_payment(so(1, total), TODAY) is None


def test_missing_fields_do_not_raise():
    assert order_payment({"total": 100, "invoices": [{"status": "sent"}]}, TODAY)["state"] == "unpaid"


def test_advance_only_covers_what_is_not_invoiced():
    order = so(1, 612000, invoices=[inv(250000, 0), inv(180000, 180000, n=2)])
    p = order_payment(order, TODAY, credit=500000)
    assert (p["advance"], p["paid"], p["rest"], p["left"], p["pct"], p["state"]) == (
        182000,
        432000,
        0,
        180000,
        70,
        "partial",
    )


def test_credit_is_shared_oldest_order_first():  # the spec's worked case
    pays = board_payments([so(1, 339500, credit=381100), so(2, 59422, credit=381100)], TODAY)
    assert (pays["so1"]["advance"], pays["so1"]["state"]) == (339500, "paid")
    assert (pays["so2"]["advance"], pays["so2"]["pct"], pays["so2"]["state"]) == (41600, 70, "partial")


def test_credit_comes_from_the_most_recently_fetched_detail():
    pays = board_payments(
        [
            so(1, 9000, credit=0, fetched="2026-01-10T00:00:00+00:00"),
            so(2, 9000, credit=5000, fetched="2026-01-19T00:00:00+00:00"),
        ],
        TODAY,
    )
    assert pays["so1"]["advance"] == 5000 and pays["so2"]["advance"] == 0


def test_orders_without_a_customer_id_share_nothing():
    pays = board_payments([so(1, 1000, customer="", credit=1000), so(2, 1000, customer="")], TODAY)
    assert pays["so1"]["advance"] == 0 and pays["so2"]["advance"] == 0


def test_contact_and_its_phone_fallback():
    order = {
        "contact_person_details": [
            {"first_name": " Teva ", "last_name": "Marchand", "email": " t@x.example ", "phone": "", "mobile": "  "}
        ],
        "billing_address": {"phone": "40 50 22 10"},
    }
    assert order_contact(order) == {
        "name": "Teva Marchand",
        "email": "t@x.example",
        "phone": "40 50 22 10",
        "mobile": "",
    }
    assert order_contact({"contact_person_details": []}) is None


def test_facts_and_links():
    shop = order_facts(
        {
            "sales_channel_formatted": "Shopify",
            "reference_number": "1042",
            "marketplace_so_id": "5550001112223",
            "account_identifier": "123a4b-56",
            "payment_terms_label": "-",
        }
    )
    assert shop["shopify_url"] == "https://admin.shopify.com/store/123a4b-56/orders/5550001112223"
    assert shop["payment_terms"] == ""
    assert order_facts({"reference_number": "DEV26-2655", "estimate_id": "e1"})["shopify_url"] is None
    assert order_facts({})["reference"] == ""  # missing Zoho fields do not raise


def test_module_imports_without_order_board():  # order_board will import this module; no cycle allowed
    code = "import sys, backend.app.services.order_board_payment; assert 'backend.app.services.order_board' not in sys.modules"
    # From the repo root, wherever pytest was started: CI and test_backend.sh run it inside backend/.
    subprocess.run([sys.executable, "-c", code], check=True, cwd=Path(__file__).resolve().parents[3])
