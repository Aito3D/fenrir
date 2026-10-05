"""Filing library files into projects (phase 5): the File Manager bridge.

Where a file goes inside a project (section from its extension, item from its
name, existing items matched by ``name_key``) is decided here and shared with
the Aito task drop (``aito_project_links``). ``move_library_files_to_project``
moves File Manager files into a project: managed files keep their row (queue
items, archives and photos reference it by id) and their old bytes are
unlinked only after the commit; external files are copied into a new row and
the original row and the file on the mount are never touched.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.library import to_absolute_path
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem
from backend.app.schemas.project_files import ProjectSuggestionForFile
from backend.app.services import project_files
from backend.app.services.project_codes import format_project_code
from backend.app.services.project_files import RevisionSource
from backend.app.services.project_storage import ENABLED_SECTIONS, PRINTABLE_EXTENSIONS, is_printable_filename

logger = logging.getLogger(__name__)

_DROP_SECTIONS = {
    "scan": (".ply", ".obj", ".e57", ".xyz", ".pts"),
    "modelisation": (".step", ".stp", ".iges", ".igs", ".f3d", ".stl", ".sldprt"),
    "impression": PRINTABLE_EXTENSIONS,  # the one printable rule (project_storage)
    "usinage": (".nc", ".tap", ".dxf"),
}
_SECTION_BY_EXTENSION = {ext: section for section, exts in _DROP_SECTIONS.items() for ext in exts}


def section_for_filename(name: str) -> str:
    """Guess the project section from the extension (``.gcode.3mf`` ends in ``.3mf``); unknown -> docs."""
    lowered = name.strip().lower()
    dot = lowered.rfind(".")
    return _SECTION_BY_EXTENSION.get(lowered[dot:], "docs") if dot >= 0 else "docs"


def item_name_for_filename(name: str) -> str:
    """File name without its extension (``.gcode.3mf`` counted whole); the full name if nothing is left."""
    stripped = name.strip()
    if stripped.lower().endswith(".gcode.3mf"):
        stem = stripped[: -len(".gcode.3mf")]
    else:
        stem = stripped.rsplit(".", 1)[0] if "." in stripped else stripped
    return stem if stem.strip() else stripped


async def find_item(db: AsyncSession, project_id: int, section: str, key: str) -> ProjectItem | None:
    return (
        await db.execute(
            select(ProjectItem).where(
                ProjectItem.project_id == project_id,
                ProjectItem.section == section,
                ProjectItem.name_key == key,
            )
        )
    ).scalar_one_or_none()


async def find_or_create_item(
    db: AsyncSession, project: Project, section: str, key: str, name: str, user_id: int | None
) -> tuple[ProjectItem, Project]:
    """The item a group of files goes to, created (and committed) if missing.

    Two drops of the same new name can race between the lookup and the
    create: the loser hits the name check (409) or the unique constraint, so
    it re-reads the winner's item and adds its revision there instead of
    failing. Returns the project too, re-read if the rollback expired it."""
    project_id = project.id
    item = await find_item(db, project_id, section, key)
    if item is not None:
        return item, project
    try:
        item = await project_files.create_item(db, project, section=section, name=name, user_id=user_id)
        await db.commit()
        return item, project
    except (IntegrityError, project_files.ProjectFilesError) as exc:
        if isinstance(exc, project_files.ProjectFilesError) and exc.status_code != 409:
            raise
        await db.rollback()
        project = await db.get(Project, project_id)
        item = await find_item(db, project_id, section, key)
        if item is None or project is None:
            raise project_files.ProjectFilesError(409, "This item was changed meanwhile; drop the files again") from exc
        return item, project


# --- moving File Manager files into a project --------------------------------


@dataclass
class MoveToProjectResult:
    """``moved``: managed rows re-pointed (same ``file_id``). ``copied``: external
    files copied into a new row (``file_id``; ``source_file_id`` is the untouched
    original). Both carry ``filename``, ``section``, ``item_id``, ``item_name``,
    ``revision_id`` and ``revision_number``. ``skipped``: ``{file_id, code, reason}``."""

    moved: list[dict] = field(default_factory=list)
    copied: list[dict] = field(default_factory=list)
    skipped: list[dict] = field(default_factory=list)


@dataclass
class _Candidate:
    file_id: int
    filename: str
    is_external: bool
    src: Path
    file_path: str


def _source_path(file: LibraryFile) -> Path | None:
    if file.is_external:
        return Path(file.file_path) if file.file_path else None
    try:
        return to_absolute_path(file.file_path)
    except ValueError:  # a stored path escaping the data dir is treated as missing
        return None


def _skip(result: MoveToProjectResult, file_id: int, code: str, reason: str) -> None:
    result.skipped.append({"file_id": file_id, "code": code, "reason": reason})


async def _target_item(db: AsyncSession, project: Project, item_id: int) -> ProjectItem:
    item = (
        await db.execute(select(ProjectItem).where(ProjectItem.id == item_id, ProjectItem.project_id == project.id))
    ).scalar_one_or_none()
    if item is None:
        raise project_files.ProjectFilesError(404, "Item not found")
    if item.section not in ENABLED_SECTIONS:
        raise ValueError(f"Section {item.section!r} does not accept files for now")
    return item


async def _fresh_rows(db: AsyncSession, file_ids: list[int]) -> dict[int, LibraryFile]:
    """The rows as committed now (an earlier group's rollback expires every instance)."""
    rows = (
        await db.execute(
            select(LibraryFile).where(LibraryFile.id.in_(file_ids)).execution_options(populate_existing=True)
        )
    ).scalars()
    return {row.id: row for row in rows}


def _unlink_old_bytes(paths: list[Path]) -> None:
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("Moved %s into a project but couldn't remove the old file: %s", path, exc)


async def move_library_files_to_project(
    db: AsyncSession,
    project: Project,
    files: list[LibraryFile],
    *,
    item_id: int | None,
    new_item_name: str | None,
    user_id: int | None,
) -> MoveToProjectResult:
    """Move File Manager files into ``project``. Commits (once per item group).

    Only printable files are accepted, always into the Impression section;
    others are skipped (``not_printable``), as are project files
    (``already_in_project``), trashed files (``trashed``) and files missing on
    disk (``source_missing``). Target: ``item_id`` (an item of this project, in
    an enabled section, else ValueError) or ``new_item_name`` (found or created;
    a blank name is a ValueError)
    takes every file as one revision; otherwise files are grouped per item name
    from their filenames, each group becoming the next revision of the matching
    item (or R1 of a new one). A group that cannot be stored (copy error,
    concurrent change) is skipped whole (``copy_failed`` / ``conflict``) and
    leaves its rows and files as they were; earlier groups stay committed.

    Ownership and permission checks are the caller's."""
    if item_id is not None and new_item_name is not None:
        raise ValueError("Pass either item_id or new_item_name, not both")
    result = MoveToProjectResult()
    project_id = project.id
    target: ProjectItem | None = await _target_item(db, project, item_id) if item_id is not None else None
    target_item_id = target.id if target is not None else None
    if new_item_name is not None:
        try:
            new_item_name, _key = project_files._clean_item_name(new_item_name)
        except project_files.ProjectFilesError as exc:
            raise ValueError(exc.detail) from exc

    # Classify while the caller's instances are loaded: commits and rollbacks below expire them.
    groups: dict[tuple[str, str], tuple[str, list[_Candidate]]] = {}
    for file in files:
        file_id, filename = file.id, file.filename
        if file.revision_id is not None:
            _skip(result, file_id, "already_in_project", "file already belongs to a project")
            continue
        if file.deleted_at is not None:
            _skip(result, file_id, "trashed", "file is in the trash")
            continue
        section = section_for_filename(filename)  # "impression" for every printable file
        if not is_printable_filename(filename):
            _skip(result, file_id, "not_printable", "projects only accept printing files (.3mf, .gcode, .bgcode)")
            continue
        src = _source_path(file)
        if src is None or not src.is_file():
            _skip(result, file_id, "source_missing", "source file missing on disk")
            continue
        candidate = _Candidate(file_id, filename, bool(file.is_external), src, file.file_path)
        if target is not None:
            name, section = target.name, target.section
        else:
            name = new_item_name if new_item_name is not None else item_name_for_filename(filename)
        key = (section, target.name_key if target is not None else project_files._name_key(name))
        groups.setdefault(key, (name, []))[1].append(candidate)

    for (section, key), (name, candidates) in groups.items():
        pending = candidates  # what a failure below reports as skipped
        try:
            if target_item_id is not None:
                item = await project_files._fresh_item(db, target_item_id)
            else:
                item, project = await find_or_create_item(db, project, section, key, name, user_id)
            item_id_now, item_name = item.id, item.name
            rows = await _fresh_rows(db, [c.file_id for c in candidates])
            sources: list[RevisionSource] = []
            stored: list[_Candidate] = []
            for candidate in candidates:
                row = rows.get(candidate.file_id)
                if row is not None and row.deleted_at is not None:
                    _skip(result, candidate.file_id, "trashed", "file is in the trash")
                    continue
                if row is None or row.file_path != candidate.file_path or row.revision_id is not None:
                    _skip(result, candidate.file_id, "conflict", "file changed while it was being moved")
                    continue
                sources.append(
                    RevisionSource(
                        path=candidate.src,
                        filename=candidate.filename,
                        reuse_row=None if candidate.is_external else row,
                    )
                )
                stored.append(candidate)
            pending = stored
            if not sources:
                continue
            revision = await project_files.add_revision_from_sources(
                db, project, item, sources, note=None, user_id=user_id
            )
        except (OSError, project_files.ProjectFilesError) as exc:
            # Only a copy error or a genuine 409 race is a per-group skip; anything else
            # (e.g. the target item deleted meanwhile, 404) is the whole call's error.
            if isinstance(exc, project_files.ProjectFilesError) and exc.status_code != 409:
                raise
            code = "copy_failed" if isinstance(exc, OSError) else "conflict"
            reason = str(exc.detail if isinstance(exc, project_files.ProjectFilesError) else exc)
            logger.warning("Moving files into project %s failed for item %r: %s", project_id, name, reason)
            for candidate in pending:
                _skip(result, candidate.file_id, code, reason)
            refreshed = await db.get(Project, project_id)  # the rollback expired it
            if refreshed is None:
                raise project_files.ProjectFilesError(404, "Project not found") from exc
            project = refreshed
            continue
        _unlink_old_bytes([c.src for c in stored if not c.is_external])
        for candidate, source in zip(stored, sources, strict=True):
            entry = {
                "file_id": source.row.id,
                "filename": source.row.filename,
                "section": section,
                "item_id": item_id_now,
                "item_name": item_name,
                "revision_id": revision.id,
                "revision_number": revision.number,
            }
            if candidate.is_external:
                result.copied.append({**entry, "source_file_id": candidate.file_id})
            else:
                result.moved.append(entry)
    return result


# --- project codes in filenames and project suggestions ----------------------

_FILENAME_CODE_RE = re.compile(r"^P-(\d{4,})[ _-]", re.IGNORECASE)
SIMILAR_ITEM_THRESHOLD = 0.6
SIMILAR_PROJECT_THRESHOLD = 0.45


def project_code_from_filename(name: str) -> str | None:
    """``P-0042`` from a filename starting with ``P-0042_``/``P-0042 ``/``P-0042-``
    (case-insensitive, 4+ digits, normalised); None otherwise."""
    match = _FILENAME_CODE_RE.match(name.strip())
    return format_project_code(int(match.group(1))) if match else None


def _name_without_code(name: str) -> str:
    """The item name a file suggests, its leading project code stripped."""
    item_name = item_name_for_filename(name)
    match = _FILENAME_CODE_RE.match(item_name.strip())
    rest = item_name.strip()[match.end() :] if match else item_name
    return rest if rest.strip() else item_name


async def suggest_projects_for_filename(
    db: AsyncSession, filename: str, limit: int = 5
) -> list[ProjectSuggestionForFile]:
    """Projects a File Manager file likely belongs to, best first: the project
    whose code prefixes the filename (score 1.0), then projects with an item
    (in an enabled section) named like the file, then projects named like it.
    Templates are never suggested; a project appears once, under its best
    reason. Non-printable files get no suggestion."""
    if not is_printable_filename(filename) or limit <= 0:
        return []
    out: list[ProjectSuggestionForFile] = []
    seen: set[int] = set()

    def add(suggestion: ProjectSuggestionForFile) -> None:
        if suggestion.project_id not in seen:
            seen.add(suggestion.project_id)
            out.append(suggestion)

    code = project_code_from_filename(filename)
    if code is not None:
        row = (
            await db.execute(
                select(Project.id, Project.code, Project.name).where(
                    Project.code == code, Project.is_template.is_not(True)
                )
            )
        ).first()
        if row is not None:
            add(ProjectSuggestionForFile(project_id=row[0], code=row[1], name=row[2], score=1.0, reason="code"))

    name = _name_without_code(filename)
    key = project_files._name_key(name)
    if key:
        rows = await db.execute(
            select(ProjectItem.id, ProjectItem.name, ProjectItem.name_key, Project.id, Project.code, Project.name)
            .join(Project, Project.id == ProjectItem.project_id)
            .where(ProjectItem.section.in_(ENABLED_SECTIONS), Project.is_template.is_not(True))
        )
        scored = []
        for item_id, item_name, item_key, project_id, project_code, project_name in rows:
            ratio = SequenceMatcher(None, key, item_key or "").ratio()
            if ratio >= SIMILAR_ITEM_THRESHOLD:
                scored.append((ratio, project_id, item_id, item_name, project_code, project_name))
        scored.sort(key=lambda r: (-r[0], r[1], r[2]))
        for ratio, project_id, item_id, item_name, project_code, project_name in scored:
            add(
                ProjectSuggestionForFile(
                    project_id=project_id,
                    code=project_code,
                    name=project_name,
                    item_id=item_id,
                    item_name=item_name,
                    score=round(ratio, 4),
                    reason="item_name",
                )
            )

    folded = name.strip().casefold()
    if folded:
        rows = await db.execute(select(Project.id, Project.code, Project.name).where(Project.is_template.is_not(True)))
        scored_projects = []
        for project_id, project_code, project_name in rows:
            ratio = SequenceMatcher(None, folded, (project_name or "").casefold()).ratio()
            if ratio >= SIMILAR_PROJECT_THRESHOLD:
                scored_projects.append((ratio, project_id, project_code, project_name))
        scored_projects.sort(key=lambda r: (-r[0], r[1]))
        for ratio, project_id, project_code, project_name in scored_projects:
            add(
                ProjectSuggestionForFile(
                    project_id=project_id,
                    code=project_code,
                    name=project_name,
                    score=round(ratio, 4),
                    reason="project_name",
                )
            )
    return out[:limit]


# --- auto-filing by project code ---------------------------------------------

AUTO_FILE_SETTING_KEY = "projects_auto_file_by_code"


@dataclass
class AutoFileResult:
    """Where ``auto_file_by_code`` put the file (``file_id``: the row now in the revision)."""

    project_id: int
    code: str
    item_id: int
    item_name: str
    revision_id: int
    revision_number: int
    file_id: int


async def auto_file_enabled(db: AsyncSession) -> bool:
    """The ``projects_auto_file_by_code`` setting (default on)."""
    from backend.app.api.routes.settings import get_setting, setting_is_true

    value = await get_setting(db, AUTO_FILE_SETTING_KEY)
    return True if value is None or value == "" else setting_is_true(value)


async def auto_file_by_code(
    db: AsyncSession,
    *,
    filename: str,
    path: Path,
    library_file: LibraryFile | None,
    user_id: int | None,
) -> AutoFileResult | None:
    """File a printing file named ``P-0042_<name>…`` into project P-0042 >
    Impression > ``<name>`` (an existing item is matched by ``name_key``) as its
    next revision. A ``library_file`` is moved (a managed row keeps its id; an
    external one is copied into a new row); without one, ``path`` is copied into
    a new row and left in place.

    Returns None — and leaves everything as it was — when the setting is off, the
    file isn't printable, has no code, or the code names no (non-template)
    project. Never raises: an error is logged, the session rolled back, and None
    returned, so the upload or ingest that called it still succeeds."""
    try:
        return await _auto_file_by_code(db, filename=filename, path=path, library_file=library_file, user_id=user_id)
    except Exception:
        logger.warning("Auto-filing %r by project code failed", filename, exc_info=True)
        try:
            await db.rollback()
        except Exception:
            logger.debug("Rollback after a failed auto-filing failed too", exc_info=True)
        return None


async def _auto_file_by_code(
    db: AsyncSession,
    *,
    filename: str,
    path: Path,
    library_file: LibraryFile | None,
    user_id: int | None,
) -> AutoFileResult | None:
    if not is_printable_filename(filename):
        return None
    code = project_code_from_filename(filename)
    if code is None or not await auto_file_enabled(db):
        return None
    project = (
        await db.execute(select(Project).where(Project.code == code, Project.is_template.is_not(True)))
    ).scalar_one_or_none()
    if project is None:
        return None
    project_id = project.id
    name = _name_without_code(filename)

    if library_file is not None:
        result = await move_library_files_to_project(
            db, project, [library_file], item_id=None, new_item_name=name, user_id=user_id
        )
        filed = [*result.moved, *result.copied]
        if not filed:
            logger.info("Auto-filing %r into %s skipped: %s", filename, code, result.skipped)
            return None
        entry = filed[0]
        outcome = AutoFileResult(
            project_id=project_id,
            code=code,
            item_id=entry["item_id"],
            item_name=entry["item_name"],
            revision_id=entry["revision_id"],
            revision_number=entry["revision_number"],
            file_id=entry["file_id"],
        )
        section = entry["section"]
    else:
        section = section_for_filename(filename)  # "impression" for every printable file
        clean, key = project_files._clean_item_name(name)
        item, project = await find_or_create_item(db, project, section, key, clean, user_id)
        item_id, item_name = item.id, item.name
        source = RevisionSource(path=path, filename=filename)
        revision = await project_files.add_revision_from_sources(
            db, project, item, [source], note=None, user_id=user_id
        )
        outcome = AutoFileResult(
            project_id=project_id,
            code=code,
            item_id=item_id,
            item_name=item_name,
            revision_id=revision.id,
            revision_number=revision.number,
            file_id=source.row.id,
        )
    logger.info("Auto-filed %r into %s > %s R%d", filename, code, outcome.item_name, outcome.revision_number)
    await _record_auto_filed(db, outcome, section, user_id)
    return outcome


async def _record_auto_filed(db: AsyncSession, outcome: AutoFileResult, section: str, user_id: int | None) -> None:
    """Best-effort ``project.revision_added`` on the linked orders (as the import route does)."""
    await _record_revision_added(
        db,
        outcome.project_id,
        {
            "section": section,
            "item_id": outcome.item_id,
            "item_name": outcome.item_name,
            "revision_id": outcome.revision_id,
            "revision_number": outcome.revision_number,
        },
        user_id,
    )


async def _record_revision_added(db: AsyncSession, project_id: int, entry: dict, user_id: int | None) -> None:
    """Best-effort ``project.revision_added`` on the project's linked orders for one
    moved/copied ``entry`` (a ``MoveToProjectResult`` entry); a failure only costs the event."""
    from backend.app.models.user import User
    from backend.app.services import aito_project_links as aito_links

    try:
        user = await db.get(User, user_id) if user_id is not None else None
        actor = user.username if user is not None else None
        async with db.begin_nested():
            order_ids = await aito_links.record_on_linked_orders(
                db,
                project_id,
                "project.revision_added",
                actor=actor,
                subject_label=f"{entry['item_name']} R{entry['revision_number']}",
                detail={"section": entry["section"], "item_id": entry["item_id"], "revision_id": entry["revision_id"]},
            )
        await db.commit()
    except Exception:
        logger.warning("project.revision_added event failed for project %s", project_id, exc_info=True)
        await db.rollback()
        return
    await aito_links.broadcast_orders_changed(order_ids, actor)


# --- legacy migration: linked File Manager files into project trees ----------
#
# Printing files only (user decision 2026-10-05): a project's legacy printable
# files -- File Manager files linked to it directly (``LibraryFile.project_id``)
# or through a linked folder (``LibraryFolder.project_id``; direct link wins) --
# move into its tree (Impression) with ``move_library_files_to_project``.
# Non-printable files stay in the File Manager; the legacy ``attachments`` JSON,
# its files and the cover image are not touched.
#
# Idempotency: ``projects.legacy_migrated_at`` marks a finished project. A
# project that failed half-way is re-run from what is left: moved managed files
# carry ``revision_id`` and drop out of the query; a copied EXTERNAL original
# stays as it was (by design), so it is skipped on a re-run when the project
# already holds a revision file with the same SHA-256 AND the same filename (the
# copy's ``file_hash`` is the hash of the bytes it was copied from). The name is
# part of the key so two distinct external files that happen to share their
# bytes both get migrated. No extra column, no reliance on an editable note.

_RETRYABLE_SKIPS = ("copy_failed", "conflict")


class LegacyMigrationError(Exception):
    """A project's migration stopped short; it keeps no marker and can be re-run."""


@dataclass
class LegacyMigrationOutcome:
    revisions_created: int
    files_moved: int
    files_copied: int


def _legacy_owner():
    """The project a legacy file belongs to: its own link, else its folder's."""
    return func.coalesce(LibraryFile.project_id, LibraryFolder.project_id)


def _legacy_files_query():
    return (
        select(LibraryFile)
        .outerjoin(LibraryFolder, LibraryFile.folder_id == LibraryFolder.id)
        .where(LibraryFile.revision_id.is_(None), LibraryFile.deleted_at.is_(None))
    )


async def legacy_candidates(db: AsyncSession) -> list[int]:
    """Projects not migrated yet that own at least one legacy printable file, by id."""
    owner = _legacy_owner()
    rows = await db.execute(
        select(owner, LibraryFile.filename)
        .select_from(LibraryFile)
        .outerjoin(LibraryFolder, LibraryFile.folder_id == LibraryFolder.id)
        .join(Project, Project.id == owner)
        .where(
            LibraryFile.revision_id.is_(None),
            LibraryFile.deleted_at.is_(None),
            Project.legacy_migrated_at.is_(None),
        )
    )
    return sorted({project_id for project_id, filename in rows if is_printable_filename(filename)})


async def _legacy_files(db: AsyncSession, project_id: int) -> list[LibraryFile]:
    rows = (
        (await db.execute(_legacy_files_query().where(_legacy_owner() == project_id).order_by(LibraryFile.id)))
        .scalars()
        .all()
    )
    return [row for row in rows if is_printable_filename(row.filename)]


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


async def _already_copied(db: AsyncSession, project_id: int, files: list[LibraryFile]) -> set[int]:
    """External files the project already holds a copy of (an earlier run): same
    SHA-256 and same filename as one of its revision files."""
    externals = [(f.id, f.filename, _source_path(f)) for f in files if f.is_external]
    if not externals:
        return set()
    held = set(
        (
            await db.execute(
                select(LibraryFile.file_hash, LibraryFile.filename).where(
                    LibraryFile.project_id == project_id,
                    LibraryFile.revision_id.is_not(None),
                    LibraryFile.deleted_at.is_(None),
                    LibraryFile.file_hash.is_not(None),
                )
            )
        )
        .tuples()
        .all()
    )
    if not held:
        return set()
    out: set[int] = set()
    for file_id, filename, path in externals:
        if path is None or not path.is_file():
            continue
        try:
            digest = await asyncio.to_thread(_sha256_file, path)
        except OSError:
            continue  # the move reports it (source_missing / copy_failed)
        if (digest, filename) in held:
            logger.info(
                "Legacy migration of project %s: external file %s (%r) already copied, skipping",
                project_id,
                file_id,
                filename,
            )
            out.add(file_id)
    return out


async def migrate_project_legacy(db: AsyncSession, project: Project) -> LegacyMigrationOutcome:
    """Move ``project``'s legacy printing files into its tree, then set
    ``legacy_migrated_at``. Each revision commits on its own; on any error the
    marker is not set (already-committed revisions stay; a re-run continues).
    A group skipped for a transient reason (copy error, concurrent change)
    raises ``LegacyMigrationError`` so the project stays a candidate."""
    project_id = project.id
    files = await _legacy_files(db, project_id)
    done = await _already_copied(db, project_id, files)
    to_move = [f for f in files if f.id not in done]
    result = await move_library_files_to_project(db, project, to_move, item_id=None, new_item_name=None, user_id=None)

    revisions: dict[int, dict] = {}
    for entry in [*result.moved, *result.copied]:
        revisions.setdefault(entry["revision_id"], entry)
    for entry in revisions.values():
        await _record_revision_added(db, project_id, entry, None)

    retryable = [s for s in result.skipped if s["code"] in _RETRYABLE_SKIPS]
    if retryable:
        first = retryable[0]
        raise LegacyMigrationError(
            f"{len(retryable)} file(s) could not be moved ({first['code']}: {first['reason']}); run it again"
        )
    for skip in result.skipped:
        logger.info("Legacy migration of project %s left file %s: %s", project_id, skip["file_id"], skip["code"])

    fresh = await db.get(Project, project_id, populate_existing=True)
    if fresh is None:
        raise LegacyMigrationError("project deleted meanwhile")
    fresh.legacy_migrated_at = project_files._now()
    await db.commit()
    return LegacyMigrationOutcome(
        revisions_created=len(revisions), files_moved=len(result.moved), files_copied=len(result.copied)
    )


# Background runner (pattern: the discovery subnet scan): module-level state,
# polled through GET /projects/legacy-migration/status.
_legacy_state: dict = {}


def reset_legacy_migration_state() -> None:
    _legacy_state.clear()
    _legacy_state.update(running=False, total=0, done=0, current=None, failures=[], last_run=None)


reset_legacy_migration_state()


def legacy_migration_status_running() -> bool:
    return bool(_legacy_state["running"])


def start_legacy_migration() -> bool:
    """Spawn the runner; False when one is already running. Check-and-set has no
    await in between, so two concurrent starts can't both win."""
    from backend.app.core.tasks import spawn_background_task

    if _legacy_state["running"]:
        return False
    reset_legacy_migration_state()
    _legacy_state["running"] = True
    spawn_background_task(_run_legacy_migration(), name="projects-legacy-migration")
    return True


async def legacy_migration_status(db: AsyncSession) -> dict:
    state = _legacy_state
    if state["running"]:
        pending = max(state["total"] - state["done"], 0)
    else:
        pending = len(await legacy_candidates(db))
    return {
        "running": state["running"],
        "total": state["total"],
        "done": state["done"],
        "current": dict(state["current"]) if state["current"] else None,
        "failures": [dict(f) for f in state["failures"]],
        "pending": pending,
        "last_run": dict(state["last_run"]) if state["last_run"] else None,
    }


async def _run_legacy_migration() -> None:
    from backend.app.core import database  # module attribute read at call time (tests patch it)

    state = _legacy_state
    totals = {"projects": 0, "files_moved": 0, "files_copied": 0}
    try:
        async with database.async_session() as db:
            project_ids = await legacy_candidates(db)
        state["total"] = len(project_ids)
        for project_id in project_ids:
            code = None
            async with database.async_session() as db:
                try:
                    project = await db.get(Project, project_id)
                    if project is not None and project.legacy_migrated_at is None:
                        code = project.code
                        state["current"] = {"project_id": project_id, "code": code}
                        outcome = await migrate_project_legacy(db, project)
                        logger.info("Legacy migration of %s: %s", code, outcome)
                        totals["projects"] += 1
                        totals["files_moved"] += outcome.files_moved
                        totals["files_copied"] += outcome.files_copied
                except Exception as exc:
                    logger.warning("Legacy migration of project %s failed", project_id, exc_info=True)
                    detail = exc.detail if isinstance(exc, project_files.ProjectFilesError) else str(exc)
                    state["failures"].append({"project_id": project_id, "code": code, "error": str(detail)[:500]})
                    try:
                        await db.rollback()
                    except Exception:
                        logger.debug("Rollback after a failed legacy migration failed too", exc_info=True)
            state["done"] += 1
            state["current"] = None
    except Exception:
        logger.exception("Legacy project migration stopped")
    finally:
        state["last_run"] = {**totals, "finished_at": project_files._now()}
        state["running"] = False
        state["current"] = None
