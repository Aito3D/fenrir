"""Deleting a project and creating an item in it race each other (T-066).

Both sides check, then write: ``delete_project`` refuses a project with items,
``create_item`` needs the project. Each re-checks once its own write holds the
SQLite write lock, so whichever loses is refused instead of stranding an item
(and its revision and files) under a deleted project — SQLite runs without FK
enforcement, nothing would cascade.

File-backed WAL SQLite with a connection per session, as in production: the
in-memory test database hands every session one shared connection, which cannot
show two writers.
"""

import pytest
from fastapi import HTTPException
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401  # registers every table on Base.metadata
from backend.app.api.routes import projects as projects_routes
from backend.app.core.database import Base, _set_sqlite_pragmas
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem
from backend.app.services import project_files, project_filing

ITEMS_DETAIL = "This project has files; delete or move its items first"


@pytest.fixture
async def sessions(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'race.db'}", echo=False)
    event.listen(engine.sync_engine, "connect", _set_sqlite_pragmas)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


async def _new_project(maker, name="Support caméra") -> int:
    async with maker() as db:
        project = Project(name=name)
        db.add(project)
        await db.commit()
        return project.id


async def _counts(maker, project_id: int) -> tuple[int, int]:
    """(projects with this id, items in it), read on a fresh connection."""
    async with maker() as db:
        projects = (await db.execute(select(func.count()).where(Project.id == project_id))).scalar_one()
        items = (
            await db.execute(select(func.count()).select_from(ProjectItem).where(ProjectItem.project_id == project_id))
        ).scalar_one()
        return projects, items


@pytest.mark.asyncio
async def test_item_committed_after_the_delete_precheck_refuses_the_delete(sessions, monkeypatch):
    project_id = await _new_project(sessions)

    async with sessions() as db:
        real_execute = db.execute
        injected = False

        async def execute(statement, *args, **kwargs):
            nonlocal injected
            result = await real_execute(statement, *args, **kwargs)
            if not injected and "project_items" in str(statement):
                # The pre-check just found no item: a drop commits one now.
                injected = True
                async with sessions() as other:
                    other.add(ProjectItem(project_id=project_id, section="impression", name="Pièce", name_key="piece"))
                    await other.commit()
            return result

        monkeypatch.setattr(db, "execute", execute)
        with pytest.raises(HTTPException) as caught:
            await projects_routes.delete_project(project_id, db=db, _=None)
        await db.rollback()  # what get_db does with the exception

    assert injected
    assert caught.value.status_code == 409
    assert caught.value.detail == ITEMS_DETAIL
    assert await _counts(sessions, project_id) == (1, 1)


@pytest.mark.asyncio
async def test_delete_without_a_racing_item_still_deletes(sessions):
    project_id = await _new_project(sessions)
    async with sessions() as db:
        assert await projects_routes.delete_project(project_id, db=db, _=None) == {"message": "Project deleted"}
        await db.commit()
    assert await _counts(sessions, project_id) == (0, 0)


async def _delete_project_after_name_check(sessions, monkeypatch, project_id: int) -> list[bool]:
    """Make ``_require_item_name_free`` (the last read before the insert) let a delete commit."""
    real_check = project_files._require_item_name_free
    deleted: list[bool] = []

    async def check(*args, **kwargs):
        await real_check(*args, **kwargs)
        async with sessions() as other:
            await other.delete(await other.get(Project, project_id))
            await other.commit()
        deleted.append(True)

    monkeypatch.setattr(project_files, "_require_item_name_free", check)
    return deleted


@pytest.mark.asyncio
async def test_create_item_in_a_project_deleted_meanwhile_is_refused(sessions, monkeypatch):
    project_id = await _new_project(sessions)
    deleted = await _delete_project_after_name_check(sessions, monkeypatch, project_id)

    async with sessions() as db:
        project = await db.get(Project, project_id)
        with pytest.raises(project_files.ProjectFilesError) as caught:
            await project_files.create_item(db, project, section="impression", name="Pièce", user_id=None)
        await db.commit()  # nothing of the refused insert is left to commit

    assert deleted == [True]
    assert (caught.value.status_code, caught.value.detail) == (404, "Project not found")
    assert await _counts(sessions, project_id) == (0, 0)


@pytest.mark.asyncio
async def test_find_or_create_item_in_a_project_deleted_meanwhile_is_refused(sessions, monkeypatch):
    project_id = await _new_project(sessions)
    deleted = await _delete_project_after_name_check(sessions, monkeypatch, project_id)

    async with sessions() as db:
        project = await db.get(Project, project_id)
        with pytest.raises(project_files.ProjectFilesError) as caught:
            await project_filing.find_or_create_item(db, project, "impression", "piece", "Pièce", None)
        await db.commit()  # e.g. the drop route's ``finally`` commits its event

    assert deleted == [True]
    assert (caught.value.status_code, caught.value.detail) == (404, "Project not found")
    assert await _counts(sessions, project_id) == (0, 0)
