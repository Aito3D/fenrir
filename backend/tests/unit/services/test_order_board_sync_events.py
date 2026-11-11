"""The sync pass records what it observes in the order history. Zoho is the fake of test_order_board_sync."""

from datetime import datetime, timedelta

import pytest
from sqlalchemy import select

from backend.app.models.order_board_event import OrderBoardEvent
from backend.app.services import order_board_events, order_board_sync as sync
from backend.app.services.aito_events import utc_now_naive
from backend.app.services.zoho import ZohoUpstreamError
from backend.tests.unit.test_order_board_sync import (  # noqa: F401 (fixtures)
    no_back_off_left_over,
    order,
    zoho,
)


async def events(db, kind: str) -> list[OrderBoardEvent]:
    query = select(OrderBoardEvent).where(OrderBoardEvent.kind == kind).order_by(OrderBoardEvent.id)
    return list((await db.execute(query)).scalars())


def edited(n: int, stamp: str, **kwargs) -> dict:
    """The order as Books shows it after a change: a new last_modified_time makes the pass refetch it."""
    return {**order(n, **kwargs), "last_modified_time": stamp}


@pytest.mark.asyncio
async def test_received_once_across_resync(db_session, zoho):
    zoho.add({**order(1, qty=3), "created_time": "2026-11-01T08:00:00-1000", "reference_number": "1042"})
    await sync.run_pass(db_session)
    zoho.orders["so1"] = {**zoho.orders["so1"], "last_modified_time": "2026-11-02T08:00:00-1000"}
    await sync.run_pass(db_session)
    received = await events(db_session, "order.received")
    assert len(received) == 1
    assert received[0].occurred_at == datetime(2026, 11, 1, 18, 0)
    assert received[0].actor_class == "system" and received[0].actor_name is None
    assert received[0].detail == {
        "source": "shopify",
        "reference": "1042",
        "total": 1000.0,
        "units": 3.0,
        "pickup": False,
    }


@pytest.mark.asyncio
async def test_zoho_edit_logged_with_changes(db_session, zoho):
    zoho.add(order(1, qty=1))
    await sync.run_pass(db_session)
    zoho.orders["so1"] = {**edited(1, "2026-11-02T08:00:00-1000", qty=2), "shipment_date": "2026-11-20"}
    await sync.run_pass(db_session)
    (event,) = await events(db_session, "zoho.edited")
    assert event.changes == [
        {"field": "Thing", "from": 1.0, "to": 2.0},
        {"field": "shipment_date", "from": None, "to": "2026-11-20"},
    ]


@pytest.mark.asyncio
async def test_own_write_not_logged_as_zoho_edit(db_session, zoho):
    zoho.add(order(1, qty=1))
    await sync.run_pass(db_session)
    sync.note_write("so1")
    zoho.orders["so1"] = edited(1, "2026-11-02T08:00:00-1000", qty=2)
    await sync.run_pass(db_session)
    assert await events(db_session, "zoho.edited") == []


@pytest.mark.asyncio
async def test_ready_on_transition_only(db_session, zoho):
    zoho.add(order(1, qty=3))
    zoho.stock["A"] = 0
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    assert await events(db_session, "order.ready") == []
    zoho.stock["A"] = 3
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    assert len(await events(db_session, "order.ready")) == 1


@pytest.mark.asyncio
async def test_first_compute_records_no_ready(db_session, zoho):
    zoho.add(order(1, qty=3))
    await sync.run_pass(db_session)
    assert (await sync.read_board(db_session))["rows"][0]["status"] == "to_ship"
    assert await events(db_session, "order.ready") == []


def _paid(amount: float) -> dict:
    invoice = {"invoice_id": "i1", "invoice_number": "INV-1", "total": 1000.0, "balance": 1000.0 - amount}
    return edited(1, "2026-11-02T08:00:00-1000", invoices=[{**invoice, "status": "partially_paid"}])


@pytest.mark.asyncio
async def test_payment_received_delta(db_session, zoho):
    zoho.add(order(1))
    await sync.run_pass(db_session)
    zoho.orders["so1"] = _paid(400.0)
    await sync.run_pass(db_session)
    (event,) = await events(db_session, "payment.received")
    assert event.detail == {"amount": 400.0, "paid": 400.0, "total": 1000.0}


@pytest.mark.asyncio
async def test_credit_shifting_between_a_customers_orders_is_not_a_payment(db_session, zoho):
    credit = {"contact": {"unused_customer_credits": 300.0}}
    zoho.add({**order(1, age=9), **credit}, {**order(2, age=5), **credit})
    await sync.run_pass(db_session)
    # Order 1's invoice is paid in full: its credit share is freed and moves to order 2.
    zoho.orders["so1"] = {**_paid(1000.0), "date": order(1, age=9)["date"], **credit}
    await sync.run_pass(db_session)
    rows = {r["id"]: r["payment"] for r in (await sync.read_board(db_session))["rows"]}
    assert (rows["so2"]["paid"], rows["so2"]["invoice_paid"]) == (300.0, 0.0)
    assert [(e.salesorder_id, e.detail["amount"]) for e in await events(db_session, "payment.received")] == [
        ("so1", 1000.0)
    ]


@pytest.mark.asyncio
async def test_payment_already_logged_by_a_terminal_is_not_logged_again(db_session, zoho):
    zoho.add(order(1))
    await sync.run_pass(db_session)
    await order_board_events.record(
        db_session, "so1", "payment.received", actor_class="system", detail={"amount": 400.0, "method": "card"}
    )
    await db_session.commit()
    zoho.orders["so1"] = _paid(400.0)
    await sync.run_pass(db_session)
    assert [e.detail for e in await events(db_session, "payment.received")] == [{"amount": 400.0, "method": "card"}]


@pytest.mark.asyncio
async def test_an_older_terminal_payment_does_not_hide_a_new_one(db_session, zoho):
    zoho.add(order(1))
    await order_board_events.record(
        db_session, "so1", "payment.received", actor_class="system", occurred_at=utc_now_naive() - timedelta(days=1)
    )
    await db_session.commit()
    await sync.run_pass(db_session)
    zoho.orders["so1"] = _paid(400.0)
    await sync.run_pass(db_session)
    assert len(await events(db_session, "payment.received")) == 2


@pytest.mark.asyncio
async def test_finished_once(db_session, zoho):
    zoho.add(order(1, qty=2))
    await sync.run_pass(db_session)
    zoho.orders["so1"] = edited(1, "2026-11-02T08:00:00-1000", qty=2, shipped=2)
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    assert len(await events(db_session, "order.finished")) == 1


@pytest.mark.asyncio
async def test_a_failing_event_write_never_breaks_the_pass(db_session, zoho, monkeypatch):
    zoho.add(order(1, qty=1))
    await sync.run_pass(db_session)

    async def boom(*args, **kwargs):
        raise RuntimeError("event table gone")

    monkeypatch.setattr(order_board_events, "record", boom)
    zoho.orders["so1"] = edited(1, "2026-11-02T08:00:00-1000", qty=2)
    await sync.run_pass(db_session)
    board = await sync.read_board(db_session)
    assert board["sync"]["last_error"] is None
    assert board["rows"][0]["lines"][0]["quantity"] == 2


RETAINER = {"id": "r1", "number": "RET-1", "total": 400.0, "balance": 0.0, "status": "paid"}


@pytest.mark.asyncio
async def test_a_retainer_paid_on_the_quote_is_a_payment_and_drawing_it_is_not(db_session, zoho):
    zoho.add(order(1, estimate_id="e1"))
    await sync.run_pass(db_session)
    zoho.retainers["e1"] = [RETAINER]
    zoho.customer_payments = [{"payment_id": "p1", "retainerinvoice_id": "r1", "unused_amount": 400.0}]
    zoho.orders["so1"] = edited(1, "2026-11-02T08:00:00-1000", estimate_id="e1")
    await sync.run_pass(db_session)
    assert [e.detail["amount"] for e in await events(db_session, "payment.received")] == [400.0]
    # Drawn on the order's invoice: the retainer's payment has nothing unused left, the invoice is settled by it.
    zoho.customer_payments = [{"payment_id": "p1", "retainerinvoice_id": "r1", "unused_amount": 0.0}]
    zoho.orders["so1"] = {**_paid(400.0), "estimate_id": "e1", "last_modified_time": "2026-11-03T08:00:00-1000"}
    await sync.run_pass(db_session)
    assert [e.detail for e in await events(db_session, "payment.received")] == [
        {"amount": 400.0, "paid": 400.0, "total": 1000.0}
    ]


@pytest.mark.asyncio
async def test_retainers_read_for_the_first_time_are_not_a_payment(db_session, zoho):
    """An order stored before retainers were read (an upgrade, or every read failed): its old deposit is not news."""
    zoho.retainers["e1"] = [RETAINER]
    zoho.customer_payments = [{"payment_id": "p1", "retainerinvoice_id": "r1", "unused_amount": 400.0}]
    zoho.fail_retainers = ZohoUpstreamError("retainers boom")
    zoho.add(order(1, estimate_id="e1"))
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    assert (await sync.read_board(db_session))["rows"][0]["payment"]["retainer_known"] is False
    zoho.fail_retainers = None
    zoho.orders["so1"] = edited(1, "2026-11-02T08:00:00-1000", estimate_id="e1")
    await sync.run_pass(db_session)
    assert (await sync.read_board(db_session))["rows"][0]["payment"]["retainer"] == 400.0
    assert await events(db_session, "payment.received") == []


@pytest.mark.asyncio
async def test_an_undrawn_deposit_drawn_after_the_invoice_is_not_a_payment(db_session, zoho):
    """Deposit 400 on the quote, an invoice for the whole order raised without it, then drawn: one payment only."""
    zoho.retainers["e1"] = [RETAINER]
    zoho.customer_payments = [{"payment_id": "p1", "retainerinvoice_id": "r1", "unused_amount": 400.0}]
    zoho.add(order(1, estimate_id="e1"))
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    raised = {"invoice_id": "i1", "invoice_number": "INV-1", "total": 1000.0, "balance": 1000.0, "status": "sent"}
    zoho.orders["so1"] = edited(1, "2026-11-02T08:00:00-1000", estimate_id="e1", invoices=[raised])
    await sync.run_pass(db_session)
    payment = (await sync.read_board(db_session))["rows"][0]["payment"]
    assert (payment["retainer"], payment["paid"], payment["left"]) == (400.0, 400.0, 600.0)
    zoho.customer_payments = [{"payment_id": "p1", "retainerinvoice_id": "r1", "unused_amount": 0.0}]
    zoho.orders["so1"] = {**_paid(400.0), "estimate_id": "e1", "last_modified_time": "2026-11-03T08:00:00-1000"}
    await sync.run_pass(db_session)
    payment = (await sync.read_board(db_session))["rows"][0]["payment"]
    assert (payment["retainer"], payment["invoice_paid"], payment["left"]) == (0.0, 400.0, 600.0)
    assert await events(db_session, "payment.received") == []
