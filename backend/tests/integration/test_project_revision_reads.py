"""T-358: the other by-id library reads of project revision files go through the symlink guard.

Slice, Combine, Add to queue, the plate list, the plate thumbnail and the
filament requirements load the row with ``LibraryFile.active()``, which keeps
revision files reachable. A revision file swapped for a symlink in the projects
tree now answers 404 "File not found" there (as ``/download`` does since T-303);
Add to queue, a batch route, reports it as a file missing on disk. A revision
file with no symlink in its path is read as before.
"""

from __future__ import annotations

import io
import zipfile
from functools import partial

import httpx
import pytest
import trimesh
from httpx import AsyncClient

from backend.app.models.library import LibraryFile
from backend.tests.integration.test_library_slice_api import (  # noqa: F401  # fixture
    _install_mock_sidecar,
    _make_3mf_with_settings,
    _wait_for_job,
    slice_test_setup,
)
from backend.tests.project_fixtures import api_project, projects_root_fixture

root = projects_root_fixture(autouse=True, subdir="projects", library=True)
_project = partial(api_project, check=False)

PNG = b"\x89PNG\r\n\x1a\nplate-one"


def _three_mf() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in (
            ("3D/3dmodel.model", b"<model/>"),
            ("Metadata/plate_1.png", PNG),
            (
                "Metadata/slice_info.config",
                b"<config><plate><metadata key='index' value='1'/>"
                b"<filament id='1' type='PLA' color='#FF0000' used_g='1.5' used_m='0.5'/></plate></config>",
            ),
        ):
            zf.writestr(zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0)), data)
    return buf.getvalue()


async def _revision(client: AsyncClient, name: str, data: bytes) -> dict:
    project = await _project(client)
    item = await client.post(f"/api/v1/projects/{project['id']}/items", json={"section": "impression", "name": "S"})
    assert item.status_code == 201, item.text
    response = await client.post(
        f"/api/v1/projects/items/{item.json()['id']}/revisions",
        files=[("files", (name, data, "application/octet-stream"))],
    )
    assert response.status_code == 201, response.text
    return response.json()["revision"]


async def _revision_file(client: AsyncClient, name: str, data: bytes) -> int:
    [file] = (await _revision(client, name, data))["files"]
    return file["id"]


async def _stl_revision_file(client: AsyncClient, db_session, root) -> int:
    """An STL row on a revision, as a legacy item in a disabled section holds."""
    revision = await _revision(client, "carrier.3mf", _three_mf())
    [sibling] = list(root.rglob("carrier.3mf"))
    stl = sibling.parent / "part.stl"
    stl.write_bytes(trimesh.creation.box((10, 10, 10)).export(file_type="stl"))
    row = LibraryFile(
        filename="part.stl",
        file_path=str(stl.relative_to(root.parent)),
        file_type="stl",
        file_size=stl.stat().st_size,
        revision_id=revision["id"],
    )
    db_session.add(row)
    await db_session.commit()
    return row.id


@pytest.fixture
def outside_secret(tmp_path_factory):
    secret = tmp_path_factory.mktemp("data_dir") / ".jwt_secret"
    secret.write_bytes(b"top-secret")
    return secret


def _swap_for_symlink(root, filename, target):
    [path] = list(root.rglob(filename))
    path.unlink()
    path.symlink_to(target)


def _read_urls(file_id: int) -> list[str]:
    return [
        f"/api/v1/library/files/{file_id}/plates",
        f"/api/v1/library/files/{file_id}/plate-thumbnail/1",
        f"/api/v1/library/files/{file_id}/filament-requirements",
    ]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_plate_and_filament_reads_of_a_symlinked_revision_file_are_404(
    async_client: AsyncClient, root, outside_secret
):
    file_id = await _revision_file(async_client, "a.3mf", _three_mf())
    _swap_for_symlink(root, "a.3mf", outside_secret)
    for url in _read_urls(file_id):
        response = await async_client.get(url)
        assert response.status_code == 404, url
        assert response.json() == {"detail": "File not found"}, url


@pytest.mark.asyncio
@pytest.mark.integration
async def test_plate_and_filament_reads_of_a_plain_revision_file_still_work(async_client: AsyncClient):
    file_id = await _revision_file(async_client, "a.3mf", _three_mf())
    plates, thumbnail, filaments = [await async_client.get(url) for url in _read_urls(file_id)]
    assert plates.status_code == 200 and plates.json()["file_id"] == file_id
    assert [plate["index"] for plate in plates.json()["plates"]] == [1]
    assert thumbnail.status_code == 200 and thumbnail.content == PNG
    assert filaments.status_code == 200
    assert [f["type"] for f in filaments.json()["filaments"]] == ["PLA"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_add_to_queue_reports_a_symlinked_revision_file_as_missing(
    async_client: AsyncClient, root, outside_secret
):
    file_id = await _revision_file(async_client, "a.gcode", b"G1 X1\n")
    _swap_for_symlink(root, "a.gcode", outside_secret)
    response = await async_client.post("/api/v1/library/files/add-to-queue", json={"file_ids": [file_id]})
    assert response.status_code == 400
    assert response.json()["detail"] == {
        "message": "No files could be added to the queue.",
        "errors": [{"file_id": file_id, "filename": "a.gcode", "error": "File not found on disk"}],
    }


@pytest.mark.asyncio
@pytest.mark.integration
async def test_add_to_queue_of_a_plain_revision_file_still_works(async_client: AsyncClient, db_session):
    revision = await _revision(async_client, "a.gcode", b"G1 X1\n")
    [file] = revision["files"]
    response = await async_client.post("/api/v1/library/files/add-to-queue", json={"file_ids": [file["id"]]})
    assert response.status_code == 200, response.text
    [added] = response.json()["added"]
    assert added["file_id"] == file["id"] and response.json()["errors"] == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_combine_refuses_a_symlinked_revision_file(async_client: AsyncClient, db_session, root, outside_secret):
    file_id = await _stl_revision_file(async_client, db_session, root)
    _swap_for_symlink(root, "part.stl", outside_secret)
    response = await async_client.post(
        "/api/v1/library/files/combine", json={"items": [{"file_id": file_id}], "filename": "Plate"}
    )
    assert response.status_code == 404
    assert response.json() == {"detail": "File not found"}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_combine_reads_a_plain_revision_file(async_client: AsyncClient, db_session, root):
    file_id = await _stl_revision_file(async_client, db_session, root)
    response = await async_client.post(
        "/api/v1/library/files/combine", json={"items": [{"file_id": file_id}], "filename": "Plate"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["filename"] == "Plate.3mf"


def _slice_body(setup: dict) -> dict:
    return {
        "printer_preset_id": setup["printer_id"],
        "process_preset_id": setup["process_id"],
        "filament_preset_id": setup["filament_id"],
    }


@pytest.mark.asyncio
@pytest.mark.integration
async def test_slice_refuses_a_symlinked_revision_file(
    async_client: AsyncClient,
    root,
    outside_secret,
    slice_test_setup,  # noqa: F811
):
    file_id = await _revision_file(async_client, "a.3mf", _three_mf())
    _swap_for_symlink(root, "a.3mf", outside_secret)
    _install_mock_sidecar(lambda _request: httpx.Response(500))
    response = await async_client.post(f"/api/v1/library/files/{file_id}/slice", json=_slice_body(slice_test_setup))
    assert response.status_code == 404
    assert response.json() == {"detail": "File not found"}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_slice_reads_a_plain_revision_file(
    async_client: AsyncClient,
    slice_test_setup,  # noqa: F811
):
    file_id = await _revision_file(async_client, "a.3mf", _three_mf())
    sent: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path.endswith("/slice"):
            sent.append(request.content)
        return httpx.Response(200, content=_make_3mf_with_settings())

    _install_mock_sidecar(handler)
    response = await async_client.post(f"/api/v1/library/files/{file_id}/slice", json=_slice_body(slice_test_setup))
    assert response.status_code == 202, response.text
    final = await _wait_for_job(async_client, response.json()["job_id"])
    assert final["status"] == "completed", final
    assert sent and b"plate-one" in sent[0]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_a_symlink_to_a_sibling_inside_the_tree_is_refused_too(async_client: AsyncClient, root):
    """A link that stays under base_dir is refused by the guard itself rather than by ``to_absolute_path``."""
    file_id = await _revision_file(async_client, "a.3mf", _three_mf())
    queued_id = await _revision_file(async_client, "q.gcode", b"G1 Q\n")
    await _revision_file(async_client, "b.3mf", _three_mf())
    [sibling] = list(root.rglob("b.3mf"))
    _swap_for_symlink(root, "a.3mf", sibling)
    _swap_for_symlink(root, "q.gcode", sibling)
    for url in _read_urls(file_id):
        response = await async_client.get(url)
        assert response.status_code == 404 and response.json() == {"detail": "File not found"}, url
    queued = await async_client.post("/api/v1/library/files/add-to-queue", json={"file_ids": [queued_id]})
    assert queued.status_code == 400
    assert queued.json()["detail"]["errors"] == [
        {"file_id": queued_id, "filename": "q.gcode", "error": "File not found on disk"}
    ]
