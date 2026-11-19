import math
from datetime import datetime, timedelta, timezone

from backend.app.services.revenue.sync_plan import DayRow, count_legacy_days, merge_day_rows, plan_revenue_sync

T0 = datetime(2026, 10, 15, 20, 0, tzinfo=timezone.utc)  # 10:00 in Tahiti, org day 2026-10-15
H = 3600
D = 86400


def base(**over):
    return {
        "days": [], "today": "2026-10-15", "now": T0, "history_start": "2026-10-01", "format": 2,
        "live_ttl_s": 60, "recent_days": 7, "recent_ttl_s": 12 * H, **over,
    }  # fmt: skip


def plan(**over):
    return plan_revenue_sync(**base(**over))


def fetched(day, age_s, closed=True, fmt=2):
    return DayRow(day, closed, (T0 - timedelta(seconds=age_s)).isoformat(), fmt)


def days_desc(first, last):
    out, d = [], datetime.fromisoformat(first)
    while d >= datetime.fromisoformat(last):
        out.append(d.date().isoformat())
        d -= timedelta(days=1)
    return out


def test_plans_every_missing_day_from_history_start_to_today_newest_first():
    assert plan() == days_desc("2026-10-15", "2026-10-01")


def test_never_plans_a_day_after_today_even_when_the_index_carries_one():
    p = plan(days=[fetched("2026-10-16", 0, False)])
    assert "2026-10-16" not in p
    assert p[0] == "2026-10-15"


def test_a_fetched_day_with_no_sales_is_not_missing():
    days = [fetched(d, 30 if d == "2026-10-15" else H) for d in plan()]
    assert plan(days=days) == []


def test_re_plans_today_when_its_fetch_is_older_than_live_ttl_not_when_fresher():
    allr = [fetched(d, H) for d in plan()]
    fresh = [fetched(r.day, 30, False) if r.day == "2026-10-15" else r for r in allr]
    assert plan(days=fresh) == []
    stale = [fetched(r.day, 90, False) if r.day == "2026-10-15" else r for r in allr]
    assert plan(days=stale) == ["2026-10-15"]


def test_re_plans_the_previous_recent_days_days_when_older_than_recent_ttl_never_older_days():
    allr = [fetched(d, 13 * H) for d in plan()]
    assert plan(days=allr) == days_desc("2026-10-15", "2026-10-08")


def test_re_plans_a_past_day_whose_last_fetch_happened_while_it_was_still_open_whatever_its_age():
    def row(d):
        if d == "2026-10-15":
            return fetched(d, 30, False)
        return fetched(d, 30 * D, False) if d == "2026-10-01" else fetched(d, H)

    assert plan(days=[row(d) for d in plan()]) == ["2026-10-01"]


def test_missing_days_come_before_stale_ones():
    allr = [fetched(d, 13 * H) for d in plan() if d != "2026-10-03"]
    p = plan(days=allr)
    assert p[0] == "2026-10-03"
    assert p[1:] == days_desc("2026-10-15", "2026-10-08")


def test_recent_window_is_clamped_at_history_start():
    p = plan(
        history_start="2026-10-13",
        days=[fetched("2026-10-13", 13 * H), fetched("2026-10-14", 13 * H), fetched("2026-10-15", 13 * H, False)],
    )
    assert p == ["2026-10-15", "2026-10-14", "2026-10-13"]


def row(item_id="i1", **over):
    return {"item_id": item_id, "item_name": "A", "quantity_sold": 1, "amount": 10, "item": {"sku": "S"}, **over}


def group(customer, *sales):
    return {"group_name": customer, "sales": list(sales)}


def test_maps_report_rows_to_line_inputs_and_sums_duplicates_of_one_item():
    out, bad = merge_day_rows(
        [
            group(
                "",
                row("i1", quantity_sold=2, amount=100, item={"sku": "A1"}),
                row("i2", item_name="B", quantity_sold=-1, amount=-3097, item={"sku": ""}),
                row("i1", quantity_sold=1, amount=50, item={"sku": "A1"}),
            )
        ]
    )
    assert out == [
        {"itemId": "i1", "customerId": "", "name": "A", "sku": "A1", "quantity": 3, "amount": 150},
        {"itemId": "i2", "customerId": "", "name": "B", "sku": "", "quantity": -1, "amount": -3097},
    ]
    assert bad == 0


def test_merges_a_missing_quantity_and_a_nan_amount_as_0_with_no_nan():
    out, _ = merge_day_rows([group("", row(quantity_sold=None, amount=math.nan))])
    assert out == [{"itemId": "i1", "customerId": "", "name": "A", "sku": "S", "quantity": 0, "amount": 0}]


def test_defaults_a_null_name_and_a_missing_sku_to_empty_strings():
    out, _ = merge_day_rows([group("", row(item_name=None, item=None))])
    assert out[0]["name"] == ""
    assert out[0]["sku"] == ""


def test_skips_a_row_with_an_empty_item_id():
    assert merge_day_rows([group("", row(item_id=""), row(item_id=None))])[0] == []


def test_leaves_well_formed_rows_unchanged_and_does_not_count():
    out, bad = merge_day_rows([group("", row(), row(quantity_sold=2, amount=5))])
    assert out == [{"itemId": "i1", "customerId": "", "name": "A", "sku": "S", "quantity": 3, "amount": 15}]
    assert bad == 0


def test_counts_a_null_quantity_or_amount_once_storing_0_as_before():
    out, bad = merge_day_rows([group("", row(quantity_sold=None, amount=None))])
    assert out[0]["quantity"] == 0 and out[0]["amount"] == 0
    assert bad == 1


def test_counts_the_malformed_rows():
    _, bad = merge_day_rows(
        [group("", row(amount=math.nan), row(item_id=""), row(item_id="i2", item_name=None), row(item_id="i3"))]
    )
    assert bad == 3


def test_reads_a_string_amount_as_a_number_and_a_garbage_one_as_0():
    out, bad = merge_day_rows([group("", row(amount="12.5"), row("i2", amount="abc"), row("i3", amount="inf"))])
    assert [o["amount"] for o in out] == [12.5, 0, 0]
    assert bad == 2


def test_keeps_one_line_per_item_customer_and_sums_a_pair_split_across_pages():
    def r(amount):
        return row(amount=amount)

    out, _ = merge_day_rows([group("c1", r(100)), group("c2", r(50)), group("c1", r(25))])
    assert out == [
        {"itemId": "i1", "customerId": "c1", "name": "A", "sku": "S", "quantity": 2, "amount": 125},
        {"itemId": "i1", "customerId": "c2", "name": "A", "sku": "S", "quantity": 1, "amount": 50},
    ]


def test_a_group_without_a_name_has_no_customer():
    out, _ = merge_day_rows([{"sales": [row()]}, {"group_name": None, "sales": [row("i2")]}])
    assert [o["customerId"] for o in out] == ["", ""]


def aged(fmt):
    return [fetched(d, 30 if d == "2026-10-15" else 30 * D, fmt=fmt) for d in plan()]


def test_re_plans_every_closed_day_stored_under_an_older_format_newest_first_after_missing_and_stale_days():
    days = [r for r in aged(1) if r.day != "2026-10-03"]
    p = plan(days=days)
    assert p[0] == "2026-10-03"
    assert p[1:8] == days_desc("2026-10-14", "2026-10-08")
    assert p[8:] == ["2026-10-07", "2026-10-06", "2026-10-05", "2026-10-04", "2026-10-02", "2026-10-01"]
    assert len(set(p)) == len(p)


def test_nothing_to_upgrade_once_every_day_carries_the_current_format():
    assert [d for d in plan(days=aged(2)) if d < "2026-10-08"] == []


def test_count_legacy_days_counts_the_days_below_the_format():
    days = [fetched("2026-10-01", 0, fmt=1), fetched("2026-10-02", 0, fmt=2), fetched("2026-10-03", 0, fmt=3)]
    assert count_legacy_days(days, 2) == 1
