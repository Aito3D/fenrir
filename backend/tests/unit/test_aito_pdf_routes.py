"""The three document-PDF routes — quote.pdf, invoice.pdf, retainer.pdf — side by side.

They share one prologue (load, deleted guard, push, quote guard), one upstream
failure mapping (502 carrying Books' message), and one response tail (inline
Content-Disposition with control characters stripped). This pins all of it per
route, so the three cannot drift apart: the per-document fetch is the only part
that is meant to differ.
"""

import logging
from dataclasses import dataclass

import pytest

from backend.app.api.routes import aito as aito_routes
from backend.app.models.aito_project import AitoProject
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoUpstreamError, zoho_service
from backend.app.utils.http import build_content_disposition

PDF = b"%PDF-1.4 pinned body"


@dataclass(frozen=True)
class Route:
    name: str
    path: str  # formatted with the project id
    fetcher: str  # zoho_service attribute the route fetches the PDF through
    log_text: str


ROUTES = [
    Route("quote", "/api/v1/aito/{id}/quote.pdf", "get_estimate_pdf", "Aito quote PDF failed for project %s: %s"),
    Route("invoice", "/api/v1/aito/{id}/invoice.pdf", "get_invoice_pdf", "Aito invoice PDF failed for project %s: %s"),
    Route(
        "retainer",
        "/api/v1/aito/{id}/retainer.pdf?retainer_id=RET-1",
        "get_retainer_invoice_pdf",
        "Aito retainer PDF failed for project %s: %s",
    ),
]
IDS = [r.name for r in ROUTES]


@pytest.fixture
def documents(monkeypatch):
    """Invoice/retainer resolution is patched at the route module, so the
    document number each route builds its filename from is under test control."""
    state = {"number": "DOC-0001"}

    async def resolve_invoice(db, project, invoice_id):
        return {"id": "inv-1", "number": state["number"]}, 1

    async def resolve_retainer(db, project, retainer_id):
        assert retainer_id == "RET-1"
        return {"id": "RET-1", "number": state["number"]}

    monkeypatch.setattr(aito_routes, "_resolve_project_invoice", resolve_invoice)
    monkeypatch.setattr(aito_routes, "_resolve_project_retainer", resolve_retainer)
    return state


async def _project(db_session, *, number="DOC-0001", quote_id="EST-1", status="active"):
    project = AitoProject(
        description="Trophy", board_column="devis", quote_id=quote_id, quote_number=number, status=status
    )
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)
    return project


def _serve(monkeypatch, route: Route, result):
    async def fetch(db, document_id):
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(zoho_service, route.fetcher, fetch)


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ROUTES, ids=IDS)
@pytest.mark.parametrize(
    ("number", "filename"),
    [("DOC-0001", "DOC-0001.pdf"), ("DOC-00\x0742\r\n\x7f", "DOC-0042.pdf")],
    ids=["plain", "control-chars"],
)
async def test_pdf_is_served_whole_and_inline(
    async_client, db_session, documents, monkeypatch, route, number, filename
):
    documents["number"] = number
    _serve(monkeypatch, route, PDF)
    project = await _project(db_session, number=number)

    response = await async_client.get(route.path.format(id=project.id))

    assert response.status_code == 200
    assert response.content == PDF
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"] == build_content_disposition(filename, disposition="inline")


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ROUTES, ids=IDS)
async def test_pdf_falls_back_to_the_id_without_a_number(async_client, db_session, documents, monkeypatch, route):
    documents["number"] = None
    _serve(monkeypatch, route, PDF)
    project = await _project(db_session, number=None)

    response = await async_client.get(route.path.format(id=project.id))

    expected = {"quote": "EST-1.pdf", "invoice": "inv-1.pdf", "retainer": "RET-1.pdf"}[route.name]
    assert response.status_code == 200
    assert response.headers["content-disposition"] == build_content_disposition(expected, disposition="inline")


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ROUTES, ids=IDS)
async def test_pdf_404s_for_a_missing_project(async_client, documents, monkeypatch, route):
    _serve(monkeypatch, route, AssertionError("must not fetch"))

    response = await async_client.get(route.path.format(id=999999))

    assert response.status_code == 404
    assert response.json() == {"detail": "Project not found"}


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ROUTES, ids=IDS)
async def test_pdf_404s_for_a_deleted_project(async_client, db_session, documents, monkeypatch, route):
    _serve(monkeypatch, route, AssertionError("must not fetch"))
    project = await _project(db_session, status="deleted")

    response = await async_client.get(route.path.format(id=project.id))

    assert response.status_code == 404
    assert response.json() == {"detail": "Project not found"}


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ROUTES, ids=IDS)
async def test_pdf_404s_without_a_quote(async_client, db_session, documents, monkeypatch, route):
    _serve(monkeypatch, route, AssertionError("must not fetch"))
    project = await _project(db_session, quote_id=None)

    response = await async_client.get(route.path.format(id=project.id))

    assert response.status_code == 404
    assert response.json() == {"detail": "This project has no Zoho quote"}


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ROUTES, ids=IDS)
@pytest.mark.parametrize(
    "error",
    [ZohoUpstreamError("Books said no"), ZohoNotConfiguredError("Zoho Books is not configured")],
    ids=["upstream", "not-configured"],
)
async def test_pdf_maps_books_failures_to_502(async_client, db_session, documents, monkeypatch, caplog, route, error):
    _serve(monkeypatch, route, error)
    project = await _project(db_session)

    with caplog.at_level(logging.WARNING, logger=aito_routes.logger.name):
        response = await async_client.get(route.path.format(id=project.id))

    assert response.status_code == 502
    assert response.json() == {"detail": str(error)}
    logged = [r for r in caplog.records if r.name == aito_routes.logger.name and r.msg == route.log_text]
    assert len(logged) == 1
    assert logged[0].levelno == logging.WARNING
    assert logged[0].args == (project.id, error)
