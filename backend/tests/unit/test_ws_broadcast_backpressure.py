"""Regression tests for T-020: ConnectionManager.broadcast() must not let a
wedged client's TCP backpressure stall delivery to everyone else, or block
connect()/disconnect() from acquiring the shared lock.

Prior to the fix, broadcast() awaited each ``connection.send_text()``
serially *inside* ``async with self._lock``. A never-returning send_text
(sleeping laptop, dead cell link) would therefore:
  - never let later clients in the loop receive the broadcast at all
    (the loop body never advances past the stuck ``await``), and
  - hold the lock open for the whole stall, blocking connect()/disconnect().

These tests fail against that old implementation (verified: reverting
broadcast() to the serial loop-under-lock times out test 1 and deadlocks
test 4) and pass against the fan-out-with-timeout fix.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from backend.app.core.websocket import ConnectionManager


class _NeverReturningConn:
    """A connection whose send_text hangs forever (simulates a wedged
    socket stuck behind TCP backpressure)."""

    def __init__(self):
        self.state = SimpleNamespace()
        self.started = False

    async def send_text(self, data: str) -> None:
        self.started = True
        await asyncio.Event().wait()  # never resolves on its own


class _FastConn:
    """A connection that receives instantly."""

    def __init__(self):
        self.state = SimpleNamespace()
        self.received: str | None = None

    async def send_text(self, data: str) -> None:
        self.received = data


class _RaisingConn:
    """A connection whose send raises immediately (e.g. a closed socket)."""

    def __init__(self):
        self.state = SimpleNamespace()

    async def send_text(self, data: str) -> None:
        raise RuntimeError("socket closed")


class _NeverReturningConnWithClose(_NeverReturningConn):
    """Same as ``_NeverReturningConn``, plus a normal (non-hanging) mocked
    ``close()`` so T-041 eviction-close tests can assert on it."""

    def __init__(self):
        super().__init__()
        self.close = AsyncMock()


class _FastConnWithClose(_FastConn):
    """Same as ``_FastConn``, plus a mocked ``close()`` used to assert a
    healthy connection is never closed by eviction."""

    def __init__(self):
        super().__init__()
        self.close = AsyncMock()


class _HangingCloseConn:
    """(T-041) A connection whose ``send_text`` fails immediately — so
    ``_fan_out`` evicts it right away — but whose ``close()`` itself never
    returns on its own, simulating a socket wedged badly enough that even
    tearing it down cleanly can't complete."""

    def __init__(self):
        self.state = SimpleNamespace()
        self.close_started = False

    async def send_text(self, data: str) -> None:
        raise RuntimeError("socket closed")

    async def close(self, code: int | None = None) -> None:
        self.close_started = True
        await asyncio.Event().wait()  # never resolves on its own


class _RaisingCloseConn:
    """(T-041) A connection that is evicted normally but whose ``close()``
    itself raises — e.g. the peer already tore the transport down."""

    def __init__(self):
        self.state = SimpleNamespace()

    async def send_text(self, data: str) -> None:
        raise RuntimeError("socket closed")

    async def close(self, code: int | None = None) -> None:
        raise RuntimeError("already closed")


async def _drain_pending_eviction_closes(mgr: ConnectionManager, timeout: float = 2.0) -> None:
    """Wait for any eviction-close background tasks _fan_out fired to
    actually finish running, without relying on a fixed sleep. Tasks are
    created synchronously inside _fan_out, so they already exist in
    ``_pending_eviction_closes`` (if not already run-to-completion and
    discarded) by the time the triggering broadcast()/broadcast_aito()
    call returns."""
    pending = list(mgr._pending_eviction_closes)
    if pending:
        await asyncio.wait_for(asyncio.gather(*pending, return_exceptions=True), timeout=timeout)


@pytest.mark.asyncio
async def test_slow_client_does_not_block_delivery_to_other_clients():
    """Core bug: a client stuck behind backpressure must not prevent other
    clients from receiving the broadcast."""
    mgr = ConnectionManager()
    mgr._BROADCAST_SEND_TIMEOUT = 0.1
    slow = _NeverReturningConn()
    fast = _FastConn()
    mgr.active_connections = [slow, fast]

    # Bounded well above the send timeout so a regression (serial-under-lock)
    # fails loudly instead of hanging the suite.
    await asyncio.wait_for(mgr.broadcast({"type": "printer_status"}), timeout=2.0)

    assert slow.started is True  # the wedged send was attempted
    assert fast.received is not None
    assert json.loads(fast.received) == {"type": "printer_status"}


@pytest.mark.asyncio
async def test_client_exceeding_timeout_is_removed_from_active_connections():
    mgr = ConnectionManager()
    mgr._BROADCAST_SEND_TIMEOUT = 0.05
    slow = _NeverReturningConn()
    fast = _FastConn()
    mgr.active_connections = [slow, fast]

    await asyncio.wait_for(mgr.broadcast({"type": "printer_status"}), timeout=2.0)

    assert slow not in mgr.active_connections
    assert fast in mgr.active_connections


@pytest.mark.asyncio
async def test_one_failing_client_does_not_stop_others():
    """return_exceptions=True path: an immediately-raising send must not
    cancel the fan-out to healthy connections."""
    mgr = ConnectionManager()
    bad = _RaisingConn()
    good = _FastConn()
    mgr.active_connections = [bad, good]

    await asyncio.wait_for(mgr.broadcast({"type": "print_complete"}), timeout=2.0)

    assert bad not in mgr.active_connections
    assert good in mgr.active_connections
    assert json.loads(good.received) == {"type": "print_complete"}


@pytest.mark.asyncio
async def test_lock_is_not_held_across_sends_connect_proceeds_during_broadcast():
    """While a broadcast is stalled on a wedged client's send, connect()
    must still be able to acquire the lock and register a new socket —
    proving the lock is released before the I/O, not held across it."""
    mgr = ConnectionManager()
    mgr._BROADCAST_SEND_TIMEOUT = 1.0  # long enough that connect() would
    # visibly hang under the old lock-held-across-I/O behavior
    slow = _NeverReturningConn()
    mgr.active_connections = [slow]

    broadcast_task = asyncio.create_task(mgr.broadcast({"type": "printer_status"}))

    # Let the broadcast task run far enough to enter the (slow) I/O phase.
    for _ in range(5):
        await asyncio.sleep(0)
    assert slow.started is True

    new_conn = SimpleNamespace(state=SimpleNamespace(), accept=None)

    async def _accept():
        return None

    new_conn.accept = _accept

    # connect() must return well before the 1.0s send timeout if the lock
    # was released before the I/O.
    await asyncio.wait_for(mgr.connect(new_conn), timeout=0.2)
    assert new_conn in mgr.active_connections

    disconnect_target = SimpleNamespace(state=SimpleNamespace())
    disconnect_target.state.aito_project_id = None
    mgr.active_connections.append(disconnect_target)
    await asyncio.wait_for(mgr.disconnect(disconnect_target), timeout=0.2)
    assert disconnect_target not in mgr.active_connections

    await asyncio.wait_for(broadcast_task, timeout=2.0)


# ---------------------------------------------------------------------------
# T-041: an evicted connection is now also closed (bounded, best-effort),
# outside the lock, so the client's onclose reconnect path actually runs
# instead of parking forever on a socket the server has already given up on.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_timed_out_client_is_closed_with_1011_but_healthy_client_is_not():
    mgr = ConnectionManager()
    mgr._BROADCAST_SEND_TIMEOUT = 0.05
    slow = _NeverReturningConnWithClose()
    fast = _FastConnWithClose()
    mgr.active_connections = [slow, fast]

    await asyncio.wait_for(mgr.broadcast({"type": "printer_status"}), timeout=2.0)
    await _drain_pending_eviction_closes(mgr)

    slow.close.assert_awaited_once_with(code=1011)
    fast.close.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_hanging_close_does_not_block_fan_out_and_is_itself_bounded():
    """The evicted connection's close() itself never returns — _fan_out (and
    therefore broadcast()) must still return promptly because the close is
    fired as a background task, never awaited inline. The background task
    must also not hang forever: it is bounded by _EVICTION_CLOSE_TIMEOUT."""
    mgr = ConnectionManager()
    mgr._EVICTION_CLOSE_TIMEOUT = 0.05
    hanging = _HangingCloseConn()
    mgr.active_connections = [hanging]

    await asyncio.wait_for(mgr.broadcast({"type": "printer_status"}), timeout=1.0)

    assert hanging not in mgr.active_connections

    # Draining the background task must itself complete quickly, proving
    # the internal wait_for(..., timeout=_EVICTION_CLOSE_TIMEOUT) actually
    # cancels the hung close() rather than waiting on it forever.
    await asyncio.wait_for(_drain_pending_eviction_closes(mgr), timeout=1.0)
    assert hanging.close_started is True


@pytest.mark.asyncio
async def test_a_close_that_raises_is_swallowed():
    """close() raising (e.g. the peer already tore the transport down) must
    not propagate out of the background task or affect other connections."""
    mgr = ConnectionManager()
    already_gone = _RaisingCloseConn()
    fast = _FastConnWithClose()
    mgr.active_connections = [already_gone, fast]

    await asyncio.wait_for(mgr.broadcast({"type": "printer_status"}), timeout=2.0)
    # No exception escapes draining, even though close() raised internally.
    await asyncio.wait_for(_drain_pending_eviction_closes(mgr), timeout=2.0)

    assert already_gone not in mgr.active_connections
    assert fast in mgr.active_connections
    assert json.loads(fast.received) == {"type": "printer_status"}


@pytest.mark.asyncio
async def test_disconnect_after_eviction_is_a_no_op():
    """disconnect() may run concurrently for the same socket (the endpoint's
    receive loop unblocking once the eviction close lands, then its own
    except-clause calling ws_manager.disconnect()). Removal must tolerate
    an already-evicted connection instead of raising."""
    mgr = ConnectionManager()
    mgr._BROADCAST_SEND_TIMEOUT = 0.05
    slow = _NeverReturningConnWithClose()
    mgr.active_connections = [slow]

    await asyncio.wait_for(mgr.broadcast({"type": "printer_status"}), timeout=2.0)
    assert slow not in mgr.active_connections

    await asyncio.wait_for(mgr.disconnect(slow), timeout=1.0)
    assert slow not in mgr.active_connections


# ---------------------------------------------------------------------------
# T-042 (folds T-049): broadcast_to_user() now routes through _fan_out too,
# so a wedged client of the target user no longer stalls every other
# broadcast (in particular broadcast_aito(), awaited inline from every
# Aito route handler) behind the manager lock.
# ---------------------------------------------------------------------------


def _stamp_user(conn, user_id: int | None) -> None:
    conn.state.bambuddy_principal_user_id = user_id


@pytest.mark.asyncio
async def test_broadcast_to_user_wedged_target_is_evicted_and_closed_but_other_user_a_conn_still_gets_it():
    mgr = ConnectionManager()
    mgr._BROADCAST_SEND_TIMEOUT = 0.05
    wedged = _NeverReturningConnWithClose()
    _stamp_user(wedged, 7)
    healthy = _FastConnWithClose()
    _stamp_user(healthy, 7)
    mgr.active_connections = [wedged, healthy]

    await asyncio.wait_for(mgr.broadcast_to_user(7, {"type": "queue_item_upload_progress"}), timeout=2.0)
    await _drain_pending_eviction_closes(mgr)

    assert wedged not in mgr.active_connections
    wedged.close.assert_awaited_once_with(code=1011)
    assert healthy in mgr.active_connections
    healthy.close.assert_not_awaited()
    assert json.loads(healthy.received) == {"type": "queue_item_upload_progress"}


@pytest.mark.asyncio
async def test_broadcast_to_user_filter_still_excludes_other_users_and_unstamped_connections():
    mgr = ConnectionManager()
    target = _FastConn()
    _stamp_user(target, 7)
    other_user = _FastConn()
    _stamp_user(other_user, 8)
    unstamped = _FastConn()  # never received bambuddy_principal_user_id at all
    mgr.active_connections = [target, other_user, unstamped]

    await asyncio.wait_for(mgr.broadcast_to_user(7, {"type": "queue_item_acked"}), timeout=2.0)

    assert target.received is not None
    assert other_user.received is None
    assert unstamped.received is None


@pytest.mark.asyncio
async def test_broadcast_to_user_lock_is_not_held_across_the_wedged_send():
    """While a targeted send to user A's wedged socket is stalled,
    connect()/disconnect() of an unrelated socket and a concurrent
    broadcast_aito() must all complete promptly — proving the lock is
    released before the I/O, not held across it (the exact bug T-042
    fixes: previously this send was inline under the lock, so every
    Aito route handler's closing broadcast_aito() would hang behind it)."""
    mgr = ConnectionManager()
    mgr._BROADCAST_SEND_TIMEOUT = 1.0  # long enough that a lock-held
    # regression would visibly hang the assertions below
    wedged = _NeverReturningConn()
    _stamp_user(wedged, 7)
    mgr.active_connections = [wedged]

    task = asyncio.create_task(mgr.broadcast_to_user(7, {"type": "queue_item_upload_progress"}))

    for _ in range(5):
        await asyncio.sleep(0)
    assert wedged.started is True

    new_conn = SimpleNamespace(state=SimpleNamespace(), accept=None)

    async def _accept():
        return None

    new_conn.accept = _accept
    await asyncio.wait_for(mgr.connect(new_conn), timeout=0.2)
    assert new_conn in mgr.active_connections

    disconnect_target = SimpleNamespace(state=SimpleNamespace())
    disconnect_target.state.aito_project_id = None
    mgr.active_connections.append(disconnect_target)
    await asyncio.wait_for(mgr.disconnect(disconnect_target), timeout=0.2)
    assert disconnect_target not in mgr.active_connections

    aito_conn = _FastConn()
    aito_conn.state.aito_read = True
    mgr.active_connections.append(aito_conn)
    await asyncio.wait_for(mgr.broadcast_aito({"type": "aito_changed"}), timeout=0.2)
    assert aito_conn.received is not None

    await asyncio.wait_for(task, timeout=2.0)


@pytest.mark.asyncio
async def test_broadcast_to_user_none_still_fans_out_via_broadcast():
    """Existing behavior, pinned: user_id=None routes through broadcast()
    unfiltered — the auth-disabled single-user path."""
    mgr = ConnectionManager()
    a = _FastConn()
    b = _FastConn()
    mgr.active_connections = [a, b]

    await asyncio.wait_for(mgr.broadcast_to_user(None, {"type": "queue_item_uploading"}), timeout=2.0)

    assert a.received is not None
    assert b.received is not None
