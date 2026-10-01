"""When each Aito card's pending push is due, and who is waiting for it.

The outbox itself is the database: a card is pushed because its row says
``quote_sync_state == 'pending'``. This module only answers WHEN — the
per-card quiet period an edit opens, and the "now" a creation, a panel close
or a Print click asks for — and holds the futures a route awaits while its
card is pushed (``aito_quote_sync.flush_and_wait``).

Process-local and memory only, on purpose: a restart forgets every window,
and a pending card with no window is simply due (``is_due``), which is the
recovery the worker always had. Pure: the caller passes ``time.monotonic()``
readings in, so the tests need no clock patching. Safe without a lock for
the same reason as the worker's other memos: every caller runs on the one
event loop and none awaits between reading and writing.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

# How long a card must go without a further edit before its push runs. Ten
# seconds is well above a human's typing cadence, so an ordinary edit session
# lands as one PUT.
EDIT_QUIET_SECONDS = 10.0
# The longest any edit waits, however busy the card stays: without it an
# operator who keeps typing would starve the push indefinitely.
EDIT_MAX_WAIT_SECONDS = 45.0


@dataclass
class _Window:
    opened_at: float
    due_at: float
    # Set by note_immediate: a later edit must not push the due time back out.
    immediate: bool = False


_windows: dict[int, _Window] = {}
_waiters: dict[int, list[asyncio.Future[None]]] = {}


def note_edit(project_id: int, now: float) -> None:
    """An edit to this card was committed: open its window or extend it."""
    window = _windows.get(project_id)
    if window is None:
        _windows[project_id] = _Window(opened_at=now, due_at=now + EDIT_QUIET_SECONDS)
    elif not window.immediate:
        window.due_at = min(now + EDIT_QUIET_SECONDS, window.opened_at + EDIT_MAX_WAIT_SECONDS)


def note_immediate(project_id: int, now: float) -> None:
    """This card is wanted in Books now (creation, panel close, a flush)."""
    window = _windows.get(project_id)
    _windows[project_id] = _Window(opened_at=window.opened_at if window else now, due_at=now, immediate=True)


def is_due(project_id: int, now: float) -> bool:
    window = _windows.get(project_id)
    return window is None or window.due_at <= now


def any_due(now: float) -> bool:
    return any(window.due_at <= now for window in _windows.values())


def next_due(now: float) -> float | None:
    """Seconds until the earliest window closes (0.0 when one already has),
    or None when no window is open."""
    if not _windows:
        return None
    return max(0.0, min(window.due_at for window in _windows.values()) - now)


def take(project_id: int) -> None:
    """The drain is about to push this card: its window is spent. Taken
    BEFORE the push so an edit that lands during it opens a fresh one."""
    _windows.pop(project_id, None)


def drop_due_except(now: float, keep: set[int]) -> None:
    """Forget every due window whose card is not in ``keep``. A window left
    standing for a card that is no longer pending would keep ``next_due`` at
    zero and spin the worker's wait."""
    for project_id in [pid for pid, window in _windows.items() if window.due_at <= now and pid not in keep]:
        del _windows[project_id]


def add_waiter(project_id: int) -> asyncio.Future[None]:
    waiter: asyncio.Future[None] = asyncio.get_running_loop().create_future()
    _waiters.setdefault(project_id, []).append(waiter)
    return waiter


def has_waiter(project_id: int) -> bool:
    return bool(_waiters.get(project_id))


def waiting_ids() -> list[int]:
    """The cards somebody is waiting on, as a snapshot safe to iterate while
    resolving."""
    return list(_waiters)


def resolve(project_id: int) -> None:
    """This card's push attempt has been committed, whatever it concluded."""
    for waiter in _waiters.pop(project_id, []):
        if not waiter.done():
            waiter.set_result(None)


def discard_waiter(project_id: int, waiter: asyncio.Future[None]) -> None:
    remaining = [w for w in _waiters.get(project_id, []) if w is not waiter]
    if remaining:
        _waiters[project_id] = remaining
    else:
        _waiters.pop(project_id, None)


def reset() -> None:
    """Test seam."""
    _windows.clear()
    _waiters.clear()
