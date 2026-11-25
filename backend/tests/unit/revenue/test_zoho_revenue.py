"""The revenue dashboard's three read-only Zoho calls, against a mock transport."""

import json

import httpx
import pytest

from backend.app.services.zoho import ZohoNotFound, zoho_service


@pytest.fixture(autouse=True)
def reset_service():
    zoho_service.invalidate_token()
    zoho_service.transport = None
    yield
    zoho_service.invalidate_token()
    zoho_service.transport = None


async def _configure(async_client):
    await async_client.put(
        "/api/v1/settings/",
        json={
            "zoho_client_id": "1000.FAKE",
            "zoho_client_secret": "fake-secret",
            "zoho_refresh_token": "1000.fake.refresh",
            "zoho_organization_id": "999",
        },
    )


def _books(handler):
    def wrapped(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return handler(request)

    return httpx.MockTransport(wrapped)


@pytest.mark.asyncio
async def test_sales_by_item_by_customer_sends_day_page_and_group_by(async_client, db_session):
    await _configure(async_client)
    seen: list[httpx.Request] = []
    groups = [{"group_name": "c1", "sales": [{"item_id": "i1", "amount": 10}]}]

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"sales_by_item": groups, "page_context": {"has_more_page": True}})

    zoho_service.transport = _books(handler)

    got, has_more = await zoho_service.sales_by_item_by_customer(db_session, "2026-10-15", 2)

    assert got == groups
    assert has_more is True
    assert seen[0].url.path == "/books/v3/reports/salesbyitem"
    q = seen[0].url.params
    assert q["from_date"] == q["to_date"] == "2026-10-15"
    assert q["page"] == "2"
    assert q["per_page"] == "200"
    assert json.loads(q["group_by"]) == [{"field": "customer_name", "group": "report"}]


@pytest.mark.asyncio
async def test_sales_by_item_by_customer_without_page_context_has_no_more(async_client, db_session):
    await _configure(async_client)
    zoho_service.transport = _books(lambda _r: httpx.Response(200, json={}))
    assert await zoho_service.sales_by_item_by_customer(db_session, "2026-10-15", 1) == ([], False)


@pytest.mark.asyncio
async def test_sales_by_item_range_sends_the_range_and_page_without_group_by(async_client, db_session):
    await _configure(async_client)
    seen: list[httpx.Request] = []
    rows = [{"item_id": "i1", "amount": 10}]

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"sales_by_item": rows, "page_context": {"has_more_page": False}})

    zoho_service.transport = _books(handler)

    assert await zoho_service.sales_by_item_range(db_session, "2026-09-01", "2026-09-30", 3) == (rows, False)
    assert seen[0].url.path == "/books/v3/reports/salesbyitem"
    q = seen[0].url.params
    assert (q["from_date"], q["to_date"], q["page"], q["per_page"]) == ("2026-09-01", "2026-09-30", "3", "200")
    assert "group_by" not in q


@pytest.mark.asyncio
async def test_list_items_page_all_sends_no_filter(async_client, db_session):
    await _configure(async_client)
    seen: list[httpx.Request] = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"items": [{"item_id": "i1"}], "page_context": {"has_more_page": False}})

    zoho_service.transport = _books(handler)

    items, has_more = await zoho_service.list_items_page_all(db_session, 3)

    assert items == [{"item_id": "i1"}]
    assert has_more is False
    assert seen[0].url.path == "/books/v3/items"
    assert dict(seen[0].url.params) == {"organization_id": "999", "page": "3", "per_page": "200"}


@pytest.mark.asyncio
async def test_get_contact_404_raises_not_found(async_client, db_session):
    await _configure(async_client)
    zoho_service.transport = _books(lambda _r: httpx.Response(404, json={"code": 1002, "message": "nope"}))
    with pytest.raises(ZohoNotFound):
        await zoho_service.get_contact(db_session, "zX")


@pytest.mark.asyncio
async def test_list_customer_payments_page_sends_books_since_oldest_first(async_client, db_session):
    await _configure(async_client)
    seen: list[httpx.Request] = []
    rows = [{"payment_id": "p1", "amount": 10, "last_modified_time": "2026-10-01T08:00:00-1000"}]

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"customerpayments": rows, "page_context": {"has_more_page": False}})

    zoho_service.transport = _books(handler)
    got, more = await zoho_service.list_customer_payments_page(db_session, "2025-10-01T10:00:00+0000", 3)
    assert (got, more) == (rows, False)
    assert seen[0].url.path == "/books/v3/customerpayments"
    q = seen[0].url.params
    assert q["last_modified_time"] == "2025-10-01T10:00:00+0000"
    assert (q["sort_column"], q["sort_order"], q["per_page"], q["page"]) == ("last_modified_time", "A", "200", "3")


@pytest.mark.asyncio
async def test_get_customer_payment_and_unpaid_invoice_listing(async_client, db_session):
    await _configure(async_client)
    seen: list[httpx.Request] = []

    def handler(request):
        seen.append(request)
        if request.url.path.endswith("/customerpayments/p1"):
            return httpx.Response(200, json={"payment": {"invoices": [{"invoice_id": "i1", "amount_applied": 5}]}})
        return httpx.Response(200, json={"invoices": [{"invoice_id": "i1"}], "page_context": {"has_more_page": True}})

    zoho_service.transport = _books(handler)
    assert (await zoho_service.get_customer_payment(db_session, "p1"))["invoices"][0]["amount_applied"] == 5
    got, more = await zoho_service.list_unpaid_invoices_page(db_session, "overdue", 2)
    assert (got, more) == ([{"invoice_id": "i1"}], True)
    q = seen[1].url.params
    assert seen[1].url.path == "/books/v3/invoices"
    assert (q["status"], q["page"], q["per_page"]) == ("overdue", "2", "200")


@pytest.mark.asyncio
async def test_list_fixed_assets_reads_the_whole_listing(async_client, db_session):
    await _configure(async_client)
    seen: list[httpx.Request] = []
    rows = [{"fixed_asset_id": "a1", "asset_name": "H2S01", "asset_cost": 360000}]

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"fixedassets": rows, "page_context": {"has_more_page": False}})

    zoho_service.transport = _books(handler)
    assert await zoho_service.list_fixed_assets(db_session) == rows
    assert seen[0].url.path == "/books/v3/fixedassets"
    assert seen[0].url.params["per_page"] == "200"
