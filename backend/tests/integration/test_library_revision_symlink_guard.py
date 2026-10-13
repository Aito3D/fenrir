"""T-303: library by-id reads of project revision files go through the symlink guard.

``/library/files/{id}/download``, the slicer ``/dl/`` link and ``/gcode`` load
the row with ``LibraryFile.active()``, which keeps revision files reachable.
A revision file swapped for a symlink in the projects tree now answers 404
"File not found" (as ``/projects/revisions/{id}/download`` does); a normal
revision file is served exactly as before; other library files are untouched.
"""

from functools import partial

import pytest
from httpx import AsyncClient

from backend.app.models.library import LibraryFile
from backend.tests.project_fixtures import api_project, projects_root_fixture

root = projects_root_fixture(autouse=True)
_project = partial(api_project, check=False)


async def _revision_file(client, name="a.gcode", data=b"G1 X1\n") -> dict:
    project = await _project(client)
    item = await client.post(f"/api/v1/projects/{project['id']}/items", json={"section": "impression", "name": "S"})
    assert item.status_code == 201, item.text
    response = await client.post(
        f"/api/v1/projects/items/{item.json()['id']}/revisions",
        files=[("files", (name, data, "application/octet-stream"))],
    )
    assert response.status_code == 201, response.text
    [file] = response.json()["revision"]["files"]
    return file


@pytest.fixture
def outside_secret(tmp_path_factory):
    secret = tmp_path_factory.mktemp("data_dir") / ".jwt_secret"
    secret.write_bytes(b"top-secret")
    return secret


def _swap_for_symlink(root, filename, target):
    [path] = list(root.rglob(filename))
    path.unlink()
    path.symlink_to(target)


async def _slicer_get(client, file_id, filename="a.gcode"):
    token = (await client.post(f"/api/v1/library/files/{file_id}/slicer-token")).json()["token"]
    return await client.get(f"/api/v1/library/files/{file_id}/dl/{token}/{filename}")


def _urls(file_id):
    return {
        "download": f"/api/v1/library/files/{file_id}/download",
        "gcode": f"/api/v1/library/files/{file_id}/gcode",
    }


@pytest.mark.asyncio
@pytest.mark.integration
async def test_a_revision_file_swapped_for_a_symlink_is_404_on_all_three_routes(
    async_client: AsyncClient, root, outside_secret
):
    file = await _revision_file(async_client)
    _swap_for_symlink(root, "a.gcode", outside_secret)
    for url in _urls(file["id"]).values():
        response = await async_client.get(url)
        assert response.status_code == 404, url
        assert response.json() == {"detail": "File not found"}
        assert b"top-secret" not in response.content
    slicer = await _slicer_get(async_client, file["id"])
    assert slicer.status_code == 404
    assert slicer.json() == {"detail": "File not found"}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_a_symlink_to_a_sibling_inside_the_tree_is_refused_too(async_client: AsyncClient, root):
    file = await _revision_file(async_client, "a.gcode", b"G1 A\n")
    await _revision_file(async_client, "b.gcode", b"G1 B\n")
    [sibling] = list(root.rglob("b.gcode"))
    _swap_for_symlink(root, "a.gcode", sibling)
    response = await async_client.get(_urls(file["id"])["download"])
    assert response.status_code == 404 and response.json() == {"detail": "File not found"}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_a_normal_revision_file_is_served_unchanged(async_client: AsyncClient):
    data = b"G1 X1\nG1 X2\n"
    file = await _revision_file(async_client, "a.gcode", data)
    urls = _urls(file["id"])

    download = await async_client.get(urls["download"])
    assert download.status_code == 200 and download.content == data
    assert download.headers["content-disposition"] == 'attachment; filename="a.gcode"'
    assert download.headers["content-type"] == "application/octet-stream"
    assert download.headers["content-length"] == str(len(data))
    assert download.headers["accept-ranges"] == "bytes"
    assert download.headers["etag"]
    partial_range = await async_client.get(urls["download"], headers={"Range": "bytes=0-3"})
    assert partial_range.status_code == 206 and partial_range.content == data[:4]

    slicer = await _slicer_get(async_client, file["id"])
    assert slicer.status_code == 200 and slicer.content == data
    assert slicer.headers["content-disposition"] == 'attachment; filename="a.gcode"'
    assert slicer.headers["content-type"] == "application/octet-stream"

    gcode = await async_client.get(urls["gcode"])
    assert gcode.status_code == 200 and gcode.content == data
    assert gcode.headers["content-type"].startswith("text/plain")
    assert "content-disposition" not in gcode.headers


@pytest.mark.asyncio
@pytest.mark.integration
async def test_a_missing_revision_file_keeps_the_on_disk_detail(async_client: AsyncClient, root):
    file = await _revision_file(async_client)
    [path] = list(root.rglob("a.gcode"))
    path.unlink()
    for url in _urls(file["id"]).values():
        response = await async_client.get(url)
        assert response.status_code == 404 and response.json() == {"detail": "File not found on disk"}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_a_file_manager_file_is_not_guarded(async_client: AsyncClient, db_session, tmp_path, outside_secret):
    link = tmp_path / "library-link.gcode"
    link.symlink_to(outside_secret)
    row = LibraryFile(filename="plain.gcode", file_path=str(link), file_type="gcode", file_size=10)
    db_session.add(row)
    await db_session.commit()
    response = await async_client.get(f"/api/v1/library/files/{row.id}/download")
    assert response.status_code == 200 and response.content == b"top-secret"
