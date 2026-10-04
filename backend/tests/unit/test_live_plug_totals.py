"""Archive stats read the smart plugs concurrently, with a timeout each.

In "total consumption" mode /archives/stats asked every plug's live API one
after another (a Home Assistant plug is 3-4 sequential requests with a 10 s
timeout each), so one slow plug held the stats request for tens of seconds,
and stats are refetched on every print start and completion.
"""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

pytestmark = pytest.mark.asyncio


def _db(plugs):
    db = MagicMock()
    db.execute = AsyncMock(return_value=MagicMock(scalars=lambda: MagicMock(all=lambda: plugs)))
    return db


@pytest.fixture(autouse=True)
def _no_cache():
    from backend.app.api.routes import archives

    archives._live_plug_total_cache.clear()
    yield
    archives._live_plug_total_cache.clear()


async def _run(plugs, get_energy):
    from backend.app.api.routes import archives

    with (
        patch("backend.app.services.tasmota.tasmota_service.get_energy", get_energy),
        patch("backend.app.api.routes.settings.get_setting", AsyncMock(return_value="")),
    ):
        return await archives._sum_live_plug_totals(_db(plugs))


async def test_plugs_are_read_concurrently():
    plugs = [SimpleNamespace(id=i, plug_type="tasmota") for i in range(5)]

    async def _slow(plug):
        await asyncio.sleep(0.2)
        return {"total": 1.5}

    started = time.monotonic()
    total = await _run(plugs, _slow)
    assert total == pytest.approx(7.5)
    assert time.monotonic() - started < 0.6


async def test_a_hanging_plug_times_out_and_the_rest_still_count(monkeypatch):
    from backend.app.api.routes import archives

    monkeypatch.setattr(archives, "_LIVE_PLUG_TIMEOUT_SECONDS", 0.1)
    plugs = [SimpleNamespace(id=1, plug_type="tasmota"), SimpleNamespace(id=2, plug_type="tasmota")]

    async def _one_hangs(plug):
        if plug.id == 1:
            await asyncio.sleep(10)
        return {"total": 2.0}

    assert await _run(plugs, _one_hangs) == pytest.approx(2.0)


async def test_the_total_is_cached_briefly():
    plugs = [SimpleNamespace(id=1, plug_type="tasmota")]
    calls = {"n": 0}

    async def _count(plug):
        calls["n"] += 1
        return {"total": 3.0}

    assert await _run(plugs, _count) == 3.0
    assert await _run(plugs, _count) == 3.0
    assert calls["n"] == 1
