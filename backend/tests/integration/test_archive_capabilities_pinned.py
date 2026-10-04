"""Characterization of /archives/{id}/capabilities before its parsing moved out.

Pins what the endpoint answers for the file shapes it distinguishes, so the
extraction of its helpers (mesh check, printable volume, slice colours) can be
checked against it. Written against the code as it was on 2026-10-04.
"""

from __future__ import annotations

import json
import uuid
import zipfile
from pathlib import Path

import pytest
from httpx import AsyncClient

from backend.app.core.config import settings

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


@pytest.fixture(autouse=True)
def _private_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "base_dir", tmp_path)


def _zip(path: Path, entries: dict[str, str]) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        for name, body in entries.items():
            zf.writestr(name, body)
    return str(path.relative_to(settings.base_dir))


def _config(**kw) -> str:
    return json.dumps(kw)


SLICE_INFO = (
    "<config><plate>"
    '<filament id="1" color="#FF0000" used_g="3.5"/>'
    '<filament id="3" color="#0000FF" used_g="1"/>'
    '<filament id="2" color="#00FF00" used_g="0"/>'
    "</plate></config>"
)


async def _caps(async_client, archive_factory, printer_factory, db_session, sliced: dict, source: dict | None = None):
    printer = await printer_factory()
    base = settings.base_dir / "archive" / uuid.uuid4().hex
    rel = _zip(base / "p.gcode.3mf", sliced)
    fields = {"file_path": rel}
    if source is not None:
        fields["source_3mf_path"] = _zip(base / "source" / "p.3mf", source)
    archive = await archive_factory(printer.id, **fields)
    await db_session.commit()
    response = await async_client.get(f"/api/v1/archives/{archive.id}/capabilities")
    assert response.status_code == 200, response.text
    return response.json()


async def test_sliced_only_with_volume_and_slice_colours(async_client, archive_factory, printer_factory, db_session):
    body = await _caps(
        async_client,
        archive_factory,
        printer_factory,
        db_session,
        {
            "Metadata/plate_1.gcode": "G28",
            "Metadata/slice_info.config": SLICE_INFO,
            "Metadata/project_settings.config": _config(
                printable_area=["0x0", "350x0", "350x320", "0x320"], printable_height="325"
            ),
        },
    )
    assert body["has_gcode"] is True
    assert body["has_model"] is False
    assert body["has_source"] is False
    assert body["build_volume"] == {"x": 350, "y": 320, "z": 325}
    assert body["filament_colors"] == ["#FF0000", "#00AE42", "#0000FF"]


async def test_source_mesh_colours_and_volume_win(async_client, archive_factory, printer_factory, db_session):
    body = await _caps(
        async_client,
        archive_factory,
        printer_factory,
        db_session,
        {
            "Metadata/plate_1.gcode": "G28",
            "Metadata/slice_info.config": SLICE_INFO,
            "Metadata/project_settings.config": _config(printable_area=["0x0", "180x0", "180x180", "0x180"]),
        },
        source={
            "3D/Objects/o.model": "<model><mesh><vertex x='1'/></mesh></model>",
            "Metadata/project_settings.config": _config(
                printable_area=["0x0", "256x0", "256x256", "0x256"], printable_height="250", filament_colour=["#ABCDEF", "", 3]
            ),
        },
    )
    assert body["has_model"] is True
    assert body["has_source"] is True
    # The source's 256x256 reads as "unset", so the sliced file's area applies;
    # its own z (250) stays because the source volume differed from the default.
    assert body["build_volume"] == {"x": 180, "y": 180, "z": 250}
    assert body["filament_colors"] == ["#ABCDEF"]


async def test_mesh_in_the_sliced_file_and_junk_values(async_client, archive_factory, printer_factory, db_session):
    body = await _caps(
        async_client,
        archive_factory,
        printer_factory,
        db_session,
        {
            "3D/3dmodel.model": "<model><mesh/></model>",
            "Metadata/project_settings.config": _config(printable_area=["axb", "10x", "0x0"], printable_height="tall"),
        },
    )
    assert body["has_model"] is True
    assert body["has_gcode"] is False
    assert body["build_volume"] == {"x": 256, "y": 256, "z": 256}
    assert body["filament_colors"] == []


async def test_unparseable_configs_fall_back_to_defaults(async_client, archive_factory, printer_factory, db_session):
    body = await _caps(
        async_client,
        archive_factory,
        printer_factory,
        db_session,
        {"Metadata/slice_info.config": "<not xml", "Metadata/project_settings.config": "{not json"},
        source={"Metadata/project_settings.config": "{not json"},
    )
    assert body["build_volume"] == {"x": 256, "y": 256, "z": 256}
    assert body["filament_colors"] == []
    assert body["has_model"] is False


async def test_sliced_project_colours_are_the_last_fallback(async_client, archive_factory, printer_factory, db_session):
    """No source, no used filament in slice_info: the sliced file's
    project_settings filament_colour list is used."""
    body = await _caps(
        async_client,
        archive_factory,
        printer_factory,
        db_session,
        {"Metadata/project_settings.config": _config(filament_colour=["#111111", "#222222"])},
    )
    assert body["filament_colors"] == ["#111111", "#222222"]


async def test_a_non_string_area_coordinate_skips_the_sliced_config(
    async_client, archive_factory, printer_factory, db_session
):
    """An int in printable_area raised inside the block's try, so nothing from
    that config applied -- neither the height nor the colours."""
    body = await _caps(
        async_client,
        archive_factory,
        printer_factory,
        db_session,
        {
            "Metadata/project_settings.config": _config(
                printable_area=[0, "200x0", "200x200"], printable_height="300", filament_colour=["#333333"]
            )
        },
    )
    assert body["build_volume"] == {"x": 256, "y": 256, "z": 256}
    assert body["filament_colors"] == []
