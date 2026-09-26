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


async def _card_for(async_client, contact_id: str) -> dict:
    """An active Aito card on ``contact_id``.

    T-039: PATCH /zoho/contacts/{id} is scoped to a contact this board is
    working for, so every patch test that expects to reach Books needs one.
    Creates no Zoho traffic of its own (no shipping in the payload), so it is
    safe to call before a counting transport is installed.
    """
    r = await async_client.post(
        "/api/v1/aito/",
        json={
            "description": "Support GoPro",
            "client_id": contact_id,
            "client_name": "Jean DUPONT",
            "client_phone": "+689-87000001",
            "client_email": "jean@example.pf",
            "client_is_company": False,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


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
    # The walk-in refusal comes FIRST: even with an active card on it (every
    # counter sale makes one), the shared bucket is never rewritten.
    await _card_for(async_client, "66407000001237340")
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
    await _card_for(async_client, "z1")

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
    # No card needed: body validation runs before the handler (and so before
    # T-039's scoping query), which is what keeps these 422 and not 404.
    assert (await async_client.patch("/api/v1/zoho/contacts/z1", json={"email": "nope"})).status_code == 422
    assert (await async_client.patch("/api/v1/zoho/contacts/z1", json={"phone": "87123456"})).status_code == 422


@pytest.mark.asyncio
async def test_patch_contact_accepts_empty_string_to_clear(async_client):
    await _configure(async_client)
    await _card_for(async_client, "z1")
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
    await _card_for(async_client, "z1")
    zoho_service.transport = _token_then(lambda request: httpx.Response(500, text="boom"))
    r = await async_client.patch("/api/v1/zoho/contacts/z1", json={"email": "x@y.pf"})
    assert r.status_code == 502


# --------------------------------------------- T-039: scoped to the board


@pytest.mark.asyncio
async def test_patch_contact_refuses_a_contact_with_no_card(async_client):
    """The whole point of T-039: an aito:create principal can no longer
    rewrite the email/phone of a Books contact the board has never worked
    for — and the refusal costs Zoho nothing."""
    await _configure(async_client)
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})

    zoho_service.transport = httpx.MockTransport(handler)
    r = await async_client.patch(
        "/api/v1/zoho/contacts/stranger",
        json={"email": "x@y.pf", "phone": "+689-87123456", "phone_field": "mobile"},
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "No active project for this contact"
    assert calls["n"] == 0  # never reaches Zoho


@pytest.mark.asyncio
async def test_patch_contact_refuses_a_contact_whose_only_card_is_trashed(async_client):
    """A trashed card is not a client the board is working for: the scoping
    query asks for `status == "active"`, the same predicate every other
    project route uses (`_get_active_project_or_404`)."""
    await _configure(async_client)
    project = await _card_for(async_client, "z9")
    assert (await async_client.delete(f"/api/v1/aito/{project['id']}")).status_code == 204
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})

    zoho_service.transport = httpx.MockTransport(handler)
    r = await async_client.patch("/api/v1/zoho/contacts/z9", json={"email": "x@y.pf"})
    assert r.status_code == 404
    assert calls["n"] == 0


@pytest.mark.asyncio
async def test_patch_contact_records_nothing_on_the_timeline(async_client):
    """Pinned deliberately (see patch_contact's comment): the Books write is
    NOT an event. `project.updated` would claim card fields changed — none
    do here — and it coalesces, so a detail-only row would fold into or
    delete an unrelated recent edit."""
    await _configure(async_client)
    project = await _card_for(async_client, "z1")

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
    before = (await async_client.get(f"/api/v1/aito/{project['id']}/events?depth=everything")).json()["events"]
    assert (
        await async_client.patch("/api/v1/zoho/contacts/z1", json={"email": "x@y.pf", "phone_field": "mobile"})
    ).status_code == 204
    after = (await async_client.get(f"/api/v1/aito/{project['id']}/events?depth=everything")).json()["events"]
    assert [e["kind"] for e in after] == [e["kind"] for e in before]
