"""Manual sliced-file upload for a revision whose server slice failed (design 2026-10-30).

The operator slices the project in Bambu Studio and uploads the exported plate file
(``.gcode.3mf``). The server checks the content really carries G-code and that its settings
match the revision's, then stores it exactly as a server slice: hidden ``derived_slice`` row,
``sliced`` state, waiting queue items settled.
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.models.library import LibraryFile
from backend.tests.integration.test_project_slice import (  # noqa: F401  # fixtures
    _wait_job,
    roots,
    sidecar,
    test_engine,
)
from backend.tests.integration.test_project_slice_queue import _item, _queue, _revision, _upload
from backend.tests.project_fixtures import (
    wal_engine_fixture,  # noqa: F401  # the ``wal_engine`` fixture
)

SOURCE_CONFIG = {
    "printer_model": "Bambu Lab X1 Carbon",
    "nozzle_diameter": ["0.4"],
    "layer_height": "0.2",
    "filament_type": ["PLA", "PETG"],
}


def _zip(entries: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in entries.items():
            zf.writestr(zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0)), content)
    return buf.getvalue()


def source_3mf(config: dict | None = None) -> bytes:
    return _zip(
        {
            "Metadata/project_settings.config": json.dumps(config or SOURCE_CONFIG),
            "3D/3dmodel.model": '<model><metadata name="Application">BambuStudio-02.08.00.50</metadata></model>',
        }
    )


def sliced_3mf(config: dict | None = None, *, settings: bool = True) -> bytes:
    entries = {
        "Metadata/plate_1.gcode": "; HEADER_BLOCK_START\n; total layer number: 10\n; HEADER_BLOCK_END\nG28\n",
        "Metadata/slice_info.config": (
            '<config><plate><metadata key="index" value="1"/><metadata key="prediction" value="4200"/>'
            '<metadata key="weight" value="12.5"/></plate></config>'
        ),
    }
    if settings:
        entries["Metadata/project_settings.config"] = json.dumps(config or SOURCE_CONFIG)
    return _zip(entries)


async def _failed_revision(client: AsyncClient, sidecar) -> dict:
    """A revision whose server slice failed because the sidecar is down."""
    rev = await _upload(client, content=source_3mf())
    sidecar.mode = "down"
    started = await client.post(f"/api/v1/projects/revisions/{rev['id']}/slice")
    assert started.status_code == 202, started.text
    await _wait_job(started.json()["job_id"])
    return rev


async def _post_sliced(client: AsyncClient, revision_id: int, content: bytes, filename: str = "support.gcode.3mf"):
    return await client.post(
        f"/api/v1/projects/revisions/{revision_id}/sliced-file",
        files=[("file", (filename, content, "application/octet-stream"))],
    )


@pytest.mark.asyncio
@pytest.mark.integration
async def test_upload_replaces_failed_slice_and_settles_queue(async_client: AsyncClient, db_session, sidecar):
    rev = await _failed_revision(async_client, sidecar)
    source_id = rev["files"][0]["id"]
    assert (await _revision(db_session, rev["id"])).slice_status == "failed"
    # Queueing a failed revision's source retries its slice; the sidecar is still down, so the
    # item ends ``slice_failed`` once that retry has run.
    waiting = await _queue(async_client, source_id)
    await _wait_job((await _revision(db_session, rev["id"])).slice_job_id)
    assert (await _item(db_session, waiting["id"])).status == "slice_failed"

    res = await _post_sliced(async_client, rev["id"], sliced_3mf())
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["slice_status"] == "sliced"
    assert out["slice_error"] is None
    assert out["sliced_file"]["filename"] == "support.gcode.3mf"
    assert out["sliced_file"]["print_time_seconds"] == 4200
    assert out["sliced_file"]["filament_used_grams"] == 12.5
    assert [f["id"] for f in out["files"]] == [source_id]  # the slice stays hidden from the revision's files

    revision = await _revision(db_session, rev["id"])
    row = await db_session.get(LibraryFile, revision.sliced_file_id)
    assert row.derived_slice is True
    assert row.file_type == "gcode.3mf"
    assert row.file_metadata["sliced_for_model"] == "X1C"
    sliced_id = row.id  # ``_item`` expires the session

    item = await _item(db_session, waiting["id"])
    assert (item.status, item.library_file_id, item.error_message) == ("pending", sliced_id, None)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_raw_gcode_is_refused_by_name(async_client: AsyncClient, sidecar):
    rev = await _failed_revision(async_client, sidecar)
    res = await _post_sliced(async_client, rev["id"], b"G28\nG1 X10\n", filename="support.gcode")
    assert res.status_code == 400, res.text
    assert ".gcode.3mf" in res.json()["detail"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_source_content_is_refused_whatever_its_name(async_client: AsyncClient, db_session, sidecar):
    rev = await _failed_revision(async_client, sidecar)
    res = await _post_sliced(async_client, rev["id"], source_3mf(), filename="support.gcode.3mf")
    assert res.status_code == 400, res.text
    assert "not sliced" in res.json()["detail"]
    assert (await _revision(db_session, rev["id"])).slice_status == "failed"
    rows = (await db_session.execute(select(LibraryFile).where(LibraryFile.derived_slice.is_(True)))).scalars().all()
    assert rows == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_not_a_zip_is_refused(async_client: AsyncClient, sidecar):
    rev = await _failed_revision(async_client, sidecar)
    res = await _post_sliced(async_client, rev["id"], b"not a zip at all")
    assert res.status_code == 400, res.text


@pytest.mark.asyncio
@pytest.mark.integration
async def test_settings_mismatch_is_refused_with_the_differences(async_client: AsyncClient, db_session, sidecar):
    rev = await _failed_revision(async_client, sidecar)
    other = {**SOURCE_CONFIG, "printer_model": "Bambu Lab P1S", "nozzle_diameter": ["0.6"], "filament_type": ["PLA"]}
    res = await _post_sliced(async_client, rev["id"], sliced_3mf(other))
    assert res.status_code == 400, res.text
    detail = res.json()["detail"]
    assert detail["code"] == "settings_mismatch"
    assert {(m["field"], m["file"], m["revision"]) for m in detail["mismatches"]} == {
        ("printer_model", "P1S", "X1C"),
        ("nozzle_diameter", "0.6", "0.4"),
        ("filament_types", "PLA", "PLA, PETG"),
    }
    assert (await _revision(db_session, rev["id"])).slice_status == "failed"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_same_settings_in_other_spelling_match(async_client: AsyncClient, sidecar):
    """``X1C`` vs ``Bambu Lab X1 Carbon``, ``0.40`` vs ``0.4``, ``pla`` vs ``PLA`` are the same settings."""
    rev = await _failed_revision(async_client, sidecar)
    spelled = {
        "printer_model": "X1C",
        "nozzle_diameter": "0.40",
        "layer_height": 0.2,
        "filament_type": ["pla", "petg"],
    }
    res = await _post_sliced(async_client, rev["id"], sliced_3mf(spelled))
    assert res.status_code == 200, res.text


@pytest.mark.asyncio
@pytest.mark.integration
async def test_file_without_settings_is_refused(async_client: AsyncClient, sidecar):
    rev = await _failed_revision(async_client, sidecar)
    res = await _post_sliced(async_client, rev["id"], sliced_3mf(settings=False))
    assert res.status_code == 400, res.text
    assert "no settings" in res.json()["detail"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_only_a_failed_revision_takes_an_upload(async_client: AsyncClient, sidecar):
    rev = await _upload(async_client, content=source_3mf())  # never sliced
    res = await _post_sliced(async_client, rev["id"], sliced_3mf())
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["code"] == "not_failed"

    started = await async_client.post(f"/api/v1/projects/revisions/{rev['id']}/slice")
    await _wait_job(started.json()["job_id"])  # the mock sidecar answers: sliced
    res = await _post_sliced(async_client, rev["id"], sliced_3mf())
    assert res.status_code == 409, res.text

    missing = await _post_sliced(async_client, 999_999, sliced_3mf())
    assert missing.status_code == 404
