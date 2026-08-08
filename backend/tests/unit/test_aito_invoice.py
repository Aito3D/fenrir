"""GET /aito/{id}/invoice and /invoice.pdf — the Invoice card's data.

The service-level tests here carry more weight than usual: Books treats an
empty ``estimate_id`` as "no filter" and answers with the org's entire
invoice list, so the guard against that is the difference between this card
and one that renders a stranger's invoice.
"""

import pytest

from backend.app.services.zoho import ZohoUpstreamError, zoho_service

INVOICE = {
    "invoice_id": "inv-1",
    "invoice_number": "FA-26-0001",
    "date": "2026-08-03",
    "due_date": "2026-08-17",
    "total": 18350,
    "balance": 0,
    "currency_code": "XPF",
    "status": "paid",
    "customer_id": "z1",
}


@pytest.fixture
def books_invoices(monkeypatch):
    """Books answers the invoice lookup, and records every query it was sent.

    Patched on the zoho_service INSTANCE (so the fakes need no ``self``),
    matching test_aito_quote_email.py — safe only because conftest's
    ``reset_zoho_singleton_shadows`` strips the shadow this leaves behind.
    """
    queries: list[dict] = []
    rows: list[dict] = [dict(INVOICE)]

    async def request(db, method, path, *, params=None, json=None):
        queries.append({"method": method, "path": path, "params": params or {}})
        if path == "/invoices":
            return {"invoices": list(rows)}
        return {}

    async def base(db):
        return "https://books.zoho.eu/app/org1"

    monkeypatch.setattr(zoho_service, "_request", request)
    monkeypatch.setattr(zoho_service, "_books_app_base", base)
    return {"queries": queries, "rows": rows}


async def _create(async_client, *, quoted=True, **overrides):
    """A board card. ``quoted=False`` omits the quote fields entirely rather
    than sending nulls — that is what a hand-made project looks like, and the
    create schema rejects an explicit null anyway."""
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        # Required: a hand-made card must carry a phone, an email or a social
        # handle. Imported cards are exempt, so this only bites quoted=False.
        "client_email": "contact@example.pf",
    }
    if quoted:
        payload |= {"quote_id": "EST-9", "quote_number": "QT-00412"}
    payload.update(overrides)
    return (await async_client.post("/api/v1/aito/", json=payload)).json()


# --- service guard -----------------------------------------------------------


@pytest.mark.asyncio
async def test_empty_estimate_id_never_reaches_zoho(async_client, books_invoices):
    """The whole point of the guard: Books would answer with every invoice
    the org has, and the first of them would be rendered as this project's."""
    result = await zoho_service.list_project_invoices(None, "", "z1")

    assert result == []
    assert books_invoices["queries"] == []


@pytest.mark.asyncio
async def test_invoices_are_filtered_to_the_projects_customer(async_client, books_invoices):
    books_invoices["rows"][:] = [
        {**INVOICE, "invoice_id": "inv-other", "customer_id": "someone-else"},
        {**INVOICE, "invoice_id": "inv-ours", "customer_id": "z1"},
    ]

    result = await zoho_service.list_project_invoices(None, "EST-9", "z1")

    assert [i["id"] for i in result] == ["inv-ours"]


@pytest.mark.asyncio
async def test_invoices_are_returned_newest_first(async_client, books_invoices):
    books_invoices["rows"][:] = [
        {**INVOICE, "invoice_id": "old", "date": "2026-01-01"},
        {**INVOICE, "invoice_id": "new", "date": "2026-08-03"},
        {**INVOICE, "invoice_id": "undated", "date": ""},
    ]

    result = await zoho_service.list_project_invoices(None, "EST-9", "z1")

    assert [i["id"] for i in result] == ["new", "old", "undated"]


@pytest.mark.asyncio
async def test_lookup_is_scoped_by_estimate_id(async_client, books_invoices):
    await zoho_service.list_project_invoices(None, "EST-9", "z1")

    assert books_invoices["queries"][0]["params"] == {"estimate_id": "EST-9"}


# --- GET /invoice ------------------------------------------------------------


@pytest.mark.asyncio
async def test_invoice_returns_the_newest_with_a_books_link(async_client, books_invoices):
    project = await _create(async_client)

    body = (await async_client.get(f"/api/v1/aito/{project['id']}/invoice")).json()

    assert body["number"] == "FA-26-0001"
    assert body["total"] == 18350
    assert body["balance"] == 0
    assert body["status"] == "paid"
    assert body["invoice_count"] == 1
    assert body["url"] == "https://books.zoho.eu/app/org1#/invoices/inv-1"


@pytest.mark.asyncio
async def test_invoice_counts_every_invoice_not_just_the_one_shown(async_client, books_invoices):
    books_invoices["rows"][:] = [
        {**INVOICE, "invoice_id": "a", "date": "2026-08-03"},
        {**INVOICE, "invoice_id": "b", "date": "2026-07-01"},
    ]
    project = await _create(async_client)

    body = (await async_client.get(f"/api/v1/aito/{project['id']}/invoice")).json()

    assert body["id"] == "a"
    assert body["invoice_count"] == 2


@pytest.mark.asyncio
async def test_no_invoice_is_null_not_an_error(async_client, books_invoices):
    """The ordinary state of a quoted job that has not been billed yet."""
    books_invoices["rows"][:] = []
    project = await _create(async_client)

    response = await async_client.get(f"/api/v1/aito/{project['id']}/invoice")

    assert response.status_code == 200
    assert response.json() is None


@pytest.mark.asyncio
async def test_a_project_without_a_quote_never_calls_zoho(async_client, books_invoices):
    project = await _create(async_client, quoted=False)

    response = await async_client.get(f"/api/v1/aito/{project['id']}/invoice")

    assert response.status_code == 200
    assert response.json() is None
    assert books_invoices["queries"] == []


@pytest.mark.asyncio
async def test_missing_project_is_404(async_client, books_invoices):
    assert (await async_client.get("/api/v1/aito/99999/invoice")).status_code == 404


@pytest.mark.asyncio
async def test_zoho_failure_is_502(async_client, books_invoices, monkeypatch):
    async def boom(db, estimate_id, customer_id):
        raise ZohoUpstreamError("Zoho Books unreachable: ConnectError")

    monkeypatch.setattr(zoho_service, "list_project_invoices", boom)
    project = await _create(async_client)

    response = await async_client.get(f"/api/v1/aito/{project['id']}/invoice")

    assert response.status_code == 502


# --- GET /invoice.pdf --------------------------------------------------------


@pytest.mark.asyncio
async def test_invoice_pdf_is_served_inline(async_client, books_invoices, monkeypatch):
    async def pdf(db, invoice_id):
        assert invoice_id == "inv-1"
        return b"%PDF-1.4 fake"

    monkeypatch.setattr(zoho_service, "get_invoice_pdf", pdf)
    project = await _create(async_client)

    response = await async_client.get(f"/api/v1/aito/{project['id']}/invoice.pdf")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert "inline" in response.headers["content-disposition"]
    assert "FA-26-0001.pdf" in response.headers["content-disposition"]
    assert response.content.startswith(b"%PDF-")


@pytest.mark.asyncio
async def test_invoice_pdf_is_404_when_there_is_no_invoice(async_client, books_invoices):
    books_invoices["rows"][:] = []
    project = await _create(async_client)

    response = await async_client.get(f"/api/v1/aito/{project['id']}/invoice.pdf")

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_invoice_pdf_filename_survives_a_non_latin1_number(async_client, books_invoices, monkeypatch):
    """Starlette encodes headers as latin-1; an em dash in Books' invoice
    number would 500 the route if the filename were not built by the shared
    Content-Disposition helper."""
    books_invoices["rows"][:] = [{**INVOICE, "invoice_number": "FA—26—0001"}]

    async def pdf(db, invoice_id):
        return b"%PDF-1.4 fake"

    monkeypatch.setattr(zoho_service, "get_invoice_pdf", pdf)
    project = await _create(async_client)

    response = await async_client.get(f"/api/v1/aito/{project['id']}/invoice.pdf")

    assert response.status_code == 200
