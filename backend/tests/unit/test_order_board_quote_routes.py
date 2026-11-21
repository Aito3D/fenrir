"""The quote list route: who may read it and what shape it returns."""

from uuid import uuid4

import pytest

from backend.app.services import order_board_sync
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
