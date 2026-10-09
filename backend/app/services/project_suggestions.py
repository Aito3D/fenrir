"""Shared "similar project name" scan for the project suggesters.

``aito_project_links.suggest_projects`` (task title) and
``project_filing.suggest_projects_for_filename`` (filename-derived name) both
rank non-template projects by how closely their name matches a text.
"""

from collections.abc import Collection
from difflib import SequenceMatcher

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.project import Project

SIMILAR_NAME_THRESHOLD = 0.45


async def similar_projects(
    db: AsyncSession, text: str, threshold: float, exclude: Collection[int] = ()
) -> list[tuple[float, int, str | None, str]]:
    """``(ratio, id, code, name)`` for every non-template project not in
    ``exclude`` whose case-folded name matches ``text`` (already case-folded)
    with a ratio of at least ``threshold``; best ratio first, ties by id."""
    rows = await db.execute(select(Project.id, Project.code, Project.name).where(Project.is_template.is_not(True)))
    scored = []
    for project_id, code, name in rows:
        if project_id in exclude:
            continue
        ratio = SequenceMatcher(None, text, (name or "").casefold()).ratio()
        if ratio >= threshold:
            scored.append((ratio, project_id, code, name))
    scored.sort(key=lambda row: (-row[0], row[1]))
    return scored
