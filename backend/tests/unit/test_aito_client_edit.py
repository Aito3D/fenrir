"""PUT /aito/{id}/client — edit the attached Zoho contact from the card panel.

Zoho is written FIRST; the card (and every other active card on the same
contact) is rewritten only once Books has accepted the change, so the two
never disagree. The walk-in default contact is the one exception: Books
refuses edits to it, so those cards take a card-only edit.
"""

import json

import httpx
import pytest

from backend.app.services.zoho import zoho_service

WALK_IN_ID = "66407000001237340"


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
    """A transport that answers the token exchange itself and hands every
    Books call to ``handler``."""

    def wrapped(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return handler(request)

    return httpx.MockTransport(wrapped)


def _recording_books(seen: list, *, contact: dict | None = None):
    """Records every Books call as (method, path, body) and answers them the
    way a healthy Books would."""
    contact = contact or {
        "contact_id": "z1",
        "contact_name": "Jean DUPONT",
        "customer_sub_type": "individual",
        "first_name": "Jean",
        "last_name": "DUPONT",
        "email": "jean@example.pf",
        "mobile": "+689-87000001",
        "phone": "",
        "contact_persons": [{"contact_person_id": "cp1", "is_primary_contact": True}],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        seen.append((request.method, request.url.path, body))
        if request.method == "GET":
            return httpx.Response(200, json={"contact": contact})
        if "/contactpersons" in request.url.path:
            return httpx.Response(200, json={"contact_person": {}})
        return httpx.Response(200, json={"contact": contact})

    return _books(handler)


async def _create(client, **overrides):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "Jean DUPONT",
        "client_phone": "+689-87000001",
        "client_email": "jean@example.pf",
        "client_is_company": False,
    }
    payload.update(overrides)
    r = await client.post("/api/v1/aito/", json=payload)
    assert r.status_code == 201, r.text
    return r.json()


async def _read(client, project_id: int) -> dict:
    """The board has no single-card GET; read the card back off the list."""
    board = (await client.get("/api/v1/aito/")).json()
    return next(p for p in board if p["id"] == project_id)


PERSON_EDIT = {
    "first_name": "jean-pierre",
    "last_name": "dupont",
    "email": "jp@example.pf",
    "phone": "+689-87000002",
    "phone_field": "mobile",
}


# ------------------------------------------------------------ Zoho first


@pytest.mark.asyncio
async def test_edit_writes_name_and_person_to_zoho_then_the_card(async_client):
    await _configure(async_client)
    seen: list = []
    zoho_service.transport = _recording_books(seen)
    project = await _create(async_client)

    r = await async_client.put(
        f"/api/v1/aito/{project['id']}/client", json={**PERSON_EDIT, "expected_version": project["version"]}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # House casing applied server-side, like create_contact does.
    assert body["client_name"] == "Jean-Pierre DUPONT"
    assert body["client_phone"] == "+689-87000002"
    assert body["client_email"] == "jp@example.pf"
    assert body["client_is_company"] is False
    assert body["version"] == project["version"] + 1

    contact_put = next(b for m, p, b in seen if m == "PUT" and p == "/books/v3/contacts/z1")
    assert contact_put == {"contact_name": "Jean-Pierre DUPONT"}
    person_put = next(b for m, p, b in seen if m == "PUT" and p == "/books/v3/contacts/contactpersons/cp1")
    assert person_put == {
        "first_name": "Jean-Pierre",
        "last_name": "DUPONT",
        "email": "jp@example.pf",
        "mobile": "+689-87000002",
    }


@pytest.mark.asyncio
async def test_company_edit_writes_company_name_to_zoho(async_client):
    await _configure(async_client)
    seen: list = []
    zoho_service.transport = _recording_books(seen)
    project = await _create(async_client, client_name="ACME", client_is_company=True)

    r = await async_client.put(
        f"/api/v1/aito/{project['id']}/client",
        json={"company_name": "  Acme Pacific ", "email": "hello@acme.pf", "phone": "", "phone_field": "phone"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["client_name"] == "Acme Pacific"
    assert r.json()["client_is_company"] is True
    contact_put = next(b for m, p, b in seen if m == "PUT" and p == "/books/v3/contacts/z1")
    assert contact_put == {"contact_name": "Acme Pacific", "company_name": "Acme Pacific"}
    person_put = next(b for m, p, b in seen if m == "PUT" and p == "/books/v3/contacts/contactpersons/cp1")
    # A company edit never renames the contact person; it clears the phone
    # because the operator emptied it.
    assert person_put == {"email": "hello@acme.pf", "phone": ""}


@pytest.mark.asyncio
async def test_zoho_failure_leaves_the_card_untouched(async_client):
    await _configure(async_client)
    zoho_service.transport = _books(lambda request: httpx.Response(500, text="boom"))
    project = await _create(async_client)

    r = await async_client.put(f"/api/v1/aito/{project['id']}/client", json=PERSON_EDIT)
    assert r.status_code == 502

    after = await _read(async_client, project["id"])
    assert after["client_name"] == "Jean DUPONT"
    assert after["client_phone"] == "+689-87000001"
    assert after["version"] == project["version"]


@pytest.mark.asyncio
async def test_zoho_rejection_surfaces_its_message_as_409(async_client):
    await _configure(async_client)
    zoho_service.transport = _books(
        lambda request: httpx.Response(400, json={"code": 1000, "message": "Contact name already exists"})
    )
    project = await _create(async_client)

    r = await async_client.put(f"/api/v1/aito/{project['id']}/client", json=PERSON_EDIT)
    assert r.status_code == 409
    assert "already exists" in r.json()["detail"]


@pytest.mark.asyncio
async def test_zoho_unconfigured_is_409(async_client):
    project = await _create(async_client)
    r = await async_client.put(f"/api/v1/aito/{project['id']}/client", json=PERSON_EDIT)
    assert r.status_code == 409


# ------------------------------------------------------------ walk-in


@pytest.mark.asyncio
async def test_walk_in_card_is_edited_without_touching_zoho(async_client):
    await _configure(async_client)
    seen: list = []
    zoho_service.transport = _recording_books(seen)
    project = await _create(async_client, client_id=WALK_IN_ID, client_name="Client de passage")

    r = await async_client.put(f"/api/v1/aito/{project['id']}/client", json=PERSON_EDIT)
    assert r.status_code == 200, r.text
    assert r.json()["client_name"] == "Jean-Pierre DUPONT"
    assert r.json()["client_phone"] == "+689-87000002"
    assert seen == []


@pytest.mark.asyncio
async def test_walk_in_edit_never_fans_out_to_other_walk_in_cards(async_client):
    """Every passing customer shares the walk-in contact id, so the fan-out
    that keeps one real client's cards in step would here rename every
    counter sale after this one person."""
    await _configure(async_client)
    zoho_service.transport = _recording_books([])
    edited = await _create(async_client, client_id=WALK_IN_ID, client_name="Client de passage")
    other = await _create(async_client, client_id=WALK_IN_ID, client_name="Client de passage", description="Other")

    r = await async_client.put(f"/api/v1/aito/{edited['id']}/client", json=PERSON_EDIT)
    assert r.status_code == 200, r.text
    assert (await _read(async_client, other["id"]))["client_name"] == "Client de passage"


# ------------------------------------------------------------ fan-out


@pytest.mark.asyncio
async def test_edit_rewrites_every_active_card_on_the_same_contact(async_client):
    await _configure(async_client)
    zoho_service.transport = _recording_books([])
    edited = await _create(async_client)
    sibling = await _create(async_client, description="Second job")
    other = await _create(async_client, client_id="z2", client_name="Someone ELSE")
    trashed = await _create(async_client, description="Old job")
    assert (await async_client.delete(f"/api/v1/aito/{trashed['id']}")).status_code == 204

    r = await async_client.put(f"/api/v1/aito/{edited['id']}/client", json=PERSON_EDIT)
    assert r.status_code == 200, r.text

    sibling_after = await _read(async_client, sibling["id"])
    assert sibling_after["client_name"] == "Jean-Pierre DUPONT"
    assert sibling_after["client_phone"] == "+689-87000002"
    assert sibling_after["client_email"] == "jp@example.pf"
    assert sibling_after["version"] == sibling["version"] + 1

    other_after = await _read(async_client, other["id"])
    assert other_after["client_name"] == "Someone ELSE"

    trash = (await async_client.get("/api/v1/aito/trash")).json()
    assert next(p for p in trash if p["id"] == trashed["id"])["client_name"] == "Jean DUPONT"


@pytest.mark.asyncio
async def test_edit_records_a_project_updated_event_on_each_rewritten_card(async_client):
    await _configure(async_client)
    zoho_service.transport = _recording_books([])
    edited = await _create(async_client)
    sibling = await _create(async_client, description="Second job")

    r = await async_client.put(f"/api/v1/aito/{edited['id']}/client", json=PERSON_EDIT)
    assert r.status_code == 200, r.text

    for pid in (edited["id"], sibling["id"]):
        events = (await async_client.get(f"/api/v1/aito/{pid}/events?depth=detail")).json()["events"]
        updated = [e for e in events if e["kind"] == "project.updated"]
        assert len(updated) == 1, events
        changed = {c["field"]: c["to"] for c in updated[0]["changes"]}
        assert changed == {
            "client_name": "Jean-Pierre DUPONT",
            "client_phone": "+689-87000002",
            "client_email": "jp@example.pf",
        }


@pytest.mark.asyncio
async def test_edit_does_not_queue_a_quote_push(async_client):
    """Books derives the customer name from the contact itself, so the quote
    needs no re-push — and a needless push on a locked quote would only
    end in a sync error."""
    await _configure(async_client)
    zoho_service.transport = _recording_books([])
    project = await _create(async_client)
    # Drive the card to idle so a mark-pending would be visible.
    from sqlalchemy import update

    from backend.app.core.database import async_session
    from backend.app.models.aito_project import AitoProject

    async with async_session() as session:
        await session.execute(
            update(AitoProject).where(AitoProject.id == project["id"]).values(quote_sync_state="idle")
        )
        await session.commit()

    r = await async_client.put(f"/api/v1/aito/{project['id']}/client", json=PERSON_EDIT)
    assert r.status_code == 200, r.text
    assert r.json()["quote_sync_state"] == "idle"


# ------------------------------------------------------------ validation


@pytest.mark.asyncio
async def test_person_card_requires_first_and_last_name(async_client):
    await _configure(async_client)
    zoho_service.transport = _recording_books([])
    project = await _create(async_client)
    r = await async_client.put(
        f"/api/v1/aito/{project['id']}/client", json={**PERSON_EDIT, "first_name": "Jean", "last_name": ""}
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_company_card_requires_a_company_name(async_client):
    await _configure(async_client)
    zoho_service.transport = _recording_books([])
    project = await _create(async_client, client_name="ACME", client_is_company=True)
    r = await async_client.put(
        f"/api/v1/aito/{project['id']}/client", json={"company_name": "  ", "email": "a@b.pf", "phone": ""}
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_edit_must_keep_the_card_reachable(async_client):
    await _configure(async_client)
    seen: list = []
    zoho_service.transport = _recording_books(seen)
    project = await _create(async_client)
    r = await async_client.put(f"/api/v1/aito/{project['id']}/client", json={**PERSON_EDIT, "email": "", "phone": ""})
    assert r.status_code == 400
    assert seen == []


@pytest.mark.asyncio
async def test_a_social_handle_keeps_the_card_reachable(async_client):
    await _configure(async_client)
    zoho_service.transport = _recording_books([])
    project = await _create(
        async_client, client_phone=None, client_email=None, client_social_network="messenger", client_social_handle="jp"
    )
    r = await async_client.put(f"/api/v1/aito/{project['id']}/client", json={**PERSON_EDIT, "email": "", "phone": ""})
    assert r.status_code == 200, r.text
    assert r.json()["client_phone"] is None
    assert r.json()["client_email"] is None


@pytest.mark.asyncio
async def test_social_pair_in_the_body_is_written_to_the_card_only(async_client):
    """The contact sheet sends the social channel with the Books fields. It is
    card-only: never pushed to Zoho, never fanned out to sibling cards."""
    await _configure(async_client)
    seen: list = []
    zoho_service.transport = _recording_books(seen)
    project = await _create(async_client)
    sibling = await _create(async_client, description="Second card, same contact")
    r = await async_client.put(
        f"/api/v1/aito/{project['id']}/client",
        json={**PERSON_EDIT, "client_social_network": "instagram", "client_social_handle": "jp.3d"},
    )
    assert r.status_code == 200, r.text
    assert (r.json()["client_social_network"], r.json()["client_social_handle"]) == ("instagram", "jp.3d")
    assert not any("instagram" in json.dumps(body) for _method, _path, body in seen)
    other = await _read(async_client, sibling["id"])
    assert other["client_name"] == "Jean-Pierre DUPONT"  # the Books fields DID fan out
    assert other["client_social_handle"] is None  # the card-only channel did not


@pytest.mark.asyncio
async def test_a_blank_social_handle_in_the_body_clears_the_pair(async_client):
    await _configure(async_client)
    zoho_service.transport = _recording_books([])
    project = await _create(async_client, client_social_network="tiktok", client_social_handle="jp.tt")
    r = await async_client.put(
        f"/api/v1/aito/{project['id']}/client",
        json={**PERSON_EDIT, "client_social_network": "tiktok", "client_social_handle": ""},
    )
    assert r.status_code == 200, r.text
    assert r.json()["client_social_network"] is None
    assert r.json()["client_social_handle"] is None


@pytest.mark.asyncio
async def test_a_body_without_the_social_pair_leaves_the_handle_alone(async_client):
    await _configure(async_client)
    zoho_service.transport = _recording_books([])
    project = await _create(async_client, client_social_network="messenger", client_social_handle="jp")
    r = await async_client.put(f"/api/v1/aito/{project['id']}/client", json=PERSON_EDIT)
    assert r.status_code == 200, r.text
    assert (r.json()["client_social_network"], r.json()["client_social_handle"]) == ("messenger", "jp")


@pytest.mark.asyncio
async def test_reachability_is_judged_on_the_social_handle_after_the_edit(async_client):
    """Clearing the only channel in the same body is refused; adding one in
    the same body is enough."""
    await _configure(async_client)
    zoho_service.transport = _recording_books([])
    only_social = await _create(
        async_client, client_phone=None, client_email=None, client_social_network="messenger", client_social_handle="jp"
    )
    r = await async_client.put(
        f"/api/v1/aito/{only_social['id']}/client",
        json={**PERSON_EDIT, "email": "", "phone": "", "client_social_network": None, "client_social_handle": ""},
    )
    assert r.status_code == 400
    bare = await _create(async_client)
    r = await async_client.put(
        f"/api/v1/aito/{bare['id']}/client",
        json={
            **PERSON_EDIT,
            "email": "",
            "phone": "",
            "client_social_network": "whatsapp",
            "client_social_handle": "87",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["client_social_handle"] == "87"


@pytest.mark.asyncio
async def test_malformed_phone_and_email_are_422(async_client):
    await _configure(async_client)
    zoho_service.transport = _recording_books([])
    project = await _create(async_client)
    url = f"/api/v1/aito/{project['id']}/client"
    assert (await async_client.put(url, json={**PERSON_EDIT, "email": "nope"})).status_code == 422
    assert (await async_client.put(url, json={**PERSON_EDIT, "phone": "12"})).status_code == 422


@pytest.mark.asyncio
async def test_stale_version_is_a_409_before_zoho_is_called(async_client):
    await _configure(async_client)
    seen: list = []
    zoho_service.transport = _recording_books(seen)
    project = await _create(async_client)
    r = await async_client.put(
        f"/api/v1/aito/{project['id']}/client", json={**PERSON_EDIT, "expected_version": project["version"] + 5}
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "version_conflict"
    assert seen == []


@pytest.mark.asyncio
async def test_unknown_or_trashed_project_is_404(async_client):
    await _configure(async_client)
    zoho_service.transport = _recording_books([])
    assert (await async_client.put("/api/v1/aito/999999/client", json=PERSON_EDIT)).status_code == 404
    project = await _create(async_client)
    await async_client.delete(f"/api/v1/aito/{project['id']}")
    assert (await async_client.put(f"/api/v1/aito/{project['id']}/client", json=PERSON_EDIT)).status_code == 404


# ------------------------------------------------------------ prefill read


@pytest.mark.asyncio
async def test_get_zoho_contact_returns_person_fields_for_prefill(async_client):
    await _configure(async_client)
    zoho_service.transport = _recording_books([])
    r = await async_client.get("/api/v1/zoho/contacts/z1")
    assert r.status_code == 200
    assert r.json() == {
        "id": "z1",
        "name": "Jean DUPONT",
        "company_name": "",
        "customer_sub_type": "individual",
        "phone": "",
        "mobile": "+689-87000001",
        "email": "jean@example.pf",
        "first_name": "Jean",
        "last_name": "DUPONT",
    }


@pytest.mark.asyncio
async def test_get_zoho_contact_maps_errors(async_client):
    assert (await async_client.get("/api/v1/zoho/contacts/z1")).status_code == 409
    await _configure(async_client)
    zoho_service.transport = _books(lambda request: httpx.Response(404, json={"message": "no"}))
    assert (await async_client.get("/api/v1/zoho/contacts/z1")).status_code == 404
    zoho_service.transport = _books(lambda request: httpx.Response(500, text="boom"))
    assert (await async_client.get("/api/v1/zoho/contacts/z1")).status_code == 502


# ------------------------------------------------------- contact persons

SNP = {
    "contact_id": "zSNP",
    "contact_name": "SNP",
    "customer_sub_type": "business",
    "company_name": "SNP",
    "contact_persons": [
        {"contact_person_id": "cp1", "first_name": "Vaekehu", "last_name": "VARNEY", "is_primary_contact": True},
        {"contact_person_id": "cp2", "first_name": "Moana", "last_name": "TERIIPAIA"},
    ],
}

COMPANY = {
    "client_id": "zSNP",
    "client_name": "SNP",
    "client_is_company": True,
    "client_contact_person_id": "cp1",
    "client_contact_name": "Vaekehu VARNEY",
}


@pytest.mark.asyncio
async def test_company_edit_writes_to_the_selected_person(async_client):
    await _configure(async_client)
    seen: list = []
    zoho_service.transport = _recording_books(seen, contact=SNP)
    project = await _create(async_client, **COMPANY)

    r = await async_client.put(
        f"/api/v1/aito/{project['id']}/client",
        json={
            "company_name": "SNP",
            "client_contact_person_id": "cp2",
            "client_contact_name": "Moana TERIIPAIA",
            "email": "moana@snp.pf",
            "phone": "+689-87221043",
            "phone_field": "mobile",
            "expected_version": project["version"],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["client_contact_person_id"] == "cp2"
    assert body["client_contact_name"] == "Moana TERIIPAIA"
    assert body["client_phone"] == "+689-87221043"
    person_put = next((p, b) for m, p, b in seen if m == "PUT" and "/contactpersons/" in p)
    assert person_put == ("/books/v3/contacts/contactpersons/cp2", {"email": "moana@snp.pf", "mobile": "+689-87221043"})


@pytest.mark.asyncio
async def test_company_edit_without_person_keys_keeps_the_card_person(async_client):
    await _configure(async_client)
    seen: list = []
    zoho_service.transport = _recording_books(seen, contact=SNP)
    project = await _create(async_client, **COMPANY)

    r = await async_client.put(
        f"/api/v1/aito/{project['id']}/client",
        json={"company_name": "SNP", "email": "v2@snp.pf", "phone": "", "phone_field": "mobile"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["client_contact_person_id"] == "cp1"
    person_put = next(p for m, p, _b in seen if m == "PUT" and "/contactpersons/" in p)
    assert person_put == "/books/v3/contacts/contactpersons/cp1"


@pytest.mark.asyncio
async def test_company_edit_with_a_gone_person_is_409(async_client):
    await _configure(async_client)
    zoho_service.transport = _recording_books([], contact=SNP)
    project = await _create(async_client, **COMPANY)

    r = await async_client.put(
        f"/api/v1/aito/{project['id']}/client",
        json={
            "company_name": "SNP",
            "client_contact_person_id": "gone",
            "client_contact_name": "Ghost",
            "email": "g@snp.pf",
            "phone": "",
            "phone_field": "mobile",
        },
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "contact_person_gone"
    assert (await _read(async_client, project["id"]))["client_contact_person_id"] == "cp1"


@pytest.mark.asyncio
async def test_fan_out_reaches_only_siblings_with_the_same_person(async_client):
    await _configure(async_client)
    zoho_service.transport = _recording_books([], contact=SNP)
    edited = await _create(async_client, **COMPANY)
    same_person = await _create(async_client, **COMPANY, description="same person")
    other_person = await _create(
        async_client, **{**COMPANY, "client_contact_person_id": "cp2", "client_contact_name": "Moana TERIIPAIA"}
    )
    no_person = await _create(
        async_client, **{**COMPANY, "client_contact_person_id": None, "client_contact_name": None}
    )

    r = await async_client.put(
        f"/api/v1/aito/{edited['id']}/client",
        json={"company_name": "SNP", "email": "new@snp.pf", "phone": "+689-40000000", "phone_field": "mobile"},
    )
    assert r.status_code == 200, r.text

    assert (await _read(async_client, same_person["id"]))["client_email"] == "new@snp.pf"
    assert (await _read(async_client, other_person["id"]))["client_email"] == "jean@example.pf"
    assert (await _read(async_client, no_person["id"]))["client_email"] == "jean@example.pf"
    # The company name is contact-level and still reaches every sibling.
    assert (await _read(async_client, other_person["id"]))["client_name"] == "SNP"


@pytest.mark.asyncio
async def test_switching_person_does_not_fan_out(async_client):
    await _configure(async_client)
    zoho_service.transport = _recording_books([], contact=SNP)
    edited = await _create(async_client, **COMPANY)
    sibling = await _create(async_client, **COMPANY, description="sibling")

    r = await async_client.put(
        f"/api/v1/aito/{edited['id']}/client",
        json={
            "company_name": "SNP",
            "client_contact_person_id": "cp2",
            "client_contact_name": "Moana TERIIPAIA",
            "email": "moana@snp.pf",
            "phone": "",
            "phone_field": "mobile",
        },
    )
    assert r.status_code == 200, r.text
    row = await _read(async_client, sibling["id"])
    assert row["client_contact_person_id"] == "cp1"
    assert row["client_email"] == "jean@example.pf"


@pytest.mark.asyncio
async def test_legacy_company_card_never_auto_assigns_the_primary(async_client):
    """A company card stored with no person (client_contact_person_id=None) must
    stay person-less on an edit that never mentions the person keys — the
    frontend contact sheet no longer auto-selects the primary for it either
    (ContactPersonPicker's `autoSelect` prop). Its fan-out must still reach the
    other person-less siblings (`None == None` counts as a match), and the
    Books coordinate write still targets the primary — a person-less card has
    no person of its own to write to."""
    await _configure(async_client)
    seen: list = []
    zoho_service.transport = _recording_books(seen, contact=SNP)
    legacy = await _create(async_client, **{**COMPANY, "client_contact_person_id": None, "client_contact_name": None})
    sibling_no_person = await _create(
        async_client,
        **{**COMPANY, "client_contact_person_id": None, "client_contact_name": None},
        description="sibling, no person",
    )
    sibling_with_person = await _create(async_client, **COMPANY, description="sibling, cp1")

    r = await async_client.put(
        f"/api/v1/aito/{legacy['id']}/client",
        json={
            "company_name": "SNP",
            "client_contact_person_id": None,
            "client_contact_name": None,
            "email": "new@snp.pf",
            "phone": "+689-40000000",
            "phone_field": "mobile",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["client_contact_person_id"] is None
    assert body["client_contact_name"] is None
    assert body["client_email"] == "new@snp.pf"

    # Fan-out reaches the other person-less sibling but not the cp1 one.
    assert (await _read(async_client, sibling_no_person["id"]))["client_email"] == "new@snp.pf"
    assert (await _read(async_client, sibling_with_person["id"]))["client_email"] == "jean@example.pf"

    # The Books coordinate write, with no person named, targets the primary.
    person_put = next(p for m, p, _b in seen if m == "PUT" and "/contactpersons/" in p)
    assert person_put == "/books/v3/contacts/contactpersons/cp1"


@pytest.mark.asyncio
async def test_contact_not_found_on_a_person_card_is_502_not_contact_person_gone(async_client):
    """A 404 from the contact-level PUT (a deleted Books contact) is only ever
    a stale contact_person_id on a COMPANY edit that named one. A person card
    never sends a contact_person_id, so the same 404 here means something else
    entirely upstream — it must fall back to the pre-existing 502, not the
    person-specific 409 `contact_person_gone`, which would be a dead end."""
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "PUT" and request.url.path == "/books/v3/contacts/z1":
            return httpx.Response(404, json={"message": "The contact does not exist"})
        if request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "contact": {
                        "contact_id": "z1",
                        "contact_name": "Jean DUPONT",
                        "customer_sub_type": "individual",
                        "first_name": "Jean",
                        "last_name": "DUPONT",
                        "email": "jean@example.pf",
                        "mobile": "+689-87000001",
                        "phone": "",
                        "contact_persons": [{"contact_person_id": "cp1", "is_primary_contact": True}],
                    }
                },
            )
        return httpx.Response(200, json={})

    zoho_service.transport = _books(handler)
    project = await _create(async_client)

    r = await async_client.put(
        f"/api/v1/aito/{project['id']}/client", json={**PERSON_EDIT, "expected_version": project["version"]}
    )
    assert r.status_code == 502
    assert r.json()["detail"]

    row = await _read(async_client, project["id"])
    assert row["client_name"] == "Jean DUPONT"
    assert row["version"] == project["version"]
