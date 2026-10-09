"""Deleting a project and creating an item in it race each other (T-066).

Both sides check, then write: ``delete_project`` refuses a project with items,
``create_item`` needs the project. Each re-checks once its own write holds the
SQLite write lock, so whichever loses is refused instead of stranding an item
(and its revision and files) under a deleted project — SQLite runs without FK
enforcement, nothing would cascade.

Deleting an item races a print or delivery of one of its revisions the same way
(T-077): ``delete_item`` re-checks usage once its delete holds the write lock.
So does linking an Aito task to a project being deleted (T-078): ``link_task``
re-checks the project once its link holds the write lock, and ``delete_project``
re-checks live task links once its delete holds it (T-079).

File-backed WAL SQLite with a connection per session, as in production: the
in-memory test database hands every session one shared connection, which cannot
show two writers.
"""

import io

import pytest
from fastapi import HTTPException, UploadFile
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401  # registers every table on Base.metadata
from backend.app.api.routes import aito_project_links as links_routes, projects as projects_routes
from backend.app.core.database import Base, _set_sqlite_pragmas
from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.aito_task_delivery import AitoTaskDelivery
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.app.schemas.aito_project_links import TaskLinkRequest
from backend.app.services import aito_events, aito_project_links, project_files, project_filing, project_storage

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


# --- delete_item against a use committed after its pre-check (T-077) ---------

ITEM_USED_DETAIL = "A revision of this item was printed or delivered; the item cannot be deleted"


@pytest.fixture
def root(tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setattr(project_storage, "projects_root", lambda: projects)
    return projects


async def _item_with_a_revision(maker) -> tuple[int, int, int, int, str]:
    """(project id, item id, revision id, file id, project storage dir), committed."""
    async with maker() as db:
        project = Project(name="Support caméra")
        db.add(project)
        await db.flush()
        item = await project_files.create_item(db, project, section="modelisation", name="Support", user_id=None)
        revision, _ = await project_files.add_revision(
            db,
            project,
            item,
            [UploadFile(filename="a.step", file=io.BytesIO(b"data"))],
            note=None,
            derived_from_id=None,
            user_id=None,
        )
        file_id = (await db.execute(select(LibraryFile.id).where(LibraryFile.revision_id == revision.id))).scalar_one()
        await db.commit()
        return project.id, item.id, revision.id, file_id, project.storage_dir


def _use_after_the_pre_check(maker, monkeypatch, make_use) -> list[int]:
    """Once delete_item's pre-check found the revision unused, a second session commits ``make_use``."""
    real = project_files.revision_is_used
    calls: list[int] = []

    async def racing(db, revision_id):
        used = await real(db, revision_id)
        if not calls:
            calls.append(revision_id)
            async with maker() as other:
                await make_use(other, revision_id)
                await other.commit()
        return used

    monkeypatch.setattr(project_files, "revision_is_used", racing)
    return calls


async def _item_state(maker, item_id: int, revision_id: int) -> tuple[int, int, int]:
    """(items, revisions, file rows) still present, read on a fresh connection."""
    async with maker() as db:
        items = (await db.execute(select(func.count()).where(ProjectItem.id == item_id))).scalar_one()
        revisions = (await db.execute(select(func.count()).where(ProjectRevision.id == revision_id))).scalar_one()
        files = (
            await db.execute(
                select(func.count()).select_from(LibraryFile).where(LibraryFile.revision_id == revision_id)
            )
        ).scalar_one()
        return items, revisions, files


async def _delete_item_racing(maker, monkeypatch, root, make_use):
    project_id, item_id, revision_id, _, storage_dir = await _item_with_a_revision(maker)
    calls = _use_after_the_pre_check(maker, monkeypatch, make_use)
    async with maker() as db:
        project = await db.get(Project, project_id)
        item = await db.get(ProjectItem, item_id)
        with pytest.raises(project_files.ProjectFilesError) as caught:
            await project_files.delete_item(db, project, item)
    assert calls == [revision_id]
    assert (caught.value.status_code, caught.value.detail) == (409, ITEM_USED_DETAIL)
    assert await _item_state(maker, item_id, revision_id) == (1, 1, 1)
    base = root / storage_dir
    assert (base / "Modélisation" / "Support" / "R1" / "a.step").read_bytes() == b"data"
    assert not (base / "_trash").exists() or not any(p.is_file() for p in (base / "_trash").rglob("*"))


@pytest.mark.asyncio
async def test_delete_item_refuses_a_delivery_committed_after_the_pre_check(sessions, root, monkeypatch):
    async def deliver(other, revision_id):
        other.add(AitoTaskDelivery(task_id=4242, revision_id=revision_id))

    await _delete_item_racing(sessions, monkeypatch, root, deliver)


@pytest.mark.asyncio
async def test_delete_item_refuses_a_queued_print_committed_after_the_pre_check(sessions, root, monkeypatch):
    async def queue(other, revision_id):
        file_id = (
            await other.execute(select(LibraryFile.id).where(LibraryFile.revision_id == revision_id))
        ).scalar_one()
        other.add(PrintQueueItem(library_file_id=file_id))

    await _delete_item_racing(sessions, monkeypatch, root, queue)


@pytest.mark.asyncio
async def test_delete_item_refuses_an_archived_print_committed_after_the_pre_check(sessions, root, monkeypatch):
    async def archive(other, revision_id):
        file_id = (
            await other.execute(select(LibraryFile.id).where(LibraryFile.revision_id == revision_id))
        ).scalar_one()
        other.add(PrintArchive(filename="x", file_path="x", file_size=1, library_file_id=file_id))

    await _delete_item_racing(sessions, monkeypatch, root, archive)


@pytest.mark.asyncio
async def test_delete_item_without_a_racing_use_still_trashes_the_item(sessions, root):
    project_id, item_id, revision_id, _, storage_dir = await _item_with_a_revision(sessions)
    async with sessions() as db:
        project = await db.get(Project, project_id)
        await project_files.delete_item(db, project, await db.get(ProjectItem, item_id))
    assert await _item_state(sessions, item_id, revision_id) == (0, 0, 0)
    base = root / storage_dir
    assert not (base / "Modélisation" / "Support").exists()
    assert [p.name for p in (base / "_trash").rglob("a.step")] == ["a.step"]


@pytest.mark.asyncio
async def test_delete_item_refuses_a_use_of_a_later_revision_committed_after_the_pre_check(sessions, root, monkeypatch):
    # Two revisions: the use lands on R2, after the pre-check has passed over both.
    project_id, item_id, first_id, _, storage_dir = await _item_with_a_revision(sessions)
    async with sessions() as db:
        project = await db.get(Project, project_id)
        second, _ = await project_files.add_revision(
            db,
            project,
            await db.get(ProjectItem, item_id),
            [UploadFile(filename="b.step", file=io.BytesIO(b"more"))],
            note=None,
            derived_from_id=None,
            user_id=None,
        )
        await db.commit()
        second_id = second.id

    real = project_files.revision_is_used
    checked: list[int] = []

    async def racing(db, revision_id):
        used = await real(db, revision_id)
        checked.append(revision_id)
        if revision_id == second_id:
            async with sessions() as other:
                other.add(AitoTaskDelivery(task_id=4242, revision_id=second_id))
                await other.commit()
        return used

    monkeypatch.setattr(project_files, "revision_is_used", racing)
    async with sessions() as db:
        project = await db.get(Project, project_id)
        with pytest.raises(project_files.ProjectFilesError) as caught:
            await project_files.delete_item(db, project, await db.get(ProjectItem, item_id))

    assert sorted(checked) == sorted([first_id, second_id])
    assert (caught.value.status_code, caught.value.detail) == (409, ITEM_USED_DETAIL)
    assert await _item_state(sessions, item_id, first_id) == (1, 1, 1)
    assert await _item_state(sessions, item_id, second_id) == (1, 1, 1)
    base = root / storage_dir / "Modélisation" / "Support"
    assert (base / "R1" / "a.step").read_bytes() == b"data"
    assert (base / "R2" / "b.step").read_bytes() == b"more"
    trash = root / storage_dir / "_trash"
    assert not trash.exists() or not any(p.is_file() for p in trash.rglob("*"))


# --- link_task against a project deleted after it was read (T-078) -----------


async def _task_linked_to(maker, linked: int | None) -> int:
    async with maker() as db:
        order = AitoProject(
            description="Commande", board_column="devis", status="active", client_id="C1", client_name="ACME"
        )
        db.add(order)
        await db.flush()
        task = AitoTask(project_id=order.id, title="Support", linked_project_id=linked)
        db.add(task)
        await db.commit()
        return task.id


def _delete_project_after_its_read(maker, db, monkeypatch, project_id: int) -> list[int]:
    """Once ``db`` has read project ``project_id``, a second session deletes it and commits."""
    real_get = db.get
    deleted: list[int] = []

    async def get(entity, ident, *args, **kwargs):
        found = await real_get(entity, ident, *args, **kwargs)
        if entity is Project and ident == project_id and not deleted:
            async with maker() as other:
                await other.delete(await other.get(Project, project_id))
                await other.commit()
            deleted.append(project_id)
        return found

    monkeypatch.setattr(db, "get", get)
    return deleted


async def _link_state(maker, task_id: int) -> tuple[int | None, int]:
    """(the task's linked project id, Aito events), read on a fresh connection."""
    async with maker() as db:
        linked = (await db.execute(select(AitoTask.linked_project_id).where(AitoTask.id == task_id))).scalar_one()
        events = (await db.execute(select(func.count()).select_from(AitoEvent))).scalar_one()
        return linked, events


def _spy_events(monkeypatch) -> list[str]:
    real_record = aito_events.record
    kinds: list[str] = []

    async def record(db, order_id, kind, **kwargs):
        kinds.append(kind)
        return await real_record(db, order_id, kind, **kwargs)

    monkeypatch.setattr(aito_events, "record", record)
    return kinds


@pytest.mark.asyncio
@pytest.mark.parametrize("starts_linked", [False, True])
async def test_link_task_to_a_project_deleted_meanwhile_is_refused(sessions, monkeypatch, starts_linked):
    previous_id = await _new_project(sessions, name="Ancien") if starts_linked else None
    project_id = await _new_project(sessions)
    task_id = await _task_linked_to(sessions, previous_id)
    kinds = _spy_events(monkeypatch)

    async with sessions() as db:
        deleted = _delete_project_after_its_read(sessions, db, monkeypatch, project_id)
        task = await db.get(AitoTask, task_id)
        with pytest.raises(aito_project_links.LinkError) as caught:
            await aito_project_links.link_task(db, task, project_id, actor="paul")
        await db.rollback()  # what both link routes do with a LinkError

    assert deleted == [project_id]
    assert (caught.value.status_code, caught.value.detail) == (404, "Project not found")
    assert kinds == []
    assert await _link_state(sessions, task_id) == (previous_id, 0)


@pytest.mark.asyncio
async def test_put_task_project_to_a_project_deleted_meanwhile_is_a_404(sessions, monkeypatch):
    project_id = await _new_project(sessions)
    task_id = await _task_linked_to(sessions, None)

    async with sessions() as db:
        deleted = _delete_project_after_its_read(sessions, db, monkeypatch, project_id)
        with pytest.raises(HTTPException) as caught:
            await links_routes.put_task_project(
                task_id, TaskLinkRequest(project_id=project_id), db=db, user=None, __=None
            )

    assert deleted == [project_id]
    assert (caught.value.status_code, caught.value.detail) == (404, "Project not found")
    assert await _link_state(sessions, task_id) == (None, 0)


@pytest.mark.asyncio
async def test_link_task_without_a_racing_delete_still_links(sessions, monkeypatch):
    project_id = await _new_project(sessions)
    task_id = await _task_linked_to(sessions, None)
    kinds = _spy_events(monkeypatch)

    async with sessions() as db:
        task = await db.get(AitoTask, task_id)
        assert await aito_project_links.link_task(db, task, project_id, actor="paul") is task
        await db.commit()

    assert kinds == ["task.project_linked"]
    assert await _link_state(sessions, task_id) == (project_id, 1)


# --- delete_project against a task link committed after its check (T-079) ----

LINKED_DETAIL = "This project is linked to Aito tasks; unlink them first"


async def _order_task(maker, status: str, linked: int | None) -> int:
    """A task on a new order with ``status``, linked to ``linked``; returns the task id."""
    async with maker() as db:
        order = AitoProject(
            description="Commande", board_column="devis", status=status, client_id="C1", client_name="ACME"
        )
        db.add(order)
        await db.flush()
        task = AitoTask(project_id=order.id, title="Support", linked_project_id=linked)
        db.add(task)
        await db.commit()
        return task.id


async def _linked_ids(maker, *task_ids: int) -> list[int | None]:
    async with maker() as db:
        return [
            (await db.execute(select(AitoTask.linked_project_id).where(AitoTask.id == task_id))).scalar_one()
            for task_id in task_ids
        ]


@pytest.mark.asyncio
async def test_task_link_committed_after_the_delete_link_check_refuses_the_delete(sessions, monkeypatch):
    project_id = await _new_project(sessions)
    live_task = await _order_task(sessions, "active", None)
    trashed_task = await _order_task(sessions, "deleted", project_id)

    async with sessions() as db:
        real_execute = db.execute
        injected = False

        async def execute(statement, *args, **kwargs):
            nonlocal injected
            result = await real_execute(statement, *args, **kwargs)
            if not injected and "aito_tasks" in str(statement):
                # The link check just found no live link: PUT /tasks/{id}/project commits one now.
                injected = True
                async with sessions() as other:
                    (await other.get(AitoTask, live_task)).linked_project_id = project_id
                    await other.commit()
            return result

        monkeypatch.setattr(db, "execute", execute)
        with pytest.raises(HTTPException) as caught:
            await projects_routes.delete_project(project_id, db=db, _=None)
        await db.rollback()  # what get_db does with the exception

    assert injected
    assert (caught.value.status_code, caught.value.detail) == (409, LINKED_DETAIL)
    assert await _counts(sessions, project_id) == (1, 0)
    # The live link survives, and the rolled-back delete left the trashed order's link too.
    assert await _linked_ids(sessions, live_task, trashed_task) == [project_id, project_id]


@pytest.mark.asyncio
async def test_delete_without_a_racing_link_clears_links_outside_live_orders(sessions):
    project_id = await _new_project(sessions)
    other_id = await _new_project(sessions, name="Autre")
    trashed_task = await _order_task(sessions, "deleted", project_id)
    live_unlinked = await _order_task(sessions, "active", None)
    live_elsewhere = await _order_task(sessions, "active", other_id)
    async with sessions() as db:
        # A task whose order row is gone: the link check never sees it, the clear always did.
        orphan = AitoTask(project_id=987654, title="Orpheline", linked_project_id=project_id)
        db.add(orphan)
        await db.commit()
        orphan_task = orphan.id

    async with sessions() as db:
        assert await projects_routes.delete_project(project_id, db=db, _=None) == {"message": "Project deleted"}
        await db.commit()

    assert await _counts(sessions, project_id) == (0, 0)
    assert await _linked_ids(sessions, trashed_task, orphan_task, live_unlinked, live_elsewhere) == [
        None,
        None,
        None,
        other_id,
    ]
