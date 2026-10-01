"""GET/PUT /api/v1/aito/{id}/watch: one user's watch on one card."""

import pytest
from sqlalchemy import select

from backend.app.models.notification_inbox import AitoWatch, UserInboxPreference
from backend.tests.unit.test_aito_merge import _create_with_tasks
from backend.tests.unit.test_inbox_service import _user


async def _card(async_client) -> int:
    """A card created while auth is still off, so nobody auto-watches it."""
    return (await _create_with_tasks(async_client, []))["id"]


async def _sign_in_alice(db):
    """Turn auth on and return (alice, headers) for an aito:read+update user."""
    from backend.app.core.auth import create_access_token
    from backend.app.models.settings import Settings

    alice = await _user(db, "alice")
    db.add(Settings(key="auth_enabled", value="true"))
    await db.commit()
    return alice, {"Authorization": f"Bearer {create_access_token(data={'sub': alice.username})}"}


async def _watches(db):
    return [(w.user_id, w.project_id, w.kinds_json) for w in (await db.execute(select(AitoWatch))).scalars()]


@pytest.mark.asyncio
async def test_watch_roundtrip_and_unwatch(async_client, db_session):
    card = await _card(async_client)
    alice, headers = await _sign_in_alice(db_session)

    r = await async_client.get(f"/api/v1/aito/{card}/watch", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json() == {"watching": False, "kinds": []}

    r = await async_client.put(
        f"/api/v1/aito/{card}/watch", json={"kinds": ["aito.paid", "aito.quote_accepted"]}, headers=headers
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"watching": True, "kinds": ["aito.paid", "aito.quote_accepted"]}
    assert (await async_client.get(f"/api/v1/aito/{card}/watch", headers=headers)).json() == r.json()

    # A second PUT replaces the kinds on the same row.
    r = await async_client.put(f"/api/v1/aito/{card}/watch", json={"kinds": ["aito.paid"]}, headers=headers)
    assert r.json() == {"watching": True, "kinds": ["aito.paid"]}
    assert await _watches(db_session) == [(alice.id, card, ["aito.paid"])]

    r = await async_client.put(f"/api/v1/aito/{card}/watch", json={"kinds": []}, headers=headers)
    assert r.status_code == 200
    assert r.json() == {"watching": False, "kinds": []}
    assert await _watches(db_session) == []
    # Unwatching a card nobody watches is a no-op, not an error.
    r = await async_client.put(f"/api/v1/aito/{card}/watch", json={"kinds": []}, headers=headers)
    assert r.status_code == 200 and r.json() == {"watching": False, "kinds": []}


@pytest.mark.asyncio
async def test_watch_rejects_unknown_printer_and_disabled_kinds(async_client, db_session):
    card = await _card(async_client)
    alice, headers = await _sign_in_alice(db_session)

    for kinds in (["aito.nope"], ["printer.finished"]):
        r = await async_client.put(f"/api/v1/aito/{card}/watch", json={"kinds": kinds}, headers=headers)
        assert r.status_code == 422, (kinds, r.text)

    # aito.overdue is off by default, so watching for it is refused...
    r = await async_client.put(f"/api/v1/aito/{card}/watch", json={"kinds": ["aito.overdue"]}, headers=headers)
    assert r.status_code == 422
    assert "kind disabled in preferences" in r.json()["detail"]
    assert await _watches(db_session) == []

    # ...until the user turns it on in Settings.
    db_session.add(
        UserInboxPreference(user_id=alice.id, kinds_json=["aito.overdue"], sound_kinds_json=[], auto_watch=True)
    )
    await db_session.commit()
    r = await async_client.put(f"/api/v1/aito/{card}/watch", json={"kinds": ["aito.overdue"]}, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json() == {"watching": True, "kinds": ["aito.overdue"]}


@pytest.mark.asyncio
async def test_watch_on_a_trashed_or_missing_card_is_404(async_client, db_session):
    card = await _card(async_client)
    assert (await async_client.delete(f"/api/v1/aito/{card}")).status_code == 204
    _, headers = await _sign_in_alice(db_session)

    for project_id in (card, 999_999):
        assert (await async_client.get(f"/api/v1/aito/{project_id}/watch", headers=headers)).status_code == 404
        r = await async_client.put(f"/api/v1/aito/{project_id}/watch", json={"kinds": ["aito.paid"]}, headers=headers)
        assert r.status_code == 404
    assert await _watches(db_session) == []


@pytest.mark.asyncio
async def test_watch_with_auth_disabled_is_a_no_op(async_client, db_session):
    card = await _card(async_client)
    r = await async_client.get(f"/api/v1/aito/{card}/watch")
    assert r.status_code == 200 and r.json() == {"watching": False, "kinds": []}
    r = await async_client.put(f"/api/v1/aito/{card}/watch", json={"kinds": ["aito.paid"]})
    assert r.status_code == 200 and r.json() == {"watching": False, "kinds": []}
    assert await _watches(db_session) == []
