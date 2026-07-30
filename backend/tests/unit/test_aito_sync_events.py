"""The sync worker's own trace, and the one thing it must NOT claim.

Conflicts are currently recorded in quote_status_block, a current-state field
the next write overwrites. As events they become history: a card that
conflicted three times last week can say so.
"""

import httpx
import pytest
from sqlalchemy import select

from backend.app.models.aito_event import AitoEvent
from backend.app.services.aito_quote_sync import sync_project
from backend.app.services.zoho import zoho_service

from .test_aito_quote_sync import _configure_zoho, _project_with_quote, zoho_handler


async def _kinds(db_session, project_id: int) -> list[str]:
    rows = (
        (
            await db_session.execute(
                select(AitoEvent.kind).where(AitoEvent.project_id == project_id).order_by(AitoEvent.id)
            )
        )
        .scalars()
        .all()
    )
    return list(rows)


@pytest.mark.asyncio
async def test_a_successful_push_is_recorded(db_session):
    project = await _project_with_quote(db_session, scan_cost=5000)
    await _configure_zoho(db_session)
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "estimate_number": "DEV26-9001",
                        "status": "draft",
                        "is_transaction_created": False,
                        "invoiced_amount": 0,
                        "is_inclusive_tax": True,
                        "line_items": [],
                        "last_modified_time": "2026-07-29T10:00:00+1100",
                    }
                },
                ("PUT", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "draft"}},
            }
        )
    )
    try:
        await sync_project(db_session, project)
        await db_session.commit()
    finally:
        zoho_service.transport = None

    assert "sync.pushed" in await _kinds(db_session, project.id)


@pytest.mark.asyncio
async def test_a_rejected_push_is_recorded_as_a_failure(db_session):
    """Mirrors test_zoho_request_rejected_goes_straight_to_error, which already
    proves the 400 path sets quote_sync_state='error'. This asserts the event."""
    project = await _project_with_quote(db_session, scan_cost=5000)
    await _configure_zoho(db_session)

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        if request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "estimate": {
                        "estimate_id": "E1",
                        "status": "draft",
                        "is_transaction_created": False,
                        "invoiced_amount": 0,
                        "is_inclusive_tax": True,
                        "line_items": [],
                    }
                },
            )
        return httpx.Response(400, json={"message": "tax_id required"})

    zoho_service.transport = httpx.MockTransport(handler)
    try:
        await sync_project(db_session, project)
        await db_session.commit()
    finally:
        zoho_service.transport = None

    kinds = await _kinds(db_session, project.id)
    assert "sync.failed" in kinds

    event = (
        (
            await db_session.execute(
                select(AitoEvent).where(AitoEvent.project_id == project.id, AitoEvent.kind == "sync.failed")
            )
        )
        .scalars()
        .first()
    )
    assert event.detail["error"]


@pytest.mark.asyncio
async def test_the_reconciler_does_not_emit_quote_status_events(db_session):
    """The comment mirror owns those. Two sources for one fact would show the
    client accepting the quote twice, and the reconciler's timestamp is only
    when it polled — Books knows when it actually happened.

    Arranged like test_a_push_still_adopts_books_status_when_ours_is_undecided:
    ours is undecided, Books says accepted, so the reconciler adopts it.
    """
    project = await _project_with_quote(db_session, scan_cost=5000)
    project.quote_sync_state = "idle"
    project.quote_status = None
    await db_session.commit()
    await _configure_zoho(db_session)

    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "estimate_number": "DEV26-9001",
                        "status": "accepted",
                        "line_items": [],
                        "last_modified_time": "2026-07-29T10:00:00+1100",
                    }
                }
            }
        )
    )
    try:
        await sync_project(db_session, project)
        await db_session.commit()
    finally:
        zoho_service.transport = None

    await db_session.refresh(project)
    assert project.quote_status == "accepted"  # the reconciler DID adopt it
    assert "quote.accepted" not in await _kinds(db_session, project.id)  # but recorded no event


@pytest.mark.asyncio
async def test_a_status_conflict_becomes_an_event(db_session):
    """Arranged like
    test_a_push_never_resolves_two_disagreeing_decisions_in_books_favour:
    both sides decided, and they disagree."""
    project = await _project_with_quote(db_session, scan_cost=5000)
    project.quote_sync_state = "idle"
    project.quote_status = "accepted"
    await db_session.commit()
    await _configure_zoho(db_session)

    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "estimate_number": "DEV26-9001",
                        "status": "declined",
                        "line_items": [],
                        "last_modified_time": "2026-07-29T10:00:00+1100",
                    }
                }
            }
        )
    )
    try:
        await sync_project(db_session, project)
        await db_session.commit()
    finally:
        zoho_service.transport = None

    await db_session.refresh(project)
    assert project.quote_status_block == "conflict"
    assert "sync.conflict" in await _kinds(db_session, project.id)
