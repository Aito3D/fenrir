"""The Finish step on a job that SHIPS.

`client_contacted_at` is one stamp with two meanings: on a pickup job it says
the client was told to come and collect; on a job with a shipment it says the
parcel was handed over. The Done gate reads it the same way either side, but
the timeline and the refusal must name the step that was actually owed — a
parcel, not a phone call — and switching a finished card between the two
modes must retract a stamp that now records the wrong step as done.
"""

import pytest
from sqlalchemy import select

from backend.app.models.aito_event import AitoEvent
from backend.app.services.aito_events import KINDS, contact_mark_kind
from backend.app.services.zoho import zoho_service

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

    # Instance-level, like test_aito_shipping_routes.py — a class-level patch
    # is shadowed by the instance attribute an earlier file leaves behind.
    monkeypatch.setattr(zoho_service, "get_shipping_catalogue", fake)


async def _create_finished(client, **overrides):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "+689-87123456",
    }
    payload.update(overrides)
    created = (await client.post("/api/v1/aito/", json=payload)).json()
    accepted = await client.post(f"/api/v1/aito/{created['id']}/quote-status", json={"status": "accepted"})
    return accepted.json()["project"]


async def _events(db_session, project_id: int) -> list[AitoEvent]:
    rows = await db_session.execute(select(AitoEvent).where(AitoEvent.project_id == project_id).order_by(AitoEvent.id))
    return list(rows.scalars().all())


def test_the_kind_helper_names_the_step_that_was_owed():
    assert contact_mark_kind(False) == "project.contacted.set"
    assert contact_mark_kind(False, cleared=True) == "project.contacted.cleared"
    assert contact_mark_kind(True) == "project.shipped.set"
    assert contact_mark_kind(True, cleared=True) == "project.shipped.cleared"


def test_the_shipped_pair_is_registered_as_story():
    # Same depth as the contacted pair: "who sent it, and when" is the
    # question asked when a client says the parcel never arrived.
    assert KINDS["project.shipped.set"] == "story"
    assert KINDS["project.shipped.cleared"] == "story"


@pytest.mark.asyncio
async def test_marking_a_shipping_job_records_a_shipped_event_not_a_contact(
    async_client, db_session, resolved_catalogue
):
    p = await _create_finished(async_client, **SHIPPING)

    r = await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})

    assert r.status_code == 200
    assert r.json()["client_contacted_at"] is not None
    kinds = [e.kind for e in await _events(db_session, p["id"])]
    assert "project.shipped.set" in kinds
    assert "project.contacted.set" not in kinds


@pytest.mark.asyncio
async def test_taking_a_shipped_mark_back_records_the_shipped_kind(async_client, db_session, resolved_catalogue):
    p = await _create_finished(async_client, **SHIPPING)
    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})

    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": False})

    kinds = [e.kind for e in await _events(db_session, p["id"])]
    assert "project.shipped.cleared" in kinds
    assert "project.contacted.cleared" not in kinds


@pytest.mark.asyncio
async def test_a_pickup_job_still_records_the_contacted_kind(async_client, db_session):
    p = await _create_finished(async_client)

    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})

    kinds = [e.kind for e in await _events(db_session, p["id"])]
    assert "project.contacted.set" in kinds
    assert "project.shipped.set" not in kinds


@pytest.mark.asyncio
async def test_the_shipped_mark_opens_the_done_gate(async_client, resolved_catalogue):
    p = await _create_finished(async_client, **SHIPPING)
    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})

    r = await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "done", "position": 0})

    assert r.status_code == 200


@pytest.mark.asyncio
async def test_archiving_an_unsent_parcel_is_refused_in_shipping_terms(async_client, resolved_catalogue):
    """The refusal is what an API-key caller sees; "tell the client" about a
    parcel nobody has posted would send them looking for the wrong step."""
    p = await _create_finished(async_client, **SHIPPING)

    r = await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "done", "position": 0})

    assert r.status_code == 409
    assert "parcel" in r.json()["detail"].lower()
    assert "tell the client" not in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_the_pickup_refusal_is_unchanged(async_client):
    p = await _create_finished(async_client)

    r = await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "done", "position": 0})

    assert r.status_code == 409
    assert "tell the client" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_work_reappearing_retracts_a_shipped_mark_under_its_own_kind(
    async_client, db_session, resolved_catalogue
):
    p = await _create_finished(async_client, **SHIPPING)
    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})

    await async_client.post(f"/api/v1/aito/{p['id']}/tasks", json={"impression_cost": 2400.0})

    cleared = [e for e in await _events(db_session, p["id"]) if e.kind == "project.shipped.cleared"]
    assert cleared and (cleared[-1].detail or {}).get("cause") == "rule"
    assert not [e for e in await _events(db_session, p["id"]) if e.kind == "project.contacted.cleared"]


@pytest.mark.asyncio
async def test_detaching_the_shipment_retracts_a_shipped_mark(async_client, db_session, resolved_catalogue):
    """A card marked "parcel sent" that becomes a pickup job owes a phone
    call it has not made: the stamp must not carry over and open Done."""
    p = await _create_finished(async_client, **SHIPPING)
    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})

    r = await async_client.patch(f"/api/v1/aito/{p['id']}", json={"shipping_island": None})

    assert r.status_code == 200
    assert r.json()["client_contacted_at"] is None
    cleared = [e for e in await _events(db_session, p["id"]) if e.kind == "project.shipped.cleared"]
    assert cleared and (cleared[-1].detail or {}).get("cause") == "shipping"
    move = await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "done", "position": 0})
    assert move.status_code == 409


@pytest.mark.asyncio
async def test_attaching_a_shipment_retracts_a_contacted_mark(async_client, db_session, resolved_catalogue):
    """The other direction: a client told to collect is not a parcel sent."""
    p = await _create_finished(async_client)
    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})

    r = await async_client.patch(f"/api/v1/aito/{p['id']}", json=SHIPPING)

    assert r.status_code == 200
    assert r.json()["client_contacted_at"] is None
    cleared = [e for e in await _events(db_session, p["id"]) if e.kind == "project.contacted.cleared"]
    assert cleared and (cleared[-1].detail or {}).get("cause") == "shipping"


@pytest.mark.asyncio
async def test_editing_a_shipment_in_place_keeps_the_shipped_mark(async_client, db_session, resolved_catalogue):
    """Only a change of MODE retracts: correcting the recipient's name on a
    parcel already sent is a typo fix, not a new parcel."""
    p = await _create_finished(async_client, **SHIPPING)
    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})

    r = await async_client.patch(f"/api/v1/aito/{p['id']}", json={"shipping_last_name": "DURAND"})

    assert r.status_code == 200
    assert r.json()["client_contacted_at"] is not None
    assert not [e for e in await _events(db_session, p["id"]) if e.kind.endswith(".cleared")]
