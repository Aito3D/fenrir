"""Project files service: the tree, lookups, usage queries and small pure helpers (split from test_project_files_service.py)."""

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
    _rev,
    _sqlite_sql,
    _usage_branches,
)

root = projects_root_fixture()
legacy_uploads = legacy_uploads_fixture(autouse=True)


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


@pytest.mark.asyncio
async def test_used_file_ids_query_is_one_flat_union_with_the_delivered_branch():
    session = _CapturingSession()
    file_ids = select(LibraryFile.id).where(LibraryFile.revision_id == 7)
    assert await project_files.used_file_ids(session, file_ids) == set()
    (statement,) = session.statements
    sub = "(SELECT library_files.id \nFROM library_files \nWHERE library_files.revision_id = 7)"
    delivered = (
        f"SELECT library_files.id AS file_id \nFROM library_files \nWHERE library_files.id IN {sub} "
        "AND library_files.revision_id IN (SELECT aito_task_deliveries.revision_id \nFROM aito_task_deliveries)"
    )
    assert _sqlite_sql(statement) == " UNION ".join([*_usage_branches(sub), delivered])


@pytest.mark.asyncio
async def test_duplicate_warnings_are_empty_when_no_row_has_a_hash(db_session: AsyncSession):
    """Rows without a ``file_hash`` cannot match anything: no warning, no lookup."""
    rows = [LibraryFile(filename="a.3mf", file_hash=None), LibraryFile(filename="b.3mf", file_hash="")]
    assert await project_files._duplicate_warnings(db_session, None, None, rows) == []


def test_project_files_error_declares_stored_count_without_a_default():
    """``stored_count`` is annotated on the class but absent until a task drop sets it on the instance."""
    assert "stored_count" in ProjectFilesError.__annotations__
    err = ProjectFilesError(409, "x")
    assert not hasattr(err, "stored_count")
    err.stored_count = 2
    assert err.stored_count == 2
    assert not hasattr(ProjectFilesError(409, "y"), "stored_count")


def test_revision_label_format_is_pinned():
    assert project_files.revision_label("Bracket", 3) == "Bracket R3"
    assert project_files.revision_label("Pièce 2 / b", 12) == "Pièce 2 / b R12"


def test_revision_label_callers_share_the_helper():
    from types import SimpleNamespace

    from backend.app.services import aito_project_links as links

    label, _ = links.revision_added_payload(
        item_name="Bracket", revision_number=3, section="wip", item_id=1, revision_id=2
    )
    assert label == project_files.revision_label("Bracket", 3)
    item, revision = SimpleNamespace(name="Bracket"), SimpleNamespace(number=3)
    assert links._revision_label(item, revision, 9) == project_files.revision_label("Bracket", 3)
    assert links._revision_label(None, revision, 9) == "#9"


@pytest.mark.asyncio
async def test_status_change_stamps_naive_utc_now(db_session, root):
    from datetime import datetime, timedelta, timezone

    project = await _project(db_session)
    item = await create_item(db_session, project, section="scan", name="Mesh", user_id=None)
    rev, _ = await add_revision(
        db_session, project, item, [upload("s.ply")], note=None, derived_from_id=None, user_id=None
    )
    before = datetime.now(timezone.utc).replace(tzinfo=None)
    await update_revision(db_session, project, rev, fields={"status": "valide"}, user_id=None)
    stamp = rev.status_changed_at
    assert stamp.tzinfo is None
    assert (
        before - timedelta(seconds=1) <= stamp <= datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(seconds=1)
    )


@pytest.mark.asyncio
async def test_fresh_item_refuses_an_unknown_item_with_a_404(db_session):
    with pytest.raises(ProjectFilesError) as missing:
        await project_files.fresh_item(db_session, 987654)
    assert (missing.value.status_code, missing.value.detail) == (404, "Item not found")


def test_require_enabled_section_names_the_refused_section():
    with pytest.raises(ProjectFilesError) as refused:
        project_files.require_enabled_section("no-such-section")
    assert refused.value.status_code == 400
    assert "'no-such-section'" in refused.value.detail


def test_find_item_and_find_revision_return_none_when_the_tree_lacks_them():
    from types import SimpleNamespace as NS

    rev = NS(id=7)
    tree = NS(sections=[NS(items=[NS(id=3, revisions=[rev])])])
    assert project_files.find_item(tree, 3).id == 3
    assert project_files.find_revision(tree, 7) is rev
    assert project_files.find_item(tree, 4) is None
    assert project_files.find_revision(tree, 8) is None


def test_require_printable_uploads_names_every_refused_file():
    project_files.require_printable_uploads(
        [upload("ok.3mf"), upload("p.gcode"), upload("q.BGCODE")]
    )  # nothing refused, no error
    with pytest.raises(ProjectFilesError) as refused:
        project_files.require_printable_uploads([upload("a.3mf"), upload("plan.pdf"), upload("mesh.stl")])
    assert (refused.value.status_code, refused.value.detail) == (
        400,
        "Projects only accept printing files (.3mf, .gcode, .bgcode); refused: plan.pdf, mesh.stl",
    )
