"""The read-model timing log: silent under the threshold, one warning naming the path above it."""

import logging

from starlette.requests import Request

from backend.app.api.routes import revenue as routes


def _request(path: str) -> Request:
    return Request({"type": "http", "method": "GET", "path": path, "query_string": b"", "headers": []})


async def _body() -> dict:
    return {"ok": True}


async def test_fast_build_logs_nothing(caplog):
    with caplog.at_level(logging.WARNING):
        assert await routes._timed_build(_request("/api/v1/revenue"), _body()) == {"ok": True}
    assert not caplog.records


async def test_slow_build_warns_with_path(caplog, monkeypatch):
    monkeypatch.setattr(routes, "SLOW_BUILD_S", -1)
    with caplog.at_level(logging.WARNING):
        await routes._timed_build(_request("/api/v1/revenue/analysis"), _body())
    assert "/api/v1/revenue/analysis" in caplog.text
