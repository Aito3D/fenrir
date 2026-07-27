"""Zoho Books proxy: connection status + contact search for the Aito board."""

import logging
import re

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequireAnyPermissionIfAuthEnabled, RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.user import User
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoRequestRejected, ZohoUpstreamError, zoho_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/zoho", tags=["zoho"])


class ZohoStatus(BaseModel):
    configured: bool
    reachable: bool
    default_contact_id: str
    default_contact_name: str


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
    default_id, default_name = await zoho_service.get_default_contact(db)
    if not await zoho_service.is_configured(db):
        return ZohoStatus(
            configured=False,
            reachable=False,
            default_contact_id=default_id,
            default_contact_name=default_name,
        )
    try:
        await zoho_service.get_access_token(db)
        reachable = True
        configured = True
    except ZohoNotConfiguredError:
        # Settings were cleared between the is_configured() check above and here.
        configured, reachable = False, False
    except ZohoUpstreamError as e:
        logger.warning("Zoho unreachable: %s", e)
        configured, reachable = True, False
    return ZohoStatus(
        configured=configured,
        reachable=reachable,
        default_contact_id=default_id,
        default_contact_name=default_name,
    )


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


# Mirrors the frontend rules in utils/clientDraft.ts. These endpoints are
# reachable independently of the modal, so the client checks cannot be the only
# gate. Both fields are optional — only a non-empty malformed value is rejected.
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")
_PHONE_RE = re.compile(r"^\+\d{1,4}-\d{4,14}$")


def _check_email(value: str) -> str:
    if value.strip() and not _EMAIL_RE.match(value.strip()):
        raise ValueError("Enter a valid email address")
    return value


def _check_phone(value: str) -> str:
    if value.strip() and not _PHONE_RE.match(value.strip()):
        raise ValueError("Phone must look like +689-87123456")
    return value


class ZohoContactCreate(BaseModel):
    """Either ``company_name`` or both name parts must be present — the display
    name is derived from them server-side, never taken from the client."""

    company_name: str = Field(default="", max_length=200)
    first_name: str = Field(default="", max_length=100)
    last_name: str = Field(default="", max_length=100)
    email: str = Field(default="", max_length=200)
    phone: str = Field(default="", max_length=50)

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        return _check_email(value)

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, value: str) -> str:
        return _check_phone(value)

    @model_validator(mode="after")
    def check_name(self):
        if not self.company_name.strip() and not (self.first_name.strip() and self.last_name.strip()):
            raise ValueError("Provide a company name, or both a first and last name")
        return self


@router.post("/contacts", response_model=ZohoContact, status_code=201)
async def create_contact(
    payload: ZohoContactCreate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE),
):
    try:
        return await zoho_service.create_contact(
            db,
            company_name=payload.company_name,
            first_name=payload.first_name,
            last_name=payload.last_name,
            email=payload.email,
            phone=payload.phone,
        )
    except ZohoNotConfiguredError:
        raise HTTPException(status_code=409, detail="Zoho is not configured") from None
    except ZohoRequestRejected as e:
        # Zoho's own validation message (duplicate name, bad email, …) — actionable inline.
        raise HTTPException(status_code=409, detail=str(e)) from e
    except ZohoUpstreamError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
