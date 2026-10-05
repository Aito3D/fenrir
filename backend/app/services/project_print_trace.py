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
from collections.abc import Collection
from dataclasses import dataclass

from sqlalchemy import case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.app.services import aito_events

logger = logging.getLogger(__name__)

QUEUED_KIND = "print.queued_from_revision"
TASK_UNUSABLE = "This Aito task can't be used for this file"


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


async def _source_trace(
    db: AsyncSession, library_file_id: int | None, archive_id: int | None
) -> tuple[int | None, int | None]:
    """(revision, task) of the source: the library file's revision (no task), else
    the archive's revision and task (a reprint)."""
    if library_file_id is not None:
        revision_id = (
            await db.execute(select(LibraryFile.revision_id).where(LibraryFile.id == library_file_id))
        ).scalar_one_or_none()
        return revision_id, None
    if archive_id is not None:
        row = (
            await db.execute(
                select(PrintArchive.revision_id, PrintArchive.aito_task_id).where(PrintArchive.id == archive_id)
            )
        ).first()
        return (row[0], row[1]) if row is not None else (None, None)
    return None, None


async def resolve_print_context(
    db: AsyncSession,
    library_file_id: int | None,
    aito_task_id: int | None,
    project_id: int | None,
    *,
    archive_id: int | None = None,
) -> PrintContext:
    """Revision, task and project for a queue item made from ``library_file_id``
    (or, for a reprint, from ``archive_id``).

    - ``revision_id`` is the file's revision (None for a non-project file); a
      reprint takes the archive's, so a traced print stays traced.
    - ``project_id`` defaults to the revision's project when not given.
    - ``aito_task_id`` requires a revision file and must name an existing task
      whose order is not trashed and whose linked project is the revision's
      project; every failure is a 400 (an unknown or trashed task included, so
      the caller cannot tell the two apart). A reprint of an archive that
      already has a task only accepts that same task.
    """
    revision_id, source_task_id = await _source_trace(db, library_file_id, archive_id)
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
    # A reprint stays on its archive's task (the scheduler keeps it), so another
    # task would be credited with prints it never gets.
    if source_task_id is not None and source_task_id != aito_task_id:
        raise PrintTraceError(400, TASK_UNUSABLE)

    row = (
        await db.execute(
            select(AitoTask, AitoProject.status)
            .join(AitoProject, AitoProject.id == AitoTask.project_id)
            .where(AitoTask.id == aito_task_id)
        )
    ).first()
    # One message for unknown, trashed and wrongly linked tasks, so the 400
    # never reveals whether a task id exists.
    if row is None or row[1] == "deleted" or row[0].linked_project_id != project.id:
        raise PrintTraceError(400, TASK_UNUSABLE)
    task = row[0]
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


@dataclass(frozen=True)
class PrintCounts:
    printed: int = 0
    rejected: int = 0
    queued: int = 0


_QUEUED_STATUSES = ("pending", "printing")


def _is_printed():
    """Spec §4.2: completed and not rejected, or explicitly marked good."""
    return or_(
        (PrintArchive.status == "completed") & (func.coalesce(PrintArchive.user_verdict, "") != "reject"),
        PrintArchive.user_verdict == "good",
    )


async def task_print_counts(db: AsyncSession, task_ids: Collection[int]) -> dict[int, PrintCounts]:
    """printed / rejected / queued per task, all in parts: one grouped query on
    the live archives and one on the live queue rows. Tasks without prints are absent."""
    ids = list(task_ids)
    if not ids:
        return {}
    printed = func.coalesce(func.sum(case((_is_printed(), PrintArchive.quantity), else_=0)), 0)
    rejected = func.coalesce(func.sum(case((PrintArchive.user_verdict == "reject", PrintArchive.quantity), else_=0)), 0)
    archive_rows = await db.execute(
        select(PrintArchive.aito_task_id, printed, rejected)
        .where(PrintArchive.aito_task_id.in_(ids), PrintArchive.deleted_at.is_(None))
        .group_by(PrintArchive.aito_task_id)
    )
    # Queued is in parts too: each live queue row counts its source's parts —
    # the library file's printable objects, or the reprinted archive's quantity.
    # One row per live queue item (a handful), the file metadata path joined in.
    queue_rows = await db.execute(
        select(
            PrintQueueItem.aito_task_id,
            LibraryFile.file_metadata["printable_objects"],
            PrintArchive.quantity,
        )
        .outerjoin(LibraryFile, LibraryFile.id == PrintQueueItem.library_file_id)
        .outerjoin(PrintArchive, PrintArchive.id == PrintQueueItem.archive_id)
        .where(PrintQueueItem.aito_task_id.in_(ids), PrintQueueItem.status.in_(_QUEUED_STATUSES))
    )
    counts = {tid: [int(p), int(r), 0] for tid, p, r in archive_rows}
    for tid, printable_objects, archive_quantity in queue_rows:
        counts.setdefault(tid, [0, 0, 0])[2] += _queued_parts(printable_objects, archive_quantity)
    return {tid: PrintCounts(*values) for tid, values in counts.items()}


def _queued_parts(printable_objects, archive_quantity: int | None) -> int:
    """Parts one queue row will print: the file's printable objects, else the
    reprinted archive's quantity, else 1."""
    if isinstance(printable_objects, dict) and printable_objects:
        return len(printable_objects)
    if archive_quantity and archive_quantity > 0:
        return int(archive_quantity)
    return 1


async def revision_print_counts(db: AsyncSession, revision_ids: Collection[int]) -> dict[int, int]:
    """Printed quantity per revision (same rule as tasks); one grouped query."""
    ids = list(revision_ids)
    if not ids:
        return {}
    rows = await db.execute(
        select(PrintArchive.revision_id, func.coalesce(func.sum(PrintArchive.quantity), 0))
        .where(PrintArchive.revision_id.in_(ids), PrintArchive.deleted_at.is_(None), _is_printed())
        .group_by(PrintArchive.revision_id)
    )
    return {rid: int(total) for rid, total in rows}
