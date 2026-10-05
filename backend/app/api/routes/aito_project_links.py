"""Aito task ↔ Fenrir project link routes (spec §1.6, §4).

Registered before ``aito.router`` so the literal ``/aito/project-codes`` is
never captured by a ``/aito/{project_id}`` route. Links are production
metadata: nothing here touches the order's quote state or versioned fields.
"""

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.project_files import content_length_capped_route
from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.user import User
from backend.app.schemas.aito_project_links import (
    DropFilesResponse,
    OrderProjectLinks,
    ProjectSuggestion,
    TaskCreateProjectRequest,
    TaskDeliveriesRequest,
    TaskLinkRequest,
    TaskProjectLink,
)
from backend.app.services import aito_project_links as svc, project_files

router = APIRouter(prefix="/aito", tags=["aito"])

# The file-drop route: same pre-body Content-Length gate as the project upload routes,
# authorised with aito:update + projects:update.
drop_router = APIRouter(
    prefix="/aito",
    tags=["aito"],
    route_class=content_length_capped_route(Permission.AITO_UPDATE, Permission.PROJECTS_UPDATE),
)

_aito_read = RequirePermissionIfAuthEnabled(Permission.AITO_READ)
_aito_update = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE)
_projects_read = RequirePermissionIfAuthEnabled(Permission.PROJECTS_READ)
_projects_update = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE)
_projects_create = RequirePermissionIfAuthEnabled(Permission.PROJECTS_CREATE)


def _actor(user: User | None) -> str | None:
    return user.username if user is not None else None


async def _broadcast_changed(order_id: int, actor: str | None) -> None:
    """Best-effort board refresh signal after commit (same payload as aito.py)."""
    await svc.broadcast_orders_changed([order_id], actor)


async def _task(db: AsyncSession, task_id: int) -> AitoTask:
    """A task, only through a non-deleted order."""
    task = (
        await db.execute(
            select(AitoTask)
            .join(AitoProject, AitoProject.id == AitoTask.project_id)
            .where(AitoTask.id == task_id, AitoProject.status != "deleted")
        )
    ).scalar_one_or_none()
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


async def _task_link(db: AsyncSession, task: AitoTask) -> TaskProjectLink:
    links = await svc.order_links(db, task.project_id)
    link = next((t for t in links.tasks if t.task_id == task.id), None)
    if link is None:  # deleted or moved by someone else meanwhile
        raise HTTPException(status_code=404, detail="Task not found")
    return link


async def _commit_link(db: AsyncSession, task: AitoTask, actor: str | None) -> TaskProjectLink:
    order_id = task.project_id
    await db.commit()
    await _broadcast_changed(order_id, actor)
    return await _task_link(db, task)


@router.get("/project-codes")
async def get_project_codes(
    db: AsyncSession = Depends(get_db),
    _: User | None = _aito_read,
    __: User | None = _projects_read,
) -> dict[int, list[str]]:
    return await svc.codes_by_order(db)


@router.get("/tasks/{task_id}/project-suggestions")
async def get_project_suggestions(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = _aito_read,
    __: User | None = _projects_read,
) -> list[ProjectSuggestion]:
    return await svc.suggest_projects(db, await _task(db, task_id))


@router.put("/tasks/{task_id}/project")
async def put_task_project(
    task_id: int,
    body: TaskLinkRequest,
    db: AsyncSession = Depends(get_db),
    user: User | None = _aito_update,
    __: User | None = _projects_read,
) -> TaskProjectLink:
    task = await _task(db, task_id)
    try:
        await svc.link_task(db, task, body.project_id, actor=_actor(user))
    except svc.LinkError as exc:
        await db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    return await _commit_link(db, task, _actor(user))


@router.post("/tasks/{task_id}/project", status_code=201)
async def post_task_project(
    task_id: int,
    body: TaskCreateProjectRequest,
    db: AsyncSession = Depends(get_db),
    user: User | None = _aito_update,
    __: User | None = _projects_create,
) -> TaskProjectLink:
    task = await _task(db, task_id)
    try:
        await svc.create_project_for_task(
            db,
            task,
            name=body.name,
            description=body.description,
            tag_ids=body.tag_ids,
            new_tag_names=body.new_tag_names,
            actor=_actor(user),
        )
    except svc.LinkError as exc:
        await db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    return await _commit_link(db, task, _actor(user))


@router.put("/tasks/{task_id}/deliveries")
async def put_task_deliveries(
    task_id: int,
    body: TaskDeliveriesRequest,
    db: AsyncSession = Depends(get_db),
    user: User | None = _aito_update,
    __: User | None = _projects_read,
) -> TaskProjectLink:
    task = await _task(db, task_id)
    try:
        await svc.set_deliveries(db, task, body.revision_ids, actor=_actor(user), user_id=user.id if user else None)
    except svc.LinkError as exc:
        await db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    return await _commit_link(db, task, _actor(user))


@drop_router.post("/tasks/{task_id}/files", status_code=201)
async def drop_task_files(
    task_id: int,
    files: list[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    user: User | None = _aito_update,
    __: User | None = _projects_update,
) -> DropFilesResponse:
    """Drop files on a linked task: sorted into sections by extension, one revision per item name."""
    task = await _task(db, task_id)
    order_id = task.project_id
    try:
        response = await svc.drop_files_on_task(db, task, files, user_id=user.id if user else None, actor=_actor(user))
    except svc.LinkError as exc:
        await db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except project_files.ProjectFilesError as exc:
        if getattr(exc, "stored_count", 0):
            await _broadcast_changed(order_id, _actor(user))
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    await _broadcast_changed(order_id, _actor(user))
    return response


@router.get("/{order_id}/project-links")
async def get_project_links(
    order_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = _aito_read,
    __: User | None = _projects_read,
) -> OrderProjectLinks:
    order = await db.get(AitoProject, order_id)
    if order is None or order.status == "deleted":
        raise HTTPException(status_code=404, detail="Project not found")
    return await svc.order_links(db, order_id)
