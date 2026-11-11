"""Order Board payments on Aito's Heimdall ledgers: `project_id = 0`, `salesorder_id` set, the same reservation,
replay, polling and settle machinery, and never an Aito project, event or acceptance. Heimdall and Zoho are stubbed."""

import asyncio
from datetime import datetime, timedelta

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.api.routes.settings import set_setting
from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_terminal_payment import AitoTerminalPayment
from backend.app.models.order_board_event import OrderBoardEvent
from backend.app.services import (
    aito_payment_documents as docs,
    aito_payment_links as links,
    aito_terminal_payments as tpe,
)
from backend.app.services.aito_payment_documents import DocumentMismatch, PaymentDocument, resolve_order_document
from backend.app.services.heimdall import HeimdallUnreachable, LinkView, heimdall_service
from backend.app.services.zoho import zoho_service

NOW = datetime(2026, 11, 11, 1, 0, 0)
SO = "so-77"
INVOICE = PaymentDocument(kind="invoice", id="inv-9", number="FA-26-0900", customer_id="c1", balance=23000)


def _payment(**over):
    base = {
        "id": "h-1",
        "method": "terminal",
        "status": "processing",
        "native_state": "sending_to_tpe",
        "amount": 23000,
        "amount_confirmed": None,
        "currency": "XPF",
        "reference": None,
        "link": None,
        "booking": {"status": "pending", "zoho_payment_id": None, "error": None},
    }
    base.update(over)
    return base


def _view(**over) -> LinkView:
    base = {
        "id": "h-1",
        "status": "paid",
        "amount": 23000,
        "currency": "XPF",
        "reference": "FA-26-0900",
        "url": "https://pay.example/x",
        "expires_at": None,
        "native_state": "confirmed",
        "amount_confirmed": 23000,
        "booking_status": "booked",
    }
    base.update(over)
    return LinkView(**base)


@pytest.fixture(autouse=True)
async def _heimdall(db_session):
    await set_setting(db_session, "heimdall_base_url", "http://pos.local:8081")
    await set_setting(db_session, "heimdall_api_token", "hmd_live.84f32b71ac095ed2.s3cret")
    await db_session.commit()
    heimdall_service._transport = None
    tpe._reset_redrive_failures()
    yield
    heimdall_service._transport = None
    tpe._reset_redrive_failures()


@pytest.fixture
def refreshed(monkeypatch):
    """`refresh_order` stubbed (it re-reads Books); records the orders it was asked for."""
    calls: list[str] = []

    async def fake_refresh(db, salesorder_id):
        calls.append(salesorder_id)

    monkeypatch.setattr("backend.app.services.order_board_sync.refresh_order", fake_refresh)
    return calls


@pytest.fixture
def no_aito(monkeypatch):
    """An order row must never reach Aito's acceptance or figures refresh."""

    async def boom(*args, **kwargs):
        raise AssertionError("an order row reached Aito")

    monkeypatch.setattr("backend.app.services.aito_quote_status.accept_quote", boom)
    monkeypatch.setattr("backend.app.services.aito_manual_payments.refresh_after_payment", boom)


async def _order_events(db, kind="payment.received") -> list[OrderBoardEvent]:
    q = select(OrderBoardEvent).where(OrderBoardEvent.kind == kind).order_by(OrderBoardEvent.id)
    return list((await db.execute(q)).scalars())


async def _aito_events(db) -> list[AitoEvent]:
    return list((await db.execute(select(AitoEvent))).scalars())


def _order_charge(**over) -> AitoTerminalPayment:
    base = {
        "project_id": 0,
        "salesorder_id": SO,
        "document_kind": "invoice",
        "document_id": "inv-9",
        "document_number": "FA-26-0900",
        "idempotency_key": f"order-tpe:{SO}:1",
        "heimdall_id": "h-1",
        "amount": 23000,
        "status": "processing",
        "created_at": NOW,
    }
    base.update(over)
    return AitoTerminalPayment(**base)


# --- terminal: lock, in-flight, replay ----------------------------------------


@pytest.mark.asyncio
async def test_order_terminal_double_click_one_charge(test_engine, db_session):
    seen: list[str] = []

    def handler(request):
        seen.append(request.headers["idempotency-key"])
        return httpx.Response(202, json=_payment())

    heimdall_service._transport = httpx.MockTransport(handler)
    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as s1, maker() as s2:
        results = await asyncio.gather(
            tpe.start_order_terminal_payment(s1, SO, document=INVOICE, amount=23000, actor_name="paul", now=NOW),
            tpe.start_order_terminal_payment(s2, SO, document=INVOICE, amount=23000, actor_name="paul", now=NOW),
            return_exceptions=True,
        )
    rows = [r for r in results if isinstance(r, AitoTerminalPayment)]
    assert len(rows) == 1 and len([r for r in results if isinstance(r, tpe.TerminalInProgress)]) == 1
    assert seen == [f"order-tpe:{SO}:1"]
    assert rows[0].project_id == 0 and rows[0].salesorder_id == SO
    assert await _aito_events(db_session) == []  # no `payment.terminal.started` on a project


@pytest.mark.asyncio
async def test_order_replay_same_amount_reuses_key(db_session, monkeypatch):
    keys: list[str] = []
    answers = [HeimdallUnreachable("read timeout"), _view(status="processing", amount_confirmed=None)]

    async def fake_create(db, *, idempotency_key, amount, document):
        keys.append(idempotency_key)
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(heimdall_service, "create_terminal_payment", fake_create)
    with pytest.raises(HeimdallUnreachable):
        await tpe.start_order_terminal_payment(db_session, SO, document=INVOICE, amount=23000, actor_name=None, now=NOW)
    row = await tpe.start_order_terminal_payment(
        db_session, SO, document=INVOICE, amount=23000, actor_name=None, now=NOW
    )
    assert keys == [f"order-tpe:{SO}:1", f"order-tpe:{SO}:1"]
    assert row.heimdall_id == "h-1" and row.status == "processing"
    assert len((await db_session.execute(select(AitoTerminalPayment))).scalars().all()) == 1


@pytest.mark.asyncio
async def test_order_start_is_independent_of_aito_projects(db_session):
    """An open Aito charge never blocks an order (and the reverse): the scopes are separate."""
    db_session.add(_order_charge(salesorder_id="other", idempotency_key="order-tpe:other:1", heimdall_id="h-x"))
    db_session.add(_order_charge(project_id=5, salesorder_id=None, idempotency_key="aito-tpe:5:1", heimdall_id="h-y"))
    await db_session.commit()
    heimdall_service._transport = httpx.MockTransport(lambda r: httpx.Response(202, json=_payment()))
    row = await tpe.start_order_terminal_payment(db_session, SO, document=INVOICE, amount=1, actor_name=None, now=NOW)
    assert row.idempotency_key == f"order-tpe:{SO}:1"


# --- terminal: sweep, settle-once, redrive, age-out ---------------------------


@pytest.mark.asyncio
async def test_sweep_settles_order_row_without_project(db_session, monkeypatch, refreshed, no_aito):
    db_session.add(_order_charge())
    await db_session.commit()

    async def fake_get(db, payment_id):
        return _view()

    monkeypatch.setattr(heimdall_service, "get_payment", fake_get)
    await tpe.poll_open_terminal_payments(db_session, now=NOW)
    row = (await db_session.execute(select(AitoTerminalPayment))).scalar_one()
    assert row.status == "paid" and row.settled_at == NOW and row.effects_pending_at is None
    assert refreshed == [SO]
    assert await _aito_events(db_session) == []


@pytest.mark.asyncio
async def test_order_settle_records_payment_event(db_session, monkeypatch, refreshed, no_aito):
    db_session.add(_order_charge())
    await db_session.commit()

    async def fake_get(db, payment_id):
        return _view(amount_confirmed=22000, booking_status="pending")

    monkeypatch.setattr(heimdall_service, "get_payment", fake_get)
    for _ in range(3):  # repeated polls (the paid row is re-polled while its booking is pending)
        await tpe.poll_open_terminal_payments(db_session, now=NOW)
    events = await _order_events(db_session)
    assert len(events) == 1
    assert events[0].salesorder_id == SO and events[0].detail == {"amount": 22000, "method": "terminal"}


@pytest.mark.asyncio
async def test_order_settle_effects_failure_is_redriven_once(db_session, monkeypatch, refreshed, no_aito):
    db_session.add(_order_charge())
    await db_session.commit()
    real_record = docs.record_order_payment
    fails = [True]

    async def flaky_record(db, salesorder_id, **kw):
        if fails.pop(0) if fails else False:
            raise RuntimeError("event write failed")
        await real_record(db, salesorder_id, **kw)

    monkeypatch.setattr(tpe, "record_order_payment", flaky_record)

    async def fake_get(db, payment_id):
        return _view(booking_status="booked")

    monkeypatch.setattr(heimdall_service, "get_payment", fake_get)
    await tpe.poll_open_terminal_payments(db_session, now=NOW)
    row = (await db_session.execute(select(AitoTerminalPayment))).scalar_one()
    await db_session.refresh(row)
    assert row.status == "paid" and row.effects_pending_at == NOW and await _order_events(db_session) == []

    later = NOW + timedelta(seconds=tpe.EFFECTS_REDRIVE_GRACE_SECONDS + 1)
    await tpe.poll_open_terminal_payments(db_session, now=later)
    await tpe.poll_open_terminal_payments(db_session, now=later + timedelta(minutes=10))
    await db_session.refresh(row)
    assert row.effects_pending_at is None
    assert len(await _order_events(db_session)) == 1 and refreshed == [SO]


@pytest.mark.asyncio
async def test_failed_order_refresh_never_undoes_the_settle(db_session, monkeypatch, no_aito):
    """No stored order: the real `refresh_order` raises; the settle and its event stay."""
    db_session.add(_order_charge())
    await db_session.commit()

    async def fake_get(db, payment_id):
        return _view()

    monkeypatch.setattr(heimdall_service, "get_payment", fake_get)
    await tpe.poll_open_terminal_payments(db_session, now=NOW)
    row = (await db_session.execute(select(AitoTerminalPayment))).scalar_one()
    assert row.status == "paid" and row.settled_at == NOW and row.effects_pending_at is None
    assert len(await _order_events(db_session)) == 1


@pytest.mark.asyncio
async def test_order_reservation_aged_out_and_lost_row_closed_without_aito_events(db_session, monkeypatch):
    old = NOW - timedelta(seconds=tpe.ABANDONED_RESERVATION_SECONDS + 1)
    db_session.add(_order_charge(heimdall_id=None, status="pending", created_at=old))
    db_session.add(_order_charge(salesorder_id="so-lost", idempotency_key="order-tpe:so-lost:1", heimdall_id="h-2"))
    await db_session.commit()

    from backend.app.services.heimdall import HeimdallNotFound

    async def lost(db, payment_id):
        raise HeimdallNotFound("gone")

    monkeypatch.setattr(heimdall_service, "get_payment", lost)
    await tpe.poll_open_terminal_payments(db_session, now=NOW)
    rows = (await db_session.execute(select(AitoTerminalPayment).order_by(AitoTerminalPayment.id))).scalars().all()
    assert [(r.status, r.sync_error) for r in rows] == [("failed", "reservation abandoned"), ("failed", "gone")]
    assert await _aito_events(db_session) == [] and await _order_events(db_session) == []


# --- scope separation -----------------------------------------------------------


@pytest.mark.asyncio
async def test_aito_lookup_ignores_order_rows(db_session):
    p = AitoProject(description="d", board_column="devis", position=0, status="active")
    db_session.add(p)
    await db_session.commit()
    # Defensive: even an order row carrying a real project id never reads as that project's.
    db_session.add(_order_charge(project_id=p.id, status="pending", heimdall_id=None))
    db_session.add(
        AitoPaymentLink(
            project_id=p.id,
            salesorder_id=SO,
            idempotency_key=f"order:{SO}:1",
            reference="FA-26-0900",
            document_kind="invoice",
            amount=1,
            expires_on="2026-12-11",
        )
    )
    await db_session.commit()
    assert await tpe.current_terminal_payment(db_session, p.id) is None
    assert await tpe.current_terminal_payments(db_session, [p.id]) == {}
    assert await tpe._blocking_row(db_session, p.id) is None
    assert await tpe._next_key(db_session, p.id) == f"aito-tpe:{p.id}:1"
    assert await links.current_link(db_session, p.id, kind="invoice") is None
    assert await links.current_links(db_session, [p.id], kind="invoice") == {}
    assert await links._next_key(db_session, p.id) == f"aito:{p.id}:1"
    # ...while the order scope sees them.
    assert (await tpe.current_terminal_payment(db_session, ("order", SO))).salesorder_id == SO
    assert (await links.current_link(db_session, ("order", SO), kind=None)).salesorder_id == SO
    assert await links._next_key(db_session, ("order", SO)) == f"order:{SO}:2"


# --- payment links ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_order_invoice_link_reserves_replays_and_refuses_a_second(db_session, monkeypatch):
    keys: list[str] = []
    answers: list = [HeimdallUnreachable("down"), _view(status="pending")]

    async def fake_create(db, *, idempotency_key, reference, amount, expires_in_days):
        keys.append(idempotency_key)
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(heimdall_service, "create_link", fake_create)
    with pytest.raises(HeimdallUnreachable):
        await links.create_order_invoice_link(
            db_session, SO, document=INVOICE, amount=23000, actor_name="paul", now=NOW
        )
    row = await links.create_order_invoice_link(
        db_session, SO, document=INVOICE, amount=999, actor_name="paul", now=NOW
    )
    assert keys == [f"order:{SO}:1", f"order:{SO}:1"]
    assert row.project_id == 0 and row.salesorder_id == SO and row.amount == 23000 and row.status == "pending"
    with pytest.raises(links.InvoiceLinkExists):
        await links.create_order_invoice_link(db_session, SO, document=INVOICE, amount=1, actor_name=None, now=NOW)
    assert await _aito_events(db_session) == []


@pytest.mark.asyncio
async def test_order_link_paid_by_poll_records_once(db_session, monkeypatch, refreshed, no_aito):
    db_session.add(
        AitoPaymentLink(
            project_id=0,
            salesorder_id=SO,
            idempotency_key=f"order:{SO}:1",
            heimdall_id="h-1",
            reference="FA-26-0900",
            document_kind="invoice",
            amount=23000,
            expires_on="2026-12-11",
            status="pending",
        )
    )
    await db_session.commit()

    async def fake_get(db, payment_id):
        return _view()

    monkeypatch.setattr(heimdall_service, "get_payment", fake_get)
    for minute in range(3):
        await links.reconcile_payment_links(db_session, now=NOW + timedelta(minutes=minute))
    row = (await db_session.execute(select(AitoPaymentLink))).scalar_one()
    assert row.status == "paid" and row.paid_at == NOW
    events = await _order_events(db_session)
    assert len(events) == 1 and events[0].detail == {"amount": 23000, "method": "link"}
    assert refreshed == [SO] and await _aito_events(db_session) == []


@pytest.mark.asyncio
async def test_order_link_reservation_aged_out_and_lost_link_closed(db_session, monkeypatch):
    old = NOW - timedelta(seconds=links.ABANDONED_RESERVATION_SECONDS + 1)
    common = {"project_id": 0, "reference": "R-1", "amount": 1, "expires_on": "2026-12-11", "status": "pending"}
    db_session.add(
        AitoPaymentLink(
            **common, salesorder_id=SO, idempotency_key="order:a:1", document_kind="retainer", created_at=old
        )
    )
    db_session.add(
        AitoPaymentLink(
            **common, salesorder_id="so-b", idempotency_key="order:b:1", document_kind="retainer", heimdall_id="h-9"
        )
    )
    await db_session.commit()

    from backend.app.services.heimdall import HeimdallNotFound

    async def lost(db, payment_id):
        raise HeimdallNotFound("gone")

    monkeypatch.setattr(heimdall_service, "get_payment", lost)
    await links.reconcile_payment_links(db_session, now=NOW)
    rows = (await db_session.execute(select(AitoPaymentLink).order_by(AitoPaymentLink.id))).scalars().all()
    assert [r.status for r in rows] == ["failed", "failed"]
    assert await _aito_events(db_session) == []


# --- resolve_order_document -------------------------------------------------------

ORDER = {
    "salesorder_id": SO,
    "customer_id": "c1",
    "invoices": [
        {"invoice_id": "inv-9", "invoice_number": "FA-26-0900", "status": "sent", "balance": 23000},
        {"invoice_id": "inv-void", "invoice_number": "FA-26-0901", "status": "void", "balance": 500},
        {"invoice_id": "inv-paid", "invoice_number": "FA-26-0902", "status": "paid", "balance": 0},
    ],
    "_retainers": [{"id": "ret-1", "number": "RET-0001", "balance": 4000, "status": "sent", "unused": 0}],
}


@pytest.mark.asyncio
async def test_resolve_order_document_refuses_foreign_invoice(db_session, monkeypatch):
    async def raw(db, invoice_id):
        return {"invoice_number": "FA-26-0900", "customer_id": "c1", "balance": 23000}

    monkeypatch.setattr(zoho_service, "get_invoice_raw", raw)
    for kind, doc_id in (
        ("invoice", "inv-other"),  # not this order's
        ("invoice", "inv-void"),  # void
        ("invoice", "inv-paid"),  # nothing left to pay
        ("retainer", "ret-other"),  # not the order's quote's
        ("quote", "est-1"),  # unknown kind for an order
        ("invoice", ""),
    ):
        with pytest.raises(DocumentMismatch):
            await resolve_order_document(db_session, ORDER, kind, doc_id)
    inv = await resolve_order_document(db_session, ORDER, "invoice", "inv-9")
    assert inv == PaymentDocument(kind="invoice", id="inv-9", number="FA-26-0900", customer_id="c1", balance=23000)
    ret = await resolve_order_document(db_session, ORDER, "retainer", "ret-1")
    assert ret == PaymentDocument(kind="retainer", id="ret-1", number="RET-0001", customer_id="c1", balance=4000)


@pytest.mark.asyncio
async def test_resolve_order_document_refuses_an_invoice_paid_since_the_read(db_session, monkeypatch):
    async def raw(db, invoice_id):
        return {"invoice_number": "FA-26-0900", "customer_id": "c1", "balance": 0}

    monkeypatch.setattr(zoho_service, "get_invoice_raw", raw)
    with pytest.raises(DocumentMismatch):
        await resolve_order_document(db_session, ORDER, "invoice", "inv-9")


@pytest.mark.asyncio
async def test_migration_adds_salesorder_id_to_both_ledgers(test_engine):
    from sqlalchemy import text

    from backend.app.core.database import run_migrations

    tables = ("aito_payment_links", "aito_terminal_payments")
    async with test_engine.begin() as conn:
        for table in tables:
            await conn.execute(text(f"DROP TABLE {table}"))
    for _ in range(2):  # a second boot swallows the duplicate column
        async with test_engine.begin() as conn:
            await run_migrations(conn)  # re-creates the pre-feature tables, then adds the column and index
    async with test_engine.begin() as conn:
        for table in tables:
            assert "salesorder_id" in {r[1] for r in (await conn.execute(text(f"PRAGMA table_info({table})"))).all()}
            indexes = {r[1] for r in (await conn.execute(text(f"PRAGMA index_list({table})"))).all()}
            assert f"ix_{table}_salesorder_id" in indexes
