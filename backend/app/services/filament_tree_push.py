"""Push half of SYNC: send every leaf whose generated preset differs from what Orca Cloud holds.

Runs after the pull, on the same Orca listing. Leaves are matched to Orca profiles by name (as the pull does).
A leaf with an unresolved conflict is never pushed: the user picks first, the next SYNC sends it.
"""

import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.config import settings
from backend.app.models.filament_profile import FilamentPreset
from backend.app.models.filament_tree import FilamentTreeLeaf
from backend.app.services.filament_tree import SKIP_KEYS
from backend.app.services.orca_cloud import OrcaCloudAuthError, OrcaCloudError

logger = logging.getLogger(__name__)

_KEEP_SNAPSHOTS = 20
_MAX_FAILURES_IN_A_ROW = 5  # rate limit or outage: stop, the next SYNC resumes (the diff is recomputed each time)


def _snapshot_dir() -> Path:
    return settings.base_dir / "orca_snapshots"


def _snapshot(entries: list[dict]) -> str:
    """Save Orca Cloud's filament profiles as they were before this push; keep the newest few."""
    folder = _snapshot_dir()
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"filaments-{datetime.now(timezone.utc):%Y%m%dT%H%M%S%fZ}.json"
    path.write_text(json.dumps(entries))
    for old in sorted(folder.glob("filaments-*.json"))[:-_KEEP_SNAPSHOTS]:
        old.unlink()
    return path.name


def _differs(generated: dict, orca: dict) -> bool:
    return any(v != orca.get(k) for k, v in generated.items() if k not in SKIP_KEYS)


def _is_filament(entry: dict) -> bool:
    return (entry.get("content") or {}).get("type") == "filament"


async def _can_write(svc) -> bool:
    return "sync:write" in str((await svc.introspect()).get("scope", ""))


async def cleanup_preview(db: AsyncSession, svc) -> dict:
    """Filament profiles in Orca Cloud that are not a tree leaf: what a cleanup would delete."""
    leaf_names = set(
        (
            await db.execute(
                select(FilamentPreset.name).join(FilamentTreeLeaf, FilamentTreeLeaf.preset_id == FilamentPreset.id)
            )
        ).scalars()
    )
    filaments = [e for e in await svc.list_profiles() if _is_filament(e)]
    strays = [e for e in filaments if e.get("name") not in leaf_names and e.get("id")]
    return {
        "count": len(strays),
        "names": sorted(str(e.get("name")) for e in strays),
        "writable": await _can_write(svc),
        "_filaments": filaments,
        "_ids": [str(e["id"]) for e in strays],
    }


async def cleanup_orca(db: AsyncSession, svc, expected: int) -> dict:
    """Snapshot, then delete every Orca Cloud filament profile that is not a tree leaf. Printer and process
    profiles are never touched. ``expected`` is the count the user confirmed: anything else refuses."""
    preview = await cleanup_preview(db, svc)
    if not preview["writable"]:
        raise ValueError("Orca Cloud is connected read-only: disconnect and reconnect it to allow deleting")
    if preview["count"] != expected:
        raise ValueError(f"Orca Cloud changed: {preview['count']} profiles would be deleted, not {expected}")
    ids = preview["_ids"]
    if not ids:
        return {"deleted": 0, "failed": 0, "snapshot": None}
    snapshot = _snapshot(preview["_filaments"])
    for i in range(0, len(ids), 100):
        await svc.delete_profiles(ids[i : i + 100])
    left = {str(e.get("id")) for e in await svc.list_profiles()} & set(ids)  # trust the listing, not the reply
    return {"deleted": len(ids) - len(left), "failed": len(left), "snapshot": snapshot}


async def push_leaves(db: AsyncSession, svc, entries: list[dict], skip: set[tuple]) -> dict:
    """``skip``: (tree_id, machine, nozzle, color_id) of leaves with an open conflict."""
    out: dict = {"pushed": 0, "failed": [], "remaining": 0, "needs_write_scope": False, "snapshot": None}
    filaments = [e for e in entries if _is_filament(e)]
    by_name = {e.get("name"): e for e in filaments}
    rows = (
        await db.execute(
            select(FilamentTreeLeaf, FilamentPreset)
            .join(FilamentPreset, FilamentPreset.id == FilamentTreeLeaf.preset_id)
            .order_by(FilamentPreset.name)
        )
    ).all()
    todo = []
    for link, preset in rows:
        if (link.tree_id, link.machine, link.nozzle, link.color_id) in skip:
            continue
        content = json.loads(preset.content)
        entry = by_name.get(preset.name)
        if entry is None or _differs(content, entry["content"]):
            todo.append((link, preset.name, content, entry))
    if not todo:
        return out
    if not await _can_write(svc):
        out["needs_write_scope"] = True
        out["remaining"] = len(todo)
        return out
    out["snapshot"] = _snapshot(filaments)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    streak = 0
    try:
        for done, (link, name, content, entry) in enumerate(todo):
            try:
                await svc.push_profile(
                    profile_id=str(entry["id"]) if entry else str(uuid.uuid4()),
                    name=name,
                    content={"type": "filament", **content},  # the pull only reads profiles carrying this marker
                    original_updated_time=entry.get("updated_time") if entry else None,
                )
            except OrcaCloudAuthError:
                raise
            except OrcaCloudError as e:
                logger.info("Orca push of %s failed: %s", name, e)
                out["failed"].append({"name": name, "detail": str(e)})
                streak += 1
                if streak >= _MAX_FAILURES_IN_A_ROW:
                    out["remaining"] = len(todo) - done - 1
                    break
                continue
            streak = 0
            link.baseline_content = json.dumps(content, indent=4)  # Orca now holds exactly this
            link.exported_at = now
            link.export_pending = False
            out["pushed"] += 1
    finally:
        await db.commit()  # an auth failure mid-run must not forget what Orca already took
    return out
