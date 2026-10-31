"""The display facts of a sliced file, read from a library row's ``file_metadata``.

The File Manager card, the project revision card and the archive card show the same
facts about a sliced file (``ThreeMFParser`` output): print time, grams, material,
colours, vendor, target printer, layers, layer height and object count. One reader, so
a value is validated the same way everywhere and a new fact is added once.
"""

from __future__ import annotations

from typing import Any


def _positive_int(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0 else None


def _positive_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        try:
            value = float(value)
        except ValueError:
            return None
    return float(value) if isinstance(value, (int, float)) and value > 0 else None


def _text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def object_count_of(meta: dict | None) -> int | None:
    """How many objects the slice holds (``printable_objects`` maps object id to name)."""
    objects = (meta or {}).get("printable_objects")
    return len(objects) if isinstance(objects, dict) and objects else None


def extra_display_facts(meta: dict | None) -> dict[str, Any]:
    """The facts beyond print time / grams / material / target printer, which the
    serializers already read: colours, vendor, layers, layer height, object count."""
    meta = meta if isinstance(meta, dict) else {}
    return {
        "filament_color": _text(meta.get("filament_color")),
        "filament_vendor": _text(meta.get("filament_vendor")),
        "total_layers": _positive_int(meta.get("total_layers")),
        "layer_height": _positive_float(meta.get("layer_height")),
        "object_count": object_count_of(meta),
    }


def display_facts(meta: dict | None) -> dict[str, Any]:
    """Every display fact of a sliced file (None where the metadata has none)."""
    meta = meta if isinstance(meta, dict) else {}
    return {
        "print_time_seconds": _positive_int(meta.get("print_time_seconds")),
        "filament_used_grams": _positive_float(meta.get("filament_used_grams")),
        "filament_type": _text(meta.get("filament_type")),
        "sliced_for_model": _text(meta.get("sliced_for_model")),
        **extra_display_facts(meta),
    }
