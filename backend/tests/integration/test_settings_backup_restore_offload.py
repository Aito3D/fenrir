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
