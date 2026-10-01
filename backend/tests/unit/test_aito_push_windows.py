"""Per-card push windows through the worker: which pending cards a drain
takes, and what wakes the loop."""

import asyncio
import contextlib
import time

import httpx
import pytest

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.services import aito_push_schedule, aito_quote_sync
from backend.app.services.aito_quote_sync import run_sync_once
from backend.app.services.zoho import zoho_service
from backend.tests.unit.test_aito_quote_sync import (  # noqa: F401 — fixtures register by name
    _always,
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


def _creating_books(seen: list):
    return httpx.MockTransport(
        zoho_handler({("GET", "/estimates"): {"estimates": []}, ("POST", "/estimates"): CREATED}, seen)
    )


@contextlib.asynccontextmanager
async def _fake_session():
    yield None


def _loop_fakes(monkeypatch, drains: list, *, interval: float = 300):
    """Run the loop with collaborator fakes: every drain is recorded as
    (kind, monotonic time), where kind is 'tick', 'drain' or 'change'."""

    async def fake_run_sync_once(db, pending_only=False, fast_retry=False, attention_only=False):
        drains.append(("drain" if pending_only else "tick", time.monotonic()))
        now = time.monotonic()
        aito_push_schedule.drop_due_except(now, keep=set())
        return 0

    async def fake_change_pass(db):
        drains.append(("change", time.monotonic()))
        return 0

    monkeypatch.setattr(aito_quote_sync, "async_session", _fake_session)
    monkeypatch.setattr(aito_quote_sync, "run_sync_once", fake_run_sync_once)
    monkeypatch.setattr(aito_quote_sync, "run_change_pass", fake_change_pass)
    monkeypatch.setattr(aito_quote_sync, "sync_enabled", _always(True))
    monkeypatch.setattr(aito_quote_sync.zoho_service, "is_configured", _always(True))
    monkeypatch.setattr(aito_quote_sync, "sync_interval_seconds", _always(interval))
    monkeypatch.setattr(aito_quote_sync, "sweep_invoices", _always(0))
    monkeypatch.setattr(aito_quote_sync, "purge_tracking_views", _always(0))


async def _stop(task: asyncio.Task) -> None:
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_a_drain_skips_a_card_whose_window_is_still_open(db_session):
    quiet = await _pending(db_session, "C1")
    due = await _pending(db_session, "C2")
    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = _creating_books(seen)
    aito_push_schedule.note_edit(quiet.id, time.monotonic())  # 10 s of quiet still to run

    assert await run_sync_once(db_session, pending_only=True) == 1

    await db_session.refresh(quiet)
    await db_session.refresh(due)
    assert due.quote_sync_state == "idle"
    assert quiet.quote_sync_state == "pending"
    assert quiet.quote_id is None


@pytest.mark.asyncio
async def test_a_drain_takes_the_windows_it_pushes_and_drops_stale_ones(db_session):
    card = await _pending(db_session)
    await _configure_zoho(db_session)
    zoho_service.transport = _creating_books([])
    now = time.monotonic()
    aito_push_schedule.note_immediate(card.id, now)
    aito_push_schedule.note_immediate(99999, now)  # a card that is not pending (or no longer exists)

    await run_sync_once(db_session, pending_only=True)

    assert aito_push_schedule.next_due(time.monotonic()) is None


@pytest.mark.asyncio
async def test_a_429_mid_drain_leaves_no_due_window_behind(db_session):
    # The drain stops at the first 429. Windows left due would wake the loop
    # again at once, straight back into the limit; the fast retry is what
    # brings the remaining cards back.
    first = await _pending(db_session, "C1")
    second = await _pending(db_session, "C2")
    await _configure_zoho(db_session)

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(429, json={"code": 44, "message": "no"})

    zoho_service.transport = httpx.MockTransport(handler)
    now = time.monotonic()
    aito_push_schedule.note_immediate(first.id, now)
    aito_push_schedule.note_immediate(second.id, now)

    await run_sync_once(db_session, pending_only=True)

    assert aito_push_schedule.any_due(time.monotonic()) is False


@pytest.mark.asyncio
async def test_an_edit_is_drained_after_its_quiet_period_not_before(monkeypatch):
    drains: list = []
    _loop_fakes(monkeypatch, drains)
    monkeypatch.setattr(aito_push_schedule, "EDIT_QUIET_SECONDS", 0.3)
    monkeypatch.setattr(aito_quote_sync, "CHANGE_PASS_SECONDS", 3600.0)
    loop_task = asyncio.create_task(aito_quote_sync.run_sync_loop())
    try:
        await asyncio.sleep(0.05)  # the start-up tick
        drains.clear()
        edited_at = time.monotonic()
        aito_quote_sync.request_debounced_sync(7)
        await asyncio.sleep(0.15)
        assert drains == []  # the edit alone drains nothing
        await asyncio.sleep(0.4)
        assert [kind for kind, _ in drains] == ["drain"]
        assert drains[0][1] - edited_at >= 0.3
    finally:
        await _stop(loop_task)


@pytest.mark.asyncio
async def test_a_creation_is_drained_at_once(monkeypatch):
    drains: list = []
    _loop_fakes(monkeypatch, drains)
    monkeypatch.setattr(aito_quote_sync, "CHANGE_PASS_SECONDS", 3600.0)
    loop_task = asyncio.create_task(aito_quote_sync.run_sync_loop())
    try:
        await asyncio.sleep(0.05)
        drains.clear()
        asked_at = time.monotonic()
        aito_quote_sync.request_immediate_sync(7)
        await asyncio.sleep(0.1)
        assert [kind for kind, _ in drains] == ["drain"]
        assert drains[0][1] - asked_at < 0.1
    finally:
        await _stop(loop_task)


@pytest.mark.asyncio
async def test_the_change_pass_runs_on_its_own_cadence_between_ticks(monkeypatch):
    drains: list = []
    _loop_fakes(monkeypatch, drains)
    monkeypatch.setattr(aito_quote_sync, "CHANGE_PASS_SECONDS", 0.2)
    loop_task = asyncio.create_task(aito_quote_sync.run_sync_loop())
    try:
        await asyncio.sleep(0.75)
        kinds = [kind for kind, _ in drains]
        assert kinds[:2] == ["tick", "change"]  # the tick runs one change pass itself
        assert kinds.count("tick") == 1
        assert kinds.count("change") >= 3
    finally:
        await _stop(loop_task)


@pytest.mark.asyncio
async def test_a_low_daily_budget_leaves_the_change_pass_to_the_tick(monkeypatch):
    drains: list = []
    _loop_fakes(monkeypatch, drains)
    monkeypatch.setattr(aito_quote_sync, "CHANGE_PASS_SECONDS", 0.1)
    monkeypatch.setattr(aito_quote_sync.zoho_service, "daily_remaining", 4999, raising=False)
    loop_task = asyncio.create_task(aito_quote_sync.run_sync_loop())
    try:
        await asyncio.sleep(0.5)
        assert [kind for kind, _ in drains].count("change") == 1  # the tick's own
    finally:
        await _stop(loop_task)


@pytest.mark.asyncio
async def test_a_change_pass_does_not_cancel_a_scheduled_fast_retry(monkeypatch):
    """A push failed transiently and its retry is scheduled a moment out. The
    change pass falling due in between is background work: it must not eat
    the retry and leave the card waiting for the next full tick."""
    drains: list = []
    _loop_fakes(monkeypatch, drains)
    monkeypatch.setattr(aito_quote_sync, "FAST_RETRY_DELAYS", (0.35, 0.35, 0.35))
    monkeypatch.setattr(aito_quote_sync, "CHANGE_PASS_SECONDS", 0.1)
    aito_quote_sync._reset_fast_retry_state()
    pending_drains = 0

    async def failing_once(db, pending_only=False, fast_retry=False, attention_only=False):
        nonlocal pending_drains
        if pending_only:
            pending_drains += 1
            drains.append(("retry" if fast_retry else "drain", time.monotonic()))
            if pending_drains == 1:
                aito_quote_sync._note_transient_push_failure()  # what a ReadTimeout on the push does
        aito_push_schedule.drop_due_except(time.monotonic(), keep=set())
        return 1 if pending_only else 0

    monkeypatch.setattr(aito_quote_sync, "run_sync_once", failing_once)
    loop_task = asyncio.create_task(aito_quote_sync.run_sync_loop())
    try:
        await asyncio.sleep(0.05)
        drains.clear()
        aito_quote_sync.request_immediate_sync(7)
        await asyncio.sleep(0.7)
        kinds = [kind for kind, _ in drains]
        assert kinds.count("change") >= 2  # the pass did fall due before the retry
        assert [kind for kind in kinds if kind != "change"] == ["drain", "retry"]
    finally:
        await _stop(loop_task)
        aito_quote_sync._reset_fast_retry_state()


@pytest.mark.asyncio
async def test_a_stale_due_window_cannot_spin_the_loop(monkeypatch):
    # Sync switched off with a due window standing: no drain may run, and the
    # wait must not degrade into a zero-timeout loop.
    drains: list = []
    _loop_fakes(monkeypatch, drains)
    monkeypatch.setattr(aito_quote_sync, "sync_enabled", _always(False))
    monkeypatch.setattr(aito_quote_sync, "CHANGE_PASS_SECONDS", 3600.0)
    laps = 0
    real_wait_for = asyncio.wait_for

    async def counting_wait_for(awaitable, timeout):
        nonlocal laps
        laps += 1
        return await real_wait_for(awaitable, timeout)

    monkeypatch.setattr(aito_quote_sync.asyncio, "wait_for", counting_wait_for)
    loop_task = asyncio.create_task(aito_quote_sync.run_sync_loop())
    try:
        await asyncio.sleep(0.05)
        aito_quote_sync.request_immediate_sync(7)
        await asyncio.sleep(0.3)
        assert drains == []
        assert laps < 10
        assert aito_push_schedule.next_due(time.monotonic()) is None
    finally:
        await _stop(loop_task)
