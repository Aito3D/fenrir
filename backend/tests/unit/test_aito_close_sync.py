"""POST /aito/{id}/sync — the push the detail panel owes Books when it closes.

Every other write path wakes the worker through ``request_debounced_sync``,
whose window is FIXED: the first edit opens it and later edits do not push the
deadline out (see that function's own docstring). A task added through the
panel is POSTed empty and filled in afterwards, so that window routinely
expires mid-edit — the drain pushes a task with no priced service, which
``build_line_items`` emits no line for at all, and the card reads as "not in
the quote".

This route is the panel's answer: it is called once, after every write the
panel made has settled, and it wakes the worker IMMEDIATELY — cancelling any
standing edit window rather than queueing behind it, so the push carries the
finished task instead of a half-typed one.

Fixtures mirror test_aito_quote_e2e.py (wire assertions go through
``zoho_service.transport``, never a class-level monkeypatch).
"""

import json
from datetime import datetime, timezone

import httpx
import pytest
from sqlalchemy import select

from backend.app.api.routes.settings import set_setting
from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.services.aito_quote_sync import run_sync_once
from backend.app.services.zoho import zoho_service


@pytest.fixture(autouse=True)
def reset_zoho_service():
    zoho_service.invalidate_token()
    zoho_service.transport = None
    yield
    zoho_service.invalidate_token()
    zoho_service.transport = None


@pytest.fixture(autouse=True)
def fresh_wake_event():
    import asyncio

    from backend.app.services import aito_quote_sync

    aito_quote_sync._wake = asyncio.Event()
    aito_quote_sync._debounce_deadline = None
    yield
    aito_quote_sync._debounce_deadline = None


async def _create(client, **overrides):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "+689 87 00 00 01",
    }
    payload.update(overrides)
    return await client.post("/api/v1/aito/", json=payload)


async def _configure_zoho(db) -> None:
    for key, value in {
        "zoho_client_id": "1000.FAKE",
        "zoho_client_secret": "fake-secret",
        "zoho_refresh_token": "1000.fake.refresh",
        "zoho_organization_id": "999",
    }.items():
        await set_setting(db, key, value)
    await db.commit()


def zoho_handler(routes: dict[tuple[str, str], dict], seen: list | None = None):
    """(METHOD, path-suffix) -> JSON body; token auto-answered; anything
    unrouted 404s loudly (mirrors test_aito_quote_e2e.py)."""

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


def _estimate(**overrides) -> dict:
    body = {
        "estimate_id": "E1",
        "estimate_number": "DEV26-9100",
        "date": "2026-08-05",
        "status": "draft",
        "total": 27500,
        "last_modified_time": "2026-08-05T10:00:00-1000",
        "is_inclusive_tax": True,
    }
    body.update(overrides)
    return {"estimate": body}


async def _events_of_kind(db, project_id: int, kind: str) -> list[AitoEvent]:
    rows = await db.execute(select(AitoEvent).where(AitoEvent.project_id == project_id, AitoEvent.kind == kind))
    return list(rows.scalars().all())


# ---------------------------------------------------------------------------
# The route itself
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_closing_a_card_queues_it_for_a_push(async_client, db_session):
    """The panel's whole contract: after this call the card owes Books a push,
    whatever state it had settled into while the operator was still editing."""
    project_id = (await _create(async_client)).json()["id"]
    project = await db_session.get(AitoProject, project_id)
    project.quote_sync_state = "idle"
    await db_session.commit()

    response = await async_client.post(f"/api/v1/aito/{project_id}/sync")

    assert response.status_code == 200, response.text
    assert response.json()["quote_sync_state"] == "pending"
    await db_session.refresh(project)
    assert project.quote_sync_state == "pending"


@pytest.mark.asyncio
async def test_closing_a_card_cancels_a_standing_edit_window(async_client):
    """The reason this route exists rather than reusing the edit path's wake.

    `request_debounced_sync` opens a FIXED window — a task PATCH made while one
    is already open does not extend it, so the drain can fire mid-edit. Closing
    the panel means the edit is finished, so the window it opened is stale:
    this route must clear it and wake now, not queue behind a deadline set
    before the operator had typed anything.
    """
    from backend.app.services import aito_quote_sync

    project_id = (await _create(async_client)).json()["id"]
    task = await async_client.post(f"/api/v1/aito/{project_id}/tasks", json={"scan_cost": 1000})
    assert task.status_code == 201, task.text

    # An ordinary edit leaves a window standing — the state this route inherits.
    assert aito_quote_sync._debounce_deadline is not None
    aito_quote_sync._wake.clear()

    assert (await async_client.post(f"/api/v1/aito/{project_id}/sync")).status_code == 200

    assert aito_quote_sync._debounce_deadline is None
    assert aito_quote_sync._wake.is_set()


@pytest.mark.asyncio
async def test_closing_an_unmanaged_card_never_queues_it(async_client, db_session):
    """'unmanaged' is the one state meaning this feature must never touch the
    quote (see `_mark_pending_if_ours`). A panel close is no more entitled to
    override that than any other edit — and with nothing queued, there is
    nothing to wake for either."""
    from backend.app.services import aito_quote_sync

    project_id = (await _create(async_client, quote_id="E9", quote_number="DEV26-9")).json()["id"]
    project = await db_session.get(AitoProject, project_id)
    project.quote_sync_state = "unmanaged"
    await db_session.commit()

    aito_quote_sync._wake.clear()
    aito_quote_sync._debounce_deadline = None
    response = await async_client.post(f"/api/v1/aito/{project_id}/sync")

    assert response.status_code == 200, response.text
    await db_session.refresh(project)
    assert project.quote_sync_state == "unmanaged"
    assert not aito_quote_sync._wake.is_set()


@pytest.mark.asyncio
async def test_closing_a_card_records_sync_queued_only_on_the_transition(async_client, db_session):
    """Same rule the task endpoints already follow: `_mark_pending_if_ours` is
    idempotent, so recording off the post-call state alone would put a
    `sync.queued` row on the timeline every time a panel closed, whether or not
    anything was actually owed."""
    project_id = (await _create(async_client)).json()["id"]
    project = await db_session.get(AitoProject, project_id)
    project.quote_sync_state = "idle"
    await db_session.commit()
    before = len(await _events_of_kind(db_session, project_id, "sync.queued"))

    assert (await async_client.post(f"/api/v1/aito/{project_id}/sync")).status_code == 200
    assert (await async_client.post(f"/api/v1/aito/{project_id}/sync")).status_code == 200

    after = await _events_of_kind(db_session, project_id, "sync.queued")
    assert len(after) - before == 1


@pytest.mark.asyncio
async def test_closing_a_trashed_or_missing_card_is_a_404(async_client):
    """Matches every other project-scoped route: the panel cannot be open on a
    card that is not on the board."""
    project_id = (await _create(async_client)).json()["id"]
    assert (await async_client.delete(f"/api/v1/aito/{project_id}")).status_code == 204

    assert (await async_client.post(f"/api/v1/aito/{project_id}/sync")).status_code == 404
    assert (await async_client.post("/api/v1/aito/999999/sync")).status_code == 404


# ---------------------------------------------------------------------------
# End to end: the task the operator added actually reaches Books
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_task_added_in_the_panel_reaches_the_quote_after_the_card_closes(async_client, db_session):
    """The reported bug, end to end.

    The panel POSTs a task the instant "+ Add task" is clicked — empty, no
    priced service — and the title and cost arrive as later PATCHes. The drain
    that fires in that gap pushes a quote with no line for the task at all
    (asserted below), and settles the card to 'idle' as though it were in sync.

    What makes that stick is the fixed edit window: the PATCH that finally
    carries the real content re-queues the project but does NOT reopen the
    window it is already inside, so the push it earns waits out the full
    300s poll. This test pins that — `_debounce_delay()` is still counting
    down after the PATCH — and then pins the fix: closing the card clears the
    window, and the very next drain carries the finished task.

    `db_session.rollback()` before each drain is test plumbing, not a
    behaviour: the worker owns its own session in production, while here it
    shares the test's, whose open read snapshot would otherwise predate the
    routes' commits and select nothing.
    """
    from backend.app.services.aito_quote_sync import _debounce_delay

    await _configure_zoho(db_session)
    # One priced task up front: `_create_quote` refuses to POST a quote with no
    # priced service at all, and this test is about the SECOND task.
    project_id = (await _create(async_client, tasks=[{"title": "Moyeu", "scan_cost": 3500}])).json()["id"]

    # First push: the quote is created, and the project settles to 'idle'.
    zoho_service.transport = httpx.MockTransport(
        zoho_handler({("GET", "/estimates"): {"estimates": []}, ("POST", "/estimates"): _estimate()})
    )
    assert await run_sync_once(db_session) == 1
    project = await db_session.get(AitoProject, project_id)
    await db_session.refresh(project)
    assert project.quote_sync_state == "idle"

    # "+ Add task": the row is POSTed empty, and the window opens here.
    task_id = (await async_client.post(f"/api/v1/aito/{project_id}/tasks", json={})).json()["id"]
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler({("GET", "/estimates/E1"): _estimate(), ("PUT", "/estimates/E1"): _estimate()}, seen)
    )
    await db_session.rollback()
    assert await run_sync_once(db_session, pending_only=True) == 1

    # The bug: that push carried no line for the task the operator just added,
    # and left the card reading as in sync.
    mid_edit = next(entry for entry in seen if entry[0] == "PUT")
    assert [line.get("header_name") for line in mid_edit[2]["line_items"]] == ["Moyeu"]
    await db_session.refresh(project)
    assert project.quote_sync_state == "idle"

    # The operator finishes typing. This re-queues the card but does NOT
    # reopen the window it is already inside, so the worker is still counting
    # down to a deadline set before any of this content existed.
    await async_client.patch(
        f"/api/v1/aito/tasks/{task_id}",
        json={"title": "Bague de serrage", "usinage_cost": 6000},
    )
    assert _debounce_delay() > 0

    # The card closes: the stale window goes, and the worker drains now.
    assert (await async_client.post(f"/api/v1/aito/{project_id}/sync")).status_code == 200
    assert _debounce_delay() == 0
    seen.clear()
    await db_session.rollback()
    assert await run_sync_once(db_session, pending_only=True) == 1

    put = next(entry for entry in seen if entry[0] == "PUT")
    assert put[2]["line_items"] == [
        {
            "item_id": "66407000006501192",
            "tax_id": "66407000009281008",
            "unit": "Projet",
            "rate": 3500,
            "quantity": 1,
            "description": "*Fichier non cédé*",
            "header_name": "Moyeu",
            "item_order": 1,
        },
        {
            "item_id": "66407000006884825",
            "tax_id": "66407000009281008",
            "unit": "Projet",
            "rate": 6000,
            "quantity": 1,
            "description": "",
            "header_name": "Bague de serrage",
            "item_order": 2,
        },
    ]
