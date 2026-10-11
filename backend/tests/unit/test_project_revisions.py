"""Shared revision lookups (services/project_revisions.py)."""

import pytest

from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.app.services import project_files, project_print_trace, project_revisions
from backend.app.services.project_revisions import find_revision_bundle, revision_label


def test_revision_label_names_item_and_number():
    assert revision_label("Support", 3) == "Support R3"


def test_revision_label_is_the_same_function_everywhere():
    # project_files re-exports it (routes and services import it from there).
    assert project_files.revision_label is project_revisions.revision_label
    assert project_print_trace.revision_label is project_revisions.revision_label


@pytest.mark.asyncio
async def test_find_revision_bundle_returns_revision_item_and_project(db_session):
    project = Project(name="P")
    db_session.add(project)
    await db_session.flush()
    item = ProjectItem(project_id=project.id, section="impression", name="Mesh", name_key="mesh")
    db_session.add(item)
    await db_session.flush()
    rev = ProjectRevision(item_id=item.id, number=1)
    db_session.add(rev)
    await db_session.flush()

    bundle = await find_revision_bundle(db_session, rev.id)

    assert isinstance(bundle, tuple)
    assert bundle == (rev, item, project)


@pytest.mark.asyncio
async def test_find_revision_bundle_unknown_revision_is_none(db_session):
    assert await find_revision_bundle(db_session, 987654) is None


@pytest.mark.asyncio
async def test_get_revision_bundle_unknown_revision_is_404(db_session):
    with pytest.raises(project_files.ProjectFilesError) as exc:
        await project_files.get_revision_bundle(db_session, 987654)
    assert exc.value.status_code == 404
    assert exc.value.detail == "Revision not found"
