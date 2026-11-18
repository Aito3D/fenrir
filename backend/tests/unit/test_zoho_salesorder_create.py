import pytest

from backend.app.services.zoho import zoho_service


@pytest.mark.asyncio
async def test_create_salesorder_posts_and_returns_the_order(monkeypatch):
    calls = []

    async def fake_request(db, method, path, **kwargs):
        calls.append((method, path, kwargs))
        return {"salesorder": {"salesorder_id": "9"}}

    monkeypatch.setattr(zoho_service, "_request", fake_request)
    payload = {"customer_id": "1"}
    assert await zoho_service.create_salesorder(None, payload) == {"salesorder_id": "9"}
    assert calls == [("POST", "/salesorders", {"json": payload})]


@pytest.mark.asyncio
async def test_mark_salesorder_open_posts_status_open(monkeypatch):
    calls = []

    async def fake_request(db, method, path, **kwargs):
        calls.append((method, path, kwargs))
        return {}

    monkeypatch.setattr(zoho_service, "_request", fake_request)
    await zoho_service.mark_salesorder_open(None, "9")
    assert calls == [("POST", "/salesorders/9/status/open", {})]
