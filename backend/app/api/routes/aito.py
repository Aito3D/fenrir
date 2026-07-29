"""Aito production board: DB-backed Kanban with soft delete."""

import logging
from dataclasses import dataclass

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.user import User
from backend.app.schemas.aito import (
    AitoProjectCreate,
    AitoProjectImport,
    AitoProjectMove,
    AitoProjectResponse,
    AitoProjectUpdate,
    AitoTaskCreate,
    AitoTaskResponse,
    AitoTaskUpdate,
)
from backend.app.services.aito_board_rules import SERVICES, evaluate, pending_services

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/aito", tags=["aito"])


# Canonical order for `task_services`, fixed here so the card's badge row is
# stable across refetches regardless of the order tasks were created in.
_SERVICE_COLUMNS = (
    ("scan", AitoTask.scan_cost),
    ("modelisation", AitoTask.modelisation_cost),
    ("impression", AitoTask.impression_cost),
    ("usinage", AitoTask.usinage_cost),
)

# The same four services paired with their done flags, for the "pending"
# aggregate. Kept separate from _SERVICE_COLUMNS so that tuple stays the
# canonical badge order and nothing reading it has to skip a third element.
_SERVICE_DONE_COLUMNS = (
    ("scan", AitoTask.scan_cost, AitoTask.scan_done),
    ("modelisation", AitoTask.modelisation_cost, AitoTask.modelisation_done),
    ("impression", AitoTask.impression_cost, AitoTask.impression_done),
    ("usinage", AitoTask.usinage_cost, AitoTask.usinage_done),
)


@dataclass(frozen=True)
class _TaskSummary:
    count: int = 0
    total: float = 0.0
    services: tuple[str, ...] = ()
    # Services with at least one enabled-but-unticked step, which is all the
    # rule engine needs to place the card. Aggregated in the same GROUP BY as
    # the rest so the board still costs one query, not one per card.
    pending: tuple[str, ...] = ()


_EMPTY_SUMMARY = _TaskSummary()


async def _task_summaries(db: AsyncSession, project_ids: list[int]) -> dict[int, _TaskSummary]:
    """Task count, total and enabled-service set per project, in ONE query.

    Membership is tested with IS NOT NULL, never `> 0`: NULL means the service
    is disabled and 0 means it is free, and a service quoted at zero must still
    show its badge.

    The SUM() below mirrors `taskTotal` in frontend/src/utils/taskDraft.ts. The
    two are in different languages and cannot share code — if the definition of
    a task's total changes, it must be changed in both places.

    Projects with no tasks are absent from the result; callers fall back to
    ``_EMPTY_SUMMARY``.
    """
    if not project_ids:
        return {}
    stmt = (
        select(
            AitoTask.project_id,
            func.count().label("n"),
            func.sum(
                func.coalesce(AitoTask.scan_cost, 0.0)
                + func.coalesce(AitoTask.modelisation_cost, 0.0)
                + func.coalesce(AitoTask.usinage_cost, 0.0)
                + func.coalesce(AitoTask.impression_cost, 0.0)
            ).label("total"),
            *[
                func.max(case((column.is_not(None), 1), else_=0)).label(f"svc_{name}")
                for name, column in _SERVICE_COLUMNS
            ],
            *[
                func.max(case(((column.is_not(None)) & (done.is_(False)), 1), else_=0)).label(f"pend_{name}")
                for name, column, done in _SERVICE_DONE_COLUMNS
            ],
        )
        .where(AitoTask.project_id.in_(project_ids))
        .group_by(AitoTask.project_id)
    )
    return {
        row.project_id: _TaskSummary(
            count=row.n,
            total=float(row.total or 0.0),
            services=tuple(name for name, _ in _SERVICE_COLUMNS if getattr(row, f"svc_{name}")),
            pending=tuple(name for name, _, _ in _SERVICE_DONE_COLUMNS if getattr(row, f"pend_{name}")),
        )
        for row in (await db.execute(stmt)).all()
    }


async def _one_summary(db: AsyncSession, project_id: int) -> _TaskSummary:
    """Summary for a single project, for the endpoints that return one card."""
    return (await _task_summaries(db, [project_id])).get(project_id, _EMPTY_SUMMARY)


def _to_response(p: AitoProject, summary: _TaskSummary) -> AitoProjectResponse:
    """`summary` is required, never defaulted. The detail panel writes PATCH
    responses straight into the board cache with setQueryData, replacing the
    row — so an endpoint that quietly returned zeros would blank a card's
    badges and nothing would fail. Requiring it makes every call site state
    its intent."""
    _, lock = evaluate(p.quote_status, p.board_column, summary.pending)
    return AitoProjectResponse(
        id=p.id,
        description=p.description,
        column=p.board_column,
        position=p.position,
        status=p.status,
        client_id=p.client_id,
        client_name=p.client_name,
        client_phone=p.client_phone,
        client_email=p.client_email,
        client_is_company=p.client_is_company,
        quote_id=p.quote_id,
        quote_number=p.quote_number,
        quote_date=p.quote_date,
        quote_total=p.quote_total,
        quote_url=p.quote_url,
        quote_salesperson=p.quote_salesperson,
        quote_status=p.quote_status,
        created_by=p.created_by,
        quote_sync_state=p.quote_sync_state or "idle",
        quote_sync_error=p.quote_sync_error,
        task_count=summary.count,
        tasks_total=summary.total,
        task_services=list(summary.services),
        move_lock=lock,
        created_at=p.created_at,
        updated_at=p.updated_at,
    )


def _task_to_response(t: AitoTask) -> AitoTaskResponse:
    return AitoTaskResponse(
        id=t.id,
        project_id=t.project_id,
        position=t.position,
        title=t.title,
        description=t.description,
        scan_cost=t.scan_cost,
        modelisation_cost=t.modelisation_cost,
        usinage_cost=t.usinage_cost,
        impression_printer_id=t.impression_printer_id,
        impression_filament_id=t.impression_filament_id,
        impression_weight_g=t.impression_weight_g,
        impression_time_min=t.impression_time_min,
        impression_quantity=t.impression_quantity,
        impression_color=t.impression_color,
        impression_cost=t.impression_cost,
        scan_done=t.scan_done,
        modelisation_done=t.modelisation_done,
        impression_done=t.impression_done,
        usinage_done=t.usinage_done,
        created_at=t.created_at,
        updated_at=t.updated_at,
    )


async def _active_in_column(db: AsyncSession, column: str, exclude_id: int | None = None) -> list[AitoProject]:
    stmt = (
        select(AitoProject)
        .where(AitoProject.status == "active", AitoProject.board_column == column)
        .order_by(AitoProject.position, AitoProject.id)
    )
    rows = list((await db.execute(stmt)).scalars().all())
    return [r for r in rows if r.id != exclude_id]


async def _apply_rules(db: AsyncSession, project: AitoProject) -> None:
    """Recompute ``project.board_column`` from the rules and relocate it.

    An advancing project is appended to the END of its destination column —
    work arriving at a stage joins the back of that stage's queue — and the
    source column is renumbered contiguously. Both column listings are read
    BEFORE the row is mutated, so autoflush cannot make the second query
    observe the half-applied move.

    Does not commit: every caller is already inside a request that does.
    """
    rows = (await db.execute(select(AitoTask).where(AitoTask.project_id == project.id))).scalars().all()
    column, _ = evaluate(project.quote_status, project.board_column, pending_services(rows))
    if column == project.board_column:
        return

    source = project.board_column
    destination_rows = await _active_in_column(db, column, exclude_id=project.id)
    source_rows = await _active_in_column(db, source, exclude_id=project.id)
    project.board_column = column
    project.position = len(destination_rows)
    for index, row in enumerate(source_rows):
        row.position = index


def _mark_pending(project: AitoProject) -> None:
    """Hand the project to the Zoho sync worker.

    The only thing a request path ever does about Zoho. Clearing the failure
    counter is what makes an edit the natural way to retry a project stuck in
    'error' — the user fixes whatever Books objected to and saves.
    """
    project.quote_sync_state = "pending"
    project.quote_sync_failures = 0


async def _mark_project_pending_for_task(db: AsyncSession, project_id: int) -> AitoProject | None:
    """Task endpoints address a task, not a project, so the parent has to be
    loaded to be marked. A missing parent is not an error here: the task's own
    404 already covers the case that matters. Returns the project (or None) so
    callers that also need to run `_apply_rules` on it don't load it twice."""
    project = (await db.execute(select(AitoProject).where(AitoProject.id == project_id))).scalar_one_or_none()
    if project:
        _mark_pending(project)
    return project


@router.get("/", response_model=list[AitoProjectResponse])
async def list_projects(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_READ),
):
    stmt = (
        select(AitoProject)
        .where(AitoProject.status == "active")
        .order_by(AitoProject.board_column, AitoProject.position, AitoProject.id)
    )
    projects = list((await db.execute(stmt)).scalars().all())
    summaries = await _task_summaries(db, [p.id for p in projects])
    return [_to_response(p, summaries.get(p.id, _EMPTY_SUMMARY)) for p in projects]


@router.get("/trash", response_model=list[AitoProjectResponse])
async def list_trash(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_READ),
):
    """Deleted projects, newest deletions first. Rows are never removed."""
    stmt = (
        select(AitoProject)
        .where(AitoProject.status == "deleted")
        .order_by(AitoProject.updated_at.desc(), AitoProject.id.desc())
    )
    projects = list((await db.execute(stmt)).scalars().all())
    summaries = await _task_summaries(db, [p.id for p in projects])
    return [_to_response(p, summaries.get(p.id, _EMPTY_SUMMARY)) for p in projects]


@router.post("/", response_model=AitoProjectResponse, status_code=201)
async def create_project(
    payload: AitoProjectCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE),
):
    # New cards land on top of the quote column: shift existing cards down.
    for row in await _active_in_column(db, "devis"):
        row.position += 1
    project = AitoProject(
        description=payload.description.strip(),
        board_column="devis",
        position=0,
        client_id=payload.client_id,
        client_name=payload.client_name,
        client_phone=payload.client_phone,
        client_email=payload.client_email,
        client_is_company=payload.client_is_company,
        quote_id=payload.quote_id,
        quote_number=payload.quote_number,
        quote_date=payload.quote_date,
        quote_total=payload.quote_total,
        quote_url=payload.quote_url,
        quote_salesperson=payload.quote_salesperson,
        quote_status=payload.quote_status,
        # None when auth is disabled, and for API-key requests — the dependency
        # returns None for both rather than a synthetic user.
        created_by=current_user.username if current_user else None,
    )
    db.add(project)
    _mark_pending(project)
    # Flush so the project has an id the tasks can reference; one commit still
    # covers both, so a failure creates neither.
    await db.flush()
    for position, task_payload in enumerate(payload.tasks):
        db.add(AitoTask(project_id=project.id, position=position, **task_payload.model_dump()))
    await _apply_rules(db, project)
    await db.commit()
    await db.refresh(project)
    return _to_response(project, await _one_summary(db, project.id))


@router.get("/{project_id}/tasks", response_model=list[AitoTaskResponse])
async def list_tasks(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_READ),
):
    stmt = select(AitoTask).where(AitoTask.project_id == project_id).order_by(AitoTask.position, AitoTask.id)
    return [_task_to_response(t) for t in (await db.execute(stmt)).scalars().all()]


async def _get_task_or_404(db: AsyncSession, task_id: int) -> AitoTask:
    task = (await db.execute(select(AitoTask).where(AitoTask.id == task_id))).scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.post("/{project_id}/tasks", response_model=AitoTaskResponse, status_code=201)
async def add_task(
    project_id: int,
    payload: AitoTaskCreate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE),
):
    project = (await db.execute(select(AitoProject).where(AitoProject.id == project_id))).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    _mark_pending(project)
    highest = await db.scalar(select(func.max(AitoTask.position)).where(AitoTask.project_id == project_id))
    task = AitoTask(project_id=project_id, position=(highest + 1) if highest is not None else 0, **payload.model_dump())
    db.add(task)
    await db.flush()  # so _apply_rules' SELECT sees the new row
    await _apply_rules(db, project)
    await db.commit()
    await db.refresh(task)
    return _task_to_response(task)


@router.patch("/tasks/{task_id}", response_model=AitoTaskResponse)
async def update_task(
    task_id: int,
    payload: AitoTaskUpdate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    """Only fields present in the body are written, so an omitted key is left
    alone and an explicit null disables that service.

    Two invariants hold across the write:

    - Clearing a cost to NULL clears its done flag. The step no longer exists,
      and leaving the flag set would bring the service back pre-ticked if it
      were ever re-enabled.
    - A done flag may not be set for a service with no cost. Checked against
      the MERGED row rather than the stored one, so enabling a service and
      ticking it in the same PATCH is legal while ticking a service that stays
      absent is a 422.
    """
    task = await _get_task_or_404(db, task_id)
    fields = payload.model_dump(exclude_unset=True)

    for service in SERVICES:
        cost_key, done_key = f"{service}_cost", f"{service}_done"
        merged_cost = fields.get(cost_key, getattr(task, cost_key))
        merged_done = fields.get(done_key, getattr(task, done_key))
        if merged_cost is None:
            if fields.get(done_key):
                raise HTTPException(status_code=422, detail=f"{service} has no cost, so it cannot be marked done")
            if merged_done:
                fields[done_key] = False

    for key, value in fields.items():
        setattr(task, key, value)
    project = await _mark_project_pending_for_task(db, task.project_id)
    if project:
        await _apply_rules(db, project)
    await db.commit()
    await db.refresh(task)
    return _task_to_response(task)


@router.delete("/tasks/{task_id}", status_code=204)
async def delete_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_DELETE),
):
    """Hard delete, unlike projects: tasks need no stable visible number, and
    hold-to-remove is already a deliberate gesture."""
    task = await _get_task_or_404(db, task_id)
    project = await _mark_project_pending_for_task(db, task.project_id)
    await db.delete(task)
    await db.flush()  # so the deleted row is out of _apply_rules' SELECT
    if project:
        await _apply_rules(db, project)
    await db.commit()


@router.post("/import", response_model=list[AitoProjectResponse], status_code=201)
async def import_legacy_projects(
    payload: AitoProjectImport,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE),
):
    """One-time localStorage migration. Guard counts ALL rows (incl. soft-deleted)
    so a double-fire can never duplicate the board."""
    total = await db.scalar(select(func.count(AitoProject.id)))
    if total:
        raise HTTPException(status_code=409, detail="Aito board is not empty")
    created = []
    for item in payload.projects:
        p = AitoProject(description=item.description, board_column=item.column, position=item.position)
        db.add(p)
        created.append(p)
    await db.commit()
    for p in created:
        await db.refresh(p)
    # Imported projects are task-free by construction: the legacy localStorage
    # board had no concept of tasks.
    return [_to_response(p, _EMPTY_SUMMARY) for p in created]


@router.patch("/{project_id}/move", response_model=AitoProjectResponse)
async def move_project(
    project_id: int,
    payload: AitoProjectMove,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    project = (
        await db.execute(select(AitoProject).where(AitoProject.id == project_id, AitoProject.status == "active"))
    ).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    source_column = project.board_column
    destination = await _active_in_column(db, payload.column, exclude_id=project.id)
    insert_at = min(payload.position, len(destination))
    destination.insert(insert_at, project)
    project.board_column = payload.column
    for i, row in enumerate(destination):
        row.position = i
    if source_column != payload.column:
        for i, row in enumerate(await _active_in_column(db, source_column, exclude_id=project.id)):
            row.position = i
    await db.commit()
    await db.refresh(project)
    return _to_response(project, await _one_summary(db, project.id))


@router.patch("/{project_id}", response_model=AitoProjectResponse)
async def update_project(
    project_id: int,
    payload: AitoProjectUpdate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    """Edit a card's content. Only fields present in the body are written, so a
    null client_phone clears it while an omitted one is left alone."""
    project = (
        await db.execute(select(AitoProject).where(AitoProject.id == project_id, AitoProject.status == "active"))
    ).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    fields = payload.model_dump(exclude_unset=True)

    # The client fields are a snapshot, so consistency has to hold for the MERGED
    # row, not just the payload: a lone {"client_name": null} passes any
    # payload-only check while leaving client_id pointing at a contact with no
    # name attached.
    merged_client_id = fields.get("client_id", project.client_id)
    merged_client_name = fields.get("client_name", project.client_name)
    if merged_client_id is not None and not merged_client_name:
        raise HTTPException(status_code=422, detail="client_name is required when client_id is set")

    if "description" in fields:
        project.description = fields["description"].strip()
    for key in ("client_id", "client_name", "client_phone", "client_email", "client_is_company"):
        if key in fields:
            setattr(project, key, fields[key])
    _mark_pending(project)
    await db.commit()
    await db.refresh(project)
    return _to_response(project, await _one_summary(db, project.id))


@router.post("/{project_id}/restore", response_model=AitoProjectResponse)
async def restore_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    """Un-delete: back onto the board at the end of its original column."""
    project = (
        await db.execute(select(AitoProject).where(AitoProject.id == project_id, AitoProject.status == "deleted"))
    ).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Deleted project not found")
    # Compute the append position before flipping status: autoflush would otherwise
    # include this row in its own column's active count.
    position = len(await _active_in_column(db, project.board_column))
    project.status = "active"
    project.position = position
    _mark_pending(project)
    await _apply_rules(db, project)
    await db.commit()
    await db.refresh(project)
    return _to_response(project, await _one_summary(db, project.id))


@router.delete("/{project_id}", status_code=204)
async def delete_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_DELETE),
):
    """Soft delete: the row is kept forever, only hidden from the board."""
    project = (
        await db.execute(select(AitoProject).where(AitoProject.id == project_id, AitoProject.status == "active"))
    ).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    project.status = "deleted"
    _mark_pending(project)
    await db.commit()
