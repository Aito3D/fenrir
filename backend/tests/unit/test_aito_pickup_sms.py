"""The Finish column's "come and collect your part" SMS.

Two endpoints are pinned here:

1. /pickup-message — an AI DRAFT, gated to finished projects, that never
   sends anything.
2. /pickup-sms — records an SMS the browser already sent through the relay
   on the operator's Mac; requires a phone number, writes a timeline event,
   and sets the contacted mark on a finished card.
"""

import asyncio
import json

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes import aito as aito_routes
from backend.app.models.aito_event import AitoEvent
from backend.app.models.settings import Settings
from backend.app.services import openrouter as openrouter_service
from backend.tests.aito_card_fixture import _create, _create_finished


class _FakeClock:
    """Stands in for the module's `time` name — only `.monotonic()` is used
    by `_check_ai_rate_limit`. Never patch the real `time.monotonic`: asyncio's
    own loop internals depend on it, and this test suite runs async tests."""

    def __init__(self, start: float = 0.0):
        self.now = start

    def monotonic(self) -> float:
        return self.now


@pytest.fixture(autouse=True)
def _reset_ai_rate_limit():
    """Every route in this file shares the module-level bucket dict — clear it
    so one test's calls never count against another's budget."""
    aito_routes._ai_rate_limit_calls.clear()
    yield
    aito_routes._ai_rate_limit_calls.clear()


def _patch_pickup_message(monkeypatch, fake):
    # Patch the name the ROUTE looks up (import site), not the service module's.
    from backend.app.api.routes import aito as aito_routes

    monkeypatch.setattr(aito_routes, "pickup_message", fake)


# ---------------------------------------------------------------- the draft


@pytest.mark.asyncio
async def test_draft_returns_the_model_answer(async_client, monkeypatch):
    project = await _create_finished(async_client)

    async def fake(db, description, client_name=None, parts=None):
        assert description == "Pièce en aluminium de 50mm pour Renault Clio"
        assert client_name == "ACME"
        # The helper's accepted-with-no-tasks card: the route still forwards
        # the (empty) title list rather than omitting the argument.
        assert parts == []
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

    async def fake(db, description, client_name=None, parts=None):  # pragma: no cover - must not run
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

    async def fake(db, description, client_name=None, parts=None):
        raise openrouter_service.OpenRouterUpstreamError("boom")

    _patch_pickup_message(monkeypatch, fake)
    r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-message")
    assert r.status_code == 502


@pytest.mark.asyncio
async def test_draft_404_on_unknown_project(async_client):
    r = await async_client.post("/api/v1/aito/999999/pickup-message")
    assert r.status_code == 404


# ---------------------------------------------------------------- T-043: rate limit


@pytest.mark.asyncio
async def test_draft_rate_limit_blocks_the_call_past_the_budget(async_client, monkeypatch):
    """The Nth call in the window still succeeds; the N+1th gets 429 with the
    exact detail, and never reaches the (billed) OpenRouter call. Enforced
    before the finished-project lookup, so the same project id is reusable."""
    project = await _create_finished(async_client)
    calls: list[str] = []

    async def fake(db, description, client_name=None, parts=None):
        calls.append("call")
        return "message", "m"

    _patch_pickup_message(monkeypatch, fake)

    for _ in range(aito_routes._AI_RATE_LIMIT_MAX_CALLS):
        r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-message")
        assert r.status_code == 200

    r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-message")
    assert r.status_code == 429
    assert r.json()["detail"] == aito_routes._AI_RATE_LIMIT_DETAIL
    assert len(calls) == aito_routes._AI_RATE_LIMIT_MAX_CALLS


@pytest.mark.asyncio
async def test_draft_rate_limit_is_per_principal(async_client, monkeypatch):
    """A different principal (a different `current_user`) is not affected by
    another principal's exhausted budget — the bucket is keyed per user, not
    global."""
    from backend.app.main import app
    from backend.app.models.group import Group
    from backend.app.models.user import User

    project = await _create_finished(async_client)

    async def fake(db, description, client_name=None, parts=None):
        return "message", "m"

    _patch_pickup_message(monkeypatch, fake)

    for _ in range(aito_routes._AI_RATE_LIMIT_MAX_CALLS):
        r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-message")
        assert r.status_code == 200
    blocked = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-message")
    assert blocked.status_code == 429

    route = next(r for r in app.routes if getattr(r, "name", "") == "generate_pickup_message")
    dep = next(d.call for d in route.dependant.dependencies if d.name == "current_user")
    app.dependency_overrides[dep] = lambda: User(
        id=999, username="other", groups=[Group(name="t", permissions=["aito:update"])]
    )
    try:
        r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-message")
        assert r.status_code == 200
    finally:
        app.dependency_overrides.pop(dep, None)


@pytest.mark.asyncio
async def test_draft_rate_limit_clears_once_the_window_elapses(async_client, monkeypatch):
    """After the window passes, the same principal is allowed again. The
    module's own `time` name is rebound to a fake clock — never the real
    `time.monotonic`, which asyncio's loop also relies on."""
    project = await _create_finished(async_client)

    async def fake(db, description, client_name=None, parts=None):
        return "message", "m"

    clock = _FakeClock(start=1_000.0)
    monkeypatch.setattr(aito_routes, "time", clock)
    _patch_pickup_message(monkeypatch, fake)

    for _ in range(aito_routes._AI_RATE_LIMIT_MAX_CALLS):
        r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-message")
        assert r.status_code == 200
    blocked = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-message")
    assert blocked.status_code == 429

    clock.now += aito_routes._AI_RATE_LIMIT_WINDOW_S + 1
    r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-message")
    assert r.status_code == 200


# ---------------------------------------------------------------- the record
# The browser sends the SMS through the relay on the operator's Mac; this
# route only records that it went.


async def _sms_kinds(db_session, project_id):
    rows = await db_session.execute(select(AitoEvent.kind).where(AitoEvent.project_id == project_id))
    return rows.scalars().all()


@pytest.mark.asyncio
async def test_record_writes_the_event_and_marks_a_finished_card_contacted(async_client, db_session):
    """The SMS is the contact: project.sms.sent plus the same contacted event
    and stamp the manual control writes, and the response is the card."""
    project = await _create_finished(async_client)
    r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms")
    assert r.status_code == 200
    assert r.json()["id"] == project["id"]
    assert r.json()["client_contacted_at"] is not None
    kinds = await _sms_kinds(db_session, project["id"])
    assert "project.sms.sent" in kinds
    assert kinds.count("project.contacted.set") == 1


@pytest.mark.asyncio
async def test_a_second_sms_keeps_the_first_contact_stamp(async_client, db_session):
    """An existing mark is not restamped: the waiting clock must not reset."""
    project = await _create_finished(async_client)
    first = (await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms")).json()["client_contacted_at"]
    second = (await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms")).json()["client_contacted_at"]
    assert second == first
    kinds = await _sms_kinds(db_session, project["id"])
    assert kinds.count("project.sms.sent") == 2
    assert kinds.count("project.contacted.set") == 1


@pytest.mark.asyncio
async def test_an_sms_on_unfinished_work_never_opens_the_done_gate(async_client, db_session):
    project = (await _create(async_client)).json()
    r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms")
    assert r.status_code == 200
    assert r.json()["client_contacted_at"] is None
    assert "project.contacted.set" not in await _sms_kinds(db_session, project["id"])


@pytest.mark.asyncio
async def test_record_is_refused_without_a_phone_number(async_client, db_session):
    project = await _create_finished(async_client, client_phone=None, client_email="acme@example.com")
    r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms")
    assert r.status_code == 409
    assert "project.sms.sent" not in await _sms_kinds(db_session, project["id"])


@pytest.mark.asyncio
async def test_record_404_on_unknown_project(async_client):
    assert (await async_client.post("/api/v1/aito/999999/pickup-sms")).status_code == 404


@pytest.mark.asyncio
async def test_record_rate_limit_blocks_past_the_budget(async_client, db_session):
    """T-025: the N+1th call in the window gets the plain 429 and writes no event."""
    project = await _create_finished(async_client)
    for _ in range(aito_routes._PICKUP_SMS_MAX_CALLS):
        assert (await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms")).status_code == 200
    blocked = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms")
    assert blocked.status_code == 429
    assert blocked.json()["detail"] == aito_routes._PICKUP_SMS_DETAIL
    kinds = await _sms_kinds(db_session, project["id"])
    assert kinds.count("project.sms.sent") == aito_routes._PICKUP_SMS_MAX_CALLS


@pytest.mark.asyncio
async def test_record_rate_limit_clears_once_the_window_elapses(async_client, monkeypatch):
    project = await _create_finished(async_client)
    clock = _FakeClock(start=1_000.0)
    monkeypatch.setattr(aito_routes, "time", clock)
    for _ in range(aito_routes._PICKUP_SMS_MAX_CALLS):
        assert (await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms")).status_code == 200
    assert (await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms")).status_code == 429
    clock.now += aito_routes._AI_RATE_LIMIT_WINDOW_S + 1
    assert (await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms")).status_code == 200


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
    # The normalizer also moves the signature onto its own line — see below.
    assert message == "Ia Ora na, prêt.\nAito3D"


@pytest.mark.asyncio
async def test_pickup_message_lists_every_part_for_the_model(db_session, monkeypatch):
    """Multiple tasks → the prompt carries each title as its own list line,
    so the model can be held to naming all of them."""
    db_session.add(Settings(key="openrouter_api_key", value="sk-test"))
    await db_session.commit()
    seen = {}

    async def fake_chat(api_key, model, system, user, max_tokens, **kwargs):
        seen.update(system=system, user=user)
        return "Ia Ora na, le cache de vis de jante et le cache attelage Fox sont prêts à Arue.\nAito3D"

    monkeypatch.setattr(openrouter_service, "_chat", fake_chat)
    message, _ = await openrouter_service.pickup_message(
        db_session, "Caches pour Andy", "Andy JONQUILLE", parts=["Cache de vis de jante", "Cache attelage Fox"]
    )
    assert "- Cache de vis de jante" in seen["user"]
    assert "- Cache attelage Fox" in seen["user"]
    # The prompt's part rules, pinned: every part, object names only, no
    # production steps or colours leaking into the SMS — and always tutoiement.
    assert "toutes sans exception" in seen["system"]
    assert "couleurs" in seen["system"]
    assert "tutoyant" in seen["system"]
    assert message.endswith("\nAito3D")


def test_normalize_fixes_the_lowercase_greeting():
    """Mistral has answered « la Ora na » — an L that reads as an I in most
    fonts, and a mistake the client would notice. Fixed mechanically."""
    assert openrouter_service._normalize_pickup("la Ora na, prêt.\nAito3D") == "Ia Ora na, prêt.\nAito3D"
    assert openrouter_service._normalize_pickup("La Ora na, prêt.\nAito3D") == "Ia Ora na, prêt.\nAito3D"
    # A genuine capital I passes through untouched.
    assert openrouter_service._normalize_pickup("Ia Ora na, prêt.\nAito3D") == "Ia Ora na, prêt.\nAito3D"


def test_normalize_puts_the_signature_on_its_own_line():
    assert openrouter_service._normalize_pickup("Ia Ora na, prêt. Aito3D") == "Ia Ora na, prêt.\nAito3D"
    # Already on its own line: no second newline stacked on top.
    assert openrouter_service._normalize_pickup("Ia Ora na, prêt.\nAito3D") == "Ia Ora na, prêt.\nAito3D"
    # A blank line (the model's other observed habit) collapses to one break.
    assert openrouter_service._normalize_pickup("Ia Ora na, prêt.\n\nAito3D") == "Ia Ora na, prêt.\nAito3D"
    assert openrouter_service._normalize_pickup("Ia Ora na, prêt.\n \n Aito3D") == "Ia Ora na, prêt.\nAito3D"
    # No signature at all: the user may have edited it out on purpose.
    assert openrouter_service._normalize_pickup("Ia Ora na, prêt.") == "Ia Ora na, prêt."


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
    """The draft takes AITO_UPDATE, same as set_project_contacted. The send is
    admin-only (it texts a client from the shop's number). Pinned because
    hand-written routes are exactly the kind that ship ungated."""
    assert _declared_permissions("generate_pickup_message") == ["aito:update"]
    from backend.app.main import app

    route = next(r for r in app.routes if getattr(r, "name", None) == "send_pickup_sms")
    assert any(
        getattr(d.call, "__qualname__", "").startswith("require_admin_if_auth_enabled.")
        for d in route.dependant.dependencies
    )
