"""Queue items never wait forever for a slice, and a printer never receives an unsliced project
``.3mf`` (design 2026-10-17 anti-goals; final branch review).

* A settle that fails after ``POST /queue/`` committed its ``slicing`` items does not fail the
  request; the startup sweep (``recover_waiting_queue_items``) brings such items back.
* The dispatch-time guard (``hold_unsliced_dispatch``) catches items queued ``pending`` on a
  source ``.3mf`` by any path: the G-code of a sliced revision is dispatched instead, an unsliced
  revision's item waits in ``slicing`` with its slice started.
* ``_mark_failed`` never overwrites a revision another slice already landed.

The sidecar is an httpx ``MockTransport``: no test reaches a real slicer or printer.
"""

from __future__ import annotations

from contextlib import ExitStack
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core import database
from backend.app.models.library import LibraryFile
from backend.app.models.print_batch import PrintBatch, PrintBatchPlate
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.project_item import ProjectRevision
from backend.app.services import project_slice
from backend.app.services.print_scheduler import PrintScheduler
from backend.tests.integration.test_project_slice import (  # noqa: F401  # fixtures
    _wait_job,
    roots,
    sidecar,
    test_engine,
)
from backend.tests.integration.test_project_slice_queue import _item, _queue, _revision, _slice_now, _upload
from backend.tests.project_fixtures import wal_engine_fixture  # noqa: F401  # the ``wal_engine`` fixture


def _boom(*_args, **_kwargs):
    raise RuntimeError("database went away")


async def _pending_on(db, file_id: int, **extra) -> int:
    """A ``pending`` item on ``file_id`` written straight to the table, as a row queued before
    server slicing (or by a path that skips the queue route) would be."""
    item = PrintQueueItem(library_file_id=file_id, status="pending", position=1, **extra)
    db.add(item)
    await db.commit()
    return item.id


# --- the settle never turns a committed queue write into a 500 ------------------------------------


@pytest.mark.asyncio
@pytest.mark.integration
async def test_failing_settle_does_not_fail_add_to_queue_and_the_sweep_recovers(
    async_client: AsyncClient, db_session, sidecar, monkeypatch
):
    rev = await _upload(async_client)

    async def start_fails(*_args, **_kwargs):
        raise RuntimeError("enqueue refused")

    real_start, real_settle = project_slice.start_revision_slice, project_slice.settle_waiting_queue_items
    monkeypatch.setattr(project_slice, "start_revision_slice", start_fails)
    monkeypatch.setattr(project_slice, "settle_waiting_queue_items", AsyncMock(side_effect=_boom))
    response = await async_client.post("/api/v1/queue/", json={"library_file_id": rev["files"][0]["id"]})
    assert response.status_code == 200, response.text
    item_id = response.json()["id"]
    assert (await _item(db_session, item_id)).status == "slicing"
    assert (await _revision(db_session, rev["id"])).slice_status is None  # stranded: nothing will slice it
    monkeypatch.setattr(project_slice, "start_revision_slice", real_start)  # not undo(): it reverts the fixtures too
    monkeypatch.setattr(project_slice, "settle_waiting_queue_items", real_settle)

    assert await project_slice.recover_waiting_queue_items() == 1
    revision = await _revision(db_session, rev["id"])
    assert revision.slice_job_id is not None
    await _wait_job(revision.slice_job_id)
    sliced_id = (await _revision(db_session, rev["id"])).sliced_file_id
    item = await _item(db_session, item_id)
    assert (item.status, item.library_file_id) == ("pending", sliced_id)
    assert len(sidecar.slice_requests) == 1


@pytest.mark.asyncio
@pytest.mark.integration
async def test_sweep_slices_a_never_sliced_revision_with_a_stranded_item(
    async_client: AsyncClient, db_session, sidecar
):
    rev = await _upload(async_client)
    source_id = rev["files"][0]["id"]
    db_session.add(PrintQueueItem(library_file_id=source_id, status="slicing", position=1))
    await db_session.commit()
    stranded = (
        await db_session.execute(select(PrintQueueItem.id).where(PrintQueueItem.library_file_id == source_id))
    ).scalar_one()

    assert await project_slice.recover_waiting_queue_items() == 1
    await _wait_job((await _revision(db_session, rev["id"])).slice_job_id)
    revision = await _revision(db_session, rev["id"])
    assert revision.slice_status == "sliced"
    sliced_id = revision.sliced_file_id
    item = await _item(db_session, stranded)
    assert (item.status, item.library_file_id) == ("pending", sliced_id)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_sweep_applies_an_already_sliced_revision_without_slicing_again(
    async_client: AsyncClient, db_session, sidecar
):
    rev = await _upload(async_client)
    source_id = rev["files"][0]["id"]
    await _slice_now(async_client, rev["id"])
    db_session.add(PrintQueueItem(library_file_id=source_id, status="slicing", position=1))
    await db_session.commit()

    assert await project_slice.recover_waiting_queue_items() == 1
    sliced_id = (await _revision(db_session, rev["id"])).sliced_file_id
    db_session.expire_all()
    item = (await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.status != "cancelled"))).scalar_one()
    assert (item.status, item.library_file_id) == ("pending", sliced_id)
    assert len(sidecar.slice_requests) == 1
    assert await project_slice.recover_waiting_queue_items() == 0  # nothing left stranded


@pytest.mark.asyncio
@pytest.mark.integration
async def test_failing_settle_does_not_fail_batch_dispatch(async_client: AsyncClient, db_session, sidecar, monkeypatch):
    rev = await _upload(async_client)
    sidecar.block = True
    out = await _queue(async_client, rev["files"][0]["id"], plate_id=1)
    assert out["status"] == "slicing"
    batch = PrintBatch(name="Order", quantity=2, status="active")
    db_session.add(batch)
    await db_session.flush()
    db_session.add(PrintBatchPlate(batch_id=batch.id, plate_id=1, quantity_target=2, sort_order=0))
    item = await db_session.get(PrintQueueItem, out["id"])
    item.batch_id = batch_id = batch.id
    await db_session.commit()

    monkeypatch.setattr(project_slice, "settle_waiting_queue_items", AsyncMock(side_effect=_boom))
    response = await async_client.post(f"/api/v1/queue/batches/{batch_id}/dispatch", json={})
    assert response.status_code == 200, response.text
    sidecar.release.set()
    await _wait_job(out["slice_job_id"])


@pytest.mark.asyncio
@pytest.mark.integration
async def test_resume_survives_a_failing_rollback(async_client: AsyncClient, db_session, sidecar, monkeypatch):
    rev = await _upload(async_client)
    await db_session.execute(
        update(ProjectRevision).where(ProjectRevision.id == rev["id"]).values(slice_status="slicing")
    )
    await db_session.commit()

    async def start_fails(*_args, **_kwargs):
        raise RuntimeError("enqueue refused")

    monkeypatch.setattr(project_slice, "_start", start_fails)
    real_rollback = AsyncSession.rollback

    async def rollback_fails(self):
        await real_rollback(self)
        raise RuntimeError("rollback failed too")

    monkeypatch.setattr(AsyncSession, "rollback", rollback_fails)
    assert await project_slice.resume_interrupted_slices() == 0  # logged, never raised


# --- the dispatch-time guard -------------------------------------------------------------------


def _dispatch_patches(scheduler: PrintScheduler, archive_print: AsyncMock) -> list:
    return [
        patch("backend.app.services.print_scheduler.async_session", database.async_session),
        patch("backend.app.services.print_scheduler.printer_manager.is_connected", MagicMock(return_value=True)),
        patch("backend.app.services.print_scheduler.printer_manager.get_status", MagicMock(return_value=None)),
        patch("backend.app.services.print_scheduler.printer_manager.start_print", MagicMock(return_value=True)),
        patch("backend.app.services.print_scheduler.upload_file_async", AsyncMock(return_value=True)),
        patch("backend.app.services.archive.ArchiveService.archive_print", archive_print),
        patch.object(scheduler, "_power_off_if_needed", AsyncMock()),
    ]


async def _dispatch(item_id: int) -> AsyncMock:
    """Run one dispatch; returns the patched ``archive_print`` (the first step that copies the file
    on its way to the printer). It returns None, so a dispatch that gets that far stops there."""
    scheduler = PrintScheduler()
    archive_print = AsyncMock(return_value=None)
    with ExitStack() as stack:
        for p in _dispatch_patches(scheduler, archive_print):
            stack.enter_context(p)
        await scheduler._dispatch_one(item_id)
    return archive_print


@pytest.mark.asyncio
@pytest.mark.integration
async def test_pending_item_on_an_unsliced_source_is_never_sent(
    async_client: AsyncClient, db_session, sidecar, printer_factory
):
    printer_id = (await printer_factory()).id
    rev = await _upload(async_client)
    source_id = rev["files"][0]["id"]
    sidecar.block = True
    item_id = await _pending_on(db_session, source_id, printer_id=printer_id)

    archive_print = await _dispatch(item_id)

    archive_print.assert_not_called()
    item = await _item(db_session, item_id)
    assert (item.status, item.library_file_id, item.dispatching_at) == ("slicing", source_id, None)
    revision = await _revision(db_session, rev["id"])
    assert revision.slice_status == "slicing"
    assert revision.slice_job_id is not None

    sidecar.release.set()
    await _wait_job(revision.slice_job_id)
    item = await _item(db_session, item_id)
    assert (item.status, item.library_file_id) == ("pending", (await _revision(db_session, rev["id"])).sliced_file_id)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_pending_item_on_a_sliced_revisions_source_is_sent_as_its_gcode(
    async_client: AsyncClient, db_session, sidecar, printer_factory
):
    printer_id = (await printer_factory()).id
    rev = await _upload(async_client)
    source_id = rev["files"][0]["id"]
    await _slice_now(async_client, rev["id"])
    sliced = await db_session.get(LibraryFile, (await _revision(db_session, rev["id"])).sliced_file_id)
    sliced_id, sliced_name = sliced.id, Path(sliced.file_path).name
    item_id = await _pending_on(db_session, source_id, printer_id=printer_id)

    archive_print = await _dispatch(item_id)

    archive_print.assert_awaited_once()
    kwargs = archive_print.await_args.kwargs
    assert Path(kwargs["source_file"]).name == sliced_name
    assert sliced_name.endswith(".gcode.3mf")
    assert kwargs["library_file_id"] == sliced_id
    assert (await _item(db_session, item_id)).library_file_id == sliced_id
    assert len(sidecar.slice_requests) == 1


@pytest.mark.asyncio
@pytest.mark.integration
async def test_pending_item_on_a_non_source_3mf_fails_at_dispatch(
    async_client: AsyncClient, db_session, sidecar, printer_factory
):
    from backend.tests.integration.test_project_slice_queue import _legacy_two_source_revision

    printer_id = (await printer_factory()).id
    _rev, _part_a, part_b = await _legacy_two_source_revision(async_client, db_session)
    item_id = await _pending_on(db_session, part_b, printer_id=printer_id)

    archive_print = await _dispatch(item_id)

    archive_print.assert_not_called()
    item = await _item(db_session, item_id)
    assert (item.status, item.error_message) == ("slice_failed", project_slice.NOT_THE_SOURCE)
    assert sidecar.slice_requests == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_hold_lets_a_sliced_3mf_under_a_revision_print_as_is(async_client: AsyncClient, db_session, sidecar):
    """Legacy G-code stored under a plain ``.3mf`` name in a revision is not a project by content:
    the guard returns False, the item stays as queued and no slice is started."""
    from backend.app.api.routes.library import to_absolute_path
    from backend.tests.integration.test_project_slice import _sliced_3mf

    rev = await _upload(async_client)
    source = await db_session.get(LibraryFile, rev["files"][0]["id"])
    legacy_rel = str(Path(source.file_path).with_name("legacy.3mf"))
    to_absolute_path(legacy_rel).write_bytes(_sliced_3mf())
    legacy = LibraryFile(
        filename="legacy.3mf", file_path=legacy_rel, file_size=1, file_type="3mf", revision_id=rev["id"]
    )
    db_session.add(legacy)
    await db_session.commit()
    legacy_id = legacy.id
    item_id = await _pending_on(db_session, legacy_id)

    item = await _item(db_session, item_id)
    held = await project_slice.hold_unsliced_dispatch(db_session, item, await db_session.get(LibraryFile, legacy_id))

    assert held is False
    after = await _item(db_session, item_id)
    assert (after.status, after.library_file_id, after.error_message) == ("pending", legacy_id, None)
    assert (await _revision(db_session, rev["id"])).slice_status is None
    assert sidecar.slice_requests == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_hold_fails_an_item_whose_revision_has_no_slicable_source(async_client: AsyncClient, db_session, sidecar):
    """The file reads as a project but the revision names no source ``.3mf`` (here the row's name no
    longer ends in ``.3mf``): ``sliced_file_of`` refuses and the item is ``slice_failed``, not sliced."""
    rev = await _upload(async_client)
    source_id = rev["files"][0]["id"]
    await db_session.execute(update(LibraryFile).where(LibraryFile.id == source_id).values(filename="support.bin"))
    await db_session.commit()
    item_id = await _pending_on(db_session, source_id)

    item = await _item(db_session, item_id)
    held = await project_slice.hold_unsliced_dispatch(db_session, item, await db_session.get(LibraryFile, source_id))

    assert held is True
    after = await _item(db_session, item_id)
    assert (after.status, after.error_message) == ("slice_failed", project_slice.NO_PROJECT_TO_SLICE)
    assert sidecar.slice_requests == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_hold_starts_no_slice_for_an_item_cancelled_meanwhile(async_client: AsyncClient, db_session, sidecar):
    """A cancel that wins the race against the guard keeps its status: the item is not moved to
    ``slicing`` and no slice is started on its behalf. The dispatch is still held."""
    rev = await _upload(async_client)
    source_id = rev["files"][0]["id"]
    item_id = await _pending_on(db_session, source_id)
    item = await _item(db_session, item_id)
    source = await db_session.get(LibraryFile, source_id)
    await db_session.execute(update(PrintQueueItem).where(PrintQueueItem.id == item_id).values(status="cancelled"))
    await db_session.commit()

    held = await project_slice.hold_unsliced_dispatch(db_session, item, source)

    assert held is True
    assert (await _item(db_session, item_id)).status == "cancelled"
    assert (await _revision(db_session, rev["id"])).slice_status is None
    assert sidecar.slice_requests == []


# --- _mark_failed ------------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.integration
async def test_mark_failed_leaves_a_sliced_revision_alone(async_client: AsyncClient, db_session, sidecar):
    rev = await _upload(async_client)
    await _slice_now(async_client, rev["id"])
    before = await _revision(db_session, rev["id"])
    sliced_id = before.sliced_file_id

    async with database.async_session() as db:
        await project_slice._mark_failed(db, rev["id"], "a late failure from another slice")

    after = await _revision(db_session, rev["id"])
    assert (after.slice_status, after.slice_error, after.sliced_file_id) == ("sliced", None, sliced_id)


async def _slicing_revision_with_waiting_item(client: AsyncClient, db) -> tuple[int, int]:
    """A revision left ``slicing`` with a ``slicing`` queue item on its source, as a slice whose job just failed."""
    rev = await _upload(client)
    await db.execute(update(ProjectRevision).where(ProjectRevision.id == rev["id"]).values(slice_status="slicing"))
    item = PrintQueueItem(library_file_id=rev["files"][0]["id"], status="slicing", position=1)
    db.add(item)
    await db.commit()
    return rev["id"], item.id


def _flaky_commit(db, monkeypatch, failures: int | None) -> list[int]:
    """Make ``db.commit`` raise its first ``failures`` calls (every call when None); returns the call log."""
    real_commit = db.commit
    calls: list[int] = []

    async def commit():
        calls.append(1)
        if failures is None or len(calls) <= failures:
            raise RuntimeError("database is locked")
        await real_commit()

    monkeypatch.setattr(db, "commit", commit)  # this session only
    return calls


@pytest.mark.asyncio
@pytest.mark.integration
async def test_mark_failed_retries_a_failed_write_and_fails_the_waiting_items(
    async_client: AsyncClient, db_session, sidecar, monkeypatch
):
    revision_id, item_id = await _slicing_revision_with_waiting_item(async_client, db_session)
    monkeypatch.setattr(project_slice, "_MARK_FAILED_BACKOFF_SECONDS", 0)

    async with database.async_session() as db:
        calls = _flaky_commit(db, monkeypatch, failures=1)
        await project_slice._mark_failed(db, revision_id, "The slicer refused the file")

    assert len(calls) == 2
    revision = await _revision(db_session, revision_id)
    assert (revision.slice_status, revision.slice_error) == ("failed", "The slicer refused the file")
    item = await _item(db_session, item_id)
    assert (item.status, item.error_message) == ("slice_failed", "The slicer refused the file")


@pytest.mark.asyncio
@pytest.mark.integration
async def test_mark_failed_gives_up_after_its_attempts_and_logs_once(
    async_client: AsyncClient, db_session, sidecar, monkeypatch, caplog
):
    revision_id, item_id = await _slicing_revision_with_waiting_item(async_client, db_session)
    monkeypatch.setattr(project_slice, "_MARK_FAILED_BACKOFF_SECONDS", 0)
    async with database.async_session() as db:
        calls = _flaky_commit(db, monkeypatch, failures=None)
        with caplog.at_level("WARNING", logger=project_slice.logger.name):
            await project_slice._mark_failed(db, revision_id, "The slicer refused the file")

    assert len(calls) == project_slice._MARK_FAILED_ATTEMPTS == 3
    failures = [r for r in caplog.records if r.getMessage().startswith("Could not record the failed slice")]
    assert len(failures) == 1 and failures[0].levelname == "ERROR" and failures[0].exc_info
    assert (await _revision(db_session, revision_id)).slice_status == "slicing"
    assert (await _item(db_session, item_id)).status == "slicing"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_mark_failed_logs_a_rollback_that_raises_after_its_last_attempt(
    async_client: AsyncClient, db_session, sidecar, monkeypatch, caplog
):
    revision_id, _item_id = await _slicing_revision_with_waiting_item(async_client, db_session)
    monkeypatch.setattr(project_slice, "_MARK_FAILED_BACKOFF_SECONDS", 0)

    async with database.async_session() as db:
        monkeypatch.setattr(db, "rollback", AsyncMock(side_effect=RuntimeError("connection reset")))
        with caplog.at_level("WARNING", logger=project_slice.logger.name):
            await project_slice._mark_failed(db, revision_id, "x")

    messages = [r.getMessage() for r in caplog.records]
    assert messages.count(f"Could not record the failed slice of project revision {revision_id}") == 1
    assert "Rollback after recording a failed slice raised" in messages
    assert (await _revision(db_session, revision_id)).slice_status == "slicing"


# --- files filed into a project by move / import / auto-filing --------------------------------


@pytest.fixture
def real_slice_start(monkeypatch):
    """conftest turns the upload-triggered slice off; these tests need it."""
    from backend.tests.integration.test_project_slice import _real_start_after_upload

    monkeypatch.setattr(project_slice, "start_slice_after_upload", _real_start_after_upload)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_importing_a_source_3mf_starts_its_slice_and_a_gcode_3mf_stays_as_is(
    async_client: AsyncClient, db_session, sidecar, real_slice_start
):
    from backend.tests.integration.test_project_slice import _sliced_3mf
    from backend.tests.project_fixtures import api_project, make_managed_library_file, threemf_bytes

    project = await api_project(async_client)
    source = await make_managed_library_file(db_session, "Bracket.3mf", threemf_bytes())
    legacy = await make_managed_library_file(db_session, "Clip.gcode.3mf", _sliced_3mf())
    file_ids = [source.id, legacy.id]

    response = await async_client.post(
        f"/api/v1/projects/{project['id']}/import-library-files", json={"file_ids": file_ids}
    )
    assert response.status_code == 200, response.text
    by_file = {m["file_id"]: m["revision_id"] for m in response.json()["moved"]}
    assert set(by_file) == set(file_ids)

    sliced_rev = await _revision(db_session, by_file[file_ids[0]])
    assert sliced_rev.slice_status == "slicing"
    await _wait_job(sliced_rev.slice_job_id)
    assert (await _revision(db_session, by_file[file_ids[0]])).slice_status == "sliced"
    assert (await _revision(db_session, by_file[file_ids[1]])).slice_status is None  # legacy G-code: allowed, unsliced
    assert len(sidecar.slice_requests) == 1


@pytest.mark.asyncio
@pytest.mark.integration
async def test_a_failing_slice_start_never_fails_the_import(
    async_client: AsyncClient, db_session, sidecar, real_slice_start, monkeypatch
):
    from backend.tests.project_fixtures import api_project, make_managed_library_file, threemf_bytes

    project = await api_project(async_client)
    source = await make_managed_library_file(db_session, "Bracket.3mf", threemf_bytes())
    source_id = source.id

    async def start_fails(*_args, **_kwargs):
        raise RuntimeError("enqueue refused")

    monkeypatch.setattr(project_slice, "start_revision_slice", start_fails)
    response = await async_client.post(
        f"/api/v1/projects/{project['id']}/import-library-files", json={"file_ids": [source_id]}
    )
    assert response.status_code == 200, response.text
    assert [m["file_id"] for m in response.json()["moved"]] == [source_id]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_auto_filing_a_received_source_3mf_starts_its_slice(
    async_client: AsyncClient, db_session, sidecar, real_slice_start, tmp_path
):
    from backend.app.services.project_filing import auto_file_by_code
    from backend.tests.project_fixtures import api_project, threemf_bytes

    project = await api_project(async_client)
    received = tmp_path / "received.3mf"
    received.write_bytes(threemf_bytes())

    result = await auto_file_by_code(
        db_session, filename=f"{project['code']}_Bracket.3mf", path=received, library_file=None, user_id=None
    )
    assert result is not None
    revision = await _revision(db_session, result.revision_id)
    assert revision.slice_status == "slicing"
    await _wait_job(revision.slice_job_id)
    assert (await _revision(db_session, result.revision_id)).slice_status == "sliced"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_sweep_fails_a_stranded_item_whose_source_is_gone(async_client: AsyncClient, db_session, sidecar):
    """A ``slicing`` item left over from before a restart, its source ``.3mf`` deleted meanwhile:
    the sweep marks it ``slice_failed`` instead of leaving it for every later startup."""
    from backend.app.api.routes.library import to_absolute_path

    rev = await _upload(async_client)
    source_id = rev["files"][0]["id"]
    source_path = to_absolute_path((await db_session.get(LibraryFile, source_id)).file_path)
    db_session.add(PrintQueueItem(library_file_id=source_id, status="slicing", position=1))
    await db_session.commit()
    source_path.unlink()

    assert await project_slice.recover_waiting_queue_items() == 1
    db_session.expire_all()
    item = (await db_session.execute(select(PrintQueueItem))).scalar_one()
    assert (item.status, item.error_message) == ("slice_failed", "The slice could not start")
    assert sidecar.slice_requests == []
    assert await project_slice.recover_waiting_queue_items() == 0  # not stranded any more


# --- the lifespan runs both startup sweeps, resume first, each isolated from the other -------------


class _StopStartup(Exception):
    """Raised by the first lifespan step after the slice sweeps, so the rest of startup never runs."""


async def _run_startup_through_the_slice_sweeps(monkeypatch) -> None:
    """Enter the real ``lifespan`` and stop it right after the two slice sweeps.

    Only the steps around them are neutralised: ``init_db`` would migrate the module-level engine
    (the dev database), and the cloud client registration just after the sweeps is the stop sign."""
    from backend.app import main
    from backend.app.services import bambu_cloud

    def stop(*_args, **_kwargs):
        raise _StopStartup

    monkeypatch.setattr(main, "init_db", AsyncMock())
    monkeypatch.setattr(bambu_cloud, "set_shared_http_client", stop)
    monkeypatch.setattr("backend.app.core.fd_limit.raise_open_file_limit", MagicMock())
    with pytest.raises(_StopStartup):
        async with main.lifespan(main.app):
            pytest.fail("the lifespan was expected to stop before yielding")


async def _stranded_pair(client: AsyncClient, db_session) -> tuple[dict, dict, int]:
    """A revision a restart left ``slicing`` with a dead job, and another never sliced whose queue
    item is stranded in ``slicing``: (first revision, second revision, the item's id)."""
    first = await _upload(client)
    await db_session.execute(
        update(ProjectRevision)
        .where(ProjectRevision.id == first["id"])
        .values(slice_status="slicing", slice_job_id=9999)
    )
    await db_session.commit()
    second = await _upload(client)
    item = PrintQueueItem(library_file_id=second["files"][0]["id"], status="slicing", position=1)
    db_session.add(item)
    await db_session.commit()
    return first, second, item.id


@pytest.mark.asyncio
@pytest.mark.integration
async def test_startup_resumes_the_interrupted_slice_then_settles_the_stranded_item(
    async_client: AsyncClient, db_session, sidecar, monkeypatch
):
    first, second, item_id = await _stranded_pair(async_client, db_session)
    calls: list[str] = []
    real_resume, real_recover = project_slice.resume_interrupted_slices, project_slice.recover_waiting_queue_items

    async def resume():
        calls.append("resume")
        return await real_resume()

    async def recover():
        calls.append("recover")
        return await real_recover()

    monkeypatch.setattr(project_slice, "resume_interrupted_slices", resume)
    monkeypatch.setattr(project_slice, "recover_waiting_queue_items", recover)

    await _run_startup_through_the_slice_sweeps(monkeypatch)

    assert calls == ["resume", "recover"]
    resumed_job = (await _revision(db_session, first["id"])).slice_job_id
    assert resumed_job not in (None, 9999)
    recovered_job = (await _revision(db_session, second["id"])).slice_job_id
    assert recovered_job is not None
    await _wait_job(resumed_job)
    await _wait_job(recovered_job)
    assert (await _revision(db_session, first["id"])).slice_status == "sliced"
    revision = await _revision(db_session, second["id"])
    assert revision.slice_status == "sliced"
    sliced_id = revision.sliced_file_id
    item = await _item(db_session, item_id)
    assert (item.status, item.library_file_id) == ("pending", sliced_id)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_startup_still_recovers_the_stranded_item_when_the_resume_sweep_raises(
    async_client: AsyncClient, db_session, sidecar, monkeypatch
):
    first, second, item_id = await _stranded_pair(async_client, db_session)
    monkeypatch.setattr(project_slice, "resume_interrupted_slices", AsyncMock(side_effect=_boom))

    await _run_startup_through_the_slice_sweeps(monkeypatch)

    assert (await _revision(db_session, first["id"])).slice_job_id == 9999  # not resumed
    recovered = await _revision(db_session, second["id"])
    assert recovered.slice_job_id is not None
    await _wait_job(recovered.slice_job_id)
    revision = await _revision(db_session, second["id"])
    sliced_id = revision.sliced_file_id
    item = await _item(db_session, item_id)
    assert (item.status, item.library_file_id) == ("pending", sliced_id)
