"""An ownerless batch (created_by_id NULL) is nobody's own (T-005).

A user holding only queue:update_own gets 404 on it from PATCH/dispatch of a
batch and from adding an item into it; its owner and queue:update_all holders
are unaffected, and so is auth-off.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from backend.app.core import database as _database_module
from backend.app.models.print_batch import PrintBatchPlate
from backend.app.models.print_queue import PrintBatch, PrintQueueItem
from backend.tests.integration.test_queue_review_1620 import STAFF, STUDENT, _admin_token, _auth, _user

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


async def _batch(owner_id: int | None, users=None) -> int:
    """With *users*, seed it as an order that still owes a run: a target of 2 runs and one pending member."""
    async with _database_module.async_session() as session:
        batch = PrintBatch(name="Legacy", status="active", created_by_id=owner_id)
        if users:
            batch.archive_id, batch.quantity = users["archive"].id, 2
        session.add(batch)
        await session.commit()
        if users:
            session.add(PrintBatchPlate(batch_id=batch.id, plate_id=None, quantity_target=2))
            session.add(
                PrintQueueItem(
                    printer_id=users["printer"].id,
                    archive_id=users["archive"].id,
                    batch_id=batch.id,
                    status="pending",
                    created_by_id=owner_id,
                )
            )
            await session.commit()
        return batch.id


@pytest.fixture
async def users(async_client, printer_factory, archive_factory):
    printer = await printer_factory(name="Lab")
    archive = await archive_factory(printer.id)
    admin = await _admin_token(async_client)
    student, student_id = await _user(async_client, admin, "student", STUDENT)
    staff, _ = await _user(async_client, admin, "staff", STAFF)
    return {"student": student, "student_id": student_id, "staff": staff, "printer": printer, "archive": archive}


async def _calls(async_client, headers, batch_id, users):
    return {
        "patch": await async_client.patch(f"/api/v1/queue/batches/{batch_id}", headers=headers, json={"name": "x"}),
        "dispatch": await async_client.post(f"/api/v1/queue/batches/{batch_id}/dispatch", headers=headers, json={}),
        "add": await async_client.post(
            "/api/v1/queue/",
            headers=headers,
            json={"printer_id": users["printer"].id, "archive_id": users["archive"].id, "batch_id": batch_id},
        ),
        "cancel": await async_client.patch(
            f"/api/v1/queue/batches/{batch_id}", headers=headers, json={"status": "cancelled"}
        ),
    }


async def _assert_reached(responses, batch_id: int) -> None:
    """Every call succeeded; dispatch queued the owed run and the added item landed in the batch."""
    assert {k: r.status_code for k, r in responses.items()} == dict.fromkeys(responses, 200), {
        k: r.text for k, r in responses.items()
    }
    assert responses["patch"].json()["name"] == "x"
    assert responses["add"].json()["batch_id"] == batch_id
    assert responses["cancel"].json()["status"] == "cancelled"
    async with _database_module.async_session() as session:
        members = (await session.execute(select(PrintQueueItem.id).where(PrintQueueItem.batch_id == batch_id))).all()
    assert len(members) == 3  # the seeded run, the one dispatch cloned, the one added


async def test_update_own_only_cannot_touch_an_ownerless_batch(async_client, users):
    batch_id = await _batch(None)

    responses = await _calls(async_client, _auth(users["student"]), batch_id, users)

    assert {k: r.status_code for k, r in responses.items()} == dict.fromkeys(responses, 404)


async def test_update_all_holder_still_reaches_an_ownerless_batch(async_client, users):
    batch_id = await _batch(None, users)

    responses = await _calls(async_client, _auth(users["staff"]), batch_id, users)

    await _assert_reached(responses, batch_id)


async def test_owner_still_reaches_their_own_batch(async_client, users):
    batch_id = await _batch(users["student_id"], users)

    responses = await _calls(async_client, _auth(users["student"]), batch_id, users)

    await _assert_reached(responses, batch_id)


async def test_auth_off_still_reaches_an_ownerless_batch(async_client, printer_factory, archive_factory):
    printer = await printer_factory()
    archive = await archive_factory(printer.id)
    users = {"printer": printer, "archive": archive}
    batch_id = await _batch(None, users)

    responses = await _calls(async_client, {}, batch_id, users)

    await _assert_reached(responses, batch_id)


async def _member_row(batch_id: int | None, owner_id: int | None, users) -> int:
    async with _database_module.async_session() as session:
        item = PrintQueueItem(
            printer_id=users["printer"].id,
            archive_id=users["archive"].id,
            batch_id=batch_id,
            status="pending",
            created_by_id=owner_id,
        )
        session.add(item)
        await session.commit()
        return item.id


async def _member_batch_id(item_id: int) -> int | None:
    async with _database_module.async_session() as session:
        return (await session.get(PrintQueueItem, item_id)).batch_id


async def _batch_exists(batch_id: int) -> bool:
    async with _database_module.async_session() as session:
        return await session.get(PrintBatch, batch_id) is not None


async def test_ungroup_by_an_update_own_user_keeps_other_peoples_members_in_the_batch(async_client, users):
    batch_id = await _batch(users["student_id"])
    mine = await _member_row(batch_id, users["student_id"], users)
    theirs = await _member_row(batch_id, None, users)

    response = await async_client.post(f"/api/v1/queue/batches/{batch_id}/ungroup", headers=_auth(users["student"]))

    assert response.status_code == 200, response.text
    assert response.json() == {"ungrouped_count": 1, "message": "Ungrouped 1 item(s)"}
    assert await _member_batch_id(mine) is None
    assert await _member_batch_id(theirs) == batch_id
    assert await _batch_exists(batch_id)


async def test_ungroup_of_an_unknown_batch_is_404(async_client, users):
    response = await async_client.post("/api/v1/queue/batches/999999/ungroup", headers=_auth(users["student"]))

    assert response.status_code == 404
    assert response.json()["detail"] == "Batch not found"
