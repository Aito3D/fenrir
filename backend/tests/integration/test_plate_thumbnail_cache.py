"""Plate thumbnails revalidate with an ETag instead of reopening the 3MF.

Hovering a card or switching plates re-requested the image, and every request
opened the 3MF's zip on the event loop with no cache headers. The response now
carries an ETag from the file's mtime, size and plate; a matching
If-None-Match answers 304 from a stat alone.
"""

from __future__ import annotations

import uuid
import zipfile

import pytest
from httpx import AsyncClient

from backend.app.core.config import settings

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


@pytest.fixture(autouse=True)
def _private_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "base_dir", tmp_path)


async def test_a_repeat_request_is_a_304_without_opening_the_zip(
    async_client: AsyncClient, archive_factory, printer_factory, db_session, monkeypatch
):
    printer = await printer_factory()
    rel = f"archive/{uuid.uuid4().hex}/p.gcode.3mf"
    path = settings.base_dir / rel
    path.parent.mkdir(parents=True)
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("Metadata/plate_2.png", b"\x89PNG plate two")
    archive = await archive_factory(printer.id, file_path=rel)
    await db_session.commit()

    first = await async_client.get(f"/api/v1/archives/{archive.id}/plate-thumbnail/2")
    assert first.status_code == 200
    assert first.content == b"\x89PNG plate two"
    etag = first.headers["etag"]
    assert "no-cache" in first.headers["cache-control"]

    def _no_zip(*_args, **_kwargs):
        raise AssertionError("opened the 3MF for a revalidation")

    monkeypatch.setattr(zipfile, "ZipFile", _no_zip)
    second = await async_client.get(f"/api/v1/archives/{archive.id}/plate-thumbnail/2", headers={"If-None-Match": etag})
    assert second.status_code == 304


async def test_another_plate_has_another_etag(async_client: AsyncClient, archive_factory, printer_factory, db_session):
    printer = await printer_factory()
    rel = f"archive/{uuid.uuid4().hex}/p.gcode.3mf"
    path = settings.base_dir / rel
    path.parent.mkdir(parents=True)
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("Metadata/plate_1.png", b"one")
        zf.writestr("Metadata/plate_2.png", b"two")
    archive = await archive_factory(printer.id, file_path=rel)
    await db_session.commit()

    one = await async_client.get(f"/api/v1/archives/{archive.id}/plate-thumbnail/1")
    two = await async_client.get(f"/api/v1/archives/{archive.id}/plate-thumbnail/2")
    assert one.headers["etag"] != two.headers["etag"]
