"""The chosen Zoho contact person on a company card: create, PATCH, response."""

import pytest

BASE = {
    "description": "Boule de 45mm",
    "client_id": "zSNP",
    "client_name": "Societe de Navigation Polynesienne",
    "client_phone": "+689-40549958",
    "client_email": "vaekehu@snp.pf",
    "client_is_company": True,
}


async def _create(client, **overrides):
    payload = {**BASE, **overrides}
    r = await client.post("/api/v1/aito/", json=payload)
    assert r.status_code == 201, r.text
    return r.json()


@pytest.mark.asyncio
async def test_create_stores_person_on_a_company_card(async_client):
    body = await _create(async_client, client_contact_person_id="cp1", client_contact_name="Vaekehu VARNEY")
    assert body["client_contact_person_id"] == "cp1"
    assert body["client_contact_name"] == "Vaekehu VARNEY"


@pytest.mark.asyncio
async def test_create_clears_person_on_a_person_card(async_client):
    body = await _create(
        async_client, client_is_company=False, client_contact_person_id="cp1", client_contact_name="Vaekehu VARNEY"
    )
    assert body["client_contact_person_id"] is None
    assert body["client_contact_name"] is None


@pytest.mark.asyncio
async def test_create_defaults_to_no_person(async_client):
    body = await _create(async_client)
    assert body["client_contact_person_id"] is None
    assert body["client_contact_name"] is None


@pytest.mark.asyncio
async def test_create_rejects_oversized_ids(async_client):
    r = await async_client.post("/api/v1/aito/", json={**BASE, "client_contact_person_id": "x" * 51})
    assert r.status_code == 422
    r = await async_client.post("/api/v1/aito/", json={**BASE, "client_contact_name": "x" * 201})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_patch_sets_and_clears_person(async_client):
    project = await _create(async_client)
    r = await async_client.patch(
        f"/api/v1/aito/{project['id']}",
        json={"client_contact_person_id": "cp2", "client_contact_name": "Moana TERIIPAIA"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["client_contact_person_id"] == "cp2"
    assert r.json()["client_contact_name"] == "Moana TERIIPAIA"

    r = await async_client.patch(
        f"/api/v1/aito/{project['id']}", json={"client_contact_person_id": None, "client_contact_name": None}
    )
    assert r.status_code == 200, r.text
    assert r.json()["client_contact_person_id"] is None


@pytest.mark.asyncio
async def test_patch_to_a_person_card_drops_the_person(async_client):
    project = await _create(async_client, client_contact_person_id="cp1", client_contact_name="Vaekehu VARNEY")
    r = await async_client.patch(f"/api/v1/aito/{project['id']}", json={"client_is_company": False})
    assert r.status_code == 200, r.text
    assert r.json()["client_contact_person_id"] is None
    assert r.json()["client_contact_name"] is None


@pytest.mark.asyncio
async def test_board_list_carries_the_person(async_client):
    project = await _create(async_client, client_contact_person_id="cp1", client_contact_name="Vaekehu VARNEY")
    board = (await async_client.get("/api/v1/aito/")).json()
    row = next(p for p in board if p["id"] == project["id"])
    assert row["client_contact_person_id"] == "cp1"
    assert row["client_contact_name"] == "Vaekehu VARNEY"
