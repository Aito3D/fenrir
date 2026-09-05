"""The hourly invoice sweep: one Books call per open invoice, stops when paid."""

from datetime import datetime

import pytest

from backend.app.models.aito_project import AitoProject
from backend.app.services import aito_invoice_sweep
from backend.app.services.aito_invoice_sweep import sweep_invoices
from backend.app.services.zoho import ZohoUpstreamError, zoho_service


@pytest.fixture(autouse=True)
def reset_gate():
    aito_invoice_sweep._last_run = 0.0
    yield
    aito_invoice_sweep._last_run = 0.0


def _invoice(balance: float, status: str = "unpaid", due: str = "2026-03-01") -> dict:
    return {
        "id": "INV1",
        "number": "INV-1",
        "date": "2026-02-01",
        "due_date": due,
        "total": 100.0,
        "balance": balance,
        "currency_code": "XPF",
        "status": status,
    }


async def _project(db, **fields) -> AitoProject:
    base = {
        "description": "x",
        "board_column": "finish",
        "position": 0,
        "status": "active",
        "client_id": "z1",
        "quote_id": "EST1",
        "quote_invoiced": True,
    }
    base.update(fields)
    row = AitoProject(**base)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


def _fake(responses: dict[str, list[dict] | Exception], calls: list[str]):
    async def list_project_invoices(db, estimate_id, customer_id):
        calls.append(estimate_id)
        out = responses.get(estimate_id, [])
        if isinstance(out, Exception):
            raise out
        return out

    return list_project_invoices


@pytest.mark.asyncio
async def test_selection_and_field_writes(db_session, monkeypatch):
    open_ = await _project(db_session, quote_id="EST-OPEN")
    paid = await _project(db_session, quote_id="EST-PAID", invoice_balance=0.0)
    not_invoiced = await _project(db_session, quote_id="EST-NO", quote_invoiced=False)
    trashed = await _project(db_session, quote_id="EST-TRASH", status="deleted")
    quoteless = await _project(db_session, quote_id=None)
    # Captured before expire_all(): an expired AsyncSession object can't
    # reload its own PK synchronously (MissingGreenlet), so `.id` has to be
    # read while the row is still fresh, not off the post-expire object.
    open_id, other_ids = open_.id, [paid.id, not_invoiced.id, trashed.id, quoteless.id]
    calls: list[str] = []
    monkeypatch.setattr(
        zoho_service, "list_project_invoices", _fake({"EST-OPEN": [_invoice(40.0, "partially_paid")]}, calls)
    )

    updated = await sweep_invoices(db_session, force=True)

    assert calls == ["EST-OPEN"]
    assert updated == 1
    db_session.expire_all()
    row = await db_session.get(AitoProject, open_id)
    assert (row.invoice_status, row.invoice_balance, row.invoice_due_date) == ("partially_paid", 40.0, "2026-03-01")
    assert isinstance(row.invoice_checked_at, datetime)
    for other_id in other_ids:
        assert (await db_session.get(AitoProject, other_id)).invoice_checked_at is None


@pytest.mark.asyncio
async def test_paid_drops_out_and_the_newest_invoice_wins(db_session, monkeypatch):
    p = await _project(db_session, quote_id="EST1")
    p_id = p.id  # captured before expire_all(); see note above
    calls: list[str] = []
    monkeypatch.setattr(
        zoho_service,
        "list_project_invoices",
        _fake({"EST1": [_invoice(0.0, "paid", "2026-03-10"), _invoice(100.0, "unpaid", "2026-01-01")]}, calls),
    )
    await sweep_invoices(db_session, force=True)
    db_session.expire_all()
    row = await db_session.get(AitoProject, p_id)
    assert (row.invoice_status, row.invoice_balance, row.invoice_due_date) == ("paid", 0.0, "2026-03-10")

    await sweep_invoices(db_session, force=True)
    assert calls == ["EST1"]  # paid: never asked again


@pytest.mark.asyncio
async def test_an_upstream_error_skips_one_project_only(db_session, monkeypatch):
    bad = await _project(db_session, quote_id="EST-BAD")
    good = await _project(db_session, quote_id="EST-GOOD")
    bad_id, good_id = bad.id, good.id  # captured before expire_all(); see note above
    monkeypatch.setattr(
        zoho_service,
        "list_project_invoices",
        _fake({"EST-BAD": ZohoUpstreamError("boom"), "EST-GOOD": [_invoice(10.0)]}, []),
    )
    updated = await sweep_invoices(db_session, force=True)
    assert updated == 1
    db_session.expire_all()
    assert (await db_session.get(AitoProject, bad_id)).invoice_checked_at is None
    assert (await db_session.get(AitoProject, good_id)).invoice_balance == 10.0


@pytest.mark.asyncio
async def test_a_malformed_payload_skips_one_project_only(db_session, monkeypatch):
    bad = await _project(db_session, quote_id="EST-BAD")
    good = await _project(db_session, quote_id="EST-GOOD")
    bad_id, good_id = bad.id, good.id  # captured before expire_all(); see note above
    bad_invoice = {"balance": "not-a-number", "status": "unpaid", "due_date": "2026-03-01"}
    monkeypatch.setattr(
        zoho_service,
        "list_project_invoices",
        _fake({"EST-BAD": [bad_invoice], "EST-GOOD": [_invoice(10.0)]}, []),
    )
    updated = await sweep_invoices(db_session, force=True)
    assert updated == 1
    db_session.expire_all()
    assert (await db_session.get(AitoProject, bad_id)).invoice_checked_at is None
    assert (await db_session.get(AitoProject, good_id)).invoice_balance == 10.0


@pytest.mark.asyncio
async def test_no_invoice_yet_still_stamps_checked_at(db_session, monkeypatch):
    p = await _project(db_session, quote_id="EST1")
    p_id = p.id  # captured before expire_all(); see note above
    monkeypatch.setattr(zoho_service, "list_project_invoices", _fake({}, []))
    await sweep_invoices(db_session, force=True)
    db_session.expire_all()
    row = await db_session.get(AitoProject, p_id)
    assert row.invoice_checked_at is not None
    assert row.invoice_status is None and row.invoice_balance is None


@pytest.mark.asyncio
async def test_the_hourly_gate_skips_a_second_pass(db_session, monkeypatch):
    await _project(db_session, quote_id="EST1")
    calls: list[str] = []
    monkeypatch.setattr(zoho_service, "list_project_invoices", _fake({"EST1": [_invoice(10.0)]}, calls))
    await sweep_invoices(db_session)
    await sweep_invoices(db_session)
    assert calls == ["EST1"]
    assert await sweep_invoices(db_session, force=True) == 1
    assert calls == ["EST1", "EST1"]
