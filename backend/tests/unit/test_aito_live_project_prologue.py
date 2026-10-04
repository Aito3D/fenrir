"""Characterization of the "live project or 404" prologue shared by the
billing/document routes (T-159).

Pins, for every route whose prologue is ``db.get`` + not-deleted:
- a missing id and a soft-deleted card both answer 404 "Project not found",
  before any push and before any Books call;
- whether ``ensure_pushed`` runs (and with which ``strict``) relative to the
  quote_id check, and the exact no-quote answer of each route.
"""

import pytest
from sqlalchemy import update

from backend.app.models.aito_project import AitoProject
from backend.app.services.zoho import zoho_service

ROUTES = [
    ("get", "/invoice", None),
    ("get", "/retainers", None),
    ("get", "/retainer.pdf", {"retainer_id": "RET-A"}),
    ("get", "/retainer-email", {"retainer_id": "RET-A"}),
    ("get", "/invoice-preview", None),
    ("post", "/invoice", None),
    ("get", "/invoice.pdf", None),
    ("get", "/invoice-email", None),
    ("get", "/quote.pdf", None),
    ("get", "/quote-email", None),
]


@pytest.fixture
def pushes(monkeypatch):
    """Record every ensure_pushed the routes make, without pushing anything."""
    calls: list[tuple[int, bool]] = []

    async def fake_ensure_pushed(db, project, *, strict=False, **_kwargs):
        calls.append((project.id, strict))

    monkeypatch.setattr("backend.app.api.routes.aito.ensure_pushed", fake_ensure_pushed)
    return calls


@pytest.fixture
def books_untouched(monkeypatch):
    """Any Books read reached from these routes fails the test loudly."""
    touched: list[str] = []

    def trap(name):
        async def _f(*_a, **_k):
            touched.append(name)
            raise AssertionError(f"Books was called: {name}")

        return _f

    for name in (
        "list_project_invoices",
        "books_invoice_url",
        "get_retainer_invoice_pdf",
        "get_retainer_email_content",
        "get_invoice_email_content",
        "get_invoice_pdf",
        "get_quote_pdf",
        "get_estimate_email_content",
    ):
        if hasattr(zoho_service, name):
            monkeypatch.setattr(zoho_service, name, trap(name))

    async def resolver(db, project):
        touched.append("list_project_retainers")
        raise AssertionError("Books was called: list_project_retainers")

    monkeypatch.setattr("backend.app.api.routes.aito.list_project_retainers", resolver)
    return touched


async def _create(async_client, *, quoted=True):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        "client_email": "contact@example.pf",
    }
    if quoted:
        payload |= {"quote_id": "EST-9", "quote_number": "DEV26-2638"}
    response = await async_client.post("/api/v1/aito/", json=payload)
    assert response.status_code in (200, 201), response.text
    return response.json()


async def _call(async_client, method, suffix, params, project_id):
    url = f"/api/v1/aito/{project_id}{suffix}"
    return await getattr(async_client, method)(url, params=params)


@pytest.mark.asyncio
@pytest.mark.parametrize(("method", "suffix", "params"), ROUTES)
async def test_missing_project_is_404_project_not_found(async_client, pushes, books_untouched, method, suffix, params):
    response = await _call(async_client, method, suffix, params, 999999)

    assert response.status_code == 404
    assert response.json() == {"detail": "Project not found"}
    assert pushes == []
    assert books_untouched == []


@pytest.mark.asyncio
@pytest.mark.parametrize(("method", "suffix", "params"), ROUTES)
async def test_soft_deleted_project_is_404_project_not_found(
    async_client, db_session, pushes, books_untouched, method, suffix, params
):
    project = await _create(async_client)
    await db_session.execute(update(AitoProject).where(AitoProject.id == project["id"]).values(status="deleted"))
    await db_session.commit()

    response = await _call(async_client, method, suffix, params, project["id"])

    assert response.status_code == 404
    assert response.json() == {"detail": "Project not found"}
    assert pushes == []
    assert books_untouched == []


# (method, suffix, params, expected status, expected body, expected pushes as strict flags)
NO_QUOTE = [
    ("get", "/invoice", None, 200, None, []),
    ("get", "/retainers", None, 200, [], []),
    ("get", "/retainer.pdf", {"retainer_id": "RET-A"}, 404, {"detail": "This project has no Zoho quote"}, [False]),
    ("get", "/retainer-email", {"retainer_id": "RET-A"}, 404, {"detail": "This project has no Zoho quote"}, []),
    ("get", "/invoice-preview", None, 409, {"detail": "This project has no Zoho quote to invoice"}, []),
    ("post", "/invoice", None, 409, {"detail": "This project has no Zoho quote to invoice"}, []),
    ("get", "/invoice.pdf", None, 404, {"detail": "This project has no Zoho quote"}, [False]),
    ("get", "/invoice-email", None, 404, {"detail": "This project has no Zoho quote"}, []),
    ("get", "/quote.pdf", None, 404, {"detail": "This project has no Zoho quote"}, [False]),
    ("get", "/quote-email", None, 404, {"detail": "This project has no Zoho quote"}, [True]),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(("method", "suffix", "params", "status", "body", "strict_flags"), NO_QUOTE)
async def test_live_card_without_a_quote(
    async_client, pushes, books_untouched, method, suffix, params, status, body, strict_flags
):
    project = await _create(async_client, quoted=False)

    response = await _call(async_client, method, suffix, params, project["id"])

    assert response.status_code == status
    assert response.json() == body
    # The PDF loader pushes BEFORE its quote_id check (a card whose quote is
    # still being created is pending too); the two email-content loaders and
    # the invoice guard's quote check never push first.
    assert pushes == [(project["id"], strict) for strict in strict_flags]
    assert books_untouched == []


@pytest.mark.asyncio
async def test_email_content_loaders_never_push_a_quoted_card(async_client, pushes, monkeypatch):
    """With a quote, the retainer/invoice email-content loaders go straight to
    Books — no ensure_pushed — while the PDF loader pushes first."""
    project = await _create(async_client)
    order: list[str] = []

    async def resolver(db, p):
        order.append("list_project_retainers")
        return [{"id": "RET-A", "number": "AC-1", "date": "", "total": 0, "balance": 0, "currency_code": "XPF"}]

    async def retainer_content(db, retainer_id):
        order.append(f"retainer_email:{retainer_id}")
        return {"recipients": [], "subject": "s", "body": "b"}

    async def list_invoices(db, quote_id, client_id):
        order.append(f"list_invoices:{quote_id}")
        return [{"id": "INV-1", "number": "INV-1"}]

    async def invoice_content(db, invoice_id):
        order.append(f"invoice_email:{invoice_id}")
        return {"recipients": [], "subject": "s", "body": "b"}

    monkeypatch.setattr("backend.app.api.routes.aito.list_project_retainers", resolver)
    monkeypatch.setattr(zoho_service, "get_retainer_email_content", retainer_content)
    monkeypatch.setattr(zoho_service, "list_project_invoices", list_invoices)
    monkeypatch.setattr(zoho_service, "get_invoice_email_content", invoice_content)

    r1 = await async_client.get(f"/api/v1/aito/{project['id']}/retainer-email", params={"retainer_id": "RET-A"})
    r2 = await async_client.get(f"/api/v1/aito/{project['id']}/invoice-email")

    assert r1.status_code == 200, r1.text
    assert r2.status_code == 200, r2.text

    assert pushes == []
    assert order[:2] == ["list_project_retainers", "retainer_email:RET-A"]
    assert "list_invoices:EST-9" in order
    assert order[-1] == "invoice_email:INV-1"
