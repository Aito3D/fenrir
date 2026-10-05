"""Project revision files never appear in or are affected by the File Manager (spec §6.1)."""

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.models.library import LibraryFile
from backend.app.services import project_storage


@pytest.fixture(autouse=True)
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(project_storage, "projects_root", lambda: tmp_path)


async def _project_file(client) -> tuple[dict, int, str]:
    project = (await client.post("/api/v1/projects/", json={"name": "Caché"})).json()
    item = (
        await client.post(f"/api/v1/projects/{project['id']}/items", json={"section": "docs", "name": "Plan"})
    ).json()
    rev = (
        await client.post(
            f"/api/v1/projects/items/{item['id']}/revisions",
            files=[("files", ("secret-plan.pdf", b"%PDF-1.4 projet", "application/pdf"))],
        )
    ).json()["revision"]
    return project, rev["files"][0]["id"], rev["files"][0]["file_hash"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_file_manager_never_sees_project_files(async_client: AsyncClient, db_session):
    stats_before = (await async_client.get("/api/v1/library/stats")).json()

    project, file_id, digest = await _project_file(async_client)

    listed = (await async_client.get("/api/v1/library/files")).json()
    assert all(f["id"] != file_id for f in listed)
    by_project = (await async_client.get("/api/v1/library/files", params={"project_id": project["id"]})).json()
    assert all(f["id"] != file_id for f in by_project)
    searched = (await async_client.get("/api/v1/library/files", params={"search": "secret-plan"})).json()
    assert searched == []

    dupes = await async_client.post("/api/v1/library/files/check-duplicates", json={"hashes": [digest]})
    assert dupes.status_code == 200
    assert dupes.json() == {"duplicates": {}}

    assert (await async_client.delete(f"/api/v1/library/files/{file_id}")).status_code == 404
    assert (await async_client.put(f"/api/v1/library/files/{file_id}", json={"notes": "x"})).status_code == 404
    bulk = await async_client.post("/api/v1/library/bulk-delete", json={"file_ids": [file_id], "folder_ids": []})
    assert bulk.json()["deleted_files"] == 0
    await async_client.post("/api/v1/library/files/move", json={"file_ids": [file_id], "folder_id": None})

    db_session.expire_all()
    row = (await db_session.execute(select(LibraryFile).where(LibraryFile.id == file_id))).scalar_one()
    assert row.deleted_at is None and row.revision_id is not None and row.folder_id is None

    stats_after = (await async_client.get("/api/v1/library/stats")).json()
    assert stats_after["total_files"] == stats_before["total_files"]
    assert stats_after["total_size_bytes"] == stats_before["total_size_bytes"]
    assert stats_after["files_by_type"] == stats_before["files_by_type"]
    file_types = (await async_client.get("/api/v1/library/files/file-types")).json()
    assert "pdf" not in file_types

    # By-id preview routes still work for the project page.
    assert (await async_client.get(f"/api/v1/library/files/{file_id}/download")).status_code == 200
