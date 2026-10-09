"""Moving File Manager files into a project (phase 5, task 1).

Managed files keep their row (queue items, archives and photos follow the id);
external files are copied into a new row and the mount is never touched.
"""

import hashlib
import io
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

import pytest
from sqlalchemy import delete, select, update

from backend.app.api.routes.library import get_library_files_dir, to_absolute_path, to_relative_path
from backend.app.core.config import settings
from backend.app.models.archive import PrintArchive
from backend.app.models.library import FileVariantGroup, LibraryFile, LibraryFolder
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.app.services import project_files, project_storage
from backend.app.services.project_files import RevisionSource, add_revision_from_sources, create_item
from backend.app.services.project_filing import MoveToProjectResult, move_library_files_to_project


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "base_dir", tmp_path)
    monkeypatch.setattr(settings, "archive_dir", tmp_path / "archive")
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setattr(project_storage, "projects_root", lambda: projects)
    return projects


def threemf_bytes() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("Metadata/project_settings.config", '{"printer_model": "Bambu Lab X1C", "layer_height": "0.2"}')
        zf.writestr(
            "3D/3dmodel.model", '<model><metadata name="Application">BambuStudio-02.08.00.50</metadata></model>'
        )
    return buffer.getvalue()


async def _project(db, name="Support caméra") -> Project:
    project = Project(name=name)
    db.add(project)
    await db.flush()
    return project


async def _managed(db, filename: str, data: bytes = b"bytes", **fields) -> LibraryFile:
    path = get_library_files_dir() / f"{uuid.uuid4().hex}{Path(filename).suffix}"
    path.write_bytes(data)
    row = LibraryFile(
        filename=filename,
        file_path=to_relative_path(path),
        file_type=Path(filename).suffix.lstrip(".") or "unknown",
        file_size=len(data),
        file_hash=None,
        is_external=False,
        **fields,
    )
    db.add(row)
    await db.flush()
    return row


async def _external(db, tmp_path: Path, filename: str, *, readonly: bool, data: bytes = b"nas") -> LibraryFile:
    mount = tmp_path / f"mount-{uuid.uuid4().hex[:6]}"
    mount.mkdir()
    (mount / filename).write_bytes(data)
    folder = LibraryFolder(name="NAS", is_external=True, external_readonly=readonly, external_path=str(mount))
    db.add(folder)
    await db.flush()
    row = LibraryFile(
        folder_id=folder.id,
        filename=filename,
        file_path=str(mount / filename),
        file_type=Path(filename).suffix.lstrip("."),
        file_size=len(data),
        is_external=True,
    )
    db.add(row)
    await db.flush()
    return row


async def _move(db, project, files, *, item_id=None, new_item_name=None) -> MoveToProjectResult:
    return await move_library_files_to_project(
        db, project, files, item_id=item_id, new_item_name=new_item_name, user_id=None
    )


async def _revisions(db, project) -> list[tuple[str, str, int, list[str]]]:
    rows = (
        await db.execute(
            select(ProjectItem.section, ProjectItem.name, ProjectRevision.number, ProjectRevision.id)
            .join(ProjectRevision, ProjectRevision.item_id == ProjectItem.id)
            .where(ProjectItem.project_id == project.id)
            .order_by(ProjectItem.name, ProjectRevision.number)
        )
    ).all()
    out = []
    for section, name, number, rev_id in rows:
        names = (
            (await db.execute(select(LibraryFile.filename).where(LibraryFile.revision_id == rev_id))).scalars().all()
        )
        out.append((section, name, number, sorted(names)))
    return out


@pytest.mark.asyncio
async def test_move_keeps_row_id_and_references(db_session, root):
    project = await _project(db_session)
    group = FileVariantGroup(name="g")
    db_session.add(group)
    await db_session.flush()
    data = threemf_bytes()
    row = await _managed(db_session, "Bracket.3mf", data, variant_group_id=group.id, variant_position=2)
    file_id, old_path = row.id, to_absolute_path(row.file_path)
    db_session.add(PrintQueueItem(library_file_id=file_id))
    db_session.add(PrintArchive(filename="Bracket.3mf", file_path="x", file_size=1, library_file_id=file_id))
    await db_session.commit()

    result = await _move(db_session, project, [row])

    assert result.skipped == [] and result.copied == []
    assert [m["file_id"] for m in result.moved] == [file_id]
    moved = (
        await db_session.execute(
            select(LibraryFile).where(LibraryFile.id == file_id).execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert moved.revision_id is not None and moved.project_id == project.id and moved.folder_id is None
    assert moved.variant_group_id is None
    assert moved.file_hash == hashlib.sha256(data).hexdigest()
    new_path = to_absolute_path(moved.file_path)
    assert new_path == (root / project.storage_dir / "Impression" / "Bracket" / "R1" / "Bracket.3mf").resolve()
    assert new_path.read_bytes() == data
    assert not old_path.exists()
    revision = await db_session.get(ProjectRevision, moved.revision_id)
    assert revision.config_snapshot is not None  # 3MF post-processing shared with uploads
    queue_ref = (await db_session.execute(select(PrintQueueItem.library_file_id))).scalar_one()
    archive_ref = (await db_session.execute(select(PrintArchive.library_file_id))).scalar_one()
    assert queue_ref == archive_ref == file_id
    assert result.moved[0]["revision_number"] == 1 and result.moved[0]["section"] == "impression"


@pytest.mark.asyncio
@pytest.mark.parametrize("readonly", [True, False])
async def test_external_files_are_copied_not_moved(db_session, root, tmp_path, readonly):
    project = await _project(db_session)
    row = await _external(db_session, tmp_path, "Lid.gcode", readonly=readonly, data=b"G1 X0")
    file_id, folder_id, file_path = row.id, row.folder_id, row.file_path
    await db_session.commit()

    result = await _move(db_session, project, [row])

    assert result.moved == [] and result.skipped == []
    assert len(result.copied) == 1 and result.copied[0]["source_file_id"] == file_id
    original = (
        await db_session.execute(
            select(LibraryFile).where(LibraryFile.id == file_id).execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert (original.file_path, original.folder_id, original.revision_id, original.is_external) == (
        file_path,
        folder_id,
        None,
        True,
    )
    assert Path(file_path).read_bytes() == b"G1 X0"
    copy = await db_session.get(LibraryFile, result.copied[0]["file_id"])
    assert copy.id != file_id and copy.is_external is False and copy.project_id == project.id
    assert copy.revision_id is not None and copy.file_hash == hashlib.sha256(b"G1 X0").hexdigest()
    assert to_absolute_path(copy.file_path).read_bytes() == b"G1 X0"


@pytest.mark.asyncio
async def test_bulk_groups_by_item_name(db_session, root):
    project = await _project(db_session)
    files = [
        await _managed(db_session, "bracket.3mf", threemf_bytes()),
        await _managed(db_session, "bracket.gcode", b"G1"),
        await _managed(db_session, "lid.gcode.3mf", threemf_bytes()),
    ]
    await db_session.commit()

    result = await _move(db_session, project, files)

    assert len(result.moved) == 3 and result.skipped == []
    assert await _revisions(db_session, project) == [
        ("impression", "bracket", 1, ["bracket.3mf", "bracket.gcode"]),
        ("impression", "lid", 1, ["lid.gcode.3mf"]),
    ]


@pytest.mark.asyncio
async def test_explicit_item_takes_all_files_as_next_revision(db_session, root):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="impression", name="Support", user_id=None)
    await db_session.commit()
    await add_revision_from_sources(
        db_session,
        project,
        item,
        [RevisionSource(path=(await _write(root, "first.gcode")), filename="first.gcode", reuse_row=None)],
        note=None,
        user_id=None,
    )
    files = [await _managed(db_session, "a.3mf", threemf_bytes()), await _managed(db_session, "b.gcode", b"G1")]
    await db_session.commit()

    result = await _move(db_session, project, files, item_id=item.id)

    assert {m["revision_number"] for m in result.moved} == {2}
    assert await _revisions(db_session, project) == [
        ("impression", "Support", 1, ["first.gcode"]),
        ("impression", "Support", 2, ["a.3mf", "b.gcode"]),
    ]


async def _write(root: Path, name: str, data: bytes = b"G1") -> Path:
    path = root.parent / f"src-{uuid.uuid4().hex[:6]}-{name}"
    path.write_bytes(data)
    return path


@pytest.mark.asyncio
async def test_new_item_name_creates_one_item_for_all(db_session, root):
    project = await _project(db_session)
    files = [await _managed(db_session, "a.gcode", b"1"), await _managed(db_session, "b.gcode", b"2")]
    await db_session.commit()

    await _move(db_session, project, files, new_item_name="Kit complet")

    assert await _revisions(db_session, project) == [("impression", "Kit complet", 1, ["a.gcode", "b.gcode"])]


@pytest.mark.asyncio
async def test_failure_on_second_copy_changes_nothing(db_session, root, monkeypatch):
    project = await _project(db_session)
    files = [await _managed(db_session, "part.3mf", threemf_bytes()), await _managed(db_session, "part.gcode", b"G")]
    before = [(f.id, f.file_path) for f in files]
    await db_session.commit()

    real_copy = project_files._copy_hashing
    calls = {"n": 0}

    def flaky(src, dest):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError("disk full")
        return real_copy(src, dest)

    monkeypatch.setattr(project_files, "_copy_hashing", flaky)

    result = await _move(db_session, project, files)

    assert result.moved == [] and result.copied == []
    assert sorted((s["file_id"], s["code"]) for s in result.skipped) == sorted(
        (file_id, "copy_failed") for file_id, _ in before
    )
    rows = (
        (
            await db_session.execute(
                select(LibraryFile).order_by(LibraryFile.id).execution_options(populate_existing=True)
            )
        )
        .scalars()
        .all()
    )
    assert [(r.id, r.file_path, r.revision_id) for r in rows] == [(i, p, None) for i, p in before]
    assert all(to_absolute_path(p).exists() for _, p in before)
    assert (await db_session.execute(select(ProjectRevision))).scalars().all() == []
    leftovers = [p for p in root.rglob("*") if p.is_file()]
    assert leftovers == []


@pytest.mark.asyncio
async def test_add_revision_from_sources_rolls_back_on_copy_failure(db_session, root, monkeypatch):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="impression", name="X", user_id=None)
    await db_session.commit()
    first, second = await _write(root, "a.gcode"), await _write(root, "b.gcode")
    real_copy = project_files._copy_hashing
    calls = {"n": 0}

    def flaky(src, dest):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError("boom")
        return real_copy(src, dest)

    monkeypatch.setattr(project_files, "_copy_hashing", flaky)
    with pytest.raises(OSError):
        await add_revision_from_sources(
            db_session,
            project,
            item,
            [
                RevisionSource(path=first, filename="a.gcode", reuse_row=None),
                RevisionSource(path=second, filename="b.gcode", reuse_row=None),
            ],
            note=None,
            user_id=None,
        )
    assert (await db_session.execute(select(ProjectRevision))).scalars().all() == []
    assert [p for p in root.rglob("*") if p.is_file()] == []
    assert first.exists() and second.exists()


@pytest.mark.asyncio
async def test_skip_codes(db_session, root, tmp_path):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="impression", name="Done", user_id=None)
    await db_session.commit()
    rev = await add_revision_from_sources(
        db_session,
        project,
        item,
        [RevisionSource(path=await _write(root, "in.gcode"), filename="in.gcode", reuse_row=None)],
        note=None,
        user_id=None,
    )
    in_project = (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == rev.id))).scalar_one()

    trashed = await _managed(db_session, "t.gcode", deleted_at=datetime(2026, 1, 1))
    missing = await _managed(db_session, "m.gcode")
    to_absolute_path(missing.file_path).unlink()
    stl = await _managed(db_session, "mesh.stl", b"solid")
    pdf = await _managed(db_session, "notice.pdf", b"%PDF")
    good = await _managed(db_session, "ok.3mf", threemf_bytes())
    stl_path, pdf_path = stl.file_path, pdf.file_path
    await db_session.commit()

    result = await _move(db_session, project, [in_project, trashed, missing, stl, pdf, good])

    assert [m["file_id"] for m in result.moved] == [good.id]
    assert {s["file_id"]: s["code"] for s in result.skipped} == {
        in_project.id: "already_in_project",
        trashed.id: "trashed",
        missing.id: "source_missing",
        stl.id: "not_printable",
        pdf.id: "not_printable",
    }
    assert all(s["reason"] for s in result.skipped)
    for row_id, path in ((stl.id, stl_path), (pdf.id, pdf_path)):
        fresh = (
            await db_session.execute(
                select(LibraryFile).where(LibraryFile.id == row_id).execution_options(populate_existing=True)
            )
        ).scalar_one()
        assert (fresh.file_path, fresh.revision_id) == (path, None)
        assert to_absolute_path(path).exists()


@pytest.mark.asyncio
async def test_item_in_disabled_section_is_rejected(db_session, root):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="scan", name="Mesh", user_id=None)
    row = await _managed(db_session, "a.gcode")
    await db_session.commit()
    with pytest.raises(ValueError):
        await _move(db_session, project, [row], item_id=item.id)
    fresh = await db_session.get(LibraryFile, row.id)
    assert fresh.revision_id is None


@pytest.mark.asyncio
async def test_item_of_another_project_is_rejected(db_session, root):
    project, other = await _project(db_session), await _project(db_session, "Autre")
    item = await create_item(db_session, other, section="impression", name="Theirs", user_id=None)
    row = await _managed(db_session, "a.gcode")
    await db_session.commit()
    with pytest.raises(project_files.ProjectFilesError) as exc:
        await _move(db_session, project, [row], item_id=item.id)
    assert exc.value.status_code == 404


def test_printable_rule():
    assert project_storage.ENABLED_SECTIONS == ("impression",)
    for name in ("a.3mf", "A.GCODE.3MF", "b.gcode", "c.BGCODE"):
        assert project_storage.is_printable_filename(name)
    for name in ("a.stl", "b.pdf", "gcode", "", "c.3mf.zip"):
        assert not project_storage.is_printable_filename(name)


@pytest.mark.asyncio
async def test_atomicity_is_per_item_group(db_session, root, monkeypatch):
    """Each item group commits on its own: a failing later group leaves earlier groups moved."""
    project = await _project(db_session)
    first = await _managed(db_session, "alpha.gcode", b"A")
    second = [await _managed(db_session, "beta.3mf", threemf_bytes()), await _managed(db_session, "beta.gcode", b"B")]
    second_before = [(f.id, f.file_path) for f in second]
    first_id, first_old = first.id, to_absolute_path(first.file_path)
    await db_session.commit()

    real_copy = project_files._copy_hashing
    calls = {"n": 0}

    def flaky(src, dest):
        calls["n"] += 1
        if calls["n"] == 3:  # second copy of the second group
            raise OSError("disk full")
        return real_copy(src, dest)

    monkeypatch.setattr(project_files, "_copy_hashing", flaky)

    result = await _move(db_session, project, [first, *second])

    assert [m["file_id"] for m in result.moved] == [first_id]
    assert not first_old.exists()
    assert sorted((s["file_id"], s["code"]) for s in result.skipped) == sorted(
        (file_id, "copy_failed") for file_id, _ in second_before
    )
    for file_id, path in second_before:
        fresh = (
            await db_session.execute(
                select(LibraryFile).where(LibraryFile.id == file_id).execution_options(populate_existing=True)
            )
        ).scalar_one()
        assert (fresh.file_path, fresh.revision_id) == (path, None)
        assert to_absolute_path(path).exists()
    assert await _revisions(db_session, project) == [("impression", "alpha", 1, ["alpha.gcode"])]
    stored = sorted(p.name for p in root.rglob("*") if p.is_file())
    assert stored == ["alpha.gcode"]  # no stray copies from the failed group


@pytest.mark.asyncio
async def test_mixed_managed_and_external_in_one_group(db_session, root, tmp_path):
    project = await _project(db_session)
    managed = await _managed(db_session, "part.3mf", threemf_bytes())
    external = await _external(db_session, tmp_path, "part.gcode", readonly=True, data=b"G1 ext")
    managed_id, external_id, external_path = managed.id, external.id, external.file_path
    await db_session.commit()

    result = await _move(db_session, project, [managed, external])

    assert [(m["file_id"], m["filename"]) for m in result.moved] == [(managed_id, "part.3mf")]
    assert [(c["source_file_id"], c["filename"]) for c in result.copied] == [(external_id, "part.gcode")]
    copy = await db_session.get(LibraryFile, result.copied[0]["file_id"])
    assert to_absolute_path(copy.file_path).read_bytes() == b"G1 ext"
    assert Path(external_path).read_bytes() == b"G1 ext"
    assert result.moved[0]["revision_id"] == result.copied[0]["revision_id"]
    assert await _revisions(db_session, project) == [("impression", "part", 1, ["part.3mf", "part.gcode"])]


@pytest.mark.asyncio
async def test_external_trashed_before_its_group_is_skipped(db_session, root, tmp_path, monkeypatch):
    from backend.app.services import project_filing

    project = await _project(db_session)
    external = await _external(db_session, tmp_path, "lid.gcode", readonly=False)
    external_id = external.id
    await db_session.commit()
    real_fresh_rows = project_filing._fresh_rows

    async def trashed_meanwhile(db, file_ids):
        rows = await real_fresh_rows(db, file_ids)
        rows[external_id].deleted_at = datetime(2026, 1, 1)
        return rows

    monkeypatch.setattr(project_filing, "_fresh_rows", trashed_meanwhile)

    result = await _move(db_session, project, [external])

    assert result.copied == [] and [(s["file_id"], s["code"]) for s in result.skipped] == [(external_id, "trashed")]


@pytest.mark.asyncio
async def test_blank_new_item_name_raises_before_anything(db_session, root):
    project = await _project(db_session)
    row = await _managed(db_session, "a.gcode")
    path = row.file_path
    await db_session.commit()
    with pytest.raises(ValueError):
        await _move(db_session, project, [row], new_item_name="  ./  ")
    assert to_absolute_path(path).exists()
    assert (await db_session.execute(select(ProjectItem))).scalars().all() == []


@pytest.mark.asyncio
async def test_target_item_deleted_meanwhile_propagates(db_session, root, monkeypatch):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="impression", name="Gone", user_id=None)
    row = await _managed(db_session, "a.gcode")
    path = row.file_path
    await db_session.commit()

    async def deleted(db, item_id):
        raise project_files.ProjectFilesError(404, "Item not found")

    monkeypatch.setattr(project_files, "_fresh_item", deleted)
    with pytest.raises(project_files.ProjectFilesError) as exc:
        await _move(db_session, project, [row], item_id=item.id)
    assert exc.value.status_code == 404
    assert to_absolute_path(path).exists()


# --- pins for the split of move_library_files_to_project (T-029) -------------


async def _fresh(db, file_id: int) -> LibraryFile:
    return (
        await db.execute(select(LibraryFile).where(LibraryFile.id == file_id).execution_options(populate_existing=True))
    ).scalar_one()


@pytest.mark.asyncio
async def test_result_entries_are_exact_and_ordered(db_session, root, tmp_path):
    """Skips in input order with their exact reasons; groups in first-seen order; every key of every entry."""
    project = await _project(db_session)
    lid = await _managed(db_session, "lid.gcode", b"L")
    stl = await _managed(db_session, "mesh.stl", b"solid")
    bracket = await _managed(db_session, "Bracket.3mf", threemf_bytes())
    trashed = await _managed(db_session, "t.gcode", deleted_at=datetime(2026, 1, 1))
    external = await _external(db_session, tmp_path, "bracket.gcode", readonly=True, data=b"G1 ext")
    ids = {"lid": lid.id, "stl": stl.id, "bracket": bracket.id, "trashed": trashed.id, "external": external.id}
    await db_session.commit()

    result = await _move(db_session, project, [lid, stl, bracket, trashed, external])

    assert result.skipped == [
        {
            "file_id": ids["stl"],
            "code": "not_printable",
            "reason": "projects only accept printing files (.3mf, .gcode, .bgcode)",
        },
        {"file_id": ids["trashed"], "code": "trashed", "reason": "file is in the trash"},
    ]
    items = {
        i.name: i
        for i in (await db_session.execute(select(ProjectItem).where(ProjectItem.project_id == project.id))).scalars()
    }
    revs = {
        r.item_id: r
        for r in (await db_session.execute(select(ProjectRevision).execution_options(populate_existing=True))).scalars()
    }
    lid_item, bracket_item = items["lid"], items["Bracket"]
    copy_id = result.copied[0]["file_id"]
    assert copy_id not in ids.values()
    assert result.moved == [
        {
            "file_id": ids["lid"],
            "filename": "lid.gcode",
            "section": "impression",
            "item_id": lid_item.id,
            "item_name": "lid",
            "revision_id": revs[lid_item.id].id,
            "revision_number": 1,
        },
        {
            "file_id": ids["bracket"],
            "filename": "Bracket.3mf",
            "section": "impression",
            "item_id": bracket_item.id,
            "item_name": "Bracket",
            "revision_id": revs[bracket_item.id].id,
            "revision_number": 1,
        },
    ]
    assert result.copied == [
        {
            "file_id": copy_id,
            "filename": "bracket.gcode",
            "section": "impression",
            "item_id": bracket_item.id,
            "item_name": "Bracket",
            "revision_id": revs[bracket_item.id].id,
            "revision_number": 1,
            "source_file_id": ids["external"],
        }
    ]


@pytest.mark.asyncio
async def test_item_id_and_new_item_name_together_raise_before_anything(db_session, root):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="impression", name="Kit", user_id=None)
    row = await _managed(db_session, "a.gcode")
    item_id, path = item.id, row.file_path
    await db_session.commit()
    with pytest.raises(ValueError, match="^Pass either item_id or new_item_name, not both$"):
        await _move(db_session, project, [row], item_id=item_id, new_item_name="Kit")
    assert to_absolute_path(path).exists()
    assert (await _fresh(db_session, row.id)).revision_id is None


@pytest.mark.asyncio
async def test_disabled_section_value_error_message(db_session, root):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="scan", name="Mesh", user_id=None)
    row = await _managed(db_session, "a.gcode")
    await db_session.commit()
    with pytest.raises(ValueError, match="^Section 'scan' does not accept files for now$"):
        await _move(db_session, project, [row], item_id=item.id)


@pytest.mark.asyncio
async def test_blank_new_item_name_value_error_message(db_session, root):
    project = await _project(db_session)
    row = await _managed(db_session, "a.gcode")
    await db_session.commit()
    with pytest.raises(ValueError, match="^Item name must not be blank$"):
        await _move(db_session, project, [row], new_item_name="   ")


@pytest.mark.asyncio
async def test_new_item_name_is_trimmed_and_finds_the_existing_item(db_session, root):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="impression", name="Kit Complet", user_id=None)
    await db_session.commit()
    await add_revision_from_sources(
        db_session,
        project,
        item,
        [RevisionSource(path=await _write(root, "r1.gcode"), filename="r1.gcode", reuse_row=None)],
        note=None,
        user_id=None,
    )
    item_id = item.id
    files = [await _managed(db_session, "a.gcode", b"1"), await _managed(db_session, "b.3mf", threemf_bytes())]
    await db_session.commit()

    result = await _move(db_session, project, files, new_item_name="  kit complet  ")

    assert {(m["item_id"], m["item_name"], m["revision_number"]) for m in result.moved} == {(item_id, "Kit Complet", 2)}
    assert await _revisions(db_session, project) == [
        ("impression", "Kit Complet", 1, ["r1.gcode"]),
        ("impression", "Kit Complet", 2, ["a.gcode", "b.3mf"]),
    ]


@pytest.mark.asyncio
async def test_per_filename_grouping_finds_an_existing_item_by_key(db_session, root):
    project = await _project(db_session)
    item = await create_item(db_session, project, section="impression", name="Bracket", user_id=None)
    await db_session.commit()
    await add_revision_from_sources(
        db_session,
        project,
        item,
        [RevisionSource(path=await _write(root, "r1.gcode"), filename="r1.gcode", reuse_row=None)],
        note=None,
        user_id=None,
    )
    item_id = item.id
    row = await _managed(db_session, "BRACKET.gcode", b"2")
    await db_session.commit()

    result = await _move(db_session, project, [row])

    assert [(m["item_id"], m["item_name"], m["revision_number"]) for m in result.moved] == [(item_id, "Bracket", 2)]
    assert len((await db_session.execute(select(ProjectItem))).scalars().all()) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["path", "gone", "filed"])
async def test_row_changed_before_its_group_is_a_conflict_skip(db_session, root, monkeypatch, change):
    """A row moved, deleted or filed meanwhile is skipped as a conflict; its group-mates still go."""
    from backend.app.services import project_filing

    project = await _project(db_session)
    changed = await _managed(db_session, "part.gcode", b"C")
    mate = await _managed(db_session, "part.3mf", threemf_bytes())
    changed_id, changed_path, mate_id = changed.id, changed.file_path, mate.id
    await db_session.commit()
    real_fresh_rows = project_filing._fresh_rows

    async def changed_meanwhile(db, file_ids):
        if change == "path":
            await db.execute(
                update(LibraryFile).where(LibraryFile.id == changed_id).values(file_path="elsewhere.gcode")
            )
        elif change == "gone":
            await db.execute(delete(LibraryFile).where(LibraryFile.id == changed_id))
        rows = await real_fresh_rows(db, file_ids)
        if change == "filed":
            rows[changed_id].revision_id = 12345  # in memory only: no such revision
        return rows

    monkeypatch.setattr(project_filing, "_fresh_rows", changed_meanwhile)

    result = await _move(db_session, project, [changed, mate])

    assert result.skipped == [
        {"file_id": changed_id, "code": "conflict", "reason": "file changed while it was being moved"}
    ]
    assert [m["file_id"] for m in result.moved] == [mate_id]
    assert to_absolute_path(changed_path).exists()  # its bytes are left alone
    if change == "path":
        fresh = await _fresh(db_session, changed_id)
        assert (fresh.file_path, fresh.revision_id) == ("elsewhere.gcode", None)
    elif change == "gone":
        assert (await db_session.execute(select(LibraryFile).where(LibraryFile.id == changed_id))).first() is None


@pytest.mark.asyncio
async def test_a_group_with_nothing_left_creates_no_revision(db_session, root, monkeypatch):
    from backend.app.services import project_filing

    project = await _project(db_session)
    row = await _managed(db_session, "solo.gcode", b"S")
    row_id = row.id
    await db_session.commit()
    real_fresh_rows = project_filing._fresh_rows

    async def gone(db, file_ids):
        rows = await real_fresh_rows(db, file_ids)
        rows.pop(row_id)
        return rows

    monkeypatch.setattr(project_filing, "_fresh_rows", gone)

    result = await _move(db_session, project, [row])

    assert result.moved == [] and result.copied == []
    assert [s["code"] for s in result.skipped] == ["conflict"]
    assert (await db_session.execute(select(ProjectRevision))).scalars().all() == []
    # The (empty) item was found-or-created and committed before the rows were checked.
    assert [i.name for i in (await db_session.execute(select(ProjectItem))).scalars()] == ["solo"]


@pytest.mark.asyncio
async def test_a_409_while_storing_skips_the_rest_of_the_group_as_conflict_and_goes_on(db_session, root, monkeypatch):
    """A 409 skips only the group's still-pending files (no double skip), with the error detail;
    earlier groups stay committed and later groups still go."""
    from backend.app.services import project_filing

    project = await _project(db_session)
    first = await _managed(db_session, "alpha.gcode", b"A")
    raced = await _managed(db_session, "beta.gcode", b"B1")
    changed = await _managed(db_session, "beta.3mf", threemf_bytes())
    last = await _managed(db_session, "gamma.gcode", b"G")
    ids = [f.id for f in (first, raced, changed, last)]
    raced_path = raced.file_path
    await db_session.commit()
    real_fresh_rows = project_filing._fresh_rows
    real_add = project_files.add_revision_from_sources

    async def changed_meanwhile(db, file_ids):
        rows = await real_fresh_rows(db, file_ids)
        if ids[2] in rows:
            rows[ids[2]].file_path = "elsewhere.3mf"
        return rows

    async def racing_add(db, project, item, sources, **kwargs):
        if item.name == "beta":
            await db.rollback()
            raise project_files.ProjectFilesError(409, "Revision number taken")
        return await real_add(db, project, item, sources, **kwargs)

    monkeypatch.setattr(project_filing, "_fresh_rows", changed_meanwhile)
    monkeypatch.setattr(project_files, "add_revision_from_sources", racing_add)

    result = await _move(db_session, project, [first, raced, changed, last])

    assert [m["file_id"] for m in result.moved] == [ids[0], ids[3]]
    assert result.skipped == [
        {"file_id": ids[2], "code": "conflict", "reason": "file changed while it was being moved"},
        {"file_id": ids[1], "code": "conflict", "reason": "Revision number taken"},
    ]
    fresh = await _fresh(db_session, ids[1])
    assert (fresh.file_path, fresh.revision_id) == (raced_path, None)
    assert [(r[1], r[2]) for r in await _revisions(db_session, project)] == [("alpha", 1), ("gamma", 1)]


@pytest.mark.asyncio
async def test_a_copy_failure_reason_is_the_os_error_text(db_session, root, monkeypatch):
    project = await _project(db_session)
    row = await _managed(db_session, "a.gcode", b"A")
    row_id = row.id
    await db_session.commit()

    def broken(src, dest):
        raise OSError("disk full")

    monkeypatch.setattr(project_files, "_copy_hashing", broken)
    result = await _move(db_session, project, [row])
    assert result.skipped == [{"file_id": row_id, "code": "copy_failed", "reason": "disk full"}]


@pytest.mark.asyncio
async def test_a_non_409_error_while_storing_propagates(db_session, root, monkeypatch):
    project = await _project(db_session)
    row = await _managed(db_session, "a.gcode", b"A")
    path = row.file_path
    await db_session.commit()

    async def refused(*args, **kwargs):
        raise project_files.ProjectFilesError(413, "Too big")

    monkeypatch.setattr(project_files, "add_revision_from_sources", refused)
    with pytest.raises(project_files.ProjectFilesError) as exc:
        await _move(db_session, project, [row])
    assert (exc.value.status_code, exc.value.detail) == (413, "Too big")
    assert to_absolute_path(path).exists()


@pytest.mark.asyncio
async def test_a_project_gone_after_a_failed_group_is_a_404(db_session, root, monkeypatch):
    project = await _project(db_session)
    row = await _managed(db_session, "a.gcode", b"A")
    await db_session.commit()

    def broken(src, dest):
        raise OSError("disk full")

    real_get = db_session.get

    async def project_gone(model, ident, **kwargs):
        if model is Project:
            return None
        return await real_get(model, ident, **kwargs)

    monkeypatch.setattr(project_files, "_copy_hashing", broken)
    monkeypatch.setattr(db_session, "get", project_gone)
    with pytest.raises(project_files.ProjectFilesError) as exc:
        await _move(db_session, project, [row])
    assert (exc.value.status_code, exc.value.detail) == (404, "Project not found")
    assert isinstance(exc.value.__cause__, OSError)


@pytest.mark.asyncio
async def test_an_escaping_or_empty_source_path_is_source_missing(db_session, root, tmp_path):
    project = await _project(db_session)
    escaping = await _managed(db_session, "a.gcode")
    escaping.file_path = "../../outside.gcode"
    external = await _external(db_session, tmp_path, "b.gcode", readonly=True)
    external.file_path = ""
    await db_session.flush()
    ids = [escaping.id, external.id]
    await db_session.commit()

    result = await _move(db_session, project, [escaping, external])

    assert result.skipped == [
        {"file_id": ids[0], "code": "source_missing", "reason": "source file missing on disk"},
        {"file_id": ids[1], "code": "source_missing", "reason": "source file missing on disk"},
    ]


@pytest.mark.asyncio
async def test_old_bytes_that_cannot_be_removed_only_log(db_session, root, monkeypatch, caplog):
    project = await _project(db_session)
    row = await _managed(db_session, "a.gcode", b"A")
    row_id, old = row.id, to_absolute_path(row.file_path)
    await db_session.commit()
    real_unlink = Path.unlink

    def stubborn(self, missing_ok=False):
        if self == old:
            raise PermissionError("read-only")
        return real_unlink(self, missing_ok=missing_ok)

    monkeypatch.setattr(Path, "unlink", stubborn)
    with caplog.at_level("WARNING", logger="backend.app.services.project_filing"):
        result = await _move(db_session, project, [row])

    assert [m["file_id"] for m in result.moved] == [row_id]
    assert old.exists()
    assert "couldn't remove the old file" in caplog.text
