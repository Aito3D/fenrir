"""The change pass: three listings, a reconcile queue, a safety trickle — and
a rate-limit hold that stops reconciles without ever stopping a push."""

import time
from datetime import datetime

import httpx
import pytest

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.services import aito_quote_sync
from backend.app.services.aito_quote_sync import run_change_pass, run_sync_once
from backend.app.services.zoho import zoho_service
from backend.tests.unit.test_aito_quote_sync import (  # noqa: F401 — fixtures register by name
    _configure_zoho,
    fresh_wake_event,
    reset_deferred_reasons,
    reset_requeue_marker,
    reset_zoho_service,
)

CREATED = {
    "estimate": {
        "estimate_id": "NEW",
        "estimate_number": "DEV26-9001",
        "date": "2026-07-29",
        "status": "draft",
        "total": 5000,
        "last_modified_time": "2026-07-29T10:00:00-1000",
        "is_inclusive_tax": True,
    }
}


async def _quoted(db, estimate_id: str, client_id: str = "C1", **fields) -> AitoProject:
    project = AitoProject(
        description="Quoted",
        board_column=fields.pop("board_column", "print"),
        position=0,
        client_id=client_id,
        client_name="Client",
        quote_id=estimate_id,
        quote_number=f"DEV26-{estimate_id}",
        quote_status=fields.pop("quote_status", "accepted"),
        quote_sync_state=fields.pop("quote_sync_state", "idle"),
        quote_status_confirmed=fields.pop("quote_status_confirmed", True),
        # Steady state: the comments mirror has already read this estimate at
        # this timestamp, so a reconcile does not spend a comments call.
        zoho_comments_watermark="2026-07-29T10:00:00-1000",
        zoho_comments_checked_at=datetime.utcnow(),
        **fields,
    )
    db.add(project)
    await db.flush()
    db.add(AitoTask(project_id=project.id, position=0, title="Helice", scan_cost=5000))
    await db.commit()
    return project


async def _pending(db) -> AitoProject:
    project = AitoProject(
        description="Nouveau",
        board_column="devis",
        position=0,
        client_id="C9",
        client_name="Client",
        quote_sync_state="pending",
    )
    db.add(project)
    await db.flush()
    db.add(AitoTask(project_id=project.id, position=0, title="Helice", scan_cost=5000))
    await db.commit()
    return project


def _books(seen: list, changed: dict[str, list[dict]] | None = None, status: dict[str, int] | None = None):
    """A Books that lists ``changed`` rows per listing suffix, answers every
    single-estimate read with an accepted estimate, and records each call as
    (METHOD, path). ``status`` forces a status code for a path suffix."""
    changed = changed or {}
    keys = {
        "/estimates": "estimates",
        "/customerpayments": "customerpayments",
        "/retainerinvoices": "retainerinvoices",
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        path = request.url.path
        seen.append((request.method, path))
        for suffix, code in (status or {}).items():
            if path.endswith(suffix):
                return httpx.Response(code, json={"code": 44, "message": "no"})
        if request.method == "POST" and path.endswith("/estimates"):
            return httpx.Response(200, json=CREATED)
        for suffix, key in keys.items():
            if request.method == "GET" and path.endswith(suffix):
                if "last_modified_time" in request.url.params:
                    return httpx.Response(
                        200, json={key: changed.get(suffix, []), "page_context": {"has_more_page": False}}
                    )
                return httpx.Response(200, json={key: []})  # a per-customer or by-reference read
        if path.endswith("/comments"):
            return httpx.Response(200, json={"comments": []})
        if request.method == "GET" and "/estimates/" in path:
            estimate_id = path.rsplit("/", 1)[-1]
            # No customer_id: the card keeps its own (see _follow_customer).
            return httpx.Response(
                200,
                json={
                    "estimate": {
                        "estimate_id": estimate_id,
                        "status": "accepted",
                        "total": 5000,
                        "last_modified_time": "2026-07-29T10:00:00-1000",
                        "is_inclusive_tax": True,
                    }
                },
            )
        return httpx.Response(200, json={})

    return handler


def _single_reads(seen: list) -> list[str]:
    return [
        path.rsplit("/", 1)[-1]
        for method, path in seen
        if method == "GET" and "/estimates/" in path and not path.endswith("/comments")
    ]


@pytest.mark.asyncio
async def test_a_hold_does_not_stop_a_pending_push(db_session):
    project = await _pending(db_session)
    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(_books(seen))
    aito_quote_sync._throttled_until = time.monotonic() + 60

    assert await run_sync_once(db_session, pending_only=True) == 1

    await db_session.refresh(project)
    assert project.quote_id == "NEW"
    assert project.quote_sync_state == "idle"


@pytest.mark.asyncio
async def test_a_hold_turns_a_full_sweep_into_a_push_only_pass(db_session):
    pending = await _pending(db_session)
    await _quoted(db_session, "E1")
    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(_books(seen))
    aito_quote_sync._throttled_until = time.monotonic() + 60

    assert await run_sync_once(db_session) == 1

    await db_session.refresh(pending)
    assert pending.quote_id == "NEW"
    assert _single_reads(seen) == []  # the quoted card was not reconciled


@pytest.mark.asyncio
async def test_the_attention_pass_reconciles_error_cards_and_leaves_healthy_ones(db_session):
    await _quoted(db_session, "HEALTHY")
    await _quoted(db_session, "BROKEN", quote_sync_state="error", quote_sync_failures=5, quote_sync_error="down")
    await _quoted(db_session, "UNCONFIRMED", board_column="done", quote_status_confirmed=False)
    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(_books(seen))

    assert await run_sync_once(db_session, attention_only=True) == 2

    assert sorted(_single_reads(seen)) == ["BROKEN", "UNCONFIRMED"]


@pytest.mark.asyncio
async def test_a_429_on_a_push_arms_a_fast_retry_and_a_hold_of_at_most_a_minute(db_session):
    await _pending(db_session)
    await _configure_zoho(db_session)

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(429, json={"code": 44, "message": "no"}, headers={"Retry-After": "900"})

    zoho_service.transport = httpx.MockTransport(handler)
    aito_quote_sync._reset_fast_retry_state()
    before = time.monotonic()

    await run_sync_once(db_session, pending_only=True)

    assert aito_quote_sync._take_transient_push_failure() is True
    assert aito_quote_sync._throttled_until is not None
    assert aito_quote_sync._throttled_until - before <= 60.5


@pytest.mark.asyncio
async def test_a_change_pass_reconciles_only_changed_cards_plus_the_trickle(db_session):
    cards = [await _quoted(db_session, f"E{n}", client_id=f"C{n}") for n in range(1, 8)]
    await _configure_zoho(db_session)
    seen: list = []
    changed = {
        "/estimates": [{"estimate_id": "E6", "customer_id": "C6", "last_modified_time": "2026-10-01T01:00:00-1000"}],
        "/customerpayments": [{"payment_id": "P1", "customer_id": "C7", "last_modified_time": "2026-10-01T01:00:00-1000"}],
    }
    zoho_service.transport = httpx.MockTransport(_books(seen, changed))

    reconciled = await run_change_pass(db_session)

    # E6 (its estimate changed), E7 (its customer paid), then the trickle's two lowest ids.
    assert _single_reads(seen) == ["E6", "E7", "E1", "E2"]
    assert reconciled == 4
    assert aito_quote_sync._trickle_cursor == cards[1].id


@pytest.mark.asyncio
async def test_the_trickle_walks_the_board_and_wraps_around(db_session):
    for n in range(1, 4):
        await _quoted(db_session, f"E{n}", client_id=f"C{n}")
    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(_books(seen))

    await run_change_pass(db_session)
    await run_change_pass(db_session)

    assert _single_reads(seen) == ["E1", "E2", "E3", "E1"]


@pytest.mark.asyncio
async def test_a_quiet_change_pass_on_a_production_sized_board_stays_under_ten_calls(db_session):
    for n in range(1, 78):  # the 77 open quoted cards of the 2026-10-01 board
        await _quoted(db_session, f"E{n}", client_id=f"C{n}")
    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(_books(seen))

    await run_change_pass(db_session)

    assert len(seen) <= 10
    assert len(_single_reads(seen)) == 2


@pytest.mark.asyncio
async def test_the_budget_guard_stops_the_pass_and_keeps_the_queue(db_session, monkeypatch):
    for n in range(1, 4):
        await _quoted(db_session, f"E{n}", client_id=f"C{n}")
    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(_books(seen))
    # The three listings pass under it; the first card's reads cross it.
    monkeypatch.setattr(aito_quote_sync, "BACKGROUND_CALL_CEILING", 4)

    await run_change_pass(db_session)

    assert _single_reads(seen) == ["E1"]
    assert len(aito_quote_sync._reconcile_queue) == 1  # the second trickle card waits for the next pass


@pytest.mark.asyncio
async def test_a_429_from_a_listing_arms_the_hold_and_still_queues_what_was_read(db_session):
    project = await _quoted(db_session, "E1")
    await _configure_zoho(db_session)
    seen: list = []
    changed = {
        "/estimates": [{"estimate_id": "E1", "customer_id": "C1", "last_modified_time": "2026-10-01T01:00:00-1000"}]
    }
    zoho_service.transport = httpx.MockTransport(_books(seen, changed, status={"/customerpayments": 429}))

    assert await run_change_pass(db_session) == 0

    assert aito_quote_sync._throttled_until is not None
    assert aito_quote_sync._reconcile_queue == [project.id]
    assert _single_reads(seen) == []


@pytest.mark.asyncio
async def test_a_change_pass_does_nothing_inside_a_hold(db_session):
    await _quoted(db_session, "E1")
    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(_books(seen))
    aito_quote_sync._throttled_until = time.monotonic() + 60

    assert await run_change_pass(db_session) == 0
    assert seen == []


@pytest.mark.asyncio
async def test_a_pending_card_named_by_a_change_is_left_to_the_push(db_session):
    project = await _quoted(db_session, "E1", quote_sync_state="pending")
    await _configure_zoho(db_session)
    seen: list = []
    changed = {
        "/estimates": [{"estimate_id": "E1", "customer_id": "C1", "last_modified_time": "2026-10-01T01:00:00-1000"}]
    }
    zoho_service.transport = httpx.MockTransport(_books(seen, changed))

    await run_change_pass(db_session)

    assert _single_reads(seen) == []
    await db_session.refresh(project)
    assert project.quote_sync_state == "pending"
