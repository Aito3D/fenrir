"""GET/POST /aito/{id}/invoice-email — the Books invoice send path."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services.zoho import ZohoRequestRejected, ZohoUpstreamError, zoho_service

CONTENT = {
    "subject": "Facture INV-00087",
    "body": "<p>Bonjour</p>",
    "recipients": [
        {"email": "contact@example.pf", "name": "Jean-Pierre DUPONT", "contact_person_id": "cp-1"},
    ],
}

INVOICE = {
    "id": "INV-7",
    "number": "INV-00087",
    "date": "2026-08-18",
    "due_date": "2026-09-18",
    "total": 45000.0,
    "balance": 45000.0,
    "currency_code": "XPF",
    "status": "draft",
}

# A second, older invoice for this same project. Books lists invoices
# newest-first, so a pair like this is what makes invoice_id="INV-7" (older)
# and invoice_id=None (which must fall through to the newest, INV-42)
# actually distinguishable in a test — a single-invoice fixture can't tell
# "pinned correctly" apart from "ignored payload.invoice_id entirely".
OLDER_INVOICE = {**INVOICE, "id": "INV-7", "number": "INV-00087"}
NEWER_INVOICE = {**INVOICE, "id": "INV-42", "number": "INV-00099"}
TWO_INVOICES = [NEWER_INVOICE, OLDER_INVOICE]


@pytest.fixture
def books_invoice_email(monkeypatch):
    """Books lists one invoice, answers the prefill, and records every send.

    Patched on the zoho_service INSTANCE so the fakes need no ``self``. That is
    safe only because ``reset_zoho_singleton_shadows`` in conftest strips the
    shadow monkeypatch's undo leaves behind on the singleton — without it this
    fixture silently disarms every later class-level patch of the same method.

    The listed invoice's ``status`` flips from "draft" to "sent" starting on
    the SECOND call to ``list_project_invoices`` within a test — mirroring
    what Books actually does as a side effect of emailing an invoice. The
    send route calls this once before the send (still "draft") and once more
    after (now "sent") to build its response; without this flip, a send
    handler that skipped the post-send re-read entirely and just echoed the
    pre-send invoice back would pass every test in this file undetected.
    """
    sent: list[tuple[str, list[str]]] = []
    calls = {"invoices": 0}

    async def invoices(db, estimate_id, customer_id):
        calls["invoices"] += 1
        status = "draft" if calls["invoices"] == 1 else "sent"
        return [{**INVOICE, "status": status}]

    async def url(db, invoice_id):
        return f"https://books.zoho.com/app#/invoices/{invoice_id}"

    async def content(db, invoice_id):
        return {**CONTENT, "recipients": list(CONTENT["recipients"])}

    async def send(db, invoice_id, *, to_mail_ids):
        sent.append((invoice_id, to_mail_ids))

    monkeypatch.setattr(zoho_service, "list_project_invoices", invoices)
    monkeypatch.setattr(zoho_service, "books_invoice_url", url)
    monkeypatch.setattr(zoho_service, "get_invoice_email_content", content)
    monkeypatch.setattr(zoho_service, "email_invoice", send)
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


async def _events(async_client, project_id) -> list[str]:
    body = (await async_client.get(f"/api/v1/aito/{project_id}/events?depth=detail")).json()
    return [e["kind"] for e in body["events"]]


@pytest.mark.asyncio
async def test_prefill_returns_the_invoice_subject_and_recipients(async_client, books_invoice_email):
    project = await _create(async_client)
    body = (await async_client.get(f"/api/v1/aito/{project['id']}/invoice-email")).json()

    assert body["subject"] == "Facture INV-00087"
    assert body["invoice_id"] == "INV-7"
    assert body["invoice_number"] == "INV-00087"
    assert [r["email"] for r in body["recipients"]] == ["contact@example.pf"]
    assert body["default_email"] == "contact@example.pf"


@pytest.mark.asyncio
async def test_prefill_prefers_the_cards_own_client_email(async_client, books_invoice_email):
    # The card carries an address Books does not offer. It was attached by a
    # human on purpose, so it must be offered AND preselected.
    project = await _create(async_client, client_email="direct@example.pf")
    body = (await async_client.get(f"/api/v1/aito/{project['id']}/invoice-email")).json()

    assert body["default_email"] == "direct@example.pf"
    assert [r["email"] for r in body["recipients"]] == ["direct@example.pf", "contact@example.pf"]


@pytest.mark.asyncio
async def test_prefill_404s_without_a_quote(async_client, books_invoice_email):
    project = await _create(async_client, quote_id=None, quote_number=None)
    response = await async_client.get(f"/api/v1/aito/{project['id']}/invoice-email")
    assert response.status_code == 404
    assert response.json()["detail"] == "This project has no Zoho quote"


@pytest.mark.asyncio
async def test_prefill_404s_when_the_estimate_has_no_invoice(async_client, monkeypatch):
    async def none(db, estimate_id, customer_id):
        return []

    monkeypatch.setattr(zoho_service, "list_project_invoices", none)
    project = await _create(async_client)
    response = await async_client.get(f"/api/v1/aito/{project['id']}/invoice-email")
    assert response.status_code == 404
    assert response.json()["detail"] == "This project has no Zoho invoice"


@pytest.mark.asyncio
async def test_prefill_404s_for_an_invoice_that_is_not_this_projects(async_client, books_invoice_email):
    project = await _create(async_client)
    response = await async_client.get(f"/api/v1/aito/{project['id']}/invoice-email?invoice_id=INV-999")
    assert response.status_code == 404
    assert response.json()["detail"] == "That invoice is not one of this project's"


@pytest.mark.asyncio
async def test_prefill_maps_an_outage_to_502(async_client, books_invoice_email, monkeypatch):
    project = await _create(async_client)

    async def boom(db, invoice_id):
        raise ZohoUpstreamError("Zoho Books unreachable: ConnectError")

    monkeypatch.setattr(zoho_service, "get_invoice_email_content", boom)
    assert (await async_client.get(f"/api/v1/aito/{project['id']}/invoice-email")).status_code == 502


@pytest.mark.asyncio
async def test_prefill_maps_a_rejection_to_400(async_client, books_invoice_email, monkeypatch):
    project = await _create(async_client)

    async def rejected(db, invoice_id):
        raise ZohoRequestRejected("No email address for this contact")

    monkeypatch.setattr(zoho_service, "get_invoice_email_content", rejected)
    response = await async_client.get(f"/api/v1/aito/{project['id']}/invoice-email")
    assert response.status_code == 400
    assert "No email address" in response.json()["detail"]


@pytest.mark.asyncio
async def test_send_emails_the_invoice_and_records_one_event(async_client, books_invoice_email):
    project = await _create(async_client)

    response = await async_client.post(
        f"/api/v1/aito/{project['id']}/invoice-email",
        json={"to": "contact@example.pf", "invoice_id": "INV-7"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "INV-7"
    # Proves the response is the POST-send re-read, not an echo of the
    # pre-send invoice: the fixture flips status to "sent" and gives a URL
    # only from its second call onward.
    assert body["status"] == "sent"
    assert body["url"]
    assert books_invoice_email == [("INV-7", ["contact@example.pf"])]
    kinds = await _events(async_client, project["id"])
    assert kinds.count("invoice.emailed") == 1


@pytest.mark.asyncio
async def test_send_never_moves_the_card(async_client, books_invoice_email):
    # An invoice going out is not a board transition — see the spec. The card
    # must sit exactly where it was.
    project = await _create(async_client)
    before = next(p for p in (await async_client.get("/api/v1/aito/")).json() if p["id"] == project["id"])

    response = await async_client.post(
        f"/api/v1/aito/{project['id']}/invoice-email",
        json={"to": "contact@example.pf", "invoice_id": "INV-7"},
    )
    assert response.status_code == 200

    after = next(p for p in (await async_client.get("/api/v1/aito/")).json() if p["id"] == project["id"])
    assert after["column"] == before["column"]
    assert after["quote_status"] == before["quote_status"]


@pytest.mark.asyncio
async def test_send_pins_to_the_requested_invoice_among_several(async_client, books_invoice_email, monkeypatch):
    # Books lists newest-first (NEWER_INVOICE, then OLDER_INVOICE). Pinning to
    # the older one and getting the newer one back instead is exactly the bug
    # invoice_id exists to prevent — a fixture with only one candidate invoice
    # can't catch it, since invoice_id and "no invoice_id" would be
    # indistinguishable.
    async def two(db, estimate_id, customer_id):
        return [dict(i) for i in TWO_INVOICES]

    monkeypatch.setattr(zoho_service, "list_project_invoices", two)
    project = await _create(async_client)

    response = await async_client.post(
        f"/api/v1/aito/{project['id']}/invoice-email",
        json={"to": "contact@example.pf", "invoice_id": "INV-7"},
    )

    assert response.status_code == 200
    assert response.json()["id"] == "INV-7"
    assert books_invoice_email == [("INV-7", ["contact@example.pf"])]


@pytest.mark.asyncio
async def test_send_uses_the_newest_invoice_when_none_is_pinned(async_client, books_invoice_email, monkeypatch):
    # The schema promises invoice_id is optional and falls back to the
    # newest invoice. Untested, this is exactly as likely to silently regress
    # as the pinning behaviour above.
    async def two(db, estimate_id, customer_id):
        return [dict(i) for i in TWO_INVOICES]

    monkeypatch.setattr(zoho_service, "list_project_invoices", two)
    project = await _create(async_client)

    response = await async_client.post(
        f"/api/v1/aito/{project['id']}/invoice-email",
        json={"to": "contact@example.pf"},
    )

    assert response.status_code == 200
    assert response.json()["id"] == "INV-42"
    assert books_invoice_email == [("INV-42", ["contact@example.pf"])]


@pytest.mark.asyncio
async def test_an_address_outside_the_allowlist_is_refused_without_sending(async_client, books_invoice_email):
    project = await _create(async_client)

    response = await async_client.post(
        f"/api/v1/aito/{project['id']}/invoice-email",
        json={"to": "attacker@evil.example", "invoice_id": "INV-7"},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "That address is not a recipient of this invoice"
    assert books_invoice_email == []  # Zoho was never asked to send anything
    assert "invoice.emailed" not in await _events(async_client, project["id"])


@pytest.mark.asyncio
async def test_an_invoice_id_from_another_project_is_refused_without_sending(async_client, books_invoice_email):
    project = await _create(async_client)

    response = await async_client.post(
        f"/api/v1/aito/{project['id']}/invoice-email",
        json={"to": "contact@example.pf", "invoice_id": "INV-999"},
    )

    assert response.status_code == 404
    assert books_invoice_email == []
    assert "invoice.emailed" not in await _events(async_client, project["id"])


@pytest.mark.asyncio
async def test_a_failed_send_records_nothing(async_client, books_invoice_email, monkeypatch):
    project = await _create(async_client)

    async def boom(db, invoice_id, *, to_mail_ids):
        raise ZohoUpstreamError("Zoho Books unreachable: ConnectError")

    monkeypatch.setattr(zoho_service, "email_invoice", boom)

    response = await async_client.post(
        f"/api/v1/aito/{project['id']}/invoice-email",
        json={"to": "contact@example.pf", "invoice_id": "INV-7"},
    )

    assert response.status_code == 502
    assert "invoice.emailed" not in await _events(async_client, project["id"])


@pytest.mark.asyncio
async def test_a_failed_re_read_after_a_successful_send_still_returns_200(
    async_client, books_invoice_email, monkeypatch
):
    # The mail has gone out and the event is committed. 500ing here would
    # invite a real second send on retry, which is the one thing this
    # handler exists to prevent.
    project = await _create(async_client)
    calls = {"n": 0}

    async def flaky(db, estimate_id, customer_id):
        calls["n"] += 1
        if calls["n"] > 1:
            raise ZohoUpstreamError("Zoho Books unreachable: ConnectError")
        return [dict(INVOICE)]

    # Patched after the fixture so the first (pre-send) lookup still answers.
    monkeypatch.setattr(zoho_service, "list_project_invoices", flaky)
    response = await async_client.post(
        f"/api/v1/aito/{project['id']}/invoice-email",
        json={"to": "contact@example.pf", "invoice_id": "INV-7"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "INV-7"
    # The re-read failed, so this must be the PRE-send invoice, not an
    # invented or defaulted one: still "draft", and no url — Books was never
    # reached a second time to produce either.
    assert body["status"] == "draft"
    assert body["url"] == ""
    assert "invoice.emailed" in await _events(async_client, project["id"])


@pytest.mark.asyncio
async def test_a_re_read_failure_that_genuinely_locks_the_db_does_not_500(
    async_client, books_invoice_email, monkeypatch
):
    """Regression test for a MissingGreenlet 500 that the test above cannot catch.

    Session.rollback() expires EVERY object in the identity map —
    ``_restore_snapshot(dirty_only=False)`` — not just dirty ones;
    ``expire_on_commit=False`` only governs commit, never rollback. Reading an
    expired attribute from async code afterwards does not lazily re-fetch it;
    it raises ``MissingGreenlet``.

    The fake above (and the fixture's own ``invoices``) never touch the
    session, so ``db.rollback()`` in the handler's except-block is a no-op
    there and this bug is invisible to it. This one actually executes a
    statement before failing, so a transaction is genuinely open when the
    handler's own ``await db.rollback()`` runs — reproducing what a real
    "database is locked" failure inside ``list_project_invoices`` looks like
    (it reaches this app's own SQLite file via ``_load_config``'s
    ``get_setting`` SELECTs, sharing a connection with this same session).
    """
    project = await _create(async_client)
    calls = {"n": 0}

    async def touches_the_session_then_fails(db, estimate_id, customer_id):
        calls["n"] += 1
        if calls["n"] > 1:
            await db.execute(text("SELECT 1"))
            raise ZohoUpstreamError("Zoho Books unreachable: ConnectError")
        return [dict(INVOICE)]

    # Patched after the fixture so the first (pre-send) lookup still answers.
    monkeypatch.setattr(zoho_service, "list_project_invoices", touches_the_session_then_fails)
    response = await async_client.post(
        f"/api/v1/aito/{project['id']}/invoice-email",
        json={"to": "contact@example.pf", "invoice_id": "INV-7"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "INV-7"
    assert body["status"] == "draft"
    assert body["url"] == ""
    assert "invoice.emailed" in await _events(async_client, project["id"])


@pytest.mark.asyncio
async def test_a_record_commit_failure_after_a_real_send_does_not_500(async_client, books_invoice_email, monkeypatch):
    """Same MissingGreenlet hazard, reached from the OTHER rollback: the
    handler's own ``record()`` + ``commit()`` pair failing after a real send.

    ``record()`` ends in ``await db.flush()``, which genuinely opens a
    transaction on this session (an INSERT is sent to SQLite) before this
    test's ``commit()`` override ever runs — so unlike the fake above, no
    artificial ``db.execute()`` is needed to open one; the real code path
    already does it. Faking ``AsyncSession.commit`` at the class level (only
    for its first call within this test) reproduces "the local commit hit a
    lock" without needing an actual second connection to contend for one.
    """
    project = await _create(async_client)
    real_commit = AsyncSession.commit
    calls = {"n": 0}

    async def flaky_commit(self):
        calls["n"] += 1
        if calls["n"] == 1:
            raise SQLAlchemyError("database is locked")
        return await real_commit(self)

    monkeypatch.setattr(AsyncSession, "commit", flaky_commit)

    response = await async_client.post(
        f"/api/v1/aito/{project['id']}/invoice-email",
        json={"to": "contact@example.pf", "invoice_id": "INV-7"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "INV-7"
    # The re-read after the failed commit still succeeds for real (the
    # fixture's second call), proving the handler recovered rather than
    # merely surviving by luck.
    assert body["status"] == "sent"
    assert body["url"]
    assert books_invoice_email == [("INV-7", ["contact@example.pf"])]
    # The commit that would have persisted invoice.emailed failed and was
    # rolled back — the send went out for real, but there is deliberately no
    # local record of it. See send_invoice_email's docstring on why a 500
    # here (inviting a retry that sends a second real invoice) is worse.
    assert "invoice.emailed" not in await _events(async_client, project["id"])
