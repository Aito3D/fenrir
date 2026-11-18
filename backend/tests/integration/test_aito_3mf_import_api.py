"""Aito .3mf import job routes (design 2026-11-14). The slicer is always stubbed."""

import asyncio

import pytest
from httpx import AsyncClient

from backend.app.services import aito_3mf_import
from backend.app.services.aito_3mf_import import ALREADY_SLICED, Import3mfError
from backend.app.services.project_slice import NO_SLICER
from backend.app.services.slice_dispatch import slice_dispatch
from backend.tests.unit.services.test_aito_3mf_import import SLICED, SOURCE, make_3mf

URL = "/api/v1/aito/import-3mf"


def _upload(content: bytes, name: str = "Outils.3mf") -> dict:
    return {"file": (name, content, "application/octet-stream")}


async def _settled(client: AsyncClient, job_id: int) -> dict:
    for _ in range(200):
        body = (await client.get(f"{URL}/{job_id}")).json()
        if body["status"] in ("completed", "failed"):
            return body
        await asyncio.sleep(0.01)
    raise AssertionError("the import job never settled")


@pytest.fixture
def stub_slicer(monkeypatch):
    async def fake(db, source, filename, job_id):
        return SLICED

    monkeypatch.setattr(aito_3mf_import, "slice_source", fake)


async def test_import_returns_plates(async_client: AsyncClient, stub_slicer):
    r = await async_client.post(URL, files=_upload(SOURCE))
    assert r.status_code == 202
    body = await _settled(async_client, r.json()["job_id"])
    assert (body["status"], body["filename"], body["error"]) == ("completed", "Outils.3mf", None)
    assert body["plates"][0]["name"] == "Marteaux"
    assert body["plates"][0]["objects"] == [{"name": "marteau", "count": 2, "x_mm": 10, "y_mm": 20, "z_mm": 30}]


async def test_sliced_upload_is_400(async_client: AsyncClient, stub_slicer):
    sliced = make_3mf({"Metadata/plate_1.gcode": "G1", "Metadata/project_settings.config": "{}"})
    r = await async_client.post(URL, files=_upload(sliced))
    assert (r.status_code, r.json()["detail"]) == (400, ALREADY_SLICED)


async def test_wrong_extension_is_400(async_client: AsyncClient, stub_slicer):
    r = await async_client.post(URL, files=_upload(SOURCE, "part.stl"))
    assert r.status_code == 400


async def test_slicer_failure_reports_error(async_client: AsyncClient, monkeypatch):
    async def boom(db, source, filename, job_id):
        raise Import3mfError(502, "boom")

    monkeypatch.setattr(aito_3mf_import, "slice_source", boom)
    r = await async_client.post(URL, files=_upload(SOURCE))
    body = await _settled(async_client, r.json()["job_id"])
    assert (body["status"], body["error"], body["plates"]) == ("failed", "boom", None)


async def test_no_slicer_configured(async_client: AsyncClient, monkeypatch):
    from backend.app.api.routes import library

    async def no_url(db):
        return None

    monkeypatch.setattr(library, "resolve_slicer_api_url", no_url)
    r = await async_client.post(URL, files=_upload(SOURCE))
    body = await _settled(async_client, r.json()["job_id"])
    assert (body["status"], body["error"]) == ("failed", NO_SLICER)


async def _noop(job_id: int) -> dict:
    return {"plates": []}


async def test_other_users_job_is_404(async_client: AsyncClient):
    job = await slice_dispatch.enqueue(kind="aito_import", source_id=0, source_name="x.3mf", owner_id=4242, run=_noop)
    assert (await async_client.get(f"{URL}/{job.id}")).status_code == 404


async def test_library_slice_job_is_not_served(async_client: AsyncClient):
    job = await slice_dispatch.enqueue(kind="library_file", source_id=1, source_name="x.3mf", run=_noop)
    assert (await async_client.get(f"{URL}/{job.id}")).status_code == 404


async def test_unknown_job_is_404(async_client: AsyncClient):
    assert (await async_client.get(f"{URL}/987654321")).status_code == 404


async def test_generic_slice_job_route_does_not_serve_imports(async_client: AsyncClient):
    """The library's polling route is gated on library permissions, not Aito's."""
    job = await slice_dispatch.enqueue(kind="aito_import", source_id=0, source_name="x.3mf", run=_noop)
    assert (await async_client.get(f"/api/v1/slice-jobs/{job.id}")).status_code == 404


async def test_import_over_its_own_cap_is_413(async_client: AsyncClient, stub_slicer, monkeypatch):
    from backend.app.api.routes import aito

    monkeypatch.setattr(aito, "_IMPORT_3MF_MAX_BYTES", len(SOURCE) - 1)
    r = await async_client.post(URL, files=_upload(SOURCE))
    assert (r.status_code, r.json()["detail"]) == (413, "The .3mf is too large")
    monkeypatch.setattr(aito, "_IMPORT_3MF_MAX_BYTES", len(SOURCE))
    assert (await async_client.post(URL, files=_upload(SOURCE))).status_code == 202


# ---- T-685: DELETE cancels an abandoned import ----


async def test_cancel_stops_a_running_import_and_frees_its_slice_slot(async_client: AsyncClient, monkeypatch):
    from backend.app.services.project_slice import _MAX_CONCURRENT_SLICES, _slice_slot

    started = asyncio.Event()

    async def hang(db, source, filename, job_id):
        async with _slice_slot():
            started.set()
            await asyncio.Event().wait()

    monkeypatch.setattr(aito_3mf_import, "slice_source", hang)
    job_id = (await async_client.post(URL, files=_upload(SOURCE))).json()["job_id"]
    await asyncio.wait_for(started.wait(), 5)
    assert _slice_slot()._value == _MAX_CONCURRENT_SLICES - 1

    r = await async_client.delete(f"{URL}/{job_id}")

    assert r.status_code == 204
    body = await _settled(async_client, job_id)
    assert (body["status"], body["error"], body["plates"]) == ("failed", "Cancelled", None)
    assert _slice_slot()._value == _MAX_CONCURRENT_SLICES
    assert job_id not in slice_dispatch._tasks


async def test_cancel_of_a_finished_import_is_a_noop(async_client: AsyncClient, stub_slicer):
    job_id = (await async_client.post(URL, files=_upload(SOURCE))).json()["job_id"]
    await _settled(async_client, job_id)

    assert (await async_client.delete(f"{URL}/{job_id}")).status_code == 204
    assert (await async_client.delete(f"{URL}/{job_id}")).status_code == 204
    assert (await async_client.get(f"{URL}/{job_id}")).json()["status"] == "completed"


async def test_cancel_refuses_other_users_unknown_and_non_import_jobs(async_client: AsyncClient):
    other = await slice_dispatch.enqueue(kind="aito_import", source_id=0, source_name="x.3mf", owner_id=4242, run=_noop)
    library = await slice_dispatch.enqueue(kind="library_file", source_id=1, source_name="x.3mf", run=_noop)
    for job_id in (other.id, library.id, 987654321):
        assert (await async_client.delete(f"{URL}/{job_id}")).status_code == 404


async def test_dispatch_cancel_marks_any_job_failed_and_never_touches_finished_ones():
    gate = asyncio.Event()

    async def hang(job_id: int) -> dict:
        await gate.wait()
        return {}

    running = await slice_dispatch.enqueue(kind="project_revision", source_id=1, source_name="a", run=hang)
    await asyncio.sleep(0)
    slice_dispatch.cancel(running.id)
    await asyncio.sleep(0.01)
    assert (running.status, running.error_status, running.error_detail) == ("failed", 499, "Cancelled")

    gate.set()
    done = await slice_dispatch.enqueue(kind="project_revision", source_id=2, source_name="b", run=_noop)
    await asyncio.sleep(0.01)
    slice_dispatch.cancel(done.id)
    slice_dispatch.cancel(123456789)
    assert done.status == "completed"
