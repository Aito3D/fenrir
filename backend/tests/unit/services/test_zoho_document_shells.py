"""The nine per-document Books methods, pinned side by side.

PDF fetch, default-email read and email send each exist for estimates,
invoices and retainer invoices. Within a family the three must differ ONLY in
the REST resource they address, so this pins, for every method: the exact
request (verb, raw path with the id escaped, query, JSON body) and the result
or exception for every response shape the shared handling distinguishes.
"""

import json

import httpx
import pytest

from backend.app.services.zoho import (
    ZohoAmbiguous,
    ZohoNotFound,
    ZohoRateLimited,
    ZohoRequestRejected,
    ZohoUpstreamError,
    zoho_service,
)

# Escaped by _seg: "/" -> %2F, " " -> %20, "." kept literally inside the segment.
RAW_ID = "a/b c.7"
QUOTED_ID = "a%2Fb%20c.7"

PDF_METHODS = [
    ("get_estimate_pdf", "estimates"),
    ("get_invoice_pdf", "invoices"),
    ("get_retainer_invoice_pdf", "retainerinvoices"),
]
CONTENT_METHODS = [
    ("get_estimate_email_content", "estimates"),
    ("get_invoice_email_content", "invoices"),
    ("get_retainer_email_content", "retainerinvoices"),
]
SEND_METHODS = [
    ("email_estimate", "estimates"),
    ("email_invoice", "invoices"),
    ("email_retainer", "retainerinvoices"),
]
ALL_METHODS = (
    [(name, res, "pdf") for name, res in PDF_METHODS]
    + [(name, res, "content") for name, res in CONTENT_METHODS]
    + [(name, res, "send") for name, res in SEND_METHODS]
)
ALL_IDS = [m[0] for m in ALL_METHODS]


@pytest.fixture(autouse=True)
def reset_service():
    zoho_service.invalidate_token()
    zoho_service.transport = None
    yield
    zoho_service.invalidate_token()
    zoho_service.transport = None


async def _configure(async_client):
    await async_client.put(
        "/api/v1/settings/",
        json={
            "zoho_client_id": "1000.FAKE",
            "zoho_client_secret": "fake-secret",
            "zoho_refresh_token": "1000.fake.refresh",
            "zoho_organization_id": "999",
        },
    )


def _serve(api_response: httpx.Response) -> list[httpx.Request]:
    """Token endpoint answered, then `api_response` for every Books call."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at-1", "expires_in": 3600})
        seen.append(request)
        return api_response

    zoho_service.transport = httpx.MockTransport(handler)
    return seen


def _call(name: str, kind: str, db):
    method = getattr(zoho_service, name)
    if kind == "send":
        return method(db, RAW_ID, to_mail_ids=["a@example.pf", "b@example.pf"])
    return method(db, RAW_ID)


EMAIL_PAYLOAD = {
    "code": 0,
    "data": {
        "subject": "Sujet",
        "body": "<p>Corps</p>",
        "to_contacts": [
            {"contact_person_id": "cp-1", "email": "jp@example.pf", "first_name": "jean-pierre", "last_name": "dupont"},
            {"contact_person_id": "cp-2", "email": "", "first_name": "Marie", "last_name": "Tama"},
            {"contact_person_id": "cp-3", "first_name": "No", "last_name": "Key"},
            {"email": "solo@example.pf", "first_name": "solo"},
        ],
    },
}


# --- the request each method sends ---------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(("name", "resource", "kind"), ALL_METHODS, ids=ALL_IDS)
async def test_request_shape(async_client, db_session, name, resource, kind):
    await _configure(async_client)
    if kind == "pdf":
        response = httpx.Response(200, content=b"%PDF-1.4 x")
    elif kind == "content":
        response = httpx.Response(200, json=EMAIL_PAYLOAD)
    else:
        response = httpx.Response(200, json={"code": 0, "message": "sent"})
    seen = _serve(response)

    await _call(name, kind, db_session)

    assert len(seen) == 1
    request = seen[0]
    suffix = "" if kind == "pdf" else "/email"
    assert request.method == ("POST" if kind == "send" else "GET")
    assert request.url.raw_path.split(b"?")[0] == f"/books/v3/{resource}/{QUOTED_ID}{suffix}".encode()
    expected_query = {"organization_id": "999"}
    if kind == "pdf":
        expected_query["accept"] = "pdf"
    assert dict(request.url.params) == expected_query
    assert request.headers["authorization"] == "Zoho-oauthtoken at-1"
    if kind == "send":
        assert json.loads(request.content) == {"to_mail_ids": ["a@example.pf", "b@example.pf"]}
    else:
        assert request.content == b""


# --- PDF family -------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(("name", "resource"), PDF_METHODS, ids=[m[0] for m in PDF_METHODS])
async def test_pdf_returns_the_body_whole(async_client, db_session, name, resource):
    await _configure(async_client)
    _serve(httpx.Response(200, content=b"%PDF-1.7 the whole body"))

    assert await getattr(zoho_service, name)(db_session, RAW_ID) == b"%PDF-1.7 the whole body"


@pytest.mark.asyncio
@pytest.mark.parametrize(("name", "resource"), PDF_METHODS, ids=[m[0] for m in PDF_METHODS])
@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, content=b"<html>login</html>"),
        httpx.Response(200, json={"code": 1, "message": "oops"}),
        httpx.Response(200, content=b""),
    ],
    ids=["html", "json", "empty"],
)
async def test_pdf_rejects_a_200_that_is_not_a_pdf(async_client, db_session, name, resource, response):
    await _configure(async_client)
    _serve(response)

    with pytest.raises(ZohoUpstreamError) as excinfo:
        await getattr(zoho_service, name)(db_session, RAW_ID)
    assert type(excinfo.value) is ZohoUpstreamError
    assert str(excinfo.value) == "Zoho Books did not return a PDF"


# --- error mapping, all nine --------------------------------------------------------

ERROR_CASES = [
    # (id, response, exception type, message) — identical for every method.
    ("404-json", httpx.Response(404, json={"message": "Estimate missing"}), ZohoNotFound, "Estimate missing"),
    ("404-empty", httpx.Response(404, content=b""), ZohoNotFound, "Not found in Zoho Books"),
    ("400-json", httpx.Response(400, json={"message": "Bad id"}), ZohoRequestRejected, "Bad id"),
    ("400-empty", httpx.Response(400, content=b""), ZohoRequestRejected, "Zoho rejected the request"),
    (
        "429",
        httpx.Response(429, json={"code": 44}, headers={"Retry-After": "7"}),
        ZohoRateLimited,
        "Zoho Books error (HTTP 429)",
    ),
    ("500-json", httpx.Response(500, json={"message": "boom"}), ZohoAmbiguous, "Zoho Books error (HTTP 500)"),
    ("503-empty", httpx.Response(503, content=b""), ZohoAmbiguous, "Zoho Books error (HTTP 503)"),
    ("403-json", httpx.Response(403, json={"message": "nope"}), ZohoUpstreamError, "Zoho Books error (HTTP 403)"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(("name", "resource", "kind"), ALL_METHODS, ids=ALL_IDS)
@pytest.mark.parametrize(
    ("response", "exc_type", "message"), [c[1:] for c in ERROR_CASES], ids=[c[0] for c in ERROR_CASES]
)
async def test_error_mapping(async_client, db_session, name, resource, kind, response, exc_type, message):
    await _configure(async_client)
    _serve(response)

    with pytest.raises(ZohoUpstreamError) as excinfo:
        await _call(name, kind, db_session)
    assert type(excinfo.value) is exc_type
    assert str(excinfo.value) == message
    if exc_type is ZohoRateLimited:
        assert excinfo.value.retry_after_raw == "7"
        assert excinfo.value.code == 44


@pytest.mark.asyncio
@pytest.mark.parametrize(("name", "resource", "kind"), ALL_METHODS, ids=ALL_IDS)
async def test_non_json_error_body(async_client, db_session, name, resource, kind):
    """A non-JSON 4xx: the PDF shell falls back to an empty payload and maps
    the status; the JSON shell (_request) refuses to parse it at all."""
    await _configure(async_client)
    _serve(httpx.Response(404, content=b"<html>not json</html>"))

    with pytest.raises(ZohoUpstreamError) as excinfo:
        await _call(name, kind, db_session)
    if kind == "pdf":
        assert type(excinfo.value) is ZohoNotFound
        assert str(excinfo.value) == "Not found in Zoho Books"
    else:
        assert type(excinfo.value) is ZohoAmbiguous
        assert str(excinfo.value) == "Zoho returned a non-JSON response (HTTP 404)"


# --- email content family ---------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(("name", "resource"), CONTENT_METHODS, ids=[m[0] for m in CONTENT_METHODS])
async def test_email_content_shape(async_client, db_session, name, resource):
    await _configure(async_client)
    _serve(httpx.Response(200, json=EMAIL_PAYLOAD))

    content = await getattr(zoho_service, name)(db_session, RAW_ID)

    assert content == {
        "subject": "Sujet",
        "body": "<p>Corps</p>",
        "recipients": [
            {"email": "jp@example.pf", "name": "Jean-Pierre DUPONT", "contact_person_id": "cp-1"},
            {"email": "solo@example.pf", "name": "Solo", "contact_person_id": ""},
        ],
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(("name", "resource"), CONTENT_METHODS, ids=[m[0] for m in CONTENT_METHODS])
@pytest.mark.parametrize(
    "payload",
    [{"code": 0}, {"code": 0, "data": {"to_contacts": None}}],
    ids=["no-data", "null-contacts"],
)
async def test_email_content_defaults(async_client, db_session, name, resource, payload):
    await _configure(async_client)
    _serve(httpx.Response(200, json=payload))

    assert await getattr(zoho_service, name)(db_session, RAW_ID) == {"subject": "", "body": "", "recipients": []}


# --- email send family ---------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(("name", "resource"), SEND_METHODS, ids=[m[0] for m in SEND_METHODS])
async def test_email_send_returns_none(async_client, db_session, name, resource):
    await _configure(async_client)
    _serve(httpx.Response(200, json={"code": 0, "message": "Your email has been sent."}))

    assert await getattr(zoho_service, name)(db_session, RAW_ID, to_mail_ids=["a@example.pf"]) is None
