"""``GET /projects/catalog`` shows linked Aito orders only to callers holding aito:read (T-520).

Auth off keeps them; with auth on a user token needs aito:read; an API key never has it
(aito:read is API-key-denied). A hidden row keeps its shape with ``client_names == []`` and
``open_orders == []``, and the search no longer matches client names or order numbers.
"""

import pytest
from httpx import AsyncClient

from backend.app.core.auth import generate_api_key
from backend.app.core.permissions import Permission as P
from backend.app.models.api_key import APIKey
from backend.app.models.settings import Settings
from backend.tests.project_fixtures import add_user_with_group, bearer_headers, make_order, make_project, make_task

API = "/api/v1/projects/catalog"


@pytest.fixture
async def linked(db_session):
    project = await make_project(db_session, "Support caméra")
    order = await make_order(db_session)
    await make_task(db_session, order, linked_project_id=project.id, commit=True)
    return project.id, order.id


async def _catalog(client: AsyncClient, headers: dict | None = None, **params) -> dict[int, dict]:
    response = await client.get(API, params=params, headers=headers or {})
    assert response.status_code == 200, response.text
    return {row["id"]: row for row in response.json()["items"]}


async def _assert_visible(client: AsyncClient, project_id: int, order_id: int, visible: bool, headers=None):
    row = (await _catalog(client, headers))[project_id]
    if visible:
        assert row["client_names"] == ["ACME"]
        assert row["open_orders"] == [{"order_id": order_id, "client_name": "ACME"}]
    else:
        assert (row["client_names"], row["open_orders"]) == ([], [])
    assert row["name"] == "Support caméra"  # the rest of the row is unchanged
    for q in ("acme", f"#{order_id}"):
        assert set(await _catalog(client, headers, q=q)) == ({project_id} if visible else set()), q
    assert set(await _catalog(client, headers, q="caméra")) == {project_id}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_auth_off_keeps_the_orders(async_client: AsyncClient, linked):
    project_id, order_id = linked
    await _assert_visible(async_client, project_id, order_id, True)


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize(
    ("permissions", "visible"),
    [([P.PROJECTS_READ, P.AITO_READ], True), ([P.PROJECTS_READ], False)],
    ids=["with aito:read", "without aito:read"],
)
async def test_user_sees_the_orders_only_with_aito_read(
    async_client: AsyncClient, db_session, linked, permissions, visible
):
    project_id, order_id = linked
    db_session.add(Settings(key="auth_enabled", value="true"))
    user = await add_user_with_group(
        db_session, username="cat-aito", group_name="cat-aito", permissions=sorted(p.value for p in permissions)
    )
    await db_session.commit()
    await _assert_visible(async_client, project_id, order_id, visible, bearer_headers(user))


@pytest.mark.asyncio
@pytest.mark.integration
async def test_api_key_never_sees_the_orders(async_client: AsyncClient, db_session, linked):
    project_id, order_id = linked
    db_session.add(Settings(key="auth_enabled", value="true"))
    full_key, key_hash, key_prefix = generate_api_key()
    db_session.add(
        APIKey(name="cat-aito", key_hash=key_hash, key_prefix=key_prefix, enabled=True, can_read_status=True)
    )
    await db_session.commit()
    await _assert_visible(async_client, project_id, order_id, False, {"X-API-Key": full_key})
