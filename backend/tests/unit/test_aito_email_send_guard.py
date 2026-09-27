"""T-064: the quote and invoice emails get a rate limit and a duplicate-send guard.

Both routes mail the client from the company's Zoho account on every call, so
— like the pickup SMS (T-025/T-043/T-044) — an identical send inside a minute
is refused with 409 before Books is asked, and a principal past ten sends a
minute (one bucket shared by both routes) gets 429. The key is armed before
the send, kept on success and on ZohoUnreachable (Books may have sent it),
and dropped on a clean refusal from Books or any other exception the send
raises. conftest's ``_reset_zoho_email_guards`` empties both around every test.
"""

import pytest

from backend.app.api.routes import aito as aito_routes
from backend.app.services.zoho import (
    ZohoNotConfiguredError,
    ZohoRequestRejected,
    ZohoUnreachable,
    ZohoUpstreamError,
    zoho_service,
)

pytestmark = pytest.mark.asyncio

RECIPIENTS = [
    {"email": "contact@example.pf", "name": "Jean-Pierre DUPONT", "contact_person_id": "cp-1"},
    {"email": "compta@example.pf", "name": "Compta", "contact_person_id": "cp-2"},
]
INVOICE = {
    "id": "INV-7",
    "number": "INV-00087",
    "date": "2026-08-18",
    "due_date": "2026-09-18",
    "total": 45000.0,
    "balance": 45000.0,
    "currency_code": "XPF",
    "status": "sent",
}


class _FakeClock:
    """Stands in for the module's `time` name (only `.monotonic()` is read).
    Never patch the real `time.monotonic` in an async test."""

    def __init__(self, start: float = 1000.0):
        self.now = start

    def monotonic(self) -> float:
        return self.now


@pytest.fixture
def books(monkeypatch):
    """Books answers both prefills and records every send; ``error`` makes the
    next sends raise instead."""
    state = {"sent": [], "error": None}

    async def content(db, _document_id):
        return {"subject": "S", "body": "<p>B</p>", "recipients": list(RECIPIENTS)}

    async def send(kind, document_id, to_mail_ids):
        state["sent"].append((kind, document_id, to_mail_ids))
        if state["error"] is not None:
            raise state["error"]

    async def email_estimate(db, estimate_id, *, to_mail_ids):
        await send("quote", estimate_id, to_mail_ids)

    async def email_invoice(db, invoice_id, *, to_mail_ids):
        await send("invoice", invoice_id, to_mail_ids)

    async def invoices(db, estimate_id, customer_id):
        return [dict(INVOICE)]

    async def url(db, invoice_id):
        return f"https://books.zoho.com/app#/invoices/{invoice_id}"

    monkeypatch.setattr(zoho_service, "get_estimate_email_content", content)
    monkeypatch.setattr(zoho_service, "get_invoice_email_content", content)
    monkeypatch.setattr(zoho_service, "email_estimate", email_estimate)
    monkeypatch.setattr(zoho_service, "email_invoice", email_invoice)
    monkeypatch.setattr(zoho_service, "list_project_invoices", invoices)
    monkeypatch.setattr(zoho_service, "books_invoice_url", url)
    return state


@pytest.fixture
def clock(monkeypatch):
    fake = _FakeClock()
    monkeypatch.setattr(aito_routes, "time", fake)
    return fake


async def _card(async_client, quote_id="EST-9"):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        "client_email": "contact@example.pf",
        "quote_id": quote_id,
        "quote_number": f"QT-{quote_id}",
    }
    r = await async_client.post("/api/v1/aito/", json=payload)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _url(project_id, kind):
    return f"/api/v1/aito/{project_id}/{kind}-email"


@pytest.mark.parametrize("kind", ["quote", "invoice"])
async def test_a_second_identical_send_inside_the_window_is_a_409_with_one_books_call(async_client, books, clock, kind):
    pid = await _card(async_client)
    first = await async_client.post(_url(pid, kind), json={"to": "contact@example.pf"})
    assert first.status_code == 200, first.text
    clock.now += 59
    # Same address in another case is the same recipient (the allowlist folds case too).
    again = await async_client.post(_url(pid, kind), json={"to": " Contact@Example.pf "})
    assert again.status_code == 409
    assert again.json()["detail"].startswith("Already sent")
    assert len(books["sent"]) == 1


@pytest.mark.parametrize("kind", ["quote", "invoice"])
async def test_the_same_send_goes_again_once_the_window_has_passed(async_client, books, clock, kind):
    pid = await _card(async_client)
    assert (await async_client.post(_url(pid, kind), json={"to": "contact@example.pf"})).status_code == 200
    clock.now += 60
    assert (await async_client.post(_url(pid, kind), json={"to": "contact@example.pf"})).status_code == 200
    assert len(books["sent"]) == 2
    # The stale key was pruned rather than kept alongside the fresh one.
    assert len(aito_routes._recent_emails) == 1


@pytest.mark.parametrize("kind", ["quote", "invoice"])
async def test_a_different_recipient_is_not_a_duplicate(async_client, books, clock, kind):
    pid = await _card(async_client)
    assert (await async_client.post(_url(pid, kind), json={"to": "contact@example.pf"})).status_code == 200
    assert (await async_client.post(_url(pid, kind), json={"to": "compta@example.pf"})).status_code == 200
    assert [s[2] for s in books["sent"]] == [["contact@example.pf"], ["compta@example.pf"]]


async def test_the_quote_and_its_invoice_to_the_same_address_are_different_sends(async_client, books, clock):
    pid = await _card(async_client)
    assert (await async_client.post(_url(pid, "quote"), json={"to": "contact@example.pf"})).status_code == 200
    assert (await async_client.post(_url(pid, "invoice"), json={"to": "contact@example.pf"})).status_code == 200
    assert [s[0] for s in books["sent"]] == ["quote", "invoice"]


async def test_another_cards_quote_to_the_same_address_is_not_a_duplicate(async_client, books, clock):
    first = await _card(async_client, quote_id="EST-1")
    second = await _card(async_client, quote_id="EST-2")
    assert (await async_client.post(_url(first, "quote"), json={"to": "contact@example.pf"})).status_code == 200
    assert (await async_client.post(_url(second, "quote"), json={"to": "contact@example.pf"})).status_code == 200
    assert [s[1] for s in books["sent"]] == ["EST-1", "EST-2"]


async def test_past_ten_sends_a_minute_across_both_routes_is_a_429_before_books(async_client, books, clock):
    pid = await _card(async_client)
    # One real send, then nine refused duplicates alternating routes: every
    # call counts against the one shared bucket, refused or not.
    assert (await async_client.post(_url(pid, "quote"), json={"to": "contact@example.pf"})).status_code == 200
    statuses = [
        (
            await async_client.post(_url(pid, "invoice" if i % 2 else "quote"), json={"to": "contact@example.pf"})
        ).status_code
        for i in range(9)
    ]
    assert statuses.count(200) == 1  # the invoice's first send
    over = await async_client.post(_url(pid, "invoice"), json={"to": "compta@example.pf"})
    assert over.status_code == 429
    assert over.json()["detail"] == "Too many email sends. Please wait a moment and try again."
    assert len(books["sent"]) == 2
    clock.now += 60
    assert (await async_client.post(_url(pid, "invoice"), json={"to": "compta@example.pf"})).status_code == 200


@pytest.mark.parametrize("kind", ["quote", "invoice"])
@pytest.mark.parametrize(
    ("error", "status"),
    [
        (ZohoRequestRejected("This contact has no email address"), 400),
        (ZohoUpstreamError("Books answered 500"), 502),
        (ZohoNotConfiguredError("missing settings"), 502),
    ],
)
async def test_a_clean_refusal_from_books_drops_the_key_so_a_retry_goes(
    async_client, books, clock, kind, error, status
):
    pid = await _card(async_client)
    books["error"] = error
    assert (await async_client.post(_url(pid, kind), json={"to": "contact@example.pf"})).status_code == status
    assert aito_routes._recent_emails == {}
    books["error"] = None
    assert (await async_client.post(_url(pid, kind), json={"to": "contact@example.pf"})).status_code == 200
    assert len(books["sent"]) == 2


@pytest.mark.parametrize("kind", ["quote", "invoice"])
async def test_an_unreachable_books_keeps_the_key_because_it_may_have_sent(async_client, books, clock, kind):
    pid = await _card(async_client)
    books["error"] = ZohoUnreachable("Zoho Books unreachable: ReadTimeout")
    r = await async_client.post(_url(pid, kind), json={"to": "contact@example.pf"})
    assert r.status_code == 502
    assert r.json()["detail"] == "Zoho Books unreachable: ReadTimeout"  # unchanged mapping
    books["error"] = None
    again = await async_client.post(_url(pid, kind), json={"to": "contact@example.pf"})
    assert again.status_code == 409
    assert len(books["sent"]) == 1


@pytest.mark.parametrize("kind", ["quote", "invoice"])
async def test_an_unexpected_exception_from_the_send_drops_the_key(async_client, books, clock, kind):
    pid = await _card(async_client)
    books["error"] = RuntimeError("bug")
    try:
        r = await async_client.post(_url(pid, kind), json={"to": "contact@example.pf"})
        assert r.status_code != 200
    except RuntimeError:
        pass  # propagated unchanged, as before
    assert aito_routes._recent_emails == {}
    books["error"] = None
    assert (await async_client.post(_url(pid, kind), json={"to": "contact@example.pf"})).status_code == 200


@pytest.mark.parametrize("kind", ["quote", "invoice"])
async def test_a_refused_request_never_arms_the_key(async_client, books, clock, kind):
    pid = await _card(async_client)
    outside = await async_client.post(_url(pid, kind), json={"to": "stranger@example.com"})
    assert outside.status_code == 422
    assert (await async_client.post(_url(99999, kind), json={"to": "contact@example.pf"})).status_code == 404
    assert aito_routes._recent_emails == {}
    assert books["sent"] == []
