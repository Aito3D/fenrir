"""What printing cost per org day (filament + energy + printer wear), the cost side of the services' gross margin."""

import json
import statistics
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Protocol, TypeVar, cast
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncConnection

from backend.app.models.calculator import CalculatorDefaults, CalculatorFilament, CalculatorPrinter
from backend.app.models.print_log import RUN_OPEN, PrintLogEntry
from backend.app.models.printer import Printer
from backend.app.models.settings import Settings
from backend.app.services.revenue.config import ORG_TIME_ZONE
from backend.app.services.revenue.dates import _org_day_of, add_days, all_days, days_in_month
from backend.app.services.revenue.fixed_accounts import Charge, charges_by_month

_Json = TypeVar("_Json", list[dict], dict)

# Before July 2026 the print log priced filament at ~25-31 per kg (not XPF), so earlier costs are not usable.
COSTS_START = "2026-07-01"
# A run "lasting" longer than this is a reconciled abort whose end time is unknown (#2592), not machine time.
MAX_RUN_SECONDS = 72 * 3600
# Settings row holding the labour list: [{"name", "hourlyRate", "hoursPerDay", "daysPerWeek", "since"}].
LABOR_KEY = "revenue_labor"
# Settings row: {"assets": [{"id", "number", "name", "type", "cost", "start", "months", "status"}], "selected": [id],
# "readAt"}: Zoho's fixed assets as last read, and the ones the operator charges to 3D printing.
DEPRECIATION_KEY = "revenue_depreciation"
# Settings row: {account id: {"percent", "type", "goodsShare"}}: the share of each Zoho class 6 account that is 3D's.
FIXED_ACCOUNTS_KEY = "revenue_fixed_accounts"
# Settings row: {"accounts": [{"id", "code", "name", "active"}], "months": {"YYYY-MM": {account id: total}},
# "readAt", "currentReadAt"}: Zoho's expense accounts and their monthly totals as last read. A row of its own, so a
# refresh and a save of the shares never overwrite each other.
FIXED_ACCOUNTS_CACHE_KEY = "revenue_fixed_accounts_cache"


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
    material: str | None = None


PARTS = ("filament", "energy", "wear", "labor")


@dataclass(frozen=True)
class ProductionCosts:
    by_day: dict[str, dict[str, float]]  # day -> part (PARTS) -> cost
    first_day: str | None  # services sold before the print log began have no known cost
    hours_by_day: dict[str, float] = field(default_factory=dict)  # day -> printer hours of the runs started that day
    # day -> the goods' part of that day's `fixed` and `fixedEstimated` (already inside `by_day`)
    fixed_goods_by_day: dict[str, dict[str, float]] = field(default_factory=dict)


def _add(by_day: dict[str, dict[str, float]], day: str, parts: dict[str, float]) -> None:
    acc = by_day.setdefault(day, {})
    for part, cost in parts.items():
        acc[part] = acc.get(part, 0.0) + cost


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
    return _org_day_of(aware)


class FilamentPrices:
    """The calculator's purchase price per kg (no margin) by material, for pricing a print's grams.

    The print log keeps a print's material, not its spool's brand: a material with several sheets
    (SUNLU and Polymaker PETG) takes the cheapest, the brand the shop prints most."""

    def __init__(self, sheets: Iterable[tuple[str, float]]):
        by: dict[str, list[float]] = {}
        for material, per_kg in sheets:
            if material and per_kg and per_kg > 0:
                by.setdefault(material.strip().casefold(), []).append(per_kg)
        self.by_material = {m: min(v) for m, v in by.items()}
        every = [p for v in by.values() for p in v]
        # The median, not the mean: a few technical filaments (PPS-CF, PAHT-CF) cost ten times PLA.
        self.fallback = statistics.median(every) if every else None

    def per_g(self, material: str | None) -> float | None:
        """Exact material, else a sheet named after it (TPU → TPU 95A), else the median; the first of a mix."""
        key = (material or "").split(",")[0].strip().casefold()
        price = self.by_material.get(key) if key else None
        if price is None and key:
            near = [p for m, p in self.by_material.items() if m.startswith(key)]
            price = min(near) if near else None
        price = price if price is not None else self.fallback
        return price / 1000 if price is not None else None


def run_cost(run: Run, rate: MachineRate | None, tariff: float, filament_per_g: float | None) -> dict[str, float]:
    """Filament at the calculator's purchase price when the grams are known, else the cost the print recorded;
    energy and wear measured first, the calculator's machine rates filling what the print did not record."""
    hours = run.seconds / 3600 if run.seconds <= MAX_RUN_SECONDS else 0.0
    filament = run.cost
    if run.grams and filament_per_g is not None:
        filament = run.grams * filament_per_g
    energy = run.energy_cost
    if energy is None and rate is not None:
        energy = rate.watts / 1000 * tariff * hours
    wear = run.wear_cost
    if wear is None and rate is not None:
        wear = rate.wear_per_hour * hours
    return {"filament": filament or 0.0, "energy": energy or 0.0, "wear": wear or 0.0}


def costs_by_day(
    runs: Iterable[Run],
    rates_by_printer: dict[int, MachineRate],
    tariff: float,
    prices: FilamentPrices,
    since: str = COSTS_START,
) -> ProductionCosts:
    by_day: dict[str, dict[str, float]] = {}
    hours: dict[str, float] = {}
    for run in runs:
        day = org_day(run.started_at)
        if day < since:
            continue
        if run.seconds <= MAX_RUN_SECONDS:
            hours[day] = hours.get(day, 0.0) + run.seconds / 3600
        rate = rates_by_printer.get(run.printer_id) if run.printer_id is not None else None
        _add(by_day, day, run_cost(run, rate, tariff, prices.per_g(run.material)))
    return ProductionCosts(by_day=by_day, first_day=min(by_day, default=None), hours_by_day=hours)


WORK_START_H, WORK_END_H = 8, 17


def day_shares(now: datetime) -> tuple[float, float]:
    """(share of the org day gone, share of its 8h-17h working window gone), to the minute."""
    local = now.astimezone(ZoneInfo(ORG_TIME_ZONE))
    hours = local.hour + local.minute / 60
    return hours / 24, min(max((hours - WORK_START_H) / (WORK_END_H - WORK_START_H), 0.0), 1.0)


def labor_by_day(
    providers: Iterable[dict], today: str, since: str = COSTS_START, today_share: float = 0.0
) -> dict[str, float]:
    """Each provider costs rate × hours on its first `daysPerWeek` weekdays (Monday first), up to yesterday, plus
    `today_share` of today: the part of the working window already gone."""
    by_day: dict[str, float] = {}
    for p in providers:
        start = max(since, p.get("since") or since)
        daily = p["hourlyRate"] * p["hoursPerDay"]
        for day in all_days(start, today) if start <= today else []:
            cost = daily * (today_share if day == today else 1.0)
            if cost and date.fromisoformat(day).weekday() < p["daysPerWeek"]:
                by_day[day] = by_day.get(day, 0.0) + cost
    return by_day


def fixed_by_day(
    charges: dict[str, Charge], today: str, since: str = COSTS_START, today_share: float = 0.0
) -> tuple[dict[str, dict[str, float]], dict[str, dict[str, float]]]:
    """Each month's fixed charge spread evenly over its days: whole days up to yesterday, then `today_share` of
    today, so it grows by the minute. Two maps, day -> {"fixed": entered in the books, "fixedEstimated": usual
    charges the running month still misses}: every charge, and the goods' part of it."""
    every: dict[str, dict[str, float]] = {}
    goods: dict[str, dict[str, float]] = {}
    for day in all_days(since, today):
        charge = charges.get(day[:7])
        if charge is None:
            continue
        share = (today_share if day == today else 1.0) / days_in_month(int(day[:4]), int(day[5:7]))
        for by_day, real, estimated in (
            (every, charge.real, charge.estimated),
            (goods, charge.real_goods, charge.est_goods),
        ):
            parts = {k: v * share for k, v in (("fixed", real), ("fixedEstimated", estimated)) if v * share}
            if parts:
                by_day[day] = parts
    return every, goods


def _life_end(start: str, months: int) -> str:
    """The first day after an asset's life: `start` moved `months` calendar months on, the day clamped to the month."""
    year, month0 = divmod(int(start[:4]) * 12 + int(start[5:7]) - 1 + months, 12)
    return f"{year:04d}-{month0 + 1:02d}-{min(int(start[8:10]), days_in_month(year, month0 + 1)):02d}"


def depreciation_by_day(
    assets: Iterable[dict], today: str, since: str = COSTS_START, today_share: float = 0.0
) -> dict[str, float]:
    """Straight-line depreciation with no residual value: each asset costs `cost / months` a month over its life,
    spread over the month's days like the fixed charges, today counting for `today_share`."""
    by_day: dict[str, float] = {}
    for a in assets:
        if not (a.get("cost") and a.get("months") and a.get("start")):
            continue
        monthly = a["cost"] / a["months"]
        first, last = max(since, a["start"]), min(today, add_days(_life_end(a["start"], a["months"]), -1))
        for day in all_days(first, last) if first <= last else []:
            cost = monthly / days_in_month(int(day[:4]), int(day[5:7])) * (today_share if day == today else 1.0)
            if cost:
                by_day[day] = by_day.get(day, 0.0) + cost
    return by_day


def selected_assets(dep: dict) -> list[dict]:
    """The assets the operator switched on, as long as Zoho still calls them active."""
    chosen = set(dep["selected"])
    return [a for a in dep["assets"] if a["id"] in chosen and a["status"] == "active"]


async def _read_json(conn: AsyncConnection, key: str) -> list[dict]:
    raw = (await conn.execute(select(Settings.value).where(Settings.key == key))).scalar_one_or_none()
    return json.loads(raw) if raw else []


async def _save_json(db, key: str, rows: _Json) -> _Json:
    row = (await db.execute(select(Settings).where(Settings.key == key))).scalar_one_or_none()
    value = json.dumps(rows)
    if row is None:
        db.add(Settings(key=key, value=value))
    else:
        row.value = value
    await db.commit()
    return rows


async def read_labor(conn: AsyncConnection) -> list[dict]:
    return await _read_json(conn, LABOR_KEY)


async def save_labor(db, providers: list[dict]) -> list[dict]:
    return await _save_json(db, LABOR_KEY, providers)


async def read_depreciation(conn: AsyncConnection) -> dict:
    raw = (await conn.execute(select(Settings.value).where(Settings.key == DEPRECIATION_KEY))).scalar_one_or_none()
    return json.loads(raw) if raw else {"assets": [], "selected": [], "readAt": None}


async def save_depreciation(db, value: dict) -> dict:
    return await _save_json(db, DEPRECIATION_KEY, value)


async def read_fixed_accounts(conn: AsyncConnection) -> dict[str, dict]:
    return cast(dict, await _read_json(conn, FIXED_ACCOUNTS_KEY)) or {}


async def save_fixed_accounts(db, config: dict[str, dict]) -> dict[str, dict]:
    return await _save_json(db, FIXED_ACCOUNTS_KEY, config)


async def read_fixed_cache(conn: AsyncConnection) -> dict:
    cache = cast(dict, await _read_json(conn, FIXED_ACCOUNTS_CACHE_KEY))
    return cache or {"accounts": [], "months": {}, "readAt": None, "currentReadAt": None}


async def save_fixed_cache(db, cache: dict) -> dict:
    return await _save_json(db, FIXED_ACCOUNTS_CACHE_KEY, cache)


async def read_fixed_charges(conn: AsyncConnection, today: str) -> dict[str, Charge]:
    """What each month charges to 3D printing, from the shares set on Zoho's expense accounts."""
    return charges_by_month(await read_fixed_accounts(conn), await read_fixed_cache(conn), today)


async def read_production_costs(conn: AsyncConnection, today: str, now: datetime | None = None) -> ProductionCosts:
    """`now` adds today's share of labour and fixed costs; without it today carries neither."""
    day_share, work_share = day_shares(now) if now else (0.0, 0.0)
    sheets = (await conn.execute(select(CalculatorPrinter))).all()
    # A Core row carries the model's columns as attributes; the checker only sees Row.
    rates = {p.name.casefold(): machine_rate(cast(PrinterSheet, p)) for p in sheets}
    rates_by_printer = {
        pid: rate
        for pid, name, model in (await conn.execute(select(Printer.id, Printer.name, Printer.model))).all()
        if (rate := match_rate(model, name, rates)) is not None
    }
    tariff = (await conn.execute(select(CalculatorDefaults.electricity_tariff).limit(1))).scalar() or 0.0
    prices = FilamentPrices(
        (m, c)
        for m, c in (await conn.execute(select(CalculatorFilament.material, CalculatorFilament.cost_per_kg))).all()
    )
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
            PrintLogEntry.filament_type,
        )
        # Core read, so the ORM's open-run filter does not apply: leave open runs out by hand.
        .where(PrintLogEntry.started_at.isnot(None), PrintLogEntry.status != RUN_OPEN)
    )
    runs = []
    for started, completed, duration, printer_id, grams, cost, energy, wear, material in rows.all():
        if started is None:  # excluded by the query; narrows the type
            continue
        # Same rule as the archive stats (#2592): a stored duration wins, even 0.
        if duration is not None:
            seconds = float(duration)
        elif completed is not None:
            seconds = max(0.0, (completed - started).total_seconds())
        else:
            seconds = 0.0
        runs.append(Run(started, printer_id, seconds, grams, cost, energy, wear, material))
    costs = costs_by_day(runs, rates_by_printer, tariff, prices)
    by_day = costs.by_day
    for day, cost in labor_by_day(await read_labor(conn), today, today_share=work_share).items():
        _add(by_day, day, {"labor": cost})
    fixed, fixed_goods = fixed_by_day(await read_fixed_charges(conn, today), today, today_share=day_share)
    for day, parts in fixed.items():
        _add(by_day, day, parts)
    assets = selected_assets(await read_depreciation(conn))
    if assets:
        # The books' depreciation replaces the calculator's usage wear: counting both would charge the machines twice.
        for parts in by_day.values():
            parts.pop("wear", None)
        for day, cost in depreciation_by_day(assets, today, today_share=day_share).items():
            _add(by_day, day, {"depreciation": cost})
    return ProductionCosts(
        by_day=by_day,
        first_day=min(by_day, default=None),
        hours_by_day=costs.hours_by_day,
        fixed_goods_by_day=fixed_goods,
    )
