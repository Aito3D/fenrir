"""Golden probe (campaign 17): exactly what the Heimdall client puts on the
wire, and exactly which exception each upstream answer becomes.

An httpx.MockTransport stands in for the POS bridge and records the request
byte for byte — method, full URL, every header, the raw body — for all five
calls (ping, create, patch, cancel, get). The clock and the nonce are frozen
so the signature is reproducible, which means a change to the canonical
string, the header set, the body serialisation, the URL joining or the
Content-Type rule shows up as a diff here even when the unit tests keep
passing (they re-derive the HMAC with the same recipe they test).

The second half pins ERROR MAPPING: 400/401/403/404/409/422/429/500/503, a
non-JSON body, an empty body, a non-object JSON body, a transport failure,
and a malformed payment shape each become one named exception carrying one
message. The reconciler in services/aito_payment_links.py branches on those
classes, so the mapping is behavior, not an implementation detail.

Settings are read from a real in-memory SQLite database, as in production.
"""

import asyncio
import json
import secrets as _secrets
import sys
import time as _time

sys.path.insert(0, ".")

import httpx  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402

import backend.app.main  # noqa: E402,F401  (registers every model on Base.metadata)
from backend.app.api.routes.settings import set_setting  # noqa: E402
from backend.app.core.database import Base  # noqa: E402
from backend.app.services import heimdall as H  # noqa: E402

TOKEN = "hmd_live.84f32b71ac095ed2.2vy0_YZCo5BscR8UgRTVYTO1NB46EyARcIalbpnJD7o"
BASE_URL = "http://pos.local:8081"
FROZEN_TS = 1757707200
FROZEN_NONCE = "0123456789abcdef0123456789abcdef"

PAYMENT = {
    "id": "6f1e2c3a-0000-4000-8000-000000000001",
    "method": "link",
    "status": "pending",
    "native_state": "running",
    "amount": 12500,
    "amount_confirmed": None,
    "currency": "XPF",
    "reference": "DEV-000123",
    "invoice_id": None,
    "link": {
        "url": "https://secure.osb.pf/pay/abc",
        "expires_at": "2026-09-27T23:59:59.999Z",
        "osb_order_id": "ORDER-1",
    },
    "booking": {"status": "pending", "zoho_payment_id": None, "error": None},
    "created_at": "2026-09-12T22:41:03.221Z",
}


def view(v) -> dict:
    return {
        "id": v.id,
        "status": v.status,
        "amount": v.amount,
        "currency": v.currency,
        "reference": v.reference,
        "url": v.url,
        "expires_at": v.expires_at,
    }


def record_request(r: httpx.Request) -> dict:
    return {
        "method": r.method,
        "url": str(r.url),
        "path": r.url.path,
        "query": r.url.query.decode() if r.url.query else "",
        # Every header the client sets, verbatim. httpx adds host/accept/
        # connection/user-agent itself; those are dropped so an httpx upgrade
        # does not read as a behavior change, but OUR five signing headers,
        # Content-Type and Idempotency-Key are all kept.
        "headers": {
            k: v
            for k, v in sorted(r.headers.items())
            if k.lower()
            in {
                "x-heimdall-key-id",
                "x-heimdall-timestamp",
                "x-heimdall-nonce",
                "x-heimdall-signature",
                "idempotency-key",
                "content-type",
                "authorization",
                "content-length",
            }
        },
        "body": r.content.decode("utf-8") if r.content else "",
        "body_len": len(r.content),
    }


async def main() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sm = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    out: dict = {}

    # Freeze the two sources of per-request entropy.
    _time.time = lambda: float(FROZEN_TS)  # type: ignore[assignment]
    _secrets.token_hex = lambda n=32: FROZEN_NONCE  # type: ignore[assignment]

    async with sm() as db:
        await set_setting(db, "heimdall_base_url", BASE_URL)
        await set_setting(db, "heimdall_api_token", TOKEN)
        await db.commit()

        # --- 1. the five calls, request bytes captured -----------------
        captured: list[dict] = []

        def ok_handler(request: httpx.Request) -> httpx.Response:
            captured.append(record_request(request))
            return httpx.Response(200, json=PAYMENT)

        H.heimdall_service._transport = httpx.MockTransport(ok_handler)

        calls = []
        await H.heimdall_service.ping(db)
        calls.append({"call": "ping", "result": None})
        calls.append(
            {
                "call": "create_link",
                "result": view(
                    await H.heimdall_service.create_link(
                        db, idempotency_key="aito:7:2", reference="DEV-000123", amount=12500, expires_in_days=15
                    )
                ),
            }
        )
        calls.append(
            {
                "call": "patch_link-amount-only",
                "result": view(await H.heimdall_service.patch_link(db, "hd-1", amount=9000)),
            }
        )
        calls.append(
            {
                "call": "patch_link-expiry-only",
                "result": view(await H.heimdall_service.patch_link(db, "hd-1", expires_in_days=7)),
            }
        )
        calls.append(
            {
                "call": "patch_link-both",
                "result": view(await H.heimdall_service.patch_link(db, "hd-1", amount=9000, expires_in_days=7)),
            }
        )
        calls.append({"call": "patch_link-neither", "result": view(await H.heimdall_service.patch_link(db, "hd-1"))})
        calls.append({"call": "cancel_link", "result": view(await H.heimdall_service.cancel_link(db, "hd-1"))})
        calls.append({"call": "get_payment", "result": view(await H.heimdall_service.get_payment(db, "hd-1"))})
        # An id that needs escaping: it is interpolated straight into the path.
        calls.append(
            {
                "call": "get_payment-id-with-slash",
                "result": view(await H.heimdall_service.get_payment(db, "hd-1/../ping")),
            }
        )
        calls.append(
            {"call": "get_payment-id-with-space", "result": view(await H.heimdall_service.get_payment(db, "hd 1"))}
        )
        calls.append(
            {"call": "get_payment-id-with-query", "result": view(await H.heimdall_service.get_payment(db, "hd?x=1"))}
        )
        # Overrides: the Settings Test button path.
        await H.heimdall_service.ping(db, base_url="http://other.local:9999/", token=TOKEN)
        calls.append({"call": "ping-with-overrides", "result": None})
        out["01-results"] = calls
        out["02-requests"] = list(captured)

        # --- 2. error mapping ------------------------------------------
        def err(status: int, body=None, headers=None, raw: str | None = None):
            def handler(request: httpx.Request) -> httpx.Response:
                if raw is not None:
                    return httpx.Response(status, text=raw, headers=headers or {})
                return httpx.Response(status, json=body, headers=headers or {})

            return handler

        ERRORS = [
            ("400-invalid-request", err(400, {"error": {"code": "invalid_request", "message": "bad body"}})),
            ("401-bad-signature", err(401, {"error": {"code": "unauthorized", "message": "Invalid request signature"}})),
            ("403-missing-scope", err(403, {"error": {"code": "forbidden", "message": "scope payments:write"}})),
            ("404-no-such-payment", err(404, {"error": {"code": "not_found", "message": "no such payment"}})),
            ("409-state-moved", err(409, {"error": {"code": "conflict_state", "message": "already cancelled"}})),
            ("409-idempotency-reuse", err(409, {"error": {"code": "idempotency_key_reuse", "message": "different body"}})),
            ("409-no-code", err(409, {"error": {"message": "no code field"}})),
            ("409-no-error-object", err(409, {})),
            ("422-unprocessable", err(422, {"error": {"code": "unprocessable", "message": "amount too small"}})),
            ("429-retry-after-30", err(429, {"error": {"code": "rate_limited"}}, {"Retry-After": "30"})),
            ("429-retry-after-absent", err(429, {"error": {"code": "rate_limited"}})),
            ("429-retry-after-garbage", err(429, {"error": {"code": "rate_limited"}}, {"Retry-After": "soon"})),
            ("429-retry-after-http-date", err(429, {}, {"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"})),
            ("429-retry-after-negative", err(429, {}, {"Retry-After": "-5"})),
            ("429-retry-after-float", err(429, {}, {"Retry-After": "1.5"})),
            ("500-server-error", err(500, {"error": {"code": "internal", "message": "boom"}})),
            ("503-unavailable", err(503, {})),
            ("500-html-body", err(500, raw="<html>502 Bad Gateway</html>")),
            ("200-non-json-body", err(200, raw="not json at all")),
            ("200-empty-body", err(200, raw="")),
            ("200-json-array", err(200, [1, 2, 3])),
            ("200-json-string", err(200, "a string")),
            ("200-missing-id", err(200, {"status": "pending", "amount": 1})),
            ("200-missing-status", err(200, {"id": "x", "amount": 1})),
            ("200-amount-not-a-number", err(200, {"id": "x", "status": "pending", "amount": "lots"})),
            ("200-amount-null", err(200, {"id": "x", "status": "pending", "amount": None})),
            ("200-link-null", err(200, {"id": "x", "status": "pending", "amount": 1, "link": None})),
            ("200-link-not-an-object", err(200, {"id": "x", "status": "pending", "amount": 1, "link": "str"})),
            ("200-minimal-valid", err(200, {"id": "x", "status": "pending", "amount": 1})),
            ("200-currency-null", err(200, {"id": "x", "status": "paid", "amount": 1, "currency": None})),
            ("200-reference-null", err(200, {"id": "x", "status": "paid", "amount": 1, "reference": None})),
            ("200-amount-float", err(200, {"id": "x", "status": "paid", "amount": 12500.7})),
            ("200-id-numeric", err(200, {"id": 42, "status": "paid", "amount": 1})),
        ]
        mapping = []
        for name, handler in ERRORS:
            H.heimdall_service._transport = httpx.MockTransport(handler)
            row: dict = {"case": name}
            try:
                v = await H.heimdall_service.get_payment(db, "hd-1")
                row["outcome"] = "ok"
                row["view"] = view(v)
            except Exception as e:  # noqa: BLE001 — the class IS the observable
                row["outcome"] = type(e).__name__
                row["message"] = str(e)
                for attr in ("status", "code", "retry_after"):
                    if hasattr(e, attr):
                        row[attr] = getattr(e, attr)
            mapping.append(row)

        # A transport-level failure (DNS, refused, timeout).
        def boom(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused", request=request)

        H.heimdall_service._transport = httpx.MockTransport(boom)
        try:
            await H.heimdall_service.get_payment(db, "hd-1")
            mapping.append({"case": "transport-connect-error", "outcome": "ok"})
        except Exception as e:  # noqa: BLE001
            mapping.append({"case": "transport-connect-error", "outcome": type(e).__name__, "message": str(e)})

        def slow(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("timed out", request=request)

        H.heimdall_service._transport = httpx.MockTransport(slow)
        try:
            await H.heimdall_service.get_payment(db, "hd-1")
            mapping.append({"case": "transport-read-timeout", "outcome": "ok"})
        except Exception as e:  # noqa: BLE001
            mapping.append({"case": "transport-read-timeout", "outcome": type(e).__name__, "message": str(e)})
        out["03-error-mapping"] = mapping

        # --- 3. configuration gate -------------------------------------
        H.heimdall_service._transport = httpx.MockTransport(ok_handler)
        cfg = []
        for label, url, token in [
            ("both-set", BASE_URL, TOKEN),
            ("url-blank", "", TOKEN),
            ("token-blank", BASE_URL, ""),
            ("both-blank", "", ""),
            ("url-whitespace", "   ", TOKEN),
            ("token-whitespace", BASE_URL, "   "),
            ("url-trailing-slashes", BASE_URL + "///", TOKEN),
            ("token-not-a-credential", BASE_URL, "plain-token"),
            ("token-padded", BASE_URL, "  " + TOKEN + "  "),
            ("url-with-path", BASE_URL + "/bridge", TOKEN),
        ]:
            await set_setting(db, "heimdall_base_url", url)
            await set_setting(db, "heimdall_api_token", token)
            await db.commit()
            row = {"case": label, "is_configured": await H.heimdall_service.is_configured(db)}
            captured.clear()
            try:
                await H.heimdall_service.ping(db)
                row["ping"] = "ok"
                row["ping_url"] = captured[0]["url"] if captured else None
            except Exception as e:  # noqa: BLE001
                row["ping"] = type(e).__name__
                row["message"] = str(e)
            cfg.append(row)
        out["04-configuration"] = cfg

    H.heimdall_service._transport = None
    await engine.dispose()
    await asyncio.sleep(0.05)
    print(json.dumps(out, sort_keys=True, indent=1, default=str))


asyncio.run(main())
