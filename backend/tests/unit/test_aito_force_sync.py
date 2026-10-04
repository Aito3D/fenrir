"""POST /aito/{id}/force-sync: check every Zoho-backed part of a card, fix
what drifted, report per step."""

import pytest
from sqlalchemy import select

from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.services import aito_quote_sync
from backend.app.services.heimdall import heimdall_service
from backend.app.services.zoho import ZohoRateLimited, zoho_service


@pytest.fixture(autouse=True)
def _clear_rate_limit():
    from backend.app.api.routes import aito as aito_routes

    aito_routes._ai_rate_limit_calls.clear()
    yield
    aito_routes._ai_rate_limit_calls.clear()


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
        "quote_sync_state": "locked",
        "quote_total": 14000.0,
        "customer_credit_total": 0.0,
    }
    base.update(fields)
    row = AitoProject(**base)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@pytest.fixture
def stubs(monkeypatch):
    """Default: everything in sync, Heimdall not configured."""
    state = {"credit": 0.0, "invoices": [], "flush": True, "settled": None, "reconciled": []}

    async def flush_and_wait(project_id, *a, **k):
        return state["flush"]

    async def read_customer_credit(db, customer_id, cache=None):
        if isinstance(state["credit"], Exception):
            raise state["credit"]
        return state["credit"]

    async def list_project_invoices(db, estimate_id, customer_id):
        return state["invoices"]

    async def settle(db, project_id, quote_id, invoice, quote_number=None):
        return (state["settled"] or invoice), 0.0

    async def is_configured(db):
        return False

    async def reconcile(db, **kw):
        state["reconciled"].append(kw)
        return 1

    monkeypatch.setattr(aito_quote_sync, "flush_and_wait", flush_and_wait)
    monkeypatch.setattr(aito_quote_sync, "can_flush", lambda: True)
    monkeypatch.setattr("backend.app.services.aito_force_sync.read_customer_credit", read_customer_credit)
    monkeypatch.setattr(zoho_service, "list_project_invoices", list_project_invoices)
    monkeypatch.setattr("backend.app.services.aito_invoice_sweep.settle_with_deposits", settle)
    monkeypatch.setattr(heimdall_service, "is_configured", is_configured)
    monkeypatch.setattr("backend.app.services.aito_payment_links.reconcile_payment_links", reconcile)
    return state


def _by_key(body):
    return {s["key"]: s for s in body["steps"]}


@pytest.mark.asyncio
async def test_everything_in_sync(async_client, db_session, stubs):
    p = await _project(db_session)
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    assert r.status_code == 200, r.text
    steps = _by_key(r.json())
    assert [s["key"] for s in r.json()["steps"]] == ["quote", "credit", "invoice", "payment_links"]
    assert steps["quote"]["outcome"] == "in_sync"
    assert steps["credit"]["outcome"] == "in_sync"
    assert steps["invoice"]["outcome"] == "in_sync"
    assert steps["payment_links"] == {
        "key": "payment_links",
        "outcome": "skipped",
        "detail": {"reason": "not_configured"},
    }


@pytest.mark.asyncio
async def test_credit_drift_is_fixed(async_client, db_session, stubs):
    p = await _project(db_session, customer_credit_total=500.0)
    stubs["credit"] = 7000.0
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    assert _by_key(r.json())["credit"] == {
        "key": "credit",
        "outcome": "fixed",
        "detail": {"before": 500.0, "after": 7000.0},
    }
    await db_session.refresh(p)
    assert p.customer_credit_total == 7000.0


@pytest.mark.asyncio
async def test_deposit_applied_to_invoice_is_fixed(async_client, db_session, stubs):
    p = await _project(db_session)
    stubs["invoices"] = [{"id": "INV1", "number": "FA-1", "balance": 7000.0, "status": "draft", "due_date": ""}]
    stubs["settled"] = {"id": "INV1", "number": "FA-1", "balance": 0.0, "status": "paid", "due_date": ""}
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    assert _by_key(r.json())["invoice"]["outcome"] == "fixed"
    assert _by_key(r.json())["invoice"]["detail"] == {"number": "FA-1", "balance_before": 7000.0, "balance_after": 0.0}


@pytest.mark.asyncio
async def test_worker_unavailable_fails_the_quote_step_only(async_client, db_session, stubs, monkeypatch):
    p = await _project(db_session, quote_sync_state="idle", quote_invoiced=False)
    monkeypatch.setattr(aito_quote_sync, "can_flush", lambda: False)
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    steps = _by_key(r.json())
    assert steps["quote"] == {"key": "quote", "outcome": "failed", "detail": {"reason": "worker_unavailable"}}
    assert steps["credit"]["outcome"] == "in_sync"
    assert steps["invoice"] == {"key": "invoice", "outcome": "skipped", "detail": {"reason": "not_invoiced"}}


@pytest.mark.asyncio
async def test_rate_limit_skips_the_remaining_zoho_steps(async_client, db_session, stubs, monkeypatch):
    p = await _project(db_session)
    stubs["credit"] = ZohoRateLimited("429", retry_after=30.0, code=429)
    armed: list = []
    monkeypatch.setattr(aito_quote_sync, "_arm_rate_limit_throttle", lambda e: armed.append(e))

    async def heimdall_on(db):
        return True

    monkeypatch.setattr(heimdall_service, "is_configured", heimdall_on)
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    steps = _by_key(r.json())
    assert steps["credit"] == {"key": "credit", "outcome": "failed", "detail": {"reason": "rate_limited"}}
    assert steps["invoice"] == {"key": "invoice", "outcome": "skipped", "detail": {"reason": "rate_limited"}}
    assert steps["payment_links"]["outcome"] in ("in_sync", "fixed")  # Heimdall still runs
    assert armed and stubs["reconciled"]


@pytest.mark.asyncio
async def test_unmanaged_card_skips_the_quote(async_client, db_session, stubs):
    p = await _project(db_session, quote_sync_state="unmanaged")
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    assert _by_key(r.json())["quote"] == {"key": "quote", "outcome": "skipped", "detail": {"reason": "unmanaged"}}


@pytest.mark.asyncio
async def test_no_quote_skips_every_zoho_step(async_client, db_session, stubs):
    p = await _project(db_session, quote_id=None, quote_number=None, quote_invoiced=False, quote_sync_state="idle")
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    steps = _by_key(r.json())
    assert steps["quote"]["detail"] == {"reason": "no_quote"}
    assert steps["invoice"]["outcome"] == "skipped"


@pytest.mark.asyncio
async def test_trashed_card_is_404(async_client, db_session, stubs):
    p = await _project(db_session, status="deleted")
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_records_one_event(async_client, db_session, stubs):
    p = await _project(db_session)
    await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    rows = (
        (
            await db_session.execute(
                select(AitoEvent).where(AitoEvent.project_id == p.id, AitoEvent.kind == "project.force_synced")
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1
    assert rows[0].detail["steps"]["quote"] == "in_sync"
