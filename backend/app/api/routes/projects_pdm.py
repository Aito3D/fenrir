"""Projects as a PDM — fork-owned project endpoints (spec §3.1, §3.5).

Kept out of the upstream ``projects.py`` so upstream merges stay clean.
Registered BEFORE ``projects.router`` in main.py: ``/projects/search`` and
``/projects/tags`` would otherwise be swallowed by ``/projects/{project_id}``.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.aito import _check_ai_rate_limit
from backend.app.core.auth import (
    RequirePermissionIfAuthEnabled,
    probe_permissions_if_auth_enabled,
    require_any_permission_if_auth_enabled,
)
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryTag
from backend.app.models.project import Project
from backend.app.models.project_tag import ProjectTag
from backend.app.models.user import User
from backend.app.schemas.project import (
    ProjectCatalogResponse,
    ProjectFolderCreate,
    ProjectFolderMove,
    ProjectFolderMoveOut,
    ProjectFolderOut,
    ProjectFoldersResponse,
    ProjectFolderUpdate,
    ProjectReformulateRequest,
    ProjectReformulateResponse,
    ProjectSearchItem,
    ProjectSearchResponse,
    ProjectSuggestTagsRequest,
    ProjectSuggestTagsResponse,
    ProjectTagCount,
    ProjectTagRef,
)
from backend.app.services import project_catalog
from backend.app.services.openrouter import (
    OpenRouterNotConfiguredError,
    OpenRouterUpstreamError,
    reformulate_project_text,
    suggest_project_tag_names,
)
from backend.app.services.project_tags import project_tag_refs, rank_tag_suggestions, tag_name_key

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects", tags=["projects"])


@contextmanager
def _catalog_errors() -> Iterator[None]:
    """A ``ProjectCatalogError`` becomes its HTTP error."""
    try:
        yield
    except project_catalog.ProjectCatalogError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.get("/search", response_model=ProjectSearchResponse)
async def search_projects(
    q: str | None = Query(default=None, max_length=200),
    tag_ids: list[int] = Query(default=[], max_length=200),
    tag_mode: Literal["any", "all"] = "any",
    status: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_READ),
):
    """The projects list page: search code, title, description and tag names."""
    conditions = [Project.is_template.is_(False)]
    if status and status != "all":
        conditions.append(Project.status == status)
    term = (q or "").strip()
    if term:
        tagged_like = (
            select(ProjectTag.project_id)
            .join(LibraryTag, LibraryTag.id == ProjectTag.tag_id)
            .where(project_catalog._text_match(LibraryTag.name, term))
        )
        conditions.append(
            or_(
                project_catalog._text_match(Project.code, term),
                project_catalog._text_match(Project.name, term),
                project_catalog._text_match(Project.description, term),
                Project.id.in_(tagged_like),
            )
        )
    wanted = sorted(set(tag_ids))
    if wanted:
        tagged = select(ProjectTag.project_id).where(ProjectTag.tag_id.in_(wanted))
        if tag_mode == "all":
            tagged = tagged.group_by(ProjectTag.project_id).having(
                func.count(func.distinct(ProjectTag.tag_id)) == len(wanted)
            )
        conditions.append(Project.id.in_(tagged))

    total = (await db.execute(select(func.count(Project.id)).where(*conditions))).scalar_one()
    projects = (
        (
            await db.execute(
                select(Project)
                .where(*conditions)
                .order_by(Project.updated_at.desc(), Project.id.desc())
                .limit(limit)
                .offset(offset)
            )
        )
        .scalars()
        .all()
    )
    ids = [p.id for p in projects]
    tags = await project_tag_refs(db, ids)
    counts: dict[int, int] = {}
    if ids:
        counts = dict(
            (
                await db.execute(
                    select(PrintArchive.project_id, func.count(PrintArchive.id))
                    .where(PrintArchive.project_id.in_(ids), PrintArchive.deleted_at.is_(None))
                    .group_by(PrintArchive.project_id)
                )
            ).all()
        )
    return ProjectSearchResponse(
        total=total,
        items=[
            ProjectSearchItem(
                id=p.id,
                code=p.code,
                name=p.name,
                description=p.description,
                status=p.status,
                color=p.color,
                cover_image_filename=p.cover_image_filename,
                tags=tags[p.id],
                archive_count=int(counts.get(p.id, 0)),
                created_at=p.created_at,
                updated_at=p.updated_at,
            )
            for p in projects
        ],
    )


@router.get("/folders", response_model=ProjectFoldersResponse)
async def list_project_folders(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_READ),
):
    """The catalog's folder tree, each folder with its subtree's project counts."""
    return ProjectFoldersResponse(folders=await project_catalog.list_folders(db))


@router.post("/folders", response_model=ProjectFolderOut, status_code=201)
async def create_project_folder(
    body: ProjectFolderCreate,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE),
):
    with _catalog_errors():
        folder = await project_catalog.create_folder(db, body.name, body.parent_id)
    return ProjectFolderOut(
        id=folder.id, name=folder.name, parent_id=folder.parent_id, project_count=0, in_production_count=0
    )


@router.patch("/folders/{folder_id}", response_model=ProjectFolderOut)
async def update_project_folder(
    folder_id: int,
    body: ProjectFolderUpdate,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE),
):
    """Rename and/or move a folder; moving it under itself is refused (409)."""
    with _catalog_errors():
        folder = await project_catalog.get_folder(db, folder_id)
        folder = await project_catalog.update_folder(
            db, folder, name=body.name, parent_id=body.parent_id, parent_given="parent_id" in body.model_fields_set
        )
        counts = next((f for f in await project_catalog.list_folders(db) if f.id == folder.id), None)
    return counts or ProjectFolderOut(
        id=folder.id, name=folder.name, parent_id=folder.parent_id, project_count=0, in_production_count=0
    )


@router.delete("/folders/{folder_id}", status_code=204, response_model=None)
async def delete_project_folder(
    folder_id: int,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE),
) -> None:
    """Delete a folder; its projects and sub-folders move up to its parent."""
    with _catalog_errors():
        await project_catalog.delete_folder(db, await project_catalog.get_folder(db, folder_id))


@router.patch("/{project_id}/folder", response_model=ProjectFolderMoveOut)
async def move_project_to_folder(
    project_id: int,
    body: ProjectFolderMove,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE),
):
    """File the project in a folder (``folder_id`` null takes it out of any folder)."""
    project = await db.get(Project, project_id)
    if project is None or project.is_template:
        raise HTTPException(status_code=404, detail="Project not found")
    with _catalog_errors():
        project = await project_catalog.move_project(db, project, body.folder_id)
    return ProjectFolderMoveOut(id=project.id, folder_id=project.folder_id)


@router.get("/catalog", response_model=ProjectCatalogResponse)
async def project_catalog_list(
    q: str | None = Query(default=None, max_length=200),
    tag_ids: list[int] = Query(default=[], max_length=200),
    tag_mode: Literal["any", "all"] = "any",
    status: str | None = None,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_READ),
    can_read_aito: bool = Depends(probe_permissions_if_auth_enabled(Permission.AITO_READ)),
):
    """The Projects catalog: every matching project with the facts its row and pane show, newest
    activity first. The search also covers folders, clients, order numbers, item and file names."""
    items, truncated = await project_catalog.catalog(
        db, q=q, status=status, tag_ids=tag_ids, tag_mode=tag_mode, can_read_aito=can_read_aito
    )
    return ProjectCatalogResponse(items=items, truncated=truncated)


@router.get("/tags", response_model=list[ProjectTagCount])
async def list_project_tags(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_READ),
):
    """The whole tag catalogue with how many projects carry each tag. Gated on
    projects:read (not library:read) so a projects-only user can pick tags."""
    counts = (
        select(ProjectTag.tag_id, func.count(ProjectTag.project_id).label("n")).group_by(ProjectTag.tag_id).subquery()
    )
    rows = await db.execute(
        select(LibraryTag.id, LibraryTag.name, func.coalesce(counts.c.n, 0))
        .outerjoin(counts, counts.c.tag_id == LibraryTag.id)
        .order_by(LibraryTag.name_key)
    )
    return [ProjectTagCount(id=tag_id, name=name, project_count=int(n)) for tag_id, name, n in rows.all()]


_AI_WRITERS = require_any_permission_if_auth_enabled(Permission.PROJECTS_CREATE, Permission.PROJECTS_UPDATE)


@contextmanager
def _openrouter_errors(upstream_log: str) -> Iterator[None]:
    """Map OpenRouter failures to HTTP: not configured -> 409 (no cause),
    upstream failure -> 502 with the error text, logged with ``upstream_log``."""
    try:
        yield
    except OpenRouterNotConfiguredError:
        raise HTTPException(status_code=409, detail="OpenRouter is not configured") from None
    except OpenRouterUpstreamError as e:
        logger.warning(upstream_log, e)
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.post("/ai/reformulate", response_model=ProjectReformulateResponse)
async def reformulate_text(
    payload: ProjectReformulateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db, scope="function"),
    current_user: User | None = Depends(_AI_WRITERS),
):
    """French rewording of a project title or description (spec §3.5). Shares
    the Aito OpenRouter budget: same bill, same bucket."""
    _check_ai_rate_limit(request, current_user)
    with _openrouter_errors("Project reformulate failed upstream: %s"):
        text, model = await reformulate_project_text(db, payload.text, payload.field)
    return ProjectReformulateResponse(text=text, model=model)


@router.post("/ai/suggest-tags", response_model=ProjectSuggestTagsResponse)
async def suggest_tags(
    payload: ProjectSuggestTagsRequest,
    request: Request,
    db: AsyncSession = Depends(get_db, scope="function"),
    current_user: User | None = Depends(_AI_WRITERS),
):
    """Up to five tags, catalogue first, at most two new names. Never applied:
    the client shows them as chips the operator accepts one by one."""
    _check_ai_rate_limit(request, current_user)
    catalogue_rows = (await db.execute(select(LibraryTag.id, LibraryTag.name).order_by(LibraryTag.name_key))).all()
    catalogue = {tag_name_key(name): ProjectTagRef(id=tag_id, name=name) for tag_id, name in catalogue_rows}
    with _openrouter_errors("Project tag suggestion failed upstream: %s"):
        raw, model = await suggest_project_tag_names(
            db, payload.title, payload.description, [name for _id, name in catalogue_rows]
        )
    return ProjectSuggestTagsResponse(
        suggestions=rank_tag_suggestions(raw, catalogue, set(payload.exclude_tag_ids)), model=model
    )
