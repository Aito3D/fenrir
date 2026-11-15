import io
import json
import zipfile

import pytest
from sqlalchemy import select

from backend.app.models.filament_tree import FilamentTree, FilamentTreeColor, FilamentTreeLeaf
from backend.app.services import filament_tree_store as store
from backend.app.services.filament_tree_export import build_export_zip


async def _tree(db, name):
    tree = FilamentTree(name=name, brand="Polymaker", material="PETG", base_family="Generic PETG")
    db.add(tree)
    await db.flush()
    db.add(FilamentTreeColor(tree_id=tree.id, name="Red", hex="#FF0000"))
    await db.commit()
    await store.regenerate_tree(db, tree.id)
    return tree


async def test_export_zip_entries_and_baseline(db_session):
    tree = await _tree(db_session, "Polymaker PETG")
    data = await build_export_zip(db_session, tree.id)
    zf = zipfile.ZipFile(io.BytesIO(data))
    names = zf.namelist()
    assert len(names) == 16 and names == sorted(names)
    assert "Polymaker PETG - Red @H2S 0.4.json" in names
    assert all("inherits" in json.loads(zf.read(n)) for n in names)
    leaves = (await db_session.execute(select(FilamentTreeLeaf))).scalars().all()
    assert len(leaves) == 16 and all(lf.baseline_content for lf in leaves)
    assert json.loads(leaves[0].baseline_content)["name"].endswith(("0.2", "0.4", "0.6", "0.8"))
    assert data == await build_export_zip(db_session, tree.id)


async def test_export_single_tree_only(db_session):
    one = await _tree(db_session, "Polymaker PETG")
    await _tree(db_session, "Other PETG")
    zf = zipfile.ZipFile(io.BytesIO(await build_export_zip(db_session, one.id)))
    assert len(zf.namelist()) == 16 and all(n.startswith("Polymaker") for n in zf.namelist())
    assert len(zipfile.ZipFile(io.BytesIO(await build_export_zip(db_session, None))).namelist()) == 32
    with pytest.raises(LookupError):
        await build_export_zip(db_session, 9999)
