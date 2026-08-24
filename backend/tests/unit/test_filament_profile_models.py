"""Filament preset model + schema shape tests."""

import pytest
from sqlalchemy import select

from backend.app.models.filament_profile import BaseFilamentPreset, FilamentPreset
from backend.app.schemas.filament_profile import BambuSyncRequest, FilamentPresetUpdate


@pytest.mark.asyncio
async def test_filament_preset_defaults(db_session):
    row = FilamentPreset()
    db_session.add(row)
    await db_session.commit()
    await db_session.refresh(row)
    assert row.id is not None
    assert row.name == "" and row.brand == "" and row.content == ""
    assert row.created_at is not None and row.updated_at is not None


@pytest.mark.asyncio
async def test_base_preset_roundtrip(db_session):
    db_session.add(BaseFilamentPreset(name="Bambu PLA Basic", filename="Bambu PLA Basic.json"))
    await db_session.commit()
    got = (await db_session.execute(select(BaseFilamentPreset))).scalar_one()
    assert got.inherits == "" and got.color == ""


def test_update_schema_partial():
    upd = FilamentPresetUpdate(name="X")
    assert upd.model_dump(exclude_unset=True) == {"name": "X"}


def test_bambu_sync_request_requires_presets():
    with pytest.raises(Exception):  # noqa: B017 — validation error type is pydantic's, not ours to narrow
        BambuSyncRequest()  # presets key must be REQUIRED (spec §9.1 guard)
    assert BambuSyncRequest(presets=[]).dry_run is False
