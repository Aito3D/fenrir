"""Project items and revisions schema (spec §1.3–§1.5)."""

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from backend.app.models.library import LibraryFile
from backend.app.models.project import Project
from backend.app.models.project_item import REVISION_STATUSES, SECTIONS, ProjectItem, ProjectRevision


def test_section_and_status_vocabularies():
    assert SECTIONS == ("scan", "modelisation", "impression", "usinage", "docs")
    assert REVISION_STATUSES == ("wip", "valide", "obsolete")


@pytest.mark.asyncio
async def test_item_name_unique_per_section_case_insensitive(db_session):
    project = Project(name="P")
    db_session.add(project)
    await db_session.flush()
    db_session.add(ProjectItem(project_id=project.id, section="scan", name="Mesh", name_key="mesh"))
    db_session.add(ProjectItem(project_id=project.id, section="docs", name="Mesh", name_key="mesh"))
    await db_session.flush()
    db_session.add(ProjectItem(project_id=project.id, section="scan", name="MESH", name_key="mesh"))
    with pytest.raises(IntegrityError):
        await db_session.flush()


@pytest.mark.asyncio
async def test_revision_number_unique_per_item_and_defaults(db_session):
    project = Project(name="P")
    db_session.add(project)
    await db_session.flush()
    item = ProjectItem(project_id=project.id, section="scan", name="Mesh", name_key="mesh")
    db_session.add(item)
    await db_session.flush()
    rev = ProjectRevision(item_id=item.id, number=1)
    db_session.add(rev)
    await db_session.flush()
    assert rev.status == "wip"
    assert item.last_revision_number == 0
    db_session.add(ProjectRevision(item_id=item.id, number=1))
    with pytest.raises(IntegrityError):
        await db_session.flush()


@pytest.mark.asyncio
async def test_file_manager_select_excludes_revision_files(db_session):
    project = Project(name="P")
    db_session.add(project)
    await db_session.flush()
    item = ProjectItem(project_id=project.id, section="docs", name="Plan", name_key="plan")
    db_session.add(item)
    await db_session.flush()
    rev = ProjectRevision(item_id=item.id, number=1)
    db_session.add(rev)
    await db_session.flush()
    loose = LibraryFile(filename="a.stl", file_path="a.stl", file_type="stl", file_size=1)
    owned = LibraryFile(filename="b.pdf", file_path="b.pdf", file_type="pdf", file_size=1, revision_id=rev.id)
    db_session.add_all([loose, owned])
    await db_session.flush()
    names = (await db_session.execute(LibraryFile.file_manager())).scalars().all()
    assert [f.filename for f in names] == ["a.stl"]
    assert (
        await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == rev.id))
    ).scalar_one().id == owned.id
