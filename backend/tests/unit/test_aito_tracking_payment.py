"""The public page's payment block: derived from the ledger row, never from
Heimdall; invoice precedence is the page's, the payload carries both. A
pending link is offered only once the quote is accepted — the client pays
what they have validated, never a quote still under discussion."""

from datetime import datetime

import pytest

from backend.app.api.routes.settings import set_setting
from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.models.aito_project import AitoProject
from backend.app.services.aito_tracking import compute_tracking

NOW = datetime(2026, 9, 12, 10, 0, 0)


async def _project(db, **fields) -> AitoProject:
    base = {
        "description": "x",
        "board_column": "devis",
        "position": 0,
        "status": "active",
        "tracking_token": "K7F3XQ",
        "quote_number": "DEV-1",
        "quote_status": "sent",
    }
    base.update(fields)
    row = AitoProject(**base)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def _link(db, project_id, **fields):
    base = {
        "project_id": project_id,
        "idempotency_key": f"aito:{project_id}:1",
        "heimdall_id": "L1",
        "reference": "DEV-1",
        "amount": 12500,
        "expires_on": "2026-09-27",
        "url": "https://osb/pay/L1",
        "status": "pending",
    }
    base.update(fields)
    db.add(AitoPaymentLink(**base))
    await db.commit()


async def _track(db):
    found = await compute_tracking(db, "K7F3XQ", {}, {}, NOW)
    assert found is not None
    return found[1]


@pytest.mark.asyncio
async def test_no_link_means_null(db_session):
    await _project(db_session)
    assert (await _track(db_session)).payment is None


@pytest.mark.asyncio
async def test_pending_link_is_unpaid_with_the_url_once_accepted(db_session):
    p = await _project(db_session, quote_status="accepted")
    await _link(db_session, p.id)
    payment = (await _track(db_session)).payment
    assert payment.model_dump() == {"state": "unpaid", "url": "https://osb/pay/L1", "deposit": False}


@pytest.mark.asyncio
async def test_paid_link_is_paid_and_deposit_reflects_the_setting(db_session):
    p = await _project(db_session)
    await _link(db_session, p.id, status="paid")
    await set_setting(db_session, "aito_deposit_pct", "30")
    await db_session.commit()
    payment = (await _track(db_session)).payment
    assert payment.model_dump() == {"state": "paid", "url": None, "deposit": True}


@pytest.mark.asyncio
@pytest.mark.parametrize("dead", ["expired", "cancelled", "failed"])
async def test_a_dead_current_link_is_null(db_session, dead):
    p = await _project(db_session)
    await _link(db_session, p.id, status=dead)
    assert (await _track(db_session)).payment is None


@pytest.mark.asyncio
async def test_a_superseded_paid_row_does_not_leak_past_a_pending_one(db_session):
    p = await _project(db_session, quote_status="accepted")
    await _link(
        db_session, p.id, idempotency_key=f"aito:{p.id}:1", heimdall_id="L1", status="expired", superseded_at=NOW
    )
    await _link(db_session, p.id, idempotency_key=f"aito:{p.id}:2", heimdall_id="L2", url="https://osb/pay/L2")
    assert (await _track(db_session)).payment.url == "https://osb/pay/L2"


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["draft", "sent", "viewed", None])
async def test_a_pending_link_is_hidden_until_the_quote_is_accepted(db_session, status):
    p = await _project(db_session, quote_status=status)
    await _link(db_session, p.id)
    assert (await _track(db_session)).payment is None


@pytest.mark.asyncio
async def test_a_paid_link_shows_whatever_the_quote_status(db_session):
    # Money wins: a paid link accepts the quote on the next tick, and the
    # page must not flicker back to nothing in between.
    p = await _project(db_session, quote_status="sent")
    await _link(db_session, p.id, status="paid")
    assert (await _track(db_session)).payment.state == "paid"


@pytest.mark.asyncio
async def test_a_paid_link_never_exposes_the_checkout_url(db_session):
    # The schema documents `url` as the unpaid-only field, and the page
    # never renders it once state is "paid" — a settled order must not
    # leak the Heimdall checkout link to anyone reading the JSON.
    p = await _project(db_session)
    await _link(db_session, p.id, status="paid")
    payment = (await _track(db_session)).payment
    assert payment.state == "paid"
    assert payment.url is None
