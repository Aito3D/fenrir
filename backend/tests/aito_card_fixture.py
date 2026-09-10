"""The hand-made-card fixture shared by the Aito tests that need a finished
project: test_aito_tracking_delivery.py and test_aito_pickup_sms.py both
create a card through the public API and drive it to `accepted` through the
dedicated quote-status route, so it lands unlocked in `finish` with no tasks.

Kept as a standalone module (not a cross-import between the two test files)
so neither file becomes the other's "source" for a fixture that both use
purely incidentally — same reasoning as `aito_rules_fixture.py`.
"""

from httpx import AsyncClient


async def _create(client: AsyncClient, **overrides):
    payload = {
        "description": "Pièce en aluminium de 50mm pour Renault Clio",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "87 12 34 56",
    }
    payload.update(overrides)
    # None means "leave the field out" — the create schema validates present
    # fields, and a test that wants a phoneless client simply never sends one.
    payload = {k: v for k, v in payload.items() if v is not None}
    return await client.post("/api/v1/aito/", json=payload)


async def _create_finished(client: AsyncClient, **overrides):
    """A hand-made card accepted through the dedicated route, which lands it —
    with no tasks — unlocked in `finish`. Same helper as test_aito_contacted."""
    created = (await _create(client, **overrides)).json()
    accepted = await client.post(f"/api/v1/aito/{created['id']}/quote-status", json={"status": "accepted"})
    return accepted.json()["project"]
