"""GET/POST /aito/{id}/quote-email — the Books send path and the card move."""

import pytest
from sqlalchemy.exc import OperationalError

from backend.app.services.zoho import ZohoRequestRejected, ZohoUpstreamError, zoho_service

CONTENT = {
    "subject": "Devis QT-00412",
    "body": "<p>Bonjour</p>",
    "recipients": [
        {"email": "contact@example.pf", "name": "Jean-Pierre DUPONT", "contact_person_id": "cp-1"},
    ],
}


@pytest.fixture
def books_email(monkeypatch):
    """Books answers the prefill, and records every send.

    Patched on the zoho_service INSTANCE so the fakes need no ``self``. That is
    safe only because ``reset_zoho_singleton_shadows`` in conftest strips the
    shadow monkeypatch's undo leaves behind on the singleton — without it this
    fixture silently disarms every later class-level patch of the same method.
    """
    sent: list[tuple[str, list[str]]] = []

    async def content(db, estimate_id):
        return {**CONTENT, "recipients": list(CONTENT["recipients"])}

    async def send(db, estimate_id, *, to_mail_ids):
        sent.append((estimate_id, to_mail_ids))

    monkeypatch.setattr(zoho_service, "get_estimate_email_content", content)
    monkeypatch.setattr(zoho_service, "email_estimate", send)
    return sent


async def _create(async_client, **overrides):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        "client_email": "contact@example.pf",
        "quote_id": "EST-9",
        "quote_number": "QT-00412",
    }
    payload.update(overrides)
    return (await async_client.post("/api/v1/aito/", json=payload)).json()


@pytest.mark.asyncio
async def test_prefill_returns_subject_and_recipients(async_client, books_email):
    project = await _create(async_client)
    body = (await async_client.get(f"/api/v1/aito/{project['id']}/quote-email")).json()

    assert body["subject"] == "Devis QT-00412"
    assert [r["email"] for r in body["recipients"]] == ["contact@example.pf"]
    assert body["default_email"] == "contact@example.pf"


@pytest.mark.asyncio
async def test_prefill_prefers_the_cards_own_client_email(async_client, books_email):
    # The card carries an address Books does not offer. It was attached by a
    # human on purpose, so it must be offered AND preselected.
    project = await _create(async_client, client_email="direct@example.pf")
    body = (await async_client.get(f"/api/v1/aito/{project['id']}/quote-email")).json()

    assert body["default_email"] == "direct@example.pf"
    assert [r["email"] for r in body["recipients"]] == ["direct@example.pf", "contact@example.pf"]


@pytest.mark.asyncio
async def test_prefill_falls_back_to_the_client_email_alone(async_client, monkeypatch):
    # Books offers nobody (a contact with no contact persons). The card's own
    # address is still a real address, and must be the whole list.
    async def empty(db, estimate_id):
        return {"subject": "Devis QT-00412", "body": "<p>Bonjour</p>", "recipients": []}

    monkeypatch.setattr(zoho_service, "get_estimate_email_content", empty)
    project = await _create(async_client)
    body = (await async_client.get(f"/api/v1/aito/{project['id']}/quote-email")).json()

    assert [r["email"] for r in body["recipients"]] == ["contact@example.pf"]
    assert body["default_email"] == "contact@example.pf"


@pytest.mark.asyncio
async def test_prefill_has_no_default_when_nobody_can_receive_it(async_client, monkeypatch):
    async def empty(db, estimate_id):
        return {"subject": "Devis QT-00412", "body": "<p>Bonjour</p>", "recipients": []}

    monkeypatch.setattr(zoho_service, "get_estimate_email_content", empty)
    project = await _create(async_client, client_email=None)
    body = (await async_client.get(f"/api/v1/aito/{project['id']}/quote-email")).json()

    assert body["recipients"] == []
    assert body["default_email"] is None


@pytest.mark.asyncio
async def test_prefill_404s_without_a_quote(async_client, books_email):
    project = await _create(async_client, quote_id=None, quote_number=None)
    response = await async_client.get(f"/api/v1/aito/{project['id']}/quote-email")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_prefill_404s_for_an_unknown_project(async_client, books_email):
    assert (await async_client.get("/api/v1/aito/99999/quote-email")).status_code == 404


@pytest.mark.asyncio
async def test_prefill_maps_an_outage_to_502(async_client, monkeypatch):
    project = await _create(async_client)

    async def boom(db, estimate_id):
        raise ZohoUpstreamError("Zoho Books unreachable: ConnectError")

    monkeypatch.setattr(zoho_service, "get_estimate_email_content", boom)
    response = await async_client.get(f"/api/v1/aito/{project['id']}/quote-email")
    assert response.status_code == 502


@pytest.mark.asyncio
async def test_prefill_maps_a_rejection_to_400(async_client, monkeypatch):
    project = await _create(async_client)

    async def rejected(db, estimate_id):
        raise ZohoRequestRejected("No email address for this contact")

    monkeypatch.setattr(zoho_service, "get_estimate_email_content", rejected)
    response = await async_client.get(f"/api/v1/aito/{project['id']}/quote-email")
    assert response.status_code == 400
    assert "No email address" in response.json()["detail"]


async def _events(async_client, project_id) -> list[str]:
    body = (await async_client.get(f"/api/v1/aito/{project_id}/events?depth=detail")).json()
    return [e["kind"] for e in body["events"]]


@pytest.mark.asyncio
async def test_send_from_devis_marks_sent_and_moves_to_waiting(async_client, books_email):
    project = await _create(async_client)
    assert project["column"] == "devis"

    response = await async_client.post(f"/api/v1/aito/{project['id']}/quote-email", json={"to": "contact@example.pf"})

    assert response.status_code == 200
    body = response.json()
    assert body["marked_sent"] is True
    assert body["project"]["column"] == "waiting"
    assert body["project"]["quote_status"] == "sent"
    assert books_email == [("EST-9", ["contact@example.pf"])]
    kinds = await _events(async_client, project["id"])
    assert "quote.emailed" in kinds
    assert "quote.sent" in kinds


@pytest.mark.asyncio
async def test_send_from_waiting_leaves_the_card_alone(async_client, books_email):
    project = await _create(async_client)
    await async_client.post(f"/api/v1/aito/{project['id']}/quote-status", json={"status": "sent"})

    body = (
        await async_client.post(f"/api/v1/aito/{project['id']}/quote-email", json={"to": "contact@example.pf"})
    ).json()

    assert body["marked_sent"] is False
    assert body["project"]["column"] == "waiting"
    assert books_email == [("EST-9", ["contact@example.pf"])]


@pytest.mark.asyncio
async def test_resending_an_accepted_quote_never_demotes_it(async_client, books_email):
    # The one outcome this endpoint must never have: knocking authorised work
    # back off the board because someone re-sent the paperwork.
    project = await _create(async_client)
    await async_client.post(f"/api/v1/aito/{project['id']}/quote-status", json={"status": "accepted"})
    before = (await async_client.get("/api/v1/aito/")).json()
    accepted = next(p for p in before if p["id"] == project["id"])

    body = (
        await async_client.post(f"/api/v1/aito/{project['id']}/quote-email", json={"to": "contact@example.pf"})
    ).json()

    assert body["marked_sent"] is False
    assert body["project"]["quote_status"] == "accepted"
    assert body["project"]["column"] == accepted["column"]
    assert body["project"]["quote_accepted_at"] == accepted["quote_accepted_at"]


@pytest.mark.asyncio
async def test_an_address_outside_the_allowlist_is_refused_without_sending(async_client, books_email):
    project = await _create(async_client)

    response = await async_client.post(
        f"/api/v1/aito/{project['id']}/quote-email", json={"to": "attacker@evil.example"}
    )

    assert response.status_code == 422
    assert books_email == []  # Zoho was never asked to send anything
    assert "quote.emailed" not in await _events(async_client, project["id"])


@pytest.mark.asyncio
async def test_a_failed_send_changes_nothing(async_client, books_email, monkeypatch):
    project = await _create(async_client)

    async def boom(db, estimate_id, *, to_mail_ids):
        raise ZohoUpstreamError("Zoho Books unreachable: ConnectError")

    monkeypatch.setattr(zoho_service, "email_estimate", boom)

    response = await async_client.post(f"/api/v1/aito/{project['id']}/quote-email", json={"to": "contact@example.pf"})

    assert response.status_code == 502
    after = next(p for p in (await async_client.get("/api/v1/aito/")).json() if p["id"] == project["id"])
    assert after["column"] == "devis"
    assert after["quote_status"] is None
    assert "quote.emailed" not in await _events(async_client, project["id"])


@pytest.mark.asyncio
async def test_send_never_pushes_a_status_to_books(async_client, books_email, monkeypatch):
    # Books already marks the estimate sent as a side effect of emailing it.
    # A second status POST is a redundant round trip that can fail on its own.
    project = await _create(async_client)

    async def fail(*args, **kwargs):
        raise AssertionError("the email path must not push a status to Books")

    monkeypatch.setattr(zoho_service, "set_estimate_status", fail)
    monkeypatch.setattr(zoho_service, "advance_estimate_status", fail)

    response = await async_client.post(f"/api/v1/aito/{project['id']}/quote-email", json={"to": "contact@example.pf"})
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_send_404s_without_a_quote(async_client, books_email):
    project = await _create(async_client, quote_id=None, quote_number=None)
    response = await async_client.post(f"/api/v1/aito/{project['id']}/quote-email", json={"to": "contact@example.pf"})
    assert response.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "to,expect_sent_to",
    [
        # Blank/whitespace-only: nothing in the allowlist matches "", and
        # nothing should ever reach Zoho on the way to that rejection.
        ("", None),
        ("   ", None),
        # Same recipient Books offers, just noisy: only .strip() is applied
        # before matching and sending — case is compared case-insensitively
        # but NOT normalized, so what reaches Zoho keeps the caller's case,
        # with only the surrounding whitespace trimmed.
        ("  CONTACT@Example.PF  ", "CONTACT@Example.PF"),
    ],
)
async def test_allowlist_trims_and_case_folds_without_widening(async_client, books_email, to, expect_sent_to):
    project = await _create(async_client)

    response = await async_client.post(f"/api/v1/aito/{project['id']}/quote-email", json={"to": to})

    if expect_sent_to is None:
        assert response.status_code == 422
        assert books_email == []  # Zoho was never asked to send anything
    else:
        assert response.status_code == 200
        assert books_email == [("EST-9", [expect_sent_to])]


@pytest.mark.asyncio
async def test_a_failed_card_move_still_records_the_send(async_client, books_email, monkeypatch):
    """Zoho has already emailed the client by the time the card-move half
    (adopt_quote_status / _apply_rules / the second commit) runs. A failure
    there — a locked SQLite database is the realistic cause, since the
    aito_quote_sync worker commits through the same file — must not erase
    the send from the timeline nor 500 the request: a 500 here reads to the
    operator as "nothing happened", and one more click would email the
    client a second time for real. The commit for `quote.emailed` happens
    on its own, before this failure-injection point, so it must survive."""
    import backend.app.api.routes.aito as aito_routes

    project = await _create(async_client)
    assert project["column"] == "devis"

    # Patched only now: create_project's own _apply_rules call (moving the
    # freshly-made card into "devis") must not be caught by this.
    async def boom(db, project, summary, actor=None):
        raise OperationalError("UPDATE aito_projects ...", {}, Exception("database is locked"))

    monkeypatch.setattr(aito_routes, "_apply_rules", boom)

    response = await async_client.post(f"/api/v1/aito/{project['id']}/quote-email", json={"to": "contact@example.pf"})

    assert response.status_code == 200
    body = response.json()
    assert body["marked_sent"] is False
    assert body["project"]["column"] == "devis"  # the card-move half failed and stayed put
    assert body["project"]["quote_status"] is None
    assert books_email == [("EST-9", ["contact@example.pf"])]  # the email really did go out

    kinds = await _events(async_client, project["id"])
    assert "quote.emailed" in kinds  # durable despite the failure below it
    assert "quote.sent" not in kinds


@pytest.mark.asyncio
async def test_a_non_database_bug_in_the_card_move_still_500s(async_client, books_email, monkeypatch):
    """Only database contention degrades to a 200 with marked_sent=False (see
    the previous test). A genuine programming error in the card-move half —
    an AttributeError here, standing in for any bug that is not a locked
    database — must propagate as a 500, not be reported as a quiet success.
    Otherwise a real logic bug in adopt_quote_status/_apply_rules/record
    would silently look like "the send worked, only the card move failed"
    forever, since nothing distinguishes it from the DB-contention case in
    the response body."""
    import backend.app.api.routes.aito as aito_routes

    project = await _create(async_client)
    assert project["column"] == "devis"

    # Patched only now: create_project's own _apply_rules call (moving the
    # freshly-made card into "devis") must not be caught by this.
    async def boom(db, project, summary, actor=None):
        raise AttributeError("boom")

    monkeypatch.setattr(aito_routes, "_apply_rules", boom)

    response = await async_client.post(f"/api/v1/aito/{project['id']}/quote-email", json={"to": "contact@example.pf"})

    # It must NOT look like the previous test: a non-database bug is not
    # allowed to reach the client as a 200 with marked_sent=False, unlike
    # OperationalError above. (What it becomes instead — 500 vs the outer
    # auth-probe middleware's own 503 fail-closed handling of an unexpected
    # exception, see main.py's auth_middleware — is incidental to this
    # handler and not this test's concern.)
    assert response.status_code != 200
    assert books_email == [("EST-9", ["contact@example.pf"])]  # the email really did go out

    kinds = await _events(async_client, project["id"])
    assert "quote.emailed" in kinds  # durable despite the failure below it
    assert "quote.sent" not in kinds


@pytest.mark.asyncio
async def test_no_recipients_and_no_client_email_refuses_any_address(async_client, books_email, monkeypatch):
    # Books offers nobody, and the card carries no client_email to fall back
    # on (see _quote_email_content) — the allowlist is empty, so every
    # address is out of it, and none of them may reach Zoho.
    async def empty(db, estimate_id):
        return {"subject": "Devis QT-00412", "body": "<p>Bonjour</p>", "recipients": []}

    monkeypatch.setattr(zoho_service, "get_estimate_email_content", empty)
    project = await _create(async_client, client_email=None)

    response = await async_client.post(f"/api/v1/aito/{project['id']}/quote-email", json={"to": "anyone@example.pf"})

    assert response.status_code == 422
    assert books_email == []
