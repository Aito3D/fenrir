"""Bell alerts for the Order Board: a ready order, and a new one (not old history read for the first time)."""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select, text

from backend.app.models.notification_inbox import Notification, UserInboxPreference
from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.models.order_board_event import OrderBoardEvent
from backend.app.services import inbox, order_board_events, order_board_sync as sync
from backend.tests.unit.test_inbox_service import _user, pushes  # noqa: F401 (fixture)
from backend.tests.unit.test_order_board_sync import (  # noqa: F401 (fixtures)
    no_back_off_left_over,
    order,
    zoho,
)


async def rows(db, kind: str | None = None) -> list[Notification]:
    query = select(Notification).order_by(Notification.id)
    if kind:
        query = query.where(Notification.kind == kind)
    return list((await db.execute(query)).scalars())


async def seed_order(db) -> None:
    db.add(
        OrderBoardDoc(
            kind="salesorder", zoho_id="so1", header={"salesorder_number": "SO-00001", "customer_name": "Customer 1"}
        )
    )
    await db.commit()


@pytest.mark.asyncio
async def test_ready_notifies_order_readers_only(db_session, pushes):  # noqa: F811
    reader = await _user(db_session, "reader", perms=("orders:read",))
    await _user(db_session, "aito-only", perms=("aito:read",))
    await seed_order(db_session)
    await order_board_events.record(db_session, "so1", "order.ready", actor_class="system")
    await db_session.commit()
    await inbox.broadcast_pending(db_session)

    (row,) = await rows(db_session)
    assert (row.user_id, row.kind, row.family, row.title) == (reader.id, "orders.ready", "orders", "orders.ready")
    assert (row.body, row.target_type, row.target_ref) == ("SO-00001 · Customer 1", "order", "so1")
    assert pushes == [(reader.id, {"type": "inbox_changed", "user_ids": [reader.id]})]


@pytest.mark.asyncio
async def test_body_falls_back_when_order_not_stored(db_session):
    await _user(db_session, "reader", perms=("orders:read",))
    await order_board_events.record(db_session, "so9", "order.ready", actor_class="system")
    (row,) = await rows(db_session)
    assert row.body == "— · —"


@pytest.mark.asyncio
async def test_actor_not_notified(db_session):
    reader = await _user(db_session, "reader", perms=("orders:read",))
    other = await _user(db_session, "other", perms=("orders:read",))
    await seed_order(db_session)
    await order_board_events.record(db_session, "so1", "order.ready", actor_class="user", actor_name=reader.username)
    assert [r.user_id for r in await rows(db_session)] == [other.id]


@pytest.mark.asyncio
async def test_kind_off_in_prefs_skips(db_session):
    reader = await _user(db_session, "reader", perms=("orders:read",))
    db_session.add(UserInboxPreference(user_id=reader.id, kinds_json=["aito.paid"], sound_kinds_json=[]))
    await db_session.commit()
    await seed_order(db_session)
    await order_board_events.record(db_session, "so1", "order.ready", actor_class="system")
    assert await rows(db_session) == []


@pytest.mark.asyncio
async def test_other_events_ring_nothing(db_session):
    await _user(db_session, "reader", perms=("orders:read",))
    await order_board_events.record(db_session, "so1", "package.created", actor_class="system")
    await order_board_events.record(db_session, "so1", "order.received", actor_class="system", alert=False)
    assert await rows(db_session) == []


@pytest.mark.asyncio
async def test_alert_failure_keeps_the_event(db_session, monkeypatch):
    await _user(db_session, "reader", perms=("orders:read",))

    async def broken(db, user_id):
        raise RuntimeError("boom")

    monkeypatch.setattr(inbox, "preferences_for", broken)
    event = await order_board_events.record(db_session, "so1", "order.ready", actor_class="system")
    await db_session.commit()
    assert event is not None
    assert len(list((await db_session.execute(select(OrderBoardEvent))).scalars())) == 1
    assert await rows(db_session) == []


@pytest.mark.asyncio
async def test_first_load_sends_no_new_alerts(db_session, zoho, pushes):  # noqa: F811
    await _user(db_session, "reader", perms=("orders:read",))
    zoho.add({**order(1), "created_time": datetime.now(timezone.utc).isoformat()})
    await sync.run_pass(db_session)
    assert len(await order_board_events_of(db_session, "order.received")) == 1
    assert await rows(db_session, "orders.new") == []


@pytest.mark.asyncio
async def test_new_order_after_last_success_alerts(db_session, zoho, pushes):  # noqa: F811
    reader = await _user(db_session, "reader", perms=("orders:read",))
    zoho.add(order(1))
    await sync.run_pass(db_session)
    pushes.clear()
    now = datetime.now(timezone.utc)
    zoho.add({**order(2), "created_time": (now + timedelta(minutes=1)).isoformat()})
    # Already open before the last pass, read for the first time now (the deploy case): history, no bell.
    zoho.add({**order(3), "created_time": (now - timedelta(days=3)).isoformat()})
    await sync.run_pass(db_session)

    (row,) = await rows(db_session, "orders.new")
    assert (row.user_id, row.target_ref, row.body) == (reader.id, "so2", "SO-00002 · Customer 2")
    assert len(await order_board_events_of(db_session, "order.received")) == 3
    assert pushes == [(reader.id, {"type": "inbox_changed", "user_ids": [reader.id]})]


async def order_board_events_of(db, kind: str) -> list[OrderBoardEvent]:
    return list((await db.execute(select(OrderBoardEvent).where(OrderBoardEvent.kind == kind))).scalars())


@pytest.mark.asyncio
async def test_backfill_adds_order_kinds_once(db_session):
    a = await _user(db_session, "a", perms=("orders:read",))
    b = await _user(db_session, "b", perms=("orders:read",))
    db_session.add_all(
        [
            UserInboxPreference(user_id=a.id, kinds_json=["aito.paid"], sound_kinds_json=["aito.paid"]),
            UserInboxPreference(user_id=b.id, kinds_json=["aito.paid"], sound_kinds_json=[]),  # sound off
        ]
    )
    await db_session.commit()
    assert await order_board_events.backfill_alert_kinds(db_session) == 2
    prefs = {p.user_id: p for p in (await db_session.execute(select(UserInboxPreference))).scalars()}
    assert prefs[a.id].kinds_json == ["aito.paid", "orders.ready", "orders.new"]
    assert prefs[a.id].sound_kinds_json == ["aito.paid", "orders.ready"]
    assert prefs[b.id].sound_kinds_json == []
    prefs[a.id].kinds_json = ["aito.paid"]
    await db_session.commit()
    assert await order_board_events.backfill_alert_kinds(db_session) == 0


@pytest.mark.asyncio
async def test_migration_adds_target_ref():
    from backend.app.core.database import run_migrations
    from backend.tests.unit.test_aito_quote_status_confirmed_migration import _make_engine

    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            await conn.execute(text("ALTER TABLE notifications DROP COLUMN target_ref"))
        for _ in range(2):  # a second boot is a no-op
            async with engine.begin() as conn:
                await run_migrations(conn)
        async with engine.connect() as conn:
            info = {row[1]: row for row in (await conn.execute(text("PRAGMA table_info(notifications)"))).all()}
        assert "target_ref" in info and info["target_ref"][3] == 0
    finally:
        await engine.dispose()
