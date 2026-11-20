"""Route tests for /local-backup list/download/restore/delete/run, all under tmp_path."""

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient

from backend.app.services.local_backup import local_backup_service

BASE = "/api/v1/local-backup"
NAME = "bambuddy-backup-20260101-000000.zip"


@pytest.fixture
def backup_dir(tmp_path, monkeypatch):
    settings = {"enabled": False, "schedule": "daily", "time": "03:00", "retention": 5, "path": str(tmp_path)}
    monkeypatch.setattr(local_backup_service, "_load_settings", AsyncMock(return_value=settings))
    (tmp_path / NAME).write_bytes(b"PKfake")
    return tmp_path


@pytest.mark.asyncio
async def test_list_returns_existing_backup(async_client: AsyncClient, backup_dir):
    resp = await async_client.get(f"{BASE}/backups")
    assert resp.status_code == 200
    assert [b["filename"] for b in resp.json()] == [NAME]
    assert resp.json()[0]["size"] == 6


@pytest.mark.asyncio
async def test_download_real_file(async_client: AsyncClient, backup_dir):
    resp = await async_client.get(f"{BASE}/backups/{NAME}/download")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/zip"
    assert resp.content == b"PKfake"


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["bambuddy-backup-missing.zip", "..%2Fsecret.zip", "notabackup.zip"])
async def test_download_unknown_or_traversal_is_404(async_client: AsyncClient, backup_dir, name):
    resp = await async_client.get(f"{BASE}/backups/{name}/download")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_restore_unknown_is_404(async_client: AsyncClient, backup_dir):
    resp = await async_client.post(f"{BASE}/backups/bambuddy-backup-missing.zip/restore")
    assert resp.status_code == 404
    assert resp.json()["message"] == "Backup not found"


@pytest.mark.asyncio
async def test_restore_hands_file_to_settings_restore(async_client: AsyncClient, backup_dir):
    seen = {}

    async def fake_restore(file, db):
        seen["name"] = file.filename
        seen["content"] = await file.read()
        return {"success": True}

    @asynccontextmanager
    async def fake_session():
        yield object()

    with (
        patch("backend.app.api.routes.settings.restore_backup", fake_restore),
        patch("backend.app.core.database.async_session", fake_session),
    ):
        resp = await async_client.post(f"{BASE}/backups/{NAME}/restore")
    assert resp.status_code == 200
    assert resp.json() == {"success": True}
    assert seen == {"name": NAME, "content": b"PKfake"}


@pytest.mark.asyncio
async def test_delete_removes_file(async_client: AsyncClient, backup_dir):
    resp = await async_client.delete(f"{BASE}/backups/{NAME}")
    assert resp.status_code == 200
    assert resp.json() == {"success": True, "message": "Backup deleted"}
    assert not (backup_dir / NAME).exists()


@pytest.mark.asyncio
async def test_delete_unknown_reports_not_found(async_client: AsyncClient, backup_dir):
    resp = await async_client.delete(f"{BASE}/backups/bambuddy-backup-missing.zip")
    assert resp.json() == {"success": False, "message": "Backup not found"}


@pytest.mark.asyncio
async def test_run_returns_service_result(async_client: AsyncClient, backup_dir):
    with patch.object(local_backup_service, "run_backup", AsyncMock(return_value={"success": True, "filename": NAME})):
        resp = await async_client.post(f"{BASE}/run")
    assert resp.json() == {"success": True, "filename": NAME}
