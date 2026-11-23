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


@pytest.mark.asyncio
async def test_a_quote_on_an_aito_card_is_refused_at_once(async_client, tokens, stored, books, db_session):  # noqa: F811
    from backend.app.models.aito_project import AitoProject
    from backend.app.services.order_board_sync._common import _state

    state = await _state(db_session)
    state.detail = {"quotes_listed_at": "2026-11-21T08:00:00+0000"}
    db_session.add(AitoProject(description="card", board_column="devis", quote_id="e1"))
    await db_session.commit()
    h = tokens["both"]
    assert (await async_client.get("/api/v1/order-board/quotes", headers=h)).json()["rows"] == []
    for method, url, body in [
        ("post", f"{BASE}/accept", None),
        ("put", BASE, {"customer_id": "c1", "lines": [_LINE]}),
        ("post", f"{BASE}/decline", None),
        ("post", f"{BASE}/email", {"to": "ana@example.com"}),
        ("get", f"{BASE}/pdf", None),
        ("post", f"{BASE}/undo-accept", {"salesorder_id": "so1"}),
    ]:
        r = await async_client.request(method, url, json=body, headers=h)
        assert (r.status_code, r.json()["detail"]) == (404, "Quote not found."), url
    assert books == []  # nothing reached Books


@pytest.mark.asyncio
async def test_undo_accept_refused_while_the_orders_payment_lock_is_held(async_client, tokens, stored, books):  # noqa: F811
    from backend.app.api.routes.order_board.payment import _order_payment_lock

    async with _order_payment_lock("so1", wait=True):
        r = await async_client.post(f"{BASE}/undo-accept", json={"salesorder_id": "so1"}, headers=tokens["both"])
    assert (r.status_code, r.json()["detail"]) == (400, "undo_too_late")
    assert books == []


@pytest.mark.asyncio
async def test_undo_accept_answers_the_refreshed_board(async_client, tokens, stored, monkeypatch):  # noqa: F811
    from backend.app.services import order_board_actions

    calls = []

    async def fake_undo(db, estimate_id, salesorder_id, *, by):
        calls.append((estimate_id, salesorder_id))

    monkeypatch.setattr(order_board_actions, "undo_accept", fake_undo)
    r = await async_client.post(f"{BASE}/undo-accept", json={"salesorder_id": "so1"}, headers=tokens["both"])
    assert (r.status_code, sorted(r.json()), calls) == (200, ["board", "quotes"], [("e1", "so1")])


# ---- success paths: the body maps to the action arguments, the answer carries the refreshed lists ----


@pytest.fixture
def actions(monkeypatch):
    """Every quote action replaced by a recorder; the routes run for real around them."""
    from backend.app.services import order_board_actions

    calls: list[tuple] = []

    def make(name, result):
        async def fake(*args, **kwargs):
            calls.append((name, *args[1:], kwargs))  # args[0] is the session
            return result

        monkeypatch.setattr(order_board_actions, name, fake)

    make("create_quote", "e9")
    make("edit_quote", None)
    make("decline_quote", None)
    make("reopen_quote", None)
    make("create_order_from_quote", "so7")
    return calls


_NOT_READY = {"rows": [], "loading": 0, "ready": False}


@pytest.mark.asyncio
async def test_create_quote_is_201_and_passes_lines_without_nones(async_client, tokens, actions):  # noqa: F811
    ref = uuid4()
    body = {"customer_id": "c1", "client_ref": str(ref), "lines": [_LINE, {**_LINE, "discount": "10%"}]}
    r = await async_client.post("/api/v1/order-board/quotes", json=body, headers=tokens["both"])
    assert (r.status_code, r.json()) == (201, {"quotes": _NOT_READY, "estimate_id": "e9"})
    lines = [{"item_id": "A", "quantity": 1.0}, {"item_id": "A", "quantity": 1.0, "discount": "10%"}]
    assert actions == [("create_quote", "c1", lines, str(ref), {"by": "orders-both"})]


@pytest.mark.asyncio
async def test_edit_quote_keeps_the_line_id_and_drops_nones(async_client, tokens, actions):  # noqa: F811
    body = {"customer_id": "c2", "lines": [{**_LINE, "line_id": "L1"}, _LINE]}
    r = await async_client.put(BASE, json=body, headers=tokens["both"])
    assert (r.status_code, r.json()) == (200, {"quotes": _NOT_READY, "estimate_id": "e1"})
    lines = [{"item_id": "A", "quantity": 1.0, "line_id": "L1"}, {"item_id": "A", "quantity": 1.0}]
    assert actions == [("edit_quote", "e1", "c2", lines, {"by": "orders-both"})]


@pytest.mark.asyncio
@pytest.mark.parametrize("verb", ["decline", "reopen"])
async def test_decline_and_reopen_answer_the_quotes(async_client, tokens, actions, verb):  # noqa: F811
    r = await async_client.post(f"{BASE}/{verb}", headers=tokens["both"])
    assert (r.status_code, r.json()) == (200, {"quotes": _NOT_READY, "estimate_id": "e1"})
    assert actions == [(f"{verb}_quote", "e1", {"by": "orders-both"})]


@pytest.mark.asyncio
async def test_create_order_from_quote_answers_quotes_board_row(async_client, tokens, actions):  # noqa: F811
    r = await async_client.post(f"{BASE}/order", headers=tokens["both"])
    body = r.json()
    assert r.status_code == 200
    assert sorted(body) == ["board", "quotes", "row", "salesorder_id", "undoable"]
    assert (body["salesorder_id"], body["row"], body["undoable"]) == ("so7", None, False)
    assert actions == [("create_order_from_quote", "e1", {"by": "orders-both"})]


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [{"salesorder_id": ""}, {}])
async def test_undo_accept_with_a_wrong_shape_is_422(async_client, tokens, body):  # noqa: F811
    r = await async_client.post(f"{BASE}/undo-accept", json=body, headers=tokens["both"])
    assert r.status_code == 422
