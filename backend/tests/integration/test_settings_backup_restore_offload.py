"""Regression tests for T-018 and T-019 (backend/app/api/routes/settings.py).

T-018: ``create_backup_zip`` ran ``shutil.copytree`` over the archive/
timelapse/photo tree and the ``zipfile.ZipFile`` compression pass
synchronously on the event loop, with no ``await`` — for a large archive
this froze the whole FastAPI process (no request served, no MQTT/WebSocket
keepalive) for as long as the copy/compress took. ``restore_backup`` had
the same problem for ``zf.extractall``, the SQLite online-backup call, and
the per-directory restore copy. The fix moves each of these onto a worker
thread via ``asyncio.to_thread``, matching the pattern already used in
``services/printer_media.py``.

T-019: ``restore_backup`` read the entire uploaded backup ZIP into memory
(``content = await file.read()``) before opening it via
``zipfile.ZipFile(io.BytesIO(content), ...)``. A backup ZIP is a full
snapshot of the archive/timelapse tree and is routinely multi-GB, so this
held the compressed bytes, a BytesIO view of them, and the decompressed
tree on disk all at once. The fix streams the upload to a temp file with
``shutil.copyfileobj`` and opens the ``ZipFile`` from that path instead.

These tests assert the actual new properties (work happens off the event
loop's thread / the upload is never materialised as one in-memory object),
not just that the endpoints still return the expected status codes.
"""

from __future__ import annotations

import io
import shutil
import threading
import zipfile

import pytest
from starlette.datastructures import UploadFile as StarletteUploadFile


class TestCreateBackupZipOffloadsBlockingWork:
    """T-018: the copytree + zip-compression body must not run inline on
    the event loop's own thread."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_copytree_and_zip_write_run_in_a_worker_thread(self, async_client, monkeypatch, tmp_path):
        from backend.app.api.routes.settings import create_backup_zip
        from backend.app.core.config import settings as app_settings

        monkeypatch.setenv("DATA_DIR", str(tmp_path))
        monkeypatch.setattr(app_settings, "base_dir", tmp_path)

        # Give create_backup_zip a non-empty directory to copytree, so the
        # blocking body under test actually executes.
        archive_dir = tmp_path / "archive"
        archive_dir.mkdir()
        (archive_dir / "print.3mf").write_text("fake-3mf-bytes")

        caller_thread_id = threading.get_ident()
        copytree_thread_ids: list[int] = []
        zip_write_thread_ids: list[int] = []

        real_copytree = shutil.copytree

        def spy_copytree(*args, **kwargs):
            copytree_thread_ids.append(threading.get_ident())
            return real_copytree(*args, **kwargs)

        real_zip_write = zipfile.ZipFile.write

        def spy_zip_write(self, *args, **kwargs):
            zip_write_thread_ids.append(threading.get_ident())
            return real_zip_write(self, *args, **kwargs)

        monkeypatch.setattr(shutil, "copytree", spy_copytree)
        monkeypatch.setattr(zipfile.ZipFile, "write", spy_zip_write)

        zip_path, _filename = await create_backup_zip(output_path=tmp_path)
        try:
            assert copytree_thread_ids, "expected shutil.copytree to be invoked for the archive dir"
            assert all(tid != caller_thread_id for tid in copytree_thread_ids), (
                f"shutil.copytree ran on the caller's (event loop) thread {caller_thread_id}: {copytree_thread_ids}"
            )
            assert zip_write_thread_ids, "expected ZipFile.write to be invoked while building the backup zip"
            assert all(tid != caller_thread_id for tid in zip_write_thread_ids), (
                f"ZipFile.write ran on the caller's (event loop) thread {caller_thread_id}: {zip_write_thread_ids}"
            )
            # Both blocking phases ran off-loop, and on the *same* worker
            # thread call each (to_thread schedules each call independently,
            # but within a single call every write happens synchronously in
            # that one thread).
            assert len(set(copytree_thread_ids)) == 1
            assert len(set(zip_write_thread_ids)) == 1
        finally:
            zip_path.unlink(missing_ok=True)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_event_loop_stays_responsive_while_backup_runs(self, async_client, monkeypatch, tmp_path):
        """A concrete symptom of the bug: with the work inline on the loop,
        a concurrently-scheduled coroutine could not run a single tick until
        the whole backup finished. Prove ticks interleave with the backup."""
        import asyncio
        import time

        from backend.app.api.routes.settings import create_backup_zip
        from backend.app.core.config import settings as app_settings

        monkeypatch.setenv("DATA_DIR", str(tmp_path))
        monkeypatch.setattr(app_settings, "base_dir", tmp_path)

        archive_dir = tmp_path / "archive"
        archive_dir.mkdir()
        for i in range(20):
            (archive_dir / f"print{i}.3mf").write_text("fake-3mf-bytes" * 200)

        # Artificially slow down the copy so the ticker has time to observe
        # multiple ticks while the backup is in flight.
        real_copytree = shutil.copytree

        def slow_copytree(*args, **kwargs):
            time.sleep(0.3)
            return real_copytree(*args, **kwargs)

        monkeypatch.setattr(shutil, "copytree", slow_copytree)

        tick_count = 0
        stop = False

        async def ticker():
            nonlocal tick_count
            while not stop:
                tick_count += 1
                await asyncio.sleep(0.01)

        ticker_task = asyncio.create_task(ticker())
        try:
            zip_path, _filename = await create_backup_zip(output_path=tmp_path)
            try:
                # If the backup had run inline on the event loop, the ticker
                # coroutine would not get a chance to run at all until the
                # (artificially slowed) copy finished, so it would show 0 or
                # ~1 ticks. Off-loop, the loop keeps servicing it throughout.
                assert tick_count > 5, f"event loop was starved during backup (ticks={tick_count})"
            finally:
                zip_path.unlink(missing_ok=True)
        finally:
            stop = True
            await ticker_task


class TestCreateBackupTempFileCleanupOnFailure:
    """T-201: in the ``output_path is None`` branch (used by the
    ``GET /settings/backup`` download endpoint), ``create_backup_zip``
    creates its ZIP with ``tempfile.mkstemp``. The only unlink for that file
    was the ``BackgroundTask`` attached to a *successful* ``FileResponse``,
    so if ``_build_zip`` raised (e.g. ENOSPC deflating a large archive tree)
    the partially-written temp ZIP was never cleaned up — every retry left
    another one behind."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_build_zip_failure_unlinks_the_mkstemp_file_and_still_returns_500(self, async_client, monkeypatch):
        import tempfile
        from pathlib import Path

        created_paths: list[str] = []
        real_mkstemp = tempfile.mkstemp

        def spy_mkstemp(*args, **kwargs):
            fd, path = real_mkstemp(*args, **kwargs)
            created_paths.append(path)
            return fd, path

        monkeypatch.setattr(tempfile, "mkstemp", spy_mkstemp)

        def raise_enospc(self, *args, **kwargs):
            raise OSError(28, "No space left on device")

        monkeypatch.setattr(zipfile.ZipFile, "write", raise_enospc)

        response = await async_client.get("/api/v1/settings/backup")

        # Same 500 create_backup's `except Exception` produces today for any
        # failure in create_backup_zip — the fix must not change this.
        assert response.status_code == 500
        assert response.json() == {
            "success": False,
            "message": "Backup failed. Check server logs for details.",
        }

        assert created_paths, "expected tempfile.mkstemp to have been called for the mkstemp branch"
        for path in created_paths:
            assert not Path(path).exists(), f"mkstemp'd backup ZIP {path} leaked after a failed build"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_build_zip_success_still_schedules_cleanup_after_download(self, async_client, monkeypatch):
        """The fix must not touch the existing success path: a completed
        backup still returns 200 and its BackgroundTask still unlinks the
        mkstemp'd ZIP once the download finishes."""
        import tempfile
        from pathlib import Path

        created_paths: list[str] = []
        real_mkstemp = tempfile.mkstemp

        def spy_mkstemp(*args, **kwargs):
            fd, path = real_mkstemp(*args, **kwargs)
            created_paths.append(path)
            return fd, path

        monkeypatch.setattr(tempfile, "mkstemp", spy_mkstemp)

        response = await async_client.get("/api/v1/settings/backup")

        assert response.status_code == 200
        assert response.headers["content-type"] == "application/zip"
        assert created_paths, "expected tempfile.mkstemp to have been called for the mkstemp branch"
        for path in created_paths:
            assert not Path(path).exists(), (
                "success path's BackgroundTask should still have unlinked the mkstemp'd ZIP after download"
            )


class TestRestoreUploadIsStreamedNotBuffered:
    """T-019: the uploaded backup ZIP must be streamed to disk, never fully
    materialised as a single in-memory ``bytes`` object."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_restore_never_reads_the_whole_upload_into_one_object(self, async_client, monkeypatch):
        """``UploadFile.read()`` with no size argument (or a size covering
        the whole body) is exactly the buffer-the-world call T-019 removes.
        The old code was ``content = await file.read()``; assert that call
        no longer happens at all, and that the upload is instead streamed
        via shutil.copyfileobj."""
        read_calls: list[int] = []
        real_read = StarletteUploadFile.read

        async def spy_read(self, size=-1):
            read_calls.append(size)
            return await real_read(self, size)

        monkeypatch.setattr(StarletteUploadFile, "read", spy_read)

        copyfileobj_calls: list[tuple] = []
        real_copyfileobj = shutil.copyfileobj

        def spy_copyfileobj(fsrc, fdst, *args, **kwargs):
            copyfileobj_calls.append((fsrc, fdst))
            return real_copyfileobj(fsrc, fdst, *args, **kwargs)

        monkeypatch.setattr(shutil, "copyfileobj", spy_copyfileobj)

        # A ZIP missing bambuddy.db is enough to exercise the full
        # upload-streaming + extraction path before restore_backup 400s.
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("dummy.txt", "dummy content")
        zip_buffer.seek(0)

        files = {"file": ("backup.zip", zip_buffer.read(), "application/zip")}
        response = await async_client.post("/api/v1/settings/restore", files=files)

        assert response.status_code == 400
        assert "missing bambuddy.db" in response.json()["detail"].lower()

        assert read_calls == [], (
            f"restore_backup must not call UploadFile.read() (buffers the whole upload); got calls: {read_calls}"
        )
        assert copyfileobj_calls, "expected shutil.copyfileobj to stream the upload to a temp file"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_restore_still_rejects_corrupted_zip_after_streaming(self, async_client):
        """Behavior-preservation check: a non-ZIP upload still 400s with the
        same message once streamed through a temp file first."""
        files = {"file": ("backup.zip", b"not valid zip content", "application/zip")}
        response = await async_client.post("/api/v1/settings/restore", files=files)

        assert response.status_code == 400
        assert "not a valid zip" in response.json()["detail"].lower()


class TestRestoreSuccessPath:
    """T-210: the DB swap through the final success response (lines ~1290-1504
    of restore_backup) had zero coverage. Every existing restore test either
    400s before the swap (missing/corrupt zip) or forces the PostgreSQL branch
    (``is_sqlite`` patched ``False``) to dodge the real ``sqlite3`` backup
    call entirely (see ``test_security.py``'s ``test_restore_writes_key_files_
    with_chmod_0600`` and friends).

    This builds a genuine backup ZIP with a real SQLite ``bambuddy.db``
    (containing a marker row) plus a data directory, restores it for real —
    ``is_sqlite()`` and the ``sqlite3`` online-backup call are NOT mocked —
    and asserts:
      - HTTP 200 with the documented success body
      - the on-disk SQLite file the app is configured against
        (``app_settings.database_url``) was actually replaced: the marker row
        is readable back out of it
      - the ``icons`` data directory was restored from the backup
      - the paused background services stay paused on success (no restart —
        a successful restore requires a container restart anyway)

    ``reinitialize_database``/``init_db`` are mocked, matching the established
    pattern in ``test_security.py``'s restore tests, purely to avoid reseeding
    the shared disposable app-db file that lives for the lifetime of the
    xdist worker process (conftest's ``_TEST_APP_DB_DIR``) — the file itself
    is snapshotted and restored around the test so the real (unmocked)
    ``sqlite3`` backup swap this test exercises can never leak into sibling
    tests sharing that worker.
    """

    @staticmethod
    def _mock_paused_services(monkeypatch):
        """Mock the three background services and the virtual printer
        manager so the test observes calls instead of touching real
        singletons / spawning real background loops."""
        from unittest.mock import AsyncMock, MagicMock

        from backend.app.services.notification_service import notification_service
        from backend.app.services.print_scheduler import scheduler as print_scheduler
        from backend.app.services.smart_plug_manager import smart_plug_manager
        from backend.app.services.virtual_printer import virtual_printer_manager

        monkeypatch.setattr(print_scheduler, "stop", MagicMock())
        monkeypatch.setattr(print_scheduler, "run", AsyncMock())
        monkeypatch.setattr(smart_plug_manager, "stop_scheduler", MagicMock())
        monkeypatch.setattr(smart_plug_manager, "start_scheduler", MagicMock())
        monkeypatch.setattr(notification_service, "stop_digest_scheduler", MagicMock())
        monkeypatch.setattr(notification_service, "start_digest_scheduler", MagicMock())

        # is_enabled is a plain `len(self._instances) > 0` property; fake a
        # running virtual printer without touching the class descriptor.
        monkeypatch.setattr(virtual_printer_manager, "_instances", {1: object()})
        monkeypatch.setattr(virtual_printer_manager, "configure", AsyncMock())
        monkeypatch.setattr(virtual_printer_manager, "sync_from_db", AsyncMock())

        return print_scheduler, smart_plug_manager, notification_service, virtual_printer_manager

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_restore_success_swaps_db_and_returns_200(self, async_client, monkeypatch, tmp_path):
        import io
        import sqlite3
        import zipfile
        from pathlib import Path
        from unittest.mock import AsyncMock, patch

        from backend.app.core.config import settings as app_settings

        monkeypatch.setenv("DATA_DIR", str(tmp_path))
        monkeypatch.setattr(app_settings, "base_dir", tmp_path)

        print_scheduler, smart_plug_manager, notification_service, virtual_printer_manager = self._mock_paused_services(
            monkeypatch
        )

        # Build a real SQLite backup source with a marker row so a
        # successful restore can be proven by reading it back afterwards.
        backup_db_path = tmp_path / "backup-source.db"
        marker_value = "T-210-restore-marker-df93a1"
        src_conn = sqlite3.connect(str(backup_db_path))
        try:
            src_conn.execute("CREATE TABLE restore_marker (key TEXT PRIMARY KEY, value TEXT)")
            src_conn.execute("INSERT INTO restore_marker (key, value) VALUES ('marker', ?)", (marker_value,))
            src_conn.commit()
        finally:
            src_conn.close()

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(backup_db_path, "bambuddy.db")
            zf.writestr("icons/marker-icon.txt", "restored-icon-bytes")
        buf.seek(0)

        db_path = Path(app_settings.database_url.replace("sqlite+aiosqlite:///", ""))
        # The physical file backing `backend.app.core.database.engine` is
        # shared for the lifetime of this xdist worker (conftest's
        # _TEST_APP_DB_DIR) — snapshot it so the real backup swap below can
        # never leak state into a test that runs after this one.
        pre_existing = db_path.exists()
        original_bytes = db_path.read_bytes() if pre_existing else None

        try:
            with (
                patch("backend.app.core.database.reinitialize_database", new_callable=AsyncMock) as reinit_mock,
                patch("backend.app.core.database.init_db", new_callable=AsyncMock) as init_mock,
            ):
                resp = await async_client.post(
                    "/api/v1/settings/restore",
                    files={"file": ("backup.zip", buf, "application/zip")},
                )

            assert resp.status_code == 200, resp.text
            assert resp.json() == {
                "success": True,
                "message": "Backup restored successfully. Please restart Fenrir for changes to take effect.",
            }
            reinit_mock.assert_awaited_once()
            init_mock.assert_awaited_once()

            # The DB swap itself (the sqlite3 online-backup call) ran for
            # real, unmocked: the file the app is configured against must now
            # contain the marker row from the uploaded backup.
            assert db_path.exists()
            restored_conn = sqlite3.connect(str(db_path))
            try:
                row = restored_conn.execute("SELECT value FROM restore_marker WHERE key = 'marker'").fetchone()
            finally:
                restored_conn.close()
            assert row == (marker_value,)

            # Data-directory restore (step 6) also ran for real.
            assert (tmp_path / "icons" / "marker-icon.txt").read_text() == "restored-icon-bytes"

            # A successful restore intentionally leaves the paused services
            # stopped (a restart is required anyway) rather than restarting
            # them.
            virtual_printer_manager.configure.assert_awaited_once()
            print_scheduler.stop.assert_called_once()
            smart_plug_manager.stop_scheduler.assert_called_once()
            notification_service.stop_digest_scheduler.assert_called_once()
            print_scheduler.run.assert_not_called()
            smart_plug_manager.start_scheduler.assert_not_called()
            notification_service.start_digest_scheduler.assert_not_called()
            virtual_printer_manager.sync_from_db.assert_not_awaited()
        finally:
            if pre_existing:
                db_path.write_bytes(original_bytes)
            else:
                db_path.unlink(missing_ok=True)


class TestRestoreRejectsZipSlipPaths:
    """T-211: restore_backup rejects any ZIP entry whose resolved path would
    land outside the temp extraction directory, before ``zf.extractall`` is
    ever called — the ZipSlip / path-traversal guard described in the code
    comment (CVE-2006-5456-style) at settings.py ~1263-1275. No existing test
    built a ZIP with a traversal or absolute-path entry, so the guard's raise
    branch had zero coverage.

    ``restore_backup``'s ``tempfile.TemporaryDirectory()`` is created with no
    ``dir=`` argument, so it always resolves via ``tempfile.gettempdir()``.
    Both tests below monkeypatch that to relocate the extraction dir under
    ``tmp_path``, so the malicious entry's *would-be* destination is a path
    this test fully controls: a canary file directly under ``tmp_path``. If
    the guard were ever removed or broken, ``zf.extractall`` would write that
    canary file for real; asserting it does not exist (and that
    ``extractall`` was never even called) proves the traversal never reached
    disk, not just that some 400 was returned.
    """

    @staticmethod
    def _spy_extractall(monkeypatch):
        calls: list[object] = []
        real_extractall = zipfile.ZipFile.extractall

        def spy(self, *args, **kwargs):
            calls.append(self)
            return real_extractall(self, *args, **kwargs)

        monkeypatch.setattr(zipfile.ZipFile, "extractall", spy)
        return calls

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_restore_rejects_relative_path_traversal_entry(self, async_client, monkeypatch, tmp_path):
        import tempfile

        monkeypatch.setattr(tempfile, "gettempdir", lambda: str(tmp_path))
        extractall_calls = self._spy_extractall(monkeypatch)

        # restore_backup's TemporaryDirectory() is created directly under
        # gettempdir() (relocated to tmp_path above), so one level of ".."
        # from inside it lands exactly at tmp_path.
        canary = tmp_path / "zipslip-relative-canary.txt"
        assert not canary.exists()

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("../zipslip-relative-canary.txt", "pwned")
            zf.writestr("bambuddy.db", "fake-db-bytes")
        buf.seek(0)

        response = await async_client.post(
            "/api/v1/settings/restore",
            files={"file": ("backup.zip", buf, "application/zip")},
        )

        assert response.status_code == 400
        detail = response.json()["detail"]
        assert "unsafe path in zip" in detail.lower()
        assert "../zipslip-relative-canary.txt" in detail

        assert not canary.exists(), "ZipSlip guard failed: traversal entry was written outside the extraction dir"
        assert extractall_calls == [], "extractall must never run once an unsafe entry is found in the ZIP"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_restore_rejects_absolute_path_entry(self, async_client, monkeypatch, tmp_path):
        import tempfile

        monkeypatch.setattr(tempfile, "gettempdir", lambda: str(tmp_path))
        extractall_calls = self._spy_extractall(monkeypatch)

        # An absolute-path entry overrides the extraction dir entirely
        # (Path(temp_dir) / "/abs/path" == Path("/abs/path")); point it at a
        # path under tmp_path so the "would-be write" is something this test
        # can safely assert against, rather than a real system path.
        canary = tmp_path / "zipslip-absolute-canary.txt"
        assert not canary.exists()

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(str(canary), "pwned")
            zf.writestr("bambuddy.db", "fake-db-bytes")
        buf.seek(0)

        response = await async_client.post(
            "/api/v1/settings/restore",
            files={"file": ("backup.zip", buf, "application/zip")},
        )

        assert response.status_code == 400
        detail = response.json()["detail"]
        assert "unsafe path in zip" in detail.lower()
        assert str(canary) in detail

        assert not canary.exists(), "ZipSlip guard failed: absolute-path entry was written outside the extraction dir"
        assert extractall_calls == [], "extractall must never run once an unsafe entry is found in the ZIP"


class TestRestoreDataDirectoryStagingContract:
    """T-212: ``_restore_data_directory`` — the T-017 stage-then-atomic-move
    fix — has no direct test. ``TestRestoreSuccessPath`` only exercises it
    indirectly through the full ``/restore`` endpoint, with a single flat
    file and a destination that doesn't pre-exist, so it never reaches the
    "stale staging dir left over from a previous failed attempt" branch, the
    ``shutil.copytree`` (sub-*directory*, not file) branch, or the "clear an
    existing destination" branch.

    These tests call ``_restore_data_directory(name, src_dir, dest_dir)``
    directly, matching the docstring's contract line by line:
      - the backup is copied into a sibling ``.{dest_dir.name}.restore-staging``
        directory first
      - only once that copy fully succeeds is ``dest_dir`` cleared and the
        staged files moved in (a same-filesystem rename)
      - if the staging copy raises ``OSError``, ``dest_dir`` is never
        touched and the exception propagates
      - the staging directory is removed in all cases (success or failure)
    """

    @staticmethod
    def _tree(root, files: dict[str, str]):
        """Create ``root`` and populate it with the given relative
        file paths -> contents (parent dirs created as needed)."""
        root.mkdir(parents=True, exist_ok=True)
        for rel_path, content in files.items():
            full = root / rel_path
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_text(content)
        return root

    def test_happy_path_replaces_dest_contents_with_src_contents(self, tmp_path):
        """dest_dir's old files/subdirs are gone afterwards; src_dir's are
        all present with their original content, and the staging dir left
        behind by this run is cleaned up."""
        from backend.app.api.routes.settings import _restore_data_directory

        src_dir = self._tree(
            tmp_path / "src",
            {
                "top.txt": "src-top",
                "nested/inner.txt": "src-nested",
            },
        )
        dest_dir = self._tree(
            tmp_path / "dest",
            {
                "stale.txt": "old-stale-file",
                "stale_dir/old.txt": "old-nested-file",
            },
        )

        _restore_data_directory("icons", src_dir, dest_dir)

        # Old destination contents are gone.
        assert not (dest_dir / "stale.txt").exists()
        assert not (dest_dir / "stale_dir").exists()

        # New (src) contents are present, file and directory alike.
        assert (dest_dir / "top.txt").read_text() == "src-top"
        assert (dest_dir / "nested" / "inner.txt").read_text() == "src-nested"

        # The staging directory used for this restore is cleaned up.
        stage_dir = dest_dir.parent / f".{dest_dir.name}.restore-staging"
        assert not stage_dir.exists()

    def test_dest_dir_missing_is_created(self, tmp_path):
        """dest_dir need not pre-exist: it's created and populated from
        src_dir (the ``else: dest_dir.mkdir(...)`` branch)."""
        from backend.app.api.routes.settings import _restore_data_directory

        src_dir = self._tree(tmp_path / "src", {"only.txt": "only-content"})
        dest_dir = tmp_path / "dest-does-not-exist"
        assert not dest_dir.exists()

        _restore_data_directory("archive", src_dir, dest_dir)

        assert (dest_dir / "only.txt").read_text() == "only-content"

    def test_src_dir_empty_leaves_dest_dir_empty(self, tmp_path):
        """An empty backup directory still clears out dest_dir's stale
        contents (the staging copy trivially "succeeds" with nothing to
        copy), leaving dest_dir present but empty."""
        from backend.app.api.routes.settings import _restore_data_directory

        src_dir = tmp_path / "src-empty"
        src_dir.mkdir()
        dest_dir = self._tree(tmp_path / "dest", {"stale.txt": "old-stale-file"})

        _restore_data_directory("timelapse", src_dir, dest_dir)

        assert dest_dir.exists()
        assert list(dest_dir.iterdir()) == []

    def test_stale_staging_dir_from_a_previous_failed_attempt_is_cleared_first(self, tmp_path):
        """A staging directory left behind by an earlier crashed/failed
        restore is removed before this run stages into it, rather than the
        new copy landing on top of (or being confused by) old leftovers."""
        from backend.app.api.routes.settings import _restore_data_directory

        src_dir = self._tree(tmp_path / "src", {"fresh.txt": "fresh-content"})
        dest_dir = self._tree(tmp_path / "dest", {"stale.txt": "old-stale-file"})

        stage_dir = dest_dir.parent / f".{dest_dir.name}.restore-staging"
        stage_dir.mkdir(parents=True)
        (stage_dir / "leftover-from-crash.txt").write_text("leftover")

        _restore_data_directory("icons", src_dir, dest_dir)

        assert (dest_dir / "fresh.txt").read_text() == "fresh-content"
        assert not (dest_dir / "stale.txt").exists()
        # The stale leftover never made it into the restored destination,
        # and the (fresh) staging dir used by this run is cleaned up too.
        assert not (dest_dir / "leftover-from-crash.txt").exists()
        assert not stage_dir.exists()

    def test_mid_staging_oserror_leaves_dest_dir_completely_untouched(self, tmp_path, monkeypatch):
        """The T-017 bug this function fixes: dest_dir must never be
        cleared until the staging copy has *fully* succeeded. Simulate a
        mid-copy failure (e.g. ENOSPC) via a real ``shutil.copytree`` that
        raises after copying the first of two source entries, and assert
        the exception propagates while dest_dir's original files are all
        still there, byte-for-byte."""
        import shutil

        from backend.app.api.routes.settings import _restore_data_directory

        src_dir = self._tree(
            tmp_path / "src",
            {
                "aaa_first/file.txt": "src-first-dir",
                "zzz_second/file.txt": "src-second-dir",
            },
        )
        dest_dir = self._tree(
            tmp_path / "dest",
            {
                "keep.txt": "must-survive",
                "keep_dir/inner.txt": "must-also-survive",
            },
        )

        real_copytree = shutil.copytree
        call_count = 0

        def flaky_copytree(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                raise OSError("ENOSPC: simulated mid-copy disk-full failure")
            return real_copytree(*args, **kwargs)

        monkeypatch.setattr(shutil, "copytree", flaky_copytree)

        with pytest.raises(OSError, match="ENOSPC"):
            _restore_data_directory("archive", src_dir, dest_dir)

        # dest_dir is completely untouched — not partially cleared, not
        # deleted.
        assert dest_dir.exists()
        assert (dest_dir / "keep.txt").read_text() == "must-survive"
        assert (dest_dir / "keep_dir" / "inner.txt").read_text() == "must-also-survive"

        # The staging dir (with its now-abandoned partial copy) is still
        # cleaned up by the ``finally`` block even on this failure path.
        stage_dir = dest_dir.parent / f".{dest_dir.name}.restore-staging"
        assert not stage_dir.exists()
