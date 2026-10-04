"""Per-card push windows through the worker: which pending cards a drain
takes, and what wakes the loop."""

import asyncio
import contextlib
import time

import httpx
import pytest
from sqlalchemy import update

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
async def test_a_card_the_worker_session_already_holds_is_pushed_when_another_session_queues_it(db_session):
    """The worker's session keeps every row it has loaded (expire_on_commit is
    off), and a drain served in the middle of a tick reuses that session. A
    card it read earlier as 'idle' and that a request handler has since
    committed 'pending' must be pushed: read from the session's memory, it
    still looks idle, and the drain used to take its window, release its
    waiter and skip it — leaving it pending with nothing left to push it until
    the next tick, and a Print click hanging its full twenty seconds."""
    card = await _pending(db_session)
    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates"): {"estimates": []},
                ("POST", "/estimates"): CREATED,
                ("GET", "/estimates/NEW"): {"estimate": {**CREATED["estimate"], "line_items": []}},
                ("PUT", "/estimates/NEW"): CREATED,
            },
            seen,
        )
    )
    # The worker's session pushes the card: it now holds it as 'idle'.
    assert await run_sync_once(db_session, pending_only=True) == 1
    assert card.quote_sync_state == "idle"

    # A request handler's commit, through another session: the ROW is pending,
    # the instance the worker session holds is untouched.
    await db_session.execute(
        update(AitoProject)
        .where(AitoProject.id == card.id)
        .values(quote_sync_state="pending")
        .execution_options(synchronize_session=False)
    )
    await db_session.commit()
    aito_push_schedule.note_immediate(card.id, time.monotonic())
    seen.clear()

    assert await run_sync_once(db_session, pending_only=True) == 1

    assert any(method == "PUT" for method, _path, _body in seen)
    await db_session.refresh(card)
    assert card.quote_sync_state == "idle"


@pytest.mark.asyncio
async def test_a_second_push_on_the_same_session_carries_the_edited_task_not_the_one_it_remembers(db_session):
    """Same staleness, one level down: the session that pushed a card holds
    its TASK rows too. An edit committed by a request handler and then pushed
    on that same session (a flush served mid-tick) must send the edited cost,
    not the one the session read for the first push."""
    card = await _pending(db_session)
    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates"): {"estimates": []},
                ("POST", "/estimates"): CREATED,
                ("GET", "/estimates/NEW"): {"estimate": {**CREATED["estimate"], "line_items": []}},
                ("PUT", "/estimates/NEW"): CREATED,
            },
            seen,
        )
    )
    assert await run_sync_once(db_session, pending_only=True) == 1  # scan_cost 5000, tasks now in the session

    # The operator's edit, committed through another session.
    await db_session.execute(
        update(AitoTask)
        .where(AitoTask.project_id == card.id)
        .values(scan_cost=7300)
        .execution_options(synchronize_session=False)
    )
    await db_session.execute(
        update(AitoProject)
        .where(AitoProject.id == card.id)
        .values(quote_sync_state="pending")
        .execution_options(synchronize_session=False)
    )
    await db_session.commit()
    seen.clear()

    assert await run_sync_once(db_session, pending_only=True) == 1

    put = next(body for method, _path, body in seen if method == "PUT" and "line_items" in (body or {}))
    assert [line["rate"] for line in put["line_items"]] == [7300]


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
async def test_a_failing_change_pass_does_not_cost_the_tick_its_other_passes(monkeypatch, caplog):
    """The change pass runs ahead of the invoice, contact, payment-link and
    terminal passes. A failure inside it (a locked database while it stores a
    watermark, a bug) must cost that pass only: left unguarded, every tick
    would stop there and online-payment detection would freeze with it."""
    from backend.app.services import aito_terminal_payments

    drains: list = []
    _loop_fakes(monkeypatch, drains)
    terminal_polled = asyncio.Event()

    async def broken_change_pass(db):
        raise RuntimeError("database is locked")

    async def fake_terminal_poll(db, **_kwargs):
        terminal_polled.set()

    monkeypatch.setattr(aito_quote_sync, "run_change_pass", broken_change_pass)
    monkeypatch.setattr(aito_terminal_payments, "poll_open_terminal_payments", fake_terminal_poll)
    loop_task = asyncio.create_task(aito_quote_sync.run_sync_loop())
    try:
        with caplog.at_level("ERROR"):
            await asyncio.wait_for(terminal_polled.wait(), timeout=5)
        assert "Aito change pass failed" in caplog.text
        assert "Aito quote sync tick failed" not in caplog.text
    finally:
        await _stop(loop_task)


@pytest.mark.asyncio
async def test_a_failing_attention_pass_does_not_cost_the_tick_its_other_passes(monkeypatch, caplog):
    """T-124: the tick's attention pass ran outside any try of its own. An
    error escaping run_sync_once — here its selection query hitting a locked
    database, which no per-card guard covers — fell through to the tick's
    outer handler and skipped the change, invoice, contact, purge, inbox,
    payment-link and terminal passes for the whole interval. It must cost
    that pass only, logged, with the session rolled back."""
    from sqlalchemy.exc import OperationalError

    from backend.app.services import aito_terminal_payments

    drains: list = []
    _loop_fakes(monkeypatch, drains)
    real_run_sync_once = run_sync_once  # the module-level import, not the fake
    rollbacks: list = []
    terminal_polled = asyncio.Event()

    class LockedSession:
        async def execute(self, *args, **kwargs):
            raise OperationalError("SELECT aito_projects", {}, Exception("database is locked"))

        async def rollback(self):
            rollbacks.append(None)

    @contextlib.asynccontextmanager
    async def locked_session():
        yield LockedSession()

    fake_once = aito_quote_sync.run_sync_once  # _loop_fakes' recorder

    async def attention_pass_hits_the_lock(db, pending_only=False, fast_retry=False, attention_only=False):
        if attention_only:
            drains.append(("attention", time.monotonic()))
            return await real_run_sync_once(db, attention_only=True)
        return await fake_once(db, pending_only=pending_only, fast_retry=fast_retry)

    async def fake_terminal_poll(db, **_kwargs):
        terminal_polled.set()

    monkeypatch.setattr(aito_quote_sync, "async_session", locked_session)
    monkeypatch.setattr(aito_quote_sync, "run_sync_once", attention_pass_hits_the_lock)
    monkeypatch.setattr(aito_quote_sync, "CHANGE_PASS_SECONDS", 3600.0)
    monkeypatch.setattr(aito_terminal_payments, "poll_open_terminal_payments", fake_terminal_poll)
    loop_task = asyncio.create_task(aito_quote_sync.run_sync_loop())
    try:
        with caplog.at_level("ERROR"):
            await asyncio.wait_for(terminal_polled.wait(), timeout=5)
        kinds = [kind for kind, _ in drains]
        assert kinds[0] == "attention"
        assert "change" in kinds  # the tick's change pass still ran after the failure
        assert "Aito attention pass failed" in caplog.text
        assert "database is locked" in caplog.text
        assert "Aito quote sync tick failed" not in caplog.text
        assert rollbacks  # the attention pass's half-done work was rolled back
    finally:
        await _stop(loop_task)


@pytest.mark.asyncio
async def test_a_failing_wake_lap_change_pass_keeps_the_windows_that_fell_due_during_it(monkeypatch, caplog):
    """T-156: the wake lap ran the change pass outside any try of its own, so
    its failure reached the lap's handler, which drops every due window. A
    window that closed while the pass was reading Books (an edit's quiet
    period, a Print click's note_immediate) was deleted unpushed, and the card
    waited for the next full tick. It must be drained within the next lap."""
    drains: list = []
    _loop_fakes(monkeypatch, drains)
    monkeypatch.setattr(aito_quote_sync, "CHANGE_PASS_SECONDS", 0.1)
    rollbacks: list = []
    change_passes = 0

    class Session:
        async def rollback(self):
            rollbacks.append(None)

    @contextlib.asynccontextmanager
    async def session():
        yield Session()

    async def change_pass_fails_after_a_window_closes(db):
        nonlocal change_passes
        change_passes += 1
        drains.append(("change", time.monotonic()))
        if change_passes == 2:  # the first wake-lap pass; the tick ran #1
            # What a route's flush_and_wait does while the pass is in flight.
            aito_push_schedule.note_immediate(7, time.monotonic())
            raise RuntimeError("database is locked")
        return 0

    monkeypatch.setattr(aito_quote_sync, "async_session", session)
    monkeypatch.setattr(aito_quote_sync, "run_change_pass", change_pass_fails_after_a_window_closes)
    loop_task = asyncio.create_task(aito_quote_sync.run_sync_loop())
    try:
        with caplog.at_level("ERROR"):
            # The tick is 300 s away: a drain inside this wait can only be the
            # lap serving the window the failed pass left standing.
            deadline = time.monotonic() + 3
            while "drain" not in [kind for kind, _ in drains] and time.monotonic() < deadline:
                await asyncio.sleep(0.02)
        kinds = [kind for kind, _ in drains]
        assert kinds[:3] == ["tick", "change", "change"]
        assert "drain" in kinds[3:]  # the window closed mid-pass was served, not dropped
        assert "Aito change pass failed" in caplog.text
        assert "Aito quote sync wake drain failed" not in caplog.text
        assert rollbacks
        assert not loop_task.done()
    finally:
        await _stop(loop_task)


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


@pytest.mark.asyncio
@pytest.mark.parametrize("serving", [True, False])
async def test_the_tick_hands_its_serve_to_the_heimdall_passes_only_while_serving(monkeypatch, serving):
    """T-157: the payment-link and terminal passes get the loop's own
    `_serve_due_pushes`, so pushes land between their Heimdall calls — and
    nothing at all when sync is off, like every other serve on the tick."""
    from backend.app.services import aito_payment_links, aito_terminal_payments

    drains: list = []
    _loop_fakes(monkeypatch, drains)
    monkeypatch.setattr(aito_quote_sync, "sync_enabled", _always(serving))
    monkeypatch.setattr(aito_quote_sync, "CHANGE_PASS_SECONDS", 3600.0)
    handed: dict = {}
    terminal_polled = asyncio.Event()

    async def fake_reconcile(db, **kwargs):
        handed["reconcile_payment_links"] = kwargs.get("serve_due_pushes", "missing")

    async def fake_terminal_poll(db, **kwargs):
        handed["poll_open_terminal_payments"] = kwargs.get("serve_due_pushes", "missing")
        terminal_polled.set()

    monkeypatch.setattr(aito_payment_links, "reconcile_payment_links", fake_reconcile)
    monkeypatch.setattr(aito_terminal_payments, "poll_open_terminal_payments", fake_terminal_poll)
    loop_task = asyncio.create_task(aito_quote_sync.run_sync_loop())
    try:
        await asyncio.wait_for(terminal_polled.wait(), timeout=5)
        expected = aito_quote_sync._serve_due_pushes if serving else None
        assert handed == {"reconcile_payment_links": expected, "poll_open_terminal_payments": expected}
    finally:
        await _stop(loop_task)
