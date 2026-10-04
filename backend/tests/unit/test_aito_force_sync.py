"""POST /aito/{id}/force-sync: check every Zoho-backed part of a card, fix
what drifted, report per step."""

import pytest
from sqlalchemy import select

from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.services import aito_quote_sync
from backend.app.services.aito_invoice_sweep import DepositSettlement, settle_deposits as real_settle_deposits
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
        # Like the worker: a pending card comes back settled (nothing changed).
        from backend.app.core import database as dbmod

        async with dbmod.async_session() as other:
            row = await other.get(AitoProject, project_id)
            if row.quote_sync_state == "pending":
                row.quote_sync_state = "locked" if row.quote_invoiced else "idle"
                await other.commit()
        return state["flush"]

    async def read_customer_credit(db, customer_id, cache=None):
        if isinstance(state["credit"], Exception):
            raise state["credit"]
        return state["credit"]

    async def list_project_invoices(db, estimate_id, customer_id):
        return state["invoices"]

    async def settle(db, project_id, quote_id, invoice, quote_number=None):
        return DepositSettlement(state["settled"] or invoice, 0.0)

    async def is_configured(db):
        return False

    async def reconcile(db, **kw):
        state["reconciled"].append(kw)
        return 1

    monkeypatch.setattr(aito_quote_sync, "flush_and_wait", flush_and_wait)
    monkeypatch.setattr(aito_quote_sync, "can_flush", lambda: True)
    monkeypatch.setattr("backend.app.services.aito_force_sync.read_customer_credit", read_customer_credit)
    monkeypatch.setattr(zoho_service, "list_project_invoices", list_project_invoices)
    monkeypatch.setattr("backend.app.services.aito_invoice_sweep.settle_deposits", settle)

    async def zoho_configured(db):
        return True

    monkeypatch.setattr(zoho_service, "is_configured", zoho_configured)
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
    stubs["invoices"] = [
        {"id": "INV1", "number": "FA-1", "balance": 7000.0, "status": "draft", "due_date": "", "currency_code": "XPF"}
    ]
    stubs["settled"] = {"id": "INV1", "number": "FA-1", "balance": 0.0, "status": "paid", "due_date": ""}
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    assert _by_key(r.json())["invoice"]["outcome"] == "fixed"
    assert _by_key(r.json())["invoice"]["detail"] == {
        "number": "FA-1",
        "balance_before": 7000.0,
        "balance_after": 0.0,
        "currency_code": "XPF",
    }


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
    await db_session.refresh(p)
    assert p.quote_sync_state == "idle"
    queued = (
        (
            await db_session.execute(
                select(AitoEvent).where(AitoEvent.project_id == p.id, AitoEvent.kind == "sync.queued")
            )
        )
        .scalars()
        .all()
    )
    assert queued == []


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


def _leave_row(monkeypatch, **columns):
    """A flush that lands as the worker would: columns written and committed
    through a separate session before the waiter is released."""
    from backend.app.core import database as dbmod

    async def flush_and_wait(project_id, *a, **k):
        async with dbmod.async_session() as other:
            row = await other.get(AitoProject, project_id)
            for k_, v in columns.items():
                setattr(row, k_, v)
            await other.commit()
        return True

    monkeypatch.setattr(aito_quote_sync, "flush_and_wait", flush_and_wait)


@pytest.mark.asyncio
async def test_pending_after_flush_without_error_is_rate_limited(async_client, db_session, stubs, monkeypatch):
    p = await _project(db_session, quote_sync_state="idle", quote_invoiced=False)
    _leave_row(monkeypatch, quote_sync_state="pending", quote_sync_error=None)
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    steps = _by_key(r.json())
    assert steps["quote"] == {"key": "quote", "outcome": "failed", "detail": {"reason": "rate_limited"}}
    assert steps["credit"]["detail"] == {"reason": "rate_limited"}
    assert steps["credit"]["outcome"] == "skipped"
    assert steps["invoice"] == {"key": "invoice", "outcome": "skipped", "detail": {"reason": "rate_limited"}}


@pytest.mark.asyncio
async def test_pending_after_flush_with_error_is_upstream(async_client, db_session, stubs, monkeypatch):
    p = await _project(db_session, quote_sync_state="idle", quote_invoiced=False)
    _leave_row(monkeypatch, quote_sync_state="pending", quote_sync_error="Books is down")
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    assert _by_key(r.json())["quote"] == {
        "key": "quote",
        "outcome": "failed",
        "detail": {"reason": "upstream", "message": "Books is down"},
    }


@pytest.mark.asyncio
async def test_cleared_error_counts_as_fixed(async_client, db_session, stubs, monkeypatch):
    p = await _project(db_session, quote_sync_state="error", quote_sync_error="boom", quote_invoiced=False)
    _leave_row(monkeypatch, quote_sync_state="idle", quote_sync_error=None)
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    assert _by_key(r.json())["quote"] == {"key": "quote", "outcome": "fixed", "detail": {"error_cleared": True}}


@pytest.mark.asyncio
async def test_failed_deposit_application_is_failed(async_client, db_session, stubs, monkeypatch):
    p = await _project(db_session)
    invoice = {"id": "INV1", "number": "FA-1", "balance": 7000.0, "status": "draft", "due_date": ""}
    stubs["invoices"] = [invoice]

    async def settle(db, project_id, quote_id, inv, quote_number=None):
        return DepositSettlement(inv, None)

    monkeypatch.setattr("backend.app.services.aito_invoice_sweep.settle_deposits", settle)
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    assert _by_key(r.json())["invoice"] == {"key": "invoice", "outcome": "failed", "detail": {"reason": "unreachable"}}


@pytest.mark.asyncio
async def test_unreachable_credit_fails_and_unconfigured_zoho_skips(async_client, db_session, stubs, monkeypatch):
    p = await _project(db_session)
    stubs["credit"] = None
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    assert _by_key(r.json())["credit"] == {"key": "credit", "outcome": "failed", "detail": {"reason": "unreachable"}}

    async def not_configured(db):
        return False

    monkeypatch.setattr(zoho_service, "is_configured", not_configured)
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    assert _by_key(r.json())["credit"] == {
        "key": "credit",
        "outcome": "skipped",
        "detail": {"reason": "not_configured"},
    }


@pytest.mark.asyncio
async def test_links_pass_that_visited_nothing_is_rate_limited(async_client, db_session, stubs, monkeypatch):
    p = await _project(db_session)

    async def heimdall_on(db):
        return True

    async def reconcile(db, **kw):
        return 0

    monkeypatch.setattr(heimdall_service, "is_configured", heimdall_on)
    monkeypatch.setattr("backend.app.services.aito_payment_links.reconcile_payment_links", reconcile)
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    assert _by_key(r.json())["payment_links"] == {
        "key": "payment_links",
        "outcome": "skipped",
        "detail": {"reason": "rate_limited"},
    }


@pytest.mark.asyncio
async def test_books_refusing_the_deposit_is_failed_refused(async_client, db_session, stubs, monkeypatch):
    """The REAL settle: a linked deposit with something to spend, an open
    balance, and Books rejecting the application -> failed, not in_sync."""
    from backend.app.services.zoho import ZohoRequestRejected

    monkeypatch.setattr("backend.app.services.aito_invoice_sweep.settle_deposits", real_settle_deposits)
    stubs["invoices"] = [{"id": "INV1", "number": "FA-1", "balance": 7000.0, "status": "draft", "due_date": ""}]

    async def get_estimate(db, estimate_id):
        return {"estimate_id": "EST1", "customer_id": "z1", "retainerinvoices": [{"retainerinvoice_id": "RET1"}]}

    async def list_customer_payments(db, customer_id):
        return [
            {
                "payment_id": "P1",
                "payment_number": "1",
                "retainerinvoice_id": "RET1",
                "amount": 7000.0,
                "unused_amount": 7000.0,
                "date": "2026-09-01",
            }
        ]

    async def list_customer_retainers(db, customer_id):
        return [{"retainerinvoice_id": "RET1", "retainerinvoice_number": "RET-1", "reference_number": ""}]

    attempts: list = []

    async def refuse(db, invoice_id, invoice_payments):
        attempts.append(invoice_payments)
        raise ZohoRequestRejected("Books said no")

    for name, fn in {
        "get_estimate": get_estimate,
        "list_customer_payments": list_customer_payments,
        "list_customer_retainers": list_customer_retainers,
        "apply_invoice_credits": refuse,
    }.items():
        monkeypatch.setattr(zoho_service, name, fn)

    p = await _project(db_session)
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    assert r.status_code == 200, r.text
    assert attempts, "the real settle must have tried Books"
    assert _by_key(r.json())["invoice"] == {"key": "invoice", "outcome": "failed", "detail": {"reason": "refused"}}


@pytest.mark.asyncio
async def test_rate_limit_after_a_deposit_landed_keeps_its_event(async_client, db_session, stubs, monkeypatch):
    """The settle applied money and recorded the event, then its re-read hit a
    429: the event is committed, the rest of the Zoho steps stand down."""
    from backend.app.services import aito_events

    p = await _project(db_session)
    pid = p.id
    stubs["invoices"] = [{"id": "INV1", "number": "FA-1", "balance": 7000.0, "status": "draft", "due_date": ""}]
    monkeypatch.setattr(aito_quote_sync, "_arm_rate_limit_throttle", lambda e: None)

    async def settle(db, project_id, quote_id, invoice, quote_number=None):
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

    monkeypatch.setattr("backend.app.services.aito_invoice_sweep.settle_deposits", settle)
    r = await async_client.post(f"/api/v1/aito/{pid}/force-sync")
    assert r.status_code == 200, r.text
    assert _by_key(r.json())["invoice"]["detail"] == {"reason": "rate_limited"}
    db_session.expire_all()
    rows = (
        (
            await db_session.execute(
                select(AitoEvent).where(AitoEvent.project_id == pid, AitoEvent.kind == "invoice.deposit_applied")
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_unexpected_error_in_a_step_is_reported_not_a_500(async_client, db_session, stubs):
    p = await _project(db_session)
    stubs["credit"] = RuntimeError("bug")
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    assert r.status_code == 200, r.text
    steps = _by_key(r.json())
    assert steps["credit"] == {"key": "credit", "outcome": "failed", "detail": {"reason": "internal"}}
    assert steps["invoice"]["outcome"] == "in_sync"  # the next step still ran


@pytest.mark.asyncio
async def test_a_failed_commit_in_a_step_leaves_the_session_usable(async_client, db_session, stubs, monkeypatch):
    p = await _project(db_session)
    pid = p.id

    async def poisoning_credit_step(db, project):
        # A duplicate primary key: the flush fails and the session needs a rollback.
        db.add(AitoProject(id=project.id, description="dup", board_column="finish", position=0, status="active"))
        await db.commit()

    monkeypatch.setattr("backend.app.services.aito_force_sync._credit_step", poisoning_credit_step)
    stubs["invoices"] = [{"id": "INV1", "number": "FA-1", "balance": 7000.0, "status": "draft", "due_date": ""}]
    stubs["settled"] = {"id": "INV1", "number": "FA-1", "balance": 0.0, "status": "paid", "due_date": ""}
    r = await async_client.post(f"/api/v1/aito/{pid}/force-sync")
    assert r.status_code == 200, r.text
    steps = _by_key(r.json())
    assert steps["credit"]["detail"] == {"reason": "internal"}
    assert steps["invoice"]["outcome"] == "fixed"
    db_session.expire_all()
    row = await db_session.get(AitoProject, pid)
    assert row.invoice_balance == 0.0


@pytest.mark.asyncio
async def test_force_sync_broadcasts_the_board_change(async_client, db_session, stubs, monkeypatch):
    p = await _project(db_session)
    seen: list = []

    async def fake_broadcast(action, project_id, actor):
        seen.append((action, project_id))

    monkeypatch.setattr("backend.app.api.routes.aito._broadcast_changed", fake_broadcast)
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    assert r.status_code == 200
    assert seen == [("invoice", p.id)]


@pytest.mark.asyncio
async def test_force_sync_is_rate_limited_per_user(async_client, db_session, stubs):
    from backend.app.api.routes import aito as aito_routes

    p = await _project(db_session)
    for _ in range(aito_routes._FORCE_SYNC_MAX_CALLS):
        r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
        assert r.status_code == 200, r.text
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    assert r.status_code == 429
    assert r.json()["detail"] == aito_routes._FORCE_SYNC_DETAIL
