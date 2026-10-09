"""Project files API (spec §8)."""

import io
import zipfile

import pytest
from httpx import AsyncClient

from backend.app.api.routes import project_files as project_files_routes
from backend.app.core.config import settings
from backend.app.services import project_storage


@pytest.fixture(autouse=True)
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(project_storage, "projects_root", lambda: tmp_path)
    return tmp_path


async def _project(client):
    return (await client.post("/api/v1/projects/", json={"name": "Support caméra"})).json()


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
