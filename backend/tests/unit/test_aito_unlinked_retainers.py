"""Deposits raised by hand in Books name no quote, so they never count toward
any quote's deposit (live DEV26-2896 / RET26-00361, 2026-11-10). The panel
lists them and lets the operator link one to the card's quote."""

import pytest

from backend.app.services.aito_customer_credit import unlinked_retainers
from backend.app.services.zoho import zoho_service

PAYMENTS = [
    {"payment_id": "p1", "unused_amount": 10000, "retainerinvoice_id": "r-hand"},
    {"payment_id": "p2", "unused_amount": 5500, "retainerinvoice_id": "r-ref"},
    {"payment_id": "p3", "unused_amount": 3000, "retainerinvoice_id": "r-est"},
    {"payment_id": "p4", "unused_amount": 0, "retainerinvoice_id": "r-spent"},
    {"payment_id": "p5", "unused_amount": 700, "retainerinvoice_id": ""},
]
RETAINERS = [
    {"retainerinvoice_id": "r-hand", "retainerinvoice_number": "RET-1", "reference_number": "", "estimate_number": ""},
    {
        "retainerinvoice_id": "r-ref",
        "retainerinvoice_number": "RET-2",
        "reference_number": "DEV-1",
        "estimate_number": "",
    },
    {
        "retainerinvoice_id": "r-est",
        "retainerinvoice_number": "RET-3",
        "reference_number": "",
        "estimate_number": "DEV-2",
    },
    {"retainerinvoice_id": "r-spent", "retainerinvoice_number": "RET-4", "reference_number": "", "estimate_number": ""},
]


@pytest.fixture
def books(monkeypatch):
    writes: list[tuple[str, str]] = []

    async def payments(db, customer_id):
        return list(PAYMENTS)

    async def retainers(db, customer_id):
        return list(RETAINERS)

    async def set_reference(db, retainer_id, reference):
        writes.append((retainer_id, reference))
        return {}

    monkeypatch.setattr(zoho_service, "list_customer_payments", payments)
    monkeypatch.setattr(zoho_service, "list_customer_retainers", retainers)
    monkeypatch.setattr(zoho_service, "set_retainer_reference", set_reference)
    return writes


@pytest.mark.asyncio
async def test_only_unspent_retainers_naming_no_quote_are_unlinked(books):
    rows = await unlinked_retainers(None, "c1")
    assert [(r["id"], r["number"], r["unused"]) for r in rows] == [("r-hand", "RET-1", 10000.0)]
    assert await unlinked_retainers(None, "") == []


async def _card(async_client, quote_number="DEV26-9"):
    r = await async_client.post(
        "/api/v1/aito/",
        json={
            "description": "x",
            "client_id": "c1",
            "client_name": "ACME",
            "quote_id": "E9",
            "quote_number": quote_number,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


@pytest.mark.asyncio
async def test_link_writes_the_quote_number_and_refuses_any_other_retainer(async_client, books, monkeypatch):
    refreshed: list[int] = []

    async def fake_refresh(db, project_id, kind):
        refreshed.append(project_id)

    async def fake_reconcile(db, **kw):
        return 0

    monkeypatch.setattr("backend.app.api.routes.aito_payments.refresh_after_payment", fake_refresh)
    monkeypatch.setattr("backend.app.api.routes.aito_payments.reconcile_payment_links", fake_reconcile)
    pid = await _card(async_client)

    r = await async_client.get(f"/api/v1/aito/{pid}/unlinked-retainers")
    assert r.status_code == 200 and [row["number"] for row in r.json()] == ["RET-1"]

    r = await async_client.post(f"/api/v1/aito/{pid}/unlinked-retainers/r-ref/link")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_unlinked"
    assert books == []

    r = await async_client.post(f"/api/v1/aito/{pid}/unlinked-retainers/r-hand/link")
    assert r.status_code == 200, r.text
    assert books == [("r-hand", "DEV26-9")] and refreshed == [pid]
