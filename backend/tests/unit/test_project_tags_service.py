import pytest
from sqlalchemy import select

from backend.app.models.library import LibraryTag, prune_empty_library_tags
from backend.app.models.project import Project
from backend.app.services.project_tags import (
    UnknownTagError,
    apply_project_tag_input,
    get_or_create_tags,
    project_tag_refs,
    set_project_tags,
    sync_project_tags_from_string,
)


async def _project(db, name="P", tags=None):
    project = Project(name=name, tags=tags)
    db.add(project)
    await db.flush()
    return project


@pytest.mark.asyncio
async def test_get_or_create_reuses_case_insensitively(db_session):
    db_session.add(LibraryTag(name="Drone", name_key="drone"))
    await db_session.flush()
    tags = await get_or_create_tags(db_session, [" drone ", "Pièce, auto", "pièce  auto"])
    assert [t.name for t in tags] == ["Drone", "Pièce  auto"]
    assert len((await db_session.execute(select(LibraryTag))).scalars().all()) == 2


@pytest.mark.asyncio
async def test_set_project_tags_replaces_rows_and_mirror(db_session):
    project = await _project(db_session)
    a, b = await get_or_create_tags(db_session, ["zèbre", "Abeille"])
    await set_project_tags(db_session, project, [a.id, b.id, a.id])
    assert project.tags == "Abeille, zèbre"
    await set_project_tags(db_session, project, [b.id])
    refs = await project_tag_refs(db_session, [project.id])
    assert [r.name for r in refs[project.id]] == ["Abeille"]
    assert project.tags == "Abeille"


@pytest.mark.asyncio
async def test_set_project_tags_rejects_unknown_ids(db_session):
    project = await _project(db_session)
    with pytest.raises(UnknownTagError) as err:
        await set_project_tags(db_session, project, [999])
    assert err.value.tag_ids == [999]


@pytest.mark.asyncio
async def test_apply_input_creates_new_names(db_session):
    project = await _project(db_session)
    (existing,) = await get_or_create_tags(db_session, ["drone"])
    await apply_project_tag_input(db_session, project, tag_ids=[existing.id], new_tag_names=["support"])
    assert project.tags == "drone, support"


@pytest.mark.asyncio
async def test_sync_from_legacy_string(db_session):
    project = await _project(db_session, tags="b, A,a")
    await sync_project_tags_from_string(db_session, project)
    assert project.tags == "A, b"


@pytest.mark.asyncio
async def test_prune_keeps_project_only_tags(db_session):
    project = await _project(db_session)
    (kept,) = await get_or_create_tags(db_session, ["projet-seul"])
    await get_or_create_tags(db_session, ["orphelin"])
    await set_project_tags(db_session, project, [kept.id])
    await prune_empty_library_tags(db_session)
    names = (await db_session.execute(select(LibraryTag.name))).scalars().all()
    assert "projet-seul" in names
    assert "orphelin" not in names
