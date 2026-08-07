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
    conn.state.bambuddy_principal = principal
    conn.state.bambuddy_principal_user_id = None
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
