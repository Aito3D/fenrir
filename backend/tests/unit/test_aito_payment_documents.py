import pytest

from backend.app.models.aito_project import AitoProject
from backend.app.services.aito_payment_documents import DocumentMismatch, resolve_document
from backend.app.services.zoho import zoho_service


async def _project(db, **over):
    base = {
        "description": "d",
        "client_id": "c1",
        "client_name": "ACME",
        "board_column": "devis",
        "position": 0,
        "status": "active",
        "quote_id": "est-1",
        "quote_number": "DEV26-0001",
        "quote_status": "sent",
        "quote_sync_state": "idle",
    }
    base.update(over)
    p = AitoProject(**base)
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return p


@pytest.fixture
def books(monkeypatch):
    state = {
        "invoices": [{"id": "inv-1", "number": "FA-26-0001", "balance": 23000.0}],
        "raw": {"invoice_id": "inv-1", "invoice_number": "FA-26-0001", "balance": 23000.0, "customer_id": "c1"},
        "estimate": {"estimate_id": "est-1", "customer_id": "c1"},
    }

    async def list_project_invoices(db, estimate_id, customer_id):
        return list(state["invoices"]) if estimate_id == "est-1" else []

    async def get_invoice_raw(db, invoice_id):
        return dict(state["raw"])

    async def get_estimate(db, estimate_id):
        return dict(state["estimate"])

    monkeypatch.setattr(zoho_service, "list_project_invoices", list_project_invoices)
    monkeypatch.setattr(zoho_service, "get_invoice_raw", get_invoice_raw)
    monkeypatch.setattr(zoho_service, "get_estimate", get_estimate)
    return state


@pytest.mark.asyncio
async def test_quote_document_is_the_projects_own_quote(db_session, books):
    p = await _project(db_session)
    doc = await resolve_document(db_session, p, "quote", "est-1")
    assert (doc.kind, doc.id, doc.number, doc.customer_id, doc.balance) == ("quote", "est-1", "DEV26-0001", "c1", None)
    with pytest.raises(DocumentMismatch):
        await resolve_document(db_session, p, "quote", "est-other")


@pytest.mark.asyncio
async def test_invoice_document_must_belong_to_the_estimate(db_session, books):
    p = await _project(db_session)
    doc = await resolve_document(db_session, p, "invoice", "inv-1")
    assert (doc.number, doc.customer_id, doc.balance) == ("FA-26-0001", "c1", 23000)
    with pytest.raises(DocumentMismatch):
        await resolve_document(db_session, p, "invoice", "inv-9")


@pytest.mark.asyncio
async def test_project_without_a_quote_matches_nothing(db_session, books):
    p = await _project(db_session, quote_id=None, quote_number=None)
    with pytest.raises(DocumentMismatch):
        await resolve_document(db_session, p, "quote", "est-1")
    with pytest.raises(DocumentMismatch):
        await resolve_document(db_session, p, "invoice", "inv-1")


@pytest.mark.asyncio
async def test_unknown_kind_is_a_mismatch(db_session, books):
    p = await _project(db_session)
    with pytest.raises(DocumentMismatch):
        await resolve_document(db_session, p, "retainer", "x")
