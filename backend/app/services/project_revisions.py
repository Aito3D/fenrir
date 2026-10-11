"""Revision lookups shared by project files and print traceability.

``project_files`` imports ``project_print_trace`` (revision print counts), so
anything both need lives here, below them both.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision


def revision_label(item_name: str, number: int) -> str:
    """``"<item> R<n>"``: how a revision is named in events, archives and status messages."""
    return f"{item_name} R{number}"


async def find_revision_bundle(
    db: AsyncSession, revision_id: int
) -> tuple[ProjectRevision, ProjectItem, Project] | None:
    """The revision with its item and project, or None when the revision does not exist."""
    row = (
        await db.execute(
            select(ProjectRevision, ProjectItem, Project)
            .join(ProjectItem, ProjectItem.id == ProjectRevision.item_id)
            .join(Project, Project.id == ProjectItem.project_id)
            .where(ProjectRevision.id == revision_id)
        )
    ).first()
    if row is None:
        return None
    return row[0], row[1], row[2]
