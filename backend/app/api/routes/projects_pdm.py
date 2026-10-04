"""Projects as a PDM — fork-owned project endpoints (spec §3.1, §3.5).

Kept out of the upstream ``projects.py`` so upstream merges stay clean.
Registered BEFORE ``projects.router`` in main.py: ``/projects/search`` and
``/projects/tags`` would otherwise be swallowed by ``/projects/{project_id}``.
"""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.aito import _check_ai_rate_limit
from backend.app.core.auth import RequirePermissionIfAuthEnabled, require_any_permission_if_auth_enabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryTag
from backend.app.models.project import Project
from backend.app.models.project_tag import ProjectTag
from backend.app.models.user import User
from backend.app.schemas.project import (
    ProjectReformulateRequest,
    ProjectReformulateResponse,
    ProjectSearchItem,
    ProjectSearchResponse,
    ProjectSuggestTagsRequest,
    ProjectSuggestTagsResponse,
    ProjectTagCount,
    ProjectTagRef,
)
from backend.app.services.openrouter import (
    OpenRouterNotConfiguredError,
    OpenRouterUpstreamError,
    reformulate_project_text,
    suggest_project_tag_names,
)
from backend.app.services.project_tags import project_tag_refs, rank_tag_suggestions, tag_name_key

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects", tags=["projects"])


def _like(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _text_match(column, raw: str):
    """Case-insensitive contains. Two patterns because SQLite's ``lower()`` only
    folds ASCII: the lowered one covers "fpv" vs "FPV", the raw one covers an
    accented capital typed as stored ("Électronique")."""
    return or_(
        func.lower(func.coalesce(column, "")).like(_like(raw.lower()), escape="\\"),
        func.coalesce(column, "").like(_like(raw), escape="\\"),
    )


@router.get("/search", response_model=ProjectSearchResponse)
async def search_projects(
    q: str | None = Query(default=None, max_length=200),
    tag_ids: list[int] = Query(default=[]),
    tag_mode: Literal["any", "all"] = "any",
    status: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
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
            .where(_text_match(LibraryTag.name, term))
        )
        conditions.append(
            or_(
                _text_match(Project.code, term),
                _text_match(Project.name, term),
                _text_match(Project.description, term),
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


@router.get("/tags", response_model=list[ProjectTagCount])
async def list_project_tags(
    db: AsyncSession = Depends(get_db),
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


@router.post("/ai/reformulate", response_model=ProjectReformulateResponse)
async def reformulate_text(
    payload: ProjectReformulateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(_AI_WRITERS),
):
    """French rewording of a project title or description (spec §3.5). Shares
    the Aito OpenRouter budget: same bill, same bucket."""
    _check_ai_rate_limit(request, current_user)
    try:
        text, model = await reformulate_project_text(db, payload.text, payload.field)
    except OpenRouterNotConfiguredError:
        raise HTTPException(status_code=409, detail="OpenRouter is not configured") from None
    except OpenRouterUpstreamError as e:
        logger.warning("Project reformulate failed upstream: %s", e)
        raise HTTPException(status_code=502, detail=str(e)) from e
    return ProjectReformulateResponse(text=text, model=model)


@router.post("/ai/suggest-tags", response_model=ProjectSuggestTagsResponse)
async def suggest_tags(
    payload: ProjectSuggestTagsRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(_AI_WRITERS),
):
    """Up to five tags, catalogue first, at most two new names. Never applied:
    the client shows them as chips the operator accepts one by one."""
    _check_ai_rate_limit(request, current_user)
    catalogue_rows = (await db.execute(select(LibraryTag.id, LibraryTag.name).order_by(LibraryTag.name_key))).all()
    catalogue = {tag_name_key(name): ProjectTagRef(id=tag_id, name=name) for tag_id, name in catalogue_rows}
    try:
        raw, model = await suggest_project_tag_names(
            db, payload.title, payload.description, [name for _id, name in catalogue_rows]
        )
    except OpenRouterNotConfiguredError:
        raise HTTPException(status_code=409, detail="OpenRouter is not configured") from None
    except OpenRouterUpstreamError as e:
        logger.warning("Project tag suggestion failed upstream: %s", e)
        raise HTTPException(status_code=502, detail=str(e)) from e
    return ProjectSuggestTagsResponse(
        suggestions=rank_tag_suggestions(raw, catalogue, set(payload.exclude_tag_ids)), model=model
    )
