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
    # Reject unknown fields (e.g. a stray camelCase "dryRun") with a 422
    # instead of silently ignoring it and running the destructive, non-dry
    # sync path the caller actually meant to skip.
    model_config = {"extra": "forbid"}

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


class FilamentPresetZohoSyncAttention(BaseModel):
    """One profile the sync would not price, and why."""

    id: int
    name: str
    # "no_match" | "ambiguous" | "no_price" — mirrors ProfileMatch.outcome.
    # "unwritable_content" is not a match outcome: the item matched fine, but
    # the preset's own content was empty or unparseable JSON, so there was
    # nowhere to write the price. See apply_filament_cost's "unwritable".
    reason: str
    # Colliding item names for "ambiguous", the single unpriced item for
    # "no_price", empty for "no_match" and "unwritable_content". A list, not
    # one name: naming only one of an ambiguous pair would hide the actual
    # problem.
    candidates: list[str] = []


class FilamentPresetZohoSyncResponse(BaseModel):
    """Counts are disjoint and sum to the profile count.

    ``priced`` and ``unchanged`` are both confident matches, split by whether
    the value actually moved; ``attention`` is everything else.
    """

    priced: int
    unchanged: int
    attention: list[FilamentPresetZohoSyncAttention] = []
