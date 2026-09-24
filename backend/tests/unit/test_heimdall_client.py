"""The Heimdall /api/v1 client: signing, headers, response mapping, error classes."""

import hashlib
import hmac
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
    _to_view,
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


def _canonical_hmac(secret: bytes, *lines: str) -> str:
    return "sha256=" + hmac.new(secret, "\n".join(lines).encode(), hashlib.sha256).hexdigest()


def test_sign_matches_the_documented_recipe():
    # The six canonical lines, spelled out: METHOD upper-cased, path,
    # timestamp, nonce, sha256(body) lowercase hex, Idempotency-Key.
    body = b'{"amount":12500,"currency":"XPF","method":"link","reference":"DEV-2026-1234"}'
    sig = sign("post", "/api/v1/payments", body, "s3cret", 1757700000, "0123456789abcdef0123456789abcdef", "aito:1:1")
    assert sig == _canonical_hmac(
        b"s3cret",
        "POST",
        "/api/v1/payments",
        "1757700000",
        "0123456789abcdef0123456789abcdef",
        hashlib.sha256(body).hexdigest(),
        "aito:1:1",
    )


def test_sign_hashes_zero_bytes_for_an_empty_body_and_keeps_the_query_string():
    sig = sign("GET", "/api/v1/payments/abc?x=1", b"", "s3cret", 1757700000, "n0nce-n0nce-n0nce")
    assert sig == _canonical_hmac(
        b"s3cret",
        "GET",
        "/api/v1/payments/abc?x=1",
        "1757700000",
        "n0nce-n0nce-n0nce",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",  # sha256 of zero bytes
        "",
    )


def test_sign_reproduces_the_contracts_worked_example():
    # heimdall/docs/API.md "A worked, byte-checkable example": SIX canonical
    # lines, the last one the Idempotency-Key header value (`order-42`
    # here). The value is the doc's own output of Heimdall's signParts, not
    # something we computed — a five-line signer gets `401 Invalid request
    # signature` against the live server.
    body = b'{"method":"link","amount":12500,"currency":"XPF","reference":"DEV-000123"}'
    sig = sign(
        "POST",
        "/api/v1/payments",
        body,
        "2vy0_YZCo5BscR8UgRTVYTO1NB46EyARcIalbpnJD7o",
        1757707200,
        "n0nce_1757707200abcXYZ",
        idempotency_key="order-42",
    )
    assert sig == "sha256=a1bb7a336acc3afee8dabca6aa3ee6b0366a88972a91bc1137a1879beb30fc5c"


def test_sign_binds_an_empty_sixth_line_when_no_idempotency_key_is_sent():
    # The contract: "Sixth line is '' (the empty string, not omitted)
    # whenever the request carries no Idempotency-Key at all." So a GET
    # signs `...\n<body hash>\n` — one more line than the five-line form,
    # and a different signature from it.
    five_line = "GET\n/api/v1/ping\n1757700000\nn0nce-n0nce-n0nce\n" + hashlib.sha256(b"").hexdigest()
    six_line = five_line + "\n"
    expected = "sha256=" + hmac.new(b"s3cret", six_line.encode(), hashlib.sha256).hexdigest()
    sig = sign("GET", "/api/v1/ping", b"", "s3cret", 1757700000, "n0nce-n0nce-n0nce")
    assert sig == expected
    assert sig != "sha256=" + hmac.new(b"s3cret", five_line.encode(), hashlib.sha256).hexdigest()


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
    # The signature covers the exact bytes sent AND the Idempotency-Key as
    # sent, verified with the same recipe.
    expected = sign(
        "POST",
        "/api/v1/payments",
        seen["body"],
        "s3cret",
        int(h["x-heimdall-timestamp"]),
        h["x-heimdall-nonce"],
        idempotency_key="aito:12:1",
    )
    assert h["x-heimdall-signature"] == expected
    assert h["x-heimdall-signature"] != sign(
        "POST", "/api/v1/payments", seen["body"], "s3cret", int(h["x-heimdall-timestamp"]), h["x-heimdall-nonce"]
    ), "the Idempotency-Key must be bound into the signature, not left out"
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


# heimdall/docs/API.md, "Signing": normalise BEFORE signing, not after --
# "so a space or a `..` cannot be signed in one form and sent in another by
# fetch". patch_link/cancel_link/get_payment build `path` as a raw f-string
# (heimdall.py) and hand `sign(method, path, ...)` that exact, unescaped
# string; `_request` then hands `f"{base_url}{path}"` to httpx, which
# percent-encodes/resolves it independently once it parses that string into
# a URL. For a plain id the two forms are byte-identical and nothing is
# observable; for an id containing a space, or a `/..` segment, the SIGNED
# path and the SENT path diverge. Heimdall verifies the signature against
# the bytes it actually received, so that divergence would surface only as
# an opaque `401 Invalid request signature` -- never as a clue pointing at
# escaping. Each row is (heimdall_id, expected wire path for PATCH/GET,
# expected wire path for the cancel POST, which appends "/cancel").
_ID_ENCODING_CASES = [
    pytest.param("6f1e", "/api/v1/payments/6f1e", "/api/v1/payments/6f1e/cancel", id="plain-id-is-unaffected"),
    pytest.param(
        "hd 1",
        "/api/v1/payments/hd%201",
        "/api/v1/payments/hd%201/cancel",
        id="space-is-percent-encoded-on-the-wire",
    ),
    pytest.param(
        "hd-1/../ping",
        "/api/v1/payments/ping",
        "/api/v1/payments/ping/cancel",
        id="slash-and-dot-segments-resolve-to-a-different-endpoint",
    ),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(("heimdall_id", "wire_path", "wire_cancel_path"), _ID_ENCODING_CASES)
async def test_signature_is_over_the_raw_path_not_the_encoded_wire_path(
    db_session, heimdall_id, wire_path, wire_cancel_path
):
    """Pins TODAY's behavior: the signature covers the raw, unescaped
    f-string path, not the (possibly different) bytes httpx actually sends.
    `snapshots/heimdall-wire.golden`'s `get_payment-id-with-slash` /
    `-id-with-space` entries record the same wire paths asserted here.

    When T-005 (normalise-before-sign: sign `httpx.URL(...).raw_path`
    instead of the raw f-string) lands, this test's two assertions per case
    -- `signature == signed_over_raw_path` and, where the paths differ,
    `signature != signed_over_wire_path` -- must be swapped, not deleted;
    that is the whole point of pinning the current, divergent behavior here.
    """
    await _configure(db_session)
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["raw_path"] = request.url.raw_path
        seen["signature"] = request.headers["x-heimdall-signature"]
        seen["timestamp"] = request.headers["x-heimdall-timestamp"]
        seen["nonce"] = request.headers["x-heimdall-nonce"]
        seen["body"] = request.content
        return httpx.Response(200, json=_link_json())

    heimdall_service._transport = httpx.MockTransport(handler)

    # (HTTP method, the exact f-string `path` heimdall.py builds and signs,
    # the coroutine to run, the wire path we expect httpx to actually send).
    calls = [
        (
            "PATCH",
            f"/api/v1/payments/{heimdall_id}",
            heimdall_service.patch_link(db_session, heimdall_id, amount=9000),
            wire_path,
        ),
        (
            "POST",
            f"/api/v1/payments/{heimdall_id}/cancel",
            heimdall_service.cancel_link(db_session, heimdall_id),
            wire_cancel_path,
        ),
        (
            "GET",
            f"/api/v1/payments/{heimdall_id}",
            heimdall_service.get_payment(db_session, heimdall_id),
            wire_path,
        ),
    ]
    for method, signed_fstring_path, coro, expected_wire_path in calls:
        seen.clear()
        await coro

        # The bytes actually on the wire, captured from inside the mock
        # transport -- this is httpx's own encoding, not anything heimdall.py
        # computes, and it matches the golden's recorded wire paths.
        assert seen["raw_path"] == expected_wire_path.encode()

        body_hash = hashlib.sha256(seen["body"]).hexdigest()
        # Two independent recomputations of the six-line canonical HMAC
        # (built with hmac.new directly, exactly like
        # test_sign_reproduces_the_contracts_worked_example -- never via
        # sign() itself, so this cannot pass just because sign() and the
        # client agree on what "the path" means).
        signed_over_raw_path = _canonical_hmac(
            b"s3cret", method, signed_fstring_path, seen["timestamp"], seen["nonce"], body_hash, ""
        )
        signed_over_wire_path = _canonical_hmac(
            b"s3cret", method, seen["raw_path"].decode(), seen["timestamp"], seen["nonce"], body_hash, ""
        )

        # TODAY: the client signs the raw, unescaped path it interpolated --
        # not the bytes httpx actually puts on the wire.
        assert seen["signature"] == signed_over_raw_path
        if signed_fstring_path == expected_wire_path:
            assert seen["signature"] == signed_over_wire_path
        else:
            assert seen["signature"] != signed_over_wire_path, (
                "the raw and wire paths differ for this id, so a signature that matches "
                "both would mean the divergence this test exists to pin has disappeared "
                "-- i.e. T-005 landed and this test's expectations need to be flipped"
            )


def test_to_view_accepts_a_normal_https_link_url():
    view = _to_view(_link_json())
    assert view.url == "https://secure.osb.pf/pay/abc"


def test_to_view_accepts_a_missing_or_null_link_url():
    # Not every payment has a link yet — this must stay a valid, linkless
    # view rather than an error.
    without_link = _link_json()
    del without_link["link"]
    assert _to_view(without_link).url is None

    assert _to_view(_link_json(link={"url": None, "expires_at": None})).url is None


@pytest.mark.parametrize(
    "bad_url",
    [
        "javascript:alert(document.cookie)",
        "data:text/html,<script>alert(1)</script>",
        "file:///etc/passwd",
        "//attacker.example/pay",
        "ftp://attacker.example/pay",
        "not-a-url-at-all",
        "",
        "https:///no-hostname",
        "x" * 501,
    ],
)
def test_to_view_rejects_a_link_url_that_is_not_a_safe_http_url(bad_url):
    # An unauthenticated Heimdall response is where an attacker on the LAN
    # hop (or a compromised POS host) could hand back a url that gets
    # rendered verbatim to the customer's tracking page and the operator's
    # panel; this must surface as a sync error, not as a stored/rendered
    # value.
    with pytest.raises(HeimdallUpstreamError):
        _to_view(_link_json(link={"url": bad_url, "expires_at": None}))


def test_to_view_rejects_a_non_string_link_url():
    with pytest.raises(HeimdallUpstreamError):
        _to_view(_link_json(link={"url": 12345, "expires_at": None}))


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


def _terminal_json(**overrides):
    base = {
        "id": "9a0b1c2d-0000-4000-8000-000000000002",
        "method": "terminal",
        "status": "processing",
        "native_state": "sending_to_tpe",
        "amount": 23000,
        "amount_confirmed": None,
        "currency": "XPF",
        "reference": None,
        "link": None,
        "booking": {"status": "pending", "zoho_payment_id": None, "error": None},
        "zoho_reference": {"kind": "invoice", "id": "460000000123456", "number": "FA-26-4358", "customer_name": "ACME"},
        "created_at": "2026-09-23T01:00:00.000Z",
        "updated_at": "2026-09-23T01:00:00.000Z",
    }
    base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_create_terminal_payment_sends_confirm_true_with_the_document(db_session):
    await _configure(db_session)
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        seen["idem"] = request.headers["idempotency-key"]
        return httpx.Response(202, json=_terminal_json())

    heimdall_service._transport = httpx.MockTransport(handler)
    view = await heimdall_service.create_terminal_payment(
        db_session,
        idempotency_key="aito-tpe:12:1",
        amount=23000,
        document={"type": "invoice", "id": "460000000123456"},
    )
    assert seen["idem"] == "aito-tpe:12:1"
    assert seen["body"] == {
        "method": "terminal",
        "amount": 23000,
        "currency": "XPF",
        "confirm": True,
        "document": {"type": "invoice", "id": "460000000123456"},
    }
    assert view.status == "processing" and view.native_state == "sending_to_tpe"
    assert view.amount_confirmed is None and view.booking_status == "pending" and view.url is None


@pytest.mark.asyncio
async def test_create_terminal_payment_omits_document_for_a_free_amount(db_session):
    await _configure(db_session)
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(202, json=_terminal_json(zoho_reference=None))

    heimdall_service._transport = httpx.MockTransport(handler)
    await heimdall_service.create_terminal_payment(db_session, idempotency_key="k", amount=100, document=None)
    assert "document" not in seen["body"]


def test_to_view_reads_booking_and_confirmed_amount():
    view = _to_view(
        _terminal_json(
            status="paid",
            native_state="synced",
            amount_confirmed=23000,
            booking={"status": "booked", "zoho_payment_id": "pay-1", "error": None},
        )
    )
    assert view.amount_confirmed == 23000
    assert view.booking_status == "booked" and view.zoho_payment_id == "pay-1" and view.booking_error is None


def test_to_view_tolerates_a_missing_booking_block():
    view = _to_view(_link_json())
    assert view.native_state == "running"
    assert view.booking_status == "pending"  # _link_json carries a booking block
    view2 = _to_view({k: v for k, v in _link_json().items() if k != "booking"})
    assert view2.booking_status is None and view2.amount_confirmed is None


@pytest.mark.asyncio
async def test_422_maps_to_heimdall_invalid_with_the_message(db_session):
    from backend.app.services.heimdall import HeimdallInvalid

    await _configure(db_session)
    heimdall_service._transport = httpx.MockTransport(
        lambda r: httpx.Response(
            422, json={"error": {"code": "invalid_request", "message": "amount 30000 exceeds balance 23000"}}
        )
    )
    with pytest.raises(HeimdallInvalid) as exc:
        await heimdall_service.create_terminal_payment(db_session, idempotency_key="k", amount=30000, document=None)
    assert "exceeds balance 23000" in str(exc.value)
    assert isinstance(exc.value, HeimdallUpstreamError)
