"""Editing an archive's project page saves exactly what was typed, safely.

The new value went into ``re.sub`` as a replacement string, so a backslash
(a Windows path, ``\\d``) either raised -- swallowed into a generic 500 -- or
changed the saved text. The body was an unvalidated ``dict``, the 3MF was
re-zipped on the event loop into /tmp and moved across filesystems without an
fsync, and the row kept the old file's hash and size afterwards.
"""

from __future__ import annotations

import html
import io
import shutil
import threading
import uuid
import zipfile
from pathlib import Path

import pytest
from httpx import AsyncClient

from backend.app.core.config import settings

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

MODEL = (
    '<?xml version="1.0"?><model>'
    '<metadata name="Title">Old title</metadata>'
    '<metadata name="Description">Old description</metadata>'
    "</model>"
)


@pytest.fixture
async def archive_with_3mf(archive_factory, printer_factory, db_session):
    printer = await printer_factory()
    # A path of its own: the factory default is shared across parallel tests.
    archive = await archive_factory(printer.id, file_path=f"archives/pp_{uuid.uuid4().hex}/page.gcode.3mf")
    path = settings.base_dir / archive.file_path
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("3D/3dmodel.model", MODEL)
        zf.writestr("Metadata/slice_info.config", "<config/>")
    path.write_bytes(buf.getvalue())
    archive.file_size = path.stat().st_size
    archive.content_hash = "stale"
    await db_session.commit()
    yield archive, path
    shutil.rmtree(path.parent, ignore_errors=True)


def _model(path: Path) -> str:
    with zipfile.ZipFile(path) as zf:
        return zf.read("3D/3dmodel.model").decode()


async def test_backslashes_are_saved_as_typed(async_client: AsyncClient, archive_with_3mf):
    archive, path = archive_with_3mf
    text = r"Saved in C:\designs\x1 \d \1 \g<0>"

    response = await async_client.patch(f"/api/v1/archives/{archive.id}/project-page", json={"description": text})

    assert response.status_code == 200, response.text
    # Stored HTML-escaped, as every value is; the backslashes survive as typed.
    assert f">{html.escape(text)}<" in _model(path)


async def test_a_non_string_value_is_refused(async_client: AsyncClient, archive_with_3mf):
    archive, _ = archive_with_3mf
    response = await async_client.patch(f"/api/v1/archives/{archive.id}/project-page", json={"description": 42})
    assert response.status_code == 422


async def test_the_row_follows_the_rewritten_file(async_client: AsyncClient, archive_with_3mf):
    from backend.app.services.archive import ArchiveService

    archive, path = archive_with_3mf
    await async_client.patch(f"/api/v1/archives/{archive.id}/project-page", json={"title": "New title"})

    detail = (await async_client.get(f"/api/v1/archives/{archive.id}")).json()
    assert detail["file_size"] == path.stat().st_size
    assert detail["content_hash"] == ArchiveService.compute_file_hash(path)


async def test_the_rewrite_runs_off_the_event_loop(async_client: AsyncClient, archive_with_3mf, monkeypatch):
    from backend.app.services.archive import ProjectPageParser

    archive, _ = archive_with_3mf
    threads: list = []
    real = ProjectPageParser.update_metadata

    def _spy(self, updates):
        threads.append(threading.current_thread())
        return real(self, updates)

    monkeypatch.setattr(ProjectPageParser, "update_metadata", _spy)
    await async_client.patch(f"/api/v1/archives/{archive.id}/project-page", json={"title": "T"})
    assert threads and threads[0] is not threading.main_thread()
