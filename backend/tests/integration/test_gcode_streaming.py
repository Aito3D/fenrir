"""The G-code viewer streams the plate's G-code instead of loading it whole.

A multi-hour print's plate_N.gcode can be hundreds of MB uncompressed. The
route decompressed and UTF-8 decoded all of it on the event loop and held it
twice (bytes and str), stalling every printer's MQTT handling on a small
server or tripping the OOM killer.
"""

from __future__ import annotations

import shutil
import uuid
import zipfile

import pytest
from httpx import AsyncClient

from backend.app.core.config import settings

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


async def test_the_gcode_streams_without_a_whole_member_read(
    async_client: AsyncClient, archive_factory, printer_factory, db_session, monkeypatch
):
    printer = await printer_factory()
    archive = await archive_factory(printer.id, file_path=f"archives/gc_{uuid.uuid4().hex}/p.gcode.3mf")
    path = settings.base_dir / archive.file_path
    path.parent.mkdir(parents=True, exist_ok=True)
    gcode = ("G1 X10 Y10 E0.5 ; é\n" * 200_000).encode()  # ~4 MB, more than one chunk
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("Metadata/plate_1.gcode", gcode)
        zf.writestr("Metadata/plate_2.gcode", b"G28 ; plate 2\n")
    await db_session.commit()

    def _no_whole_reads(self, name, pwd=None):
        raise AssertionError(f"read the whole member {name} into memory")

    monkeypatch.setattr(zipfile.ZipFile, "read", _no_whole_reads)
    try:
        response = await async_client.get(f"/api/v1/archives/{archive.id}/gcode")
        assert response.status_code == 200
        assert response.content == gcode
        assert response.headers["content-type"].startswith("text/plain")

        plate2 = await async_client.get(f"/api/v1/archives/{archive.id}/gcode?plate=2")
        assert plate2.text == "G28 ; plate 2\n"
    finally:
        shutil.rmtree(path.parent, ignore_errors=True)
