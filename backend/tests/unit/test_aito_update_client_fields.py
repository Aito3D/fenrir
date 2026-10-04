"""T-154: PATCH /aito/{id} no longer re-points a card at another contact.

Card ownership changes only through PUT /{id}/transfer-client (invoiced-card
guard, client push flag, social/contact clearing) and PUT /{id}/client (the
Books-first edit). A PATCH body carrying `client_id` or `client_name` is a 422
from the schema, before the handler runs, so nothing is written and an
`expected_version` claim is not spent. Every other field, and any other
unknown key, behaves exactly as before.
"""

import pytest
from sqlalchemy import update

from backend.app.models.aito_project import AitoProject
from backend.app.schemas.aito import AitoProjectUpdate


async def _create(client, **overrides):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "+33 6 12 34 56 78",
    }
    payload.update(overrides)
    r = await client.post("/api/v1/aito/", json=payload)
    assert r.status_code == 201, r.text
    return r.json()


async def _board_row(client, project_id):
    return next(p for p in (await client.get("/api/v1/aito/")).json() if p["id"] == project_id)


_OWNERSHIP_BODIES = [
    pytest.param({"client_id": "z9", "client_name": "Globex"}, id="id-and-name"),
    pytest.param({"client_id": "z9"}, id="id-alone"),
    pytest.param({"client_name": "ACME SARL"}, id="name-alone"),
    pytest.param({"client_id": None, "client_name": None}, id="both-null"),
    pytest.param({"client_name": None}, id="name-null"),
    pytest.param({"description": "Autre", "client_id": "z9", "client_name": "Globex"}, id="with-a-description"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("body", _OWNERSHIP_BODIES)
async def test_a_patch_carrying_client_id_or_client_name_is_refused_and_writes_nothing(async_client, body):
    a = await _create(async_client)
    r = await async_client.patch(f"/api/v1/aito/{a['id']}", json=body)
    assert r.status_code == 422, r.text
    assert "transfer-client" in r.text
    row = await _board_row(async_client, a["id"])
    assert (row["client_id"], row["client_name"], row["description"]) == ("z1", "ACME", "Support GoPro")
    assert row["version"] == a["version"]


@pytest.mark.asyncio
async def test_an_invoiced_card_cannot_be_re_pointed_through_the_patch(async_client, db_session):
    a = await _create(async_client)
    await db_session.execute(update(AitoProject).where(AitoProject.id == a["id"]).values(quote_invoiced=True))
    await db_session.commit()
    r = await async_client.patch(f"/api/v1/aito/{a['id']}", json={"client_id": "z9", "client_name": "Globex"})
    assert r.status_code == 422, r.text
    row = await _board_row(async_client, a["id"])
    assert (row["client_id"], row["client_name"]) == ("z1", "ACME")


@pytest.mark.asyncio
async def test_a_refused_ownership_patch_does_not_spend_the_version_claim(async_client):
    a = await _create(async_client)
    r = await async_client.patch(
        f"/api/v1/aito/{a['id']}", json={"client_id": "z9", "client_name": "Globex", "expected_version": a["version"]}
    )
    assert r.status_code == 422
    ok = await async_client.patch(
        f"/api/v1/aito/{a['id']}", json={"description": "Autre", "expected_version": a["version"]}
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["description"] == "Autre"


@pytest.mark.asyncio
async def test_the_other_client_fields_are_still_written_by_the_patch(async_client):
    a = await _create(async_client)
    r = await async_client.patch(
        f"/api/v1/aito/{a['id']}",
        json={"client_phone": None, "client_email": "ops@acme.pf", "client_contact_name": "Hina"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["client_phone"], body["client_email"], body["client_contact_name"]) == (None, "ops@acme.pf", "Hina")
    assert (body["client_id"], body["client_name"]) == ("z1", "ACME")


@pytest.mark.asyncio
async def test_any_other_unknown_key_is_still_ignored(async_client):
    a = await _create(async_client)
    r = await async_client.patch(f"/api/v1/aito/{a['id']}", json={"description": "Autre", "bogus": 1})
    assert r.status_code == 200, r.text
    assert r.json()["description"] == "Autre"


@pytest.mark.asyncio
async def test_a_card_stored_with_an_id_but_no_name_still_refuses_every_patch(async_client, db_session):
    """The merged-row invariant (a client_id needs a name) still guards the
    stored row: unchanged behavior for a legacy, inconsistent card."""
    a = await _create(async_client)
    await db_session.execute(update(AitoProject).where(AitoProject.id == a["id"]).values(client_name=None))
    await db_session.commit()
    r = await async_client.patch(f"/api/v1/aito/{a['id']}", json={"description": "Autre"})
    assert r.status_code == 422
    assert r.json()["detail"] == "client_name is required when client_id is set"


def test_the_update_schema_no_longer_publishes_client_id_or_client_name():
    properties = AitoProjectUpdate.model_json_schema()["properties"]
    assert "client_id" not in properties and "client_name" not in properties
    assert "client_phone" in properties and "client_contact_person_id" in properties
