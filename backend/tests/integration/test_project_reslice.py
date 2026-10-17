"""Re-trancher (spec §12.1): POST /projects/revisions/{id}/reslice."""

import asyncio
import io
import json
import zipfile

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.api.routes.library import to_absolute_path
from backend.app.core.config import settings as app_settings
from backend.app.core.permissions import Permission
from backend.app.models.library import LibraryFile
from backend.app.models.project_item import ProjectItem
from backend.app.models.slicer_pipeline import SlicerPipeline
from backend.app.schemas.slicer import SliceResponse
from backend.app.services import project_files, project_reslice, project_storage
from backend.app.services.slice_dispatch import slice_dispatch
from backend.tests.project_fixtures import (
    legacy_uploads_fixture,
    make_users,
    wal_engine_fixture,  # noqa: F401  # the ``wal_engine`` fixture
)

legacy_uploads = legacy_uploads_fixture(autouse=True)

_ONE_FILAMENT = json.dumps([{"source": "local", "id": "3"}])


@pytest.fixture
async def test_engine(test_engine, wal_engine):
    """WAL file database: the job runs in a background task with its own session
    while the request session closes; behind the shared ``:memory:`` StaticPool
    that close would roll back the job's work (see test_project_legacy_migration).
    The parent fixture is requested only for its model registration."""
    yield wal_engine


@pytest.fixture(autouse=True)
def roots(tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setattr(project_storage, "projects_root", lambda: projects)
    monkeypatch.setattr(app_settings, "base_dir", tmp_path)
    (tmp_path / "library").mkdir()
    return tmp_path


def _3mf(tag: str = "src") -> bytes:
    # Fixed entry timestamps: tests compare two builds byte for byte, and on a
    # slow runner the two calls can fall in different seconds.
    def entry(name: str) -> zipfile.ZipInfo:
        return zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(entry("3D/3dmodel.model"), f"<model>{tag}</model>")
        zf.writestr(entry("Metadata/project_settings.config"), json.dumps({"printer_model": "Bambu Lab H2D"}))
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
            # slice_and_persist merges extra_metadata into file_metadata.
            file_metadata=dict(kwargs["extra_metadata"] or {}),
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
    # T-335: the output is marked as a Re-trancher intermediate for the startup sweep.
    assert call["extra_metadata"] == {
        "sliced_from_library_file_id": rev["files"][0]["id"],
        "reslice_intermediate": True,
    }


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
async def test_validation_check_order_and_messages(async_client: AsyncClient, db_session, fake_slicer):
    """Pin: each check's status + detail, and that an earlier check wins over every later one
    (revision, section, file in revision, 3MF only, pipeline, usable preset, bytes on disk)."""
    _project, item, rev = await _source_revision(async_client)
    gcode = await async_client.post(
        f"/api/v1/projects/items/{item['id']}/revisions",
        files=[("files", ("support.gcode", b"G1", "application/octet-stream"))],
    )
    gcode_rev = gcode.json()["revision"]
    no_preset_id = await _pipeline(db_session, name="No filament", filament_presets_json="[]")
    pipeline_id = await _pipeline(db_session)
    url = f"/api/v1/projects/revisions/{rev['id']}/reslice"
    fid = rev["files"][0]["id"]

    async def post(target_url: str, file_id: int, pid: int) -> tuple[int, str]:
        r = await async_client.post(target_url, json={"file_id": file_id, "pipeline_id": pid})
        return r.status_code, r.json()["detail"]

    assert await post("/api/v1/projects/revisions/999999/reslice", 999999, 999999) == (404, "Revision not found")
    assert await post(url, gcode_rev["files"][0]["id"], 999999) == (404, "File not found in this revision")
    gcode_url = f"/api/v1/projects/revisions/{gcode_rev['id']}/reslice"
    assert await post(gcode_url, gcode_rev["files"][0]["id"], 999999) == (400, "Only 3MF files can be re-sliced")
    assert await post(url, fid, 999999) == (404, "Pipeline not found")

    source = (await db_session.execute(select(LibraryFile).where(LibraryFile.id == fid))).scalar_one()
    to_absolute_path(source.file_path).unlink()
    assert await post(url, fid, no_preset_id) == (400, "Pipeline has no usable filament preset")
    assert await post(url, fid, pipeline_id) == (404, "Source file missing on disk")

    db_item = (await db_session.execute(select(ProjectItem).where(ProjectItem.id == item["id"]))).scalar_one()
    db_item.section = "scan"
    await db_session.commit()
    assert await post(url, 999999, 999999) == (400, "Section 'scan' does not accept files for now")
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
    return {key: headers for key, (_, headers) in (await make_users(db_session, "reslice-", specs)).items()}


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


async def _linked_order(client: AsyncClient, db, project_id: int) -> int:
    """An active Aito order with a task linked to the project (as in test_aito_project_links_api)."""
    from backend.app.models.aito_project import AitoProject
    from backend.app.models.aito_task import AitoTask

    order = AitoProject(
        description="Commande", board_column="devis", status="active", client_id="C1", client_name="ACME"
    )
    db.add(order)
    await db.commit()
    task = AitoTask(project_id=order.id, title="Support")
    db.add(task)
    await db.commit()
    linked = await client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project_id})
    assert linked.status_code == 200, linked.text
    return order.id


async def _revision_added_events(client: AsyncClient, order_id: int) -> list[dict]:
    events = (await client.get(f"/api/v1/aito/{order_id}/events", params={"depth": "story"})).json()["events"]
    return [e for e in events if e["kind"] == "project.revision_added"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_reslice_records_revision_added_on_linked_orders(async_client: AsyncClient, db_session, fake_slicer):
    project, item, rev = await _source_revision(async_client)
    order_id = await _linked_order(async_client, db_session, project["id"])
    assert await _revision_added_events(async_client, order_id) == []  # R1 predates the link
    pipeline_id = await _pipeline(db_session)
    started = await async_client.post(
        f"/api/v1/projects/revisions/{rev['id']}/reslice",
        json={"file_id": rev["files"][0]["id"], "pipeline_id": pipeline_id},
    )
    job = await _wait(async_client, started.json()["job_id"])
    assert job["status"] == "completed", job
    added = [
        e
        for e in await _revision_added_events(async_client, order_id)
        if e["detail"]["revision_id"] == job["result"]["revision_id"]
    ]
    assert len(added) == 1
    assert added[0]["subject_label"] == "Support R2"
    assert len(await _revision_added_events(async_client, order_id)) == 1  # nothing else recorded
    assert added[0]["detail"]["item_id"] == item["id"] and added[0]["detail"]["project_id"] == project["id"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_failed_revision_event_does_not_fail_the_job(
    async_client: AsyncClient, db_session, fake_slicer, roots, monkeypatch
):
    from backend.app.services import aito_project_links

    project, item, rev = await _source_revision(async_client)
    pipeline_id = await _pipeline(db_session)

    async def boom(*_args, **_kwargs):
        raise RuntimeError("event store down")

    monkeypatch.setattr(aito_project_links, "record_on_linked_orders", boom)
    started = await async_client.post(
        f"/api/v1/projects/revisions/{rev['id']}/reslice",
        json={"file_id": rev["files"][0]["id"], "pipeline_id": pipeline_id},
    )
    job = await _wait(async_client, started.json()["job_id"])
    assert job["status"] == "completed", job
    assert job["result"]["revision_number"] == 2
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    assert [r["number"] for s in tree["sections"] for i in s["items"] for r in i["revisions"]] == [2, 1]
    assert await _sliced_rows(db_session) == []
    assert not (roots / "library" / "sliced-1.gcode.3mf").exists()


def _revision_numbers(tree: dict) -> list[int]:
    return [r["number"] for s in tree["sections"] for i in s["items"] for r in i["revisions"]]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_pipeline_deleted_before_the_job_runs_fails_with_404(
    async_client: AsyncClient, db_session, fake_slicer, monkeypatch
):
    from sqlalchemy import update

    project, item, rev = await _source_revision(async_client)
    pipeline_id = await _pipeline(db_session)
    real_run = project_reslice.run_reslice

    async def delete_pipeline_then_run(db, req, **kwargs):
        # Soft-delete lands after the route's checks, before the job reads the pipeline.
        await db.execute(update(SlicerPipeline).where(SlicerPipeline.id == pipeline_id).values(is_deleted=True))
        await db.commit()
        return await real_run(db, req, **kwargs)

    monkeypatch.setattr(project_reslice, "run_reslice", delete_pipeline_then_run)
    started = await async_client.post(
        f"/api/v1/projects/revisions/{rev['id']}/reslice",
        json={"file_id": rev["files"][0]["id"], "pipeline_id": pipeline_id},
    )
    assert started.status_code == 202, started.text
    job = await _wait(async_client, started.json()["job_id"])
    assert job["status"] == "failed"
    assert job["error_status"] == 404 and "Pipeline not found" in job["error_detail"], job
    assert fake_slicer["calls"] == []  # never sliced
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    assert _revision_numbers(tree) == [1]
    assert await _sliced_rows(db_session) == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_slicer_output_missing_on_disk_fails_with_500_and_drops_the_row(
    async_client: AsyncClient, db_session, fake_slicer, roots, monkeypatch
):
    project, item, rev = await _source_revision(async_client)
    pipeline_id = await _pipeline(db_session)
    fake = project_reslice._slice

    async def slice_then_lose_output(db, **kwargs):
        sliced = await fake(db, **kwargs)
        (roots / "library" / sliced.name).unlink()
        return sliced

    monkeypatch.setattr(project_reslice, "_slice", slice_then_lose_output)
    started = await async_client.post(
        f"/api/v1/projects/revisions/{rev['id']}/reslice",
        json={"file_id": rev["files"][0]["id"], "pipeline_id": pipeline_id},
    )
    job = await _wait(async_client, started.json()["job_id"])
    assert job["status"] == "failed"
    assert job["error_status"] == 500 and "The slicer output is missing on disk" in job["error_detail"], job
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    assert _revision_numbers(tree) == [1]
    # Today the intermediate File Manager row is still hard-deleted (the finally runs).
    assert await _sliced_rows(db_session) == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_intermediate_drop_failure_keeps_the_job_and_session_alive(
    async_client: AsyncClient, db_session, fake_slicer, monkeypatch
):
    from backend.app.models.project_item import ProjectRevision
    from backend.app.services.library_trash import library_trash_service

    project, item, rev = await _source_revision(async_client)
    pipeline_id = await _pipeline(db_session)
    attempts: list[int] = []

    async def boom(*_args, **_kwargs):
        attempts.append(1)
        raise OSError("disk gone")

    real_hard_delete = library_trash_service.hard_delete_many
    monkeypatch.setattr(library_trash_service, "hard_delete_many", boom)
    monkeypatch.setattr(project_reslice, "_DROP_RETRY_DELAYS", (0, 0))
    real_run = project_reslice.run_reslice
    follow_up: dict = {}

    async def run_then_query(db, req, **kwargs):
        result = await real_run(db, req, **kwargs)
        # The same session still answers after _drop_intermediate rolled back.
        follow_up["number"] = (
            await db.execute(select(ProjectRevision.number).where(ProjectRevision.id == result["revision_id"]))
        ).scalar_one()
        return result

    monkeypatch.setattr(project_reslice, "run_reslice", run_then_query)
    started = await async_client.post(
        f"/api/v1/projects/revisions/{rev['id']}/reslice",
        json={"file_id": rev["files"][0]["id"], "pipeline_id": pipeline_id},
    )
    job = await _wait(async_client, started.json()["job_id"])
    assert job["status"] == "completed", job
    assert job["result"]["revision_number"] == 2
    assert follow_up == {"number": 2}
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    assert _revision_numbers(tree) == [2, 1]
    # T-288: tried three times; every attempt failed, so the intermediate row is left
    # behind (logged, not raised) for the startup sweep.
    assert len(attempts) == 3
    assert [r.filename for r in await _sliced_rows(db_session)] == ["sliced-1.gcode.3mf"]
    # T-335: the leftover carries the Re-trancher marker, so the next startup sweep deletes it.
    monkeypatch.setattr(library_trash_service, "hard_delete_many", real_hard_delete)
    assert await project_reslice.sweep_orphan_intermediates(db_session) == 1
    assert await _sliced_rows(db_session) == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_revision_added_helper_raising_does_not_fail_the_job(
    async_client: AsyncClient, db_session, fake_slicer, monkeypatch
):
    from backend.app.services import project_filing

    project, item, rev = await _source_revision(async_client)
    pipeline_id = await _pipeline(db_session)

    async def boom(*_args, **_kwargs):
        raise RuntimeError("helper itself blew up")

    monkeypatch.setattr(project_filing, "record_revision_added", boom)
    started = await async_client.post(
        f"/api/v1/projects/revisions/{rev['id']}/reslice",
        json={"file_id": rev["files"][0]["id"], "pipeline_id": pipeline_id},
    )
    job = await _wait(async_client, started.json()["job_id"])
    assert job["status"] == "completed", job
    assert job["result"]["revision_number"] == 2
    assert await _sliced_rows(db_session) == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_reslice_refuses_a_source_swapped_for_a_symlink(
    async_client: AsyncClient, db_session, fake_slicer, roots
):
    """T-207: a source 3MF replaced by a symlink to a data-dir file (``.jwt_secret``, the
    database) reads as missing; its bytes never reach the slicer."""
    _project, _item, rev = await _source_revision(async_client)
    pipeline_id = await _pipeline(db_session)
    fid = rev["files"][0]["id"]
    secret = roots / ".jwt_secret"  # under the data dir, outside the projects root
    secret.write_bytes(_3mf("secret"))
    source = (await db_session.execute(select(LibraryFile).where(LibraryFile.id == fid))).scalar_one()
    path = to_absolute_path(source.file_path)
    path.unlink()
    path.symlink_to(secret)
    response = await async_client.post(
        f"/api/v1/projects/revisions/{rev['id']}/reslice", json={"file_id": fid, "pipeline_id": pipeline_id}
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "Source file missing on disk"
    assert fake_slicer["calls"] == []


@pytest.mark.asyncio
async def test_slice_seam_delegates_to_the_library_slicer(monkeypatch):
    """``_slice`` forwards the session and every keyword to ``slice_and_persist`` and returns its result."""
    calls = []
    sentinel_db, sentinel_result = object(), object()

    async def fake_slice_and_persist(db, **kwargs):
        calls.append((db, kwargs))
        return sentinel_result

    monkeypatch.setattr(project_reslice, "slice_and_persist", fake_slice_and_persist)
    result = await project_reslice._slice(sentinel_db, model_bytes=b"3mf", model_filename="a.3mf", job_id=7)
    assert result is sentinel_result
    assert calls == [(sentinel_db, {"model_bytes": b"3mf", "model_filename": "a.3mf", "job_id": 7})]


# --- T-288: _drop_intermediate retries, and the startup sweep of leftovers ---


@pytest.mark.asyncio
@pytest.mark.integration
async def test_intermediate_drop_retries_and_succeeds_on_the_second_attempt(
    async_client: AsyncClient, db_session, fake_slicer, roots, monkeypatch, caplog
):
    import logging

    from backend.app.services.library_trash import library_trash_service

    project, _item, rev = await _source_revision(async_client)
    pipeline_id = await _pipeline(db_session)
    real = library_trash_service.hard_delete_many
    attempts: list[int] = []
    pauses: list[float] = []

    async def locked_once(db, rows):
        attempts.append(1)
        if len(attempts) == 1:
            raise OSError("database is locked")
        return await real(db, rows)

    real_sleep = asyncio.sleep

    async def no_pause(seconds):
        pauses.append(seconds)
        await real_sleep(0)

    monkeypatch.setattr(library_trash_service, "hard_delete_many", locked_once)
    monkeypatch.setattr(project_reslice.asyncio, "sleep", no_pause)
    with caplog.at_level(logging.WARNING, logger=project_reslice.__name__):
        started = await async_client.post(
            f"/api/v1/projects/revisions/{rev['id']}/reslice",
            json={"file_id": rev["files"][0]["id"], "pipeline_id": pipeline_id},
        )
        job = await _wait(async_client, started.json()["job_id"])
    assert job["status"] == "completed", job
    assert len(attempts) == 2
    assert 0.2 in pauses  # the first pause of _DROP_RETRY_DELAYS
    assert "failed (attempt 1 of 3), retrying" in caplog.text
    assert "could not delete intermediate" not in caplog.text
    assert await _sliced_rows(db_session) == []
    assert not (roots / "library" / "sliced-1.gcode.3mf").exists()


def _loose(roots, name: str, *, sliced_from: int | None = None, marker: bool = False, **fields) -> LibraryFile:
    """A loose sliced row; ``marker`` adds the Re-trancher intermediate marker (T-335)."""
    path = roots / "library" / name
    path.write_bytes(b"gcode")
    metadata: dict = {}
    if sliced_from is not None:
        metadata["sliced_from_library_file_id"] = sliced_from
    if marker:
        metadata[project_reslice.INTERMEDIATE_MARKER] = True
    return LibraryFile(
        filename=name,
        file_path=str(path.relative_to(roots)),
        file_type="gcode.3mf",
        file_size=5,
        source_type="sliced",
        file_metadata=metadata or None,
        **fields,
    )


@pytest.mark.asyncio
@pytest.mark.integration
async def test_startup_sweep_deletes_only_unused_loose_marked_intermediates(
    async_client: AsyncClient, db_session, roots, caplog
):
    import logging
    from datetime import datetime

    from backend.app.models.pipeline_run import PipelineRun

    _project, _item, rev = await _source_revision(async_client)
    revision_file_id = rev["files"][0]["id"]
    plain = _loose(roots, "plain.3mf")
    db_session.add(plain)
    await db_session.flush()
    orphan = _loose(roots, "support.gcode.3mf", sliced_from=revision_file_id, marker=True)
    filed = _loose(roots, "filed.gcode.3mf", sliced_from=revision_file_id, marker=True, revision_id=rev["id"])
    from_plain = _loose(roots, "plain.gcode.3mf", sliced_from=plain.id)
    used = _loose(roots, "pipeline.gcode.3mf", sliced_from=revision_file_id, marker=True)
    trashed = _loose(
        roots, "trashed.gcode.3mf", sliced_from=revision_file_id, marker=True, deleted_at=datetime(2026, 10, 1)
    )
    # T-335: an unmarked slice of a project revision file (a File Manager slice, or a
    # Re-trancher leftover from before the marker existed) is never swept.
    unmarked = _loose(roots, "unmarked.gcode.3mf", sliced_from=revision_file_id)
    db_session.add_all([orphan, filed, from_plain, used, trashed, unmarked])
    await db_session.flush()
    db_session.add(PipelineRun(source_library_file_id=revision_file_id, sliced_library_file_id=used.id))
    await db_session.commit()
    orphan_id = orphan.id
    kept = {plain.id, filed.id, from_plain.id, used.id, trashed.id, unmarked.id, revision_file_id}

    with caplog.at_level(logging.WARNING, logger=project_reslice.__name__):
        deleted = await project_reslice.sweep_orphan_intermediates(db_session)

    assert deleted == 1
    ids = set((await db_session.execute(select(LibraryFile.id))).scalars().all())
    assert orphan_id not in ids
    assert kept <= ids
    assert not (roots / "library" / "support.gcode.3mf").exists()
    for name in (
        "plain.3mf",
        "filed.gcode.3mf",
        "plain.gcode.3mf",
        "pipeline.gcode.3mf",
        "trashed.gcode.3mf",
        "unmarked.gcode.3mf",
    ):
        assert (roots / "library" / name).exists(), name
    assert f"deleting leftover intermediate library file {orphan_id} (support.gcode.3mf)" in caplog.text
    # A second startup finds nothing more to do.
    assert await project_reslice.sweep_orphan_intermediates(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.integration
async def test_startup_sweep_keeps_a_file_manager_slice_whose_source_was_moved_into_a_project(
    async_client: AsyncClient, db_session, roots, monkeypatch
):
    """T-335: slice model.3mf in the File Manager, keep the unqueued output, then move
    model.3mf into a project (same row, now with a revision_id). The slice survives."""
    from backend.tests.project_fixtures import make_managed_library_file

    monkeypatch.setattr(app_settings, "archive_dir", roots / "archive")
    project = (await async_client.post("/api/v1/projects/", json={"name": "Support caméra"})).json()
    model = await make_managed_library_file(db_session, "model.3mf", _3mf())
    model_id = model.id
    fm_slice = _loose(roots, "model.gcode.3mf", sliced_from=model_id)
    db_session.add(fm_slice)
    await db_session.commit()
    fm_slice_id = fm_slice.id

    moved = await async_client.post(
        f"/api/v1/projects/{project['id']}/import-library-files", json={"file_ids": [model_id]}
    )
    assert moved.status_code == 200, moved.text
    assert [m["file_id"] for m in moved.json()["moved"]] == [model_id]
    source_revision = (
        await db_session.execute(
            select(LibraryFile.revision_id).where(LibraryFile.id == model_id).execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert source_revision is not None

    assert await project_reslice.sweep_orphan_intermediates(db_session) == 0
    kept = (
        await db_session.execute(
            select(LibraryFile).where(LibraryFile.id == fm_slice_id).execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert kept.deleted_at is None and kept.revision_id is None
    assert (roots / "library" / "model.gcode.3mf").exists()


# --- T-352: every usage column keeps a marked intermediate out of the sweep ---


def _usage_key(column) -> str:
    """``"PrintQueueItem.library_file_id"`` for a ``project_files._USAGE_COLUMNS`` entry."""
    return f"{column.class_.__name__}.{column.key}"


async def _reference_from(db, key: str, file_id: int, *, finished: bool) -> None:
    """Add a row whose ``key`` usage column points at ``file_id``. ``finished`` makes the
    referencing row a finished one (completed status), and soft-deleted where the table has
    ``deleted_at``: a use is a use whatever state the referencing row is in."""
    from datetime import datetime

    from backend.app.models.archive import PrintArchive
    from backend.app.models.pipeline_run import PipelineRun
    from backend.app.models.print_batch import PrintBatch
    from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant

    if key == "PrintQueueItem.library_file_id":
        db.add(PrintQueueItem(library_file_id=file_id, status="completed" if finished else "pending"))
    elif key == "PrintArchive.library_file_id":
        db.add(
            PrintArchive(
                filename="archived.gcode.3mf",
                file_path="archive/archived.gcode.3mf",
                file_size=5,
                library_file_id=file_id,
                status="completed",
                deleted_at=datetime(2026, 10, 1) if finished else None,
            )
        )
    elif key == "PrintBatch.library_file_id":
        db.add(PrintBatch(name="Lot", library_file_id=file_id, status="completed" if finished else "active"))
    elif key == "PrintQueueVariant.library_file_id":
        item = PrintQueueItem(library_file_id=None, status="completed" if finished else "pending")
        db.add(item)
        await db.flush()
        db.add(PrintQueueVariant(queue_item_id=item.id, library_file_id=file_id, target_model="X1C"))
    elif key == "PipelineRun.source_library_file_id":
        db.add(PipelineRun(source_library_file_id=file_id, status="completed" if finished else "queued"))
    elif key == "PipelineRun.sliced_library_file_id":
        db.add(PipelineRun(sliced_library_file_id=file_id, status="completed" if finished else "queued"))
    else:  # a new usage column: give it a referencing row above
        raise AssertionError(f"no referencing row for usage column {key}")


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize("finished", [False, True], ids=["live", "finished"])
@pytest.mark.parametrize("key", [_usage_key(column) for column in project_files._USAGE_COLUMNS])
async def test_startup_sweep_keeps_a_marked_intermediate_any_usage_column_references(
    async_client: AsyncClient, db_session, roots, key, finished
):
    """A marked Re-trancher leftover that a queue item, archive, batch, queue variant or
    pipeline run still points at (live or finished/soft-deleted) survives the sweep, and the
    returned count only covers the unreferenced orphan next to it."""
    _project, _item, rev = await _source_revision(async_client)
    revision_file_id = rev["files"][0]["id"]
    referenced = _loose(roots, "referenced.gcode.3mf", sliced_from=revision_file_id, marker=True)
    orphan = _loose(roots, "orphan.gcode.3mf", sliced_from=revision_file_id, marker=True)
    db_session.add_all([referenced, orphan])
    await db_session.flush()
    referenced_id, orphan_id = referenced.id, orphan.id
    await _reference_from(db_session, key, referenced_id, finished=finished)
    await db_session.commit()

    assert await project_reslice.sweep_orphan_intermediates(db_session) == 1

    ids = set((await db_session.execute(select(LibraryFile.id))).scalars().all())
    assert referenced_id in ids and orphan_id not in ids
    kept = (
        await db_session.execute(
            select(LibraryFile).where(LibraryFile.id == referenced_id).execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert kept.deleted_at is None
    assert (roots / "library" / "referenced.gcode.3mf").exists()
    assert not (roots / "library" / "orphan.gcode.3mf").exists()
    assert await project_reslice.sweep_orphan_intermediates(db_session) == 0


def test_lifespan_runs_the_intermediate_sweep_after_the_migrations_and_never_blocks_startup():
    """Wiring check, read from the source like test_oidc_env_startup.py: the lifespan is too
    large to run here. The sweep's behaviour is pinned by the test above."""
    import inspect

    from backend.app.main import lifespan

    source = inspect.getsource(lifespan)
    call = source.index("await sweep_orphan_intermediates(")
    assert source.index("await init_db()") < call
    guard = source.rindex("try:", 0, call)
    assert "except Exception" in source[call : source.index("\n\n", call)]
    assert source.index("from backend.app.services.project_reslice import sweep_orphan_intermediates") > guard
