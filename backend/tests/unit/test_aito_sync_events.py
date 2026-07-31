"""The sync worker's own trace, and the one thing it must NOT claim.

Conflicts are currently recorded in quote_status_block, a current-state field
the next write overwrites. As events they become history: a card that
conflicted three times last week can say so.
"""

from datetime import datetime

import httpx
import pytest
from sqlalchemy import select

from backend.app.models.aito_event import AitoEvent
from backend.app.services import aito_quote_sync
from backend.app.services.aito_events import record as real_record
from backend.app.services.aito_quote_sync import SYNC_FAILURE_LIMIT, sync_project
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


@pytest.mark.asyncio
async def test_a_persistent_status_conflict_is_recorded_once(db_session):
    """A conflict clears only via a human calling set_quote_status (see
    _clear_block's docstring) — so with nobody doing that, the exact same
    disagreement is rediscovered on every subsequent sweep tick. Before the
    fix this wrote a fresh sync.conflict row per tick for as long as the
    conflict persisted (a project left in conflict for a week would have
    accumulated ~288 rows/day at the default 300s interval); the columns
    (`quote_status_block`/`quote_status_remote`) are still written every
    tick — only the event must be debounced."""
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
        await db_session.refresh(project)
        await sync_project(db_session, project)
        await db_session.commit()
    finally:
        zoho_service.transport = None

    await db_session.refresh(project)
    assert project.quote_status_block == "conflict"  # the column is still written every tick
    assert (await _kinds(db_session, project.id)).count("sync.conflict") == 1


@pytest.mark.asyncio
async def test_a_status_conflict_against_a_new_remote_status_records_again(db_session):
    """The debounce must not swallow genuinely new information. Books' side of
    a conflict can itself change — a second, different decision recorded
    against the same disputed estimate — and that is not the same event as
    the first; it must produce its own row. `quote_status_remote` alone
    identifies the attempt the debounce compares against (see the 'rejected'
    branch's own comment on this), so a second tick whose remote status
    differs from what was stored must not be swallowed."""
    project = await _project_with_quote(db_session, scan_cost=5000)
    project.quote_sync_state = "idle"
    project.quote_status = "accepted"
    await db_session.commit()
    await _configure_zoho(db_session)

    def transport_for(status: str) -> httpx.MockTransport:
        return httpx.MockTransport(
            zoho_handler(
                {
                    ("GET", "/estimates/E1"): {
                        "estimate": {
                            "estimate_id": "E1",
                            "estimate_number": "DEV26-9001",
                            "status": status,
                            "line_items": [],
                            "last_modified_time": "2026-07-29T10:00:00+1100",
                        }
                    }
                }
            )
        )

    try:
        zoho_service.transport = transport_for("declined")
        await sync_project(db_session, project)
        await db_session.commit()
        await db_session.refresh(project)
        assert project.quote_status_block == "conflict"
        assert project.quote_status_remote == "declined"

        # Our own side changes too (the only way a SECOND, still-decided
        # remote status can disagree with it — 'accepted'/'declined' are the
        # only two decided values there are) — a fresh disagreement, not a
        # repeat of the one just recorded.
        project.quote_status = "declined"
        await db_session.commit()
        zoho_service.transport = transport_for("accepted")
        await sync_project(db_session, project)
        await db_session.commit()
    finally:
        zoho_service.transport = None

    await db_session.refresh(project)
    assert project.quote_status_remote == "accepted"
    assert (await _kinds(db_session, project.id)).count("sync.conflict") == 2


@pytest.mark.asyncio
async def test_a_persistent_upstream_failure_is_recorded_once(db_session):
    """The ZohoUpstreamError escalation re-fires on every subsequent tick for
    the duration of a Books outage, because an escalated project stays
    selected by the sweep (see the SYNC_FAILURE_LIMIT comment: the limit ends
    retrying the PUSH, not being polled) and quote_sync_failures is never
    reset while it stays broken. Before the fix this wrote a fresh
    sync.failed row on every tick for the entire outage."""
    project = await _project_with_quote(db_session, scan_cost=5000)
    project.quote_sync_state = "idle"
    project.quote_sync_failures = SYNC_FAILURE_LIMIT - 1
    await db_session.commit()
    await _configure_zoho(db_session)

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(503, json={"message": "down"})

    zoho_service.transport = httpx.MockTransport(handler)
    try:
        await sync_project(db_session, project)
        await db_session.commit()
        await db_session.refresh(project)
        assert project.quote_sync_state == "error"  # this tick spent the retry budget
        await sync_project(db_session, project)
        await db_session.commit()
    finally:
        zoho_service.transport = None

    await db_session.refresh(project)
    assert project.quote_sync_state == "error"
    assert (await _kinds(db_session, project.id)).count("sync.failed") == 1


@pytest.mark.asyncio
async def test_sync_project_does_not_raise_when_a_terminal_handler_hits_a_poisoned_session(db_session, monkeypatch):
    """FINDING 1's reproducible trigger, in miniature: a terminal exception
    handler's own record() call does db.add() + await db.flush(), so if the
    exception being handled was ITSELF a failed flush (the real-world case is
    two active projects landing on the same quote_id via the partial unique
    index uq_aito_project_active_quote), the session is already aborted and
    that second flush raises PendingRollbackError OUT of sync_project --
    breaking the "never raises" promise its own docstring makes, and (per
    run_sync_once's loop) aborting every remaining project in the tick.

    A duplicate zoho_comment_id is used here to force a real, deterministic
    IntegrityError -- easier to arrange in a unit test than the quote_id race
    -- but the failure mode it reproduces is exactly the one FINDING 1
    describes: some flush inside the try block fails, and the terminal
    handler's own record() call is the SECOND flush against the now-poisoned
    session.

    Before the fix, this test fails with PendingRollbackError propagating out
    of sync_project. After the fix (rolling the session back before a
    terminal handler writes or records anything), it passes."""
    project = await _project_with_quote(db_session, scan_cost=5000)
    await _configure_zoho(db_session)
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "status": "draft",
                        "is_transaction_created": False,
                        "invoiced_amount": 0,
                        "is_inclusive_tax": True,
                        "line_items": [],
                    }
                },
                ("PUT", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "draft"}},
            }
        )
    )

    poisoned = {"done": False}

    async def poisoning_record(db, project_id, kind, **kwargs):
        # sync.pushed is _update_quote's own success-path record() call --
        # intercepting it lets the successful PUT stand (so the exception
        # really is "a flush failed", not "Zoho rejected something") while
        # still landing in sync_project's catch-all below.
        if kind == "sync.pushed" and not poisoned["done"]:
            poisoned["done"] = True
            same_id_kwargs = {
                "project_id": project_id,
                "occurred_at": datetime.utcnow(),
                "kind": "zoho.comment",
                "actor_class": "system",
                "zoho_comment_id": "dup-1",
            }
            db.add(AitoEvent(**same_id_kwargs))
            await db.flush()  # succeeds
            db.add(AitoEvent(**same_id_kwargs))
            await db.flush()  # UNIQUE constraint on zoho_comment_id: raises, poisoning the session
            return None
        return await real_record(db, project_id, kind, **kwargs)

    monkeypatch.setattr(aito_quote_sync, "record", poisoning_record)

    try:
        await sync_project(db_session, project)  # must not raise
        await db_session.commit()
    finally:
        zoho_service.transport = None

    assert poisoned["done"]  # the poisoning path actually ran, not skipped
    await db_session.refresh(project)
    # The IntegrityError is not one of the named Zoho exceptions, so it lands
    # in sync_project's catch-all, which marks the project 'error' -- and,
    # critically, records that fact instead of raising while trying to.
    assert project.quote_sync_state == "error"
    assert "sync.failed" in await _kinds(db_session, project.id)
