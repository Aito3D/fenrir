"""Production traceability for project revision files (projects as a PDM, phase 4).

A queue item made from a project revision file carries that revision
(``revision_id``, always derived from the library file, never from the client)
and optionally the Aito task it is printed for (``aito_task_id``). This module
resolves and validates both, and records the ``print.queued_from_revision``
story event on the task's order once the queue items are committed.

``resolve_print_context`` only reads; ``record_queued`` owns its own savepoint
and commit and is best-effort: a queue that succeeded must never turn into an
error because the timeline could not be written.
"""

import logging
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.library import LibraryFile
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.app.services import aito_events

logger = logging.getLogger(__name__)

QUEUED_KIND = "print.queued_from_revision"


class PrintTraceError(ValueError):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class PrintContext:
    revision_id: int | None
    aito_task_id: int | None
    project_id: int | None
    revision_label: str | None = None
    order_id: int | None = None
    code: str | None = None
    # The revision's own project (``project_id`` may be a client-chosen one).
    revision_project_id: int | None = None
    task_title: str | None = None


async def file_revision_id(db: AsyncSession, library_file_id: int | None) -> int | None:
    if library_file_id is None:
        return None
    return (
        await db.execute(select(LibraryFile.revision_id).where(LibraryFile.id == library_file_id))
    ).scalar_one_or_none()


async def resolve_print_context(
    db: AsyncSession,
    library_file_id: int | None,
    aito_task_id: int | None,
    project_id: int | None,
) -> PrintContext:
    """Revision, task and project for a queue item made from ``library_file_id``.

    - ``revision_id`` is the file's revision (None for a non-project file).
    - ``project_id`` defaults to the revision's project when not given.
    - ``aito_task_id`` requires a revision file and must name an existing task
      whose order is not trashed and whose linked project is the revision's
      project; every failure is a 400 (an unknown or trashed task included, so
      the caller cannot tell the two apart).
    """
    revision_id = await file_revision_id(db, library_file_id)
    bundle = None
    if revision_id is not None:
        bundle = (
            await db.execute(
                select(ProjectRevision, ProjectItem, Project)
                .join(ProjectItem, ProjectItem.id == ProjectRevision.item_id)
                .join(Project, Project.id == ProjectItem.project_id)
                .where(ProjectRevision.id == revision_id)
            )
        ).first()
    if bundle is None:
        if aito_task_id is not None:
            raise PrintTraceError(400, "An Aito task can only be attached to a project revision file")
        return PrintContext(revision_id=None, aito_task_id=None, project_id=project_id)

    revision, item, project = bundle
    context = PrintContext(
        revision_id=revision.id,
        aito_task_id=None,
        project_id=project_id if project_id is not None else project.id,
        revision_label=f"{item.name} R{revision.number}",
        code=project.code,
        revision_project_id=project.id,
    )
    if aito_task_id is None:
        return context

    row = (
        await db.execute(
            select(AitoTask, AitoProject.status)
            .join(AitoProject, AitoProject.id == AitoTask.project_id)
            .where(AitoTask.id == aito_task_id)
        )
    ).first()
    if row is None or row[1] == "deleted":
        raise PrintTraceError(400, "Aito task not found")
    task = row[0]
    if task.linked_project_id != project.id:
        raise PrintTraceError(400, "The Aito task is not linked to this file's project")
    return PrintContext(
        revision_id=context.revision_id,
        aito_task_id=task.id,
        project_id=context.project_id,
        revision_label=context.revision_label,
        order_id=task.project_id,
        code=context.code,
        revision_project_id=context.revision_project_id,
        task_title=task.title,
    )


async def record_queued(db: AsyncSession, context: PrintContext, *, copies: int, actor: str | None) -> None:
    """``print.queued_from_revision`` once on the task's order, then an ``aito_changed``
    broadcast. Call after the queue items are committed; never raises."""
    if context.aito_task_id is None or context.order_id is None:
        return
    try:
        async with db.begin_nested():
            await aito_events.record(
                db,
                context.order_id,
                QUEUED_KIND,
                actor_class="user" if actor else "system",
                actor_name=actor,
                subject_type="task",
                subject_id=context.aito_task_id,
                subject_label=context.task_title,
                detail={
                    "revision_label": context.revision_label,
                    "copies": copies,
                    "project_id": context.revision_project_id,
                    "code": context.code,
                },
            )
        await db.commit()
    except Exception:
        logger.warning("%s event failed for order %s", QUEUED_KIND, context.order_id, exc_info=True)
        try:
            await db.rollback()
        except Exception:
            logger.warning("rollback after %s failure failed", QUEUED_KIND, exc_info=True)
        return
    # Lazy: aito_project_links -> project_files -> routes.library -> routes.print_queue
    # -> this module would be an import cycle at startup.
    from backend.app.services.aito_project_links import broadcast_orders_changed

    await broadcast_orders_changed([context.order_id], actor)
