"""Measured "reality check" figures for the pricing calculator.

The calculator prices jobs from assumed rates (failure %, electricity tariff,
filament cost). This service aggregates what the app actually measured so the
calculator can show "assumed vs measured" with one-click apply:

- failure rates from the print log (overall, per printer, per filament type)
- the global electricity price setting (`energy_cost_per_kwh`)
- average real spool purchase cost per material (and per brand+material) from
  the inventory
- slicer-estimate vs actual duration accuracy per printer
- measured average power draw per printer from smart-plug energy readings
- measured daily usage hours per printer from print-log durations

Groups with fewer than ``MIN_SAMPLE`` runs are suppressed — a rate computed
from a couple of prints is noise dressed up as truth.
"""

from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.archive import PrintArchive
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.printer import Printer
from backend.app.models.spool import Spool

MIN_SAMPLE = 5

# Same band as the archives stats fold (archives.py get_archive_stats):
# multi-plate runs and manual interventions produce ratios that are pure
# noise, so only ratios within [50%, 200%] count toward the average.
_ACCURACY_BAND_LO = 50.0
_ACCURACY_BAND_HI = 200.0

# Implied per-print watts outside this band are attribution noise (plug
# powering more than the printer, counter glitches, sub-minute blips).
_WATTS_BAND_LO = 1.0
_WATTS_BAND_HI = 3000.0
# Prints shorter than this can't produce a meaningful watts figure.
_MIN_POWER_SECONDS = 300
# Stale log entries (left open for weeks, then bulk-closed by a cleanup
# sweep) carry weeks of wall-clock time as "duration" — under any status.
# No real print outlasts this bound, so longer durations are corrupted
# records and must be skipped entirely, not clamped.
_MAX_PRINT_SECONDS = 4 * 24 * 3600
# A usage-hours/day figure needs at least this many observed days — a
# 3-day-old printer showing 20 h/day is noise, not utilization.
_MIN_USAGE_DAYS = 14

_FAILED_STATUSES = ("failed", "aborted")


def _duration_usable_expr():
    """SQL predicate: ``duration_seconds`` is present and non-zero (usable as-is)."""
    return and_(PrintLogEntry.duration_seconds.isnot(None), PrintLogEntry.duration_seconds != 0)


def _duration_missing_expr():
    """SQL predicate: ``duration_seconds`` is absent or zero (needs the elapsed-time fallback)."""
    return or_(PrintLogEntry.duration_seconds.is_(None), PrintLogEntry.duration_seconds == 0)


class CalculatorInsightsService:
    """Aggregates measured pricing signals for GET /calculator/insights."""

    async def compute(self, db: AsyncSession, days: int = 365) -> dict:
        since = datetime.now(timezone.utc) - timedelta(days=days)
        failure = await self._failure_rates(db, since)
        time_accuracy = await self._time_accuracy(db, since)
        spool_costs = await self._spool_costs(db)
        spool_costs_by_brand = await self._spool_costs_by_brand(db)
        power = await self._power_draw(db, since)
        usage = await self._daily_usage(db, since)

        from backend.app.api.routes.settings import get_energy_cost_per_kwh

        return {
            "window_days": days,
            "failure": failure,
            "energy_cost_per_kwh": await get_energy_cost_per_kwh(db),
            "spool_cost_by_material": spool_costs,
            "spool_cost_by_brand": spool_costs_by_brand,
            "time_accuracy": time_accuracy,
            "power_by_printer": power,
            "usage_by_printer": usage,
        }

    async def _failure_rates(self, db: AsyncSession, since: datetime) -> dict:
        rows = await db.execute(
            select(
                PrintLogEntry.status,
                PrintLogEntry.printer_id,
                PrintLogEntry.filament_type,
                func.count(PrintLogEntry.id),
            )
            .where(
                PrintLogEntry.status.in_(("completed", *_FAILED_STATUSES)),
                PrintLogEntry.created_at >= since,
            )
            .group_by(PrintLogEntry.status, PrintLogEntry.printer_id, PrintLogEntry.filament_type)
        )

        overall = {"completed": 0, "failed": 0}
        per_printer: dict[int, dict[str, int]] = {}
        per_material: dict[str, dict[str, int]] = {}
        for status, printer_id, filament_type, count in rows.all():
            bucket = "completed" if status == "completed" else "failed"
            overall[bucket] += count
            if printer_id is not None:
                per_printer.setdefault(printer_id, {"completed": 0, "failed": 0})[bucket] += count
            # Multi-material runs store comma-joined types; each material
            # observed the run's outcome (same convention as stats splitting).
            for material in _split_materials(filament_type):
                per_material.setdefault(material, {"completed": 0, "failed": 0})[bucket] += count

        printer_names = await _printer_names(db, per_printer.keys())

        def rate(counts: dict[str, int]) -> tuple[float, int]:
            sample = counts["completed"] + counts["failed"]
            return (round(counts["failed"] / sample * 100, 1) if sample else 0.0, sample)

        overall_rate, overall_sample = rate(overall)
        by_printer = []
        for printer_id, counts in per_printer.items():
            pct, sample = rate(counts)
            if sample >= MIN_SAMPLE:
                by_printer.append(
                    {
                        "printer_id": printer_id,
                        "printer_name": printer_names.get(printer_id, f"#{printer_id}"),
                        "rate_pct": pct,
                        "sample": sample,
                    }
                )
        by_material = []
        for material, counts in per_material.items():
            pct, sample = rate(counts)
            if sample >= MIN_SAMPLE:
                by_material.append({"material": material, "rate_pct": pct, "sample": sample})

        return {
            "overall_pct": overall_rate if overall_sample >= MIN_SAMPLE else None,
            "sample": overall_sample,
            "by_printer": sorted(by_printer, key=lambda r: -r["sample"]),
            "by_material": sorted(by_material, key=lambda r: -r["sample"]),
        }

    async def _time_accuracy(self, db: AsyncSession, since: datetime) -> dict:
        # These extra predicates are a pure row-count optimization: they only
        # exclude rows that `_resolve_duration` + the accuracy-band check
        # below would discard anyway, so the Python fold that follows is
        # untouched and sees the exact same (duration, estimate) pairs it
        # always did. Two cases are pushed to SQL because they're exact
        # integer/IEEE-754 float mirrors of the Python arithmetic:
        #   - duration_seconds is usable (truthy) directly, no timestamp math;
        #   - the accuracy ratio and its [50, 200] band, using `col * 1.0 / col`
        #     to force float division exactly like Python's `int / int`.
        # Rows needing the started_at/completed_at fallback (duration_seconds
        # null or 0) are always fetched and still resolved/banded in Python,
        # since replicating that elapsed-time fallback in SQL would risk
        # timezone/precision drift this task explicitly warns against.
        duration_usable = _duration_usable_expr()
        duration_missing = _duration_missing_expr()
        accuracy_in_band = (PrintArchive.print_time_seconds * 1.0 / PrintLogEntry.duration_seconds * 100).between(
            _ACCURACY_BAND_LO, _ACCURACY_BAND_HI
        )
        rows = await db.execute(
            select(
                PrintLogEntry.duration_seconds,
                PrintLogEntry.started_at,
                PrintLogEntry.completed_at,
                PrintLogEntry.printer_id,
                PrintArchive.print_time_seconds,
            )
            .join(PrintArchive, PrintArchive.id == PrintLogEntry.archive_id)
            .where(
                PrintLogEntry.status == "completed",
                PrintLogEntry.created_at >= since,
                PrintArchive.print_time_seconds.isnot(None),
                # `not estimate_seconds` in the fold below also drops 0.
                PrintArchive.print_time_seconds != 0,
                or_(
                    and_(duration_usable, accuracy_in_band),
                    and_(
                        duration_missing,
                        PrintLogEntry.started_at.isnot(None),
                        PrintLogEntry.completed_at.isnot(None),
                    ),
                ),
            )
        )

        accuracies: list[float] = []
        per_printer: dict[int, list[float]] = {}
        for duration_seconds, started_at, completed_at, printer_id, estimate_seconds in rows.all():
            actual_seconds = _resolve_duration(duration_seconds, started_at, completed_at)
            if not actual_seconds or not estimate_seconds:
                continue
            accuracy = (estimate_seconds / actual_seconds) * 100
            if accuracy < _ACCURACY_BAND_LO or accuracy > _ACCURACY_BAND_HI:
                continue
            accuracies.append(accuracy)
            if printer_id is not None:
                per_printer.setdefault(printer_id, []).append(accuracy)

        printer_names = await _printer_names(db, per_printer.keys())

        by_printer = [
            {
                "printer_id": printer_id,
                "printer_name": printer_names.get(printer_id, f"#{printer_id}"),
                "accuracy_pct": round(sum(values) / len(values), 1),
                "sample": len(values),
            }
            for printer_id, values in per_printer.items()
            if len(values) >= 3
        ]
        return {
            "overall_pct": round(sum(accuracies) / len(accuracies), 1) if accuracies else None,
            "sample": len(accuracies),
            "by_printer": sorted(by_printer, key=lambda r: -r["sample"]),
        }

    async def _power_draw(self, db: AsyncSession, since: datetime) -> list[dict]:
        """Energy-weighted average watts per printer from measured print energy.

        ``PrintLogEntry.energy_kwh`` is backfilled from the smart-plug lifetime
        counter delta, so attribution is already per-printer — but it assumes
        the plug powers only the printer; a plug also feeding a dryer or light
        inflates the figure (the outlier band catches the worst of it).
        """
        # Same technique as `_time_accuracy`: only pre-filter rows that the
        # Python fold below would discard anyway, for the duration_seconds-
        # usable case where the arithmetic is an exact SQL mirror of the
        # Python expressions (`hours = actual/3600`, `implied_watts =
        # energy_kwh*1000/hours`, both forced to float division to match
        # Python's automatic int/int promotion). Rows needing the
        # started_at/completed_at fallback are always fetched, unresolved,
        # and handled by the unchanged Python loop.
        duration_usable = _duration_usable_expr()
        duration_missing = _duration_missing_expr()
        hours_expr = PrintLogEntry.duration_seconds * 1.0 / 3600
        implied_watts_expr = PrintLogEntry.energy_kwh * 1000 / hours_expr
        rows = await db.execute(
            select(
                PrintLogEntry.energy_kwh,
                PrintLogEntry.duration_seconds,
                PrintLogEntry.started_at,
                PrintLogEntry.completed_at,
                PrintLogEntry.printer_id,
            ).where(
                PrintLogEntry.energy_kwh > 0,
                PrintLogEntry.printer_id.isnot(None),
                PrintLogEntry.created_at >= since,
                PrintLogEntry.status.in_(("completed", *_FAILED_STATUSES)),
                or_(
                    and_(
                        duration_usable,
                        PrintLogEntry.duration_seconds.between(_MIN_POWER_SECONDS, _MAX_PRINT_SECONDS),
                        implied_watts_expr.between(_WATTS_BAND_LO, _WATTS_BAND_HI),
                    ),
                    and_(
                        duration_missing,
                        PrintLogEntry.started_at.isnot(None),
                        PrintLogEntry.completed_at.isnot(None),
                    ),
                ),
            )
        )

        per_printer: dict[int, dict[str, float]] = {}
        for energy_kwh, duration_seconds, started_at, completed_at, printer_id in rows.all():
            actual_seconds = _resolve_duration(duration_seconds, started_at, completed_at)
            if not actual_seconds or actual_seconds < _MIN_POWER_SECONDS or actual_seconds > _MAX_PRINT_SECONDS:
                continue
            hours = actual_seconds / 3600
            implied_watts = energy_kwh * 1000 / hours
            if implied_watts < _WATTS_BAND_LO or implied_watts > _WATTS_BAND_HI:
                continue
            bucket = per_printer.setdefault(printer_id, {"kwh": 0.0, "hours": 0.0, "sample": 0})
            bucket["kwh"] += energy_kwh
            bucket["hours"] += hours
            bucket["sample"] += 1

        printer_names = await _printer_names(db, per_printer.keys())

        by_printer = [
            {
                "printer_id": printer_id,
                "printer_name": printer_names.get(printer_id, f"#{printer_id}"),
                "avg_watts": round(bucket["kwh"] * 1000 / bucket["hours"], 1),
                "sample": int(bucket["sample"]),
            }
            for printer_id, bucket in per_printer.items()
            if bucket["sample"] >= MIN_SAMPLE and bucket["hours"] > 0
        ]
        return sorted(by_printer, key=lambda r: -r["sample"])

    async def _daily_usage(self, db: AsyncSession, since: datetime) -> list[dict]:
        """Measured usage-hours/day per printer, for the depreciation assumption."""
        rows = await db.execute(
            select(
                PrintLogEntry.printer_id,
                func.sum(PrintLogEntry.duration_seconds),
                func.count(PrintLogEntry.id),
                func.min(PrintLogEntry.created_at),
            )
            .where(
                PrintLogEntry.printer_id.isnot(None),
                PrintLogEntry.created_at >= since,
                PrintLogEntry.duration_seconds.isnot(None),
                PrintLogEntry.duration_seconds <= _MAX_PRINT_SECONDS,
                PrintLogEntry.status.in_(("completed", *_FAILED_STATUSES)),
            )
            .group_by(PrintLogEntry.printer_id)
        )

        now = datetime.now(timezone.utc)
        entries: dict[int, dict] = {}
        for printer_id, total_seconds, sample, first_at in rows.all():
            if not total_seconds or sample < MIN_SAMPLE or first_at is None:
                continue
            if first_at.tzinfo is None:
                first_at = first_at.replace(tzinfo=timezone.utc)
            observed_days = max(1, (now - first_at).days)
            if observed_days < _MIN_USAGE_DAYS:
                continue
            entries[printer_id] = {
                "printer_id": printer_id,
                "hours_per_day": round(total_seconds / 3600 / observed_days, 2),
                "observed_days": observed_days,
                "sample": sample,
            }

        printer_names = await _printer_names(db, entries.keys())
        for printer_id, entry in entries.items():
            entry["printer_name"] = printer_names.get(printer_id, f"#{printer_id}")
        return sorted(entries.values(), key=lambda r: -r["sample"])

    async def _spool_costs(self, db: AsyncSession) -> list[dict]:
        rows = await db.execute(
            select(
                func.upper(Spool.material),
                func.avg(Spool.cost_per_kg),
                func.count(Spool.id),
            )
            .where(Spool.cost_per_kg.isnot(None), Spool.archived_at.is_(None))
            .group_by(func.upper(Spool.material))
        )
        published_brand_counts = await self._published_brand_counts_by_material(db)
        result = []
        for material, avg_cost, count in rows.all():
            if not material or count < MIN_SAMPLE:
                continue
            # The published brand+material rows for this material are a
            # visible partition of it. If they leave a small residual
            # population — this material's total minus the sum of its
            # published brand subgroups — that residual's average is
            # recoverable by subtraction even though no single query
            # discloses it directly (see T-089/T-106). Suppress the whole
            # material row rather than let that residual leak through it.
            residual = count - published_brand_counts.get(material, 0)
            if 0 < residual < MIN_SAMPLE:
                continue
            result.append({"material": material, "avg_cost_per_kg": round(avg_cost, 2), "sample": count})
        return result

    async def _published_brand_counts_by_material(self, db: AsyncSession) -> dict[str, int]:
        """Per-material sum of counts from the brand+material groups that
        ``_spool_costs_by_brand`` actually publishes (i.e. that clear its own
        MIN_SAMPLE floor). Used by ``_spool_costs`` to find the residual
        population a material's published brand breakdown leaves unaccounted
        for.
        """
        rows = await db.execute(
            select(
                func.upper(Spool.material),
                func.count(Spool.id),
            )
            .where(
                Spool.cost_per_kg.isnot(None),
                Spool.archived_at.is_(None),
                Spool.brand.isnot(None),
            )
            .group_by(func.upper(Spool.brand), func.upper(Spool.material))
            .having(func.count(Spool.id) >= MIN_SAMPLE)
        )
        totals: dict[str, int] = {}
        for material, count in rows.all():
            if not material:
                continue
            totals[material] = totals.get(material, 0) + count
        return totals

    async def _spool_costs_by_brand(self, db: AsyncSession) -> list[dict]:
        """Like ``_spool_costs`` but grouped by brand+material for exact matches."""
        rows = await db.execute(
            select(
                func.upper(Spool.brand),
                func.upper(Spool.material),
                func.avg(Spool.cost_per_kg),
                func.count(Spool.id),
            )
            .where(
                Spool.cost_per_kg.isnot(None),
                Spool.archived_at.is_(None),
                Spool.brand.isnot(None),
            )
            .group_by(func.upper(Spool.brand), func.upper(Spool.material))
        )
        return [
            {"brand": brand, "material": material, "avg_cost_per_kg": round(avg_cost, 2), "sample": count}
            for brand, material, avg_cost, count in rows.all()
            if brand and material and count >= MIN_SAMPLE
        ]


async def _printer_names(db: AsyncSession, printer_ids) -> dict[int, str]:
    """Batched id → name lookup for the per-printer groupings."""
    ids = list(printer_ids)
    if not ids:
        return {}
    return dict((await db.execute(select(Printer.id, Printer.name).where(Printer.id.in_(ids)))).all())


def _resolve_duration(duration_seconds, started_at, completed_at) -> int | None:
    """Actual run seconds: the stored duration, else the started→completed elapsed."""
    if duration_seconds:
        return duration_seconds
    if started_at and completed_at:
        elapsed = (completed_at - started_at).total_seconds()
        return int(elapsed) if elapsed > 0 else None
    return None


def _split_materials(filament_type: str | None) -> list[str]:
    if not filament_type:
        return []
    return sorted({part.strip().upper() for part in filament_type.split(",") if part.strip()})


calculator_insights_service = CalculatorInsightsService()
