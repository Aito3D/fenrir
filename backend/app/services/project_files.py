"""Project files: sections → items → revisions (spec §1.3–§1.5, §2).

Files are normal ``library_files`` rows (so thumbnails, 3D preview and later
printing reuse the library) whose bytes live in the projects space under
``{storage_dir}/{Section}/{Item}/R{n}/``. Filesystem and database move
together: every function that touches the disk commits its own transaction
and undoes the disk change when the commit fails.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import shutil
import uuid
import weakref
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from fastapi import UploadFile
from sqlalchemy import Select, delete, select, union, update
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
from backend.app.models.aito_task_delivery import AitoTaskDelivery
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile, LibraryFileTag
from backend.app.models.pipeline_run import PipelineRun
from backend.app.models.print_batch import PrintBatch
from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant
from backend.app.models.project import Project
from backend.app.models.project_item import REVISION_STATUSES, SECTIONS, ProjectItem, ProjectRevision
from backend.app.models.user import User
from backend.app.schemas.project_files import (
    DuplicateWarning,
    ProjectFileOut,
    ProjectItemOut,
    ProjectRevisionOut,
    ProjectSectionOut,
    ProjectTreeResponse,
    RevisionRef,
)
from backend.app.services.pdf_thumbnail import generate_pdf_thumbnail
from backend.app.services.project_print_trace import revision_print_counts
from backend.app.services.project_snapshot import PrintSnapshot, is_3mf, read_print_snapshot
from backend.app.services.project_storage import (
    ENABLED_SECTIONS,
    claim_unique_file_path,
    is_printable_filename,
    item_dir,
    move_to_trash,
    revision_dir,
    sanitize_component,
)
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


# One lock per item, held across every operation that writes into or moves the
# item's folder (uploads hold it from the first streamed byte to the commit), so
# a rename, delete or fork never runs under a half-written upload. The app runs
# in a single process; entries vanish once no coroutine holds or awaits them.
_item_locks: weakref.WeakValueDictionary[int, asyncio.Lock] = weakref.WeakValueDictionary()


def _item_lock(item_id: int) -> asyncio.Lock:
    lock = _item_locks.get(item_id)
    if lock is None:
        lock = asyncio.Lock()
        _item_locks[item_id] = lock
    return lock


async def _fresh_item(db: AsyncSession, item_id: int) -> ProjectItem:
    """The item as committed now (the caller's copy may predate a rename made while it waited for the lock)."""
    item = (
        await db.execute(select(ProjectItem).where(ProjectItem.id == item_id).execution_options(populate_existing=True))
    ).scalar_one_or_none()
    if item is None:
        raise ProjectFilesError(404, "Item not found")
    return item


async def _fresh_revision(db: AsyncSession, revision_id: int, item_id: int) -> ProjectRevision:
    revision = (
        await db.execute(
            select(ProjectRevision)
            .where(ProjectRevision.id == revision_id, ProjectRevision.item_id == item_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if revision is None:
        raise ProjectFilesError(404, "Revision not found")
    return revision


async def _require_item_unchanged(db: AsyncSession, item_id: int, section: str, name: str) -> None:
    """Right before an upload's DB step: the folder it streamed into must still be the item's."""
    row = (await db.execute(select(ProjectItem.section, ProjectItem.name).where(ProjectItem.id == item_id))).first()
    if row is None or (row.section, row.name) != (section, name):
        raise ProjectFilesError(409, "This item was renamed or deleted during the upload; try again")


def _name_key(name: str) -> str:
    """Uniqueness key = what the folder name will be (NFC, forbidden chars and dots stripped), case-folded."""
    return sanitize_component(name.strip(), fallback="").casefold()


def _clean_item_name(name: str) -> tuple[str, str]:
    clean = name.strip()[:255]
    key = _name_key(clean)
    if not key:
        raise ProjectFilesError(400, "Item name must not be blank")
    return clean, key


async def _require_item_name_free(
    db: AsyncSession, project: Project, section: str, key: str, exclude_id: int | None = None
) -> None:
    query = select(ProjectItem.id).where(
        ProjectItem.project_id == project.id, ProjectItem.section == section, ProjectItem.name_key == key
    )
    if exclude_id is not None:
        query = query.where(ProjectItem.id != exclude_id)
    if (await db.execute(query)).first():
        raise ProjectFilesError(409, "An item with this name already exists in this section")


def require_enabled_section(section: str) -> None:
    """400 unless ``section`` takes new items/files today (``ENABLED_SECTIONS``).
    Items already in a disabled section keep working (rename, delete, fork…)."""
    if section not in ENABLED_SECTIONS:
        raise ProjectFilesError(400, f"Section {section!r} does not accept files for now")


def _upload_name(upload: UploadFile) -> str:
    return (upload.filename or "").replace("\\", "/").rsplit("/", 1)[-1]


def require_printable_uploads(uploads: list[UploadFile]) -> None:
    """400 naming every non-printable upload (the whole request is refused, nothing written)."""
    rejected = [_upload_name(upload) for upload in uploads if not is_printable_filename(_upload_name(upload))]
    if rejected:
        raise ProjectFilesError(
            400, "Projects only accept printing files (.3mf, .gcode, .bgcode); refused: " + ", ".join(rejected)
        )


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
    clean, key = _clean_item_name(name)
    await _require_item_name_free(db, project, section, key)
    item = ProjectItem(project_id=project.id, section=section, name=clean, name_key=key, created_by_id=user_id)
    db.add(item)
    await db.flush()
    return item


@dataclass
class RevisionSource:
    """A file on disk to copy into a new revision (``add_revision_from_sources``).

    ``reuse_row`` is a managed library row to re-point at the copy (it keeps its
    id, so queue items, archives and photos follow); ``None`` makes a new row.
    ``row`` is filled in with the stored row once the revision is committed."""

    path: Path
    filename: str
    reuse_row: LibraryFile | None = None
    row: LibraryFile | None = field(default=None, init=False, compare=False, repr=False)


@dataclass
class _WrittenFile:
    path: Path
    size: int
    digest: str
    thumbnail_rel: str | None = None
    thumbnail_abs: Path | None = None
    metadata: dict | None = None
    snapshot: PrintSnapshot | None = None
    source: RevisionSource | None = None
    # file_path the reused row had when its copy started; the DB step refuses a row that moved meanwhile
    reuse_file_path: str | None = None


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

    Touches no database. Each upload streams to its own ``.{uuid}.part`` and the
    final name is claimed atomically, so overlapping uploads of one filename
    never share a file. On any failure everything written by THIS call (files,
    ``.part`` files, thumbnails) is removed before the exception propagates."""
    written: list[_WrittenFile] = []
    part: Path | None = None
    try:
        for upload in uploads:
            part = safe_join_under(folder, f".{uuid.uuid4().hex}.part", http=False)
            size, digest = await _stream_upload_to_path(upload, part, settings.library_max_upload_bytes)
            dest = claim_unique_file_path(folder, upload.filename or "fichier")
            try:
                os.replace(part, dest)
            except BaseException:
                dest.unlink(missing_ok=True)
                raise
            part = None
            entry = _WrittenFile(path=dest, size=size, digest=digest)
            written.append(entry)
            await _post_process(entry)
    except BaseException:
        if part is not None:
            part.unlink(missing_ok=True)
        _cleanup_written(written)
        raise
    return written


async def _post_process(entry: _WrittenFile, *, thumbnail: bool = True) -> None:
    """Thumbnail + 3MF metadata (unless ``thumbnail`` is False) and the 3MF print snapshot of a stored file."""
    if thumbnail:
        thumb, entry.metadata = await _make_thumbnail(entry.path)
        if thumb is not None:
            entry.thumbnail_abs = thumb
            entry.thumbnail_rel = to_relative_path(thumb)
    if is_3mf(entry.path.name):
        entry.snapshot = await asyncio.to_thread(read_print_snapshot, entry.path)


def _copy_hashing(src: Path, dest: Path) -> tuple[int, str]:
    """Copy ``src`` over ``dest`` in bounded chunks; returns (size, SHA-256 hex) of what was written."""
    digest = hashlib.sha256()
    size = 0
    with open(src, "rb") as reader, open(dest, "wb") as writer:
        while chunk := reader.read(1 << 20):
            writer.write(chunk)
            digest.update(chunk)
            size += len(chunk)
    try:
        shutil.copystat(src, dest)
    except OSError:
        pass  # timestamps are a nicety
    return size, digest.hexdigest()


async def _copy_sources(folder: Path, sources: list[RevisionSource]) -> list[_WrittenFile]:
    """Copy every source into ``folder`` (hashing while copying) and post-process it like an upload.

    Touches no database. A reused row that already has a thumbnail keeps it
    (and its metadata) instead of getting a second one. On any failure every
    copy and thumbnail made by THIS call is removed; the sources are never touched."""
    written: list[_WrittenFile] = []
    try:
        for source in sources:
            reuse = source.reuse_row
            dest = claim_unique_file_path(folder, source.filename)
            entry = _WrittenFile(
                path=dest,
                size=0,
                digest="",
                source=source,
                reuse_file_path=reuse.file_path if reuse is not None else None,
            )
            written.append(entry)  # before the copy, so cleanup also removes the claimed placeholder
            entry.size, entry.digest = await asyncio.to_thread(_copy_hashing, source.path, dest)
            await _post_process(entry, thumbnail=reuse is None or not reuse.thumbnail_path)
    except BaseException:
        _cleanup_written(written)
        raise
    return written


async def _require_reuse_rows_unchanged(db: AsyncSession, written: list[_WrittenFile]) -> None:
    """Each reused row must still be the live, unfiled file whose bytes were copied."""
    expected = {
        entry.source.reuse_row.id: entry.reuse_file_path
        for entry in written
        if entry.source is not None and entry.source.reuse_row is not None
    }
    if not expected:
        return
    current = {
        row.id: row
        for row in (
            await db.execute(
                select(LibraryFile.id, LibraryFile.file_path, LibraryFile.revision_id, LibraryFile.deleted_at).where(
                    LibraryFile.id.in_(expected)
                )
            )
        ).all()
    }
    for file_id, file_path in expected.items():
        row = current.get(file_id)
        if row is None or row.file_path != file_path or row.revision_id is not None or row.deleted_at is not None:
            raise ProjectFilesError(409, "A file changed while it was being moved; try again")


async def _add_file_rows(
    db: AsyncSession, project: Project, revision: ProjectRevision, written: list[_WrittenFile], user_id: int | None
) -> list[LibraryFile]:
    """Library rows for ``written`` (flushed); the first 3MF snapshot fills a revision that has none.

    An entry whose source carries a ``reuse_row`` re-points that row at the copy
    (same id; out of its File Manager folder and variant group) instead of
    adding a new one."""
    await _require_reuse_rows_unchanged(db, written)
    rows: list[LibraryFile] = []
    for entry in written:
        file_type = (await asyncio.to_thread(classify_file_type, entry.path.name, entry.path))[:10]
        reuse = entry.source.reuse_row if entry.source is not None else None
        if reuse is None:
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
        else:
            row = reuse
            row.project_id = project.id
            row.revision_id = revision.id
            row.folder_id = None
            row.is_external = False
            row.variant_group_id = None
            row.variant_position = 0
            row.filename = entry.path.name
            row.file_path = to_relative_path(entry.path)
            row.file_type = file_type
            row.file_size = entry.size
            row.file_hash = entry.digest
            if entry.thumbnail_rel is not None:
                row.thumbnail_path = entry.thumbnail_rel
            if entry.metadata is not None:
                row.file_metadata = entry.metadata
        if entry.source is not None:
            entry.source.row = row
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
    async with _item_lock(item.id):
        return await _add_revision_locked(
            db,
            project,
            await _fresh_item(db, item.id),
            lambda folder: _stream_files(folder, uploads),
            note,
            derived_from_id,
            user_id,
        )


async def add_revision_from_sources(
    db: AsyncSession,
    project: Project,
    item: ProjectItem,
    sources: list[RevisionSource],
    *,
    note: str | None,
    user_id: int | None,
) -> ProjectRevision:
    """New R{n} for ``item`` from files already on disk (≥ 1). Commits.

    Each source is copied into the revision folder (size and SHA-256 computed
    while copying) and post-processed like an upload before any row is written;
    then one short DB step creates the revision and updates each ``reuse_row``
    or adds a new row. The sources themselves are never modified or removed —
    unlinking a moved file's old bytes after the commit is the caller's job. On
    failure the copies are deleted and the caller's WHOLE session is rolled back
    (see ``add_revision``). Each source's ``row`` is set on success."""
    if not sources:
        raise ProjectFilesError(400, "A revision needs at least one file")
    async with _item_lock(item.id):
        revision, _warnings = await _add_revision_locked(
            db,
            project,
            await _fresh_item(db, item.id),
            lambda folder: _copy_sources(folder, sources),
            note,
            None,
            user_id,
        )
        return revision


async def _add_revision_locked(
    db: AsyncSession,
    project: Project,
    item: ProjectItem,
    write: Callable[[Path], Awaitable[list[_WrittenFile]]],
    note: str | None,
    derived_from_id: int | None,
    user_id: int | None,
) -> tuple[ProjectRevision, list[DuplicateWarning]]:
    if derived_from_id is not None:
        await _check_derived_from(db, project, None, derived_from_id)
    item_id, section, name = item.id, item.section, item.name
    number = item.last_revision_number + 1
    folder = revision_dir(project, section, name, number)
    created_folder = not any(folder.iterdir())
    written: list[_WrittenFile] = []
    try:
        written = await write(folder)
        await _require_item_unchanged(db, item_id, section, name)
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


# Every reference that makes a file "used" (printed, queued, batched, sliced).
# Files of delivered revisions (aito_task_deliveries) count too, see used_file_ids.
_USAGE_COLUMNS = (
    PrintQueueItem.library_file_id,
    PrintArchive.library_file_id,
    PrintBatch.library_file_id,
    PrintQueueVariant.library_file_id,
    PipelineRun.source_library_file_id,
    PipelineRun.sliced_library_file_id,
)


async def used_file_ids(db: AsyncSession, file_ids: Select) -> set[int]:
    """Which of ``file_ids`` (a select of library file ids) are used, in one query."""
    delivered = select(LibraryFile.id.label("file_id")).where(
        LibraryFile.id.in_(file_ids), LibraryFile.revision_id.in_(select(AitoTaskDelivery.revision_id))
    )
    query = union(
        *(select(column.label("file_id")).where(column.in_(file_ids)) for column in _USAGE_COLUMNS), delivered
    )
    return set((await db.execute(query)).scalars().all())


async def revision_is_used(db: AsyncSession, revision_id: int) -> bool:
    """A file of the revision is used (see ``_USAGE_COLUMNS``)."""
    return bool(await used_file_ids(db, select(LibraryFile.id).where(LibraryFile.revision_id == revision_id)))


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


async def _revision_files(db: AsyncSession, revision_id: int) -> list[LibraryFile]:
    return list(
        (await db.execute(select(LibraryFile).where(LibraryFile.revision_id == revision_id).order_by(LibraryFile.id)))
        .scalars()
        .all()
    )


async def _require_editable_files(db: AsyncSession, revision: ProjectRevision) -> None:
    if revision.status != "wip":
        raise ProjectFilesError(409, "Only an in-progress revision can change its files")
    if await revision_is_used(db, revision.id):
        raise ProjectFilesError(409, "This revision was printed or delivered; make a new revision instead")


async def add_files_to_revision(
    db: AsyncSession,
    project: Project,
    item: ProjectItem,
    revision: ProjectRevision,
    uploads: list[UploadFile],
    user_id: int | None,
) -> list[DuplicateWarning]:
    if not uploads:
        raise ProjectFilesError(400, "No file")
    async with _item_lock(item.id):
        item = await _fresh_item(db, item.id)
        revision = await _fresh_revision(db, revision.id, item.id)
        await _require_editable_files(db, revision)
        item_id, section, name = item.id, item.section, item.name
        folder = revision_dir(project, section, name, revision.number)
        written: list[_WrittenFile] = []
        try:
            written = await _stream_files(folder, uploads)
            await _require_item_unchanged(db, item_id, section, name)
            # the revision may have been validated or used while streaming
            await _require_editable_files(db, await _fresh_revision(db, revision.id, item_id))
            rows = await _add_file_rows(db, project, revision, written, user_id)
            warnings = await _duplicate_warnings(db, item, revision, rows)
            await db.commit()
        except BaseException:
            await db.rollback()
            _cleanup_written(written)
            raise
        return warnings


async def _delete_file_rows(
    db: AsyncSession, *, file_ids: list[int] | None = None, revision_ids: list[int] | None = None
):
    """Delete library rows (and their tag links: SQLite runs without FK enforcement)."""
    if file_ids is None:
        file_ids = list(
            (await db.execute(select(LibraryFile.id).where(LibraryFile.revision_id.in_(revision_ids or []))))
            .scalars()
            .all()
        )
    if not file_ids:
        return
    await db.execute(delete(LibraryFileTag).where(LibraryFileTag.file_id.in_(file_ids)))
    await db.execute(delete(LibraryFile).where(LibraryFile.id.in_(file_ids)))


async def _restore_and_rollback(db: AsyncSession, moved: Path | None, original: Path | None) -> None:
    if moved is not None and original is not None:
        shutil.move(str(moved), str(original))
    await db.rollback()


async def remove_file_from_revision(
    db: AsyncSession, project: Project, item: ProjectItem, revision: ProjectRevision, file_id: int
) -> None:
    async with _item_lock(item.id):
        item = await _fresh_item(db, item.id)
        await _remove_file_locked(db, project, item, await _fresh_revision(db, revision.id, item.id), file_id)


async def _remove_file_locked(
    db: AsyncSession, project: Project, item: ProjectItem, revision: ProjectRevision, file_id: int
) -> None:
    await _require_editable_files(db, revision)
    files = await _revision_files(db, revision.id)
    target = next((f for f in files if f.id == file_id), None)
    if target is None:
        raise ProjectFilesError(404, "File not found in this revision")
    if len(files) == 1:
        raise ProjectFilesError(409, "A revision keeps at least one file; delete the revision instead")
    from backend.app.api.routes.library import to_absolute_path

    path = to_absolute_path(target.file_path)
    moved: Path | None = None
    try:
        await _delete_file_rows(db, file_ids=[target.id])
        await db.flush()
        moved = move_to_trash(project, path) if path is not None else None
        await db.commit()
    except BaseException:
        await _restore_and_rollback(db, moved, path)
        raise


async def _clear_links_to(db: AsyncSession, revision_ids: list[int]) -> None:
    await db.execute(
        update(ProjectRevision).where(ProjectRevision.derived_from_id.in_(revision_ids)).values(derived_from_id=None)
    )
    await db.execute(
        update(ProjectItem)
        .where(ProjectItem.forked_from_revision_id.in_(revision_ids))
        .values(forked_from_revision_id=None)
    )


async def delete_revision(db: AsyncSession, project: Project, item: ProjectItem, revision: ProjectRevision) -> None:
    async with _item_lock(item.id):
        item = await _fresh_item(db, item.id)
        await _delete_revision_locked(db, project, item, await _fresh_revision(db, revision.id, item.id))


async def _delete_revision_locked(
    db: AsyncSession, project: Project, item: ProjectItem, revision: ProjectRevision
) -> None:
    if await revision_is_used(db, revision.id):
        raise ProjectFilesError(409, "This revision was printed or delivered and cannot be deleted")
    folder = item_dir(project, item.section, item.name).joinpath(
        f"R{revision.number}"
    )  # SEC-PATH-OK: fixed "R{int}" under a resolved item dir
    moved: Path | None = None
    try:
        await _delete_file_rows(db, revision_ids=[revision.id])
        await _clear_links_to(db, [revision.id])
        await db.delete(revision)
        await db.flush()
        moved = move_to_trash(project, folder)
        await db.commit()
    except BaseException:
        await _restore_and_rollback(db, moved, folder)
        raise


async def _item_revision_ids(db: AsyncSession, item_id: int) -> list[int]:
    return list(
        (await db.execute(select(ProjectRevision.id).where(ProjectRevision.item_id == item_id))).scalars().all()
    )


async def rename_item(db: AsyncSession, project: Project, item: ProjectItem, new_name: str) -> ProjectItem:
    async with _item_lock(item.id):
        return await _rename_item_locked(db, project, await _fresh_item(db, item.id), new_name)


async def _rename_item_locked(db: AsyncSession, project: Project, item: ProjectItem, new_name: str) -> ProjectItem:
    from backend.app.api.routes.library import to_absolute_path

    clean, key = _clean_item_name(new_name)
    if key != item.name_key:
        await _require_item_name_free(db, project, item.section, key, exclude_id=item.id)
    old_dir = item_dir(project, item.section, item.name)
    new_dir = item_dir(project, item.section, clean)
    moved = False
    if old_dir != new_dir and old_dir.exists():
        if new_dir.exists():
            if not os.path.samefile(old_dir, new_dir):
                raise ProjectFilesError(409, "A folder with this name already exists")
            # case-only rename on a case-insensitive filesystem: go through a temporary name
            temp = old_dir.with_name(f".rename-{uuid.uuid4().hex}")
            old_dir.rename(temp)
            temp.rename(new_dir)
        else:
            old_dir.rename(new_dir)
        moved = True
    try:
        if moved:
            files = (
                (
                    await db.execute(
                        select(LibraryFile).where(LibraryFile.revision_id.in_(await _item_revision_ids(db, item.id)))
                    )
                )
                .scalars()
                .all()
            )
            for row in files:
                current = to_absolute_path(row.file_path)
                if current is not None and old_dir in current.parents:
                    row.file_path = to_relative_path(
                        new_dir.joinpath(current.relative_to(old_dir))
                    )  # SEC-PATH-OK: relative part of a path already under old_dir
        item.name = clean
        item.name_key = key
        await db.commit()
    except BaseException:
        if moved:
            new_dir.rename(old_dir)
        await db.rollback()
        raise
    return item


async def delete_item(db: AsyncSession, project: Project, item: ProjectItem) -> None:
    async with _item_lock(item.id):
        await _delete_item_locked(db, project, await _fresh_item(db, item.id))


async def _delete_item_locked(db: AsyncSession, project: Project, item: ProjectItem) -> None:
    revision_ids = await _item_revision_ids(db, item.id)
    for revision_id in revision_ids:
        if await revision_is_used(db, revision_id):
            raise ProjectFilesError(409, "A revision of this item was printed or delivered; the item cannot be deleted")
    folder = item_dir(project, item.section, item.name)
    moved: Path | None = None
    try:
        if revision_ids:
            await _delete_file_rows(db, revision_ids=revision_ids)
            await _clear_links_to(db, revision_ids)
            await db.execute(delete(ProjectRevision).where(ProjectRevision.id.in_(revision_ids)))
        await db.delete(item)
        await db.flush()
        moved = move_to_trash(project, folder)
        await db.commit()
    except BaseException:
        await _restore_and_rollback(db, moved, folder)
        raise


def _copy_thumbnail(source_thumbnail: str | None) -> tuple[str | None, Path | None]:
    """Own copy of a thumbnail (relative path, absolute path), so deleting one file never blanks the other."""
    from backend.app.api.routes.library import to_absolute_path

    src = to_absolute_path(source_thumbnail)
    if src is None or not src.is_file():
        return None, None
    dest = safe_join_under(get_library_thumbnails_dir(), f"{uuid.uuid4().hex}{src.suffix}", http=False)
    shutil.copy2(src, dest)
    return to_relative_path(dest), dest


def _remove_empty(*folders: Path) -> None:
    for folder in folders:
        try:
            folder.rmdir()
        except OSError:
            pass


async def fork_revision(
    db: AsyncSession, project: Project, item: ProjectItem, revision: ProjectRevision, new_name: str, user_id: int | None
) -> ProjectItem:
    """New item in the same section whose R1 is a copy of ``revision`` (spec §2.4).

    Files are copied BEFORE any row is written so the database write lock is
    held only for the final flush and commit. The source item stays locked
    while its files are read."""
    async with _item_lock(item.id):
        item = await _fresh_item(db, item.id)
        revision = await _fresh_revision(db, revision.id, item.id)
        return await _fork_revision_locked(db, project, item, revision, new_name, user_id)


async def _fork_revision_locked(
    db: AsyncSession, project: Project, item: ProjectItem, revision: ProjectRevision, new_name: str, user_id: int | None
) -> ProjectItem:
    from backend.app.api.routes.library import to_absolute_path

    section = item.section
    clean, key = _clean_item_name(new_name)
    await _require_item_name_free(db, project, section, key)
    new_item_dir = item_dir(project, section, clean)
    if new_item_dir.exists():
        raise ProjectFilesError(409, "A folder with this name already exists")
    sources = [
        {
            "filename": f.filename,
            "path": to_absolute_path(f.file_path),
            "file_type": f.file_type,
            "file_size": f.file_size,
            "file_hash": f.file_hash,
            "thumbnail_path": f.thumbnail_path,
            "file_metadata": f.file_metadata,
        }
        for f in await _revision_files(db, revision.id)
    ]
    snapshot = (
        revision.config_snapshot,
        revision.config_hash,
        revision.slicer_name,
        revision.slicer_version,
        revision.print_profile,
    )
    revision_id = revision.id
    folder = revision_dir(project, section, clean, 1)
    copies: list[dict] = []

    def cleanup() -> None:
        for entry in copies:
            entry["dest"].unlink(missing_ok=True)
            if entry["thumb_abs"] is not None:
                entry["thumb_abs"].unlink(missing_ok=True)
        _remove_empty(folder, new_item_dir)

    try:
        for source in sources:
            src = source["path"]
            if src is None or not src.exists():
                continue
            dest = claim_unique_file_path(folder, source["filename"])
            entry = {"source": source, "dest": dest, "thumb_rel": None, "thumb_abs": None}
            copies.append(entry)  # before the copy, so cleanup also removes the claimed placeholder
            await asyncio.to_thread(shutil.copy2, src, dest)
            entry["thumb_rel"], entry["thumb_abs"] = await asyncio.to_thread(_copy_thumbnail, source["thumbnail_path"])
        if not copies:
            raise ProjectFilesError(409, "No file of this revision could be copied")
        forked = ProjectItem(
            project_id=project.id,
            section=section,
            name=clean,
            name_key=key,
            created_by_id=user_id,
            forked_from_revision_id=revision_id,
            last_revision_number=1,
        )
        db.add(forked)
        await db.flush()
        r1 = ProjectRevision(
            item_id=forked.id, number=1, status="wip", derived_from_id=revision_id, created_by_id=user_id
        )
        r1.config_snapshot, r1.config_hash, r1.slicer_name, r1.slicer_version, r1.print_profile = snapshot
        db.add(r1)
        await db.flush()
        for entry in copies:
            source = entry["source"]
            db.add(
                LibraryFile(
                    project_id=project.id,
                    revision_id=r1.id,
                    folder_id=None,
                    is_external=False,
                    filename=entry["dest"].name,
                    file_path=to_relative_path(entry["dest"]),
                    file_type=source["file_type"],
                    file_size=source["file_size"],
                    file_hash=source["file_hash"],
                    thumbnail_path=entry["thumb_rel"],
                    file_metadata=source["file_metadata"],
                    created_by_id=user_id,
                )
            )
        await db.commit()
    except BaseException as exc:
        await db.rollback()
        cleanup()
        if isinstance(exc, IntegrityError):
            raise ProjectFilesError(409, "An item with this name already exists in this section") from exc
        raise
    return forked


def _ref(revision: ProjectRevision, item: ProjectItem) -> RevisionRef:
    return RevisionRef(
        id=revision.id,
        item_id=item.id,
        item_name=item.name,
        section=item.section,
        number=revision.number,
        status=revision.status,
    )


async def load_tree(db: AsyncSession, project: Project) -> ProjectTreeResponse:
    """The whole Fichiers view in one payload: one query per table + grouped usage checks."""
    items = list(
        (
            await db.execute(
                select(ProjectItem)
                .where(ProjectItem.project_id == project.id)
                .order_by(ProjectItem.position, ProjectItem.name_key)
            )
        )
        .scalars()
        .all()
    )
    items_by_id = {item.id: item for item in items}
    revisions = (
        list(
            (await db.execute(select(ProjectRevision).where(ProjectRevision.item_id.in_(items_by_id)))).scalars().all()
        )
        if items_by_id
        else []
    )
    revisions_by_id = {rev.id: rev for rev in revisions}
    files = (
        list(
            (
                await db.execute(
                    select(LibraryFile).where(LibraryFile.revision_id.in_(revisions_by_id)).order_by(LibraryFile.id)
                )
            )
            .scalars()
            .all()
        )
        if revisions_by_id
        else []
    )
    files_by_revision: dict[int, list[LibraryFile]] = {}
    for row in files:
        files_by_revision.setdefault(row.revision_id, []).append(row)
    used = (
        await used_file_ids(
            db, select(LibraryFile.id).where(LibraryFile.project_id == project.id, LibraryFile.revision_id.isnot(None))
        )
        if files
        else set()
    )
    user_ids = {rev.created_by_id for rev in revisions if rev.created_by_id}
    users = (
        dict((await db.execute(select(User.id, User.username).where(User.id.in_(user_ids)))).all()) if user_ids else {}
    )
    print_counts = await revision_print_counts(db, list(revisions_by_id))
    newest_valide: dict[int, ProjectRevision] = {}
    for rev in revisions:
        if rev.status == "valide" and (
            rev.item_id not in newest_valide or rev.number > newest_valide[rev.item_id].number
        ):
            newest_valide[rev.item_id] = rev

    def revision_out(rev: ProjectRevision, item: ProjectItem) -> ProjectRevisionOut:
        source = revisions_by_id.get(rev.derived_from_id) if rev.derived_from_id else None
        source_item = items_by_id.get(source.item_id) if source else None
        outdated_by = None
        if item.section == "impression" and source is not None and source_item is not None:
            newer = newest_valide.get(source.item_id)
            if newer is not None and newer.number > source.number:
                outdated_by = _ref(newer, source_item)
        rev_files = files_by_revision.get(rev.id, [])
        return ProjectRevisionOut(
            id=rev.id,
            number=rev.number,
            status=rev.status,
            note=rev.note,
            derived_from=_ref(source, source_item) if source and source_item else None,
            outdated_by=outdated_by,
            print_profile=rev.print_profile,
            slicer_name=rev.slicer_name,
            slicer_version=rev.slicer_version,
            has_snapshot=rev.config_snapshot is not None,
            used=any(f.id in used for f in rev_files),
            files=[
                ProjectFileOut(
                    id=f.id,
                    filename=f.filename,
                    file_type=f.file_type,
                    file_size=f.file_size,
                    file_hash=f.file_hash,
                    has_thumbnail=bool(f.thumbnail_path),
                    created_at=f.created_at,
                )
                for f in rev_files
            ],
            created_by=users.get(rev.created_by_id),
            created_at=rev.created_at,
            status_changed_at=rev.status_changed_at,
            print_count=print_counts.get(rev.id, 0),
        )

    by_section: dict[str, list[ProjectItemOut]] = {section: [] for section in SECTIONS}
    for item in items:
        item_revisions = sorted((r for r in revisions if r.item_id == item.id), key=lambda r: r.number, reverse=True)
        fork_source = revisions_by_id.get(item.forked_from_revision_id) if item.forked_from_revision_id else None
        fork_item = items_by_id.get(fork_source.item_id) if fork_source else None
        by_section.setdefault(item.section, []).append(
            ProjectItemOut(
                id=item.id,
                section=item.section,
                name=item.name,
                name_key=item.name_key,
                forked_from=_ref(fork_source, fork_item) if fork_source and fork_item else None,
                revisions=[revision_out(rev, item) for rev in item_revisions],
            )
        )
    return ProjectTreeResponse(
        project_id=project.id,
        code=project.code,
        sections=[ProjectSectionOut(section=section, items=by_section[section]) for section in SECTIONS],
    )
