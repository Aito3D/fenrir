"""JsonGZipMiddleware compresses JSON API responses and nothing else.

Starlette's GZipMiddleware would also compress streamed responses (camera
MJPEG, file and timelapse downloads), so Fenrir uses this narrower one.
"""

import json

import httpx
import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse, PlainTextResponse, Response, StreamingResponse
from starlette.routing import Route

from backend.app.core.json_gzip import JsonGZipMiddleware

BIG = {"rows": ["x" * 50] * 100}  # ~5 KB of JSON


def _app() -> Starlette:
    async def big(_request):
        return JSONResponse(BIG)

    async def small(_request):
        return JSONResponse({"ok": True})

    async def text(_request):
        return PlainTextResponse("y" * 5000)

    async def stream(_request):
        async def frames():
            yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + b"a" * 3000
            yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + b"b" * 3000

        return StreamingResponse(frames(), media_type="multipart/x-mixed-replace; boundary=frame")

    async def pre_encoded(_request):
        return Response(b"already", media_type="application/json", headers={"Content-Encoding": "br"})

    app = Starlette(
        routes=[
            Route("/big", big),
            Route("/small", small),
            Route("/text", text),
            Route("/stream", stream),
            Route("/pre-encoded", pre_encoded),
        ]
    )
    app.add_middleware(JsonGZipMiddleware)
    return app


async def _request(method: str, path: str, accept_encoding: str = "gzip") -> httpx.Response:
    transport = httpx.ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, path, headers={"Accept-Encoding": accept_encoding})


@pytest.mark.asyncio
async def test_large_json_is_gzipped_and_round_trips():
    response = await _request("GET", "/big")
    assert response.headers["content-encoding"] == "gzip"
    assert "Accept-Encoding" in response.headers["vary"]
    assert int(response.headers["content-length"]) < len(json.dumps(BIG))
    assert response.json() == BIG  # httpx decodes gzip transparently


@pytest.mark.asyncio
async def test_small_json_is_not_compressed():
    response = await _request("GET", "/small")
    assert "content-encoding" not in response.headers
    assert response.json() == {"ok": True}


@pytest.mark.asyncio
async def test_client_without_gzip_gets_plain_json():
    response = await _request("GET", "/big", accept_encoding="identity")
    assert "content-encoding" not in response.headers
    assert response.json() == BIG


@pytest.mark.asyncio
async def test_non_json_is_untouched():
    response = await _request("GET", "/text")
    assert "content-encoding" not in response.headers
    assert response.text == "y" * 5000


@pytest.mark.asyncio
async def test_streamed_multipart_is_untouched():
    response = await _request("GET", "/stream")
    assert "content-encoding" not in response.headers
    assert response.content.count(b"--frame") == 2


@pytest.mark.asyncio
async def test_already_encoded_json_is_not_recompressed():
    response = await _request("GET", "/pre-encoded")
    assert response.headers["content-encoding"] == "br"


@pytest.mark.asyncio
async def test_head_request_is_untouched():
    response = await _request("HEAD", "/big")
    assert "content-encoding" not in response.headers
