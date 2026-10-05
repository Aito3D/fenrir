"""Aito tasks linked to Fenrir projects (spec §1.6, §4).

A task links to at most one project; a project has many tasks across orders
and clients. Nothing here goes through the task PATCH path or touches the
order's quote state (``quote_sync_state``) or its versioned fields: a link is
production metadata, not part of the quote, so it must never queue a Zoho push
or bump the order's version. Deliberately independent of
``api/routes/aito.py``; the models are read directly.

Functions flush, never commit — the route owns the transaction.
"""

import logging
from collections import defaultdict
from difflib import SequenceMatcher

from fastapi import UploadFile
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.aito_task_delivery import AitoTaskDelivery
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.app.schemas.aito_project_links import (
    DropFilesResponse,
    DroppedFileResult,
    LinkedProjectRef,
    OrderProjectLinks,
    ProjectOrdersResponse,
    ProjectOrderTask,
    ProjectSuggestion,
    SectionRevisionSummary,
    TaskProjectLink,
)
from backend.app.schemas.project_files import RevisionRef
from backend.app.services import aito_events, project_files
from backend.app.services.project_tags import UnknownTagError, apply_project_tag_input

logger = logging.getLogger(__name__)

SIMILAR_TITLE_THRESHOLD = 0.45
SECTION_SUMMARY_LIMIT = 3


class LinkError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _actor_class(actor: str | None) -> str:
    return "user" if actor else "system"


def _project_detail(project_id: int, project: Project | None) -> dict:
    return {
        "project_id": project_id,
        "code": project.code if project else None,
        "name": project.name if project else None,
    }


def _revision_label(item: ProjectItem | None, revision: ProjectRevision | None, revision_id: int) -> str:
    if item is None or revision is None:
        return f"#{revision_id}"
    return f"{item.name} R{revision.number}"


async def _clear_deliveries(db: AsyncSession, task_id: int) -> None:
    await db.execute(delete(AitoTaskDelivery).where(AitoTaskDelivery.task_id == task_id))


async def link_task(db: AsyncSession, task: AitoTask, project_id: int | None, *, actor: str | None) -> AitoTask:
    """Link ``task`` to ``project_id`` (or unlink with None). Leaving a project
    drops the task's deliveries, which only make sense within that project."""
    previous_id = task.linked_project_id
    if project_id == previous_id:
        return task

    project = await db.get(Project, project_id) if project_id is not None else None
    if project_id is not None and project is None:
        raise LinkError(404, "Project not found")
    if project is not None and project.is_template:
        raise LinkError(400, "A template cannot be linked to a task")

    previous = await db.get(Project, previous_id) if previous_id is not None else None
    if previous_id is not None:
        await _clear_deliveries(db, task.id)
    task.linked_project_id = project_id
    await db.flush()

    if project is not None:
        kind, detail = "task.project_linked", _project_detail(project.id, project)
        if previous_id is not None:
            detail["previous_project_id"] = previous_id
            detail["previous_code"] = previous.code if previous else None
    else:
        kind = "task.project_unlinked"
        detail = _project_detail(previous_id, previous)
    await aito_events.record(
        db,
        task.project_id,
        kind,
        actor_class=_actor_class(actor),
        actor_name=actor,
        subject_type="task",
        subject_id=task.id,
        subject_label=task.title,
        detail=detail,
    )
    return task


async def create_project_for_task(
    db: AsyncSession,
    task: AitoTask,
    *,
    name: str,
    description: str | None,
    tag_ids: list[int] | None,
    new_tag_names: list[str] | None,
    actor: str | None,
) -> Project:
    """New project (its P-#### code comes from the model listener), tagged, and linked to ``task``."""
    project = Project(name=name, description=description)
    db.add(project)
    await db.flush()
    try:
        await apply_project_tag_input(db, project, tag_ids=tag_ids or [], new_tag_names=new_tag_names or [])
    except UnknownTagError as exc:
        raise LinkError(400, str(exc)) from exc
    await link_task(db, task, project.id, actor=actor)
    return project


async def suggest_projects(db: AsyncSession, task: AitoTask, limit: int = 8) -> list[ProjectSuggestion]:
    """Likely projects for ``task``: the same client's linked projects (most
    recent link first), then projects with a similar name (best first)."""
    excluded = {task.linked_project_id} if task.linked_project_id is not None else set()
    suggestions: list[ProjectSuggestion] = []

    def add(project_id: int, code: str | None, name: str, reason: str) -> None:
        if project_id in excluded or len(suggestions) >= limit:
            return
        excluded.add(project_id)
        suggestions.append(ProjectSuggestion(id=project_id, code=code, name=name, reason=reason))

    client_id = (
        await db.execute(select(AitoProject.client_id).where(AitoProject.id == task.project_id))
    ).scalar_one_or_none()
    if client_id:
        # No link timestamp exists; the newest linking task id stands in for it.
        latest = func.max(AitoTask.id).label("latest")
        rows = await db.execute(
            select(Project.id, Project.code, Project.name, latest)
            .join(AitoTask, AitoTask.linked_project_id == Project.id)
            .join(AitoProject, AitoProject.id == AitoTask.project_id)
            .where(
                AitoProject.client_id == client_id,
                AitoProject.status != "deleted",
                Project.is_template.is_not(True),
            )
            .group_by(Project.id, Project.code, Project.name)
            .order_by(latest.desc())
        )
        for project_id, code, name, _latest in rows:
            add(project_id, code, name, "same_client")

    title = (task.title or "").strip().casefold()
    if title and len(suggestions) < limit:
        candidates = await db.execute(
            select(Project.id, Project.code, Project.name).where(Project.is_template.is_not(True))
        )
        scored = []
        for project_id, code, name in candidates:
            if project_id in excluded:
                continue
            ratio = SequenceMatcher(None, title, (name or "").casefold()).ratio()
            if ratio >= SIMILAR_TITLE_THRESHOLD:
                scored.append((ratio, project_id, code, name))
        scored.sort(key=lambda row: (-row[0], row[1]))
        for _ratio, project_id, code, name in scored:
            add(project_id, code, name, "similar_title")
    return suggestions


async def _revision_bundles(
    db: AsyncSession, revision_ids: list[int]
) -> dict[int, tuple[ProjectRevision, ProjectItem]]:
    if not revision_ids:
        return {}
    rows = await db.execute(
        select(ProjectRevision, ProjectItem)
        .join(ProjectItem, ProjectItem.id == ProjectRevision.item_id)
        .where(ProjectRevision.id.in_(revision_ids))
    )
    return {revision.id: (revision, item) for revision, item in rows}


async def set_deliveries(
    db: AsyncSession, task: AitoTask, revision_ids: list[int], *, actor: str | None, user_id: int | None = None
) -> list[int]:
    """Replace the revisions ``task`` delivered. They must all belong to the
    task's linked project. Records one event when the set changed."""
    if task.linked_project_id is None:
        raise LinkError(409, "Task is not linked to a project")
    wanted = list(dict.fromkeys(revision_ids))
    bundles = await _revision_bundles(db, wanted)
    offenders = [rid for rid in wanted if rid not in bundles or bundles[rid][1].project_id != task.linked_project_id]
    if offenders:
        raise LinkError(400, "Revisions not in the linked project: " + ", ".join(str(rid) for rid in offenders))

    current = set(
        (await db.execute(select(AitoTaskDelivery.revision_id).where(AitoTaskDelivery.task_id == task.id))).scalars()
    )
    added = [rid for rid in wanted if rid not in current]
    removed = sorted(current - set(wanted))
    if not added and not removed:
        return wanted

    if removed:
        await db.execute(
            delete(AitoTaskDelivery).where(
                AitoTaskDelivery.task_id == task.id, AitoTaskDelivery.revision_id.in_(removed)
            )
        )
    db.add_all(AitoTaskDelivery(task_id=task.id, revision_id=rid, created_by_id=user_id) for rid in added)
    await db.flush()

    removed_bundles = await _revision_bundles(db, removed)

    def label(rid: int, source: dict) -> str:
        revision, item = source.get(rid, (None, None))
        return _revision_label(item, revision, rid)

    await aito_events.record(
        db,
        task.project_id,
        "task.deliveries_changed",
        actor_class=_actor_class(actor),
        actor_name=actor,
        subject_type="task",
        subject_id=task.id,
        subject_label=task.title,
        detail={
            "added": [label(rid, bundles) for rid in added],
            "removed": [label(rid, removed_bundles) for rid in removed],
        },
    )
    return wanted


async def order_links(db: AsyncSession, order_id: int) -> OrderProjectLinks:
    """Every task of the order with its linked project, a per-section summary
    (newest revision of up to three items, newest activity first) and its
    delivered revision ids. One query per table."""
    tasks = list(
        (
            await db.execute(
                select(AitoTask).where(AitoTask.project_id == order_id).order_by(AitoTask.position, AitoTask.id)
            )
        ).scalars()
    )
    project_ids = {t.linked_project_id for t in tasks if t.linked_project_id is not None}
    task_ids = [t.id for t in tasks]

    projects: dict[int, Project] = {}
    sections_by_project: dict[int, dict[str, list[SectionRevisionSummary]]] = defaultdict(dict)
    if project_ids:
        projects = {p.id: p for p in (await db.execute(select(Project).where(Project.id.in_(project_ids)))).scalars()}
        items = {
            i.id: i
            for i in (await db.execute(select(ProjectItem).where(ProjectItem.project_id.in_(project_ids)))).scalars()
        }
        if items:
            # Numbers only grow, so the highest number is the newest revision.
            newest = (
                select(ProjectRevision.item_id, func.max(ProjectRevision.number).label("number"))
                .where(ProjectRevision.item_id.in_(list(items)))
                .group_by(ProjectRevision.item_id)
                .subquery()
            )
            revisions = (
                await db.execute(
                    select(ProjectRevision)
                    .join(
                        newest,
                        (newest.c.item_id == ProjectRevision.item_id) & (newest.c.number == ProjectRevision.number),
                    )
                    .order_by(ProjectRevision.created_at.desc(), ProjectRevision.id.desc())
                )
            ).scalars()
            for revision in revisions:
                item = items[revision.item_id]
                section = sections_by_project[item.project_id].setdefault(item.section, [])
                if len(section) < SECTION_SUMMARY_LIMIT:
                    section.append(
                        SectionRevisionSummary(
                            item_id=item.id, item_name=item.name, number=revision.number, status=revision.status
                        )
                    )

    deliveries: dict[int, list[int]] = defaultdict(list)
    if task_ids:
        rows = await db.execute(
            select(AitoTaskDelivery.task_id, AitoTaskDelivery.revision_id)
            .where(AitoTaskDelivery.task_id.in_(task_ids))
            .order_by(AitoTaskDelivery.created_at, AitoTaskDelivery.revision_id)
        )
        for task_id, revision_id in rows:
            deliveries[task_id].append(revision_id)

    result = []
    for task in tasks:
        project = projects.get(task.linked_project_id) if task.linked_project_id is not None else None
        result.append(
            TaskProjectLink(
                task_id=task.id,
                project=LinkedProjectRef(id=project.id, code=project.code, name=project.name) if project else None,
                sections=dict(sections_by_project.get(project.id, {})) if project else {},
                deliveries=deliveries.get(task.id, []),
            )
        )
    return OrderProjectLinks(order_id=order_id, tasks=result)


async def codes_by_order(db: AsyncSession) -> dict[int, list[str]]:
    """Distinct project codes per active order, for the board card chips."""
    rows = await db.execute(
        select(AitoTask.project_id, Project.code)
        .join(Project, Project.id == AitoTask.linked_project_id)
        .join(AitoProject, AitoProject.id == AitoTask.project_id)
        .where(AitoProject.status != "deleted", Project.code.is_not(None))
        .group_by(AitoTask.project_id, Project.code)
        .order_by(AitoTask.project_id, Project.code)
    )
    codes: dict[int, list[str]] = defaultdict(list)
    for order_id, code in rows:
        codes[order_id].append(code)
    return dict(codes)


async def orders_for_project(db: AsyncSession, project_id: int) -> ProjectOrdersResponse:
    """Tasks of non-deleted orders linking to the project, newest order first,
    with the revisions each delivered."""
    rows = list(
        await db.execute(
            select(AitoTask, AitoProject)
            .join(AitoProject, AitoProject.id == AitoTask.project_id)
            .where(AitoTask.linked_project_id == project_id, AitoProject.status != "deleted")
            .order_by(AitoProject.created_at.desc(), AitoProject.id.desc(), AitoTask.id.desc())
        )
    )
    delivered: dict[int, list[RevisionRef]] = defaultdict(list)
    task_ids = [task.id for task, _order in rows]
    if task_ids:
        refs = await db.execute(
            select(AitoTaskDelivery.task_id, ProjectRevision, ProjectItem)
            .join(ProjectRevision, ProjectRevision.id == AitoTaskDelivery.revision_id)
            .join(ProjectItem, ProjectItem.id == ProjectRevision.item_id)
            .where(AitoTaskDelivery.task_id.in_(task_ids))
            .order_by(ProjectItem.section, ProjectItem.name, ProjectRevision.number)
        )
        for task_id, revision, item in refs:
            delivered[task_id].append(
                RevisionRef(
                    id=revision.id,
                    item_id=item.id,
                    item_name=item.name,
                    section=item.section,
                    number=revision.number,
                    status=revision.status,
                )
            )
    return ProjectOrdersResponse(
        orders=[
            ProjectOrderTask(
                task_id=task.id,
                task_title=task.title,
                order_id=order.id,
                order_description=order.description,
                client_name=order.client_name,
                board_column=order.board_column,
                created_at=order.created_at,
                deliveries=delivered.get(task.id, []),
            )
            for task, order in rows
        ]
    )


async def record_on_linked_orders(
    db: AsyncSession,
    project_id: int,
    kind: str,
    *,
    actor: str | None,
    subject_label: str | None,
    detail: dict | None,
) -> int:
    """One event per distinct active order with a task linked to the project.

    ``subject_type`` stays empty: on the order timeline "project" means the
    order itself, so the PDM project travels in ``detail`` (id and code)."""
    order_ids = (
        await db.execute(
            select(AitoTask.project_id)
            .join(AitoProject, AitoProject.id == AitoTask.project_id)
            .where(AitoTask.linked_project_id == project_id, AitoProject.status != "deleted")
            .distinct()
            .order_by(AitoTask.project_id)
        )
    ).scalars()
    order_ids = list(order_ids)
    if not order_ids:
        return 0
    code = (await db.execute(select(Project.code).where(Project.id == project_id))).scalar_one_or_none()
    payload = {"project_id": project_id, "code": code, **(detail or {})}
    recorded = 0
    for order_id in order_ids:
        event = await aito_events.record(
            db,
            order_id,
            kind,
            actor_class=_actor_class(actor),
            actor_name=actor,
            subject_label=subject_label,
            detail=dict(payload),
        )
        if event is not None:
            recorded += 1
    return recorded


# --- file drops (spec §4.3) -------------------------------------------------

_DROP_SECTIONS = {
    "scan": (".ply", ".obj", ".e57", ".xyz", ".pts"),
    "modelisation": (".step", ".stp", ".iges", ".igs", ".f3d", ".stl", ".sldprt"),
    "impression": (".3mf", ".gcode", ".bgcode"),
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


def _base_name(upload: UploadFile) -> str:
    return (upload.filename or "").replace("\\", "/").rsplit("/", 1)[-1]


async def _record_drop(
    db: AsyncSession,
    order_id: int,
    project_id: int,
    code: str | None,
    results: list[DroppedFileResult],
    actor: str | None,
) -> None:
    sections = sorted({r.section for r in results})
    await aito_events.record(
        db,
        order_id,
        "project.files_dropped",
        actor_class=_actor_class(actor),
        actor_name=actor,
        subject_label=f"{len(results)} file(s)",
        detail={
            "project_id": project_id,
            "code": code,
            "sections": sections,
            "results": [r.model_dump() for r in results],
        },
    )


async def drop_files_on_task(
    db: AsyncSession, task: AitoTask, uploads: list[UploadFile], *, user_id: int | None, actor: str | None
) -> DropFilesResponse:
    """Drop files on a linked task: each (section, item name) group becomes the next
    revision of the existing item, or R1 of a new one. Commits.

    Goes through the phase-2 service so streaming-before-DB, per-item locks and
    cleanup apply. ``add_revision`` rolls the whole session back on failure, so
    each created item is committed first. If a later group fails, the groups
    already stored are still recorded on the order before the error propagates."""
    if task.linked_project_id is None:
        raise LinkError(409, "Task is not linked to a project")
    if not uploads:
        raise LinkError(400, "No files to drop")
    project = await db.get(Project, task.linked_project_id)
    if project is None:
        raise LinkError(409, "Task is not linked to a project")
    project_id, code, order_id = project.id, project.code, task.project_id

    groups: dict[tuple[str, str], tuple[str, list[UploadFile]]] = {}
    for upload in uploads:
        filename = _base_name(upload)
        name = item_name_for_filename(filename)
        key = (section_for_filename(filename), project_files._name_key(name))
        groups.setdefault(key, (name, []))[1].append(upload)

    results: list[DroppedFileResult] = []
    try:
        for (section, key), (name, group) in groups.items():
            item = (
                await db.execute(
                    select(ProjectItem).where(
                        ProjectItem.project_id == project_id,
                        ProjectItem.section == section,
                        ProjectItem.name_key == key,
                    )
                )
            ).scalar_one_or_none()
            if item is None:
                item = await project_files.create_item(db, project, section=section, name=name, user_id=user_id)
                await db.commit()
            item_id, item_name = item.id, item.name
            revision, _warnings = await project_files.add_revision(
                db, project, item, group, note=None, derived_from_id=None, user_id=user_id
            )
            results.extend(
                DroppedFileResult(
                    filename=_base_name(upload),
                    section=section,
                    item_id=item_id,
                    item_name=item_name,
                    revision_number=revision.number,
                )
                for upload in group
            )
    except Exception as exc:
        exc.stored_count = len(results)  # type: ignore[attr-defined]  # lets the route still broadcast
        raise
    finally:
        if results:
            try:
                await _record_drop(db, order_id, project_id, code, results, actor)
                await db.commit()
            except Exception:
                logger.warning("project.files_dropped event failed for order %s", order_id, exc_info=True)
                await db.rollback()
    return DropFilesResponse(project_id=project_id, results=results)
