"""A saved slicer pipeline's presets as a ``SliceRequest``.

Shared by pipeline runs and the project Re-trancher (spec §12.1)."""

from __future__ import annotations

import json

from backend.app.models.slicer_pipeline import SlicerPipeline
from backend.app.schemas.slicer import PresetRef, SliceRequest


def slice_request_from_pipeline(pipeline: SlicerPipeline) -> SliceRequest:
    try:
        raw_filaments = json.loads(pipeline.filament_presets_json or "[]")
    except (json.JSONDecodeError, TypeError):
        raw_filaments = []
    if not isinstance(raw_filaments, list):
        raw_filaments = []
    filament_presets = [
        PresetRef(source=r["source"], id=r["id"])
        for r in raw_filaments
        if isinstance(r, dict) and "source" in r and "id" in r
    ]
    return SliceRequest(
        printer_preset=PresetRef(source=pipeline.printer_preset_source, id=pipeline.printer_preset_id),
        process_preset=PresetRef(source=pipeline.process_preset_source, id=pipeline.process_preset_id),
        filament_presets=filament_presets,
        bed_type=pipeline.bed_type,
        export_3mf=True,
    )
