"""Gzip for JSON API responses only.

The archive list alone is several MB of JSON; compressed it is ~5x smaller.
Starlette's GZipMiddleware is not used because it compresses every response
type, including streamed ones (camera MJPEG, file and timelapse downloads),
where buffering or re-chunking would break the stream. This middleware looks
at the response start: anything that is not `application/json`, or already
has a Content-Encoding, is passed through untouched. JSON bodies are buffered
(JSONResponse sends a single body message anyway) and compressed when they
reach `minimum_size`.
"""

import gzip

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class JsonGZipMiddleware:
    def __init__(self, app: ASGIApp, minimum_size: int = 1024, compresslevel: int = 6) -> None:
        self.app = app
        self.minimum_size = minimum_size
        self.compresslevel = compresslevel

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope.get("method") == "HEAD"
            or "gzip" not in Headers(scope=scope).get("accept-encoding", "").lower()
        ):
            await self.app(scope, receive, send)
            return

        start: Message | None = None
        chunks: list[bytes] = []
        passthrough = False

        async def send_wrapper(message: Message) -> None:
            nonlocal start, passthrough
            if passthrough:
                await send(message)
                return
            if message["type"] == "http.response.start":
                headers = Headers(raw=message["headers"])
                content_type = headers.get("content-type", "").split(";")[0].strip().lower()
                if content_type != "application/json" or "content-encoding" in headers:
                    passthrough = True
                    await send(message)
                    return
                start = message
                return
            if message["type"] == "http.response.body" and start is not None:
                chunks.append(message.get("body", b""))
                if message.get("more_body", False):
                    return
                body = b"".join(chunks)
                headers = MutableHeaders(raw=start["headers"])
                if len(body) >= self.minimum_size:
                    body = gzip.compress(body, compresslevel=self.compresslevel)
                    headers["Content-Encoding"] = "gzip"
                    headers.add_vary_header("Accept-Encoding")
                headers["Content-Length"] = str(len(body))
                await send(start)
                await send({"type": "http.response.body", "body": body, "more_body": False})
                return
            await send(message)

        await self.app(scope, receive, send_wrapper)
