"""Public shop figures (services/showcase_stats.py), fetched by the Shopify theme.

No auth: the numbers are marketing copy. CORS is opened for this one GET so
the storefront can fetch it from the browser; the cache header lets browsers
and any CDN reuse the answer for the same five minutes the server caches it.
"""

from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import get_db
from backend.app.services import showcase_stats

router = APIRouter(prefix="/showcase", tags=["showcase"])


@router.get("/stats")
async def get_stats(response: Response, db: AsyncSession = Depends(get_db)) -> dict:
    response.headers["Cache-Control"] = f"public, max-age={int(showcase_stats.CACHE_TTL)}"
    response.headers["Access-Control-Allow-Origin"] = "*"
    return await showcase_stats.get_cached(db)
