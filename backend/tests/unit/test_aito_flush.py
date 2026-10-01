"""Flush on intent: a route that needs the card in Books waits for its push."""

import asyncio
import json
import time

import httpx
import pytest
from fastapi import HTTPException

from backend.app.api.routes import aito as aito_routes
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.services import aito_push_schedule, aito_quote_sync
from backend.app.services.aito_quote_sync import flush_and_wait, run_sync_once
from backend.app.services.zoho import zoho_service
from backend.tests.unit.test_aito_quote_sync import (  # noqa: F401 — fixtures register by name
    _configure_zoho,
    fresh_wake_event,
    reset_deferred_reasons,
    reset_requeue_marker,
    reset_zoho_service,
    zoho_handler,
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


async def _pending(db, client_id: str = "C1") -> AitoProject:
    project = AitoProject(
        description="Nouveau",
        board_column="devis",
        position=0,
        client_id=client_id,
        client_name="Client",
        quote_sync_state="pending",
    )
    db.add(project)
    await db.flush()
    db.add(AitoTask(project_id=project.id, position=0, title="Helice", scan_cost=5000))
    await db.commit()
    return project


@pytest.fixture
def serving(monkeypatch):
    monkeypatch.setattr(aito_quote_sync, "_serving", True)


@pytest.mark.asyncio
async def test_flush_marks_the_card_due_and_returns_when_its_push_is_resolved(serving):
    aito_push_schedule.note_edit(7, time.monotonic())  # mid quiet period

    async def worker():
        await asyncio.sleep(0.05)
        assert aito_push_schedule.is_due(7, time.monotonic()) is True
        assert aito_quote_sync._take_drain_request() is True
        aito_push_schedule.resolve(7)

    task = asyncio.create_task(worker())
    assert await flush_and_wait(7, timeout=1.0) is True
    await task
    assert aito_push_schedule.has_waiter(7) is False


@pytest.mark.asyncio
async def test_a_wait_without_a_request_asks_for_no_drain(serving):
    """The second wait of a route whose card is still pending after one
    attempt: it joins the worker's own next attempt (a fast retry, the window
    an edit re-opened). Asking again each time would re-push a card Books
    just refused, every half second, and spend its failure budget in
    seconds."""
    aito_push_schedule.note_edit(7, time.monotonic())

    async def worker():
        await asyncio.sleep(0.05)
        assert aito_quote_sync._drain_requested is False
        assert aito_push_schedule.is_due(7, time.monotonic()) is False  # the quiet period stands
        aito_push_schedule.resolve(7)

    task = asyncio.create_task(worker())
    assert await flush_and_wait(7, timeout=1.0, request=False) is True
    await task


@pytest.mark.asyncio
async def test_flush_times_out_and_leaves_no_waiter_behind(serving):
    started = time.monotonic()
    assert await flush_and_wait(7, timeout=0.1) is False
    assert time.monotonic() - started < 0.5
    assert aito_push_schedule.has_waiter(7) is False


@pytest.mark.asyncio
async def test_a_cancelled_flush_leaves_no_waiter_behind(serving):
    task = asyncio.create_task(flush_and_wait(7, timeout=5.0))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert aito_push_schedule.has_waiter(7) is False


@pytest.mark.asyncio
async def test_flush_returns_at_once_when_the_worker_is_not_serving(monkeypatch):
    monkeypatch.setattr(aito_quote_sync, "_serving", False)
    started = time.monotonic()
    assert await flush_and_wait(7, timeout=5.0) is False
    assert time.monotonic() - started < 0.1


@pytest.mark.asyncio
async def test_a_drain_resolves_the_waiters_of_every_card_it_attempts(db_session, serving):
    project = await _pending(db_session)
    await _configure_zoho(db_session)
    zoho_service.transport = httpx.MockTransport(
        zoho_handler({("GET", "/estimates"): {"estimates": []}, ("POST", "/estimates"): CREATED})
    )
    waiter = aito_push_schedule.add_waiter(project.id)

    await run_sync_once(db_session, pending_only=True)

    assert waiter.done()


@pytest.mark.asyncio
async def test_a_drain_resolves_a_waiter_whose_card_was_settled_by_someone_else(db_session, serving):
    project = await _pending(db_session)
    project.quote_sync_state = "idle"
    await db_session.commit()
    waiter = aito_push_schedule.add_waiter(project.id)
    aito_push_schedule.note_immediate(project.id, time.monotonic())

    await run_sync_once(db_session, pending_only=True)

    # Not selected (not pending), so never attempted — the route must still be
    # released to read the state for itself.
    assert waiter.done()


@pytest.mark.asyncio
async def test_a_flushed_card_is_pushed_before_the_other_due_cards(db_session, serving):
    first = await _pending(db_session, "C1")
    flushed = await _pending(db_session, "C2")
    await _configure_zoho(db_session)
    order: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        if request.method == "POST":
            order.append(json.loads(request.content)["customer_id"])
            return httpx.Response(200, json=CREATED)
        return httpx.Response(200, json={"estimates": []})

    zoho_service.transport = httpx.MockTransport(handler)
    aito_push_schedule.add_waiter(flushed.id)

    await run_sync_once(db_session, pending_only=True)

    assert order[0] == "C2"
    assert first.id < flushed.id  # id order alone would have pushed C1 first


@pytest.mark.asyncio
async def test_ensure_pushed_returns_at_once_for_a_card_that_is_not_pending(db_session, serving, monkeypatch):
    project = await _pending(db_session)
    project.quote_sync_state = "idle"
    await db_session.commit()

    async def never(*_args, **_kwargs):
        raise AssertionError("must not flush")

    monkeypatch.setattr(aito_quote_sync, "flush_and_wait", never)
    await aito_routes.ensure_pushed(db_session, project)


@pytest.mark.asyncio
async def test_ensure_pushed_waits_for_the_push_and_then_lets_the_route_proceed(db_session, serving, monkeypatch):
    project = await _pending(db_session)
    project_id = project.id

    async def pushed(pid, timeout=20.0, request=True):
        assert pid == project_id
        assert request is True
        row = await db_session.get(AitoProject, pid)
        row.quote_sync_state = "idle"
        row.quote_id = "NEW"
        await db_session.commit()
        return True

    monkeypatch.setattr(aito_quote_sync, "flush_and_wait", pushed)
    await aito_routes.ensure_pushed(db_session, project)
    assert project.quote_sync_state == "idle"
    assert project.quote_id == "NEW"


@pytest.mark.asyncio
async def test_ensure_pushed_raises_503_sync_pending_when_the_push_does_not_land(db_session, serving, monkeypatch):
    project = await _pending(db_session)

    async def timed_out(pid, timeout=20.0, request=True):
        return False

    monkeypatch.setattr(aito_quote_sync, "flush_and_wait", timed_out)
    with pytest.raises(HTTPException) as caught:
        await aito_routes.ensure_pushed(db_session, project)
    assert caught.value.status_code == 503
    assert caught.value.detail["code"] == "sync_pending"


@pytest.mark.asyncio
async def test_ensure_pushed_waits_again_when_the_card_is_still_pending_after_an_attempt(
    db_session, serving, monkeypatch
):
    """An edit landed mid-push, or Books refused the push: the card is still
    pending when the first attempt completes. The route waits for the
    worker's next attempt — and asks for a drain only the first time."""
    project = await _pending(db_session)
    requests: list[bool] = []

    async def second_time_lucky(pid, timeout=20.0, request=True):
        requests.append(request)
        if len(requests) == 2:
            row = await db_session.get(AitoProject, pid)
            row.quote_sync_state = "idle"
            await db_session.commit()
        return True

    monkeypatch.setattr(aito_quote_sync, "flush_and_wait", second_time_lucky)
    await aito_routes.ensure_pushed(db_session, project)
    assert requests == [True, False]
    assert project.quote_sync_state == "idle"


@pytest.mark.asyncio
async def test_ensure_pushed_does_not_wait_when_the_worker_is_not_serving(db_session, monkeypatch):
    project = await _pending(db_session)
    monkeypatch.setattr(aito_quote_sync, "_serving", False)
    started = time.monotonic()
    await aito_routes.ensure_pushed(db_session, project)  # returns; the route behaves as it did before
    assert time.monotonic() - started < 0.1
    assert project.quote_sync_state == "pending"


@pytest.mark.asyncio
@pytest.mark.parametrize("ended", ["error", "locked"])
async def test_strict_ensure_pushed_refuses_when_the_push_did_not_land(db_session, serving, monkeypatch, ended):
    """The routes that cannot be undone — raising an invoice, emailing the
    quote to the client — pass ``strict``. The card was pending when the
    operator clicked; the push was attempted and Books refused it ('error')
    or the worker refused to write ('locked'). Books therefore still holds
    the lines as they were BEFORE the edit, and billing or sending them now
    is exactly what waiting for the push was meant to prevent."""
    project = await _pending(db_session)

    async def refused(pid, timeout=20.0, request=True):
        row = await db_session.get(AitoProject, pid)
        row.quote_sync_state = ended
        row.quote_sync_error = "Books said no"
        await db_session.commit()
        return True

    monkeypatch.setattr(aito_quote_sync, "flush_and_wait", refused)
    with pytest.raises(HTTPException) as caught:
        await aito_routes.ensure_pushed(db_session, project, strict=True)
    assert caught.value.status_code == 409
    assert "Zoho" in caught.value.detail
    if ended == "error":
        assert "Books said no" in caught.value.detail


@pytest.mark.asyncio
async def test_a_read_only_route_still_proceeds_when_the_push_ended_in_error(db_session, serving, monkeypatch):
    """Printing is not irreversible: the panel already shows the sync error
    with a retry, and the PDF Books holds may still be what is wanted."""
    project = await _pending(db_session)

    async def refused(pid, timeout=20.0, request=True):
        row = await db_session.get(AitoProject, pid)
        row.quote_sync_state = "error"
        await db_session.commit()
        return True

    monkeypatch.setattr(aito_quote_sync, "flush_and_wait", refused)
    await aito_routes.ensure_pushed(db_session, project)
    assert project.quote_sync_state == "error"


@pytest.mark.asyncio
async def test_strict_ensure_pushed_leaves_a_card_alone_that_was_not_pending(db_session, serving, monkeypatch):
    """A card already in 'error' when the operator clicks was billable before
    this change and stays so: the refusal is about an edit this very click
    tried, and failed, to push."""
    project = await _pending(db_session)
    project.quote_sync_state = "error"
    await db_session.commit()

    async def never(*_args, **_kwargs):
        raise AssertionError("must not flush")

    monkeypatch.setattr(aito_quote_sync, "flush_and_wait", never)
    await aito_routes.ensure_pushed(db_session, project, strict=True)
