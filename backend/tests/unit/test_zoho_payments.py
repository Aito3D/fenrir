import pytest

from backend.app.services.zoho import zoho_service


@pytest.fixture
def books(monkeypatch):
    state = {"calls": []}

    async def request(db, method, path, *, params=None, json=None):
        state["calls"].append((method, path, json))
        if path == "/retainerinvoices" and method == "POST":
            return {"retainerinvoice": {"retainerinvoice_id": "ret-1", "retainerinvoice_number": "RET26-0001"}}
        if path == "/customerpayments" and method == "POST":
            return {"payment": {"payment_id": "pay-1", "payment_number": "42"}}
        return {}

    monkeypatch.setattr(zoho_service, "_request", request)
    return state


@pytest.mark.asyncio
async def test_create_retainer_invoice_sends_one_line_and_returns_ids(db_session, books):
    out = await zoho_service.create_retainer_invoice(
        db_session,
        customer_id="c1",
        reference_number="DEV26-0001",
        description="Acompte DEV26-0001",
        amount=25000,
        today="2026-09-23",
    )
    assert out["retainerinvoice_id"] == "ret-1" and out["retainerinvoice_number"] == "RET26-0001"
    method, path, body = books["calls"][0]
    assert (method, path) == ("POST", "/retainerinvoices")
    assert body == {
        "customer_id": "c1",
        "reference_number": "DEV26-0001",
        "date": "2026-09-23",
        "line_items": [{"description": "Acompte DEV26-0001", "rate": 25000, "quantity": 1}],
    }


@pytest.mark.asyncio
async def test_record_customer_payment_applies_to_an_invoice(db_session, books):
    out = await zoho_service.record_customer_payment(
        db_session,
        customer_id="c1",
        payment_mode="check",
        amount=23000,
        reference_number="0004521",
        description="FA-26-0001 · Chèque",
        today="2026-09-23",
        invoice_id="inv-1",
    )
    assert out["payment_id"] == "pay-1"
    body = books["calls"][0][2]
    assert body == {
        "customer_id": "c1",
        "payment_mode": "check",
        "amount": 23000,
        "date": "2026-09-23",
        "reference_number": "0004521",
        "description": "FA-26-0001 · Chèque",
        "invoices": [{"invoice_id": "inv-1", "amount_applied": 23000}],
    }


@pytest.mark.asyncio
async def test_record_customer_payment_on_a_retainer_sends_retainerinvoice_id(db_session, books):
    await zoho_service.record_customer_payment(
        db_session,
        customer_id="c1",
        payment_mode="cash",
        amount=100,
        reference_number="",
        description="DEV26-0001",
        today="2026-09-23",
        retainerinvoice_id="ret-1",
    )
    body = books["calls"][0][2]
    assert body["retainerinvoice_id"] == "ret-1" and "invoices" not in body and "reference_number" not in body


@pytest.mark.asyncio
async def test_record_customer_payment_needs_exactly_one_target(db_session, books):
    with pytest.raises(ValueError):
        await zoho_service.record_customer_payment(
            db_session,
            customer_id="c1",
            payment_mode="cash",
            amount=1,
            reference_number="",
            description="",
            today="2026-09-23",
        )
