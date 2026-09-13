"""expiry_date on the estimate Aito creates, its copy-back, and the
paid-retainer auto-accept read off the sweep's estimate."""

from datetime import date

import pytest

from backend.app.api.routes.settings import set_setting
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.services import aito_quote_sync
from backend.app.services.aito_quote_sync import _apply_estimate, _create_quote, _paid_retainer_total, expiry_for
from backend.app.services.zoho import zoho_service


async def _configure_zoho(db) -> None:
    for key, value in {
        "zoho_client_id": "1000.FAKE",
        "zoho_client_secret": "fake-secret",
        "zoho_refresh_token": "1000.fake.refresh",
        "zoho_organization_id": "999",
    }.items():
        await set_setting(db, key, value)
    await db.commit()


async def _pending_project(db) -> AitoProject:
    p = AitoProject(
        description="x", board_column="devis", position=0, status="active", client_id="z1", quote_sync_state="pending"
    )
    db.add(p)
    await db.commit()
    await db.refresh(p)
    db.add(AitoTask(project_id=p.id, position=0, title="t", scan_cost=5000.0))
    await db.commit()
    return p


def test_expiry_for_adds_validity_days_to_the_quote_date():
    assert expiry_for("2026-09-12", 15) == "2026-09-27"
    assert expiry_for(None, 15) == (date.today().fromordinal(date.today().toordinal() + 15)).isoformat()


def test_required_amount_is_the_total_or_the_ceiled_deposit_share():
    from backend.app.services.aito_payment_links import required_amount

    assert required_amount(12500.0, 0) == 12500
    assert required_amount(12500.4, 0) == 12500
    assert required_amount(12500.0, 30) == 3750
    assert required_amount(10001.0, 30) == 3001  # ceil, never a franc short
    assert required_amount(None, 0) is None and required_amount(0.0, 30) is None


def test_paid_retainer_total_sums_only_paid_entries():
    estimate = {
        "retainerinvoices": [
            {"status": "paid", "total": 3000},
            {"status": "sent", "total": 9000},
            {"status": "paid", "total": "1500.5"},
        ]
    }
    assert _paid_retainer_total(estimate) == 4500.5
    assert _paid_retainer_total({}) == 0.0


def test_apply_estimate_copies_expiry_back():
    p = AitoProject(description="x", board_column="devis", position=0)
    _apply_estimate(p, {"estimate_id": "E1", "expiry_date": "2026-09-27", "total": 1}, requeue_marker=0)
    assert p.quote_expiry_date == "2026-09-27"


@pytest.mark.asyncio
async def test_create_sends_expiry_date_from_the_setting(db_session, monkeypatch):
    await _configure_zoho(db_session)
    await set_setting(db_session, "aito_quote_validity_days", "20")
    await db_session.commit()
    p = await _pending_project(db_session)
    captured = {}

    async def fake_find(db, reference_number, client_id):
        return None

    async def fake_create(db, payload):
        captured.update(payload)
        return {
            "estimate_id": "E1",
            "estimate_number": "DEV-1",
            "date": "2026-09-12",
            "expiry_date": payload["expiry_date"],
            "status": "draft",
            "total": 5000,
            "is_inclusive_tax": True,
            "last_modified_time": "x",
        }

    async def noop(*a, **k):
        return {}

    monkeypatch.setattr(zoho_service, "find_estimate_by_reference", fake_find)
    monkeypatch.setattr(zoho_service, "create_estimate", fake_create)
    monkeypatch.setattr(zoho_service, "update_estimate_notes", noop)
    # get_catalogue is NOT patched: it reads the settings table, no network —
    # the same shape backend/tests/unit/test_aito_tracking_delivery.py relies on.
    await _create_quote(db_session, p)
    assert captured["expiry_date"] == expiry_for(date.today().isoformat(), 20)
    assert p.quote_expiry_date == captured["expiry_date"]


@pytest.mark.asyncio
async def test_sweep_accepts_when_paid_retainers_cover_the_required_amount(db_session, monkeypatch):
    await _configure_zoho(db_session)
    p = AitoProject(
        description="x",
        board_column="devis",
        position=0,
        status="active",
        client_id="z1",
        quote_id="EST1",
        quote_number="DEV-1",
        quote_total=10000.0,
        quote_status="sent",
        quote_sync_state="idle",
    )
    db_session.add(p)
    await db_session.commit()
    await db_session.refresh(p)

    async def fake_get_estimate(db, estimate_id):
        return {
            "estimate_id": "EST1",
            "status": "sent",
            "total": 10000,
            "is_inclusive_tax": True,
            "retainerinvoices": [{"status": "paid", "total": 10000}],
            "last_modified_time": "x",
        }

    async def ok(db, estimate_id, target, current=None):
        return None

    monkeypatch.setattr(zoho_service, "get_estimate", fake_get_estimate)
    monkeypatch.setattr(zoho_service, "advance_estimate_status", ok)
    monkeypatch.setattr(zoho_service, "books_app_url", ok)
    await aito_quote_sync.sync_project(db_session, p)
    await db_session.refresh(p)
    assert p.retainer_paid_total == 10000.0
    assert p.quote_status == "accepted"
