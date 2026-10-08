import json

import pytest
from pydantic import ValidationError

from backend.app.models.slicer_pipeline import SlicerPipeline
from backend.app.services.slicer_pipeline_request import slice_request_from_pipeline


def test_request_carries_presets_and_bed_type():
    pipeline = SlicerPipeline(
        name="H2D PETG",
        printer_preset_source="local",
        printer_preset_id="1",
        process_preset_source="local",
        process_preset_id="2",
        filament_presets_json=json.dumps([{"source": "local", "id": "3"}, {"bad": 1}]),
        bed_type="Textured PEI Plate",
    )
    req = slice_request_from_pipeline(pipeline)
    assert req.printer_preset.id == "1" and req.process_preset.id == "2"
    assert [f.id for f in req.filament_presets] == ["3"]
    assert req.bed_type == "Textured PEI Plate" and req.export_3mf is True


def test_unreadable_filament_json_is_treated_as_no_filaments():
    pipeline = SlicerPipeline(
        name="x",
        printer_preset_source="local",
        printer_preset_id="1",
        process_preset_source="local",
        process_preset_id="2",
        filament_presets_json="{",
    )
    # Unreadable JSON yields no filaments, which SliceRequest itself rejects (behaviour moved unchanged).
    with pytest.raises(ValidationError, match="filament preset is required"):
        slice_request_from_pipeline(pipeline)
