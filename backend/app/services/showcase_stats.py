"""Public shop figures for the Shopify storefront (routes/showcase.py).

Everything is derived from completed, non-trashed archives, accepted Aito
projects and active printers. The headline figures are multiplied by
``MULTIPLIER`` because the archive only covers the machines Fenrir has
tracked, not the shop's whole history; the fleet size and the load are
real. The load window is a week so a weekend never reads as a slump. Results are cached in memory for ``CACHE_TTL`` seconds so a
storefront with many visitors never recomputes per request.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_project import AitoProject
from backend.app.models.archive import PrintArchive
from backend.app.models.printer import Printer
from backend.app.utils.local_time import utcnow_naive

MULTIPLIER = 1.5  # shortcut: fixed, upgrade to a setting when the shop wants to tune it
# Shop history from before Fenrir, added after the multiplier. Same shortcut as MULTIPLIER.
SINCE = "2024-06-01"
PRINTS_OFFSET = 10_000
FILAMENT_KG_OFFSET = 1_000.0
ORDERS_OFFSET = 1_000
PRINT_HOURS_OFFSET = 50_000
LAYERS_OFFSET = 3_200_000
LOAD_FACTOR = 2  # the tracked fleet under-reports the shop's real machine hours
PRINTERS_OFFSET = 3  # machines not connected to Fenrir; the load still divides by the real fleet
CACHE_TTL = 300.0
LOAD_WINDOW_DAYS = 7
# An open (completed_at IS NULL) row older than this is a print that never got closed, not a running one.
_OPEN_PRINT_MAX_AGE = timedelta(days=7)

_cache: tuple[float, dict[str, Any]] | None = None
_clock = time.monotonic  # module attribute so tests can freeze it without touching the event loop's clock


def reset_cache() -> None:
    global _cache
    _cache = None


def load_level(avg_hours_per_printer: float) -> str:
    """Busy indicator on the weekly average: every machine running 16 h/day is "high", half of that "medium"."""
    if avg_hours_per_printer >= 16:
        return "high"
    if avg_hours_per_printer >= 8:
        return "medium"
    return "low"


async def compute(db: AsyncSession, now: datetime | None = None) -> dict[str, Any]:
    now = now or utcnow_naive()
    m = MULTIPLIER
    done = (PrintArchive.deleted_at.is_(None), PrintArchive.status == "completed")

    n_prints, grams, seconds, layers = (
        await db.execute(
            select(
                func.count(PrintArchive.id),
                func.coalesce(func.sum(PrintArchive.filament_used_grams), 0.0),
                func.coalesce(func.sum(PrintArchive.print_time_seconds), 0),
                func.coalesce(func.sum(PrintArchive.total_layers), 0),
            ).where(*done)
        )
    ).one()
    n_recent, grams_recent = (
        await db.execute(
            select(func.count(PrintArchive.id), func.coalesce(func.sum(PrintArchive.filament_used_grams), 0.0)).where(
                *done, PrintArchive.completed_at >= now - timedelta(days=30)
            )
        )
    ).one()
    orders = (
        await db.scalar(
            select(func.count(AitoProject.id)).where(
                AitoProject.status == "active", AitoProject.board_column != "devis"
            )
        )
        or 0
    )
    printers = await db.scalar(select(func.count(Printer.id)).where(Printer.is_active.is_(True))) or 0

    # weekly load: hours of any print (failed ones ran the machine too) overlapping the window
    start = now - timedelta(days=LOAD_WINDOW_DAYS)
    rows = (
        await db.execute(
            select(PrintArchive.started_at, PrintArchive.completed_at).where(
                PrintArchive.deleted_at.is_(None),
                PrintArchive.started_at.is_not(None),
                PrintArchive.started_at < now,
                (PrintArchive.completed_at >= start) | (PrintArchive.completed_at.is_(None)),
                PrintArchive.started_at >= now - _OPEN_PRINT_MAX_AGE,
            )
        )
    ).all()
    machine_hours = 0.0
    for started, ended in rows:
        if started is not None:
            machine_hours += max(0.0, (min(ended or now, now) - max(started, start)).total_seconds()) / 3600
    machine_hours *= LOAD_FACTOR
    avg = machine_hours / printers / LOAD_WINDOW_DAYS if printers else 0.0

    hours = float(seconds or 0) / 3600 * m + PRINT_HOURS_OFFSET
    return {
        "updated_at": now.replace(microsecond=0).isoformat() + "Z",
        "since": SINCE,
        "prints": round(int(n_prints or 0) * m) + PRINTS_OFFSET,
        "filament_kg": round(float(grams or 0) / 1000 * m + FILAMENT_KG_OFFSET, 1),
        "print_hours": round(hours),
        "print_days": round(hours / 24, 1),
        "layers": round(int(layers or 0) * m) + LAYERS_OFFSET,
        "orders": round(orders * m) + ORDERS_OFFSET,
        "printers": printers + PRINTERS_OFFSET,
        "last_30_days": {
            "prints": round(int(n_recent or 0) * m),
            "filament_kg": round(float(grams_recent or 0) / 1000 * m, 1),
        },
        "load_7d": {
            "machine_hours": round(machine_hours, 1),
            "avg_hours_per_printer_per_day": round(avg, 1),
            "level": load_level(avg),
        },
    }


async def get_cached(db: AsyncSession) -> dict[str, Any]:
    global _cache
    if _cache is None or _clock() - _cache[0] >= CACHE_TTL:
        _cache = (_clock(), await compute(db))
    return _cache[1]
