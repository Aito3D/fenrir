"""Pydantic schemas for the filament preset manager and Bambu Studio sync."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

# T-028: input-side size caps for the user-authored preset's short text
# fields and its full slicer JSON blob. Response models (FilamentPresetResponse,
# BaseContentResponse, ...) intentionally carry none of these -- a row already
# stored above a cap (e.g. before this change shipped) must still be readable
# in full; only *writing* a new value above the cap is rejected.
#
# _CONTENT_MAX_LENGTH: measured every bundled Bambu Studio filament preset
# shipped with a local BambuStudio.app install (2054 files under
# `.../profiles/BBL/filament`) -- individual per-filament presets (the shape
# `content` actually stores; not the shared lookup tables also living in that
# folder, like `filaments_color_codes.json`, which are never a single
# preset's content) top out at 5164 bytes ("Bambu TPU 90A @BBL H2D 0.6
# nozzle.json"). 256 KiB is ~50x that measured maximum, comfortably clearing
# the "generous margin" bar without letting a stored blob multiply into the
# many-megabyte range that made /zoho-sync's per-request memory use a
# concern in the first place.
_CONTENT_MAX_LENGTH = 262_144  # 256 KiB
# _SHORT_TEXT_MAX_LENGTH: the model's `name`/`brand`/`material`/`color`
# columns are unbounded SQLAlchemy `String` (TEXT in SQLite), so there is no
# existing DB-layer length to match. 200 is a generous cap for a label field
# that in every real preset scanned above is well under 60 characters.
_SHORT_TEXT_MAX_LENGTH = 200
# _COLOR_HEX_MAX_LENGTH: `color_hex` is always a normalized CSS hex colour
# ("#RRGGBB" or "#RRGGBBAA", <= 9 characters -- see
# frontend/src/components/filament-profiles/presetJson.ts normalizeColorHex).
# 32 leaves headroom for a hand-edited value while still being far below the
# unbounded column's ceiling.
_COLOR_HEX_MAX_LENGTH = 32
# _FILENAME_MAX_LENGTH: real bundled filenames top out at 52 characters
# ("Bambu Support For PLA-PETG @BBL H2DP 0.6 nozzle.json"). 255 matches the
# common filesystem max-filename-length convention and stays generous over
# that measured maximum.
_FILENAME_MAX_LENGTH = 255


def _validate_bare_filename(value: str) -> str:
    """Mirror the bambu-sync bare-filename check at the storage boundary.

    A preset stored with a path-shaped filename ("..", "/" or "\\") makes the
    whole Sync-to-PC request 400 (bambu_sync validates every preset in the
    payload at once) and lands as a traversal-shaped entry name in the
    export ZIP. Rejecting it here, at create/update time, keeps every stored
    filename bare so those downstream consumers never see a bad one.
    """
    if not value or ".." in value or "/" in value or "\\" in value:
        raise ValueError("filename must be a bare file name")
    return value


class FilamentPresetCreate(BaseModel):
    name: str = Field("", max_length=_SHORT_TEXT_MAX_LENGTH)
    brand: str = Field("", max_length=_SHORT_TEXT_MAX_LENGTH)
    material: str = Field("", max_length=_SHORT_TEXT_MAX_LENGTH)
    color: str = Field("", max_length=_SHORT_TEXT_MAX_LENGTH)
    color_hex: str = Field("", max_length=_COLOR_HEX_MAX_LENGTH)
    filename: str = Field("", max_length=_FILENAME_MAX_LENGTH)
    content: str = Field("", max_length=_CONTENT_MAX_LENGTH)

    @field_validator("filename")
    @classmethod
    def _filename_is_bare(cls, v: str) -> str:
        return _validate_bare_filename(v)


class FilamentPresetUpdate(BaseModel):
    name: str | None = Field(None, max_length=_SHORT_TEXT_MAX_LENGTH)
    brand: str | None = Field(None, max_length=_SHORT_TEXT_MAX_LENGTH)
    material: str | None = Field(None, max_length=_SHORT_TEXT_MAX_LENGTH)
    color: str | None = Field(None, max_length=_SHORT_TEXT_MAX_LENGTH)
    color_hex: str | None = Field(None, max_length=_COLOR_HEX_MAX_LENGTH)
    filename: str | None = Field(None, max_length=_FILENAME_MAX_LENGTH)
    content: str | None = Field(None, max_length=_CONTENT_MAX_LENGTH)

    @field_validator("filename")
    @classmethod
    def _filename_is_bare(cls, v: str | None) -> str | None:
        if v is None:
            return v
        return _validate_bare_filename(v)


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
    # "no_match" | "ambiguous" | "no_price" mirror ProfileMatch.outcome.
    # "unwritable_content" is not a match outcome: the item matched fine, but
    # the preset's own content was empty or unparseable JSON, so there was
    # nowhere to write the price. See apply_filament_cost's "unwritable".
    # "bad_price" is also not a match outcome: the item matched and the
    # preset's content is fine, but the item's own cost_per_kg is non-finite,
    # <= 0, or above the ceiling. See apply_filament_cost's "bad_price".
    # "weight_unknown" is also not a match outcome: the item matched and its
    # price is usable, but its cost_per_kg was derived from a 1 kg default
    # because the Zoho item name carried no weight at all
    # (FilamentProduct.weight_inferred). Writing that price would let an
    # upstream rename silently re-scale it, exactly what the calculator's own
    # sync refuses to do — so it is reported instead of written.
    reason: Literal["no_match", "ambiguous", "no_price", "unwritable_content", "bad_price", "weight_unknown"]
    # Colliding item names for "ambiguous", the single unpriced item for
    # "no_price", the single matched item for "weight_unknown", empty for
    # "no_match", "unwritable_content" and "bad_price". A list, not one name:
    # naming only one of an ambiguous pair would hide the actual problem.
    # Capped at 5 entries for "ambiguous" — see candidates_total for the true
    # count.
    candidates: list[str] = []
    # The TRUE number of items behind `candidates`. For "ambiguous" this can
    # exceed len(candidates) once the cap above truncates the list, so the UI
    # can still render a "+N more" instead of silently dropping items with no
    # trace. For every other reason it equals len(candidates) (0 for
    # "no_match", "unwritable_content" and "bad_price"; 1 for "no_price" and
    # "weight_unknown").
    # Always present rather than sometimes-omitted, so the response shape is
    # predictable regardless of reason.
    candidates_total: int = 0


class FilamentPresetZohoSyncResponse(BaseModel):
    """Counts are disjoint and sum to the profile count.

    ``priced`` and ``unchanged`` are both confident matches, split by whether
    the value actually moved; ``attention`` is everything else.
    """

    priced: int
    unchanged: int
    attention: list[FilamentPresetZohoSyncAttention] = []
    # T-034: set only when the catalogue this sync priced from came from
    # fetch_catalogue's failure-branch stale-cache fallback (Zoho was
    # unreachable and the cache's age has no upper bound) rather than a fresh
    # fetch or an unexpired cache hit. The value is the timestamp that
    # catalogue was actually last captured at. None means the catalogue was
    # fresh. Additive and defaulted so old clients are unaffected.
    catalogue_stale_since: datetime | None = None
