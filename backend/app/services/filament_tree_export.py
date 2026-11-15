"""Export for Orca: zip of generated leaf presets; records each leaf's baseline (what Orca holds after import)."""

import io
import zipfile

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.filament_profile import FilamentPreset
from backend.app.models.filament_tree import FilamentTreeLeaf
from backend.app.services.filament_tree_store import _get_tree


async def build_export_zip(db: AsyncSession, tree_id: int | None) -> bytes:
    query = select(FilamentTreeLeaf, FilamentPreset).join(
        FilamentPreset, FilamentPreset.id == FilamentTreeLeaf.preset_id
    )
    if tree_id is not None:
        await _get_tree(db, tree_id)  # LookupError when unknown
        query = query.where(FilamentTreeLeaf.tree_id == tree_id)
    rows = (await db.execute(query.order_by(FilamentPreset.name))).all()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for leaf, preset in rows:
            zf.writestr(zipfile.ZipInfo(f"{preset.name}.json", date_time=(1980, 1, 1, 0, 0, 0)), preset.content)
            leaf.baseline_content = preset.content
    await db.commit()
    return buf.getvalue()
