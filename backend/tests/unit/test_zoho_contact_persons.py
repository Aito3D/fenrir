"""Books contact persons: listing, creating, and targeting one for a write."""

import json

import httpx
import pytest

from backend.app.services.zoho import ZohoNotFound, _map_contact_person, zoho_service


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


def _books(handler):
    def wrapped(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return handler(request)

    return httpx.MockTransport(wrapped)


SNP = {
    "contact_id": "zSNP",
    "contact_name": "Societe de Navigation Polynesienne",
    "customer_sub_type": "business",
    "contact_persons": [
        {
            "contact_person_id": "cp1",
            "first_name": "vaekehu",
            "last_name": "varney",
            "email": "vaekehu@snp.pf",
            "mobile": "+689-40549958",
            "phone": "",
            "is_primary_contact": True,
        },
        {"contact_person_id": "cp2", "first_name": "Moana", "last_name": "TERIIPAIA", "phone": "+689-87221043"},
    ],
}


def _recording(seen: list, contact: dict = SNP):
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        seen.append((request.method, request.url.path, body))
        if request.method == "GET":
            return httpx.Response(200, json={"contact": contact})
        if request.method == "POST" and request.url.path.endswith("/contacts/contactpersons"):
            return httpx.Response(
                201,
                json={
                    "contact_person": {
                        "contact_person_id": "cp9",
                        **body,
                        "is_primary_contact": body["is_primary_contact"],
                    }
                },
            )
        return httpx.Response(200, json={"contact_person": {}})

    return _books(handler)


# ------------------------------------------------------------------ mapper


def test_map_contact_person_normalises_name_and_fills_blanks():
    mapped = _map_contact_person(SNP["contact_persons"][0])
    assert mapped == {
        "contact_person_id": "cp1",
        "first_name": "vaekehu",
        "last_name": "varney",
        "name": "Vaekehu VARNEY",
        "email": "vaekehu@snp.pf",
        "phone": "",
        "mobile": "+689-40549958",
        "is_primary": True,
    }
    second = _map_contact_person(SNP["contact_persons"][1])
    assert second["email"] == ""
    assert second["mobile"] == ""
    assert second["is_primary"] is False


# -------------------------------------------------------------------- list


@pytest.mark.asyncio
async def test_list_contact_persons_reads_the_contact_once(async_client, db_session):
    await _configure(async_client)
    seen: list = []
    zoho_service.transport = _recording(seen)

    persons = await zoho_service.list_contact_persons(db_session, "zSNP")

    assert [p["contact_person_id"] for p in persons] == ["cp1", "cp2"]
    assert seen == [("GET", "/books/v3/contacts/zSNP", None)]


@pytest.mark.asyncio
async def test_list_contact_persons_empty_when_books_has_none(async_client, db_session):
    await _configure(async_client)
    zoho_service.transport = _recording([], contact={"contact_id": "z0"})
    assert await zoho_service.list_contact_persons(db_session, "z0") == []


# ------------------------------------------------------------------ create


@pytest.mark.asyncio
async def test_create_contact_person_posts_mobile_and_is_not_primary_when_others_exist(async_client, db_session):
    await _configure(async_client)
    seen: list = []
    zoho_service.transport = _recording(seen)

    person = await zoho_service.create_contact_person(
        db_session, "zSNP", first_name="Hina", last_name="LO", email="", phone="+689-87000000"
    )

    post = next(b for m, p, b in seen if m == "POST")
    assert post == {
        "contact_id": "zSNP",
        "first_name": "Hina",
        "last_name": "LO",
        "mobile": "+689-87000000",
        "is_primary_contact": False,
    }
    assert person["contact_person_id"] == "cp9"
    assert person["name"] == "Hina LO"
    assert person["mobile"] == "+689-87000000"


@pytest.mark.asyncio
async def test_create_contact_person_is_primary_when_the_account_has_none(async_client, db_session):
    await _configure(async_client)
    seen: list = []
    zoho_service.transport = _recording(seen, contact={"contact_id": "z0", "contact_persons": []})

    await zoho_service.create_contact_person(
        db_session, "z0", first_name="Hina", last_name="", email="h@x.pf", phone=""
    )

    post = next(b for m, p, b in seen if m == "POST")
    assert post == {
        "contact_id": "z0",
        "first_name": "Hina",
        "last_name": "",
        "email": "h@x.pf",
        "is_primary_contact": True,
    }


# ------------------------------------------------------------------ target


@pytest.mark.asyncio
async def test_update_contact_person_targets_the_given_id(async_client, db_session):
    await _configure(async_client)
    seen: list = []
    zoho_service.transport = _recording(seen)

    await zoho_service.update_contact_person(
        db_session, "zSNP", email="m@snp.pf", phone=None, phone_field="mobile", contact_person_id="cp2"
    )

    put = next((m, p, b) for m, p, b in seen if m == "PUT")
    assert put == ("PUT", "/books/v3/contacts/contactpersons/cp2", {"email": "m@snp.pf"})


@pytest.mark.asyncio
async def test_update_contact_person_without_id_still_targets_primary(async_client, db_session):
    await _configure(async_client)
    seen: list = []
    zoho_service.transport = _recording(seen)

    await zoho_service.update_contact_person(db_session, "zSNP", email="v@snp.pf", phone=None, phone_field="mobile")

    put = next((m, p, b) for m, p, b in seen if m == "PUT")
    assert put[1] == "/books/v3/contacts/contactpersons/cp1"


@pytest.mark.asyncio
async def test_update_contact_person_unknown_id_raises_not_found(async_client, db_session):
    await _configure(async_client)
    seen: list = []
    zoho_service.transport = _recording(seen)

    with pytest.raises(ZohoNotFound):
        await zoho_service.update_contact_person(
            db_session, "zSNP", email="x@snp.pf", phone=None, phone_field="mobile", contact_person_id="gone"
        )
    assert not any(m == "PUT" for m, _p, _b in seen)


@pytest.mark.asyncio
async def test_update_contact_passes_the_person_through(async_client, db_session):
    await _configure(async_client)
    seen: list = []
    zoho_service.transport = _recording(seen)

    name = await zoho_service.update_contact(
        db_session,
        "zSNP",
        company_name="SNP",
        first_name=None,
        last_name=None,
        email="m@snp.pf",
        phone="+689-87221043",
        phone_field="mobile",
        contact_person_id="cp2",
    )

    assert name == "SNP"
    paths = [p for m, p, _b in seen if m == "PUT"]
    assert paths == ["/books/v3/contacts/zSNP", "/books/v3/contacts/contactpersons/cp2"]


# ------------------------------------------------------------------ routes

WALK_IN = "66407000001237340"


@pytest.mark.asyncio
async def test_list_route_maps_persons(async_client):
    await _configure(async_client)
    zoho_service.transport = _recording([])
    r = await async_client.get("/api/v1/zoho/contacts/zSNP/persons")
    assert r.status_code == 200, r.text
    assert r.json() == [
        {
            "contact_person_id": "cp1",
            "first_name": "vaekehu",
            "last_name": "varney",
            "name": "Vaekehu VARNEY",
            "email": "vaekehu@snp.pf",
            "phone": "",
            "mobile": "+689-40549958",
            "is_primary": True,
        },
        {
            "contact_person_id": "cp2",
            "first_name": "Moana",
            "last_name": "TERIIPAIA",
            "name": "Moana TERIIPAIA",
            "email": "",
            "phone": "+689-87221043",
            "mobile": "",
            "is_primary": False,
        },
    ]


@pytest.mark.asyncio
async def test_list_route_walk_in_is_empty_without_a_books_call(async_client):
    await _configure(async_client)
    seen: list = []
    zoho_service.transport = _recording(seen)
    r = await async_client.get(f"/api/v1/zoho/contacts/{WALK_IN}/persons")
    assert r.status_code == 200
    assert r.json() == []
    assert seen == []


@pytest.mark.asyncio
async def test_list_route_error_mapping(async_client):
    r = await async_client.get("/api/v1/zoho/contacts/zSNP/persons")
    assert r.status_code == 409  # not configured
    await _configure(async_client)
    zoho_service.transport = _books(lambda request: httpx.Response(404, json={"message": "nope"}))
    assert (await async_client.get("/api/v1/zoho/contacts/zSNP/persons")).status_code == 404
    zoho_service.transport = _books(lambda request: httpx.Response(500, text="boom"))
    assert (await async_client.get("/api/v1/zoho/contacts/zSNP/persons")).status_code == 502


@pytest.mark.asyncio
async def test_create_route_normalises_and_returns_the_person(async_client):
    await _configure(async_client)
    seen: list = []
    zoho_service.transport = _recording(seen)
    r = await async_client.post(
        "/api/v1/zoho/contacts/zSNP/persons",
        json={"first_name": "hina", "last_name": "lo", "phone": "+689-87000000"},
    )
    assert r.status_code == 201, r.text
    assert r.json()["contact_person_id"] == "cp9"
    assert r.json()["name"] == "Hina LO"
    post = next(b for m, p, b in seen if m == "POST")
    assert post["first_name"] == "Hina"
    assert post["last_name"] == "LO"
    assert post["mobile"] == "+689-87000000"


@pytest.mark.asyncio
async def test_create_route_validation(async_client):
    await _configure(async_client)
    zoho_service.transport = _recording([])
    url = "/api/v1/zoho/contacts/zSNP/persons"
    assert (await async_client.post(url, json={"first_name": "", "email": "a@b.pf"})).status_code == 422
    assert (await async_client.post(url, json={"first_name": "Hina"})).status_code == 422  # no phone, no email
    assert (await async_client.post(url, json={"first_name": "Hina", "email": "nope"})).status_code == 422
    assert (await async_client.post(url, json={"first_name": "Hina", "phone": "87000000"})).status_code == 422
    assert (await async_client.post(url, json={"first_name": "Hina", "email": "h@x.pf"})).status_code == 201


@pytest.mark.asyncio
async def test_create_route_refuses_walk_in(async_client):
    await _configure(async_client)
    zoho_service.transport = _recording([])
    r = await async_client.post(
        f"/api/v1/zoho/contacts/{WALK_IN}/persons", json={"first_name": "Hina", "email": "h@x.pf"}
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_create_route_maps_zoho_rejection_to_409_with_its_message(async_client):
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json={"contact": SNP})
        return httpx.Response(400, json={"code": 1038, "message": "Email already in use"})

    zoho_service.transport = _books(handler)
    r = await async_client.post("/api/v1/zoho/contacts/zSNP/persons", json={"first_name": "Hina", "email": "h@x.pf"})
    assert r.status_code == 409
    assert "Email already in use" in r.json()["detail"]
