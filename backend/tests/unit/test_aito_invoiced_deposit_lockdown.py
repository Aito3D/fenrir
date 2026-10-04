"""Once a card is invoiced its quote deposit can no longer be collected from
the panel, and a deposit that lands anyway goes onto the invoice at once."""

import pytest

from backend.app.models.aito_project import AitoProject
from backend.app.services import aito_manual_payments, aito_payment_links
from backend.app.services.zoho import zoho_service
from backend.tests.unit.test_aito_invoice_create import (
    _project as _invoice_project,
    books,  # noqa: F401 — fixture reused as-is
)


async def _project(db, **fields) -> AitoProject:
    base = {
        "description": "x",
        "board_column": "finish",
        "position": 0,
        "status": "active",
        "client_id": "z1",
        "quote_id": "EST1",
        "quote_number": "DEV26-1",
        "quote_invoiced": True,
    }
    base.update(fields)
    row = AitoProject(**base)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@pytest.mark.asyncio
async def test_manual_quote_payment_on_invoiced_card_is_refused(async_client, db_session, monkeypatch):
    p = await _project(db_session)

    async def resolve(*_a, **_k):  # never reached
        raise AssertionError("document must not be resolved")

    monkeypatch.setattr("backend.app.api.routes.aito_payments.resolve_document", resolve)
    r = await async_client.post(
        f"/api/v1/aito/{p.id}/manual-payment",
        json={"document_kind": "quote", "document_id": "EST1", "mode": "cash", "amount": 1000},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "quote_invoiced"


@pytest.mark.asyncio
async def test_terminal_quote_payment_on_invoiced_card_is_refused(async_client, db_session, monkeypatch):
    p = await _project(db_session)

    async def resolve(*_a, **_k):
        raise AssertionError("document must not be resolved")

    monkeypatch.setattr("backend.app.api.routes.aito_payments.resolve_document", resolve)
    r = await async_client.post(
        f"/api/v1/aito/{p.id}/terminal-payment",
        json={"document_kind": "quote", "document_id": "EST1", "amount": 1000},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "quote_invoiced"


@pytest.mark.asyncio
async def test_quote_payment_refresh_settles_the_open_invoice(db_session, monkeypatch):
    p = await _project(db_session)
    settled: list[str] = []

    async def fake_sync_project(db, project, *a, **k):
        return None

    async def list_project_invoices(db, estimate_id, customer_id):
        return [{"id": "INV1", "number": "FA-1", "balance": 7000.0, "status": "draft", "due_date": "2026-10-10"}]

    async def fake_settle(db, project_id, quote_id, invoice, quote_number=None):
        settled.append(invoice["id"])
        return {**invoice, "balance": 0.0, "status": "paid"}, 0.0

    monkeypatch.setattr("backend.app.services.aito_quote_sync.sync_project", fake_sync_project)
    monkeypatch.setattr(zoho_service, "list_project_invoices", list_project_invoices)
    monkeypatch.setattr("backend.app.services.aito_invoice_sweep.settle_with_deposits", fake_settle)

    await aito_manual_payments.refresh_after_payment(db_session, p.id, "quote")

    assert settled == ["INV1"]
    await db_session.refresh(p)
    assert (p.invoice_status, p.invoice_balance) == ("paid", 0.0)


@pytest.mark.asyncio
async def test_quote_payment_refresh_leaves_uninvoiced_card_alone(db_session, monkeypatch):
    p = await _project(db_session, quote_invoiced=False)

    async def fake_sync_project(db, project, *a, **k):
        return None

    async def boom(*_a, **_k):
        raise AssertionError("no invoice read for an uninvoiced card")

    monkeypatch.setattr("backend.app.services.aito_quote_sync.sync_project", fake_sync_project)
    monkeypatch.setattr(zoho_service, "list_project_invoices", boom)
    await aito_manual_payments.refresh_after_payment(db_session, p.id, "quote")


@pytest.mark.asyncio
async def test_paid_quote_link_on_invoiced_card_runs_the_refresh(db_session, monkeypatch):
    from backend.app.models.aito_payment_link import AitoPaymentLink

    p = await _project(db_session)
    row = AitoPaymentLink(
        project_id=p.id,
        idempotency_key="k1",
        reference="DEV26-1",
        document_kind="quote",
        amount=7000,
        expires_on="2026-12-31",
        status="paid",
    )
    db_session.add(row)
    await db_session.commit()
    calls: list[tuple[int, str]] = []

    async def fake_refresh(db, project_id, kind):
        calls.append((project_id, kind))

    async def fake_accept(*_a, **_k):
        return None

    monkeypatch.setattr(aito_manual_payments, "refresh_after_payment", fake_refresh)
    monkeypatch.setattr("backend.app.services.aito_quote_status.accept_quote", fake_accept)
    from datetime import datetime

    await aito_payment_links._became_paid(db_session, row, now=datetime(2026, 10, 3))
    assert calls == [(p.id, "quote")]


@pytest.mark.asyncio
async def test_create_invoice_reconciles_the_card_links_at_once(async_client, db_session, books, monkeypatch):
    """The create route cancels the card's now-moot deposit link immediately:
    reconcile_payment_links for this card with force=True after the flip."""
    calls: list[dict] = []

    async def fake_reconcile(db, **kw):
        calls.append(kw)
        return 1

    monkeypatch.setattr("backend.app.api.routes.aito.reconcile_payment_links", fake_reconcile)
    pid = await _invoice_project(db_session)

    response = await async_client.post(f"/api/v1/aito/{pid}/invoice")

    assert response.status_code == 200
    assert any(c.get("only_project_id") == pid and c.get("force") is True for c in calls)


@pytest.mark.asyncio
async def test_settle_failure_after_apply_still_commits_and_broadcasts(db_session, monkeypatch):
    """The late-deposit settle applied money and recorded its event, then its
    re-read hit a 429: the event and sync_project's work are committed, the
    board is told, and the shared throttle is armed."""
    from sqlalchemy import select

    from backend.app.models.aito_event import AitoEvent
    from backend.app.services import aito_events, aito_quote_sync
    from backend.app.services.zoho import ZohoRateLimited

    p = await _project(db_session)
    pid = p.id

    async def fake_sync_project(db, project, *a, **k):
        project.retainer_paid_total = 7000.0

    async def list_project_invoices(db, estimate_id, customer_id):
        return [{"id": "INV1", "number": "FA-1", "balance": 7000.0, "status": "draft", "due_date": "2026-10-10"}]

    async def fake_settle(db, project_id, quote_id, invoice, quote_number=None):
        await aito_events.record(
            db,
            project_id,
            "invoice.deposit_applied",
            actor_class="system",
            subject_type="project",
            subject_id=project_id,
            detail={"retainer_number": "RET-1", "invoice_number": "FA-1", "amount": 7000.0},
        )
        raise ZohoRateLimited("429", retry_after=30.0, code=429)

    armed: list = []
    broadcasts: list = []

    async def fake_broadcast(db):
        broadcasts.append(db)

    monkeypatch.setattr("backend.app.services.aito_quote_sync.sync_project", fake_sync_project)
    monkeypatch.setattr(zoho_service, "list_project_invoices", list_project_invoices)
    monkeypatch.setattr("backend.app.services.aito_invoice_sweep.settle_with_deposits", fake_settle)
    monkeypatch.setattr(aito_quote_sync, "_arm_rate_limit_throttle", lambda e: armed.append(e))
    monkeypatch.setattr(aito_manual_payments, "broadcast_pending", fake_broadcast)

    await aito_manual_payments.refresh_after_payment(db_session, pid, "quote")

    await db_session.rollback()  # anything left uncommitted is gone now
    events = (
        (
            await db_session.execute(
                select(AitoEvent).where(AitoEvent.project_id == pid, AitoEvent.kind == "invoice.deposit_applied")
            )
        )
        .scalars()
        .all()
    )
    assert len(events) == 1
    row = await db_session.get(AitoProject, pid)
    await db_session.refresh(row)
    assert row.retainer_paid_total == 7000.0
    assert broadcasts and armed


@pytest.mark.asyncio
async def test_settle_generic_failure_still_commits_sync_work(db_session, monkeypatch):
    from backend.app.services.zoho import ZohoUpstreamError

    p = await _project(db_session)
    pid = p.id

    async def fake_sync_project(db, project, *a, **k):
        project.retainer_paid_total = 3000.0

    async def boom(db, estimate_id, customer_id):
        raise ZohoUpstreamError("Books is down")

    broadcasts: list = []

    async def fake_broadcast(db):
        broadcasts.append(db)

    monkeypatch.setattr("backend.app.services.aito_quote_sync.sync_project", fake_sync_project)
    monkeypatch.setattr(zoho_service, "list_project_invoices", boom)
    monkeypatch.setattr(aito_manual_payments, "broadcast_pending", fake_broadcast)

    await aito_manual_payments.refresh_after_payment(db_session, pid, "quote")

    await db_session.rollback()
    row = await db_session.get(AitoProject, pid)
    await db_session.refresh(row)
    assert row.retainer_paid_total == 3000.0
    assert broadcasts
