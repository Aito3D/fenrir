"""/api/v1/inbox: each user's own rows, read marks, and inbox preferences."""

from dataclasses import dataclass
from datetime import datetime

import pytest
from sqlalchemy import select

from backend.app.models.notification_inbox import Notification, UserInboxPreference
from backend.app.services import inbox
from backend.tests.unit.test_inbox_service import _user


@dataclass
class _Principal:
    id: int
    headers: dict


@pytest.fixture
async def inbox_users(db_session):
    """Two real users under auth-enabled, each with a genuine JWT."""
    from backend.app.core.auth import create_access_token
    from backend.app.models.settings import Settings

    alice = await _user(db_session, "alice")
    bob = await _user(db_session, "bob")
    db_session.add(Settings(key="auth_enabled", value="true"))
    await db_session.commit()

    def principal(user):
        token = create_access_token(data={"sub": user.username})
        return _Principal(id=user.id, headers={"Authorization": f"Bearer {token}"})

    return principal(alice), principal(bob)


async def _seed(db, user_id: int, n: int, *, read: bool = False) -> list[int]:
    rows = [
        Notification(
            user_id=user_id,
            kind="aito.paid",
            family="aito",
            title="aito.paid",
            body=f"row {i}",
            target_type="aito_project",
            target_id=i,
            read_at=datetime(2026, 9, 30) if read else None,
        )
        for i in range(n)
    ]
    db.add_all(rows)
    await db.commit()
    return [r.id for r in rows]


@pytest.mark.asyncio
async def test_inbox_lists_own_rows_newest_first_with_unread_count(async_client, db_session, inbox_users):
    alice, bob = inbox_users
    alice_ids = await _seed(db_session, alice.id, 2)
    alice_ids += await _seed(db_session, alice.id, 1, read=True)
    await _seed(db_session, bob.id, 1)

    r = await async_client.get("/api/v1/inbox", headers=alice.headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert [i["id"] for i in body["items"]] == sorted(alice_ids, reverse=True)
    assert body["unread"] == 2
    first = body["items"][0]
    assert set(first) == {
        "id",
        "kind",
        "family",
        "title",
        "body",
        "target_type",
        "target_id",
        "created_at",
        "read_at",
    }
    assert first["kind"] == "aito.paid" and first["family"] == "aito" and first["read_at"] is not None


@pytest.mark.asyncio
async def test_mark_read_only_touches_own_rows(async_client, db_session, inbox_users):
    alice, bob = inbox_users
    (row_id,) = await _seed(db_session, alice.id, 1)

    r = await async_client.post(f"/api/v1/inbox/{row_id}/read", headers=bob.headers)
    assert r.status_code == 404
    r = await async_client.post("/api/v1/inbox/999999/read", headers=alice.headers)
    assert r.status_code == 404

    r = await async_client.post(f"/api/v1/inbox/{row_id}/read", headers=alice.headers)
    assert r.status_code == 204
    page = (await async_client.get("/api/v1/inbox", headers=alice.headers)).json()
    assert page["unread"] == 0 and page["items"][0]["read_at"] is not None
    first_read_at = page["items"][0]["read_at"]

    # Idempotent: a second mark keeps the first read time.
    r = await async_client.post(f"/api/v1/inbox/{row_id}/read", headers=alice.headers)
    assert r.status_code == 204
    page = (await async_client.get("/api/v1/inbox", headers=alice.headers)).json()
    assert page["items"][0]["read_at"] == first_read_at


@pytest.mark.asyncio
async def test_read_all_and_pagination(async_client, db_session, inbox_users):
    alice, bob = inbox_users
    ids = await _seed(db_session, alice.id, 5)
    bob_ids = await _seed(db_session, bob.id, 2)

    r = await async_client.get("/api/v1/inbox", params={"limit": 2}, headers=alice.headers)
    assert [i["id"] for i in r.json()["items"]] == [ids[4], ids[3]]
    r = await async_client.get("/api/v1/inbox", params={"limit": 2, "before": ids[3]}, headers=alice.headers)
    assert [i["id"] for i in r.json()["items"]] == [ids[2], ids[1]]
    assert r.json()["unread"] == 5  # the count is the whole inbox, not the page

    r = await async_client.post("/api/v1/inbox/read-all", headers=alice.headers)
    assert r.status_code == 204
    assert (await async_client.get("/api/v1/inbox", headers=alice.headers)).json()["unread"] == 0
    # Bob's rows are his own business.
    page = (await async_client.get("/api/v1/inbox", headers=bob.headers)).json()
    assert page["unread"] == 2 and [i["id"] for i in page["items"]] == sorted(bob_ids, reverse=True)


@pytest.mark.asyncio
async def test_preferences_roundtrip_and_validation(async_client, db_session, inbox_users):
    alice, bob = inbox_users

    r = await async_client.get("/api/v1/inbox/preferences", headers=alice.headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kinds"] == inbox.DEFAULT_KINDS
    assert body["sound_kinds"] == inbox.DEFAULT_KINDS
    assert body["auto_watch"] is True
    available = {a["kind"]: a for a in body["available"]}
    assert list(available) == list(inbox.KINDS)
    assert available["aito.paid"] == {"kind": "aito.paid", "family": "aito", "default_on": True, "available": True}
    assert available["aito.overdue"]["default_on"] is False and available["aito.overdue"]["available"] is True
    assert all(not a["available"] for k, a in available.items() if k.startswith("printer."))

    for bad in (
        {"kinds": ["aito.nope"], "sound_kinds": [], "auto_watch": True},
        {"kinds": ["aito.paid"], "sound_kinds": ["aito.quote_viewed"], "auto_watch": True},
    ):
        r = await async_client.put("/api/v1/inbox/preferences", json=bad, headers=alice.headers)
        assert r.status_code == 422, (bad, r.text)
    assert (await db_session.execute(select(UserInboxPreference))).scalars().first() is None

    wanted = {"kinds": ["aito.paid", "aito.overdue"], "sound_kinds": ["aito.paid"], "auto_watch": False}
    r = await async_client.put("/api/v1/inbox/preferences", json=wanted, headers=alice.headers)
    assert r.status_code == 200, r.text
    assert {k: r.json()[k] for k in wanted} == wanted
    r = await async_client.get("/api/v1/inbox/preferences", headers=alice.headers)
    assert {k: r.json()[k] for k in wanted} == wanted

    # A second PUT updates the same row rather than adding one.
    wanted["auto_watch"] = True
    r = await async_client.put("/api/v1/inbox/preferences", json=wanted, headers=alice.headers)
    assert r.status_code == 200 and r.json()["auto_watch"] is True
    rows = list((await db_session.execute(select(UserInboxPreference))).scalars())
    assert [r.user_id for r in rows] == [alice.id]

    # Bob still reads the defaults.
    r = await async_client.get("/api/v1/inbox/preferences", headers=bob.headers)
    assert r.json()["kinds"] == inbox.DEFAULT_KINDS


@pytest.mark.asyncio
async def test_auth_disabled_inbox_is_empty(async_client, db_session):
    alice = await _user(db_session, "alice")
    (row_id,) = await _seed(db_session, alice.id, 1)

    r = await async_client.get("/api/v1/inbox")
    assert r.status_code == 200 and r.json() == {"items": [], "unread": 0}
    assert (await async_client.post(f"/api/v1/inbox/{row_id}/read")).status_code == 204
    assert (await async_client.post("/api/v1/inbox/read-all")).status_code == 204
    r = await async_client.get("/api/v1/inbox/preferences")
    assert r.status_code == 200 and r.json()["kinds"] == inbox.DEFAULT_KINDS
    r = await async_client.put("/api/v1/inbox/preferences", json={"kinds": [], "sound_kinds": [], "auto_watch": False})
    assert r.status_code == 204
    assert (await db_session.execute(select(UserInboxPreference))).scalars().first() is None
    row = (await db_session.execute(select(Notification))).scalar_one()
    await db_session.refresh(row)
    assert row.read_at is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "method,url,body",
    [
        ("get", "/api/v1/inbox", None),
        ("post", "/api/v1/inbox/1/read", None),
        ("post", "/api/v1/inbox/read-all", None),
        ("get", "/api/v1/inbox/preferences", None),
        ("put", "/api/v1/inbox/preferences", {"kinds": [], "sound_kinds": [], "auto_watch": True}),
    ],
)
async def test_auth_enabled_without_a_token_is_401(async_client, inbox_users, method, url, body):
    kwargs = {"json": body} if body is not None else {}
    r = await getattr(async_client, method)(url, **kwargs)
    assert r.status_code == 401, r.text
