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
    await db_session.rollback()
    assert (await db_session.execute(select(Notification))).scalars().first() is None


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
    assert set(watch.kinds_json) == {k for k in inbox.DEFAULT_KINDS if k.startswith("aito.")}

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
async def test_the_hourly_invoice_sweep_purges_old_rows(db_session):
    from backend.app.services.aito_invoice_sweep import sweep_invoices

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
    await sweep_invoices(db_session, force=True)
    assert (await db_session.execute(select(Notification))).scalars().first() is None


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
