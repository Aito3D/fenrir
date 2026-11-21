"""The quote list route: who may read it and what shape it returns."""

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
