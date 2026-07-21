"""API routes for the 3D print pricing calculator (filaments, printers, defaults)."""

import logging

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
    CalculatorFilamentUpdate,
    CalculatorInsightsResponse,
    CalculatorPrinterCreate,
    CalculatorPrinterResponse,
    CalculatorPrinterUpdate,
)
from backend.app.services.calculator_insights import calculator_insights_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/calculator", tags=["calculator"])


# --- Filaments ---


def _filament_display_name(brand: str, material: str) -> str:
    """Display label stored in the ``name`` column, derived from brand + material."""
    return f"{brand.strip()} {material.strip()}".strip()


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
    filament = CalculatorFilament(**data.model_dump(), name=_filament_display_name(data.brand, data.material))
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

    # exclude_none: no column is nullable, so an explicit JSON null means
    # "leave unchanged" rather than crashing the name derivation below.
    for key, value in update_data.model_dump(exclude_unset=True, exclude_none=True).items():
        setattr(filament, key, value)
    filament.name = _filament_display_name(filament.brand, filament.material)

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
