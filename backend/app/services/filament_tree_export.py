"""Export for Orca: zip of generated leaf presets; marks leaves exported (baseline waits for SYNC to see Orca)."""

import io
import zipfile
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.filament_profile import FilamentPreset
from backend.app.models.filament_tree import FilamentTreeLeaf
from backend.app.services.filament_tree_store import _get_tree


async def build_export_zip(db: AsyncSession, tree_id: int | None, changed_only: bool = False) -> bytes:
    query = select(FilamentTreeLeaf, FilamentPreset).join(
        FilamentPreset, FilamentPreset.id == FilamentTreeLeaf.preset_id
    )
    if tree_id is not None:
        await _get_tree(db, tree_id)  # LookupError when unknown
        query = query.where(FilamentTreeLeaf.tree_id == tree_id)
    if changed_only:
        query = query.where(FilamentTreeLeaf.export_pending)
    rows = (await db.execute(query.order_by(FilamentPreset.name))).all()
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for leaf, preset in rows:
            zf.writestr(zipfile.ZipInfo(f"{preset.name}.json", date_time=(1980, 1, 1, 0, 0, 0)), preset.content)
            leaf.exported_at = now
            leaf.export_pending = False
    await db.commit()
    return buf.getvalue()
