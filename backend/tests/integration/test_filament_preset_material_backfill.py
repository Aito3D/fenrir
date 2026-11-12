"""Imported filament presets get their material from the name on startup.

They inherit ``filament_type`` from their base preset, so the column stayed
empty and the Zoho price sync (brand + material) skipped them.
"""

import pytest
from sqlalchemy import select

from backend.app.core.database import _backfill_filament_preset_material
from backend.app.models.filament_profile import FilamentPreset

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

# (name, brand, stored material) -> material after the backfill
CASES = [
    (("Polymaker PETG - Black", "Polymaker", ""), "PETG"),
    (("eSUN PLA - White @BBL H2S 0.4mm", "eSUN", ""), "PLA"),
    (("SUNLU PA6-GF - Black", "SUNLU", "PA-GF"), "PA-GF"),  # a stored value is never replaced
    (("Polymaker - Black", "Polymaker", ""), ""),  # no material between brand and colour
    (("Some PETG", "Polymaker", ""), ""),  # not the "Brand Material - Colour" shape
    (("PETG - Black", "", ""), ""),  # no brand to strip
]


async def test_empty_material_is_read_from_the_name(db_session):
    for name, brand, material in (case for case, _ in CASES):
        db_session.add(FilamentPreset(name=name, brand=brand, material=material))
    await db_session.commit()

    await _backfill_filament_preset_material(await db_session.connection())
    await db_session.commit()
    db_session.expire_all()

    rows = (await db_session.execute(select(FilamentPreset).order_by(FilamentPreset.id))).scalars().all()
    assert [row.material for row in rows] == [expected for _, expected in CASES]
