"""Project files service: forking a revision into a new item (split from test_project_files_service.py)."""

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
    _rev,
    _user,
)

root = projects_root_fixture()
legacy_uploads = legacy_uploads_fixture(autouse=True)


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
async def test_fork_copies_all_five_snapshot_columns_onto_r1(db_session, root):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project, files=[upload("a.step", b"geo")])
    rev.config_snapshot = {"layer_height": "0.2"}
    rev.config_hash = "h" * 64
    rev.slicer_name = "OrcaSlicer"
    rev.slicer_version = "2.3.2"
    rev.print_profile = {"printer_model": "Bambu Lab P1S"}
    await db_session.commit()
    forked = await fork_revision(db_session, project, item, rev, "Support client C", user_id=None)
    r1 = (await db_session.execute(select(ProjectRevision).where(ProjectRevision.item_id == forked.id))).scalar_one()
    assert (r1.config_snapshot, r1.config_hash, r1.slicer_name, r1.slicer_version, r1.print_profile) == (
        {"layer_height": "0.2"},
        "h" * 64,
        "OrcaSlicer",
        "2.3.2",
        {"printer_model": "Bambu Lab P1S"},
    )


@pytest.mark.asyncio
async def test_fork_writes_nothing_to_the_db_while_copying(db_session, root, monkeypatch):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    seen = {}
    real = project_files._copy_claimed

    def spy(src, dst, *args, **kwargs):
        seen["new"] = list(db_session.new)
        seen["dirty"] = list(db_session.dirty)
        return real(src, dst, *args, **kwargs)

    monkeypatch.setattr(project_files, "_copy_claimed", spy)
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
async def test_fork_row_columns_are_pinned(db_session, root):
    from backend.app.api.routes.library import to_relative_path

    forker = await _user(db_session, "t031-forker")
    project = await _project(db_session)
    item, rev = await _rev(db_session, project, files=[upload("a.step", b"geo")])
    [source] = (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == rev.id))).scalars().all()
    # The fork copies these from the source row rather than recomputing them.
    source.file_type = "custom"
    source.file_size = 999
    source.file_hash = "f" * 64
    source.file_metadata = {"pinned": True}
    source.notes = "source only"
    await db_session.flush()

    forked = await fork_revision(db_session, project, item, rev, "Support B", user_id=forker.id)

    r1 = (await db_session.execute(select(ProjectRevision).where(ProjectRevision.item_id == forked.id))).scalar_one()
    [copy] = (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == r1.id))).scalars().all()
    await db_session.refresh(copy)
    folder = root / project.storage_dir / "Modélisation" / "Support B" / "R1"
    assert _columns(copy) == {
        "project_id": project.id,
        "revision_id": r1.id,
        "folder_id": None,
        "is_external": False,
        "variant_group_id": None,
        "variant_position": 0,
        "filename": "a.step",
        "file_path": to_relative_path(folder / "a.step"),
        "file_type": "custom",
        "file_size": 999,
        "file_hash": "f" * 64,
        "thumbnail_path": None,
        "file_metadata": {"pinned": True},
        "created_by_id": forker.id,
        "notes": None,
    }


@pytest.mark.asyncio
async def test_fork_maps_an_integrity_error_to_409_after_cleaning_up(db_session, root, monkeypatch):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    base = root / project.storage_dir / "Modélisation"
    error = _commit_raises_integrity(db_session, monkeypatch, "UNIQUE constraint failed: project_items.name_key")
    with pytest.raises(ProjectFilesError) as caught:
        await fork_revision(db_session, project, item, rev, "Copie", user_id=None)
    assert (caught.value.status_code, caught.value.detail) == (
        409,
        "An item with this name already exists in this section",
    )
    assert caught.value.__cause__ is error
    assert not (base / "Copie").exists()


@pytest.mark.asyncio
async def test_fork_refuses_a_name_whose_folder_already_exists(db_session, root):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await db_session.commit()
    base = root / project.storage_dir / "Modélisation"
    (base / "Copie").mkdir()
    with pytest.raises(ProjectFilesError) as caught:
        await fork_revision(db_session, project, item, rev, "Copie", user_id=None)
    assert (caught.value.status_code, caught.value.detail) == (409, "A folder with this name already exists")
    assert (await db_session.execute(select(ProjectItem).where(ProjectItem.name == "Copie"))).first() is None
    assert list((base / "Copie").iterdir()) == []  # the pre-existing folder is left alone
    assert (base / "Support" / "R1" / "a.step").exists()


@pytest.mark.asyncio
async def test_fork_skips_a_revision_file_swapped_for_a_symlink(db_session, root, tmp_path_factory):
    secret = tmp_path_factory.mktemp("data_dir") / ".jwt_secret"
    secret.write_bytes(b"top-secret")
    project = await _project(db_session)
    item, rev = await _rev(db_session, project, files=[upload("a.step", b"geo-a"), upload("b.step", b"geo-b")])
    base = root / project.storage_dir / "Modélisation"
    swapped = base / "Support" / "R1" / "a.step"
    swapped.unlink()
    swapped.symlink_to(secret)
    forked = await fork_revision(db_session, project, item, rev, "Copie", user_id=None)
    r1 = (await db_session.execute(select(ProjectRevision).where(ProjectRevision.item_id == forked.id))).scalar_one()
    names = (await db_session.execute(select(LibraryFile.filename).where(LibraryFile.revision_id == r1.id))).scalars()
    assert list(names) == ["b.step"]
    assert sorted(p.name for p in (base / "Copie" / "R1").iterdir()) == ["b.step"]
    assert (base / "Copie" / "R1" / "b.step").read_bytes() == b"geo-b"


@pytest.mark.asyncio
async def test_fork_refuses_when_the_only_file_is_a_symlink(db_session, root, tmp_path_factory):
    secret = tmp_path_factory.mktemp("data_dir") / ".jwt_secret"
    secret.write_bytes(b"top-secret")
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    base = root / project.storage_dir / "Modélisation"
    swapped = base / "Support" / "R1" / "a.step"
    swapped.unlink()
    swapped.symlink_to(secret)
    with pytest.raises(ProjectFilesError) as err:
        await fork_revision(db_session, project, item, rev, "Copie", user_id=None)
    assert (err.value.status_code, err.value.detail) == (409, "No file of this revision could be copied")
    assert not (base / "Copie").exists()


@pytest.mark.asyncio
async def test_fork_removes_its_copies_and_folders_even_when_the_rollback_fails(db_session, root, monkeypatch):
    """T-482: a fork whose commit and rollback both fail leaves no new item folder behind, so the
    next fork to that name is not refused with 'A folder with this name already exists'."""
    project = await _project(db_session)
    item, rev = await _rev(db_session, project, files=[upload("a.step"), upload("b.step", b"other")])
    await db_session.commit()
    base = root / project.storage_dir / "Modélisation"
    commit_error, rollbacks = _commit_and_rollback_fail(db_session, monkeypatch)
    with pytest.raises(RuntimeError) as caught:
        await fork_revision(db_session, project, item, rev, "Copie", user_id=None)
    assert caught.value is commit_error
    assert rollbacks == ["rollback"]
    assert not (base / "Copie").exists()
    assert (base / "Support" / "R1" / "a.step").exists()  # the source is untouched
