"""Projects as a PDM, phase 4 task 1: production traceability columns.

`revision_id` / `aito_task_id` on queue items and print archives, the
scheduler copying them onto the archive at dispatch, and the guards that keep
`cleanup_library_after_dispatch` from ever deleting a project revision file.
"""

from contextlib import ExitStack
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401 - populate Base.metadata
import backend.app.services.print_scheduler as scheduler_module
from backend.app.core.database import Base, run_migrations
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.print_scheduler import PrintScheduler
from backend.tests._fixtures.background_tasks import discarding_spawn_patch

TRACE_COLUMNS = [
    ("print_queue", "revision_id"),
    ("print_queue", "aito_task_id"),
    ("print_archives", "revision_id"),
    ("print_archives", "aito_task_id"),
]


# ---------------------------------------------------------------------------
# Columns


@pytest.mark.asyncio
async def test_trace_columns_persist(db_session):
    printer = Printer(name="P", serial_number="S-TRACE", ip_address="127.0.0.1", access_code="x", model="X1C")
    db_session.add(printer)
    await db_session.flush()
    archive = PrintArchive(
        printer_id=printer.id,
        filename="a.3mf",
        file_path="archives/a.3mf",
        file_size=1,
        status="completed",
        revision_id=11,
        aito_task_id=22,
    )
    db_session.add(archive)
    await db_session.flush()
    item = PrintQueueItem(printer_id=printer.id, archive_id=archive.id, revision_id=33, aito_task_id=44)
    db_session.add(item)
    await db_session.commit()

    archive_row = (await db_session.execute(select(PrintArchive).where(PrintArchive.id == archive.id))).scalar_one()
    item_row = (await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.id == item.id))).scalar_one()
    assert (archive_row.revision_id, archive_row.aito_task_id) == (11, 22)
    assert (item_row.revision_id, item_row.aito_task_id) == (33, 44)


# ---------------------------------------------------------------------------
# Migration


@pytest.fixture
async def legacy_engine():
    """Full schema with the four trace columns (and their indexes) dropped,
    i.e. a database that predates phase 4."""
    eng = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        for table, column in TRACE_COLUMNS:
            await conn.execute(text(f"DROP INDEX IF EXISTS ix_{table}_{column}"))
            await conn.execute(text(f"ALTER TABLE {table} DROP COLUMN {column}"))
    yield eng
    await eng.dispose()


async def _columns(conn, table):
    return {row[1] for row in (await conn.execute(text(f"PRAGMA table_info({table})"))).all()}


async def _indexes(conn, table):
    return {row[1] for row in (await conn.execute(text(f"PRAGMA index_list({table})"))).all()}


@pytest.mark.asyncio
async def test_migration_adds_columns_and_indexes_and_is_idempotent(legacy_engine):
    async with legacy_engine.connect() as conn:
        for table, column in TRACE_COLUMNS:
            assert column not in await _columns(conn, table)

    async with legacy_engine.begin() as conn:
        await run_migrations(conn)
    async with legacy_engine.begin() as conn:
        await run_migrations(conn)  # second run is a no-op

    async with legacy_engine.connect() as conn:
        for table, column in TRACE_COLUMNS:
            assert column in await _columns(conn, table)
            assert f"ix_{table}_{column}" in await _indexes(conn, table)


# ---------------------------------------------------------------------------
# POST /queue/ cleanup guard


@pytest.mark.asyncio
@pytest.mark.integration
async def test_cleanup_flag_on_revision_file_is_rejected(async_client: AsyncClient, db_session, printer_factory):
    printer = await printer_factory()
    library_file = LibraryFile(
        filename="support.3mf",
        file_path="/tmp/support.3mf",  # nosec B108 - never read
        file_type="3mf",
        file_size=1,
        revision_id=7,
    )
    db_session.add(library_file)
    await db_session.commit()

    response = await async_client.post(
        "/api/v1/queue/",
        json={"printer_id": printer.id, "library_file_id": library_file.id, "cleanup_library_after_dispatch": True},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "Project files are never deleted after printing"

    # Without the flag the same file queues fine.
    response = await async_client.post(
        "/api/v1/queue/", json={"printer_id": printer.id, "library_file_id": library_file.id}
    )
    assert response.status_code == 200


# ---------------------------------------------------------------------------
# Scheduler (fixtures modelled on test_scheduler_cleanup_library.py)


@pytest.fixture
async def session_maker():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


async def _make_library_case(session_maker, base_dir: Path, *, revision_id, aito_task_id, cleanup):
    source_path = base_dir / "library" / "support.3mf"
    source_path.parent.mkdir(parents=True)
    source_path.write_bytes(b"library source")
    async with session_maker() as db:
        printer = Printer(name="P", serial_number="S-1", ip_address="127.0.0.1", access_code="x", model="X1C")
        library_file = LibraryFile(
            filename="support.3mf",
            file_path=str(source_path),
            file_type="3mf",
            file_size=source_path.stat().st_size,
            revision_id=revision_id,
        )
        db.add_all([printer, library_file])
        await db.flush()
        item = PrintQueueItem(
            printer_id=printer.id,
            library_file_id=library_file.id,
            status="pending",
            cleanup_library_after_dispatch=cleanup,
            revision_id=revision_id,
            aito_task_id=aito_task_id,
        )
        db.add(item)
        await db.commit()
        return item.id, library_file.id, source_path


async def _dispatch(session_maker, base_dir: Path, queue_item_id: int):
    scheduler = PrintScheduler()

    async def archive_print(
        self,
        *,
        printer_id,
        source_file,
        original_filename,
        created_by_id=None,
        project_id=None,
        cost_center_id=None,
        plate_id=None,
        library_file_id=None,
    ):
        rel = Path("archives") / f"archive-{queue_item_id}.3mf"
        (base_dir / rel).parent.mkdir(parents=True, exist_ok=True)
        (base_dir / rel).write_bytes(Path(source_file).read_bytes())
        archive = PrintArchive(
            printer_id=printer_id,
            filename=original_filename,
            file_path=str(rel),
            file_size=1,
            status="printing",
            project_id=project_id,
            library_file_id=library_file_id,
        )
        self.db.add(archive)
        await self.db.flush()
        return archive

    patches = [
        patch.object(scheduler_module.settings, "base_dir", base_dir),
        patch.object(scheduler_module.settings, "archive_dir", base_dir / "archive"),
        patch("backend.app.services.archive.ArchiveService.archive_print", new=archive_print),
        patch("backend.app.services.print_scheduler.printer_manager.is_connected", MagicMock(return_value=True)),
        patch("backend.app.services.print_scheduler.printer_manager.get_status", MagicMock(return_value=None)),
        patch("backend.app.services.print_scheduler.printer_manager.start_print", MagicMock(return_value=True)),
        patch("backend.app.services.print_scheduler.printer_manager.set_awaiting_plate_clear", MagicMock()),
        patch(
            "backend.app.services.print_scheduler.get_ftp_retry_settings", AsyncMock(return_value=(False, 0, 0, 1.0))
        ),
        patch("backend.app.services.print_scheduler.delete_file_async", AsyncMock(return_value=True)),
        patch("backend.app.services.print_scheduler.upload_file_async", AsyncMock(return_value=True)),
        patch("backend.app.services.print_scheduler.cache_3mf_download", MagicMock()),
        discarding_spawn_patch(),
        patch("backend.app.services.notification_service.notification_service.on_queue_job_started", AsyncMock()),
        patch("backend.app.services.notification_service.notification_service.on_queue_job_failed", AsyncMock()),
        patch("backend.app.services.mqtt_relay.mqtt_relay.on_queue_job_started", AsyncMock()),
        patch.object(scheduler, "_propagate_owner_to_printer_manager", AsyncMock()),
        patch.object(scheduler, "_power_off_if_needed", AsyncMock()),
    ]
    with ExitStack() as stack:
        for patcher in patches:
            stack.enter_context(patcher)
        async with session_maker() as db:
            item = await db.get(PrintQueueItem, queue_item_id)
            await scheduler._start_print(db, item)


@pytest.mark.asyncio
async def test_start_print_copies_trace_ids_onto_new_archive(session_maker, tmp_path):
    item_id, _file_id, _src = await _make_library_case(
        session_maker, tmp_path, revision_id=5, aito_task_id=9, cleanup=False
    )
    await _dispatch(session_maker, tmp_path, item_id)

    async with session_maker() as db:
        item = await db.get(PrintQueueItem, item_id)
        assert item.archive_id is not None
        archive = await db.get(PrintArchive, item.archive_id)
        assert (archive.revision_id, archive.aito_task_id) == (5, 9)


@pytest.mark.asyncio
async def test_forced_cleanup_flag_never_deletes_a_revision_file(session_maker, tmp_path):
    item_id, file_id, source_path = await _make_library_case(
        session_maker, tmp_path, revision_id=5, aito_task_id=None, cleanup=True
    )
    await _dispatch(session_maker, tmp_path, item_id)

    async with session_maker() as db:
        item = await db.get(PrintQueueItem, item_id)
        assert item.archive_id is not None
        assert item.library_file_id == file_id
        assert await db.get(LibraryFile, file_id) is not None
    assert source_path.exists()


async def _make_archive_case(session_maker, *, archive_revision, archive_task, item_revision, item_task):
    async with session_maker() as db:
        printer = Printer(name="P", serial_number="S-2", ip_address="127.0.0.1", access_code="x", model="X1C")
        db.add(printer)
        await db.flush()
        archive = PrintArchive(
            printer_id=printer.id,
            filename="old.3mf",
            file_path="archives/old.3mf",
            file_size=1,
            status="completed",
            revision_id=archive_revision,
            aito_task_id=archive_task,
        )
        db.add(archive)
        await db.flush()
        item = PrintQueueItem(
            printer_id=printer.id,
            archive_id=archive.id,
            status="pending",
            revision_id=item_revision,
            aito_task_id=item_task,
        )
        db.add(item)
        await db.commit()
        return item.id, archive.id


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("archive_ids", "item_ids", "expected"),
    [
        ((None, None), (5, 9), (5, 9)),  # archive has none: copied
        ((3, 4), (5, 9), (3, 4)),  # archive already traced: kept
    ],
)
async def test_reprint_copies_trace_ids_only_when_archive_has_none(
    session_maker, tmp_path, archive_ids, item_ids, expected
):
    (tmp_path / "archives").mkdir()
    (tmp_path / "archives" / "old.3mf").write_bytes(b"old")
    item_id, archive_id = await _make_archive_case(
        session_maker,
        archive_revision=archive_ids[0],
        archive_task=archive_ids[1],
        item_revision=item_ids[0],
        item_task=item_ids[1],
    )
    await _dispatch(session_maker, tmp_path, item_id)

    async with session_maker() as db:
        archive = await db.get(PrintArchive, archive_id)
        assert (archive.revision_id, archive.aito_task_id) == expected


@pytest.mark.asyncio
@pytest.mark.integration
async def test_cleanup_flag_on_revision_variant_is_rejected(async_client: AsyncClient, db_session, printer_factory):
    await printer_factory(model="X1C")
    library_file = LibraryFile(
        filename="support.3mf",
        file_path="/tmp/support.3mf",  # nosec B108 - never read
        file_type="3mf",
        file_size=1,
        revision_id=7,
    )
    db_session.add(library_file)
    await db_session.commit()

    payload = {
        "variants": [{"library_file_id": library_file.id, "target_model": "X1C"}],
        "cleanup_library_after_dispatch": True,
    }
    response = await async_client.post("/api/v1/queue/", json=payload)
    assert response.status_code == 400
    assert response.json()["detail"] == "Project files are never deleted after printing"

    payload["cleanup_library_after_dispatch"] = False
    response = await async_client.post("/api/v1/queue/", json=payload)
    assert response.status_code == 200, response.text
