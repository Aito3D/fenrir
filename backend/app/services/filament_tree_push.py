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
from backend.app.services.orca_cloud import OrcaCloudAuthError, OrcaCloudError
from backend.app.services.orca_cloud_codec import decode_content, encode_content, is_wire_format

logger = logging.getLogger(__name__)

_KEEP_SNAPSHOTS = 20
_MAX_FAILURES_IN_A_ROW = 5  # rate limit or outage: stop, the next SYNC resumes (the diff is recomputed each time)


def _snapshot_dir() -> Path:
    return settings.base_dir / "orca_snapshots"


def _snapshot(entries: list[dict], prefix: str = "filaments") -> str:
    """Save Orca Cloud's filament profiles as they were before this push; keep the newest few.
    Only push snapshots (the default prefix) rotate: a ``cleanup`` snapshot is never pruned."""
    folder = _snapshot_dir()
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{prefix}-{datetime.now(timezone.utc):%Y%m%dT%H%M%S%fZ}.json"
    path.write_text(json.dumps(entries))
    if prefix == "filaments":
        for old in sorted(folder.glob("filaments-*.json"))[:-_KEEP_SNAPSHOTS]:
            old.unlink()
    return path.name


def _differs(generated: dict, orca: dict) -> bool:
    # every generated key, identity keys included: the pull skips those, so only a push can fix a colour or
    # printer list Orca holds differently
    return any(v != orca.get(k) for k, v in generated.items())


def _is_filament(entry: object) -> bool:
    # a malformed entry (not a dict, or content not a dict) is nobody's filament: the pull counts it as ignored
    content = entry.get("content") if isinstance(entry, dict) else None
    return isinstance(content, dict) and content.get("type") == "filament"


async def can_write(svc) -> bool:
    return "sync:write" in str((await svc.introspect()).get("scope", ""))


async def stray_filaments(db: AsyncSession, entries: list[dict], keep: frozenset[str] = frozenset()) -> list[dict]:
    """Orca Cloud filament profiles that are no tree leaf. ``keep``: names to leave alone anyway."""
    leaf_names = set(
        (
            await db.execute(
                select(FilamentPreset.name).join(FilamentTreeLeaf, FilamentTreeLeaf.preset_id == FilamentPreset.id)
            )
        ).scalars()
    )
    return [
        e
        for e in entries
        if _is_filament(e) and e.get("id") and e.get("name") not in leaf_names and e.get("name") not in keep
    ]


async def cleanup_preview(db: AsyncSession, svc) -> dict:
    """Filament profiles in Orca Cloud that are not a tree leaf: what a cleanup would delete."""
    filaments = [e for e in await svc.list_profiles() if _is_filament(e)]
    strays = await stray_filaments(db, filaments)
    return {
        "count": len(strays),
        "names": sorted(str(e.get("name")) for e in strays),
        "writable": await can_write(svc),
        "_filaments": filaments,
        "_ids": [str(e["id"]) for e in strays],
    }


async def cleanup_orca(db: AsyncSession, svc, confirmed: list[str]) -> dict:
    """Snapshot, then delete every Orca Cloud filament profile that is not a tree leaf. Printer and process
    profiles are never touched. ``confirmed`` are the names the user saw: any other stray set refuses."""
    preview = await cleanup_preview(db, svc)
    if not preview["writable"]:
        raise ValueError("Orca Cloud is connected read-only: disconnect and reconnect it to allow deleting")
    if preview["names"] != sorted(confirmed):
        raise ValueError(
            f"Orca Cloud changed: {preview['count']} profiles would be deleted, not the {len(confirmed)} confirmed"
        )
    return await _delete_profiles(svc, preview["_ids"], preview["_filaments"])


async def remove_strays(db: AsyncSession, svc, entries: list[dict], keep: frozenset[str]) -> dict:
    """SYNC's last step: delete the Orca Cloud filaments that are no tree leaf, so both sides hold the same set.
    Read-only pairing: nothing is deleted and every stray counts as failed."""
    strays = await stray_filaments(db, entries, keep)
    if strays and not await can_write(svc):
        return {"deleted": 0, "failed": len(strays), "snapshot": None}
    return await _delete_profiles(svc, [str(e["id"]) for e in strays], [e for e in entries if _is_filament(e)])


async def _delete_profiles(svc, ids: list[str], filaments: list[dict]) -> dict:
    """Snapshot ``filaments`` (Orca as it is), delete ``ids``, then count what the listing still holds."""
    if not ids:
        return {"deleted": 0, "failed": 0, "snapshot": None}
    snapshot = _snapshot(filaments, "cleanup")
    for i in range(0, len(ids), 100):
        try:
            await svc.delete_profiles(ids[i : i + 100])
        except OrcaCloudAuthError:
            raise
        except OrcaCloudError as e:
            logger.info("Orca cleanup delete batch failed: %s", e)  # the listing below counts what is left
    try:
        listing = await svc.list_profiles()
    except OrcaCloudAuthError:
        raise
    except OrcaCloudError as e:  # the deletes ran and the snapshot exists: say so, with the count unknown
        logger.info("Orca cleanup final check failed: %s", e)
        return {"deleted": None, "failed": None, "snapshot": snapshot}
    left = {str(e.get("id")) for e in listing} & set(ids)  # trust the listing, not the reply
    return {"deleted": len(ids) - len(left), "failed": len(left), "snapshot": snapshot}


async def _todo(db: AsyncSession, entries: list[dict], skip: set[tuple]) -> tuple[list[tuple], list[dict]]:
    """Leaves Orca Cloud lacks or holds differently, and Orca's filament entries.
    ``skip``: (tree_id, machine, nozzle, color_id) of leaves with an open conflict."""
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
        if entry is None or not is_wire_format(entry["content"]) or _differs(content, decode_content(entry["content"])):
            todo.append((link, preset.name, content, entry))
    return todo, filaments


async def push_names(db: AsyncSession, entries: list[dict], skip: set[tuple]) -> list[dict]:
    """The leaves a push would send, without sending them; ``new``: Orca Cloud does not hold it yet."""
    return [{"name": name, "new": entry is None} for _, name, _, entry in (await _todo(db, entries, skip))[0]]


async def push_leaves(
    db: AsyncSession, svc, entries: list[dict], skip: set[tuple], progress: dict | None = None
) -> dict:
    """``skip``: (tree_id, machine, nozzle, color_id) of leaves with an open conflict.
    ``progress``: its ``done``/``total``/``name`` are kept current while the leaves are sent; its ``stop`` set
    by anyone ends the run before the next leaf (``stopped``, the rest counted in ``remaining``)."""
    out: dict = {
        "pushed": 0,
        "failed": [],
        "remaining": 0,
        "needs_write_scope": False,
        "snapshot": None,
        "stopped": False,
    }
    todo, filaments = await _todo(db, entries, skip)
    if not todo:
        return out
    if not await can_write(svc):
        out["needs_write_scope"] = True
        out["remaining"] = len(todo)
        return out
    out["snapshot"] = _snapshot(filaments)
    if progress is not None:
        progress.update(total=len(todo), phase="push")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    streak = 0
    try:
        for done, (link, name, content, entry) in enumerate(todo):
            if progress is not None:
                if progress.get("stop"):
                    out["stopped"] = True
                    out["remaining"] = len(todo) - done
                    break
                progress.update(done=done, name=name)
            try:
                await svc.push_profile(
                    profile_id=str(entry["id"]) if entry else str(uuid.uuid4()),
                    name=name,
                    # the pull only reads profiles carrying the type marker
                    content=encode_content({"type": "filament", **content}),
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
