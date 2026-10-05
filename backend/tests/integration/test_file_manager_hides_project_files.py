"""Project revision files never appear in or are affected by the File Manager (spec §6.1)."""

from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update

from backend.app.api.routes.library import to_absolute_path
from backend.app.models.library import LibraryFile, LibraryFileTag
from backend.app.services import project_storage
from backend.app.services.library_trash import library_trash_service

DISK_KEYS = ("disk_free_bytes", "disk_total_bytes", "disk_used_bytes")


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
    stats_with_project = (await async_client.get("/api/v1/library/stats")).json()
    assert stats_with_project == {**stats_before, **{k: stats_with_project[k] for k in DISK_KEYS}}

    listed = (await async_client.get("/api/v1/library/files")).json()
    assert all(f["id"] != file_id for f in listed)
    by_project = (await async_client.get("/api/v1/library/files", params={"project_id": project["id"]})).json()
    assert all(f["id"] != file_id for f in by_project)
    searched = (await async_client.get("/api/v1/library/files", params={"search": "secret-plan"})).json()
    assert searched == []

    dupes = await async_client.post("/api/v1/library/files/check-duplicates", json={"hashes": [digest]})
    assert dupes.status_code == 200
    assert dupes.json() == {"duplicates": {}}

    file_types = (await async_client.get("/api/v1/library/files/file-types")).json()
    assert "pdf" not in file_types

    assert (await async_client.delete(f"/api/v1/library/files/{file_id}")).status_code == 404
    assert (await async_client.put(f"/api/v1/library/files/{file_id}", json={"notes": "x"})).status_code == 404
    bulk = await async_client.post("/api/v1/library/bulk-delete", json={"file_ids": [file_id], "folder_ids": []})
    assert bulk.json()["deleted_files"] == 0
    folder = (await async_client.post("/api/v1/library/folders", json={"name": "Dest"})).json()
    move = await async_client.post(
        "/api/v1/library/files/move", json={"file_ids": [file_id], "folder_id": folder["id"]}
    )
    assert move.status_code == 200
    assert move.json()["moved"] == 0

    tag = (await async_client.post("/api/v1/library/tags", json={"name": "plan-tag"})).json()
    assign = await async_client.post(
        "/api/v1/library/tags/bulk-assign", json={"file_ids": [file_id], "tag_ids": [tag["id"]], "action": "add"}
    )
    assert assign.status_code == 200
    assert assign.json()["files_updated"] == 0
    assert assign.json()["associations_added"] == 0
    tag_rows = (await db_session.execute(select(LibraryFileTag).where(LibraryFileTag.file_id == file_id))).all()
    assert tag_rows == []

    # A File Manager file with the same bytes is not a duplicate of the project file.
    up1 = await async_client.post(
        "/api/v1/library/files", files={"file": ("legacy.pdf", b"%PDF-1.4 projet", "application/pdf")}
    )
    assert up1.status_code == 200
    assert up1.json()["duplicate_of"] is None
    legacy_id = up1.json()["id"]
    listed = (await async_client.get("/api/v1/library/files")).json()
    legacy = next(f for f in listed if f["id"] == legacy_id)
    assert legacy["duplicate_count"] == 0
    assert all(f["id"] != file_id for f in listed)
    # ...while the check still works between File Manager files.
    up2 = await async_client.post(
        "/api/v1/library/files", files={"file": ("legacy2.pdf", b"%PDF-1.4 projet", "application/pdf")}
    )
    assert up2.json()["duplicate_of"] == legacy_id

    db_session.expire_all()
    row = (await db_session.execute(select(LibraryFile).where(LibraryFile.id == file_id))).scalar_one()
    assert row.deleted_at is None and row.revision_id is not None and row.folder_id is None

    stats_after = (await async_client.get("/api/v1/library/stats")).json()
    assert stats_after["total_files"] == stats_before["total_files"] + 2  # only the two legacy uploads

    # By-id preview routes still work for the project page.
    assert (await async_client.get(f"/api/v1/library/files/{file_id}/download")).status_code == 200


@pytest.mark.asyncio
@pytest.mark.integration
async def test_trash_purge_and_sweep_never_touch_project_files(async_client: AsyncClient, db_session):
    _project_data, file_id, _digest = await _project_file(async_client)
    legacy = await async_client.post(
        "/api/v1/library/files", files={"file": ("old-legacy.pdf", b"%PDF-1.4 legacy", "application/pdf")}
    )
    legacy_id = legacy.json()["id"]
    long_ago = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=400)
    await db_session.execute(
        update(LibraryFile)
        .where(LibraryFile.id.in_([file_id, legacy_id]))
        .values(created_at=long_ago, last_printed_at=long_ago)
    )
    await db_session.commit()
    project_row = (await db_session.execute(select(LibraryFile).where(LibraryFile.id == file_id))).scalar_one()
    project_path = to_absolute_path(project_row.file_path)
    assert project_path is not None and project_path.exists()

    preview = await library_trash_service.preview_purge(db_session, older_than_days=30, include_never_printed=True)
    assert preview["count"] == 1  # only the File Manager file
    assert "secret-plan.pdf" not in preview["sample_filenames"]
    assert await library_trash_service.purge_older_than(db_session, older_than_days=30) == 1

    db_session.expire_all()
    project_row = (await db_session.execute(select(LibraryFile).where(LibraryFile.id == file_id))).scalar_one()
    assert project_row.deleted_at is None

    # A project row stamped by the old purge must still survive the sweeper and the trash deletes.
    await db_session.execute(update(LibraryFile).where(LibraryFile.id == file_id).values(deleted_at=long_ago))
    await db_session.execute(update(LibraryFile).where(LibraryFile.id == legacy_id).values(deleted_at=long_ago))
    await db_session.commit()
    assert await library_trash_service._sweep(db_session) == 1  # the legacy file only
    db_session.expire_all()
    project_row = (await db_session.execute(select(LibraryFile).where(LibraryFile.id == file_id))).scalar_one()
    assert await library_trash_service.hard_delete_many(db_session, [project_row]) == 0
    db_session.expire_all()
    assert (await db_session.execute(select(LibraryFile.id).where(LibraryFile.id == file_id))).scalar_one() == file_id
    assert (await db_session.execute(select(LibraryFile.id).where(LibraryFile.id == legacy_id))).first() is None
    assert project_path.exists()
