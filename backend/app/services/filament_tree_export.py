"""Export for Orca: zip of generated leaf presets. Leaves are marked exported only when the client confirms the
download (baseline waits for SYNC to see Orca)."""

import hashlib
import io
import secrets
import zipfile
from collections import OrderedDict
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.filament_profile import FilamentPreset
from backend.app.models.filament_tree import FilamentTreeLeaf
from backend.app.services.filament_tree_store import _get_tree, _tree_write_lock

# token -> {leaf_id: (tree_id, sha256 of the zipped preset)}. In memory, newest _MAX_OPEN kept: after a restart or an
# eviction the confirm 404s and the leaves simply stay pending (safe direction).
_MAX_OPEN = 32
_open_exports: "OrderedDict[str, dict[int, tuple[int, str]]]" = OrderedDict()


def _digest(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


async def build_export_zip(db: AsyncSession, tree_id: int | None, changed_only: bool = False) -> tuple[bytes, str]:
    """Zip plus the token the client sends to confirm_export once it holds the file. Read-only."""
    query = select(FilamentTreeLeaf, FilamentPreset).join(
        FilamentPreset, FilamentPreset.id == FilamentTreeLeaf.preset_id
    )
    if tree_id is not None:
        await _get_tree(db, tree_id)  # LookupError when unknown
        query = query.where(FilamentTreeLeaf.tree_id == tree_id)
    if changed_only:
        query = query.where(FilamentTreeLeaf.export_pending)
    rows = (await db.execute(query.order_by(FilamentPreset.name))).all()
    exported: dict[int, tuple[int, str]] = {}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for leaf, preset in rows:
            zf.writestr(zipfile.ZipInfo(f"{preset.name}.json", date_time=(1980, 1, 1, 0, 0, 0)), preset.content)
            exported[leaf.id] = (leaf.tree_id, _digest(preset.content))
    token = secrets.token_urlsafe(16)
    _open_exports[token] = exported
    while len(_open_exports) > _MAX_OPEN:
        _open_exports.popitem(last=False)
    return buf.getvalue(), token


async def confirm_export(db: AsyncSession, token: str) -> int:
    """Mark the leaves of that export as exported, except those whose preset changed since (they stay pending).
    Returns how many were cleared. LookupError for an unknown or already confirmed token."""
    exported = _open_exports.get(token)
    if exported is None:
        raise LookupError("unknown export token")
    async with _tree_write_lock({tree for tree, _ in exported.values()}):
        if _open_exports.pop(token, None) is None:  # a concurrent confirm won the lock
            raise LookupError("unknown export token")
        rows = (
            await db.execute(
                select(FilamentTreeLeaf, FilamentPreset)
                .join(FilamentPreset, FilamentPreset.id == FilamentTreeLeaf.preset_id)
                .where(FilamentTreeLeaf.id.in_(exported))
            )
        ).all()
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        cleared = 0
        for leaf, preset in rows:
            if _digest(preset.content) == exported[leaf.id][1]:
                leaf.exported_at = now
                leaf.export_pending = False
                cleared += 1
        await db.commit()
    return cleared
