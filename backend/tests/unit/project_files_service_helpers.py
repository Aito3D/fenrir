"""Helpers shared by the test_project_files_service_*.py files (split from test_project_files_service.py)."""

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


async def _rev(db, project, section="modelisation", name="Support", files=None):
    item = await create_item(db, project, section=section, name=name, user_id=None)
    rev, _ = await add_revision(
        db, project, item, files or [upload("a.step")], note=None, derived_from_id=None, user_id=None
    )
    return item, rev


async def _mark_used(db, rev):
    file_id = (await db.execute(select(LibraryFile.id).where(LibraryFile.revision_id == rev.id))).scalars().first()
    db.add(PrintArchive(filename="x", file_path="x", file_size=1, library_file_id=file_id))
    await db.flush()


def _trash_entries(base: Path) -> list[Path]:
    """Files left in the project's _trash (the empty parent folders move_to_trash created do not count)."""
    return [p for p in (base / "_trash").rglob("*") if not p.is_dir()] if (base / "_trash").exists() else []


async def _fresh_scalars(test_engine, statement):
    async with AsyncSession(test_engine) as fresh:
        return list((await fresh.execute(statement)).scalars().all())


async def _fork_source_with_thumbnail(db_session, monkeypatch, tmp_path):
    """A committed impression revision whose 3MF has a thumbnail; returns what the fork tests check."""
    thumbs = tmp_path / "thumbs"
    thumbs.mkdir()
    monkeypatch.setattr(project_files, "get_library_thumbnails_dir", lambda: thumbs)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("Metadata/project_settings.config", '{"printer_model": "X"}')
        zf.writestr("3D/3dmodel.model", "<model></model>")
        zf.writestr("Metadata/plate_1.png", b"\x89PNG fake")
    project = await _project(db_session)
    item, rev = await _rev(db_session, project, section="impression", files=[upload("plate.3mf", buffer.getvalue())])
    await db_session.commit()
    assert len(list(thumbs.iterdir())) == 1, "the 3MF upload should have produced a thumbnail"
    section_dir = tmp_path / project.storage_dir / project_storage.SECTION_DIRS["impression"]
    return project, item, rev, thumbs, section_dir


_ROW_COLUMNS = (
    "project_id",
    "revision_id",
    "folder_id",
    "is_external",
    "variant_group_id",
    "variant_position",
    "filename",
    "file_path",
    "file_type",
    "file_size",
    "file_hash",
    "thumbnail_path",
    "file_metadata",
    "created_by_id",
    "notes",
)


def _columns(row: LibraryFile) -> dict:
    return {name: getattr(row, name) for name in _ROW_COLUMNS}


async def _user(db, username: str):
    from backend.app.models.user import User

    user = User(username=username, password_hash="x", is_active=True)
    db.add(user)
    await db.flush()
    return user


def _commit_raises_integrity(db_session, monkeypatch, message: str) -> IntegrityError:
    error = IntegrityError("INSERT", {}, Exception(message))

    async def boom():
        raise error

    monkeypatch.setattr(db_session, "commit", boom)
    return error


async def _revision_rows(db_session, item_id: int) -> tuple[int, int]:
    """(revisions of the item, file rows of those revisions) after the undo's rollback."""
    revisions = (await db_session.execute(select(ProjectRevision.id).where(ProjectRevision.item_id == item_id))).all()
    files = (
        await db_session.execute(
            select(LibraryFile.id)
            .join(ProjectRevision, ProjectRevision.id == LibraryFile.revision_id)
            .where(ProjectRevision.item_id == item_id)
        )
    ).all()
    return len(revisions), len(files)


class _CapturingSession:
    """Records executed statements; every result is empty."""

    def __init__(self):
        self.statements = []

    async def execute(self, statement):
        self.statements.append(statement)
        return self

    def first(self):
        return None

    def scalars(self):
        return self

    def all(self):
        return []


def _sqlite_sql(statement) -> str:
    from sqlalchemy.dialects import sqlite

    return str(statement.compile(dialect=sqlite.dialect(), compile_kwargs={"literal_binds": True}))


# The usage columns, in _USAGE_COLUMNS order, as (table, column).
_USAGE_SQL_COLUMNS = (
    ("print_queue", "library_file_id"),
    ("print_archives", "library_file_id"),
    ("print_batches", "library_file_id"),
    ("print_queue_variants", "library_file_id"),
    ("pipeline_runs", "source_library_file_id"),
    ("pipeline_runs", "sliced_library_file_id"),
)


def _usage_branches(in_clause: str) -> list[str]:
    return [
        f"SELECT {table}.{column} AS file_id \nFROM {table} \nWHERE {table}.{column} IN {in_clause}"
        for table, column in _USAGE_SQL_COLUMNS
    ]


def _name_check_passes(monkeypatch) -> None:
    """``_require_item_name_free`` finds nothing, as when a concurrent create commits right after it."""

    async def free(*_args, **_kwargs):
        return None

    monkeypatch.setattr(project_files, "_require_item_name_free", free)


def _commit_and_rollback_fail(db_session, monkeypatch) -> tuple[RuntimeError, list[str]]:
    """The commit fails, then the undo's rollback fails too (a dropped connection); returns the
    commit's error and the rollbacks attempted. ``monkeypatch.undo()`` puts the real ones back."""
    commit_error, rollbacks = RuntimeError("db down"), []

    async def commit():
        raise commit_error

    async def rollback():
        rollbacks.append("rollback")
        raise ConnectionError("connection lost")

    monkeypatch.setattr(db_session, "commit", commit)
    monkeypatch.setattr(db_session, "rollback", rollback)
    return commit_error, rollbacks
