"""Bell alerts for the Order Board: a ready order, and a new one (not old history read for the first time)."""

from datetime import datetime, timezone

import pytest
from sqlalchemy import delete, select, text

from backend.app.models.notification_inbox import Notification, OrderWatch, UserInboxPreference
from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.models.order_board_event import OrderBoardEvent
from backend.app.services import inbox, order_board_events, order_board_sync as sync
from backend.app.services.order_board_sync import _pass as sync_pass
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
async def test_a_watch_beats_a_kind_switched_off_for_that_order_only(db_session):
    reader = await _user(db_session, "reader", perms=("orders:read",))
    gone = await _user(db_session, "lost-access", perms=("aito:read",))
    db_session.add(UserInboxPreference(user_id=reader.id, kinds_json=["aito.paid"], sound_kinds_json=[]))
    db_session.add_all([OrderWatch(user_id=u.id, salesorder_id="so1") for u in (reader, gone)])
    await db_session.commit()
    await seed_order(db_session)
    await order_board_events.record(db_session, "so1", "order.ready", actor_class="system")
    await order_board_events.record(db_session, "so2", "order.ready", actor_class="system")  # not watched: prefs rule
    await order_board_events.record(db_session, "so1", "order.ready", actor_class="user", actor_name=reader.username)
    # One row: the watched order; a watcher without orders:read gets nothing, nor does the actor.
    assert [(r.user_id, r.target_ref) for r in await rows(db_session)] == [(reader.id, "so1")]


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


async def markers(db) -> list[str]:
    query = select(OrderBoardDoc.zoho_id).where(OrderBoardDoc.kind == "alert_new")
    return list((await db.execute(query)).scalars())


async def new_alerts(db) -> list[str]:
    return [r.target_ref for r in await rows(db, "orders.new")]


@pytest.mark.asyncio
async def test_order_created_during_a_pass_alerts_once_next_pass(db_session, zoho, pushes):  # noqa: F811
    reader = await _user(db_session, "reader", perms=("orders:read",))
    zoho.add(order(1))
    created_mid_pass = datetime.now(timezone.utc).isoformat()  # before the pass stamps its success
    await sync.run_pass(db_session)
    pushes.clear()
    zoho.add({**order(2), "created_time": created_mid_pass})
    await sync.run_pass(db_session)

    (row,) = await rows(db_session, "orders.new")
    assert (row.user_id, row.target_ref, row.body) == (reader.id, "so2", "SO-00002 · Customer 2")
    assert await markers(db_session) == []
    assert pushes == [(reader.id, {"type": "inbox_changed", "user_ids": [reader.id]})]
    zoho.orders["so2"] = {**zoho.orders["so2"], "last_modified_time": "2026-11-02T08:00:00-1000"}
    await sync.run_pass(db_session)
    assert await new_alerts(db_session) == ["so2"]


@pytest.mark.asyncio
async def test_order_deferred_by_the_cap_alerts_when_fetched(db_session, zoho, monkeypatch):
    await _user(db_session, "reader", perms=("orders:read",))
    zoho.add(order(1))
    await sync.run_pass(db_session)
    monkeypatch.setattr(sync_pass, "MAX_DETAILS_PER_PASS", 1)
    zoho.add(order(2, age=1), order(3, age=9), order(4, age=8))  # oldest first: so2 waits two passes
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    assert await new_alerts(db_session) == ["so3", "so4"]
    assert await markers(db_session) == ["so2"]
    await sync.run_pass(db_session)
    assert await new_alerts(db_session) == ["so3", "so4", "so2"]
    assert await markers(db_session) == []


@pytest.mark.asyncio
async def test_reset_sends_no_alert(db_session, zoho):
    await _user(db_session, "reader", perms=("orders:read",))
    zoho.add(order(1))
    await sync.run_pass(db_session)
    await db_session.execute(delete(OrderBoardDoc))  # the disposable copy, state row included
    await db_session.commit()
    zoho.add(order(2))
    await sync.run_pass(db_session)
    assert await rows(db_session) == [] and await markers(db_session) == []


@pytest.mark.asyncio
async def test_order_gone_before_its_detail_leaves_no_marker(db_session, zoho, monkeypatch):
    await _user(db_session, "reader", perms=("orders:read",))
    zoho.add(order(1))
    await sync.run_pass(db_session)
    monkeypatch.setattr(sync_pass, "MAX_DETAILS_PER_PASS", 0)
    zoho.add(order(2))
    await sync.run_pass(db_session)
    assert await markers(db_session) == ["so2"]
    del zoho.orders["so2"]
    await sync.run_pass(db_session)
    assert await markers(db_session) == [] and await rows(db_session) == []


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
    assert prefs[a.id].kinds_json == ["aito.paid", "orders.ready", "orders.new", "orders.packed"]
    assert prefs[a.id].sound_kinds_json == ["aito.paid", "orders.ready", "orders.packed"]
    assert prefs[b.id].sound_kinds_json == []
    prefs[a.id].kinds_json = ["aito.paid"]
    await db_session.commit()
    assert await order_board_events.backfill_alert_kinds(db_session) == 0


@pytest.mark.asyncio
async def test_backfill_offers_only_the_kinds_added_since_the_first_run(db_session):
    from backend.app.api.routes.settings import set_setting

    a = await _user(db_session, "a", perms=("orders:read",))
    db_session.add(UserInboxPreference(user_id=a.id, kinds_json=["orders.new"], sound_kinds_json=[]))  # ready: off
    await set_setting(db_session, "orders_inbox_kinds_backfilled", "1")  # what the first version stored
    await db_session.commit()
    assert await order_board_events.backfill_alert_kinds(db_session) == 1
    pref = (await db_session.execute(select(UserInboxPreference))).scalar_one()
    assert pref.kinds_json == ["orders.new", "orders.packed"]  # the kind switched off stays off
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
