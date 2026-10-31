"""Project files service: items, revisions, uploads and the tree (spec 1.3-1.5, 2.3) (split from test_project_files_service.py)."""

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
    _columns,
    _commit_and_rollback_fail,
    _commit_raises_integrity,
    _fresh_scalars,
    _mark_used,
    _name_check_passes,
    _rev,
    _revision_rows,
    _user,
)

root = projects_root_fixture()
legacy_uploads = legacy_uploads_fixture(autouse=True)


@pytest.mark.asyncio
async def test_create_item_validates_and_dedupes(db_session, root):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="scan", name="  Mesh brut ", user_id=None)
    assert (item.section, item.name, item.name_key) == ("scan", "Mesh brut", "mesh brut")
    with pytest.raises(ProjectFilesError) as dup:
        await create_item(db_session, project, section="scan", name="MESH BRUT", user_id=None)
    assert dup.value.status_code == 409
    with pytest.raises(ProjectFilesError) as bad:
        await create_item(db_session, project, section="garage", name="x", user_id=None)
    assert bad.value.status_code == 400
    with pytest.raises(ProjectFilesError):
        await create_item(db_session, project, section="scan", name="   ", user_id=None)


@pytest.mark.asyncio
async def test_duplicate_hash_in_same_item_warns(db_session, root):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="modelisation", name="Support", user_id=None)
    await add_revision(
        db_session, project, item, [upload("a.step", b"same")], note=None, derived_from_id=None, user_id=None
    )
    rev2, warnings = await add_revision(
        db_session, project, item, [upload("b.step", b"same")], note=None, derived_from_id=None, user_id=None
    )
    assert rev2.number == 2
    assert [(w.filename, w.same_as) for w in warnings] == [("b.step", "R1")]


@pytest.mark.asyncio
async def test_numbers_never_reused_after_delete(db_session, root):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="docs", name="Plan", user_id=None)
    rev1, _ = await add_revision(
        db_session, project, item, [upload("p.pdf")], note=None, derived_from_id=None, user_id=None
    )
    rev2, _ = await add_revision(
        db_session, project, item, [upload("p.pdf")], note=None, derived_from_id=None, user_id=None
    )
    await project_files.delete_revision(db_session, project, item, rev2)
    rev3, _ = await add_revision(
        db_session, project, item, [upload("p.pdf")], note=None, derived_from_id=None, user_id=None
    )
    assert (rev1.number, rev3.number) == (1, 3)


@pytest.mark.asyncio
async def test_failed_second_file_rolls_back_everything(db_session, root, monkeypatch):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="scan", name="Mesh", user_id=None)
    storage_dir, item_id = project.storage_dir, item.id  # the rollback below expires ORM attributes
    await db_session.commit()  # the item must outlive the rollback add_revision performs
    real = project_files._stream_upload_to_path
    calls = {"n": 0}

    async def flaky(file, dest, max_bytes, on_first_chunk=None):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError("disk full")
        return await real(file, dest, max_bytes)

    monkeypatch.setattr(project_files, "_stream_upload_to_path", flaky)
    with pytest.raises(OSError):
        await add_revision(
            db_session, project, item, [upload("a.ply"), upload("b.ply")], note=None, derived_from_id=None, user_id=None
        )
    folder = root / storage_dir / "Scan" / "Mesh" / "R1"
    assert not folder.exists() or list(folder.iterdir()) == []
    assert (await db_session.execute(select(ProjectRevision))).scalars().all() == []
    # re-query: the rollback expired `item`, and a lazy attribute load would need a greenlet
    assert (
        await db_session.execute(select(ProjectItem.last_revision_number).where(ProjectItem.id == item_id))
    ).scalar_one() == 0


@pytest.mark.asyncio
async def test_3mf_snapshot_written_once(db_session, root):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="impression", name="Support X1C", user_id=None)
    rev, _ = await add_revision(
        db_session, project, item, [upload("plate.3mf", threemf_bytes())], note=None, derived_from_id=None, user_id=None
    )
    assert rev.slicer_name == "BambuStudio"
    assert rev.print_profile["printer_model"] == "Bambu Lab X1C"
    assert rev.config_hash


@pytest.mark.asyncio
async def test_3mf_overlong_slicer_strings_are_stored_capped_at_64(db_session, root):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "3D/3dmodel.model",
            f'<model><metadata name="Application">{"N" * 100}-{"9" * 100}</metadata></model>',
        )
    project = await _project(db_session)
    item = await create_item(db_session, project, section="impression", name="Long slicer", user_id=None)
    rev, _ = await add_revision(
        db_session, project, item, [upload("plate.3mf", buf.getvalue())], note=None, derived_from_id=None, user_id=None
    )
    assert (rev.slicer_name, rev.slicer_version) == ("N" * 64, "9" * 64)


@pytest.mark.asyncio
async def test_3mf_snapshot_fills_all_five_revision_columns(db_session, root, tmp_path):
    from backend.app.services.project_snapshot import read_print_snapshot

    source = tmp_path / "plate.3mf"
    source.write_bytes(threemf_bytes())
    snap = read_print_snapshot(source)
    assert snap is not None and None not in (snap.config, snap.config_hash, snap.slicer_version, snap.print_profile)
    project = await _project(db_session)
    item = await create_item(db_session, project, section="impression", name="Support X1C", user_id=None)
    rev, _ = await add_revision(
        db_session, project, item, [upload("plate.3mf", threemf_bytes())], note=None, derived_from_id=None, user_id=None
    )
    assert (rev.config_snapshot, rev.config_hash, rev.slicer_name, rev.slicer_version, rev.print_profile) == (
        snap.config,
        snap.config_hash,
        snap.slicer_name,
        snap.slicer_version,
        snap.print_profile,
    )


@pytest.mark.asyncio
async def test_update_revision_status_note_and_derived_from(db_session, root):
    project = await _project(db_session)
    scan = await create_item(db_session, project, section="scan", name="Mesh", user_id=None)
    cad = await create_item(db_session, project, section="modelisation", name="Support", user_id=None)
    s1, _ = await add_revision(
        db_session, project, scan, [upload("s.ply")], note=None, derived_from_id=None, user_id=None
    )
    c1, _ = await add_revision(
        db_session, project, cad, [upload("c.step")], note=None, derived_from_id=s1.id, user_id=None
    )
    assert c1.derived_from_id == s1.id
    await update_revision(db_session, project, c1, fields={"status": "valide", "note": "ok"}, user_id=None)
    assert (c1.status, c1.note) == ("valide", "ok") and c1.status_changed_at is not None
    await update_revision(db_session, project, c1, fields={"derived_from_id": None}, user_id=None)
    assert c1.derived_from_id is None
    with pytest.raises(ProjectFilesError):
        await update_revision(db_session, project, c1, fields={"derived_from_id": c1.id}, user_id=None)
    await update_revision(db_session, project, s1, fields={"derived_from_id": c1.id}, user_id=None)
    with pytest.raises(ProjectFilesError):  # c1 -> s1 -> c1 would be a cycle
        await update_revision(db_session, project, c1, fields={"derived_from_id": s1.id}, user_id=None)
    other = await _project(db_session, "Autre")
    foreign = await create_item(db_session, other, section="scan", name="X", user_id=None)
    f1, _ = await add_revision(
        db_session, other, foreign, [upload("x.ply")], note=None, derived_from_id=None, user_id=None
    )
    with pytest.raises(ProjectFilesError) as cross:
        await update_revision(db_session, project, c1, fields={"derived_from_id": f1.id}, user_id=None)
    assert cross.value.status_code == 400
    with pytest.raises(ProjectFilesError):
        await update_revision(db_session, project, c1, fields={"status": "livre"}, user_id=None)


@pytest.mark.asyncio
async def test_nothing_is_written_to_the_db_before_streaming_finishes(db_session, root, monkeypatch):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="scan", name="Mesh", user_id=None)
    await db_session.commit()
    real = project_files._stream_files
    seen = {}

    async def spy(folder, uploads):
        seen["new"] = list(db_session.new)
        seen["dirty"] = list(db_session.dirty)
        return await real(folder, uploads)

    monkeypatch.setattr(project_files, "_stream_files", spy)
    await add_revision(db_session, project, item, [upload("a.ply")], note=None, derived_from_id=None, user_id=None)
    assert seen == {"new": [], "dirty": []}


@pytest.mark.asyncio
async def test_used_or_validated_revision_files_are_frozen(db_session, root):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await update_revision(db_session, project, rev, fields={"status": "valide"}, user_id=None)
    file_id = (await db_session.execute(select(LibraryFile.id).where(LibraryFile.revision_id == rev.id))).scalar_one()
    with pytest.raises(ProjectFilesError) as frozen:
        await remove_file_from_revision(db_session, project, item, rev, file_id)
    assert (frozen.value.status_code, frozen.value.detail) == (409, "Only an in-progress revision can change its files")
    item2, rev2 = await _rev(db_session, project, name="Autre")
    await _mark_used(db_session, rev2)
    with pytest.raises(ProjectFilesError) as used:
        await delete_revision(db_session, project, item2, rev2)
    assert used.value.status_code == 409


async def _delete_elsewhere(test_engine, revision_id: int) -> None:
    """``delete_revision`` of ``revision_id`` through its own session, as a concurrent request would."""
    async with AsyncSession(test_engine, expire_on_commit=False) as other:
        revision, item, project = await project_files.get_revision_bundle(other, revision_id)
        await delete_revision(other, project, item, revision)


async def _upload_while_target_is_deleted(db_session, root, monkeypatch, test_engine, *, target_is_newest: bool):
    project = await _project(db_session)
    source_item, target = await _rev(db_session, project, section="scan", name="Mesh")
    if not target_is_newest:
        await add_revision(
            db_session, project, source_item, [upload("b.ply")], note=None, derived_from_id=None, user_id=None
        )
    item = await create_item(db_session, project, section="modelisation", name="Support", user_id=None)
    storage_dir, item_id, target_id = project.storage_dir, item.id, target.id
    await db_session.commit()
    real = project_files._stream_files

    async def racing(folder, uploads):
        await _delete_elsewhere(test_engine, target_id)
        return await real(folder, uploads)

    monkeypatch.setattr(project_files, "_stream_files", racing)
    with pytest.raises(ProjectFilesError) as refused:
        await add_revision(
            db_session, project, item, [upload("c.step")], note=None, derived_from_id=target_id, user_id=None
        )
    assert (refused.value.status_code, refused.value.detail) == (
        400,
        "Derived-from revision must belong to the same project",
    )
    assert await _fresh_scalars(test_engine, select(ProjectRevision.id).where(ProjectRevision.item_id == item_id)) == []
    assert await _fresh_scalars(test_engine, select(LibraryFile.id).where(LibraryFile.filename == "c.step")) == []
    assert await _fresh_scalars(test_engine, select(ProjectRevision.id).where(ProjectRevision.id == target_id)) == []
    assert list(root.rglob("c.step")) == []
    assert all(list(folder.iterdir()) == [] for folder in (root / storage_dir).glob("*/Support/R1"))


@pytest.mark.asyncio
async def test_upload_refuses_a_derived_from_target_deleted_while_streaming(db_session, root, monkeypatch, test_engine):
    await _upload_while_target_is_deleted(db_session, root, monkeypatch, test_engine, target_is_newest=False)


@pytest.mark.asyncio
async def test_upload_refuses_a_deleted_target_whose_id_the_new_revision_reused(
    db_session, root, monkeypatch, test_engine
):
    # project_revisions.id has no AUTOINCREMENT: deleting the newest row hands its id to the next insert
    await _upload_while_target_is_deleted(db_session, root, monkeypatch, test_engine, target_is_newest=True)


@pytest.mark.asyncio
async def test_update_revision_refuses_a_derived_from_target_deleted_after_the_check(
    db_session, root, monkeypatch, test_engine
):
    project = await _project(db_session)
    _scan, target = await _rev(db_session, project, section="scan", name="Mesh")
    _cad, revision = await _rev(db_session, project)
    target_id, revision_id = target.id, revision.id
    await db_session.commit()
    real = project_files._check_derived_from
    calls = []

    async def racing(db, project, revision_id, target_id):
        await real(db, project, revision_id, target_id)
        if not calls:
            calls.append(target_id)
            await _delete_elsewhere(test_engine, target_id)

    monkeypatch.setattr(project_files, "_check_derived_from", racing)
    with pytest.raises(ProjectFilesError) as refused:
        await update_revision(db_session, project, revision, fields={"derived_from_id": target_id}, user_id=None)
    assert (refused.value.status_code, refused.value.detail) == (
        400,
        "Derived-from revision must belong to the same project",
    )
    assert calls == [target_id]
    await db_session.rollback()  # what get_db does with the route's error
    assert await _fresh_scalars(
        test_engine, select(ProjectRevision.derived_from_id).where(ProjectRevision.id == revision_id)
    ) == [None]


@pytest.mark.asyncio
async def test_upload_row_columns_are_pinned(db_session, root):
    import hashlib

    from backend.app.api.routes.library import to_relative_path

    user = await _user(db_session, "t031-uploader")
    project = await _project(db_session)
    item = await create_item(db_session, project, section="modelisation", name="Support", user_id=user.id)
    rev, _ = await add_revision(
        db_session, project, item, [upload("a.step", b"geo")], note=None, derived_from_id=None, user_id=user.id
    )
    [row] = (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == rev.id))).scalars().all()
    await db_session.refresh(row)
    folder = root / project.storage_dir / "Modélisation" / "Support" / "R1"
    assert _columns(row) == {
        "project_id": project.id,
        "revision_id": rev.id,
        "folder_id": None,
        "is_external": False,
        "variant_group_id": None,
        "variant_position": 0,
        "filename": "a.step",
        "file_path": to_relative_path(folder / "a.step"),
        "file_type": "step",
        "file_size": 3,
        "file_hash": hashlib.sha256(b"geo").hexdigest(),
        "thumbnail_path": None,
        "file_metadata": None,
        "created_by_id": user.id,
        "notes": None,
    }


async def _reuse_two_manager_rows(db_session, monkeypatch, tmp_path):
    """Two File Manager rows (a G-code with a thumbnail and metadata, a 3MF without) reused into a
    new revision by another user. Returns (project, revision, kept id, plate id, owner, 3MF bytes, thumbs dir)."""
    from backend.app.api.routes.library import to_relative_path
    from backend.app.models.library import FileVariantGroup, LibraryFolder

    thumbs = tmp_path / "thumbs"
    thumbs.mkdir()
    monkeypatch.setattr(project_files, "get_library_thumbnails_dir", lambda: thumbs)
    owner = await _user(db_session, "t031-owner")
    mover = await _user(db_session, "t031-mover")
    folder_row = LibraryFolder(name="Inbox")
    group = FileVariantGroup(name="Group")
    db_session.add_all([folder_row, group])
    await db_session.flush()
    src_dir = tmp_path / "manager"
    src_dir.mkdir()
    kept_src = src_dir / "kept.gcode"
    kept_src.write_bytes(b"G1 X1")
    plate_src = src_dir / "plate.3mf"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("Metadata/project_settings.config", '{"printer_model": "X"}')
        zf.writestr("3D/3dmodel.model", "<model></model>")
        zf.writestr("Metadata/plate_1.png", b"\x89PNG fake")
    plate_src.write_bytes(buffer.getvalue())

    def managed(path: Path, **extra) -> LibraryFile:
        return LibraryFile(
            folder_id=folder_row.id,
            filename=path.name,
            file_path=to_relative_path(path),
            file_type="old",
            file_size=1,
            file_hash="0" * 64,
            created_by_id=owner.id,
            variant_group_id=group.id,
            variant_position=3,
            notes="keep me",
            **extra,
        )

    kept = managed(kept_src, thumbnail_path="old/thumb.png", file_metadata={"old": "meta"})
    plate = managed(plate_src)
    db_session.add_all([kept, plate])
    await db_session.flush()
    kept_id, plate_id = kept.id, plate.id

    project = await _project(db_session)
    item = await create_item(db_session, project, section="impression", name="Plateau", user_id=None)
    rev = await project_files.add_revision_from_sources(
        db_session,
        project,
        item,
        [
            project_files.RevisionSource(path=kept_src, filename="kept.gcode", reuse_row=kept),
            project_files.RevisionSource(path=plate_src, filename="plate.3mf", reuse_row=plate),
        ],
        note=None,
        user_id=mover.id,
    )
    return project, rev, kept_id, plate_id, owner, buffer.getvalue(), thumbs


@pytest.mark.asyncio
async def test_reused_row_columns_are_pinned(db_session, root, monkeypatch, tmp_path):
    import hashlib

    from backend.app.api.routes.library import to_relative_path

    project, rev, kept_id, plate_id, owner, plate_bytes, thumbs = await _reuse_two_manager_rows(
        db_session, monkeypatch, tmp_path
    )
    rows = {
        r.id: r
        for r in (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == rev.id)))
        .scalars()
        .all()
    }
    assert sorted(rows) == sorted([kept_id, plate_id])  # same ids, no new rows
    folder = root / project.storage_dir / "Impression" / "Plateau" / "R1"
    common = {
        "project_id": project.id,
        "revision_id": rev.id,
        "folder_id": None,
        "is_external": False,
        "variant_group_id": None,
        "variant_position": 0,
        "created_by_id": owner.id,  # the reuse branch never touches the creator
        "notes": "keep me",
    }
    assert _columns(rows[kept_id]) == {
        **common,
        "filename": "kept.gcode",
        "file_path": to_relative_path(folder / "kept.gcode"),
        "file_type": "gcode",
        "file_size": 5,
        "file_hash": hashlib.sha256(b"G1 X1").hexdigest(),
        "thumbnail_path": "old/thumb.png",  # a reused row with a thumbnail keeps it and its metadata
        "file_metadata": {"old": "meta"},
    }
    plate_cols = _columns(rows[plate_id])
    new_thumb = plate_cols.pop("thumbnail_path")
    new_meta = plate_cols.pop("file_metadata")
    assert plate_cols == {
        **common,
        "filename": "plate.3mf",
        "file_path": to_relative_path(folder / "plate.3mf"),
        "file_type": "3mf",
        "file_size": len(plate_bytes),
        "file_hash": hashlib.sha256(plate_bytes).hexdigest(),
    }
    [thumb_file] = list(thumbs.iterdir())
    assert new_thumb == to_relative_path(thumb_file)  # no thumbnail before: the copy's new one is stored
    assert isinstance(new_meta, dict)


@pytest.mark.asyncio
async def test_add_revision_maps_a_revision_number_clash_to_409_after_cleaning_up(db_session, root, monkeypatch):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="scan", name="Mesh", user_id=None)
    await db_session.commit()
    folder = root / project.storage_dir / "Scan" / "Mesh" / "R1"
    error = _commit_raises_integrity(
        db_session, monkeypatch, "UNIQUE constraint failed: project_revisions.item_id, project_revisions.number"
    )
    with pytest.raises(ProjectFilesError) as caught:
        await add_revision(db_session, project, item, [upload("a.ply")], note=None, derived_from_id=None, user_id=None)
    assert (caught.value.status_code, caught.value.detail) == (
        409,
        "Another upload just created this revision number; try again",
    )
    assert caught.value.__cause__ is error
    assert folder.parent.is_dir() and not folder.exists()  # R1 was created, then removed by the undo


@pytest.mark.asyncio
async def test_add_revision_keeps_any_other_integrity_error(db_session, root, monkeypatch):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="scan", name="Mesh", user_id=None)
    await db_session.commit()
    folder = root / project.storage_dir / "Scan" / "Mesh" / "R1"
    error = _commit_raises_integrity(db_session, monkeypatch, "NOT NULL constraint failed: library_files.filename")
    with pytest.raises(IntegrityError) as caught:
        await add_revision(db_session, project, item, [upload("a.ply")], note=None, derived_from_id=None, user_id=None)
    assert caught.value is error
    assert folder.parent.is_dir() and not folder.exists()  # R1 was created, then removed by the undo


@pytest.mark.asyncio
async def test_add_revision_maps_the_named_revision_number_constraint_to_409(db_session, root, monkeypatch):
    # PostgreSQL names the constraint instead of the columns.
    project = await _project(db_session)
    item = await create_item(db_session, project, section="scan", name="Mesh", user_id=None)
    await db_session.commit()
    item_id = item.id
    folder = root / project.storage_dir / "Scan" / "Mesh" / "R1"
    error = _commit_raises_integrity(
        db_session, monkeypatch, 'duplicate key value violates unique constraint "uq_project_revisions_item_number"'
    )
    with pytest.raises(ProjectFilesError) as caught:
        await add_revision(db_session, project, item, [upload("a.ply")], note=None, derived_from_id=None, user_id=None)
    assert (caught.value.status_code, caught.value.detail) == (
        409,
        "Another upload just created this revision number; try again",
    )
    assert caught.value.__cause__ is error
    assert not folder.exists()
    assert await _revision_rows(db_session, item_id) == (0, 0)


@pytest.mark.asyncio
async def test_add_revision_still_maps_to_409_when_the_r_folder_cannot_be_removed(db_session, root, monkeypatch):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="scan", name="Mesh", user_id=None)
    await db_session.commit()
    item_id = item.id
    folder = root / project.storage_dir / "Scan" / "Mesh" / "R1"
    error = _commit_raises_integrity(
        db_session, monkeypatch, "UNIQUE constraint failed: project_revisions.item_id, project_revisions.number"
    )
    real_rmdir = project_files._rmdir
    refused: list[Path] = []

    def rmdir(path):
        if path == folder:
            refused.append(path)
            raise OSError("busy")
        return real_rmdir(path)

    monkeypatch.setattr(project_files, "_rmdir", rmdir)
    with pytest.raises(ProjectFilesError) as caught:
        await add_revision(db_session, project, item, [upload("a.ply")], note=None, derived_from_id=None, user_id=None)
    assert (caught.value.status_code, caught.value.detail) == (
        409,
        "Another upload just created this revision number; try again",
    )
    assert caught.value.__cause__ is error
    assert refused == [folder]
    assert folder.is_dir() and not any(folder.iterdir())  # the written file is gone; the empty R1 stays
    assert await _revision_rows(db_session, item_id) == (0, 0)


@pytest.mark.asyncio
async def test_add_revision_leaves_a_pre_existing_r_folder_in_place_on_a_clash(db_session, root, monkeypatch):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="scan", name="Mesh", user_id=None)
    await db_session.commit()
    item_id = item.id
    folder = root / project.storage_dir / "Scan" / "Mesh" / "R1"
    folder.mkdir(parents=True)
    (folder / "leftover.txt").write_bytes(b"old")
    _commit_raises_integrity(
        db_session, monkeypatch, "UNIQUE constraint failed: project_revisions.item_id, project_revisions.number"
    )
    with pytest.raises(ProjectFilesError) as caught:
        await add_revision(db_session, project, item, [upload("a.ply")], note=None, derived_from_id=None, user_id=None)
    assert caught.value.status_code == 409
    assert sorted(p.name for p in folder.iterdir()) == ["leftover.txt"]  # only what this upload wrote is removed
    assert await _revision_rows(db_session, item_id) == (0, 0)


@pytest.mark.asyncio
async def test_revision_writes_refuse_an_empty_file_list(db_session, root):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    folder = project_storage.item_dir(project, item.section, item.name)
    before = sorted(p.relative_to(folder).as_posix() for p in folder.rglob("*"))
    assert before == ["R1", "R1/a.step"]

    with pytest.raises(ProjectFilesError) as no_upload:
        await add_revision(db_session, project, item, [], note=None, derived_from_id=None, user_id=None)
    assert (no_upload.value.status_code, no_upload.value.detail) == (400, "A revision needs at least one file")
    with pytest.raises(ProjectFilesError) as no_source:
        await project_files.add_revision_from_sources(db_session, project, item, [], note=None, user_id=None)
    assert (no_source.value.status_code, no_source.value.detail) == (400, "A revision needs at least one file")

    numbers = (await db_session.execute(select(ProjectRevision.number))).scalars().all()
    assert numbers == [1]  # no R2 was created
    assert len((await db_session.execute(select(LibraryFile))).scalars().all()) == 1
    assert sorted(p.relative_to(folder).as_posix() for p in folder.rglob("*")) == before


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["deleted", "trashed", "filed", "moved"])
async def test_reuse_row_changed_during_copy_is_refused(test_engine, tmp_path, monkeypatch, change):
    """T-248: the DB step re-reads each reused row after its bytes were copied; a row that was
    deleted, trashed, filed into a revision or moved meanwhile refuses the revision with a 409."""
    from datetime import datetime, timezone

    from sqlalchemy import delete, update
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from backend.app.api.routes.library import to_relative_path
    from backend.tests.project_fixtures import create_wal_engine, point_projects_root

    root = point_projects_root(monkeypatch, tmp_path, subdir="projects")
    engine = await create_wal_engine(tmp_path / "wal.db")  # two real connections; test_engine only registers models
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with maker() as db, maker() as other:
            src_dir = tmp_path / "manager"
            src_dir.mkdir()
            src = src_dir / "plate.gcode"
            src.write_bytes(b"G1 X1")
            reused = LibraryFile(
                filename="plate.gcode",
                file_path=to_relative_path(src),
                file_type="gcode",
                file_size=5,
                is_external=False,
            )
            db.add(reused)
            project = await _project(db)
            item = await create_item(db, project, section="impression", name="Plateau", user_id=None)
            elsewhere = await create_item(db, project, section="impression", name="Ailleurs", user_id=None)
            other_rev, _ = await add_revision(
                db, project, elsewhere, [upload("a.gcode", b"a")], note=None, derived_from_id=None, user_id=None
            )
            await db.commit()
            reused_id, item_id, other_rev_id = reused.id, item.id, other_rev.id
            r1 = root / project.storage_dir / "Impression" / "Plateau" / "R1"

            mutations = {
                "deleted": delete(LibraryFile).where(LibraryFile.id == reused_id),
                "trashed": update(LibraryFile)
                .where(LibraryFile.id == reused_id)
                .values(deleted_at=datetime.now(timezone.utc)),
                "filed": update(LibraryFile).where(LibraryFile.id == reused_id).values(revision_id=other_rev_id),
                "moved": update(LibraryFile)
                .where(LibraryFile.id == reused_id)
                .values(file_path="elsewhere/plate.gcode"),
            }
            real_copy = project_files._copy_sources
            copied: list[Path] = []

            async def copy_then_change(folder, sources):
                written = await real_copy(folder, sources)
                copied.extend(entry.path for entry in written)
                assert all(path.exists() for path in copied)
                await other.execute(mutations[change])
                await other.commit()
                return written

            monkeypatch.setattr(project_files, "_copy_sources", copy_then_change)
            with pytest.raises(ProjectFilesError) as err:
                await project_files.add_revision_from_sources(
                    db,
                    project,
                    item,
                    [project_files.RevisionSource(path=src, filename="plate.gcode", reuse_row=reused)],
                    note=None,
                    user_id=None,
                )
            assert (err.value.status_code, err.value.detail) == (
                409,
                "A file changed while it was being moved; try again",
            )

        async with maker() as check:
            revisions = (
                (await check.execute(select(ProjectRevision).where(ProjectRevision.item_id == item_id))).scalars().all()
            )
            assert revisions == []
            assert (await check.get(ProjectItem, item_id)).last_revision_number == 0
            row = await check.get(LibraryFile, reused_id)
            if change == "deleted":
                assert row is None
            else:  # left exactly as the other session made it, never re-pointed at the copy
                assert row.project_id is None
                assert (row.file_path, row.revision_id, row.deleted_at is not None) == {
                    "trashed": (to_relative_path(src), None, True),
                    "filed": (to_relative_path(src), other_rev_id, False),
                    "moved": ("elsewhere/plate.gcode", None, False),
                }[change]
        assert len(copied) == 1 and not copied[0].exists()  # the copy is removed
        assert not r1.exists()  # the folder this attempt created is removed too
        assert src.read_bytes() == b"G1 X1"  # the source is never touched
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_add_revision_from_sources_writes_nothing_to_the_db_while_copying(
    db_session, root, tmp_path, monkeypatch
):
    project = await _project(db_session)
    item, _r1 = await _rev(db_session, project)
    await db_session.commit()
    src = tmp_path / "out.gcode.3mf"
    src.write_bytes(b"not really a zip")
    real = project_files._copy_sources
    seen = {}

    async def spy(folder, sources):
        seen["new"] = list(db_session.new)
        seen["dirty"] = list(db_session.dirty)
        seen["deleted"] = list(db_session.deleted)
        return await real(folder, sources)

    monkeypatch.setattr(project_files, "_copy_sources", spy)
    rev = await project_files.add_revision_from_sources(
        db_session,
        project,
        item,
        [project_files.RevisionSource(path=src, filename="Support.gcode.3mf")],
        note=None,
        user_id=None,
    )
    assert seen == {"new": [], "dirty": [], "deleted": []}
    assert rev.number == 2


def _sliced_3mf_bytes() -> bytes:
    """A 3MF whose name says source but whose zip carries plate G-code (classified ``gcode.3mf``)."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr(zipfile.ZipInfo("Metadata/plate_1.gcode", date_time=(1980, 1, 1, 0, 0, 0)), "G28")
    return buffer.getvalue()


def _classify_during_write_spy(monkeypatch, producer: str):
    """Record, per ``classify_file_type`` call, whether the producer ``producer`` had already returned
    (i.e. whether the file was classified in the DB step, under the write lock)."""
    real_classify = project_files.classify_file_type
    real_producer = getattr(project_files, producer)
    state = {"written": False}
    calls: list[tuple[str, bool]] = []

    def classify(filename, file_path=None):
        calls.append((filename, state["written"]))
        return real_classify(filename, file_path)

    async def produce(*args):
        written = await real_producer(*args)
        state["written"] = True
        return written

    monkeypatch.setattr(project_files, "classify_file_type", classify)
    monkeypatch.setattr(project_files, producer, produce)
    return calls


@pytest.mark.asyncio
async def test_add_revision_classifies_files_before_the_db_step(db_session, root, monkeypatch):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="modelisation", name="Support", user_id=None)
    await db_session.commit()
    calls = _classify_during_write_spy(monkeypatch, "_stream_files")
    rev, _ = await add_revision(
        db_session,
        project,
        item,
        [upload("plate.3mf", _sliced_3mf_bytes()), upload("a.step", b"geo")],
        note=None,
        derived_from_id=None,
        user_id=None,
    )
    assert calls == [("plate.3mf", False), ("a.step", False)]
    files = (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == rev.id))).scalars().all()
    assert sorted((f.filename, f.file_type) for f in files) == [("a.step", "step"), ("plate.3mf", "gcode.3mf")]


@pytest.mark.asyncio
async def test_add_revision_from_sources_classifies_files_before_the_db_step(db_session, root, tmp_path, monkeypatch):
    project = await _project(db_session)
    item, _r1 = await _rev(db_session, project)
    await db_session.commit()
    src = tmp_path / "out.3mf"
    src.write_bytes(_sliced_3mf_bytes())
    calls = _classify_during_write_spy(monkeypatch, "_copy_sources")
    rev = await project_files.add_revision_from_sources(
        db_session,
        project,
        item,
        [project_files.RevisionSource(path=src, filename="Support.3mf")],
        note=None,
        user_id=None,
    )
    assert calls == [("Support.3mf", False)]
    files = (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == rev.id))).scalars().all()
    assert [(f.filename, f.file_type) for f in files] == [("Support.3mf", "gcode.3mf")]


@pytest.mark.asyncio
async def test_create_item_racing_a_same_name_create_is_the_name_409(db_session, root, monkeypatch):
    project = await _project(db_session)
    winner = await create_item(db_session, project, section="impression", name="Support", user_id=None)
    await db_session.commit()
    project_id, winner_id = project.id, winner.id
    _name_check_passes(monkeypatch)
    with pytest.raises(ProjectFilesError) as caught:
        await create_item(db_session, project, section="impression", name="SUPPORT", user_id=None)
    assert (caught.value.status_code, caught.value.detail) == (
        409,
        "An item with this name already exists in this section",
    )
    assert isinstance(caught.value.__cause__, IntegrityError)
    # rolled back: the session is usable and only the winner exists
    rows = (await db_session.execute(select(ProjectItem.id).where(ProjectItem.project_id == project_id))).all()
    assert [r[0] for r in rows] == [winner_id]


@pytest.mark.asyncio
async def test_create_item_lets_another_integrity_error_through_unrolled(db_session, root, monkeypatch):
    project = await _project(db_session)
    await db_session.commit()
    error = IntegrityError("INSERT", {}, Exception("NOT NULL constraint failed: project_items.created_at"))

    async def boom(*_args, **_kwargs):
        raise error

    async def no_rollback():
        raise AssertionError("an unrelated integrity error must not be rolled back here")

    monkeypatch.setattr(db_session, "flush", boom)
    monkeypatch.setattr(db_session, "rollback", no_rollback)
    with pytest.raises(IntegrityError) as caught:
        await create_item(db_session, project, section="impression", name="Support", user_id=None)
    assert caught.value is error


@pytest.mark.asyncio
async def test_create_item_maps_the_postgresql_constraint_name_to_the_name_409(db_session, root, monkeypatch):
    project = await _project(db_session)
    await db_session.commit()
    error = IntegrityError(
        "INSERT", {}, Exception('duplicate key value violates unique constraint "uq_project_items_section_name"')
    )

    async def boom(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(db_session, "flush", boom)
    with pytest.raises(ProjectFilesError) as caught:
        await create_item(db_session, project, section="impression", name="Support", user_id=None)
    assert (caught.value.status_code, caught.value.detail) == (
        409,
        "An item with this name already exists in this section",
    )
    assert caught.value.__cause__ is error


@pytest.mark.asyncio
async def test_add_revision_removes_its_files_even_when_the_rollback_fails(db_session, root, monkeypatch, caplog):
    """T-482: the written files and the new R{n} folder go before the rollback is tried, so a
    failing rollback leaves no orphan on disk (the commit's error is still the one raised)."""
    project = await _project(db_session)
    item = await create_item(db_session, project, section="modelisation", name="Support", user_id=None)
    await db_session.commit()
    folder = root / project.storage_dir / "Modélisation" / "Support" / "R1"
    commit_error, rollbacks = _commit_and_rollback_fail(db_session, monkeypatch)
    caplog.set_level("WARNING", logger=project_files.logger.name)
    with pytest.raises(RuntimeError) as caught:
        await add_revision(
            db_session,
            project,
            item,
            [upload("a.step"), upload("b.step", b"other")],
            note=None,
            derived_from_id=None,
            user_id=None,
        )
    assert caught.value is commit_error
    assert rollbacks == ["rollback"]
    assert not folder.exists()
    assert any("Undo after the failed" in r.getMessage() and r.exc_info for r in caplog.records)


@pytest.mark.asyncio
async def test_add_revision_into_an_existing_folder_removes_only_its_files_when_the_rollback_fails(
    db_session, root, monkeypatch
):
    """T-482: a revision folder that already held something is kept, only this call's files go."""
    project = await _project(db_session)
    item = await create_item(db_session, project, section="modelisation", name="Support", user_id=None)
    await db_session.commit()
    folder = root / project.storage_dir / "Modélisation" / "Support" / "R1"
    folder.mkdir(parents=True)
    (folder / "keep.txt").write_bytes(b"x")
    commit_error, rollbacks = _commit_and_rollback_fail(db_session, monkeypatch)
    with pytest.raises(RuntimeError) as caught:
        await add_revision(db_session, project, item, [upload("a.step")], note=None, derived_from_id=None, user_id=None)
    assert caught.value is commit_error
    assert rollbacks == ["rollback"]
    assert sorted(p.name for p in folder.iterdir()) == ["keep.txt"]
