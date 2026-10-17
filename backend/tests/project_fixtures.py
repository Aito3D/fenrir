"""Helpers and fixtures shared by the project (PDM) test files.

A plain module, imported by the test files that need it (same style as
``aito_card_fixture.py``). The variants the files used to copy are kept as
keyword arguments, so each file picks its own behavior explicitly:

- ``projects_root_fixture(...)`` builds the per-file ``root`` fixture that points
  ``project_storage.projects_root`` at the test's ``tmp_path`` (or a ``projects``
  folder in it, optionally with ``settings.base_dir`` / ``archive_dir`` too).
- ``wal_engine_fixture`` is a file-backed WAL SQLite engine with a connection per
  session, as in production; the shared ``:memory:`` StaticPool engine hands every
  session one connection, which cannot show two writers or a background task's
  own session. Import it with ``# noqa: F401`` and request it as ``wal_engine``.
- ``make_order`` / ``make_task`` add an Aito order and a (linked) task; files that commit
  them bind ``commit=True`` with ``functools.partial``.
- ``make_users(db, prefix, specs)`` turns auth on and creates one user per spec key
  in one group with exactly those permissions; ``add_user_with_group`` and
  ``bearer_headers`` are its building blocks for files with their own naming.
"""

from __future__ import annotations

import io
import uuid
import zipfile
from collections.abc import AsyncIterator, Callable, Iterable, Mapping
from pathlib import Path

import pytest
from fastapi import UploadFile
from httpx import AsyncClient
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine

import backend.app.models  # noqa: F401  # registers every table on Base.metadata
from backend.app.api.routes.library import get_library_files_dir, to_relative_path
from backend.app.core.auth import create_access_token, get_password_hash
from backend.app.core.config import settings
from backend.app.core.database import Base, _set_sqlite_pragmas
from backend.app.core.permissions import Permission
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.group import Group
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.app.models.settings import Settings
from backend.app.models.user import User
from backend.app.services import project_storage

# --- storage roots -------------------------------------------------------------


def point_projects_root(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    subdir: str | None = None,
    library: bool = False,
    make_archive: bool = False,
) -> Path:
    """Point ``projects_root`` at ``tmp_path`` (or ``tmp_path / subdir``, created).

    ``library`` also points ``settings.base_dir`` at ``tmp_path`` and
    ``settings.archive_dir`` at ``tmp_path / "archive"`` (created first when
    ``make_archive``), for tests that store File Manager files too."""
    if library:
        monkeypatch.setattr(settings, "base_dir", tmp_path)
        if make_archive:
            (tmp_path / "archive").mkdir()
        monkeypatch.setattr(settings, "archive_dir", tmp_path / "archive")
    projects = tmp_path
    if subdir is not None:
        projects = tmp_path / subdir
        projects.mkdir()
    monkeypatch.setattr(project_storage, "projects_root", lambda: projects)
    return projects


def projects_root_fixture(
    *, autouse: bool = False, subdir: str | None = None, library: bool = False, make_archive: bool = False
) -> Callable:
    """A ``root`` fixture running ``point_projects_root`` with these options; assign it to ``root``."""

    @pytest.fixture(name="root", autouse=autouse)
    def _root(tmp_path, monkeypatch) -> Path:
        return point_projects_root(monkeypatch, tmp_path, subdir=subdir, library=library, make_archive=make_archive)

    return _root


def legacy_uploads_fixture(*, autouse: bool = False) -> Callable:
    """A ``legacy_uploads`` fixture putting the pre-server-slicing upload rules back.

    Projects now take one source ``.3mf`` per revision, but revisions made before that hold any
    printing files, several at a time. Tests of what those revisions do (download, zip, reslice,
    delete, symlink guards...) seed them through the upload path, so this swaps the name/count
    gate for the old printable-extension one and turns the content check off. Tests of the new
    rules do not use it. Assign it to ``legacy_uploads``."""

    @pytest.fixture(name="legacy_uploads", autouse=autouse)
    def _legacy_uploads(monkeypatch) -> None:
        from backend.app.services import project_files

        monkeypatch.setattr(project_files, "require_source_uploads", project_files.require_printable_uploads)
        monkeypatch.setattr(project_files, "require_source_names", project_files.require_printable_uploads)
        monkeypatch.setattr(project_files, "require_one_file", lambda _uploads: None)
        monkeypatch.setattr(project_files, "_require_source_content", lambda _path, _name: None)

    return _legacy_uploads


# --- database ------------------------------------------------------------------


async def create_wal_engine(path: Path) -> AsyncEngine:
    """A file-backed SQLite engine with the production pragmas (WAL, busy timeout) and every table."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}", echo=False)
    event.listen(engine.sync_engine, "connect", _set_sqlite_pragmas)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine


@pytest.fixture(name="wal_engine")
async def wal_engine_fixture(tmp_path) -> AsyncIterator[AsyncEngine]:
    engine = await create_wal_engine(tmp_path / "wal.db")
    yield engine
    await engine.dispose()


# --- auth ----------------------------------------------------------------------


def bearer_headers(user: User) -> dict[str, str]:
    """The ``Authorization`` header of a JWT issued to ``user``."""
    return {"Authorization": f"Bearer {create_access_token(data={'sub': user.username})}"}


async def add_user_with_group(
    db: AsyncSession, *, username: str, group_name: str, permissions: Iterable[str], password: str = "password"
) -> User:
    """Add (and flush, not commit) a non-system group holding exactly ``permissions`` and an
    active user in it."""
    group = Group(name=group_name, permissions=list(permissions), is_system=False)
    db.add(group)
    await db.flush()
    user = User(username=username, password_hash=get_password_hash(password), is_active=True)
    user.groups.append(group)
    db.add(user)
    await db.flush()
    return user


async def make_users(
    db: AsyncSession, prefix: str, specs: Mapping[str, Iterable[Permission]]
) -> dict[str, tuple[int, dict[str, str]]]:
    """Auth on. Each spec key gets one user (username and group name ``f"{prefix}{key}"``) in one
    group with exactly the listed permissions; returns ``key -> (user id, bearer headers)``."""
    db.add(Settings(key="auth_enabled", value="true"))
    out = {}
    for key, permissions in specs.items():
        name = f"{prefix}{key}"
        user = await add_user_with_group(db, username=name, group_name=name, permissions=[p.value for p in permissions])
        out[key] = (user.id, bearer_headers(user))
    await db.commit()
    return out


# --- files ---------------------------------------------------------------------


def upload(name: str, data: bytes = b"data") -> UploadFile:
    return UploadFile(filename=name, file=io.BytesIO(data))


def threemf_bytes() -> bytes:
    """A minimal Bambu 3MF. Fixed entry timestamps: two builds are byte-identical
    even when they fall in different seconds."""

    def entry(name: str) -> zipfile.ZipInfo:
        return zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr(
            entry("Metadata/project_settings.config"), '{"printer_model": "Bambu Lab X1C", "layer_height": "0.2"}'
        )
        zf.writestr(
            entry("3D/3dmodel.model"),
            '<model><metadata name="Application">BambuStudio-02.08.00.50</metadata></model>',
        )
    return buffer.getvalue()


class ChunkedMultipart:
    """A multipart ``files`` body posted with chunked transfer encoding: httpx sends an
    async-generator body without a Content-Length. ``sent`` counts the bytes the server
    actually pulled, so a test can see a refused upload stopped reading early."""

    BOUNDARY = "fenrir-chunked-boundary"

    def __init__(self, files: list[tuple[str, bytes]], *, chunk_size: int = 1024) -> None:
        self.body = self.encode(files)
        self.chunk_size = chunk_size
        self.sent = 0

    @classmethod
    def encode(cls, files: list[tuple[str, bytes]]) -> bytes:
        parts = [
            f'--{cls.BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="{name}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n".encode()
            + data
            + b"\r\n"
            for name, data in files
        ]
        return b"".join(parts) + f"--{cls.BOUNDARY}--\r\n".encode()

    @classmethod
    def of_size(cls, total: int, files: list[tuple[str, bytes]], name: str = "pad.gcode") -> ChunkedMultipart:
        """``files`` plus one ``name`` file padded so the whole body is exactly ``total`` bytes."""
        padding = total - len(cls.encode([*files, (name, b"")]))
        body = cls([*files, (name, b"x" * padding)])
        assert len(body.body) == total
        return body

    async def _stream(self) -> AsyncIterator[bytes]:
        for start in range(0, len(self.body), self.chunk_size):
            chunk = self.body[start : start + self.chunk_size]
            self.sent += len(chunk)
            yield chunk

    async def post(self, client: AsyncClient, url: str):
        return await client.post(
            url,
            content=self._stream(),
            headers={"content-type": f"multipart/form-data; boundary={self.BOUNDARY}"},
        )


# --- rows ----------------------------------------------------------------------


async def _save(db: AsyncSession, commit: bool) -> None:
    if commit:
        await db.commit()
    else:
        await db.flush()


async def make_project(db: AsyncSession, name: str = "Support caméra", *, commit: bool = False, **fields) -> Project:
    """A ``Project`` row, flushed (or committed)."""
    project = Project(name=name, **fields)
    db.add(project)
    await _save(db, commit)
    return project


async def api_project(client: AsyncClient, name: str = "Support caméra", *, check: bool = True) -> dict:
    """A project created through ``POST /api/v1/projects/``; ``check`` asserts the status first."""
    response = await client.post("/api/v1/projects/", json={"name": name})
    if check:
        assert response.status_code in (200, 201), response.text
    return response.json()


async def make_order(
    db: AsyncSession,
    *,
    status: str = "active",
    client_id: str = "C1",
    description: str = "Commande",
    commit: bool = False,
) -> AitoProject:
    """An Aito order (``AitoProject``) for client ``ACME`` in ``devis``, flushed (or committed)."""
    order = AitoProject(
        description=description, board_column="devis", status=status, client_id=client_id, client_name="ACME"
    )
    db.add(order)
    await _save(db, commit)
    return order


async def make_task(
    db: AsyncSession,
    order: AitoProject,
    title: str = "Support",
    *,
    linked_project_id: int | None = None,
    commit: bool = False,
) -> AitoTask:
    """A task on ``order``, optionally linked to a project, flushed (or committed)."""
    task = AitoTask(project_id=order.id, title=title, linked_project_id=linked_project_id)
    db.add(task)
    await _save(db, commit)
    return task


async def make_managed_library_file(
    db: AsyncSession, filename: str, data: bytes = b"bytes", *, commit: bool = True, **fields
) -> LibraryFile:
    """A managed File Manager file: ``data`` written under the library dir, its row committed (or flushed)."""
    path = get_library_files_dir() / f"{uuid.uuid4().hex}{Path(filename).suffix}"
    path.write_bytes(data)
    row = LibraryFile(
        filename=filename,
        file_path=to_relative_path(path),
        file_type=Path(filename).suffix.lstrip(".") or "unknown",
        file_size=len(data),
        is_external=False,
        **fields,
    )
    db.add(row)
    await _save(db, commit)
    return row


async def make_external_file(
    db: AsyncSession,
    tmp_path: Path,
    filename: str,
    data: bytes = b"nas",
    *,
    readonly: bool = True,
    commit: bool = True,
    **fields,
) -> LibraryFile:
    """A file in a fresh external (NAS) folder mounted under ``tmp_path``."""
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
        **fields,
    )
    db.add(row)
    await _save(db, commit)
    return row


async def revisions_of(db: AsyncSession, project_id: int) -> list[tuple[str, str, int, list[str]]]:
    """``(section, item name, revision number, sorted filenames)`` for every revision of the project."""
    rows = (
        await db.execute(
            select(ProjectItem.section, ProjectItem.name, ProjectRevision.number, ProjectRevision.id)
            .join(ProjectRevision, ProjectRevision.item_id == ProjectItem.id)
            .where(ProjectItem.project_id == project_id)
            .order_by(ProjectItem.name, ProjectRevision.number)
        )
    ).all()
    out = []
    for section, name, number, revision_id in rows:
        names = (
            (
                await db.execute(
                    select(LibraryFile.filename)
                    .where(LibraryFile.revision_id == revision_id)
                    .order_by(LibraryFile.filename)
                )
            )
            .scalars()
            .all()
        )
        out.append((section, name, number, list(names)))
    return out
