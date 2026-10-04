"""Replacing an archive's source 3MF or F3D design never loses the old one.

Both routes deleted the existing file first and validated the upload after, so
a rejected replacement (raw gcode renamed to .3mf, a truncated upload) left the
row pointing at a file that was already gone. The F3D route also resolved its
folder from ``file_path``, which a fallback archive leaves empty: the design
went to ``<base_dir>/../f3d/`` and the route answered 500.
"""

from __future__ import annotations

import io
import shutil
import zipfile

import pytest
from httpx import AsyncClient

from backend.app.core.config import settings

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


def _3mf(marker: str = "a") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("3D/3dmodel.model", f"<model>{marker}</model>")
        zf.writestr("Metadata/slice_info.config", "<config/>")
    return buf.getvalue()


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


async def _fallback_archive(archive_factory, printer_factory, db_session):
    printer = await printer_factory()
    archive = await archive_factory(printer.id, file_path="", file_size=0)
    await db_session.commit()
    return archive


async def test_a_rejected_source_keeps_the_old_one(
    async_client: AsyncClient, archive_factory, printer_factory, db_session, cleanup
):
    archive = await _fallback_archive(archive_factory, printer_factory, db_session)
    cleanup.append(settings.base_dir / "archive" / "no_source" / str(archive.id))

    first = await async_client.post(
        f"/api/v1/archives/{archive.id}/source", files={"file": ("Part.3mf", _3mf(), "application/octet-stream")}
    )
    assert first.status_code == 200, first.text
    old_path = settings.base_dir / first.json()["source_3mf_path"]
    assert old_path.exists()

    bad = await async_client.post(
        f"/api/v1/archives/{archive.id}/source",
        files={"file": ("Other.3mf", b"G28\nG1 X0", "application/octet-stream")},
    )
    assert bad.status_code == 400
    assert old_path.exists(), "the rejected upload deleted the only source"
    detail = (await async_client.get(f"/api/v1/archives/{archive.id}")).json()
    assert detail["source_3mf_path"] == first.json()["source_3mf_path"]


async def test_a_new_source_replaces_the_old_one(
    async_client: AsyncClient, archive_factory, printer_factory, db_session, cleanup
):
    archive = await _fallback_archive(archive_factory, printer_factory, db_session)
    cleanup.append(settings.base_dir / "archive" / "no_source" / str(archive.id))

    first = await async_client.post(
        f"/api/v1/archives/{archive.id}/source", files={"file": ("Part.3mf", _3mf("a"), "application/octet-stream")}
    )
    second = await async_client.post(
        f"/api/v1/archives/{archive.id}/source", files={"file": ("Part_v2.3mf", _3mf("b"), "application/octet-stream")}
    )
    assert second.status_code == 200, second.text
    assert not (settings.base_dir / first.json()["source_3mf_path"]).exists()
    assert (settings.base_dir / second.json()["source_3mf_path"]).read_bytes() == _3mf("b")


async def test_the_same_name_is_replaced_in_place(
    async_client: AsyncClient, archive_factory, printer_factory, db_session, cleanup
):
    archive = await _fallback_archive(archive_factory, printer_factory, db_session)
    cleanup.append(settings.base_dir / "archive" / "no_source" / str(archive.id))

    await async_client.post(
        f"/api/v1/archives/{archive.id}/source", files={"file": ("Part.3mf", _3mf("a"), "application/octet-stream")}
    )
    again = await async_client.post(
        f"/api/v1/archives/{archive.id}/source", files={"file": ("Part.3mf", _3mf("b"), "application/octet-stream")}
    )
    assert (settings.base_dir / again.json()["source_3mf_path"]).read_bytes() == _3mf("b")


async def test_an_f3d_on_a_fallback_archive_stays_in_the_data_volume(
    async_client: AsyncClient, archive_factory, printer_factory, db_session, cleanup
):
    archive = await _fallback_archive(archive_factory, printer_factory, db_session)
    cleanup.append(settings.base_dir / "archive" / "no_source" / str(archive.id))

    response = await async_client.post(
        f"/api/v1/archives/{archive.id}/f3d", files={"file": ("design.f3d", b"f3d-bytes", "application/octet-stream")}
    )
    assert response.status_code == 200, response.text
    stored = settings.base_dir / response.json()["f3d_path"]
    assert stored.read_bytes() == b"f3d-bytes"
    assert stored.resolve().is_relative_to(settings.base_dir.resolve())


async def test_a_new_f3d_replaces_the_old_one(
    async_client: AsyncClient, archive_factory, printer_factory, db_session, cleanup
):
    archive = await _fallback_archive(archive_factory, printer_factory, db_session)
    cleanup.append(settings.base_dir / "archive" / "no_source" / str(archive.id))

    first = await async_client.post(
        f"/api/v1/archives/{archive.id}/f3d", files={"file": ("a.f3d", b"one", "application/octet-stream")}
    )
    second = await async_client.post(
        f"/api/v1/archives/{archive.id}/f3d", files={"file": ("b.f3d", b"two", "application/octet-stream")}
    )
    assert not (settings.base_dir / first.json()["f3d_path"]).exists()
    assert (settings.base_dir / second.json()["f3d_path"]).read_bytes() == b"two"
