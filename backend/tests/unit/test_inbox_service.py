"""services/inbox.py: which Aito events become inbox rows, for whom."""

from datetime import datetime, timedelta

import pytest
from sqlalchemy import select

from backend.app.models.notification_inbox import AitoWatch, Notification, UserInboxPreference
from backend.app.services import inbox
from backend.app.services.aito_events import record
from backend.tests.unit.test_aito_merge import _create_with_tasks


async def _user(db, name, perms=("aito:read", "aito:update")):
    """A persisted user whose only group grants ``perms`` — built the way
    test_aito_permissions.py's `aito_tokens` fixture builds its principals."""
    from backend.app.core.auth import get_password_hash
    from backend.app.models.group import Group
    from backend.app.models.user import User

    group = Group(name=f"inbox-{name}", permissions=list(perms), is_system=False)
    db.add(group)
    await db.flush()
    user = User(username=f"inbox-{name}", password_hash=get_password_hash("password"), is_active=True)
    user.groups.append(group)
    db.add(user)
    await db.commit()
    return user


@pytest.fixture(autouse=True)
def reset_sweep_gates():
    """The sweeps' hourly gates are module state: reset them around every
    test so a test's pass never closes the gate for the next one in the same
    xdist worker (mirrors test_aito_invoice_sweep.py's reset)."""
    from backend.app.services import aito_invoice_sweep

    aito_invoice_sweep._last_run = 0.0
    aito_invoice_sweep._last_inbox_run = 0.0
    yield
    aito_invoice_sweep._last_run = 0.0
    aito_invoice_sweep._last_inbox_run = 0.0


@pytest.fixture
def pushes(monkeypatch):
    sent: list[tuple[int, dict]] = []

    async def fake_broadcast_to_user(user_id, message):
        sent.append((user_id, message))

    monkeypatch.setattr(inbox.ws_manager, "broadcast_to_user", fake_broadcast_to_user)
    return sent


@pytest.mark.asyncio
async def test_kind_mapping():
    assert inbox.inbox_kind_for("quote.accepted") == "aito.quote_accepted"
    assert inbox.inbox_kind_for("quote.viewed") == "aito.quote_viewed"
    assert inbox.inbox_kind_for("quote.declined") == "aito.quote_declined"
    assert inbox.inbox_kind_for("payment_link.paid") == "aito.paid"
    assert inbox.inbox_kind_for("payment.terminal.paid") == "aito.paid"
    assert inbox.inbox_kind_for("payment.manual.recorded") == "aito.paid"
    assert inbox.inbox_kind_for("task.added") is None
    assert "aito.overdue" in inbox.KINDS and "aito.overdue" not in inbox.DEFAULT_KINDS
    assert "printer.finished" in inbox.KINDS and "printer.finished" not in inbox.DEFAULT_KINDS
    assert set(inbox.DEFAULT_KINDS) == {"aito.quote_viewed", "aito.quote_accepted", "aito.quote_declined", "aito.paid"}


@pytest.mark.asyncio
async def test_fan_out_writes_one_row_per_watcher_who_wants_the_kind(async_client, db_session, pushes):
    alice = await _user(db_session, "alice")
    bob = await _user(db_session, "bob")  # watches a different kind
    carol = await _user(db_session, "carol")  # watches it, but her preferences turn it off
    dave = await _user(db_session, "dave", perms=())  # watches it, but cannot read Aito
    p = await _create_with_tasks(async_client, [])
    db_session.add_all(
        [
            AitoWatch(user_id=alice.id, project_id=p["id"], kinds_json=["aito.quote_accepted"]),
            AitoWatch(user_id=bob.id, project_id=p["id"], kinds_json=["aito.quote_viewed"]),
            AitoWatch(user_id=carol.id, project_id=p["id"], kinds_json=["aito.quote_accepted"]),
            AitoWatch(user_id=dave.id, project_id=p["id"], kinds_json=["aito.quote_accepted"]),
            UserInboxPreference(user_id=carol.id, kinds_json=[], sound_kinds_json=[], auto_watch=False),
        ]
    )
    await db_session.commit()

    await record(db_session, p["id"], "quote.accepted", actor_class="client")
    assert db_session.info["inbox_users"] == {alice.id}
    await db_session.commit()
    assert pushes == []  # nothing goes out until the caller drains after commit

    rows = list((await db_session.execute(select(Notification))).scalars())
    assert [r.user_id for r in rows] == [alice.id]
    assert rows[0].kind == "aito.quote_accepted" and rows[0].family == "aito"
    assert rows[0].target_type == "aito_project" and rows[0].target_id == p["id"]
    assert "ACME" in rows[0].body and rows[0].read_at is None

    await inbox.broadcast_pending(db_session)
    assert pushes == [(alice.id, {"type": "inbox_changed", "user_ids": [alice.id]})]
    assert not db_session.info.get("inbox_users")


@pytest.mark.asyncio
async def test_unmapped_event_writes_nothing(async_client, db_session):
    alice = await _user(db_session, "alice")
    p = await _create_with_tasks(async_client, [])
    db_session.add(AitoWatch(user_id=alice.id, project_id=p["id"], kinds_json=list(inbox.DEFAULT_KINDS)))
    await db_session.commit()
    await record(db_session, p["id"], "note.added", actor_class="user", note="hello")
    await db_session.commit()
    assert (await db_session.execute(select(Notification))).scalars().first() is None
    assert not db_session.info.get("inbox_users")


@pytest.mark.asyncio
async def test_rows_roll_back_with_the_event(async_client, db_session):
    alice = await _user(db_session, "alice")
    p = await _create_with_tasks(async_client, [])
    db_session.add(AitoWatch(user_id=alice.id, project_id=p["id"], kinds_json=["aito.quote_accepted"]))
    await db_session.commit()
    await record(db_session, p["id"], "quote.accepted", actor_class="client")
    assert db_session.info["inbox_users"] == {alice.id}
    await db_session.rollback()
    assert (await db_session.execute(select(Notification))).scalars().first() is None
    assert not db_session.info.get("inbox_users")  # nobody is told about a row that never landed


@pytest.mark.asyncio
async def test_a_failing_commit_after_a_fan_out_leaves_no_pending_push(async_client, db_session, pushes):
    """The commit itself fails (here a duplicate watch trips the unique
    constraint) and the caller rolls back, as every commit site does: the
    recipients noted by fan_out go with the rows, so a later drain on the
    same session pushes nothing."""
    from sqlalchemy.exc import IntegrityError

    alice = await _user(db_session, "alice")
    p = await _create_with_tasks(async_client, [])
    db_session.add(AitoWatch(user_id=alice.id, project_id=p["id"], kinds_json=["aito.quote_accepted"]))
    await db_session.commit()

    await record(db_session, p["id"], "quote.accepted", actor_class="client")
    assert db_session.info["inbox_users"] == {alice.id}
    db_session.add(AitoWatch(user_id=alice.id, project_id=p["id"], kinds_json=[]))
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()

    assert not db_session.info.get("inbox_users")
    await inbox.broadcast_pending(db_session)
    assert pushes == []
    assert (await db_session.execute(select(Notification))).scalars().first() is None


@pytest.mark.asyncio
async def test_a_rolled_back_savepoint_keeps_the_ids_noted_before_it(async_client, db_session):
    """Only the outermost rollback forgets: a savepoint rolled back after the
    fan-out leaves the event's row, so its recipient must still be nudged."""
    alice = await _user(db_session, "alice")
    p = await _create_with_tasks(async_client, [])
    db_session.add(AitoWatch(user_id=alice.id, project_id=p["id"], kinds_json=["aito.quote_accepted"]))
    await db_session.commit()

    await record(db_session, p["id"], "quote.accepted", actor_class="client")
    savepoint = await db_session.begin_nested()
    await savepoint.rollback()
    assert db_session.info["inbox_users"] == {alice.id}
    await db_session.commit()
    assert [r.user_id for r in (await db_session.execute(select(Notification))).scalars()] == [alice.id]


@pytest.mark.asyncio
async def test_commit_and_wake_drains_the_pending_pushes(async_client, db_session, pushes):
    """Every route that commits through `_commit_and_wake` nudges the
    recipients its events fanned out to — after the commit, not before."""
    from backend.app.api.routes.aito import _commit_and_wake

    alice = await _user(db_session, "alice")
    p = await _create_with_tasks(async_client, [])
    db_session.add(AitoWatch(user_id=alice.id, project_id=p["id"], kinds_json=["aito.quote_accepted"]))
    await db_session.commit()

    await record(db_session, p["id"], "quote.accepted", actor_class="client")
    assert pushes == []
    await _commit_and_wake(db_session, False)
    assert pushes == [(alice.id, {"type": "inbox_changed", "user_ids": [alice.id]})]
    assert not db_session.info.get("inbox_users")
    assert [r.user_id for r in (await db_session.execute(select(Notification))).scalars()] == [alice.id]


@pytest.mark.asyncio
async def test_auto_watch_and_purge(async_client, db_session):
    alice = await _user(db_session, "alice")
    p = await _create_with_tasks(async_client, [])
    await inbox.auto_watch(db_session, p["id"], alice.id)
    await inbox.auto_watch(db_session, p["id"], alice.id)  # idempotent
    await inbox.auto_watch(db_session, p["id"], None)  # auth disabled: nobody to watch
    await db_session.commit()
    watch = (await db_session.execute(select(AitoWatch))).scalars().one()
    assert watch.user_id == alice.id
    assert watch.kinds_json is None  # an auto-watch follows Settings

    old = Notification(
        user_id=alice.id,
        kind="aito.paid",
        family="aito",
        title="x",
        body="y",
        created_at=datetime.utcnow() - timedelta(days=31),
    )
    fresh = Notification(user_id=alice.id, kind="aito.paid", family="aito", title="x", body="y")
    db_session.add_all([old, fresh])
    await db_session.commit()
    assert await inbox.purge_old(db_session, now=datetime.utcnow()) == 1
    await db_session.commit()
    assert [r.id for r in (await db_session.execute(select(Notification))).scalars()] == [fresh.id]


@pytest.mark.asyncio
async def test_the_hourly_inbox_sweep_purges_old_rows(db_session):
    from backend.app.services.aito_invoice_sweep import sweep_inbox

    alice = await _user(db_session, "alice")
    db_session.add(
        Notification(
            user_id=alice.id,
            kind="aito.paid",
            family="aito",
            title="x",
            body="y",
            created_at=datetime.utcnow() - timedelta(days=45),
        )
    )
    await db_session.commit()
    await sweep_inbox(db_session, force=True)
    assert (await db_session.execute(select(Notification))).scalars().first() is None


@pytest.mark.asyncio
async def test_a_failing_inbox_sweep_rolls_back_and_skips_the_broadcast(db_session, monkeypatch):
    """A database error in the overdue/purge step is logged and rolled back so
    the session stays usable for the next sync step; nothing is broadcast."""
    from sqlalchemy.exc import SQLAlchemyError

    from backend.app.services import aito_invoice_sweep

    async def boom(*_a, **_k):
        raise SQLAlchemyError("overdue failed")

    broadcast = []

    async def fake_broadcast(*_a, **_k):
        broadcast.append(1)

    monkeypatch.setattr(aito_invoice_sweep, "_record_overdue", boom)
    monkeypatch.setattr(aito_invoice_sweep, "broadcast_pending", fake_broadcast)
    await db_session.execute(select(Notification))  # open a transaction
    assert db_session.in_transaction()

    await aito_invoice_sweep.sweep_inbox(db_session, force=True)

    assert not db_session.in_transaction()
    assert broadcast == []
    assert (await db_session.execute(select(Notification))).scalars().first() is None


@pytest.mark.asyncio
async def test_a_failing_rollback_in_the_inbox_sweep_is_swallowed(db_session, monkeypatch):
    from sqlalchemy.exc import SQLAlchemyError

    from backend.app.services import aito_invoice_sweep

    async def boom(*_a, **_k):
        raise SQLAlchemyError("overdue failed")

    async def bad_rollback():
        raise SQLAlchemyError("rollback failed")

    broadcast = []

    async def fake_broadcast(*_a, **_k):
        broadcast.append(1)

    monkeypatch.setattr(aito_invoice_sweep, "_record_overdue", boom)
    monkeypatch.setattr(aito_invoice_sweep, "broadcast_pending", fake_broadcast)
    monkeypatch.setattr(db_session, "rollback", bad_rollback)

    await aito_invoice_sweep.sweep_inbox(db_session, force=True)

    assert broadcast == []


@pytest.mark.asyncio
async def test_a_failing_books_pass_still_purges_the_inbox(db_session, test_engine, monkeypatch):
    """The purge is its own step of the sync tick: a Books outage that makes
    the invoice sweep raise does not keep 30-day-old rows around."""
    import asyncio
    import contextlib

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from backend.app.services import (
        aito_contact_poll,
        aito_invoice_poll,
        aito_invoice_sweep,
        aito_payment_links,
        aito_quote_sync,
        aito_terminal_payments,
    )
    from backend.app.services.zoho import ZohoUpstreamError

    alice = await _user(db_session, "alice")
    db_session.add(
        Notification(
            user_id=alice.id,
            kind="aito.paid",
            family="aito",
            title="x",
            body="y",
            created_at=datetime.utcnow() - timedelta(days=45),
        )
    )
    await db_session.commit()

    async def ok(*_args, **_kwargs):
        return 0

    async def books_down(db, **_kwargs):
        raise ZohoUpstreamError("HTTP 503")

    tick_done = asyncio.Event()

    async def last_pass(db):
        tick_done.set()

    monkeypatch.setattr(aito_quote_sync, "_wake", asyncio.Event())
    monkeypatch.setattr(aito_quote_sync, "run_change_pass", ok)
    monkeypatch.setattr(aito_quote_sync, "_throttled_until", None)
    monkeypatch.setattr(aito_invoice_sweep, "_last_inbox_run", 0.0)
    monkeypatch.setattr(
        aito_quote_sync, "async_session", async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    )
    monkeypatch.setattr(aito_quote_sync, "sync_enabled", lambda db: _true())
    monkeypatch.setattr(aito_quote_sync.zoho_service, "is_configured", lambda db: _true())
    monkeypatch.setattr(aito_quote_sync, "sync_interval_seconds", lambda db: _value(300))
    monkeypatch.setattr(aito_quote_sync, "run_sync_once", ok)
    monkeypatch.setattr(aito_quote_sync, "sweep_invoices", books_down)
    monkeypatch.setattr(aito_invoice_poll, "poll_invoices", ok)
    monkeypatch.setattr(aito_contact_poll, "poll_contacts", ok)
    monkeypatch.setattr(aito_payment_links, "reconcile_payment_links", ok)
    monkeypatch.setattr(aito_terminal_payments, "poll_open_terminal_payments", last_pass)

    loop_task = asyncio.create_task(aito_quote_sync.run_sync_loop())
    try:
        await asyncio.wait_for(tick_done.wait(), timeout=10)
    finally:
        loop_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await loop_task
    db_session.expire_all()
    assert (await db_session.execute(select(Notification))).scalars().first() is None


async def _value(value):
    return value


async def _true():
    return True


@pytest.mark.asyncio
async def test_auto_watch_respects_the_preference(async_client, db_session):
    alice = await _user(db_session, "alice")
    p = await _create_with_tasks(async_client, [])
    db_session.add(UserInboxPreference(user_id=alice.id, kinds_json=[], sound_kinds_json=[], auto_watch=False))
    await db_session.commit()
    await inbox.auto_watch(db_session, p["id"], alice.id)
    await db_session.commit()
    assert (await db_session.execute(select(AitoWatch))).scalars().first() is None


@pytest.mark.asyncio
async def test_routes_auto_watch_the_creator_and_nudge_after_commit(async_client, db_session, pushes):
    """End to end through the routes: creating a card (and splitting one)
    watches it for the signed-in creator; a decision another user records
    lands in the creator's inbox and is pushed after the commit."""
    from backend.app.core.auth import create_access_token
    from backend.app.models.settings import Settings

    perms = ("aito:read", "aito:create", "aito:update")
    alice = await _user(db_session, "alice", perms)
    bob = await _user(db_session, "bob", perms)
    db_session.add(Settings(key="auth_enabled", value="true"))
    await db_session.commit()
    as_alice = {"Authorization": f"Bearer {create_access_token(data={'sub': alice.username})}"}
    as_bob = {"Authorization": f"Bearer {create_access_token(data={'sub': bob.username})}"}

    resp = await async_client.post(
        "/api/v1/aito/",
        json={
            "description": "Watch me",
            "client_id": "z1",
            "client_name": "ACME",
            "client_phone": "+689 87 00 00 00",
            "tasks": [{}, {}],
        },
        headers=as_alice,
    )
    assert resp.status_code == 201, resp.text
    project_id = resp.json()["id"]
    watches = list((await db_session.execute(select(AitoWatch))).scalars())
    assert [(w.user_id, w.project_id) for w in watches] == [(alice.id, project_id)]

    tasks = (await async_client.get(f"/api/v1/aito/{project_id}/tasks", headers=as_bob)).json()
    resp = await async_client.post(
        f"/api/v1/aito/{project_id}/tasks/transfer", json={"task_ids": [tasks[0]["id"]]}, headers=as_bob
    )
    assert resp.status_code == 200, resp.text
    split_id = resp.json()["target"]["id"]
    watch = (await db_session.execute(select(AitoWatch).where(AitoWatch.project_id == split_id))).scalar_one()
    assert watch.user_id == bob.id

    resp = await async_client.post(
        f"/api/v1/aito/{project_id}/quote-status", json={"status": "accepted"}, headers=as_bob
    )
    assert resp.status_code == 200, resp.text
    rows = list((await db_session.execute(select(Notification))).scalars())
    assert [(r.user_id, r.kind, r.target_id) for r in rows] == [(alice.id, "aito.quote_accepted", project_id)]
    assert pushes == [(alice.id, {"type": "inbox_changed", "user_ids": [alice.id]})]


@pytest.mark.asyncio
async def test_a_watcher_is_not_notified_about_their_own_action(async_client, db_session, pushes):
    """The creator accepts the quote by hand on a card they auto-watch: no
    row for them. Another watcher of the same card still gets one."""
    from backend.app.core.auth import create_access_token
    from backend.app.models.settings import Settings

    perms = ("aito:read", "aito:create", "aito:update")
    alice = await _user(db_session, "alice", perms)
    bob = await _user(db_session, "bob", perms)
    db_session.add(Settings(key="auth_enabled", value="true"))
    await db_session.commit()
    as_alice = {"Authorization": f"Bearer {create_access_token(data={'sub': alice.username})}"}
    as_bob = {"Authorization": f"Bearer {create_access_token(data={'sub': bob.username})}"}

    resp = await async_client.post(
        "/api/v1/aito/",
        json={"description": "Mine", "client_id": "z1", "client_name": "ACME", "client_phone": "+689 87 00 00 00"},
        headers=as_alice,
    )
    assert resp.status_code == 201, resp.text
    project_id = resp.json()["id"]
    resp = await async_client.put(
        f"/api/v1/aito/{project_id}/watch", json={"kinds": ["aito.quote_accepted"]}, headers=as_bob
    )
    assert resp.status_code == 200, resp.text

    resp = await async_client.post(
        f"/api/v1/aito/{project_id}/quote-status", json={"status": "accepted"}, headers=as_alice
    )
    assert resp.status_code == 200, resp.text
    rows = list((await db_session.execute(select(Notification))).scalars())
    assert [(r.user_id, r.kind) for r in rows] == [(bob.id, "aito.quote_accepted")]
    assert pushes == [(bob.id, {"type": "inbox_changed", "user_ids": [bob.id]})]


@pytest.mark.asyncio
async def test_a_client_action_still_reaches_a_watcher_who_shares_the_actor_name(async_client, db_session):
    """Only a USER event is the watcher's own: a client decision recorded with
    an actor name equal to a username is still news to that user."""
    alice = await _user(db_session, "alice")
    p = await _create_with_tasks(async_client, [])
    db_session.add(AitoWatch(user_id=alice.id, project_id=p["id"], kinds_json=["aito.quote_accepted"]))
    await db_session.commit()
    await record(db_session, p["id"], "quote.accepted", actor_class="client", actor_name=alice.username)
    await db_session.commit()
    rows = list((await db_session.execute(select(Notification))).scalars())
    assert [r.user_id for r in rows] == [alice.id]


@pytest.mark.asyncio
async def test_history_older_than_the_watch_is_not_news(async_client, db_session):
    """Importing a quote auto-watches it, then the first comment mirror
    records the quote's PAST Books history with its past occurred_at. Those
    events predate the watch and write no row; a later one does."""
    alice = await _user(db_session, "alice")
    p = await _create_with_tasks(async_client, [])
    watched_at = datetime.utcnow()
    db_session.add(
        AitoWatch(
            user_id=alice.id,
            project_id=p["id"],
            kinds_json=["aito.quote_viewed", "aito.quote_accepted"],
            created_at=watched_at,
        )
    )
    await db_session.commit()

    await record(db_session, p["id"], "quote.viewed", actor_class="client", occurred_at=watched_at - timedelta(days=3))
    await db_session.commit()
    assert (await db_session.execute(select(Notification))).scalars().first() is None

    await record(
        db_session, p["id"], "quote.accepted", actor_class="client", occurred_at=watched_at + timedelta(seconds=5)
    )
    await db_session.commit()
    rows = list((await db_session.execute(select(Notification))).scalars())
    assert [(r.user_id, r.kind) for r in rows] == [(alice.id, "aito.quote_accepted")]


@pytest.mark.asyncio
async def test_an_auto_watch_stores_no_kinds_and_follows_settings(async_client, db_session):
    """An auto-watch means "follow my Settings": a kind enabled AFTER the
    watch was made reaches it, and one turned off stops reaching it."""
    alice = await _user(db_session, "alice")
    p = await _create_with_tasks(async_client, [])
    await inbox.auto_watch(db_session, p["id"], alice.id)
    await db_session.commit()
    watch = (await db_session.execute(select(AitoWatch))).scalars().one()
    assert watch.kinds_json is None
    watch.created_at = datetime.utcnow() - timedelta(minutes=5)

    # Defaults leave overdue off: nothing yet.
    await record(db_session, p["id"], "project.due.overdue", actor_class="system")
    await db_session.commit()
    assert (await db_session.execute(select(Notification))).scalars().first() is None

    # Enabled in Settings later — the existing auto-watch now delivers it.
    db_session.add(
        UserInboxPreference(user_id=alice.id, kinds_json=["aito.overdue"], sound_kinds_json=[], auto_watch=True)
    )
    await db_session.commit()
    await record(db_session, p["id"], "project.due.overdue", actor_class="system", detail={"day": 2})
    await record(db_session, p["id"], "quote.accepted", actor_class="client")  # default kind, now turned off
    await db_session.commit()
    rows = list((await db_session.execute(select(Notification))).scalars())
    assert [(r.user_id, r.kind) for r in rows] == [(alice.id, "aito.overdue")]


@pytest.mark.asyncio
async def test_an_explicit_watch_keeps_its_own_list_within_settings(async_client, db_session):
    alice = await _user(db_session, "alice")
    p = await _create_with_tasks(async_client, [])
    db_session.add_all(
        [
            AitoWatch(
                user_id=alice.id,
                project_id=p["id"],
                kinds_json=["aito.quote_accepted"],
                created_at=datetime.utcnow() - timedelta(minutes=5),
            ),
            UserInboxPreference(
                user_id=alice.id,
                kinds_json=["aito.quote_accepted", "aito.quote_declined"],
                sound_kinds_json=[],
                auto_watch=True,
            ),
        ]
    )
    await db_session.commit()
    await record(db_session, p["id"], "quote.declined", actor_class="client")  # enabled, but not on this watch
    await db_session.commit()
    assert (await db_session.execute(select(Notification))).scalars().first() is None


@pytest.mark.asyncio
async def test_a_failing_push_is_logged_and_the_other_recipients_are_still_nudged(db_session, monkeypatch, caplog):
    sent: list[int] = []

    async def flaky_broadcast_to_user(user_id, message):
        if user_id == 1:
            raise RuntimeError("socket gone")
        sent.append(user_id)

    monkeypatch.setattr(inbox.ws_manager, "broadcast_to_user", flaky_broadcast_to_user)
    db_session.info["inbox_users"] = {1, 2}

    with caplog.at_level("WARNING"):
        await inbox.broadcast_pending(db_session)

    assert sent == [2]
    assert "inbox_changed push failed for user 1" in caplog.text
    assert not db_session.info.get("inbox_users")


def test_retention_is_thirty_days():
    assert inbox.RETENTION_DAYS == 30


@pytest.mark.asyncio
async def test_purge_old_deletes_only_rows_strictly_older_than_the_retention_window(async_client, db_session):
    alice = await _user(db_session, "alice")
    now = datetime(2026, 6, 15, 12, 0, 0)
    window = timedelta(days=inbox.RETENTION_DAYS)
    for title, age in (
        ("exactly", window),
        ("just-inside", window - timedelta(seconds=1)),
        ("just-outside", window + timedelta(seconds=1)),
    ):
        db_session.add(
            Notification(user_id=alice.id, kind="aito.paid", family="aito", title=title, body="y", created_at=now - age)
        )
    await db_session.commit()

    assert await inbox.purge_old(db_session, now=now) == 1
    await db_session.commit()

    titles = {r.title for r in (await db_session.execute(select(Notification))).scalars()}
    assert titles == {"exactly", "just-inside"}
