from datetime import datetime

from backend.app.models.calculator import CalculatorPrinter
from backend.app.services.revenue.production import (
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
    assert run_cost(run(7200, grams=10), RATE, 50, 3) == 250
    assert run_cost(run(7200, cost=5, energy=1, wear=2), RATE, 50, 3) == 8
    # An unknown printer still counts its filament.
    assert run_cost(run(7200, cost=5), None, 50, 3) == 5
    # A reconciled abort's months-long "duration" is not machine time.
    assert run_cost(run(90 * 86400, cost=5), RATE, 50, 3) == 5


def test_costs_by_day_buckets_on_the_org_day_from_the_start_date():
    runs = [
        run(cost=10, energy=0, wear=0, at=datetime(2026, 9, 2, 5)),  # 19:00 on 09-01 in Tahiti
        run(cost=7, energy=0, wear=0, at=datetime(2026, 6, 30, 20)),
    ]
    out = costs_by_day(runs, {1: RATE}, 50, None, since="2026-07-01")
    assert out.by_day == {"2026-09-01": 10}
    assert out.first_day == "2026-09-01"


def test_labor_costs_each_provider_on_its_working_days_from_its_start_up_to_yesterday():
    alice = {"hourlyRate": 1500, "hoursPerDay": 8, "daysPerWeek": 5, "since": None}
    bob = {"hourlyRate": 1800, "hoursPerDay": 8, "daysPerWeek": 6, "since": "2026-11-14"}
    # 2026-11-13 is a Friday; 11-14 a Saturday, 11-15 a Sunday, 11-16 a Monday.
    out = labor_by_day([alice, bob], today="2026-11-17", since="2026-11-13")
    assert out == {"2026-11-13": 12000, "2026-11-14": 14400, "2026-11-16": 12000 + 14400}
    # Today (the 17th) is not worked yet.
    assert "2026-11-17" not in out
    assert labor_by_day([{**alice, "since": "2026-12-01"}], today="2026-11-16") == {}
