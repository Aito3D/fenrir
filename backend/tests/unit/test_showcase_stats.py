"""Public showcase stats: the JSON the Shopify theme fetches (services/showcase_stats.py)."""

from datetime import datetime, timedelta

import pytest

from backend.app.models.aito_project import AitoProject
from backend.app.models.archive import PrintArchive
from backend.app.models.print_log import PrintLogEntry
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


def _log(status="completed", hours=1.0, grams=100.0, started=None, ended=None, at=None, duration=True):
    """A print-log row: what the Statistics page (and now the showcase) counts."""
    return PrintLogEntry(
        printer_id=1,
        print_name="p",
        status=status,
        started_at=started,
        completed_at=ended,
        duration_seconds=int(hours * 3600) if duration else None,
        filament_used_grams=grams,
        created_at=at or ended or datetime(2026, 1, 1),
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
            # the print log behind the archives above (the trashed one was purged with its stats);
            # every status counts, like the Statistics page
            _log(hours=10, grams=300, ended=now - timedelta(days=39)),
            _log(hours=2, grams=100, ended=now - timedelta(hours=18)),
            _log(status="failed", hours=6, grams=50, ended=now),
            # a legacy row without a stored duration: started -> completed is used instead
            _log(
                hours=4,
                grams=10,
                started=now - timedelta(days=8, hours=4),
                ended=now - timedelta(days=8),
                duration=False,
            ),
            # an archive deleted long ago: its log row still counts
            _log(hours=1, grams=20, ended=now - timedelta(days=400)),
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
async def test_compute_counts_the_print_log_like_the_statistics_page_and_applies_the_multiplier(db_session):
    now = datetime(2026, 11, 1, 12, 0, 0)
    await _seed(db_session, now)
    s = await svc.compute(db_session, now=now)
    m = svc.MULTIPLIER
    assert m == 1.5
    # 5 log rows (failed and archive-less ones included), 23 h, 480 g
    assert s["prints"] == round(5 * m) + svc.PRINTS_OFFSET
    assert s["filament_kg"] == round(0.48 * m + svc.FILAMENT_KG_OFFSET, 1)
    assert s["print_hours"] == round(23 * m) + svc.PRINT_HOURS_OFFSET
    assert s["print_days"] == round((23 * m + svc.PRINT_HOURS_OFFSET) / 24, 1)
    assert s["layers"] == round(170 * m) + svc.LAYERS_OFFSET  # completed, non-trashed archives
    assert s["orders"] == round(2 * m) + svc.ORDERS_OFFSET
    assert s["printers"] == 2 + svc.PRINTERS_OFFSET  # never multiplied, only offset
    assert s["since"] == svc.SINCE
    assert s["last_30_days"] == {"prints": round(3 * m), "filament_kg": round(0.16 * m, 1)}  # 3 rows, 160 g


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


@pytest.fixture
def served_from_test_engine(test_engine, monkeypatch):
    """Point the service's own recompute at the test engine (the route opens no
    session of its own) and freeze its clock."""
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    svc.reset_cache()
    monkeypatch.setattr(
        svc, "_session_factory", async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    )
    clock = {"t": 1000.0}
    monkeypatch.setattr(svc, "_clock", lambda: clock["t"])
    yield clock
    svc.reset_cache()


@pytest.mark.asyncio
async def test_route_is_public_cached_and_cors_open(async_client, db_session, served_from_test_engine):
    clock = served_from_test_engine
    await _seed(db_session, datetime(2026, 11, 1, 12, 0, 0))
    r = await async_client.get("/api/v1/showcase/stats")
    assert r.status_code == 200, r.text
    assert r.headers["access-control-allow-origin"] == "*"
    assert r.headers["cache-control"] == "public, max-age=300"
    assert r.headers["content-type"] == "application/json"
    first = r.json()
    assert first["prints"] == round(5 * svc.MULTIPLIER) + svc.PRINTS_OFFSET
    # a new print inside the TTL is not visible; after the TTL it is
    db_session.add(_log(ended=datetime(2026, 11, 1, 1)))
    await db_session.commit()
    clock["t"] += 299
    assert (await async_client.get("/api/v1/showcase/stats")).json()["prints"] == round(
        5 * svc.MULTIPLIER
    ) + svc.PRINTS_OFFSET
    clock["t"] += 2
    assert (await async_client.get("/api/v1/showcase/stats")).json()["prints"] == round(
        6 * svc.MULTIPLIER
    ) + svc.PRINTS_OFFSET


@pytest.mark.asyncio
async def test_conditional_request_gets_an_empty_304(async_client, db_session, served_from_test_engine):
    await _seed(db_session, datetime(2026, 11, 1, 12, 0, 0))
    r = await async_client.get("/api/v1/showcase/stats")
    etag = r.headers["etag"]
    assert etag.startswith('"') and len(etag) == 34
    r2 = await async_client.get("/api/v1/showcase/stats", headers={"If-None-Match": etag})
    assert r2.status_code == 304
    assert r2.content == b""
    assert r2.headers["etag"] == etag
    assert r2.headers["cache-control"] == "public, max-age=300"


@pytest.mark.asyncio
async def test_concurrent_misses_recompute_once(db_session, served_from_test_engine, monkeypatch):
    import asyncio

    await _seed(db_session, datetime(2026, 11, 1, 12, 0, 0))
    calls = 0
    real = svc.compute

    async def counting(db, now=None):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.05)  # let the other waiters pile up behind the lock
        return await real(db, now)

    monkeypatch.setattr(svc, "compute", counting)
    snaps = await asyncio.gather(*(svc.get_cached() for _ in range(20)))
    assert calls == 1
    assert len({s.etag for s in snaps}) == 1


@pytest.mark.asyncio
async def test_failed_recompute_keeps_serving_the_last_snapshot(
    async_client, db_session, served_from_test_engine, monkeypatch
):
    clock = served_from_test_engine
    await _seed(db_session, datetime(2026, 11, 1, 12, 0, 0))
    good = (await async_client.get("/api/v1/showcase/stats")).json()

    async def boom(db, now=None):
        raise RuntimeError("db down")

    monkeypatch.setattr(svc, "compute", boom)
    clock["t"] += 301
    r = await async_client.get("/api/v1/showcase/stats")
    assert r.status_code == 200
    assert r.json() == good
    assert "db down" not in r.text


@pytest.mark.asyncio
async def test_no_snapshot_and_a_failure_is_a_bodiless_503(async_client, served_from_test_engine, monkeypatch):
    async def boom(db, now=None):
        raise RuntimeError("db down")

    monkeypatch.setattr(svc, "compute", boom)
    r = await async_client.get("/api/v1/showcase/stats")
    assert r.status_code == 503
    assert r.content == b""
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["retry-after"] == "60"
