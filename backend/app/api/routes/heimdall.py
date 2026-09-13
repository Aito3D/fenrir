"""The Settings card's Test button for the Heimdall payment bridge."""

import logging

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.user import User
from backend.app.schemas.heimdall import HeimdallStatus, HeimdallTestRequest
from backend.app.services.heimdall import (
    HeimdallAuthError,
    HeimdallNotConfigured,
    HeimdallUpstreamError,
    heimdall_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/heimdall", tags=["heimdall"])


@router.post("/test", response_model=HeimdallStatus)
async def test_heimdall(
    payload: HeimdallTestRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
) -> HeimdallStatus:
    """Ping Heimdall with the saved credential, or the overrides typed in
    the card. Never a non-200: the card renders the outcome."""
    overriding = payload.base_url is not None and payload.token is not None
    if not overriding and not await heimdall_service.is_configured(db):
        return HeimdallStatus(configured=False, reachable=None, error=None)
    try:
        await heimdall_service.ping(db, base_url=payload.base_url, token=payload.token)
    except HeimdallNotConfigured:
        return HeimdallStatus(configured=False, reachable=None, error=None)
    except HeimdallAuthError as e:
        return HeimdallStatus(
            configured=True, reachable=False, error="unauthorized" if e.status == 401 else "forbidden"
        )
    except HeimdallUpstreamError as e:
        logger.warning("Heimdall unreachable: %s", e)
        return HeimdallStatus(configured=True, reachable=False, error="unreachable")
    return HeimdallStatus(configured=True, reachable=True, error=None)
