"""Fenrir: say what the event loop was doing whenever it stops turning.

Every request, MQTT callback and background job shares one event loop, so a
single blocking call freezes the whole app for its duration. A second thread
watches a heartbeat the loop refreshes; when the heartbeat goes stale it logs
the loop thread's stack, which names the blocking call.
"""

from __future__ import annotations

import asyncio
import logging
import sys
import threading
import time
import traceback
from collections.abc import Callable

logger = logging.getLogger(__name__)


def start_loop_watchdog(threshold: float = 1.0, interval: float = 0.25) -> Callable[[], None]:
    """Watch the running loop; returns a function that stops the watchdog."""
    loop = asyncio.get_running_loop()
    loop_thread = threading.get_ident()
    stop = threading.Event()
    beat = time.monotonic()

    def tick() -> None:
        nonlocal beat
        beat = time.monotonic()
        if not stop.is_set():
            loop.call_later(interval, tick)

    def watch() -> None:
        reported: float | None = None  # the heartbeat a stall was reported for
        while not stop.wait(interval):
            last = beat
            if reported is not None and last != reported:
                logger.warning("Event loop resumed after being blocked for %.1fs", last - reported)
                reported = None
            if reported is None and time.monotonic() - last >= threshold:
                reported = last
                frame = sys._current_frames().get(loop_thread)
                stack = "".join(traceback.format_stack(frame, limit=25)) if frame else "<no stack>\n"
                logger.warning("Event loop blocked for over %.1fs, currently in:\n%s", threshold, stack)

    tick()
    threading.Thread(target=watch, name="loop-watchdog", daemon=True).start()
    return stop.set
