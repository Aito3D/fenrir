from datetime import datetime

from backend.app.models.calculator import CalculatorPrinter
from backend.app.services.revenue.production import (
    FilamentPrices,
    MachineRate,
    Run,
    costs_by_day,
    labor_by_day,
    machine_rate,
    match_rate,
    run_cost,
)

RATE = MachineRate(watts=200, wear_per_hour=100)


def run(seconds=3600, grams=None, cost=None, energy=None, wear=None, at=datetime(2026, 9, 1, 20), printer=1):
    return Run(at, printer, seconds, grams, cost, energy, wear)


def test_machine_rate_is_depreciation_plus_repairs_per_lifetime_hour():
    p = CalculatorPrinter(
        purchase_price=1825, lifetime_years=1, daily_usage_hours=5, power_watts=150, repair_rate_pct=20
    )
    assert machine_rate(p) == MachineRate(watts=150, wear_per_hour=1.2)


def test_match_rate_prefers_the_model_then_the_longest_name_prefix():
    rates = {"h2s": RATE, "x1": MachineRate(1, 1), "x1c": MachineRate(2, 2)}
    assert match_rate("H2S", "Shop 1", rates) is RATE
    assert match_rate(None, "X1C04", rates) == MachineRate(2, 2)
    assert match_rate("A1", "A101", rates) is None


def test_run_cost_uses_measured_figures_and_estimates_the_rest():
    # 2 h: energy 0.2 kW × 50 × 2 = 20, wear 200, filament 10 g × 3 = 30.
    assert run_cost(run(7200, grams=10), RATE, 50, 3) == {"filament": 30, "energy": 20, "wear": 200}
    assert run_cost(run(7200, cost=5, energy=1, wear=2), RATE, 50, 3) == {"filament": 5, "energy": 1, "wear": 2}
    # An unknown printer still counts its filament.
    assert run_cost(run(7200, cost=5), None, 50, 3) == {"filament": 5, "energy": 0, "wear": 0}
    # Known grams are priced at the purchase price, whatever the print recorded.
    assert run_cost(run(7200, grams=10, cost=99), None, 50, 3)["filament"] == 30
    # A reconciled abort's months-long "duration" is not machine time.
    assert run_cost(run(90 * 86400, cost=5), RATE, 50, 3) == {"filament": 5, "energy": 0, "wear": 0}


def test_costs_by_day_buckets_on_the_org_day_from_the_start_date():
    runs = [
        run(cost=10, energy=0, wear=0, at=datetime(2026, 9, 2, 5)),  # 19:00 on 09-01 in Tahiti
        run(cost=7, energy=0, wear=0, at=datetime(2026, 6, 30, 20)),
    ]
    out = costs_by_day(runs, {1: RATE}, 50, FilamentPrices([]), since="2026-07-01")
    assert out.by_day == {"2026-09-01": {"filament": 10, "energy": 0, "wear": 0}}
    assert out.first_day == "2026-09-01"


def test_costs_by_day_sums_printer_hours_per_org_day_and_skips_reconciled_aborts():
    runs = [
        run(seconds=5400, at=datetime(2026, 9, 2, 5)),
        run(seconds=1800, at=datetime(2026, 9, 2, 6)),
        run(seconds=73 * 3600, at=datetime(2026, 9, 2, 7)),
        run(seconds=3600, at=datetime(2026, 6, 30, 20)),
    ]
    out = costs_by_day(runs, {1: RATE}, 50, FilamentPrices([]), since="2026-07-01")
    assert out.hours_by_day == {"2026-09-01": 2.0}


def test_labor_costs_each_provider_on_its_working_days_from_its_start_up_to_yesterday():
    alice = {"hourlyRate": 1500, "hoursPerDay": 8, "daysPerWeek": 5, "since": None}
    bob = {"hourlyRate": 1800, "hoursPerDay": 8, "daysPerWeek": 6, "since": "2026-11-14"}
    # 2026-11-13 is a Friday; 11-14 a Saturday, 11-15 a Sunday, 11-16 a Monday.
    out = labor_by_day([alice, bob], today="2026-11-17", since="2026-11-13")
    assert out == {"2026-11-13": 12000, "2026-11-14": 14400, "2026-11-16": 12000 + 14400}
    # Today (the 17th) is not worked yet.
    assert "2026-11-17" not in out
    assert labor_by_day([{**alice, "since": "2026-12-01"}], today="2026-11-16") == {}


def test_filament_prices_take_the_cheapest_sheet_of_the_material_then_a_named_sheet_then_the_median():
    prices = FilamentPrices(
        [("PLA", 2000), ("PETG", 2200), ("PETG", 2400), ("TPU 95A", 3000), ("PPS-CF", 27000), ("", 9), ("ASA", 0)]
    )
    assert prices.per_g("pla") == 2.0
    assert prices.per_g("PETG") == 2.2  # the cheapest of the two PETG sheets
    assert prices.per_g("TPU") == 3.0
    assert prices.per_g("PETG, PLA") == 2.2  # the first of a mix
    # Unknown or missing: the median (2400), not the mean the PPS-CF would drag up.
    assert prices.per_g("PA-CF") == prices.per_g(None) == 2.4
    assert FilamentPrices([]).per_g("PLA") is None
