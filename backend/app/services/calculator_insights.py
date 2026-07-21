"""Measured "reality check" figures for the pricing calculator.

The calculator prices jobs from assumed rates (failure %, electricity tariff,
filament cost). This service aggregates what the app actually measured so the
calculator can show "assumed vs measured" with one-click apply:

- failure rates from the print log (overall, per printer, per filament type)
- the global electricity price setting (`energy_cost_per_kwh`)
- average real spool purchase cost per material from the inventory
- slicer-estimate vs actual duration accuracy per printer

Groups with fewer than ``MIN_SAMPLE`` runs are suppressed — a rate computed
from a couple of prints is noise dressed up as truth.
"""

from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
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

_FAILED_STATUSES = ("failed", "aborted")


class CalculatorInsightsService:
    """Aggregates measured pricing signals for GET /calculator/insights."""

    async def compute(self, db: AsyncSession, days: int = 365) -> dict:
        since = datetime.now(timezone.utc) - timedelta(days=days)
        failure = await self._failure_rates(db, since)
        time_accuracy = await self._time_accuracy(db, since)
        spool_costs = await self._spool_costs(db)

        from backend.app.api.routes.settings import get_energy_cost_per_kwh

        return {
            "window_days": days,
            "failure": failure,
            "energy_cost_per_kwh": await get_energy_cost_per_kwh(db),
            "spool_cost_by_material": spool_costs,
            "time_accuracy": time_accuracy,
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

        printer_names = (
            dict((await db.execute(select(Printer.id, Printer.name).where(Printer.id.in_(per_printer.keys())))).all())
            if per_printer
            else {}
        )

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
            )
        )

        accuracies: list[float] = []
        per_printer: dict[int, list[float]] = {}
        for duration_seconds, started_at, completed_at, printer_id, estimate_seconds in rows.all():
            actual_seconds = duration_seconds
            if not actual_seconds and started_at and completed_at:
                elapsed = (completed_at - started_at).total_seconds()
                actual_seconds = int(elapsed) if elapsed > 0 else None
            if not actual_seconds or not estimate_seconds:
                continue
            accuracy = (estimate_seconds / actual_seconds) * 100
            if accuracy < _ACCURACY_BAND_LO or accuracy > _ACCURACY_BAND_HI:
                continue
            accuracies.append(accuracy)
            if printer_id is not None:
                per_printer.setdefault(printer_id, []).append(accuracy)

        printer_names = (
            dict((await db.execute(select(Printer.id, Printer.name).where(Printer.id.in_(per_printer.keys())))).all())
            if per_printer
            else {}
        )

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
        return [
            {"material": material, "avg_cost_per_kg": round(avg_cost, 2), "sample": count}
            for material, avg_cost, count in rows.all()
            if material
        ]


def _split_materials(filament_type: str | None) -> list[str]:
    if not filament_type:
        return []
    return sorted({part.strip().upper() for part in filament_type.split(",") if part.strip()})


calculator_insights_service = CalculatorInsightsService()
