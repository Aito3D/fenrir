"""Revision lookups shared by project files and print traceability.

``project_files`` imports ``project_print_trace`` (revision print counts), so
anything both need lives here, below them both.
"""

from __future__ import annotations

from collections.abc import Collection

from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision


def revision_lock_statement(revision_ids: Collection[int], *, share: bool = False) -> Select:
    """``SELECT id FROM project_revisions WHERE id IN (...) FOR UPDATE`` (``FOR SHARE`` with
    ``share``), in id order so two lockers never deadlock on each other."""
    return (
        select(ProjectRevision.id)
        .where(ProjectRevision.id.in_(list(revision_ids)))
        .order_by(ProjectRevision.id)
        .with_for_update(read=share)
    )


async def lock_revision_rows(
    db: AsyncSession, revision_ids: Collection[int], *, share: bool = False
) -> set[int] | None:
    """On PostgreSQL, lock the revisions' rows until the transaction ends and return the
    ids still there; on SQLite run nothing and return None.

    A delete takes ``FOR UPDATE``, a writer that adds a use (a delivery, a queued
    print) ``FOR SHARE``: whichever comes second waits for the first to commit, then
    sees its result, so the usage re-checks hold under READ COMMITTED. SQLite needs
    no statement: its single write lock already serialises the two (and the dialect
    drops the clause anyway), so its statements stay exactly as they were.
    """
    if db.get_bind().dialect.name != "postgresql":
        return None
    return set((await db.execute(revision_lock_statement(revision_ids, share=share))).scalars())


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
