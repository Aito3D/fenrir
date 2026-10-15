"""``GET /projects/{id}/archives`` shows the Aito task and order ids only to callers holding aito:read (T-334).

Auth off keeps the ids; with auth on a user token needs aito:read; an API key never has it
(aito:read is API-key-denied), so a key sees them null whatever its other scopes.
"""

import pytest
from httpx import AsyncClient

from backend.app.core.auth import generate_api_key
from backend.app.core.permissions import Permission as P
from backend.app.models.api_key import APIKey
from backend.app.models.archive import PrintArchive
from backend.app.models.settings import Settings
from backend.tests.project_fixtures import add_user_with_group, bearer_headers, make_order, make_project, make_task


@pytest.fixture
async def traced_project(db_session):
    project = await make_project(db_session)
    order = await make_order(db_session)
    task = await make_task(db_session, order)
    db_session.add(
        PrintArchive(
            filename="a.3mf",
            file_path="x/a.3mf",
            file_size=1,
            print_name="A",
            status="completed",
            quantity=1,
            project_id=project.id,
            aito_task_id=task.id,
        )
    )
    await db_session.commit()
    return project.id, task.id, order.id


async def _row(client: AsyncClient, project_id: int, headers: dict | None = None) -> dict:
    response = await client.get(f"/api/v1/projects/{project_id}/archives", headers=headers or {})
    assert response.status_code == 200, response.text
    (row,) = response.json()
    return row


@pytest.mark.asyncio
@pytest.mark.integration
async def test_auth_off_keeps_the_ids(async_client: AsyncClient, traced_project):
    project_id, task_id, order_id = traced_project
    row = await _row(async_client, project_id)
    assert (row["aito_task_id"], row["order_id"]) == (task_id, order_id)


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize(
    ("permissions", "visible"),
    [([P.PROJECTS_READ, P.AITO_READ], True), ([P.PROJECTS_READ], False)],
    ids=["with aito:read", "without aito:read"],
)
async def test_user_sees_the_ids_only_with_aito_read(
    async_client: AsyncClient, db_session, traced_project, permissions, visible
):
    project_id, task_id, order_id = traced_project
    db_session.add(Settings(key="auth_enabled", value="true"))
    user = await add_user_with_group(
        db_session, username="arch-ids", group_name="arch-ids", permissions=sorted(p.value for p in permissions)
    )
    await db_session.commit()
    row = await _row(async_client, project_id, bearer_headers(user))
    expected = (task_id, order_id) if visible else (None, None)
    assert (row["aito_task_id"], row["order_id"]) == expected


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize("scopes", [("can_read_status",), ("can_read_status", "can_manage_projects")])
async def test_api_key_never_sees_the_ids(async_client: AsyncClient, db_session, traced_project, scopes):
    project_id, _task_id, _order_id = traced_project
    db_session.add(Settings(key="auth_enabled", value="true"))
    full_key, key_hash, key_prefix = generate_api_key()
    db_session.add(
        APIKey(name="arch-ids", key_hash=key_hash, key_prefix=key_prefix, enabled=True, **dict.fromkeys(scopes, True))
    )
    await db_session.commit()
    row = await _row(async_client, project_id, {"X-API-Key": full_key})
    assert (row["aito_task_id"], row["order_id"]) == (None, None)
    assert row["print_name"] == "A"
