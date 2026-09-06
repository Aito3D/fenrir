"""T-038: filter Aito WebSocket fan-out (``aito_changed`` / ``aito_presence_state``)
by ``Permission.AITO_READ`` (audit-security, user-approved behavior change).

Two layers pinned here:

1. ``_resolve_principal_and_aito_read`` (``routes/websocket.py``) — the
   connect-time permission resolution that decides ``websocket.state.aito_read``.
2. ``ConnectionManager.broadcast_aito`` (``core/websocket.py``) — the filtered
   fan-out both ``aito_changed`` and ``aito_presence_state`` now go through,
   instead of the unfiltered ``broadcast()`` every other feature still uses.

A third group of tests drives the real ``websocket_endpoint`` end-to-end
against a throwaway ``ConnectionManager`` instance (never the global
``ws_manager`` singleton — matching every other websocket test in this repo)
to prove the initial presence-state send is actually gated on the stamped
flag, not just that the flag itself computes correctly in isolation.

A fourth group (T-011, also user-approved) drives the same end-to-end
harness with an inbound ``aito_presence`` message, proving the handler
itself — not just the initial send — is gated on ``aito_read``.

A fifth group (T-028, also user-approved) pins ``broadcast_aito``'s
backpressure handling — it now shares ``ConnectionManager._fan_out`` with
``broadcast()``, so a wedged/slow client is dropped after
``_BROADCAST_SEND_TIMEOUT`` instead of stalling every other client and the
manager lock.

A sixth group (T-030, also user-approved) proves the ``aito_read`` stamp
happens *before* ``ws_manager.connect()`` admits the socket into
``active_connections`` — not, as before, in the window after — using a
``ConnectionManager`` subclass that records the state at the moment
``connect()`` is entered.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import WebSocketDisconnect
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.api.routes import websocket as ws_route
from backend.app.core.permissions import Permission
from backend.app.core.websocket import ConnectionManager
from backend.app.models.group import Group
from backend.app.models.user import User

# ---------------------------------------------------------------------------
# Layer 1: ConnectionManager.broadcast_aito (core/websocket.py)
# ---------------------------------------------------------------------------


def _conn(aito_read: bool | None = True, *, stamped: bool = True):
    """A stand-in WebSocket-shaped object, matching the ``_conn`` helpers in
    ``test_ws_aito_presence.py`` / ``test_ws_broadcast_to_user.py``."""
    conn = SimpleNamespace()
    conn.state = SimpleNamespace(aito_read=aito_read) if stamped else SimpleNamespace()
    conn.send_text = AsyncMock()
    return conn


@pytest.mark.asyncio
async def test_broadcast_aito_skips_a_connection_without_aito_read():
    mgr = ConnectionManager()
    reader, denied = _conn(True), _conn(False)
    mgr.active_connections = [reader, denied]

    await mgr.broadcast_aito({"type": "aito_changed", "action": "create", "project_id": 1, "actor": "paul"})

    reader.send_text.assert_awaited_once()
    denied.send_text.assert_not_awaited()


@pytest.mark.asyncio
async def test_broadcast_aito_delivers_the_presence_map_to_a_reader():
    mgr = ConnectionManager()
    reader = _conn(True)
    mgr.active_connections = [reader]

    await mgr.broadcast_aito({"type": "aito_presence_state", "viewers": {"3": ["paul"]}})

    reader.send_text.assert_awaited_once()


@pytest.mark.asyncio
async def test_broadcast_aito_defaults_to_false_for_a_never_stamped_connection():
    """T-030: ``routes/websocket.py`` now stamps ``aito_read`` before
    ``connect()`` ever admits the socket, so an unstamped connection should
    never reach ``active_connections`` in practice — but the default must
    fail CLOSED, not open, on a connection that somehow gets there anyway
    (e.g. unrelated code elsewhere stamping nothing)."""
    mgr = ConnectionManager()
    unstamped = _conn(stamped=False)
    mgr.active_connections = [unstamped]

    await mgr.broadcast_aito({"type": "aito_changed", "action": "move", "project_id": 2, "actor": None})

    unstamped.send_text.assert_not_awaited()


@pytest.mark.asyncio
async def test_non_aito_broadcast_still_reaches_a_connection_without_aito_read():
    """The filter is scoped to broadcast_aito only. Every other broadcast —
    printer status, print start/complete, archive events, queue toasts,
    spool warnings — keeps calling the unfiltered broadcast() and must stay
    completely untouched by this fix, even for a connection that has no
    Aito authority at all."""
    mgr = ConnectionManager()
    denied = _conn(False)
    mgr.active_connections = [denied]

    await mgr.send_printer_status(1, {"state": "RUNNING"})

    denied.send_text.assert_awaited_once()


# ---------------------------------------------------------------------------
# Layer 1b (T-028): broadcast_aito fans out outside the lock, timeout-bounded
#
# Mirrors test_ws_broadcast_backpressure.py's coverage of broadcast() —
# broadcast_aito() now shares the same _fan_out helper and must behave
# identically: a wedged client is dropped after _BROADCAST_SEND_TIMEOUT
# without blocking delivery to other clients or the manager lock.
# ---------------------------------------------------------------------------


class _NeverReturningConn:
    """A permitted (``aito_read=True``) connection whose ``send_text`` hangs
    forever, simulating a wedged socket stuck behind TCP backpressure."""

    def __init__(self):
        self.state = SimpleNamespace(aito_read=True)
        self.started = False

    async def send_text(self, data: str) -> None:
        self.started = True
        await asyncio.Event().wait()  # never resolves on its own


class _RaisingConn:
    """A permitted connection whose send raises immediately (closed socket)."""

    def __init__(self):
        self.state = SimpleNamespace(aito_read=True)

    async def send_text(self, data: str) -> None:
        raise RuntimeError("socket closed")


@pytest.mark.asyncio
async def test_broadcast_aito_drops_a_wedged_client_but_still_delivers_to_others():
    mgr = ConnectionManager()
    mgr._BROADCAST_SEND_TIMEOUT = 0.05
    slow = _NeverReturningConn()
    fast = _conn(True)
    mgr.active_connections = [slow, fast]

    await asyncio.wait_for(
        mgr.broadcast_aito({"type": "aito_changed", "action": "create", "project_id": 1, "actor": "paul"}),
        timeout=2.0,
    )

    assert slow.started is True  # the wedged send was attempted
    assert slow not in mgr.active_connections
    fast.send_text.assert_awaited_once()
    assert fast in mgr.active_connections


@pytest.mark.asyncio
async def test_broadcast_aito_lock_is_not_held_across_sends():
    """While broadcast_aito is stalled on a wedged client's send, connect()
    and disconnect() must still be able to acquire the manager lock — proving
    the lock is released before the I/O, not held across it (the exact bug
    T-028 fixes)."""
    mgr = ConnectionManager()
    mgr._BROADCAST_SEND_TIMEOUT = 1.0  # long enough that connect()/disconnect()
    # would visibly hang under the old lock-held-across-I/O behavior
    slow = _NeverReturningConn()
    mgr.active_connections = [slow]

    broadcast_task = asyncio.create_task(
        mgr.broadcast_aito({"type": "aito_changed", "action": "create", "project_id": 1, "actor": "paul"})
    )

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


@pytest.mark.asyncio
async def test_broadcast_aito_one_failing_client_does_not_stop_others():
    mgr = ConnectionManager()
    bad = _RaisingConn()
    good = _conn(True)
    mgr.active_connections = [bad, good]

    await asyncio.wait_for(
        mgr.broadcast_aito({"type": "aito_changed", "action": "create", "project_id": 1, "actor": "paul"}),
        timeout=2.0,
    )

    assert bad not in mgr.active_connections
    assert good in mgr.active_connections
    good.send_text.assert_awaited_once()


# ---------------------------------------------------------------------------
# Layer 2: _resolve_principal_and_aito_read (routes/websocket.py)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolve_denies_a_user_without_aito_read(db_session):
    group = Group(name="T038-no-read", permissions=[])
    user = User(username="viewer-t038", groups=[group])
    db_session.add_all([group, user])
    await db_session.commit()

    user_id, aito_read = await ws_route._resolve_principal_and_aito_read("viewer-t038", db_session)

    assert user_id == user.id
    assert aito_read is False


@pytest.mark.asyncio
async def test_resolve_allows_a_user_with_aito_read(db_session):
    group = Group(name="T038-readers", permissions=[Permission.AITO_READ.value])
    user = User(username="reader-t038", groups=[group])
    db_session.add_all([group, user])
    await db_session.commit()

    user_id, aito_read = await ws_route._resolve_principal_and_aito_read("reader-t038", db_session)

    assert user_id == user.id
    assert aito_read is True


@pytest.mark.asyncio
async def test_resolve_allows_an_admin_with_no_explicit_aito_permission(db_session):
    """User.has_permission's is_admin short-circuit must keep admins seeing
    everything, with no group grant needed."""
    admin = User(username="admin-t038", role="admin")
    db_session.add(admin)
    await db_session.commit()

    user_id, aito_read = await ws_route._resolve_principal_and_aito_read("admin-t038", db_session)

    assert user_id == admin.id
    assert aito_read is True


@pytest.mark.asyncio
async def test_resolve_fails_closed_for_a_principal_with_no_matching_user(db_session):
    """A username that no longer resolves (e.g. deleted after the token was
    minted) gets no benefit of the doubt."""
    user_id, aito_read = await ws_route._resolve_principal_and_aito_read("ghost-t038", db_session)

    assert user_id is None
    assert aito_read is False


# ---------------------------------------------------------------------------
# Layer 3: the real connect handler, end to end (isolated ConnectionManager)
# ---------------------------------------------------------------------------


class _FakeWebSocket:
    """Just enough of the WebSocket surface websocket_endpoint touches."""

    def __init__(self):
        self.state = SimpleNamespace()
        self.accept = AsyncMock()
        self.close = AsyncMock()
        self.send_json = AsyncMock()

    async def receive_json(self):
        # Simulate an immediate disconnect right after connect — the
        # endpoint's own except-clause handles this and tears the
        # connection down cleanly.
        raise WebSocketDisconnect()


def _sent_types(fake_ws: _FakeWebSocket) -> list[str | None]:
    return [call.args[0].get("type") for call in fake_ws.send_json.await_args_list]


@pytest.mark.asyncio
async def test_connect_withholds_the_initial_presence_map_without_aito_read(monkeypatch, test_engine):
    session_maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with session_maker() as seed:
        group = Group(name="T038-endpoint-no-read", permissions=[])
        seed.add(group)
        seed.add(User(username="endpoint-denied", groups=[group]))
        await seed.commit()

    fresh_mgr = ConnectionManager()
    monkeypatch.setattr(ws_route, "ws_manager", fresh_mgr)
    monkeypatch.setattr(ws_route, "async_session", session_maker)
    monkeypatch.setattr(ws_route, "is_auth_enabled", AsyncMock(return_value=True))
    monkeypatch.setattr(ws_route, "verify_websocket_token", AsyncMock(return_value="endpoint-denied"))

    ws = _FakeWebSocket()
    await ws_route.websocket_endpoint(ws, token="tok")

    assert ws.state.aito_read is False
    assert "aito_presence_state" not in _sent_types(ws)


@pytest.mark.asyncio
async def test_connect_sends_the_initial_presence_map_with_aito_read(monkeypatch, test_engine):
    session_maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with session_maker() as seed:
        group = Group(name="T038-endpoint-read", permissions=[Permission.AITO_READ.value])
        seed.add(group)
        seed.add(User(username="endpoint-allowed", groups=[group]))
        await seed.commit()

    fresh_mgr = ConnectionManager()
    monkeypatch.setattr(ws_route, "ws_manager", fresh_mgr)
    monkeypatch.setattr(ws_route, "async_session", session_maker)
    monkeypatch.setattr(ws_route, "is_auth_enabled", AsyncMock(return_value=True))
    monkeypatch.setattr(ws_route, "verify_websocket_token", AsyncMock(return_value="endpoint-allowed"))

    ws = _FakeWebSocket()
    await ws_route.websocket_endpoint(ws, token="tok")

    assert ws.state.aito_read is True
    assert "aito_presence_state" in _sent_types(ws)


@pytest.mark.asyncio
async def test_connect_sends_the_initial_presence_map_for_an_admin(monkeypatch, test_engine):
    session_maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with session_maker() as seed:
        seed.add(User(username="endpoint-admin", role="admin"))
        await seed.commit()

    fresh_mgr = ConnectionManager()
    monkeypatch.setattr(ws_route, "ws_manager", fresh_mgr)
    monkeypatch.setattr(ws_route, "async_session", session_maker)
    monkeypatch.setattr(ws_route, "is_auth_enabled", AsyncMock(return_value=True))
    monkeypatch.setattr(ws_route, "verify_websocket_token", AsyncMock(return_value="endpoint-admin"))

    ws = _FakeWebSocket()
    await ws_route.websocket_endpoint(ws, token="tok")

    assert ws.state.aito_read is True
    assert "aito_presence_state" in _sent_types(ws)


@pytest.mark.asyncio
async def test_connect_sends_everything_when_auth_is_disabled(monkeypatch, test_engine):
    """Auth-disabled installs must not start filtering anything — nobody's
    principal is ever verified there, so ``verify_websocket_token`` is never
    even called, and the presence map goes out exactly as it did before
    this fix."""
    session_maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    fresh_mgr = ConnectionManager()
    monkeypatch.setattr(ws_route, "ws_manager", fresh_mgr)
    monkeypatch.setattr(ws_route, "async_session", session_maker)
    monkeypatch.setattr(ws_route, "is_auth_enabled", AsyncMock(return_value=False))
    verify_spy = AsyncMock()
    monkeypatch.setattr(ws_route, "verify_websocket_token", verify_spy)

    ws = _FakeWebSocket()
    await ws_route.websocket_endpoint(ws, token=None)

    verify_spy.assert_not_awaited()
    assert ws.state.aito_read is True
    assert "aito_presence_state" in _sent_types(ws)


# ---------------------------------------------------------------------------
# Layer 3b (T-030): aito_read is stamped BEFORE ws_manager.connect() admits
# the socket into active_connections, not after — closing the connect-time
# window broadcast_aito() used to rely on its fail-open default to cover.
# ---------------------------------------------------------------------------


class _RecordingConnectManager(ConnectionManager):
    """A real ``ConnectionManager`` whose ``connect()`` records whatever
    ``websocket.state.aito_read`` holds *at the moment connect() is called*
    — ``"UNSET"`` if the attribute does not exist yet — before doing the
    real accept/register work. This is the only way to observe ordering:
    reading the state after ``websocket_endpoint`` returns cannot tell you
    whether the stamp happened before or after admission."""

    def __init__(self):
        super().__init__()
        self.aito_read_at_connect: list[bool | str] = []

    async def connect(self, websocket):
        self.aito_read_at_connect.append(getattr(websocket.state, "aito_read", "UNSET"))
        await super().connect(websocket)


@pytest.mark.asyncio
async def test_connect_stamps_aito_read_before_admitting_an_allowed_principal(monkeypatch, test_engine):
    session_maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with session_maker() as seed:
        group = Group(name="T030-allowed", permissions=[Permission.AITO_READ.value])
        seed.add(group)
        seed.add(User(username="t030-allowed", groups=[group]))
        await seed.commit()

    fresh_mgr = _RecordingConnectManager()
    monkeypatch.setattr(ws_route, "ws_manager", fresh_mgr)
    monkeypatch.setattr(ws_route, "async_session", session_maker)
    monkeypatch.setattr(ws_route, "is_auth_enabled", AsyncMock(return_value=True))
    monkeypatch.setattr(ws_route, "verify_websocket_token", AsyncMock(return_value="t030-allowed"))

    ws = _FakeWebSocket()
    await ws_route.websocket_endpoint(ws, token="tok")

    assert fresh_mgr.aito_read_at_connect == [True]


@pytest.mark.asyncio
async def test_connect_stamps_aito_read_before_admitting_a_denied_principal(monkeypatch, test_engine):
    session_maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with session_maker() as seed:
        group = Group(name="T030-denied", permissions=[])
        seed.add(group)
        seed.add(User(username="t030-denied", groups=[group]))
        await seed.commit()

    fresh_mgr = _RecordingConnectManager()
    monkeypatch.setattr(ws_route, "ws_manager", fresh_mgr)
    monkeypatch.setattr(ws_route, "async_session", session_maker)
    monkeypatch.setattr(ws_route, "is_auth_enabled", AsyncMock(return_value=True))
    monkeypatch.setattr(ws_route, "verify_websocket_token", AsyncMock(return_value="t030-denied"))

    ws = _FakeWebSocket()
    await ws_route.websocket_endpoint(ws, token="tok")

    assert fresh_mgr.aito_read_at_connect == [False]


@pytest.mark.asyncio
async def test_connect_admits_with_fail_closed_aito_read_when_resolution_raises(monkeypatch, test_engine):
    """A resolution failure (e.g. a DB blip) must still admit the socket —
    degrading to no per-user routing rather than refusing the connection —
    but the value it is admitted with must already be the fail-closed
    ``not auth_required`` default, never the unstamped sentinel: the stamp
    assignment happens unconditionally after the try/except, before
    connect() is ever called."""
    session_maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    fresh_mgr = _RecordingConnectManager()
    monkeypatch.setattr(ws_route, "ws_manager", fresh_mgr)
    monkeypatch.setattr(ws_route, "async_session", session_maker)
    monkeypatch.setattr(ws_route, "is_auth_enabled", AsyncMock(return_value=True))
    monkeypatch.setattr(ws_route, "verify_websocket_token", AsyncMock(return_value="whoever"))
    monkeypatch.setattr(ws_route, "_resolve_principal_and_aito_read", AsyncMock(side_effect=RuntimeError("db blip")))

    ws = _FakeWebSocket()
    await ws_route.websocket_endpoint(ws, token="tok")

    assert fresh_mgr.aito_read_at_connect == [False]  # not auth_required == False
    assert ws.state.aito_read is False


# ---------------------------------------------------------------------------
# Layer 4 (T-011): the inbound "aito_presence" message handler, end to end
# ---------------------------------------------------------------------------


class _MessageWebSocket(_FakeWebSocket):
    """Like ``_FakeWebSocket``, but replays a queued sequence of inbound
    messages before disconnecting, so the endpoint's ``while True`` loop
    actually reaches the branch under test."""

    def __init__(self, messages: list[dict]):
        super().__init__()
        self._messages = list(messages)

    async def receive_json(self):
        if self._messages:
            return self._messages.pop(0)
        raise WebSocketDisconnect()


async def _run_endpoint_with_messages(monkeypatch, test_engine, *, group_permissions, messages):
    session_maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with session_maker() as seed:
        group = Group(name="T011-group", permissions=group_permissions)
        seed.add(group)
        seed.add(User(username="t011-user", groups=[group]))
        await seed.commit()

    fresh_mgr = ConnectionManager()
    presence_spy = AsyncMock(wraps=fresh_mgr.set_aito_presence)
    monkeypatch.setattr(fresh_mgr, "set_aito_presence", presence_spy)
    monkeypatch.setattr(ws_route, "ws_manager", fresh_mgr)
    monkeypatch.setattr(ws_route, "async_session", session_maker)
    monkeypatch.setattr(ws_route, "is_auth_enabled", AsyncMock(return_value=True))
    monkeypatch.setattr(ws_route, "verify_websocket_token", AsyncMock(return_value="t011-user"))

    ws = _MessageWebSocket(messages)
    await ws_route.websocket_endpoint(ws, token="tok")
    return ws, presence_spy


@pytest.mark.asyncio
async def test_inbound_aito_presence_is_applied_with_aito_read(monkeypatch, test_engine):
    ws, presence_spy = await _run_endpoint_with_messages(
        monkeypatch,
        test_engine,
        group_permissions=[Permission.AITO_READ.value],
        messages=[{"type": "aito_presence", "project_id": 5}],
    )

    assert ws.state.aito_read is True
    presence_spy.assert_awaited_once_with(ws, 5)


@pytest.mark.asyncio
async def test_inbound_aito_presence_is_ignored_without_aito_read(monkeypatch, test_engine):
    """Without AITO_READ the ping is a silent no-op, but the loop must keep
    running — a following message (here, a plain ping) still gets a
    reply."""
    ws, presence_spy = await _run_endpoint_with_messages(
        monkeypatch,
        test_engine,
        group_permissions=[],
        messages=[{"type": "aito_presence", "project_id": 5}, {"type": "ping"}],
    )

    assert ws.state.aito_read is False
    presence_spy.assert_not_awaited()
    assert "pong" in _sent_types(ws)


@pytest.mark.asyncio
async def test_inbound_aito_presence_with_bogus_project_id_is_ignored_without_aito_read(monkeypatch, test_engine):
    """A stray boolean ``project_id`` must not slip through the aito_read
    gate either — no call at all, sanitizing or otherwise."""
    ws, presence_spy = await _run_endpoint_with_messages(
        monkeypatch,
        test_engine,
        group_permissions=[],
        messages=[{"type": "aito_presence", "project_id": True}],
    )

    assert ws.state.aito_read is False
    presence_spy.assert_not_awaited()
