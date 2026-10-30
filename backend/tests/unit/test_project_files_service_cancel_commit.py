"""Project files service: the commit-through-cancel guard at every commit site (split from test_project_files_service.py)."""

import asyncio
import io
import zipfile
from pathlib import Path

import pytest
from fastapi import UploadFile
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_task_delivery import AitoTaskDelivery
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.app.services import project_files, project_storage
from backend.app.services.project_files import (
    ProjectFilesError,
    add_revision,
    create_item,
    delete_item,
    delete_revision,
    fork_revision,
    load_tree,
    remove_file_from_revision,
    rename_item,
    revision_is_used,
    update_revision,
)
from backend.tests.project_fixtures import (
    legacy_uploads_fixture,
    make_project as _project,
    projects_root_fixture,
    threemf_bytes,
    upload,
)
from backend.tests.unit.project_files_service_helpers import (
    _fork_source_with_thumbnail,
    _fresh_scalars,
    _rev,
    _trash_entries,
)

root = projects_root_fixture()
legacy_uploads = legacy_uploads_fixture(autouse=True)


def _commit_outlives_cancel(db_session, monkeypatch, *, fails=False):
    real_commit = db_session.commit
    in_flight, release = asyncio.Event(), asyncio.Event()

    async def worker_thread():
        await release.wait()
        if fails:
            raise RuntimeError("db down")
        await real_commit()

    async def commit():
        inner = asyncio.ensure_future(worker_thread())
        in_flight.set()
        await asyncio.shield(inner)

    monkeypatch.setattr(db_session, "commit", commit)
    return in_flight, release


async def _cancel_mid_commit(operation, in_flight, release):
    task = asyncio.ensure_future(operation)
    await in_flight.wait()
    task.cancel()
    await asyncio.sleep(0)  # the cancellation reaches the awaiting coroutine first
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task


async def _cancelled_before_commit(db_session, monkeypatch):
    async def cancelled():
        raise asyncio.CancelledError

    monkeypatch.setattr(db_session, "commit", cancelled)


@pytest.mark.asyncio
async def test_add_revision_keeps_files_when_a_cancelled_commit_lands(db_session, root, monkeypatch, test_engine):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="scan", name="Mesh", user_id=None)
    storage_dir, item_id = project.storage_dir, item.id
    await db_session.commit()
    in_flight, release = _commit_outlives_cancel(db_session, monkeypatch)
    await _cancel_mid_commit(
        add_revision(db_session, project, item, [upload("a.ply")], note=None, derived_from_id=None, user_id=None),
        in_flight,
        release,
    )
    rev_ids = await _fresh_scalars(test_engine, select(ProjectRevision.id).where(ProjectRevision.item_id == item_id))
    assert len(rev_ids) == 1
    paths = await _fresh_scalars(
        test_engine, select(LibraryFile.file_path).where(LibraryFile.revision_id == rev_ids[0])
    )
    assert len(paths) == 1
    folder = root / storage_dir / "Scan" / "Mesh" / "R1"
    assert (folder / "a.ply").read_bytes() == b"data"


@pytest.mark.asyncio
async def test_add_revision_cleans_up_when_a_cancelled_commit_fails(db_session, root, monkeypatch, test_engine):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="scan", name="Mesh", user_id=None)
    storage_dir, item_id = project.storage_dir, item.id
    await db_session.commit()
    in_flight, release = _commit_outlives_cancel(db_session, monkeypatch, fails=True)
    await _cancel_mid_commit(
        add_revision(db_session, project, item, [upload("a.ply")], note=None, derived_from_id=None, user_id=None),
        in_flight,
        release,
    )
    assert await _fresh_scalars(test_engine, select(ProjectRevision.id).where(ProjectRevision.item_id == item_id)) == []
    folder = root / storage_dir / "Scan" / "Mesh" / "R1"
    assert not folder.exists() or list(folder.iterdir()) == []


@pytest.mark.asyncio
async def test_add_revision_cleans_up_when_cancelled_before_the_commit(db_session, root, monkeypatch, test_engine):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="scan", name="Mesh", user_id=None)
    storage_dir, item_id = project.storage_dir, item.id
    await db_session.commit()
    await _cancelled_before_commit(db_session, monkeypatch)
    with pytest.raises(asyncio.CancelledError):
        await add_revision(db_session, project, item, [upload("a.ply")], note=None, derived_from_id=None, user_id=None)
    assert await _fresh_scalars(test_engine, select(ProjectRevision.id).where(ProjectRevision.item_id == item_id)) == []
    folder = root / storage_dir / "Scan" / "Mesh" / "R1"
    assert not folder.exists() or list(folder.iterdir()) == []


async def _two_file_revision(db_session):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project, files=[upload("a.step"), upload("b.step", b"other")])
    rows = (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == rev.id))).scalars().all()
    target_id = next(f.id for f in rows if f.filename == "a.step")
    await db_session.commit()
    return project, item, rev, target_id


@pytest.mark.asyncio
async def test_remove_file_stays_trashed_when_a_cancelled_commit_lands(db_session, root, monkeypatch, test_engine):
    project, item, rev, target_id = await _two_file_revision(db_session)
    base, rev_id = root / project.storage_dir, rev.id
    in_flight, release = _commit_outlives_cancel(db_session, monkeypatch)
    await _cancel_mid_commit(remove_file_from_revision(db_session, project, item, rev, target_id), in_flight, release)
    kept = await _fresh_scalars(test_engine, select(LibraryFile.filename).where(LibraryFile.revision_id == rev_id))
    assert kept == ["b.step"]
    folder = base / "Modélisation" / "Support" / "R1"
    assert not (folder / "a.step").exists() and (folder / "b.step").exists()
    assert [p.name.startswith("a") for p in _trash_entries(base)] == [True]


@pytest.mark.asyncio
async def test_remove_file_restored_when_cancelled_before_the_commit(db_session, root, monkeypatch, test_engine):
    project, item, rev, target_id = await _two_file_revision(db_session)
    base, rev_id = root / project.storage_dir, rev.id
    await _cancelled_before_commit(db_session, monkeypatch)
    with pytest.raises(asyncio.CancelledError):
        await remove_file_from_revision(db_session, project, item, rev, target_id)
    kept = await _fresh_scalars(test_engine, select(LibraryFile.filename).where(LibraryFile.revision_id == rev_id))
    assert sorted(kept) == ["a.step", "b.step"]
    assert (base / "Modélisation" / "Support" / "R1" / "a.step").read_bytes() == b"data"
    assert _trash_entries(base) == []


@pytest.mark.asyncio
async def test_delete_revision_stays_trashed_when_a_cancelled_commit_lands(db_session, root, monkeypatch, test_engine):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    base, rev_id = root / project.storage_dir, rev.id
    in_flight, release = _commit_outlives_cancel(db_session, monkeypatch)
    await _cancel_mid_commit(delete_revision(db_session, project, item, rev), in_flight, release)
    assert await _fresh_scalars(test_engine, select(ProjectRevision.id).where(ProjectRevision.id == rev_id)) == []
    assert await _fresh_scalars(test_engine, select(LibraryFile.id).where(LibraryFile.revision_id == rev_id)) == []
    assert not (base / "Modélisation" / "Support" / "R1").exists()
    assert [p.name for p in _trash_entries(base)] == ["a.step"]


@pytest.mark.asyncio
async def test_delete_revision_restored_when_cancelled_before_the_commit(db_session, root, monkeypatch, test_engine):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    base, rev_id = root / project.storage_dir, rev.id
    await _cancelled_before_commit(db_session, monkeypatch)
    with pytest.raises(asyncio.CancelledError):
        await delete_revision(db_session, project, item, rev)
    assert await _fresh_scalars(test_engine, select(ProjectRevision.id).where(ProjectRevision.id == rev_id)) == [rev_id]
    assert (base / "Modélisation" / "Support" / "R1" / "a.step").read_bytes() == b"data"
    assert _trash_entries(base) == []


@pytest.mark.asyncio
async def test_delete_item_stays_trashed_when_a_cancelled_commit_lands(db_session, root, monkeypatch, test_engine):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    base, item_id, rev_id = root / project.storage_dir, item.id, rev.id
    in_flight, release = _commit_outlives_cancel(db_session, monkeypatch)
    await _cancel_mid_commit(delete_item(db_session, project, item), in_flight, release)
    assert await _fresh_scalars(test_engine, select(ProjectItem.id).where(ProjectItem.id == item_id)) == []
    assert await _fresh_scalars(test_engine, select(LibraryFile.id).where(LibraryFile.revision_id == rev_id)) == []
    assert not (base / "Modélisation" / "Support").exists()
    assert [p.name for p in _trash_entries(base)] == ["a.step"]


@pytest.mark.asyncio
async def test_delete_item_restored_when_cancelled_before_the_commit(db_session, root, monkeypatch, test_engine):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    base, item_id = root / project.storage_dir, item.id
    await _cancelled_before_commit(db_session, monkeypatch)
    with pytest.raises(asyncio.CancelledError):
        await delete_item(db_session, project, item)
    assert await _fresh_scalars(test_engine, select(ProjectItem.id).where(ProjectItem.id == item_id)) == [item_id]
    assert (base / "Modélisation" / "Support" / "R1" / "a.step").read_bytes() == b"data"
    assert _trash_entries(base) == []


@pytest.mark.asyncio
async def test_remove_file_restored_when_a_cancelled_commit_fails(db_session, root, monkeypatch, test_engine):
    project, item, rev, target_id = await _two_file_revision(db_session)
    base, rev_id = root / project.storage_dir, rev.id
    in_flight, release = _commit_outlives_cancel(db_session, monkeypatch, fails=True)
    await _cancel_mid_commit(remove_file_from_revision(db_session, project, item, rev, target_id), in_flight, release)
    kept = await _fresh_scalars(test_engine, select(LibraryFile.filename).where(LibraryFile.revision_id == rev_id))
    assert sorted(kept) == ["a.step", "b.step"]
    folder = base / "Modélisation" / "Support" / "R1"
    assert (folder / "a.step").read_bytes() == b"data" and (folder / "b.step").read_bytes() == b"other"
    assert _trash_entries(base) == []


@pytest.mark.asyncio
async def test_delete_revision_restored_when_a_cancelled_commit_fails(db_session, root, monkeypatch, test_engine):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    base, rev_id = root / project.storage_dir, rev.id
    in_flight, release = _commit_outlives_cancel(db_session, monkeypatch, fails=True)
    await _cancel_mid_commit(delete_revision(db_session, project, item, rev), in_flight, release)
    assert await _fresh_scalars(test_engine, select(ProjectRevision.id).where(ProjectRevision.id == rev_id)) == [rev_id]
    assert await _fresh_scalars(test_engine, select(LibraryFile.filename).where(LibraryFile.revision_id == rev_id)) == [
        "a.step"
    ]
    assert (base / "Modélisation" / "Support" / "R1" / "a.step").read_bytes() == b"data"
    assert _trash_entries(base) == []


@pytest.mark.asyncio
async def test_delete_item_restored_when_a_cancelled_commit_fails(db_session, root, monkeypatch, test_engine):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    base, item_id, rev_id = root / project.storage_dir, item.id, rev.id
    in_flight, release = _commit_outlives_cancel(db_session, monkeypatch, fails=True)
    await _cancel_mid_commit(delete_item(db_session, project, item), in_flight, release)
    assert await _fresh_scalars(test_engine, select(ProjectItem.id).where(ProjectItem.id == item_id)) == [item_id]
    assert await _fresh_scalars(test_engine, select(ProjectRevision.id).where(ProjectRevision.item_id == item_id)) == [
        rev_id
    ]
    assert await _fresh_scalars(test_engine, select(LibraryFile.filename).where(LibraryFile.revision_id == rev_id)) == [
        "a.step"
    ]
    assert (base / "Modélisation" / "Support" / "R1" / "a.step").read_bytes() == b"data"
    assert _trash_entries(base) == []


@pytest.mark.asyncio
async def test_repeated_cancellation_still_waits_for_the_commit(db_session, root, monkeypatch, test_engine):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    base, rev_id = root / project.storage_dir, rev.id
    in_flight, release = _commit_outlives_cancel(db_session, monkeypatch)
    task = asyncio.ensure_future(delete_revision(db_session, project, item, rev))
    await in_flight.wait()
    task.cancel()
    await asyncio.sleep(0)
    task.cancel()  # a second cancellation while the helper waits for the commit
    await asyncio.sleep(0)
    assert not task.done(), "the helper must not hand the session back while the commit is in flight"
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert await _fresh_scalars(test_engine, select(ProjectRevision.id).where(ProjectRevision.id == rev_id)) == []
    assert [p.name for p in _trash_entries(base)] == ["a.step"]


def _commit_stalls(db_session, monkeypatch):
    stalled = asyncio.Event()
    started: dict[str, asyncio.Task] = {}

    async def commit():
        started["commit_task"] = asyncio.current_task()
        await stalled.wait()

    monkeypatch.setattr(db_session, "commit", commit)
    monkeypatch.setattr(project_files, "_COMMIT_CANCEL_WAIT_S", 0.05)
    return stalled, started


async def _cancel_stalled_commit(operation, item_id, stalled, started, caplog, label):
    task = asyncio.ensure_future(operation)
    while "commit_task" not in started:
        await asyncio.sleep(0)
    task.cancel()
    with caplog.at_level("ERROR", logger=project_files.logger.name), pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, timeout=5)
    assert not started["commit_task"].done(), "the stalled commit is given up on, not awaited"
    [record] = [r for r in caplog.records if r.name == project_files.logger.name and r.levelname == "ERROR"]
    assert record.getMessage().startswith(f"Commit of {label} still pending 0.1 s after its request was cancelled")
    # the item lock is free again: a second operation on the item proceeds
    lock = project_files._item_lock(item_id)
    await asyncio.wait_for(lock.acquire(), timeout=1)
    lock.release()
    stalled.set()  # let the stalled commit task finish, so the loop closes without a pending task
    await started["commit_task"]


@pytest.mark.asyncio
async def test_add_revision_keeps_files_when_a_cancelled_commit_stalls(db_session, root, monkeypatch, caplog):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="scan", name="Mesh", user_id=None)
    storage_dir, item_id = project.storage_dir, item.id
    await db_session.commit()
    stalled, started = _commit_stalls(db_session, monkeypatch)
    await _cancel_stalled_commit(
        add_revision(db_session, project, item, [upload("a.ply")], note=None, derived_from_id=None, user_id=None),
        item_id,
        stalled,
        started,
        caplog,
        f"new revision of item {item_id}",
    )
    # may have landed: the files stay where the database may point
    assert (root / storage_dir / "Scan" / "Mesh" / "R1" / "a.ply").read_bytes() == b"data"


@pytest.mark.asyncio
async def test_delete_item_stays_trashed_when_a_cancelled_commit_stalls(db_session, root, monkeypatch, caplog):
    project = await _project(db_session)
    item, _rev_row = await _rev(db_session, project)
    await db_session.commit()
    base, item_id = root / project.storage_dir, item.id
    stalled, started = _commit_stalls(db_session, monkeypatch)
    await _cancel_stalled_commit(
        delete_item(db_session, project, item), item_id, stalled, started, caplog, f"deletion of item {item_id}"
    )
    assert not (base / "Modélisation" / "Support").exists()
    assert [p.name for p in _trash_entries(base)] == ["a.step"]


@pytest.mark.asyncio
async def test_commit_finishing_within_the_bound_after_cancel_still_counts(monkeypatch):
    """A commit that lands after the cancellation, inside the bound, is waited for as before."""
    monkeypatch.setattr(project_files, "_COMMIT_CANCEL_WAIT_S", 5.0)
    release = asyncio.Event()
    db = _GuardSession(commit=release.wait)
    outcome = project_files._CommitOutcome("test op")
    task = asyncio.ensure_future(project_files._commit_through_cancel(db, outcome))
    await asyncio.sleep(0)
    task.cancel()
    await asyncio.sleep(0.01)
    assert not task.done()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert outcome.may_have_landed is True


def _commit_task_cancelled_at_shutdown(db_session, monkeypatch):
    real_commit = db_session.commit
    in_flight, release = asyncio.Event(), asyncio.Event()
    started: dict[str, asyncio.Task] = {}

    async def worker_thread():
        await release.wait()
        await real_commit()

    async def commit():
        started["commit_task"] = asyncio.current_task()
        started["worker"] = asyncio.ensure_future(worker_thread())
        in_flight.set()
        await asyncio.shield(started["worker"])

    monkeypatch.setattr(db_session, "commit", commit)
    return in_flight, release, started


async def _shutdown_mid_commit(operation, in_flight, release, started):
    task = asyncio.ensure_future(operation)
    await in_flight.wait()
    started["commit_task"].cancel()
    task.cancel()
    for _ in range(5):
        await asyncio.sleep(0)
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    await started["worker"]  # the COMMIT the worker thread ran despite the shutdown


@pytest.mark.asyncio
async def test_add_revision_keeps_files_when_the_commit_task_is_cancelled_at_shutdown(
    db_session, root, monkeypatch, test_engine
):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="scan", name="Mesh", user_id=None)
    storage_dir, item_id = project.storage_dir, item.id
    await db_session.commit()
    in_flight, release, started = _commit_task_cancelled_at_shutdown(db_session, monkeypatch)
    await _shutdown_mid_commit(
        add_revision(db_session, project, item, [upload("a.ply")], note=None, derived_from_id=None, user_id=None),
        in_flight,
        release,
        started,
    )
    rev_ids = await _fresh_scalars(test_engine, select(ProjectRevision.id).where(ProjectRevision.item_id == item_id))
    assert len(rev_ids) == 1
    paths = await _fresh_scalars(
        test_engine, select(LibraryFile.file_path).where(LibraryFile.revision_id == rev_ids[0])
    )
    assert len(paths) == 1
    assert (root / storage_dir / "Scan" / "Mesh" / "R1" / "a.ply").read_bytes() == b"data"


@pytest.mark.asyncio
async def test_delete_revision_stays_trashed_when_the_commit_task_is_cancelled_at_shutdown(
    db_session, root, monkeypatch, test_engine
):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    base, rev_id = root / project.storage_dir, rev.id
    in_flight, release, started = _commit_task_cancelled_at_shutdown(db_session, monkeypatch)
    await _shutdown_mid_commit(delete_revision(db_session, project, item, rev), in_flight, release, started)
    assert await _fresh_scalars(test_engine, select(ProjectRevision.id).where(ProjectRevision.id == rev_id)) == []
    assert await _fresh_scalars(test_engine, select(LibraryFile.id).where(LibraryFile.revision_id == rev_id)) == []
    assert not (base / "Modélisation" / "Support" / "R1").exists()
    assert [p.name for p in _trash_entries(base)] == ["a.step"]


@pytest.mark.asyncio
async def test_remove_file_stays_trashed_when_the_commit_task_is_cancelled_at_shutdown(
    db_session, root, monkeypatch, test_engine
):
    project, item, rev, target_id = await _two_file_revision(db_session)
    base, rev_id = root / project.storage_dir, rev.id
    in_flight, release, started = _commit_task_cancelled_at_shutdown(db_session, monkeypatch)
    await _shutdown_mid_commit(
        remove_file_from_revision(db_session, project, item, rev, target_id), in_flight, release, started
    )
    kept = await _fresh_scalars(test_engine, select(LibraryFile.filename).where(LibraryFile.revision_id == rev_id))
    assert kept == ["b.step"]
    assert [p.name.startswith("a") for p in _trash_entries(base)] == [True]


@pytest.mark.asyncio
async def test_delete_item_stays_trashed_when_the_commit_task_is_cancelled_at_shutdown(
    db_session, root, monkeypatch, test_engine
):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    base, item_id = root / project.storage_dir, item.id
    in_flight, release, started = _commit_task_cancelled_at_shutdown(db_session, monkeypatch)
    await _shutdown_mid_commit(delete_item(db_session, project, item), in_flight, release, started)
    assert await _fresh_scalars(test_engine, select(ProjectItem.id).where(ProjectItem.id == item_id)) == []
    assert not (base / "Modélisation" / "Support").exists()
    assert [p.name for p in _trash_entries(base)] == ["a.step"]


@pytest.mark.asyncio
async def test_rename_item_keeps_the_new_folder_when_the_commit_task_is_cancelled_at_shutdown(
    db_session, root, monkeypatch, test_engine
):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    base, item_id, rev_id = root / project.storage_dir, item.id, rev.id
    in_flight, release, started = _commit_task_cancelled_at_shutdown(db_session, monkeypatch)
    await _shutdown_mid_commit(rename_item(db_session, project, item, "Nouveau"), in_flight, release, started)
    assert await _fresh_scalars(test_engine, select(ProjectItem.name).where(ProjectItem.id == item_id)) == ["Nouveau"]
    paths = await _fresh_scalars(test_engine, select(LibraryFile.file_path).where(LibraryFile.revision_id == rev_id))
    assert len(paths) == 1 and paths[0].endswith("Nouveau/R1/a.step")
    assert (base / "Modélisation" / "Nouveau" / "R1" / "a.step").read_bytes() == b"data"
    assert not (base / "Modélisation" / "Support").exists()  # no rename-back: the folder matches the committed paths


@pytest.mark.asyncio
async def test_fork_keeps_the_copied_files_when_the_commit_task_is_cancelled_at_shutdown(
    db_session, root, monkeypatch, tmp_path, test_engine
):
    from backend.app.api.routes.library import to_absolute_path

    project, item, rev, thumbs, section_dir = await _fork_source_with_thumbnail(db_session, monkeypatch, tmp_path)
    project_id, rev_id = project.id, rev.id
    in_flight, release, started = _commit_task_cancelled_at_shutdown(db_session, monkeypatch)
    await _shutdown_mid_commit(
        fork_revision(db_session, project, item, rev, "Support B", user_id=None), in_flight, release, started
    )
    forked_ids = await _fresh_scalars(
        test_engine,
        select(ProjectItem.id).where(
            ProjectItem.project_id == project_id,
            ProjectItem.name == "Support B",
            ProjectItem.forked_from_revision_id == rev_id,
        ),
    )
    assert len(forked_ids) == 1
    r1_ids = await _fresh_scalars(
        test_engine,
        select(ProjectRevision.id).where(ProjectRevision.item_id == forked_ids[0], ProjectRevision.number == 1),
    )
    assert len(r1_ids) == 1
    rows = await _fresh_scalars(test_engine, select(LibraryFile).where(LibraryFile.revision_id == r1_ids[0]))
    assert [r.filename for r in rows] == ["plate.3mf"]
    copied = section_dir / "Support B" / "R1" / "plate.3mf"
    assert to_absolute_path(rows[0].file_path) == copied
    assert copied.read_bytes() == (section_dir / "Support" / "R1" / "plate.3mf").read_bytes()
    copied_thumb = to_absolute_path(rows[0].thumbnail_path)
    assert copied_thumb is not None and copied_thumb.parent == thumbs and copied_thumb.is_file()
    assert len(list(thumbs.iterdir())) == 2  # no cleanup: the source's thumbnail and the copy's own


@pytest.mark.asyncio
async def test_rename_item_keeps_the_new_folder_when_a_cancelled_commit_lands(
    db_session, root, monkeypatch, test_engine
):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    base, item_id, rev_id = root / project.storage_dir, item.id, rev.id
    in_flight, release = _commit_outlives_cancel(db_session, monkeypatch)
    await _cancel_mid_commit(rename_item(db_session, project, item, "Nouveau"), in_flight, release)
    assert await _fresh_scalars(test_engine, select(ProjectItem.name).where(ProjectItem.id == item_id)) == ["Nouveau"]
    paths = await _fresh_scalars(test_engine, select(LibraryFile.file_path).where(LibraryFile.revision_id == rev_id))
    assert len(paths) == 1 and paths[0].endswith("Nouveau/R1/a.step")
    assert (base / "Modélisation" / "Nouveau" / "R1" / "a.step").read_bytes() == b"data"
    assert not (base / "Modélisation" / "Support").exists()  # the folder matches the committed paths


@pytest.mark.asyncio
async def test_rename_item_rolls_folder_back_when_a_cancelled_commit_fails(db_session, root, monkeypatch, test_engine):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    base, item_id, rev_id = root / project.storage_dir, item.id, rev.id
    in_flight, release = _commit_outlives_cancel(db_session, monkeypatch, fails=True)
    await _cancel_mid_commit(rename_item(db_session, project, item, "Nouveau"), in_flight, release)
    assert await _fresh_scalars(test_engine, select(ProjectItem.name).where(ProjectItem.id == item_id)) == ["Support"]
    paths = await _fresh_scalars(test_engine, select(LibraryFile.file_path).where(LibraryFile.revision_id == rev_id))
    assert len(paths) == 1 and paths[0].endswith("Support/R1/a.step")
    assert (base / "Modélisation" / "Support" / "R1" / "a.step").read_bytes() == b"data"
    assert not (base / "Modélisation" / "Nouveau").exists()


@pytest.mark.asyncio
async def test_rename_item_rolls_folder_back_when_cancelled_before_the_commit(
    db_session, root, monkeypatch, test_engine
):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    base, item_id, rev_id = root / project.storage_dir, item.id, rev.id
    await _cancelled_before_commit(db_session, monkeypatch)
    with pytest.raises(asyncio.CancelledError):
        await rename_item(db_session, project, item, "Nouveau")
    assert await _fresh_scalars(test_engine, select(ProjectItem.name).where(ProjectItem.id == item_id)) == ["Support"]
    paths = await _fresh_scalars(test_engine, select(LibraryFile.file_path).where(LibraryFile.revision_id == rev_id))
    assert len(paths) == 1 and paths[0].endswith("Support/R1/a.step")
    assert (base / "Modélisation" / "Support" / "R1" / "a.step").read_bytes() == b"data"
    assert not (base / "Modélisation" / "Nouveau").exists()


@pytest.mark.asyncio
async def test_fork_keeps_the_copied_files_when_a_cancelled_commit_lands(
    db_session, root, monkeypatch, tmp_path, test_engine
):
    from backend.app.api.routes.library import to_absolute_path

    project, item, rev, thumbs, section_dir = await _fork_source_with_thumbnail(db_session, monkeypatch, tmp_path)
    project_id, rev_id = project.id, rev.id
    in_flight, release = _commit_outlives_cancel(db_session, monkeypatch)
    await _cancel_mid_commit(
        fork_revision(db_session, project, item, rev, "Support B", user_id=None), in_flight, release
    )
    forked_ids = await _fresh_scalars(
        test_engine,
        select(ProjectItem.id).where(
            ProjectItem.project_id == project_id,
            ProjectItem.name == "Support B",
            ProjectItem.forked_from_revision_id == rev_id,
        ),
    )
    assert len(forked_ids) == 1
    r1_ids = await _fresh_scalars(
        test_engine,
        select(ProjectRevision.id).where(ProjectRevision.item_id == forked_ids[0], ProjectRevision.number == 1),
    )
    assert len(r1_ids) == 1
    rows = await _fresh_scalars(test_engine, select(LibraryFile).where(LibraryFile.revision_id == r1_ids[0]))
    assert [r.filename for r in rows] == ["plate.3mf"]
    copied = section_dir / "Support B" / "R1" / "plate.3mf"
    assert to_absolute_path(rows[0].file_path) == copied
    assert copied.read_bytes() == (section_dir / "Support" / "R1" / "plate.3mf").read_bytes()
    copied_thumb = to_absolute_path(rows[0].thumbnail_path)
    assert copied_thumb is not None and copied_thumb.parent == thumbs and copied_thumb.is_file()
    assert len(list(thumbs.iterdir())) == 2  # the source's thumbnail and the copy's own


@pytest.mark.asyncio
async def test_fork_cleans_up_when_a_cancelled_commit_fails(db_session, root, monkeypatch, tmp_path, test_engine):
    project, item, rev, thumbs, section_dir = await _fork_source_with_thumbnail(db_session, monkeypatch, tmp_path)
    project_id = project.id
    in_flight, release = _commit_outlives_cancel(db_session, monkeypatch, fails=True)
    await _cancel_mid_commit(
        fork_revision(db_session, project, item, rev, "Support B", user_id=None), in_flight, release
    )
    assert (
        await _fresh_scalars(
            test_engine,
            select(ProjectItem.id).where(ProjectItem.project_id == project_id, ProjectItem.name == "Support B"),
        )
        == []
    )
    assert not (section_dir / "Support B").exists()
    assert len(list(thumbs.iterdir())) == 1  # the copied thumbnail was removed again
    assert (section_dir / "Support" / "R1" / "plate.3mf").exists()


@pytest.mark.asyncio
async def test_fork_cleans_up_when_cancelled_before_the_commit(db_session, root, monkeypatch, tmp_path, test_engine):
    project, item, rev, thumbs, section_dir = await _fork_source_with_thumbnail(db_session, monkeypatch, tmp_path)
    project_id = project.id
    await _cancelled_before_commit(db_session, monkeypatch)
    with pytest.raises(asyncio.CancelledError):
        await fork_revision(db_session, project, item, rev, "Support B", user_id=None)
    assert (
        await _fresh_scalars(
            test_engine,
            select(ProjectItem.id).where(ProjectItem.project_id == project_id, ProjectItem.name == "Support B"),
        )
        == []
    )
    assert not (section_dir / "Support B").exists()
    assert len(list(thumbs.iterdir())) == 1
    assert (section_dir / "Support" / "R1" / "plate.3mf").exists()


class _GuardSession:
    def __init__(self, commit=None):
        self.commits = 0
        self._commit = commit

    async def commit(self):
        self.commits += 1
        if self._commit is not None:
            await self._commit()


def _recording_undo(calls: list[str], fail: BaseException | None = None):
    async def undo():
        calls.append("undo")
        if fail is not None:
            raise fail

    return undo


@pytest.mark.asyncio
async def test_committing_commits_without_undo_on_success():
    db, calls = _GuardSession(), []
    async with project_files._CommitGuard(db, _recording_undo(calls)) as commit:
        await commit()
    assert (db.commits, calls) == (1, [])


@pytest.mark.asyncio
async def test_committing_undoes_a_failure_before_the_commit_and_reraises_it():
    db, calls = _GuardSession(), []
    boom = ValueError("before the commit")
    with pytest.raises(ValueError) as caught:
        async with project_files._CommitGuard(db, _recording_undo(calls)):
            raise boom
    assert caught.value is boom
    assert (db.commits, calls) == (0, ["undo"])


@pytest.mark.asyncio
async def test_committing_skips_the_undo_when_a_cancelled_commit_landed(monkeypatch):
    calls: list[str] = []

    async def landed(db, outcome):
        outcome.may_have_landed = True
        raise asyncio.CancelledError

    monkeypatch.setattr(project_files, "_commit_through_cancel", landed)
    with pytest.raises(asyncio.CancelledError):
        async with project_files._CommitGuard(_GuardSession(), _recording_undo(calls)) as commit:
            await commit()
    assert calls == []


@pytest.mark.asyncio
async def test_committing_translates_after_the_undo_only_when_asked():
    calls: list[str] = []
    boom = RuntimeError("unique")

    def translate(exc):
        calls.append("translate")
        return ProjectFilesError(409, "taken") if exc is boom else None

    with pytest.raises(ProjectFilesError) as caught:
        async with project_files._CommitGuard(_GuardSession(), _recording_undo(calls), translate=translate):
            raise boom
    assert (caught.value.status_code, caught.value.__cause__) == (409, boom)
    assert calls == ["undo", "translate"]

    other = RuntimeError("other")
    with pytest.raises(RuntimeError) as kept:
        async with project_files._CommitGuard(_GuardSession(), _recording_undo(calls), translate=translate):
            raise other
    assert kept.value is other


@pytest.mark.asyncio
async def test_committing_logs_a_failing_undo_and_still_translates_the_original(caplog):
    calls: list[str] = []
    boom, undo_failed = RuntimeError("body"), OSError("undo")

    def translate(exc):
        calls.append("translate")
        return ProjectFilesError(409, "taken") if exc is boom else None

    caplog.set_level("WARNING", logger=project_files.logger.name)
    with pytest.raises(ProjectFilesError) as caught:
        async with project_files._CommitGuard(
            _GuardSession(), _recording_undo(calls, undo_failed), translate=translate, label="the test op"
        ):
            raise boom
    assert (caught.value.status_code, caught.value.__cause__) == (409, boom)
    assert calls == ["undo", "translate"]
    assert any("the test op" in r.getMessage() and r.exc_info and r.exc_info[1] is undo_failed for r in caplog.records)


@pytest.mark.asyncio
async def test_committing_keeps_the_original_error_when_the_undo_fails_and_nothing_translates(caplog):
    calls: list[str] = []
    boom = RuntimeError("body")
    caplog.set_level("WARNING", logger=project_files.logger.name)
    with pytest.raises(RuntimeError) as caught:
        async with project_files._CommitGuard(_GuardSession(), _recording_undo(calls, OSError("undo"))):
            raise boom
    assert caught.value is boom
    assert calls == ["undo"]
