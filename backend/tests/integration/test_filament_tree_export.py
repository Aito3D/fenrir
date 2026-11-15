import io
import json
import zipfile

import pytest
from sqlalchemy import select

from backend.app.models.filament_profile import FilamentPreset
from backend.app.models.filament_tree import FilamentTree, FilamentTreeColor, FilamentTreeLeaf
from backend.app.services import filament_tree_store as store
from backend.app.services.filament_tree_export import build_export_zip, confirm_export


async def _tree(db, name):
    tree = FilamentTree(name=name, brand="Polymaker", material="PETG", base_family="Generic PETG")
    db.add(tree)
    await db.flush()
    db.add(FilamentTreeColor(tree_id=tree.id, name="Red", hex="#FF0000"))
    await db.commit()
    await store.regenerate_tree(db, tree.id)
    return tree


async def test_export_zip_entries_marks_exported_not_baseline(db_session):
    tree = await _tree(db_session, "Polymaker PETG")
    data, token = await build_export_zip(db_session, tree.id)
    zf = zipfile.ZipFile(io.BytesIO(data))
    names = zf.namelist()
    assert len(names) == 16 and names == sorted(names)
    assert "Polymaker PETG - Red @H2S 0.4.json" in names
    assert all("inherits" in json.loads(zf.read(n)) for n in names)
    leaves = (await db_session.execute(select(FilamentTreeLeaf))).scalars().all()
    # the download is not confirmed yet: everything stays pending
    assert len(leaves) == 16 and all(lf.export_pending and lf.exported_at is None for lf in leaves)
    assert await confirm_export(db_session, token) == 16
    await db_session.refresh(leaves[0])
    leaves = (await db_session.execute(select(FilamentTreeLeaf))).scalars().all()
    # Orca has not imported the zip yet: only SYNC may record what Orca holds
    assert all(lf.baseline_content is None and lf.exported_at and not lf.export_pending for lf in leaves)
    assert data == (await build_export_zip(db_session, tree.id))[0]


async def test_confirm_keeps_leaves_changed_since_export_pending(db_session):
    tree = await _tree(db_session, "Polymaker PETG")
    _, token = await build_export_zip(db_session, tree.id)
    preset = (await db_session.execute(select(FilamentPreset).order_by(FilamentPreset.id))).scalars().first()
    preset.content = preset.content.replace("{", '{"zz": 1,', 1)
    await db_session.commit()
    assert await confirm_export(db_session, token) == 15
    pending = (
        (await db_session.execute(select(FilamentTreeLeaf).where(FilamentTreeLeaf.export_pending))).scalars().all()
    )
    assert [lf.preset_id for lf in pending] == [preset.id]


async def test_confirm_unknown_or_spent_token(db_session):
    tree = await _tree(db_session, "Polymaker PETG")
    _, token = await build_export_zip(db_session, tree.id)
    await confirm_export(db_session, token)
    for bad in (token, "nope"):
        with pytest.raises(LookupError):
            await confirm_export(db_session, bad)


async def test_open_exports_are_bounded(db_session):
    tree = await _tree(db_session, "Polymaker PETG")
    first = (await build_export_zip(db_session, tree.id))[1]
    for _ in range(32):
        await build_export_zip(db_session, tree.id)
    with pytest.raises(LookupError):
        await confirm_export(db_session, first)


async def test_export_single_tree_only(db_session):
    one = await _tree(db_session, "Polymaker PETG")
    await _tree(db_session, "Other PETG")
    zf = zipfile.ZipFile(io.BytesIO((await build_export_zip(db_session, one.id))[0]))
    assert len(zf.namelist()) == 16 and all(n.startswith("Polymaker") for n in zf.namelist())
    assert len(zipfile.ZipFile(io.BytesIO((await build_export_zip(db_session, None))[0])).namelist()) == 32
    with pytest.raises(LookupError):
        await build_export_zip(db_session, 9999)
