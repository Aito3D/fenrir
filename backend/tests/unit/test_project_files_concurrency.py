"""Project files under concurrency: atomic file claims and the per-item lock (final review F3/F4)."""

import asyncio
import hashlib
import io
import weakref

import pytest
from fastapi import UploadFile
from sqlalchemy import event, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.app.api.routes.library import to_absolute_path
from backend.app.core.database import Base
from backend.app.models.library import LibraryFile
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.app.services import project_files, project_storage
from backend.app.services.project_files import (
    ProjectFilesError,
    add_files_to_revision,
    add_revision,
    create_item,
    get_item_for_project,
    get_revision_bundle,
    rename_item,
)


@pytest.fixture
def root(tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setattr(project_storage, "projects_root", lambda: projects)
    return projects


@pytest.fixture(autouse=True)
def own_item_locks(monkeypatch):
    """A fresh lock registry per test: an asyncio.Lock binds to the loop of its first contended acquire."""
    monkeypatch.setattr(project_files, "_item_locks", weakref.WeakValueDictionary())


@pytest.fixture
async def sessions(test_engine, tmp_path):
    """Two sessions on a WAL file database: `test_engine` is `:memory:` behind a StaticPool, so concurrent
    sessions there share one sqlite3 connection (fails on CI's SQLite 3.46). Uses `test_engine` only for
    its model registration."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'race.db'}")

    @event.listens_for(engine.sync_engine, "connect")
    def _pragmas(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode = WAL")
        cursor.execute("PRAGMA busy_timeout = 15000")
        cursor.close()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as a, maker() as b:
        yield a, b
    await engine.dispose()


def upload(name: str, data: bytes) -> UploadFile:
    return UploadFile(filename=name, file=io.BytesIO(data))


async def _seed(db) -> tuple[int, int]:
    project = Project(name="Course")
    db.add(project)
    await db.flush()
    item = await create_item(db, project, section="modelisation", name="Support", user_id=None)
    await db.commit()
    return project.id, item.id


async def _assert_rows_match_disk(db) -> list[LibraryFile]:
    rows = (await db.execute(select(LibraryFile))).scalars().all()
    for row in rows:
        path = to_absolute_path(row.file_path)
        assert path is not None and path.exists(), row.file_path
        assert hashlib.sha256(path.read_bytes()).hexdigest() == row.file_hash
    return list(rows)


@pytest.mark.asyncio
async def test_concurrent_streams_of_one_name_never_share_a_file(root, monkeypatch):
    folder = root / "R1"
    folder.mkdir()
    real = project_files._stream_upload_to_path
    arrived = {"n": 0}
    both = asyncio.Event()
    temp_names: list[str] = []

    async def overlapping(file, dest, max_bytes, on_first_chunk=None):
        temp_names.append(dest.name)
        arrived["n"] += 1
        if arrived["n"] == 2:
            both.set()
        await both.wait()  # both uploads are mid-stream at the same time
        return await real(file, dest, max_bytes)

    monkeypatch.setattr(project_files, "_stream_upload_to_path", overlapping)
    first, second = await asyncio.gather(
        project_files._stream_files(folder, [upload("a.step", b"first")]),
        project_files._stream_files(folder, [upload("a.step", b"second")]),
    )
    assert len(set(temp_names)) == 2
    written = first + second
    assert sorted(w.path.name for w in written) == ["a (2).step", "a.step"]
    for entry in written:
        assert hashlib.sha256(entry.path.read_bytes()).hexdigest() == entry.digest
    assert sorted(p.name for p in folder.iterdir()) == ["a (2).step", "a.step"]


@pytest.mark.asyncio
async def test_concurrent_uploads_to_one_item_keep_every_file(sessions, root):
    a, b = sessions
    _project_id, item_id = await _seed(a)

    async def new_revision(db, data: bytes):
        item, project = await get_item_for_project(db, item_id)
        try:
            await add_revision(
                db, project, item, [upload("plate.step", data)], note=None, derived_from_id=None, user_id=None
            )
            return "ok"
        except ProjectFilesError as exc:
            assert exc.status_code == 409
            return "409"

    outcomes = await asyncio.gather(new_revision(a, b"one"), new_revision(b, b"two"))
    assert outcomes.count("ok") >= 1
    rows = await _assert_rows_match_disk(a)
    assert len(rows) == outcomes.count("ok")

    revision_id = (await a.execute(select(ProjectRevision.id).order_by(ProjectRevision.id))).scalars().first()

    async def more_files(db, data: bytes):
        revision, item, project = await get_revision_bundle(db, revision_id)
        await add_files_to_revision(db, project, item, revision, [upload("extra.step", data)], user_id=None)

    await asyncio.gather(more_files(a, b"x" * 50_000), more_files(b, b"y" * 70_000))
    rows = await _assert_rows_match_disk(a)
    names = sorted(r.filename for r in rows if r.revision_id == revision_id)
    assert names == ["extra (2).step", "extra.step", "plate.step"]


@pytest.mark.asyncio
async def test_rename_waits_for_a_running_upload_then_moves_its_files(sessions, root, monkeypatch):
    a, b = sessions
    _project_id, item_id = await _seed(a)
    real = project_files._stream_files
    streaming = asyncio.Event()
    release = asyncio.Event()

    async def slow(folder, uploads):
        streaming.set()
        await release.wait()
        return await real(folder, uploads)

    monkeypatch.setattr(project_files, "_stream_files", slow)

    async def do_upload():
        item, project = await get_item_for_project(a, item_id)
        return await add_revision(
            a, project, item, [upload("plate.step", b"geo")], note=None, derived_from_id=None, user_id=None
        )

    async def do_rename():
        item, project = await get_item_for_project(b, item_id)
        return await rename_item(b, project, item, "Support v2")

    upload_task = asyncio.create_task(do_upload())
    await streaming.wait()
    rename_task = asyncio.create_task(do_rename())
    # The upload is parked on ``release`` while holding the item lock, so the rename
    # can only still be pending here because it is blocked on that lock.
    _done, pending = await asyncio.wait({rename_task}, timeout=0.2)
    assert rename_task in pending, "rename must wait for the upload holding the item lock"
    assert not upload_task.done()  # the lock holder is still parked on the event
    release.set()
    await upload_task
    renamed = await rename_task
    assert renamed.name == "Support v2"

    a.expire_all()
    rows = await _assert_rows_match_disk(a)
    assert len(rows) == 1
    assert "Support v2" in rows[0].file_path


@pytest.mark.asyncio
async def test_upload_refuses_when_the_item_changed_behind_its_back(sessions, root, monkeypatch):
    a, b = sessions
    _project_id, item_id = await _seed(a)
    real = project_files._stream_files

    async def rename_meanwhile(folder, uploads):
        written = await real(folder, uploads)
        # a writer that bypasses the lock (another process, a manual edit) renames the item
        await b.execute(
            update(ProjectItem).where(ProjectItem.id == item_id).values(name="Ailleurs", name_key="ailleurs")
        )
        await b.commit()
        return written

    monkeypatch.setattr(project_files, "_stream_files", rename_meanwhile)
    item, project = await get_item_for_project(a, item_id)
    storage_dir = project.storage_dir
    with pytest.raises(ProjectFilesError) as err:
        await add_revision(
            a, project, item, [upload("plate.step", b"geo")], note=None, derived_from_id=None, user_id=None
        )
    assert err.value.status_code == 409
    folder = root / storage_dir / "Modélisation" / "Support" / "R1"
    assert not folder.exists() or list(folder.iterdir()) == []
    assert (await a.execute(select(LibraryFile))).scalars().all() == []
    assert (await a.execute(select(ProjectRevision))).scalars().all() == []


@pytest.mark.asyncio
async def test_upload_after_the_item_was_deleted_is_a_404(sessions, root):
    a, b = sessions
    _project_id, item_id = await _seed(a)
    item, project = await get_item_for_project(a, item_id)
    stale, stale_project = await get_item_for_project(b, item_id)
    await project_files.delete_item(a, project, item)
    with pytest.raises(ProjectFilesError) as err:
        await add_revision(
            b, stale_project, stale, [upload("plate.step", b"geo")], note=None, derived_from_id=None, user_id=None
        )
    assert err.value.status_code == 404
    assert (await b.execute(select(LibraryFile))).scalars().all() == []
