"""Tests for GET /api/v1/calculator/insights (measured reality-check figures)."""

from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.archive import PrintArchive
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.spool import Spool
from backend.app.services.calculator_insights import (
    _ACCURACY_BAND_HI,
    _ACCURACY_BAND_LO,
    _FAILED_STATUSES,
    _MAX_PRINT_SECONDS,
    _MIN_POWER_SECONDS,
    _WATTS_BAND_HI,
    _WATTS_BAND_LO,
    MIN_SAMPLE,
    _printer_names,
    _resolve_duration,
    _split_materials,
    calculator_insights_service,
)

NOW = datetime.now(timezone.utc).replace(tzinfo=None)


def _run(printer_id: int, status: str, filament_type: str = "PLA", archive_id: int | None = None, **kwargs):
    defaults = {
        "printer_id": printer_id,
        "status": status,
        "filament_type": filament_type,
        "archive_id": archive_id,
        "created_at": NOW - timedelta(days=1),
    }
    defaults.update(kwargs)
    return PrintLogEntry(**defaults)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_insights_empty_db(async_client: AsyncClient):
    response = await async_client.get("/api/v1/calculator/insights")
    assert response.status_code == 200
    data = response.json()
    assert data["failure"]["overall_pct"] is None
    assert data["failure"]["by_printer"] == []
    assert data["time_accuracy"]["overall_pct"] is None
    assert data["spool_cost_by_material"] == []
    assert data["spool_cost_by_brand"] == []
    assert data["power_by_printer"] == []
    assert data["usage_by_printer"] == []
    assert data["energy_cost_per_kwh"] == 0.15  # settings default


@pytest.mark.asyncio
@pytest.mark.integration
async def test_failure_rates_per_printer_and_material(async_client: AsyncClient, printer_factory, db_session):
    printer = await printer_factory()
    # 8 completed + 2 failed on PLA = 20% failure, sample 10.
    for _ in range(8):
        db_session.add(_run(printer.id, "completed"))
    for _ in range(2):
        db_session.add(_run(printer.id, "failed"))
    # Cancelled/skipped must not count toward the denominator.
    db_session.add(_run(printer.id, "cancelled"))
    db_session.add(_run(printer.id, "skipped"))
    await db_session.commit()

    response = await async_client.get("/api/v1/calculator/insights")
    data = response.json()
    assert data["failure"]["overall_pct"] == 20.0
    assert data["failure"]["sample"] == 10
    by_printer = data["failure"]["by_printer"]
    assert len(by_printer) == 1
    assert by_printer[0]["printer_name"] == printer.name
    assert by_printer[0]["rate_pct"] == 20.0
    by_material = data["failure"]["by_material"]
    assert len(by_material) == 1
    assert by_material[0]["material"] == "PLA"
    assert by_material[0]["rate_pct"] == 20.0
    assert by_material[0]["sample"] == 10


@pytest.mark.asyncio
@pytest.mark.integration
async def test_small_samples_are_suppressed(async_client: AsyncClient, printer_factory, db_session):
    printer = await printer_factory()
    # Only 4 outcome runs — below MIN_SAMPLE (5): no per-group rows, no overall.
    for _ in range(3):
        db_session.add(_run(printer.id, "completed"))
    db_session.add(_run(printer.id, "failed"))
    await db_session.commit()

    response = await async_client.get("/api/v1/calculator/insights")
    data = response.json()
    assert data["failure"]["overall_pct"] is None
    assert data["failure"]["sample"] == 4
    assert data["failure"]["by_printer"] == []
    assert data["failure"]["by_material"] == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_window_filters_old_runs(async_client: AsyncClient, printer_factory, db_session):
    printer = await printer_factory()
    for _ in range(6):
        db_session.add(_run(printer.id, "failed", created_at=NOW - timedelta(days=400)))
    await db_session.commit()

    response = await async_client.get("/api/v1/calculator/insights?days=30")
    assert response.json()["failure"]["sample"] == 0


@pytest.mark.asyncio
@pytest.mark.integration
async def test_time_accuracy_with_band_clamp(async_client: AsyncClient, printer_factory, archive_factory, db_session):
    printer = await printer_factory()
    # Estimate 3600s, actual 3000s → accuracy 120%. Three runs for the min sample.
    archive = await archive_factory(printer.id, print_time_seconds=3600, with_run=False)
    for _ in range(3):
        db_session.add(_run(printer.id, "completed", archive_id=archive.id, duration_seconds=3000))
    # Outlier: actual 400s → 900% — outside [50, 200], must be ignored.
    db_session.add(_run(printer.id, "completed", archive_id=archive.id, duration_seconds=400))
    await db_session.commit()

    response = await async_client.get("/api/v1/calculator/insights")
    acc = response.json()["time_accuracy"]
    assert acc["overall_pct"] == 120.0
    assert acc["sample"] == 3
    assert acc["by_printer"][0]["accuracy_pct"] == 120.0
    assert acc["by_printer"][0]["sample"] == 3


@pytest.mark.asyncio
@pytest.mark.integration
async def test_spool_costs_average_by_material(async_client: AsyncClient, db_session):
    """T-089: below MIN_SAMPLE, a group is suppressed entirely, not shown with
    a low ``sample``. PLA has exactly MIN_SAMPLE (5) priced, unarchived spools;
    PETG has only one, so it must not appear in the response at all — a
    single spool's cost is that spool's verbatim purchase price, not an
    aggregate.
    """
    db_session.add(Spool(material="PLA", cost_per_kg=20.0))
    db_session.add(Spool(material="pla", cost_per_kg=30.0))
    db_session.add(Spool(material="PLA", cost_per_kg=20.0))
    db_session.add(Spool(material="pla", cost_per_kg=30.0))
    db_session.add(Spool(material="PLA", cost_per_kg=20.0))  # 5th PLA spool: hits MIN_SAMPLE
    db_session.add(Spool(material="PETG", cost_per_kg=18.0))  # below MIN_SAMPLE — suppressed
    db_session.add(Spool(material="ABS"))  # no cost — excluded
    db_session.add(Spool(material="PLA", cost_per_kg=99.0, archived_at=NOW))  # archived — excluded
    await db_session.commit()

    response = await async_client.get("/api/v1/calculator/insights")
    rows = {r["material"]: r for r in response.json()["spool_cost_by_material"]}
    assert rows["PLA"]["avg_cost_per_kg"] == 24.0
    assert rows["PLA"]["sample"] == 5
    assert "PETG" not in rows


@pytest.mark.asyncio
@pytest.mark.integration
async def test_spool_costs_by_material_below_min_sample_is_absent(async_client: AsyncClient, db_session):
    """The MIN_SAMPLE boundary, one below: MIN_SAMPLE - 1 priced spools must
    produce no row at all for that material."""
    for _ in range(MIN_SAMPLE - 1):
        db_session.add(Spool(material="PLA", cost_per_kg=20.0))
    await db_session.commit()

    response = await async_client.get("/api/v1/calculator/insights")
    rows = {r["material"]: r for r in response.json()["spool_cost_by_material"]}
    assert "PLA" not in rows


@pytest.mark.asyncio
@pytest.mark.integration
async def test_spool_costs_by_material_at_min_sample_is_present(async_client: AsyncClient, db_session):
    """The MIN_SAMPLE boundary, exactly on it: MIN_SAMPLE priced spools must
    produce a row."""
    for _ in range(MIN_SAMPLE):
        db_session.add(Spool(material="PLA", cost_per_kg=20.0))
    await db_session.commit()

    response = await async_client.get("/api/v1/calculator/insights")
    rows = {r["material"]: r for r in response.json()["spool_cost_by_material"]}
    assert rows["PLA"]["avg_cost_per_kg"] == 20.0
    assert rows["PLA"]["sample"] == MIN_SAMPLE


@pytest.mark.asyncio
@pytest.mark.integration
async def test_spool_costs_average_by_brand(async_client: AsyncClient, db_session):
    """T-089: same suppression, grouped by brand+material. Polymaker/PLA has
    exactly MIN_SAMPLE (5); Bambu Lab/PLA has only one and must not appear —
    that single spool's cost is its exact purchase price and supplier brand,
    not an aggregate.
    """
    db_session.add(Spool(material="PLA", brand="Polymaker", cost_per_kg=20.0))
    db_session.add(Spool(material="pla", brand="polymaker", cost_per_kg=30.0))
    db_session.add(Spool(material="PLA", brand="Polymaker", cost_per_kg=20.0))
    db_session.add(Spool(material="pla", brand="polymaker", cost_per_kg=30.0))
    db_session.add(Spool(material="PLA", brand="Polymaker", cost_per_kg=20.0))  # 5th: hits MIN_SAMPLE
    db_session.add(Spool(material="PLA", brand="Bambu Lab", cost_per_kg=28.0))  # below MIN_SAMPLE — suppressed
    db_session.add(Spool(material="PLA", cost_per_kg=15.0))  # no brand — excluded here
    db_session.add(Spool(material="PLA", brand="Polymaker", cost_per_kg=99.0, archived_at=NOW))  # archived

    await db_session.commit()

    response = await async_client.get("/api/v1/calculator/insights")
    rows = {(r["brand"], r["material"]): r for r in response.json()["spool_cost_by_brand"]}
    assert rows[("POLYMAKER", "PLA")]["avg_cost_per_kg"] == 24.0
    assert rows[("POLYMAKER", "PLA")]["sample"] == 5
    assert ("BAMBU LAB", "PLA") not in rows
    assert ("POLYMAKER", "PLA") in rows and len(rows) == 1


@pytest.mark.asyncio
@pytest.mark.integration
async def test_spool_costs_by_brand_below_min_sample_is_absent(async_client: AsyncClient, db_session):
    """The MIN_SAMPLE boundary, one below, for the brand+material grouping."""
    for _ in range(MIN_SAMPLE - 1):
        db_session.add(Spool(material="PLA", brand="Polymaker", cost_per_kg=20.0))
    await db_session.commit()

    response = await async_client.get("/api/v1/calculator/insights")
    rows = {(r["brand"], r["material"]): r for r in response.json()["spool_cost_by_brand"]}
    assert ("POLYMAKER", "PLA") not in rows


@pytest.mark.asyncio
@pytest.mark.integration
async def test_spool_costs_by_brand_at_min_sample_is_present(async_client: AsyncClient, db_session):
    """The MIN_SAMPLE boundary, exactly on it, for the brand+material grouping."""
    for _ in range(MIN_SAMPLE):
        db_session.add(Spool(material="PLA", brand="Polymaker", cost_per_kg=20.0))
    await db_session.commit()

    response = await async_client.get("/api/v1/calculator/insights")
    rows = {(r["brand"], r["material"]): r for r in response.json()["spool_cost_by_brand"]}
    assert rows[("POLYMAKER", "PLA")]["avg_cost_per_kg"] == 20.0
    assert rows[("POLYMAKER", "PLA")]["sample"] == MIN_SAMPLE


@pytest.mark.asyncio
@pytest.mark.integration
async def test_power_draw_energy_weighted(async_client: AsyncClient, printer_factory, db_session):
    printer = await printer_factory()
    # 5 prints: 2h at 0.2 kWh each → 100 W energy-weighted.
    for _ in range(5):
        db_session.add(_run(printer.id, "completed", duration_seconds=7200, energy_kwh=0.2))
    # Outlier: implied 7200 W — outside [1, 3000], ignored.
    db_session.add(_run(printer.id, "completed", duration_seconds=3600, energy_kwh=7.2))
    # Too short (< 300 s), ignored.
    db_session.add(_run(printer.id, "completed", duration_seconds=120, energy_kwh=0.01))
    # No energy reading, ignored.
    db_session.add(_run(printer.id, "completed", duration_seconds=3600))
    await db_session.commit()

    response = await async_client.get("/api/v1/calculator/insights")
    rows = response.json()["power_by_printer"]
    assert len(rows) == 1
    assert rows[0]["printer_name"] == printer.name
    assert rows[0]["avg_watts"] == 100.0
    assert rows[0]["sample"] == 5


@pytest.mark.asyncio
@pytest.mark.integration
async def test_power_draw_small_sample_suppressed(async_client: AsyncClient, printer_factory, db_session):
    printer = await printer_factory()
    for _ in range(4):  # below MIN_SAMPLE
        db_session.add(_run(printer.id, "completed", duration_seconds=7200, energy_kwh=0.2))
    await db_session.commit()

    response = await async_client.get("/api/v1/calculator/insights")
    assert response.json()["power_by_printer"] == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_daily_usage_hours_per_day(async_client: AsyncClient, printer_factory, db_session):
    printer = await printer_factory()
    # 10 prints of 6h over 20 observed days → 60h / 20d = 3 h/day.
    for i in range(10):
        db_session.add(_run(printer.id, "completed", duration_seconds=21600, created_at=NOW - timedelta(days=20 - i)))
    await db_session.commit()

    response = await async_client.get("/api/v1/calculator/insights")
    rows = response.json()["usage_by_printer"]
    assert len(rows) == 1
    assert rows[0]["printer_name"] == printer.name
    assert rows[0]["hours_per_day"] == 3.0
    assert rows[0]["observed_days"] == 20
    assert rows[0]["sample"] == 10


@pytest.mark.asyncio
@pytest.mark.integration
async def test_stale_entries_excluded_from_usage_and_power(async_client: AsyncClient, printer_factory, db_session):
    """Stale log entries bulk-closed weeks after starting carry weeks of
    wall-clock time as "duration" — they must not count as usage or watts."""
    printer = await printer_factory()
    for i in range(10):
        db_session.add(
            _run(
                printer.id, "completed", duration_seconds=21600, energy_kwh=0.6, created_at=NOW - timedelta(days=20 - i)
            )
        )
    # A stale aborted entry left open for 5 weeks, then swept closed: its
    # "duration" is 840h of wall-clock. Alone it would add 42 h/day.
    db_session.add(
        _run(printer.id, "aborted", duration_seconds=840 * 3600, energy_kwh=1.0, created_at=NOW - timedelta(days=2))
    )
    await db_session.commit()

    response = await async_client.get("/api/v1/calculator/insights")
    usage = response.json()["usage_by_printer"]
    # 10 × 6h over 20 observed days = 3 h/day; the stale entry is ignored.
    assert usage[0]["hours_per_day"] == 3.0
    assert usage[0]["sample"] == 10
    power = response.json()["power_by_printer"]
    # 0.6 kWh per 6h print → 100 W; the stale entry would drag it to ~8 W.
    assert power[0]["avg_watts"] == 100.0
    assert power[0]["sample"] == 10


@pytest.mark.asyncio
@pytest.mark.integration
async def test_daily_usage_short_window_suppressed(async_client: AsyncClient, printer_factory, db_session):
    printer = await printer_factory()
    # Plenty of prints but only observed for 5 days — below _MIN_USAGE_DAYS (14).
    for _ in range(10):
        db_session.add(_run(printer.id, "completed", duration_seconds=21600, created_at=NOW - timedelta(days=5)))
    await db_session.commit()

    response = await async_client.get("/api/v1/calculator/insights")
    assert response.json()["usage_by_printer"] == []


# --- T-076 differential test -------------------------------------------------
#
# `_time_accuracy` and `_power_draw` were changed to push row-count-reducing
# WHERE predicates into SQL (see calculator_insights.py). The predicates are
# provably-safe pre-filters only: the actual fold — `_resolve_duration`,
# the band checks, the sums, the rounding — is untouched Python code applied
# to whatever rows survive. This test proves the *output* is unaffected by
# comparing the new implementation against a verbatim copy of the old,
# unfiltered implementation across a dataset built to hit every branch named
# in the task brief, with values sitting exactly on every band boundary.


async def _reference_time_accuracy(db: AsyncSession, since: datetime) -> dict:
    """Verbatim copy of `_time_accuracy` as it existed before T-076 — no SQL
    pre-filtering, fetches every matching row and folds all of it in Python."""
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


async def _reference_power_draw(db: AsyncSession, since: datetime) -> list[dict]:
    """Verbatim copy of `_power_draw` as it existed before T-076."""
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


async def _build_time_accuracy_dataset(printer_factory, archive_factory, db_session):
    """Exercises every `_resolve_duration` branch and every accuracy-band
    boundary, plus the (hardcoded) `len(values) >= 3` per-printer gate."""
    since = NOW - timedelta(days=3650)

    p_main = await printer_factory()
    a_1h = await archive_factory(p_main.id, print_time_seconds=3600, with_run=False)
    a_zero_estimate = await archive_factory(p_main.id, print_time_seconds=0, with_run=False)
    a_null_estimate = await archive_factory(p_main.id, print_time_seconds=None, with_run=False)

    # Baseline valid runs (accuracy 100%, safely mid-band) — keep p_main above
    # the "3" per-printer gate regardless of which edge cases also land or not.
    for _ in range(4):
        db_session.add(_run(p_main.id, "completed", archive_id=a_1h.id, duration_seconds=3600))

    # Accuracy band edges: estimate/duration*100.
    db_session.add(_run(p_main.id, "completed", archive_id=a_1h.id, duration_seconds=7200))  # est/dur*100=50.0 (LO, in)
    db_session.add(
        _run(p_main.id, "completed", archive_id=a_1h.id, duration_seconds=7202)
    )  # 3600/7202*100=49.986..% (just under LO, out)
    db_session.add(
        _run(p_main.id, "completed", archive_id=a_1h.id, duration_seconds=1800)
    )  # 3600/1800*100=200.0 (HI, in)
    db_session.add(
        _run(p_main.id, "completed", archive_id=a_1h.id, duration_seconds=1799)
    )  # 3600/1799*100=200.11..% (just over HI, out)

    # duration_seconds == 0 (falsy) with valid timestamps → fallback to elapsed.
    db_session.add(
        _run(
            p_main.id,
            "completed",
            archive_id=a_1h.id,
            duration_seconds=0,
            started_at=NOW - timedelta(seconds=3600),
            completed_at=NOW,
        )
    )
    # duration_seconds is None (not just falsy-0) with valid timestamps → fallback.
    db_session.add(
        _run(
            p_main.id,
            "completed",
            archive_id=a_1h.id,
            duration_seconds=None,
            started_at=NOW - timedelta(seconds=3600),
            completed_at=NOW,
        )
    )
    # completed_at <= started_at → elapsed <= 0 → _resolve_duration returns None → excluded.
    db_session.add(
        _run(
            p_main.id,
            "completed",
            archive_id=a_1h.id,
            duration_seconds=None,
            started_at=NOW,
            completed_at=NOW - timedelta(seconds=10),
        )
    )
    # duration_seconds None with no timestamps at all → excluded.
    db_session.add(_run(p_main.id, "completed", archive_id=a_1h.id, duration_seconds=None))
    # estimate_seconds == 0 (falsy but not NULL) → excluded via `not estimate_seconds`.
    db_session.add(_run(p_main.id, "completed", archive_id=a_zero_estimate.id, duration_seconds=3600))
    # estimate_seconds NULL → excluded by the base `.isnot(None)` filter (unchanged by T-076).
    db_session.add(_run(p_main.id, "completed", archive_id=a_null_estimate.id, duration_seconds=3600))

    # Per-printer "len(values) >= 3" gate, with printers isolated from p_main.
    p_low = await printer_factory()
    a_low = await archive_factory(p_low.id, print_time_seconds=3600, with_run=False)
    for _ in range(2):
        db_session.add(_run(p_low.id, "completed", archive_id=a_low.id, duration_seconds=3600))

    p_exact = await printer_factory()
    a_exact = await archive_factory(p_exact.id, print_time_seconds=3600, with_run=False)
    for _ in range(3):
        db_session.add(_run(p_exact.id, "completed", archive_id=a_exact.id, duration_seconds=3600))

    p_high = await printer_factory()
    a_high = await archive_factory(p_high.id, print_time_seconds=3600, with_run=False)
    for _ in range(4):
        db_session.add(_run(p_high.id, "completed", archive_id=a_high.id, duration_seconds=3600))

    await db_session.commit()
    return since


async def _build_power_draw_dataset(printer_factory, db_session):
    """Exercises every `_resolve_duration` branch and every power-band /
    duration-band boundary, plus the MIN_SAMPLE per-printer gate."""
    since = NOW - timedelta(days=3650)

    p_main = await printer_factory()
    # Baseline valid runs (200 W, safely mid-band) — keep p_main comfortably
    # above MIN_SAMPLE regardless of which edge cases also survive.
    for _ in range(6):
        db_session.add(_run(p_main.id, "completed", duration_seconds=3600, energy_kwh=0.2))

    # Duration-band edges (_MIN_POWER_SECONDS=300, _MAX_PRINT_SECONDS=345600),
    # each held safely inside the watts band so only the duration bound is exercised.
    db_session.add(_run(p_main.id, "completed", duration_seconds=300, energy_kwh=0.2))  # MIN edge, in (2400 W)
    db_session.add(_run(p_main.id, "completed", duration_seconds=299, energy_kwh=0.2))  # just under MIN, out
    db_session.add(_run(p_main.id, "completed", duration_seconds=345600, energy_kwh=10))  # MAX edge, in (~104.17 W)
    db_session.add(_run(p_main.id, "completed", duration_seconds=345601, energy_kwh=10))  # just over MAX, out

    # Watts-band edges (_WATTS_BAND_LO=1.0, _WATTS_BAND_HI=3000.0), duration=3600s (1h).
    db_session.add(_run(p_main.id, "completed", duration_seconds=3600, energy_kwh=0.001))  # 1.0 W, LO edge, in
    db_session.add(_run(p_main.id, "completed", duration_seconds=3600, energy_kwh=0.0009))  # 0.9 W, just under LO, out
    db_session.add(_run(p_main.id, "completed", duration_seconds=3600, energy_kwh=3.0))  # 3000.0 W, HI edge, in
    db_session.add(_run(p_main.id, "completed", duration_seconds=3600, energy_kwh=3.001))  # 3001.0 W, just over HI, out

    # duration_seconds == 0 (falsy) with valid timestamps → fallback to elapsed.
    db_session.add(
        _run(
            p_main.id,
            "completed",
            duration_seconds=0,
            energy_kwh=0.5,
            started_at=NOW - timedelta(seconds=3600),
            completed_at=NOW,
        )
    )
    # duration_seconds None with valid timestamps → fallback.
    db_session.add(
        _run(
            p_main.id,
            "completed",
            duration_seconds=None,
            energy_kwh=0.5,
            started_at=NOW - timedelta(seconds=3600),
            completed_at=NOW,
        )
    )
    # completed_at <= started_at → elapsed <= 0 → excluded.
    db_session.add(
        _run(
            p_main.id,
            "completed",
            duration_seconds=None,
            energy_kwh=0.5,
            started_at=NOW,
            completed_at=NOW - timedelta(seconds=10),
        )
    )
    # duration_seconds None with no timestamps → excluded.
    db_session.add(_run(p_main.id, "completed", duration_seconds=None, energy_kwh=0.5))
    # "failed" status is included by _FAILED_STATUSES; "aborted" too.
    db_session.add(_run(p_main.id, "failed", duration_seconds=3600, energy_kwh=0.2))
    db_session.add(_run(p_main.id, "aborted", duration_seconds=3600, energy_kwh=0.2))
    # "cancelled"/"skipped" are neither completed nor a failed status → excluded (unchanged filter).
    db_session.add(_run(p_main.id, "cancelled", duration_seconds=3600, energy_kwh=0.2))

    # MIN_SAMPLE (5) per-printer gate, isolated printers, safely mid-band values.
    p4 = await printer_factory()
    for _ in range(4):
        db_session.add(_run(p4.id, "completed", duration_seconds=3600, energy_kwh=0.2))

    p5 = await printer_factory()
    for _ in range(5):
        db_session.add(_run(p5.id, "completed", duration_seconds=3600, energy_kwh=0.2))

    p6 = await printer_factory()
    for _ in range(6):
        db_session.add(_run(p6.id, "completed", duration_seconds=3600, energy_kwh=0.2))

    await db_session.commit()
    return since


@pytest.mark.asyncio
async def test_time_accuracy_matches_reference_implementation_exactly(printer_factory, archive_factory, db_session):
    since = await _build_time_accuracy_dataset(printer_factory, archive_factory, db_session)

    new_result = await calculator_insights_service._time_accuracy(db_session, since)
    old_result = await _reference_time_accuracy(db_session, since)

    assert new_result == old_result
    # Sanity: the dataset actually reaches every gate/edge it claims to (a
    # differential test that never varies its inputs proves nothing).
    assert new_result["sample"] >= 6  # 4 baseline + 2 band-inclusive edges (fallback-branch rows also add in)
    assert len(new_result["by_printer"]) >= 3  # p_main, p_exact, p_high all clear the >=3 gate


@pytest.mark.asyncio
async def test_power_draw_matches_reference_implementation_exactly(printer_factory, db_session):
    since = await _build_power_draw_dataset(printer_factory, db_session)

    new_result = await calculator_insights_service._power_draw(db_session, since)
    old_result = await _reference_power_draw(db_session, since)

    assert new_result == old_result
    # Sanity: p5 and p6 (>= MIN_SAMPLE) must appear, p4 (< MIN_SAMPLE) must not.
    samples_by_printer = {row["sample"] for row in new_result}
    assert any(sample >= MIN_SAMPLE for sample in samples_by_printer)
    assert len(new_result) >= 3  # p_main, p5, p6


# --- T-087: `_resolve_duration`'s started_at/completed_at fallback ----------
#
# The differential tests above mix fallback rows into a larger dataset and
# only assert loose bounds (`>= 6`, `>= 3`). These two isolate the fallback
# branch on its own -- every row's `duration_seconds` is None, so the only
# way any of them contribute is via `_resolve_duration`'s elapsed-time
# computation -- and assert the exact figures produced, through the real
# HTTP route (not the service method directly).


@pytest.mark.asyncio
@pytest.mark.integration
async def test_time_accuracy_resolved_purely_from_timestamp_fallback(
    async_client: AsyncClient, printer_factory, archive_factory, db_session
):
    printer = await printer_factory()
    archive = await archive_factory(printer.id, print_time_seconds=3600, with_run=False)  # 1h slicer estimate
    # Three runs with NO duration_seconds at all -- only started_at/completed_at.
    # Elapsed = 7200s (2h) each, so accuracy = 3600/7200*100 = 50.0%.
    for _ in range(3):
        db_session.add(
            _run(
                printer.id,
                "completed",
                archive_id=archive.id,
                duration_seconds=None,
                started_at=NOW - timedelta(seconds=7200),
                completed_at=NOW,
            )
        )
    # A clock-skew row: completed_at <= started_at -> `_resolve_duration`
    # returns None -> must be silently excluded, not counted and not
    # corrupting the average (e.g. via a negative or zero actual_seconds).
    db_session.add(
        _run(
            printer.id,
            "completed",
            archive_id=archive.id,
            duration_seconds=None,
            started_at=NOW,
            completed_at=NOW - timedelta(seconds=10),
        )
    )
    await db_session.commit()

    response = await async_client.get("/api/v1/calculator/insights")
    acc = response.json()["time_accuracy"]
    assert acc["overall_pct"] == 50.0
    assert acc["sample"] == 3
    assert acc["by_printer"][0]["accuracy_pct"] == 50.0
    assert acc["by_printer"][0]["sample"] == 3


@pytest.mark.asyncio
@pytest.mark.integration
async def test_power_draw_resolved_purely_from_timestamp_fallback(
    async_client: AsyncClient, printer_factory, db_session
):
    printer = await printer_factory()
    # Five runs with NO duration_seconds -- only started_at/completed_at.
    # Elapsed = 3600s (1h) each, energy 0.2 kWh -> implied 200 W. Five clears
    # MIN_SAMPLE (5).
    for _ in range(5):
        db_session.add(
            _run(
                printer.id,
                "completed",
                duration_seconds=None,
                energy_kwh=0.2,
                started_at=NOW - timedelta(seconds=3600),
                completed_at=NOW,
            )
        )
    # Clock-skew row: completed_at <= started_at -> `_resolve_duration`
    # returns None -> excluded rather than dragging the average toward a
    # bogus (near-infinite or negative) implied wattage.
    db_session.add(
        _run(
            printer.id,
            "completed",
            duration_seconds=None,
            energy_kwh=0.2,
            started_at=NOW,
            completed_at=NOW - timedelta(seconds=10),
        )
    )
    await db_session.commit()

    response = await async_client.get("/api/v1/calculator/insights")
    rows = response.json()["power_by_printer"]
    assert len(rows) == 1
    assert rows[0]["avg_watts"] == 200.0
    assert rows[0]["sample"] == 5


# --- T-087 (reopened): `_resolve_duration` direct unit tests ----------------
#
# The route-level fallback tests above mix `duration_seconds` in with the
# accuracy/watts band checks, which silently discard any row whose resolved
# duration goes negative or otherwise out-of-band — so a broken clock-skew
# guard or a broken zero-vs-None branch produces the same route output either
# way. These call `_resolve_duration` directly so no downstream filtering can
# mask a broken guard.


def test_resolve_duration_returns_duration_seconds_as_is_when_truthy():
    assert _resolve_duration(1234, None, None) == 1234


def test_resolve_duration_returns_negative_duration_seconds_unchanged():
    # Current behavior: a negative *stored* duration is not validated here —
    # it is merely truthy, so it passes straight through unchanged.
    assert _resolve_duration(-5, None, None) == -5


def test_resolve_duration_falls_back_to_elapsed_when_duration_seconds_is_zero():
    # duration_seconds == 0 is falsy, so this must take the fallback branch
    # rather than returning 0 directly.
    started = NOW - timedelta(seconds=100)
    completed = NOW
    assert _resolve_duration(0, started, completed) == 100


def test_resolve_duration_falls_back_to_elapsed_when_duration_seconds_is_none():
    started = NOW - timedelta(seconds=250)
    completed = NOW
    assert _resolve_duration(None, started, completed) == 250


def test_resolve_duration_returns_none_when_elapsed_is_exactly_zero():
    assert _resolve_duration(None, NOW, NOW) is None


def test_resolve_duration_returns_none_when_elapsed_is_negative():
    assert _resolve_duration(None, NOW, NOW - timedelta(seconds=10)) is None


def test_resolve_duration_returns_none_when_started_at_missing():
    assert _resolve_duration(None, None, NOW) is None


def test_resolve_duration_returns_none_when_completed_at_missing():
    assert _resolve_duration(None, NOW - timedelta(seconds=10), None) is None


def test_resolve_duration_truncates_fractional_elapsed_seconds():
    started = NOW
    completed = NOW + timedelta(seconds=100, microseconds=999000)  # 100.999s
    assert _resolve_duration(None, started, completed) == 100


# --- `_split_materials` direct unit tests ------------------------------------
#
# Not touched by mutation (i)/(ii) above, but checked separately per the task
# brief: a mutation that drops the `if part.strip()` filter (letting empty
# segments through as `""`) also survives the whole file untouched, so it is
# similarly only reachable via a direct test.


def test_split_materials_returns_empty_list_for_none():
    assert _split_materials(None) == []


def test_split_materials_returns_empty_list_for_empty_string():
    assert _split_materials("") == []


def test_split_materials_splits_uppercases_dedupes_and_sorts():
    assert _split_materials("pla, ABS,pla, petg") == ["ABS", "PETG", "PLA"]


def test_split_materials_drops_empty_segments():
    assert _split_materials("PLA,, ,PETG") == ["PETG", "PLA"]


# --- T-102: `_printer_names` unknown-printer fallback ------------------------
#
# `printer_names.get(printer_id, f"#{printer_id}")` is called at four sites
# (_failure_rates, _time_accuracy, _power_draw, _daily_usage). Every existing
# test logs runs against a printer created via `printer_factory`, i.e. a real
# `Printer` row, so `printer_names.get(...)` always hits and the `f"#{id}"`
# default is never actually evaluated anywhere in the suite. This test logs
# runs against a printer_id with NO corresponding Printer row (simulating a
# printer that was later deleted, since `printer_id` carries no FK) and
# checks the fallback fires at all four sites, in one shared dataset: one
# printer_id, one dataset, one GET, four assertions. `_time_accuracy` and
# `_power_draw` pre-filter in SQL (see calculator_insights.py), so every row
# below is deliberately placed in-band (accuracy 100%, watts 200, duration
# within both the power and staleness bounds) rather than relying on the
# Python fold to save an out-of-band row.


@pytest.mark.asyncio
@pytest.mark.integration
async def test_unknown_printer_falls_back_to_hash_id_label(async_client: AsyncClient, archive_factory, db_session):
    deleted_printer_id = 987654  # no Printer row exists with this id

    # _time_accuracy: 3 runs (the per-printer >=3 gate), accuracy 100% (in-band).
    archive = await archive_factory(deleted_printer_id, print_time_seconds=3600, with_run=False)
    for _ in range(3):
        db_session.add(_run(deleted_printer_id, "completed", archive_id=archive.id, duration_seconds=3600))

    # _power_draw: 5 runs (MIN_SAMPLE), duration 3600s / 0.2 kWh -> 200 W (in-band).
    for _ in range(5):
        db_session.add(_run(deleted_printer_id, "completed", duration_seconds=3600, energy_kwh=0.2))

    # _daily_usage: 10 runs of 6h spread over 20 observed days (>= _MIN_USAGE_DAYS).
    for i in range(10):
        db_session.add(
            _run(
                deleted_printer_id,
                "completed",
                duration_seconds=21600,
                created_at=NOW - timedelta(days=20 - i),
            )
        )
    await db_session.commit()

    response = await async_client.get("/api/v1/calculator/insights")
    data = response.json()
    expected_name = f"#{deleted_printer_id}"

    # All 18 runs above are "completed", so _failure_rates' MIN_SAMPLE (5) is
    # cleared for this printer_id too — one dataset pins all four sites.
    failure_row = next(r for r in data["failure"]["by_printer"] if r["printer_id"] == deleted_printer_id)
    assert failure_row["printer_name"] == expected_name
    assert failure_row["sample"] == 18

    accuracy_row = data["time_accuracy"]["by_printer"][0]
    assert accuracy_row["printer_id"] == deleted_printer_id
    assert accuracy_row["printer_name"] == expected_name
    assert accuracy_row["sample"] == 3

    power_row = data["power_by_printer"][0]
    assert power_row["printer_id"] == deleted_printer_id
    assert power_row["printer_name"] == expected_name
    assert power_row["sample"] == 5

    # `_daily_usage` groups by printer_id alone (no archive_id/energy_kwh
    # filter), so it also sums the 3 time-accuracy rows and the 5 power-draw
    # rows above (all `duration_seconds`-bearing, all "completed"): sample
    # 3 + 5 + 10 = 18, total 3*3600 + 5*3600 + 10*21600 = 244800s over the
    # 20 observed days set by the earliest usage row -> 3.4 h/day.
    usage_row = data["usage_by_printer"][0]
    assert usage_row["printer_id"] == deleted_printer_id
    assert usage_row["printer_name"] == expected_name
    assert usage_row["sample"] == 18
    assert usage_row["hours_per_day"] == 3.4
    assert usage_row["observed_days"] == 20


# --- T-105: band/threshold constants — literal + behavioural pins ----------
#
# The differential tests above (and the reference implementations they
# compare against) IMPORT these constants directly, so a change to a
# constant shifts production and reference identically and neither side
# notices — mutation-proven: `_ACCURACY_BAND_HI` 200.0 -> 150.0 leaves the
# whole suite green. These tests pin each band two ways: a literal
# assertion (fails on ANY edit, doesn't say why the number is right) and,
# for every band, a behavioural pair through the aggregate's real output —
# a row sitting exactly ON the bound is INCLUDED, one just outside is
# EXCLUDED — with the fixture values hardcoded rather than derived from the
# imported constant, so widening/narrowing the band changes what comes out
# even if the literal assertion is "helpfully" updated to match.
#
# `_time_accuracy` and `_power_draw` pre-filter rows in SQL before the
# Python fold (see calculator_insights.py), so every fixture row here sits
# in-band on every OTHER dimension (duration, watts, accuracy) to avoid the
# query silently dropping it for the wrong reason.


def test_band_threshold_constants_have_expected_values():
    assert _ACCURACY_BAND_LO == 50.0
    assert _ACCURACY_BAND_HI == 200.0
    assert _WATTS_BAND_LO == 1.0
    assert _WATTS_BAND_HI == 3000.0
    assert _MIN_POWER_SECONDS == 300
    assert _MAX_PRINT_SECONDS == 4 * 24 * 3600


# _ACCURACY_BAND_LO / _ACCURACY_BAND_HI, via `_time_accuracy` (`overall_pct`
# has no MIN_SAMPLE-style gate, so a single in-band row is enough to appear).


@pytest.mark.asyncio
async def test_time_accuracy_lo_bound_is_inclusive(printer_factory, archive_factory, db_session):
    since = NOW - timedelta(days=3650)
    printer = await printer_factory()
    archive = await archive_factory(printer.id, print_time_seconds=3600, with_run=False)
    # 3600 / 7200 * 100 = 50.0 exactly -- the low edge.
    db_session.add(_run(printer.id, "completed", archive_id=archive.id, duration_seconds=7200))
    await db_session.commit()

    result = await calculator_insights_service._time_accuracy(db_session, since)
    assert result["sample"] == 1
    assert result["overall_pct"] == 50.0


@pytest.mark.asyncio
async def test_time_accuracy_just_below_lo_bound_is_excluded(printer_factory, archive_factory, db_session):
    since = NOW - timedelta(days=3650)
    printer = await printer_factory()
    archive = await archive_factory(printer.id, print_time_seconds=3600, with_run=False)
    # 3600 / 7201 * 100 = 49.986...% -- just under the low edge.
    db_session.add(_run(printer.id, "completed", archive_id=archive.id, duration_seconds=7201))
    await db_session.commit()

    result = await calculator_insights_service._time_accuracy(db_session, since)
    assert result["sample"] == 0
    assert result["overall_pct"] is None


@pytest.mark.asyncio
async def test_time_accuracy_hi_bound_is_inclusive(printer_factory, archive_factory, db_session):
    since = NOW - timedelta(days=3650)
    printer = await printer_factory()
    archive = await archive_factory(printer.id, print_time_seconds=3600, with_run=False)
    # 3600 / 1800 * 100 = 200.0 exactly -- the high edge.
    db_session.add(_run(printer.id, "completed", archive_id=archive.id, duration_seconds=1800))
    await db_session.commit()

    result = await calculator_insights_service._time_accuracy(db_session, since)
    assert result["sample"] == 1
    assert result["overall_pct"] == 200.0


@pytest.mark.asyncio
async def test_time_accuracy_just_above_hi_bound_is_excluded(printer_factory, archive_factory, db_session):
    since = NOW - timedelta(days=3650)
    printer = await printer_factory()
    archive = await archive_factory(printer.id, print_time_seconds=3600, with_run=False)
    # 3600 / 1799 * 100 = 200.11...% -- just over the high edge.
    db_session.add(_run(printer.id, "completed", archive_id=archive.id, duration_seconds=1799))
    await db_session.commit()

    result = await calculator_insights_service._time_accuracy(db_session, since)
    assert result["sample"] == 0
    assert result["overall_pct"] is None


# _WATTS_BAND_LO / _WATTS_BAND_HI, via `_power_draw`. A printer only
# appears in the output once its sample clears MIN_SAMPLE, so each test adds
# 4 safely-mid-band baseline rows (200 W) and one boundary row: included ->
# sample 5 with the printer present; excluded -> sample stuck at 4, printer
# absent entirely.


@pytest.mark.asyncio
async def test_power_draw_watts_lo_bound_is_inclusive(printer_factory, db_session):
    since = NOW - timedelta(days=3650)
    printer = await printer_factory()
    for _ in range(4):
        db_session.add(_run(printer.id, "completed", duration_seconds=3600, energy_kwh=0.2))  # 200 W, mid-band
    # 0.001 kWh over 1h -> 1.0 W exactly -- the low edge.
    db_session.add(_run(printer.id, "completed", duration_seconds=3600, energy_kwh=0.001))
    await db_session.commit()

    result = await calculator_insights_service._power_draw(db_session, since)
    assert len(result) == 1
    assert result[0]["sample"] == 5


@pytest.mark.asyncio
async def test_power_draw_just_below_watts_lo_bound_is_excluded(printer_factory, db_session):
    since = NOW - timedelta(days=3650)
    printer = await printer_factory()
    for _ in range(4):
        db_session.add(_run(printer.id, "completed", duration_seconds=3600, energy_kwh=0.2))  # 200 W, mid-band
    # 0.000999 kWh over 1h -> 0.999 W -- just under the low edge.
    db_session.add(_run(printer.id, "completed", duration_seconds=3600, energy_kwh=0.000999))
    await db_session.commit()

    result = await calculator_insights_service._power_draw(db_session, since)
    assert result == []


@pytest.mark.asyncio
async def test_power_draw_watts_hi_bound_is_inclusive(printer_factory, db_session):
    since = NOW - timedelta(days=3650)
    printer = await printer_factory()
    for _ in range(4):
        db_session.add(_run(printer.id, "completed", duration_seconds=3600, energy_kwh=0.2))  # 200 W, mid-band
    # 3.0 kWh over 1h -> 3000.0 W exactly -- the high edge.
    db_session.add(_run(printer.id, "completed", duration_seconds=3600, energy_kwh=3.0))
    await db_session.commit()

    result = await calculator_insights_service._power_draw(db_session, since)
    assert len(result) == 1
    assert result[0]["sample"] == 5


@pytest.mark.asyncio
async def test_power_draw_just_above_watts_hi_bound_is_excluded(printer_factory, db_session):
    since = NOW - timedelta(days=3650)
    printer = await printer_factory()
    for _ in range(4):
        db_session.add(_run(printer.id, "completed", duration_seconds=3600, energy_kwh=0.2))  # 200 W, mid-band
    # 3.001 kWh over 1h -> 3001.0 W -- just over the high edge.
    db_session.add(_run(printer.id, "completed", duration_seconds=3600, energy_kwh=3.001))
    await db_session.commit()

    result = await calculator_insights_service._power_draw(db_session, since)
    assert result == []


# _MIN_POWER_SECONDS / _MAX_PRINT_SECONDS, via `_power_draw`. Same
# 4-baseline + 1-boundary shape; the boundary row's `energy_kwh` is chosen
# so its implied watts stay safely inside the watts band regardless of the
# duration edge under test.


@pytest.mark.asyncio
async def test_power_draw_min_duration_bound_is_inclusive(printer_factory, db_session):
    since = NOW - timedelta(days=3650)
    printer = await printer_factory()
    for _ in range(4):
        db_session.add(_run(printer.id, "completed", duration_seconds=3600, energy_kwh=0.2))  # 200 W, mid-band
    # duration_seconds = 300 (the low edge); 0.2 kWh over 300s -> 2400 W (in watts-band).
    db_session.add(_run(printer.id, "completed", duration_seconds=300, energy_kwh=0.2))
    await db_session.commit()

    result = await calculator_insights_service._power_draw(db_session, since)
    assert len(result) == 1
    assert result[0]["sample"] == 5


@pytest.mark.asyncio
async def test_power_draw_just_below_min_duration_bound_is_excluded(printer_factory, db_session):
    since = NOW - timedelta(days=3650)
    printer = await printer_factory()
    for _ in range(4):
        db_session.add(_run(printer.id, "completed", duration_seconds=3600, energy_kwh=0.2))  # 200 W, mid-band
    # duration_seconds = 299 -- just under the low edge.
    db_session.add(_run(printer.id, "completed", duration_seconds=299, energy_kwh=0.2))
    await db_session.commit()

    result = await calculator_insights_service._power_draw(db_session, since)
    assert result == []


@pytest.mark.asyncio
async def test_power_draw_max_duration_bound_is_inclusive(printer_factory, db_session):
    since = NOW - timedelta(days=3650)
    printer = await printer_factory()
    for _ in range(4):
        db_session.add(_run(printer.id, "completed", duration_seconds=3600, energy_kwh=0.2))  # 200 W, mid-band
    # duration_seconds = 345600 (4 days, the high edge); 10 kWh over 96h -> ~104.17 W (in watts-band).
    db_session.add(_run(printer.id, "completed", duration_seconds=345600, energy_kwh=10))
    await db_session.commit()

    result = await calculator_insights_service._power_draw(db_session, since)
    assert len(result) == 1
    assert result[0]["sample"] == 5


@pytest.mark.asyncio
async def test_power_draw_just_above_max_duration_bound_is_excluded(printer_factory, db_session):
    since = NOW - timedelta(days=3650)
    printer = await printer_factory()
    for _ in range(4):
        db_session.add(_run(printer.id, "completed", duration_seconds=3600, energy_kwh=0.2))  # 200 W, mid-band
    # duration_seconds = 345601 -- just over the high edge.
    db_session.add(_run(printer.id, "completed", duration_seconds=345601, energy_kwh=10))
    await db_session.commit()

    result = await calculator_insights_service._power_draw(db_session, since)
    assert result == []
