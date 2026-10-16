"""Resolve a queue item's trace ids into what the timeline hover card shows.

A queue item records `revision_id` (projects as a PDM) and `aito_task_id`
(the production board) as bare integers with no foreign key, so a deleted
revision or task leaves the id behind. The card wants names, not ids, so the
read routes call :func:`attach_trace_summaries` once per response list: two
queries for the whole list, never one per row, and a dangling id simply
resolves to nothing.
"""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.app.schemas.print_queue import PrintQueueItemResponse


async def attach_trace_summaries(db: AsyncSession, responses: Iterable[PrintQueueItemResponse]) -> None:
    """Fill the `project_*`, `revision_*` and `aito_*` summary fields in place."""
    rows = list(responses)
    revision_ids = {r.revision_id for r in rows if r.revision_id is not None}
    task_ids = {r.aito_task_id for r in rows if r.aito_task_id is not None}

    revisions: dict[int, tuple[ProjectRevision, ProjectItem, Project]] = {}
    if revision_ids:
        result = await db.execute(
            select(ProjectRevision, ProjectItem, Project)
            .join(ProjectItem, ProjectItem.id == ProjectRevision.item_id)
            .join(Project, Project.id == ProjectItem.project_id)
            .where(ProjectRevision.id.in_(revision_ids))
        )
        revisions = {rev.id: (rev, item, project) for rev, item, project in result.all()}

    tasks: dict[int, tuple[AitoTask, AitoProject]] = {}
    if task_ids:
        result = await db.execute(
            select(AitoTask, AitoProject)
            .join(AitoProject, AitoProject.id == AitoTask.project_id)
            .where(AitoTask.id.in_(task_ids))
        )
        tasks = {task.id: (task, order) for task, order in result.all()}

    for row in rows:
        if row.revision_id is not None and (found := revisions.get(row.revision_id)):
            rev, item, project = found
            row.project_code = project.code
            row.project_name = project.name
            row.revision_item_name = item.name
            row.revision_number = rev.number
            row.revision_status = rev.status
        if row.aito_task_id is not None and (found := tasks.get(row.aito_task_id)):
            task, order = found
            row.aito_task_title = task.title
            row.aito_client_name = order.client_name
            row.aito_due_date = order.due_date
            row.aito_quantity = task.impression_quantity
            row.aito_board_column = order.board_column
