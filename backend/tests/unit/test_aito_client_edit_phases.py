"""PUT /aito/{id}/client — the route's phases pinned one by one.

test_aito_client_edit.py covers the behaviour end to end through a fake Books
transport. This file pins the parts it asserts only loosely: the exact status
and detail of every arm of the Books error ladder (and the exact arguments the
Books write receives), the exact ``changes`` payload recorded on the edited
card and on each sibling, and the broadcast sent on success.
"""

import pytest

import backend.app.api.routes.aito as aito_routes
from backend.app.services.zoho import (
    ZohoAmbiguous,
    ZohoNotConfiguredError,
    ZohoNotFound,
    ZohoRequestRejected,
    ZohoUpstreamError,
    zoho_service,
)
from backend.tests.unit.test_aito_client_edit import COMPANY, PERSON_EDIT, _configure, _create, _read


@pytest.fixture
def books(monkeypatch):
    """``update_contact`` stubbed on the service instance: records every call,
    answers ``state["name"]`` or raises ``state["raise"]``."""
    state: dict = {"calls": [], "raise": None, "name": "Books Name"}

    async def update_contact(db, contact_id, **kwargs):
        state["calls"].append((contact_id, kwargs))
        if state["raise"] is not None:
            raise state["raise"]
        return state["name"]

    monkeypatch.setattr(zoho_service, "update_contact", update_contact)
    return state


@pytest.fixture
def broadcasts(monkeypatch):
    sent: list[tuple] = []

    async def fake(action, project_id, actor):
        sent.append((action, project_id, actor))

    monkeypatch.setattr(aito_routes, "_broadcast_changed", fake)
    return sent


async def _updated_changes(client, project_id: int) -> list[list[dict]]:
    events = (await client.get(f"/api/v1/aito/{project_id}/events?depth=detail")).json()["events"]
    return [e["changes"] for e in events if e["kind"] == "project.updated"]


COMPANY_EDIT = {"company_name": "SNP", "email": "g@snp.pf", "phone": "", "phone_field": "phone"}

LADDER = [
    # (id, card kind, raised, status, detail)
    ("not-configured", "person", ZohoNotConfiguredError("x"), 409, "Zoho is not configured"),
    (
        "not-found-with-person",
        "company",
        ZohoNotFound("gone"),
        409,
        {"code": "contact_person_gone", "message": "This contact person no longer exists in Zoho Books"},
    ),
    ("not-found-without-person", "person", ZohoNotFound("Contact missing"), 502, "Contact missing"),
    ("rejected", "person", ZohoRequestRejected("Name already exists"), 409, "Name already exists"),
    ("upstream", "person", ZohoUpstreamError("Books down"), 502, "Books down"),
    ("ambiguous", "company", ZohoAmbiguous("Zoho Books error (HTTP 503)"), 502, "Zoho Books error (HTTP 503)"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(("kind", "raised", "status", "detail"), [c[1:] for c in LADDER], ids=[c[0] for c in LADDER])
@pytest.mark.parametrize("guarded", [False, True], ids=["unguarded", "guarded"])
async def test_books_error_ladder(async_client, books, broadcasts, kind, raised, status, detail, guarded):
    await _configure(async_client)
    books["raise"] = raised
    if kind == "company":
        project = await _create(async_client, **COMPANY)
        body = dict(COMPANY_EDIT)
    else:
        project = await _create(async_client)
        body = dict(PERSON_EDIT)
    sibling = await _create(async_client, **(COMPANY if kind == "company" else {}), description="sibling")
    if guarded:
        body["expected_version"] = project["version"]

    broadcasts.clear()  # the creates above broadcast too
    r = await async_client.put(f"/api/v1/aito/{project['id']}/client", json=body)

    assert r.status_code == status
    assert r.json() == {"detail": detail}
    assert len(books["calls"]) == 1
    assert broadcasts == []
    after = await _read(async_client, project["id"])
    for key in ("client_name", "client_phone", "client_email", "client_contact_person_id"):
        assert after[key] == project[key]
    assert after["version"] == project["version"] + (1 if guarded else 0)
    assert await _updated_changes(async_client, project["id"]) == []
    sib_after = await _read(async_client, sibling["id"])
    assert sib_after["client_name"] == sibling["client_name"]
    assert sib_after["version"] == sibling["version"]


@pytest.mark.asyncio
async def test_books_write_arguments_for_a_person_card(async_client, books, broadcasts):
    await _configure(async_client)
    project = await _create(async_client)

    broadcasts.clear()  # the creates above broadcast too
    r = await async_client.put(
        f"/api/v1/aito/{project['id']}/client",
        json={**PERSON_EDIT, "first_name": " jean-pierre ", "email": " jp@example.pf ", "phone": " +689-87000002 "},
    )

    assert r.status_code == 200, r.text
    assert books["calls"] == [
        (
            "z1",
            {
                "company_name": None,
                "first_name": "jean-pierre",
                "last_name": "dupont",
                "email": "jp@example.pf",
                "phone": "+689-87000002",
                "phone_field": "mobile",
                "contact_person_id": None,
            },
        )
    ]
    # The name Books answered with is the one the card takes.
    assert r.json()["client_name"] == "Books Name"
    assert broadcasts == [("update", project["id"], None)]


@pytest.mark.asyncio
async def test_books_write_arguments_for_a_company_card_naming_a_person(async_client, books, broadcasts):
    await _configure(async_client)
    project = await _create(async_client, **COMPANY)

    broadcasts.clear()  # the creates above broadcast too
    r = await async_client.put(
        f"/api/v1/aito/{project['id']}/client",
        json={
            **COMPANY_EDIT,
            "company_name": " SNP Tahiti ",
            "client_contact_person_id": "cp2",
            "client_contact_name": "Moana TERIIPAIA",
        },
    )

    assert r.status_code == 200, r.text
    assert books["calls"] == [
        (
            "zSNP",
            {
                "company_name": "SNP Tahiti",
                "first_name": None,
                "last_name": None,
                "email": "g@snp.pf",
                "phone": "",
                "phone_field": "phone",
                "contact_person_id": "cp2",
            },
        )
    ]


@pytest.mark.asyncio
async def test_changes_recorded_on_the_card_and_each_sibling(async_client, books, broadcasts):
    """Edited card: social changes, then person changes, then name/coords.
    Same-person sibling: name and coords. Other-person sibling: name only."""
    await _configure(async_client)
    books["name"] = "SNP Tahiti"
    edited = await _create(async_client, **COMPANY)
    same = await _create(
        async_client,
        **{**COMPANY, "client_contact_person_id": "cp2", "client_contact_name": "Moana TERIIPAIA"},
        description="same person",
    )
    other = await _create(async_client, **COMPANY, description="other person")
    stranger = await _create(async_client, client_id="z9", client_name="Someone ELSE", description="stranger")

    broadcasts.clear()  # the creates above broadcast too
    r = await async_client.put(
        f"/api/v1/aito/{edited['id']}/client",
        json={
            "company_name": "SNP Tahiti",
            "email": "new@snp.pf",
            "phone": "+689-40000000",
            "phone_field": "mobile",
            "client_contact_person_id": "cp2",
            "client_contact_name": "Moana TERIIPAIA",
            "client_social_network": "instagram",
            "client_social_handle": "snp.pf",
            "expected_version": edited["version"],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["version"] == edited["version"] + 1
    assert (body["client_social_network"], body["client_social_handle"]) == ("instagram", "snp.pf")
    assert (body["client_contact_person_id"], body["client_contact_name"]) == ("cp2", "Moana TERIIPAIA")

    assert await _updated_changes(async_client, edited["id"]) == [
        [
            {"field": "client_social_network", "from": None, "to": "instagram"},
            {"field": "client_social_handle", "from": None, "to": "snp.pf"},
            {"field": "client_contact_person_id", "from": "cp1", "to": "cp2"},
            {"field": "client_contact_name", "from": "Vaekehu VARNEY", "to": "Moana TERIIPAIA"},
            {"field": "client_name", "from": "SNP", "to": "SNP Tahiti"},
            {"field": "client_phone", "from": "+689-87000001", "to": "+689-40000000"},
            {"field": "client_email", "from": "jean@example.pf", "to": "new@snp.pf"},
        ]
    ]
    assert await _updated_changes(async_client, same["id"]) == [
        [
            {"field": "client_name", "from": "SNP", "to": "SNP Tahiti"},
            {"field": "client_phone", "from": "+689-87000001", "to": "+689-40000000"},
            {"field": "client_email", "from": "jean@example.pf", "to": "new@snp.pf"},
        ]
    ]
    assert await _updated_changes(async_client, other["id"]) == [
        [{"field": "client_name", "from": "SNP", "to": "SNP Tahiti"}]
    ]
    assert await _updated_changes(async_client, stranger["id"]) == []

    same_after = await _read(async_client, same["id"])
    other_after = await _read(async_client, other["id"])
    assert (same_after["client_name"], same_after["client_email"], same_after["client_phone"]) == (
        "SNP Tahiti",
        "new@snp.pf",
        "+689-40000000",
    )
    assert (other_after["client_name"], other_after["client_email"], other_after["client_phone"]) == (
        "SNP Tahiti",
        "jean@example.pf",
        "+689-87000001",
    )
    assert other_after["client_social_handle"] is None
    assert same_after["version"] == same["version"] + 1
    assert other_after["version"] == other["version"] + 1
    assert broadcasts == [("update", edited["id"], None)]


@pytest.mark.asyncio
async def test_a_no_op_edit_surfaces_no_change_event(async_client, books, broadcasts):
    """Nothing differs: no project.updated event surfaces, the guarded
    version still lands on expected + 1, and the broadcast still goes out."""
    await _configure(async_client)
    books["name"] = "Jean DUPONT"
    project = await _create(async_client)

    broadcasts.clear()  # the creates above broadcast too
    r = await async_client.put(
        f"/api/v1/aito/{project['id']}/client",
        json={
            "first_name": "Jean",
            "last_name": "DUPONT",
            "email": "jean@example.pf",
            "phone": "+689-87000001",
            "phone_field": "mobile",
            "expected_version": project["version"],
        },
    )

    assert r.status_code == 200, r.text
    assert r.json()["version"] == project["version"] + 1
    changes = await _updated_changes(async_client, project["id"])
    assert changes == []
    assert broadcasts == [("update", project["id"], None)]


@pytest.mark.asyncio
async def test_walk_in_card_takes_the_composed_name_and_blank_coordinates_become_none(async_client, books, broadcasts):
    await _configure(async_client)
    project = await _create(async_client, client_id="66407000001237340", client_name="Client de passage")

    broadcasts.clear()  # the creates above broadcast too
    r = await async_client.put(
        f"/api/v1/aito/{project['id']}/client",
        json={**PERSON_EDIT, "email": "", "client_social_network": "instagram", "client_social_handle": "jp"},
    )

    assert r.status_code == 200, r.text
    assert books["calls"] == []
    assert r.json()["client_name"] == "Jean-Pierre DUPONT"
    assert r.json()["client_email"] is None
    assert await _updated_changes(async_client, project["id"]) == [
        [
            {"field": "client_social_network", "from": None, "to": "instagram"},
            {"field": "client_social_handle", "from": None, "to": "jp"},
            {"field": "client_name", "from": "Client de passage", "to": "Jean-Pierre DUPONT"},
            {"field": "client_phone", "from": "+689-87000001", "to": "+689-87000002"},
            {"field": "client_email", "from": "jean@example.pf", "to": None},
        ]
    ]
