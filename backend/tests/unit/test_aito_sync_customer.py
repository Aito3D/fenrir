"""The sweep follows the estimate's customer.

A card's client fields are a snapshot taken at import. Before this, a quote
re-assigned to another customer in Zoho Books kept the old person on the card
forever — and the invoice poll, invoice list, rating and history all key on
the card's client_id, so the new customer's invoices never attached. Books is
the record for WHO the quote belongs to: the sweep already reads the estimate
every tick, and `customer_id` rides in that same response.
"""

import httpx
import pytest
from sqlalchemy import select

from backend.app.models.aito_event import AitoEvent
from backend.app.services.aito_quote_sync import sync_project
from backend.app.services.zoho import zoho_service

from .test_aito_quote_sync import _configure_zoho, _project_with_quote, zoho_handler

_ESTIMATE_C2 = {
    "estimate_id": "E1",
    "status": "accepted",
    "total": 5000,
    "customer_id": "C2",
    "customer_name": "Nouveau Client",
    "is_transaction_created": False,
    "invoiced_amount": 0,
}

_CONTACT_C2 = {
    "contact": {
        "contact_id": "C2",
        "contact_name": "Nouveau Client",
        "customer_sub_type": "business",
        "mobile": "+687 12 34 56",
        "phone": "+687 99 99 99",
        "email": "nouveau@example.com",
    }
}


async def _idle_quoted_project(db):
    project = await _project_with_quote(db, impression_cost=1000)
    project.quote_status = "accepted"
    project.quote_sync_state = "idle"
    project.client_phone = "+687 11 11 11"
    project.client_email = "ancien@example.com"
    project.client_is_company = False
    await db.commit()
    await _configure_zoho(db)
    return project


async def _events(db, project_id: int) -> list[AitoEvent]:
    return list(
        (await db.execute(select(AitoEvent).where(AitoEvent.project_id == project_id).order_by(AitoEvent.id)))
        .scalars()
        .all()
    )


@pytest.mark.asyncio
async def test_the_sweep_adopts_the_estimates_new_customer(db_session):
    project = await _idle_quoted_project(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {"estimate": _ESTIMATE_C2},
                ("GET", "/contacts/C2"): _CONTACT_C2,
                ("GET", "/estimates/E1/comments"): {"comments": []},
            },
            seen,
        )
    )
    zoho_service.invalidate_token()
    try:
        await sync_project(db_session, project)
    finally:
        zoho_service.transport = None

    assert project.client_id == "C2"
    assert project.client_name == "Nouveau Client"
    # Mobile first, same as import.
    assert project.client_phone == "+687 12 34 56"
    assert project.client_email == "nouveau@example.com"
    assert project.client_is_company is True
    assert [p for m, p, _ in seen if m == "GET" and "/contacts/" in p] == ["/books/v3/contacts/C2"]


@pytest.mark.asyncio
async def test_the_same_customer_is_a_no_op_with_no_contact_read(db_session):
    """The common case costs nothing: no contact call, and no version bump
    that would 409 an operator mid-edit on the panel."""
    project = await _idle_quoted_project(db_session)
    version_before = project.version
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {**_ESTIMATE_C2, "customer_id": "C1", "customer_name": "Client"}
                },
                ("GET", "/estimates/E1/comments"): {"comments": []},
            },
            seen,
        )
    )
    zoho_service.invalidate_token()
    try:
        await sync_project(db_session, project)
        await db_session.commit()
    finally:
        zoho_service.transport = None

    assert project.client_id == "C1"
    assert project.client_phone == "+687 11 11 11"
    assert project.version == version_before
    assert not [p for m, p, _ in seen if m == "GET" and "/contacts/" in p]


@pytest.mark.asyncio
async def test_an_estimate_without_a_customer_id_is_a_no_op(db_session):
    """A partial payload is no evidence the quote has no customer."""
    project = await _idle_quoted_project(db_session)
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "accepted"}},
                ("GET", "/estimates/E1/comments"): {"comments": []},
            }
        )
    )
    zoho_service.invalidate_token()
    try:
        await sync_project(db_session, project)
    finally:
        zoho_service.transport = None

    assert project.client_id == "C1"
    assert project.client_name == "Client"


@pytest.mark.asyncio
async def test_a_failed_contact_read_still_moves_the_card_to_the_new_customer(db_session):
    """Same degradation as import: id and name from the estimate itself, no
    phone or email. The invoice poll and rating key on the id, so the card
    must follow even when the contact is unreachable — and the sweep as a
    whole must not fail on it."""
    project = await _idle_quoted_project(db_session)
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {"estimate": _ESTIMATE_C2},
                # No /contacts/C2 route: the handler answers 404.
                ("GET", "/estimates/E1/comments"): {"comments": []},
            }
        )
    )
    zoho_service.invalidate_token()
    try:
        await sync_project(db_session, project)
    finally:
        zoho_service.transport = None

    assert project.client_id == "C2"
    assert project.client_name == "Nouveau Client"
    assert project.client_phone is None
    assert project.client_email is None
    assert project.client_is_company is None
    assert project.quote_sync_state == "idle"
    assert project.quote_sync_error is None


@pytest.mark.asyncio
async def test_a_customer_change_clears_the_old_persons_card_only_facts(db_session):
    """The social handle and the contacted stamp describe the OLD person: the
    new client was never told the job is ready, and Books has no field the
    handle could have come from."""
    from datetime import datetime

    project = await _idle_quoted_project(db_session)
    project.client_social_network = "instagram"
    project.client_social_handle = "@ancien"
    project.client_contacted_at = datetime(2026, 9, 1, 8, 0, 0)
    await db_session.commit()
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {"estimate": _ESTIMATE_C2},
                ("GET", "/contacts/C2"): _CONTACT_C2,
                ("GET", "/estimates/E1/comments"): {"comments": []},
            }
        )
    )
    zoho_service.invalidate_token()
    try:
        await sync_project(db_session, project)
        await db_session.commit()
    finally:
        zoho_service.transport = None

    assert project.client_social_network is None
    assert project.client_social_handle is None
    assert project.client_contacted_at is None
    events = await _events(db_session, project.id)
    by_kind = {e.kind: e for e in events}
    changed = by_kind["project.client.changed"]
    assert changed.actor_class == "system"
    assert changed.detail == {
        "from_id": "C1",
        "from_name": "Client",
        "to_id": "C2",
        "to_name": "Nouveau Client",
    }
    assert by_kind["project.contacted.cleared"].detail == {"cause": "zoho"}


@pytest.mark.asyncio
async def test_no_contacted_cleared_event_when_there_was_no_stamp(db_session):
    project = await _idle_quoted_project(db_session)
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {"estimate": _ESTIMATE_C2},
                ("GET", "/contacts/C2"): _CONTACT_C2,
                ("GET", "/estimates/E1/comments"): {"comments": []},
            }
        )
    )
    zoho_service.invalidate_token()
    try:
        await sync_project(db_session, project)
        await db_session.commit()
    finally:
        zoho_service.transport = None

    kinds = [e.kind for e in await _events(db_session, project.id)]
    assert "project.client.changed" in kinds
    assert "project.contacted.cleared" not in kinds
