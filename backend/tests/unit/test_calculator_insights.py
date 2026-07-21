"""Tests for GET /api/v1/calculator/insights (measured reality-check figures)."""

from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient

from backend.app.models.print_log import PrintLogEntry
from backend.app.models.spool import Spool

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
async def test_time_accuracy_with_band_clamp(
    async_client: AsyncClient, printer_factory, archive_factory, db_session
):
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
    db_session.add(Spool(material="PLA", cost_per_kg=20.0))
    db_session.add(Spool(material="pla", cost_per_kg=30.0))
    db_session.add(Spool(material="PETG", cost_per_kg=18.0))
    db_session.add(Spool(material="ABS"))  # no cost — excluded
    db_session.add(Spool(material="PLA", cost_per_kg=99.0, archived_at=NOW))  # archived — excluded
    await db_session.commit()

    response = await async_client.get("/api/v1/calculator/insights")
    rows = {r["material"]: r for r in response.json()["spool_cost_by_material"]}
    assert rows["PLA"]["avg_cost_per_kg"] == 25.0
    assert rows["PLA"]["sample"] == 2
    assert rows["PETG"]["avg_cost_per_kg"] == 18.0
