"""The Finish column's "come and collect your part" SMS.

Two endpoints and one relay are pinned here:

1. /pickup-message — an AI DRAFT, gated to finished projects, that never
   sends anything.
2. /pickup-sms — the relay to Pushcut, which requires a phone number, records
   a timeline event, and deliberately does NOT set the contacted mark (the
   SMS has not left the phone yet — the user still taps accept there).
3. services/pushcut — the notification payload's `input` must be a JSON
   dictionary with exactly the keys the iPhone shortcut reads: `phone` and
   `text`. That shape is a contract with a shortcut nobody can see from this
   repo, so it is pinned byte-for-byte here.
"""

import json

import pytest
from sqlalchemy import select

from backend.app.models.aito_event import AitoEvent
from backend.app.models.settings import Settings
from backend.app.services import openrouter as openrouter_service, pushcut as pushcut_service


async def _create(client, **overrides):
    payload = {
        "description": "Pièce en aluminium de 50mm pour Renault Clio",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "87 12 34 56",
    }
    payload.update(overrides)
    # None means "leave the field out" — the create schema validates present
    # fields, and a test that wants a phoneless client simply never sends one.
    payload = {k: v for k, v in payload.items() if v is not None}
    return await client.post("/api/v1/aito/", json=payload)


async def _create_finished(client, **overrides):
    """A hand-made card accepted through the dedicated route, which lands it —
    with no tasks — unlocked in `finish`. Same helper as test_aito_contacted."""
    created = (await _create(client, **overrides)).json()
    accepted = await client.post(f"/api/v1/aito/{created['id']}/quote-status", json={"status": "accepted"})
    return accepted.json()["project"]


def _patch_pickup_message(monkeypatch, fake):
    # Patch the name the ROUTE looks up (import site), not the service module's.
    from backend.app.api.routes import aito as aito_routes

    monkeypatch.setattr(aito_routes, "pickup_message", fake)


def _patch_send_sms(monkeypatch, fake):
    from backend.app.api.routes import aito as aito_routes

    monkeypatch.setattr(aito_routes, "send_sms_notification", fake)


# ---------------------------------------------------------------- the draft


@pytest.mark.asyncio
async def test_draft_returns_the_model_answer(async_client, monkeypatch):
    project = await _create_finished(async_client)

    async def fake(db, description, client_name=None):
        assert description == "Pièce en aluminium de 50mm pour Renault Clio"
        assert client_name == "ACME"
        return "Ia Ora na, la pièce pour la Renault Clio est disponible à nos bureaux à Arue. Aito3D", "m"

    _patch_pickup_message(monkeypatch, fake)
    r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-message")
    assert r.status_code == 200
    assert r.json() == {
        "message": "Ia Ora na, la pièce pour la Renault Clio est disponible à nos bureaux à Arue. Aito3D",
        "model": "m",
    }


@pytest.mark.asyncio
async def test_draft_is_refused_while_the_work_is_unfinished(async_client, monkeypatch):
    # A fresh card sits in `devis` — "your part is ready" is not a statement
    # anyone can make about it yet, so no paid call is ever made.
    project = (await _create(async_client)).json()

    async def fake(db, description, client_name=None):  # pragma: no cover - must not run
        raise AssertionError("an unfinished project reached the model")

    _patch_pickup_message(monkeypatch, fake)
    r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-message")
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_draft_unconfigured_409(async_client):
    project = await _create_finished(async_client)
    r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-message")
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_draft_upstream_502(async_client, monkeypatch):
    project = await _create_finished(async_client)

    async def fake(db, description, client_name=None):
        raise openrouter_service.OpenRouterUpstreamError("boom")

    _patch_pickup_message(monkeypatch, fake)
    r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-message")
    assert r.status_code == 502


@pytest.mark.asyncio
async def test_draft_404_on_unknown_project(async_client):
    r = await async_client.post("/api/v1/aito/999999/pickup-message")
    assert r.status_code == 404


# ---------------------------------------------------------------- the send


@pytest.mark.asyncio
async def test_send_relays_the_edited_message_not_a_regenerated_one(async_client, monkeypatch):
    project = await _create_finished(async_client)
    seen = {}

    async def fake(db, *, phone, text, title):
        seen.update(phone=phone, text=text, title=title)

    _patch_send_sms(monkeypatch, fake)
    r = await async_client.post(
        f"/api/v1/aito/{project['id']}/pickup-sms",
        json={"message": "Ia Ora na, c'est prêt. Aito3D"},
    )
    assert r.status_code == 200
    assert r.json() == {"sent": True}
    assert seen == {"phone": "87 12 34 56", "text": "Ia Ora na, c'est prêt. Aito3D", "title": "SMS — ACME"}


@pytest.mark.asyncio
async def test_send_is_refused_without_a_phone_number(async_client, monkeypatch):
    # Email instead of phone: creation requires SOME channel, and an
    # email-only client is exactly who this refusal exists for.
    project = await _create_finished(async_client, client_phone=None, client_email="acme@example.com")

    async def fake(db, *, phone, text, title):  # pragma: no cover - must not run
        raise AssertionError("a phoneless project reached Pushcut")

    _patch_send_sms(monkeypatch, fake)
    r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_send_is_refused_while_the_work_is_unfinished(async_client, monkeypatch):
    project = (await _create(async_client)).json()

    async def fake(db, *, phone, text, title):  # pragma: no cover - must not run
        raise AssertionError("an unfinished project reached Pushcut")

    _patch_send_sms(monkeypatch, fake)
    r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_send_unconfigured_409(async_client):
    project = await _create_finished(async_client)
    r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_send_upstream_502(async_client, monkeypatch):
    project = await _create_finished(async_client)

    async def fake(db, *, phone, text, title):
        raise pushcut_service.PushcutUpstreamError("boom")

    _patch_send_sms(monkeypatch, fake)
    r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})
    assert r.status_code == 502


@pytest.mark.asyncio
async def test_send_rejects_a_blank_message(async_client):
    project = await _create_finished(async_client)
    r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "  \n "})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_send_records_the_event_but_never_the_contact(async_client, monkeypatch, db_session):
    """The two halves of the design in one test: the timeline gains
    project.sms.sent, and client_contacted_at stays NULL — the SMS reached
    the phone, not the client, and the user records the contact by hand."""
    project = await _create_finished(async_client)

    async def fake(db, *, phone, text, title):
        pass

    _patch_send_sms(monkeypatch, fake)
    r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt. Aito3D"})
    assert r.status_code == 200

    kinds = (
        (
            await db_session.execute(
                select(AitoEvent.kind).where(AitoEvent.project_id == project["id"]).order_by(AitoEvent.id)
            )
        )
        .scalars()
        .all()
    )
    assert "project.sms.sent" in kinds
    # No single-project GET exists; the board list is how the app reads cards.
    board = (await async_client.get("/api/v1/aito/")).json()
    refreshed = next(p for p in board if p["id"] == project["id"])
    assert refreshed["client_contacted_at"] is None


@pytest.mark.asyncio
async def test_a_failed_relay_records_nothing(async_client, monkeypatch, db_session):
    project = await _create_finished(async_client)

    async def fake(db, *, phone, text, title):
        raise pushcut_service.PushcutUpstreamError("boom")

    _patch_send_sms(monkeypatch, fake)
    await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})
    kinds = (
        (await db_session.execute(select(AitoEvent.kind).where(AitoEvent.project_id == project["id"]))).scalars().all()
    )
    assert "project.sms.sent" not in kinds


# ---------------------------------------------------------------- the relay


@pytest.mark.asyncio
async def test_pushcut_payload_matches_the_shortcut_contract(db_session, monkeypatch):
    """`input` is a JSON dictionary with exactly `phone` and `text` — the two
    keys the [Aito3D] shortcut's Get-dictionary step reads. Byte-for-byte,
    because the shortcut lives on a phone no test can see."""
    db_session.add(Settings(key="pushcut_sms_url", value="https://api.pushcut.io/tok/notifications/SMS"))
    await db_session.commit()
    seen = {}

    class FakeResponse:
        status_code = 200

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, json=None):
            seen.update(url=url, payload=json)
            return FakeResponse()

    monkeypatch.setattr(pushcut_service.httpx, "AsyncClient", FakeClient)
    await pushcut_service.send_sms_notification(
        db_session, phone="87 12 34 56", text="Ia Ora na, prêt. Aito3D", title="SMS — ACME"
    )
    assert seen["url"] == "https://api.pushcut.io/tok/notifications/SMS"
    assert seen["payload"]["title"] == "SMS — ACME"
    assert seen["payload"]["text"] == "Ia Ora na, prêt. Aito3D"
    assert json.loads(seen["payload"]["input"]) == {"phone": "87 12 34 56", "text": "Ia Ora na, prêt. Aito3D"}


@pytest.mark.asyncio
async def test_pushcut_unconfigured_raises(db_session):
    with pytest.raises(pushcut_service.PushcutNotConfiguredError):
        await pushcut_service.send_sms_notification(db_session, phone="87", text="x", title="t")


@pytest.mark.asyncio
async def test_pushcut_non_2xx_raises(db_session, monkeypatch):
    db_session.add(Settings(key="pushcut_sms_url", value="https://api.pushcut.io/tok/notifications/SMS"))
    await db_session.commit()

    class FakeResponse:
        status_code = 404

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, json=None):
            return FakeResponse()

    monkeypatch.setattr(pushcut_service.httpx, "AsyncClient", FakeClient)
    with pytest.raises(pushcut_service.PushcutUpstreamError):
        await pushcut_service.send_sms_notification(db_session, phone="87", text="x", title="t")


# ---------------------------------------------------------------- the prompt


@pytest.mark.asyncio
async def test_pickup_message_sends_description_and_client_to_the_model(db_session, monkeypatch):
    db_session.add(Settings(key="openrouter_api_key", value="sk-test"))
    await db_session.commit()
    seen = {}

    async def fake_chat(api_key, model, system, user, max_tokens, **kwargs):
        seen.update(api_key=api_key, model=model, system=system, user=user)
        return "Ia Ora na, la pièce pour la Renault Clio est disponible à nos bureaux à Arue. Aito3D"

    monkeypatch.setattr(openrouter_service, "_chat", fake_chat)
    message, model = await openrouter_service.pickup_message(
        db_session, "Pièce en aluminium de 50mm pour Renault Clio", "ACME"
    )
    assert message.startswith("Ia Ora na")
    assert model == openrouter_service.DEFAULT_MODEL
    assert "Pièce en aluminium de 50mm pour Renault Clio" in seen["user"]
    assert "ACME" in seen["user"]
    # The prompt's two hard rules, pinned so a reword cannot drop them: the
    # greeting/signature pair, and Arue as the pickup point.
    assert "Ia Ora na" in seen["system"]
    assert "Aito3D" in seen["system"]
    assert "Arue" in seen["system"]


@pytest.mark.asyncio
async def test_pickup_message_strips_a_wrapping_quote_pair(db_session, monkeypatch):
    db_session.add(Settings(key="openrouter_api_key", value="sk-test"))
    await db_session.commit()

    async def fake_chat(api_key, model, system, user, max_tokens, **kwargs):
        return "« Ia Ora na, prêt. Aito3D »"

    monkeypatch.setattr(openrouter_service, "_chat", fake_chat)
    message, _ = await openrouter_service.pickup_message(db_session, "Capot")
    assert message == "Ia Ora na, prêt. Aito3D"


# ---------------------------------------------------------------- permissions


def _declared_permissions(route_name: str) -> list[str]:
    """Same closure-read as test_aito_contacted's, for the same reason: the
    test client runs with auth disabled, so the declaration is only observable
    in the checker's closure."""
    from backend.app.main import app

    route = next(r for r in app.routes if getattr(r, "name", "") == route_name)
    checker = next(d.call for d in route.dependant.dependencies if d.name in ("current_user", "_"))
    cells = dict(zip(checker.__code__.co_freevars, checker.__closure__ or (), strict=True))
    return list(cells["perm_strings"].cell_contents)


def test_both_routes_are_gated_on_permission_to_edit_the_card():
    """AITO_UPDATE, same as set_project_contacted and for the same reason:
    contacting the client is an act on the card. Pinned because hand-written
    routes are exactly the kind that ship ungated."""
    assert _declared_permissions("generate_pickup_message") == ["aito:update"]
    assert _declared_permissions("send_pickup_sms") == ["aito:update"]
    assert _declared_permissions("send_pickup_sms") == _declared_permissions("set_project_contacted")
