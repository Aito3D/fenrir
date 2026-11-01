"""Public showcase stats: the JSON the Shopify theme fetches (services/showcase_stats.py)."""

from datetime import datetime, timedelta

import pytest

from backend.app.models.aito_project import AitoProject
from backend.app.models.archive import PrintArchive
from backend.app.models.printer import Printer
from backend.app.services import showcase_stats as svc


def _archive(status="completed", hours=1.0, grams=100.0, layers=50, started=None, ended=None, deleted=False):
    return PrintArchive(
        printer_id=1,
        print_name="p",
        filename="p.gcode.3mf",
        file_path="",
        file_size=0,
        status=status,
        print_time_seconds=int(hours * 3600),
        filament_used_grams=grams,
        total_layers=layers,
        started_at=started,
        completed_at=ended,
        deleted_at=datetime(2026, 1, 1) if deleted else None,
    )


def _printer(i, active=True):
    return Printer(name=f"P{i}", serial_number=f"S{i}", ip_address=f"10.0.0.{i}", access_code="x", is_active=active)


async def _seed(db_session, now):
    db_session.add_all([_printer(1), _printer(2), _printer(3, active=False)])
    db_session.add_all(
        [
            # two good prints, one recent: 10 h + 2 h, 300 g + 100 g
            _archive(hours=10, grams=300, layers=100, started=now - timedelta(days=40), ended=now - timedelta(days=39)),
            _archive(hours=2, grams=100, layers=20, started=now - timedelta(hours=20), ended=now - timedelta(hours=18)),
            # a failed print: not counted as a print, but its 6 h still loads the machines today
            _archive(status="failed", hours=6, grams=50, started=now - timedelta(hours=6), ended=now),
            # a trashed archive: never counted
            _archive(hours=99, grams=9999, deleted=True),
            # a print that ended 8 days ago: outside the 7-day window, inside the 30-day one
            _archive(hours=4, grams=10, started=now - timedelta(days=8, hours=4), ended=now - timedelta(days=8)),
        ]
    )
    db_session.add_all(
        [
            AitoProject(description="quote", board_column="devis", client_name="A"),
            AitoProject(description="order", board_column="print", client_name="B"),
            AitoProject(description="delivered", board_column="done", client_name="C"),
            AitoProject(description="trashed", board_column="done", client_name="D", status="deleted"),
        ]
    )
    await db_session.commit()


@pytest.mark.asyncio
async def test_compute_counts_only_completed_prints_and_applies_the_multiplier(db_session):
    now = datetime(2026, 11, 1, 12, 0, 0)
    await _seed(db_session, now)
    s = await svc.compute(db_session, now=now)
    m = svc.MULTIPLIER
    assert m == 1.5
    assert s["prints"] == round(3 * m) + svc.PRINTS_OFFSET
    assert s["filament_kg"] == round(0.41 * m + svc.FILAMENT_KG_OFFSET, 1)  # 410 g, rounded to one decimal
    assert s["print_hours"] == round(16 * m) + svc.PRINT_HOURS_OFFSET
    assert s["print_days"] == round((16 * m + svc.PRINT_HOURS_OFFSET) / 24, 1)
    assert s["layers"] == round(170 * m) + svc.LAYERS_OFFSET
    assert s["orders"] == round(2 * m) + svc.ORDERS_OFFSET
    assert s["printers"] == 2 + svc.PRINTERS_OFFSET  # never multiplied, only offset
    assert s["since"] == svc.SINCE
    assert s["last_30_days"] == {"prints": round(2 * m), "filament_kg": round(0.11 * m, 1)}  # 2 prints, 110 g


@pytest.mark.asyncio
async def test_load_7d_is_machine_hours_in_the_week_per_active_printer_per_day(db_session):
    now = datetime(2026, 11, 1, 12, 0, 0)
    await _seed(db_session, now)
    s = await svc.compute(db_session, now=now)
    # window: 2 h (completed) + 6 h (failed); the 8-day-old print is out
    assert s["load_7d"]["machine_hours"] == pytest.approx(8.0 * svc.LOAD_FACTOR)
    assert s["load_7d"]["avg_hours_per_printer_per_day"] == pytest.approx(8 * svc.LOAD_FACTOR / 2 / 7, abs=0.05)
    assert s["load_7d"]["level"] == "low"


@pytest.mark.parametrize(
    "avg, level", [(16, "high"), (20, "high"), (8, "medium"), (15.9, "medium"), (7.9, "low"), (0, "low")]
)
def test_load_level_thresholds(avg, level):
    assert svc.load_level(avg) == level


@pytest.mark.asyncio
async def test_open_print_counts_up_to_now_but_stale_open_rows_are_ignored(db_session):
    now = datetime(2026, 11, 1, 12, 0, 0)
    db_session.add(_printer(1))
    db_session.add_all(
        [
            _archive(status="printing", hours=0, started=now - timedelta(hours=3), ended=None),
            _archive(status="printing", hours=0, started=now - timedelta(days=30), ended=None),  # never closed
        ]
    )
    await db_session.commit()
    s = await svc.compute(db_session, now=now)
    assert s["load_7d"]["machine_hours"] == pytest.approx(3.0 * svc.LOAD_FACTOR)


@pytest.mark.asyncio
async def test_route_is_public_cached_and_cors_open(async_client, db_session, monkeypatch):
    svc.reset_cache()
    await _seed(db_session, datetime(2026, 11, 1, 12, 0, 0))
    clock = {"t": 1000.0}
    monkeypatch.setattr(svc, "_clock", lambda: clock["t"])
    r = await async_client.get("/api/v1/showcase/stats")
    assert r.status_code == 200, r.text
    assert r.headers["access-control-allow-origin"] == "*"
    assert r.headers["cache-control"] == "public, max-age=300"
    first = r.json()
    assert first["prints"] == round(3 * svc.MULTIPLIER) + svc.PRINTS_OFFSET
    # a new print inside the TTL is not visible; after the TTL it is
    db_session.add(_archive(started=datetime(2026, 11, 1), ended=datetime(2026, 11, 1, 1)))
    await db_session.commit()
    clock["t"] += 299
    assert (await async_client.get("/api/v1/showcase/stats")).json()["prints"] == round(
        3 * svc.MULTIPLIER
    ) + svc.PRINTS_OFFSET
    clock["t"] += 2
    assert (await async_client.get("/api/v1/showcase/stats")).json()["prints"] == round(
        4 * svc.MULTIPLIER
    ) + svc.PRINTS_OFFSET
    svc.reset_cache()
