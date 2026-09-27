"""Where upstream's library features meet the fork's library rules.

The 2026-09-27 upstream merge brought photos on library files (#3077) and PDF
thumbnails (#2976) into code the fork had already reshaped: trash deletes run
as one batched commit that never touches disk before the commit lands (#T-148,
#T-149), the batch thumbnail route pages with a real ``remaining`` count
(T-158) and serialises STL renders, and the external-folder scan skips its
removal pass after a partial walk. Upstream's own tests cover each feature on
its happy path; these pin the combinations the merge had to resolve by hand.
"""

import os
from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.core.config import settings as app_settings
from backend.app.models.library import LibraryFile
from backend.app.utils.library_paths import library_photos_dir


@pytest.fixture
def isolated_storage(monkeypatch, tmp_path):
    """Library data (and therefore photo dirs) under a throwaway directory."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setattr(app_settings, "base_dir", data_dir)
    monkeypatch.setattr(app_settings, "archive_dir", data_dir / "archive")
    return data_dir


@pytest.fixture
async def file_factory(db_session):
    _counter = [0]

    async def _create_file(**kwargs):
        _counter[0] += 1
        defaults = {
            "filename": f"merge_{_counter[0]}.3mf",
            "file_path": f"library/files/merge_{_counter[0]}.3mf",
            "file_type": "3mf",
            "file_size": 100,
        }
        defaults.update(kwargs)
        row = LibraryFile(**defaults)
        db_session.add(row)
        await db_session.commit()
        await db_session.refresh(row)
        return row

    return _create_file


def _give_photos(file_id: int):
    photos_dir = library_photos_dir(file_id)
    photos_dir.mkdir(parents=True)
    (photos_dir / "result.jpg").write_bytes(b"jpeg")
    return photos_dir


class TestTrashDeletesPhotos:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_failed_commit_keeps_photos(self, file_factory, db_session, isolated_storage, monkeypatch):
        """#T-148 extends to photos: nothing on disk goes before the commit lands."""
        from backend.app.services.library_trash import library_trash_service

        row = await file_factory(deleted_at=datetime.now(timezone.utc))
        photos_dir = _give_photos(row.id)

        async def _boom():
            raise RuntimeError("database is locked")

        monkeypatch.setattr(db_session, "commit", _boom)
        with pytest.raises(RuntimeError):
            await library_trash_service.hard_delete_now(db_session, row)

        assert (photos_dir / "result.jpg").exists()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_empty_trash_removes_every_rows_photos(
        self, async_client: AsyncClient, file_factory, isolated_storage
    ):
        """The batched delete removes the photo dir of each row, not only the first or last."""
        rows = [await file_factory() for _ in range(3)]
        photo_dirs = [_give_photos(row.id) for row in rows]
        for row in rows:
            assert (await async_client.delete(f"/api/v1/library/files/{row.id}")).json()["trashed"] is True
        assert all(d.is_dir() for d in photo_dirs), "trashing alone must not touch photos"

        response = await async_client.delete("/api/v1/library/trash")

        assert response.status_code == 200
        assert response.json()["deleted"] >= 3
        assert not any(d.exists() for d in photo_dirs)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_sweeper_removes_photos_of_expired_rows_only(self, file_factory, db_session, isolated_storage):
        from backend.app.services.library_trash import library_trash_service

        await library_trash_service.set_retention_days(db_session, 30)
        expired = await file_factory(deleted_at=datetime.now(timezone.utc) - timedelta(days=40))
        recent = await file_factory(deleted_at=datetime.now(timezone.utc) - timedelta(days=2))
        expired_photos = _give_photos(expired.id)
        recent_photos = _give_photos(recent.id)

        assert await library_trash_service._sweep(db_session) == 1

        assert not expired_photos.exists()
        assert (recent_photos / "result.jpg").exists()


class TestBatchThumbnailsWithPdf:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_pdf_rows_count_toward_the_limit_and_remaining(
        self, async_client: AsyncClient, file_factory, db_session, isolated_storage, monkeypatch
    ):
        """PDF rows page like STL rows, and only the STL render takes the render lock."""
        from backend.app.api.routes import library as library_routes

        files_dir = isolated_storage / "archive" / "library" / "files"
        files_dir.mkdir(parents=True)
        (files_dir / "bracket.stl").write_text("solid t\nendsolid t")
        (files_dir / "manual.pdf").write_bytes(b"%PDF-1.4")
        stl = await file_factory(filename="bracket.stl", file_path=str(files_dir / "bracket.stl"), file_type="stl")
        pdf = await file_factory(filename="manual.pdf", file_path=str(files_dir / "manual.pdf"), file_type="pdf")

        lock_held = {}

        def fake_render(kind):
            def render(file_path, thumbnails_dir):
                lock_held[kind] = library_routes._stl_render_lock.locked()
                thumbnails_dir.mkdir(parents=True, exist_ok=True)
                out = thumbnails_dir / f"{kind}.png"
                out.write_bytes(b"png")
                return str(out)

            return render

        monkeypatch.setattr(library_routes, "STL_THUMBNAIL_BATCH_LIMIT", 1)
        monkeypatch.setattr(library_routes, "generate_stl_thumbnail", fake_render("stl"))
        monkeypatch.setattr(library_routes, "generate_pdf_thumbnail", fake_render("pdf"))

        first = (await async_client.post("/api/v1/library/generate-stl-thumbnails", json={"all_missing": True})).json()
        assert (first["processed"], first["succeeded"], first["remaining"]) == (1, 1, 1)

        second = (await async_client.post("/api/v1/library/generate-stl-thumbnails", json={"all_missing": True})).json()
        assert (second["processed"], second["succeeded"], second["remaining"]) == (1, 1, 0)

        assert lock_held == {"stl": True, "pdf": False}
        await db_session.refresh(stl)
        await db_session.refresh(pdf)
        assert stl.thumbnail_path and pdf.thumbnail_path


class TestPartialScanKeepsPhotos:
    @pytest.fixture
    def external_share(self, monkeypatch, isolated_storage, tmp_path):
        from backend.app.api.routes import library as library_routes

        share = tmp_path / "share"
        share.mkdir()
        monkeypatch.setenv("BAMBUDDY_EXTERNAL_ROOTS", str(share))
        # The scan's STL thumbnail backfill runs detached and would outlive the
        # test database; it has nothing to do with the removal pass under test.
        monkeypatch.setattr(library_routes, "spawn_background_task", lambda coro, **_: coro.close())
        return share

    @pytest.mark.asyncio
    @pytest.mark.integration
    @pytest.mark.skipif(os.geteuid() == 0, reason="root reads through chmod 000")
    async def test_unreadable_subfolder_keeps_row_and_photos(
        self, async_client: AsyncClient, db_session, external_share
    ):
        """A subfolder the scan cannot read makes its files look vanished; the
        partial-walk guard must keep both the rows and their photos (#3077 put
        photo removal inside that guarded pass)."""
        sub = external_share / "sub"
        sub.mkdir()
        (sub / "bracket.stl").write_bytes(b"fakestl")

        folder = await async_client.post(
            "/api/v1/library/folders/external",
            json={"name": "Share", "external_path": str(external_share), "readonly": True, "show_hidden": False},
        )
        assert folder.status_code == 200
        folder_id = folder.json()["id"]
        assert (await async_client.post(f"/api/v1/library/folders/{folder_id}/scan")).json()["added"] == 1

        row = (await db_session.execute(select(LibraryFile).where(LibraryFile.filename == "bracket.stl"))).scalar_one()
        row_id, row_path = row.id, row.file_path
        photos_dir = _give_photos(row_id)

        sub.chmod(0)
        try:
            assert not os.path.exists(row_path), "precondition: the file must look vanished"
            rescan = (await async_client.post(f"/api/v1/library/folders/{folder_id}/scan")).json()
        finally:
            sub.chmod(0o755)

        assert rescan["status"] == "partial"
        assert rescan["removed"] == 0
        db_session.expire_all()
        assert await db_session.get(LibraryFile, row_id) is not None
        assert (photos_dir / "result.jpg").exists()
