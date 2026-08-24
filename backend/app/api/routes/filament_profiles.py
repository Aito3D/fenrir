"""CRUD routes for user-authored filament profiles (Filament Profile Manager)."""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.filament_profile import FilamentPreset
from backend.app.models.user import User
from backend.app.schemas.filament_profile import FilamentPresetCreate, FilamentPresetResponse, FilamentPresetUpdate

router = APIRouter(prefix="/filament-profiles", tags=["filament-profiles"])

DUPLICATE_FIELDS = ("name", "brand", "material", "color", "color_hex", "filename", "content")

# --- static routes (bambu-scan, base-content, base-presets, sync-base, bambu-sync) go above the /{preset_id} routes; added in Tasks 4-5 ---


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
