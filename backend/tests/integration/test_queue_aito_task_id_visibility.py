"""``GET /queue`` and ``GET /queue/{id}`` show a queue item's Aito task id only to callers holding aito:read (T-359).

Auth off keeps the id; with auth on a user token needs aito:read on top of queue read; an API key never has it
(aito:read is API-key-denied), so a key sees it null whatever its other scopes. Mirrors T-334's archive rule.
"""

import pytest
from httpx import AsyncClient

from backend.app.core.auth import generate_api_key
from backend.app.core.permissions import Permission as P
from backend.app.models.api_key import APIKey
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.settings import Settings
from backend.tests.project_fixtures import add_user_with_group, bearer_headers, make_order, make_task


@pytest.fixture
async def traced_item(db_session):
    order = await make_order(db_session)
    task = await make_task(db_session, order)
    item = PrintQueueItem(printer_id=None, target_model="X1C", revision_id=7, aito_task_id=task.id, position=1)
    db_session.add(item)
    await db_session.commit()
    return item.id, task.id


async def _rows(client: AsyncClient, item_id: int, headers: dict | None = None) -> tuple[dict, dict]:
    listed = await client.get("/api/v1/queue/", headers=headers or {})
    assert listed.status_code == 200, listed.text
    (row,) = [r for r in listed.json() if r["id"] == item_id]
    single = await client.get(f"/api/v1/queue/{item_id}", headers=headers or {})
    assert single.status_code == 200, single.text
    return row, single.json()


@pytest.mark.asyncio
@pytest.mark.integration
async def test_auth_off_keeps_the_id(async_client: AsyncClient, traced_item):
    item_id, task_id = traced_item
    row, single = await _rows(async_client, item_id)
    assert (row["aito_task_id"], single["aito_task_id"]) == (task_id, task_id)


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize(
    ("permissions", "visible"),
    [
        ([P.QUEUE_READ_ALL, P.AITO_READ], True),
        ([P.QUEUE_READ_ALL], False),
        ([P.QUEUE_READ_OWN], False),
    ],
    ids=["with aito:read", "without aito:read", "read_own without aito:read"],
)
async def test_user_sees_the_id_only_with_aito_read(
    async_client: AsyncClient, db_session, traced_item, permissions, visible
):
    item_id, task_id = traced_item
    db_session.add(Settings(key="auth_enabled", value="true"))
    user = await add_user_with_group(
        db_session, username="queue-ids", group_name="queue-ids", permissions=sorted(p.value for p in permissions)
    )
    item = await db_session.get(PrintQueueItem, item_id)
    item.created_by_id = user.id  # read_own only lists the caller's own items
    await db_session.commit()
    row, single = await _rows(async_client, item_id, bearer_headers(user))
    expected = task_id if visible else None
    assert (row["aito_task_id"], single["aito_task_id"]) == (expected, expected)
    # Only the Aito id is withheld; the rest of the traceability stays.
    assert (row["revision_id"], single["revision_id"]) == (7, 7)


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize("scopes", [("can_read_status",), ("can_read_status", "can_queue", "can_manage_projects")])
async def test_api_key_never_sees_the_id(async_client: AsyncClient, db_session, traced_item, scopes):
    item_id, _task_id = traced_item
    db_session.add(Settings(key="auth_enabled", value="true"))
    full_key, key_hash, key_prefix = generate_api_key()
    db_session.add(
        APIKey(name="queue-ids", key_hash=key_hash, key_prefix=key_prefix, enabled=True, **dict.fromkeys(scopes, True))
    )
    await db_session.commit()
    row, single = await _rows(async_client, item_id, {"X-API-Key": full_key})
    assert (row["aito_task_id"], single["aito_task_id"]) == (None, None)
    assert (row["revision_id"], single["revision_id"]) == (7, 7)
