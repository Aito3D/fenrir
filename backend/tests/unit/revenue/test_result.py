from backend.app.services.revenue.result import build_result


def mb(month, ht, items=0, filament=0, labor=0):
    return {"key": month, "ht": ht, "costParts": {"items": items, "filament": filament, "labor": labor}}


def days(amounts, month="2026-11"):
    return [{"start": f"{month}-{i + 1:02d}", "ht": a} for i, a in enumerate(amounts)]


def test_closed_month_result_takes_every_cost_off_the_revenue():
    r = build_result(
        [mb("2026-10", 1_000_000, items=300_000, filament=100_000, labor=200_000), mb("2026-11", 0)],
        [],
        150_000,
        "2026-11-01",
    )
    assert r["fixedMonthly"] == 150_000
    assert r["months"][0] == {
        "month": "2026-10",
        "ht": 1_000_000,
        "variable": 400_000,
        "labor": 200_000,
        "fixed": 150_000,
        "result": 250_000,
    }


def test_current_month_fixed_costs_count_only_the_days_gone():
    r = build_result([mb("2026-11", 0)], [], 120_000, "2026-11-11")
    assert r["months"][0]["fixed"] == 40_000
    assert r["months"][0]["result"] == -40_000


def test_break_even_amount_and_the_day_it_was_crossed():
    # 10 days gone at 100 000 a day, 40 % variable, 60 000 of labour so far, 120 000 of fixed costs a month:
    # charges = 120 000 + 60 000 / 10 × 30 = 300 000; rate 0.6; amount 500 000, crossed on the 5th.
    r = build_result(
        [mb("2026-11", 1_000_000, items=400_000, labor=60_000)], days([100_000] * 10), 120_000, "2026-11-11"
    )
    assert r["breakEven"] == {"amount": 500_000, "reached": 2.0, "day": "2026-11-05", "projected": False}


def test_break_even_not_reached_yet_is_projected_at_the_current_pace():
    r = build_result([mb("2026-11", 200_000, items=80_000, labor=60_000)], days([20_000] * 10), 120_000, "2026-11-11")
    assert r["breakEven"] == {"amount": 500_000, "reached": 0.4, "day": "2026-11-25", "projected": True}


def test_a_projection_past_the_end_of_the_month_gives_no_day():
    r = build_result([mb("2026-11", 100_000, items=40_000, labor=60_000)], days([10_000] * 10), 120_000, "2026-11-11")
    assert r["breakEven"] == {"amount": 500_000, "reached": 0.2, "day": None, "projected": True}


def test_a_month_without_sales_uses_the_rate_of_the_three_closed_months_before():
    closed = [mb(m, 1_000_000, items=500_000) for m in ("2026-08", "2026-09", "2026-10")]
    r = build_result([*closed, mb("2026-11", 0)], days([0] * 10), 120_000, "2026-11-11")
    assert r["breakEven"] == {"amount": 240_000, "reached": 0.0, "day": None, "projected": True}


def test_first_day_of_the_month_takes_last_months_labour():
    r = build_result(
        [mb("2026-10", 1_000_000, items=500_000, labor=90_000), mb("2026-11", 0)], [], 110_000, "2026-11-01"
    )
    assert r["breakEven"]["amount"] == 400_000


def test_no_usable_rate_gives_no_break_even():
    assert build_result([mb("2026-11", 0)], [], 120_000, "2026-11-11")["breakEven"] is None
    # Costs above the revenue: no amount of sales at that rate ever breaks even.
    losing = build_result([mb("2026-11", 100_000, items=150_000)], days([10_000] * 10), 120_000, "2026-11-11")
    assert losing["breakEven"] is None


def test_no_charges_gives_no_break_even():
    assert (
        build_result([mb("2026-11", 100_000, items=40_000)], days([10_000] * 10), 0, "2026-11-11")["breakEven"] is None
    )
