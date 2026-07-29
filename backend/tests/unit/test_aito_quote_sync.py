"""The Aito -> Zoho outbox worker, driven through zoho_service's MockTransport
seam. No network, no real Books org."""

import json

import httpx
import pytest

from backend.app.api.routes.settings import set_setting
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.services.aito_quote_sync import run_sync_once
from backend.app.services.zoho import zoho_service


@pytest.fixture(autouse=True)
def reset_zoho_service():
    """Undo the MockTransport + cached token each test installs on the module
    singleton, so no state leaks into unrelated tests (mirrors the reset
    fixture in test_zoho_service.py)."""
    zoho_service.invalidate_token()
    zoho_service.transport = None
    yield
    zoho_service.invalidate_token()
    zoho_service.transport = None


async def _configure_zoho(db) -> None:
    """Seed the settings the sync worker needs to consider Zoho configured.

    Mirrors ``_configure`` in test_zoho_service.py, but writes straight to the
    settings table via ``db_session`` rather than through the HTTP API, since
    this module has no ``async_client`` dependency to spare.
    """
    for key, value in {
        "zoho_client_id": "1000.FAKE",
        "zoho_client_secret": "fake-secret",
        "zoho_refresh_token": "1000.fake.refresh",
        "zoho_organization_id": "999",
    }.items():
        await set_setting(db, key, value)
    await db.commit()


def zoho_handler(routes: dict[tuple[str, str], dict], seen: list | None = None):
    """Map (METHOD, path-suffix) -> JSON body. Token requests are auto-answered."""

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        if seen is not None:
            seen.append((request.method, request.url.path, json.loads(request.content) if request.content else None))
        for (method, suffix), body in routes.items():
            if request.method == method and request.url.path.endswith(suffix):
                return httpx.Response(200, json=body)
        return httpx.Response(404, json={"message": "no route"})

    return handler


@pytest.mark.asyncio
async def test_pending_project_without_a_quote_gets_one_created(db_session):
    project = AitoProject(
        description="Helice",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client de passage",
        quote_sync_state="pending",
    )
    db_session.add(project)
    await db_session.flush()
    db_session.add(AitoTask(project_id=project.id, position=0, title="Helice grise", scan_cost=5000))
    await db_session.commit()
    await _configure_zoho(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("POST", "/estimates"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "estimate_number": "DEV26-9001",
                        "date": "2026-07-29",
                        "status": "draft",
                        "total": 5000,
                        "last_modified_time": "2026-07-29T10:00:00-1000",
                    }
                }
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_id == "E1"
    assert project.quote_number == "DEV26-9001"
    assert project.quote_status == "draft"
    assert project.quote_synced_at == "2026-07-29T10:00:00-1000"
    assert project.quote_sync_state == "idle"
    assert project.quote_url.startswith("https://books.")

    post = next(entry for entry in seen if entry[0] == "POST")
    assert post[2]["customer_id"] == "C1"
    assert post[2]["reference_number"] == f"AITO-{project.id}"
    assert post[2]["is_inclusive_tax"] is True
    assert len(post[2]["line_items"]) == 1


@pytest.mark.asyncio
async def test_idle_project_is_never_touched(db_session):
    """An old quote-less card. The migration default excludes it from sync."""
    db_session.add(AitoProject(description="Vieux", board_column="devis", position=0, quote_sync_state="idle"))
    await db_session.commit()
    zoho_service.transport = httpx.MockTransport(zoho_handler({}))
    assert await run_sync_once(db_session) == 0


@pytest.mark.asyncio
async def test_one_bad_project_does_not_roll_back_a_good_ones_write(db_session, monkeypatch):
    """Regression guard for the duplicate-quote bug: an unexpected exception in
    one project must not discard another project's already-successful write.

    Pre-fix, ``run_sync_once`` committed once after the whole batch, so the
    good project's in-memory ``quote_id`` was lost when the bad project's
    exception unwound the loop before ``db.commit()`` — and the next tick
    would POST a second, duplicate estimate for the good project.
    """
    good = AitoProject(
        description="Bonne piece",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client OK",
        quote_sync_state="pending",
    )
    bad = AitoProject(
        description="Piece cassee",
        board_column="devis",
        position=1,
        client_id="C2",
        client_name="Client KO",
        quote_sync_state="pending",
    )
    db_session.add_all([good, bad])
    await db_session.flush()
    db_session.add(AitoTask(project_id=good.id, position=0, title="Good", scan_cost=5000))
    db_session.add(AitoTask(project_id=bad.id, position=0, title="Bad", scan_cost=5000))
    await db_session.commit()
    await _configure_zoho(db_session)

    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("POST", "/estimates"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "estimate_number": "DEV26-9001",
                        "date": "2026-07-29",
                        "status": "draft",
                        "total": 5000,
                        "last_modified_time": "2026-07-29T10:00:00-1000",
                    }
                }
            }
        )
    )
    zoho_service.invalidate_token()

    # Simulate an unexpected, non-Zoho bug (a plain TypeError) in the export
    # step, but only for the "bad" project's task, so "good" still syncs
    # cleanly through the real code path first.
    from backend.app.services import aito_quote_sync

    original_build_line_items = aito_quote_sync.build_line_items

    def flaky_build_line_items(tasks, existing_line_items, catalogue):
        if any(t.title == "Bad" for t in tasks):
            raise TypeError("simulated bug in export")
        return original_build_line_items(tasks, existing_line_items, catalogue)

    monkeypatch.setattr(aito_quote_sync, "build_line_items", flaky_build_line_items)

    assert await run_sync_once(db_session) == 2

    await db_session.refresh(good)
    await db_session.refresh(bad)
    assert good.quote_id == "E1"
    assert good.quote_sync_state == "idle"
    assert bad.quote_sync_state == "error"
    assert bad.quote_id is None
    assert "simulated bug" in (bad.quote_sync_error or "")


@pytest.mark.asyncio
async def test_zoho_not_configured_leaves_project_pending(db_session):
    """No credentials entered yet: stay pending, not a failure."""
    project = AitoProject(
        description="Sans creds",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_sync_state="pending",
    )
    db_session.add(project)
    await db_session.flush()
    db_session.add(AitoTask(project_id=project.id, position=0, title="Task", scan_cost=5000))
    await db_session.commit()
    # Deliberately not calling _configure_zoho: settings table has no Zoho keys.

    zoho_service.transport = httpx.MockTransport(zoho_handler({}))
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "pending"
    assert project.quote_id is None
    assert project.quote_sync_error is None


@pytest.mark.asyncio
async def test_zoho_request_rejected_goes_straight_to_error(db_session):
    """Books rejects the payload (HTTP 400): not retried, message recorded."""
    project = AitoProject(
        description="Payload invalide",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_sync_state="pending",
    )
    db_session.add(project)
    await db_session.flush()
    db_session.add(AitoTask(project_id=project.id, position=0, title="Task", scan_cost=5000))
    await db_session.commit()
    await _configure_zoho(db_session)

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        if request.method == "POST" and request.url.path.endswith("/estimates"):
            return httpx.Response(400, json={"message": "Invalid customer_id"})
        return httpx.Response(404, json={"message": "no route"})

    zoho_service.transport = httpx.MockTransport(handler)
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "error"
    assert project.quote_sync_error == "Invalid customer_id"
    assert project.quote_sync_failures == 0
    assert project.quote_id is None
