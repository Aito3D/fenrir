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
