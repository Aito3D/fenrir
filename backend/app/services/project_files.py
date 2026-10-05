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
from datetime import datetime, timezone
from pathlib import Path

from fastapi import UploadFile
from sqlalchemy import exists, or_, select
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
from backend.app.services.project_snapshot import is_3mf, read_print_snapshot
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


async def _make_thumbnail(path: Path) -> tuple[str | None, dict | None]:
    """Thumbnail (relative path) and 3MF metadata, the way the library upload makes them."""
    thumbnails_dir = get_library_thumbnails_dir()
    lower = path.name.lower()
    thumb: str | None = None
    metadata: dict | None = None
    try:
        if lower.endswith(".3mf"):
            from backend.app.services.archive import ThreeMFParser

            raw = ThreeMFParser(str(path)).parse()
            data = raw.get("_thumbnail_data")
            if data:
                thumb_path = safe_join_under(
                    thumbnails_dir, f"{uuid.uuid4().hex}{raw.get('_thumbnail_ext', '.png')}", http=False
                )
                thumb_path.write_bytes(data)
                thumb = str(thumb_path)
            metadata = _without_print_name(_clean_3mf_metadata(raw))
        elif lower.endswith(".gcode"):
            data = extract_gcode_thumbnail(path)
            if data:
                thumb_path = safe_join_under(thumbnails_dir, f"{uuid.uuid4().hex}.png", http=False)
                thumb_path.write_bytes(data)
                thumb = str(thumb_path)
        elif path.suffix.lower() in IMAGE_EXTENSIONS:
            thumb = create_image_thumbnail(path, thumbnails_dir)
        elif lower.endswith(".pdf"):
            thumb = await asyncio.to_thread(generate_pdf_thumbnail, path, thumbnails_dir)
        elif lower.endswith(".stl") and MIN_USABLE_STL_BYTES <= path.stat().st_size <= STL_THUMBNAIL_MAX_BYTES:
            async with _stl_render_lock:
                thumb = await asyncio.to_thread(generate_stl_thumbnail, path, thumbnails_dir)
    except Exception:  # a thumbnail is a nicety; never fail the upload for it
        logger.warning("Thumbnail generation failed for %s", path.name, exc_info=True)
    return (to_relative_path(thumb) if thumb else None), metadata


async def _write_files(
    db: AsyncSession,
    project: Project,
    revision: ProjectRevision,
    folder: Path,
    uploads: list[UploadFile],
    user_id: int | None,
) -> list[LibraryFile]:
    """Stream every upload into ``folder`` and create its rows. On any failure the
    files written by THIS call are removed before the exception propagates."""
    written: list[Path] = []
    rows: list[LibraryFile] = []
    try:
        for upload in uploads:
            dest = unique_file_path(folder, upload.filename or "fichier")
            part = safe_join_under(folder, f"{dest.name}.part", http=False)
            written.append(part)
            size, digest = await _stream_upload_to_path(upload, part, settings.library_max_upload_bytes)
            part.rename(dest)
            written[-1] = dest
            thumb, metadata = await _make_thumbnail(dest)
            row = LibraryFile(
                project_id=project.id,
                revision_id=revision.id,
                folder_id=None,
                is_external=False,
                filename=dest.name,
                file_path=to_relative_path(dest),
                file_type=classify_file_type(dest.name, dest)[:10],
                file_size=size,
                file_hash=digest,
                thumbnail_path=thumb,
                file_metadata=metadata,
                created_by_id=user_id,
            )
            db.add(row)
            rows.append(row)
            if revision.config_snapshot is None and revision.print_profile is None and is_3mf(dest.name):
                snapshot = await asyncio.to_thread(read_print_snapshot, dest)
                if snapshot is not None:
                    revision.config_snapshot = snapshot.config
                    revision.config_hash = snapshot.config_hash
                    revision.slicer_name = snapshot.slicer_name
                    revision.slicer_version = snapshot.slicer_version
                    revision.print_profile = snapshot.print_profile
        await db.flush()
    except BaseException:
        for path in written:
            path.unlink(missing_ok=True)
        raise
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
    """New R{n} for ``item`` from ``uploads`` (≥ 1). Commits."""
    if not uploads:
        raise ProjectFilesError(400, "A revision needs at least one file")
    if derived_from_id is not None:
        await _check_derived_from(db, project, None, derived_from_id)
    number = item.last_revision_number + 1
    folder = revision_dir(project, item.section, item.name, number)
    created_folder = not any(folder.iterdir())
    revision = ProjectRevision(
        item_id=item.id,
        number=number,
        status="wip",
        note=(note or None),
        derived_from_id=derived_from_id,
        created_by_id=user_id,
    )
    try:
        db.add(revision)
        item.last_revision_number = number
        await db.flush()
        rows = await _write_files(db, project, revision, folder, uploads, user_id)
        warnings = await _duplicate_warnings(db, item, revision, rows)
        await db.commit()
    except BaseException:
        await db.rollback()
        if created_folder:
            try:
                folder.rmdir()
            except OSError:
                pass
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
