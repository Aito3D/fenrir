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
from backend.app.services import openrouter as openrouter_service, pushcut as pushcut_service
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
    so one test's calls never count against another's budget. The pickup SMS's
    duplicate guard (T-030) is module state for the same reason and is emptied
    with it, so one test's send cannot refuse another's."""
    aito_routes._ai_rate_limit_calls.clear()
    aito_routes._reset_recent_sms()
    yield
    aito_routes._ai_rate_limit_calls.clear()
    aito_routes._reset_recent_sms()


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
    # T-043: refused above the guard, so nothing was armed — see
    # test_a_refusal_above_the_guard_never_arms_it.
    assert aito_routes._recent_sms == {}


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


@pytest.mark.asyncio
async def test_a_record_commit_failure_after_a_real_send_does_not_500(async_client, monkeypatch, db_session):
    """The MissingGreenlet hazard send_invoice_email's tests pin, reached
    from the pickup-SMS relay: the handler's own record()+commit() pair
    failing AFTER Pushcut has already pushed the notification to the phone
    must not 500 — that would read as the send having failed and invite a
    duplicate tap that pushes a second real SMS.

    Faking AsyncSession.commit at the class level (only for its first call
    within this test) reproduces "the local commit hit a lock" without
    needing an actual second connection to contend for one.
    """
    project = await _create_finished(async_client)
    seen = {}

    async def fake(db, *, phone, text, title):
        seen.update(phone=phone, text=text, title=title)

    _patch_send_sms(monkeypatch, fake)

    real_commit = AsyncSession.commit
    calls = {"n": 0}

    async def flaky_commit(self):
        calls["n"] += 1
        if calls["n"] == 1:
            raise SQLAlchemyError("database is locked")
        return await real_commit(self)

    monkeypatch.setattr(AsyncSession, "commit", flaky_commit)

    r = await async_client.post(
        f"/api/v1/aito/{project['id']}/pickup-sms",
        json={"message": "Ia Ora na, c'est prêt. Aito3D"},
    )

    # Pushcut was called exactly once — the failure is entirely on the local
    # side, after the real send already went out.
    assert seen == {
        "phone": "87 12 34 56",
        "text": "Ia Ora na, c'est prêt. Aito3D",
        "title": "SMS — ACME",
    }
    # Still 200 with the normal response body, not a 500 — reading it at all
    # proves no MissingGreenlet leaked past the guarded rollback.
    assert r.status_code == 200
    assert r.json() == {"sent": True}
    # The commit that would have persisted project.sms.sent failed and was
    # rolled back — the SMS went out for real, but there is deliberately no
    # local record of it. See send_pickup_sms's docstring for why a 500 here
    # (inviting a retry that pushes a second real SMS) is worse.
    kinds = (
        (await db_session.execute(select(AitoEvent.kind).where(AitoEvent.project_id == project["id"]))).scalars().all()
    )
    assert "project.sms.sent" not in kinds


# ------------------------------------------- T-025: the send's rate limit


@pytest.mark.asyncio
async def test_send_rate_limit_blocks_the_push_past_the_budget(async_client, monkeypatch, db_session):
    """The Nth send in the window still goes out; the N+1th gets the module's
    plain 429 and reaches neither Pushcut nor the timeline."""
    project = await _create_finished(async_client)
    pushed: list[str] = []

    async def fake(db, *, phone, text, title):
        pushed.append(text)

    _patch_send_sms(monkeypatch, fake)

    # A DISTINCT body per call: identical text inside a minute is what
    # T-030's duplicate guard refuses, and this test is about the budget.
    for i in range(aito_routes._PICKUP_SMS_MAX_CALLS):
        r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": f"prêt {i}"})
        assert r.status_code == 200

    blocked = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})

    assert blocked.status_code == 429
    assert blocked.json()["detail"] == aito_routes._PICKUP_SMS_DETAIL
    assert len(pushed) == aito_routes._PICKUP_SMS_MAX_CALLS
    kinds = (
        (await db_session.execute(select(AitoEvent.kind).where(AitoEvent.project_id == project["id"]))).scalars().all()
    )
    assert kinds.count("project.sms.sent") == aito_routes._PICKUP_SMS_MAX_CALLS


@pytest.mark.asyncio
async def test_send_rate_limit_runs_before_the_lookups(async_client, monkeypatch):
    """Checked ahead of the 404 and the finished-project 409, so a caller
    hammering ids that do not exist (or are not ready) is bounded too."""
    unfinished = (await _create(async_client)).json()

    async def fake(db, *, phone, text, title):  # pragma: no cover - must not run
        raise AssertionError("a rate-limited or unfinished project reached Pushcut")

    _patch_send_sms(monkeypatch, fake)

    for _ in range(aito_routes._PICKUP_SMS_MAX_CALLS):
        r = await async_client.post(f"/api/v1/aito/{unfinished['id']}/pickup-sms", json={"message": "prêt"})
        assert r.status_code == 409

    blocked = await async_client.post("/api/v1/aito/999999/pickup-sms", json={"message": "prêt"})

    assert blocked.status_code == 429
    assert blocked.json()["detail"] == aito_routes._PICKUP_SMS_DETAIL


@pytest.mark.asyncio
async def test_send_rate_limit_has_its_own_bucket(async_client, monkeypatch):
    """Exhausting the send budget must not disable the (separately budgeted)
    draft, and vice versa."""
    project = await _create_finished(async_client)

    async def fake_send(db, *, phone, text, title):
        pass

    async def fake_draft(db, description, client_name=None, parts=None):
        return "message", "m"

    _patch_send_sms(monkeypatch, fake_send)
    _patch_pickup_message(monkeypatch, fake_draft)

    for i in range(aito_routes._PICKUP_SMS_MAX_CALLS):
        r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": f"prêt {i}"})
        assert r.status_code == 200
    assert (
        await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})
    ).status_code == 429

    draft = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-message")
    assert draft.status_code == 200


@pytest.mark.asyncio
async def test_send_rate_limit_clears_once_the_window_elapses(async_client, monkeypatch):
    project = await _create_finished(async_client)

    async def fake(db, *, phone, text, title):
        pass

    clock = _FakeClock(start=1_000.0)
    monkeypatch.setattr(aito_routes, "time", clock)
    _patch_send_sms(monkeypatch, fake)

    for i in range(aito_routes._PICKUP_SMS_MAX_CALLS):
        r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": f"prêt {i}"})
        assert r.status_code == 200
    blocked = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})
    assert blocked.status_code == 429

    clock.now += aito_routes._AI_RATE_LIMIT_WINDOW_S + 1
    r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})
    assert r.status_code == 200


# ----------------------- T-030: an ambiguous push, and the duplicate guard


async def _events(db_session, project_id: int) -> list[str]:
    return (await db_session.execute(select(AitoEvent.kind).where(AitoEvent.project_id == project_id))).scalars().all()


@pytest.mark.asyncio
async def test_a_transport_failure_is_reported_as_maybe_sent_and_records_no_event(
    async_client, monkeypatch, db_session
):
    """Pushcut never answered: the notification may already be on the phone,
    so the operator is told exactly that (not a plain "failed"), and the
    timeline gains nothing — no event may claim a send nobody confirmed."""
    project = await _create_finished(async_client)
    pushed: list[str] = []

    async def fake(db, *, phone, text, title):
        pushed.append(text)
        raise pushcut_service.PushcutUnreachable("Pushcut request failed: timed out")

    _patch_send_sms(monkeypatch, fake)
    r = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})

    assert r.status_code == 502
    assert r.json()["detail"] == aito_routes._SMS_UNREACHABLE_DETAIL
    # The distinguishing half: the detail says the push MAY have landed, which
    # is the whole difference from the refusal case below.
    assert "may already have been pushed" in r.json()["detail"]
    assert "project.sms.sent" not in await _events(db_session, project["id"])
    assert pushed == ["prêt"]


@pytest.mark.asyncio
async def test_a_reflex_retry_after_a_transport_failure_is_refused(async_client, monkeypatch, db_session):
    """The point of arming the guard on the ambiguous outcome: the operator
    reads "may already have been pushed" and taps Send again — that second tap
    must not reach Pushcut, because the first one may have."""
    project = await _create_finished(async_client)
    pushed: list[str] = []

    async def fake(db, *, phone, text, title):
        pushed.append(text)
        raise pushcut_service.PushcutUnreachable("Pushcut request failed: timed out")

    _patch_send_sms(monkeypatch, fake)
    first = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})
    assert first.status_code == 502

    again = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})
    assert again.status_code == 409
    assert again.json()["detail"] == aito_routes._SMS_DUPLICATE_DETAIL
    assert pushed == ["prêt"]
    assert "project.sms.sent" not in await _events(db_session, project["id"])


@pytest.mark.asyncio
async def test_an_identical_resend_right_after_a_successful_one_is_refused(async_client, monkeypatch, db_session):
    project = await _create_finished(async_client)
    pushed: list[str] = []

    async def fake(db, *, phone, text, title):
        pushed.append(text)

    _patch_send_sms(monkeypatch, fake)
    first = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt. Aito3D"})
    assert first.status_code == 200

    again = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt. Aito3D"})
    assert again.status_code == 409
    assert again.json()["detail"] == aito_routes._SMS_DUPLICATE_DETAIL
    # One push, and exactly one event — the refused call reached neither.
    assert pushed == ["prêt. Aito3D"]
    assert (await _events(db_session, project["id"])).count("project.sms.sent") == 1


@pytest.mark.asyncio
async def test_the_guard_is_per_project_and_per_message(async_client, monkeypatch):
    """A different body, or the same body for a different card, is a different
    send — the guard refuses repeats, not sending."""
    project = await _create_finished(async_client)
    other = await _create_finished(async_client)
    pushed: list[str] = []

    async def fake(db, *, phone, text, title):
        pushed.append(text)

    _patch_send_sms(monkeypatch, fake)
    assert (
        await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})
    ).status_code == 200
    # Same project, different text.
    assert (
        await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt, à Arue"})
    ).status_code == 200
    # Same text, different project.
    assert (
        await async_client.post(f"/api/v1/aito/{other['id']}/pickup-sms", json={"message": "prêt"})
    ).status_code == 200
    assert pushed == ["prêt", "prêt, à Arue", "prêt"]


@pytest.mark.asyncio
async def test_a_clean_refusal_leaves_the_guard_unarmed(async_client, monkeypatch):
    """Pushcut answered non-2xx: nothing was pushed, so the operator's retry
    is honest and must go through — the guard only holds what may have landed."""
    project = await _create_finished(async_client)
    pushed: list[str] = []
    fail = {"on": True}

    async def fake(db, *, phone, text, title):
        pushed.append(text)
        if fail["on"]:
            raise pushcut_service.PushcutUpstreamError("Pushcut returned 500")

    _patch_send_sms(monkeypatch, fake)
    refused = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})
    assert refused.status_code == 502
    # Still the upstream's own words, not the "may already" wording.
    assert refused.json()["detail"] == "Pushcut returned 500"
    # T-043: the key IS armed before the push now, so "unarmed" here means the
    # refusal handler dropped it again — pinned on the state, not just on the
    # retry below being let through.
    assert aito_routes._recent_sms == {}

    fail["on"] = False
    retry = await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})
    assert retry.status_code == 200
    assert pushed == ["prêt", "prêt"]


@pytest.mark.asyncio
async def test_an_unconfigured_relay_leaves_the_guard_unarmed(async_client, monkeypatch):
    project = await _create_finished(async_client)
    pushed: list[str] = []
    fail = {"on": True}

    async def fake(db, *, phone, text, title):
        if fail["on"]:
            raise pushcut_service.PushcutNotConfiguredError()
        pushed.append(text)

    _patch_send_sms(monkeypatch, fake)
    assert (
        await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})
    ).status_code == 409
    # T-043: armed before the push, dropped again by the not-configured handler.
    assert aito_routes._recent_sms == {}
    fail["on"] = False
    assert (
        await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})
    ).status_code == 200
    assert pushed == ["prêt"]


# --------------------- T-043: the guard is armed before the push, not after


@pytest.mark.asyncio
async def test_a_second_send_while_the_first_is_still_in_flight_is_refused(async_client, monkeypatch, db_session):
    """The hole the late arm left open: Pushcut's POST runs at an 8s timeout,
    so an operator whose request hangs (or whose browser dropped the answer)
    taps Send again while the first push is still on the wire. That second tap
    must be refused — otherwise a SECOND real SMS lands on the client's phone,
    the very outcome this guard exists to prevent."""
    project = await _create_finished(async_client)
    pushed: list[str] = []
    started = asyncio.Event()  # the first push has reached Pushcut
    release = asyncio.Event()  # ...and may now come back

    async def fake(db, *, phone, text, title):
        pushed.append(text)
        # Only the FIRST push hangs: if the guard ever let a second one
        # through, it returns at once and the assertions below catch it,
        # rather than the test deadlocking on an event nobody sets.
        if len(pushed) == 1:
            started.set()
            await release.wait()

    _patch_send_sms(monkeypatch, fake)

    async def first():
        try:
            return await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})
        finally:
            release.set()

    async def second():
        await started.wait()
        try:
            return await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})
        finally:
            release.set()  # let the suspended first request finish either way

    one, two = await asyncio.wait_for(asyncio.gather(first(), second()), timeout=10)

    assert one.status_code == 200
    assert two.status_code == 409
    assert two.json()["detail"] == aito_routes._SMS_DUPLICATE_DETAIL
    # The load-bearing assertion: exactly one notification reached Pushcut, and
    # exactly one event claims a send.
    assert pushed == ["prêt"]
    assert (await _events(db_session, project["id"])).count("project.sms.sent") == 1


@pytest.mark.asyncio
async def test_a_refusal_above_the_guard_never_arms_it(async_client, monkeypatch):
    """Arming early only stays honest if everything that refuses the send
    outright still runs first: an unknown card, unfinished work and a client
    with no phone leave the guard empty, so the send that does become legitimate
    afterwards is not refused as a duplicate."""
    unfinished = (await _create(async_client)).json()
    phoneless = await _create_finished(async_client, client_phone=None, client_email="acme@example.com")
    pushed: list[str] = []

    async def fake(db, *, phone, text, title):
        pushed.append(text)

    _patch_send_sms(monkeypatch, fake)

    assert (await async_client.post("/api/v1/aito/999999/pickup-sms", json={"message": "prêt"})).status_code == 404
    assert (
        await async_client.post(f"/api/v1/aito/{unfinished['id']}/pickup-sms", json={"message": "prêt"})
    ).status_code == 409
    assert (
        await async_client.post(f"/api/v1/aito/{phoneless['id']}/pickup-sms", json={"message": "prêt"})
    ).status_code == 409

    assert pushed == []
    assert aito_routes._recent_sms == {}


@pytest.mark.asyncio
async def test_the_same_message_is_allowed_again_once_the_window_passes(async_client, monkeypatch):
    """A minute later "send it again, they never got it" is a real intention,
    not a double tap. Driven by the module's fake clock, never the real one."""
    project = await _create_finished(async_client)
    pushed: list[str] = []

    async def fake(db, *, phone, text, title):
        pushed.append(text)

    clock = _FakeClock(start=1_000.0)
    monkeypatch.setattr(aito_routes, "time", clock)
    _patch_send_sms(monkeypatch, fake)

    assert (
        await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})
    ).status_code == 200
    assert (
        await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})
    ).status_code == 409

    clock.now += aito_routes._SMS_DUPLICATE_WINDOW_S + 1
    assert (
        await async_client.post(f"/api/v1/aito/{project['id']}/pickup-sms", json={"message": "prêt"})
    ).status_code == 200
    assert pushed == ["prêt", "prêt"]


def test_the_guard_prunes_expired_keys_and_can_be_reset(monkeypatch):
    """The guard's key carries a caller-supplied message, so an unevicted dict
    would grow with every distinct body ever sent: every call drops what has
    aged out, and _reset_recent_sms empties it for the tests."""
    clock = _FakeClock(start=500.0)
    monkeypatch.setattr(aito_routes, "time", clock)
    aito_routes._reset_recent_sms()

    key = aito_routes._sms_guard_key_or_409(7, "  prêt  ")
    # Stripped, so the textarea's stray whitespace cannot smuggle a repeat past
    # the guard (the schema trims too — belt and braces).
    assert key == (7, "prêt")
    aito_routes._recent_sms[key] = clock.monotonic()
    aito_routes._recent_sms[(8, "autre")] = clock.monotonic()

    clock.now += aito_routes._SMS_DUPLICATE_WINDOW_S + 1
    # Any call prunes: this one is for a third, unrelated key.
    aito_routes._sms_guard_key_or_409(9, "troisième")
    assert aito_routes._recent_sms == {}

    aito_routes._recent_sms[(7, "prêt")] = clock.monotonic()
    aito_routes._reset_recent_sms()
    assert aito_routes._recent_sms == {}


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
    with pytest.raises(pushcut_service.PushcutUpstreamError) as excinfo:
        await pushcut_service.send_sms_notification(db_session, phone="87", text="x", title="t")
    # T-030: an answer Pushcut actually gave is the PLAIN error, never the
    # ambiguous PushcutUnreachable — nothing was pushed, so the caller may
    # report a clean failure and allow an immediate retry.
    assert not isinstance(excinfo.value, pushcut_service.PushcutUnreachable)


@pytest.mark.asyncio
async def test_pushcut_transport_failure_raises_and_chains_the_original(db_session, monkeypatch):
    """A transport-level failure (no response at all — e.g. DNS/connect
    refused) is a different code path from the non-2xx case above: it never
    reaches `response.status_code`, so it needs its own coverage. The
    original httpx error must survive as `__cause__` for debugging."""
    db_session.add(Settings(key="pushcut_sms_url", value="https://api.pushcut.io/tok/notifications/SMS"))
    await db_session.commit()
    connect_error = httpx.ConnectError("no route")

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, json=None):
            raise connect_error

    monkeypatch.setattr(pushcut_service.httpx, "AsyncClient", FakeClient)
    # PushcutUnreachable, not the plain parent: no answer came back, so this
    # says nothing about whether the notification was pushed (T-030).
    with pytest.raises(pushcut_service.PushcutUnreachable) as excinfo:
        await pushcut_service.send_sms_notification(db_session, phone="87", text="x", title="t")
    assert excinfo.value.__cause__ is connect_error
    assert isinstance(excinfo.value, pushcut_service.PushcutUpstreamError)


@pytest.mark.asyncio
async def test_pushcut_read_timeout_raises_and_chains_the_original(db_session, monkeypatch):
    db_session.add(Settings(key="pushcut_sms_url", value="https://api.pushcut.io/tok/notifications/SMS"))
    await db_session.commit()
    timeout_error = httpx.ReadTimeout("timed out")

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, json=None):
            raise timeout_error

    monkeypatch.setattr(pushcut_service.httpx, "AsyncClient", FakeClient)
    # The case the whole of T-030 exists for: Pushcut may well have taken this
    # POST and pushed the notification before the read timed out.
    with pytest.raises(pushcut_service.PushcutUnreachable) as excinfo:
        await pushcut_service.send_sms_notification(db_session, phone="87", text="x", title="t")
    assert excinfo.value.__cause__ is timeout_error


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
    """AITO_UPDATE, same as set_project_contacted and for the same reason:
    contacting the client is an act on the card. Pinned because hand-written
    routes are exactly the kind that ship ungated."""
    assert _declared_permissions("generate_pickup_message") == ["aito:update"]
    assert _declared_permissions("send_pickup_sms") == ["aito:update"]
    assert _declared_permissions("send_pickup_sms") == _declared_permissions("set_project_contacted")
