from datetime import datetime

import pytest

from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.services import aito_payment_links as svc
from backend.app.services.heimdall import LinkView, heimdall_service


async def _create(client, **overrides):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "+689 87 00 00 01",
    }
    payload.update(overrides)
    r = await client.post("/api/v1/aito/", json=payload)
    assert r.status_code == 201, r.text
    return r.json()


@pytest.mark.asyncio
async def test_board_and_detail_carry_the_current_link(async_client, db_session):
    p = await _create(async_client)
    db_session.add(
        AitoPaymentLink(
            project_id=p["id"],
            idempotency_key=f"aito:{p['id']}:1",
            heimdall_id="L0",
            reference="OLD",
            amount=1,
            expires_on="2026-09-01",
            status="expired",
            superseded_at=datetime(2026, 9, 2),
        )
    )
    db_session.add(
        AitoPaymentLink(
            project_id=p["id"],
            idempotency_key=f"aito:{p['id']}:2",
            heimdall_id="L1",
            reference="DEV-1",
            amount=12500,
            expires_on="2026-09-27",
            url="https://osb/pay/L1",
            status="pending",
        )
    )
    await db_session.commit()
    board = (await async_client.get("/api/v1/aito/")).json()
    card = next(c for c in board if c["id"] == p["id"])
    assert card["payment_link"] == {
        "state": "pending",
        "amount": 12500,
        "currency": "XPF",
        "url": "https://osb/pay/L1",
        "expires_on": "2026-09-27",
        "paid_at": None,
        "sync_error": None,
    }
    assert card["quote_expiry_date"] is None and card["retainer_paid_total"] is None
    # No GET /api/v1/aito/{project_id} exists in this codebase — the detail
    # panel is populated from the board list cache. A no-op PATCH exercises
    # the same _project_response code path a single-project fetch would.
    detail = (await async_client.patch(f"/api/v1/aito/{p['id']}", json={})).json()
    assert detail["payment_link"]["url"] == "https://osb/pay/L1"


@pytest.mark.asyncio
async def test_no_link_is_null(async_client):
    p = await _create(async_client)
    assert (await async_client.patch(f"/api/v1/aito/{p['id']}", json={})).json()["payment_link"] is None


@pytest.mark.asyncio
async def test_refresh_route_reconciles_one_project(async_client, db_session, monkeypatch):
    from backend.app.api.routes.settings import set_setting

    await set_setting(db_session, "heimdall_base_url", "http://pos:8081")
    await set_setting(db_session, "heimdall_api_token", "hmd_live.84f32b71ac095ed2.s3cret")
    await db_session.commit()
    p = await _create(async_client)
    # Give it a quote the reconciler will want a link for.
    from sqlalchemy import update

    from backend.app.models.aito_project import AitoProject

    await db_session.execute(
        update(AitoProject)
        .where(AitoProject.id == p["id"])
        .values(quote_number="DEV-7", quote_total=5000.0, quote_status="sent")
    )
    await db_session.commit()

    async def create_link(db, *, idempotency_key, reference, amount, expires_in_days):
        return LinkView(
            id="L9",
            status="pending",
            amount=amount,
            currency="XPF",
            reference=reference,
            url="https://osb/pay/L9",
            expires_at=None,
        )

    async def get_payment(db, heimdall_id):
        return LinkView(
            id="L9",
            status="pending",
            amount=5000,
            currency="XPF",
            reference="DEV-7",
            url="https://osb/pay/L9",
            expires_at=None,
        )

    monkeypatch.setattr(heimdall_service, "create_link", create_link)
    monkeypatch.setattr(heimdall_service, "get_payment", get_payment)
    svc._throttled_until = None
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link/refresh")
    assert r.status_code == 200, r.text
    assert r.json()["payment_link"]["url"] == "https://osb/pay/L9"


@pytest.mark.asyncio
async def test_refresh_404s_an_unknown_project(async_client):
    r = await async_client.post("/api/v1/aito/999999/payment-link/refresh")
    assert r.status_code == 404
