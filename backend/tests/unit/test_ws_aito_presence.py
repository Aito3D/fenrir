"""Aito presence: which operator is viewing which project.

Full-state broadcasts (never deltas): reconnects and crashed browsers stay
trivially correct because every message replaces the whole map, and a
disconnect simply broadcasts the map without the dead connection."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from backend.app.core.websocket import ConnectionManager


def _conn(principal):
    conn = SimpleNamespace()
    conn.state = SimpleNamespace()
    conn.state.fenrir_principal = principal
    conn.state.fenrir_principal_user_id = None
    # T-030: broadcast_aito() now fails closed on an unstamped connection,
    # and every connection that can reach set_aito_presence() in real usage
    # (gated on aito_read by the inbound message handler) is, by
    # construction, already aito_read-permitted — so these fixtures must
    # stamp it too, or they'd be testing a shape that can no longer occur.
    conn.state.aito_read = True
    conn.send_text = AsyncMock()
    return conn


@pytest.mark.asyncio
async def test_set_presence_broadcasts_the_full_map():
    mgr = ConnectionManager()
    paul, marie = _conn("paul"), _conn("marie")
    mgr.active_connections = [paul, marie]

    await mgr.set_aito_presence(paul, 3)

    state = mgr.aito_presence_state()
    assert state == {"type": "aito_presence_state", "viewers": {"3": ["paul"]}}
    marie.send_text.assert_awaited()  # everyone hears about it


@pytest.mark.asyncio
async def test_none_clears_and_anonymous_shows_as_operator():
    mgr = ConnectionManager()
    paul, anon = _conn("paul"), _conn(None)
    mgr.active_connections = [paul, anon]

    await mgr.set_aito_presence(paul, 3)
    await mgr.set_aito_presence(anon, 3)
    assert sorted(mgr.aito_presence_state()["viewers"]["3"]) == ["Operator", "paul"]

    await mgr.set_aito_presence(paul, None)
    assert mgr.aito_presence_state()["viewers"] == {"3": ["Operator"]}


@pytest.mark.asyncio
async def test_disconnect_clears_presence_and_rebroadcasts():
    mgr = ConnectionManager()
    paul, marie = _conn("paul"), _conn("marie")
    mgr.active_connections = [paul, marie]
    await mgr.set_aito_presence(paul, 3)

    await mgr.disconnect(paul)

    assert mgr.aito_presence_state()["viewers"] == {}
    # marie received the emptied map (last send_text call payload contains it)
    last_payload = marie.send_text.await_args_list[-1].args[0]
    assert json.loads(last_payload) == {
        "type": "aito_presence_state",
        "viewers": {},
    }


# ---------------------------------------------------------------------------
# T-065 (user-approved 2026-09-26): a presence message that repeats the
# connection's current project id changes nothing, so it is not re-broadcast.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_identical_presence_twice_broadcasts_once():
    mgr = ConnectionManager()
    paul, marie = _conn("paul"), _conn("marie")
    mgr.active_connections = [paul, marie]

    await mgr.set_aito_presence(paul, 3)
    await mgr.set_aito_presence(paul, 3)

    assert marie.send_text.await_count == 1
    assert mgr.aito_presence_state()["viewers"] == {"3": ["paul"]}


@pytest.mark.asyncio
async def test_changed_presence_is_broadcast_every_time():
    mgr = ConnectionManager()
    paul, marie = _conn("paul"), _conn("marie")
    mgr.active_connections = [paul, marie]

    await mgr.set_aito_presence(paul, 3)
    await mgr.set_aito_presence(paul, 4)
    await mgr.set_aito_presence(paul, None)
    await mgr.set_aito_presence(paul, 3)

    payloads = [json.loads(call.args[0])["viewers"] for call in marie.send_text.await_args_list]
    assert payloads == [{"3": ["paul"]}, {"4": ["paul"]}, {}, {"3": ["paul"]}]


@pytest.mark.asyncio
async def test_clearing_presence_that_was_never_set_is_not_broadcast():
    """A fresh connection's first ``project_id: null`` leaves the map as it
    was (the connection was in no project), so nothing goes out."""
    mgr = ConnectionManager()
    paul, marie = _conn("paul"), _conn("marie")
    mgr.active_connections = [paul, marie]

    await mgr.set_aito_presence(paul, None)

    marie.send_text.assert_not_awaited()
    assert mgr.aito_presence_state()["viewers"] == {}
