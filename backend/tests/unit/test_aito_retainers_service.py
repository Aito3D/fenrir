"""list_project_retainers — which of a customer's retainer invoices belong to this project."""

from types import SimpleNamespace

import pytest

from backend.app.services.aito_retainers import list_project_retainers, map_retainer
from backend.app.services.zoho import zoho_service

ESTIMATE = {
    "estimate_id": "EST-9",
    "estimate_number": "DEV26-2638",
    "customer_id": "z1",
    "currency_code": "XPF",
    "retainerinvoices": [
        {"retainerinvoice_id": "RET-A", "retainerinvoice_number": "AC-26-0001", "status": "paid", "total": 5000},
    ],
}

ROWS = [
    # Attached to the estimate (raised from it in Books).
    {
        "retainerinvoice_id": "RET-A",
        "retainerinvoice_number": "AC-26-0001",
        "status": "paid",
        "total": 5000,
        "balance": 0,
        "date": "2026-09-01",
        "currency_code": "XPF",
        "reference_number": "",
    },
    # A counter deposit: references the quote number, not attached.
    {
        "retainerinvoice_id": "RET-B",
        "retainerinvoice_number": "AC-26-0031",
        "status": "paid",
        "total": 17500,
        "balance": 0,
        "date": "2026-09-03",
        "currency_code": "XPF",
        "reference_number": "dev26-2638 ",
    },
    # Another job of the same customer.
    {
        "retainerinvoice_id": "RET-C",
        "retainerinvoice_number": "AC-26-0040",
        "status": "sent",
        "total": 900,
        "balance": 900,
        "date": "2026-09-05",
        "currency_code": "XPF",
        "reference_number": "DEV26-9999",
    },
]


def _project(**over):
    base = {"quote_id": "EST-9", "quote_number": "DEV26-2638", "client_id": "z1"}
    base.update(over)
    return SimpleNamespace(**base)


@pytest.fixture
def books(monkeypatch):
    calls = {"estimate": 0, "retainers": []}

    async def estimate(db, estimate_id):
        calls["estimate"] += 1
        return dict(ESTIMATE)

    async def retainers(db, customer_id):
        calls["retainers"].append(customer_id)
        return [dict(r) for r in ROWS]

    monkeypatch.setattr(zoho_service, "get_estimate", estimate)
    monkeypatch.setattr(zoho_service, "list_customer_retainers", retainers)
    return calls


@pytest.mark.asyncio
async def test_lists_attached_and_referenced_retainers_only(books):
    rows = await list_project_retainers(None, _project())

    assert [r["id"] for r in rows] == ["RET-A", "RET-B"]
    assert rows[1] == {
        "id": "RET-B",
        "number": "AC-26-0031",
        "date": "2026-09-03",
        "total": 17500.0,
        "balance": 0.0,
        "currency_code": "XPF",
        "status": "paid",
    }
    # The ESTIMATE's customer is queried, not whatever the card row says.
    assert books["retainers"] == ["z1"]


@pytest.mark.asyncio
async def test_no_quote_means_no_books_call(books):
    assert await list_project_retainers(None, _project(quote_id=None)) == []
    assert books["estimate"] == 0
    assert books["retainers"] == []


@pytest.mark.asyncio
async def test_an_attached_retainer_missing_from_the_customer_list_is_kept_from_the_estimate(monkeypatch):
    async def estimate(db, estimate_id):
        return dict(ESTIMATE)

    async def retainers(db, customer_id):
        return []

    monkeypatch.setattr(zoho_service, "get_estimate", estimate)
    monkeypatch.setattr(zoho_service, "list_customer_retainers", retainers)

    rows = await list_project_retainers(None, _project())

    assert rows == [
        {
            "id": "RET-A",
            "number": "AC-26-0001",
            "date": "",
            "total": 5000.0,
            "balance": 0.0,
            "currency_code": "XPF",
            "status": "paid",
        },
    ]


@pytest.mark.asyncio
async def test_the_estimates_customer_wins_over_the_cards_client_id(books):
    await list_project_retainers(None, _project(client_id="drifted"))
    assert books["retainers"] == ["z1"]


def test_map_retainer_tolerates_sloppy_numbers_and_missing_currency():
    row = {"retainerinvoice_id": "RET-X", "status": "draft", "total": "abc", "balance": None}
    assert map_retainer(row, "XPF") == {
        "id": "RET-X",
        "number": "RET-X",
        "date": "",
        "total": 0.0,
        "balance": 0.0,
        "currency_code": "XPF",
        "status": "draft",
    }
