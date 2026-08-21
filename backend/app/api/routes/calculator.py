"""API routes for the 3D print pricing calculator (filaments, printers, defaults)."""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.calculator import CalculatorDefaults, CalculatorFilament, CalculatorPrinter
from backend.app.models.user import User
from backend.app.schemas.calculator import (
    CalculatorDefaultsResponse,
    CalculatorDefaultsUpdate,
    CalculatorFilamentCreate,
    CalculatorFilamentResponse,
    CalculatorFilamentSyncRequest,
    CalculatorFilamentSyncResponse,
    CalculatorFilamentUpdate,
    CalculatorInsightsResponse,
    CalculatorPrinterCreate,
    CalculatorPrinterResponse,
    CalculatorPrinterUpdate,
    ZohoFilamentProduct,
)
from backend.app.services import zoho_filaments
from backend.app.services.calculator_insights import calculator_insights_service
from backend.app.services.zoho import zoho_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/calculator", tags=["calculator"])


# --- Filaments ---


def _filament_display_name(brand: str, material: str) -> str:
    """Display label stored in the ``name`` column, derived from brand + material."""
    return f"{brand.strip()} {material.strip()}".strip()


# Fields the UI is allowed to null out explicitly; everything else treats an
# explicit JSON null as "leave unchanged" because no other column is nullable.
_NULLABLE_FILAMENT_FIELDS = frozenset({"zoho_item_id", "zoho_item_name", "zoho_sku", "spool_weight_kg"})


def derive_sale_price(cost_per_kg: float, margin_pct: float) -> float:
    """The printing cost per kg shown to the user.

    The single place this arithmetic lives — the create route, the patch route
    and the Zoho sync all call it, so the stored invariant
    ``sale_price_per_kg == cost_per_kg * (1 + margin_pct/100)`` cannot drift.
    """
    return round(cost_per_kg * (1 + margin_pct / 100.0), 2)


@router.get("/filaments/", response_model=list[CalculatorFilamentResponse])
async def list_calculator_filaments(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CALCULATOR_READ),
):
    """List all calculator filaments."""
    result = await db.execute(select(CalculatorFilament).order_by(CalculatorFilament.name, CalculatorFilament.id))
    return result.scalars().all()


@router.post("/filaments/", response_model=CalculatorFilamentResponse)
async def create_calculator_filament(
    data: CalculatorFilamentCreate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CALCULATOR_UPDATE),
):
    """Create a calculator filament."""
    filament = CalculatorFilament(
        **data.model_dump(),
        name=_filament_display_name(data.brand, data.material),
        sale_price_per_kg=derive_sale_price(data.cost_per_kg, data.margin_pct),
    )
    db.add(filament)
    await db.commit()
    await db.refresh(filament)
    logger.info("Created calculator filament: %s", filament.name)
    return filament


@router.patch("/filaments/{filament_id}", response_model=CalculatorFilamentResponse)
async def update_calculator_filament(
    filament_id: int,
    update_data: CalculatorFilamentUpdate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CALCULATOR_UPDATE),
):
    """Update a calculator filament."""
    result = await db.execute(select(CalculatorFilament).where(CalculatorFilament.id == filament_id))
    filament = result.scalar_one_or_none()
    if not filament:
        raise HTTPException(status_code=404, detail="Calculator filament not found")

    # exclude_unset: an absent key means "leave unchanged". An explicit null is
    # only honoured for the Zoho columns, which is how unlinking works; for the
    # non-nullable columns a null would crash the name derivation below.
    for key, value in update_data.model_dump(exclude_unset=True).items():
        if value is None and key not in _NULLABLE_FILAMENT_FIELDS:
            continue
        setattr(filament, key, value)
    filament.name = _filament_display_name(filament.brand, filament.material)
    filament.sale_price_per_kg = derive_sale_price(filament.cost_per_kg, filament.margin_pct)

    await db.commit()
    await db.refresh(filament)
    return filament


@router.delete("/filaments/{filament_id}")
async def delete_calculator_filament(
    filament_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CALCULATOR_UPDATE),
):
    """Delete a calculator filament."""
    result = await db.execute(select(CalculatorFilament).where(CalculatorFilament.id == filament_id))
    filament = result.scalar_one_or_none()
    if not filament:
        raise HTTPException(status_code=404, detail="Calculator filament not found")

    name = filament.name
    await db.delete(filament)
    await db.commit()
    logger.info("Deleted calculator filament: %s", name)
    return {"message": f"Filament '{name}' deleted"}


@router.get("/zoho-filaments", response_model=list[ZohoFilamentProduct])
async def search_zoho_filaments(
    q: str = Query(default="", max_length=100, description="Free-text search over brand, material, colour and SKU"),
    limit: int = Query(default=25, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CALCULATOR_READ),
):
    """Zoho products in the Filaments category, for linking to a calculator filament.

    Results are per Zoho item — colour included — because dealer prices differ
    between colours of the same material (Bambu ABS-GF is 1866 in Blue and 3208
    in Black), so which colour the user picks decides the price.
    """
    if not await zoho_service.is_configured(db):
        raise HTTPException(status_code=503, detail="Zoho is not configured")
    try:
        catalogue = await zoho_filaments.fetch_catalogue(db)
    except Exception as exc:
        logger.warning("Zoho filament catalogue unavailable: %s", exc)
        raise HTTPException(status_code=502, detail="Could not reach Zoho") from exc
    return zoho_filaments.search_catalogue(catalogue, q, limit)


@router.post("/filaments/zoho-sync", response_model=CalculatorFilamentSyncResponse)
async def sync_calculator_filaments_from_zoho(
    payload: CalculatorFilamentSyncRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CALCULATOR_UPDATE),
):
    """Refresh one chunk of linked filaments from their Zoho dealer prices.

    Chunking is client-driven: the caller loops until ``next_offset`` is null.
    Each chunk commits its own work, so a mid-run Zoho failure leaves earlier
    chunks applied and a retry resumes from the offset it reports.

    Prices only. Brand, material, margin and difficulty are never rewritten from
    Zoho, so a rename upstream cannot clobber a hand-corrected filament.
    """
    if not await zoho_service.is_configured(db):
        raise HTTPException(status_code=503, detail="Zoho is not configured")
    try:
        catalogue = await zoho_filaments.fetch_catalogue(db)
    except Exception as exc:
        logger.warning("Zoho filament catalogue unavailable during sync: %s", exc)
        raise HTTPException(status_code=502, detail="Could not reach Zoho") from exc

    # Ordering by id is load-bearing: offset paging over an unordered query
    # would skip or repeat rows between chunks.
    result = await db.execute(
        select(CalculatorFilament).where(CalculatorFilament.zoho_item_id.is_not(None)).order_by(CalculatorFilament.id)
    )
    linked = result.scalars().all()

    total = len(linked)
    chunk = linked[payload.offset : payload.offset + payload.limit]
    by_item_id = {product.item_id: product for product in catalogue}
    now = datetime.now(timezone.utc)

    updated = unchanged = skipped_no_price = missing = 0
    for filament in chunk:
        product = by_item_id.get(filament.zoho_item_id or "")
        if product is None:
            missing += 1
            continue
        if not product.has_price:
            skipped_no_price += 1
            continue

        # The filament's own stored weight wins: re-deriving it from the Zoho
        # name on every sync would let an upstream rename re-scale the price.
        weight = filament.spool_weight_kg or product.spool_weight_kg or 1.0
        new_cost = round(product.dealer_price / weight, 2)
        filament.zoho_synced_at = now
        if abs(new_cost - filament.cost_per_kg) < 0.005:
            unchanged += 1
            continue
        filament.cost_per_kg = new_cost
        filament.sale_price_per_kg = derive_sale_price(new_cost, filament.margin_pct)
        updated += 1

    await db.commit()

    next_offset = payload.offset + payload.limit
    logger.info(
        "Zoho filament sync chunk %s-%s: %s updated, %s unchanged, %s without a dealer price, %s missing",
        payload.offset,
        payload.offset + len(chunk),
        updated,
        unchanged,
        skipped_no_price,
        missing,
    )
    return CalculatorFilamentSyncResponse(
        processed=len(chunk),
        total=total,
        updated=updated,
        unchanged=unchanged,
        skipped_no_price=skipped_no_price,
        missing=missing,
        next_offset=next_offset if next_offset < total else None,
    )


# --- Printers ---


@router.get("/printers/", response_model=list[CalculatorPrinterResponse])
async def list_calculator_printers(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CALCULATOR_READ),
):
    """List all calculator printers."""
    result = await db.execute(select(CalculatorPrinter).order_by(CalculatorPrinter.name, CalculatorPrinter.id))
    return result.scalars().all()


@router.post("/printers/", response_model=CalculatorPrinterResponse)
async def create_calculator_printer(
    data: CalculatorPrinterCreate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CALCULATOR_UPDATE),
):
    """Create a calculator printer."""
    printer = CalculatorPrinter(**data.model_dump())
    db.add(printer)
    await db.commit()
    await db.refresh(printer)
    logger.info("Created calculator printer: %s", printer.name)
    return printer


@router.patch("/printers/{printer_id}", response_model=CalculatorPrinterResponse)
async def update_calculator_printer(
    printer_id: int,
    update_data: CalculatorPrinterUpdate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CALCULATOR_UPDATE),
):
    """Update a calculator printer."""
    result = await db.execute(select(CalculatorPrinter).where(CalculatorPrinter.id == printer_id))
    printer = result.scalar_one_or_none()
    if not printer:
        raise HTTPException(status_code=404, detail="Calculator printer not found")

    for key, value in update_data.model_dump(exclude_unset=True, exclude_none=True).items():
        setattr(printer, key, value)

    await db.commit()
    await db.refresh(printer)
    return printer


@router.delete("/printers/{printer_id}")
async def delete_calculator_printer(
    printer_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CALCULATOR_UPDATE),
):
    """Delete a calculator printer."""
    result = await db.execute(select(CalculatorPrinter).where(CalculatorPrinter.id == printer_id))
    printer = result.scalar_one_or_none()
    if not printer:
        raise HTTPException(status_code=404, detail="Calculator printer not found")

    name = printer.name
    await db.delete(printer)
    await db.commit()
    logger.info("Deleted calculator printer: %s", name)
    return {"message": f"Printer '{name}' deleted"}


# --- Defaults ---


async def _get_or_create_defaults(db: AsyncSession) -> CalculatorDefaults:
    result = await db.execute(select(CalculatorDefaults).order_by(CalculatorDefaults.id).limit(1))
    defaults = result.scalar_one_or_none()
    if not defaults:
        # Fixed primary key so concurrent first requests cannot insert
        # duplicate rows — the loser hits the PK constraint and re-reads.
        defaults = CalculatorDefaults(id=1)
        db.add(defaults)
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            result = await db.execute(select(CalculatorDefaults).where(CalculatorDefaults.id == 1))
            defaults = result.scalar_one()
        else:
            await db.refresh(defaults)
    return defaults


@router.get("/defaults", response_model=CalculatorDefaultsResponse)
async def get_calculator_defaults(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CALCULATOR_READ),
):
    """Get the global calculator defaults (created on first access)."""
    return await _get_or_create_defaults(db)


@router.patch("/defaults", response_model=CalculatorDefaultsResponse)
async def update_calculator_defaults(
    update_data: CalculatorDefaultsUpdate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CALCULATOR_UPDATE),
):
    """Update the global calculator defaults."""
    defaults = await _get_or_create_defaults(db)

    for key, value in update_data.model_dump(exclude_unset=True, exclude_none=True).items():
        setattr(defaults, key, value)

    await db.commit()
    await db.refresh(defaults)
    logger.info("Updated calculator defaults")
    return defaults


# --- Insights ---


@router.get("/insights", response_model=CalculatorInsightsResponse)
async def get_calculator_insights(
    days: int = Query(default=365, ge=7, le=3650),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CALCULATOR_READ),
):
    """Measured pricing signals (failure rates, tariff, spool costs, time accuracy).

    Gated on CALCULATOR_READ alone by design: the aggregates are computed
    server-side so a calculator-only user doesn't need archives/spool read
    permissions to benefit from them.
    """
    return await calculator_insights_service.compute(db, days=days)
