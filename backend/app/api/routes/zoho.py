"""Zoho Books proxy: connection status + contact search for the Aito board."""

import logging
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequireAnyPermissionIfAuthEnabled, RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.aito_project import AitoProject
from backend.app.models.user import User
from backend.app.schemas.aito import AitoTaskCreate
from backend.app.services.aito_quote_import import build_preview
from backend.app.services.zoho import (
    ZohoNotConfiguredError,
    ZohoNotFound,
    ZohoRequestRejected,
    ZohoUpstreamError,
    zoho_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/zoho", tags=["zoho"])


class ZohoStatus(BaseModel):
    configured: bool
    # None means "not probed" — distinct from False ("probed and unreachable").
    reachable: bool | None
    default_contact_id: str
    default_contact_name: str


class ZohoContact(BaseModel):
    id: str
    name: str
    company_name: str
    customer_sub_type: str
    phone: str
    mobile: str
    email: str


class ZohoContactDetail(ZohoContact):
    """One contact read by id — what the card panel's client editor prefills
    from. Its own model rather than two more fields on `ZohoContact` so the
    search list (and every fixture built for it) keeps its shape."""

    first_name: str
    last_name: str


@router.get("/status", response_model=ZohoStatus)
async def zoho_status(
    probe: bool = False,
    db: AsyncSession = Depends(get_db),
    # Any-of: the Aito create modal (aito:create) AND the settings Test button
    # (settings:read) both need this endpoint.
    _: User | None = RequireAnyPermissionIfAuthEnabled(Permission.AITO_CREATE, Permission.SETTINGS_READ),
):
    """Connection state for the Zoho integration.

    ``configured`` and the default contact are settings-table reads. ``reachable``
    costs an OAuth round trip, so it is only established when ``probe`` is set —
    the Aito modal gates its client block on this call and never reads it.
    """
    default_id, default_name = await zoho_service.get_default_contact(db)
    configured = await zoho_service.is_configured(db)
    if not configured or not probe:
        return ZohoStatus(
            configured=configured,
            reachable=None,
            default_contact_id=default_id,
            default_contact_name=default_name,
        )
    try:
        await zoho_service.get_access_token(db)
        reachable = True
    except ZohoNotConfiguredError:
        # Settings were cleared between the is_configured() check above and here.
        configured, reachable = False, None
    except ZohoUpstreamError as e:
        logger.warning("Zoho unreachable: %s", e)
        reachable = False
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
    value = value.strip()
    if value and not _EMAIL_RE.match(value):
        raise ValueError("Enter a valid email address")
    return value


def _check_phone(value: str) -> str:
    value = value.strip()
    if value and not _PHONE_RE.match(value):
        raise ValueError("Phone must look like +689-87123456")
    return value


def _title_case_segments(value: str) -> str:
    """'jean-pierre  le roux' -> 'Jean-Pierre Le Roux' — mirrors
    frontend/src/utils/clientDraft.ts:titleCaseSegments (split on spaces and
    hyphens, capitalize each segment, keep the separators)."""
    parts = re.split(r"([ -]+)", value.strip())
    return "".join(p if i % 2 else p[:1].upper() + p[1:].lower() for i, p in enumerate(parts))


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
    def normalize_person_name(self):
        """House convention 'Jean-Pierre DUPONT', enforced server-side so no
        caller can bypass what the drawer's form promises."""
        self.first_name = _title_case_segments(self.first_name)
        self.last_name = self.last_name.strip().upper()
        return self

    @model_validator(mode="after")
    def check_name(self):
        if not self.company_name.strip() and not (self.first_name.strip() and self.last_name.strip()):
            raise ValueError("Provide a company name, or both a first and last name")
        return self


class ZohoContactPerson(BaseModel):
    """One person on a Books customer — what the Aito contact picker lists.
    Mirrors `ZohoContactPerson` in frontend/src/api/client.ts."""

    contact_person_id: str
    first_name: str
    last_name: str
    name: str
    email: str
    phone: str
    mobile: str
    is_primary: bool


class ZohoContactPersonCreate(BaseModel):
    """Body of POST /contacts/{id}/persons. First name required; phone or
    email required — a person nobody can reach is not worth a Books row.
    House casing is applied here so no caller can bypass what the picker's
    form promises."""

    first_name: str = Field(min_length=1, max_length=100)
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
    def normalize_and_require_a_channel(self):
        self.first_name = _title_case_segments(self.first_name)
        self.last_name = self.last_name.strip().upper()
        if not self.first_name.strip():
            raise ValueError("first_name is required")
        if not (self.email or self.phone):
            raise ValueError("A phone number or an email is required")
        return self


@router.get("/contacts/{contact_id}", response_model=ZohoContactDetail)
async def get_contact(
    contact_id: str,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    """The live Books record behind a card's client, for the panel's editor.
    Gated like the edit it feeds (aito:update), not like the search
    (aito:create): this is "may edit a card", not "may create one"."""
    try:
        return await zoho_service.get_contact(db, contact_id)
    except ZohoNotConfiguredError:
        raise HTTPException(status_code=409, detail="Zoho is not configured") from None
    except ZohoNotFound:
        raise HTTPException(status_code=404, detail="Contact not found in Zoho Books") from None
    except ZohoUpstreamError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


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


class ZohoContactPatch(BaseModel):
    """Only the keys present are written. An empty string clears the value, so it
    passes validation; a non-empty malformed value does not."""

    email: str | None = Field(default=None, max_length=200)
    phone: str | None = Field(default=None, max_length=50)
    phone_field: Literal["phone", "mobile"] = "mobile"

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str | None) -> str | None:
        return value if value is None else _check_email(value)

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, value: str | None) -> str | None:
        return value if value is None else _check_phone(value)


@router.patch("/contacts/{contact_id}", status_code=204)
async def patch_contact(
    contact_id: str,
    payload: ZohoContactPatch,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE),
):
    default_id, _name = await zoho_service.get_default_contact(db)
    if contact_id == default_id:
        # The walk-in bucket is shared by every passing customer and carries live
        # transaction history — it must never take one customer's details.
        raise HTTPException(status_code=400, detail="The default client cannot be modified")
    try:
        await zoho_service.update_contact_person(
            db, contact_id, email=payload.email, phone=payload.phone, phone_field=payload.phone_field
        )
    except ZohoNotConfiguredError:
        raise HTTPException(status_code=409, detail="Zoho is not configured") from None
    except ZohoUpstreamError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.get("/contacts/{contact_id}/persons", response_model=list[ZohoContactPerson])
async def list_contact_persons(
    contact_id: str,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE),
):
    """The people on a Books customer, for the drawer's company branch. Gated
    like the search (aito:create), not like `get_contact` (aito:update): a
    create-only user must be able to say WHO at the company the card is for.
    The walk-in contact is never a company, so it answers empty without a
    Books call — the same short-circuit the client history takes."""
    default_id, _name = await zoho_service.get_default_contact(db)
    if contact_id == default_id:
        return []
    try:
        return await zoho_service.list_contact_persons(db, contact_id)
    except ZohoNotConfiguredError:
        raise HTTPException(status_code=409, detail="Zoho is not configured") from None
    except ZohoNotFound:
        raise HTTPException(status_code=404, detail="Contact not found in Zoho Books") from None
    except ZohoUpstreamError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.post("/contacts/{contact_id}/persons", response_model=ZohoContactPerson, status_code=201)
async def create_contact_person(
    contact_id: str,
    payload: ZohoContactPersonCreate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE),
):
    """Add a new person to a Books company contact, for the drawer's and
    contact sheet's "Add contact" form. Gated like `list_contact_persons`
    (aito:create), not `patch_contact` (aito:update): naming who at the
    company the card is for is a create-time decision, not an edit to an
    existing card.

    The walk-in contact is shared by every passing customer, so a new person
    on it would belong to no one in particular — same refusal as
    `patch_contact`."""
    default_id, _name = await zoho_service.get_default_contact(db)
    if contact_id == default_id:
        # Same refusal as patch_contact: the walk-in bucket is everyone's.
        raise HTTPException(status_code=400, detail="The default client cannot be modified")
    try:
        return await zoho_service.create_contact_person(
            db,
            contact_id,
            first_name=payload.first_name,
            last_name=payload.last_name,
            email=payload.email,
            phone=payload.phone,
        )
    except ZohoNotConfiguredError:
        raise HTTPException(status_code=409, detail="Zoho is not configured") from None
    except ZohoRequestRejected as e:
        # Zoho's own validation message (duplicate email, …) — actionable inline.
        raise HTTPException(status_code=409, detail=str(e)) from e
    except ZohoUpstreamError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


class ZohoEstimateSummary(BaseModel):
    id: str
    number: str
    customer_name: str
    date: str
    total: float
    currency_code: str
    status: str


class ZohoQuoteInfo(BaseModel):
    id: str
    number: str
    date: str
    status: str
    total: float
    currency_code: str
    url: str
    salesperson: str | None


class ZohoQuoteClient(BaseModel):
    id: str
    name: str
    phone: str | None
    email: str | None
    is_company: bool | None


class ZohoSkippedLine(BaseModel):
    sku: str
    name: str
    amount: float


class ZohoQuoteShipping(BaseModel):
    """The shipment read back off the estimate's shipping line. Unlike
    `tasks`, this is NOT already in the shape POST /aito/ accepts:
    `AitoProjectCreate`'s shipping fields are prefixed (`shipping_island`,
    `shipping_first_name`, `shipping_phone`, `shipping_price`) and carry no
    `service` field at all — the server always derives `shipping_service`
    from the island itself and rejects a client-supplied one. A caller must
    remap these unprefixed names onto that prefixed shape (and drop
    `service` entirely) rather than forward this model as-is. None when the
    quote carries no shipping line, or when it carries one whose island we
    could not resolve — in that case the project is created without a
    shipment and the line is preserved untouched by build_line_items' echo
    rule."""

    island: str
    service: str
    first_name: str
    last_name: str
    phone: str
    price: float


class ZohoQuotePreview(BaseModel):
    """Everything the Aito import modal renders, with `tasks` already in the
    shape POST /aito/ accepts — what the user sees is what gets created."""

    quote: ZohoQuoteInfo
    client: ZohoQuoteClient
    suggested_description: str
    tasks: list[AitoTaskCreate]
    skipped_lines: list[ZohoSkippedLine]
    shipping: ZohoQuoteShipping | None
    existing_project_id: int | None


@router.get("/estimates", response_model=list[ZohoEstimateSummary])
async def search_estimates(
    q: str = Query(default="", max_length=100),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE),
):
    """Quotes for the import picker. An empty ``q`` lists the most recent."""
    try:
        return await zoho_service.search_estimates(db, q.strip())
    except ZohoNotConfiguredError:
        raise HTTPException(status_code=409, detail="Zoho is not configured") from None
    except ZohoUpstreamError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.get("/estimates/{estimate_id}/preview", response_model=ZohoQuotePreview)
async def preview_estimate(
    estimate_id: str,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE),
):
    try:
        estimate = await zoho_service.get_estimate(db, estimate_id)
        quote_url = await zoho_service.books_app_url(db, estimate_id)
    except ZohoNotConfiguredError:
        raise HTTPException(status_code=409, detail="Zoho is not configured") from None
    except ZohoUpstreamError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    # The contact enriches the client snapshot with a phone and an email. It is
    # a second round trip and a second thing that can fail — a failure here
    # degrades to the estimate's own customer rather than losing the import.
    contact = None
    customer_id = estimate.get("customer_id") or ""
    if customer_id:
        try:
            contact = await zoho_service.get_contact(db, customer_id)
        except ZohoUpstreamError as e:
            logger.warning("Quote preview: contact %s unavailable: %s", customer_id, e)

    catalogue = await zoho_service.get_catalogue(db)
    preview = build_preview(estimate, contact, quote_url, shipping_ids=catalogue.shipping)
    # Soft-deleted cards do not count: re-importing a quote whose card was
    # thrown away is not a duplicate.
    existing = await db.scalar(
        select(AitoProject.id)
        .where(AitoProject.quote_id == estimate_id, AitoProject.status == "active")
        .order_by(AitoProject.id.desc())
        .limit(1)
    )
    return ZohoQuotePreview(**preview, existing_project_id=existing)
