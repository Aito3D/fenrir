from datetime import datetime

import pytest

from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.services import aito_payment_links as svc
from backend.app.services.heimdall import LinkView, heimdall_service


@pytest.fixture(autouse=True)
def _reset_refresh_rate_limit():
    """The limiter's bucket dict is module-level state that outlives a test —
    clear it so one test's Retry calls never count against another's budget."""
    from backend.app.api.routes import aito as aito_routes

    aito_routes._ai_rate_limit_calls.clear()
    yield
    aito_routes._ai_rate_limit_calls.clear()


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
        "minted": True,
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


@pytest.mark.asyncio
async def test_refresh_reaches_heimdall_for_a_backed_off_row(async_client, db_session, monkeypatch):
    """Retry is only OFFERED while the row carries a sync_error — i.e. while it
    is inside its own backoff window. The loop's pass must skip such a row; the
    route's pass (force=True) must not, or the button does nothing for 5–30
    minutes."""
    from backend.app.api.routes.settings import set_setting

    await set_setting(db_session, "heimdall_base_url", "http://pos:8081")
    await set_setting(db_session, "heimdall_api_token", "hmd_live.84f32b71ac095ed2.s3cret")
    await db_session.commit()
    p = await _create(async_client)
    from sqlalchemy import update

    from backend.app.models.aito_project import AitoProject

    await db_session.execute(
        update(AitoProject)
        .where(AitoProject.id == p["id"])
        .values(
            quote_number="DEV-7",
            quote_total=5000.0,
            quote_status="sent",
            # Pinned so the link the reconciler WANTS matches the row below
            # exactly: the reconcile half then has nothing to do and the poll
            # half is what the bypass has to reach.
            quote_expiry_date="2026-12-31",
        )
    )
    # A pending link that failed its last contact a moment ago: one failure =
    # 300 s of backoff, counted from checked_at.
    db_session.add(
        AitoPaymentLink(
            project_id=p["id"],
            idempotency_key=f"aito:{p['id']}:1",
            heimdall_id="L9",
            reference="DEV-7",
            amount=5000,
            expires_on="2026-12-31",
            url="https://osb/pay/L9",
            status="pending",
            sync_error="Heimdall is down",
            sync_failures=1,
            checked_at=datetime.utcnow(),
        )
    )
    await db_session.commit()

    calls: list[str] = []

    async def create_link(db, *, idempotency_key, reference, amount, expires_in_days):
        calls.append("create")
        raise AssertionError("the row already exists; nothing should be created")

    async def get_payment(db, heimdall_id):
        calls.append("get")
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

    # Control: the loop's own pass leaves the backed-off row alone.
    assert await svc.reconcile_payment_links(db_session, only_project_id=p["id"]) == 1
    assert calls == []

    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link/refresh")
    assert r.status_code == 200, r.text
    assert calls == ["get"]
    assert r.json()["payment_link"]["sync_error"] is None


@pytest.mark.asyncio
async def test_refresh_is_rate_limited_per_user(async_client):
    """Spec §7.1: 10/min per principal, its own bucket. The 11th call inside
    the window is refused with the same 429 shape the AI routes use."""
    from backend.app.api.routes import aito as aito_routes

    p = await _create(async_client)
    # Heimdall is not configured here: the reconcile is a silent no-op, so
    # this exercises the limiter and nothing else.
    for _ in range(aito_routes._PAYMENT_LINK_REFRESH_MAX_CALLS):
        r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link/refresh")
        assert r.status_code == 200, r.text
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link/refresh")
    assert r.status_code == 429
    assert r.json()["detail"] == aito_routes._PAYMENT_LINK_REFRESH_DETAIL
    # Its own bucket: the AI budget is untouched by an exhausted Retry budget.
    assert aito_routes._PAYMENT_LINK_REFRESH_MAX_CALLS < aito_routes._AI_RATE_LIMIT_MAX_CALLS
    assert set(aito_routes._ai_rate_limit_calls) == {
        k for k in aito_routes._ai_rate_limit_calls if k.startswith("payment_link_refresh:")
    }


@pytest.mark.asyncio
async def test_importing_a_quote_wakes_the_loop_for_its_link(async_client, db_session):
    """An import (a create carrying `quote_id`) owes Books nothing — its tasks
    were derived FROM the estimate — but it owes Heimdall a link exactly like
    a hand-made card does, and the link is minted by the change drain the
    loop runs on a wake (`reconcile_payment_links(changes_only=True)`). The
    import branch used to skip the wake because, when it was written, the
    wake only served Books pushes; the link then waited for the next full
    tick, which the operator read as "no payment link on an imported quote".
    The wake must fire; the project must still not be queued for a push."""
    import asyncio

    from backend.app.models.aito_project import AitoProject
    from backend.app.services import aito_quote_sync

    aito_quote_sync._wake = asyncio.Event()
    aito_quote_sync._debounce_deadline = None

    p = await _create(async_client, quote_id="E9", quote_number="DEV26-9", quote_total=12500.0, quote_status="sent")

    assert aito_quote_sync._wake.is_set()
    assert aito_quote_sync._debounce_deadline is None
    project = await db_session.get(AitoProject, p["id"])
    assert project.quote_sync_state == "idle"


@pytest.mark.asyncio
async def test_board_and_detail_carry_invoice_link_and_terminal_payment(async_client, db_session):
    from backend.app.models.aito_terminal_payment import AitoTerminalPayment

    p = await _create(async_client)
    db_session.add(
        AitoPaymentLink(
            project_id=p["id"],
            idempotency_key=f"aito:{p['id']}:1",
            reference="FA-1",
            amount=50,
            expires_on="2026-12-31",
            heimdall_id="h-inv",
            status="pending",
            url="https://pay.example/inv",
            document_kind="invoice",
            document_number="FA-1",
        )
    )
    db_session.add(
        AitoTerminalPayment(
            project_id=p["id"],
            document_kind="invoice",
            document_id="i1",
            document_number="FA-1",
            idempotency_key=f"aito-tpe:{p['id']}:1",
            heimdall_id="h-tpe",
            amount=50,
            status="processing",
            native_state="awaiting_tpe",
            created_at=datetime(2026, 9, 23, 1, 0),
        )
    )
    await db_session.commit()
    board = (await async_client.get("/api/v1/aito/")).json()
    row = next(r for r in board if r["id"] == p["id"])
    assert row["payment_link"] is None
    assert row["invoice_payment_link"]["url"] == "https://pay.example/inv"
    assert row["terminal_payment"]["status"] == "processing" and row["terminal_payment"]["document_number"] == "FA-1"
    detail = (
        await async_client.patch(
            f"/api/v1/aito/{p['id']}", json={"description": "x", "expected_version": row["version"]}
        )
    ).json()
    assert detail["invoice_payment_link"]["state"] == "pending" and detail["terminal_payment"]["amount"] == 50
