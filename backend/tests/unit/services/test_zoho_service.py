"""Zoho service: config gating, token refresh + caching + 401 retry, contact mapping."""

import asyncio
import json

import httpx
import pytest

from backend.app.services.zoho import (
    ZohoNotConfiguredError,
    ZohoNotFound,
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
