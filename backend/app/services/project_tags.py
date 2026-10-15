"""Project tags on the shared ``library_tags`` catalogue (spec §1.2).

``projects.tags`` (the legacy comma-separated column) is kept as a normalised
MIRROR of the rows — names sorted case-insensitively, joined with ", " — so the
upstream project responses that read ``project.tags`` keep showing the right
tags without each of them learning about ``project_tags``. Every write goes
through ``set_project_tags``, which rewrites rows and mirror together.
"""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.library import LibraryTag
from backend.app.models.project import Project
from backend.app.models.project_tag import ProjectTag
from backend.app.schemas.project import ProjectTagRef, ProjectTagSuggestion

MAX_TAG_CHARS = 64


def tag_name_key(name: str) -> str:
    """Same rule as ``library_tags.name_key``: LOWER(TRIM(name))."""
    return name.strip().lower()


def clean_tag_name(name: str) -> str:
    """A storable tag name: no commas (they separate the mirror), trimmed, ≤ 64 chars."""
    return name.replace(",", " ").strip()[:MAX_TAG_CHARS].strip()


def unique_clean_names(raw_names: Iterable[str], seen: set[str] | None = None) -> list[tuple[str, str]]:
    """``(name, key)`` for each non-empty cleaned name, in order, first spelling per key wins.

    ``seen`` (when given) is mutated with every key kept."""
    seen = set() if seen is None else seen
    pairs: list[tuple[str, str]] = []
    for raw in raw_names:
        name = clean_tag_name(raw)
        key = tag_name_key(name)
        if not name or key in seen:
            continue
        seen.add(key)
        pairs.append((name, key))
    return pairs


def split_tag_string(value: str | None) -> list[str]:
    """``"drone,, Drone , pièce auto,"`` → ``["drone", "pièce auto"]`` (first spelling wins)."""
    return [name for name, _key in unique_clean_names((value or "").split(","))]


def tag_mirror(names: list[str]) -> str | None:
    return ", ".join(sorted(names, key=tag_name_key)) or None


class UnknownTagError(ValueError):
    def __init__(self, tag_ids: list[int]):
        super().__init__(f"Unknown tag ids: {tag_ids}")
        self.tag_ids = tag_ids


async def get_or_create_tags(db: AsyncSession, names: list[str]) -> list[LibraryTag]:
    """Catalogue rows for ``names``, created when missing; order kept, duplicates dropped."""
    seen: set[str] = set()
    cleaned = [name for name, _key in unique_clean_names(names, seen)]
    if not cleaned:
        return []
    existing = {
        tag.name_key: tag
        for tag in (await db.execute(select(LibraryTag).where(LibraryTag.name_key.in_(seen)))).scalars().all()
    }
    tags: list[LibraryTag] = []
    for name in cleaned:
        key = tag_name_key(name)
        tag = existing.get(key)
        if tag is None:
            tag = await _insert_tag_or_reuse(db, name, key)
            existing[key] = tag
        tags.append(tag)
    await db.flush()
    return tags


def _is_tag_name_conflict(exc: IntegrityError) -> bool:
    """``exc`` is the ``library_tags.name_key`` uniqueness violation (SQLite names the column, PostgreSQL the index)."""
    text = str(exc)
    return "library_tags.name_key" in text or "library_tags_name_key" in text


async def _insert_tag_or_reuse(db: AsyncSession, name: str, key: str) -> LibraryTag:
    """Insert the tag inside a savepoint; when a concurrent request created the same ``name_key``
    first, roll back to the savepoint and return the row that won."""
    tag = LibraryTag(name=name, name_key=key)
    try:
        async with db.begin_nested():
            db.add(tag)
            await db.flush()
    except IntegrityError as exc:
        if not _is_tag_name_conflict(exc):
            raise
        winner = (await db.execute(select(LibraryTag).where(LibraryTag.name_key == key))).scalar_one_or_none()
        if winner is None:
            raise
        return winner
    return tag


async def set_project_tags(db: AsyncSession, project: Project, tag_ids: list[int]) -> list[LibraryTag]:
    """Replace the project's tags and rewrite its mirror. Unknown ids raise ``UnknownTagError``."""
    unique_ids = list(dict.fromkeys(tag_ids))
    tags = (
        list((await db.execute(select(LibraryTag).where(LibraryTag.id.in_(unique_ids)))).scalars().all())
        if unique_ids
        else []
    )
    missing = sorted(set(unique_ids) - {tag.id for tag in tags})
    if missing:
        raise UnknownTagError(missing)
    await db.execute(delete(ProjectTag).where(ProjectTag.project_id == project.id))
    for tag in tags:
        db.add(ProjectTag(project_id=project.id, tag_id=tag.id))
    project.tags = tag_mirror([tag.name for tag in tags])
    await db.flush()
    return tags


async def apply_project_tag_input(
    db: AsyncSession, project: Project, *, tag_ids: list[int], new_tag_names: list[str]
) -> None:
    created = await get_or_create_tags(db, new_tag_names)
    await set_project_tags(db, project, [*tag_ids, *(tag.id for tag in created)])


async def sync_project_tags_from_string(db: AsyncSession, project: Project) -> None:
    """Rows from whatever a legacy path wrote into ``project.tags`` (create, import, template copy)."""
    tags = await get_or_create_tags(db, split_tag_string(project.tags))
    await set_project_tags(db, project, [tag.id for tag in tags])


async def project_tag_refs(db: AsyncSession, project_ids: list[int]) -> dict[int, list[ProjectTagRef]]:
    refs: dict[int, list[ProjectTagRef]] = {pid: [] for pid in project_ids}
    if not project_ids:
        return refs
    rows = await db.execute(
        select(ProjectTag.project_id, LibraryTag.id, LibraryTag.name)
        .join(LibraryTag, LibraryTag.id == ProjectTag.tag_id)
        .where(ProjectTag.project_id.in_(project_ids))
        .order_by(LibraryTag.name_key)
    )
    for project_id, tag_id, name in rows.all():
        refs[project_id].append(ProjectTagRef(id=tag_id, name=name))
    return refs


async def project_ids_with_tag(db: AsyncSession, tag_id: int) -> list[int]:
    return list((await db.execute(select(ProjectTag.project_id).where(ProjectTag.tag_id == tag_id))).scalars().all())


async def refresh_tag_mirrors(db: AsyncSession, project_ids: list[int]) -> None:
    """Rewrite the mirror of each project from its rows (after a catalogue rename or delete)."""
    if not project_ids:
        return
    refs = await project_tag_refs(db, project_ids)
    for project in (await db.execute(select(Project).where(Project.id.in_(project_ids)))).scalars().all():
        project.tags = tag_mirror([ref.name for ref in refs.get(project.id, [])])
    await db.flush()


MAX_SUGGESTIONS = 5
MAX_NEW_SUGGESTIONS = 2


def rank_tag_suggestions(
    raw_names: list[str], catalogue: dict[str, ProjectTagRef], exclude_ids: set[int]
) -> list[ProjectTagSuggestion]:
    """Existing catalogue tags first (in the model's order), then at most two new
    names, five in total; tags the project already has are dropped (spec §3.5)."""
    existing: list[ProjectTagSuggestion] = []
    new: list[ProjectTagSuggestion] = []
    for name, key in unique_clean_names(raw_names):
        hit = catalogue.get(key)
        if hit is not None:
            if hit.id not in exclude_ids:
                existing.append(ProjectTagSuggestion(name=hit.name, tag_id=hit.id))
        elif len(new) < MAX_NEW_SUGGESTIONS:
            new.append(ProjectTagSuggestion(name=name, tag_id=None))
    return (existing + new)[:MAX_SUGGESTIONS]
