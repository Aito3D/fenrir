"""The Heimdall /api/v1 client: signing, headers, response mapping, error classes."""

import json

import httpx
import pytest

from backend.app.api.routes.settings import set_setting
from backend.app.services.heimdall import (
    HeimdallAuthError,
    HeimdallConflict,
    HeimdallNotConfigured,
    HeimdallNotFound,
    HeimdallRateLimited,
    HeimdallUpstreamError,
    heimdall_service,
    parse_credential,
    sign,
)

TOKEN = "hmd_live.84f32b71ac095ed2.s3cret"


@pytest.fixture(autouse=True)
def reset_transport():
    heimdall_service._transport = None
    yield
    heimdall_service._transport = None


async def _configure(db, base_url="http://pos.local:8081", token=TOKEN):
    await set_setting(db, "heimdall_base_url", base_url)
    await set_setting(db, "heimdall_api_token", token)
    await db.commit()


def _link_json(**overrides):
    body = {
        "id": "6f1e2c3a-0000-4000-8000-000000000001",
        "method": "link",
        "status": "pending",
        "native_state": "running",
        "amount": 12500,
        "amount_confirmed": None,
        "currency": "XPF",
        "reference": "DEV-2026-1234",
        "invoice_id": None,
        "invoice_number": None,
        "link": {
            "url": "https://secure.osb.pf/pay/abc",
            "expires_at": "2026-09-27T23:59:59.999Z",
            "osb_order_id": "ORDER-1",
        },
        "booking": {"status": "pending", "zoho_payment_id": None, "error": None},
        "created_at": "2026-09-12T22:41:03.221Z",
        "updated_at": "2026-09-12T22:41:03.221Z",
    }
    body.update(overrides)
    return body


# --- pure signing -----------------------------------------------------------


def test_sign_matches_the_documented_recipe():
    # Known answer computed with hmac/hashlib over the canonical string
    # POST\n/api/v1/payments\n1757700000\n<nonce>\nsha256(body).
    body = b'{"amount":12500,"currency":"XPF","method":"link","reference":"DEV-2026-1234"}'
    sig = sign("post", "/api/v1/payments", body, "s3cret", 1757700000, "0123456789abcdef0123456789abcdef")
    assert sig == "sha256=97713194f8190db699a6414694d8a605ff6355bd9d2ad830b11ad8b3f022bfa9"


def test_sign_hashes_zero_bytes_for_an_empty_body_and_keeps_the_query_string():
    sig = sign("GET", "/api/v1/payments/abc?x=1", b"", "s3cret", 1757700000, "n0nce-n0nce-n0nce")
    assert sig == "sha256=418a0f524756062458354d6c5ac9a24f085f2a66fd3817cd790bec4dcc0e1b6e"


def test_sign_reproduces_the_contracts_worked_example():
    # heimdall/docs/API.md "A worked, byte-checkable example".
    body = b'{"method":"link","amount":12500,"currency":"XPF","reference":"DEV-000123"}'
    sig = sign(
        "POST",
        "/api/v1/payments",
        body,
        "2vy0_YZCo5BscR8UgRTVYTO1NB46EyARcIalbpnJD7o",
        1757707200,
        "n0nce_1757707200abcXYZ",
    )
    assert sig == "sha256=28f5920b36a4c33f77360e45a3cc188a1606a4f3d3e2b19d2a48724857b5a7a2"


def test_credential_splits_on_dots():
    assert parse_credential("hmd_live.84f32b71ac095ed2.abc_def-x") == ("84f32b71ac095ed2", "abc_def-x")
    for bad in ("pos_deadbeef", "hmd_live_a1b2c3d4_s3cret", "hmd_live.abc.", "hmd_live..s"):
        with pytest.raises(HeimdallNotConfigured):
            parse_credential(bad)


# --- wire -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_not_configured_without_url_or_token(db_session):
    assert await heimdall_service.is_configured(db_session) is False
    with pytest.raises(HeimdallNotConfigured):
        await heimdall_service.ping(db_session)


@pytest.mark.asyncio
async def test_create_link_sends_signed_request_and_maps_the_response(db_session):
    await _configure(db_session)
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["url"] = str(request.url)
        seen["headers"] = dict(request.headers)
        seen["body"] = request.content
        return httpx.Response(201, json=_link_json())

    heimdall_service._transport = httpx.MockTransport(handler)
    view = await heimdall_service.create_link(
        db_session, idempotency_key="aito:12:1", reference="DEV-2026-1234", amount=12500, expires_in_days=15
    )
    assert seen["method"] == "POST" and seen["url"] == "http://pos.local:8081/api/v1/payments"
    h = seen["headers"]
    assert h["x-heimdall-key-id"] == "84f32b71ac095ed2" and "authorization" not in h
    assert h["idempotency-key"] == "aito:12:1"
    assert h["content-type"] == "application/json"
    assert 16 <= len(h["x-heimdall-nonce"]) <= 128
    # The signature covers the exact bytes sent, verified with the same recipe.
    expected = sign(
        "POST", "/api/v1/payments", seen["body"], "s3cret", int(h["x-heimdall-timestamp"]), h["x-heimdall-nonce"]
    )
    assert h["x-heimdall-signature"] == expected
    assert json.loads(seen["body"]) == {
        "method": "link",
        "amount": 12500,
        "currency": "XPF",
        "reference": "DEV-2026-1234",
        "expires_in_days": 15,
    }
    assert view.id == "6f1e2c3a-0000-4000-8000-000000000001"
    assert view.status == "pending" and view.amount == 12500 and view.reference == "DEV-2026-1234"
    assert view.url == "https://secure.osb.pf/pay/abc" and view.expires_at == "2026-09-27T23:59:59.999Z"


@pytest.mark.asyncio
async def test_patch_cancel_get_hit_the_right_paths(db_session):
    await _configure(db_session)
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path, request.content))
        return httpx.Response(
            200, json=_link_json(status="cancelled" if request.url.path.endswith("/cancel") else "pending")
        )

    heimdall_service._transport = httpx.MockTransport(handler)
    await heimdall_service.patch_link(db_session, "6f1e", amount=13000)
    await heimdall_service.patch_link(db_session, "6f1e", expires_in_days=3)
    cancelled = await heimdall_service.cancel_link(db_session, "6f1e")
    await heimdall_service.get_payment(db_session, "6f1e")
    assert calls[0][:2] == ("PATCH", "/api/v1/payments/6f1e") and json.loads(calls[0][2]) == {"amount": 13000}
    assert json.loads(calls[1][2]) == {"expires_in_days": 3}
    assert calls[2][:2] == ("POST", "/api/v1/payments/6f1e/cancel") and calls[2][2] == b""
    assert calls[3][:2] == ("GET", "/api/v1/payments/6f1e")
    assert cancelled.status == "cancelled"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "code", "exc"),
    [
        (401, "unauthorized", HeimdallAuthError),
        (403, "forbidden", HeimdallAuthError),
        (404, "not_found", HeimdallNotFound),
        (409, "conflict", HeimdallConflict),
        (409, "idempotency_conflict", HeimdallConflict),
        (429, "rate_limited", HeimdallRateLimited),
        (502, "unavailable", HeimdallUpstreamError),
        (500, "internal", HeimdallUpstreamError),
    ],
)
async def test_error_envelope_maps_to_exception_classes(db_session, status, code, exc):
    await _configure(db_session)
    heimdall_service._transport = httpx.MockTransport(
        lambda r: httpx.Response(
            status, json={"error": {"code": code, "message": "nope"}}, headers={"Retry-After": "7"}
        )
    )
    with pytest.raises(exc) as info:
        await heimdall_service.get_payment(db_session, "6f1e")
    if exc is HeimdallConflict:
        assert info.value.code == code
    if exc is HeimdallRateLimited:
        assert info.value.retry_after == 7.0
    if exc is HeimdallAuthError:
        assert info.value.status == status


@pytest.mark.asyncio
async def test_transport_failure_and_non_json_are_upstream_errors(db_session):
    await _configure(db_session)

    def boom(request):
        raise httpx.ConnectError("refused")

    heimdall_service._transport = httpx.MockTransport(boom)
    with pytest.raises(HeimdallUpstreamError):
        await heimdall_service.ping(db_session)
    heimdall_service._transport = httpx.MockTransport(lambda r: httpx.Response(200, content=b"<html>"))
    with pytest.raises(HeimdallUpstreamError):
        await heimdall_service.get_payment(db_session, "6f1e")


@pytest.mark.asyncio
async def test_ping_accepts_overrides_for_the_settings_test_button(db_session):
    # Nothing saved: the override alone is what gets used.
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["key_id"] = request.headers["x-heimdall-key-id"]
        return httpx.Response(200, json={"ok": True})

    heimdall_service._transport = httpx.MockTransport(handler)
    await heimdall_service.ping(db_session, base_url="http://other:8081/", token=TOKEN)
    assert seen["url"] == "http://other:8081/api/v1/ping" and seen["key_id"] == "84f32b71ac095ed2"
