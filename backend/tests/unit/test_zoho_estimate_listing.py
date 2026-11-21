import pytest

from backend.app.services import zoho as zoho_module
from backend.app.services.zoho import zoho_service


def _fake(monkeypatch, responder):
    calls = []

    async def fake_request(db, method, path, **kwargs):
        calls.append((method, path, kwargs))
        return responder(len(calls), kwargs)

    monkeypatch.setattr(zoho_service, "_request", fake_request)
    return calls


@pytest.mark.asyncio
async def test_list_estimates_pages_until_no_more(monkeypatch):
    calls = _fake(
        monkeypatch,
        lambda n, kw: {"estimates": [{"estimate_id": str(n)}], "page_context": {"has_more_page": n < 2}},
    )
    rows = await zoho_service.list_estimates(None)
    assert rows == [{"estimate_id": "1"}, {"estimate_id": "2"}]
    assert [c[1] for c in calls] == ["/estimates", "/estimates"]
    assert [c[2]["params"]["page"] for c in calls] == [1, 2]


@pytest.mark.asyncio
async def test_modified_since_returns_full_rows_and_truncated_flag(monkeypatch):
    row = {"estimate_id": "7", "status": "sent", "total": 12.5, "expiry_date": "2026-12-01"}
    calls = _fake(monkeypatch, lambda n, kw: {"estimates": [row], "page_context": {"has_more_page": False}})
    rows, truncated = await zoho_service.list_estimate_rows_modified_since(None, "2026-11-01T00:00:00+0100")
    assert rows == [row]
    assert truncated is False
    params = calls[0][2]["params"]
    assert params["last_modified_time"] == "2026-11-01T00:00:00+0100"
    assert params["sort_column"] == "last_modified_time"
    assert params["sort_order"] == "A"

    calls = _fake(monkeypatch, lambda n, kw: {"estimates": [row], "page_context": {"has_more_page": True}})
    rows, truncated = await zoho_service.list_estimate_rows_modified_since(None, "x")
    assert truncated is True
    assert len(rows) == len(calls) == zoho_module._MAX_CHANGE_PAGES


@pytest.mark.asyncio
async def test_prefill_reads_the_salesorder_key(monkeypatch):
    calls = _fake(monkeypatch, lambda n, kw: {"salesorder": {"customer_id": "1"}})
    assert await zoho_service.salesorder_prefill_from_estimate(None, "e9") == {"customer_id": "1"}
    assert calls == [("GET", "/salesorders/editpage/fromestimate", {"params": {"estimate_id": "e9"}})]

    _fake(monkeypatch, lambda n, kw: {})
    assert await zoho_service.salesorder_prefill_from_estimate(None, "e9") == {}


@pytest.mark.asyncio
async def test_delete_salesorder_sends_delete(monkeypatch):
    calls = _fake(monkeypatch, lambda n, kw: {})
    assert await zoho_service.delete_salesorder(None, "9/../x") is None
    assert calls == [("DELETE", f"/salesorders/{zoho_module._seg('9/../x')}", {})]
