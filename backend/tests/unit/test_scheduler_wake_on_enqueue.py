"""A queue commit wakes the scheduler instead of waiting out its 30 s sleep."""

import asyncio

import pytest

from backend.app.models.print_queue import PrintQueueItem
from backend.app.services import print_scheduler as ps


@pytest.fixture
async def awake_scheduler():
    ps.scheduler._loop = asyncio.get_running_loop()
    ps.scheduler._wake_event.clear()
    yield ps.scheduler
    ps.scheduler._loop = None
    ps.scheduler._wake_event.clear()


@pytest.mark.asyncio
async def test_queueing_a_job_wakes_the_scheduler(db_session, printer_factory, awake_scheduler):
    printer = await printer_factory()
    db_session.add(PrintQueueItem(printer_id=printer.id, status="pending", position=0))
    await db_session.commit()
    await asyncio.sleep(0)  # wake() is scheduled with call_soon_threadsafe

    assert awake_scheduler._wake_event.is_set()


@pytest.mark.asyncio
async def test_the_schedulers_own_commits_do_not_wake_it(db_session, printer_factory, awake_scheduler):
    printer = await printer_factory()
    token = ps._in_scheduler.set(True)
    try:
        db_session.add(PrintQueueItem(printer_id=printer.id, status="pending", position=0))
        await db_session.commit()
    finally:
        ps._in_scheduler.reset(token)
    await asyncio.sleep(0)

    assert not awake_scheduler._wake_event.is_set()


@pytest.mark.asyncio
async def test_a_rolled_back_change_does_not_wake_it(db_session, printer_factory, awake_scheduler):
    printer = await printer_factory()
    db_session.add(PrintQueueItem(printer_id=printer.id, status="pending", position=0))
    await db_session.flush()
    await db_session.rollback()
    await asyncio.sleep(0)

    assert not awake_scheduler._wake_event.is_set()


@pytest.mark.asyncio
async def test_the_loop_runs_a_pass_as_soon_as_it_is_woken(monkeypatch):
    sched = ps.PrintScheduler()
    passes = 0

    async def check_queue():
        nonlocal passes
        passes += 1
        return False

    async def noop(*_a, **_k):
        return None

    monkeypatch.setattr(sched, "check_queue", check_queue)
    monkeypatch.setattr(sched, "_clear_stale_dispatch_claims", noop)
    monkeypatch.setattr(sched, "_close_stranded_printing_items", noop)
    monkeypatch.setattr(sched, "_sample_chamber_temps", lambda: None)

    task = asyncio.create_task(sched.run())
    try:
        for _ in range(50):
            if passes == 1:
                break
            await asyncio.sleep(0.01)
        sched.wake()
        for _ in range(100):
            if passes == 2:
                break
            await asyncio.sleep(0.01)
        assert passes == 2  # second pass came from wake(), not the 30 s timer
    finally:
        sched._running = False
        task.cancel()
