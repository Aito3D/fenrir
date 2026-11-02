"""The Projects catalog (design 2026-10-31): folders and the browser list.

Folders: a tree (``ProjectFolder``) that projects are filed in (``Project.folder_id``).
Catalog: every project matching a search, each with the facts the catalog row and
its pane show (client, open order, files, recommended revision, printed count, last
activity, thumbnail). The search covers code, title, description, tags, folder
names, linked Aito orders (client name, order number), Impression item names and
revision file names, with case-insensitive LIKE on both dialects.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile, LibraryTag
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.project import Project
from backend.app.models.project_folder import ProjectFolder
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.app.models.project_tag import ProjectTag
from backend.app.schemas.project import (
    CatalogOpenOrder,
    CatalogRecommended,
    ProjectCatalogItem,
    ProjectFolderOut,
)
from backend.app.services.http_status_error import HttpStatusError
from backend.app.services.project_tags import project_tag_refs

CATALOG_LIMIT = 500
PRINTING_SECTION = "impression"
FOLDER_NAME_MAX = 255

# Serialises folder moves so the cycle check and the write see no other move in between. One
# process serves the app; shortcut: a second worker process would need a DB-level lock instead.
_FOLDER_TREE_LOCK = asyncio.Lock()

# An Aito order still in the shop's hands: not deleted, card not in Done (spec §12.2.3).
_OPEN_ORDER = and_(AitoProject.status != "deleted", AitoProject.board_column != "done")


class ProjectCatalogError(HttpStatusError):
    pass


# --- folders -------------------------------------------------------------------------------------


def _clean_name(name: str) -> str:
    cleaned = " ".join(name.split())
    if not cleaned:
        raise ProjectCatalogError(400, "A folder needs a name")
    if len(cleaned) > FOLDER_NAME_MAX:
        raise ProjectCatalogError(400, f"A folder name is at most {FOLDER_NAME_MAX} characters")
    return cleaned


async def all_folders(db: AsyncSession) -> list[ProjectFolder]:
    return list((await db.execute(select(ProjectFolder).order_by(ProjectFolder.name, ProjectFolder.id))).scalars())


async def get_folder(db: AsyncSession, folder_id: int) -> ProjectFolder:
    folder = await db.get(ProjectFolder, folder_id)
    if folder is None:
        raise ProjectCatalogError(404, "Folder not found")
    return folder


def _children_index(folders: list[ProjectFolder]) -> dict[int | None, list[ProjectFolder]]:
    children: dict[int | None, list[ProjectFolder]] = defaultdict(list)
    for folder in folders:
        children[folder.parent_id].append(folder)
    return children


def subtree_ids(folders: list[ProjectFolder], root_id: int) -> set[int]:
    """``root_id`` and every folder below it."""
    children = _children_index(folders)
    out: set[int] = set()
    stack = [root_id]
    while stack:
        current = stack.pop()
        if current in out:
            continue
        out.add(current)
        stack.extend(child.id for child in children.get(current, []))
    return out


def ancestor_ids(folders: list[ProjectFolder], folder_id: int | None) -> list[int]:
    """``folder_id`` and its parents up to the root (nearest first); [] for None."""
    by_id = {folder.id: folder for folder in folders}
    out: list[int] = []
    current = folder_id
    while current is not None and current in by_id and current not in out:
        out.append(current)
        current = by_id[current].parent_id
    return out


async def list_folders(db: AsyncSession) -> list[ProjectFolderOut]:
    """Every folder with its subtree's project count and in-production project count."""
    folders = await all_folders(db)
    rows = (
        await db.execute(
            select(Project.id, Project.folder_id).where(Project.is_template.is_(False), Project.folder_id.isnot(None))
        )
    ).all()
    in_production = await _in_production_ids(db, [project_id for project_id, _ in rows])
    per_folder: dict[int, list[int]] = defaultdict(list)
    for project_id, folder_id in rows:
        if folder_id is not None:
            per_folder[folder_id].append(project_id)
    out = []
    for folder in folders:
        ids = subtree_ids(folders, folder.id)
        projects = [pid for fid in ids for pid in per_folder.get(fid, [])]
        out.append(
            ProjectFolderOut(
                id=folder.id,
                name=folder.name,
                parent_id=folder.parent_id,
                project_count=len(projects),
                in_production_count=sum(1 for pid in projects if pid in in_production),
            )
        )
    return out


async def create_folder(db: AsyncSession, name: str, parent_id: int | None) -> ProjectFolder:
    if parent_id is not None:
        await get_folder(db, parent_id)
    folder = ProjectFolder(name=_clean_name(name), parent_id=parent_id)
    db.add(folder)
    await db.commit()
    await db.refresh(folder)
    return folder


async def update_folder(
    db: AsyncSession, folder: ProjectFolder, *, name: str | None, parent_id: int | None, parent_given: bool
) -> ProjectFolder:
    """Rename and/or re-parent (``parent_given`` with ``None`` moves it to the root). A folder
    cannot be moved into itself or below itself (409)."""
    if name is not None:
        folder.name = _clean_name(name)
    if parent_given and parent_id is not None:
        await get_folder(db, parent_id)
    async with _FOLDER_TREE_LOCK:
        if parent_given:
            if parent_id is not None:
                # populate_existing: the tree as committed now, not as this session first loaded it.
                fresh = await db.execute(select(ProjectFolder).execution_options(populate_existing=True))
                if parent_id in subtree_ids(list(fresh.scalars()), folder.id):
                    raise ProjectCatalogError(409, "A folder cannot be moved into itself")
            folder.parent_id = parent_id
        await db.commit()
    await db.refresh(folder)
    return folder


async def delete_folder(db: AsyncSession, folder: ProjectFolder) -> None:
    """Delete the folder; its projects and sub-folders move up to its parent (or the root)."""
    await db.execute(
        update(ProjectFolder).where(ProjectFolder.parent_id == folder.id).values(parent_id=folder.parent_id)
    )
    await db.execute(update(Project).where(Project.folder_id == folder.id).values(folder_id=folder.parent_id))
    await db.delete(folder)
    await db.commit()


async def move_project(db: AsyncSession, project: Project, folder_id: int | None) -> Project:
    if folder_id is not None:
        await get_folder(db, folder_id)
    project.folder_id = folder_id
    await db.commit()
    await db.refresh(project)
    return project


# --- catalog -------------------------------------------------------------------------------------


def _like(raw: str) -> str:
    escaped = raw.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _text_match(column, raw: str):
    """Case-insensitive substring match on both dialects (``lower`` plus the raw form for
    SQLite's ASCII-only ``lower``)."""
    return or_(
        func.lower(func.coalesce(column, "")).like(_like(raw.lower()), escape="\\"),
        func.coalesce(column, "").like(_like(raw), escape="\\"),
    )


def _order_number(term: str) -> int | None:
    """``#1098`` or a bare number of two digits or more names an Aito order."""
    digits = term.lstrip("#")
    if not digits.isdigit():
        return None
    return int(digits) if term.startswith("#") or len(digits) >= 2 else None


async def _in_production_ids(db: AsyncSession, project_ids: list[int]) -> set[int]:
    if not project_ids:
        return set()
    rows = await db.execute(
        select(AitoTask.linked_project_id)
        .join(AitoProject, AitoProject.id == AitoTask.project_id)
        .where(AitoTask.linked_project_id.in_(project_ids), _OPEN_ORDER)
        .distinct()
    )
    return {project_id for (project_id,) in rows if project_id is not None}


def _search_conditions(term: str, folders: list[ProjectFolder], can_read_aito: bool = True) -> list[Any]:
    """OR-ed conditions for one search term across every searched field (linked Aito orders'
    client name and number only for callers holding aito:read)."""
    tagged = (
        select(ProjectTag.project_id)
        .join(LibraryTag, LibraryTag.id == ProjectTag.tag_id)
        .where(_text_match(LibraryTag.name, term))
    )
    matching_folder_ids: set[int] = set()
    for folder in folders:
        if term.lower() in folder.name.lower():
            matching_folder_ids |= subtree_ids(folders, folder.id)
    items = select(ProjectItem.project_id).where(_text_match(ProjectItem.name, term))
    files = (
        select(ProjectItem.project_id)
        .join(ProjectRevision, ProjectRevision.item_id == ProjectItem.id)
        .join(LibraryFile, LibraryFile.revision_id == ProjectRevision.id)
        .where(LibraryFile.deleted_at.is_(None), _text_match(LibraryFile.filename, term))
    )
    conditions = [
        _text_match(Project.code, term),
        _text_match(Project.name, term),
        _text_match(Project.description, term),
        Project.id.in_(tagged),
        Project.id.in_(items),
        Project.id.in_(files),
    ]
    if can_read_aito:
        order_clauses = [_text_match(AitoProject.client_name, term)]
        number = _order_number(term)
        if number is not None:
            order_clauses.append(AitoProject.id == number)
        ordered = (
            select(AitoTask.linked_project_id)
            .join(AitoProject, AitoProject.id == AitoTask.project_id)
            .where(AitoProject.status != "deleted", or_(*order_clauses))
        )
        conditions.append(Project.id.in_(ordered))
    if matching_folder_ids:
        conditions.append(Project.folder_id.in_(matching_folder_ids))
    return conditions


def _is_sliced(revision: ProjectRevision) -> bool:
    if revision.slice_status == "sliced" and revision.sliced_file_id is not None:
        return True
    profile = revision.print_profile if isinstance(revision.print_profile, dict) else {}
    return bool(profile.get("sliced"))


def _recommended(revisions: list[tuple[ProjectRevision, ProjectItem]]) -> tuple[ProjectRevision, ProjectItem] | None:
    """The newest ``valide`` sliced revision, else the newest sliced one, else None."""
    sliced = [(r, i) for r, i in revisions if _is_sliced(r)]
    if not sliced:
        return None
    sliced.sort(key=lambda pair: (pair[0].created_at or datetime.min, pair[0].id), reverse=True)
    return next(((r, i) for r, i in sliced if r.status == "valide"), sliced[0])


def _as_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value if v not in (None, "")]
    return [str(value)] if value not in (None, "") else []


def _recommended_out(revision: ProjectRevision, item: ProjectItem, grams_time: tuple[int | None, float | None]):
    profile = revision.print_profile if isinstance(revision.print_profile, dict) else {}
    nozzle = profile.get("nozzle_diameter")
    return CatalogRecommended(
        item_id=item.id,
        item_name=item.name,
        revision_id=revision.id,
        number=revision.number,
        status=revision.status,
        printer_model=profile.get("printer_model") if isinstance(profile.get("printer_model"), str) else None,
        nozzle_diameter=str(nozzle) if nozzle not in (None, "") else None,
        filament_types=_as_list(profile.get("filament_types")),
        print_time_seconds=grams_time[0],
        filament_used_grams=grams_time[1],
    )


async def catalog(
    db: AsyncSession,
    *,
    q: str | None,
    status: str | None,
    tag_ids: list[int],
    tag_mode: Literal["any", "all"],
    can_read_aito: bool = True,
) -> list[ProjectCatalogItem]:
    """Without ``can_read_aito`` the linked Aito orders stay hidden: ``client_names`` and
    ``open_orders`` are empty and the search skips client names and order numbers."""
    folders = await all_folders(db)
    conditions: list[Any] = [Project.is_template.is_(False)]
    if status and status != "all":
        conditions.append(Project.status == status)
    for term in (q or "").split():
        conditions.append(or_(*_search_conditions(term, folders, can_read_aito)))
    wanted = sorted(set(tag_ids))
    if wanted:
        tagged = select(ProjectTag.project_id).where(ProjectTag.tag_id.in_(wanted))
        if tag_mode == "all":
            tagged = tagged.group_by(ProjectTag.project_id).having(
                func.count(func.distinct(ProjectTag.tag_id)) == len(wanted)
            )
        conditions.append(Project.id.in_(tagged))
    projects = list(
        (
            await db.execute(
                select(Project)
                .where(*conditions)
                .order_by(Project.updated_at.desc(), Project.id.desc())
                .limit(CATALOG_LIMIT)
            )
        ).scalars()
    )
    ids = [p.id for p in projects]
    if not ids:
        return []
    tags = await project_tag_refs(db, ids)

    # Linked Aito orders: every non-deleted one gives a client name; the open ones a badge.
    clients: dict[int, list[str]] = defaultdict(list)
    open_orders: dict[int, list[CatalogOpenOrder]] = defaultdict(list)
    seen_orders: set[tuple[int, int]] = set()
    order_rows = (
        await db.execute(
            select(AitoTask.linked_project_id, AitoProject.id, AitoProject.client_name, AitoProject.board_column)
            .join(AitoProject, AitoProject.id == AitoTask.project_id)
            .where(AitoTask.linked_project_id.in_(ids), AitoProject.status != "deleted")
            .order_by(AitoProject.created_at.desc(), AitoProject.id.desc())
        )
        if can_read_aito
        else []
    )
    for project_id, order_id, client_name, board_column in order_rows:
        if project_id is None or (project_id, order_id) in seen_orders:
            continue
        seen_orders.add((project_id, order_id))
        if client_name and client_name not in clients[project_id]:
            clients[project_id].append(client_name)
        if board_column != "done":
            open_orders[project_id].append(CatalogOpenOrder(order_id=order_id, client_name=client_name))

    # Impression items and their revisions.
    revision_rows = await db.execute(
        select(ProjectRevision, ProjectItem)
        .join(ProjectItem, ProjectItem.id == ProjectRevision.item_id)
        .where(ProjectItem.project_id.in_(ids), ProjectItem.section == PRINTING_SECTION)
    )
    revisions: dict[int, list[tuple[ProjectRevision, ProjectItem]]] = defaultdict(list)
    item_ids: dict[int, set[int]] = defaultdict(set)
    for revision, item in revision_rows:
        revisions[item.project_id].append((revision, item))
        item_ids[item.project_id].add(item.id)
    # Items without any revision still count as files.
    for project_id, item_id in await db.execute(
        select(ProjectItem.project_id, ProjectItem.id).where(
            ProjectItem.project_id.in_(ids), ProjectItem.section == PRINTING_SECTION
        )
    ):
        item_ids[project_id].add(item_id)

    recommended = {pid: _recommended(revisions[pid]) for pid in ids}
    rec_revision_ids = [pair[0].id for pair in recommended.values() if pair is not None]
    # The recommended revision's facts and thumbnail come from its files (the sliced one for time
    # and grams, the source for the thumbnail).
    facts: dict[int, tuple[int | None, float | None]] = {}
    thumb: dict[int, int] = {}
    if rec_revision_ids:
        file_rows = await db.execute(
            select(LibraryFile)
            .where(LibraryFile.revision_id.in_(rec_revision_ids), LibraryFile.deleted_at.is_(None))
            .order_by(LibraryFile.id)
        )
        for f in file_rows.scalars():
            meta = f.file_metadata if isinstance(f.file_metadata, dict) else {}
            time_s = meta.get("print_time_seconds")
            grams = meta.get("filament_used_grams")
            if (time_s or grams) and f.revision_id is not None and f.revision_id not in facts:
                facts[f.revision_id] = (
                    int(time_s) if isinstance(time_s, (int, float)) and time_s > 0 else None,
                    float(grams) if isinstance(grams, (int, float)) and grams > 0 else None,
                )
            if f.thumbnail_path and f.revision_id is not None and f.revision_id not in thumb:
                thumb[f.revision_id] = f.id
    # A thumbnail for projects whose recommended revision has none: any revision file with one.
    missing_thumb: list[int] = []
    for pid in ids:
        pair = recommended[pid]
        if pair is None or pair[0].id not in thumb:
            missing_thumb.append(pid)
    fallback_thumb: dict[int, int] = {}
    if missing_thumb:
        rows = await db.execute(
            select(ProjectItem.project_id, LibraryFile.id)
            .join(ProjectRevision, ProjectRevision.item_id == ProjectItem.id)
            .join(LibraryFile, LibraryFile.revision_id == ProjectRevision.id)
            .where(
                ProjectItem.project_id.in_(missing_thumb),
                LibraryFile.deleted_at.is_(None),
                LibraryFile.thumbnail_path.isnot(None),
            )
            .order_by(ProjectRevision.created_at.desc(), LibraryFile.id.desc())
        )
        for project_id, file_id in rows:
            if project_id is not None:
                fallback_thumb.setdefault(project_id, file_id)

    # Printed runs and the latest archive per project.
    printed: dict[int, int] = {}
    last_archive: dict[int, datetime] = {}
    for project_id, runs, latest in await db.execute(
        select(PrintArchive.project_id, func.count(PrintLogEntry.id), func.max(PrintArchive.created_at))
        .join(PrintLogEntry, PrintLogEntry.archive_id == PrintArchive.id, isouter=True)
        .where(PrintArchive.project_id.in_(ids), PrintArchive.deleted_at.is_(None))
        .group_by(PrintArchive.project_id)
    ):
        if project_id is None:
            continue
        printed[project_id] = int(runs or 0)
        if latest is not None:
            last_archive[project_id] = latest

    out = []
    for p in projects:
        rec = recommended[p.id]
        stamps = [p.updated_at, p.created_at, last_archive.get(p.id)] + [
            r.created_at for r, _ in revisions.get(p.id, [])
        ]
        last_activity = max(stamp for stamp in stamps if stamp is not None)
        rec_out = None
        thumbnail_id = fallback_thumb.get(p.id)
        if rec is not None:
            rec_out = _recommended_out(rec[0], rec[1], facts.get(rec[0].id, (None, None)))
            thumbnail_id = thumb.get(rec[0].id, thumbnail_id)
        out.append(
            ProjectCatalogItem(
                id=p.id,
                code=p.code,
                name=p.name,
                description=p.description,
                status=p.status,
                folder_id=p.folder_id,
                tags=tags.get(p.id, []),
                client_names=clients.get(p.id, []),
                open_orders=open_orders.get(p.id, []),
                files_count=len(item_ids.get(p.id, ())),
                recommended=rec_out,
                has_unsliced_only=bool(item_ids.get(p.id)) and rec is None,
                printed_count=printed.get(p.id, 0),
                target_count=p.target_count,
                last_activity=last_activity,
                thumbnail_file_id=thumbnail_id,
            )
        )
    out.sort(key=lambda item: (item.last_activity, item.id), reverse=True)
    return out
