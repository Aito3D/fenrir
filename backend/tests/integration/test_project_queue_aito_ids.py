"""``GET /projects/{id}/queue`` shows ``aito_task_id`` only to callers holding aito:read (T-423).

Auth off keeps the id; with auth on a user token needs aito:read; an API key never has it
(aito:read is API-key-denied), so a key sees it null whatever its other scopes.
"""

import pytest
from httpx import AsyncClient

from backend.app.core.auth import generate_api_key
from backend.app.core.permissions import Permission as P
from backend.app.models.api_key import APIKey
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.settings import Settings
from backend.tests.project_fixtures import add_user_with_group, bearer_headers, make_order, make_project, make_task


@pytest.fixture
async def queued_project(db_session):
    project = await make_project(db_session)
    order = await make_order(db_session)
    task = await make_task(db_session, order)
    db_session.add(PrintQueueItem(project_id=project.id, aito_task_id=task.id, status="pending", position=1))
    await db_session.commit()
    return project.id, task.id


async def _row(client: AsyncClient, project_id: int, headers: dict | None = None) -> dict:
    response = await client.get(f"/api/v1/projects/{project_id}/queue", headers=headers or {})
    assert response.status_code == 200, response.text
    (row,) = response.json()
    return row


@pytest.mark.asyncio
@pytest.mark.integration
async def test_auth_off_keeps_the_id(async_client: AsyncClient, queued_project):
    project_id, task_id = queued_project
    row = await _row(async_client, project_id)
    assert row["aito_task_id"] == task_id


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize(
    ("permissions", "visible"),
    [([P.PROJECTS_READ, P.QUEUE_READ_ALL, P.AITO_READ], True), ([P.PROJECTS_READ, P.QUEUE_READ_ALL], False)],
    ids=["with aito:read", "without aito:read"],
)
async def test_user_sees_the_id_only_with_aito_read(
    async_client: AsyncClient, db_session, queued_project, permissions, visible
):
    project_id, task_id = queued_project
    db_session.add(Settings(key="auth_enabled", value="true"))
    user = await add_user_with_group(
        db_session, username="queue-ids", group_name="queue-ids", permissions=sorted(p.value for p in permissions)
    )
    await db_session.commit()
    row = await _row(async_client, project_id, bearer_headers(user))
    assert row["aito_task_id"] == (task_id if visible else None)
    assert row["project_id"] == project_id
    assert row["status"] == "pending"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_api_key_never_sees_the_id(async_client: AsyncClient, db_session, queued_project):
    project_id, _task_id = queued_project
    db_session.add(Settings(key="auth_enabled", value="true"))
    full_key, key_hash, key_prefix = generate_api_key()
    db_session.add(
        APIKey(
            name="queue-ids",
            key_hash=key_hash,
            key_prefix=key_prefix,
            enabled=True,
            can_read_status=True,
            can_manage_projects=True,
        )
    )
    await db_session.commit()
    row = await _row(async_client, project_id, {"X-API-Key": full_key})
    assert row["aito_task_id"] is None
    assert row["status"] == "pending"
