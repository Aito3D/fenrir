"""CRUD routes for user-authored filament profiles (Filament Profile Manager)."""

import asyncio
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
    BaseContentResponse,
    BaseFilamentPresetResponse,
    BaseSyncResult,
    FilamentPresetCreate,
    FilamentPresetResponse,
    FilamentPresetUpdate,
)
from backend.app.services.bambu_studio import collect_base_presets, read_bundle_preset, scan_user_presets

router = APIRouter(prefix="/filament-profiles", tags=["filament-profiles"])

DUPLICATE_FIELDS = ("name", "brand", "material", "color", "color_hex", "filename", "content")

# --- static routes (bambu-scan, base-content, base-presets, sync-base, bambu-sync) go above the /{preset_id} routes; added in Tasks 4-5 ---


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
