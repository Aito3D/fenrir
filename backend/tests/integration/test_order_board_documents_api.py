"""The Order Board's document routes: quote and deposit PDF/email (ids checked against the stored order), the
per-order sync report, customer credit, client rating, contact edit and the manual credit apply. Books is stubbed."""

import time
from datetime import timedelta

import pytest
from sqlalchemy import select

from backend.app.api.routes import aito as aito_routes
from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.models.order_board_event import OrderBoardEvent
from backend.app.services import order_board_sync
from backend.app.services.order_board_sync import _common as sync_common
from backend.app.services.zoho import ZohoRateLimited, ZohoUpstreamError, zoho_service
from backend.tests.unit.test_order_board_routes import tokens  # noqa: F401

BASE = "/api/v1/order-board/orders/so1"
DETAIL = {
    "salesorder_id": "so1",
    "salesorder_number": "SO-1",
    "customer_id": "c1",
    "estimate_id": "est-1",
    "estimate_number": "DEV-1",
    "contact_person_details": [{"contact_person_id": "p1", "first_name": "Ana", "email": "ana@example.com"}],
    "invoices": [{"invoice_id": "inv-1", "invoice_number": "FA-1", "status": "sent", "balance": 5000}],
    "_retainers": [{"id": "ret-1", "number": "RET-1", "unused": 3000}],
    "line_items": [],
    "total": 8000,
}


@pytest.fixture(autouse=True)
def _fresh_guards():
    aito_routes._ai_rate_limit_calls.clear()
    yield
    aito_routes._ai_rate_limit_calls.clear()


@pytest.fixture
async def order(db_session, monkeypatch):
    db_session.add(OrderBoardDoc(kind="salesorder", zoho_id="so1", header={}, detail=dict(DETAIL)))
    await db_session.commit()
    left = {"retainer": 3000.0, "advance": 0.0}

    async def board_row(db, salesorder_id):
        return {"id": "so1", "payment": {"left": 5000, **left}} if salesorder_id == "so1" else None

    async def refresh(db, salesorder_id):
        return None

    monkeypatch.setattr(order_board_sync, "find_board_row", board_row)
    monkeypatch.setattr(order_board_sync, "refresh_order", refresh)
    return left


async def _events(db, kind):
    return list((await db.execute(select(OrderBoardEvent).where(OrderBoardEvent.kind == kind))).scalars())


@pytest.mark.asyncio
async def test_pdf_only_for_the_orders_own_quote_and_deposits(async_client, tokens, order, monkeypatch):  # noqa: F811
    async def estimate_pdf(db, estimate_id):
        return b"%PDF-quote"

    async def retainer_pdf(db, retainer_id):
        return b"%PDF-ret"

    monkeypatch.setattr(zoho_service, "get_estimate_pdf", estimate_pdf)
    monkeypatch.setattr(zoho_service, "get_retainer_invoice_pdf", retainer_pdf)
    r = await async_client.get(f"{BASE}/documents/quote/est-1/pdf", headers=tokens["read"])
    assert (r.status_code, r.content) == (200, b"%PDF-quote")
    r = await async_client.get(f"{BASE}/documents/retainer/ret-1/pdf", headers=tokens["read"])
    assert (r.status_code, r.content) == (200, b"%PDF-ret")
    for path in ("quote/est-2", "retainer/ret-9", "invoice/inv-1"):
        r = await async_client.get(f"{BASE}/documents/{path}/pdf", headers=tokens["read"])
        assert r.status_code in (400, 422), path
    assert (await async_client.get(f"{BASE}/documents/quote/est-1/pdf", headers=tokens["none"])).status_code == 403


@pytest.mark.asyncio
async def test_email_goes_only_to_a_books_recipient_and_is_logged(async_client, tokens, order, monkeypatch, db_session):  # noqa: F811
    sent = []

    async def content(db, estimate_id):
        return {"subject": "Devis", "body": "", "recipients": [{"email": "ana@example.com", "name": "Ana"}]}

    async def email(db, estimate_id, *, to_mail_ids):
        sent.append((estimate_id, to_mail_ids))

    monkeypatch.setattr(zoho_service, "get_estimate_email_content", content)
    monkeypatch.setattr(zoho_service, "email_estimate", email)
    body = (await async_client.get(f"{BASE}/documents/quote/est-1/email", headers=tokens["read"])).json()
    assert (body["default_email"], body["document_number"]) == ("ana@example.com", "DEV-1")
    r = await async_client.post(
        f"{BASE}/documents/quote/est-1/email", json={"to": "x@evil.test"}, headers=tokens["both"]
    )
    assert r.status_code == 422 and sent == []
    r = await async_client.post(
        f"{BASE}/documents/quote/est-1/email", json={"to": "ana@example.com"}, headers=tokens["both"]
    )
    assert r.status_code == 200 and sent == [("est-1", ["ana@example.com"])]
    [event] = await _events(db_session, "document.emailed")
    assert event.detail == {"document_kind": "quote", "document": "DEV-1", "to": "ana@example.com"}


@pytest.mark.asyncio
async def test_sync_reports_what_changed(async_client, tokens, order, monkeypatch):  # noqa: F811
    rows = iter(
        [
            {"id": "so1", "total": 8000, "payment": {"left": 5000, "state": "partial", "invoices": []}},
            {"id": "so1", "total": 8000, "payment": {"left": 0, "state": "paid", "invoices": [{"number": "FA-1"}]}},
        ]
    )

    async def board_row(db, salesorder_id):
        return next(rows)

    monkeypatch.setattr(order_board_sync, "find_board_row", board_row)
    body = (await async_client.post(f"{BASE}/sync", headers=tokens["both"])).json()
    assert {c["field"]: (c["from"], c["to"]) for c in body["changes"]} == {
        "left": (5000, 0),
        "state": ("partial", "paid"),
        "invoices": ([], ["FA-1"]),
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "status", "window"),
    [
        (ZohoRateLimited("429", retry_after=30), 503, True),
        (ZohoUpstreamError("Books said no"), 502, False),
    ],
)
async def test_sync_refresh_429_is_busy_and_opens_the_window(
    async_client,
    tokens,
    order,
    monkeypatch,
    error,
    status,
    window,  # noqa: F811
):
    async def board_row(db, salesorder_id):
        return {"id": "so1", "payment": {}}

    async def refresh(db, salesorder_id):
        raise error

    monkeypatch.setattr(order_board_sync, "find_board_row", board_row)
    monkeypatch.setattr(order_board_sync, "refresh_order", refresh)
    monkeypatch.setattr(sync_common, "_rate_limited_until", 0.0)
    r = await async_client.post(f"{BASE}/sync", headers=tokens["both"])
    assert r.status_code == status
    if window:
        assert r.json()["detail"] == "Zoho is busy, try again shortly."
    else:
        assert r.json()["detail"] == "Books said no"
    assert (sync_common._rate_limited_until > time.monotonic() + 20) is window
    monkeypatch.setattr(sync_common, "_rate_limited_until", 0.0)


@pytest.mark.asyncio
async def test_credit_and_rating_read_the_stored_customer(async_client, tokens, order, monkeypatch):  # noqa: F811
    seen = []

    async def credit(db, customer_id, cache=None):
        seen.append(customer_id)
        return 1234.0

    monkeypatch.setattr("backend.app.api.routes.order_board.documents.read_customer_credit", credit)
    body = (await async_client.get(f"{BASE}/customer-credit", headers=tokens["read"])).json()
    assert body == {"credit": 1234.0} and seen == ["c1"]
    r = await async_client.get("/api/v1/order-board/orders/nope/customer-credit", headers=tokens["read"])
    assert r.status_code == 404
    # By customer, for the new-order dialog: the caller names the id, so it needs orders:update.
    url = "/api/v1/order-board/customers/c7/credit"
    assert (await async_client.get(url, headers=tokens["read"])).status_code == 403
    assert (await async_client.get(url, headers=tokens["both"])).json() == {"credit": 1234.0} and seen[-1] == "c7"


@pytest.mark.asyncio
async def test_client_rating_reads_the_stored_customer_and_needs_orders_read(async_client, tokens, order, monkeypatch):  # noqa: F811
    from backend.app.schemas.aito import AitoClientRatingResponse

    seen = []

    async def rating(db, customer_id, **kwargs):
        seen.append(customer_id)
        return AitoClientRatingResponse(
            tier="good", reason="punctual", settled_count=4, on_time_count=4, computed_at=None, stale=False
        )

    monkeypatch.setattr("backend.app.api.routes.order_board.documents.read_client_rating", rating)
    r = await async_client.get(f"{BASE}/client-rating", headers=tokens["read"])
    assert r.status_code == 200
    assert (r.json()["tier"], r.json()["reason"], r.json()["settled_count"]) == ("good", "punctual", 4)
    assert seen == ["c1"]
    r = await async_client.get("/api/v1/order-board/orders/nope/client-rating", headers=tokens["read"])
    assert r.status_code == 404 and seen == ["c1"]
    assert (await async_client.get(f"{BASE}/client-rating", headers=tokens["none"])).status_code == 403
    assert seen == ["c1"]


@pytest.mark.asyncio
async def test_sync_is_refused_with_503_while_zoho_is_busy_and_reads_nothing(async_client, tokens, order, monkeypatch):  # noqa: F811
    calls = []

    async def board_row(db, salesorder_id):
        calls.append("row")
        return {"id": "so1", "payment": {}}

    async def refresh(db, salesorder_id):
        calls.append("refresh")

    monkeypatch.setattr(order_board_sync, "find_board_row", board_row)
    monkeypatch.setattr(order_board_sync, "refresh_order", refresh)
    monkeypatch.setattr(order_board_sync, "zoho_busy", lambda: True)
    r = await async_client.post(f"{BASE}/sync", headers=tokens["both"])
    assert r.status_code == 503
    assert r.json()["detail"] == "Zoho is busy, try again shortly."
    assert calls == []


@pytest.mark.asyncio
async def test_contact_edit_writes_the_orders_person(async_client, tokens, order, monkeypatch, db_session):  # noqa: F811
    calls = []

    async def update(db, contact_id, **kw):
        calls.append((contact_id, kw))

    monkeypatch.setattr(zoho_service, "update_contact_person", update)
    r = await async_client.put(
        f"{BASE}/contact", json={"email": " new@example.com ", "phone": "87 00 00 00"}, headers=tokens["both"]
    )
    assert r.status_code == 200
    assert calls == [
        (
            "c1",
            {"email": "new@example.com", "phone": "87 00 00 00", "phone_field": "mobile", "contact_person_id": "p1"},
        )
    ]
    assert len(await _events(db_session, "contact.edited")) == 1
    assert (await async_client.put(f"{BASE}/contact", json={}, headers=tokens["read"])).status_code == 403


@pytest.mark.asyncio
async def test_apply_credit_is_capped_by_balance_and_order_credit(async_client, tokens, order, monkeypatch, db_session):  # noqa: F811
    applied = []

    async def invoice(db, invoice_id):
        return {"invoice_id": invoice_id, "balance": 5000}

    async def payments(db, customer_id):
        return [{"payment_id": "pay-1", "retainerinvoice_id": "ret-1", "unused_amount": 9000, "date": "2026-10-01"}]

    async def apply(db, invoice_id, rows):
        applied.append((invoice_id, rows))

    monkeypatch.setattr(zoho_service, "get_invoice", invoice)
    monkeypatch.setattr(zoho_service, "list_customer_payments", payments)
    monkeypatch.setattr(zoho_service, "apply_invoice_credits", apply)
    r = await async_client.post(f"{BASE}/invoices/inv-1/apply-credit", headers=tokens["both"])
    assert r.status_code == 200 and r.json()["applied"] == 3000
    assert applied == [("inv-1", [{"payment_id": "pay-1", "amount_applied": 3000}])]
    [event] = await _events(db_session, "credit.applied")
    assert event.detail == {"invoice": "FA-1", "amount": 3000}

    r = await async_client.post(f"{BASE}/invoices/inv-9/apply-credit", headers=tokens["both"])
    assert (r.status_code, r.json()["detail"]) == (400, "unknown_invoice")
    order.update(retainer=0.0)
    r = await async_client.post(f"{BASE}/invoices/inv-1/apply-credit", headers=tokens["both"])
    assert (r.status_code, r.json()["detail"]) == (400, "no_credit")
    assert len(applied) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        (None, 3000),  # no body: today's behaviour
        ({}, 3000),  # body without a cap: same
        ({"cap": None}, 3000),
        ({"cap": 1200}, 1200),  # below the advance
        ({"cap": 3000}, 3000),
        ({"cap": 9999}, 3000),  # above balance and advance
        ({"cap": 12.345}, 12.35),  # rounded to the cent like the other limits
        ({"cap": 0}, "no_credit"),
    ],
)
async def test_apply_credit_cap_is_min_of_balance_advance_and_cap(  # noqa: F811
    async_client, tokens, order, monkeypatch, payload, expected
):
    applied = []

    async def invoice(db, invoice_id):
        return {"invoice_id": invoice_id, "balance": 5000}

    async def payments(db, customer_id):
        return [{"payment_id": "pay-1", "retainerinvoice_id": "ret-1", "unused_amount": 9000, "date": "2026-10-01"}]

    async def apply(db, invoice_id, rows):
        applied.append(rows)

    monkeypatch.setattr(zoho_service, "get_invoice", invoice)
    monkeypatch.setattr(zoho_service, "list_customer_payments", payments)
    monkeypatch.setattr(zoho_service, "apply_invoice_credits", apply)
    kw = {} if payload is None else {"json": payload}
    r = await async_client.post(f"{BASE}/invoices/inv-1/apply-credit", headers=tokens["both"], **kw)
    if expected == "no_credit":
        assert (r.status_code, r.json()["detail"]) == (400, "no_credit")
        assert applied == []
    else:
        assert r.status_code == 200 and r.json()["applied"] == expected
        assert applied == [[{"payment_id": "pay-1", "amount_applied": expected}]]


@pytest.mark.asyncio
@pytest.mark.parametrize("cap", [-1, "nan", "abc"])
async def test_apply_credit_rejects_a_bad_cap(async_client, tokens, order, cap):  # noqa: F811
    r = await async_client.post(f"{BASE}/invoices/inv-1/apply-credit", json={"cap": cap}, headers=tokens["both"])
    assert r.status_code == 422


@pytest.fixture
def quote_mail(monkeypatch):
    """A fake Books for the quote email: one offered address, every send recorded, `error` raised when set."""
    state = {"sent": [], "error": None}

    async def content(db, estimate_id):
        return {
            "subject": "Devis",
            "body": "",
            "recipients": [{"email": "ana@example.com", "name": "Ana"}, {"email": "bob@example.com", "name": "Bob"}],
        }

    async def email(db, estimate_id, *, to_mail_ids):
        if state["error"]:
            raise state["error"]
        state["sent"].append((estimate_id, to_mail_ids))

    aito_routes._reset_recent_emails()
    monkeypatch.setattr(zoho_service, "get_estimate_email_content", content)
    monkeypatch.setattr(zoho_service, "email_estimate", email)
    yield state
    aito_routes._reset_recent_emails()


@pytest.mark.asyncio
async def test_a_refused_quote_email_can_be_retried_but_a_lost_answer_cannot(async_client, tokens, order, quote_mail):  # noqa: F811
    from backend.app.services.zoho import ZohoRequestRejected, ZohoUnreachable

    url, h, mail = f"{BASE}/documents/quote/est-1/email", tokens["both"], {"to": "ana@example.com"}
    quote_mail["error"] = ZohoRequestRejected("Books says no")
    r = await async_client.post(url, headers=h, json=mail)
    assert (r.status_code, r.json()["detail"]) == (502, "Books says no")
    quote_mail["error"] = None
    r = await async_client.post(url, headers=h, json=mail)  # a clean refusal released the guard
    assert r.status_code == 200 and len(quote_mail["sent"]) == 1

    other = {"to": "bob@example.com"}
    quote_mail["error"] = ZohoUnreachable("timeout")
    r = await async_client.post(url, headers=h, json=other)
    assert r.status_code == 502
    quote_mail["error"] = None
    r = await async_client.post(url, headers=h, json=other)  # Books may have sent it: the guard stays armed
    assert r.status_code == 409 and len(quote_mail["sent"]) == 1


@pytest.mark.asyncio
async def test_quote_email_waits_for_a_write_on_the_same_order(async_client, tokens, order, quote_mail):  # noqa: F811
    from backend.app.services import order_board_actions as actions

    url, h, mail = f"{BASE}/documents/quote/est-1/email", tokens["both"], {"to": "ana@example.com"}
    with actions.writing("so1"):
        r = await async_client.post(url, headers=h, json=mail)
    assert r.status_code == 409 and quote_mail["sent"] == []
    r = await async_client.post(url, headers=h, json=mail)
    assert r.status_code == 200 and len(quote_mail["sent"]) == 1  # the busy refusal released the guard


@pytest.mark.asyncio
async def test_a_quote_email_with_an_ambiguous_answer_cannot_be_resent(async_client, tokens, order, quote_mail):  # noqa: F811
    from backend.app.services.zoho import ZohoAmbiguous

    url, h, mail = f"{BASE}/documents/quote/est-1/email", tokens["both"], {"to": "ana@example.com"}
    quote_mail["error"] = ZohoAmbiguous("502 gateway page")
    r = await async_client.post(url, headers=h, json=mail)
    assert r.status_code == 502
    quote_mail["error"] = None
    r = await async_client.post(url, headers=h, json=mail)  # Books may have sent it: the guard stays armed
    assert r.status_code == 409 and quote_mail["sent"] == []


@pytest.mark.asyncio
async def test_contact_edit_refuses_a_malformed_email_but_takes_valid_or_empty(
    async_client, tokens, order, monkeypatch
):  # noqa: F811
    async def update(db, contact_id, **kw):
        return None

    monkeypatch.setattr(zoho_service, "update_contact_person", update)
    for bad in ("not-an-email", "a@b", "two@@x.pf", "a b@x.pf"):
        r = await async_client.put(f"{BASE}/contact", json={"email": bad}, headers=tokens["both"])
        assert r.status_code == 422, bad
    for good in ("new@example.com", ""):
        r = await async_client.put(f"{BASE}/contact", json={"email": good, "phone": "87"}, headers=tokens["both"])
        assert r.status_code == 200, good


@pytest.mark.asyncio
async def test_quote_email_refuses_an_address_a_contact_edit_just_set(
    async_client, tokens, order, quote_mail, monkeypatch
):  # noqa: F811
    from backend.app.api.routes.order_board import _common

    async def update(db, contact_id, **kw):
        return None

    monkeypatch.setattr(zoho_service, "update_contact_person", update)
    url, h = f"{BASE}/documents/quote/est-1/email", tokens["both"]
    # bob is offered by Books; ana is the stored contact and stays unchanged by a phone-only edit.
    await async_client.put(f"{BASE}/contact", json={"email": "Bob@Example.com"}, headers=h)
    await async_client.put(f"{BASE}/contact", json={"email": "ana@example.com", "phone": "87"}, headers=h)
    r = await async_client.post(url, headers=h, json={"to": "bob@example.com"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "recipient_recently_edited"
    assert quote_mail["sent"] == []
    r = await async_client.post(url, headers=h, json={"to": "ana@example.com"})  # not edited: sent as before
    assert r.status_code == 200 and len(quote_mail["sent"]) == 1
    later = _common.utc_now_naive() + _common._RECIPIENT_EDIT_COOLDOWN + timedelta(seconds=1)
    monkeypatch.setattr(_common, "utc_now_naive", lambda: later)  # the window has passed
    r = await async_client.post(url, headers=h, json={"to": "bob@example.com"})
    assert r.status_code == 200 and len(quote_mail["sent"]) == 2


@pytest.mark.asyncio
async def test_quote_email_refuses_an_address_edited_from_another_order_of_the_client(
    async_client, tokens, order, quote_mail, db_session, monkeypatch
):  # noqa: F811
    async def update(db, contact_id, **kw):
        return None

    monkeypatch.setattr(zoho_service, "update_contact_person", update)
    db_session.add(OrderBoardDoc(kind="salesorder", zoho_id="so2", header={}, detail=dict(DETAIL, salesorder_id="so2")))
    await db_session.commit()
    h = tokens["both"]
    await async_client.put(f"{BASE}/contact", json={"email": "Bob@Example.com"}, headers=h)  # edited on so1
    r = await async_client.post(
        "/api/v1/order-board/orders/so2/documents/quote/est-1/email", headers=h, json={"to": "bob@example.com"}
    )
    assert r.status_code == 409 and r.json()["detail"]["code"] == "recipient_recently_edited"
    assert quote_mail["sent"] == []
