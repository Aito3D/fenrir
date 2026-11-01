"""Public shop figures (services/showcase_stats.py), fetched by the Shopify theme.

No auth: the payload is a handful of marketing aggregates with nothing
identifying in it. This is the one route meant to face the internet, so it
opens no database session itself (the service recomputes on its own, at
most once per TTL), answers conditional requests with an empty 304, and
degrades to 503 without a body when the figures were never computed.
CORS is opened for GET only, which is all a storefront fetch needs; the
cache header lets browsers and any CDN reuse the answer for the same five
minutes the server does.
"""

import logging

from fastapi import APIRouter, Request, Response

from backend.app.services import showcase_stats

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/showcase", tags=["showcase"])

_HEADERS = {
    "Cache-Control": f"public, max-age={int(showcase_stats.CACHE_TTL)}",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET",
    "Vary": "Accept-Encoding",
}


@router.get("/stats")
async def get_stats(request: Request) -> Response:
    try:
        snap = await showcase_stats.get_cached()
    except Exception:
        logger.exception("showcase stats unavailable")
        return Response(status_code=503, headers={"Cache-Control": "no-store", "Retry-After": "60"})
    headers = {**_HEADERS, "ETag": snap.etag}
    if snap.etag in request.headers.get("if-none-match", ""):
        return Response(status_code=304, headers=headers)
    return Response(content=snap.body, media_type="application/json", headers=headers)
