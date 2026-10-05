"""Archive uploads are size-capped and never held whole in memory.

Every archive upload route read the full body with ``await file.read()``: a
multi-GB timelapse or a handful of concurrent large uploads sat entirely in
RAM (an OOM kill on a Pi or NAS). 3MF, source and F3D uploads now stream to
disk under ``library_max_upload_bytes`` like the library does; photos, audio
and timelapses are read in chunks up to their own cap. Over the cap is a 413.
"""

from __future__ import annotations

import io
import shutil
import zipfile

import pytest
from httpx import AsyncClient

from backend.app.core.config import settings

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


def _3mf(size: int = 0) -> bytes:
    # Fixed entry timestamps: writestr(name) stamps the current time, so two calls a second
    # apart would produce different bytes and break byte-for-byte comparisons.
    def entry(name: str) -> zipfile.ZipInfo:
        return zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr(entry("3D/3dmodel.model"), "<model/>" + "x" * size)
        zf.writestr(entry("Metadata/slice_info.config"), "<config/>")
    return buf.getvalue()


@pytest.fixture
def small_cap(monkeypatch):
    from backend.app.api.routes import archives

    monkeypatch.setattr(settings, "library_max_upload_bytes", 4096)
    monkeypatch.setattr(archives, "_UPLOAD_PHOTO_MAX_BYTES", 4096)
    monkeypatch.setattr(archives, "_UPLOAD_AUDIO_MAX_BYTES", 4096)
    return 4096


@pytest.fixture(autouse=True)
def _private_data_dir(tmp_path, monkeypatch):
    """Archive ids repeat across parallel workers (one database each), so the
    shared archive/no_source/<id> folders would be written and cleaned up by
    two tests at once."""
    monkeypatch.setattr(settings, "base_dir", tmp_path)
    monkeypatch.setattr(settings, "archive_dir", tmp_path / "archive")


@pytest.fixture
def cleanup():
    made: list = []
    yield made
    for path in made:
        shutil.rmtree(path, ignore_errors=True)


async def test_an_oversized_archive_upload_is_refused(async_client: AsyncClient, small_cap):
    response = await async_client.post(
        "/api/v1/archives/upload", files={"file": ("big.3mf", _3mf(10_000), "application/octet-stream")}
    )
    assert response.status_code == 413


async def test_a_small_archive_upload_still_works(async_client: AsyncClient, small_cap, cleanup):
    response = await async_client.post(
        "/api/v1/archives/upload", files={"file": ("ok.3mf", _3mf(), "application/octet-stream")}
    )
    assert response.status_code == 200, response.text
    cleanup.append(settings.base_dir / response.json()["file_path"].rsplit("/", 1)[0])


async def test_a_bulk_upload_reports_the_oversized_file_and_keeps_the_rest(
    async_client: AsyncClient, small_cap, cleanup
):
    response = await async_client.post(
        "/api/v1/archives/upload-bulk",
        files=[
            ("files", ("big.3mf", _3mf(10_000), "application/octet-stream")),
            ("files", ("ok.3mf", _3mf(), "application/octet-stream")),
        ],
    )
    body = response.json()
    assert body["uploaded"] == 1
    assert body["failed"] == 1
    for result in body.get("results", []):
        detail = (await async_client.get(f"/api/v1/archives/{result['id']}")).json()
        cleanup.append(settings.base_dir / detail["file_path"].rsplit("/", 1)[0])


async def test_raw_gcode_is_still_rejected_on_the_first_chunk(async_client: AsyncClient, small_cap):
    response = await async_client.post(
        "/api/v1/archives/upload", files={"file": ("fake.3mf", b"G28\nG1 X0\n", "application/octet-stream")}
    )
    assert response.status_code == 400


async def test_an_oversized_source_keeps_the_old_one(
    async_client: AsyncClient, archive_factory, printer_factory, db_session, small_cap, cleanup
):
    printer = await printer_factory()
    archive = await archive_factory(printer.id, file_path="", file_size=0)
    await db_session.commit()
    cleanup.append(settings.base_dir / "archive" / "no_source" / str(archive.id))

    first = await async_client.post(
        f"/api/v1/archives/{archive.id}/source", files={"file": ("Part.3mf", _3mf(), "application/octet-stream")}
    )
    assert first.status_code == 200, first.text
    big = await async_client.post(
        f"/api/v1/archives/{archive.id}/source", files={"file": ("Part.3mf", _3mf(10_000), "application/octet-stream")}
    )
    assert big.status_code == 413
    assert (settings.base_dir / first.json()["source_3mf_path"]).read_bytes() == _3mf()


async def test_an_oversized_f3d_is_refused(
    async_client: AsyncClient, archive_factory, printer_factory, db_session, small_cap, cleanup
):
    printer = await printer_factory()
    archive = await archive_factory(printer.id, file_path="", file_size=0)
    await db_session.commit()
    cleanup.append(settings.base_dir / "archive" / "no_source" / str(archive.id))

    response = await async_client.post(
        f"/api/v1/archives/{archive.id}/f3d", files={"file": ("d.f3d", b"x" * 10_000, "application/octet-stream")}
    )
    assert response.status_code == 413


async def test_an_oversized_photo_is_refused(
    async_client: AsyncClient, archive_factory, printer_factory, db_session, small_cap
):
    printer = await printer_factory()
    archive = await archive_factory(printer.id)
    await db_session.commit()

    response = await async_client.post(
        f"/api/v1/archives/{archive.id}/photos", files={"file": ("p.jpg", b"\xff\xd8" + b"x" * 10_000, "image/jpeg")}
    )
    assert response.status_code == 413


async def test_an_oversized_timelapse_is_refused(
    async_client: AsyncClient, archive_factory, printer_factory, db_session, small_cap
):
    printer = await printer_factory()
    archive = await archive_factory(printer.id)
    await db_session.commit()

    response = await async_client.post(
        f"/api/v1/archives/{archive.id}/timelapse/upload", files={"file": ("t.mp4", b"x" * 10_000, "video/mp4")}
    )
    assert response.status_code == 413
