"""Finish -> Done needs an invoice.

The operator's sequence on a finished job is: tell the client it is ready,
raise the invoice when they arrive, archive the card when they have paid and
left with it. The contact gate (test_aito_contacted.py) pins the first step.
This file pins the second: a quoted project cannot be archived until its
quote has been invoiced in Books.

It lives on the server for the same reason the contact gate does — the board
card and the panel both offer the transition, and a rule that lives in a
button is a convention, not a rule.
"""

import pytest
from sqlalchemy import update

from backend.app.models.aito_project import AitoProject


async def _create_accepted(client, **overrides):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "+33 6 12 34 56 78",
    }
    payload.update(overrides)
    created = (await client.post("/api/v1/aito/", json=payload)).json()
    accepted = await client.post(f"/api/v1/aito/{created['id']}/quote-status", json={"status": "accepted"})
    project = accepted.json()["project"]
    await client.patch(f"/api/v1/aito/{project['id']}/contacted", json={"contacted": True})
    return project


async def _set_invoiced(db_session, project_id: int, invoiced: bool) -> None:
    async with db_session.begin_nested():
        await db_session.execute(
            update(AitoProject).where(AitoProject.id == project_id).values(quote_invoiced=invoiced)
        )
    await db_session.commit()


@pytest.mark.asyncio
async def test_a_quoted_project_cannot_be_archived_before_it_is_invoiced(async_client):
    """Contacted, unlocked, in Finish — and still refused, because the quote
    has no invoice yet."""
    p = await _create_accepted(async_client, quote_id="E1", quote_number="DEV26-1")

    r = await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "done", "position": 0})

    assert r.status_code == 409
    assert r.json()["detail"] == "Create the invoice before archiving it"
    board = {row["id"]: row for row in (await async_client.get("/api/v1/aito/")).json()}
    assert board[p["id"]]["column"] == "finish"


@pytest.mark.asyncio
async def test_an_invoiced_project_can_be_archived(async_client, db_session):
    p = await _create_accepted(async_client, quote_id="E1", quote_number="DEV26-1")
    await _set_invoiced(db_session, p["id"], True)

    r = await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "done", "position": 0})

    assert r.status_code == 200
    assert r.json()["column"] == "done"


@pytest.mark.asyncio
async def test_a_project_with_no_quote_has_nothing_to_invoice_and_can_be_archived(async_client):
    """A hand-made card that never went through Books cannot be invoiced from
    here, so the gate would strand it in Finish forever."""
    p = await _create_accepted(async_client)

    r = await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "done", "position": 0})

    assert r.status_code == 200
    assert r.json()["column"] == "done"


@pytest.mark.asyncio
async def test_the_way_out_of_done_stays_open_without_an_invoice(async_client, db_session):
    """One direction only, like the contact gate: a card archived before this
    rule existed must still be able to come back out."""
    p = await _create_accepted(async_client, quote_id="E1", quote_number="DEV26-1")
    await _set_invoiced(db_session, p["id"], True)
    await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "done", "position": 0})
    await _set_invoiced(db_session, p["id"], False)

    r = await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "finish", "position": 0})

    assert r.status_code == 200
    assert r.json()["column"] == "finish"
