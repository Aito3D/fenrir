"""The quote list route: who may read it and what shape it returns."""

from uuid import uuid4

import pytest

from backend.app.services import order_board_sync
from backend.app.services.zoho import zoho_service
from backend.tests.unit.test_order_board_routes import tokens  # noqa: F401  (fixture)


@pytest.mark.asyncio
async def test_quotes_need_orders_read(async_client, tokens):  # noqa: F811
    assert (await async_client.get("/api/v1/order-board/quotes", headers=tokens["none"])).status_code == 403
    assert (await async_client.get("/api/v1/order-board/quotes", headers=tokens["read"])).status_code == 200


@pytest.mark.asyncio
async def test_quotes_returns_rows_loading_ready(async_client, tokens, monkeypatch):  # noqa: F811
    payload = {"rows": [{"estimate_id": "e1"}], "loading": 2, "ready": True}

    async def fake_read(db):
        return payload

    monkeypatch.setattr(order_board_sync, "read_quotes", fake_read)
    r = await async_client.get("/api/v1/order-board/quotes", headers=tokens["read"])
    assert r.json() == payload
    # Unsynced: the real read reports not ready, never an error.
    monkeypatch.undo()
    r = await async_client.get("/api/v1/order-board/quotes", headers=tokens["read"])
    assert r.json() == {"rows": [], "loading": 0, "ready": False}


_LINE = {"item_id": "A", "quantity": 1}
_WRITES = [
    ("post", "/api/v1/order-board/quotes", {"customer_id": "c1", "client_ref": str(uuid4()), "lines": [_LINE]}),
    ("put", "/api/v1/order-board/quotes/e1", {"customer_id": "c1", "lines": [_LINE]}),
    ("post", "/api/v1/order-board/quotes/e1/decline", None),
    ("post", "/api/v1/order-board/quotes/e1/reopen", None),
    ("post", "/api/v1/order-board/quotes/e1/accept", None),
    ("post", "/api/v1/order-board/quotes/e1/order", None),
    ("post", "/api/v1/order-board/quotes/e1/undo-accept", {"salesorder_id": "so1"}),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(("method", "url", "body"), _WRITES)
async def test_quote_writes_need_orders_update(async_client, tokens, method, url, body):  # noqa: F811
    r = await async_client.request(method, url, json=body, headers=tokens["read"])
    assert r.status_code == 403


@pytest.mark.asyncio
@pytest.mark.parametrize(("method", "url", "body"), _WRITES[1:])
async def test_a_write_on_an_unstored_quote_is_404(async_client, tokens, method, url, body):  # noqa: F811
    r = await async_client.request(method, url, json=body, headers=tokens["both"])
    assert (r.status_code, r.json()["detail"]) == (404, "Quote not found.")


@pytest.mark.asyncio
async def test_edit_with_201_lines_is_422(async_client, tokens):  # noqa: F811
    body = {"customer_id": "c1", "lines": [{"item_id": f"i{n}", "quantity": 1} for n in range(201)]}
    r = await async_client.put("/api/v1/order-board/quotes/e1", json=body, headers=tokens["both"])
    assert r.status_code == 422


# ---- PDF, email and activity ----

BASE = "/api/v1/order-board/quotes/e1"
_READS = [("get", f"{BASE}/pdf"), ("get", f"{BASE}/email"), ("get", f"{BASE}/events")]


@pytest.fixture
async def stored(db_session):
    from backend.app.models.order_board_doc import OrderBoardDoc

    estimate = {"estimate_id": "e1", "estimate_number": "QT-00001", "customer_id": "c1", "status": "draft"}
    db_session.add(OrderBoardDoc(kind="estimate", zoho_id="e1", header={"estimate_id": "e1"}, detail=estimate))
    await db_session.commit()
    return estimate


@pytest.fixture
def books(monkeypatch):
    """A fake Books for the quote PDF and email: one offered address, every call recorded."""
    from backend.app.api.routes import aito as aito_routes

    calls: list[tuple] = []

    async def pdf(db, estimate_id):
        calls.append(("pdf", estimate_id))
        return b"%PDF-quote"

    async def content(db, estimate_id):
        calls.append(("content", estimate_id))
        return {"subject": "Devis", "body": "", "recipients": [{"email": "ana@example.com", "name": "Ana"}]}

    async def email(db, estimate_id, *, to_mail_ids):
        calls.append(("email", estimate_id, to_mail_ids))

    async def get_estimate(db, estimate_id):
        calls.append(("get", estimate_id))
        return {"estimate_id": estimate_id, "estimate_number": "QT-00001", "customer_id": "c1", "status": "sent"}

    async def set_status(db, estimate_id, status):
        calls.append(("status", estimate_id, status))

    aito_routes._reset_recent_emails()
    for fn, name in (
        (pdf, "get_estimate_pdf"),
        (content, "get_estimate_email_content"),
        (email, "email_estimate"),
        (get_estimate, "get_estimate"),
        (set_status, "set_estimate_status"),
    ):
        monkeypatch.setattr(zoho_service, name, fn)
    yield calls
    aito_routes._reset_recent_emails()


@pytest.mark.asyncio
@pytest.mark.parametrize(("method", "url"), _READS)
async def test_quote_reads_need_orders_read(async_client, tokens, method, url):  # noqa: F811
    assert (await async_client.request(method, url, headers=tokens["none"])).status_code == 403


@pytest.mark.asyncio
async def test_quote_email_post_needs_orders_update(async_client, tokens):  # noqa: F811
    r = await async_client.post(f"{BASE}/email", json={"to": "ana@example.com"}, headers=tokens["read"])
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_quote_routes_404_for_an_unknown_or_aito_quote(async_client, tokens, books):  # noqa: F811
    for method, url in [*_READS, ("post", f"{BASE}/email")]:
        r = await async_client.request(method, url, json={"to": "ana@example.com"}, headers=tokens["both"])
        assert (r.status_code, r.json()["detail"]) == (404, "Quote not found."), url
    assert books == []  # nothing reached Books


@pytest.mark.asyncio
async def test_quote_pdf_is_inline_and_no_store(async_client, tokens, stored, books):  # noqa: F811
    r = await async_client.get(f"{BASE}/pdf", headers=tokens["read"])
    assert (r.status_code, r.content) == (200, b"%PDF-quote")
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["content-disposition"].startswith("inline") and "QT-00001.pdf" in r.headers["content-disposition"]


@pytest.mark.asyncio
async def test_quote_email_content_preselects_the_first_offered_address(async_client, tokens, stored, books):  # noqa: F811
    body = (await async_client.get(f"{BASE}/email", headers=tokens["read"])).json()
    assert (body["default_email"], body["document_number"]) == ("ana@example.com", "QT-00001")


@pytest.mark.asyncio
async def test_email_refuses_an_address_books_did_not_offer(async_client, tokens, stored, books):  # noqa: F811
    r = await async_client.post(f"{BASE}/email", json={"to": "x@evil.test"}, headers=tokens["both"])
    assert r.status_code == 422
    assert not [c for c in books if c[0] == "email"]


@pytest.mark.asyncio
async def test_email_sends_once_then_refreshes_the_quote(async_client, tokens, stored, books, db_session):  # noqa: F811
    from sqlalchemy import select

    from backend.app.models.order_board_doc import OrderBoardDoc
    from backend.app.models.order_board_event import OrderBoardEvent

    url, h, mail = f"{BASE}/email", tokens["both"], {"to": "Ana@Example.com"}
    r = await async_client.post(url, json=mail, headers=h)
    assert r.status_code == 200
    assert [c for c in books if c[0] == "email"] == [("email", "e1", ["Ana@Example.com"])]
    assert not [c for c in books if c[0] == "status"]  # Books marks it sent itself
    doc = (await db_session.execute(select(OrderBoardDoc).where(OrderBoardDoc.kind == "estimate"))).scalar_one()
    assert doc.detail["status"] == "sent"
    [event] = (
        await db_session.execute(select(OrderBoardEvent).where(OrderBoardEvent.kind == "quote.emailed"))
    ).scalars()
    assert event.salesorder_id == "e1"
    # a second send within the minute is refused
    assert (await async_client.post(url, json=mail, headers=h)).status_code == 409
    assert len([c for c in books if c[0] == "email"]) == 1


@pytest.mark.asyncio
async def test_quote_events_lists_quote_kinds(async_client, tokens, stored, books, db_session):  # noqa: F811
    from backend.app.services.order_board_events import record

    await record(db_session, "e1", "quote.created", actor_class="user", actor_name="x")
    await record(db_session, "so9", "quote.created", actor_class="user", actor_name="x")
    await db_session.commit()
    r = await async_client.get(f"{BASE}/events", headers=tokens["read"])
    assert r.status_code == 200
    assert [e["kind"] for e in r.json()["events"]] == ["quote.created"]
    assert r.json()["has_more"] is False
