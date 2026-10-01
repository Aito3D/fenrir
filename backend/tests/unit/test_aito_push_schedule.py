"""Per-card push windows: quiet period, ceiling, immediacy, waiters."""

import asyncio

import pytest

from backend.app.services import aito_push_schedule as schedule


@pytest.fixture(autouse=True)
def clean_schedule():
    schedule.reset()
    yield
    schedule.reset()


def test_a_card_with_no_window_is_due():
    # After a restart the row is pending in the database and memory is empty:
    # nothing to wait for.
    assert schedule.is_due(7, now=100.0) is True
    assert schedule.any_due(100.0) is False
    assert schedule.next_due(100.0) is None


def test_an_edit_opens_a_quiet_period():
    schedule.note_edit(7, now=100.0)
    assert schedule.is_due(7, now=109.9) is False
    assert schedule.is_due(7, now=110.0) is True
    assert schedule.next_due(103.0) == pytest.approx(7.0)


def test_each_further_edit_restarts_the_quiet_period():
    schedule.note_edit(7, now=100.0)
    schedule.note_edit(7, now=108.0)
    assert schedule.is_due(7, now=110.0) is False
    assert schedule.is_due(7, now=118.0) is True


def test_the_ceiling_bounds_a_card_that_never_goes_quiet():
    for second in range(100, 150, 5):  # an edit every 5 s for 50 s
        schedule.note_edit(7, now=float(second))
    assert schedule.is_due(7, now=144.9) is False
    assert schedule.is_due(7, now=145.0) is True  # first edit + 45 s


def test_windows_are_per_card():
    schedule.note_edit(7, now=100.0)
    schedule.note_edit(8, now=105.0)
    assert schedule.is_due(7, now=110.0) is True
    assert schedule.is_due(8, now=110.0) is False
    assert schedule.any_due(110.0) is True
    assert schedule.next_due(110.0) == 0.0


def test_immediate_is_due_now_and_a_later_edit_does_not_delay_it():
    schedule.note_edit(7, now=100.0)
    schedule.note_immediate(7, now=101.0)
    assert schedule.is_due(7, now=101.0) is True
    schedule.note_edit(7, now=102.0)
    assert schedule.is_due(7, now=102.0) is True


def test_take_then_edit_opens_a_fresh_window():
    # The drain takes the window before it pushes; an edit that lands during
    # the push must get its own full quiet period, not be lost, and not be
    # pushed on the spot.
    schedule.note_immediate(7, now=100.0)
    schedule.take(7)
    schedule.note_edit(7, now=101.0)
    assert schedule.is_due(7, now=101.0) is False
    assert schedule.is_due(7, now=111.0) is True


def test_a_due_window_for_a_card_that_is_no_longer_pending_is_dropped():
    schedule.note_immediate(7, now=100.0)  # stale: the card is not pending any more
    schedule.note_immediate(8, now=100.0)
    schedule.note_edit(9, now=100.0)  # not due yet: untouched
    schedule.drop_due_except(100.0, keep={8})
    assert schedule.next_due(100.0) == 0.0  # card 8 is still due
    schedule.take(8)
    assert schedule.any_due(100.0) is False
    assert schedule.next_due(100.0) == pytest.approx(10.0)  # only card 9's window is left


@pytest.mark.asyncio
async def test_every_waiter_of_a_card_is_resolved():
    first = schedule.add_waiter(7)
    second = schedule.add_waiter(7)
    other = schedule.add_waiter(8)
    assert schedule.has_waiter(7) is True

    schedule.resolve(7)
    await asyncio.wait_for(asyncio.gather(first, second), timeout=1)

    assert schedule.has_waiter(7) is False
    assert not other.done()


@pytest.mark.asyncio
async def test_a_discarded_waiter_is_forgotten_and_resolve_tolerates_it():
    waiter = schedule.add_waiter(7)
    schedule.discard_waiter(7, waiter)
    assert schedule.has_waiter(7) is False
    schedule.resolve(7)  # nothing to resolve: must not raise
    waiter.cancel()
    schedule.discard_waiter(7, waiter)  # twice: must not raise


@pytest.mark.asyncio
async def test_waiting_ids_lists_the_cards_with_a_waiter():
    schedule.add_waiter(7)
    schedule.add_waiter(9)
    assert sorted(schedule.waiting_ids()) == [7, 9]
