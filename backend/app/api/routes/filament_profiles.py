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
    _CONTENT_MAX_LENGTH,
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
    _derive_bare_filename,
    _validate_bare_filename,
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

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/filament-profiles", tags=["filament-profiles"])

DUPLICATE_FIELDS = ("name", "brand", "material", "color", "color_hex", "filename", "content")

# T-038: caps the number of attention entries a zoho-sync response reports,
# mirroring zoho_filaments._MAX_REPORTED_CANDIDATES's spirit at a list scale.
# A user who imports a full preset library with no Zoho match otherwise gets
# one attention entry per preset with no bound, pushing the response (and the
# page's un-virtualized attention panel) to hundreds of rows. 50 is generous
# enough for an operator to act on in one sitting; attention_total on the
# response carries the true count so the UI can render "and N more".
_MAX_REPORTED_ATTENTION = 50

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
    try:
        _validate_bare_filename(filename)
    except ValueError as exc:
        raise HTTPException(400, "Invalid filename") from exc
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
        try:
            _validate_bare_filename(filename)
        except ValueError as exc:
            raise HTTPException(400, f"presets[{i}]: filename must be a bare file name") from exc
        validated.append({"filename": filename, "content": content})
    return validated


@router.post("/bambu-sync", response_model=BambuSyncResponse)
async def bambu_sync(
    payload: BambuSyncRequest,
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.FILAMENTS_UPDATE),
):
    validated = _validate_bambu_sync_presets(payload.presets)

    if payload.dry_run:
        stats = await asyncio.to_thread(
            lambda: compute_sync_stats(validated, read_disk_state(), get_user_filament_dirs())
        )
    else:
        # apply_sync mirrors *validated* into every user preset folder,
        # unlinking anything on disk that isn't in the incoming list — so the
        # non-dry-run path is destructive in a way the dry-run stats-only
        # path never is, and needs filaments:delete on top of the route's
        # filaments:update gate. current_user is None either because auth is
        # disabled (nothing to check) or because the caller authenticated
        # with an API key: filaments:update/delete are unmapped in
        # _APIKEY_SCOPE_BY_PERMISSION, so authorize_api_key() inside the
        # dependency already 403s any API key before it reaches this line —
        # the extra check below only ever fires for a JWT user. Same shape
        # as github_backup.py's per-category restore check.
        if current_user is not None and not current_user.has_all_permissions(Permission.FILAMENTS_DELETE.value):
            raise HTTPException(
                status_code=403,
                detail=f"Missing required permissions: {Permission.FILAMENTS_DELETE.value}",
            )
        # An empty list is a well-formed request that would otherwise wipe
        # every on-disk preset in every configured Bambu Studio filament
        # directory (apply_sync removes anything not incoming). Dry-run
        # already reports that destructively via `stats.removed` without
        # touching disk, so only the non-dry-run call is rejected here.
        if not validated:
            raise HTTPException(400, "presets must not be empty for a non-dry-run sync")
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
    # T-027: this reaches the same Zoho catalogue the calculator's
    # zoho routes gate on CALCULATOR_UPDATE (calculator.py), so a custom
    # role holding only filaments:update must not gain read access to it
    # or be able to drive the outbound paged Zoho walk. Both permissions
    # required — RequirePermissionIfAuthEnabled's varargs default to
    # all-must-pass.
    _: User | None = RequirePermissionIfAuthEnabled(Permission.FILAMENTS_UPDATE, Permission.CALCULATOR_UPDATE),
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
    # 500, not 502, on a mapping failure: a catalogue we failed to parse is a
    # bug on this side, and calling it an upstream outage sends the operator
    # to the wrong system. Same split as the calculator's routes (T-074).
    # T-034: `stale_since` is set when Zoho was unreachable and this catalogue
    # came from fetch_catalogue's failure-branch stale-cache fallback, which
    # carries no upper bound on its age — the sync below still runs and
    # writes with it (refusing outright would make the feature unusable
    # during an outage), but the response must disclose that instead of
    # reporting a plain, indistinguishable-from-live success.
    catalogue, stale_since = await zoho_filaments._fetch_catalogue_or_502(db, context="during profile sync")

    # T-048: an empty catalogue (Books' cf_nature_du_produit filter stopped
    # matching anything, items got re-categorised, etc.) makes match_profile
    # report "no_match" for every single profile below — a wall of
    # needs-attention entries that sends the operator to re-check spellings
    # on profiles that are fine, while the real fault is upstream. That's
    # also what fetch_catalogue then caches for the full TTL, so it would
    # repeat on every retry for ten minutes. This is checked here rather than
    # in fetch_catalogue itself: the calculator's search hits the same cache
    # and legitimately returns [] for an empty catalogue, so the refusal
    # belongs at this route's boundary, not the shared fetch. 502 to match
    # the "upstream gave us something unusable" family the other branches of
    # _fetch_catalogue_or_502 already use.
    if not catalogue:
        raise HTTPException(status_code=502, detail="Zoho returned no filament items")

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
                    candidates_total=match.candidates_total,
                )
            )
            continue

        if match.product.weight_inferred:
            # Matched, and the price itself would be usable — but it was
            # derived from a 1 kg default because the Zoho item name carried
            # no weight at all (FilamentProduct.weight_inferred). Writing it
            # would let an upstream rename of that item silently re-scale the
            # preset's stored price, exactly what the calculator's own sync
            # refuses to do (see its "weight wins" comment). So this is
            # reported for operator review instead of auto-priced.
            attention.append(
                FilamentPresetZohoSyncAttention(
                    id=preset.id,
                    name=preset.name,
                    reason="weight_unknown",
                    candidates=[match.product.name],
                    candidates_total=1,
                )
            )
            continue

        content, outcome = apply_filament_cost(preset.content, match.product.cost_per_kg)
        if outcome == "written":
            # apply_filament_cost re-serialises with indent=4 (to match the
            # frontend's own writer), which can inflate compact JSON by
            # roughly 3x — a preset saved right under the input-side
            # _CONTENT_MAX_LENGTH cap could round-trip past it here. Checked
            # against the same constant the CRUD routes enforce on writes, so
            # a sync can never store a blob larger than a direct edit could.
            if len(content) > _CONTENT_MAX_LENGTH:
                logger.warning(
                    "Zoho sync: preset %s (%r) priced content would exceed the %d-byte cap "
                    "after re-indenting; skipping price write and flagging for attention",
                    preset.id,
                    preset.name,
                    _CONTENT_MAX_LENGTH,
                )
                attention.append(
                    FilamentPresetZohoSyncAttention(
                        id=preset.id,
                        name=preset.name,
                        reason="content_too_large",
                        candidates=[],
                    )
                )
            else:
                preset.content = content
                priced += 1
        elif outcome == "unchanged":
            unchanged += 1
        elif outcome == "bad_price":
            # Matched, but the upstream price itself is unusable: non-finite,
            # <= 0, or above the ceiling. Distinct from "unwritable_content" —
            # the preset's own data is fine, the Zoho item's price is not —
            # so it gets its own reason rather than being told its file is
            # broken.
            logger.warning(
                "Zoho sync: preset %s (%r) matched an item with an unusable price (%r); "
                "skipping price write and flagging for attention",
                preset.id,
                preset.name,
                match.product.cost_per_kg,
            )
            attention.append(
                FilamentPresetZohoSyncAttention(
                    id=preset.id,
                    name=preset.name,
                    reason="bad_price",
                    candidates=[],
                )
            )
        else:
            # Matched, but there was nowhere to write the price: empty,
            # unparseable, or non-object content. Must not be counted as
            # "unchanged" — that means the price was already correct, and
            # here it is unknown whether it is correct at all.
            logger.warning(
                "Zoho sync: preset %s (%r) matched but its content is empty or unreadable; "
                "skipping price write and flagging for attention",
                preset.id,
                preset.name,
            )
            attention.append(
                FilamentPresetZohoSyncAttention(
                    id=preset.id,
                    name=preset.name,
                    reason="unwritable_content",
                    candidates=[],
                )
            )

    await db.commit()
    return FilamentPresetZohoSyncResponse(
        priced=priced,
        unchanged=unchanged,
        attention=attention[:_MAX_REPORTED_ATTENTION],
        attention_total=len(attention),
        catalogue_stale_since=stale_since,
    )


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

    # T-045: `expected_updated_at` is the `updated_at` the caller's fields
    # were derived from -- omitted (None) by any pre-T-045 caller, which
    # keeps this whole-content PATCH unconditional exactly as before. When
    # present, it must still match the stored row, otherwise a save started
    # before a concurrent write (e.g. /zoho-sync) landed would silently
    # clobber that write. `row.updated_at` round-trips through
    # `FilamentPresetResponse` (a plain FastAPI/pydantic datetime -> ISO
    # string encode with no timezone normalisation, since the column is
    # naive UTC), and a compliant caller sends back exactly that string, so
    # comparing the parsed datetimes directly is safe here.
    if payload.expected_updated_at is not None and payload.expected_updated_at != row.updated_at:
        raise HTTPException(409, "This preset changed on the server since it was loaded — reload and try again")

    data = payload.model_dump(exclude_unset=True, exclude={"expected_updated_at"})
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
    # T-030: `source.filename` bypassed `_validate_bare_filename` if it was
    # stored before that check existed (create/update run it; this direct
    # model construction above does not). Normalising here instead of
    # rejecting means a legacy path-shaped row can still be duplicated — it
    # just stops multiplying the bad name. Already-bare filenames pass
    # through unchanged.
    row.filename = _derive_bare_filename(row.filename, source.id)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row
