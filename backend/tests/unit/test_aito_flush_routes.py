"""Every route that reads a document from Books or bills a card pushes the
card's pending changes first (``ensure_pushed``), before anything else that
could answer differently."""

import pytest
from fastapi import HTTPException

from backend.app.api.routes import aito as aito_routes
from backend.app.models.aito_project import AitoProject

ROUTES = [
    ("GET", "/api/v1/aito/{id}/quote.pdf", None),
    ("GET", "/api/v1/aito/{id}/quote-email", None),
    ("POST", "/api/v1/aito/{id}/quote-email", {"to": "client@example.com"}),
    ("GET", "/api/v1/aito/{id}/invoice.pdf", None),
    ("GET", "/api/v1/aito/{id}/retainer.pdf?retainer_id=R1", None),
    ("GET", "/api/v1/aito/{id}/invoice-preview", None),
    ("POST", "/api/v1/aito/{id}/invoice", None),
]


async def _pending_card(db, **fields) -> AitoProject:
    project = AitoProject(
        description="Support",
        board_column="finish",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_sync_state="pending",
        **fields,
    )
    db.add(project)
    await db.commit()
    return project


def _refusing(seen: list):
    async def refuse(db, project):
        seen.append(project.id)
        raise HTTPException(status_code=503, detail=aito_routes.SYNC_PENDING_DETAIL)

    return refuse


@pytest.mark.asyncio
@pytest.mark.parametrize(("method", "path", "body"), ROUTES)
async def test_the_route_pushes_a_pending_card_before_touching_books(
    async_client, db_session, monkeypatch, method, path, body
):
    project = await _pending_card(db_session, quote_id="E1", quote_number="DEV26-1")
    seen: list[int] = []
    monkeypatch.setattr(aito_routes, "ensure_pushed", _refusing(seen))

    response = await async_client.request(method, path.format(id=project.id), json=body)

    assert seen == [project.id]
    assert response.status_code == 503, response.text
    assert response.json()["detail"]["code"] == "sync_pending"


@pytest.mark.asyncio
async def test_the_quote_pdf_waits_for_a_quote_that_is_still_being_created(async_client, db_session, monkeypatch):
    """No quote_id yet: the wait comes BEFORE the "no Zoho quote" 404, so
    Print on a brand-new card gets the quote once it exists."""
    project = await _pending_card(db_session)
    seen: list[int] = []
    monkeypatch.setattr(aito_routes, "ensure_pushed", _refusing(seen))

    response = await async_client.get(f"/api/v1/aito/{project.id}/quote.pdf")

    assert seen == [project.id]
    assert response.status_code == 503


@pytest.mark.asyncio
async def test_a_missing_card_is_a_404_not_a_wait(async_client, monkeypatch):
    seen: list[int] = []
    monkeypatch.setattr(aito_routes, "ensure_pushed", _refusing(seen))

    response = await async_client.get("/api/v1/aito/999999/quote.pdf")

    assert response.status_code == 404
    assert seen == []
