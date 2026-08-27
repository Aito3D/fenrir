"""API routes for the 3D print pricing calculator (filaments, printers, defaults)."""

import logging
import math
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.calculator import CalculatorDefaults, CalculatorFilament, CalculatorPrinter
from backend.app.models.user import User
from backend.app.schemas.calculator import (
    _MONEY_CEILING,
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
    InsightsWindowDays,
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

    linked_item_id_before = filament.zoho_item_id

    # exclude_unset: an absent key means "leave unchanged". An explicit null is
    # only honoured for the Zoho columns, which is how unlinking works; for the
    # non-nullable columns a null would crash the name derivation below.
    for key, value in update_data.model_dump(exclude_unset=True).items():
        if value is None and key not in _NULLABLE_FILAMENT_FIELDS:
            continue
        setattr(filament, key, value)

    # The sync stamp belongs to the link it was made under, so unlinking (or
    # re-pointing the row at a different product) clears it. The settings panel
    # reads a non-null zoho_synced_at as proof the cost came from a Zoho dealer
    # price and reconstructs that price as cost * spool_weight — a stamp left
    # over from a PREVIOUS link would make a hand-typed cost read-only and let
    # a spool-weight correction silently rescale it. Enforced server-side
    # rather than by asking the client for a fifth explicit null
    # (zoho_synced_at is deliberately absent from the update schema: only the
    # sync may ever set it), so no future caller can forget it.
    if filament.zoho_item_id != linked_item_id_before:
        filament.zoho_synced_at = None
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
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CALCULATOR_UPDATE),
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
    except zoho_filaments.ZohoFilamentMappingError as exc:
        # A mapping/programming bug in the catalogue service, not an
        # unreachable Zoho — surfaced distinctly (500) so it is never mistaken
        # for the network failure below (T-074).
        logger.error("Zoho filament catalogue mapping failure: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Zoho filament catalogue could not be mapped") from exc
    except Exception as exc:
        logger.warning("Zoho filament catalogue unavailable: %s", exc, exc_info=True)
        raise HTTPException(status_code=502, detail="Could not reach Zoho") from exc
    return zoho_filaments.search_catalogue(catalogue, q, limit)


@router.post("/filaments/zoho-sync", response_model=CalculatorFilamentSyncResponse)
async def sync_calculator_filaments_from_zoho(
    payload: CalculatorFilamentSyncRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CALCULATOR_UPDATE),
):
    """Refresh one chunk of linked filaments from their Zoho dealer prices.

    Chunking is keyset paging by id, client-driven: the caller loops, passing
    each response's ``next_after_id`` back as the next request's ``after_id``,
    until it comes back null. Unlike offset paging, a filament deleted (or
    added) between chunks cannot shift the window and skip a row — the next
    chunk is always "ids greater than the last one processed". Each chunk
    commits its own work, so a mid-run Zoho failure leaves earlier chunks
    applied and a retry resumes from the id it reports.

    Prices only. Brand, material, margin and difficulty are never rewritten from
    Zoho, so a rename upstream cannot clobber a hand-corrected filament.
    """
    if not await zoho_service.is_configured(db):
        raise HTTPException(status_code=503, detail="Zoho is not configured")
    try:
        catalogue = await zoho_filaments.fetch_catalogue(db)
    except zoho_filaments.ZohoFilamentMappingError as exc:
        # See the identical branch in search_zoho_filaments above (T-074).
        logger.error("Zoho filament catalogue mapping failure during sync: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Zoho filament catalogue could not be mapped") from exc
    except Exception as exc:
        logger.warning("Zoho filament catalogue unavailable during sync: %s", exc, exc_info=True)
        raise HTTPException(status_code=502, detail="Could not reach Zoho") from exc

    total_result = await db.execute(
        select(func.count()).select_from(CalculatorFilament).where(CalculatorFilament.zoho_item_id.is_not(None))
    )
    total = total_result.scalar_one()

    # order_by(id) is load-bearing for correctness here, not just presentation:
    # the WHERE clause below ("id > after_id") depends on a stable id ordering
    # to define "the next page" at all. Fetching limit + 1 rows tells us
    # whether another chunk exists without a wasted, empty final request when
    # total is an exact multiple of limit.
    result = await db.execute(
        select(CalculatorFilament)
        .where(CalculatorFilament.zoho_item_id.is_not(None), CalculatorFilament.id > payload.after_id)
        .order_by(CalculatorFilament.id)
        .limit(payload.limit + 1)
    )
    fetched = result.scalars().all()
    has_more = len(fetched) > payload.limit
    chunk = fetched[: payload.limit]

    by_item_id = {product.item_id: product for product in catalogue}
    now = datetime.now(timezone.utc)

    updated = unchanged = skipped_no_price = missing = 0
    for filament in chunk:
        product = by_item_id.get(filament.zoho_item_id or "")
        if product is None:
            missing += 1
            continue

        # The filament's own stored weight wins: re-deriving it from the Zoho
        # name on every sync would let an upstream rename re-scale the price.
        weight = filament.spool_weight_kg or product.spool_weight_kg or 1.0
        new_cost = round(product.dealer_price / weight, 2)
        new_sale = derive_sale_price(new_cost, filament.margin_pct)

        # Guard the values about to be written, not just the upstream flag: a
        # tiny dealer price over a large stored weight can round to 0.0 even
        # when ``product.has_price`` is true, and a zero cost is never
        # written. ``isfinite`` matters too: a sub-denormal weight parsed out
        # of a Zoho item name can divide a normal dealer price into inf,
        # which ``new_cost <= 0`` does not catch (``inf <= 0`` is False).
        # The derived sale price is checked as well as new_cost itself: a
        # cost within bounds can still blow past the ceiling (or overflow to
        # inf) once the margin is applied, and either write would poison the
        # row for every later PATCH, which re-derives off the stored value.
        if (
            not product.has_price
            or new_cost <= 0
            or new_cost > _MONEY_CEILING
            or not math.isfinite(new_cost)
            or not math.isfinite(new_sale)
        ):
            skipped_no_price += 1
            continue

        filament.zoho_synced_at = now
        if abs(new_cost - filament.cost_per_kg) < 0.005:
            unchanged += 1
            continue
        filament.cost_per_kg = new_cost
        filament.sale_price_per_kg = new_sale
        updated += 1

    await db.commit()

    next_after_id = chunk[-1].id if has_more and chunk else None
    logger.info(
        "Zoho filament sync chunk after=%s limit=%s: %s updated, %s unchanged, %s without a dealer price, %s missing",
        payload.after_id,
        payload.limit,
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
        next_after_id=next_after_id,
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

    # A partial PATCH can invert the pair against the stored row; the schema
    # validator only sees the fields that were sent.
    if defaults.margin_max_mult < defaults.margin_min_mult:
        await db.rollback()
        raise HTTPException(status_code=422, detail="margin_max_mult must be >= margin_min_mult")

    await db.commit()
    await db.refresh(defaults)
    logger.info("Updated calculator defaults")
    return defaults


# --- Insights ---


@router.get("/insights", response_model=CalculatorInsightsResponse)
async def get_calculator_insights(
    days: InsightsWindowDays = Query(default=InsightsWindowDays.ONE_YEAR, description="Lookback window in days."),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.CALCULATOR_READ),
):
    """Measured pricing signals (failure rates, tariff, spool costs, time accuracy).

    Gated on CALCULATOR_READ alone by design: the aggregates are computed
    server-side so a calculator-only user doesn't need archives/spool read
    permissions to benefit from them.
    """
    return await calculator_insights_service.compute(db, days=days)
