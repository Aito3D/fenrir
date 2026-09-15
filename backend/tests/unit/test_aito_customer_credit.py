"""A customer's unspent deposits, read off their payments in one Books call.

A retainer invoice in Books is a CUSTOMER document that may or may not
reference a quote (verified on the live org 2026-09-15: the same customer had
one raised from a quote and one raised by hand). Its payment is booked as an
advance on the customer's account with an ``unused_amount`` that drops the
moment it is applied to any invoice. So "deposit available" is the sum of
the customer's unused payment amounts — not the total of the retainers
hanging off this one estimate, which keeps reading as paid after the money
has been spent elsewhere.
"""

import pytest

from backend.app.services.aito_customer_credit import read_customer_credit, unused_credit_total
from backend.app.services.zoho import ZohoRateLimited, ZohoUpstreamError, zoho_service

PAYMENTS = [
    {"payment_id": "p1", "amount": 10000, "unused_amount": 10000, "retainerinvoice_id": "r1"},
    {"payment_id": "p2", "amount": 80000, "unused_amount": 0, "retainerinvoice_id": "r2"},
    {"payment_id": "p3", "amount": 5700, "unused_amount": 700, "retainerinvoice_id": ""},
]


def test_unused_credit_total_sums_what_is_still_unspent_across_every_payment():
    """The spent 80 000 counts for nothing; the hand-raised 700 counts."""
    assert unused_credit_total(PAYMENTS) == 10700.0


def test_unused_credit_total_survives_books_own_sloppiness():
    assert unused_credit_total([{"unused_amount": None}, {"unused_amount": "abc"}, {}]) == 0.0
    assert unused_credit_total([]) == 0.0


@pytest.mark.asyncio
async def test_read_customer_credit_reads_the_customer_once_per_cache(monkeypatch):
    """The sweep hands one dict to every project it reconciles in a tick, so
    three projects of one customer cost one call, not three."""
    calls: list[str] = []

    async def fake_list(db, customer_id):
        calls.append(customer_id)
        return list(PAYMENTS)

    monkeypatch.setattr(zoho_service, "list_customer_payments", fake_list)
    cache: dict = {}

    first = await read_customer_credit(None, "C1", cache)
    second = await read_customer_credit(None, "C1", cache)
    other = await read_customer_credit(None, "C2", cache)

    assert (first, second, other) == (10700.0, 10700.0, 10700.0)
    assert calls == ["C1", "C2"]


@pytest.mark.asyncio
async def test_read_customer_credit_without_a_cache_reads_every_time(monkeypatch):
    calls: list[str] = []

    async def fake_list(db, customer_id):
        calls.append(customer_id)
        return []

    monkeypatch.setattr(zoho_service, "list_customer_payments", fake_list)

    await read_customer_credit(None, "C1")
    await read_customer_credit(None, "C1")

    assert calls == ["C1", "C1"]


@pytest.mark.asyncio
async def test_read_customer_credit_is_best_effort(monkeypatch):
    """A failed side read must not flip the card to a sync error: the
    reconcile that paid for the estimate already succeeded. None means
    "leave the stored figure alone", and the failure is not cached."""
    calls: list[str] = []

    async def fake_list(db, customer_id):
        calls.append(customer_id)
        raise ZohoUpstreamError("Zoho is down")

    monkeypatch.setattr(zoho_service, "list_customer_payments", fake_list)
    cache: dict = {}

    assert await read_customer_credit(None, "C1", cache) is None
    assert await read_customer_credit(None, "C1", cache) is None
    assert calls == ["C1", "C1"]


@pytest.mark.asyncio
async def test_read_customer_credit_lets_a_throttle_through(monkeypatch):
    """A 429 is the sweep's business — it arms the whole reconciler's
    stand-down — and swallowing it here would hide it."""

    async def fake_list(db, customer_id):
        raise ZohoRateLimited("slow down", retry_after=30.0)

    monkeypatch.setattr(zoho_service, "list_customer_payments", fake_list)

    with pytest.raises(ZohoRateLimited):
        await read_customer_credit(None, "C1", {})


@pytest.mark.asyncio
async def test_read_customer_credit_never_asks_books_about_nobody(monkeypatch):
    """An empty customer id would be `customer_id=` — which Books reads as
    "no filter" and answers with every payment in the org."""

    async def fake_list(db, customer_id):
        raise AssertionError("must not be called")

    monkeypatch.setattr(zoho_service, "list_customer_payments", fake_list)

    assert await read_customer_credit(None, "", {}) is None
    assert await read_customer_credit(None, None, {}) is None


@pytest.mark.asyncio
async def test_list_customer_payments_filters_by_customer(monkeypatch):
    calls: list = []

    async def request(db, method, path, *, params=None, json=None):
        calls.append((method, path, params))
        return {"customerpayments": list(PAYMENTS)}

    monkeypatch.setattr(zoho_service, "_request", request)

    assert await zoho_service.list_customer_payments(None, "C1") == PAYMENTS
    assert calls == [("GET", "/customerpayments", {"customer_id": "C1"})]


@pytest.mark.asyncio
async def test_list_customer_payments_refuses_an_empty_customer(monkeypatch):
    """Same rule as list_project_invoices: an empty filter is no filter."""

    async def request(db, method, path, *, params=None, json=None):
        raise AssertionError("must not be called")

    monkeypatch.setattr(zoho_service, "_request", request)

    assert await zoho_service.list_customer_payments(None, "") == []
