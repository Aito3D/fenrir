"""The loop watchdog names the call that blocked the event loop."""

import asyncio
import logging
import time

import pytest

from backend.app.core.loop_watchdog import start_loop_watchdog


def _block_the_loop(seconds: float) -> None:
    time.sleep(seconds)


@pytest.mark.asyncio
async def test_a_blocking_call_is_logged_with_its_stack(caplog):
    caplog.set_level(logging.WARNING, logger="backend.app.core.loop_watchdog")
    stop = start_loop_watchdog(threshold=0.2, interval=0.05)
    try:
        await asyncio.sleep(0)  # let the first heartbeat land
        _block_the_loop(1.0)
        await asyncio.sleep(0.3)  # let the heartbeat run again
    finally:
        stop()

    messages = [r.getMessage() for r in caplog.records]
    # Not an exact count: a loaded test machine can stall the loop on its own.
    assert any("Event loop blocked" in m and "_block_the_loop" in m for m in messages)
    assert any("Event loop resumed" in m for m in messages)
