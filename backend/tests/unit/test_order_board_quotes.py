from datetime import date, timedelta

from backend.app.services.order_board_quotes import (
    draft_order_id,
    editable_here,
    held_by_orders,
    is_converted,
    is_quote_candidate,
    quote_row,
    quote_state,
)

TODAY = date(2026, 11, 21)
YESTERDAY = (TODAY - timedelta(days=1)).isoformat()
TOMORROW = (TODAY + timedelta(days=1)).isoformat()


def header(**kw):
    return {"estimate_id": "e1", "status": "sent", "date": TODAY.isoformat(), "expiry_date": TOMORROW, **kw}


def detail(**kw):
    return {
        "is_inclusive_tax": True,
        "discount_type": "item_level",
        "line_items": [{"line_item_id": "l1", "item_id": "i1", "name": "N", "sku": "S", "quantity": 2.5}],
        **kw,
    }


def test_state_other_status_is_none():
    assert quote_state(header(status="invoiced"), TODAY) is None


def test_state_sent_past_expiry_is_expired():
    assert quote_state(header(expiry_date=YESTERDAY), TODAY) == "expired"


def test_state_accepted_past_expiry_stays_accepted():
    assert quote_state(header(status="accepted", expiry_date=YESTERDAY), TODAY) == "accepted"
    assert quote_state(header(status="expired"), TODAY) == "expired"
    assert quote_state(header(), TODAY) == "sent"


def test_is_converted():
    assert not is_converted({"salesorders": [{"salesorder_order_status": "draft"}]})
    assert is_converted({"salesorders": [{"salesorder_order_status": "open"}]})
    assert is_converted({"salesorders": [{"salesorder_id": "1"}]})
    assert is_converted({"invoice_ids": ["1"]})
    assert not is_converted({})


def test_draft_order_id():
    d = {
        "salesorders": [
            {"salesorder_id": "a", "salesorder_order_status": "open"},
            {"salesorder_id": "b", "salesorder_order_status": "draft"},
        ]
    }
    assert draft_order_id(d) == "b"
    assert draft_order_id({}) is None


def test_candidate_rules():
    assert is_quote_candidate(header(), TODAY, 0, set())
    assert not is_quote_candidate(header(), TODAY, 0, {"e1"})
    assert not is_quote_candidate(header(status="invoiced"), TODAY, 0, set())
    old = header(date=(TODAY - timedelta(days=400)).isoformat())
    assert not is_quote_candidate(old, TODAY, 365, set())
    assert is_quote_candidate(old, TODAY, 0, set())


def test_editable_here():
    assert editable_here(detail())
    assert not editable_here(detail(line_items=[{"item_id": "i1"}, {"item_id": ""}]))


def test_editable_here_refuses_an_item_on_two_lines():
    assert not editable_here(detail(line_items=[{"item_id": "i1"}, {"item_id": "i1"}]))


def test_editable_here_needs_inclusive_tax_and_item_level_discount():
    assert not editable_here(detail(is_inclusive_tax=False))
    assert not editable_here(detail(is_inclusive_tax=None))
    assert not editable_here(detail(discount_type="entity_level"))


def test_quote_row_accepted_hidden_without_detail_or_when_converted():
    h = header(status="accepted")
    assert quote_row(h, None, {}, {}, TODAY, set()) is None
    assert quote_row(h, detail(invoice_ids=["1"]), {}, {}, TODAY, set()) is None
    assert quote_row(h, detail(), {}, {}, TODAY, set())["state"] == "accepted"


def test_quote_row_without_detail():
    row = quote_row(header(total=10), None, {}, {}, TODAY, set())
    assert row["lines"] is None and row["is_core"] is None and row["editable"] is False
    assert row["id"] == "e1" and row["total"] == 10.0


def test_quote_row_prefers_detail_and_flags():
    d = detail(reference_number="R", salesorders=[{"salesorder_id": "so", "salesorder_order_status": "draft"}])
    row = quote_row(header(reference_number="old"), d, {}, {}, TODAY, set())
    assert row["reference"] == "R" and row["has_draft_order"] and row["editable"]


def test_quote_row_available_and_core():
    items = {"i1": {"stock_on_hand": 20, "brand": "Acme"}}
    row = quote_row(header(), detail(), items, {"i1": 6}, TODAY, {"acme"})
    assert row["lines"][0]["available"] == 14
    assert row["is_core"] is True
    assert row["lines"][0]["quantity"] == 2.5
    low = quote_row(header(), detail(), {"i1": {"stock_on_hand": 2}}, {"i1": 6}, TODAY, set())
    assert low["lines"][0]["available"] == 0 and low["is_core"] is False
    assert quote_row(header(), detail(), {}, {}, TODAY, set())["lines"][0]["available"] is None


def test_held_by_orders():
    rows = [
        {"lines": [{"item_id": "i1", "covered": 2}, {"item_id": "", "covered": 9}]},
        {"lines": [{"item_id": "i1", "covered": 1.5}]},
    ]
    assert held_by_orders(rows) == {"i1": 3.5}
