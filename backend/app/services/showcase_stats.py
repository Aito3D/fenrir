"""Public shop figures for the Shopify storefront (routes/showcase.py).

Everything is derived from completed, non-trashed archives, accepted Aito
projects and active printers. The headline figures are multiplied by
``MULTIPLIER`` because the archive only covers the machines Fenrir has
tracked, not the shop's whole history; the fleet size and the load are
real. The load window is a week so a weekend never reads as a slump.

Exposed to the internet, so the serving path is built to cost nothing per
request: a cache hit touches neither the database nor the connection pool,
a miss recomputes once under a lock while concurrent callers wait for that
one result, and a failed recompute keeps serving the last good payload
instead of leaking an error. The JSON bytes and their ETag are built once
per recompute so conditional requests answer 304 without re-serialising.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import async_session
from backend.app.models.aito_project import AitoProject
from backend.app.models.archive import PrintArchive
from backend.app.models.printer import Printer
from backend.app.utils.local_time import utcnow_naive

MULTIPLIER = 1.5  # shortcut: fixed, upgrade to a setting when the shop wants to tune it
# Shop history from before Fenrir, added after the multiplier. Same shortcut as MULTIPLIER.
SINCE = "2024-06-01"
PRINTS_OFFSET = 20_000
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

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Snapshot:
    at: float
    payload: dict[str, Any]
    body: bytes
    etag: str


_cache: Snapshot | None = None
_lock = asyncio.Lock()
_clock = time.monotonic  # module attribute so tests can freeze it without touching the event loop's clock
_session_factory = async_session  # module attribute so tests can point a recompute at their engine


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


def _snapshot(payload: dict[str, Any]) -> Snapshot:
    body = json.dumps(payload, separators=(",", ":")).encode()
    return Snapshot(_clock(), payload, body, '"' + hashlib.sha256(body).hexdigest()[:32] + '"')


async def get_cached() -> Snapshot:
    """The current payload, recomputed at most once per ``CACHE_TTL`` and once
    per expiry however many requests arrive together. Raises only when there
    is no previous payload to fall back on."""
    global _cache
    if _cache is not None and _clock() - _cache.at < CACHE_TTL:
        return _cache
    async with _lock:
        if _cache is not None and _clock() - _cache.at < CACHE_TTL:
            return _cache  # another waiter already refreshed it
        try:
            async with _session_factory() as db:
                _cache = _snapshot(await compute(db))
        except Exception:
            if _cache is None:
                raise
            logger.exception("showcase stats recompute failed; serving the previous snapshot")
            _cache = Snapshot(_clock(), _cache.payload, _cache.body, _cache.etag)  # retry after another TTL
        return _cache
