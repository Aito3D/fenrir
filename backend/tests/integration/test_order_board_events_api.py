"""The order timeline routes: paging, depth, notes, permissions."""

from datetime import datetime, timedelta

import pytest

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services.order_board_events import record
from backend.tests.unit.test_order_board_routes import tokens  # noqa: F401

BASE = "/api/v1/order-board/orders/so1/events"


@pytest.fixture
async def order(db_session):
    db_session.add(OrderBoardDoc(kind="salesorder", zoho_id="so1", header={}, detail={}))
    await db_session.commit()


async def _rows(db, kinds):
    t0 = datetime(2026, 1, 1)
    for i, kind in enumerate(kinds):
        await record(db, "so1", kind, actor_class="system", occurred_at=t0 + timedelta(minutes=i))
    await db.commit()


@pytest.mark.asyncio
async def test_events_newest_first_and_paged(async_client, tokens, order, db_session):  # noqa: F811
    await _rows(db_session, ["note.added"] * 3)
    r = await async_client.get(BASE, params={"limit": 2}, headers=tokens["read"])
    page = r.json()
    assert r.status_code == 200 and page["has_more"] is True
    ids = [e["id"] for e in page["events"]]
    assert ids == sorted(ids, reverse=True) and len(ids) == 2
    last = page["events"][-1]
    r2 = await async_client.get(
        BASE, params={"limit": 2, "before": last["id"], "before_at": last["occurred_at"]}, headers=tokens["read"]
    )
    assert [e["id"] for e in r2.json()["events"]] == [ids[-1] - 1] and r2.json()["has_more"] is False


@pytest.mark.asyncio
async def test_half_cursor_422(async_client, tokens, order):  # noqa: F811
    r = await async_client.get(BASE, params={"before": 5}, headers=tokens["read"])
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_depth_filters(async_client, tokens, order, db_session):  # noqa: F811
    await _rows(db_session, ["zoho.edited"])
    detail = await async_client.get(BASE, params={"depth": "detail"}, headers=tokens["read"])
    everything = await async_client.get(BASE, params={"depth": "everything"}, headers=tokens["read"])
    assert detail.json()["events"] == []
    assert [e["kind"] for e in everything.json()["events"]] == ["zoho.edited"]


@pytest.mark.asyncio
async def test_note_created_201(async_client, tokens, order):  # noqa: F811
    r = await async_client.post(BASE, json={"note": " hello "}, headers=tokens["both"])
    assert r.status_code == 201
    body = r.json()
    assert body["kind"] == "note.added" and body["actor_name"] == "orders-both" and body["note"].strip() == "hello"


@pytest.mark.asyncio
async def test_blank_note_422(async_client, tokens, order):  # noqa: F811
    assert (await async_client.post(BASE, json={"note": "   "}, headers=tokens["both"])).status_code == 422


@pytest.mark.asyncio
async def test_note_needs_orders_update(async_client, tokens, order):  # noqa: F811
    assert (await async_client.post(BASE, json={"note": "x"}, headers=tokens["read"])).status_code == 403


@pytest.mark.asyncio
async def test_unknown_order_404(async_client, tokens):  # noqa: F811
    assert (await async_client.get(BASE, headers=tokens["read"])).status_code == 404
    assert (await async_client.post(BASE, json={"note": "x"}, headers=tokens["both"])).status_code == 404


@pytest.mark.asyncio
async def test_board_rows_carry_last_event(async_client, tokens, db_session):  # noqa: F811
    rows = [{"id": "so1"}, {"id": "so2"}]
    db_session.add(OrderBoardDoc(kind="state", zoho_id="board", header={}, detail={"rows": rows}))
    # Inserted newest first: the latest is picked by occurred_at, not by id.
    await record(
        db_session,
        "so1",
        "sms.sent",
        actor_class="user",
        actor_name="Marie",
        detail={"to": "0612"},
        occurred_at=datetime(2026, 1, 2),
    )
    await record(db_session, "so1", "order.received", actor_class="system", occurred_at=datetime(2026, 1, 1))
    await db_session.commit()
    r = await async_client.get("/api/v1/order-board", headers=tokens["read"])
    by_id = {row["id"]: row for row in r.json()["rows"]}
    last = by_id["so1"]["last_event"]
    assert last["kind"] == "sms.sent" and last["actor_name"] == "Marie" and last["detail"] == {"to": "0612"}
    assert last["occurred_at"].startswith("2026-01-02")
    assert by_id["so2"]["last_event"] is None


WATCH = "/api/v1/order-board/orders/so1/watch"


@pytest.mark.asyncio
async def test_watch_is_per_user_and_needs_orders_read(async_client, tokens, order):  # noqa: F811
    for method in ("get", "put", "delete"):
        assert (await getattr(async_client, method)(WATCH, headers=tokens["none"])).status_code == 403
    assert (await async_client.get(WATCH, headers=tokens["read"])).json() == {"watching": False}
    assert (await async_client.put(WATCH, headers=tokens["read"])).json() == {"watching": True}
    assert (await async_client.put(WATCH, headers=tokens["read"])).json() == {"watching": True}  # twice is once
    assert (await async_client.get(WATCH, headers=tokens["read"])).json() == {"watching": True}
    assert (await async_client.get(WATCH, headers=tokens["both"])).json() == {"watching": False}  # someone else's
    assert (await async_client.delete(WATCH, headers=tokens["read"])).json() == {"watching": False}
    assert (await async_client.get(WATCH, headers=tokens["read"])).json() == {"watching": False}


@pytest.mark.asyncio
async def test_watch_unknown_order_404(async_client, tokens):  # noqa: F811
    assert (await async_client.get(WATCH, headers=tokens["read"])).status_code == 404
    assert (await async_client.put(WATCH, headers=tokens["read"])).status_code == 404
    assert (await async_client.delete(WATCH, headers=tokens["read"])).json() == {"watching": False}
