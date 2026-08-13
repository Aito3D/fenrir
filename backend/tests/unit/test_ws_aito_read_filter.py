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
"""

from __future__ import annotations

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
async def test_broadcast_aito_defaults_to_true_for_a_never_stamped_connection():
    """``connect()`` always stamps ``aito_read`` today, so this should never
    happen in practice — but the default protects against silently dropping
    a connection if that ever changes, rather than the filter fail-CLOSED
    by accident on unrelated code elsewhere stamping nothing."""
    mgr = ConnectionManager()
    unstamped = _conn(stamped=False)
    mgr.active_connections = [unstamped]

    await mgr.broadcast_aito({"type": "aito_changed", "action": "move", "project_id": 2, "actor": None})

    unstamped.send_text.assert_awaited_once()


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
