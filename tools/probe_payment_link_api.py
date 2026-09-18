"""Golden probe (campaign 17): the payment-link HTTP surface, end to end.

Drives the real FastAPI app over httpx's ASGI transport against a fresh
in-memory SQLite database (the conftest `async_client` recipe), with an
httpx.MockTransport standing in for Heimdall. Auth is off because the
database has no users, exactly as in the integration tests.

What a payment-link user observes, pinned:
  * POST /heimdall/test — every branch of the Settings card's Test button:
    not configured, saved credential OK, 401, 403, unreachable, a partial
    override (only one of base_url/token), and the URLs the SSRF guard must
    refuse with a 422 rather than dial.
  * POST /aito/{id}/payment-link/refresh — mints a link, is idempotent on a
    second call, carries a Heimdall failure to the row's `sync_error`
    instead of raising, 404s an unknown or trashed project, and 429s once
    the Retry budget is spent.
  * The `payment_link` block on the project payload (board and detail), for
    a reservation, a live link, a paid link and a failed one.

Determinism: the clock and nonce inside the Heimdall client are frozen, the
rate-limit bucket and the reconciler's global 429 throttle are reset between
sections, and `_now()` is pinned so `paid_at`/`checked_at` never reach the
output as wall-clock values.
"""

import asyncio
import json
import secrets as _secrets
import sys
import time as _time
from datetime import date, datetime
from unittest.mock import patch

sys.path.insert(0, ".")

import httpx  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402

import backend.app.main  # noqa: E402,F401  (registers every model on Base.metadata)
from backend.app.api.routes import aito as aito_routes  # noqa: E402
from backend.app.api.routes.settings import set_setting  # noqa: E402
from backend.app.core.database import Base, get_db  # noqa: E402
from backend.app.main import app  # noqa: E402
from backend.app.models.aito_payment_link import AitoPaymentLink  # noqa: E402
from backend.app.models.aito_project import AitoProject  # noqa: E402
from backend.app.services import aito_payment_links as PL  # noqa: E402
from backend.app.services import heimdall as H  # noqa: E402

TOKEN = "hmd_live.84f32b71ac095ed2.2vy0_YZCo5BscR8UgRTVYTO1NB46EyARcIalbpnJD7o"
BASE_URL = "http://pos.local:8081"
FROZEN_TS = 1757707200
FROZEN_NONCE = "0123456789abcdef0123456789abcdef"
FROZEN_NOW = datetime(2026, 9, 16, 12, 0, 0)
FROZEN_TODAY = date(2026, 9, 16)

# Fields of the project payload that depend on the wall clock or on rows this
# probe does not control; dropped so the golden stays stable.
VOLATILE = {"created_at", "updated_at", "moved_at", "last_event_at", "aging_days", "due_in_days"}


def payment(**overrides) -> dict:
    body = {
        "id": "6f1e2c3a-0000-4000-8000-000000000001",
        "method": "link",
        "status": "pending",
        "amount": 12500,
        "currency": "XPF",
        "reference": "DEV-000123",
        "link": {"url": "https://secure.osb.pf/pay/abc", "expires_at": "2026-10-01T23:59:59.999Z"},
    }
    body.update(overrides)
    return body


def slim(body):
    """A project payload with the volatile fields and the unrelated bulk
    dropped — the payment-link block and the few flags it depends on."""
    if not isinstance(body, dict):
        return body
    keep = {
        "id",
        "description",
        "status",
        "quote_number",
        "quote_status",
        "quote_total",
        "quote_invoiced",
        "quote_expiry_date",
        "retainer_paid_total",
        "payment_link",
    }
    return {k: v for k, v in body.items() if k in keep and k not in VOLATILE}


async def main() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sm = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def override_get_db():
        async with sm() as session:
            try:
                yield session
                await session.commit()
            except BaseException:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = override_get_db

    # Freeze the client's entropy and the reconciler's clock/calendar.
    _time.time = lambda: float(FROZEN_TS)  # type: ignore[assignment]
    _secrets.token_hex = lambda n=32: FROZEN_NONCE  # type: ignore[assignment]
    PL._now = lambda: FROZEN_NOW  # type: ignore[assignment]

    out: list[dict] = []

    def rec(step, r, transform=None):
        ct = r.headers.get("content-type", "")
        body = r.json() if ct.startswith("application/json") else r.text
        out.append({"step": step, "status": r.status_code, "body": transform(body) if transform else body})

    def reset_budget():
        aito_routes._ai_rate_limit_calls.clear()
        PL._throttled_until = None

    def heimdall(handler):
        H.heimdall_service._transport = httpx.MockTransport(handler)

    def responder(status=200, body=None, headers=None, calls: list | None = None):
        def handler(request: httpx.Request) -> httpx.Response:
            if calls is not None:
                calls.append({"method": request.method, "path": request.url.path, "body": request.content.decode()})
            return httpx.Response(status, json=body if body is not None else payment(), headers=headers or {})

        return handler

    with (
        patch("backend.app.core.database.async_session", sm),
        patch("backend.app.core.auth.async_session", sm),
        patch("backend.app.main.async_session", sm),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            # ---------- 1. POST /heimdall/test ----------------------------
            heimdall(responder(200, {"ok": True}))
            rec("01-test-unconfigured", await c.post("/api/v1/heimdall/test", json={}))

            async with sm() as db:
                await set_setting(db, "heimdall_base_url", BASE_URL)
                await set_setting(db, "heimdall_api_token", TOKEN)
                await set_setting(db, "aito_deposit_pct", "0")
                await db.commit()

            rec("02-test-configured-ok", await c.post("/api/v1/heimdall/test", json={}))
            heimdall(responder(401, {"error": {"code": "unauthorized", "message": "bad signature"}}))
            rec("03-test-401", await c.post("/api/v1/heimdall/test", json={}))
            heimdall(responder(403, {"error": {"code": "forbidden", "message": "no scope"}}))
            rec("04-test-403", await c.post("/api/v1/heimdall/test", json={}))
            heimdall(responder(500, {"error": {"code": "internal"}}))
            rec("05-test-500-is-unreachable", await c.post("/api/v1/heimdall/test", json={}))

            def refuse(request: httpx.Request) -> httpx.Response:
                raise httpx.ConnectError("refused", request=request)

            heimdall(refuse)
            rec("06-test-connect-refused", await c.post("/api/v1/heimdall/test", json={}))

            heimdall(responder(200, {"ok": True}))
            rec(
                "07-test-with-both-overrides",
                await c.post("/api/v1/heimdall/test", json={"base_url": "http://other.local:8081", "token": TOKEN}),
            )
            # Only ONE override: the route's `overriding` flag needs both, so this
            # falls back to the saved credential.
            rec("08-test-url-override-only", await c.post("/api/v1/heimdall/test", json={"base_url": BASE_URL}))
            rec("09-test-token-override-only", await c.post("/api/v1/heimdall/test", json={"token": TOKEN}))
            rec("10-test-empty-strings", await c.post("/api/v1/heimdall/test", json={"base_url": "", "token": ""}))
            # The SSRF guard on base_url: a 422 from the schema, never a dial.
            for i, url in enumerate(
                [
                    "http://169.254.169.254/latest/meta-data",
                    "http://metadata.google.internal/",
                    "file:///etc/passwd",
                    "gopher://pos.local:8081",
                    "http://localhost:8081",
                    "http://127.0.0.1:8081",
                    "http://[::1]:8081",
                    "http://pos.local:8081/../../etc",
                    "not-a-url",
                    "http://",
                    "https://pos.example.com:8081",
                    "http://192.168.1.50:8081",
                    "http://10.0.0.5:8081",
                    "http://8.8.8.8:8081",
                    "x" * 400,
                ]
            ):
                rec(
                    f"11-test-url-guard-{i:02d}-{url[:40]}",
                    await c.post("/api/v1/heimdall/test", json={"base_url": url, "token": TOKEN}),
                )
            rec("12-test-token-too-long", await c.post("/api/v1/heimdall/test", json={"token": "h" * 400}))
            rec("13-test-wrong-types", await c.post("/api/v1/heimdall/test", json={"base_url": 5, "token": []}))
            rec("14-test-no-body", await c.post("/api/v1/heimdall/test"))

            # ---------- 2. refresh: the panel's Retry ---------------------
            async with sm() as db:
                for pid, desc, kw in [
                    (1, "live-link", {}),
                    (2, "no-quote", {"quote_number": None}),
                    (3, "declined", {"quote_status": "declined"}),
                    (4, "trashed", {"status": "deleted"}),
                    (5, "zero-total", {"quote_total": 0.0}),
                    (6, "retainer-covered", {"retainer_paid_total": 99999.0}),
                ]:
                    p = AitoProject(
                        id=pid,
                        description=desc,
                        board_column="devis",
                        position=pid,
                        status=kw.pop("status", "active"),
                        quote_number=kw.pop("quote_number", f"DEV-00012{pid}"),
                        quote_status=kw.pop("quote_status", "sent"),
                        quote_total=kw.pop("quote_total", 12500.0),
                        quote_invoiced=False,
                        quote_expiry_date="2026-10-01",
                        retainer_paid_total=kw.pop("retainer_paid_total", None),
                    )
                    for k, v in kw.items():
                        setattr(p, k, v)
                    db.add(p)
                await db.commit()

            reset_budget()
            seen: list = []
            heimdall(responder(200, payment(), calls=seen))
            rec("20-refresh-mints", await c.post("/api/v1/aito/1/payment-link/refresh"), slim)
            out.append({"step": "20b-heimdall-calls", "calls": list(seen)})
            seen.clear()
            rec("21-refresh-again-is-a-noop", await c.post("/api/v1/aito/1/payment-link/refresh"), slim)
            out.append({"step": "21b-heimdall-calls", "calls": list(seen)})

            for pid, label in [(2, "no-quote"), (3, "declined"), (5, "zero-total"), (6, "retainer-covered")]:
                reset_budget()
                seen.clear()
                rec(f"22-refresh-{label}", await c.post(f"/api/v1/aito/{pid}/payment-link/refresh"), slim)
                out.append({"step": f"22b-{label}-calls", "calls": list(seen)})

            reset_budget()
            rec("23-refresh-trashed-project", await c.post("/api/v1/aito/4/payment-link/refresh"), slim)
            rec("24-refresh-unknown-project", await c.post("/api/v1/aito/999/payment-link/refresh"), slim)
            rec("25-refresh-negative-id", await c.post("/api/v1/aito/-1/payment-link/refresh"), slim)
            rec("26-refresh-non-numeric-id", await c.post("/api/v1/aito/abc/payment-link/refresh"), slim)

            # A Heimdall failure must reach sync_error, never a 5xx.
            reset_budget()
            async with sm() as db:
                p = AitoProject(
                    id=7,
                    description="failing",
                    board_column="devis",
                    position=7,
                    status="active",
                    quote_number="DEV-000127",
                    quote_status="sent",
                    quote_total=5000.0,
                    quote_invoiced=False,
                    quote_expiry_date="2026-10-01",
                )
                db.add(p)
                await db.commit()
            heimdall(responder(500, {"error": {"code": "internal", "message": "POS down"}}))
            rec("27-refresh-upstream-500", await c.post("/api/v1/aito/7/payment-link/refresh"), slim)
            heimdall(refuse)
            rec("28-refresh-unreachable", await c.post("/api/v1/aito/7/payment-link/refresh"), slim)
            heimdall(responder(429, {"error": {"code": "rate_limited"}}, {"Retry-After": "30"}))
            rec("29-refresh-upstream-429", await c.post("/api/v1/aito/7/payment-link/refresh"), slim)
            PL._throttled_until = None

            # The Retry budget: 10 per principal per window, then 429.
            reset_budget()
            heimdall(responder(200, payment(), calls=seen))
            codes = []
            for _ in range(13):
                r = await c.post("/api/v1/aito/1/payment-link/refresh")
                codes.append(r.status_code)
            out.append(
                {
                    "step": "30-retry-budget",
                    "status_codes": codes,
                    "last_body": (await c.post("/api/v1/aito/1/payment-link/refresh")).json(),
                }
            )
            reset_budget()

            # ---------- 3. payment_link on the project payload ------------
            async with sm() as db:
                rows = [
                    # a reservation that never completed -> payment_link is None
                    AitoPaymentLink(
                        project_id=2,
                        idempotency_key="aito:2:1",
                        heimdall_id=None,
                        reference="DEV-000122",
                        amount=12500,
                        expires_on="2026-10-01",
                        status="pending",
                    ),
                    AitoPaymentLink(
                        project_id=3,
                        idempotency_key="aito:3:1",
                        heimdall_id="hd-paid",
                        reference="DEV-000123",
                        amount=12500,
                        currency="XPF",
                        expires_on="2026-10-01",
                        status="paid",
                        url="https://secure.osb.pf/pay/paid",
                        paid_at=FROZEN_NOW,
                    ),
                    AitoPaymentLink(
                        project_id=5,
                        idempotency_key="aito:5:1",
                        heimdall_id="hd-failed",
                        reference="DEV-000125",
                        amount=12500,
                        expires_on="2026-10-01",
                        status="failed",
                        url=None,
                        sync_error="Heimdall HTTP 500 internal: boom",
                        sync_failures=3,
                    ),
                    # an unknown status must project as "pending"
                    AitoPaymentLink(
                        project_id=6,
                        idempotency_key="aito:6:1",
                        heimdall_id="hd-weird",
                        reference="DEV-000126",
                        amount=1,
                        expires_on="2026-10-01",
                        status="refunded",
                        url="https://secure.osb.pf/pay/weird",
                    ),
                    # a superseded row must not be the current link
                    AitoPaymentLink(
                        project_id=6,
                        idempotency_key="aito:6:0",
                        heimdall_id="hd-old",
                        reference="DEV-000126",
                        amount=99,
                        expires_on="2026-09-01",
                        status="cancelled",
                        superseded_at=FROZEN_NOW,
                    ),
                ]
                for r in rows:
                    db.add(r)
                await db.commit()

            # The board payload: `payment_link` rides on every project, so a
            # reservation, a paid link, a failed one, an unknown status and a
            # superseded row are all visible in one read.
            board = await c.get("/api/v1/aito/")
            body = board.json()
            out.append(
                {
                    "step": "40-board-payment-links",
                    "status": board.status_code,
                    "projects": (
                        sorted((slim(p) for p in body), key=lambda d: d.get("id") or 0)
                        if isinstance(body, list)
                        else body
                    ),
                }
            )
            trash = await c.get("/api/v1/aito/trash")
            tbody = trash.json()
            out.append(
                {
                    "step": "41-trash-payment-links",
                    "status": trash.status_code,
                    "projects": (
                        sorted((slim(p) for p in tbody), key=lambda d: d.get("id") or 0)
                        if isinstance(tbody, list)
                        else tbody
                    ),
                }
            )

    H.heimdall_service._transport = None
    app.dependency_overrides.clear()
    await engine.dispose()
    await asyncio.sleep(0.1)
    print(json.dumps(out, sort_keys=True, indent=1, default=str))


asyncio.run(main())
