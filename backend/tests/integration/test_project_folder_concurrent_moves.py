"""Two concurrent folder moves that would make a cycle (T-526).

Each move loads its folder and new parent before either checks the tree. The winner moves; the
loser gets the 409 a sequential request gets, and the stored tree never holds a cycle.
"""

import asyncio

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.models.project_folder import ProjectFolder
from backend.app.services import project_catalog
from backend.tests.project_fixtures import wal_engine_fixture  # noqa: F401  # the ``wal_engine`` fixture


@pytest.mark.asyncio
async def test_two_crossing_moves_at_once_never_store_a_cycle(wal_engine, monkeypatch):
    maker = async_sessionmaker(wal_engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as db:
        a, b = ProjectFolder(name="A"), ProjectFolder(name="B")
        db.add_all([a, b])
        await db.commit()
        a_id, b_id = a.id, b.id

    # A lock bound to this test's event loop, not the module's shared one.
    monkeypatch.setattr(project_catalog, "_FOLDER_TREE_LOCK", asyncio.Lock())
    real_get_folder = project_catalog.get_folder
    arrived: list[int] = []
    both_loaded = asyncio.Event()

    async def get_folder_then_wait(db, folder_id):
        folder = await real_get_folder(db, folder_id)
        arrived.append(folder_id)
        if len(arrived) == 2:
            both_loaded.set()
        await both_loaded.wait()
        return folder

    monkeypatch.setattr(project_catalog, "get_folder", get_folder_then_wait)

    async def move(folder_id: int, parent_id: int) -> tuple[int, str | None]:
        async with maker() as db:
            folder = await db.get(ProjectFolder, folder_id)
            assert folder is not None
            try:
                await project_catalog.update_folder(db, folder, name=None, parent_id=parent_id, parent_given=True)
            except project_catalog.ProjectCatalogError as exc:
                await db.rollback()
                return exc.status_code, exc.detail
            return 200, None

    results = await asyncio.gather(move(a_id, b_id), move(b_id, a_id))

    assert sorted(results, key=lambda r: r[0]) == [(200, None), (409, "A folder cannot be moved into itself")]
    async with maker() as db:
        parents = dict((await db.execute(select(ProjectFolder.id, ProjectFolder.parent_id))).tuples().all())
    assert parents in ({a_id: b_id, b_id: None}, {a_id: None, b_id: a_id})


@pytest.mark.asyncio
async def test_a_rename_and_move_in_one_call_keeps_both(wal_engine):
    maker = async_sessionmaker(wal_engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as db:
        a, b = ProjectFolder(name="A"), ProjectFolder(name="B")
        db.add_all([a, b])
        await db.commit()
        moved = await project_catalog.update_folder(db, a, name="  Car  ", parent_id=b.id, parent_given=True)
        assert (moved.name, moved.parent_id) == ("Car", b.id)
    async with maker() as db:
        stored = await db.get(ProjectFolder, a.id)
        assert stored is not None and (stored.name, stored.parent_id) == ("Car", b.id)
