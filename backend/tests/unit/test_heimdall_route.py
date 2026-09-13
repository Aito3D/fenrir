"""POST /api/v1/heimdall/test — the Settings card's Test connection button."""

import httpx
import pytest

from backend.app.api.routes.settings import set_setting
from backend.app.services.heimdall import heimdall_service


@pytest.fixture(autouse=True)
def reset_transport():
    heimdall_service._transport = None
    yield
    heimdall_service._transport = None


@pytest.mark.asyncio
async def test_unconfigured(async_client):
    r = await async_client.post("/api/v1/heimdall/test", json={})
    assert r.status_code == 200
    assert r.json() == {"configured": False, "reachable": None, "error": None}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "code", "error", "reachable"),
    [(200, None, None, True), (401, "unauthorized", "unauthorized", False), (403, "forbidden", "forbidden", False)],
)
async def test_probe_outcomes(async_client, db_session, status, code, error, reachable):
    await set_setting(db_session, "heimdall_base_url", "http://pos.local:8081")
    await set_setting(db_session, "heimdall_api_token", "hmd_live.84f32b71ac095ed2.s3cret")
    await db_session.commit()
    body = {"ok": True} if code is None else {"error": {"code": code, "message": "x"}}
    heimdall_service._transport = httpx.MockTransport(lambda r: httpx.Response(status, json=body))
    r = await async_client.post("/api/v1/heimdall/test", json={})
    assert r.json() == {"configured": True, "reachable": reachable, "error": error}


@pytest.mark.asyncio
async def test_unreachable(async_client, db_session):
    await set_setting(db_session, "heimdall_base_url", "http://pos.local:8081")
    await set_setting(db_session, "heimdall_api_token", "hmd_live.84f32b71ac095ed2.s3cret")
    await db_session.commit()

    def boom(request):
        raise httpx.ConnectError("refused")

    heimdall_service._transport = httpx.MockTransport(boom)
    r = await async_client.post("/api/v1/heimdall/test", json={})
    assert r.json() == {"configured": True, "reachable": False, "error": "unreachable"}


@pytest.mark.asyncio
async def test_overrides_probe_an_unsaved_token(async_client):
    seen = {}

    def handler(request):
        seen["key_id"] = request.headers["x-heimdall-key-id"]
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"ok": True})

    heimdall_service._transport = httpx.MockTransport(handler)
    r = await async_client.post(
        "/api/v1/heimdall/test", json={"base_url": "http://new:8081", "token": "hmd_live.ffffffffffffffff.newsecret"}
    )
    assert r.json() == {"configured": True, "reachable": True, "error": None}
    assert seen["key_id"] == "ffffffffffffffff" and seen["url"] == "http://new:8081/api/v1/ping"


@pytest.mark.asyncio
async def test_override_url_is_ssrf_guarded(async_client):
    r = await async_client.post(
        "/api/v1/heimdall/test", json={"base_url": "http://169.254.169.254", "token": "hmd_live.ffffffffffffffff.x"}
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_malformed_override_token_reads_as_not_configured(async_client):
    r = await async_client.post(
        "/api/v1/heimdall/test", json={"base_url": "http://new:8081", "token": "hmd_live_a1b2c3d4_retired_form"}
    )
    assert r.status_code == 200
    assert r.json() == {"configured": False, "reachable": None, "error": None}
