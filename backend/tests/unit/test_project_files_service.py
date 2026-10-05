"""Project files service: items, revisions, uploads (spec §1.3–§1.5, §2.3)."""

import io
import zipfile
from pathlib import Path

import pytest
from fastapi import UploadFile
from sqlalchemy import select

from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.app.services import project_files, project_storage
from backend.app.services.project_files import (
    ProjectFilesError,
    add_revision,
    create_item,
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
@pytest.mark.skip(reason="delete_revision lands in Task 5")
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
