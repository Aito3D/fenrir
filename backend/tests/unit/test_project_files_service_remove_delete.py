"""Project files service: removing files and deleting revisions and items (split from test_project_files_service.py)."""

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
    _CapturingSession,
    _fresh_scalars,
    _mark_used,
    _rev,
    _sqlite_sql,
    _trash_entries,
    _usage_branches,
)

root = projects_root_fixture()
legacy_uploads = legacy_uploads_fixture(autouse=True)


@pytest.mark.asyncio
async def test_add_and_remove_files_on_unused_wip(db_session, root):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project, files=[upload("a.step"), upload("b.step", b"b")])
    files = (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == rev.id))).scalars().all()
    assert len(files) == 2
    await remove_file_from_revision(db_session, project, item, rev, files[0].id)
    remaining = (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == rev.id))).scalars().all()
    assert len(remaining) == 1
    assert list((root / project.storage_dir / "_trash").rglob("a-*.step"))
    with pytest.raises(ProjectFilesError) as last:
        await remove_file_from_revision(db_session, project, item, rev, remaining[0].id)
    assert last.value.status_code == 409


async def _used_after_the_pre_check(db_session, monkeypatch, make_used):
    """``make_used`` commits a use of the revision right after delete_revision's pre-check passed."""
    real = project_files.revision_is_used
    calls = []

    async def racing(db, revision_id):
        used = await real(db, revision_id)
        if not calls:
            calls.append(revision_id)
            await make_used(db, revision_id)
            await db.commit()
        return used

    monkeypatch.setattr(project_files, "revision_is_used", racing)
    return calls


@pytest.mark.asyncio
async def test_delete_revision_refuses_a_delivery_that_landed_after_the_pre_check(
    db_session, root, monkeypatch, test_engine
):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    base, rev_id = root / project.storage_dir, rev.id

    async def deliver(db, revision_id):
        db.add(AitoTaskDelivery(task_id=4242, revision_id=revision_id))

    calls = await _used_after_the_pre_check(db_session, monkeypatch, deliver)
    with pytest.raises(ProjectFilesError) as exc:
        await delete_revision(db_session, project, item, rev)
    assert calls == [rev_id]
    assert (exc.value.status_code, exc.value.detail) == (
        409,
        "This revision was printed or delivered and cannot be deleted",
    )
    assert await _fresh_scalars(test_engine, select(ProjectRevision.id).where(ProjectRevision.id == rev_id)) == [rev_id]
    assert await _fresh_scalars(test_engine, select(LibraryFile.filename).where(LibraryFile.revision_id == rev_id)) == [
        "a.step"
    ]
    assert (base / "Modélisation" / "Support" / "R1" / "a.step").read_bytes() == b"data"
    assert _trash_entries(base) == []


@pytest.mark.asyncio
async def test_delete_revision_refuses_a_print_that_landed_after_the_pre_check(
    db_session, root, monkeypatch, test_engine
):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    base, rev_id = root / project.storage_dir, rev.id

    async def print_it(db, revision_id):
        await _mark_used(db, await db.get(ProjectRevision, revision_id))

    await _used_after_the_pre_check(db_session, monkeypatch, print_it)
    with pytest.raises(ProjectFilesError) as exc:
        await delete_revision(db_session, project, item, rev)
    assert exc.value.status_code == 409
    assert await _fresh_scalars(test_engine, select(ProjectRevision.id).where(ProjectRevision.id == rev_id)) == [rev_id]
    assert (base / "Modélisation" / "Support" / "R1" / "a.step").read_bytes() == b"data"
    assert _trash_entries(base) == []


@pytest.mark.asyncio
async def test_a_deleted_revision_without_files_is_unused_like_the_pre_check(db_session, root):
    # revision_is_used only sees deliveries through the revision's files
    db_session.add(AitoTaskDelivery(task_id=4242, revision_id=777))
    await db_session.flush()
    assert await revision_is_used(db_session, 777) is False
    assert await project_files._deleted_revision_is_used(db_session, 777, []) is False


@pytest.mark.asyncio
async def test_delete_revision_moves_to_trash_and_clears_links(db_session, root):
    project = await _project(db_session)
    item, r1 = await _rev(db_session, project)
    r2, _ = await add_revision(
        db_session, project, item, [upload("b.step")], note=None, derived_from_id=r1.id, user_id=None
    )
    await delete_revision(db_session, project, item, r1)
    assert (
        await db_session.execute(select(ProjectRevision.derived_from_id).where(ProjectRevision.id == r2.id))
    ).scalar_one() is None
    assert not (root / project.storage_dir / "Modélisation" / "Support" / "R1").exists()
    assert list((root / project.storage_dir / "_trash" / "Modélisation" / "Support").glob("R1-*"))
    assert (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == r1.id))).scalars().all() == []


async def _commit_fails(db_session, monkeypatch):
    async def boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(db_session, "commit", boom)


@pytest.mark.asyncio
async def test_remove_file_restores_it_from_trash_on_commit_failure(db_session, root, monkeypatch):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project, files=[upload("a.step"), upload("b.step", b"other")])
    base = root / project.storage_dir  # the failed commit rolls back and expires ``project``
    item_id, rev_id = item.id, rev.id
    rows = (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == rev_id))).scalars().all()
    target_id = next(f.id for f in rows if f.filename == "a.step")
    row_ids = {f.id for f in rows}
    await _commit_fails(db_session, monkeypatch)
    with pytest.raises(RuntimeError, match="db down"):
        await remove_file_from_revision(db_session, project, item, rev, target_id)
    folder = base / "Modélisation" / "Support" / "R1"
    assert (folder / "a.step").read_bytes() == b"data" and (folder / "b.step").read_bytes() == b"other"
    assert _trash_entries(base) == []
    kept = (await db_session.execute(select(LibraryFile.id).where(LibraryFile.revision_id == rev_id))).scalars().all()
    assert set(kept) == row_ids
    assert (await db_session.execute(select(ProjectItem.id).where(ProjectItem.id == item_id))).scalar_one() == item_id


@pytest.mark.asyncio
async def test_delete_revision_restores_its_folder_from_trash_on_commit_failure(db_session, root, monkeypatch):
    project = await _project(db_session)
    item, r1 = await _rev(db_session, project)
    r2, _ = await add_revision(
        db_session, project, item, [upload("b.step")], note=None, derived_from_id=r1.id, user_id=None
    )
    base = root / project.storage_dir
    r1_id, r2_id = r1.id, r2.id
    file_ids = (
        (await db_session.execute(select(LibraryFile.id).where(LibraryFile.revision_id == r1_id))).scalars().all()
    )
    await _commit_fails(db_session, monkeypatch)
    with pytest.raises(RuntimeError, match="db down"):
        await delete_revision(db_session, project, item, r1)
    assert (base / "Modélisation" / "Support" / "R1" / "a.step").read_bytes() == b"data"
    assert _trash_entries(base) == []
    revisions = (await db_session.execute(select(ProjectRevision.id, ProjectRevision.derived_from_id))).all()
    assert {(r.id, r.derived_from_id) for r in revisions} == {(r1_id, None), (r2_id, r1_id)}  # link not cleared
    kept = (await db_session.execute(select(LibraryFile.id).where(LibraryFile.revision_id == r1_id))).scalars().all()
    assert set(kept) == set(file_ids) and file_ids


@pytest.mark.asyncio
async def test_a_failed_restore_from_trash_still_rolls_back_and_keeps_the_commit_error(
    db_session, root, monkeypatch, caplog
):
    project = await _project(db_session)
    item, r1 = await _rev(db_session, project)
    base = root / project.storage_dir
    commit_error, rollbacks = RuntimeError("db down"), []
    real_rollback = db_session.rollback

    async def boom():
        # the folder is in the trash by now; make moving it back fail too
        monkeypatch.setattr(project_files, "_move", _raise_os_error)
        raise commit_error

    async def rollback():
        rollbacks.append("rollback")
        await real_rollback()

    monkeypatch.setattr(db_session, "commit", boom)
    monkeypatch.setattr(db_session, "rollback", rollback)
    caplog.set_level("WARNING", logger=project_files.logger.name)
    with pytest.raises(RuntimeError) as caught:
        await delete_revision(db_session, project, item, r1)
    assert caught.value is commit_error
    assert rollbacks == ["rollback"]
    original = str(base / "Modélisation" / "Support" / "R1")
    assert any(original in r.getMessage() and r.exc_info for r in caplog.records)
    assert len([p for p in (base / "_trash" / "Modélisation" / "Support").iterdir() if p.name.startswith("R1-")]) == 1


def _raise_os_error(*_args, **_kwargs):
    raise OSError("move back failed")


@pytest.mark.asyncio
async def test_delete_item_restores_its_folder_from_trash_on_commit_failure(db_session, root, monkeypatch):
    project = await _project(db_session)
    item, r1 = await _rev(db_session, project)
    r2, _ = await add_revision(
        db_session, project, item, [upload("b.step")], note=None, derived_from_id=None, user_id=None
    )
    base = root / project.storage_dir
    item_id, rev_ids = item.id, {r1.id, r2.id}
    file_count = len(
        (await db_session.execute(select(LibraryFile.id).where(LibraryFile.revision_id.in_(rev_ids)))).all()
    )
    await _commit_fails(db_session, monkeypatch)
    with pytest.raises(RuntimeError, match="db down"):
        await delete_item(db_session, project, item)
    folder = base / "Modélisation" / "Support"
    assert (folder / "R1" / "a.step").exists() and (folder / "R2" / "b.step").exists()
    assert _trash_entries(base) == []
    assert (await db_session.execute(select(ProjectItem.id).where(ProjectItem.id == item_id))).scalar_one() == item_id
    kept = (
        (await db_session.execute(select(ProjectRevision.id).where(ProjectRevision.item_id == item_id))).scalars().all()
    )
    assert set(kept) == rev_ids
    files = (await db_session.execute(select(LibraryFile.id).where(LibraryFile.revision_id.in_(rev_ids)))).all()
    assert len(files) == file_count == 2


@pytest.mark.asyncio
async def test_delete_item_requires_unused_revisions(db_session, root):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await _mark_used(db_session, rev)
    with pytest.raises(ProjectFilesError):
        await delete_item(db_session, project, item)
    free, _ = await _rev(db_session, project, name="Libre")
    await delete_item(db_session, project, free)
    assert (await db_session.execute(select(ProjectItem).where(ProjectItem.id == free.id))).first() is None


@pytest.mark.asyncio
async def test_deleted_revision_is_used_query_is_the_usage_union_without_delivered_branch():
    session = _CapturingSession()
    assert await project_files._deleted_revision_is_used(session, 7, [3, 4]) is False
    delivery_check, usage = session.statements
    assert _sqlite_sql(delivery_check) == (
        "SELECT aito_task_deliveries.revision_id \nFROM aito_task_deliveries \n"
        "WHERE aito_task_deliveries.revision_id = 7\n LIMIT 1 OFFSET 0"
    )
    assert _sqlite_sql(usage) == " UNION ".join(_usage_branches("(3, 4)"))


@pytest.mark.asyncio
async def test_remove_file_rejects_a_revision_of_another_item(db_session, root):
    project = await _project(db_session)
    item, _ = await _rev(db_session, project, name="Support")
    _, other_rev = await _rev(db_session, project, name="Autre")
    await db_session.commit()
    other_file = (
        await db_session.execute(select(LibraryFile.id).where(LibraryFile.revision_id == other_rev.id))
    ).scalar_one()
    with pytest.raises(ProjectFilesError) as caught:
        await remove_file_from_revision(db_session, project, item, other_rev, other_file)
    assert (caught.value.status_code, caught.value.detail) == (404, "Revision not found")
    assert (
        await db_session.execute(select(LibraryFile).where(LibraryFile.id == other_file))
    ).scalar_one().deleted_at is None


@pytest.mark.asyncio
async def test_remove_file_rejects_a_file_outside_the_revision(db_session, root):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project, files=[upload("a.step"), upload("b.step")])
    _, other_rev = await _rev(db_session, project, name="Autre")
    await db_session.commit()
    stranger = (
        await db_session.execute(select(LibraryFile.id).where(LibraryFile.revision_id == other_rev.id))
    ).scalar_one()
    with pytest.raises(ProjectFilesError) as caught:
        await remove_file_from_revision(db_session, project, item, rev, stranger)
    assert (caught.value.status_code, caught.value.detail) == (404, "File not found in this revision")
    folder = root / project.storage_dir / "Modélisation" / "Support" / "R1"
    assert sorted(p.name for p in folder.iterdir()) == ["a.step", "b.step"]


@pytest.mark.asyncio
async def test_delete_file_rows_with_nothing_to_delete_returns_empty(db_session: AsyncSession):
    """A revision without library rows deletes nothing and reports no ids."""
    assert await project_files._delete_file_rows(db_session, revision_ids=[987654]) == []
    assert await project_files._delete_file_rows(db_session, revision_ids=None) == []
    assert await project_files._delete_file_rows(db_session, file_ids=[]) == []


def _spy_lock_and_usage(monkeypatch, module):
    calls: list[tuple] = []
    real_used = project_files.revision_is_used

    async def lock(db, revision_ids, *, share=False):
        calls.append(("lock", sorted(revision_ids), share))
        return None

    async def used(db, revision_id):
        calls.append(("used", revision_id))
        return await real_used(db, revision_id)

    monkeypatch.setattr(module, "lock_revision_rows", lock)
    monkeypatch.setattr(project_files, "revision_is_used", used)
    return calls


@pytest.mark.asyncio
async def test_delete_revision_locks_the_revision_before_the_usage_check(db_session, root, monkeypatch):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    rev_id = rev.id
    calls = _spy_lock_and_usage(monkeypatch, project_files)
    await delete_revision(db_session, project, item, rev)
    assert calls[:2] == [("lock", [rev_id], False), ("used", rev_id)]
    assert [c for c in calls if c[0] == "lock"] == [("lock", [rev_id], False)]


@pytest.mark.asyncio
async def test_delete_item_locks_every_revision_before_the_usage_checks(db_session, root, monkeypatch):
    project = await _project(db_session)
    item, r1 = await _rev(db_session, project)
    r2, _ = await add_revision(
        db_session, project, item, [upload("b.step")], note=None, derived_from_id=None, user_id=None
    )
    await db_session.commit()
    ids = sorted([r1.id, r2.id])
    calls = _spy_lock_and_usage(monkeypatch, project_files)
    await delete_item(db_session, project, item)
    assert calls[:3] == [("lock", ids, False), ("used", ids[0]), ("used", ids[1])]
    # The checks run again under the SQLite write lock, before the rows go.
    assert all(c[0] == "used" and c[1] in ids for c in calls[3:])
    assert [c for c in calls if c[0] == "lock"] == [("lock", ids, False)]


@pytest.mark.asyncio
async def test_remove_file_locks_the_revision_before_the_usage_check(db_session, root, monkeypatch):
    """T-292: removing a file locks its revision FOR UPDATE (PostgreSQL) before the pre-check, as the deletes do."""
    project = await _project(db_session)
    item, rev = await _rev(db_session, project, files=[upload("a.step"), upload("b.step", b"b")])
    await db_session.commit()
    rev_id = rev.id
    target_id = (
        (
            await db_session.execute(
                select(LibraryFile.id).where(LibraryFile.revision_id == rev_id).order_by(LibraryFile.id)
            )
        )
        .scalars()
        .first()
    )
    calls = _spy_lock_and_usage(monkeypatch, project_files)
    await remove_file_from_revision(db_session, project, item, rev, target_id)
    assert calls == [("lock", [rev_id], False), ("used", rev_id)]


async def _two_files_by_name(db_session, project):
    item, rev = await _rev(db_session, project, files=[upload("a.step"), upload("b.step", b"other")])
    await db_session.commit()
    rows = (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == rev.id))).scalars().all()
    return item, rev, {f.filename: f.id for f in rows}


async def _queue_it(db, revision_id, file_id):
    db.add(PrintQueueItem(library_file_id=file_id))


async def _deliver_it(db, revision_id, file_id):
    db.add(AitoTaskDelivery(task_id=4242, revision_id=revision_id))


async def _validate_it(db, revision_id, file_id):
    (await db.get(ProjectRevision, revision_id)).status = "valide"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("make_used", "detail"),
    [
        (_queue_it, "This revision was printed or delivered; make a new revision instead"),
        (_deliver_it, "This revision was printed or delivered; make a new revision instead"),
        (_validate_it, "Only an in-progress revision can change its files"),
    ],
)
async def test_remove_file_refuses_a_use_that_landed_after_the_pre_check(
    db_session, root, monkeypatch, test_engine, make_used, detail
):
    project = await _project(db_session)
    item, rev, ids = await _two_files_by_name(db_session, project)
    base, rev_id, target_id = root / project.storage_dir, rev.id, ids["a.step"]

    async def use_it(db, revision_id):
        await make_used(db, revision_id, target_id)

    calls = await _used_after_the_pre_check(db_session, monkeypatch, use_it)
    with pytest.raises(ProjectFilesError) as exc:
        await remove_file_from_revision(db_session, project, item, rev, target_id)
    assert calls == [rev_id]
    assert (exc.value.status_code, exc.value.detail) == (409, detail)
    kept = await _fresh_scalars(test_engine, select(LibraryFile.id).where(LibraryFile.revision_id == rev_id))
    assert sorted(kept) == sorted(ids.values())
    folder = base / "Modélisation" / "Support" / "R1"
    assert (folder / "a.step").read_bytes() == b"data" and (folder / "b.step").read_bytes() == b"other"
    assert _trash_entries(base) == []


@pytest.mark.asyncio
async def test_remove_file_refuses_a_print_of_another_file_that_landed_after_the_pre_check(
    db_session, root, monkeypatch, test_engine
):
    """The re-check covers the revision's other files too, like the pre-check."""
    project = await _project(db_session)
    item, rev, ids = await _two_files_by_name(db_session, project)
    base, rev_id, target_id = root / project.storage_dir, rev.id, ids["a.step"]

    async def print_other(db, revision_id):
        db.add(PrintArchive(filename="x", file_path="x", file_size=1, library_file_id=ids["b.step"]))

    await _used_after_the_pre_check(db_session, monkeypatch, print_other)
    with pytest.raises(ProjectFilesError) as exc:
        await remove_file_from_revision(db_session, project, item, rev, target_id)
    assert (exc.value.status_code, exc.value.detail) == (
        409,
        "This revision was printed or delivered; make a new revision instead",
    )
    assert target_id in await _fresh_scalars(
        test_engine, select(LibraryFile.id).where(LibraryFile.revision_id == rev_id)
    )
    assert _trash_entries(base) == []


@pytest.mark.asyncio
async def test_remove_file_with_nothing_landing_meanwhile_still_trashes_it(db_session, root, monkeypatch, test_engine):
    project = await _project(db_session)
    item, rev, ids = await _two_files_by_name(db_session, project)
    base, rev_id, target_id = root / project.storage_dir, rev.id, ids["a.step"]

    async def nothing(db, revision_id):
        return None

    await _used_after_the_pre_check(db_session, monkeypatch, nothing)
    await remove_file_from_revision(db_session, project, item, rev, target_id)
    assert await _fresh_scalars(test_engine, select(LibraryFile.id).where(LibraryFile.revision_id == rev_id)) == [
        ids["b.step"]
    ]
    assert not (base / "Modélisation" / "Support" / "R1" / "a.step").exists()
    assert [p.name.split("-")[0] for p in _trash_entries(base)] == ["a"]


async def _used_once_deleted(monkeypatch) -> list[int]:
    """``_deleted_revision_is_used`` answers True: a use only the post-delete re-check sees."""
    seen: list[int] = []

    async def used(_db, revision_id, _file_ids):
        seen.append(revision_id)
        return True

    monkeypatch.setattr(project_files, "_deleted_revision_is_used", used)
    return seen


@pytest.mark.asyncio
async def test_delete_revision_refuses_a_use_seen_only_by_the_post_delete_recheck(
    db_session, root, monkeypatch, test_engine
):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    base, rev_id = root / project.storage_dir, rev.id
    seen = await _used_once_deleted(monkeypatch)
    with pytest.raises(ProjectFilesError) as exc:
        await delete_revision(db_session, project, item, rev)
    assert seen == [rev_id]
    assert (exc.value.status_code, exc.value.detail) == (
        409,
        "This revision was printed or delivered and cannot be deleted",
    )
    assert await _fresh_scalars(test_engine, select(ProjectRevision.id).where(ProjectRevision.id == rev_id)) == [rev_id]
    assert (base / "Modélisation" / "Support" / "R1" / "a.step").read_bytes() == b"data"
    assert _trash_entries(base) == []


@pytest.mark.asyncio
async def test_delete_item_refuses_a_use_seen_only_by_the_post_delete_recheck(
    db_session, root, monkeypatch, test_engine
):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    base, item_id, rev_id = root / project.storage_dir, item.id, rev.id
    seen = await _used_once_deleted(monkeypatch)
    with pytest.raises(ProjectFilesError) as exc:
        await delete_item(db_session, project, item)
    assert seen == [rev_id]
    assert (exc.value.status_code, exc.value.detail) == (
        409,
        "A revision of this item was printed or delivered; the item cannot be deleted",
    )
    assert await _fresh_scalars(test_engine, select(ProjectItem.id).where(ProjectItem.id == item_id)) == [item_id]
    assert (base / "Modélisation" / "Support" / "R1" / "a.step").read_bytes() == b"data"
    assert _trash_entries(base) == []


@pytest.mark.asyncio
async def test_removing_a_file_from_a_used_wip_revision_is_refused(db_session, root):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project, files=[upload("a.step"), upload("b.step", b"b")])
    await _mark_used(db_session, rev)
    folder = project_storage.item_dir(project, item.section, item.name) / "R1"
    file_id = (
        (await db_session.execute(select(LibraryFile.id).where(LibraryFile.revision_id == rev.id))).scalars().first()
    )

    with pytest.raises(ProjectFilesError) as used:
        await remove_file_from_revision(db_session, project, item, rev, file_id)
    assert (used.value.status_code, used.value.detail) == (
        409,
        "This revision was printed or delivered; make a new revision instead",
    )
    assert sorted(p.name for p in folder.iterdir()) == ["a.step", "b.step"]
    files = (await db_session.execute(select(LibraryFile.filename).where(LibraryFile.revision_id == rev.id))).all()
    assert sorted(f.filename for f in files) == ["a.step", "b.step"]
