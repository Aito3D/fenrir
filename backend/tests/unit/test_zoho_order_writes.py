"""The Zoho calls behind parcels, shipments and invoices: method, path, params and body of each."""

import httpx
import pytest

from backend.app.services.zoho import ZohoRequestRejected, ZohoUpstreamError, zoho_service
from backend.tests.unit.test_aito_quote_sync import (  # noqa: F401 — fixtures register by name
    _configure_zoho,
    reset_zoho_service,
)


async def _fake(db, seen: list, status: int = 200, body: dict | None = None) -> None:
    await _configure_zoho(db)

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        seen.append((request.method, request.url.path, dict(request.url.params), request.content))
        return httpx.Response(status, json=body or {})

    zoho_service.transport = httpx.MockTransport(handler)
    zoho_service.invalidate_token()


def _json(content: bytes) -> dict:
    import json

    return json.loads(content) if content else {}


@pytest.mark.asyncio
async def test_create_package(db_session):
    seen: list = []
    await _fake(db_session, seen, body={"package": {"package_id": "p1"}})
    lines = [{"so_line_item_id": "l1", "quantity": 2}]
    assert await zoho_service.create_package(db_session, "so1", date="2026-01-04", line_items=lines) == {
        "package_id": "p1"
    }
    method, path, params, content = seen[0]
    assert (method, path.endswith("/packages"), params["salesorder_id"]) == ("POST", True, "so1")
    assert _json(content) == {"date": "2026-01-04", "line_items": lines}


@pytest.mark.asyncio
async def test_get_package(db_session):
    seen: list = []
    await _fake(db_session, seen, body={"package": {"package_id": "p1", "status": "x"}})
    assert (await zoho_service.get_package(db_session, "p1"))["status"] == "x"
    assert (seen[0][0], seen[0][1].endswith("/packages/p1")) == ("GET", True)


@pytest.mark.asyncio
@pytest.mark.parametrize("key", ["shipmentorder", "shipment_order"])
async def test_create_shipment(db_session, key):
    seen: list = []
    await _fake(db_session, seen, body={key: {"shipment_id": "s1"}})
    out = await zoho_service.create_shipment(db_session, "so1", "p1", date="2026-01-04", delivery_method="Post")
    assert out == {"shipment_id": "s1"}
    method, path, params, content = seen[0]
    assert (method, path.endswith("/shipmentorders")) == ("POST", True)
    assert (params["salesorder_id"], params["package_ids"]) == ("so1", "p1")
    assert _json(content) == {"date": "2026-01-04", "delivery_method": "Post"}


@pytest.mark.asyncio
async def test_create_shipment_without_a_body_key_is_empty(db_session):
    await _fake(db_session, [], body={})
    assert await zoho_service.create_shipment(db_session, "so1", "p1", date="d", delivery_method="m") == {}


@pytest.mark.asyncio
async def test_mark_shipment_delivered_and_invoice_sent(db_session):
    seen: list = []
    await _fake(db_session, seen)
    assert await zoho_service.mark_shipment_delivered(db_session, "s1") is None
    assert await zoho_service.mark_invoice_sent(db_session, "i1") is None
    assert [m for m, *_ in seen] == ["POST", "POST"]
    assert seen[0][1].endswith("/shipmentorders/s1/status/delivered")
    assert seen[1][1].endswith("/invoices/i1/status/sent")


@pytest.mark.asyncio
async def test_invoice_prefill(db_session):
    seen: list = []
    await _fake(db_session, seen, body={"invoice": {"line_items": []}})
    assert await zoho_service.invoice_prefill(db_session, "so1") == {"line_items": []}
    method, path, params, _ = seen[0]
    assert (method, path.endswith("/invoices/editpage/fromsalesorder")) == ("GET", True)
    assert params["salesorder_id"] == "so1"


@pytest.mark.asyncio
async def test_invoice_prefill_none_when_books_rejects_and_reraises_others(db_session):
    await _fake(db_session, [], status=400, body={"message": "nothing to invoice"})
    assert await zoho_service.invoice_prefill(db_session, "so1") is None
    await _fake(db_session, [], status=403, body={"message": "no"})
    with pytest.raises(ZohoUpstreamError) as err:
        await zoho_service.invoice_prefill(db_session, "so1")
    assert not isinstance(err.value, ZohoRequestRejected)


@pytest.mark.asyncio
async def test_picklist_calls(db_session):
    seen: list = []
    await _fake(db_session, seen, body={"picklist": {"picklist_id": "pl1", "status": "yet_to_start"}})
    assert (await zoho_service.picklist_prefill(db_session, "so1"))["picklist_id"] == "pl1"
    assert (await zoho_service.get_picklist(db_session, "pl1"))["status"] == "yet_to_start"
    body = {"date": "2026-01-04", "location_id": "loc1", "line_items": [{"so_line_item_id": "l1"}]}
    assert (await zoho_service.create_picklist(db_session, body))["picklist_id"] == "pl1"
    assert (await zoho_service.update_picklist(db_session, "pl1", body))["picklist_id"] == "pl1"
    await zoho_service.complete_picklist(db_session, "pl1")
    assert [(m, p.rsplit("/v3", 1)[1]) for m, p, _, _ in seen] == [
        ("GET", "/picklists/editpage"),
        ("GET", "/picklists/pl1"),
        ("POST", "/picklists"),
        ("PUT", "/picklists/pl1"),
        ("POST", "/picklists/pl1/setstatus"),
    ]
    assert seen[0][2]["salesorder_ids"] == "so1"
    assert _json(seen[2][3]) == _json(seen[3][3]) == body
    assert seen[4][2]["status"] == "completed"


@pytest.mark.asyncio
async def test_a_refused_picklist_prefill_is_none(db_session):
    await _fake(db_session, [], status=400, body={"code": 1, "message": "no"})
    assert await zoho_service.picklist_prefill(db_session, "so1") is None


@pytest.mark.asyncio
async def test_void_salesorder(db_session):
    seen: list = []
    await _fake(db_session, seen)
    await zoho_service.void_salesorder(db_session, "so1")
    assert (seen[0][0], seen[0][1].endswith("/salesorders/so1/status/void")) == ("POST", True)
