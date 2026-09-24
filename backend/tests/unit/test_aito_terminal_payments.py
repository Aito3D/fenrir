# backend/tests/unit/test_aito_terminal_payments.py
from datetime import datetime, timedelta

import httpx
import pytest
from sqlalchemy import select

from backend.app.api.routes.settings import set_setting
from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_terminal_payment import AitoTerminalPayment
from backend.app.services import aito_terminal_payments as svc
from backend.app.services.aito_payment_documents import PaymentDocument
from backend.app.services.heimdall import HeimdallConflict, LinkView, heimdall_service

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
async def test_start_refuses_while_a_row_is_open_or_needs_attention(db_session):
    p = await _project(db_session)
    for status in ("processing", "needs_attention"):
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
