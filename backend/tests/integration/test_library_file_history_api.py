"""Tests for GET /api/v1/library/files/{id}/history (file history timeline).

Print runs are matched to library files through content hashes
(PrintArchive.content_hash == LibraryFile.file_hash), with print-log entries
providing the per-run rows and the archive itself as fallback when no log
entry exists. Pending/printing queue items appear as "queued" events.
"""

from datetime import datetime, timezone

import pytest
from httpx import AsyncClient

from backend.app.models.library import LibraryFile
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.print_queue import PrintQueueItem

HASH_A = "a" * 64
HASH_B = "b" * 64


@pytest.fixture
async def file_factory(db_session):
    """Factory to create library files."""
    _counter = [0]

    async def _create_file(**kwargs):
        _counter[0] += 1
        counter = _counter[0]
        defaults = {
            "filename": f"history_test_{counter}.gcode.3mf",
            "file_path": f"/test/path/history_test_{counter}.gcode.3mf",
            "file_size": 1024,
            "file_type": "3mf",
            "file_hash": HASH_A,
        }
        defaults.update(kwargs)
        lib_file = LibraryFile(**defaults)
        db_session.add(lib_file)
        await db_session.commit()
        await db_session.refresh(lib_file)
        return lib_file

    return _create_file


@pytest.mark.asyncio
@pytest.mark.integration
async def test_history_never_printed(async_client: AsyncClient, file_factory):
    """A hashed file with no prints returns just the provenance."""
    lib_file = await file_factory()
    response = await async_client.get(f"/api/v1/library/files/{lib_file.id}/history")
    assert response.status_code == 200
    data = response.json()
    assert data["file_id"] == lib_file.id
    assert data["filename"] == lib_file.filename
    assert data["history_available"] is True
    assert data["added_at"] is not None
    assert data["total_prints"] == 0
    assert data["success_count"] == 0
    assert data["events"] == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_history_external_file_without_hash(async_client: AsyncClient, file_factory):
    """External files skip hashing — history_available is False."""
    lib_file = await file_factory(file_hash=None, is_external=True)
    response = await async_client.get(f"/api/v1/library/files/{lib_file.id}/history")
    assert response.status_code == 200
    data = response.json()
    assert data["history_available"] is False
    assert data["events"] == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_history_missing_file_404(async_client: AsyncClient):
    response = await async_client.get("/api/v1/library/files/999999/history")
    assert response.status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
async def test_history_matches_runs_by_hash(
    async_client: AsyncClient, file_factory, archive_factory, printer_factory
):
    """Log entries of hash-matching archives become print events; other hashes don't."""
    printer = await printer_factory()
    lib_file = await file_factory()
    await archive_factory(
        printer.id,
        content_hash=HASH_A,
        status="completed",
        started_at=datetime(2026, 6, 1, 10, 0),
        completed_at=datetime(2026, 6, 1, 11, 0),
    )
    # Different content — must not appear.
    await archive_factory(printer.id, content_hash=HASH_B, status="completed")

    response = await async_client.get(f"/api/v1/library/files/{lib_file.id}/history")
    assert response.status_code == 200
    data = response.json()
    assert data["total_prints"] == 1
    assert data["success_count"] == 1
    events = data["events"]
    assert len(events) == 1
    assert events[0]["type"] == "print"
    assert events[0]["status"] == "completed"
    assert events[0]["archive_id"] is not None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_history_reprints_are_separate_events(
    async_client: AsyncClient, file_factory, archive_factory, printer_factory, db_session
):
    """Each print-log entry of a matching archive is its own row, newest first."""
    printer = await printer_factory()
    lib_file = await file_factory()
    archive = await archive_factory(
        printer.id,
        content_hash=HASH_A,
        status="completed",
        started_at=datetime(2026, 6, 1, 10, 0),
        completed_at=datetime(2026, 6, 1, 11, 0),
    )
    db_session.add(
        PrintLogEntry(
            archive_id=archive.id,
            printer_id=printer.id,
            status="failed",
            started_at=datetime(2026, 6, 5, 10, 0),
            completed_at=datetime(2026, 6, 5, 10, 30),
            duration_seconds=1800,
            filament_used_grams=10.0,
            failure_reason="filament_runout",
            created_at=datetime(2026, 6, 5, 10, 30),
        )
    )
    await db_session.commit()

    response = await async_client.get(f"/api/v1/library/files/{lib_file.id}/history")
    data = response.json()
    assert data["total_prints"] == 2
    assert data["success_count"] == 1
    statuses = [e["status"] for e in data["events"]]
    # Newest first: the June 5 failure before the June 1 success.
    assert statuses == ["failed", "completed"]
    assert data["events"][0]["failure_reason"] == "filament_runout"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_history_archive_fallback_without_log_entries(
    async_client: AsyncClient, file_factory, archive_factory, printer_factory
):
    """Archives with no log rows (pre-log data / cleared log) still yield an event."""
    printer = await printer_factory()
    lib_file = await file_factory()
    archive = await archive_factory(
        printer.id,
        content_hash=HASH_A,
        status="failed",
        failure_reason="spaghetti",
        with_run=False,
        started_at=datetime(2026, 6, 2, 9, 0),
        completed_at=datetime(2026, 6, 2, 9, 45),
    )

    response = await async_client.get(f"/api/v1/library/files/{lib_file.id}/history")
    data = response.json()
    assert data["total_prints"] == 1
    event = data["events"][0]
    assert event["type"] == "print"
    assert event["status"] == "failed"
    assert event["failure_reason"] == "spaghetti"
    assert event["archive_id"] == archive.id
    assert event["printer_name"] == printer.name


@pytest.mark.asyncio
@pytest.mark.integration
async def test_history_trashed_archive_keeps_run_but_drops_link(
    async_client: AsyncClient, file_factory, archive_factory, printer_factory, db_session
):
    """A soft-deleted archive's runs stay in history without a dead-end link."""
    printer = await printer_factory()
    lib_file = await file_factory()
    archive = await archive_factory(printer.id, content_hash=HASH_A, status="completed")
    archive.deleted_at = datetime.now(timezone.utc)
    await db_session.commit()

    response = await async_client.get(f"/api/v1/library/files/{lib_file.id}/history")
    data = response.json()
    assert data["total_prints"] == 1
    assert data["events"][0]["archive_id"] is None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_history_queued_items_first(
    async_client: AsyncClient, file_factory, archive_factory, printer_factory, db_session
):
    """Pending queue items referencing the file appear as queued events on top."""
    printer = await printer_factory()
    lib_file = await file_factory()
    await archive_factory(printer.id, content_hash=HASH_A, status="completed")
    db_session.add(
        PrintQueueItem(
            printer_id=printer.id,
            library_file_id=lib_file.id,
            status="pending",
        )
    )
    await db_session.commit()

    response = await async_client.get(f"/api/v1/library/files/{lib_file.id}/history")
    data = response.json()
    # Queued rows don't count as prints.
    assert data["total_prints"] == 1
    assert len(data["events"]) == 2
    assert data["events"][0]["type"] == "queued"
    assert data["events"][0]["status"] == "pending"
    assert data["events"][0]["printer_name"] == printer.name
    assert data["events"][1]["type"] == "print"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_history_totals(async_client: AsyncClient, file_factory, archive_factory, printer_factory):
    """Filament totals and last_printed_at aggregate across matching runs."""
    printer = await printer_factory()
    lib_file = await file_factory()
    await archive_factory(
        printer.id,
        content_hash=HASH_A,
        status="completed",
        filament_used_grams=50.0,
        started_at=datetime(2026, 6, 1, 10, 0),
        completed_at=datetime(2026, 6, 1, 11, 0),
    )
    await archive_factory(
        printer.id,
        content_hash=HASH_A,
        status="completed",
        filament_used_grams=25.5,
        started_at=datetime(2026, 6, 3, 10, 0),
        completed_at=datetime(2026, 6, 3, 11, 0),
    )

    response = await async_client.get(f"/api/v1/library/files/{lib_file.id}/history")
    data = response.json()
    assert data["total_prints"] == 2
    assert data["total_filament_grams"] == 75.5
    assert data["last_printed_at"].startswith("2026-06-03")
