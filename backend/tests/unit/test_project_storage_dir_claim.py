"""A pre-phase-1 project's folder name is claimed once (T-295).

Projects created before phase 1 have no ``storage_dir``. The startup migration
fills them (``test_project_pdm_migration.py``); a row that still reaches the
file service without one is claimed with a conditional UPDATE, so two uploads
that saw different titles share one folder: the second adopts the first's name.
"""

import weakref

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.models.library import LibraryFile
from backend.app.models.project import Project
from backend.app.services import project_files
from backend.app.services.project_files import _claim_storage_dir, add_revision, create_item, get_item_for_project
from backend.tests.project_fixtures import (
    projects_root_fixture,
    upload,
    wal_engine_fixture,  # noqa: F401  # the ``wal_engine`` fixture
)

root = projects_root_fixture(subdir="projects")


@pytest.fixture(autouse=True)
def own_item_locks(monkeypatch):
    """A fresh lock registry per test: an asyncio.Lock binds to the loop of its first contended acquire."""
    monkeypatch.setattr(project_files, "_item_locks", weakref.WeakValueDictionary())


@pytest.fixture
async def sessions(test_engine, wal_engine):
    """Two sessions on a WAL file database (``test_engine`` only registers the models)."""
    maker = async_sessionmaker(wal_engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as a, maker() as b:
        yield a, b


async def _legacy_project(db, name="Ancien titre") -> tuple[int, int]:
    """A project and an item, then ``storage_dir`` cleared as on a row written before phase 1."""
    project = Project(name=name)
    db.add(project)
    await db.flush()
    item = await create_item(db, project, section="impression", name="Support", user_id=None)
    await db.execute(text("UPDATE projects SET storage_dir = NULL WHERE id = :id"), {"id": project.id})
    await db.commit()
    return project.id, item.id


async def _stored_dir(db, project_id) -> str | None:
    return (await db.execute(text("SELECT storage_dir FROM projects WHERE id = :id"), {"id": project_id})).scalar_one()


@pytest.mark.asyncio
async def test_first_upload_claims_the_name_from_the_current_title(db_session, root):
    project_id, item_id = await _legacy_project(db_session)
    db_session.expire_all()
    item, project = await get_item_for_project(db_session, item_id)
    assert project.storage_dir is None
    await add_revision(db_session, project, item, [upload("a.gcode")], note=None, derived_from_id=None, user_id=None)
    code = project.code
    assert await _stored_dir(db_session, project_id) == f"{code}_ancien-titre"
    assert project.storage_dir == f"{code}_ancien-titre"
    assert (root / f"{code}_ancien-titre" / "Impression" / "Support" / "R1" / "a.gcode").exists()


@pytest.mark.asyncio
async def test_a_second_upload_adopts_the_name_claimed_after_it_loaded_the_project(sessions, root):
    a, b = sessions
    project_id, item_id = await _legacy_project(a)
    a.expire_all()
    # Upload A loads the project while it still has no folder name...
    item_a, project_a = await get_item_for_project(a, item_id)
    assert project_a.storage_dir is None
    code = project_a.code
    # ...then the project is renamed and upload B, which saw the new title, claims first.
    item_b, project_b = await get_item_for_project(b, item_id)
    project_b.name = "Nouveau titre"
    await b.commit()
    await add_revision(b, project_b, item_b, [upload("b.gcode")], note=None, derived_from_id=None, user_id=None)
    assert await _stored_dir(b, project_id) == f"{code}_nouveau-titre"

    # A still holds the old title in memory, but adopts the stored name instead of its own.
    assert project_a.name == "Ancien titre" and project_a.storage_dir is None
    await add_revision(a, project_a, item_a, [upload("a.gcode")], note=None, derived_from_id=None, user_id=None)

    assert project_a.storage_dir == f"{code}_nouveau-titre"
    assert await _stored_dir(a, project_id) == f"{code}_nouveau-titre"
    assert not (root / f"{code}_ancien-titre").exists()
    base = root / f"{code}_nouveau-titre" / "Impression" / "Support"
    assert (base / "R1" / "b.gcode").exists()
    assert (base / "R2" / "a.gcode").exists()
    paths = (await a.execute(select(LibraryFile.file_path).order_by(LibraryFile.id))).scalars().all()
    assert all(f"{code}_nouveau-titre" in path for path in paths)


@pytest.mark.asyncio
async def test_a_project_with_a_folder_name_runs_no_statement(db_session, monkeypatch):
    project = Project(name="Courant")
    db_session.add(project)
    await db_session.flush()
    stored = project.storage_dir
    assert stored

    async def no_sql(*_args, **_kwargs):
        raise AssertionError("no statement expected")

    monkeypatch.setattr(db_session, "execute", no_sql)
    await _claim_storage_dir(db_session, project)
    assert project.storage_dir == stored


@pytest.mark.asyncio
async def test_a_project_deleted_meanwhile_is_left_to_ensure_project_dir(db_session):
    project_id, _item_id = await _legacy_project(db_session)
    db_session.expire_all()
    project = await db_session.get(Project, project_id)
    await db_session.execute(text("DELETE FROM projects WHERE id = :id"), {"id": project_id})
    await _claim_storage_dir(db_session, project)
    assert project.storage_dir is None
    await db_session.rollback()
