# backend/tests/unit/test_aito_terminal_payments.py
import asyncio
import json
from datetime import datetime, timedelta

import httpx
import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.api.routes.settings import set_setting
from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_terminal_payment import AitoTerminalPayment
from backend.app.services import aito_terminal_payments as svc
from backend.app.services.aito_payment_documents import PaymentDocument
from backend.app.services.heimdall import (
    HeimdallAmbiguous,
    HeimdallConflict,
    HeimdallNotConfigured,
    HeimdallNotFound,
    HeimdallRateLimited,
    HeimdallUnreachable,
    HeimdallUpstreamError,
    LinkView,
    heimdall_service,
)

NOW = datetime(2026, 9, 23, 1, 0, 0)
INVOICE = PaymentDocument(kind="invoice", id="inv-1", number="FA-26-0001", customer_id="c1", balance=23000)
QUOTE = PaymentDocument(kind="quote", id="est-1", number="DEV26-0001", customer_id="c1", balance=None)


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


@pytest.fixture(autouse=True)
async def _heimdall(db_session):
    await set_setting(db_session, "heimdall_base_url", "http://pos.local:8081")
    await set_setting(db_session, "heimdall_api_token", "hmd_live.84f32b71ac095ed2.s3cret")
    await db_session.commit()
    heimdall_service._transport = None
    yield
    heimdall_service._transport = None


@pytest.fixture(autouse=True)
def _forget_redrive_failures():
    """The consecutive re-drive failure counts live in a module dict (T-082);
    empty it around every test so no count leaks into the next one."""
    svc._reset_redrive_failures()
    yield
    svc._reset_redrive_failures()


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


async def _events(db, project_id, kind):
    rows = (await db.execute(select(AitoEvent).where(AitoEvent.project_id == project_id))).scalars().all()
    return [e for e in rows if e.kind == kind]


@pytest.mark.asyncio
async def test_start_reserves_then_fires_and_records(db_session):
    p = await _project(db_session)
    seen = {}

    def handler(request):
        seen["idem"] = request.headers["idempotency-key"]
        return httpx.Response(202, json=_payment())

    heimdall_service._transport = httpx.MockTransport(handler)
    row = await svc.start_terminal_payment(db_session, p, document=INVOICE, amount=23000, actor_name="paul", now=NOW)
    assert seen["idem"] == f"aito-tpe:{p.id}:1" and row.heimdall_id == "h-1"
    assert row.status == "processing" and row.native_state == "sending_to_tpe" and row.booking_status == "pending"
    assert row.created_by == "paul" and row.document_number == "FA-26-0001"
    started = await _events(db_session, p.id, "payment.terminal.started")
    assert len(started) == 1 and started[0].detail["amount"] == 23000 and started[0].actor_name == "paul"


@pytest.mark.asyncio
async def test_start_refuses_while_a_row_is_open(db_session):
    p = await _project(db_session)
    for status in ("pending", "processing"):
        db_session.add(
            AitoTerminalPayment(
                project_id=p.id,
                document_kind="invoice",
                document_id="inv-1",
                document_number="FA",
                idempotency_key=f"k-{status}",
                amount=1,
                status=status,
                heimdall_id=f"h-{status}",
                created_at=NOW,
            )
        )
        await db_session.commit()
        with pytest.raises(svc.TerminalInProgress):
            await svc.start_terminal_payment(db_session, p, document=INVOICE, amount=1, actor_name=None, now=NOW)
        await db_session.execute(AitoTerminalPayment.__table__.delete())
        await db_session.commit()


@pytest.mark.asyncio
async def test_needs_attention_does_not_block_a_new_charge(db_session):
    """Final review, Important 2: a `needs_attention` ROW is never retried or
    re-polled — but once the operator has read the paper roll, a NEW charge on
    the project is a new row, not a refusal. Spec §4.3/§8 amended."""
    p = await _project(db_session)
    stuck = AitoTerminalPayment(
        project_id=p.id,
        document_kind="invoice",
        document_id="inv-1",
        document_number="FA",
        idempotency_key="k-attention",
        amount=1,
        status="needs_attention",
        heimdall_id="h-attention",
        created_at=NOW,
        settled_at=NOW,
    )
    db_session.add(stuck)
    await db_session.commit()
    heimdall_service._transport = httpx.MockTransport(lambda r: httpx.Response(202, json=_payment(id="h-new")))
    row = await svc.start_terminal_payment(db_session, p, document=INVOICE, amount=23000, actor_name=None, now=NOW)
    assert row.id != stuck.id and row.heimdall_id == "h-new"
    await db_session.refresh(stuck)
    assert stuck.status == "needs_attention" and stuck.heimdall_id == "h-attention"


@pytest.mark.asyncio
async def test_start_marks_the_row_failed_when_heimdall_refuses(db_session):
    p = await _project(db_session)
    heimdall_service._transport = httpx.MockTransport(
        lambda r: httpx.Response(409, json={"error": {"code": "terminal_busy", "message": "busy"}})
    )
    with pytest.raises(HeimdallConflict) as exc:
        await svc.start_terminal_payment(db_session, p, document=INVOICE, amount=1, actor_name=None, now=NOW)
    assert exc.value.code == "terminal_busy"
    row = (await db_session.execute(select(AitoTerminalPayment))).scalar_one()
    assert row.status == "failed" and "terminal_busy" in (row.sync_error or "") and row.heimdall_id is None
    # A failed row does not block the next attempt.
    heimdall_service._transport = httpx.MockTransport(lambda r: httpx.Response(202, json=_payment(id="h-2")))
    again = await svc.start_terminal_payment(db_session, p, document=INVOICE, amount=1, actor_name=None, now=NOW)
    assert again.heimdall_id == "h-2" and again.idempotency_key == f"aito-tpe:{p.id}:2"


@pytest.mark.asyncio
async def test_paid_records_accepts_quote_and_refreshes(db_session, monkeypatch):
    p = await _project(db_session)
    accepted, refreshed = [], []

    async def fake_accept(db, project, **kw):
        accepted.append((project.id, kw["source"]))
        return True

    async def fake_refresh(db, project_id, kind):
        refreshed.append((project_id, kind))

    monkeypatch.setattr("backend.app.services.aito_quote_status.accept_quote", fake_accept)
    monkeypatch.setattr("backend.app.services.aito_manual_payments.refresh_after_payment", fake_refresh)
    row = AitoTerminalPayment(
        project_id=p.id,
        document_kind="quote",
        document_id="est-1",
        document_number="DEV26-0001",
        idempotency_key="k",
        heimdall_id="h-1",
        amount=5000,
        status="processing",
        created_at=NOW,
    )
    db_session.add(row)
    await db_session.commit()
    view = LinkView(
        id="h-1",
        status="paid",
        amount=5000,
        currency="XPF",
        reference="",
        url=None,
        expires_at=None,
        native_state="synced",
        amount_confirmed=5000,
        booking_status="booked",
        zoho_payment_id="pay-9",
    )
    await svc.apply_terminal_state(db_session, row, view, now=NOW)
    assert row.status == "paid" and row.amount_confirmed == 5000 and row.settled_at == NOW
    assert row.zoho_payment_id == "pay-9" and row.booking_status == "booked"
    assert accepted == [(p.id, "terminal")] and refreshed == [(p.id, "quote")]
    paid = await _events(db_session, p.id, "payment.terminal.paid")
    assert len(paid) == 1 and paid[0].detail["amount_confirmed"] == 5000
    # Idempotent: a second identical view records nothing new and accepts nothing again.
    await svc.apply_terminal_state(db_session, row, view, now=NOW + timedelta(seconds=5))
    assert len(await _events(db_session, p.id, "payment.terminal.paid")) == 1 and len(accepted) == 1


@pytest.mark.asyncio
async def test_failed_and_attention_record_their_own_events(db_session):
    p = await _project(db_session)
    for status, kind in (
        ("failed", "payment.terminal.failed"),
        ("cancelled", "payment.terminal.failed"),
        ("needs_attention", "payment.terminal.attention"),
    ):
        row = AitoTerminalPayment(
            project_id=p.id,
            document_kind="invoice",
            document_id="inv-1",
            document_number="FA",
            idempotency_key=f"k-{status}",
            heimdall_id=f"h-{status}",
            amount=1,
            status="processing",
            created_at=NOW,
        )
        db_session.add(row)
        await db_session.commit()
        view = LinkView(
            id=row.heimdall_id,
            status=status,
            amount=1,
            currency="XPF",
            reference="",
            url=None,
            expires_at=None,
            native_state="declined" if status == "failed" else status,
        )
        await svc.apply_terminal_state(db_session, row, view, now=NOW)
        assert row.status == status and row.settled_at == NOW
        assert len(await _events(db_session, p.id, kind)) >= 1


@pytest.mark.asyncio
async def test_booking_failure_after_paid_updates_the_row_without_a_new_event(db_session, monkeypatch):
    p = await _project(db_session)

    async def noop(*a, **k):
        return None

    monkeypatch.setattr("backend.app.services.aito_manual_payments.refresh_after_payment", noop)
    row = AitoTerminalPayment(
        project_id=p.id,
        document_kind="invoice",
        document_id="inv-1",
        document_number="FA",
        idempotency_key="k",
        heimdall_id="h-1",
        amount=1,
        status="processing",
        created_at=NOW,
    )
    db_session.add(row)
    await db_session.commit()
    paid = LinkView(
        id="h-1",
        status="paid",
        amount=1,
        currency="XPF",
        reference="",
        url=None,
        expires_at=None,
        booking_status="pending",
    )
    await svc.apply_terminal_state(db_session, row, paid, now=NOW)
    failed = LinkView(
        id="h-1",
        status="paid",
        amount=1,
        currency="XPF",
        reference="",
        url=None,
        expires_at=None,
        booking_status="failed",
        booking_error="Zoho 400",
    )
    await svc.apply_terminal_state(db_session, row, failed, now=NOW)
    assert row.booking_status == "failed" and row.booking_error == "Zoho 400"
    assert len(await _events(db_session, p.id, "payment.terminal.paid")) == 1


@pytest.mark.asyncio
async def test_refresh_throttles_and_never_raises(db_session):
    p = await _project(db_session)
    row = AitoTerminalPayment(
        project_id=p.id,
        document_kind="invoice",
        document_id="inv-1",
        document_number="FA",
        idempotency_key="k",
        heimdall_id="h-1",
        amount=1,
        status="processing",
        created_at=NOW,
        checked_at=NOW,
    )
    db_session.add(row)
    await db_session.commit()
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(200, json=_payment(status="paid", native_state="confirmed", amount_confirmed=1))

    heimdall_service._transport = httpx.MockTransport(handler)
    await svc.refresh_terminal_payment(db_session, row, now=NOW + timedelta(seconds=1))
    assert calls == [] and row.status == "processing"  # inside the 2 s window
    await svc.refresh_terminal_payment(db_session, row, now=NOW + timedelta(seconds=3))
    assert calls == [1] and row.status == "paid"
    heimdall_service._transport = httpx.MockTransport(
        lambda r: httpx.Response(503, json={"error": {"code": "unavailable", "message": "down"}})
    )
    row2 = AitoTerminalPayment(
        project_id=p.id,
        document_kind="invoice",
        document_id="inv-1",
        document_number="FA",
        idempotency_key="k2",
        heimdall_id="h-2",
        amount=1,
        status="processing",
        created_at=NOW,
    )
    db_session.add(row2)
    await db_session.commit()
    await svc.refresh_terminal_payment(db_session, row2, now=NOW + timedelta(seconds=10))
    assert row2.status == "processing" and "503" in (row2.sync_error or "")


@pytest.mark.asyncio
async def test_refresh_marks_an_open_row_failed_when_heimdall_reports_404(db_session):
    """Heimdall losing track of an OPEN reservation is the only way a stuck
    row ever unblocks itself — `HeimdallNotFound` must mark the row `failed`,
    stamp `checked_at`/`settled_at`, record exactly one
    `payment.terminal.failed` event (reason `not_found`, so the timeline says
    why the card went red), and return without raising."""
    p = await _project(db_session)
    row = AitoTerminalPayment(
        project_id=p.id,
        document_kind="invoice",
        document_id="inv-1",
        document_number="FA",
        idempotency_key="k",
        heimdall_id="h-gone",
        amount=1,
        status="processing",
        created_at=NOW,
    )
    db_session.add(row)
    await db_session.commit()
    heimdall_service._transport = httpx.MockTransport(
        lambda r: httpx.Response(404, json={"error": {"code": "not_found", "message": "no such payment"}})
    )
    result = await svc.refresh_terminal_payment(db_session, row, now=NOW + timedelta(seconds=10))
    assert result is row
    assert row.status == "failed"
    assert "404" in (row.sync_error or "")
    assert row.checked_at == NOW + timedelta(seconds=10)
    assert row.settled_at == NOW + timedelta(seconds=10)
    failed = await _events(db_session, p.id, "payment.terminal.failed")
    assert len(failed) == 1
    assert failed[0].detail["reason"] == "not_found"
    assert failed[0].detail["heimdall_id"] == "h-gone" and failed[0].detail["document_number"] == "FA"
    assert failed[0].actor_class == "system"


@pytest.mark.asyncio
async def test_refresh_404_event_failure_leaves_the_open_row_open(db_session, monkeypatch):
    """The 404 write-off and its `payment.terminal.failed` event share one
    commit: if the event write raises, the caller's rollback leaves the row
    open (re-selected by the poll) instead of failed with no timeline entry,
    and a later refresh closes it with exactly one event."""
    p = await _project(db_session)
    pid = p.id
    row = AitoTerminalPayment(
        project_id=pid,
        document_kind="invoice",
        document_id="inv-1",
        document_number="FA",
        idempotency_key="k-nf",
        heimdall_id="h-gone-nf",
        amount=1,
        status="processing",
        created_at=NOW,
    )
    db_session.add(row)
    await db_session.commit()
    row_id = row.id
    heimdall_service._transport = httpx.MockTransport(
        lambda r: httpx.Response(404, json={"error": {"code": "not_found", "message": "no such payment"}})
    )
    real_record = svc.record

    async def failing_record(*args, **kwargs):
        raise RuntimeError("event write failed")

    monkeypatch.setattr(svc, "record", failing_record)
    with pytest.raises(RuntimeError):
        await svc.refresh_terminal_payment(db_session, row, now=NOW + timedelta(seconds=10))
    await db_session.rollback()
    row = await db_session.get(AitoTerminalPayment, row_id)
    assert row.status == "processing" and row.settled_at is None
    assert await _events(db_session, pid, "payment.terminal.failed") == []
    monkeypatch.setattr(svc, "record", real_record)
    await svc.refresh_terminal_payment(db_session, row, now=NOW + timedelta(seconds=20), force=True)
    assert row.status == "failed" and row.settled_at == NOW + timedelta(seconds=20)
    failed = await _events(db_session, pid, "payment.terminal.failed")
    assert len(failed) == 1 and failed[0].detail["reason"] == "not_found"


@pytest.mark.asyncio
async def test_refresh_404_leaves_a_paid_row_paid(db_session, monkeypatch):
    """A paid row whose Zoho booking is still pending is deliberately kept in
    the poll (`open_row`), so a 404 — repointed base URL, rotated key, lost
    record — used to rewrite a card payment the client actually made as
    `failed`. The 404 lands in `sync_error`/`checked_at` only: `status`,
    `booking_status` and `settled_at` are untouched, no event is recorded, and
    a later successful poll still books the payment."""
    p = await _project(db_session)
    settled = NOW - timedelta(minutes=5)
    row = AitoTerminalPayment(
        project_id=p.id,
        document_kind="invoice",
        document_id="inv-1",
        document_number="FA",
        idempotency_key="k2",
        heimdall_id="h-gone-2",
        amount=1,
        status="paid",
        booking_status="pending",
        created_at=NOW,
        settled_at=settled,
    )
    db_session.add(row)
    await db_session.commit()
    heimdall_service._transport = httpx.MockTransport(
        lambda r: httpx.Response(404, json={"error": {"code": "not_found", "message": "no such payment"}})
    )
    await svc.refresh_terminal_payment(db_session, row, now=NOW + timedelta(seconds=10))
    assert row.status == "paid"
    assert row.booking_status == "pending"
    assert row.settled_at == settled
    assert "404" in (row.sync_error or "")
    assert row.checked_at == NOW + timedelta(seconds=10)
    assert await _events(db_session, p.id, "payment.terminal.failed") == []

    async def noop(*a, **k):
        return None

    monkeypatch.setattr("backend.app.services.aito_manual_payments.refresh_after_payment", noop)
    heimdall_service._transport = httpx.MockTransport(
        lambda r: httpx.Response(
            200,
            json=_payment(
                id="h-gone-2",
                status="paid",
                native_state="captured",
                amount=1,
                amount_confirmed=1,
                booking={"status": "done", "zoho_payment_id": "pay-9", "error": None},
            ),
        )
    )
    await svc.refresh_terminal_payment(db_session, row, now=NOW + timedelta(seconds=20))
    assert row.status == "paid" and row.booking_status == "done" and row.zoho_payment_id == "pay-9"
    assert row.settled_at == settled and row.sync_error is None
    assert await _events(db_session, p.id, "payment.terminal.failed") == []


@pytest.mark.asyncio
async def test_refresh_skips_the_heimdall_call_without_a_heimdall_id(db_session):
    """A row that never reserved with Heimdall (`heimdall_id is None`) must
    return as-is without attempting a request."""
    p = await _project(db_session)
    row = AitoTerminalPayment(
        project_id=p.id,
        document_kind="invoice",
        document_id="inv-1",
        document_number="FA",
        idempotency_key="k3",
        heimdall_id=None,
        amount=1,
        status="processing",
        created_at=NOW,
    )
    db_session.add(row)
    await db_session.commit()
    calls = []
    heimdall_service._transport = httpx.MockTransport(lambda r: calls.append(1) or httpx.Response(200, json={}))
    result = await svc.refresh_terminal_payment(db_session, row, now=NOW + timedelta(seconds=10))
    assert result is row
    assert calls == []
    assert row.checked_at is None


@pytest.mark.asyncio
async def test_refresh_skips_the_heimdall_call_for_a_closed_row(db_session):
    """A row that is neither open nor paid-pending-booking (e.g. already
    `failed`) must return as-is without attempting a request."""
    p = await _project(db_session)
    row = AitoTerminalPayment(
        project_id=p.id,
        document_kind="invoice",
        document_id="inv-1",
        document_number="FA",
        idempotency_key="k4",
        heimdall_id="h-4",
        amount=1,
        status="failed",
        created_at=NOW,
    )
    db_session.add(row)
    await db_session.commit()
    calls = []
    heimdall_service._transport = httpx.MockTransport(lambda r: calls.append(1) or httpx.Response(200, json={}))
    result = await svc.refresh_terminal_payment(db_session, row, now=NOW + timedelta(seconds=10))
    assert result is row
    assert calls == []
    assert row.checked_at is None


@pytest.mark.asyncio
async def test_poll_open_visits_open_rows_and_paid_pending_booking(db_session, monkeypatch):
    p = await _project(db_session)

    async def noop(*a, **k):
        return None

    monkeypatch.setattr("backend.app.services.aito_manual_payments.refresh_after_payment", noop)
    rows = {
        "open": AitoTerminalPayment(
            project_id=p.id,
            document_kind="invoice",
            document_id="i",
            document_number="FA",
            idempotency_key="k1",
            heimdall_id="h-open",
            amount=1,
            status="processing",
            created_at=NOW,
        ),
        "booking": AitoTerminalPayment(
            project_id=p.id,
            document_kind="invoice",
            document_id="i",
            document_number="FA",
            idempotency_key="k2",
            heimdall_id="h-book",
            amount=1,
            status="paid",
            booking_status="pending",
            created_at=NOW,
            settled_at=NOW,
        ),
        "done": AitoTerminalPayment(
            project_id=p.id,
            document_kind="invoice",
            document_id="i",
            document_number="FA",
            idempotency_key="k3",
            heimdall_id="h-done",
            amount=1,
            status="paid",
            booking_status="booked",
            created_at=NOW,
            settled_at=NOW,
        ),
    }
    db_session.add_all(rows.values())
    await db_session.commit()
    seen = []

    def handler(request):
        hid = request.url.path.rsplit("/", 1)[-1]
        seen.append(hid)
        return httpx.Response(
            200,
            json=_payment(
                id=hid,
                status="paid",
                native_state="synced",
                amount_confirmed=1,
                booking={"status": "booked", "zoho_payment_id": "z", "error": None},
            ),
        )

    heimdall_service._transport = httpx.MockTransport(handler)
    visited = await svc.poll_open_terminal_payments(db_session, now=NOW + timedelta(minutes=5))
    assert visited == 2 and sorted(seen) == ["h-book", "h-open"]


# --- fix round 1 -------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_settles_immediately_on_a_replay_response(db_session, monkeypatch):
    """A Heimdall 200 (replay, or the document-level double-charge guard) is
    routine, not an error: the row it adopts must still settle exactly once
    inside the SAME call — see FINDING 1."""
    p = await _project(db_session)
    accepted, refreshed = [], []

    async def fake_accept(db, project, **kw):
        accepted.append((project.id, kw["source"]))
        return True

    async def fake_refresh(db, project_id, kind):
        refreshed.append((project_id, kind))

    monkeypatch.setattr("backend.app.services.aito_quote_status.accept_quote", fake_accept)
    monkeypatch.setattr("backend.app.services.aito_manual_payments.refresh_after_payment", fake_refresh)
    heimdall_service._transport = httpx.MockTransport(
        lambda r: httpx.Response(
            200,
            json=_payment(
                status="paid",
                native_state="synced",
                amount_confirmed=23000,
                booking={"status": "booked", "zoho_payment_id": "pay-1", "error": None},
            ),
        )
    )
    row = await svc.start_terminal_payment(db_session, p, document=QUOTE, amount=23000, actor_name="paul", now=NOW)
    assert row.status == "paid" and row.settled_at == NOW and row.zoho_payment_id == "pay-1"
    paid = await _events(db_session, p.id, "payment.terminal.paid")
    assert len(paid) == 1 and paid[0].detail["amount_confirmed"] == 23000
    assert accepted == [(p.id, "terminal")]
    assert refreshed == [(p.id, "quote")]


@pytest.mark.asyncio
async def test_start_refuses_when_heimdall_returns_an_already_claimed_payment(db_session):
    """`heimdall_id` is unique — Heimdall answering with a payment id another
    row already holds must fail the fresh reservation, not raise
    IntegrityError out of the commit. See FINDING 1 (second-order)."""
    p = await _project(db_session)
    existing = AitoTerminalPayment(
        project_id=p.id,
        document_kind="invoice",
        document_id="inv-1",
        document_number="FA",
        idempotency_key="k-existing",
        heimdall_id="h-claimed",
        amount=1,
        status="paid",
        settled_at=NOW,
        created_at=NOW,
    )
    db_session.add(existing)
    await db_session.commit()
    heimdall_service._transport = httpx.MockTransport(lambda r: httpx.Response(202, json=_payment(id="h-claimed")))
    with pytest.raises(svc.TerminalInProgress):
        await svc.start_terminal_payment(db_session, p, document=INVOICE, amount=1, actor_name=None, now=NOW)
    rows = (await db_session.execute(select(AitoTerminalPayment).order_by(AitoTerminalPayment.id))).scalars().all()
    fresh = [r for r in rows if r.id != existing.id]
    assert len(fresh) == 1
    assert fresh[0].status == "failed" and fresh[0].heimdall_id is None
    assert "h-claimed" in (fresh[0].sync_error or "")


@pytest.mark.asyncio
async def test_start_marks_the_row_failed_when_heimdall_is_not_configured(db_session):
    """`HeimdallNotConfigured` does not subclass `HeimdallUpstreamError` — a
    narrow except would leave the reservation `pending` forever. See
    FINDING 2."""
    p = await _project(db_session)
    await set_setting(db_session, "heimdall_api_token", "")
    await db_session.commit()
    with pytest.raises(HeimdallNotConfigured):
        await svc.start_terminal_payment(db_session, p, document=INVOICE, amount=1, actor_name=None, now=NOW)
    row = (await db_session.execute(select(AitoTerminalPayment))).scalar_one()
    assert row.status == "failed" and row.heimdall_id is None
    # A failed row does not block the next attempt, once configured again.
    await set_setting(db_session, "heimdall_api_token", "hmd_live.84f32b71ac095ed2.s3cret")
    await db_session.commit()
    heimdall_service._transport = httpx.MockTransport(lambda r: httpx.Response(202, json=_payment(id="h-3")))
    again = await svc.start_terminal_payment(db_session, p, document=INVOICE, amount=1, actor_name=None, now=NOW)
    assert again.heimdall_id == "h-3"


@pytest.mark.asyncio
async def test_refresh_reraises_rate_limit_and_poll_stops_the_pass(db_session):
    """A 429 must reach the poll's own `except HeimdallRateLimited: break` —
    not be swallowed into `sync_error` by the broad `HeimdallUpstreamError`
    catch (`HeimdallRateLimited` is a subclass). See FINDING 4."""
    p = await _project(db_session)
    row1 = AitoTerminalPayment(
        project_id=p.id,
        document_kind="invoice",
        document_id="i",
        document_number="FA",
        idempotency_key="k1",
        heimdall_id="h-1",
        amount=1,
        status="processing",
        created_at=NOW,
    )
    db_session.add(row1)
    await db_session.commit()
    heimdall_service._transport = httpx.MockTransport(
        lambda r: httpx.Response(429, json={"error": {"code": "rate_limited", "message": "slow down"}})
    )
    with pytest.raises(HeimdallRateLimited):
        await svc.refresh_terminal_payment(db_session, row1, now=NOW + timedelta(seconds=10), force=True)
    row2 = AitoTerminalPayment(
        project_id=p.id,
        document_kind="invoice",
        document_id="i",
        document_number="FA",
        idempotency_key="k2",
        heimdall_id="h-2",
        amount=1,
        status="processing",
        created_at=NOW,
    )
    db_session.add(row2)
    await db_session.commit()
    visited = await svc.poll_open_terminal_payments(db_session, now=NOW + timedelta(minutes=5))
    assert visited == 1
    await db_session.refresh(row2)
    assert row2.checked_at is None


@pytest.mark.asyncio
async def test_apply_refreshes_the_row_after_accept_quote_rolls_back(db_session, monkeypatch):
    """`accept_quote` -> `push_quote_status` rolls the session back on a
    failed Books push, which expires every ORM object in it, including
    `row`. A caller reading `row` right after `apply_terminal_state` must not
    hit MissingGreenlet. See FINDING 5."""
    p = await _project(db_session)

    async def rollback_then_accept(db, project, **kw):
        await db.rollback()
        return True

    async def noop(*a, **k):
        return None

    monkeypatch.setattr("backend.app.services.aito_quote_status.accept_quote", rollback_then_accept)
    monkeypatch.setattr("backend.app.services.aito_manual_payments.refresh_after_payment", noop)
    row = AitoTerminalPayment(
        project_id=p.id,
        document_kind="quote",
        document_id="est-1",
        document_number="DEV26-0001",
        idempotency_key="k",
        heimdall_id="h-1",
        amount=5000,
        status="processing",
        created_at=NOW,
    )
    db_session.add(row)
    await db_session.commit()
    view = LinkView(
        id="h-1",
        status="paid",
        amount=5000,
        currency="XPF",
        reference="",
        url=None,
        expires_at=None,
        amount_confirmed=5000,
        booking_status="booked",
    )
    await svc.apply_terminal_state(db_session, row, view, now=NOW)
    # Neither of these may raise MissingGreenlet.
    assert row.status == "paid"
    assert svc.terminal_view(row) is not None


@pytest.mark.asyncio
async def test_concurrent_starts_are_serialized_by_the_lock(test_engine, db_session):
    """Two starts that straddle the guard-then-insert must not both reserve
    a row: `_start_lock` serialises the check. See FINDING 6."""
    p = await _project(db_session)
    project_id = p.id

    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(202, json=_payment())

    heimdall_service._transport = httpx.MockTransport(handler)
    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as s1, maker() as s2:
        p1 = await s1.get(AitoProject, project_id)
        p2 = await s2.get(AitoProject, project_id)
        results = await asyncio.gather(
            svc.start_terminal_payment(s1, p1, document=INVOICE, amount=1, actor_name=None, now=NOW),
            svc.start_terminal_payment(s2, p2, document=INVOICE, amount=1, actor_name=None, now=NOW),
            return_exceptions=True,
        )

    successes = [r for r in results if isinstance(r, AitoTerminalPayment)]
    failures = [r for r in results if isinstance(r, svc.TerminalInProgress)]
    assert len(successes) == 1 and len(failures) == 1
    assert calls == [1]


# --- final fix wave: unminted reservations ------------------------------------


def _reservation(project_id, **over):
    base = {
        "project_id": project_id,
        "document_kind": "invoice",
        "document_id": "inv-1",
        "document_number": "FA-26-0001",
        "idempotency_key": "aito-tpe:stuck",
        "amount": 23000,
        "status": "pending",
        "created_at": NOW,
    }
    base.update(over)
    return AitoTerminalPayment(**base)


@pytest.mark.asyncio
async def test_start_replays_an_unminted_reservation_under_its_own_key(db_session):
    """Important 1: a reservation whose handler died before Heimdall answered
    is a dead end (it blocks, and neither the GET nor the sweep may re-send
    it). The OPERATOR's next start replays it — same idempotency key, body
    rebuilt from the ROW (Heimdall answers `409 idempotency_conflict` to any
    changed field), so Heimdall either re-fires the stranded draft (202) or
    hands back the payment it already made (200)."""
    p = await _project(db_session)
    stuck = _reservation(p.id)
    db_session.add(stuck)
    await db_session.commit()
    stuck_id = stuck.id
    seen = {}

    def handler(request):
        seen["idem"] = request.headers["idempotency-key"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(202, json=_payment(id="h-replay"))

    heimdall_service._transport = httpx.MockTransport(handler)
    row = await svc.start_terminal_payment(
        db_session, p, document=INVOICE, amount=23000, actor_name="paul", now=NOW + timedelta(minutes=30)
    )
    assert row.id == stuck_id and row.heimdall_id == "h-replay" and row.status == "processing"
    assert seen["idem"] == "aito-tpe:stuck"
    assert seen["body"]["amount"] == 23000 and seen["body"]["document"] == {"type": "invoice", "id": "inv-1"}
    rows = (await db_session.execute(select(AitoTerminalPayment))).scalars().all()
    assert len(rows) == 1  # replayed, never a second reservation
    started = await _events(db_session, p.id, "payment.terminal.started")
    assert len(started) == 1 and started[0].detail["heimdall_id"] == "h-replay"


@pytest.mark.asyncio
async def test_start_replaces_an_unminted_reservation_for_another_document_or_amount(db_session):
    """The blocking reservation is not the charge the operator is asking for:
    replaying it would fire the terminal for the WRONG amount. It is abandoned
    (marked failed, never re-sent) and a fresh reservation takes over."""
    p = await _project(db_session)
    stuck = _reservation(p.id, amount=500)
    db_session.add(stuck)
    await db_session.commit()
    stuck_id = stuck.id
    seen = {}

    def handler(request):
        seen["idem"] = request.headers["idempotency-key"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(202, json=_payment(id="h-fresh"))

    heimdall_service._transport = httpx.MockTransport(handler)
    row = await svc.start_terminal_payment(
        db_session, p, document=INVOICE, amount=23000, actor_name="paul", now=NOW + timedelta(minutes=1)
    )
    assert row.id != stuck_id and row.heimdall_id == "h-fresh"
    assert seen["idem"] != "aito-tpe:stuck" and seen["body"]["amount"] == 23000
    abandoned = await db_session.get(AitoTerminalPayment, stuck_id)
    assert abandoned.status == "failed" and "replaced by a new charge" in (abandoned.sync_error or "")
    assert abandoned.heimdall_id is None and abandoned.settled_at == NOW + timedelta(minutes=1)


@pytest.mark.asyncio
async def test_the_sweep_ages_out_an_abandoned_reservation_without_calling_heimdall(db_session):
    """THE MONEY RULE: a replay carries `confirm: true` and fires the
    terminal, so the sweep NEVER re-sends an unminted reservation — it only
    ages one out after ABANDONED_RESERVATION_SECONDS so the project stops
    being blocked. A younger one is left alone."""
    p = await _project(db_session)
    old = _reservation(p.id, idempotency_key="k-old", created_at=NOW)
    young = _reservation(p.id, idempotency_key="k-young", created_at=NOW + timedelta(minutes=9))
    db_session.add_all([old, young])
    await db_session.commit()
    old_id, young_id = old.id, young.id
    calls = []

    def handler(request):
        calls.append(request.url.path)
        return httpx.Response(200, json=_payment())

    heimdall_service._transport = httpx.MockTransport(handler)
    later = NOW + timedelta(minutes=11)
    visited = await svc.poll_open_terminal_payments(db_session, now=later)
    assert calls == []  # not one Heimdall request for an unminted reservation
    assert visited == 1
    aged = await db_session.get(AitoTerminalPayment, old_id)
    assert aged.status == "failed" and aged.sync_error == "reservation abandoned" and aged.settled_at == later
    assert aged.heimdall_id is None
    still = await db_session.get(AitoTerminalPayment, young_id)
    assert still.status == "pending" and still.sync_error is None
    failed = await _events(db_session, p.id, "payment.terminal.failed")
    assert len(failed) == 1 and failed[0].detail["reason"] == "abandoned"


@pytest.mark.asyncio
async def test_one_failing_reservation_does_not_end_the_abandoned_sweep(db_session, monkeypatch):
    """Per-row isolation: the event write for the first stale reservation
    raises, the pass rolls back and still ages out the second one. The
    write-off and its event share one commit, so the failing row is left
    `pending` (re-selected by the next pass) rather than written off without
    the abandoned event that tells the operator to check the paper roll."""
    p = await _project(db_session)
    pid = p.id
    first = _reservation(pid, idempotency_key="k-1", created_at=NOW)
    second = _reservation(pid, idempotency_key="k-2", created_at=NOW)
    db_session.add_all([first, second])
    await db_session.commit()
    first_id, second_id = first.id, second.id
    real_record = svc.record
    seen = []

    async def flaky_record(db, project_id, *args, **kwargs):
        seen.append(project_id)
        if len(seen) == 1:
            raise RuntimeError("event write failed")
        return await real_record(db, project_id, *args, **kwargs)

    monkeypatch.setattr(svc, "record", flaky_record)
    later = NOW + timedelta(minutes=11)
    assert await svc._age_out_abandoned_reservations(db_session, now=later, limit=10) == 1
    assert len(seen) == 2
    # The first row's write-off rolled back with its event: still pending.
    one = await db_session.get(AitoTerminalPayment, first_id)
    two = await db_session.get(AitoTerminalPayment, second_id)
    assert one.status == "pending" and one.settled_at is None and one.sync_error is None
    assert two.status == "failed"
    assert two.sync_error == "reservation abandoned" and two.settled_at == later
    assert len(await _events(db_session, pid, "payment.terminal.failed")) == 1
    # The next pass re-selects the first row and writes it off with its event.
    monkeypatch.setattr(svc, "record", real_record)
    assert await svc._age_out_abandoned_reservations(db_session, now=later, limit=10) == 1
    one = await db_session.get(AitoTerminalPayment, first_id)
    assert one.status == "failed" and one.sync_error == "reservation abandoned" and one.settled_at == later
    assert len(await _events(db_session, pid, "payment.terminal.failed")) == 2


@pytest.mark.asyncio
async def test_the_abandoned_sweep_skips_a_reservation_that_vanished(db_session, monkeypatch):
    """A row deleted between the id listing and the per-row fetch is skipped,
    not counted, and does not stop the pass."""
    p = await _project(db_session)
    gone = _reservation(p.id, idempotency_key="k-gone", created_at=NOW)
    kept = _reservation(p.id, idempotency_key="k-kept", created_at=NOW)
    db_session.add_all([gone, kept])
    await db_session.commit()
    gone_id, kept_id = gone.id, kept.id
    real_get = db_session.get

    async def get(entity, ident, *args, **kwargs):
        if ident == gone_id:
            return None
        return await real_get(entity, ident, *args, **kwargs)

    monkeypatch.setattr(db_session, "get", get)
    later = NOW + timedelta(minutes=11)
    assert await svc._age_out_abandoned_reservations(db_session, now=later, limit=10) == 1
    monkeypatch.undo()
    assert (await db_session.get(AitoTerminalPayment, gone_id)).status == "pending"
    assert (await db_session.get(AitoTerminalPayment, kept_id)).status == "failed"


@pytest.mark.asyncio
async def test_the_abandoned_sweep_skips_a_reservation_being_replayed(db_session):
    """T-123: an old unminted reservation whose replay POST is in flight in
    this process is not abandoned -- no write-off, no event."""
    p = await _project(db_session)
    pid = p.id
    stuck = _reservation(p.id, idempotency_key="k-replaying", created_at=NOW)
    db_session.add(stuck)
    await db_session.commit()
    stuck_id = stuck.id
    svc._in_flight.add(stuck_id)
    try:
        assert await svc._age_out_abandoned_reservations(db_session, now=NOW + timedelta(minutes=11), limit=10) == 0
    finally:
        svc._in_flight.discard(stuck_id)
    db_session.expire_all()
    row = await db_session.get(AitoTerminalPayment, stuck_id)
    assert row.status == "pending" and row.settled_at is None and row.sync_error is None
    assert await _events(db_session, pid, "payment.terminal.failed") == []


@pytest.mark.asyncio
async def test_the_abandoned_sweep_leaves_a_row_adopted_after_the_listing_alone(db_session, monkeypatch):
    """T-123: the write-off is a conditional claim. A replay that adopted
    the row (minted it, opened it) between the sweep's listing and its write
    wins: the sweep writes nothing, records nothing, counts nothing, and
    still writes off the next stale row."""
    p = await _project(db_session)
    pid = p.id
    adopted = _reservation(p.id, idempotency_key="k-adopted", created_at=NOW)
    stale = _reservation(p.id, idempotency_key="k-stale", created_at=NOW)
    db_session.add_all([adopted, stale])
    await db_session.commit()
    adopted_id, stale_id = adopted.id, stale.id
    real_get = db_session.get

    async def get(entity, ident, *args, **kwargs):
        row = await real_get(entity, ident, *args, **kwargs)
        if ident == adopted_id:
            # The replay's `_adopt` commit lands in the gap.
            await db_session.execute(
                update(AitoTerminalPayment)
                .where(AitoTerminalPayment.id == adopted_id)
                .values(status="open", heimdall_id="h-adopted")
                .execution_options(synchronize_session=False)
            )
            await db_session.commit()
        return row

    monkeypatch.setattr(db_session, "get", get)
    later = NOW + timedelta(minutes=11)
    assert await svc._age_out_abandoned_reservations(db_session, now=later, limit=10) == 1
    monkeypatch.undo()
    db_session.expire_all()
    kept = await db_session.get(AitoTerminalPayment, adopted_id)
    assert kept.status == "open" and kept.heimdall_id == "h-adopted"
    assert kept.settled_at is None and kept.sync_error is None
    aged = await db_session.get(AitoTerminalPayment, stale_id)
    assert aged.status == "failed" and aged.settled_at == later
    assert len(await _events(db_session, pid, "payment.terminal.failed")) == 1


@pytest.mark.asyncio
async def test_a_sweep_during_a_replay_post_leaves_the_replayed_row_open_and_unsettled(test_engine, db_session):
    """T-123 end to end: the operator replays a reservation older than
    ABANDONED_RESERVATION_SECONDS and the tick's sweep runs while the POST
    is in flight. The row ends up adopted and open with `settled_at` NULL, so
    Heimdall's later `paid` still settles it (event, acceptance, notification);
    no false `abandoned` event is written."""
    p = await _project(db_session)
    pid = p.id
    stuck = _reservation(p.id, created_at=NOW)
    db_session.add(stuck)
    await db_session.commit()
    stuck_id = stuck.id
    later = NOW + timedelta(minutes=11)
    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    swept = []

    async def handler(request):
        async with maker() as other:
            swept.append(await svc._age_out_abandoned_reservations(other, now=later, limit=10))
        return httpx.Response(202, json=_payment(id="h-replayed"))

    heimdall_service._transport = httpx.MockTransport(handler)
    row = await svc.start_terminal_payment(db_session, p, document=INVOICE, amount=23000, actor_name="paul", now=later)

    assert swept == [0]
    assert row.id == stuck_id and row.heimdall_id == "h-replayed"
    db_session.expire_all()
    row = await db_session.get(AitoTerminalPayment, stuck_id)
    assert row.status == "processing" and row.settled_at is None
    assert await _events(db_session, pid, "payment.terminal.failed") == []
    assert len(await _events(db_session, pid, "payment.terminal.started")) == 1


# --- transport faults (T-011) ------------------------------------------------


def _timeout_transport(calls=None):
    """A POST that never gets an answer — the terminal may already be
    dialling. `httpx` raises this from inside `_request`, which turns it into
    `HeimdallUnreachable`."""

    def boom(request):
        if calls is not None:
            calls.append(request.headers["idempotency-key"])
        raise httpx.ReadTimeout("timed out", request=request)

    return httpx.MockTransport(boom)


@pytest.mark.asyncio
async def test_start_leaves_the_reservation_pending_on_a_transport_timeout(db_session):
    """The POST carries `confirm: true`: a read timeout is exactly the case
    where the charge DID start. Stamping the row `failed`/`settled_at` would
    put it beyond every reconciler (the GET returns early with no
    heimdall_id, the sweep only looks at `pending`) while the card was
    debited. It stays an unminted reservation, with the reason on it."""
    p = await _project(db_session)
    heimdall_service._transport = _timeout_transport()
    with pytest.raises(HeimdallUnreachable):
        await svc.start_terminal_payment(db_session, p, document=INVOICE, amount=23000, actor_name="paul", now=NOW)
    row = (await db_session.execute(select(AitoTerminalPayment))).scalar_one()
    assert row.status == "pending" and row.heimdall_id is None and row.settled_at is None
    assert "Heimdall unreachable" in (row.sync_error or "") and row.checked_at == NOW
    assert await _events(db_session, p.id, "payment.terminal.started") == []
    # Nothing is left claiming to be driving it, so the operator may replay.
    assert row.id not in svc._in_flight


@pytest.mark.asyncio
async def test_start_after_a_transport_timeout_replays_the_same_key(db_session):
    """The next start for the SAME document and amount re-POSTs under the
    row's own idempotency key, so Heimdall re-fires the stranded draft (202)
    rather than opening a second charge."""
    p = await _project(db_session)
    keys = []
    heimdall_service._transport = _timeout_transport(keys)
    with pytest.raises(HeimdallUnreachable):
        await svc.start_terminal_payment(db_session, p, document=INVOICE, amount=23000, actor_name="paul", now=NOW)

    def handler(request):
        keys.append(request.headers["idempotency-key"])
        return httpx.Response(202, json=_payment(id="h-replay"))

    heimdall_service._transport = httpx.MockTransport(handler)
    row = await svc.start_terminal_payment(
        db_session, p, document=INVOICE, amount=23000, actor_name="paul", now=NOW + timedelta(minutes=1)
    )
    assert keys == [f"aito-tpe:{p.id}:1", f"aito-tpe:{p.id}:1"]  # a replay, never a new charge
    assert row.heimdall_id == "h-replay" and row.status == "processing" and row.sync_error is None
    rows = (await db_session.execute(select(AitoTerminalPayment))).scalars().all()
    assert len(rows) == 1
    started = await _events(db_session, p.id, "payment.terminal.started")
    assert len(started) == 1 and started[0].detail["heimdall_id"] == "h-replay"


@pytest.mark.asyncio
async def test_start_after_a_transport_timeout_adopts_a_charge_heimdall_already_made(db_session, monkeypatch):
    """The timed-out POST had in fact reached the terminal and the card was
    debited: the replay's 200 hands the payment back, and the row settles —
    the very outcome a `failed` stamp used to throw away."""
    p = await _project(db_session)
    accepted, refreshed = [], []

    async def fake_accept(db, project, **kw):
        accepted.append((project.id, kw["source"]))
        return True

    async def fake_refresh(db, project_id, kind):
        refreshed.append((project_id, kind))

    monkeypatch.setattr("backend.app.services.aito_quote_status.accept_quote", fake_accept)
    monkeypatch.setattr("backend.app.services.aito_manual_payments.refresh_after_payment", fake_refresh)
    heimdall_service._transport = _timeout_transport()
    with pytest.raises(HeimdallUnreachable):
        await svc.start_terminal_payment(db_session, p, document=QUOTE, amount=23000, actor_name="paul", now=NOW)
    heimdall_service._transport = httpx.MockTransport(
        lambda r: httpx.Response(
            200,
            json=_payment(
                status="paid",
                native_state="synced",
                amount_confirmed=23000,
                booking={"status": "booked", "zoho_payment_id": "pay-1", "error": None},
            ),
        )
    )
    later = NOW + timedelta(minutes=2)
    row = await svc.start_terminal_payment(db_session, p, document=QUOTE, amount=23000, actor_name="paul", now=later)
    assert row.status == "paid" and row.settled_at == later and row.zoho_payment_id == "pay-1"
    paid = await _events(db_session, p.id, "payment.terminal.paid")
    assert len(paid) == 1
    assert accepted == [(p.id, "terminal")] and refreshed == [(p.id, "quote")]


@pytest.mark.asyncio
async def test_a_timed_out_reservation_is_replaced_by_a_charge_for_another_amount(db_session):
    """Replaying it would fire the terminal for the wrong amount: it is
    abandoned exactly like any other unminted reservation."""
    p = await _project(db_session)
    heimdall_service._transport = _timeout_transport()
    with pytest.raises(HeimdallUnreachable):
        await svc.start_terminal_payment(db_session, p, document=INVOICE, amount=23000, actor_name="paul", now=NOW)
    stuck_id = (await db_session.execute(select(AitoTerminalPayment.id))).scalar_one()
    heimdall_service._transport = httpx.MockTransport(lambda r: httpx.Response(202, json=_payment(id="h-fresh")))
    later = NOW + timedelta(minutes=1)
    row = await svc.start_terminal_payment(db_session, p, document=INVOICE, amount=500, actor_name="paul", now=later)
    assert row.id != stuck_id and row.heimdall_id == "h-fresh"
    abandoned = await db_session.get(AitoTerminalPayment, stuck_id)
    assert abandoned.status == "failed" and "replaced by a new charge" in (abandoned.sync_error or "")
    assert abandoned.settled_at == later


@pytest.mark.asyncio
async def test_the_sweep_ages_out_a_timed_out_reservation_the_operator_walked_away_from(db_session):
    """Nobody came back to replay it: after ABANDONED_RESERVATION_SECONDS the
    sweep writes it off (without one Heimdall call) so the project's counter
    is not blocked forever."""
    p = await _project(db_session)
    heimdall_service._transport = _timeout_transport()
    with pytest.raises(HeimdallUnreachable):
        await svc.start_terminal_payment(db_session, p, document=INVOICE, amount=23000, actor_name="paul", now=NOW)
    stuck_id = (await db_session.execute(select(AitoTerminalPayment.id))).scalar_one()
    calls = []

    def handler(request):
        calls.append(request.url.path)
        return httpx.Response(200, json=_payment())

    heimdall_service._transport = httpx.MockTransport(handler)
    later = NOW + timedelta(seconds=svc.ABANDONED_RESERVATION_SECONDS + 1)
    assert await svc.poll_open_terminal_payments(db_session, now=later) == 1
    assert calls == []
    aged = await db_session.get(AitoTerminalPayment, stuck_id)
    assert aged.status == "failed" and aged.sync_error == "reservation abandoned" and aged.settled_at == later


# --- ambiguous answers (T-058) -----------------------------------------------

_AMBIGUOUS_ANSWERS = [
    pytest.param(lambda: httpx.Response(500, json={"error": {"code": "internal", "message": "boom"}}), id="500"),
    pytest.param(lambda: httpx.Response(502, content=b"<html>502 Bad Gateway</html>"), id="502-html"),
    pytest.param(lambda: httpx.Response(504, content=b"<html>504 Gateway Time-out</html>"), id="504-html"),
    pytest.param(lambda: httpx.Response(503, json={}), id="503-empty"),
    pytest.param(lambda: httpx.Response(200, content=b"<html>ok?</html>"), id="200-html"),
    # T-077: a 2xx Heimdall answered after accepting `confirm: true`, whose
    # body cannot be read as a payment (a proxy stripped it, a schema change).
    pytest.param(lambda: httpx.Response(202, content=b""), id="202-empty"),
    pytest.param(lambda: httpx.Response(202, json=[_payment()]), id="202-list"),
    pytest.param(lambda: httpx.Response(202, json=_payment_without("id")), id="202-missing-id"),
    pytest.param(lambda: httpx.Response(202, json=_payment_without("amount")), id="202-missing-amount"),
]


def _payment_without(field):
    body = _payment()
    del body[field]
    return body


@pytest.mark.asyncio
@pytest.mark.parametrize("answer", _AMBIGUOUS_ANSWERS)
async def test_start_leaves_the_reservation_pending_on_an_ambiguous_answer(db_session, answer):
    """A 5xx or a non-JSON body (a proxy's 502/504 page) on a POST carrying
    `confirm: true` says no more about the terminal than a read timeout: the
    row stays an unminted reservation, and the next start for the same
    charge replays the SAME idempotency key instead of reserving a new one."""
    p = await _project(db_session)
    keys = []

    def ambiguous(request):
        keys.append(request.headers["idempotency-key"])
        return answer()

    heimdall_service._transport = httpx.MockTransport(ambiguous)
    with pytest.raises(HeimdallAmbiguous):
        await svc.start_terminal_payment(db_session, p, document=INVOICE, amount=23000, actor_name="paul", now=NOW)
    row = (await db_session.execute(select(AitoTerminalPayment))).scalar_one()
    assert row.status == "pending" and row.heimdall_id is None and row.settled_at is None
    assert row.sync_error and row.checked_at == NOW
    assert row.id not in svc._in_flight
    assert await _events(db_session, p.id, "payment.terminal.failed") == []

    def handler(request):
        keys.append(request.headers["idempotency-key"])
        return httpx.Response(202, json=_payment(id="h-replay"))

    heimdall_service._transport = httpx.MockTransport(handler)
    again = await svc.start_terminal_payment(
        db_session, p, document=INVOICE, amount=23000, actor_name="paul", now=NOW + timedelta(minutes=1)
    )
    assert keys == [f"aito-tpe:{p.id}:1", f"aito-tpe:{p.id}:1"]  # a replay, never a second charge
    assert again.id == row.id and again.heimdall_id == "h-replay" and again.sync_error is None
    assert len((await db_session.execute(select(AitoTerminalPayment))).scalars().all()) == 1


@pytest.mark.asyncio
async def test_an_ambiguous_reservation_is_replaced_by_a_charge_for_another_amount(db_session):
    """The existing T-011 rule, unchanged: a different amount abandons the
    stranded reservation (never re-sent) and reserves a fresh key."""
    p = await _project(db_session)
    heimdall_service._transport = httpx.MockTransport(lambda r: httpx.Response(504, content=b"<html>504</html>"))
    with pytest.raises(HeimdallAmbiguous):
        await svc.start_terminal_payment(db_session, p, document=INVOICE, amount=23000, actor_name="paul", now=NOW)
    stuck_id = (await db_session.execute(select(AitoTerminalPayment.id))).scalar_one()
    keys = []

    def handler(request):
        keys.append(request.headers["idempotency-key"])
        return httpx.Response(202, json=_payment(id="h-fresh"))

    heimdall_service._transport = httpx.MockTransport(handler)
    later = NOW + timedelta(minutes=1)
    row = await svc.start_terminal_payment(db_session, p, document=INVOICE, amount=500, actor_name="paul", now=later)
    assert keys == [f"aito-tpe:{p.id}:2"]
    assert row.id != stuck_id and row.heimdall_id == "h-fresh"
    abandoned = await db_session.get(AitoTerminalPayment, stuck_id)
    assert abandoned.status == "failed" and "replaced by a new charge" in (abandoned.sync_error or "")
    assert abandoned.settled_at == later


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [400, 403, 404, 422])
async def test_a_4xx_on_start_is_still_a_clean_refusal(db_session, status):
    """Heimdall answered and said no: nothing was created, the row is
    `failed` and settled exactly as before T-058."""
    p = await _project(db_session)
    heimdall_service._transport = httpx.MockTransport(
        lambda r: httpx.Response(status, json={"error": {"code": "nope", "message": "no"}})
    )
    with pytest.raises(HeimdallUpstreamError) as info:
        await svc.start_terminal_payment(db_session, p, document=INVOICE, amount=1, actor_name=None, now=NOW)
    assert not isinstance(info.value, (HeimdallAmbiguous, HeimdallUnreachable))
    row = (await db_session.execute(select(AitoTerminalPayment))).scalar_one()
    assert row.status == "failed" and row.settled_at == NOW and str(status) in (row.sync_error or "")


# --- the settle is claimed, not check-then-acted ------------------------------


def _paid_view(**over):
    base = {
        "id": "h-1",
        "status": "paid",
        "amount": 5000,
        "currency": "XPF",
        "reference": "",
        "url": None,
        "expires_at": None,
        "native_state": "confirmed",
        "amount_confirmed": 5000,
        "booking_status": "booked",
    }
    base.update(over)
    return LinkView(**base)


async def _open_quote_charge(db, project_id, **over):
    base = {
        "project_id": project_id,
        "document_kind": "quote",
        "document_id": "est-1",
        "document_number": "DEV26-0001",
        "idempotency_key": "k-race",
        "heimdall_id": "h-1",
        "amount": 5000,
        "status": "processing",
        "created_at": NOW,
    }
    base.update(over)
    row = AitoTerminalPayment(**base)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@pytest.mark.asyncio
async def test_two_pollers_on_one_paid_row_settle_it_exactly_once(test_engine, db_session, monkeypatch):
    """The operator's 3 s GET and the sweep's forced poll (which bypasses
    REFRESH_MIN_SECONDS) can both read `settled_at IS NULL` either side of
    the same Heimdall round trip, in two different sessions. Only the one
    that wins the conditional UPDATE may credit the card payment: one
    `payment.terminal.paid` event, one acceptance, one notification, one
    refresh."""
    from backend.app.services.notification_service import notification_service

    p = await _project(db_session)
    project_id = p.id
    row = await _open_quote_charge(db_session, project_id)
    row_id = row.id

    notified, refreshed = [], []

    async def spy_notify(db, **kw):
        notified.append(kw)

    async def fake_refresh(db, project_id, kind):
        refreshed.append((project_id, kind))

    monkeypatch.setattr(notification_service, "on_aito_payment_received", spy_notify)
    monkeypatch.setattr("backend.app.services.aito_manual_payments.refresh_after_payment", fake_refresh)

    # Both pollers are inside their Heimdall GET before either settles: the
    # first parks on the gate until the second has arrived.
    gate = asyncio.Event()
    arrived = []

    async def fake_get(db, payment_id):
        arrived.append(payment_id)
        if len(arrived) < 2:
            await gate.wait()
        else:
            gate.set()
        return _paid_view()

    monkeypatch.setattr(heimdall_service, "get_payment", fake_get)

    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as s1, maker() as s2:
        r1 = await s1.get(AitoTerminalPayment, row_id)
        r2 = await s2.get(AitoTerminalPayment, row_id)
        results = await asyncio.gather(
            svc.refresh_terminal_payment(s1, r1, now=NOW, force=True),
            svc.refresh_terminal_payment(s2, r2, now=NOW, force=True),
            return_exceptions=True,
        )
        assert [r for r in results if isinstance(r, BaseException)] == []
        # The loser's row is left consistent, not half-settled.
        assert [r.status for r in (r1, r2)] == ["paid", "paid"]
        assert [r.settled_at for r in (r1, r2)] == [NOW, NOW]

    assert arrived == ["h-1", "h-1"]
    assert len(await _events(db_session, project_id, "payment.terminal.paid")) == 1
    assert len(await _events(db_session, project_id, "quote.accepted")) == 1
    assert len(notified) == 1 and len(refreshed) == 1
    settled = await db_session.get(AitoTerminalPayment, row_id)
    await db_session.refresh(settled)
    assert settled.status == "paid" and settled.settled_at == NOW


@pytest.mark.asyncio
async def test_a_settle_claimed_by_another_session_records_nothing(test_engine, db_session, monkeypatch):
    """The loser of the claim: another poller stamped `settled_at` while this
    one was waiting for Heimdall. It still adopts the view (so `booking_*`
    stays current) but records no event, accepts nothing and notifies
    nobody — and returns without raising."""
    from backend.app.services.notification_service import notification_service

    p = await _project(db_session)
    project_id = p.id
    row = await _open_quote_charge(db_session, project_id)
    row_id = row.id

    notified, refreshed = [], []

    async def spy_notify(db, **kw):
        notified.append(kw)

    async def fake_refresh(db, project_id, kind):
        refreshed.append((project_id, kind))

    monkeypatch.setattr(notification_service, "on_aito_payment_received", spy_notify)
    monkeypatch.setattr("backend.app.services.aito_manual_payments.refresh_after_payment", fake_refresh)

    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as other:

        async def fake_get(db, payment_id):
            # The other poller settles the row while this GET is in flight.
            claimed = await other.get(AitoTerminalPayment, row_id)
            claimed.status = "paid"
            claimed.settled_at = NOW
            await other.commit()
            return _paid_view(booking_status="pending")

        monkeypatch.setattr(heimdall_service, "get_payment", fake_get)
        loser = await db_session.get(AitoTerminalPayment, row_id)
        returned = await svc.refresh_terminal_payment(db_session, loser, now=NOW + timedelta(seconds=1), force=True)

    assert returned is loser
    assert loser.status == "paid" and loser.settled_at == NOW
    assert loser.booking_status == "pending"
    assert await _events(db_session, project_id, "payment.terminal.paid") == []
    assert notified == [] and refreshed == []
    fresh = await db_session.get(AitoProject, project_id)
    await db_session.refresh(fresh)
    assert fresh.quote_status == "sent"


@pytest.mark.asyncio
async def test_a_declined_settle_still_stamps_settled_at_once(db_session):
    """The failed path claims the settle the same way: one
    `payment.terminal.failed` event, `settled_at` stamped by the winner and
    never moved by a later poll."""
    p = await _project(db_session)
    row = await _open_quote_charge(db_session, p.id, idempotency_key="k-declined")
    declined = _paid_view(status="failed", native_state="declined", amount_confirmed=None, booking_status=None)
    await svc.apply_terminal_state(db_session, row, declined, now=NOW)
    assert row.status == "failed" and row.settled_at == NOW
    await svc.apply_terminal_state(db_session, row, declined, now=NOW + timedelta(seconds=30))
    assert row.settled_at == NOW
    assert len(await _events(db_session, p.id, "payment.terminal.failed")) == 1


@pytest.mark.asyncio
async def test_one_failure_does_not_stop_the_pass(db_session, monkeypatch):
    """`poll_open_terminal_payments`'s per-row `except Exception: ... await
    db.rollback()` (mirroring `aito_payment_links.reconcile_payment_links`'s
    own `test_one_failure_does_not_stop_the_pass`) must not let one row's
    blown-up GET end the tick. `h-fail` is visited first and its
    `refresh_terminal_payment` raises outright; `h-ok`, later in the same
    batch, must still be visited and settled — which only holds if the
    rollback after the first failure leaves the session usable for the
    rest of the loop."""
    p = await _project(db_session)
    project_id = p.id
    failing = AitoTerminalPayment(
        project_id=p.id,
        document_kind="invoice",
        document_id="i",
        document_number="FA",
        idempotency_key="k-fail",
        heimdall_id="h-fail",
        amount=1,
        status="processing",
        created_at=NOW,
    )
    ok = AitoTerminalPayment(
        project_id=p.id,
        document_kind="invoice",
        document_id="i",
        document_number="FA",
        idempotency_key="k-ok",
        heimdall_id="h-ok",
        amount=1,
        status="processing",
        created_at=NOW,
    )
    db_session.add_all([failing, ok])
    await db_session.commit()
    fail_id, ok_id = failing.id, ok.id

    async def noop(*a, **k):
        return None

    monkeypatch.setattr("backend.app.services.aito_manual_payments.refresh_after_payment", noop)

    async def flaky_get(db, payment_id):
        if payment_id == "h-fail":
            raise RuntimeError("boom")
        return _paid_view(id="h-ok", amount=1, booking_status="booked", zoho_payment_id="z-ok")

    monkeypatch.setattr(heimdall_service, "get_payment", flaky_get)
    later = NOW + timedelta(minutes=5)
    visited = await svc.poll_open_terminal_payments(db_session, now=later)

    assert visited == 2
    still_open = await db_session.get(AitoTerminalPayment, fail_id)
    await db_session.refresh(still_open)
    assert still_open.status == "processing" and still_open.checked_at is None
    settled = await db_session.get(AitoTerminalPayment, ok_id)
    await db_session.refresh(settled)
    assert settled.status == "paid" and settled.settled_at == later
    assert settled.zoho_payment_id == "z-ok"
    assert len(await _events(db_session, project_id, "payment.terminal.paid")) == 1


# --- a hung Heimdall stops the poll (T-057) -----------------------------------


async def _three_open_charges(db, project_id):
    rows = [
        AitoTerminalPayment(
            project_id=project_id,
            document_kind="invoice",
            document_id="inv-1",
            document_number="FA",
            idempotency_key=f"k-{n}",
            heimdall_id=f"h-{n}",
            amount=1,
            status="processing",
            created_at=NOW,
        )
        for n in (1, 2, 3)
    ]
    db.add_all(rows)
    await db.commit()
    return [r.id for r in rows]


def _poll_transport(calls, first):
    """GET h-1 answers with `first` (a Response, or an exception to raise);
    every other GET answers a still-processing payment."""

    def handler(request):
        hid = request.url.path.rsplit("/", 1)[-1]
        calls.append(hid)
        if hid == "h-1":
            if isinstance(first, Exception):
                raise first
            return first
        return httpx.Response(200, json=_payment(id=hid, amount=1))

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_an_unreachable_poll_stops_the_terminal_sweep_after_the_first_row(db_session):
    """A hung Heimdall costs the full client timeout per GET: the first
    `HeimdallUnreachable` is stored on its row and the sweep stops there —
    the other open rows are left for the next tick, untouched. No throttle:
    the next tick polls them all again."""
    p = await _project(db_session)
    ids = await _three_open_charges(db_session, p.id)
    calls = []
    heimdall_service._transport = _poll_transport(calls, httpx.ReadTimeout("timed out"))
    later = NOW + timedelta(minutes=5)
    assert await svc.poll_open_terminal_payments(db_session, now=later) == 1
    assert calls == ["h-1"]
    first, second, third = [await db_session.get(AitoTerminalPayment, rid) for rid in ids]
    assert first.sync_error.startswith("Heimdall unreachable") and first.checked_at == later
    for untouched in (second, third):
        await db_session.refresh(untouched)
        assert untouched.sync_error is None and untouched.checked_at is None
    calls.clear()
    heimdall_service._transport = _poll_transport(calls, httpx.Response(200, json=_payment(id="h-1", amount=1)))
    assert await svc.poll_open_terminal_payments(db_session, now=later + timedelta(minutes=5)) == 3
    assert sorted(calls) == ["h-1", "h-2", "h-3"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "first",
    [
        httpx.Response(400, json={"error": {"code": "bad_request", "message": "no"}}),
        httpx.Response(503, content=b"<html>503</html>"),
        httpx.Response(200, json=[]),
        httpx.Response(200, json={"id": "h-1"}),
    ],
    ids=["400", "503-html", "200-list", "200-missing-amount"],
)
async def test_an_answered_failure_on_one_charge_still_polls_the_rest(db_session, first):
    """Heimdall answered (a 4xx, or a 5xx / proxy page): the transport
    works, so every open row is still polled, exactly as before T-057."""
    p = await _project(db_session)
    ids = await _three_open_charges(db_session, p.id)
    calls = []
    heimdall_service._transport = _poll_transport(calls, first)
    later = NOW + timedelta(minutes=5)
    assert await svc.poll_open_terminal_payments(db_session, now=later) == 3
    assert calls == ["h-1", "h-2", "h-3"]
    rows = [await db_session.get(AitoTerminalPayment, rid) for rid in ids]
    assert rows[0].sync_error and all(r.checked_at == later for r in rows)


@pytest.mark.asyncio
async def test_the_get_route_refresh_still_returns_the_row_on_a_transport_failure(db_session):
    """`refresh_terminal_payment` (the GET route's refresh) is unchanged: it
    stores the transport error and hands the row back, never raising."""
    p = await _project(db_session)
    (rid, *_) = await _three_open_charges(db_session, p.id)
    heimdall_service._transport = _poll_transport([], httpx.ReadTimeout("timed out"))
    row = await db_session.get(AitoTerminalPayment, rid)
    later = NOW + timedelta(minutes=5)
    assert await svc.refresh_terminal_payment(db_session, row, now=later) is row
    assert row.status == "processing" and row.sync_error.startswith("Heimdall unreachable")


# --- a failed settle's effects are re-driven (T-059) --------------------------


def _fail_rules_once(monkeypatch):
    """`apply_quote_decision` raises once before its commit — the shape of
    SQLite 'database is locked' or a rules failure inside the acceptance."""
    from sqlalchemy.exc import OperationalError

    import backend.app.api.routes.aito as routes

    real = routes._apply_rules
    calls = []

    async def flaky(*a, **k):
        calls.append(1)
        if len(calls) == 1:
            raise OperationalError("UPDATE", {}, Exception("database is locked"))
        return await real(*a, **k)

    monkeypatch.setattr(routes, "_apply_rules", flaky)
    return calls


def _spy_effects(monkeypatch):
    from backend.app.services.notification_service import notification_service

    notified, refreshed = [], []

    async def spy_notify(db, **kw):
        notified.append(kw)

    async def fake_refresh(db, project_id, kind):
        refreshed.append((project_id, kind))

    monkeypatch.setattr(notification_service, "on_aito_payment_received", spy_notify)
    monkeypatch.setattr("backend.app.services.aito_manual_payments.refresh_after_payment", fake_refresh)
    return notified, refreshed


@pytest.mark.asyncio
async def test_a_failed_acceptance_after_the_settle_claim_is_redriven_exactly_once(db_session, monkeypatch):
    """The settle claim commits; the acceptance then raises. The row stays
    settled with its effects owed (`effects_pending_at`); a sweep inside the
    grace window leaves it alone, the first sweep after it records the event,
    accepts the quote and notifies — once — and a third sweep does nothing."""
    p = await _project(db_session)
    project_id = p.id
    row = await _open_quote_charge(db_session, project_id)
    row_id = row.id
    notified, refreshed = _spy_effects(monkeypatch)
    rules_calls = _fail_rules_once(monkeypatch)
    gets = []

    async def fake_get(db, payment_id):
        gets.append(payment_id)
        return _paid_view()

    monkeypatch.setattr(heimdall_service, "get_payment", fake_get)

    assert await svc.poll_open_terminal_payments(db_session, now=NOW) == 1
    assert len(rules_calls) == 1
    stored = await db_session.get(AitoTerminalPayment, row_id)
    await db_session.refresh(stored)
    assert stored.status == "paid" and stored.settled_at == NOW and stored.effects_pending_at == NOW
    assert await _events(db_session, project_id, "payment.terminal.paid") == []
    assert await _events(db_session, project_id, "quote.accepted") == []
    assert notified == [] and refreshed == []

    # Inside the grace window: not re-driven yet, and no Heimdall call (the row is settled).
    inside = NOW + timedelta(seconds=svc.EFFECTS_REDRIVE_GRACE_SECONDS - 1)
    assert await svc.poll_open_terminal_payments(db_session, now=inside) == 0
    assert await _events(db_session, project_id, "payment.terminal.paid") == []

    after = NOW + timedelta(seconds=svc.EFFECTS_REDRIVE_GRACE_SECONDS)
    assert await svc.poll_open_terminal_payments(db_session, now=after) == 1
    paid = await _events(db_session, project_id, "payment.terminal.paid")
    assert len(paid) == 1 and paid[0].detail["amount_confirmed"] == 5000
    assert len(await _events(db_session, project_id, "quote.accepted")) == 1
    assert len(notified) == 1 and notified[0]["source"] == "terminal"
    assert refreshed == [(project_id, "quote")]
    fresh = await db_session.get(AitoProject, project_id)
    await db_session.refresh(fresh)
    assert fresh.quote_status == "accepted"
    await db_session.refresh(stored)
    assert stored.effects_pending_at is None and stored.settled_at == NOW

    assert await svc.poll_open_terminal_payments(db_session, now=after + timedelta(hours=1)) == 0
    assert len(await _events(db_session, project_id, "payment.terminal.paid")) == 1
    assert len(await _events(db_session, project_id, "quote.accepted")) == 1
    assert len(notified) == 1 and len(refreshed) == 1
    assert gets == ["h-1"]


@pytest.mark.asyncio
async def test_a_failed_event_commit_on_a_declined_settle_is_redriven(db_session, monkeypatch):
    """A non-paid settle owes only its event: re-driven once, no acceptance,
    no refresh."""
    p = await _project(db_session)
    project_id = p.id
    row = await _open_quote_charge(db_session, project_id, idempotency_key="k-redrive-declined")
    notified, refreshed = _spy_effects(monkeypatch)
    real_record = svc.record
    calls = []

    async def flaky_record(*a, **k):
        calls.append(a[2])
        if len(calls) == 1:
            raise RuntimeError("event write failed")
        return await real_record(*a, **k)

    monkeypatch.setattr(svc, "record", flaky_record)
    declined = _paid_view(status="failed", native_state="declined", amount_confirmed=None, booking_status=None)
    with pytest.raises(RuntimeError):
        await svc.apply_terminal_state(db_session, row, declined, now=NOW)
    stored = await db_session.get(AitoTerminalPayment, row.id)
    await db_session.refresh(stored)
    assert stored.status == "failed" and stored.settled_at == NOW and stored.effects_pending_at == NOW
    assert await _events(db_session, project_id, "payment.terminal.failed") == []

    later = NOW + timedelta(seconds=svc.EFFECTS_REDRIVE_GRACE_SECONDS)
    assert await svc.poll_open_terminal_payments(db_session, now=later) == 1
    assert len(await _events(db_session, project_id, "payment.terminal.failed")) == 1
    assert await svc.poll_open_terminal_payments(db_session, now=later + timedelta(hours=1)) == 0
    assert len(await _events(db_session, project_id, "payment.terminal.failed")) == 1
    assert notified == [] and refreshed == []
    fresh = await db_session.get(AitoProject, project_id)
    await db_session.refresh(fresh)
    assert fresh.quote_status == "sent"


@pytest.mark.asyncio
async def test_a_redrive_that_fails_again_keeps_the_marker_and_the_pass_goes_on(db_session, monkeypatch):
    p = await _project(db_session)
    project_id = p.id
    first = await _open_quote_charge(db_session, project_id, idempotency_key="k-r1", heimdall_id="h-r1")
    second = await _open_quote_charge(
        db_session, project_id, idempotency_key="k-r2", heimdall_id="h-r2", document_kind="invoice"
    )
    for r in (first, second):
        r.status = "paid"
        r.booking_status = "booked"
        r.settled_at = NOW
        r.effects_pending_at = NOW
    await db_session.commit()
    first_id, second_id = first.id, second.id
    _spy_effects(monkeypatch)
    real_record = svc.record

    async def flaky_record(db, pid, kind, **k):
        if k["detail"]["heimdall_id"] == "h-r1":
            raise RuntimeError("still failing")
        return await real_record(db, pid, kind, **k)

    monkeypatch.setattr(svc, "record", flaky_record)
    later = NOW + timedelta(seconds=svc.EFFECTS_REDRIVE_GRACE_SECONDS)
    assert await svc.poll_open_terminal_payments(db_session, now=later) == 1
    r1 = await db_session.get(AitoTerminalPayment, first_id)
    r2 = await db_session.get(AitoTerminalPayment, second_id)
    await db_session.refresh(r1)
    await db_session.refresh(r2)
    assert r1.effects_pending_at == NOW and r2.effects_pending_at is None
    paid = await _events(db_session, project_id, "payment.terminal.paid")
    assert [e.detail["heimdall_id"] for e in paid] == ["h-r2"]


@pytest.mark.asyncio
async def test_a_redrive_whose_marker_was_already_cleared_does_nothing(test_engine, db_session, monkeypatch):
    """The re-drive claims the marker like the settle: if another session
    cleared it after the selection, this one records and accepts nothing."""
    p = await _project(db_session)
    project_id = p.id
    row = await _open_quote_charge(db_session, project_id, idempotency_key="k-r3")
    row.status = "paid"
    row.booking_status = "booked"
    row.settled_at = NOW
    row.effects_pending_at = NOW
    await db_session.commit()
    row_id = row.id
    notified, refreshed = _spy_effects(monkeypatch)
    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    real_get = db_session.get

    async def get_after_another_session_cleared(model, ident, **kw):
        if model is AitoTerminalPayment:
            async with maker() as other:
                claimed = await other.get(AitoTerminalPayment, ident)
                claimed.effects_pending_at = None
                await other.commit()
        return await real_get(model, ident, **kw)

    monkeypatch.setattr(db_session, "get", get_after_another_session_cleared)
    later = NOW + timedelta(seconds=svc.EFFECTS_REDRIVE_GRACE_SECONDS)
    assert await svc._redrive_settle_effects(db_session, now=later, limit=10) == 0
    monkeypatch.undo()
    assert await _events(db_session, project_id, "payment.terminal.paid") == []
    assert notified == [] and refreshed == []
    stored = await db_session.get(AitoTerminalPayment, row_id)
    await db_session.refresh(stored)
    assert stored.effects_pending_at is None


@pytest.mark.asyncio
async def test_a_replayed_paid_row_whose_settle_never_committed_is_polled_and_settled(db_session, monkeypatch):
    """`start_terminal_payment`'s 200-replay commits the adopted `paid` row
    before `apply_terminal_state`; if the settle claim then fails, the row is
    paid, booked and unsettled. The sweep polls it again and settles it."""
    p = await _project(db_session)
    project_id = p.id
    row = await _open_quote_charge(db_session, project_id, idempotency_key="k-r4")
    row.status = "paid"
    row.booking_status = "booked"
    await db_session.commit()
    row_id = row.id
    notified, refreshed = _spy_effects(monkeypatch)
    gets = []

    async def fake_get(db, payment_id):
        gets.append(payment_id)
        return _paid_view()

    monkeypatch.setattr(heimdall_service, "get_payment", fake_get)
    assert await svc.poll_open_terminal_payments(db_session, now=NOW) == 1
    stored = await db_session.get(AitoTerminalPayment, row_id)
    await db_session.refresh(stored)
    assert stored.settled_at == NOW and stored.effects_pending_at is None
    assert len(await _events(db_session, project_id, "payment.terminal.paid")) == 1
    assert len(notified) == 1 and refreshed == [(project_id, "quote")]
    assert await svc.poll_open_terminal_payments(db_session, now=NOW + timedelta(hours=1)) == 0
    assert gets == ["h-1"]


async def _owed_paid_invoice_row(db, project_id, **over):
    row = await _open_quote_charge(db, project_id, document_kind="invoice", **over)
    row.status = "paid"
    row.booking_status = "booked"
    row.settled_at = NOW
    row.effects_pending_at = NOW
    await db.commit()
    return row.id


@pytest.mark.asyncio
async def test_a_redrive_that_keeps_failing_is_surfaced_then_capped(db_session, monkeypatch, caplog):
    """T-082 (user-approved 2026-09-27): a deterministic re-drive failure
    lands in the row's `sync_error` from the first attempt, is re-driven up
    to MAX_EFFECTS_REDRIVE_FAILURES times, then no more — `effects_pending_at`
    is cleared, the error stays visible, and ERROR is logged once."""
    p = await _project(db_session)
    project_id = p.id
    row_id = await _owed_paid_invoice_row(db_session, project_id, idempotency_key="k-cap", heimdall_id="h-cap")
    _spy_effects(monkeypatch)
    attempts = []

    async def failing_record(db, pid, kind, **k):
        attempts.append(kind)
        raise RuntimeError("event table is gone")

    monkeypatch.setattr(svc, "record", failing_record)
    later = NOW + timedelta(seconds=svc.EFFECTS_REDRIVE_GRACE_SECONDS)
    cap = svc.MAX_EFFECTS_REDRIVE_FAILURES
    for i in range(cap + 2):
        caplog.clear()
        with caplog.at_level("WARNING", logger="backend.app.services.aito_terminal_payments"):
            await svc._redrive_settle_effects(db_session, now=later + timedelta(minutes=i), limit=10)
        stored = await db_session.get(AitoTerminalPayment, row_id)
        await db_session.refresh(stored)
        assert stored.sync_error == "Settle effects failed: event table is gone"
        errors = [r for r in caplog.records if r.levelname == "ERROR"]
        if i < cap - 1:
            assert stored.effects_pending_at == NOW
            assert errors == []
        elif i == cap - 1:
            assert stored.effects_pending_at is None
            assert len(errors) == 1 and "giving up" in errors[0].getMessage()
        else:
            assert stored.effects_pending_at is None
            assert caplog.records == []
    # Re-driven exactly `cap` times, never after.
    assert len(attempts) == cap
    assert row_id not in svc._redrive_failures
    # The panel's view carries the error.
    assert svc.terminal_view(stored).sync_error == "Settle effects failed: event table is gone"
    assert stored.status == "paid" and stored.settled_at == NOW


@pytest.mark.asyncio
async def test_a_redrive_that_recovers_before_the_cap_clears_the_error_and_runs_once(db_session, monkeypatch):
    """T-082: a success before the cap clears the `sync_error` the failed
    attempt wrote and completes the effects exactly once."""
    p = await _project(db_session)
    project_id = p.id
    row_id = await _owed_paid_invoice_row(db_session, project_id, idempotency_key="k-rec", heimdall_id="h-rec")
    notified, refreshed = _spy_effects(monkeypatch)
    real_record = svc.record
    calls = []

    async def flaky_record(*a, **k):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("database is locked")
        return await real_record(*a, **k)

    monkeypatch.setattr(svc, "record", flaky_record)
    later = NOW + timedelta(seconds=svc.EFFECTS_REDRIVE_GRACE_SECONDS)
    assert await svc._redrive_settle_effects(db_session, now=later, limit=10) == 0
    stored = await db_session.get(AitoTerminalPayment, row_id)
    await db_session.refresh(stored)
    assert stored.sync_error == "Settle effects failed: database is locked"
    assert stored.effects_pending_at == NOW

    assert await svc._redrive_settle_effects(db_session, now=later, limit=10) == 1
    await db_session.refresh(stored)
    assert stored.sync_error is None and stored.effects_pending_at is None
    assert row_id not in svc._redrive_failures
    assert len(await _events(db_session, project_id, "payment.terminal.paid")) == 1
    assert refreshed == [(project_id, "invoice")]

    assert await svc._redrive_settle_effects(db_session, now=later + timedelta(hours=1), limit=10) == 0
    assert len(await _events(db_session, project_id, "payment.terminal.paid")) == 1
    assert len(refreshed) == 1 and notified == []


@pytest.mark.asyncio
async def test_a_redrive_failure_record_that_itself_fails_does_not_end_the_pass(db_session, monkeypatch):
    """T-082: writing the failure is best effort — if that write fails too,
    the pass still returns and the marker stays for the next tick."""
    p = await _project(db_session)
    project_id = p.id
    row_id = await _owed_paid_invoice_row(db_session, project_id, idempotency_key="k-wf", heimdall_id="h-wf")
    _spy_effects(monkeypatch)

    async def failing_record(*a, **k):
        raise RuntimeError("event write failed")

    monkeypatch.setattr(svc, "record", failing_record)
    real_commit = db_session.commit
    commits = []

    async def failing_commit():
        commits.append(1)
        raise RuntimeError("database is locked")

    monkeypatch.setattr(db_session, "commit", failing_commit)
    later = NOW + timedelta(seconds=svc.EFFECTS_REDRIVE_GRACE_SECONDS)
    assert await svc._redrive_settle_effects(db_session, now=later, limit=10) == 0
    assert commits == [1]
    monkeypatch.setattr(db_session, "commit", real_commit)
    stored = await db_session.get(AitoTerminalPayment, row_id)
    await db_session.refresh(stored)
    assert stored.effects_pending_at == NOW and stored.sync_error is None
    assert svc._redrive_failures[row_id] == 1


# --- T-157: due pushes served between polled rows ------------------------------


def _open_row(project_id, key, heimdall_id):
    return AitoTerminalPayment(
        project_id=project_id,
        document_kind="invoice",
        document_id="i",
        document_number="FA",
        idempotency_key=key,
        heimdall_id=heimdall_id,
        amount=1,
        status="processing",
        created_at=NOW,
    )


@pytest.mark.asyncio
async def test_poll_open_serves_due_pushes_before_every_row(db_session):
    """A route waiting on its card's push waits for one Heimdall GET, not the
    whole 40-row pass. The serve may roll the shared session back (the loop's
    `_serve_due_pushes` does, on a failed drain): every row is re-fetched by id
    after it, so the pass still polls them all."""
    p = await _project(db_session)
    project_id = p.id
    db_session.add_all([_open_row(project_id, "k1", "h-1"), _open_row(project_id, "k2", "h-2")])
    await db_session.commit()
    seen = []

    def handler(request):
        hid = request.url.path.rsplit("/", 1)[-1]
        seen.append(hid)
        return httpx.Response(200, json=_payment(id=hid))

    async def serve(db):
        assert db is db_session
        seen.append("serve")
        await db.rollback()
        return 0

    heimdall_service._transport = httpx.MockTransport(handler)
    visited = await svc.poll_open_terminal_payments(db_session, now=NOW + timedelta(minutes=5), serve_due_pushes=serve)

    assert visited == 2
    assert seen == ["serve", "h-1", "serve", "h-2"]


@pytest.mark.asyncio
async def test_poll_open_serves_nothing_by_default(db_session):
    p = await _project(db_session)
    db_session.add(_open_row(p.id, "k1", "h-1"))
    await db_session.commit()
    seen = []

    def handler(request):
        seen.append(request.url.path.rsplit("/", 1)[-1])
        return httpx.Response(200, json=_payment(id="h-1"))

    heimdall_service._transport = httpx.MockTransport(handler)
    assert await svc.poll_open_terminal_payments(db_session, now=NOW + timedelta(minutes=5)) == 1
    assert seen == ["h-1"]
