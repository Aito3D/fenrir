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

import logging
import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.library import to_absolute_path
from backend.app.models.library import LibraryFile
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
