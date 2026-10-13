"""The public page's amounts block (2026-10-13): what is owed on the document
the page shows. The quote's online link while it is unpaid — total, paid
deposits, what the link asks for — or the open invoice, which wins, from its
cached total and balance. Nothing for a settled or absent document."""

from datetime import datetime

import pytest

from backend.app.api.routes.settings import set_setting
from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.models.aito_project import AitoProject
from backend.app.services.aito_tracking import compute_tracking, tracking_balance

NOW = datetime(2026, 10, 13, 10, 0, 0)


async def _project(db, **fields) -> AitoProject:
    base = {
        "description": "x",
        "board_column": "print",
        "position": 0,
        "status": "active",
        "tracking_token": "K7F3XQ",
        "quote_number": "DEV-1",
        "quote_status": "accepted",
        "quote_total": 30000.0,
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
        "amount": 9000,
        "expires_on": "2026-10-27",
        "url": "https://osb/pay/L1",
        "status": "pending",
    }
    base.update(fields)
    db.add(AitoPaymentLink(**base))
    await db.commit()


async def _balance(db):
    found = await compute_tracking(db, "K7F3XQ", {}, {}, NOW)
    assert found is not None
    data = found[1]
    return None if data.balance is None else data.balance.model_dump()


@pytest.mark.asyncio
async def test_a_partly_paid_quote_shows_the_paid_share_what_is_left_and_the_total(db_session):
    p = await _project(db_session, retainer_paid_total=21000.0)
    await _link(db_session, p.id)
    assert await _balance(db_session) == {"currency": "XPF", "total": 30000, "paid": 21000, "due": 9000, "paid_pct": 70}


@pytest.mark.asyncio
async def test_an_unpaid_quote_shows_the_full_amount_to_pay(db_session):
    p = await _project(db_session)
    await _link(db_session, p.id, amount=30000)
    assert await _balance(db_session) == {"currency": "XPF", "total": 30000, "paid": 0, "due": 30000, "paid_pct": 0}


@pytest.mark.asyncio
async def test_a_deposit_link_asks_for_the_deposit_against_the_full_total(db_session):
    p = await _project(db_session)
    await _link(db_session, p.id, amount=9000)
    await set_setting(db_session, "aito_deposit_pct", "30")
    await db_session.commit()
    assert await _balance(db_session) == {"currency": "XPF", "total": 30000, "paid": 0, "due": 9000, "paid_pct": 0}


@pytest.mark.asyncio
async def test_a_paid_link_shows_no_amounts(db_session):
    p = await _project(db_session, retainer_paid_total=30000.0)
    await _link(db_session, p.id, status="paid")
    assert await _balance(db_session) is None


@pytest.mark.asyncio
async def test_no_live_link_and_no_invoice_shows_no_amounts(db_session):
    await _project(db_session, retainer_paid_total=21000.0)
    assert await _balance(db_session) is None


@pytest.mark.asyncio
async def test_a_link_hidden_while_the_quote_sits_in_devis_shows_no_amounts(db_session):
    p = await _project(db_session, quote_status="draft")
    await _link(db_session, p.id)
    assert await _balance(db_session) is None


@pytest.mark.asyncio
async def test_a_quote_without_a_total_shows_no_amounts(db_session):
    p = await _project(db_session, quote_total=None)
    await _link(db_session, p.id)
    assert await _balance(db_session) is None


@pytest.mark.asyncio
async def test_an_open_invoice_wins_over_the_link_and_reads_its_own_total_and_balance(db_session):
    p = await _project(
        db_session,
        invoice_status="partially_paid",
        invoice_total=32000.0,
        invoice_balance=9600.0,
        retainer_paid_total=1.0,
    )
    await _link(db_session, p.id)
    assert await _balance(db_session) == {"currency": "XPF", "total": 32000, "paid": 22400, "due": 9600, "paid_pct": 70}


@pytest.mark.asyncio
async def test_an_overdue_invoice_shows_its_amounts_too(db_session):
    await _project(db_session, invoice_status="overdue", invoice_total=30000.0, invoice_balance=30000.0)
    assert await _balance(db_session) == {"currency": "XPF", "total": 30000, "paid": 0, "due": 30000, "paid_pct": 0}


@pytest.mark.asyncio
async def test_a_paid_invoice_shows_no_amounts(db_session):
    await _project(db_session, invoice_status="paid", invoice_total=30000.0, invoice_balance=0.0)
    assert await _balance(db_session) is None


@pytest.mark.asyncio
async def test_an_invoice_cached_before_its_total_was_kept_shows_no_amounts(db_session):
    p = await _project(db_session, invoice_status="sent", invoice_total=None, invoice_balance=9000.0)
    await _link(db_session, p.id)
    assert await _balance(db_session) is None


def _shown(total, paid, due):
    b = tracking_balance(total=total, paid=paid, due=due, currency="XPF")
    return None if b is None else b.model_dump()


def test_the_share_is_rounded_down_so_the_page_never_overstates_what_was_paid():
    assert _shown(30000, 20999, 9001)["paid_pct"] == 69


def test_a_tiny_payment_still_reads_as_one_percent_and_a_tiny_balance_never_as_one_hundred():
    assert _shown(30000, 10, 29990)["paid_pct"] == 1
    assert _shown(30000, 29995, 5)["paid_pct"] == 99


def test_amounts_are_whole_francs_and_never_negative():
    assert _shown(30000.4, 21000.6, 8999.5) == {
        "currency": "XPF",
        "total": 30000,
        "paid": 21001,
        "due": 9000,
        "paid_pct": 70,
    }
    assert _shown(30000, 31000, 0) == {"currency": "XPF", "total": 30000, "paid": 30000, "due": 0, "paid_pct": 100}


def test_nothing_to_show_without_a_positive_total():
    assert _shown(0, 0, 0) is None
    assert _shown(None, 0, 100) is None
