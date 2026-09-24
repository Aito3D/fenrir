import httpx
import pytest

from backend.app.api.routes.settings import set_setting
from backend.app.services.aito_payment_documents import PaymentDocument
from backend.app.services.heimdall import heimdall_service

INVOICE = PaymentDocument(kind="invoice", id="inv-1", number="FA-26-0001", customer_id="c1", balance=23000)


@pytest.fixture(autouse=True)
async def _setup(db_session, monkeypatch):
    from backend.app.api.routes import aito as aito_routes

    aito_routes._ai_rate_limit_calls.clear()
    await set_setting(db_session, "heimdall_base_url", "http://pos.local:8081")
    await set_setting(db_session, "heimdall_api_token", "hmd_live.84f32b71ac095ed2.s3cret")
    await db_session.commit()

    async def resolve(db, project, kind, document_id):
        from backend.app.services.aito_payment_documents import DocumentMismatch

        if kind == "invoice" and document_id == "inv-1":
            return INVOICE
        raise DocumentMismatch("nope")

    monkeypatch.setattr("backend.app.api.routes.aito_payments.resolve_document", resolve)
    heimdall_service._transport = None
    yield
    heimdall_service._transport = None
    aito_routes._ai_rate_limit_calls.clear()


async def _create(client, **overrides):
    payload = {
        "description": "Support GoPro",
        "client_id": "c1",
        "client_name": "ACME",
        "client_phone": "+689 87 00 00 01",
    }
    payload.update(overrides)
    r = await client.post("/api/v1/aito/", json=payload)
    assert r.status_code == 201, r.text
    return r.json()


def _payment(**over):
    base = {
        "id": "h-1",
        "method": "terminal",
        "status": "processing",
        "native_state": "sending_to_tpe",
        "amount": 23000,
        "amount_confirmed": None,
        "currency": "XPF",
        "reference": None,
        "link": None,
        "booking": {"status": "pending", "zoho_payment_id": None, "error": None},
    }
    base.update(over)
    return base


@pytest.mark.asyncio
async def test_start_then_poll(async_client, db_session, monkeypatch):
    p = await _create(async_client)
    heimdall_service._transport = httpx.MockTransport(lambda r: httpx.Response(202, json=_payment()))
    r = await async_client.post(
        f"/api/v1/aito/{p['id']}/terminal-payment",
        json={"document_kind": "invoice", "document_id": "inv-1", "amount": 23000},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "processing" and body["document_number"] == "FA-26-0001" and body["amount"] == 23000
    heimdall_service._transport = httpx.MockTransport(
        lambda r: httpx.Response(200, json=_payment(status="paid", native_state="confirmed", amount_confirmed=23000))
    )
    from backend.app.services import aito_terminal_payments as svc

    monkeypatch.setattr(svc, "REFRESH_MIN_SECONDS", 0.0)
    r = await async_client.get(f"/api/v1/aito/{p['id']}/terminal-payment/{body['id']}")
    assert r.status_code == 200 and r.json()["status"] == "paid" and r.json()["amount_confirmed"] == 23000
    board = (await async_client.get("/api/v1/aito/")).json()
    assert next(x for x in board if x["id"] == p["id"])["terminal_payment"]["status"] == "paid"


@pytest.mark.asyncio
async def test_error_mapping(async_client):
    p = await _create(async_client)
    url = f"/api/v1/aito/{p['id']}/terminal-payment"
    body = {"document_kind": "invoice", "document_id": "inv-1", "amount": 23000}
    cases = [
        (403, {"error": {"code": "forbidden", "message": "scope"}}, 502, None),
        (409, {"error": {"code": "terminal_busy", "message": "busy"}}, 409, "terminal_busy"),
        (
            422,
            {"error": {"code": "invalid_request", "message": "amount above balance 23000"}},
            422,
            "amount_above_balance",
        ),
        (404, {"error": {"code": "not_found", "message": "no doc"}}, 422, "document_unknown"),
        (503, {"error": {"code": "unavailable", "message": "zoho down"}}, 502, None),
        (429, {"error": {"code": "rate_limited", "message": "slow"}}, 429, None),
    ]
    for upstream, payload, expected, code in cases:
        heimdall_service._transport = httpx.MockTransport(lambda r, u=upstream, pl=payload: httpx.Response(u, json=pl))
        r = await async_client.post(url, json=body)
        assert r.status_code == expected, (upstream, r.text)
        if code:
            assert r.json()["detail"]["code"] == code
    r = await async_client.post(url, json={"document_kind": "invoice", "document_id": "inv-9", "amount": 1})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "document_mismatch"


@pytest.mark.asyncio
async def test_in_progress_guard_and_unknown_project(async_client):
    p = await _create(async_client)
    heimdall_service._transport = httpx.MockTransport(lambda r: httpx.Response(202, json=_payment()))
    url = f"/api/v1/aito/{p['id']}/terminal-payment"
    body = {"document_kind": "invoice", "document_id": "inv-1", "amount": 23000}
    assert (await async_client.post(url, json=body)).status_code == 201
    r = await async_client.post(url, json=body)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "terminal_in_progress"
    assert (await async_client.post("/api/v1/aito/999999/terminal-payment", json=body)).status_code == 404
    assert (await async_client.get(f"/api/v1/aito/{p['id']}/terminal-payment/999999")).status_code == 404


@pytest.mark.asyncio
async def test_rate_limit(async_client):
    p = await _create(async_client)
    heimdall_service._transport = httpx.MockTransport(
        lambda r: httpx.Response(409, json={"error": {"code": "terminal_busy", "message": "busy"}})
    )
    url = f"/api/v1/aito/{p['id']}/terminal-payment"
    body = {"document_kind": "invoice", "document_id": "inv-1", "amount": 1}
    for _ in range(10):
        assert (await async_client.post(url, json=body)).status_code == 409
    assert (await async_client.post(url, json=body)).status_code == 429


@pytest.mark.asyncio
async def test_get_rate_limited_by_heimdall(async_client, monkeypatch):
    """refresh_terminal_payment re-raises HeimdallRateLimited (only that
    exception) rather than storing it on the row; the GET route must catch
    it and answer 429, not 500."""
    p = await _create(async_client)
    heimdall_service._transport = httpx.MockTransport(lambda r: httpx.Response(202, json=_payment()))
    url = f"/api/v1/aito/{p['id']}/terminal-payment"
    body = {"document_kind": "invoice", "document_id": "inv-1", "amount": 23000}
    r = await async_client.post(url, json=body)
    assert r.status_code == 201, r.text
    payment_id = r.json()["id"]

    from backend.app.services import aito_terminal_payments as svc

    monkeypatch.setattr(svc, "REFRESH_MIN_SECONDS", 0.0)
    heimdall_service._transport = httpx.MockTransport(
        lambda r: httpx.Response(429, json={"error": {"code": "rate_limited", "message": "slow down"}})
    )
    r = await async_client.get(f"/api/v1/aito/{p['id']}/terminal-payment/{payment_id}")
    assert r.status_code == 429, r.text


def test_routes_are_gated():
    from backend.tests.unit.test_aito_pickup_sms import _declared_permissions

    assert _declared_permissions("start_terminal_payment") == ["aito:update"]
    assert _declared_permissions("get_terminal_payment") == ["aito:read"]
    assert _declared_permissions("record_manual_payment_route") == ["aito:update"]
    assert _declared_permissions("create_invoice_payment_link") == ["aito:update"]
    assert _declared_permissions("cancel_invoice_payment_link") == ["aito:update"]
