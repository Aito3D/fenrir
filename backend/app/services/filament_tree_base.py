"""Merged values of a Bambu bundle base preset, following its `inherits` chain."""

import json

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.filament_profile import BaseFilamentPreset
from backend.app.services.bambu_studio import read_bundle_preset

VARIANT_KEY = "filament_extruder_variant"


class BaseValueReader:
    def __init__(self, filenames: dict[str, str]):
        self._filenames = filenames
        self._cache: dict[str, dict] = {}

    def values(self, name: str) -> dict:
        if name not in self._cache:
            chain: list[dict] = []
            seen: set[str] = set()
            current = name
            while current and current not in seen:
                seen.add(current)
                raw = read_bundle_preset(self._filenames[current]) if current in self._filenames else None
                if raw is None:
                    break
                try:
                    data = json.loads(raw)
                except ValueError:
                    break
                chain.append(data)
                current = data.get("inherits") or ""
            merged: dict = {}
            for data in reversed(chain):
                # same order as Bambu Studio: the parent's values, then the `include` templates, then the preset's own
                for template in data.get("include") or []:
                    raw = read_bundle_preset(self._filenames[template]) if template in self._filenames else None
                    try:
                        merged.update(json.loads(raw) if raw else {})
                    except ValueError:
                        pass
                merged.update(data)
            self._cache[name] = merged
        return self._cache[name]


async def build_base_reader(db: AsyncSession) -> BaseValueReader:
    rows = (await db.execute(select(BaseFilamentPreset.name, BaseFilamentPreset.filename))).tuples().all()
    return BaseValueReader(dict(rows))
