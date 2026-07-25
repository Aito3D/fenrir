"""Zoho Books proxy: connection status + contact search for the Aito board."""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequireAnyPermissionIfAuthEnabled, RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.user import User
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoUpstreamError, zoho_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/zoho", tags=["zoho"])


class ZohoStatus(BaseModel):
    configured: bool
    reachable: bool


class ZohoContact(BaseModel):
    id: str
    name: str
    company_name: str
    phone: str
    mobile: str
    email: str


@router.get("/status", response_model=ZohoStatus)
async def zoho_status(
    db: AsyncSession = Depends(get_db),
    # Any-of: the Aito create modal (aito:create) AND the settings Test button
    # (settings:read) both need this endpoint.
    _: User | None = RequireAnyPermissionIfAuthEnabled(Permission.AITO_CREATE, Permission.SETTINGS_READ),
):
    if not await zoho_service.is_configured(db):
        return ZohoStatus(configured=False, reachable=False)
    try:
        await zoho_service.get_access_token(db)
        return ZohoStatus(configured=True, reachable=True)
    except ZohoNotConfiguredError:
        # Settings were cleared between the is_configured() check above and here.
        return ZohoStatus(configured=False, reachable=False)
    except ZohoUpstreamError as e:
        logger.warning("Zoho unreachable: %s", e)
        return ZohoStatus(configured=True, reachable=False)


@router.get("/contacts", response_model=list[ZohoContact])
async def search_contacts(
    q: str = Query(min_length=2, max_length=100),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE),
):
    try:
        return await zoho_service.search_contacts(db, q)
    except ZohoNotConfiguredError:
        raise HTTPException(status_code=409, detail="Zoho is not configured") from None
    except ZohoUpstreamError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
