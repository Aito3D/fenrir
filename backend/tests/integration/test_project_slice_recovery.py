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
