"""The project's own event log (spec §4.4): stored ``project_events`` rows on the timeline."""

from functools import partial

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select

from backend.app.core.auth import create_access_token, get_password_hash
from backend.app.core.permissions import Permission
from backend.app.models.group import Group
from backend.app.models.project_event import ProjectEvent
from backend.app.models.settings import Settings
from backend.app.models.user import User
from backend.tests.project_fixtures import api_project, make_order, make_task, projects_root_fixture, threemf_bytes

root = projects_root_fixture(autouse=True)

_order = partial(make_order, commit=True)
_task = partial(make_task, commit=True)
_project = partial(api_project, check=False)


async def _revision(client, project_id):
    item = (
        await client.post(f"/api/v1/projects/{project_id}/items", json={"section": "impression", "name": "Pièce"})
    ).json()
    response = await client.post(
        f"/api/v1/projects/items/{item['id']}/revisions",
        files=[("files", ("p.3mf", threemf_bytes(), "application/octet-stream"))],
    )
    assert response.status_code == 201, response.text
    return response.json()["revision"]["id"]


async def _timeline(client, project_id, **kwargs):
    response = await client.get(f"/api/v1/projects/{project_id}/timeline", **kwargs)
    assert response.status_code == 200, response.text
    return {e["event_type"]: e for e in response.json()}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_timeline_shows_revision_status_link_and_delivery_events(async_client: AsyncClient, db_session):
    project = await _project(async_client)
    # No order links to the project yet: the revision is still logged.
    revision_id = await _revision(async_client, project["id"])
    await async_client.patch(f"/api/v1/projects/revisions/{revision_id}", json={"status": "valide"})
    order = await _order(db_session)
    task = await _task(db_session, order)
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/deliveries", json={"revision_ids": [revision_id]})

    events = await _timeline(async_client, project["id"])

    assert events["project.revision_added"]["description"] == "Pièce R1"
    assert events["project.revision_status_changed"]["description"] == "Pièce R1: wip → valide"
    assert events["task.project_linked"]["description"].startswith(f"#{order.id}")
    assert events["task.project_linked"]["metadata"]["order_id"] == order.id
    assert events["task.deliveries_changed"]["description"].endswith(": +Pièce R1")
    assert "project_created" in events

    # Unlinking is logged too.
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": None})
    assert "task.project_unlinked" in await _timeline(async_client, project["id"])


@pytest.mark.asyncio
@pytest.mark.integration
async def test_deleting_a_project_deletes_its_events(async_client: AsyncClient, db_session):
    project = await _project(async_client)
    order = await _order(db_session)
    task = await _task(db_session, order)
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": None})
    assert (await db_session.execute(select(func.count()).select_from(ProjectEvent))).scalar_one() == 2

    assert (await async_client.delete(f"/api/v1/projects/{project['id']}")).status_code in (200, 204)

    assert (await db_session.execute(select(func.count()).select_from(ProjectEvent))).scalar_one() == 0


@pytest.mark.asyncio
@pytest.mark.integration
async def test_order_events_need_aito_read(async_client: AsyncClient, db_session):
    project = await _project(async_client)
    await _revision(async_client, project["id"])
    order = await _order(db_session)
    task = await _task(db_session, order)
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})

    db_session.add(Settings(key="auth_enabled", value="true"))
    group = Group(name="pdm-projects-read", permissions=[Permission.PROJECTS_READ.value], is_system=False)
    user = User(username="pdm-projects-only", password_hash=get_password_hash("password"), is_active=True)
    user.groups.append(group)
    db_session.add_all([group, user])
    await db_session.commit()
    token = create_access_token(data={"sub": user.username})

    events = await _timeline(async_client, project["id"], headers={"Authorization": f"Bearer {token}"})

    assert "project.revision_added" in events
    assert "task.project_linked" not in events
