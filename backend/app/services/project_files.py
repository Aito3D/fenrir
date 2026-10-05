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
import shutil
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from fastapi import UploadFile
from sqlalchemy import delete, exists, or_, select, update
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
from backend.app.services.project_snapshot import PrintSnapshot, is_3mf, read_print_snapshot
from backend.app.services.project_storage import (
    item_dir,
    move_to_trash,
    revision_dir,
    sanitize_component,
    unique_file_path,
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
    await _require_editable_files(db, revision)
    folder = revision_dir(project, item.section, item.name, revision.number)
    written: list[_WrittenFile] = []
    try:
        written = await _stream_files(folder, uploads)
        rows = await _add_file_rows(db, project, revision, written, user_id)
        warnings = await _duplicate_warnings(db, item, revision, rows)
        await db.commit()
    except BaseException:
        await db.rollback()
        _cleanup_written(written)
        raise
    return warnings


async def remove_file_from_revision(
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
    await db.delete(target)
    await db.flush()
    moved = move_to_trash(project, path) if path is not None else None
    try:
        await db.commit()
    except BaseException:
        if moved is not None and path is not None:
            shutil.move(str(moved), str(path))
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
    if await revision_is_used(db, revision.id):
        raise ProjectFilesError(409, "This revision was printed or delivered and cannot be deleted")
    folder = item_dir(project, item.section, item.name).joinpath(
        f"R{revision.number}"
    )  # SEC-PATH-OK: fixed "R{int}" under a resolved item dir
    await db.execute(delete(LibraryFile).where(LibraryFile.revision_id == revision.id))
    await _clear_links_to(db, [revision.id])
    await db.delete(revision)
    await db.flush()
    moved = move_to_trash(project, folder)
    try:
        await db.commit()
    except BaseException:
        if moved is not None:
            shutil.move(str(moved), str(folder))
        raise


async def _item_revision_ids(db: AsyncSession, item_id: int) -> list[int]:
    return list(
        (await db.execute(select(ProjectRevision.id).where(ProjectRevision.item_id == item_id))).scalars().all()
    )


async def rename_item(db: AsyncSession, project: Project, item: ProjectItem, new_name: str) -> ProjectItem:
    from backend.app.api.routes.library import to_absolute_path

    clean = new_name.strip()[:255]
    if not clean or sanitize_component(clean, fallback="") == "":
        raise ProjectFilesError(400, "Item name must not be blank")
    key = _name_key(clean)
    if key != item.name_key:
        taken = (
            await db.execute(
                select(ProjectItem.id).where(
                    ProjectItem.project_id == project.id,
                    ProjectItem.section == item.section,
                    ProjectItem.name_key == key,
                    ProjectItem.id != item.id,
                )
            )
        ).first()
        if taken:
            raise ProjectFilesError(409, "An item with this name already exists in this section")
    old_dir = item_dir(project, item.section, item.name)
    new_dir = item_dir(project, item.section, clean)
    moved = False
    if old_dir != new_dir and old_dir.exists():
        if new_dir.exists():
            raise ProjectFilesError(409, "A folder with this name already exists")
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
    revision_ids = await _item_revision_ids(db, item.id)
    for revision_id in revision_ids:
        if await revision_is_used(db, revision_id):
            raise ProjectFilesError(409, "A revision of this item was printed or delivered; the item cannot be deleted")
    folder = item_dir(project, item.section, item.name)
    if revision_ids:
        await db.execute(delete(LibraryFile).where(LibraryFile.revision_id.in_(revision_ids)))
        await _clear_links_to(db, revision_ids)
        await db.execute(delete(ProjectRevision).where(ProjectRevision.id.in_(revision_ids)))
    await db.delete(item)
    await db.flush()
    moved = move_to_trash(project, folder)
    try:
        await db.commit()
    except BaseException:
        if moved is not None:
            shutil.move(str(moved), str(folder))
        raise


async def fork_revision(
    db: AsyncSession, project: Project, item: ProjectItem, revision: ProjectRevision, new_name: str, user_id: int | None
) -> ProjectItem:
    """New item in the same section whose R1 is a copy of ``revision`` (spec §2.4)."""
    from backend.app.api.routes.library import to_absolute_path

    forked = await create_item(db, project, section=item.section, name=new_name, user_id=user_id)
    forked.forked_from_revision_id = revision.id
    folder = revision_dir(project, forked.section, forked.name, 1)
    copied: list[Path] = []
    try:
        r1 = ProjectRevision(
            item_id=forked.id, number=1, status="wip", derived_from_id=revision.id, created_by_id=user_id
        )
        r1.config_snapshot, r1.config_hash = revision.config_snapshot, revision.config_hash
        r1.slicer_name, r1.slicer_version, r1.print_profile = (
            revision.slicer_name,
            revision.slicer_version,
            revision.print_profile,
        )
        db.add(r1)
        forked.last_revision_number = 1
        await db.flush()
        for source in await _revision_files(db, revision.id):
            src = to_absolute_path(source.file_path)
            if src is None or not src.exists():
                continue
            dest = unique_file_path(folder, source.filename)
            await asyncio.to_thread(shutil.copy2, src, dest)
            copied.append(dest)
            db.add(
                LibraryFile(
                    project_id=project.id,
                    revision_id=r1.id,
                    folder_id=None,
                    is_external=False,
                    filename=dest.name,
                    file_path=to_relative_path(dest),
                    file_type=source.file_type,
                    file_size=source.file_size,
                    file_hash=source.file_hash,
                    thumbnail_path=source.thumbnail_path,
                    file_metadata=source.file_metadata,
                    created_by_id=user_id,
                )
            )
        await db.commit()
    except BaseException:
        for path in copied:
            path.unlink(missing_ok=True)
        await db.rollback()
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
    file_ids = [row.id for row in files]
    used_file_ids: set[int] = set()
    if file_ids:
        used_file_ids |= set(
            (
                await db.execute(
                    select(PrintQueueItem.library_file_id).where(PrintQueueItem.library_file_id.in_(file_ids))
                )
            )
            .scalars()
            .all()
        )
        used_file_ids |= set(
            (await db.execute(select(PrintArchive.library_file_id).where(PrintArchive.library_file_id.in_(file_ids))))
            .scalars()
            .all()
        )
    user_ids = {rev.created_by_id for rev in revisions if rev.created_by_id}
    users = (
        dict((await db.execute(select(User.id, User.username).where(User.id.in_(user_ids)))).all()) if user_ids else {}
    )
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
            used=any(f.id in used_file_ids for f in rev_files),
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
                forked_from=_ref(fork_source, fork_item) if fork_source and fork_item else None,
                revisions=[revision_out(rev, item) for rev in item_revisions],
            )
        )
    return ProjectTreeResponse(
        project_id=project.id,
        code=project.code,
        sections=[ProjectSectionOut(section=section, items=by_section[section]) for section in SECTIONS],
    )
