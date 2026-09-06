"""The tracking link rides on the pickup SMS draft and the Zoho estimate notes."""

import pytest

from backend.app.api.routes.settings import set_setting
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.settings import Settings
from backend.app.services.aito_quote_sync import _create_quote, _update_quote
from backend.app.services.zoho import zoho_service


async def _set_external_url(db_session, value: str):
    db_session.add(Settings(key="external_url", value=value))
    await db_session.commit()


async def _configure_zoho(db) -> None:
    """Same helper as test_aito_quote_sync.py's ``_configure_zoho``: books_app_url
    (called unconditionally on both the create and update paths) needs
    ``_load_config`` to succeed even though the fakes below never touch the
    network themselves."""
    for key, value in {
        "zoho_client_id": "1000.FAKE",
        "zoho_client_secret": "fake-secret",
        "zoho_refresh_token": "1000.fake.refresh",
        "zoho_organization_id": "999",
    }.items():
        await set_setting(db, key, value)
    await db.commit()


# ------------------------------------------------------------- pickup SMS
# Same helpers as test_aito_pickup_sms.py: a hand-made card accepted through
# the dedicated route lands, with no tasks, unlocked in `finish`, and the
# route's own `pickup_message` import is what monkeypatch must target.


async def _create(client, **overrides):
    payload = {
        "description": "Pièce en aluminium de 50mm pour Renault Clio",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "87 12 34 56",
    }
    payload.update(overrides)
    payload = {k: v for k, v in payload.items() if v is not None}
    return await client.post("/api/v1/aito/", json=payload)


async def _create_finished(client, **overrides):
    created = (await _create(client, **overrides)).json()
    accepted = await client.post(f"/api/v1/aito/{created['id']}/quote-status", json={"status": "accepted"})
    return accepted.json()["project"]


def _patch_pickup_message(monkeypatch, fake):
    from backend.app.api.routes import aito as aito_routes

    monkeypatch.setattr(aito_routes, "pickup_message", fake)


@pytest.mark.asyncio
async def test_pickup_draft_ends_with_the_link_when_configured(async_client, db_session, monkeypatch):
    project = await _create_finished(async_client)

    async def fake(db, description, client_name=None, parts=None):
        return "Bonjour, c'est prêt.", "model"

    _patch_pickup_message(monkeypatch, fake)
    await _set_external_url(db_session, "https://aito.example")

    body = (await async_client.post(f"/api/v1/aito/{project['id']}/pickup-message")).json()
    assert body["message"].startswith("Bonjour, c'est prêt.")
    assert "\n\nSuivi : https://aito.example/track/" in body["message"]
    # The draft request committed the minted token: the public link works.
    token = body["message"].rsplit("/", 1)[1]
    assert (await async_client.get(f"/api/v1/aito/track/{token}")).status_code == 200


@pytest.mark.asyncio
async def test_pickup_draft_is_untouched_without_external_url(async_client, db_session, monkeypatch):
    project = await _create_finished(async_client)

    async def fake(db, description, client_name=None, parts=None):
        return "Bonjour, c'est prêt.", "model"

    _patch_pickup_message(monkeypatch, fake)

    body = (await async_client.post(f"/api/v1/aito/{project['id']}/pickup-message")).json()
    assert body["message"] == "Bonjour, c'est prêt."


# --------------------------------------------------------- Zoho estimate sync
# Same shape as test_aito_quote_sync.py: an AitoProject + priced AitoTask
# driven straight through the create/update helpers, with zoho_service's
# network-touching methods patched on the INSTANCE (never the class).


async def _pending_project(db) -> AitoProject:
    project = AitoProject(
        description="Helice",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client de passage",
        quote_sync_state="pending",
    )
    db.add(project)
    await db.flush()
    db.add(AitoTask(project_id=project.id, position=0, title="Helice grise", scan_cost=5000))
    await db.commit()
    return project


@pytest.mark.asyncio
async def test_create_estimate_carries_notes_only_when_configured(db_session, monkeypatch):
    project = await _pending_project(db_session)
    await _configure_zoho(db_session)

    async def fake_find_estimate_by_reference(db, reference_number, customer_id):
        return None

    captured_payload = {}

    async def fake_create_estimate(db, payload):
        captured_payload.update(payload)
        return {
            "estimate_id": "E1",
            "estimate_number": "DEV26-9001",
            "date": "2026-07-29",
            "status": "draft",
            "total": 5000,
            "last_modified_time": "2026-07-29T10:00:00-1000",
            "is_inclusive_tax": True,
        }

    monkeypatch.setattr(zoho_service, "find_estimate_by_reference", fake_find_estimate_by_reference)
    monkeypatch.setattr(zoho_service, "create_estimate", fake_create_estimate)

    await _create_quote(db_session, project)
    assert "notes" not in captured_payload

    captured_payload.clear()
    project.quote_id = None
    project.quote_sync_state = "pending"
    await db_session.commit()
    await _set_external_url(db_session, "https://aito.example")

    await _create_quote(db_session, project)
    assert captured_payload["notes"].startswith("Suivez votre commande : https://aito.example/track/")


@pytest.mark.asyncio
async def test_update_estimate_lines_passes_notes_through(db_session, monkeypatch):
    project = await _pending_project(db_session)
    project.quote_id = "E1"
    await db_session.commit()

    async def fake_get_estimate(db, estimate_id):
        return {
            "estimate_id": "E1",
            "status": "sent",
            "is_transaction_created": False,
            "invoiced_amount": 0,
            "is_inclusive_tax": True,
            "line_items": [],
        }

    captured_kwargs = {}

    async def fake_update_estimate_lines(db, estimate_id, line_items, notes=None):
        captured_kwargs["notes"] = notes
        return {
            "estimate_id": "E1",
            "estimate_number": "DEV26-9001",
            "status": "sent",
            "total": 5000,
            "last_modified_time": "2026-07-29T11:00:00-1000",
        }

    monkeypatch.setattr(zoho_service, "get_estimate", fake_get_estimate)
    monkeypatch.setattr(zoho_service, "update_estimate_lines", fake_update_estimate_lines)

    await _update_quote(db_session, project)
    assert captured_kwargs.get("notes") is None

    project.quote_sync_state = "pending"
    await db_session.commit()
    await _set_external_url(db_session, "https://aito.example")

    await _update_quote(db_session, project)
    assert captured_kwargs["notes"].startswith("Suivez votre commande : https://aito.example/track/")


@pytest.mark.asyncio
async def test_update_estimate_lines_body_includes_notes_only_when_given(db_session, monkeypatch):
    seen = {}

    async def fake_request(db, method, path, **kwargs):
        seen.update(kwargs)
        return {"estimate": {}}

    monkeypatch.setattr(zoho_service, "_request", fake_request)
    await zoho_service.update_estimate_lines(db_session, "E1", [{"x": 1}])
    assert seen["json"] == {"line_items": [{"x": 1}]}
    await zoho_service.update_estimate_lines(db_session, "E1", [{"x": 1}], notes="Suivez votre commande : u")
    assert seen["json"] == {"line_items": [{"x": 1}], "notes": "Suivez votre commande : u"}
