"""Re-trancher (spec §12.1): POST /projects/revisions/{id}/reslice."""

import asyncio
import io
import json
import zipfile

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.core.auth import create_access_token, get_password_hash
from backend.app.core.config import settings as app_settings
from backend.app.core.permissions import Permission
from backend.app.models.group import Group
from backend.app.models.library import LibraryFile
from backend.app.models.settings import Settings
from backend.app.models.slicer_pipeline import SlicerPipeline
from backend.app.models.user import User
from backend.app.schemas.slicer import SliceResponse
from backend.app.services import project_reslice, project_storage
from backend.app.services.slice_dispatch import slice_dispatch

_ONE_FILAMENT = json.dumps([{"source": "local", "id": "3"}])


@pytest.fixture
async def test_engine(test_engine, tmp_path):
    """WAL file database: the job runs in a background task with its own session
    while the request session closes; behind the shared ``:memory:`` StaticPool
    that close would roll back the job's work (see test_project_legacy_migration).
    The parent fixture is requested only for its model registration."""
    from sqlalchemy import event
    from sqlalchemy.ext.asyncio import create_async_engine

    from backend.app.core.database import Base

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'reslice.db'}")

    @event.listens_for(engine.sync_engine, "connect")
    def _pragmas(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode = WAL")
        cursor.execute("PRAGMA busy_timeout = 15000")
        cursor.close()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest.fixture(autouse=True)
def roots(tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setattr(project_storage, "projects_root", lambda: projects)
    monkeypatch.setattr(app_settings, "base_dir", tmp_path)
    (tmp_path / "library").mkdir()
    return tmp_path


def _3mf(tag: str = "src") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("3D/3dmodel.model", f"<model>{tag}</model>")
        zf.writestr("Metadata/project_settings.config", json.dumps({"printer_model": "Bambu Lab H2D"}))
    return buf.getvalue()


@pytest.fixture
def fake_slicer(monkeypatch, roots):
    """Stands in for slice_and_persist: writes a managed LibraryFile, like the real one."""
    calls: list[dict] = []
    gate: dict = {"before_return": None, "fail": None}

    async def fake(db, **kwargs):
        calls.append(kwargs)
        n = len(calls)  # captured before any await: concurrent jobs never share an output name
        if gate["fail"]:
            from fastapi import HTTPException

            raise HTTPException(status_code=502, detail=gate["fail"])
        if gate["before_return"]:
            await gate["before_return"]()
        out = roots / "library" / f"sliced-{n}.gcode.3mf"
        out.write_bytes(_3mf(f"out{n}"))
        row = LibraryFile(
            filename=out.name,
            file_path=str(out.relative_to(roots)),
            file_type="gcode.3mf",
            file_size=out.stat().st_size,
            source_type="sliced",
        )
        db.add(row)
        await db.commit()
        return SliceResponse(
            library_file_id=row.id,
            name=row.filename,
            print_time_seconds=600,
            filament_used_g=12.0,
            filament_used_mm=4000.0,
            used_embedded_settings=False,
        )

    monkeypatch.setattr(project_reslice, "_slice", fake)
    return {"calls": calls, "gate": gate}


async def _pipeline(db, name="H2D PETG", filament_presets_json=_ONE_FILAMENT, **fields) -> int:
    row = SlicerPipeline(
        name=name,
        printer_preset_source="local",
        printer_preset_id="1",
        process_preset_source="local",
        process_preset_id="2",
        filament_presets_json=filament_presets_json,
        **fields,
    )
    db.add(row)
    await db.commit()
    return row.id


async def _source_revision(client: AsyncClient, item_name="Support", filename="support.3mf", headers=None):
    project = (await client.post("/api/v1/projects/", json={"name": "Support caméra"}, headers=headers)).json()
    item = (
        await client.post(
            f"/api/v1/projects/{project['id']}/items",
            json={"section": "impression", "name": item_name},
            headers=headers,
        )
    ).json()
    up = await client.post(
        f"/api/v1/projects/items/{item['id']}/revisions",
        files=[("files", (filename, _3mf(), "application/octet-stream"))],
        headers=headers,
    )
    assert up.status_code == 201, up.text
    rev = up.json()["revision"]
    return project, item, rev


async def _wait(client: AsyncClient, job_id: int) -> dict:
    task = slice_dispatch._tasks.get(job_id)
    if task is not None:
        await asyncio.wait_for(asyncio.shield(task), timeout=10)
    body = (await client.get(f"/api/v1/slice-jobs/{job_id}")).json()
    assert body["status"] in ("completed", "failed"), body
    return body


async def _sliced_rows(db) -> list[LibraryFile]:
    return list((await db.execute(select(LibraryFile).where(LibraryFile.source_type == "sliced"))).scalars().all())


@pytest.mark.asyncio
@pytest.mark.integration
async def test_happy_path_creates_next_revision(async_client: AsyncClient, db_session, fake_slicer, roots):
    project, item, rev = await _source_revision(async_client)
    pipeline_id = await _pipeline(db_session)
    started = await async_client.post(
        f"/api/v1/projects/revisions/{rev['id']}/reslice",
        json={"file_id": rev["files"][0]["id"], "pipeline_id": pipeline_id},
    )
    assert started.status_code == 202, started.text
    assert started.json()["status_url"] == f"/api/v1/slice-jobs/{started.json()['job_id']}"
    job = await _wait(async_client, started.json()["job_id"])
    assert job["status"] == "completed", job
    assert job["kind"] == "project_revision"
    result = job["result"]
    assert result["revision_number"] == 2 and result["filename"] == "support.gcode.3mf"
    assert result["project_id"] == project["id"] and result["item_id"] == item["id"]

    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    revs = {r["number"]: r for s in tree["sections"] for i in s["items"] for r in i["revisions"]}
    new = revs[2]
    assert new["id"] == result["revision_id"]
    assert new["status"] == "wip"
    assert new["derived_from"]["id"] == rev["id"]
    assert new["outdated_by"] is None
    assert new["pipeline_name"] == "H2D PETG"
    assert new["note"] == "Re-tranché depuis R1 · pipeline H2D PETG"
    assert [f["filename"] for f in new["files"]] == ["support.gcode.3mf"]
    assert new["files"][0]["id"] == result["file_id"]
    # the intermediate File Manager row and its bytes are gone
    assert await _sliced_rows(db_session) == []
    assert not (roots / "library" / "sliced-1.gcode.3mf").exists()
    # the slicer got the source bytes and the pipeline presets
    call = fake_slicer["calls"][0]
    assert call["model_filename"] == "support.3mf"
    assert call["model_bytes"] == _3mf()
    assert call["request"].printer_preset.id == "1"
    assert [f.id for f in call["request"].filament_presets] == ["3"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_validation_errors(async_client: AsyncClient, db_session, fake_slicer):
    project, item, rev = await _source_revision(async_client)
    gcode = await async_client.post(
        f"/api/v1/projects/items/{item['id']}/revisions",
        files=[("files", ("support.gcode", b"G1", "application/octet-stream"))],
    )
    gcode_rev = gcode.json()["revision"]
    pipeline_id = await _pipeline(db_session)
    deleted_id = await _pipeline(db_session, name="old", is_deleted=True)
    url = f"/api/v1/projects/revisions/{rev['id']}/reslice"
    fid = rev["files"][0]["id"]
    missing_rev = await async_client.post(
        "/api/v1/projects/revisions/999999/reslice", json={"file_id": fid, "pipeline_id": pipeline_id}
    )
    assert missing_rev.status_code == 404
    other_file = await async_client.post(url, json={"file_id": gcode_rev["files"][0]["id"], "pipeline_id": pipeline_id})
    assert other_file.status_code == 404  # file of another revision
    gcode_source = await async_client.post(
        f"/api/v1/projects/revisions/{gcode_rev['id']}/reslice",
        json={"file_id": gcode_rev["files"][0]["id"], "pipeline_id": pipeline_id},
    )
    assert gcode_source.status_code == 400  # .gcode cannot be re-sliced
    assert (await async_client.post(url, json={"file_id": fid, "pipeline_id": 999999})).status_code == 404
    assert (await async_client.post(url, json={"file_id": fid, "pipeline_id": deleted_id})).status_code == 404
    assert fake_slicer["calls"] == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_pipeline_without_filament_preset_is_400_and_starts_no_job(
    async_client: AsyncClient, db_session, fake_slicer
):
    project, item, rev = await _source_revision(async_client)
    pipeline_id = await _pipeline(db_session, name="No filament", filament_presets_json="[]")
    tasks_before = set(slice_dispatch._tasks)
    jobs_before = set(slice_dispatch._jobs)
    response = await async_client.post(
        f"/api/v1/projects/revisions/{rev['id']}/reslice",
        json={"file_id": rev["files"][0]["id"], "pipeline_id": pipeline_id},
    )
    assert response.status_code == 400, response.text
    assert response.json()["detail"] == "Pipeline has no usable filament preset"
    assert set(slice_dispatch._jobs) == jobs_before and set(slice_dispatch._tasks) <= tasks_before
    assert fake_slicer["calls"] == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_slicer_failure_creates_nothing(async_client: AsyncClient, db_session, fake_slicer):
    project, item, rev = await _source_revision(async_client)
    pipeline_id = await _pipeline(db_session)
    fake_slicer["gate"]["fail"] = "Sidecar unreachable"
    started = await async_client.post(
        f"/api/v1/projects/revisions/{rev['id']}/reslice",
        json={"file_id": rev["files"][0]["id"], "pipeline_id": pipeline_id},
    )
    job = await _wait(async_client, started.json()["job_id"])
    assert job["status"] == "failed"
    assert job["error_status"] == 502 and "Sidecar unreachable" in job["error_detail"]
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    assert [r["number"] for s in tree["sections"] for i in s["items"] for r in i["revisions"]] == [1]
    assert await _sliced_rows(db_session) == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_item_renamed_during_slice_lands_in_renamed_item(
    async_client: AsyncClient, db_session, fake_slicer, roots
):
    project, item, rev = await _source_revision(async_client)
    pipeline_id = await _pipeline(db_session)

    async def rename_item():
        r = await async_client.patch(f"/api/v1/projects/items/{item['id']}", json={"name": "Support v2"})
        assert r.status_code == 200, r.text

    fake_slicer["gate"]["before_return"] = rename_item
    started = await async_client.post(
        f"/api/v1/projects/revisions/{rev['id']}/reslice",
        json={"file_id": rev["files"][0]["id"], "pipeline_id": pipeline_id},
    )
    job = await _wait(async_client, started.json()["job_id"])
    assert job["status"] == "completed", job
    new_file_path = (
        await db_session.execute(select(LibraryFile.file_path).where(LibraryFile.id == job["result"]["file_id"]))
    ).scalar_one()
    assert "Support v2" in new_file_path  # written under the item's current folder
    assert (roots / new_file_path).exists()
    assert await _sliced_rows(db_session) == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_item_deleted_during_slice_fails_and_cleans_up(async_client: AsyncClient, db_session, fake_slicer):
    project, item, rev = await _source_revision(async_client)
    pipeline_id = await _pipeline(db_session)

    async def delete_item():
        r = await async_client.delete(f"/api/v1/projects/items/{item['id']}")
        assert r.status_code == 204, r.text

    fake_slicer["gate"]["before_return"] = delete_item
    started = await async_client.post(
        f"/api/v1/projects/revisions/{rev['id']}/reslice",
        json={"file_id": rev["files"][0]["id"], "pipeline_id": pipeline_id},
    )
    job = await _wait(async_client, started.json()["job_id"])
    assert job["status"] == "failed" and job["error_status"] == 404, job
    assert await _sliced_rows(db_session) == []
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    assert [i for s in tree["sections"] for i in s["items"]] == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_source_revision_deleted_during_slice_fails_and_cleans_up(
    async_client: AsyncClient, db_session, fake_slicer
):
    project, item, rev = await _source_revision(async_client)
    other = await async_client.post(
        f"/api/v1/projects/items/{item['id']}/revisions",
        files=[("files", ("support-b.3mf", _3mf("b"), "application/octet-stream"))],
    )
    assert other.status_code == 201
    pipeline_id = await _pipeline(db_session)

    async def delete_source():
        r = await async_client.delete(f"/api/v1/projects/revisions/{rev['id']}")
        assert r.status_code == 204, r.text

    fake_slicer["gate"]["before_return"] = delete_source
    started = await async_client.post(
        f"/api/v1/projects/revisions/{rev['id']}/reslice",
        json={"file_id": rev["files"][0]["id"], "pipeline_id": pipeline_id},
    )
    job = await _wait(async_client, started.json()["job_id"])
    assert job["status"] == "failed"
    assert job["error_status"] in (400, 404)
    assert await _sliced_rows(db_session) == []
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    assert [r["number"] for s in tree["sections"] for i in s["items"] for r in i["revisions"]] == [2]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_two_concurrent_reslices_get_consecutive_numbers(async_client: AsyncClient, db_session, fake_slicer):
    project, item, rev = await _source_revision(async_client)
    pipeline_id = await _pipeline(db_session)
    body = {"file_id": rev["files"][0]["id"], "pipeline_id": pipeline_id}
    a = await async_client.post(f"/api/v1/projects/revisions/{rev['id']}/reslice", json=body)
    b = await async_client.post(f"/api/v1/projects/revisions/{rev['id']}/reslice", json=body)
    ja, jb = await _wait(async_client, a.json()["job_id"]), await _wait(async_client, b.json()["job_id"])
    assert ja["status"] == jb["status"] == "completed", (ja, jb)
    assert sorted([ja["result"]["revision_number"], jb["result"]["revision_number"]]) == [2, 3]
    assert await _sliced_rows(db_session) == []


@pytest.fixture
async def users(db_session):
    """Auth on. Each user gets one group with exactly the listed permissions."""
    db_session.add(Settings(key="auth_enabled", value="true"))
    specs = {
        "full": [
            Permission.PROJECTS_UPDATE,
            Permission.LIBRARY_UPLOAD,
            Permission.PIPELINES_READ,
        ],
        "no_upload": [Permission.PROJECTS_UPDATE, Permission.PIPELINES_READ],
        "no_pipelines": [Permission.PROJECTS_UPDATE, Permission.LIBRARY_UPLOAD],
        "no_projects": [Permission.LIBRARY_UPLOAD, Permission.PIPELINES_READ],
    }
    out = {}
    for key, permissions in specs.items():
        group = Group(name=f"reslice-{key}", permissions=[p.value for p in permissions], is_system=False)
        db_session.add(group)
        await db_session.flush()
        user = User(username=f"reslice-{key}", password_hash=get_password_hash("password"), is_active=True)
        user.groups.append(group)
        db_session.add(user)
        await db_session.flush()
        out[key] = {"Authorization": f"Bearer {create_access_token(data={'sub': user.username})}"}
    await db_session.commit()
    return out


@pytest.mark.asyncio
@pytest.mark.integration
async def test_reslice_needs_projects_update_library_upload_and_pipelines_read(
    async_client: AsyncClient, users, fake_slicer
):
    url = "/api/v1/projects/revisions/987654/reslice"
    body = {"file_id": 1, "pipeline_id": 1}
    for key in ("no_upload", "no_pipelines", "no_projects"):
        response = await async_client.post(url, json=body, headers=users[key])
        assert response.status_code == 403, (key, response.text)
    # control: with all three the request gets past auth (and the revision does not exist)
    assert (await async_client.post(url, json=body, headers=users["full"])).status_code == 404
    assert fake_slicer["calls"] == []
