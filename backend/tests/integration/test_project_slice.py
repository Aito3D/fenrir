"""Server-side slicing of project revisions (design 2026-10-17, decisions 2, 4, 7, 9, 13).

A revision's source ``.3mf`` is sliced on upload with its own embedded settings (no presets,
all plates); the ``.gcode.3mf`` is stored behind the revision as a hidden ``derived_slice``
library row. The sidecar is an httpx ``MockTransport``: no test reaches a real slicer.
"""

from __future__ import annotations

import asyncio
import io
import zipfile

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy import select, update

from backend.app.api.routes.library import to_absolute_path
from backend.app.core.config import settings as app_settings
from backend.app.models.library import LibraryFile
from backend.app.models.project_item import ProjectRevision
from backend.app.models.settings import Settings
from backend.app.services import aito_project_links, project_slice, project_storage, slicer_api as slicer_api_module
from backend.app.services.project_slice import start_slice_after_upload as _real_start_after_upload
from backend.app.services.slice_dispatch import slice_dispatch
from backend.tests.project_fixtures import (
    make_order,
    make_project,
    make_task,
    threemf_bytes,
    upload,
    wal_engine_fixture,  # noqa: F401  # the ``wal_engine`` fixture
)


@pytest.fixture
async def test_engine(test_engine, wal_engine):
    """WAL file database: the slice runs in a background task with its own session (see
    test_project_reslice). The parent fixture is requested only for its model registration."""
    yield wal_engine


@pytest.fixture(autouse=True)
def roots(tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setattr(project_storage, "projects_root", lambda: projects)
    monkeypatch.setattr(app_settings, "base_dir", tmp_path)
    (tmp_path / "library").mkdir()
    return tmp_path


@pytest.fixture(autouse=True)
def auto_slice(monkeypatch):
    """conftest turns the upload trigger off for every test; this file tests it, so put it back."""
    monkeypatch.setattr(project_slice, "start_slice_after_upload", _real_start_after_upload)


def _sliced_3mf() -> bytes:
    def entry(name: str) -> zipfile.ZipInfo:
        return zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(entry("Metadata/plate_1.gcode"), "; plate 1\nG28\n")
        zf.writestr(entry("Metadata/plate_2.gcode"), "; plate 2\nG28\n")
        zf.writestr(entry("Metadata/project_settings.config"), '{"printer_model": "Bambu Lab X1C"}')
    return buf.getvalue()


def _is_slice_post(request: httpx.Request) -> bool:
    return request.method == "POST" and request.url.path.endswith("/slice")


class Sidecar:
    """The mock sidecar. ``mode``: ``ok`` answers a 2-plate ``.gcode.3mf``; ``down`` refuses the
    connection. ``block`` makes the slice wait for ``release`` (``entered`` is set once it arrived)."""

    def __init__(self) -> None:
        self.mode = "ok"
        self.block = False
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.slice_requests: list[httpx.Request] = []

    async def handler(self, request: httpx.Request) -> httpx.Response:
        if not _is_slice_post(request):
            return httpx.Response(404)  # progress polls: "no progress yet"
        self.slice_requests.append(request)
        await request.aread()
        if self.mode == "down":
            raise httpx.ConnectError("connection refused", request=request)
        if self.block:
            self.entered.set()
            await self.release.wait()
        return httpx.Response(
            200,
            content=_sliced_3mf(),
            headers={"x-print-time-seconds": "3600", "x-filament-used-g": "12.5", "x-filament-used-mm": "4000"},
        )


@pytest.fixture
def sidecar():
    mock = Sidecar()
    client = httpx.AsyncClient(transport=httpx.MockTransport(mock.handler), timeout=10.0)
    slicer_api_module.set_shared_http_client(client)
    yield mock
    slicer_api_module.set_shared_http_client(None)


async def _wait_job(job_id: int) -> None:
    task = slice_dispatch._tasks.get(job_id)
    if task is not None:
        await asyncio.wait_for(asyncio.shield(task), timeout=10)


async def _upload(client: AsyncClient, filename: str = "support.3mf") -> tuple[dict, dict, dict]:
    project = (await client.post("/api/v1/projects/", json={"name": "Support caméra"})).json()
    item = (
        await client.post(f"/api/v1/projects/{project['id']}/items", json={"section": "impression", "name": "Support"})
    ).json()
    up = await client.post(
        f"/api/v1/projects/items/{item['id']}/revisions",
        files=[("files", (filename, threemf_bytes(), "application/octet-stream"))],
    )
    assert up.status_code == 201, up.text
    return project, item, up.json()["revision"]


async def _tree_revision(client: AsyncClient, project_id: int, revision_id: int) -> dict:
    tree = (await client.get(f"/api/v1/projects/{project_id}/tree")).json()
    return next(r for s in tree["sections"] for i in s["items"] for r in i["revisions"] if r["id"] == revision_id)


async def _derived_rows(db) -> list[LibraryFile]:
    db.expire_all()
    return list((await db.execute(select(LibraryFile).where(LibraryFile.derived_slice.is_(True)))).scalars().all())


def _no_auto_slice(monkeypatch) -> None:
    async def _off(db, revision_id, *, user_id):
        return None

    monkeypatch.setattr(project_slice, "start_slice_after_upload", _off)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_upload_starts_slice_and_stores_hidden_gcode(async_client: AsyncClient, db_session, sidecar, roots):
    project, _item, rev = await _upload(async_client)
    assert rev["slice_status"] == "slicing"
    job_id = rev["slice_job_id"]
    assert job_id is not None
    await _wait_job(job_id)

    out = await _tree_revision(async_client, project["id"], rev["id"])
    assert out["slice_status"] == "sliced", out
    assert out["slice_error"] is None
    assert out["sliced_file"]["filename"] == "support.gcode.3mf"
    assert [f["filename"] for f in out["files"]] == ["support.3mf"]

    # one slice call: all plates, a .gcode.3mf back, no profile parts (the file's own settings)
    assert len(sidecar.slice_requests) == 1
    body = sidecar.slice_requests[0].content
    assert b'name="plate"\r\n\r\n0\r\n' in body
    assert b'name="exportType"\r\n\r\n3mf\r\n' in body
    for part in (b"printerProfile", b"presetProfile", b"filamentProfile"):
        assert part not in body

    (row,) = await _derived_rows(db_session)
    assert row.id == out["sliced_file"]["id"]
    assert row.file_type == "gcode.3mf"
    assert row.revision_id == rev["id"] and row.project_id == project["id"]
    assert row.file_metadata == {
        "print_time_seconds": 3600,
        "filament_used_grams": 12.5,
        "sliced_for_model": "Bambu Lab X1C",
    }
    path = to_absolute_path(row.file_path)
    assert path is not None and path.read_bytes() == _sliced_3mf()
    assert path.parent.name == "R1"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_sidecar_down_upload_succeeds_and_slice_fails(async_client: AsyncClient, db_session, sidecar):
    sidecar.mode = "down"
    project, _item, rev = await _upload(async_client)
    await _wait_job(rev["slice_job_id"])

    out = await _tree_revision(async_client, project["id"], rev["id"])
    assert out["slice_status"] == "failed"
    assert out["slice_error"]
    assert out["sliced_file"] is None
    source = await db_session.get(LibraryFile, out["files"][0]["id"])
    source_path = to_absolute_path(source.file_path)
    assert source_path is not None and source_path.exists()
    job = (await async_client.get(f"/api/v1/slice-jobs/{rev['slice_job_id']}")).json()
    assert job["status"] == "failed"
    assert await _derived_rows(db_session) == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_no_slicer_url_configured_fails_cleanly(async_client: AsyncClient, db_session, sidecar, monkeypatch):
    db_session.add(Settings(key="preferred_slicer", value="bambu_studio"))
    db_session.add(Settings(key="bambu_studio_api_url", value=""))
    await db_session.commit()
    monkeypatch.setattr(app_settings, "bambu_studio_api_url", "")

    project, _item, rev = await _upload(async_client)
    await _wait_job(rev["slice_job_id"])

    out = await _tree_revision(async_client, project["id"], rev["id"])
    assert out["slice_status"] == "failed"
    assert "No slicer is configured" in out["slice_error"]
    assert sidecar.slice_requests == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_retry_after_failure(async_client: AsyncClient, sidecar):
    sidecar.mode = "down"
    project, _item, rev = await _upload(async_client)
    await _wait_job(rev["slice_job_id"])

    sidecar.mode = "ok"
    started = await async_client.post(f"/api/v1/projects/revisions/{rev['id']}/slice")
    assert started.status_code == 202, started.text
    body = started.json()
    assert body["slice_status"] == "slicing"
    assert body["job_id"] is not None and body["job_id"] != rev["slice_job_id"]
    await _wait_job(body["job_id"])

    out = await _tree_revision(async_client, project["id"], rev["id"])
    assert out["slice_status"] == "sliced"
    assert out["slice_error"] is None
    assert out["slice_job_id"] == body["job_id"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_slice_is_idempotent_while_running(async_client: AsyncClient, sidecar, monkeypatch):
    _no_auto_slice(monkeypatch)
    project, _item, rev = await _upload(async_client)
    assert rev["slice_status"] is None

    sidecar.block = True
    first = (await async_client.post(f"/api/v1/projects/revisions/{rev['id']}/slice")).json()
    await asyncio.wait_for(sidecar.entered.wait(), timeout=10)
    second = (await async_client.post(f"/api/v1/projects/revisions/{rev['id']}/slice")).json()
    assert first["job_id"] is not None
    assert second == {"job_id": first["job_id"], "slice_status": "slicing"}

    sidecar.release.set()
    await _wait_job(first["job_id"])
    assert len(sidecar.slice_requests) == 1
    # once sliced, another request is a no-op too
    third = (await async_client.post(f"/api/v1/projects/revisions/{rev['id']}/slice")).json()
    assert third == {"job_id": first["job_id"], "slice_status": "sliced"}
    assert len(sidecar.slice_requests) == 1
    assert (await _tree_revision(async_client, project["id"], rev["id"]))["slice_status"] == "sliced"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_revision_deleted_mid_slice_leaves_no_orphan(async_client: AsyncClient, db_session, sidecar, roots):
    sidecar.block = True
    _project, _item, rev = await _upload(async_client)
    job_id = rev["slice_job_id"]
    await asyncio.wait_for(sidecar.entered.wait(), timeout=10)

    deleted = await async_client.delete(f"/api/v1/projects/revisions/{rev['id']}")
    assert deleted.status_code == 204, deleted.text
    sidecar.release.set()
    await _wait_job(job_id)  # raises if the task raised out

    assert await _derived_rows(db_session) == []
    assert list(roots.rglob("*.gcode.3mf")) == []
    job = slice_dispatch.get(job_id)
    assert job is not None and job.status == "completed"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_resume_interrupted_slices(async_client: AsyncClient, db_session, sidecar):
    sidecar.mode = "down"
    project, _item, rev = await _upload(async_client)
    await _wait_job(rev["slice_job_id"])
    # a restart while slicing: the row still says slicing, its in-memory job is gone
    await db_session.execute(
        update(ProjectRevision).where(ProjectRevision.id == rev["id"]).values(slice_status="slicing", slice_job_id=9999)
    )
    await db_session.commit()

    sidecar.mode = "ok"
    assert await project_slice.resume_interrupted_slices() == 1
    db_session.expire_all()
    revision = await db_session.get(ProjectRevision, rev["id"])
    assert revision.slice_job_id not in (None, 9999)
    await _wait_job(revision.slice_job_id)

    out = await _tree_revision(async_client, project["id"], rev["id"])
    assert out["slice_status"] == "sliced"
    assert out["sliced_file"]["filename"] == "support.gcode.3mf"
    assert len(await _derived_rows(db_session)) == 1


@pytest.mark.asyncio
@pytest.mark.integration
async def test_legacy_unsliced_revision_can_be_sliced_on_demand(async_client: AsyncClient, sidecar, monkeypatch):
    _no_auto_slice(monkeypatch)
    project, _item, rev = await _upload(async_client)
    assert rev["slice_status"] is None and rev["slice_job_id"] is None

    started = await async_client.post(f"/api/v1/projects/revisions/{rev['id']}/slice")
    assert started.status_code == 202, started.text
    await _wait_job(started.json()["job_id"])
    out = await _tree_revision(async_client, project["id"], rev["id"])
    assert out["slice_status"] == "sliced"
    assert out["sliced_file"]["filename"] == "support.gcode.3mf"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_slice_missing_revision_is_404(async_client: AsyncClient, sidecar):
    response = await async_client.post("/api/v1/projects/revisions/987654/slice")
    assert response.status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
async def test_aito_drop_slices_each_new_revision(async_client: AsyncClient, db_session, sidecar):
    project = await make_project(db_session)
    order = await make_order(db_session)
    task = await make_task(db_session, order, linked_project_id=project.id)
    await db_session.commit()

    await aito_project_links.drop_files_on_task(
        db_session,
        task,
        [upload("Plate.3mf", threemf_bytes()), upload("bracket.3mf", threemf_bytes())],
        user_id=None,
        actor="Paul",
    )

    db_session.expire_all()
    revisions = list((await db_session.execute(select(ProjectRevision))).scalars().all())
    assert len(revisions) == 2
    for revision in revisions:
        assert revision.slice_job_id is not None
        await _wait_job(revision.slice_job_id)
    db_session.expire_all()
    revisions = list((await db_session.execute(select(ProjectRevision))).scalars().all())
    assert {r.slice_status for r in revisions} == {"sliced"}
    assert sorted(row.filename for row in await _derived_rows(db_session)) == ["Plate.gcode.3mf", "bracket.gcode.3mf"]


def _failing_enqueue(monkeypatch) -> None:
    async def boom(**_kwargs):
        raise RuntimeError("dispatcher down")

    monkeypatch.setattr(slice_dispatch, "enqueue", boom)


def _failing_source_lookup(monkeypatch) -> None:
    """Raises mid-transaction (after the start read the revision), so the trigger's rollback expires
    every instance of the request session."""

    async def boom(_db, _revision_id):
        raise RuntimeError("database is locked")

    monkeypatch.setattr(project_slice, "_source_file", boom)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_failed_slice_start_does_not_fail_the_upload(async_client: AsyncClient, db_session, sidecar, monkeypatch):
    """A start that raises rolls the request session back (expiring its instances); the upload still answers."""
    _failing_source_lookup(monkeypatch)
    _project, _item, rev = await _upload(async_client)  # asserts 201

    assert rev["number"] == 1
    assert [f["filename"] for f in rev["files"]] == ["support.3mf"]
    assert rev["slice_status"] is None  # never claimed: the retry button / POST /slice starts it
    source = await db_session.get(LibraryFile, rev["files"][0]["id"])
    assert source is not None
    source_path = to_absolute_path(source.file_path)
    assert source_path is not None and source_path.exists()
    assert sidecar.slice_requests == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_failed_enqueue_marks_the_upload_failed(async_client: AsyncClient, sidecar, monkeypatch):
    _failing_enqueue(monkeypatch)
    _project, _item, rev = await _upload(async_client)  # asserts 201

    assert [f["filename"] for f in rev["files"]] == ["support.3mf"]
    assert rev["slice_status"] == "failed"  # claimed, then released: never "slicing" with no job
    assert "dispatcher down" in rev["slice_error"]
    assert sidecar.slice_requests == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_failed_slice_start_does_not_fail_the_aito_drop(
    async_client: AsyncClient, db_session, sidecar, monkeypatch
):
    _failing_source_lookup(monkeypatch)
    project = await make_project(db_session)
    order = await make_order(db_session)
    task = await make_task(db_session, order, linked_project_id=project.id)
    await db_session.commit()

    response = await aito_project_links.drop_files_on_task(
        db_session,
        task,
        [upload("Plate.3mf", threemf_bytes()), upload("bracket.3mf", threemf_bytes())],
        user_id=None,
        actor="Paul",
    )

    assert sorted(r.filename for r in response.results) == ["Plate.3mf", "bracket.3mf"]
    assert {r.revision_number for r in response.results} == {1}
    db_session.expire_all()
    revisions = list((await db_session.execute(select(ProjectRevision))).scalars().all())
    assert len(revisions) == 2
    assert {r.slice_status for r in revisions} == {None}
