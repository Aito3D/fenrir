"""Zoho service: config gating, token refresh + caching + 401 retry, contact mapping."""

import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from backend.app.api.routes.settings import set_setting
from backend.app.services import zoho
from backend.app.services.zoho import (
    ZohoAmbiguousReferenceError,
    ZohoNotConfiguredError,
    ZohoNotFound,
    ZohoRateLimited,
    ZohoRequestRejected,
    ZohoUpstreamError,
    zoho_service,
)


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


def _transport(handler):
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_not_configured_raises(db_session):
    with pytest.raises(ZohoNotConfiguredError):
        await zoho_service.get_access_token(db_session)


@pytest.mark.asyncio
async def test_token_fetched_then_cached(async_client, db_session):
    await _configure(async_client)
    calls = {"token": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        assert "/oauth/v2/token" in str(request.url)
        calls["token"] += 1
        return httpx.Response(200, json={"access_token": "at-1", "expires_in": 3600})

    zoho_service.transport = _transport(handler)
    assert await zoho_service.get_access_token(db_session) == "at-1"
    assert await zoho_service.get_access_token(db_session) == "at-1"
    assert calls["token"] == 1  # cached, not re-fetched


@pytest.mark.asyncio
async def test_token_error_maps_to_upstream_error(async_client, db_session):
    await _configure(async_client)
    zoho_service.transport = _transport(lambda request: httpx.Response(200, json={"error": "invalid_code"}))
    with pytest.raises(ZohoUpstreamError):
        await zoho_service.get_access_token(db_session)


@pytest.mark.asyncio
async def test_search_contacts_maps_fields_and_retries_401_once(async_client, db_session):
    await _configure(async_client)
    calls = {"token": 0, "search": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            calls["token"] += 1
            return httpx.Response(200, json={"access_token": f"at-{calls['token']}", "expires_in": 3600})
        calls["search"] += 1
        assert request.url.params["organization_id"] == "999"
        assert request.url.params["search_text"] == "acm"
        if calls["search"] == 1:
            return httpx.Response(401, json={"code": 57, "message": "expired"})
        return httpx.Response(
            200,
            json={
                "contacts": [
                    {
                        "contact_id": "z1",
                        "contact_name": "ACME SARL",
                        "company_name": "ACME",
                        "phone": "",
                        "mobile": "+33 6 12 34 56 78",
                        "email": "hi@acme.fr",
                    }
                ]
            },
        )

    zoho_service.transport = _transport(handler)
    contacts = await zoho_service.search_contacts(db_session, "acm")
    assert calls["token"] == 2  # initial + refresh after 401
    assert contacts == [
        {
            "id": "z1",
            "name": "ACME SARL",
            "company_name": "ACME",
            "customer_sub_type": "",
            "phone": "",
            "mobile": "+33 6 12 34 56 78",
            "email": "hi@acme.fr",
        }
    ]


@pytest.mark.asyncio
async def test_token_non_json_response_maps_to_upstream_error(async_client, db_session):
    await _configure(async_client)
    zoho_service.transport = _transport(lambda request: httpx.Response(200, content=b"<html>not json</html>"))
    with pytest.raises(ZohoUpstreamError):
        await zoho_service.get_access_token(db_session)


@pytest.mark.asyncio
async def test_search_contacts_non_json_response_maps_to_upstream_error(async_client, db_session):
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at-1", "expires_in": 3600})
        return httpx.Response(200, content=b"<html>not json</html>")

    zoho_service.transport = _transport(handler)
    with pytest.raises(ZohoUpstreamError):
        await zoho_service.search_contacts(db_session, "acm")


@pytest.mark.asyncio
async def test_request_injects_org_and_retries_401_once(async_client, db_session):
    await _configure(async_client)
    calls = {"token": 0, "api": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            calls["token"] += 1
            return httpx.Response(200, json={"access_token": f"at-{calls['token']}", "expires_in": 3600})
        calls["api"] += 1
        assert request.url.path == "/books/v3/contacts/z1"
        assert request.url.params["organization_id"] == "999"
        assert request.headers["Authorization"] == f"Zoho-oauthtoken at-{calls['token']}"
        if calls["api"] == 1:
            return httpx.Response(401, json={"code": 57, "message": "expired"})
        return httpx.Response(200, json={"contact": {"contact_id": "z1"}})

    zoho_service.transport = _transport(handler)
    body = await zoho_service._request(db_session, "GET", "/contacts/z1")
    assert body["contact"]["contact_id"] == "z1"
    assert calls["api"] == 2
    assert calls["token"] == 2


@pytest.mark.asyncio
async def test_request_400_raises_rejected_with_zoho_message(async_client, db_session):
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return httpx.Response(400, json={"code": 1002, "message": "Contact name already exists."})

    zoho_service.transport = _transport(handler)
    with pytest.raises(ZohoRequestRejected) as exc:
        await zoho_service._request(db_session, "POST", "/contacts", json={"contact_name": "ACME"})
    assert "already exists" in str(exc.value)


@pytest.mark.asyncio
async def test_request_500_raises_upstream_error(async_client, db_session):
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return httpx.Response(500, text="boom")

    zoho_service.transport = _transport(handler)
    with pytest.raises(ZohoUpstreamError):
        await zoho_service._request(db_session, "GET", "/contacts")


@pytest.mark.asyncio
async def test_request_429_raises_rate_limited_with_seconds_retry_after(async_client, db_session):
    """A 429 raises the dedicated subclass, not the generic ZohoUpstreamError,
    with retry_after parsed from a numeric Retry-After header (seconds)."""
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return httpx.Response(429, json={"message": "Rate limited"}, headers={"Retry-After": "30"})

    zoho_service.transport = _transport(handler)
    with pytest.raises(ZohoRateLimited) as exc:
        await zoho_service._request(db_session, "GET", "/contacts")
    # Still catchable by every existing generic handler.
    assert isinstance(exc.value, ZohoUpstreamError)
    assert exc.value.retry_after == 30.0
    assert str(exc.value) == "Zoho Books error (HTTP 429)"


@pytest.mark.asyncio
async def test_request_429_parses_an_http_date_retry_after(async_client, db_session):
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return httpx.Response(
            429, json={"message": "Rate limited"}, headers={"Retry-After": "Wed, 01 Jan 2100 00:00:00 GMT"}
        )

    zoho_service.transport = _transport(handler)
    with pytest.raises(ZohoRateLimited) as exc:
        await zoho_service._request(db_session, "GET", "/contacts")
    assert exc.value.retry_after is not None
    assert exc.value.retry_after > 0


@pytest.mark.asyncio
async def test_request_429_without_retry_after_header_leaves_it_none(async_client, db_session):
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return httpx.Response(429, json={"message": "Rate limited"})

    zoho_service.transport = _transport(handler)
    with pytest.raises(ZohoRateLimited) as exc:
        await zoho_service._request(db_session, "GET", "/contacts")
    assert exc.value.retry_after is None


@pytest.mark.asyncio
async def test_concurrent_token_fetch_deduplicated(async_client, db_session):
    await _configure(async_client)
    calls = {"token": 0}

    async def handler(request: httpx.Request) -> httpx.Response:
        assert "/oauth/v2/token" in str(request.url)
        calls["token"] += 1
        await asyncio.sleep(0.05)
        return httpx.Response(200, json={"access_token": "at-concurrent", "expires_in": 3600})

    zoho_service.transport = _transport(handler)
    results = await asyncio.gather(
        zoho_service.get_access_token(db_session),
        zoho_service.get_access_token(db_session),
    )
    assert results == ["at-concurrent", "at-concurrent"]
    assert calls["token"] == 1  # deduplicated via lock, not fired twice


def test_normalize_display_name_title_cases_and_uppercases():
    from backend.app.services.zoho import normalize_display_name

    assert normalize_display_name("jean-pierre", "de la tour") == "Jean-Pierre DE LA TOUR"
    assert normalize_display_name("élodie", "teïva-marü") == "Élodie TEÏVA-MARÜ"
    assert normalize_display_name("MARIE anne", "Dupont") == "Marie Anne DUPONT"
    assert normalize_display_name("  paul  ", " theis ") == "Paul THEIS"


@pytest.mark.asyncio
async def test_create_contact_person_path(async_client, db_session):
    await _configure(async_client)
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            201,
            json={
                "contact": {
                    "contact_id": "new1",
                    "contact_name": "Jean-Pierre DUPONT",
                    "company_name": "",
                    "phone": "",
                    "mobile": "+689-87123456",
                    "email": "jp@example.pf",
                }
            },
        )

    zoho_service.transport = _transport(handler)
    result = await zoho_service.create_contact(
        db_session,
        company_name="",
        first_name="jean-pierre",
        last_name="dupont",
        email="jp@example.pf",
        phone="+689-87123456",
    )
    # The mocked response omits customer_sub_type entirely; create_contact
    # overrides it with the sub_type it computed and sent ("individual" here),
    # so the response can't disagree with the request.
    assert result == {
        "id": "new1",
        "name": "Jean-Pierre DUPONT",
        "company_name": "",
        "customer_sub_type": "individual",
        "phone": "",
        "mobile": "+689-87123456",
        "email": "jp@example.pf",
    }
    assert seen["body"]["contact_name"] == "Jean-Pierre DUPONT"
    assert seen["body"]["contact_type"] == "customer"
    assert seen["body"]["customer_sub_type"] == "individual"
    assert "company_name" not in seen["body"]
    assert seen["body"]["contact_persons"] == [
        {
            "first_name": "Jean-Pierre",
            "last_name": "DUPONT",
            "email": "jp@example.pf",
            "mobile": "+689-87123456",
            "is_primary_contact": True,
        }
    ]


@pytest.mark.asyncio
async def test_update_contact_person_puts_to_existing_primary(async_client, db_session):
    await _configure(async_client)
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        if request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "contact": {
                        "contact_id": "z1",
                        "first_name": "Michael",
                        "last_name": "Girard",
                        "contact_persons": [
                            {"contact_person_id": "cp0", "is_primary_contact": False},
                            {"contact_person_id": "cp1", "is_primary_contact": True},
                        ],
                    }
                },
            )
        seen["method"] = request.method
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"contact_person": {}})

    zoho_service.transport = _transport(handler)
    await zoho_service.update_contact_person(
        db_session, "z1", email="new@example.pf", phone="+689-87123456", phone_field="mobile"
    )
    assert seen["method"] == "PUT"
    assert seen["path"] == "/books/v3/contacts/contactpersons/cp1"
    assert seen["body"] == {"email": "new@example.pf", "mobile": "+689-87123456"}


@pytest.mark.asyncio
async def test_update_contact_person_creates_one_when_none_exists(async_client, db_session):
    await _configure(async_client)
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        if request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "contact": {
                        "contact_id": "z9",
                        "first_name": "",
                        "last_name": "",
                        "contact_persons": [],
                    }
                },
            )
        seen["method"] = request.method
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        return httpx.Response(201, json={"contact_person": {}})

    zoho_service.transport = _transport(handler)
    await zoho_service.update_contact_person(db_session, "z9", email=None, phone="+689-40123456", phone_field="phone")
    assert seen["method"] == "POST"
    assert seen["path"] == "/books/v3/contacts/contactpersons"
    assert seen["body"] == {
        "contact_id": "z9",
        "first_name": "",
        "last_name": "",
        "is_primary_contact": True,
        "phone": "+689-40123456",
    }


@pytest.mark.asyncio
async def test_create_contact_company_path_without_person(async_client, db_session):
    await _configure(async_client)
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        seen["body"] = json.loads(request.content)
        return httpx.Response(201, json={"contact": {"contact_id": "c1", "contact_name": "ACME SARL"}})

    zoho_service.transport = _transport(handler)
    result = await zoho_service.create_contact(
        db_session, company_name="ACME SARL", first_name="", last_name="", email="", phone=""
    )
    assert seen["body"]["contact_name"] == "ACME SARL"
    assert seen["body"]["company_name"] == "ACME SARL"
    assert seen["body"]["customer_sub_type"] == "business"
    # The mocked response omits customer_sub_type entirely (Books not echoing
    # it back); the mapped result must still carry the "business" we sent,
    # not the "" _map_contact would otherwise default to.
    assert result["customer_sub_type"] == "business"
    assert "contact_persons" not in seen["body"]  # nothing to put in it


@pytest.mark.asyncio
async def test_search_contacts_carries_customer_sub_type(async_client, db_session):
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return httpx.Response(
            200,
            json={
                "contacts": [
                    {"contact_id": "b1", "contact_name": "ACME SARL", "customer_sub_type": "business"},
                    {"contact_id": "i1", "contact_name": "Paul THEIS", "customer_sub_type": "individual"},
                    {"contact_id": "u1", "contact_name": "Legacy"},
                ]
            },
        )

    zoho_service.transport = _transport(handler)
    results = await zoho_service.search_contacts(db_session, "a")
    assert [c["customer_sub_type"] for c in results] == ["business", "individual", ""]


@pytest.mark.asyncio
async def test_search_contacts_drops_vendors(async_client, db_session):
    """Zoho's /contacts search returns vendors too; the client picker must not
    offer them — an estimate can only be issued to a customer, and a vendor
    sharing a customer's name reads as a duplicate in the dropdown."""
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return httpx.Response(
            200,
            json={
                "contacts": [
                    {"contact_id": "v1", "contact_name": "MATUVU", "contact_type": "vendor"},
                    {"contact_id": "c1", "contact_name": "Matuvu", "contact_type": "customer"},
                ]
            },
        )

    zoho_service.transport = _transport(handler)
    results = await zoho_service.search_contacts(db_session, "matu")
    assert [c["id"] for c in results] == ["c1"]


@pytest.mark.asyncio
async def test_create_contact_response_carries_customer_sub_type(async_client, db_session):
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return httpx.Response(
            201,
            json={
                "contact": {
                    "contact_id": "n1",
                    "contact_name": "ACME SARL",
                    "customer_sub_type": "business",
                }
            },
        )

    zoho_service.transport = _transport(handler)
    result = await zoho_service.create_contact(
        db_session, company_name="ACME SARL", first_name="", last_name="", email="", phone=""
    )
    assert result["customer_sub_type"] == "business"


@pytest.mark.asyncio
async def test_404_raises_zoho_not_found(async_client, db_session):
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(404, json={"message": "Devis introuvable"})

    zoho_service.transport = _transport(handler)
    with pytest.raises(ZohoNotFound):
        await zoho_service.get_estimate(db_session, "gone")


@pytest.mark.asyncio
async def test_update_estimate_lines_sends_only_line_items(async_client, db_session):
    await _configure(async_client)
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        seen["method"] = request.method
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"estimate": {"estimate_id": "e1", "status": "draft"}})

    zoho_service.transport = _transport(handler)
    result = await zoho_service.update_estimate_lines(db_session, "e1", [{"item_id": "x"}])
    assert seen["method"] == "PUT"
    assert seen["body"] == {"line_items": [{"item_id": "x"}]}
    assert result["estimate_id"] == "e1"


@pytest.mark.asyncio
async def test_get_catalogue_falls_back_to_the_verified_defaults(db_session):
    catalogue = await zoho_service.get_catalogue(db_session)
    assert catalogue.scan_item_id == "66407000006501192"
    assert catalogue.tax_id == "66407000009281008"


@pytest.mark.asyncio
async def test_find_estimate_by_reference_filters_by_the_exact_reference_number(async_client, db_session):
    await _configure(async_client)
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        seen["params"] = dict(request.url.params)
        return httpx.Response(
            200,
            json={"estimates": [{"estimate_id": "E1", "reference_number": "AITO-7", "customer_id": "C1"}]},
        )

    zoho_service.transport = _transport(handler)
    result = await zoho_service.find_estimate_by_reference(db_session, "AITO-7", "C1")
    assert seen["params"]["reference_number"] == "AITO-7"
    assert result == {"estimate_id": "E1", "reference_number": "AITO-7", "customer_id": "C1"}


@pytest.mark.asyncio
async def test_find_estimate_by_reference_returns_none_when_nothing_matches(async_client, db_session):
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(200, json={"estimates": []})

    zoho_service.transport = _transport(handler)
    assert await zoho_service.find_estimate_by_reference(db_session, "AITO-999", "C1") is None


@pytest.mark.asyncio
async def test_find_estimate_by_reference_ignores_a_contains_style_false_match(async_client, db_session):
    """Critical 2: Books' `reference_number` query param is not documented as
    an exact match. If Books (or a proxy in front of it) ever returns a
    contains-style match — "AITO-70" for a query of "AITO-7" — the unverified
    original code took `estimates[0]` regardless and would have adopted
    AITO-70's estimate as if it were AITO-7's. The fix filters client-side to
    an EXACT string match first."""
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(
            200,
            json={"estimates": [{"estimate_id": "WRONG", "reference_number": "AITO-70", "customer_id": "C1"}]},
        )

    zoho_service.transport = _transport(handler)
    assert await zoho_service.find_estimate_by_reference(db_session, "AITO-7", "C1") is None


@pytest.mark.asyncio
async def test_find_estimate_by_reference_raises_when_multiple_estimates_share_it(async_client, db_session):
    """Critical 2: Books does not enforce reference_number uniqueness. Taking
    `estimates[0]` when several exist (the unverified original bug) risks
    adopting the WRONG one — the fix refuses to guess."""
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(
            200,
            json={
                "estimates": [
                    {"estimate_id": "E1", "reference_number": "AITO-7", "customer_id": "C1"},
                    {"estimate_id": "E2", "reference_number": "AITO-7", "customer_id": "C1"},
                ]
            },
        )

    zoho_service.transport = _transport(handler)
    with pytest.raises(ZohoAmbiguousReferenceError):
        await zoho_service.find_estimate_by_reference(db_session, "AITO-7", "C1")


@pytest.mark.asyncio
async def test_find_estimate_by_reference_refuses_to_adopt_when_customer_id_is_falsy_on_both_sides(
    async_client, db_session
):
    """Minor: `AitoProject.client_id` is nullable and can be cleared, so a
    falsy ``customer_id`` can reach this lookup. If a Books list summary also
    omits ``customer_id``, comparing with plain ``!=`` treats `None != None`
    as False and would adopt the estimate with NO customer verification at
    all — the exact adoption this whole function exists to prevent. A falsy
    value on either side must refuse to adopt, the same as a real mismatch."""
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(
            200,
            json={"estimates": [{"estimate_id": "E1", "reference_number": "AITO-7"}]},
        )

    zoho_service.transport = _transport(handler)
    with pytest.raises(ZohoAmbiguousReferenceError) as excinfo:
        await zoho_service.find_estimate_by_reference(db_session, "AITO-7", None)
    assert str(excinfo.value) == (
        "An estimate with reference_number 'AITO-7' exists in Zoho, but this project has "
        "no linked Zoho customer to verify it against"
    )


@pytest.mark.asyncio
async def test_find_estimate_by_reference_refuses_to_adopt_when_customer_id_is_falsy_on_their_side(
    async_client, db_session
):
    """Minor: the mirror image of the "our side falsy" case above — our
    project has a real ``customer_id``, but the single exact-reference
    survivor Zoho returned carries no ``customer_id`` of its own. This is
    the branch the "both sides falsy" test (customer_id=None) can never
    reach, because that test short-circuits on the "our side falsy" check
    first. Without both sides present there is nothing to verify, so this
    must refuse to adopt too — with its own distinct wording naming Zoho's
    side as the one missing the data, not the genuine-mismatch text."""
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(
            200,
            json={"estimates": [{"estimate_id": "E1", "reference_number": "AITO-7"}]},
        )

    zoho_service.transport = _transport(handler)
    with pytest.raises(ZohoAmbiguousReferenceError) as excinfo:
        await zoho_service.find_estimate_by_reference(db_session, "AITO-7", "C1")
    assert str(excinfo.value) == (
        "An estimate with reference_number 'AITO-7' exists in Zoho, but Zoho did not "
        "return a customer_id for it, so ownership could not be verified"
    )


@pytest.mark.asyncio
async def test_find_estimate_by_reference_matches_despite_whitespace_and_case_differences(async_client, db_session):
    """Minor: an exact `==` on the reference number is brittle in the
    duplicate-creation direction — if Books echoes the value back trimmed,
    padded or case-changed, a raw string compare drops the real match, the
    lookup returns None, and a SECOND estimate gets POSTed under the same
    reference. Whitespace/case must be normalized away before comparing."""
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(
            200,
            json={"estimates": [{"estimate_id": "E1", "reference_number": " aito-7 ", "customer_id": "C1"}]},
        )

    zoho_service.transport = _transport(handler)
    result = await zoho_service.find_estimate_by_reference(db_session, "AITO-7", "C1")
    assert result is not None
    assert result["estimate_id"] == "E1"


@pytest.mark.asyncio
async def test_find_estimate_by_reference_still_rejects_aito_7_vs_aito_70_after_normalizing(async_client, db_session):
    """Normalizing whitespace/case for the fix above must not weaken the
    original contains-style protection: 'AITO-7' and 'AITO-70' differ by more
    than case or whitespace and must still compare unequal."""
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(
            200,
            json={"estimates": [{"estimate_id": "WRONG", "reference_number": " AITO-70 ", "customer_id": "C1"}]},
        )

    zoho_service.transport = _transport(handler)
    assert await zoho_service.find_estimate_by_reference(db_session, "AITO-7", "C1") is None


@pytest.mark.asyncio
async def test_find_estimate_by_reference_raises_on_a_customer_mismatch(async_client, db_session):
    """Critical 2: the one bug this exists to prevent — an unverified
    reference-number match adopting an ARBITRARY live customer's estimate,
    which the next sync tick then overwrites with this project's line items.
    A single exact-reference match belonging to a different customer must be
    refused, never silently adopted."""
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(
            200,
            json={"estimates": [{"estimate_id": "E1", "reference_number": "AITO-7", "customer_id": "SOMEONE_ELSE"}]},
        )

    zoho_service.transport = _transport(handler)
    with pytest.raises(ZohoAmbiguousReferenceError) as excinfo:
        await zoho_service.find_estimate_by_reference(db_session, "AITO-7", "C1")
    assert str(excinfo.value) == (
        "An estimate with reference_number 'AITO-7' exists in Zoho but belongs to a different customer"
    )


@pytest.mark.asyncio
async def test_get_estimate_pdf_returns_bytes(async_client, db_session):
    """A PDF response must not be run through response.json().

    _request hardcodes JSON parsing, which is right for every other call here
    and fatal for this one. get_estimate_pdf shares _request's token handling,
    org scoping and 401-retry via _send, and parses nothing on success.
    """
    await _configure(async_client)
    pdf = b"%PDF-1.4 fake"

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at-1", "expires_in": 3600})
        assert request.url.params["organization_id"] == "999"
        assert request.url.path.endswith("/estimates/EST-1")
        return httpx.Response(200, content=pdf, headers={"Content-Type": "application/pdf"})

    zoho_service.transport = _transport(handler)
    assert await zoho_service.get_estimate_pdf(db_session, "EST-1") == pdf


@pytest.mark.asyncio
async def test_get_estimate_pdf_maps_not_found(async_client, db_session):
    """Zoho's ERROR responses are still JSON, so the error mapping is shared."""
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at-1", "expires_in": 3600})
        return httpx.Response(404, json={"message": "Estimate does not exist"})

    zoho_service.transport = _transport(handler)
    with pytest.raises(ZohoNotFound):
        await zoho_service.get_estimate_pdf(db_session, "EST-1")


@pytest.mark.asyncio
async def test_get_estimate_pdf_rejects_a_200_that_is_not_a_pdf(async_client, db_session):
    """A 200 carrying HTML or JSON would otherwise reach the browser labelled
    application/pdf and open a blank print dialog with no clue why."""
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at-1", "expires_in": 3600})
        return httpx.Response(200, content=b"<html>sign in</html>")

    zoho_service.transport = _transport(handler)
    with pytest.raises(ZohoUpstreamError):
        await zoho_service.get_estimate_pdf(db_session, "EST-1")


@pytest.mark.asyncio
async def test_get_invoice_pdf_returns_bytes(async_client, db_session):
    """Same shape and same reasoning as ``get_estimate_pdf`` above: a PDF
    response must not be run through response.json()."""
    await _configure(async_client)
    pdf = b"%PDF-1.4 fake"

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at-1", "expires_in": 3600})
        assert request.url.params["organization_id"] == "999"
        assert request.url.path.endswith("/invoices/INV-1")
        return httpx.Response(200, content=pdf, headers={"Content-Type": "application/pdf"})

    zoho_service.transport = _transport(handler)
    assert await zoho_service.get_invoice_pdf(db_session, "INV-1") == pdf


@pytest.mark.asyncio
async def test_get_invoice_pdf_maps_not_found(async_client, db_session):
    """Zoho's ERROR responses are still JSON, so the error mapping is shared."""
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at-1", "expires_in": 3600})
        return httpx.Response(404, json={"message": "Invoice does not exist"})

    zoho_service.transport = _transport(handler)
    with pytest.raises(ZohoNotFound):
        await zoho_service.get_invoice_pdf(db_session, "INV-1")


@pytest.mark.asyncio
async def test_get_invoice_pdf_rejects_a_200_that_is_not_a_pdf(async_client, db_session):
    """A 200 carrying HTML or JSON would otherwise reach the browser labelled
    application/pdf and open a blank print dialog with no clue why."""
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at-1", "expires_in": 3600})
        return httpx.Response(200, content=b"<html>sign in</html>")

    zoho_service.transport = _transport(handler)
    with pytest.raises(ZohoUpstreamError):
        await zoho_service.get_invoice_pdf(db_session, "INV-1")


@pytest.mark.asyncio
async def test_list_items_page_sends_the_category_filter_and_extracts_has_more_page(db_session, monkeypatch):
    """The filament catalogue relies on this seam to page through
    ``cf_nature_du_produit=Filaments`` server-side rather than Zoho's
    ``search_text``, which also matches item descriptions."""
    captured = {}

    async def fake_request(db, method, path, **kwargs):
        captured["method"] = method
        captured["path"] = path
        captured["params"] = kwargs.get("params")
        return {
            "items": [{"item_id": "1", "name": "Bambu Lab - PLA - Rouge - 1.75mm - 1kg"}],
            "page_context": {"has_more_page": True},
        }

    monkeypatch.setattr(zoho_service, "_request", fake_request)
    items, has_more = await zoho_service.list_items_page(db_session, category="Filaments", page=2, per_page=200)

    assert captured["method"] == "GET"
    assert captured["path"] == "/items"
    assert captured["params"] == {"cf_nature_du_produit": "Filaments", "page": 2, "per_page": 200}
    assert "search_text" not in captured["params"]
    assert items == [{"item_id": "1", "name": "Bambu Lab - PLA - Rouge - 1.75mm - 1kg"}]
    assert has_more is True


@pytest.mark.asyncio
async def test_list_items_page_has_more_page_defaults_false_when_page_context_is_absent(db_session, monkeypatch):
    async def fake_request(db, method, path, **kwargs):
        return {"items": []}

    monkeypatch.setattr(zoho_service, "_request", fake_request)
    items, has_more = await zoho_service.list_items_page(db_session, category="Filaments", page=1, per_page=200)

    assert items == []
    assert has_more is False


@pytest.mark.asyncio
async def test_get_shipping_catalogue_fetches_once_then_serves_the_cache(db_session, monkeypatch):
    calls = []

    async def fake_request(db, method, path, **kwargs):
        calls.append(path)
        return {"items": [{"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": 3200}]}

    monkeypatch.setattr(zoho_service, "_request", fake_request)
    first = await zoho_service.get_shipping_catalogue(db_session)
    second = await zoho_service.get_shipping_catalogue(db_session)
    assert first["tuamotu"].item_id == "1"
    assert first["tuamotu"].rate == 3200.0
    assert second["tuamotu"].item_id == "1"
    assert len(calls) == 1, "the 24h cache must not re-fetch"


@pytest.mark.asyncio
async def test_get_shipping_catalogue_survives_zoho_being_down(db_session, monkeypatch):
    """T-011: renamed-in-spirit — this used to also assert that a second
    failed attempt immediately retries the fetch (`boom_calls["n"] == 2`).
    That was the always-retry gap T-011 closed: a failed refresh now stamps
    a process-local cooldown so an immediate second caller is short-circuited
    instead of repeating the `/items` request. That half of the old
    assertion moved to
    `test_get_shipping_catalogue_cooldown_skips_the_retry_immediately_after_a_failure`
    below, which pins the NEW behavior explicitly. This test still covers
    what it always did: a failed refresh must not lose the cached ids."""

    async def ok(db, method, path, **kwargs):
        return {"items": [{"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": 3200}]}

    monkeypatch.setattr(zoho_service, "_request", ok)
    await zoho_service.get_shipping_catalogue(db_session)
    await set_setting(db_session, "zoho_shipping_catalogue_at", "2000-01-01T00:00:00")

    boom_calls = {"n": 0}

    async def boom(db, method, path, **kwargs):
        boom_calls["n"] += 1
        raise ZohoUpstreamError("down")

    monkeypatch.setattr(zoho_service, "_request", boom)
    stale = await zoho_service.get_shipping_catalogue(db_session)
    assert stale["tuamotu"].item_id == "1", "a failed refresh must not lose the ids"

    # A failed refresh must not stamp zoho_shipping_catalogue_at, or every
    # existing test would stay green even if that write were accidentally
    # moved out of the success-only `else:` arm — which would silently
    # suppress retries for 24h forever, indistinguishable from the T-011
    # cooldown (which is process-local and expires on its own).
    assert boom_calls["n"] == 1


@pytest.mark.asyncio
async def test_get_shipping_catalogue_cooldown_skips_the_retry_immediately_after_a_failure(db_session, monkeypatch):
    """T-011: a failed refresh followed by an immediate second call must
    issue NO second `/items` request and must report the same "unavailable"
    answer the first failure did — here, the stale cache served unchanged —
    rather than repeating a fetch that just failed and is very likely to
    fail again the same way, mirroring `zoho_filaments._FAIL_COOLDOWN`."""

    async def ok(db, method, path, **kwargs):
        return {"items": [{"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": 3200}]}

    monkeypatch.setattr(zoho_service, "_request", ok)
    await zoho_service.get_shipping_catalogue(db_session)  # warms the cache
    await set_setting(db_session, "zoho_shipping_catalogue_at", "2000-01-01T00:00:00")  # ...then stales it

    boom_calls = {"n": 0}

    async def boom(db, method, path, **kwargs):
        boom_calls["n"] += 1
        raise ZohoUpstreamError("down")

    monkeypatch.setattr(zoho_service, "_request", boom)
    first = await zoho_service.get_shipping_catalogue(db_session)
    assert first["tuamotu"].item_id == "1"
    assert boom_calls["n"] == 1

    second = await zoho_service.get_shipping_catalogue(db_session)
    assert second["tuamotu"].item_id == "1", "still served from the stale cache, unchanged"
    assert boom_calls["n"] == 1, "the cooldown must skip the retry, not repeat the failed fetch"


@pytest.mark.asyncio
async def test_get_shipping_catalogue_cooldown_skips_the_retry_on_a_cold_cache_too(db_session, monkeypatch):
    """T-011's cold-cache twin of the warm-cache test above: with no cache to
    fall back to, the "unavailable" answer is an empty dict, and the cooldown
    must still prevent a second `/items` request within the window."""
    boom_calls = {"n": 0}

    async def boom(db, method, path, **kwargs):
        boom_calls["n"] += 1
        raise ZohoUpstreamError("down")

    monkeypatch.setattr(zoho_service, "_request", boom)
    assert await zoho_service.get_shipping_catalogue(db_session) == {}
    assert boom_calls["n"] == 1

    assert await zoho_service.get_shipping_catalogue(db_session) == {}
    assert boom_calls["n"] == 1, "the cooldown must skip the retry even with nothing cached to fall back to"


class _ScriptedClock:
    """Stands in for zoho.py's `datetime` name, handing back a scripted
    sequence of `now()` values instead of the real wall clock — the same
    approach `test_zoho_filaments_catalogue.py` uses for
    `zoho_filaments._FAIL_COOLDOWN` — so the T-011 cooldown's expiry can be
    exercised without an actual sleep. Once the script is down to its last
    value, every further call repeats it. Everything else (notably
    `fromisoformat`, used by the cache-freshness check) forwards to the real
    `datetime` class unchanged, since zoho.py's `get_shipping_catalogue`
    calls more than just `.now()` on the name it binds to `datetime`."""

    def __init__(self, values):
        self._values = list(values)

    def now(self, tz=None):
        return self._values.pop(0) if len(self._values) > 1 else self._values[0]

    def __getattr__(self, name):
        return getattr(datetime, name)


@pytest.mark.asyncio
async def test_get_shipping_catalogue_retries_after_the_failure_cooldown_elapses(db_session, monkeypatch):
    """T-011: after `_SHIPPING_FAIL_COOLDOWN` elapses, the next call must
    attempt a real refresh again (recovery) instead of continuing to
    short-circuit forever."""
    monkeypatch.setattr(zoho, "_SHIPPING_FAIL_COOLDOWN", timedelta(seconds=5))

    async def ok(db, method, path, **kwargs):
        return {"items": [{"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": 3200}]}

    monkeypatch.setattr(zoho_service, "_request", ok)
    await zoho_service.get_shipping_catalogue(db_session)  # warms the cache
    await set_setting(db_session, "zoho_shipping_catalogue_at", "2000-01-01T00:00:00")  # ...then stales it

    boom_calls = {"n": 0}

    async def boom(db, method, path, **kwargs):
        boom_calls["n"] += 1
        raise ZohoUpstreamError("down")

    monkeypatch.setattr(zoho_service, "_request", boom)

    t_start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    t_fail = t_start + timedelta(seconds=1)
    t_within_cooldown = t_fail + timedelta(seconds=1)  # well within the 5s cooldown
    t_after_cooldown = t_fail + timedelta(seconds=10)  # past the 5s cooldown
    # get_shipping_catalogue reads the clock once for the freshness check
    # (the stale `zoho_shipping_catalogue_at` set above always makes that
    # read happen) and once more per attempt that actually reaches the
    # cooldown gate: [call 1] the failing attempt's freshness check, [call 2]
    # the failing attempt's cooldown-gate read (stamps `_shipping_fail_at` =
    # t_fail), [call 3] the within-cooldown attempt's freshness check, [call
    # 4] its cooldown-gate read (still within the window — short-circuits),
    # [call 5] the past-cooldown attempt's freshness check, [call 6] its
    # cooldown-gate read (past the window — lets the recovery through), then
    # repeats its last value for the recovery's own success-stamp write.
    monkeypatch.setattr(
        zoho,
        "datetime",
        _ScriptedClock([t_start, t_fail, t_fail, t_within_cooldown, t_after_cooldown, t_after_cooldown]),
    )

    first = await zoho_service.get_shipping_catalogue(db_session)
    assert first["tuamotu"].item_id == "1"
    assert boom_calls["n"] == 1

    # Within the cooldown: short-circuits, no new call to Books.
    second = await zoho_service.get_shipping_catalogue(db_session)
    assert second["tuamotu"].item_id == "1"
    assert boom_calls["n"] == 1

    # Cooldown has elapsed: a real refresh is attempted again. Zoho has
    # recovered by now, so this one succeeds.
    monkeypatch.setattr(zoho_service, "_request", ok)
    recovered = await zoho_service.get_shipping_catalogue(db_session)
    assert recovered["tuamotu"].item_id == "1"
    assert boom_calls["n"] == 1, "the recovery attempt goes through _request (ok), not the old boom"


@pytest.mark.asyncio
async def test_get_shipping_catalogue_success_clears_the_cooldown(db_session, monkeypatch):
    """T-011: a successful fetch must clear the failure cooldown, exactly as
    `zoho_filaments.fetch_catalogue` clears its own `_fail_at` on success —
    otherwise a genuine recovery could still be masked by a memo from before
    it happened.

    Both calls run under the scripted clock (rather than warming up under
    the real one first) so the second call's "has the cooldown elapsed?"
    comparison is against a known, controlled `_shipping_fail_at` instead of
    racing the real wall clock the first call would otherwise stamp it
    with."""
    monkeypatch.setattr(zoho, "_SHIPPING_FAIL_COOLDOWN", timedelta(seconds=5))

    async def boom(db, method, path, **kwargs):
        raise ZohoUpstreamError("down")

    monkeypatch.setattr(zoho_service, "_request", boom)

    t_fail = datetime(2026, 1, 1, tzinfo=timezone.utc)
    t_after_cooldown = t_fail + timedelta(seconds=10)  # past the 5s cooldown
    # Cold cache throughout (no `zoho_shipping_catalogue_at` is ever written
    # by a failed refresh), so neither call reaches the freshness check —
    # each reads the clock exactly once: [call 1] the failing attempt's
    # cooldown-gate read (stamps `_shipping_fail_at` = t_fail), [call 2] the
    # past-cooldown attempt's cooldown-gate read (lets the recovery through),
    # then repeats its last value for the recovery's own success-stamp write.
    monkeypatch.setattr(zoho, "datetime", _ScriptedClock([t_fail, t_after_cooldown, t_after_cooldown]))

    assert await zoho_service.get_shipping_catalogue(db_session) == {}
    assert zoho._shipping_fail_at is not None

    async def ok(db, method, path, **kwargs):
        return {"items": [{"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": 3200}]}

    monkeypatch.setattr(zoho_service, "_request", ok)
    recovered = await zoho_service.get_shipping_catalogue(db_session)
    assert recovered["tuamotu"].item_id == "1"
    assert zoho._shipping_fail_at is None, "a successful refresh must clear the cooldown memo"


@pytest.mark.asyncio
async def test_get_shipping_catalogue_is_empty_when_never_resolved(db_session, monkeypatch):
    async def boom(db, method, path, **kwargs):
        raise ZohoUpstreamError("down")

    monkeypatch.setattr(zoho_service, "_request", boom)
    assert await zoho_service.get_shipping_catalogue(db_session) == {}


@pytest.mark.asyncio
async def test_get_shipping_catalogue_refresh_false_never_touches_the_network(db_session, monkeypatch):
    """refresh=False is for callers that only need OWNERSHIP of ids already
    learned — never a fresh rate — so it must answer from cache alone, even
    when the cache is missing or stale enough that refresh=True would
    trigger a fetch."""
    calls = []

    async def fake_request(db, method, path, **kwargs):
        calls.append(path)
        return {"items": [{"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": 3200}]}

    monkeypatch.setattr(zoho_service, "_request", fake_request)
    # No cache exists at all yet.
    result = await zoho_service.get_shipping_catalogue(db_session, refresh=False)
    assert result == {}
    assert calls == [], "refresh=False must never call Books, cold cache or not"


@pytest.mark.asyncio
async def test_get_shipping_catalogue_refresh_false_still_serves_a_warm_cache(db_session, monkeypatch):
    """Warms the cache, then makes it STALE, so `fresh` is False and the
    `not fresh` arm is actually exercised. The earlier version of this test
    warmed the cache and left it fresh, which passes verbatim whether or not
    `refresh` is honoured — it never exercises the branch it claims to cover.
    Staling it first the way `test_get_shipping_catalogue_survives_zoho_being_down`
    does means this fails if refresh=False is ever ignored."""

    async def fake_request(db, method, path, **kwargs):
        return {"items": [{"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": 3200}]}

    monkeypatch.setattr(zoho_service, "_request", fake_request)
    await zoho_service.get_shipping_catalogue(db_session)  # warms the cache
    await set_setting(db_session, "zoho_shipping_catalogue_at", "2000-01-01T00:00:00")  # ...then stales it

    calls = []

    async def boom(db, method, path, **kwargs):
        calls.append(path)
        raise AssertionError("refresh=False must not call Books even with a stale-but-warm cache")

    monkeypatch.setattr(zoho_service, "_request", boom)
    cached = await zoho_service.get_shipping_catalogue(db_session, refresh=False)
    assert cached["tuamotu"].item_id == "1"
    assert calls == []


@pytest.mark.asyncio
async def test_get_catalogue_never_calls_items(db_session, monkeypatch):
    """Pins the regression this fixed: get_catalogue sits on the sync
    worker's hot path, including _create_quote's fast path, which must make
    ZERO Zoho calls when a project has no priced service. Ownership only
    needs ids already learned, so get_catalogue must never fetch."""
    calls = []

    async def fake_request(db, method, path, **kwargs):
        calls.append(path)
        return {"items": [{"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": 3200}]}

    monkeypatch.setattr(zoho_service, "_request", fake_request)
    await zoho_service.get_catalogue(db_session)
    assert "/items" not in calls
    assert calls == []


@pytest.mark.asyncio
async def test_an_estimate_id_cannot_walk_out_of_the_books_prefix(db_session, monkeypatch):
    """quote_id arrives as free text on the create payload and lands in the
    Books URL path. httpx normalises dot segments when it builds the request,
    so an unescaped `../../../crm/v2/Leads` would leave /books/v3 entirely and
    hit an arbitrary Zoho endpoint carrying the org's OAuth token."""
    seen = []

    async def capture(db, method, path, **kwargs):
        seen.append(path)
        return {"estimate": {}}

    monkeypatch.setattr(zoho_service, "_request", capture)
    await zoho_service.get_estimate(db_session, "../../../crm/v2/Leads")

    assert seen == ["/estimates/..%2F..%2F..%2Fcrm%2Fv2%2FLeads"]
    # The property that actually matters, checked the way httpx sees it:
    url = httpx.Request("GET", f"https://books.example{seen[0]}").url
    assert str(url).startswith("https://books.example/estimates/")
