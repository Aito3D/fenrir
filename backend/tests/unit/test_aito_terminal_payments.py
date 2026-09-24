# backend/tests/unit/test_aito_terminal_payments.py
import asyncio
import json
from datetime import datetime, timedelta

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.api.routes.settings import set_setting
from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_terminal_payment import AitoTerminalPayment
from backend.app.services import aito_terminal_payments as svc
from backend.app.services.aito_payment_documents import PaymentDocument
from backend.app.services.heimdall import (
    HeimdallConflict,
    HeimdallNotConfigured,
    HeimdallRateLimited,
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
