"""The shipping services endpoint, and shipping validation on create/patch."""

import pytest
from sqlalchemy import select

from backend.app.models.aito_project import AitoProject
from backend.app.services.zoho import zoho_service


async def _create(async_client, **overrides):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "+689-87123456",
    }
    payload.update(overrides)
    return await async_client.post("/api/v1/aito/", json=payload)


SHIPPING = {
    "shipping_island": "rangiroa",
    "shipping_first_name": "Jean-Pierre",
    "shipping_last_name": "DUPONT",
    "shipping_phone": "+689-89645864",
}


@pytest.fixture
def resolved_catalogue(monkeypatch):
    from backend.app.services.aito_shipping import ShippingItem

    async def fake(db, **kwargs):
        return {"tuamotu": ShippingItem(item_id="SHIP-TU", name="Livraison Avion Tuamotu", rate=3200.0)}

    # Patched on the INSTANCE, not the class: pytest's monkeypatch restores an
    # attribute that only ever existed via the class (a bound method) by
    # setting an instance-level shadow — see test_aito_quote_sync.py's own
    # `get_shipping_catalogue` patch, which already leaves that shadow behind
    # for the rest of the session. A class-level patch here would be silently
    # masked by that shadow whenever this file runs after that one.
    monkeypatch.setattr(zoho_service, "get_shipping_catalogue", fake)


async def test_services_endpoint_lists_every_service_with_its_islands(async_client, resolved_catalogue):
    response = await async_client.get("/api/v1/aito/shipping/services")
    assert response.status_code == 200
    body = response.json()
    assert [s["key"] for s in body["services"]] == ["societe", "tuamotu", "marquises", "australes", "gambier"]
    tuamotu = next(s for s in body["services"] if s["key"] == "tuamotu")
    assert tuamotu["name"] == "Livraison Avion Tuamotu"
    assert tuamotu["rate"] == 3200.0
    assert {"key": "rangiroa", "label": "Rangiroa"} in tuamotu["islands"]
    assert body["catalogue_resolved"] is True


async def test_services_endpoint_serves_islands_with_zoho_unreachable(async_client, monkeypatch):
    async def empty(db, **kwargs):
        return {}

    # Instance-level, not class-level — see resolved_catalogue's comment.
    monkeypatch.setattr(zoho_service, "get_shipping_catalogue", empty)
    body = (await async_client.get("/api/v1/aito/shipping/services")).json()
    assert body["catalogue_resolved"] is False
    assert all(service["rate"] is None for service in body["services"])
    assert sum(len(service["islands"]) for service in body["services"]) == 45


async def test_create_derives_the_service_and_defaults_the_price(async_client, resolved_catalogue):
    body = (await _create(async_client, **SHIPPING)).json()
    assert body["shipping_island"] == "rangiroa"
    assert body["shipping_service"] == "tuamotu"
    assert body["shipping_service_name"] == "Livraison Avion Tuamotu"
    assert body["shipping_price"] == 3200.0


async def test_create_ignores_a_client_supplied_service(async_client, resolved_catalogue):
    # The service is derived, never trusted.
    body = (await _create(async_client, **SHIPPING, shipping_service="gambier")).json()
    assert body["shipping_service"] == "tuamotu"


async def test_create_accepts_a_price_override(async_client, resolved_catalogue):
    body = (await _create(async_client, **SHIPPING, shipping_price=5400)).json()
    assert body["shipping_price"] == 5400.0


async def test_create_accepts_an_explicit_zero_price(async_client, resolved_catalogue):
    """0 is a real, meaningful price (a free shipment), distinct from an
    absent one — same rule schemas/aito.py already documents for task costs.
    `price is None` is what `_validated_shipping` checks, never falsiness, so
    0 must not fall back to the catalogue rate."""
    body = (await _create(async_client, **SHIPPING, shipping_price=0)).json()
    assert body["shipping_price"] == 0.0


async def test_create_rejects_when_no_rate_is_known_and_no_price_is_given(async_client, monkeypatch):
    """The one error path that is about money: an unresolved catalogue must
    never let a shipment through at a silent 0."""

    async def empty(db, **kwargs):
        return {}

    monkeypatch.setattr(zoho_service, "get_shipping_catalogue", empty)
    response = await _create(async_client, **SHIPPING)
    assert response.status_code == 422
    assert "price" in response.json()["detail"].lower()


async def test_create_rejects_an_unknown_island(async_client, resolved_catalogue):
    response = await _create(async_client, **{**SHIPPING, "shipping_island": "atlantis"})
    assert response.status_code == 422


async def test_create_rejects_a_partial_shipment(async_client, resolved_catalogue):
    response = await _create(async_client, shipping_island="rangiroa", shipping_first_name="Jean-Pierre")
    assert response.status_code == 422
    assert "shipping" in response.json()["detail"].lower()


async def test_create_rejects_a_malformed_phone(async_client, resolved_catalogue):
    response = await _create(async_client, **{**SHIPPING, "shipping_phone": "12"})
    assert response.status_code == 422


async def test_create_without_shipping_leaves_every_field_null(async_client, resolved_catalogue):
    body = (await _create(async_client)).json()
    assert body["shipping_island"] is None
    assert body["shipping_service"] is None
    assert body["shipping_service_name"] is None


async def test_patch_attaches_shipping_and_requeues_the_quote(async_client, resolved_catalogue, db_session):
    """A freshly-created quote-less project is already 'pending' (create_project
    marks it unconditionally), so PATCHing it and asserting 'pending' back
    would pass whether or not the shipping write happens before the mark —
    or indeed whether the shipping write touches sync state at all. Forcing
    the project to 'idle' first makes this test observe the actual
    TRANSITION the shipping-only PATCH causes."""
    project_id = (await _create(async_client)).json()["id"]
    project = (await db_session.execute(select(AitoProject).where(AitoProject.id == project_id))).scalar_one()
    project.quote_sync_state = "idle"
    await db_session.commit()

    body = (await async_client.patch(f"/api/v1/aito/{project_id}", json=SHIPPING)).json()
    assert body["shipping_island"] == "rangiroa"
    assert body["quote_sync_state"] == "pending"


async def test_patch_clears_shipping_with_a_null_island(async_client, resolved_catalogue):
    project_id = (await _create(async_client, **SHIPPING)).json()["id"]
    body = (await async_client.patch(f"/api/v1/aito/{project_id}", json={"shipping_island": None})).json()
    for field in (
        "shipping_island",
        "shipping_service",
        "shipping_first_name",
        "shipping_last_name",
        "shipping_phone",
        "shipping_price",
    ):
        assert body[field] is None


async def test_patch_corrects_one_field_of_an_existing_shipment(async_client, resolved_catalogue):
    # The merged row is what has to be consistent, not the payload — so a lone
    # phone correction does not need the other three fields resent.
    project_id = (await _create(async_client, **SHIPPING)).json()["id"]
    body = (await async_client.patch(f"/api/v1/aito/{project_id}", json={"shipping_phone": "+689-40123456"})).json()
    assert body["shipping_phone"] == "+689-40123456"
    assert body["shipping_island"] == "rangiroa"
    assert body["shipping_last_name"] == "DUPONT"


async def test_patch_alone_cannot_leave_a_half_shipment(async_client, resolved_catalogue):
    project_id = (await _create(async_client, **SHIPPING)).json()["id"]
    response = await async_client.patch(f"/api/v1/aito/{project_id}", json={"shipping_first_name": ""})
    assert response.status_code == 422


async def test_patch_a_whitespace_only_island_is_rejected_not_detached(async_client, resolved_catalogue):
    """A blank string is a client bug, not the documented way to detach a
    shipment — that is a literal null. Without this check, a client that
    accidentally trims an island down to "" would silently drop the
    shipment instead of failing loudly."""
    project_id = (await _create(async_client, **SHIPPING)).json()["id"]
    response = await async_client.patch(f"/api/v1/aito/{project_id}", json={"shipping_island": "   "})
    assert response.status_code == 422


async def test_patch_changing_the_island_alone_keeps_the_stored_price(async_client, resolved_catalogue):
    """The price is frozen at attach time, not re-looked-up on every edit —
    so changing the island to a DIFFERENT service re-derives shipping_service
    but does NOT re-derive shipping_price. A caller (the frontend drawer)
    that changes a shipment's island without resending shipping_price ends up
    billing the new service at the old service's rate; this pins that
    behaviour explicitly rather than leaving it as an implicit side effect."""
    project_id = (await _create(async_client, **SHIPPING)).json()["id"]  # tuamotu, 3200.0
    body = (await async_client.patch(f"/api/v1/aito/{project_id}", json={"shipping_island": "mangareva"})).json()
    assert body["shipping_service"] == "gambier"
    assert body["shipping_price"] == 3200.0  # unchanged — still the Tuamotu rate


async def test_patch_ignores_a_client_supplied_service(async_client, resolved_catalogue):
    """The service is derived, never trusted — on PATCH just as on create."""
    project_id = (await _create(async_client, **SHIPPING)).json()["id"]
    body = (
        await async_client.patch(
            f"/api/v1/aito/{project_id}", json={"shipping_phone": "+689-40123456", "shipping_service": "gambier"}
        )
    ).json()
    assert body["shipping_service"] == "tuamotu"


async def test_patch_a_shipping_field_on_an_unshipped_project_does_not_half_create_one(
    async_client, resolved_catalogue
):
    """A single shipping field sent to a project with no shipment at all must
    not half-create one: with no island (neither supplied nor already
    stored), the merged row has nothing to validate against, so this stays
    the documented all-six-cleared outcome rather than a 422 or a
    partially-filled row."""
    project_id = (await _create(async_client)).json()["id"]  # no shipment
    body = (await async_client.patch(f"/api/v1/aito/{project_id}", json={"shipping_first_name": "Jean-Pierre"})).json()
    for field in (
        "shipping_island",
        "shipping_service",
        "shipping_first_name",
        "shipping_last_name",
        "shipping_phone",
        "shipping_price",
    ):
        assert body[field] is None


async def test_move_response_carries_the_shipping_service_name(async_client, resolved_catalogue):
    """_to_response requires shipping_names precisely so this cannot regress:
    the frontend writes the /move response straight into the board cache with
    setQueryData, replacing the row — an omitted map would silently blank a
    shipped card's service name on every drag."""
    shipped = (await _create(async_client, **SHIPPING)).json()
    await _create(async_client)  # a second project, so the move is a real reorder, not a no-op
    response = await async_client.patch(f"/api/v1/aito/{shipped['id']}/move", json={"column": "devis", "position": 0})
    assert response.status_code == 200
    assert response.json()["shipping_service_name"] == "Livraison Avion Tuamotu"


async def test_quote_status_response_carries_the_shipping_service_name(async_client, resolved_catalogue):
    """Same regression as the /move test, for the quote-status transition —
    the frontend writes this response's `project` straight into the board
    cache too."""
    project_id = (await _create(async_client, **SHIPPING)).json()["id"]
    response = await async_client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "sent"})
    assert response.status_code == 200
    assert response.json()["project"]["shipping_service_name"] == "Livraison Avion Tuamotu"


async def test_restore_response_carries_the_shipping_service_name(async_client, resolved_catalogue):
    """Same regression again, for the restore path."""
    project_id = (await _create(async_client, **SHIPPING)).json()["id"]
    await async_client.delete(f"/api/v1/aito/{project_id}")
    response = await async_client.post(f"/api/v1/aito/{project_id}/restore")
    assert response.status_code == 200
    assert response.json()["shipping_service_name"] == "Livraison Avion Tuamotu"
