"""Project files: sections → items → revisions (spec §1.3–§1.5, §2).

Files are normal ``library_files`` rows (so thumbnails, 3D preview and later
printing reuse the library) whose bytes live in the projects space under
``{storage_dir}/{Section}/{Item}/R{n}/``. Filesystem and database move
together: every function that touches the disk commits its own transaction
and undoes the disk change when the commit fails.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from fastapi import UploadFile
from sqlalchemy import exists, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.library import (
    IMAGE_EXTENSIONS,
    _clean_3mf_metadata,
    _stl_render_lock,
    _stream_upload_to_path,
    _without_print_name,
    classify_file_type,
    create_image_thumbnail,
    extract_gcode_thumbnail,
    get_library_thumbnails_dir,
    to_relative_path,
)
from backend.app.core.config import settings
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.project import Project
from backend.app.models.project_item import REVISION_STATUSES, SECTIONS, ProjectItem, ProjectRevision
from backend.app.schemas.project_files import DuplicateWarning
from backend.app.services.pdf_thumbnail import generate_pdf_thumbnail
from backend.app.services.project_snapshot import PrintSnapshot, is_3mf, read_print_snapshot
from backend.app.services.project_storage import revision_dir, sanitize_component, unique_file_path
from backend.app.services.stl_thumbnail import MIN_USABLE_STL_BYTES, generate_stl_thumbnail
from backend.app.utils.safe_path import safe_join_under

logger = logging.getLogger(__name__)

# Meshes above this get a type icon instead of a rendered thumbnail (spec §2.3).
STL_THUMBNAIL_MAX_BYTES = 200 * 1024 * 1024


class ProjectFilesError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _name_key(name: str) -> str:
    return name.strip().lower()


async def get_item_for_project(db: AsyncSession, item_id: int) -> tuple[ProjectItem, Project]:
    row = (
        await db.execute(
            select(ProjectItem, Project)
            .join(Project, Project.id == ProjectItem.project_id)
            .where(ProjectItem.id == item_id)
        )
    ).first()
    if row is None:
        raise ProjectFilesError(404, "Item not found")
    return row[0], row[1]


async def get_revision_bundle(db: AsyncSession, revision_id: int) -> tuple[ProjectRevision, ProjectItem, Project]:
    row = (
        await db.execute(
            select(ProjectRevision, ProjectItem, Project)
            .join(ProjectItem, ProjectItem.id == ProjectRevision.item_id)
            .join(Project, Project.id == ProjectItem.project_id)
            .where(ProjectRevision.id == revision_id)
        )
    ).first()
    if row is None:
        raise ProjectFilesError(404, "Revision not found")
    return row[0], row[1], row[2]


async def create_item(
    db: AsyncSession, project: Project, *, section: str, name: str, user_id: int | None
) -> ProjectItem:
    if section not in SECTIONS:
        raise ProjectFilesError(400, f"Unknown section: {section}")
    clean = name.strip()[:255]
    if not clean or sanitize_component(clean, fallback="") == "":
        raise ProjectFilesError(400, "Item name must not be blank")
    key = _name_key(clean)
    taken = (
        await db.execute(
            select(ProjectItem.id).where(
                ProjectItem.project_id == project.id, ProjectItem.section == section, ProjectItem.name_key == key
            )
        )
    ).first()
    if taken:
        raise ProjectFilesError(409, "An item with this name already exists in this section")
    item = ProjectItem(project_id=project.id, section=section, name=clean, name_key=key, created_by_id=user_id)
    db.add(item)
    await db.flush()
    return item


@dataclass
class _WrittenFile:
    path: Path
    size: int
    digest: str
    thumbnail_rel: str | None = None
    thumbnail_abs: Path | None = None
    metadata: dict | None = None
    snapshot: PrintSnapshot | None = None


def _write_thumbnail(thumbnails_dir: Path, name: str, data: bytes) -> Path:
    thumb_path = safe_join_under(thumbnails_dir, name, http=False)
    thumb_path.write_bytes(data)
    return thumb_path


async def _make_thumbnail(path: Path) -> tuple[Path | None, dict | None]:
    """Thumbnail (absolute path) and 3MF metadata, the way the library upload makes them."""
    thumbnails_dir = get_library_thumbnails_dir()
    lower = path.name.lower()
    thumb: Path | None = None
    metadata: dict | None = None
    try:
        if lower.endswith(".3mf"):
            from backend.app.services.archive import ThreeMFParser

            raw = await asyncio.to_thread(lambda: ThreeMFParser(str(path)).parse())
            data = raw.get("_thumbnail_data")
            if data:
                thumb = await asyncio.to_thread(
                    _write_thumbnail, thumbnails_dir, f"{uuid.uuid4().hex}{raw.get('_thumbnail_ext', '.png')}", data
                )
            metadata = _without_print_name(_clean_3mf_metadata(raw))
        elif lower.endswith(".gcode"):
            data = await asyncio.to_thread(extract_gcode_thumbnail, path)
            if data:
                thumb = await asyncio.to_thread(_write_thumbnail, thumbnails_dir, f"{uuid.uuid4().hex}.png", data)
        elif path.suffix.lower() in IMAGE_EXTENSIONS:
            made = await asyncio.to_thread(create_image_thumbnail, path, thumbnails_dir)
            thumb = Path(made) if made else None
        elif lower.endswith(".pdf"):
            made = await asyncio.to_thread(generate_pdf_thumbnail, path, thumbnails_dir)
            thumb = Path(made) if made else None
        elif lower.endswith(".stl") and MIN_USABLE_STL_BYTES <= path.stat().st_size <= STL_THUMBNAIL_MAX_BYTES:
            async with _stl_render_lock:
                made = await asyncio.to_thread(generate_stl_thumbnail, path, thumbnails_dir)
            thumb = Path(made) if made else None
    except Exception:  # a thumbnail is a nicety; never fail the upload for it
        logger.warning("Thumbnail generation failed for %s", path.name, exc_info=True)
    return thumb, metadata


def _cleanup_written(written: list[_WrittenFile]) -> None:
    for item in written:
        item.path.unlink(missing_ok=True)
        if item.thumbnail_abs is not None:
            item.thumbnail_abs.unlink(missing_ok=True)


async def _stream_files(folder: Path, uploads: list[UploadFile]) -> list[_WrittenFile]:
    """Stream every upload into ``folder``, make thumbnails and read the 3MF snapshot.

    Touches no database. On any failure everything written by THIS call (files,
    ``.part`` files, thumbnails) is removed before the exception propagates."""
    written: list[_WrittenFile] = []
    part: Path | None = None
    try:
        for upload in uploads:
            dest = unique_file_path(folder, upload.filename or "fichier")
            part = safe_join_under(folder, f"{dest.name}.part", http=False)
            size, digest = await _stream_upload_to_path(upload, part, settings.library_max_upload_bytes)
            part.rename(dest)
            part = None
            entry = _WrittenFile(path=dest, size=size, digest=digest)
            written.append(entry)
            thumb, entry.metadata = await _make_thumbnail(dest)
            if thumb is not None:
                entry.thumbnail_abs = thumb
                entry.thumbnail_rel = to_relative_path(thumb)
            if is_3mf(dest.name):
                entry.snapshot = await asyncio.to_thread(read_print_snapshot, dest)
    except BaseException:
        if part is not None:
            part.unlink(missing_ok=True)
        _cleanup_written(written)
        raise
    return written


async def _add_file_rows(
    db: AsyncSession, project: Project, revision: ProjectRevision, written: list[_WrittenFile], user_id: int | None
) -> list[LibraryFile]:
    """Library rows for ``written`` (flushed); the first 3MF snapshot fills a revision that has none."""
    rows: list[LibraryFile] = []
    for entry in written:
        file_type = (await asyncio.to_thread(classify_file_type, entry.path.name, entry.path))[:10]
        row = LibraryFile(
            project_id=project.id,
            revision_id=revision.id,
            folder_id=None,
            is_external=False,
            filename=entry.path.name,
            file_path=to_relative_path(entry.path),
            file_type=file_type,
            file_size=entry.size,
            file_hash=entry.digest,
            thumbnail_path=entry.thumbnail_rel,
            file_metadata=entry.metadata,
            created_by_id=user_id,
        )
        db.add(row)
        rows.append(row)
        snap = entry.snapshot
        if snap is not None and revision.config_snapshot is None and revision.print_profile is None:
            revision.config_snapshot = snap.config
            revision.config_hash = snap.config_hash
            revision.slicer_name = snap.slicer_name
            revision.slicer_version = snap.slicer_version
            revision.print_profile = snap.print_profile
    await db.flush()
    return rows


async def _duplicate_warnings(db: AsyncSession, item: ProjectItem, revision: ProjectRevision, rows: list[LibraryFile]):
    hashes = {row.file_hash for row in rows if row.file_hash}
    if not hashes:
        return []
    matches = (
        await db.execute(
            select(LibraryFile.file_hash, ProjectRevision.number)
            .join(ProjectRevision, ProjectRevision.id == LibraryFile.revision_id)
            .where(
                ProjectRevision.item_id == item.id,
                ProjectRevision.id != revision.id,
                LibraryFile.file_hash.in_(hashes),
            )
            .order_by(ProjectRevision.number)
        )
    ).all()
    first_seen: dict[str, int] = {}
    for digest, number in matches:
        first_seen.setdefault(digest, number)
    return [
        DuplicateWarning(filename=row.filename, same_as=f"R{first_seen[row.file_hash]}")
        for row in rows
        if row.file_hash in first_seen
    ]


async def _check_derived_from(db: AsyncSession, project: Project, revision_id: int | None, target_id: int) -> None:
    """Target must be another revision of the same project and must not lead back to ``revision_id``."""
    if revision_id is not None and target_id == revision_id:
        raise ProjectFilesError(400, "A revision cannot derive from itself")
    row = (
        await db.execute(
            select(ProjectRevision.id, ProjectItem.project_id)
            .join(ProjectItem, ProjectItem.id == ProjectRevision.item_id)
            .where(ProjectRevision.id == target_id)
        )
    ).first()
    if row is None or row.project_id != project.id:
        raise ProjectFilesError(400, "Derived-from revision must belong to the same project")
    if revision_id is None:
        return
    seen: set[int] = set()
    current: int | None = target_id
    while current is not None and current not in seen:
        if current == revision_id:
            raise ProjectFilesError(400, "This link would create a cycle")
        seen.add(current)
        current = (
            await db.execute(select(ProjectRevision.derived_from_id).where(ProjectRevision.id == current))
        ).scalar_one_or_none()


async def add_revision(
    db: AsyncSession,
    project: Project,
    item: ProjectItem,
    uploads: list[UploadFile],
    *,
    note: str | None,
    derived_from_id: int | None,
    user_id: int | None,
) -> tuple[ProjectRevision, list[DuplicateWarning]]:
    """New R{n} for ``item`` from ``uploads`` (≥ 1). Commits.

    Files are streamed before any row is written so the database write lock is
    held only for the final flush and commit. On failure the caller's WHOLE
    session is rolled back and its instances expire, so commit prior work
    (e.g. ``create_item``) first."""
    if not uploads:
        raise ProjectFilesError(400, "A revision needs at least one file")
    if derived_from_id is not None:
        await _check_derived_from(db, project, None, derived_from_id)
    number = item.last_revision_number + 1
    folder = revision_dir(project, item.section, item.name, number)
    created_folder = not any(folder.iterdir())
    written: list[_WrittenFile] = []
    try:
        written = await _stream_files(folder, uploads)
        revision = ProjectRevision(
            item_id=item.id,
            number=number,
            status="wip",
            note=(note or "").strip() or None,
            derived_from_id=derived_from_id,
            created_by_id=user_id,
        )
        db.add(revision)
        item.last_revision_number = number
        await db.flush()
        rows = await _add_file_rows(db, project, revision, written, user_id)
        warnings = await _duplicate_warnings(db, item, revision, rows)
        await db.commit()
    except BaseException as exc:
        await db.rollback()
        _cleanup_written(written)
        if created_folder:
            try:
                folder.rmdir()
            except OSError:
                pass
        if isinstance(exc, IntegrityError) and (
            "uq_project_revisions_item_number" in str(exc) or "project_revisions.number" in str(exc)
        ):
            raise ProjectFilesError(409, "Another upload just created this revision number; try again") from exc
        raise
    return revision, warnings


async def revision_is_used(db: AsyncSession, revision_id: int) -> bool:
    """Printed (queue or archive references one of its files). Phases 3/4 add deliveries."""
    file_ids = select(LibraryFile.id).where(LibraryFile.revision_id == revision_id)
    return bool(
        (
            await db.execute(
                select(
                    or_(
                        exists().where(PrintQueueItem.library_file_id.in_(file_ids)),
                        exists().where(PrintArchive.library_file_id.in_(file_ids)),
                    )
                )
            )
        ).scalar()
    )


async def update_revision(
    db: AsyncSession, project: Project, revision: ProjectRevision, *, fields: dict, user_id: int | None
) -> ProjectRevision:
    if "status" in fields:
        status = fields["status"]
        if status not in REVISION_STATUSES:
            raise ProjectFilesError(400, f"Unknown status: {status}")
        if status != revision.status:
            revision.status = status
            revision.status_changed_by_id = user_id
            revision.status_changed_at = _now()
    if "note" in fields:
        revision.note = (fields["note"] or "").strip() or None
    if "derived_from_id" in fields:
        target = fields["derived_from_id"]
        if target is not None:
            await _check_derived_from(db, project, revision.id, target)
        revision.derived_from_id = target
    await db.flush()
    return revision
