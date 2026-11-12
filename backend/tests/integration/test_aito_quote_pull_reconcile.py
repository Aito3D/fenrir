"""Phase 2, the pull: a reconcile that finds the Books quote's lines edited
takes the edit onto the card's tasks (aito_quote_sync._pull_lines). Books is
a stub; nothing here talks to Zoho.

One test per hard requirement: local edits win, locked cards are never
touched, only exact mappings are applied (the rest is flagged, once), a pull
queues no push, it is recorded as coming from Books, and foreign lines are
left alone."""

import json

import httpx
import pytest
from sqlalchemy import select, update

from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.services import aito_quote_sync
from backend.app.services.aito_quote_sync import run_sync_once
from backend.app.services.zoho import zoho_service
from backend.tests.unit.test_aito_quote_export import task
from backend.tests.unit.test_aito_quote_pull import books, line
from backend.tests.unit.test_aito_quote_sync import (  # noqa: F401 — fixtures register by name
    _configure_zoho,
    fresh_wake_event,
    reset_deferred_reasons,
    reset_requeue_marker,
    reset_zoho_service,
    stub_inbox_sweep,
)

pytestmark = pytest.mark.asyncio

PUSHED_AT = "2026-11-12T08:00:00-1000"
EDITED_AT = "2026-11-12T09:30:00-1000"
CARD = [
    task(title="Helice", scan_cost=5000, impression_cost=2400, impression_quantity=3),
    task(title="Socle", usinage_cost=8000, usinage_quantity=2),
]


async def _card(db, **fields) -> AitoProject:
    """A quoted card with nothing left to push, as the last push left it."""
    project = AitoProject(
        description="Helice et socle",
        board_column="print",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_id="E1",
        quote_number="DEV26-9001",
        quote_status="accepted",
        quote_status_confirmed=True,
        quote_sync_state=fields.pop("quote_sync_state", "idle"),
        quote_synced_at=PUSHED_AT,
        **fields,
    )
    db.add(project)
    await db.flush()
    db.add(
        AitoTask(
            project_id=project.id,
            position=0,
            title="Helice",
            scan_cost=5000,
            impression_cost=2400,
            impression_quantity=3,
        )
    )
    db.add(AitoTask(project_id=project.id, position=1, title="Socle", usinage_cost=8000, usinage_quantity=2))
    await db.commit()
    return project


def _serve(estimate: dict, seen: list):
    """A Books holding one estimate. Records every call that is not a read."""
    body = {"estimate_id": "E1", "status": "accepted", "total": 15400, "last_modified_time": EDITED_AT, **estimate}

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        if request.method != "GET":
            seen.append((request.method, request.url.path, json.loads(request.content) if request.content else None))
            return httpx.Response(200, json={"estimate": {**body, "last_modified_time": "2026-11-12T10:00:00-1000"}})
        if request.url.path.endswith("/comments"):
            return httpx.Response(200, json={"comments": []})
        if request.url.path.endswith("/estimates/E1"):
            return httpx.Response(200, json={"estimate": body})
        return httpx.Response(200, json={})

    zoho_service.transport = httpx.MockTransport(handler)
    zoho_service.invalidate_token()


async def _tasks(db, project_id: int) -> list[AitoTask]:
    stmt = select(AitoTask).where(AitoTask.project_id == project_id).order_by(AitoTask.position)
    return list((await db.execute(stmt.execution_options(populate_existing=True))).scalars())


async def _events(db, project_id: int, kind: str) -> list[AitoEvent]:
    stmt = select(AitoEvent).where(AitoEvent.project_id == project_id, AitoEvent.kind == kind).order_by(AitoEvent.id)
    return list((await db.execute(stmt)).scalars())


def _edited() -> dict:
    """Books after someone raised the scan to 6 500 and printed 5 instead of 3."""
    estimate = books(CARD)
    line(estimate, "P3DSCAN")["rate"] = 6500
    line(estimate, "P3DIMP")["quantity"] = 5
    return estimate


async def test_a_books_edit_lands_on_the_tasks_and_is_recorded_as_books(db_session, monkeypatch):
    project = await _card(db_session)
    await _configure_zoho(db_session)
    seen: list = []
    _serve(_edited(), seen)
    broadcasts: list = []

    async def capture(message):
        broadcasts.append(message)

    monkeypatch.setattr(aito_quote_sync.ws_manager, "broadcast_aito", capture)

    await run_sync_once(db_session)

    helice, socle = await _tasks(db_session, project.id)
    assert (helice.scan_cost, helice.impression_cost, helice.impression_quantity) == (6500, 4000, 5)
    assert (socle.usinage_cost, socle.usinage_quantity) == (8000, 2)
    (event,) = await _events(db_session, project.id, "quote.lines_pulled")
    assert (event.actor_class, event.subject_type, event.subject_id, event.subject_label) == (
        "system",
        "task",
        helice.id,
        "Helice",
    )
    assert {(c["field"], c["from"], c["to"]) for c in event.changes} == {
        ("scan_cost", 5000, 6500),
        ("impression_cost", 2400, 4000),
        ("impression_quantity", 3, 5),
    }
    # No ping-pong: nothing was written to Books and no push is owed.
    await db_session.refresh(project)
    assert seen == []
    assert project.quote_sync_state == "idle"
    assert await _events(db_session, project.id, "sync.queued") == []
    # Open panels are told to refetch.
    assert {"type": "aito_changed", "action": "quote-sync", "project_id": project.id, "actor": None} in broadcasts
    # The same estimate is not looked at twice.
    assert project.quote_synced_at == EDITED_AT
    await run_sync_once(db_session)
    assert len(await _events(db_session, project.id, "quote.lines_pulled")) == 1


async def test_a_card_with_an_unpushed_local_edit_pushes_and_is_not_overwritten(db_session):
    """Local wins: the pending card takes the push path, and Books' edit is
    overwritten by the card's lines exactly as before the pull existed."""
    project = await _card(db_session, quote_sync_state="pending")
    await _configure_zoho(db_session)
    seen: list = []
    _serve(_edited(), seen)

    await run_sync_once(db_session)

    helice, _ = await _tasks(db_session, project.id)
    assert (helice.scan_cost, helice.impression_quantity) == (5000, 3)
    assert await _events(db_session, project.id, "quote.lines_pulled") == []
    put = next(call for call in seen if call[0] == "PUT" and "line_items" in (call[2] or {}))
    assert [(item["rate"], item["quantity"]) for item in put[2]["line_items"] if "rate" in item] == [
        (5000, 1),
        (800, 3),
        (4000, 2),
    ]


async def test_a_local_edit_committed_while_books_was_being_read_wins(db_session, monkeypatch):
    """The worker read the card as idle, then an operator's edit committed
    during the Books call. The claim reads the row, not the session's memory."""
    project = await _card(db_session)
    project_id = project.id
    await _configure_zoho(db_session)
    seen: list = []
    _serve(_edited(), seen)
    real_get_estimate = zoho_service.get_estimate

    async def get_estimate_during_an_edit(db, estimate_id):
        estimate = await real_get_estimate(db, estimate_id)
        # What PATCH /aito/tasks/{id} commits, written past the ORM so the
        # worker's loaded project still says 'idle'.
        await db.execute(
            update(AitoProject)
            .where(AitoProject.id == project_id)
            .values(quote_sync_state="pending")
            .execution_options(synchronize_session=False)
        )
        await db.execute(
            update(AitoTask)
            .where(AitoTask.project_id == project_id, AitoTask.title == "Helice")
            .values(scan_cost=7777)
            .execution_options(synchronize_session=False)
        )
        return estimate

    monkeypatch.setattr(zoho_service, "get_estimate", get_estimate_during_an_edit)

    await run_sync_once(db_session, attention_only=False)

    helice, _ = await _tasks(db_session, project_id)
    assert (helice.scan_cost, helice.impression_quantity) == (7777, 3)
    assert await _events(db_session, project_id, "quote.lines_pulled") == []
    row = await db_session.get(AitoProject, project_id, populate_existing=True)
    assert row.quote_sync_state == "pending"
    assert row.quote_synced_at == PUSHED_AT  # the push will move it, not the pull


async def test_a_card_in_error_keeps_its_unpushed_lines(db_session):
    """An 'error' card holds an edit Books refused; a reconcile that settles
    it back to idle must not then take Books' lines over it."""
    project = await _card(db_session, quote_sync_state="error", quote_sync_failures=5, quote_sync_error="down")
    await _configure_zoho(db_session)
    _serve(_edited(), [])

    await run_sync_once(db_session)

    helice, _ = await _tasks(db_session, project.id)
    assert (helice.scan_cost, helice.impression_quantity) == (5000, 3)
    assert await _events(db_session, project.id, "quote.lines_pulled") == []


@pytest.mark.parametrize(
    "locked_by",
    [
        {"estimate": {"invoice_ids": ["INV-1"], "status": "invoiced"}},
        {"card": {"quote_invoiced": True}},
        {"card": {"quote_sync_state": "locked"}},
    ],
)
async def test_a_locked_card_is_never_touched(db_session, locked_by):
    project = await _card(db_session, **locked_by.get("card", {}))
    await _configure_zoho(db_session)
    seen: list = []
    _serve({**_edited(), **locked_by.get("estimate", {})}, seen)

    await run_sync_once(db_session)

    helice, _ = await _tasks(db_session, project.id)
    assert (helice.scan_cost, helice.impression_quantity) == (5000, 3)
    assert await _events(db_session, project.id, "quote.lines_pulled") == []
    assert seen == []


async def test_an_edit_that_does_not_map_exactly_is_flagged_once_and_changes_nothing(db_session):
    project = await _card(db_session)
    await _configure_zoho(db_session)
    estimate = books(CARD)
    estimate["line_items"] = estimate["line_items"][:-2]  # the Socle task deleted in Books
    line(estimate, "P3DSCAN")["rate"] = 6500
    seen: list = []
    _serve(estimate, seen)

    await run_sync_once(db_session)

    helice, socle = await _tasks(db_session, project.id)
    assert (helice.scan_cost, socle.usinage_cost) == (5000, 8000)
    (flag,) = await _events(db_session, project.id, "quote.lines_diverged")
    assert (flag.actor_class, flag.detail) == ("system", {"reason": "tasks"})
    assert await _events(db_session, project.id, "quote.lines_pulled") == []
    assert seen == []

    # Books moves again (a comment, a view) with the same divergence: no second flag.
    _serve({**estimate, "last_modified_time": "2026-11-12T09:45:00-1000"}, seen)
    await run_sync_once(db_session)
    assert len(await _events(db_session, project.id, "quote.lines_diverged")) == 1


async def test_foreign_lines_are_left_exactly_as_they_are(db_session):
    """A retail line added in Books is not the card's: nothing is applied,
    nothing is flagged, and above all nothing is written back to Books."""
    project = await _card(db_session)
    await _configure_zoho(db_session)
    estimate = books(CARD)
    estimate["line_items"].append(
        {"line_item_id": "F1", "sku": "PB05016", "name": "Bobine", "rate": 4000, "quantity": 2, "item_order": 9}
    )
    seen: list = []
    _serve({**estimate, "total": 23400}, seen)

    await run_sync_once(db_session)

    await db_session.refresh(project)
    assert seen == []
    assert project.quote_total == 23400
    assert project.quote_sync_state == "idle"
    for kind in ("quote.lines_pulled", "quote.lines_diverged"):
        assert await _events(db_session, project.id, kind) == []


async def test_a_removed_line_drops_the_step_and_its_tick(db_session):
    project = await _card(db_session)
    await db_session.execute(
        update(AitoTask).where(AitoTask.project_id == project.id, AitoTask.title == "Helice").values(scan_done=True)
    )
    await db_session.commit()
    await _configure_zoho(db_session)
    estimate = books(CARD)
    estimate["line_items"].remove(line(estimate, "P3DSCAN"))
    _serve(estimate, [])

    await run_sync_once(db_session)

    helice, _ = await _tasks(db_session, project.id)
    assert (helice.scan_cost, helice.scan_done, helice.impression_cost) == (None, False, 2400)


@pytest.mark.parametrize(
    "estimate",
    [
        {"is_inclusive_tax": True, "price_precision": 0},  # no line_items: a partial payload
        {**_edited(), "is_inclusive_tax": False},
        {**_edited(), "last_modified_time": PUSHED_AT},  # Books has not moved since our push
    ],
)
async def test_an_estimate_that_cannot_be_read_as_an_edit_is_left_alone(db_session, estimate):
    project = await _card(db_session)
    await _configure_zoho(db_session)
    _serve(estimate, [])

    await run_sync_once(db_session)

    helice, _ = await _tasks(db_session, project.id)
    assert (helice.scan_cost, helice.impression_quantity) == (5000, 3)
    await db_session.refresh(project)
    assert project.quote_synced_at == PUSHED_AT
    for kind in ("quote.lines_pulled", "quote.lines_diverged"):
        assert await _events(db_session, project.id, kind) == []


async def test_a_shipping_price_edit_moves_the_card_and_its_version(db_session, monkeypatch):
    """Shipping fields are the panel's (VERSIONED_FIELDS): an open editor must
    be refused its stale draft, so the version has to move with them."""
    from dataclasses import replace

    from backend.app.services.aito_quote_export import ExportShipping
    from backend.app.services.aito_shipping import island_for_label
    from backend.tests.unit.test_aito_quote_export import CATALOGUE

    catalogue = replace(CATALOGUE, shipping={"standard": "ITEM_SHIP"})

    async def get_catalogue(db):
        return catalogue

    monkeypatch.setattr(zoho_service, "get_catalogue", get_catalogue)
    project = await _card(
        db_session,
        shipping_island=island_for_label("Moorea"),
        shipping_service="standard",
        shipping_first_name="Jean",
        shipping_last_name="DUPONT",
        shipping_phone="87123456",
        shipping_price=3200,
    )
    version = project.version
    await _configure_zoho(db_session)
    shipment = ExportShipping(
        service="standard", island_label="Moorea", first_name="Jean", last_name="DUPONT", phone="87123456", price=3200
    )
    estimate = books(CARD, shipment, catalogue)
    next(item for item in estimate["line_items"] if item.get("item_id") == "ITEM_SHIP")["rate"] = 4100
    _serve(estimate, [])

    await run_sync_once(db_session)

    row = await db_session.get(AitoProject, project.id, populate_existing=True)
    assert (row.shipping_price, row.shipping_phone) == (4100, "87123456")
    assert row.version == version + 1
    (event,) = await _events(db_session, project.id, "quote.lines_pulled")
    assert event.changes == [{"field": "shipping_price", "from": 3200, "to": 4100}]


async def test_an_estimate_the_reader_chokes_on_is_flagged_and_the_reconcile_survives(db_session):
    project = await _card(db_session)
    await _configure_zoho(db_session)
    estimate = _edited()
    line(estimate, "P3DSCAN")["rate"] = "pas un nombre"
    _serve({**estimate, "total": 99000}, [])

    await run_sync_once(db_session)

    helice, _ = await _tasks(db_session, project.id)
    assert helice.scan_cost == 5000
    (flag,) = await _events(db_session, project.id, "quote.lines_diverged")
    assert flag.detail == {"reason": "error"}
    await db_session.refresh(project)
    assert project.quote_total == 99000  # the rest of the reconcile was kept
