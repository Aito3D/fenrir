"""Heimdall's payment webhook (routes/aito_payments.py): the signature gate,
and the wake settling a payment through the poller's own code path."""

import asyncio
import json
import time

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.api.routes import aito as aito_routes, aito_payments as routes
from backend.app.api.routes.settings import set_setting
from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.models.aito_terminal_payment import AitoTerminalPayment
from backend.app.services import aito_payment_links as links_svc
from backend.app.services.aito_payment_links import reconcile_payment_links
from backend.app.services.heimdall import LinkView, heimdall_service, sign
from backend.tests.unit.test_aito_payment_links import (  # noqa: F401 — fixtures
    NOW,
    TODAY,
    _kinds,
    _project,
    _rows,
    fake,
    file_engine,
    no_books,
)

PATH = "/api/v1/aito/payments/webhook"
SECRET = "whsec-for-tests-0123456789abcdef"
NONCE = "nonce-0123456789abcdef"


@pytest.fixture(autouse=True)
def _reset_rate_limit():
    aito_routes._ai_rate_limit_calls.clear()
    yield
    aito_routes._ai_rate_limit_calls.clear()


@pytest.fixture
async def secret(db_session):
    await set_setting(db_session, "heimdall_webhook_secret", SECRET)
    await db_session.commit()
    return SECRET


def _body(heimdall_id="L1", **over) -> bytes:
    payload = {"id": heimdall_id, "kind": "link", "status": "paid", "occurred_at": "2026-11-12T08:15:02.117Z"}
    payload.update(over)
    return json.dumps(payload).encode()


def _headers(body: bytes, *, key=SECRET, timestamp=None, nonce=NONCE, path=PATH) -> dict:
    timestamp = int(time.time()) if timestamp is None else timestamp
    return {
        "Content-Type": "application/json",
        "X-Heimdall-Timestamp": str(timestamp),
        "X-Heimdall-Nonce": nonce,
        "X-Heimdall-Signature": sign("POST", path, body, key, timestamp, nonce),
    }


async def _pending_link(db, project_id, heimdall_id="L1", **over) -> AitoPaymentLink:
    fields = {
        "project_id": project_id,
        "idempotency_key": f"aito:{project_id}:1",
        "heimdall_id": heimdall_id,
        "reference": "DEV-2026-1234",
        "amount": 12500,
        "expires_on": "2026-09-27",
        "url": f"https://osb/pay/{heimdall_id}",
        "status": "pending",
    }
    fields.update(over)
    row = AitoPaymentLink(**fields)
    db.add(row)
    await db.commit()
    return row


# --- the gate ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_route_is_off_until_a_secret_is_saved(async_client):
    body = _body()
    r = await async_client.post(PATH, content=body, headers=_headers(body))
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_a_signed_call_is_accepted_and_the_scheme_matches_heimdalls_vector(async_client, secret):
    body = _body()
    r = await async_client.post(PATH, content=body, headers=_headers(body))
    assert r.status_code == 204 and r.content == b""
    # The six-line string, spelled out: what Heimdall's api/webhook.ts signs.
    import hashlib
    import hmac

    canonical = "\n".join(["POST", PATH, "1700000000", NONCE, hashlib.sha256(body).hexdigest(), ""])
    expected = "sha256=" + hmac.new(SECRET.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    assert _headers(body, timestamp=1700000000)["X-Heimdall-Signature"] == expected


@pytest.mark.asyncio
async def test_the_query_string_is_part_of_what_is_signed(async_client, secret):
    body = _body()
    ok = await async_client.post(f"{PATH}?shop=1", content=body, headers=_headers(body, path=f"{PATH}?shop=1"))
    assert ok.status_code == 204
    swapped = await async_client.post(f"{PATH}?shop=2", content=body, headers=_headers(body, path=f"{PATH}?shop=1"))
    assert swapped.status_code == 401


@pytest.mark.asyncio
async def test_every_refusal_is_the_same_401(async_client, secret, fake):  # noqa: F811
    body = _body()
    good = _headers(body)
    now = int(time.time())
    cases = {
        "wrong secret": (body, _headers(body, key="another-secret")),
        "tampered body": (_body("L2"), good),
        "no headers": (body, {"Content-Type": "application/json"}),
        "no signature": (body, {k: v for k, v in good.items() if k != "X-Heimdall-Signature"}),
        "unprefixed signature": (body, {**good, "X-Heimdall-Signature": good["X-Heimdall-Signature"][7:]}),
        "non-ascii signature": (body, {**good, "X-Heimdall-Signature": "sha256=é".encode()}),
        "stale timestamp": (body, _headers(body, timestamp=now - 301)),
        "future timestamp": (body, _headers(body, timestamp=now + 301)),
        "milliseconds": (body, _headers(body, timestamp=now * 1000)),
        "garbage timestamp": (body, {**good, "X-Heimdall-Timestamp": "soon"}),
        "short nonce": (body, _headers(body, nonce="short")),
        "oversized body": (b" " * 5000, _headers(b" " * 5000)),
    }
    answers = {}
    for name, (content, headers) in cases.items():
        r = await async_client.post(PATH, content=content, headers=headers)
        answers[name] = (r.status_code, r.text)
    assert set(answers.values()) == {(401, '{"detail":"Unauthorized"}')}, answers
    assert fake.calls == []  # nothing refused ever reaches Heimdall


@pytest.mark.asyncio
async def test_a_timestamp_at_the_edge_of_the_window_is_accepted(async_client, secret):
    body = _body()
    r = await async_client.post(PATH, content=body, headers=_headers(body, timestamp=int(time.time()) - 290))
    assert r.status_code == 204


@pytest.mark.asyncio
async def test_an_unknown_id_or_a_malformed_payload_answers_204_and_does_nothing(async_client, secret, fake):  # noqa: F811
    for body in (_body("nobody-knows-me"), b"[]", b"not json", _body("../../ping"), json.dumps({"id": 7}).encode()):
        r = await async_client.post(PATH, content=body, headers=_headers(body))
        assert r.status_code == 204 and r.content == b""
    assert fake.calls == []


@pytest.mark.asyncio
async def test_the_route_is_rate_limited_per_ip(async_client, secret, monkeypatch):
    monkeypatch.setattr(routes, "_WEBHOOK_MAX_CALLS", 2)
    body = _body("nobody")
    codes = [(await async_client.post(PATH, content=body, headers=_headers(body))).status_code for _ in range(3)]
    assert codes == [204, 204, 429]


@pytest.mark.asyncio
async def test_the_secret_is_write_only(async_client, secret):
    assert (await async_client.get("/api/v1/settings/")).json()["heimdall_webhook_secret"] == ""
    r = await async_client.put("/api/v1/settings/", json={"heimdall_webhook_secret": "rotated-secret-0123456789"})
    assert r.status_code == 200, r.text
    assert r.json()["heimdall_webhook_secret"] == ""
    body = _body()
    assert (await async_client.post(PATH, content=body, headers=_headers(body))).status_code == 401
    rotated = _headers(body, key="rotated-secret-0123456789")
    assert (await async_client.post(PATH, content=body, headers=rotated)).status_code == 204


# --- the wake ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_paid_link_is_settled_through_the_poll_path_not_from_the_payload(
    async_client,
    db_session,
    secret,
    fake,  # noqa: F811
):
    p = await _project(db_session)
    await _pending_link(db_session, p.id)
    fake.links["L1"] = {"id": "L1", "status": "pending", "amount": 12500, "reference": "DEV-2026-1234"}

    # The payload claims `paid`; Heimdall itself still says pending. Nothing settles.
    body = _body("L1", status="paid")
    assert (await async_client.post(PATH, content=body, headers=_headers(body))).status_code == 204
    assert fake.calls == [("get", "L1")]
    (row,) = await _rows(db_session, p.id)
    await db_session.refresh(row)
    assert row.status == "pending" and row.paid_at is None

    # Heimdall says paid: the payload could say anything, the GET is what counts.
    fake.set_status("L1", "paid")
    body = _body("L1", status="cancelled")
    assert (await async_client.post(PATH, content=body, headers=_headers(body))).status_code == 204
    await db_session.refresh(row)
    assert row.status == "paid" and row.paid_at is not None
    await db_session.refresh(p)
    assert p.quote_status == "accepted"
    kinds = await _kinds(db_session, p.id)
    assert kinds.count("payment_link.paid") == 1 and kinds.count("quote.accepted") == 1

    # A replayed notification finds nothing pending: no Heimdall call, no second event.
    calls = len(fake.calls)
    assert (await async_client.post(PATH, content=body, headers=_headers(body))).status_code == 204
    assert len(fake.calls) == calls
    assert (await _kinds(db_session, p.id)).count("payment_link.paid") == 1


@pytest.mark.asyncio
async def test_the_wake_reads_only_the_notified_link(async_client, db_session, secret, fake):  # noqa: F811
    a = await _project(db_session)
    b = await _project(db_session, quote_number="DEV-2026-9999", quote_id="EST2")
    await _pending_link(db_session, a.id, "L1")
    await _pending_link(db_session, b.id, "L2", reference="DEV-2026-9999")
    for hid in ("L1", "L2"):
        fake.links[hid] = {"id": hid, "status": "paid", "amount": 12500, "reference": "x"}
    body = _body("L2")
    assert (await async_client.post(PATH, content=body, headers=_headers(body))).status_code == 204
    assert fake.calls == [("get", "L2")]  # no reconcile of any project, no poll of L1
    assert [r.status for r in await _rows(db_session, a.id)] == ["pending"]


@pytest.mark.asyncio
async def test_a_terminal_payment_is_settled_through_refresh(async_client, db_session, secret, monkeypatch):
    p = await _project(db_session)
    accepted = []

    async def fake_accept(db, project, **kw):
        accepted.append(kw["source"])
        return True

    async def fake_refresh(db, project_id, kind):
        return None

    async def configured(db):
        return True

    gets = []

    async def get_payment(db, heimdall_id):
        gets.append(heimdall_id)
        return LinkView(
            id=heimdall_id,
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

    monkeypatch.setattr("backend.app.services.aito_quote_status.accept_quote", fake_accept)
    monkeypatch.setattr("backend.app.services.aito_manual_payments.refresh_after_payment", fake_refresh)
    monkeypatch.setattr(heimdall_service, "is_configured", configured)
    monkeypatch.setattr(heimdall_service, "get_payment", get_payment)
    row = AitoTerminalPayment(
        project_id=p.id,
        document_kind="quote",
        document_id="EST1",
        document_number="DEV-2026-1234",
        idempotency_key="k",
        heimdall_id="h-1",
        amount=5000,
        status="processing",
        created_at=NOW,
    )
    db_session.add(row)
    await db_session.commit()

    body = _body("h-1", kind="terminal", status="failed")  # the payload lies; Heimdall says paid
    for _ in range(2):  # the second is a replay: the row is settled, nothing is re-read
        assert (await async_client.post(PATH, content=body, headers=_headers(body))).status_code == 204
    await db_session.refresh(row)
    assert row.status == "paid" and row.amount_confirmed == 5000 and row.settled_at is not None
    assert gets == ["h-1"] and accepted == ["terminal"]
    events = (await db_session.execute(select(AitoEvent).where(AitoEvent.project_id == p.id))).scalars().all()
    assert [e.kind for e in events].count("payment.terminal.paid") == 1


@pytest.mark.asyncio
async def test_a_wake_racing_the_poll_settles_once(file_engine, fake, monkeypatch):  # noqa: F811
    """The webhook's wake and the loop's tick both reach the same pending
    link while Heimdall says paid. The pass lock serialises them: the loser
    finds the row already paid — one event, one acceptance."""
    maker = async_sessionmaker(file_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr("backend.app.core.database.async_session", maker)
    monkeypatch.setattr(links_svc, "_pass_lock", asyncio.Lock())
    async with maker() as setup:
        p = await _project(setup)
        await _pending_link(setup, p.id)
        project_id = p.id
    fake.links["L1"] = {"id": "L1", "status": "paid", "amount": 12500, "reference": "DEV-2026-1234"}

    gate = asyncio.Event()
    inner = fake.get_payment

    async def slow_get(db, heimdall_id):
        await gate.wait()
        return await inner(db, heimdall_id)

    heimdall_service.get_payment = slow_get  # the `fake` fixture's monkeypatch restores it

    async with maker() as tick:
        wake = asyncio.create_task(routes._wake_payment("L1"))
        poll = asyncio.create_task(reconcile_payment_links(tick, now=NOW, today=TODAY))
        await asyncio.sleep(0.05)
        gate.set()
        await asyncio.gather(wake, poll)

    async with maker() as check:
        (row,) = await _rows(check, project_id)
        kinds = await _kinds(check, project_id)
    assert row.status == "paid"
    assert kinds.count("payment_link.paid") == 1 and kinds.count("quote.accepted") == 1
    assert [c for c in fake.calls if c == ("get", "L1")] == [("get", "L1")]
