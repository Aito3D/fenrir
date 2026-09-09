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
    assert "\n\nSuivi : https://aito.example/t/" in body["message"]
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
    notes_written = []

    async def fake_create_estimate(db, payload):
        captured_payload.update(payload)
        # Books fills the notes from the org default when the payload has none.
        return {
            "estimate_id": "E1",
            "estimate_number": "DEV26-9001",
            "date": "2026-07-29",
            "status": "draft",
            "total": 5000,
            "last_modified_time": "2026-07-29T10:00:00-1000",
            "is_inclusive_tax": True,
            "notes": "Signature du client (précédée de la mention « Bon pour accord ») ",
        }

    async def fake_update_estimate_notes(db, estimate_id, notes):
        notes_written.append((estimate_id, notes))
        return {}

    monkeypatch.setattr(zoho_service, "find_estimate_by_reference", fake_find_estimate_by_reference)
    monkeypatch.setattr(zoho_service, "create_estimate", fake_create_estimate)
    monkeypatch.setattr(zoho_service, "update_estimate_notes", fake_update_estimate_notes)

    await _create_quote(db_session, project)
    assert "notes" not in captured_payload
    assert notes_written == []

    captured_payload.clear()
    project.quote_id = None
    project.quote_sync_state = "pending"
    await db_session.commit()
    await _set_external_url(db_session, "https://aito.example")

    await _create_quote(db_session, project)
    # Never in the create payload — that would replace Books' default; the
    # block goes UNDER the default in a second, notes-only call.
    assert "notes" not in captured_payload
    assert len(notes_written) == 1
    estimate_id, notes = notes_written[0]
    assert estimate_id == "E1"
    default, blank, link, code_line = notes.split("\n")
    assert default == "Signature du client (précédée de la mention « Bon pour accord »)"
    assert blank == ""
    assert link.startswith("Lien de suivi de votre projet : https://aito.example/t/")
    # The code on its own line, for the client who reads the PDF on paper.
    assert code_line == f"Code de suivi : {link.rsplit('/', 1)[1]}"
    assert len(code_line.split(": ")[1]) == 6


@pytest.mark.asyncio
async def test_create_survives_a_failed_notes_write(db_session, monkeypatch):
    # The estimate exists the moment create returns; a notes failure after
    # it must not turn the create into an error (and a retried create).
    project = await _pending_project(db_session)
    await _configure_zoho(db_session)
    await _set_external_url(db_session, "https://aito.example")

    async def fake_find_estimate_by_reference(db, reference_number, customer_id):
        return None

    async def fake_create_estimate(db, payload):
        return {"estimate_id": "E1", "estimate_number": "DEV26-9001", "status": "draft", "total": 5000, "notes": "x"}

    async def failing_update_estimate_notes(db, estimate_id, notes):
        raise RuntimeError("Books is away")

    monkeypatch.setattr(zoho_service, "find_estimate_by_reference", fake_find_estimate_by_reference)
    monkeypatch.setattr(zoho_service, "create_estimate", fake_create_estimate)
    monkeypatch.setattr(zoho_service, "update_estimate_notes", failing_update_estimate_notes)

    await _create_quote(db_session, project)
    assert project.quote_id == "E1"


@pytest.mark.asyncio
async def test_update_estimate_lines_passes_notes_through(db_session, monkeypatch):
    project = await _pending_project(db_session)
    project.quote_id = "E1"
    await db_session.commit()

    # What Books holds: the default line, an operator's own remark, and the
    # block this app wrote under its OLD wording for a link since replaced.
    remote_notes = (
        "Signature du client (précédée de la mention « Bon pour accord ») "
        + "\nRemise fidélité incluse.\n\nSuivez votre commande : https://aito.example/t/OLDTOKEN\nCode de suivi : OLDTOKEN"
    )

    async def fake_get_estimate(db, estimate_id):
        return {
            "estimate_id": "E1",
            "status": "sent",
            "is_transaction_created": False,
            "invoiced_amount": 0,
            "is_inclusive_tax": True,
            "line_items": [],
            "notes": remote_notes,
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
    notes = captured_kwargs["notes"]
    # Books' default (verbatim, trailing space and all) and the operator's
    # remark survive; the old block is gone; the current one sits under a
    # blank line.
    assert notes.startswith(
        "Signature du client (précédée de la mention « Bon pour accord ») "
        + "\nRemise fidélité incluse.\n\nLien de suivi de votre projet : https://aito.example/t/"
    )
    assert "OLDTOKEN" not in notes and "Suivez votre commande" not in notes
    assert notes.count("Code de suivi : ") == 1

    # Synced again with nothing changed, the notes are left alone entirely.
    remote_notes = notes
    project.quote_sync_state = "pending"
    await db_session.commit()

    async def fake_get_estimate_settled(db, estimate_id):
        return {
            "estimate_id": "E1",
            "status": "sent",
            "is_transaction_created": False,
            "invoiced_amount": 0,
            "is_inclusive_tax": True,
            "line_items": [],
            "notes": remote_notes,
        }

    monkeypatch.setattr(zoho_service, "get_estimate", fake_get_estimate_settled)
    captured_kwargs.clear()
    await _update_quote(db_session, project)
    assert captured_kwargs.get("notes") is None


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


def test_tracking_notes_adds_the_code_line_only_for_a_short_code():
    from backend.app.services.aito_tracking import tracking_notes

    assert tracking_notes("https://x.pf/t/V9HV2M", "V9HV2M") == (
        "Lien de suivi de votre projet : https://x.pf/t/V9HV2M\nCode de suivi : V9HV2M"
    )
    legacy = "lQ38LSKdM7M9yUTn-7dvl_03NqAXCZP1hlqvpvMNKT4"
    assert (
        tracking_notes(f"https://x.pf/t/{legacy}", legacy) == f"Lien de suivi de votre projet : https://x.pf/t/{legacy}"
    )


def test_with_tracking_notes_keeps_books_text_and_is_idempotent():
    from backend.app.services.aito_tracking import with_tracking_notes

    block = "Lien de suivi de votre projet : https://x.pf/t/V9HV2M\nCode de suivi : V9HV2M"
    assert with_tracking_notes(None, "https://x.pf/t/V9HV2M", "V9HV2M") == block
    assert with_tracking_notes("", "https://x.pf/t/V9HV2M", "V9HV2M") == block
    once = with_tracking_notes("Signature du client ", "https://x.pf/t/V9HV2M", "V9HV2M")
    assert once == "Signature du client\n\n" + block
    assert with_tracking_notes(once, "https://x.pf/t/V9HV2M", "V9HV2M") == once
    # A regenerated link replaces the block rather than stacking a second one.
    again = with_tracking_notes(once, "https://x.pf/t/NEW123", "NEW123")
    assert (
        again == "Signature du client\n\nLien de suivi de votre projet : https://x.pf/t/NEW123\nCode de suivi : NEW123"
    )


@pytest.mark.asyncio
async def test_update_estimate_notes_sends_notes_only(db_session, monkeypatch):
    seen = {}

    async def fake_request(db, method, path, **kwargs):
        seen.update(method=method, path=path, **kwargs)
        return {"estimate": {"estimate_id": "E1"}}

    monkeypatch.setattr(zoho_service, "_request", fake_request)
    await zoho_service.update_estimate_notes(db_session, "E1", "Signature\n\nLien de suivi de votre projet : u")
    assert seen["method"] == "PUT" and seen["path"] == "/estimates/E1"
    assert seen["json"] == {"notes": "Signature\n\nLien de suivi de votre projet : u"}
