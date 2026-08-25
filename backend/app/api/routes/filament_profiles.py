"""CRUD routes for user-authored filament profiles (Filament Profile Manager)."""

import asyncio
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.filament_profile import BaseFilamentPreset, FilamentPreset
from backend.app.models.user import User
from backend.app.schemas.filament_profile import (
    BambuScanResponse,
    BambuSyncRequest,
    BambuSyncResponse,
    BaseContentResponse,
    BaseFilamentPresetResponse,
    BaseSyncResult,
    FilamentPresetCreate,
    FilamentPresetResponse,
    FilamentPresetUpdate,
    FilamentPresetZohoSyncAttention,
    FilamentPresetZohoSyncResponse,
)
from backend.app.services import zoho_filaments
from backend.app.services.bambu_studio import (
    apply_sync,
    collect_base_presets,
    compute_sync_stats,
    get_user_filament_dirs,
    read_bundle_preset,
    read_disk_state,
    scan_user_presets,
)
from backend.app.services.filament_profile_pricing import apply_filament_cost
from backend.app.services.zoho import zoho_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/filament-profiles", tags=["filament-profiles"])

DUPLICATE_FIELDS = ("name", "brand", "material", "color", "color_hex", "filename", "content")

# --- static routes (bambu-scan, base-content, base-presets, sync-base, bambu-sync, zoho-sync) must stay above the /{preset_id} routes, or FastAPI matches "base-presets" etc. as a preset_id path param ---


@router.get("/base-presets", response_model=list[BaseFilamentPresetResponse])
async def list_base_presets(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FILAMENTS_READ),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(BaseFilamentPreset).order_by(BaseFilamentPreset.name.asc()))
    return list(result.scalars().all())


@router.get("/base-content", response_model=BaseContentResponse)
async def get_base_content(
    filename: str,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FILAMENTS_READ),
):
    if not filename or ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(400, "Invalid filename")
    content = await asyncio.to_thread(read_bundle_preset, filename)
    if content is None:
        raise HTTPException(404, "File not found")
    return {"content": content}


@router.get("/bambu-scan", response_model=BambuScanResponse)
async def bambu_scan(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FILAMENTS_READ),
):
    files = await asyncio.to_thread(scan_user_presets)
    return {"files": files}


@router.post("/sync-base", response_model=BaseSyncResult)
async def sync_base_presets(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FILAMENTS_UPDATE),
    db: AsyncSession = Depends(get_db),
):
    records = await asyncio.to_thread(collect_base_presets)

    result = await db.execute(select(BaseFilamentPreset))
    existing_by_filename = {row.filename: row for row in result.scalars().all()}

    added = 0
    updated = 0
    unchanged = 0
    diff_fields = ("name", "inherits", "brand", "material")

    for record in records:
        row = existing_by_filename.get(record["filename"])
        if row is None:
            db.add(BaseFilamentPreset(**record))
            added += 1
            continue

        if any(getattr(row, field) != record.get(field, "") for field in diff_fields):
            for field in diff_fields:
                setattr(row, field, record.get(field, ""))
            row.color_hex = record.get("color_hex", "")
            updated += 1
        else:
            unchanged += 1

    await db.commit()
    return {"added": added, "updated": updated, "unchanged": unchanged, "total": len(records)}


def _validate_bambu_sync_presets(presets: list) -> list[dict[str, str]]:
    validated: list[dict[str, str]] = []
    for i, entry in enumerate(presets):
        if not isinstance(entry, dict):
            raise HTTPException(400, f"presets[{i}]: entry must be an object")
        filename = entry.get("filename")
        if not isinstance(filename, str):
            raise HTTPException(400, f"presets[{i}]: filename must be a string")
        content = entry.get("content")
        if not isinstance(content, str):
            raise HTTPException(400, f"presets[{i}]: content must be a string")
        if not filename or ".." in filename or "/" in filename or "\\" in filename:
            raise HTTPException(400, f"presets[{i}]: filename must be a bare file name")
        validated.append({"filename": filename, "content": content})
    return validated


@router.post("/bambu-sync", response_model=BambuSyncResponse)
async def bambu_sync(
    payload: BambuSyncRequest,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FILAMENTS_UPDATE),
):
    validated = _validate_bambu_sync_presets(payload.presets)

    if payload.dry_run:
        stats = await asyncio.to_thread(
            lambda: compute_sync_stats(validated, read_disk_state(), get_user_filament_dirs())
        )
    else:
        stats = await asyncio.to_thread(apply_sync, validated)

    return {"stats": stats}


@router.get("", response_model=list[FilamentPresetResponse])
async def list_filament_profiles(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FILAMENTS_READ),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(FilamentPreset).order_by(FilamentPreset.name.asc()))
    return list(result.scalars().all())


@router.post("", response_model=FilamentPresetResponse)
async def create_filament_profile(
    payload: FilamentPresetCreate,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FILAMENTS_CREATE),
    db: AsyncSession = Depends(get_db),
):
    row = FilamentPreset(
        name=payload.name,
        brand=payload.brand,
        material=payload.material,
        color=payload.color,
        color_hex=payload.color_hex,
        filename=payload.filename,
        content=payload.content,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@router.post("/zoho-sync", response_model=FilamentPresetZohoSyncResponse)
async def sync_filament_presets_from_zoho(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FILAMENTS_UPDATE),
):
    """Price every profile from its matching Zoho item.

    Matches on brand + material + colour and writes ``filament_cost`` only where
    exactly one priced item matches. Everything else is left byte-identical and
    reported, so an auto-match can never silently write a wrong price.

    Unlike the calculator's sync this stores no link: the match is recomputed
    every run, so there is nothing to keep in step. See the design doc for why
    auto-matching is safe here and not there.

    One pass, no chunking: profiles are a hand-curated set. If that stops being
    true, the calculator's keyset paging is the pattern to copy.
    """
    if not await zoho_service.is_configured(db):
        raise HTTPException(status_code=503, detail="Zoho is not configured")
    try:
        catalogue = await zoho_filaments.fetch_catalogue(db)
    except zoho_filaments.ZohoFilamentMappingError as exc:
        # 500, not 502: a catalogue we failed to parse is a bug on this side,
        # and calling it an upstream outage sends the operator to the wrong
        # system. Same split as the calculator's routes (T-074).
        logger.error("Zoho filament catalogue mapping failure during profile sync: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Zoho filament catalogue could not be mapped") from exc
    except Exception as exc:
        logger.warning("Zoho filament catalogue unavailable during profile sync: %s", exc, exc_info=True)
        raise HTTPException(status_code=502, detail="Could not reach Zoho") from exc

    result = await db.execute(select(FilamentPreset).order_by(FilamentPreset.id))
    presets = result.scalars().all()

    priced = unchanged = 0
    attention: list[FilamentPresetZohoSyncAttention] = []

    for preset in presets:
        match = zoho_filaments.match_profile(catalogue, preset.brand, preset.material, preset.color)
        if match.outcome != "matched" or match.product is None:
            attention.append(
                FilamentPresetZohoSyncAttention(
                    id=preset.id,
                    name=preset.name,
                    reason=match.outcome,
                    candidates=match.candidates,
                )
            )
            continue

        content, changed = apply_filament_cost(preset.content, match.product.cost_per_kg)
        if changed:
            preset.content = content
            priced += 1
        else:
            unchanged += 1

    await db.commit()
    return FilamentPresetZohoSyncResponse(priced=priced, unchanged=unchanged, attention=attention)


@router.patch("/{preset_id}", response_model=FilamentPresetResponse)
async def update_filament_profile(
    preset_id: int,
    payload: FilamentPresetUpdate,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FILAMENTS_UPDATE),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(FilamentPreset).where(FilamentPreset.id == preset_id))
    row = result.scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Preset not found")

    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(row, key, value if value is not None else "")

    row.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(row)
    return row


@router.delete("/{preset_id}")
async def delete_filament_profile(
    preset_id: int,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FILAMENTS_DELETE),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(FilamentPreset).where(FilamentPreset.id == preset_id))
    row = result.scalar_one_or_none()
    if row:
        await db.delete(row)
        await db.commit()
    return {"success": True}


@router.post("/{preset_id}/duplicate", response_model=FilamentPresetResponse)
async def duplicate_filament_profile(
    preset_id: int,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FILAMENTS_CREATE),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(FilamentPreset).where(FilamentPreset.id == preset_id))
    source = result.scalar_one_or_none()
    if not source:
        raise HTTPException(404, "Preset not found")

    row = FilamentPreset(**{field: getattr(source, field) for field in DUPLICATE_FIELDS})
    row.name = f"{source.name} (copie)"
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row
