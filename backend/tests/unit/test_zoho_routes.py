"""Zoho proxy routes: status flags and contact search error mapping."""

import json

import httpx
import pytest

from backend.app.services.zoho import zoho_service


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


@pytest.mark.asyncio
async def test_status_unconfigured_still_returns_default_contact(async_client):
    r = await async_client.get("/api/v1/zoho/status")
    assert r.status_code == 200
    assert r.json() == {
        "configured": False,
        "reachable": None,
        "default_contact_id": "66407000001237340",
        "default_contact_name": "Client de passage",
    }


@pytest.mark.asyncio
async def test_status_uses_configured_default_contact(async_client):
    await async_client.put(
        "/api/v1/settings/",
        json={"zoho_default_contact_id": "abc123", "zoho_default_contact_name": "Walk-in"},
    )
    body = (await async_client.get("/api/v1/zoho/status")).json()
    assert body["default_contact_id"] == "abc123"
    assert body["default_contact_name"] == "Walk-in"


@pytest.mark.asyncio
async def test_status_without_probe_makes_no_upstream_request(async_client):
    """The Aito modal blocks its client block on this call, so it must never
    wait on a Zoho round trip it does not read."""
    await _configure(async_client)
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})

    zoho_service.transport = httpx.MockTransport(handler)
    body = (await async_client.get("/api/v1/zoho/status")).json()
    assert calls["n"] == 0
    assert body["configured"] is True
    assert body["reachable"] is None


@pytest.mark.asyncio
async def test_status_with_probe_reports_reachable(async_client):
    await _configure(async_client)
    zoho_service.transport = httpx.MockTransport(
        lambda request: httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
    )
    assert (await async_client.get("/api/v1/zoho/status?probe=true")).json() == {
        "configured": True,
        "reachable": True,
        "default_contact_id": "66407000001237340",
        "default_contact_name": "Client de passage",
    }


@pytest.mark.asyncio
async def test_status_with_probe_reports_unreachable_on_upstream_error(async_client):
    await _configure(async_client)
    zoho_service.transport = httpx.MockTransport(lambda request: httpx.Response(500, text="boom"))
    body = (await async_client.get("/api/v1/zoho/status?probe=true")).json()
    assert body["configured"] is True
    assert body["reachable"] is False


@pytest.mark.asyncio
async def test_contacts_409_when_unconfigured(async_client):
    assert (await async_client.get("/api/v1/zoho/contacts?q=ac")).status_code == 409


@pytest.mark.asyncio
async def test_contacts_min_query_length(async_client):
    await _configure(async_client)
    assert (await async_client.get("/api/v1/zoho/contacts?q=a")).status_code == 422


@pytest.mark.asyncio
async def test_contacts_search_and_upstream_error(async_client):
    await _configure(async_client)

    def ok_handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return httpx.Response(
            200,
            json={
                "contacts": [
                    {
                        "contact_id": "z1",
                        "contact_name": "ACME",
                        "company_name": "",
                        "phone": "01",
                        "mobile": "",
                        "email": "",
                    }
                ]
            },
        )

    zoho_service.transport = httpx.MockTransport(ok_handler)
    r = await async_client.get("/api/v1/zoho/contacts?q=acm")
    assert r.status_code == 200
    assert r.json()[0] == {
        "id": "z1",
        "name": "ACME",
        "company_name": "",
        "customer_sub_type": "",
        "phone": "01",
        "mobile": "",
        "email": "",
    }

    zoho_service.invalidate_token()
    zoho_service.transport = httpx.MockTransport(lambda request: httpx.Response(500))
    assert (await async_client.get("/api/v1/zoho/contacts?q=acm")).status_code == 502


def _token_then(handler):
    def wrapped(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return handler(request)

    return httpx.MockTransport(wrapped)


@pytest.mark.asyncio
async def test_create_contact_returns_mapped_contact(async_client):
    await _configure(async_client)
    zoho_service.transport = _token_then(
        lambda request: httpx.Response(
            201,
            json={
                "contact": {
                    "contact_id": "n1",
                    "contact_name": "ACME SARL",
                    "company_name": "ACME SARL",
                    "phone": "",
                    "mobile": "",
                    "email": "",
                }
            },
        )
    )
    r = await async_client.post("/api/v1/zoho/contacts", json={"company_name": "ACME SARL"})
    assert r.status_code == 201
    assert r.json()["id"] == "n1"
    assert r.json()["name"] == "ACME SARL"


@pytest.mark.asyncio
async def test_create_contact_requires_a_name(async_client):
    await _configure(async_client)
    r = await async_client.post("/api/v1/zoho/contacts", json={"first_name": "Paul"})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_create_contact_rejects_malformed_email(async_client):
    await _configure(async_client)
    r = await async_client.post("/api/v1/zoho/contacts", json={"company_name": "ACME SARL", "email": "nope"})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_create_contact_rejects_malformed_phone(async_client):
    await _configure(async_client)
    r = await async_client.post("/api/v1/zoho/contacts", json={"company_name": "ACME SARL", "phone": "87123456"})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_create_contact_accepts_house_format_phone(async_client):
    await _configure(async_client)
    zoho_service.transport = _token_then(
        lambda request: httpx.Response(201, json={"contact": {"contact_id": "n2", "contact_name": "ACME SARL"}})
    )
    r = await async_client.post("/api/v1/zoho/contacts", json={"company_name": "ACME SARL", "phone": "+689-87123456"})
    assert r.status_code == 201


@pytest.mark.asyncio
async def test_create_contact_duplicate_maps_to_409_with_message(async_client):
    await _configure(async_client)
    zoho_service.transport = _token_then(
        lambda request: httpx.Response(400, json={"code": 1002, "message": "Contact name already exists."})
    )
    r = await async_client.post("/api/v1/zoho/contacts", json={"company_name": "ACME SARL"})
    assert r.status_code == 409
    assert "already exists" in r.json()["detail"]


@pytest.mark.asyncio
async def test_create_contact_upstream_error_maps_to_502(async_client):
    await _configure(async_client)
    zoho_service.transport = _token_then(lambda request: httpx.Response(500, text="boom"))
    assert (await async_client.post("/api/v1/zoho/contacts", json={"company_name": "X"})).status_code == 502


@pytest.mark.asyncio
async def test_contact_create_normalizes_names(async_client, monkeypatch):
    captured = {}

    async def fake_create_contact(db, *, company_name, first_name, last_name, email, phone):
        captured.update(first_name=first_name, last_name=last_name)
        return {
            "id": "c1",
            "name": f"{first_name} {last_name}",
            "company_name": company_name,
            "customer_sub_type": "individual",
            "phone": phone,
            "mobile": phone,
            "email": email,
        }

    monkeypatch.setattr(zoho_service, "create_contact", fake_create_contact)
    r = await async_client.post(
        "/api/v1/zoho/contacts",
        json={"first_name": "jean-pierre", "last_name": "dupont", "phone": "+689-87123456"},
    )
    assert r.status_code == 201
    assert captured["first_name"] == "Jean-Pierre"
    assert captured["last_name"] == "DUPONT"


@pytest.mark.asyncio
async def test_patch_contact_refuses_the_default_contact(async_client):
    await _configure(async_client)
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})

    zoho_service.transport = httpx.MockTransport(handler)
    r = await async_client.patch(
        "/api/v1/zoho/contacts/66407000001237340",
        json={"phone": "+689-87123456", "phone_field": "mobile"},
    )
    assert r.status_code == 400
    assert calls["n"] == 0  # never reaches Zoho


@pytest.mark.asyncio
async def test_patch_contact_updates_primary_person(async_client):
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "contact": {
                        "contact_id": "z1",
                        "first_name": "M",
                        "last_name": "G",
                        "contact_persons": [{"contact_person_id": "cp1", "is_primary_contact": True}],
                    }
                },
            )
        return httpx.Response(200, json={"contact_person": {}})

    zoho_service.transport = _token_then(handler)
    r = await async_client.patch("/api/v1/zoho/contacts/z1", json={"email": "x@y.pf", "phone_field": "mobile"})
    assert r.status_code == 204


@pytest.mark.asyncio
async def test_patch_contact_rejects_malformed_values(async_client):
    await _configure(async_client)
    assert (await async_client.patch("/api/v1/zoho/contacts/z1", json={"email": "nope"})).status_code == 422
    assert (await async_client.patch("/api/v1/zoho/contacts/z1", json={"phone": "87123456"})).status_code == 422


@pytest.mark.asyncio
async def test_patch_contact_accepts_empty_string_to_clear(async_client):
    await _configure(async_client)
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "contact": {
                        "contact_id": "z1",
                        "first_name": "M",
                        "last_name": "G",
                        "contact_persons": [{"contact_person_id": "cp1", "is_primary_contact": True}],
                    }
                },
            )
        seen["method"] = request.method
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"contact_person": {}})

    zoho_service.transport = _token_then(handler)
    r = await async_client.patch("/api/v1/zoho/contacts/z1", json={"phone": "", "phone_field": "mobile"})
    assert r.status_code == 204
    assert seen["method"] == "PUT"
    assert seen["path"] == "/books/v3/contacts/contactpersons/cp1"
    assert seen["body"] == {"mobile": ""}


@pytest.mark.asyncio
async def test_patch_contact_upstream_error_maps_to_502(async_client):
    await _configure(async_client)
    zoho_service.transport = _token_then(lambda request: httpx.Response(500, text="boom"))
    r = await async_client.patch("/api/v1/zoho/contacts/z1", json={"email": "x@y.pf"})
    assert r.status_code == 502
