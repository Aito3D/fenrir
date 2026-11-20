"""What printing cost per org day (filament + energy + printer wear), the cost side of the services' gross margin."""

import json
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Protocol, cast
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncConnection

from backend.app.models.calculator import CalculatorDefaults, CalculatorFilament, CalculatorPrinter
from backend.app.models.print_log import RUN_OPEN, PrintLogEntry
from backend.app.models.printer import Printer
from backend.app.models.settings import Settings
from backend.app.services.revenue.config import ORG_TIME_ZONE
from backend.app.services.revenue.dates import add_days, all_days

# Before July 2026 the print log priced filament at ~25-31 per kg (not XPF), so earlier costs are not usable.
COSTS_START = "2026-07-01"
# A run "lasting" longer than this is a reconciled abort whose end time is unknown (#2592), not machine time.
MAX_RUN_SECONDS = 72 * 3600
# Settings row holding the labour list: [{"name", "hourlyRate", "hoursPerDay", "daysPerWeek", "since"}].
LABOR_KEY = "revenue_labor"


@dataclass(frozen=True)
class MachineRate:
    watts: float
    wear_per_hour: float  # depreciation + repairs, the calculator's own formula


@dataclass(frozen=True)
class Run:
    started_at: datetime
    printer_id: int | None
    seconds: float
    grams: float | None
    cost: float | None
    energy_cost: float | None
    wear_cost: float | None


@dataclass(frozen=True)
class ProductionCosts:
    by_day: dict[str, float]
    first_day: str | None  # services sold before the print log began have no known cost


class PrinterSheet(Protocol):
    """A calculator printer: the ORM model or a Core row of it."""

    purchase_price: float
    lifetime_years: float
    daily_usage_hours: float
    power_watts: float
    repair_rate_pct: float


def machine_rate(p: PrinterSheet) -> MachineRate:
    hours = p.lifetime_years * 365 * p.daily_usage_hours
    wear = p.purchase_price * (1 + p.repair_rate_pct / 100) / hours if hours > 0 else 0.0
    return MachineRate(watts=p.power_watts, wear_per_hour=wear)


def match_rate(model: str | None, name: str, rates: dict[str, MachineRate]) -> MachineRate | None:
    """The calculator printer named like this printer's model (H2S), else whose name prefixes it (H2S01)."""
    if model and model.casefold() in rates:
        return rates[model.casefold()]
    return next(
        (r for key, r in sorted(rates.items(), key=lambda kv: -len(kv[0])) if name.casefold().startswith(key)), None
    )


def org_day(at: datetime) -> str:
    # Print log timestamps are naive UTC.
    aware = at if at.tzinfo else at.replace(tzinfo=timezone.utc)
    return aware.astimezone(ZoneInfo(ORG_TIME_ZONE)).date().isoformat()


def run_cost(run: Run, rate: MachineRate | None, tariff: float, filament_per_g: float | None) -> float:
    """Measured figures first; the calculator's rates fill what the print did not record."""
    hours = run.seconds / 3600 if run.seconds <= MAX_RUN_SECONDS else 0.0
    filament = run.cost
    if filament is None and run.grams and filament_per_g is not None:
        filament = run.grams * filament_per_g
    energy = run.energy_cost
    if energy is None and rate is not None:
        energy = rate.watts / 1000 * tariff * hours
    wear = run.wear_cost
    if wear is None and rate is not None:
        wear = rate.wear_per_hour * hours
    return (filament or 0.0) + (energy or 0.0) + (wear or 0.0)


def costs_by_day(
    runs: Iterable[Run],
    rates_by_printer: dict[int, MachineRate],
    tariff: float,
    filament_per_g: float | None,
    since: str = COSTS_START,
) -> ProductionCosts:
    by_day: dict[str, float] = {}
    for run in runs:
        day = org_day(run.started_at)
        if day < since:
            continue
        rate = rates_by_printer.get(run.printer_id) if run.printer_id is not None else None
        by_day[day] = by_day.get(day, 0.0) + run_cost(run, rate, tariff, filament_per_g)
    return ProductionCosts(by_day=by_day, first_day=min(by_day, default=None))


def labor_by_day(providers: Iterable[dict], today: str, since: str = COSTS_START) -> dict[str, float]:
    """Each provider costs rate × hours on its first `daysPerWeek` weekdays (Monday first), up to yesterday:
    today is not worked yet, like a month to date counts only the days gone."""
    end = add_days(today, -1)
    by_day: dict[str, float] = {}
    for p in providers:
        start = max(since, p.get("since") or since)
        daily = p["hourlyRate"] * p["hoursPerDay"]
        for day in all_days(start, end) if start <= end else []:
            if date.fromisoformat(day).weekday() < p["daysPerWeek"]:
                by_day[day] = by_day.get(day, 0.0) + daily
    return by_day


async def read_labor(conn: AsyncConnection) -> list[dict]:
    raw = (await conn.execute(select(Settings.value).where(Settings.key == LABOR_KEY))).scalar_one_or_none()
    return json.loads(raw) if raw else []


async def save_labor(db, providers: list[dict]) -> list[dict]:
    row = (await db.execute(select(Settings).where(Settings.key == LABOR_KEY))).scalar_one_or_none()
    value = json.dumps(providers)
    if row is None:
        db.add(Settings(key=LABOR_KEY, value=value))
    else:
        row.value = value
    await db.commit()
    return providers


async def read_production_costs(conn: AsyncConnection, today: str) -> ProductionCosts:
    sheets = (await conn.execute(select(CalculatorPrinter))).all()
    # A Core row carries the model's columns as attributes; the checker only sees Row.
    rates = {p.name.casefold(): machine_rate(cast(PrinterSheet, p)) for p in sheets}
    rates_by_printer = {
        pid: rate
        for pid, name, model in (await conn.execute(select(Printer.id, Printer.name, Printer.model))).all()
        if (rate := match_rate(model, name, rates)) is not None
    }
    tariff = (await conn.execute(select(CalculatorDefaults.electricity_tariff).limit(1))).scalar() or 0.0
    per_kg = [c for (c,) in (await conn.execute(select(CalculatorFilament.cost_per_kg))).all() if c and c > 0]
    filament_per_g = sum(per_kg) / len(per_kg) / 1000 if per_kg else None
    rows = await conn.execute(
        select(
            PrintLogEntry.started_at,
            PrintLogEntry.completed_at,
            PrintLogEntry.duration_seconds,
            PrintLogEntry.printer_id,
            PrintLogEntry.filament_used_grams,
            PrintLogEntry.cost,
            PrintLogEntry.energy_cost,
            PrintLogEntry.wear_cost,
        )
        # Core read, so the ORM's open-run filter does not apply: leave open runs out by hand.
        .where(PrintLogEntry.started_at.isnot(None), PrintLogEntry.status != RUN_OPEN)
    )
    runs = []
    for started, completed, duration, printer_id, grams, cost, energy, wear in rows.all():
        if started is None:  # excluded by the query; narrows the type
            continue
        # Same rule as the archive stats (#2592): a stored duration wins, even 0.
        if duration is not None:
            seconds = float(duration)
        elif completed is not None:
            seconds = max(0.0, (completed - started).total_seconds())
        else:
            seconds = 0.0
        runs.append(Run(started, printer_id, seconds, grams, cost, energy, wear))
    costs = costs_by_day(runs, rates_by_printer, tariff, filament_per_g)
    by_day = dict(costs.by_day)
    for day, cost in labor_by_day(await read_labor(conn), today).items():
        by_day[day] = by_day.get(day, 0.0) + cost
    return ProductionCosts(by_day=by_day, first_day=min(by_day, default=None))
