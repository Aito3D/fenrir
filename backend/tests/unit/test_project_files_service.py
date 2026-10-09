"""Project files service: items, revisions, uploads (spec §1.3–§1.5, §2.3)."""

import asyncio
import io
import zipfile
from pathlib import Path

import pytest
from fastapi import UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.app.services import project_files, project_storage
from backend.app.services.project_files import (
    ProjectFilesError,
    add_files_to_revision,
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


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(project_storage, "projects_root", lambda: tmp_path)
    return tmp_path


def upload(name: str, data: bytes = b"data") -> UploadFile:
    return UploadFile(filename=name, file=io.BytesIO(data))


def threemf_bytes() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("Metadata/project_settings.config", '{"printer_model": "Bambu Lab X1C", "layer_height": "0.2"}')
        zf.writestr(
            "3D/3dmodel.model", '<model><metadata name="Application">BambuStudio-02.08.00.50</metadata></model>'
        )
    return buffer.getvalue()


async def _project(db, name="Support caméra"):
    project = Project(name=name)
    db.add(project)
    await db.flush()
    return project


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
async def test_add_revision_writes_tree_and_rows(db_session, root):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="scan", name="Mesh brut", user_id=None)
    rev, warnings = await add_revision(
        db_session,
        project,
        item,
        [upload("scan.ply", b"ply"), upload("scan.ply", b"tex")],
        note="brut",
        derived_from_id=None,
        user_id=None,
    )
    assert (rev.number, rev.status, rev.note, warnings) == (1, "wip", "brut", [])
    files = (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == rev.id))).scalars().all()
    assert sorted(f.filename for f in files) == ["scan (2).ply", "scan.ply"]
    folder = root / project.storage_dir / "Scan" / "Mesh brut" / "R1"
    assert sorted(p.name for p in folder.iterdir()) == ["scan (2).ply", "scan.ply"]
    assert all(f.project_id == project.id and f.folder_id is None and f.file_hash for f in files)
    assert not list(folder.glob("*.part"))


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
async def test_revision_is_used_by_archive(db_session, root):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="impression", name="Support", user_id=None)
    rev, _ = await add_revision(
        db_session, project, item, [upload("p.3mf", threemf_bytes())], note=None, derived_from_id=None, user_id=None
    )
    assert not await revision_is_used(db_session, rev.id)
    file_id = (await db_session.execute(select(LibraryFile.id).where(LibraryFile.revision_id == rev.id))).scalar_one()
    db_session.add(PrintArchive(filename="p.3mf", file_path="x", file_size=1, library_file_id=file_id))
    await db_session.flush()
    assert await revision_is_used(db_session, rev.id)


@pytest.mark.asyncio
async def test_commit_failure_leaves_no_files_thumbnails_or_rows(db_session, root, monkeypatch, tmp_path):
    thumbs = tmp_path / "thumbs"
    thumbs.mkdir()
    monkeypatch.setattr(project_files, "get_library_thumbnails_dir", lambda: thumbs)
    project = await _project(db_session)
    item = await create_item(db_session, project, section="impression", name="Support", user_id=None)
    storage_dir, item_id = project.storage_dir, item.id
    await db_session.commit()

    real_commit = db_session.commit
    calls = {"n": 0}

    async def failing_commit():
        calls["n"] += 1
        if calls["n"] == 1:
            assert list(thumbs.iterdir()), "the call should have written a thumbnail before the commit"
            raise OSError("commit failed")
        return await real_commit()

    monkeypatch.setattr(db_session, "commit", failing_commit)
    # a 3MF with a real thumbnail so the thumbnails dir gets a file
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("Metadata/project_settings.config", '{"printer_model": "X"}')
        zf.writestr("3D/3dmodel.model", "<model></model>")
        zf.writestr("Metadata/plate_1.png", b"\x89PNG fake")
    with pytest.raises(OSError):
        await add_revision(
            db_session,
            project,
            item,
            [upload("plate.3mf", buffer.getvalue())],
            note=None,
            derived_from_id=None,
            user_id=None,
        )
    folder = root / storage_dir / "Impression" / "Support" / "R1"
    assert not folder.exists() or list(folder.iterdir()) == []
    assert list(thumbs.iterdir()) == []
    assert (await db_session.execute(select(ProjectRevision))).scalars().all() == []
    assert (
        await db_session.execute(select(ProjectItem.last_revision_number).where(ProjectItem.id == item_id))
    ).scalar_one() == 0

    item = (await db_session.execute(select(ProjectItem).where(ProjectItem.id == item_id))).scalar_one()
    project = (await db_session.execute(select(Project).where(Project.id == item.project_id))).scalar_one()
    rev, _ = await add_revision(
        db_session,
        project,
        item,
        [upload("plate.3mf", threemf_bytes())],
        note=" n ",
        derived_from_id=None,
        user_id=None,
    )
    assert (rev.number, rev.note) == (1, "n")
    names = [p.name for p in (root / storage_dir / "Impression" / "Support" / "R1").iterdir()]
    assert names == ["plate.3mf"]


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


async def _rev(db, project, section="modelisation", name="Support", files=None):
    item = await create_item(db, project, section=section, name=name, user_id=None)
    rev, _ = await add_revision(
        db, project, item, files or [upload("a.step")], note=None, derived_from_id=None, user_id=None
    )
    return item, rev


async def _mark_used(db, rev):
    file_id = (await db.execute(select(LibraryFile.id).where(LibraryFile.revision_id == rev.id))).scalars().first()
    db.add(PrintArchive(filename="x", file_path="x", file_size=1, library_file_id=file_id))
    await db.flush()


@pytest.mark.asyncio
async def test_add_and_remove_files_on_unused_wip(db_session, root):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await add_files_to_revision(db_session, project, item, rev, [upload("b.step", b"b")], user_id=None)
    files = (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == rev.id))).scalars().all()
    assert len(files) == 2
    await remove_file_from_revision(db_session, project, item, rev, files[0].id)
    remaining = (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == rev.id))).scalars().all()
    assert len(remaining) == 1
    assert list((root / project.storage_dir / "_trash").rglob("a-*.step"))
    with pytest.raises(ProjectFilesError) as last:
        await remove_file_from_revision(db_session, project, item, rev, remaining[0].id)
    assert last.value.status_code == 409


@pytest.mark.asyncio
async def test_used_or_validated_revision_files_are_frozen(db_session, root):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await update_revision(db_session, project, rev, fields={"status": "valide"}, user_id=None)
    with pytest.raises(ProjectFilesError):
        await add_files_to_revision(db_session, project, item, rev, [upload("c.step")], user_id=None)
    item2, rev2 = await _rev(db_session, project, name="Autre")
    await _mark_used(db_session, rev2)
    with pytest.raises(ProjectFilesError) as used:
        await delete_revision(db_session, project, item2, rev2)
    assert used.value.status_code == 409


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


@pytest.mark.asyncio
async def test_rename_item_moves_folder_and_paths(db_session, root):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await rename_item(db_session, project, item, "Support v2")
    assert item.name == "Support v2"
    new_dir = root / project.storage_dir / "Modélisation" / "Support v2" / "R1"
    assert (new_dir / "a.step").exists()
    row = (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == rev.id))).scalar_one()
    assert row.file_path.endswith("Support v2/R1/a.step")


@pytest.mark.asyncio
async def test_rename_item_rolls_folder_back_on_db_failure(db_session, root, monkeypatch):
    project = await _project(db_session)
    item, _rev1 = await _rev(db_session, project)
    base = root / project.storage_dir  # the failed commit rolls back and expires ``project``

    async def boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(db_session, "commit", boom)
    with pytest.raises(RuntimeError):
        await rename_item(db_session, project, item, "Nouveau")
    assert (base / "Modélisation" / "Support" / "R1" / "a.step").exists()
    assert not (base / "Modélisation" / "Nouveau").exists()


def _trash_entries(base: Path) -> list[Path]:
    """Files left in the project's _trash (the empty parent folders move_to_trash created do not count)."""
    return [p for p in (base / "_trash").rglob("*") if not p.is_dir()] if (base / "_trash").exists() else []


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
async def test_rename_item_conflicts(db_session, root):
    project = await _project(db_session)
    item, _ = await _rev(db_session, project)
    await _rev(db_session, project, name="Autre")
    with pytest.raises(ProjectFilesError) as taken:
        await rename_item(db_session, project, item, "autre")
    assert taken.value.status_code == 409


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
async def test_fork_copies_files_into_new_item(db_session, root):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project, files=[upload("a.step", b"geo")])
    forked = await fork_revision(db_session, project, item, rev, "Support client B", user_id=None)
    assert forked.forked_from_revision_id == rev.id and forked.section == "modelisation"
    r1 = (await db_session.execute(select(ProjectRevision).where(ProjectRevision.item_id == forked.id))).scalar_one()
    assert (r1.number, r1.derived_from_id) == (1, rev.id)
    assert (root / project.storage_dir / "Modélisation" / "Support client B" / "R1" / "a.step").read_bytes() == b"geo"
    assert (root / project.storage_dir / "Modélisation" / "Support" / "R1" / "a.step").exists()


@pytest.mark.asyncio
async def test_tree_orders_sections_newest_revision_first_and_flags_outdated(db_session, root):
    project = await _project(db_session)
    cad, c1 = await _rev(db_session, project)
    imp = await create_item(db_session, project, section="impression", name="Support X1C", user_id=None)
    p1, _ = await add_revision(
        db_session, project, imp, [upload("p.3mf", threemf_bytes())], note=None, derived_from_id=c1.id, user_id=None
    )
    c2, _ = await add_revision(
        db_session, project, cad, [upload("b.step")], note=None, derived_from_id=None, user_id=None
    )
    await update_revision(db_session, project, c2, fields={"status": "valide"}, user_id=None)
    tree = await load_tree(db_session, project)
    assert [s.section for s in tree.sections] == ["scan", "modelisation", "impression", "usinage", "docs"]
    cad_out = tree.sections[1].items[0]
    assert [r.number for r in cad_out.revisions] == [2, 1]
    print_rev = tree.sections[2].items[0].revisions[0]
    assert print_rev.derived_from.number == 1 and print_rev.derived_from.item_name == "Support"
    assert print_rev.outdated_by.number == 2
    assert print_rev.has_snapshot and print_rev.print_profile["printer_model"] == "Bambu Lab X1C"
    assert print_rev.files[0].filename == "p.3mf"
    assert cad_out.revisions[0].outdated_by is None  # only Impression revisions go outdated


@pytest.mark.asyncio
async def test_item_names_colliding_on_disk_are_conflicts(db_session, root):
    project = await _project(db_session)
    await create_item(db_session, project, section="scan", name="Support", user_id=None)
    with pytest.raises(ProjectFilesError) as dotted:
        await create_item(db_session, project, section="scan", name="Support.", user_id=None)
    assert dotted.value.status_code == 409
    await create_item(db_session, project, section="scan", name="caf\u00e9", user_id=None)
    with pytest.raises(ProjectFilesError) as decomposed:
        await create_item(db_session, project, section="scan", name="cafe\u0301", user_id=None)
    assert decomposed.value.status_code == 409


@pytest.mark.asyncio
async def test_queue_variant_makes_a_revision_used(db_session, root):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    file_id = (await db_session.execute(select(LibraryFile.id).where(LibraryFile.revision_id == rev.id))).scalar_one()
    queue_item = PrintQueueItem(library_file_id=None)
    db_session.add(queue_item)
    await db_session.flush()
    assert not await revision_is_used(db_session, rev.id)
    db_session.add(PrintQueueVariant(queue_item_id=queue_item.id, library_file_id=file_id, target_model="X1C"))
    await db_session.flush()
    assert await revision_is_used(db_session, rev.id)


@pytest.mark.asyncio
async def test_case_only_rename(db_session, root):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await rename_item(db_session, project, item, "SUPPORT")
    assert item.name == "SUPPORT"
    assert (root / project.storage_dir / "Modélisation" / "SUPPORT" / "R1" / "a.step").exists()


@pytest.mark.asyncio
async def test_fork_writes_nothing_to_the_db_while_copying(db_session, root, monkeypatch):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    seen = {}
    real = project_files.shutil.copy2

    def spy(src, dst, *args, **kwargs):
        seen["new"] = list(db_session.new)
        seen["dirty"] = list(db_session.dirty)
        return real(src, dst, *args, **kwargs)

    monkeypatch.setattr(project_files.shutil, "copy2", spy)
    await fork_revision(db_session, project, item, rev, "Copie", user_id=None)
    assert seen == {"new": [], "dirty": []}


@pytest.mark.asyncio
async def test_fork_commit_failure_leaves_no_folder_or_rows(db_session, root, monkeypatch):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    base = root / project.storage_dir / "Modélisation"

    async def boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(db_session, "commit", boom)
    with pytest.raises(RuntimeError):
        await fork_revision(db_session, project, item, rev, "Copie", user_id=None)
    assert not (base / "Copie").exists()
    assert (await db_session.execute(select(ProjectItem).where(ProjectItem.name == "Copie"))).first() is None


@pytest.mark.asyncio
async def test_fork_with_no_copyable_file_is_refused(db_session, root):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    base = root / project.storage_dir / "Modélisation"
    (base / "Support" / "R1" / "a.step").unlink()
    with pytest.raises(ProjectFilesError) as err:
        await fork_revision(db_session, project, item, rev, "Copie", user_id=None)
    assert err.value.status_code == 409
    assert not (base / "Copie").exists()


@pytest.mark.asyncio
async def test_tree_used_flag_matches_revision_is_used(db_session, root):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    _item2, rev2 = await _rev(db_session, project, name="Autre")
    file_id = (await db_session.execute(select(LibraryFile.id).where(LibraryFile.revision_id == rev.id))).scalar_one()
    queue_item = PrintQueueItem(library_file_id=None)
    db_session.add(queue_item)
    await db_session.flush()
    db_session.add(PrintQueueVariant(queue_item_id=queue_item.id, library_file_id=file_id, target_model="X1C"))
    await db_session.flush()
    tree = await load_tree(db_session, project)
    used = {r.id: r.used for s in tree.sections for i in s.items for r in i.revisions}
    assert used == {rev.id: True, rev2.id: False}
    assert used[rev.id] == await revision_is_used(db_session, rev.id)
    assert used[rev2.id] == await revision_is_used(db_session, rev2.id)


async def _impression_revisions(db, **second_fields):
    project = await _project(db)
    item = await create_item(db, project, section="impression", name="Support", user_id=None)
    r1, _ = await add_revision(
        db, project, item, [upload("a.3mf", threemf_bytes())], note=None, derived_from_id=None, user_id=None
    )
    r2, _ = await add_revision(
        db, project, item, [upload("b.3mf", threemf_bytes())], note=None, derived_from_id=r1.id, user_id=None
    )
    r1.status = "valide"
    r2.status = "valide"
    for key, value in second_fields.items():
        setattr(r2, key, value)
    await db.commit()
    return project, r1, r2


@pytest.mark.asyncio
async def test_same_item_derivation_is_never_outdated(db_session, root):
    project, _r1, r2 = await _impression_revisions(db_session)
    tree = await load_tree(db_session, project)
    revs = {r.number: r for s in tree.sections for i in s.items for r in i.revisions}
    assert revs[r2.number].derived_from is not None
    assert revs[r2.number].outdated_by is None


@pytest.mark.asyncio
async def test_tree_exposes_pipeline_name(db_session, root):
    project, _r1, r2 = await _impression_revisions(db_session, pipeline_name="H2D PETG")
    tree = await load_tree(db_session, project)
    revs = {r.number: r for s in tree.sections for i in s.items for r in i.revisions}
    assert revs[r2.number].pipeline_name == "H2D PETG"


@pytest.mark.asyncio
async def test_revision_from_sources_records_derivation_and_pipeline(db_session, root, tmp_path):
    project = await _project(db_session)
    item, r1 = await _rev(db_session, project)
    src = tmp_path / "out.gcode.3mf"
    src.write_bytes(b"not really a zip")
    rev = await project_files.add_revision_from_sources(
        db_session,
        project,
        item,
        [project_files.RevisionSource(path=src, filename="Support.gcode.3mf")],
        note="Re-tranché depuis R1 · pipeline H2D",
        user_id=None,
        derived_from_id=r1.id,
        pipeline_id=None,
        pipeline_name="H2D",
    )
    assert rev.derived_from_id == r1.id
    assert rev.pipeline_name == "H2D"
    assert rev.status == "wip"
    assert src.exists()  # sources are never touched


# A cancellation (BaseHTTPMiddleware on client disconnect) that lands while the
# commit is in flight: aiosqlite runs COMMIT in its worker thread, so the
# cancellation cannot stop it. The patched commit models that thread with a
# shielded inner task, gated so the cancellation is delivered first.


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


async def _fresh_scalars(test_engine, statement):
    async with AsyncSession(test_engine) as fresh:
        return list((await fresh.execute(statement)).scalars().all())


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


@pytest.mark.asyncio
async def test_add_files_commit_failure_rolls_back_and_removes_the_written_files(db_session, root, monkeypatch):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    base, item_id, rev_id = root / project.storage_dir, item.id, rev.id
    before = (await db_session.execute(select(LibraryFile.id).where(LibraryFile.revision_id == rev_id))).scalars().all()
    folder = base / "Modélisation" / "Support" / "R1"
    seen_on_disk = []
    real_rollback = db_session.rollback
    rolled_back = []

    async def boom():
        seen_on_disk.append(sorted(p.name for p in folder.iterdir()))
        raise RuntimeError("db down")

    async def rollback():
        rolled_back.append(True)
        await real_rollback()

    monkeypatch.setattr(db_session, "commit", boom)
    monkeypatch.setattr(db_session, "rollback", rollback)
    with pytest.raises(RuntimeError, match="db down"):
        await add_files_to_revision(db_session, project, item, rev, [upload("b.step", b"b")], user_id=None)

    assert seen_on_disk == [["a.step", "b.step"]]  # the file was written before the commit failed
    assert rolled_back == [True]
    assert sorted(p.name for p in folder.iterdir()) == ["a.step"]  # and removed again
    after = (await db_session.execute(select(LibraryFile.id).where(LibraryFile.revision_id == rev_id))).scalars().all()
    assert after == before
    assert (await db_session.execute(select(ProjectItem.id).where(ProjectItem.id == item_id))).scalar_one() == item_id


@pytest.mark.asyncio
async def test_fork_gives_the_copy_its_own_thumbnail(db_session, root, monkeypatch, tmp_path):
    thumbs = tmp_path / "thumbs"
    thumbs.mkdir()
    monkeypatch.setattr(project_files, "get_library_thumbnails_dir", lambda: thumbs)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("Metadata/project_settings.config", '{"printer_model": "X"}')
        zf.writestr("3D/3dmodel.model", "<model></model>")
        zf.writestr("Metadata/plate_1.png", b"\x89PNG fake")
    project = await _project(db_session)
    item, rev = await _rev(db_session, project, section="impression", files=[upload("plate.3mf", buffer.getvalue())])
    [source] = (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == rev.id))).scalars().all()
    source_thumb = source.thumbnail_path
    assert source_thumb, "the 3MF upload should have produced a thumbnail"

    forked = await fork_revision(db_session, project, item, rev, "Support B", user_id=None)

    r1 = (await db_session.execute(select(ProjectRevision).where(ProjectRevision.item_id == forked.id))).scalar_one()
    [copy] = (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == r1.id))).scalars().all()
    assert copy.thumbnail_path and copy.thumbnail_path != source_thumb
    thumb_files = sorted(thumbs.iterdir())
    assert len(thumb_files) == 2  # the source keeps its own; the copy has a separate file
    assert all(p.read_bytes() == thumb_files[0].read_bytes() for p in thumb_files)
