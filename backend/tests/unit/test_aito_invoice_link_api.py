import httpx
import pytest

from backend.app.api.routes.settings import set_setting
from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.services.aito_payment_documents import DocumentMismatch, PaymentDocument
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
        if (kind, document_id) == ("invoice", "inv-1"):
            return INVOICE
        raise DocumentMismatch("nope")

    monkeypatch.setattr("backend.app.api.routes.aito_payments.resolve_document", resolve)
    heimdall_service._transport = None
    yield
    heimdall_service._transport = None


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


def _link(**over):
    base = {
        "id": "h-inv",
        "status": "pending",
        "amount": 23000,
        "currency": "XPF",
        "reference": "FA-26-0001",
        "link": {"url": "https://pay/x", "expires_at": "2026-10-08T23:59:59.999Z"},
    }
    base.update(over)
    return base


@pytest.mark.asyncio
async def test_create_then_cancel(async_client, db_session):
    p = await _create(async_client)
    heimdall_service._transport = httpx.MockTransport(lambda r: httpx.Response(201, json=_link()))
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link", json={"document_id": "inv-1", "amount": 23000})
    assert r.status_code == 200, r.text
    link = r.json()["invoice_payment_link"]
    assert link["state"] == "pending" and link["url"] == "https://pay/x" and r.json()["payment_link"] is None
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link", json={"document_id": "inv-1", "amount": 1})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "link_exists"
    # The route checks the live-link refusal before the balance cap (spec
    # §6.2: link_exists is the refusal the operator cannot clear by editing
    # the amount), so an over-balance amount still answers link_exists here,
    # not amount_above_balance -- the balance cap is only reached once no
    # live link is in the way (see test_amount_above_balance_and_quote_cancel).
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link", json={"document_id": "inv-1", "amount": 23001})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "link_exists"
    row = (await db_session.execute(AitoPaymentLink.__table__.select())).first()
    heimdall_service._transport = httpx.MockTransport(lambda r: httpx.Response(200, json=_link(status="cancelled")))
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link/{row.id}/cancel")
    assert r.status_code == 200 and r.json()["invoice_payment_link"]["state"] == "cancelled"


@pytest.mark.asyncio
async def test_amount_above_balance_and_quote_cancel(async_client, db_session):
    p = await _create(async_client)
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link", json={"document_id": "inv-1", "amount": 23001})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "amount_above_balance"
    db_session.add(
        AitoPaymentLink(
            project_id=p["id"],
            idempotency_key="k",
            reference="DEV-1",
            amount=1,
            expires_on="2026-12-31",
            heimdall_id="h",
            status="pending",
            document_kind="quote",
            document_number="DEV-1",
        )
    )
    await db_session.commit()
    row = (await db_session.execute(AitoPaymentLink.__table__.select())).first()
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link/{row.id}/cancel")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "quote_link_managed"
    assert (await async_client.post(f"/api/v1/aito/{p['id']}/payment-link/999/cancel")).status_code == 404


@pytest.mark.asyncio
async def test_a_heimdall_422_on_the_link_route_reads_invalid_not_amount_above_balance(async_client):
    """Minor 5: the balance cap is checked by the route itself, so a 422 from
    Heimdall here is some OTHER invalid field — labelling it
    `amount_above_balance` sent the operator to edit an amount that was
    already fine. The terminal route keeps that code; this one is neutral and
    shows Heimdall's own message."""
    p = await _create(async_client)
    heimdall_service._transport = httpx.MockTransport(
        lambda r: httpx.Response(
            422, json={"error": {"code": "invalid_request", "message": "expires_in_days must be 1..90"}}
        )
    )
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link", json={"document_id": "inv-1", "amount": 23000})
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["code"] == "invalid"
    assert "expires_in_days" in r.json()["detail"]["message"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "over",
    [
        {"status": "paid", "heimdall_id": "h-paid"},
        {"status": "cancelled", "heimdall_id": "h-cancelled"},
        {"status": "pending", "heimdall_id": None},  # a reservation: nothing to cancel at Heimdall
    ],
)
async def test_cancel_refuses_a_link_that_is_not_open(async_client, db_session, over):
    """Minor 6: the route had no state guard — a dead link went out as
    Heimdall's opaque `conflict`, and a reservation as `POST
    /payments/None/cancel`. Both are refused here, without a Heimdall call."""
    p = await _create(async_client)
    calls = []

    def handler(request):
        calls.append(request.url.path)
        return httpx.Response(200, json=_link(status="cancelled"))

    heimdall_service._transport = httpx.MockTransport(handler)
    row = AitoPaymentLink(
        project_id=p["id"],
        idempotency_key="k-guard",
        reference="FA-26-0001",
        amount=1,
        expires_on="2026-12-31",
        document_kind="invoice",
        document_number="FA-26-0001",
        **over,
    )
    db_session.add(row)
    await db_session.commit()
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link/{row.id}/cancel")
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "not_cancellable"
    assert calls == []
