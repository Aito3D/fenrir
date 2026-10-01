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
    assert r.json() == {"watching": False, "kinds": [], "follows_settings": False}

    r = await async_client.put(
        f"/api/v1/aito/{card}/watch", json={"kinds": ["aito.paid", "aito.quote_accepted"]}, headers=headers
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"watching": True, "kinds": ["aito.paid", "aito.quote_accepted"], "follows_settings": False}
    assert (await async_client.get(f"/api/v1/aito/{card}/watch", headers=headers)).json() == r.json()

    # A second PUT replaces the kinds on the same row.
    r = await async_client.put(f"/api/v1/aito/{card}/watch", json={"kinds": ["aito.paid"]}, headers=headers)
    assert r.json() == {"watching": True, "kinds": ["aito.paid"], "follows_settings": False}
    assert await _watches(db_session) == [(alice.id, card, ["aito.paid"])]

    r = await async_client.put(f"/api/v1/aito/{card}/watch", json={"kinds": []}, headers=headers)
    assert r.status_code == 200
    assert r.json() == {"watching": False, "kinds": [], "follows_settings": False}
    assert await _watches(db_session) == []
    # Unwatching a card nobody watches is a no-op, not an error.
    r = await async_client.put(f"/api/v1/aito/{card}/watch", json={"kinds": []}, headers=headers)
    assert r.status_code == 200 and r.json() == {"watching": False, "kinds": [], "follows_settings": False}


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
    assert r.json() == {"watching": True, "kinds": ["aito.overdue"], "follows_settings": False}


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
async def test_a_first_watch_that_loses_the_insert_race_updates_the_winner(async_client, db_session, monkeypatch):
    """Two first-time PUTs (or a PUT racing create_project's auto_watch): the
    loser read "no watch" before the winner committed. Simulated by a stored
    row plus a first read that misses it — the insert trips the unique
    (user_id, project_id), and the retry re-reads and updates the stored row
    instead of answering 500."""
    from backend.app.api.routes import aito as aito_routes

    card = await _card(async_client)
    alice, headers = await _sign_in_alice(db_session)
    alice_id = alice.id
    db_session.add(AitoWatch(user_id=alice_id, project_id=card, kinds_json=["aito.paid"]))
    await db_session.commit()

    real = aito_routes._own_watch
    reads: list[int] = []

    async def stale_first_read(db, project_id, user_id):
        reads.append(project_id)
        return None if len(reads) == 1 else await real(db, project_id, user_id)

    monkeypatch.setattr(aito_routes, "_own_watch", stale_first_read)
    r = await async_client.put(f"/api/v1/aito/{card}/watch", json={"kinds": ["aito.quote_viewed"]}, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json() == {"watching": True, "kinds": ["aito.quote_viewed"], "follows_settings": False}
    assert reads == [card, card]
    db_session.expire_all()
    assert await _watches(db_session) == [(alice_id, card, ["aito.quote_viewed"])]


@pytest.mark.asyncio
async def test_watch_with_auth_disabled_is_a_no_op(async_client, db_session):
    card = await _card(async_client)
    r = await async_client.get(f"/api/v1/aito/{card}/watch")
    assert r.status_code == 200 and r.json() == {"watching": False, "kinds": [], "follows_settings": False}
    r = await async_client.put(f"/api/v1/aito/{card}/watch", json={"kinds": ["aito.paid"]})
    assert r.status_code == 200 and r.json() == {"watching": False, "kinds": [], "follows_settings": False}
    assert await _watches(db_session) == []


@pytest.mark.asyncio
async def test_an_auto_watch_reads_as_following_settings_until_saved(async_client, db_session):
    """An auto-watch (no stored list) answers with the user's enabled Aito
    kinds and follows_settings; saving a selection makes it explicit."""
    from backend.app.services import inbox

    card = await _card(async_client)
    alice, headers = await _sign_in_alice(db_session)
    alice_id = alice.id
    await inbox.auto_watch(db_session, card, alice_id)
    await db_session.commit()

    r = await async_client.get(f"/api/v1/aito/{card}/watch", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json() == {
        "watching": True,
        "kinds": [k for k in inbox.DEFAULT_KINDS if k.startswith("aito.")],
        "follows_settings": True,
    }

    # A kind enabled in Settings later shows up on the existing auto-watch.
    db_session.add(
        UserInboxPreference(
            user_id=alice_id, kinds_json=["aito.paid", "aito.overdue"], sound_kinds_json=[], auto_watch=True
        )
    )
    await db_session.commit()
    r = await async_client.get(f"/api/v1/aito/{card}/watch", headers=headers)
    assert r.json() == {"watching": True, "kinds": ["aito.paid", "aito.overdue"], "follows_settings": True}

    r = await async_client.put(f"/api/v1/aito/{card}/watch", json={"kinds": ["aito.paid"]}, headers=headers)
    assert r.json() == {"watching": True, "kinds": ["aito.paid"], "follows_settings": False}
    db_session.expire_all()
    assert await _watches(db_session) == [(alice_id, card, ["aito.paid"])]
