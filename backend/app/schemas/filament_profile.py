"""Pydantic schemas for the filament preset manager and Bambu Studio sync."""

from datetime import datetime
from typing import Any

from pydantic import BaseModel


class FilamentPresetCreate(BaseModel):
    name: str = ""
    brand: str = ""
    material: str = ""
    color: str = ""
    color_hex: str = ""
    filename: str = ""
    content: str = ""


class FilamentPresetUpdate(BaseModel):
    name: str | None = None
    brand: str | None = None
    material: str | None = None
    color: str | None = None
    color_hex: str | None = None
    filename: str | None = None
    content: str | None = None


class FilamentPresetResponse(BaseModel):
    id: int
    name: str
    brand: str
    material: str
    color: str
    color_hex: str
    filename: str
    content: str
    created_at: datetime | None
    updated_at: datetime | None

    model_config = {"from_attributes": True}


class BaseFilamentPresetResponse(BaseModel):
    id: int
    name: str
    inherits: str
    brand: str
    material: str
    color: str
    color_hex: str
    filename: str

    model_config = {"from_attributes": True}


class SyncStats(BaseModel):
    added: int
    updated: int
    removed: int
    unchanged: int


class BambuSyncRequest(BaseModel):
    presets: list[Any]
    dry_run: bool = False


class BambuScanFile(BaseModel):
    filename: str
    content: str


class BambuScanResponse(BaseModel):
    files: list[BambuScanFile]


class BaseSyncResult(BaseModel):
    added: int
    updated: int
    unchanged: int
    total: int


class BambuSyncResponse(BaseModel):
    stats: SyncStats


class BaseContentResponse(BaseModel):
    content: str
