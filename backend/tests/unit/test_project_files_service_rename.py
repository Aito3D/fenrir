"""Project files service: renaming items (split from test_project_files_service.py)."""

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
    _name_check_passes,
    _rev,
)

root = projects_root_fixture()
legacy_uploads = legacy_uploads_fixture(autouse=True)


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


@pytest.mark.asyncio
async def test_rename_item_racing_a_same_name_item_is_the_name_409_and_moves_the_folder_back(
    db_session, root, monkeypatch
):
    """T-363: the loser of a same-name race fails at commit on the unique constraint; that is the name 409."""
    project = await _project(db_session)
    item, _rev1 = await _rev(db_session, project)
    base = root / project.storage_dir
    await create_item(db_session, project, section="modelisation", name="Nouveau", user_id=None)
    await db_session.commit()
    _name_check_passes(monkeypatch)
    with pytest.raises(ProjectFilesError) as caught:
        await rename_item(db_session, project, item, "NOUVEAU")
    assert (caught.value.status_code, caught.value.detail) == (
        409,
        "An item with this name already exists in this section",
    )
    assert isinstance(caught.value.__cause__, IntegrityError)
    assert (base / "Modélisation" / "Support" / "R1" / "a.step").exists()


@pytest.mark.asyncio
async def test_rename_item_lets_another_integrity_error_through(db_session, root, monkeypatch):
    project = await _project(db_session)
    item, _rev1 = await _rev(db_session, project)
    base = root / project.storage_dir
    error = IntegrityError("UPDATE", {}, Exception("NOT NULL constraint failed: project_items.name"))

    async def boom():
        raise error

    monkeypatch.setattr(db_session, "commit", boom)
    with pytest.raises(IntegrityError) as caught:
        await rename_item(db_session, project, item, "Nouveau")
    assert caught.value is error
    assert (base / "Modélisation" / "Support" / "R1" / "a.step").exists()
    assert not (base / "Modélisation" / "Nouveau").exists()


@pytest.mark.asyncio
async def test_rename_item_conflicts(db_session, root):
    project = await _project(db_session)
    item, _ = await _rev(db_session, project)
    await _rev(db_session, project, name="Autre")
    with pytest.raises(ProjectFilesError) as taken:
        await rename_item(db_session, project, item, "autre")
    assert taken.value.status_code == 409


@pytest.mark.asyncio
async def test_case_only_rename(db_session, root):
    project = await _project(db_session)
    item, rev = await _rev(db_session, project)
    await rename_item(db_session, project, item, "SUPPORT")
    assert item.name == "SUPPORT"
    assert (root / project.storage_dir / "Modélisation" / "SUPPORT" / "R1" / "a.step").exists()


def _case_only_rename_fails(monkeypatch, base: Path, fail_targets: set[str]) -> list[tuple[str, str]]:
    """Force the case-only branch on any filesystem and make the module's rename of the temporary folder to
    any of the ``fail_targets`` folder names raise."""
    (base / "Modélisation" / "SUPPORT").mkdir(exist_ok=True)  # already "there" on a case-insensitive filesystem
    monkeypatch.setattr(project_files, "_samefile", lambda _a, _b: True)
    real_rename, calls = project_files._rename, []

    def rename(source, target):
        calls.append((Path(source).name, Path(target).name))
        if Path(source).name.startswith(".rename-") and Path(target).name in fail_targets:
            raise OSError(f"rename to {Path(target).name} failed")
        return real_rename(source, target)

    monkeypatch.setattr(project_files, "_rename", rename)
    return calls


@pytest.mark.asyncio
async def test_case_only_rename_puts_the_folder_back_when_the_second_rename_fails(db_session, root, monkeypatch):
    project = await _project(db_session)
    item, _rev1 = await _rev(db_session, project)
    item_id = item.id
    base = root / project.storage_dir
    calls = _case_only_rename_fails(monkeypatch, base, fail_targets={"SUPPORT"})
    with pytest.raises(OSError, match="rename to SUPPORT failed"):
        await rename_item(db_session, project, item, "SUPPORT")
    assert (base / "Modélisation" / "Support" / "R1" / "a.step").read_bytes() == b"data"
    assert not list((base / "Modélisation").glob(".rename-*"))
    assert [target for _source, target in calls] == [calls[0][1], "SUPPORT", "Support"]  # temp, new, back
    await db_session.rollback()
    assert (
        await db_session.execute(select(ProjectItem.name).where(ProjectItem.id == item_id))
    ).scalar_one() == "Support"


@pytest.mark.asyncio
async def test_case_only_rename_logs_and_keeps_the_original_error_when_the_put_back_fails(
    db_session, root, monkeypatch, caplog
):
    project = await _project(db_session)
    item, _rev1 = await _rev(db_session, project)
    base = root / project.storage_dir
    _case_only_rename_fails(monkeypatch, base, fail_targets={"SUPPORT", "Support"})
    caplog.set_level("WARNING", logger=project_files.logger.name)
    with pytest.raises(OSError, match="rename to SUPPORT failed"):
        await rename_item(db_session, project, item, "SUPPORT")
    stranded = list((base / "Modélisation").glob(".rename-*"))
    assert len(stranded) == 1
    assert any(str(stranded[0]) in r.getMessage() and r.exc_info for r in caplog.records)


@pytest.mark.asyncio
async def test_a_failed_rename_back_is_logged_and_the_rollback_still_runs(db_session, root, monkeypatch, caplog):
    project = await _project(db_session)
    item, _rev1 = await _rev(db_session, project)
    real_rename, rollbacks, real_rollback = project_files._rename, [], db_session.rollback
    commit_error = RuntimeError("db down")

    def rename(source, target):
        if Path(target).name == "Support":  # the rename back
            raise OSError("busy")
        return real_rename(source, target)

    async def boom():
        raise commit_error

    async def rollback():
        rollbacks.append("rollback")
        await real_rollback()

    monkeypatch.setattr(project_files, "_rename", rename)
    monkeypatch.setattr(db_session, "commit", boom)
    monkeypatch.setattr(db_session, "rollback", rollback)
    caplog.set_level("WARNING", logger=project_files.logger.name)
    with pytest.raises(RuntimeError) as caught:
        await rename_item(db_session, project, item, "Renamed")
    assert caught.value is commit_error
    assert rollbacks == ["rollback"]
    assert any("after a failed rename" in r.getMessage() and r.exc_info for r in caplog.records)


@pytest.mark.asyncio
async def test_rename_refuses_a_name_whose_folder_already_exists(db_session, root):
    project = await _project(db_session)
    item, _ = await _rev(db_session, project)
    await db_session.commit()
    base = root / project.storage_dir / "Modélisation"
    (base / "Copie").mkdir()
    with pytest.raises(ProjectFilesError) as caught:
        await rename_item(db_session, project, item, "Copie")
    assert (caught.value.status_code, caught.value.detail) == (409, "A folder with this name already exists")
    assert list((base / "Copie").iterdir()) == []
    assert (base / "Support" / "R1" / "a.step").exists()
    name = (await db_session.execute(select(ProjectItem.name).where(ProjectItem.id == item.id))).scalar_one()
    assert name == "Support"
