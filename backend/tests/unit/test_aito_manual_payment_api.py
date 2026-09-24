import pytest

from backend.app.services import aito_manual_payments as svc
from backend.app.services.aito_payment_documents import DocumentMismatch, PaymentDocument
from backend.app.services.zoho import ZohoUpstreamError

INVOICE = PaymentDocument(kind="invoice", id="inv-1", number="FA-26-0001", customer_id="c1", balance=23000)
QUOTE = PaymentDocument(kind="quote", id="est-1", number="DEV26-0001", customer_id="c1", balance=None)


@pytest.fixture(autouse=True)
def _setup(monkeypatch):
    from backend.app.api.routes import aito as aito_routes

    aito_routes._ai_rate_limit_calls.clear()
    svc._recent.clear()

    async def resolve(db, project, kind, document_id):
        if (kind, document_id) == ("invoice", "inv-1"):
            return INVOICE
        if (kind, document_id) == ("quote", "est-1"):
            return QUOTE
        raise DocumentMismatch("nope")

    monkeypatch.setattr("backend.app.api.routes.aito_payments.resolve_document", resolve)
    yield
    svc._recent.clear()
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


@pytest.mark.asyncio
async def test_records_and_returns_the_fresh_project(async_client, monkeypatch):
    calls = {}

    async def fake_record(db, project, **kw):
        calls.update(kw)
        return svc.ManualPaymentResult(zoho_payment_id="pay-1", retainer_number=None, mode_name="check")

    monkeypatch.setattr("backend.app.api.routes.aito_payments.record_manual_payment", fake_record)
    p = await _create(async_client)
    r = await async_client.post(
        f"/api/v1/aito/{p['id']}/manual-payment",
        json={
            "document_kind": "invoice",
            "document_id": "inv-1",
            "mode": "cheque",
            "amount": 23000,
            "reference": "0004521",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["id"] == p["id"] and calls["mode"] == "cheque" and calls["reference"] == "0004521"


@pytest.mark.asyncio
async def test_cheque_needs_a_reference(async_client):
    p = await _create(async_client)
    r = await async_client.post(
        f"/api/v1/aito/{p['id']}/manual-payment",
        json={"document_kind": "invoice", "document_id": "inv-1", "mode": "cheque", "amount": 1, "reference": "  "},
    )
    assert r.status_code == 422 and r.json()["detail"]["code"] == "reference_required"


@pytest.mark.asyncio
async def test_service_errors_map(async_client, monkeypatch):
    p = await _create(async_client)
    url = f"/api/v1/aito/{p['id']}/manual-payment"
    body = {"document_kind": "quote", "document_id": "est-1", "mode": "cash", "amount": 100, "reference": None}
    cases = [
        (svc.DuplicateManualPayment("dup"), 409, "duplicate"),
        (svc.AmountAboveBalance(23000), 422, "amount_above_balance"),
        (svc.ManualPaymentPartial("RET26-0001", ZohoUpstreamError("x")), 502, "manual_partial"),
        # Minor 11: Books has the money, Bambuddy's own record does not.
        (svc.ManualPaymentUnrecorded("pay-77", RuntimeError("database is locked")), 502, "manual_unrecorded"),
        (ZohoUpstreamError("zoho down"), 502, "upstream"),
    ]
    for exc, status, code in cases:

        async def boom(db, project, _exc=exc, **kw):
            raise _exc

        monkeypatch.setattr("backend.app.api.routes.aito_payments.record_manual_payment", boom)
        r = await async_client.post(url, json=body)
        assert r.status_code == status, (exc, r.text)
        assert r.json()["detail"]["code"] == code
        if code == "manual_partial":
            assert "RET26-0001" in r.json()["detail"]["message"]
        if code == "manual_unrecorded":
            message = r.json()["detail"]["message"]
            assert "pay-77" in message and "database is locked" in message
