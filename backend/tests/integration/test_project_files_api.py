"""Project files API (spec §8)."""

import io
import json
import zipfile
from functools import partial

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.api.routes import project_files as project_files_routes
from backend.app.api.routes.library import to_absolute_path
from backend.app.core.config import settings
from backend.app.models.library import LibraryFile
from backend.app.models.slicer_pipeline import SlicerPipeline
from backend.app.schemas.project_files import REVISION_NOTE_MAX_LENGTH
from backend.app.services import project_storage
from backend.tests.project_fixtures import ChunkedMultipart, api_project, projects_root_fixture

root = projects_root_fixture(autouse=True)
_project = partial(api_project, check=False)


async def _item(client, project_id, section="impression", name="Support"):
    response = await client.post(f"/api/v1/projects/{project_id}/items", json={"section": section, "name": name})
    assert response.status_code == 201, response.text
    return response.json()


async def _upload(client, item_id, *files, **form):
    return await client.post(
        f"/api/v1/projects/items/{item_id}/revisions",
        files=[("files", (name, data, "application/octet-stream")) for name, data in files],
        data={k: str(v) for k, v in form.items()},
    )


@pytest.mark.asyncio
@pytest.mark.integration
async def test_full_flow_tree_status_download(async_client: AsyncClient, root):
    project = await _project(async_client)
    item = await _item(async_client, project["id"])
    response = await _upload(async_client, item["id"], ("a.gcode", b"geo"), ("b.gcode", b"geo2"), note="v1")
    assert response.status_code == 201, response.text
    rev = response.json()["revision"]
    assert rev["number"] == 1 and len(rev["files"]) == 2
    patched = await async_client.patch(f"/api/v1/projects/revisions/{rev['id']}", json={"status": "valide"})
    assert patched.json()["status"] == "valide"
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    assert tree["code"] == project["code"]
    assert tree["sections"][2]["items"][0]["revisions"][0]["status"] == "valide"
    one = await async_client.get(
        f"/api/v1/projects/revisions/{rev['id']}/download", params={"file_id": rev["files"][0]["id"]}
    )
    assert one.status_code == 200 and one.content == b"geo"
    zipped = await async_client.get(f"/api/v1/projects/revisions/{rev['id']}/download")
    assert sorted(zipfile.ZipFile(io.BytesIO(zipped.content)).namelist()) == ["a.gcode", "b.gcode"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_errors_map_to_http(async_client: AsyncClient):
    project = await _project(async_client)
    item = await _item(async_client, project["id"])
    assert (
        await async_client.post(
            f"/api/v1/projects/{project['id']}/items", json={"section": "impression", "name": "support"}
        )
    ).status_code == 409
    assert (
        await async_client.post(f"/api/v1/projects/{project['id']}/items", json={"section": "garage", "name": "x"})
    ).status_code == 422
    assert (await async_client.get("/api/v1/projects/999999/tree")).status_code == 404
    assert (await async_client.patch("/api/v1/projects/revisions/999999", json={"note": "x"})).status_code == 404
    assert (await _upload(async_client, item["id"])).status_code in (400, 422)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_rename_fork_delete_and_files(async_client: AsyncClient, root):
    project = await _project(async_client)
    item = await _item(async_client, project["id"])
    rev = (await _upload(async_client, item["id"], ("a.gcode", b"x"))).json()["revision"]
    renamed = await async_client.patch(f"/api/v1/projects/items/{item['id']}", json={"name": "Support v2"})
    assert renamed.json()["name"] == "Support v2"
    added = await async_client.post(
        f"/api/v1/projects/revisions/{rev['id']}/files",
        files=[("files", ("b.gcode", b"x", "application/octet-stream"))],
    )
    # same bytes as a.gcode but in the SAME revision: warnings only compare other revisions
    assert added.status_code == 200 and added.json()["warnings"] == []
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    files = tree["sections"][2]["items"][0]["revisions"][0]["files"]
    removed = await async_client.delete(f"/api/v1/projects/revisions/{rev['id']}/files/{files[0]['id']}")
    assert removed.status_code == 204
    forked = await async_client.post(
        f"/api/v1/projects/items/{item['id']}/fork", json={"revision_id": rev["id"], "name": "Variante B"}
    )
    assert forked.status_code == 201 and forked.json()["forked_from"]["number"] == 1
    assert (await async_client.delete(f"/api/v1/projects/revisions/{rev['id']}")).status_code == 204
    assert (await async_client.delete(f"/api/v1/projects/items/{item['id']}")).status_code == 204


@pytest.mark.asyncio
@pytest.mark.integration
async def test_tree_isolated_per_project(async_client: AsyncClient):
    a = await _project(async_client)
    b = (await async_client.post("/api/v1/projects/", json={"name": "Autre"})).json()
    item = await _item(async_client, a["id"])
    await _upload(async_client, item["id"], ("a.gcode", b"x"))
    tree_b = (await async_client.get(f"/api/v1/projects/{b['id']}/tree")).json()
    assert all(section["items"] == [] for section in tree_b["sections"])


@pytest.mark.asyncio
@pytest.mark.integration
async def test_upload_content_length_gate(async_client: AsyncClient, monkeypatch):
    monkeypatch.setattr(settings, "library_max_upload_bytes", 1024)
    project = await _project(async_client)
    item = await _item(async_client, project["id"])
    response = await _upload(async_client, item["id"], ("a.gcode", b"x" * 4 * 1024 * 3))
    assert response.status_code == 413


async def _revision_with_files(client, *files):
    project = await _project(client)
    item = await _item(client, project["id"])
    response = await _upload(client, item["id"], *files)
    assert response.status_code == 201, response.text
    return response.json()["revision"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_zip_temp_file_removed_when_build_fails(async_client: AsyncClient, tmp_path, monkeypatch):
    rev = await _revision_with_files(async_client, ("a.gcode", b"x"))
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    real_mkstemp = project_files_routes.tempfile.mkstemp
    monkeypatch.setattr(
        project_files_routes.tempfile, "mkstemp", lambda suffix="": real_mkstemp(suffix=suffix, dir=scratch)
    )

    def boom(paths_and_names, archive):
        raise OSError("disk full")

    monkeypatch.setattr(project_files_routes, "_build_zip", boom)
    try:
        response = await async_client.get(f"/api/v1/projects/revisions/{rev['id']}/download")
        assert response.status_code >= 500
    except OSError:
        pass  # the test transport may re-raise instead of answering 500
    assert list(scratch.iterdir()) == []


def _vanish_before_zip(monkeypatch, vanish: set[str]) -> None:
    """Delete the named files after the route's existence check and before the zip build (the race)."""
    real = project_files_routes._build_zip

    def build(paths_and_names, archive):
        for path, name in paths_and_names:
            if name in vanish:
                path.unlink()
        return real(paths_and_names, archive)

    monkeypatch.setattr(project_files_routes, "_build_zip", build)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_zip_download_skips_a_file_that_vanishes_during_the_build(async_client: AsyncClient, monkeypatch):
    rev = await _revision_with_files(async_client, ("a.gcode", b"x"), ("b.gcode", b"y"))
    _vanish_before_zip(monkeypatch, {"a.gcode"})
    response = await async_client.get(f"/api/v1/projects/revisions/{rev['id']}/download")
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as zf:
        assert zf.namelist() == ["b.gcode"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_zip_download_is_404_when_every_file_vanishes_during_the_build(
    async_client: AsyncClient, tmp_path, monkeypatch
):
    rev = await _revision_with_files(async_client, ("a.gcode", b"x"))
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    real_mkstemp = project_files_routes.tempfile.mkstemp
    monkeypatch.setattr(
        project_files_routes.tempfile, "mkstemp", lambda suffix="": real_mkstemp(suffix=suffix, dir=scratch)
    )
    _vanish_before_zip(monkeypatch, {"a.gcode"})
    response = await async_client.get(f"/api/v1/projects/revisions/{rev['id']}/download")
    assert response.status_code == 404 and response.json()["detail"] == "No file available on disk"
    assert list(scratch.iterdir()) == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_download_wrong_file_id_404(async_client: AsyncClient):
    rev = await _revision_with_files(async_client, ("a.gcode", b"x"))
    response = await async_client.get(f"/api/v1/projects/revisions/{rev['id']}/download", params={"file_id": 999999})
    assert response.status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
async def test_zip_download_404_when_all_files_missing(async_client: AsyncClient, root):
    rev = await _revision_with_files(async_client, ("a.gcode", b"x"))
    for path in root.rglob("a.gcode"):
        path.unlink()
    response = await async_client.get(f"/api/v1/projects/revisions/{rev['id']}/download")
    assert response.status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
async def test_project_with_items_cannot_be_deleted(async_client: AsyncClient, root):
    project = await _project(async_client)
    item = await _item(async_client, project["id"])
    rev = (await _upload(async_client, item["id"], ("a.gcode", b"geo"))).json()["revision"]
    refused = await async_client.delete(f"/api/v1/projects/{project['id']}")
    assert refused.status_code == 409
    assert refused.json()["detail"] == "This project has files; delete or move its items first"
    assert (await async_client.get(f"/api/v1/projects/{project['id']}")).status_code == 200
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    assert tree["sections"][2]["items"][0]["revisions"][0]["files"][0]["id"] == rev["files"][0]["id"]
    one = await async_client.get(
        f"/api/v1/projects/revisions/{rev['id']}/download", params={"file_id": rev["files"][0]["id"]}
    )
    assert one.content == b"geo"

    # An empty item still counts; once it is gone the project deletes.
    empty = await _project(async_client)
    empty_item = await _item(async_client, empty["id"], name="Vide")
    assert (await async_client.delete(f"/api/v1/projects/{empty['id']}")).status_code == 409
    assert (await async_client.delete(f"/api/v1/projects/items/{empty_item['id']}")).status_code == 204
    assert (await async_client.delete(f"/api/v1/projects/{empty['id']}")).status_code == 200
    assert (await async_client.get(f"/api/v1/projects/{empty['id']}")).status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
async def test_tree_exposes_the_item_name_key(async_client: AsyncClient, root):
    project = await _project(async_client)
    created = await _item(async_client, project["id"], name="Sup:port. ")
    assert created["name_key"] == "support"
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    assert tree["sections"][2]["items"][0]["name_key"] == "support"


def _zip_bytes(*names):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        for name in names:
            zf.writestr(zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0)), b"payload " + name.encode())
    return buffer.getvalue()


@pytest.fixture
def zip_scratch(tmp_path, monkeypatch):
    """Route the download's temp archive into a dedicated dir the test can inspect."""
    scratch = tmp_path / "zip-scratch"
    scratch.mkdir()
    real_mkstemp = project_files_routes.tempfile.mkstemp
    monkeypatch.setattr(
        project_files_routes.tempfile, "mkstemp", lambda suffix="": real_mkstemp(suffix=suffix, dir=scratch)
    )
    return scratch


@pytest.mark.asyncio
@pytest.mark.integration
async def test_zip_download_removes_temp_archive_after_success(async_client: AsyncClient, zip_scratch):
    rev = await _revision_with_files(async_client, ("a.3mf", _zip_bytes("3D/a.model")), ("b.gcode", b"g1"))
    response = await async_client.get(f"/api/v1/projects/revisions/{rev['id']}/download")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert response.headers["content-length"] == str(len(response.content))
    assert "attachment" in response.headers["content-disposition"]
    assert sorted(zipfile.ZipFile(io.BytesIO(response.content)).namelist()) == ["a.3mf", "b.gcode"]
    assert list(zip_scratch.iterdir()) == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_zip_temp_archive_removed_when_send_fails_mid_body(async_client: AsyncClient, zip_scratch, monkeypatch):
    rev = await _revision_with_files(async_client, ("a.gcode", b"x" * 4096))
    real_handle_simple = project_files_routes.FileResponse._handle_simple
    seen = []

    async def cut_short(self, send, send_header_only, send_pathsend):
        async def flaky_send(message):
            seen.append(message["type"])
            if message["type"] == "http.response.body":
                raise OSError("client disconnected")
            await send(message)

        await real_handle_simple(self, flaky_send, send_header_only, send_pathsend)

    monkeypatch.setattr(project_files_routes.FileResponse, "_handle_simple", cut_short)
    try:
        await async_client.get(f"/api/v1/projects/revisions/{rev['id']}/download")
    except OSError:
        pass  # the test transport re-raises the app's send failure
    assert seen[:2] == ["http.response.start", "http.response.body"]
    assert list(zip_scratch.iterdir()) == []


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize(
    ("range_header", "status"),
    [("bytes=999999999-", 416), ("items=0-1", 400)],
)
async def test_zip_temp_archive_removed_on_rejected_range(async_client: AsyncClient, zip_scratch, range_header, status):
    rev = await _revision_with_files(async_client, ("a.gcode", b"x"))
    response = await async_client.get(
        f"/api/v1/projects/revisions/{rev['id']}/download", headers={"Range": range_header}
    )
    assert response.status_code == status
    assert list(zip_scratch.iterdir()) == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_fork_with_revision_of_another_item_is_400(async_client: AsyncClient):
    project = await _project(async_client)
    item_a = await _item(async_client, project["id"], name="Support")
    item_b = await _item(async_client, project["id"], name="Autre")
    rev_b = (await _upload(async_client, item_b["id"], ("a.gcode", b"x"))).json()["revision"]
    response = await async_client.post(
        f"/api/v1/projects/items/{item_a['id']}/fork", json={"revision_id": rev_b["id"], "name": "Variante"}
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "Revision does not belong to this item"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_revision_status_cannot_be_null(async_client: AsyncClient):
    rev = await _revision_with_files(async_client, ("a.gcode", b"x"))
    response = await async_client.patch(f"/api/v1/projects/revisions/{rev['id']}", json={"status": None})
    assert response.status_code == 400
    assert response.json()["detail"] == "status cannot be null"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_reslice_source_missing_on_disk_is_404(async_client: AsyncClient, db_session, root):
    project = await _project(async_client)
    item = await _item(async_client, project["id"])
    rev = (await _upload(async_client, item["id"], ("support.3mf", b"not-a-real-3mf"))).json()["revision"]
    pipeline = SlicerPipeline(
        name="H2D PETG",
        printer_preset_source="local",
        printer_preset_id="1",
        process_preset_source="local",
        process_preset_id="2",
        filament_presets_json=json.dumps([{"source": "local", "id": "3"}]),
    )
    db_session.add(pipeline)
    await db_session.commit()
    source = (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == rev["id"]))).scalar_one()
    path = to_absolute_path(source.file_path)
    assert path is not None and path.exists()
    path.unlink()
    response = await async_client.post(
        f"/api/v1/projects/revisions/{rev['id']}/reslice",
        json={"file_id": source.id, "pipeline_id": pipeline.id},
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "Source file missing on disk"


# --- T-207: a revision file swapped for a symlink reads as missing ---------------------------


@pytest.fixture
def outside_secret(tmp_path_factory):
    """A file outside the projects tree, standing in for ``.jwt_secret`` or the database."""
    secret = tmp_path_factory.mktemp("data_dir") / ".jwt_secret"
    secret.write_bytes(b"top-secret")
    return secret


def _swap_for_symlink(root, filename, target):
    [path] = list(root.rglob(filename))
    path.unlink()
    path.symlink_to(target)
    return path


@pytest.mark.asyncio
@pytest.mark.integration
async def test_download_refuses_a_file_swapped_for_a_symlink_outside_the_tree(
    async_client: AsyncClient, root, outside_secret
):
    rev = await _revision_with_files(async_client, ("a.gcode", b"geo-a"), ("b.gcode", b"geo-b"))
    ids = {f["filename"]: f["id"] for f in rev["files"]}
    _swap_for_symlink(root, "a.gcode", outside_secret)
    url = f"/api/v1/projects/revisions/{rev['id']}/download"

    one = await async_client.get(url, params={"file_id": ids["a.gcode"]})
    assert one.status_code == 404
    assert one.json()["detail"] == "File not found"
    other = await async_client.get(url, params={"file_id": ids["b.gcode"]})
    assert other.status_code == 200 and other.content == b"geo-b"

    zipped = await async_client.get(url)
    assert zipped.status_code == 200
    archive = zipfile.ZipFile(io.BytesIO(zipped.content))
    assert archive.namelist() == ["b.gcode"]
    assert archive.read("b.gcode") == b"geo-b"
    assert b"top-secret" not in zipped.content


@pytest.mark.asyncio
@pytest.mark.integration
async def test_zip_download_404_when_the_only_file_is_a_symlink(async_client: AsyncClient, root, outside_secret):
    rev = await _revision_with_files(async_client, ("a.gcode", b"geo"))
    _swap_for_symlink(root, "a.gcode", outside_secret)
    response = await async_client.get(f"/api/v1/projects/revisions/{rev['id']}/download")
    assert response.status_code == 404
    assert response.json()["detail"] == "No file available on disk"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_download_refuses_a_symlink_that_stays_inside_the_tree(async_client: AsyncClient, root):
    rev = await _revision_with_files(async_client, ("a.gcode", b"geo-a"), ("b.gcode", b"geo-b"))
    ids = {f["filename"]: f["id"] for f in rev["files"]}
    [sibling] = list(root.rglob("b.gcode"))
    _swap_for_symlink(root, "a.gcode", sibling)
    response = await async_client.get(
        f"/api/v1/projects/revisions/{rev['id']}/download", params={"file_id": ids["a.gcode"]}
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "File not found"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_download_refuses_a_revision_folder_swapped_for_a_symlink(
    async_client: AsyncClient, root, tmp_path_factory
):
    rev = await _revision_with_files(async_client, ("a.gcode", b"geo"))
    [path] = list(root.rglob("a.gcode"))
    elsewhere = tmp_path_factory.mktemp("elsewhere")
    (elsewhere / "a.gcode").write_bytes(b"not-the-project-file")
    folder = path.parent
    path.unlink()
    folder.rmdir()
    folder.symlink_to(elsewhere, target_is_directory=True)
    url = f"/api/v1/projects/revisions/{rev['id']}/download"
    one = await async_client.get(url, params={"file_id": rev["files"][0]["id"]})
    assert one.status_code == 404 and one.json()["detail"] == "File not found"
    zipped = await async_client.get(url)
    assert zipped.status_code == 404 and zipped.json()["detail"] == "No file available on disk"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_download_works_when_the_projects_root_itself_is_a_symlink(
    async_client: AsyncClient, monkeypatch, tmp_path_factory
):
    real = tmp_path_factory.mktemp("nas_share")
    link = tmp_path_factory.mktemp("data") / "projects"
    link.symlink_to(real, target_is_directory=True)
    monkeypatch.setattr(project_storage, "projects_root", lambda: link)
    rev = await _revision_with_files(async_client, ("a.gcode", b"geo"))
    assert list(real.rglob("a.gcode"))
    url = f"/api/v1/projects/revisions/{rev['id']}/download"
    one = await async_client.get(url, params={"file_id": rev["files"][0]["id"]})
    assert one.status_code == 200 and one.content == b"geo"
    zipped = await async_client.get(url)
    assert zipfile.ZipFile(io.BytesIO(zipped.content)).namelist() == ["a.gcode"]


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("patch", "/api/v1/projects/items/1", {"name": "x"}),
        ("delete", "/api/v1/projects/items/1", None),
        ("post", "/api/v1/projects/items/1/fork", {"revision_id": 1, "name": "x"}),
        ("delete", "/api/v1/projects/revisions/1/files/2", None),
        ("patch", "/api/v1/projects/revisions/1", {"note": "x"}),
        ("delete", "/api/v1/projects/revisions/1", None),
        ("get", "/api/v1/projects/revisions/1/download", None),
    ],
)
async def test_project_files_error_becomes_its_http_error(async_client: AsyncClient, monkeypatch, method, path, body):
    """T-230: a ProjectFilesError raised by the service surfaces with its own status and detail."""

    async def teapot(*_args, **_kwargs):
        raise project_files_routes.svc.ProjectFilesError(418, "teapot")

    monkeypatch.setattr(project_files_routes.svc, "get_item_for_project", teapot)
    monkeypatch.setattr(project_files_routes.svc, "get_revision_bundle", teapot)
    kwargs = {} if body is None else {"json": body}
    response = await async_client.request(method.upper(), path, **kwargs)
    assert (response.status_code, response.json()) == (418, {"detail": "teapot"})


@pytest.mark.asyncio
@pytest.mark.integration
async def test_project_files_error_is_the_http_error_cause(db_session, monkeypatch):
    """T-230: the HTTPException is raised ``from`` the service error (``__cause__``, context suppressed)."""
    from fastapi import HTTPException

    from backend.app.schemas.project_files import ProjectItemRename

    error = project_files_routes.svc.ProjectFilesError(418, "teapot")

    async def teapot(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(project_files_routes.svc, "get_item_for_project", teapot)
    with pytest.raises(HTTPException) as raised:
        await project_files_routes.rename_item(item_id=1, body=ProjectItemRename(name="x"), db=db_session, _=None)
    assert (raised.value.status_code, raised.value.detail) == (418, "teapot")
    assert raised.value.__cause__ is error
    assert raised.value.__suppress_context__ is True


async def _upload_urls(client) -> list[str]:
    """Both project upload routes guarded by the capped route class."""
    project = await _project(client)
    item = await _item(client, project["id"])
    response = await _upload(client, item["id"], ("seed.gcode", b"x"))
    assert response.status_code == 201, response.text
    rev = response.json()["revision"]
    return [f"/api/v1/projects/items/{item['id']}/revisions", f"/api/v1/projects/revisions/{rev['id']}/files"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_chunked_upload_over_cap_refused_before_spooling(async_client: AsyncClient, monkeypatch):
    """T-289: no Content-Length — the body is counted as it arrives and refused past the cap."""
    monkeypatch.setattr(settings, "library_max_upload_bytes", 1024)
    limit = 1024 + project_files_routes._UPLOAD_OVERHEAD_BYTES
    for url in await _upload_urls(async_client):
        # several files, each under the cap, over it in total
        body = ChunkedMultipart([(f"part{i}.gcode", b"x" * 1000) for i in range(40)])
        response = await body.post(async_client, url)
        assert response.status_code == 413, url
        assert response.json()["detail"] == "Upload exceeds the maximum size of 1024 bytes"
        assert body.sent <= limit + body.chunk_size < len(body.body)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_chunked_upload_at_limit_passes_one_byte_over_refused(async_client: AsyncClient, monkeypatch):
    monkeypatch.setattr(settings, "library_max_upload_bytes", 1024)
    limit = 1024 + project_files_routes._UPLOAD_OVERHEAD_BYTES
    item_url, files_url = await _upload_urls(async_client)
    # files each under the per-file cap, the whole body at / one past cap + overhead
    under_cap = [(f"part{i}.gcode", bytes([65 + i]) * 900) for i in range(8)]
    over = await ChunkedMultipart.of_size(limit + 1, under_cap).post(async_client, files_url)
    assert over.status_code == 413
    assert over.json()["detail"] == "Upload exceeds the maximum size of 1024 bytes"
    at_limit = await ChunkedMultipart.of_size(limit, under_cap).post(async_client, files_url)
    assert at_limit.status_code == 200, at_limit.text
    assert at_limit.json() == {"warnings": []}
    small = await ChunkedMultipart([("b.gcode", b"x" * 1000)]).post(async_client, item_url)
    assert small.status_code == 201, small.text
    assert small.json()["revision"]["files"][0]["file_size"] == 1000


@pytest.mark.asyncio
async def test_receive_capped_passes_non_body_messages_and_counts_across_chunks():
    from starlette.requests import Request

    half = (1024 + project_files_routes._UPLOAD_OVERHEAD_BYTES) // 2
    messages = iter(
        [
            {"type": "http.request", "body": b"x" * half, "more_body": True},
            {"type": "http.disconnect"},
            {"type": "http.request", "body": b"x" * half, "more_body": True},
            {"type": "http.request", "body": b"x", "more_body": False},
        ]
    )

    async def upstream():
        return next(messages)

    capped = project_files_routes._receive_capped(Request({"type": "http", "headers": []}, upstream), 1024)
    assert (await capped.receive())["body"] == b"x" * half
    assert await capped.receive() == {"type": "http.disconnect"}
    assert (await capped.receive())["body"] == b"x" * half  # exactly cap + overhead: still allowed
    with pytest.raises(HTTPException) as refused:
        await capped.receive()
    assert refused.value.status_code == 413
    assert refused.value.detail == "Upload exceeds the maximum size of 1024 bytes"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_upload_note_capped_at_the_patch_limit(async_client: AsyncClient, root):
    """T-256: the upload note shares the PATCH limit (5000); one character over is a 422 that stores nothing."""
    assert REVISION_NOTE_MAX_LENGTH == 5000
    project = await _project(async_client)
    kept = await _item(async_client, project["id"], name="Kept")
    stored = await _upload(async_client, kept["id"], ("a.gcode", b"geo"), note="n" * 5000)
    assert stored.status_code == 201, stored.text
    assert stored.json()["revision"]["note"] == "n" * 5000

    refused_item = await _item(async_client, project["id"], name="Refused")
    on_disk = sorted(p for p in root.rglob("*") if p.is_file())
    refused = await _upload(async_client, refused_item["id"], ("b.gcode", b"other"), note="n" * 5001)
    assert refused.status_code == 422, refused.text
    assert refused.json()["detail"][0]["loc"] == ["body", "note"]
    assert sorted(p for p in root.rglob("*") if p.is_file()) == on_disk
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    revisions = {i["name"]: i["revisions"] for i in tree["sections"][2]["items"]}
    assert revisions["Refused"] == [] and len(revisions["Kept"]) == 1


@pytest.mark.asyncio
@pytest.mark.integration
async def test_create_item_racing_a_same_name_create_is_409_not_500(async_client: AsyncClient, monkeypatch):
    """T-324: the second create passes the name check (the first committed right after it) and
    hits the unique constraint at its flush: the same 409 as a pre-checked duplicate."""
    project = await _project(async_client)
    await _item(async_client, project["id"], name="Support")

    async def free(*_args, **_kwargs):
        return None

    monkeypatch.setattr(project_files_routes.svc, "_require_item_name_free", free)
    response = await async_client.post(
        f"/api/v1/projects/{project['id']}/items", json={"section": "impression", "name": "support"}
    )
    assert (response.status_code, response.json()) == (
        409,
        {"detail": "An item with this name already exists in this section"},
    )
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    assert [i["name"] for s in tree["sections"] for i in s["items"]] == ["Support"]
