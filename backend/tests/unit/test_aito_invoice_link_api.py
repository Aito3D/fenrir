import httpx
import pytest

from backend.app.api.routes.settings import set_setting
from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.services.aito_payment_documents import DocumentMismatch, PaymentDocument
from backend.app.services.heimdall import heimdall_service

INVOICE = PaymentDocument(kind="invoice", id="inv-1", number="FA-26-0001", customer_id="c1", balance=23000)


@pytest.fixture(autouse=True)
async def _setup(db_session, monkeypatch):
    from backend.app.api.routes import aito as aito_routes

    aito_routes._ai_rate_limit_calls.clear()
    await set_setting(db_session, "heimdall_base_url", "http://pos.local:8081")
    await set_setting(db_session, "heimdall_api_token", "hmd_live.84f32b71ac095ed2.s3cret")
    await db_session.commit()

    async def resolve(db, project, kind, document_id):
        if (kind, document_id) == ("invoice", "inv-1"):
            return INVOICE
        raise DocumentMismatch("nope")

    monkeypatch.setattr("backend.app.api.routes.aito_payments.resolve_document", resolve)
    heimdall_service._transport = None
    yield
    heimdall_service._transport = None


async def _create(client, **overrides):
    payload = {
        "description": "Support GoPro",
        "client_id": "c1",
        "client_name": "ACME",
        "client_phone": "+689 87 00 00 01",
    }
    payload.update(overrides)
    r = await client.post("/api/v1/aito/", json=payload)
    assert r.status_code == 201, r.text
    return r.json()


def _link(**over):
    base = {
        "id": "h-inv",
        "status": "pending",
        "amount": 23000,
        "currency": "XPF",
        "reference": "FA-26-0001",
        "link": {"url": "https://pay/x", "expires_at": "2026-10-08T23:59:59.999Z"},
    }
    base.update(over)
    return base


@pytest.mark.asyncio
async def test_create_then_cancel(async_client, db_session):
    p = await _create(async_client)
    heimdall_service._transport = httpx.MockTransport(lambda r: httpx.Response(201, json=_link()))
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link", json={"document_id": "inv-1", "amount": 23000})
    assert r.status_code == 200, r.text
    link = r.json()["invoice_payment_link"]
    assert link["state"] == "pending" and link["url"] == "https://pay/x" and r.json()["payment_link"] is None
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link", json={"document_id": "inv-1", "amount": 1})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "link_exists"
    # The route checks the live-link refusal before the balance cap (spec
    # §6.2: link_exists is the refusal the operator cannot clear by editing
    # the amount), so an over-balance amount still answers link_exists here,
    # not amount_above_balance -- the balance cap is only reached once no
    # live link is in the way (see test_amount_above_balance_and_quote_cancel).
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link", json={"document_id": "inv-1", "amount": 23001})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "link_exists"
    row = (await db_session.execute(AitoPaymentLink.__table__.select())).first()
    heimdall_service._transport = httpx.MockTransport(lambda r: httpx.Response(200, json=_link(status="cancelled")))
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link/{row.id}/cancel")
    assert r.status_code == 200 and r.json()["invoice_payment_link"]["state"] == "cancelled"


@pytest.mark.asyncio
async def test_amount_above_balance_and_quote_cancel(async_client, db_session):
    p = await _create(async_client)
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link", json={"document_id": "inv-1", "amount": 23001})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "amount_above_balance"
    db_session.add(
        AitoPaymentLink(
            project_id=p["id"],
            idempotency_key="k",
            reference="DEV-1",
            amount=1,
            expires_on="2026-12-31",
            heimdall_id="h",
            status="pending",
            document_kind="quote",
            document_number="DEV-1",
        )
    )
    await db_session.commit()
    row = (await db_session.execute(AitoPaymentLink.__table__.select())).first()
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link/{row.id}/cancel")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "quote_link_managed"
    assert (await async_client.post(f"/api/v1/aito/{p['id']}/payment-link/999/cancel")).status_code == 404


@pytest.mark.asyncio
async def test_a_missing_heimdall_config_is_a_502_not_configured_on_create(async_client, db_session):
    """`HeimdallNotConfigured` does not subclass `HeimdallUpstreamError` (see
    FINDING 2); the route's own narrow `except HeimdallNotConfigured` above
    the `HeimdallUpstreamError` catch is what stops this route falling
    through to an unmapped 500."""
    p = await _create(async_client)
    await set_setting(db_session, "heimdall_api_token", "")
    await db_session.commit()
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link", json={"document_id": "inv-1", "amount": 23000})
    assert r.status_code == 502, r.text
    assert r.json()["detail"] == {"code": "not_configured", "message": "Heimdall is not configured (see Settings)"}


@pytest.mark.asyncio
async def test_a_missing_heimdall_config_is_a_502_not_configured_on_cancel(async_client, db_session):
    """Same mapping, on the cancel route: a live, minted link is seeded so
    the request gets past the `not_cancellable` state guard and reaches
    `cancel_invoice_link`, which lets `HeimdallNotConfigured` propagate
    uncaught for this same route-level `except` to map."""
    p = await _create(async_client)
    row = AitoPaymentLink(
        project_id=p["id"],
        idempotency_key="k-cfg",
        reference="FA-26-0001",
        amount=23000,
        expires_on="2026-12-31",
        heimdall_id="h-live",
        status="pending",
        document_kind="invoice",
        document_number="FA-26-0001",
    )
    db_session.add(row)
    await db_session.commit()
    await set_setting(db_session, "heimdall_api_token", "")
    await db_session.commit()
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link/{row.id}/cancel")
    assert r.status_code == 502, r.text
    assert r.json()["detail"] == {"code": "not_configured", "message": "Heimdall is not configured (see Settings)"}


@pytest.mark.asyncio
async def test_the_services_own_link_exists_guard_answers_409_when_the_routes_precheck_misses_the_race(
    async_client, db_session, monkeypatch
):
    """`create_invoice_link`'s own `InvoiceLinkExists` guard (a second,
    independent read of "is there already a live link") is the backstop for
    a concurrent create racing past the route's own pre-check -- both read
    the same state, so the route's pre-check is patched away here (as if it
    had run a heartbeat earlier and seen no link yet) while a real minted,
    pending link already sits in the database for the service's own guard to
    find and refuse."""
    p = await _create(async_client)
    row = AitoPaymentLink(
        project_id=p["id"],
        idempotency_key="k-race",
        reference="FA-26-0001",
        amount=23000,
        expires_on="2026-12-31",
        heimdall_id="h-race",
        status="pending",
        document_kind="invoice",
        document_number="FA-26-0001",
    )
    db_session.add(row)
    await db_session.commit()

    async def no_live_link_yet(db, project_id, *, kind="quote"):
        return None

    monkeypatch.setattr("backend.app.api.routes.aito_payments.current_link", no_live_link_yet)
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link", json={"document_id": "inv-1", "amount": 23000})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "link_exists"


@pytest.mark.asyncio
async def test_an_idempotency_key_taken_by_another_process_answers_409_not_500(async_client, db_session, monkeypatch):
    """T-029: the reservation window is serialised in-process, but a lock
    reaches no further than this process. When the unique `idempotency_key` is
    claimed between the count and the commit anyway, the operator must still
    get the 409 they already know for "a link is already open" — not an
    IntegrityError escaping the handler as a 500 on the Create-link button.
    The steal below is committed from the TEST's session, i.e. from outside
    the request's own session, exactly as another process would."""
    from backend.app.services import aito_payment_links as links_svc

    p = await _create(async_client)
    real_next_key = links_svc._next_key

    async def steal(db, project_id):
        key = await real_next_key(db, project_id)
        db_session.add(
            AitoPaymentLink(
                project_id=project_id,
                idempotency_key=key,
                reference="FA-26-0001",
                amount=23000,
                expires_on="2026-12-31",
                status="pending",
                document_kind="invoice",
                document_number="FA-26-0001",
            )
        )
        await db_session.commit()
        return key

    monkeypatch.setattr(links_svc, "_next_key", steal)
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link", json={"document_id": "inv-1", "amount": 23000})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "link_exists"


@pytest.mark.asyncio
async def test_a_heimdall_422_on_the_link_route_reads_invalid_not_amount_above_balance(async_client):
    """Minor 5: the balance cap is checked by the route itself, so a 422 from
    Heimdall here is some OTHER invalid field — labelling it
    `amount_above_balance` sent the operator to edit an amount that was
    already fine. The terminal route keeps that code; this one is neutral and
    shows Heimdall's own message."""
    p = await _create(async_client)
    heimdall_service._transport = httpx.MockTransport(
        lambda r: httpx.Response(
            422, json={"error": {"code": "invalid_request", "message": "expires_in_days must be 1..90"}}
        )
    )
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link", json={"document_id": "inv-1", "amount": 23000})
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["code"] == "invalid"
    assert "expires_in_days" in r.json()["detail"]["message"]


@pytest.mark.asyncio
@pytest.mark.parametrize("bad_id", [None, "h" * 37, "h-1/../ping"], ids=["null", "oversized", "path"])
async def test_a_malformed_heimdall_id_leaves_the_link_a_pending_reservation_with_a_sync_error(
    async_client, db_session, bad_id
):
    """T-098: the id is never stored. The row stays an unminted reservation
    (replayable under its own key) carrying the error, and the route answers
    the generic upstream 502 an unreadable Heimdall answer already gets."""
    p = await _create(async_client)
    heimdall_service._transport = httpx.MockTransport(lambda r: httpx.Response(201, json=_link(id=bad_id)))
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link", json={"document_id": "inv-1", "amount": 23000})
    assert r.status_code == 502, r.text
    assert r.json()["detail"]["code"] == "upstream"
    row = (await db_session.execute(AitoPaymentLink.__table__.select())).one()
    assert row.status == "pending" and row.heimdall_id is None
    assert "unexpected payment shape" in row.sync_error

    # A readable answer on the retry adopts the SAME reservation.
    keys = []

    def handler(request):
        keys.append(request.headers["idempotency-key"])
        return httpx.Response(201, json=_link())

    heimdall_service._transport = httpx.MockTransport(handler)
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link", json={"document_id": "inv-1", "amount": 23000})
    assert r.status_code == 200, r.text
    assert keys == [row.idempotency_key]
    again = (await db_session.execute(AitoPaymentLink.__table__.select())).one()
    assert again.id == row.id and again.heimdall_id == "h-inv" and again.sync_error is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "over",
    [
        {"status": "paid", "heimdall_id": "h-paid"},
        {"status": "cancelled", "heimdall_id": "h-cancelled"},
        {"status": "pending", "heimdall_id": None},  # a reservation: nothing to cancel at Heimdall
    ],
)
async def test_cancel_refuses_a_link_that_is_not_open(async_client, db_session, over):
    """Minor 6: the route had no state guard — a dead link went out as
    Heimdall's opaque `conflict`, and a reservation as `POST
    /payments/None/cancel`. Both are refused here, without a Heimdall call."""
    p = await _create(async_client)
    calls = []

    def handler(request):
        calls.append(request.url.path)
        return httpx.Response(200, json=_link(status="cancelled"))

    heimdall_service._transport = httpx.MockTransport(handler)
    row = AitoPaymentLink(
        project_id=p["id"],
        idempotency_key="k-guard",
        reference="FA-26-0001",
        amount=1,
        expires_on="2026-12-31",
        document_kind="invoice",
        document_number="FA-26-0001",
        **over,
    )
    db_session.add(row)
    await db_session.commit()
    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link/{row.id}/cancel")
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "not_cancellable"
    assert calls == []


@pytest.mark.asyncio
async def test_cancel_shares_the_counter_payment_budget_and_checks_it_before_the_lookup(async_client, db_session):
    """T-017: cancel had no `_check_counter_payment_rate_limit` call at all,
    unlike its three counter-payment siblings. The bucket is shared, so N
    creates followed by a cancel exhaust the same budget, and the limiter
    runs before any lookup -- a cancel of a link that does not even exist
    still answers 429 once the budget is spent."""
    from backend.app.api.routes import aito_payments

    p = await _create(async_client)
    row = AitoPaymentLink(
        project_id=p["id"],
        idempotency_key="k-rl",
        reference="FA-26-0001",
        amount=23000,
        expires_on="2026-12-31",
        heimdall_id="h-rl",
        status="pending",
        document_kind="invoice",
        document_number="FA-26-0001",
    )
    db_session.add(row)
    await db_session.commit()

    calls = []

    def handler(request):
        calls.append(request.url.path)
        return httpx.Response(422, json={"error": {"code": "invalid_request", "message": "no"}})

    heimdall_service._transport = httpx.MockTransport(handler)
    # N creates share the same "counter_payment" bucket as a cancel -- one
    # budget for all four routes (spec: shared per-principal window).
    for _ in range(aito_payments._COUNTER_PAYMENT_MAX_CALLS):
        await async_client.post(f"/api/v1/aito/{p['id']}/payment-link", json={"document_id": "inv-1", "amount": 23000})
    calls.clear()

    r = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link/{row.id}/cancel")
    assert r.status_code == 429, r.text
    assert r.json()["detail"] == {"code": "rate_limited", "message": aito_payments._COUNTER_PAYMENT_DETAIL}
    assert calls == []  # never reached cancel_invoice_link / Heimdall
    unchanged = await db_session.get(AitoPaymentLink, row.id)
    assert unchanged.status == "pending" and unchanged.heimdall_id == "h-rl"

    # The limiter runs before the 404 lookup too.
    r2 = await async_client.post(f"/api/v1/aito/{p['id']}/payment-link/999999/cancel")
    assert r2.status_code == 429, r2.text
    assert r2.json()["detail"]["code"] == "rate_limited"
