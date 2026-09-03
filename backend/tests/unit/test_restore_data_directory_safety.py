"""Regression tests for T-017.

``_restore_data_directory`` (backend/app/api/routes/settings.py) is the
helper the ``/settings/restore`` route uses to replace each live data
directory (archive, icons, projects, ...) with the contents of a backup
ZIP. The original implementation cleared the destination directory
*before* copying the replacement in:

    for item in dest_dir.iterdir():
        shutil.rmtree(item)  # or item.unlink()
    for item in src_dir.iterdir():
        shutil.copytree(item, dest_item)  # <- OSError here (e.g. ENOSPC)
        # ^ caught, logged as a "skipped" dir, loop continues

A copy failure partway through (disk full is the realistic case, since
the backup ZIP was just unpacked onto the same filesystem) left the
live directory destroyed with nothing to replace it, and the route
still returned ``{"success": True, ...}`` with only a footnote
mentioning the directory name.

The fix copies into a sibling staging directory first and only clears +
swaps in the destination once that copy has fully succeeded, so a
failed copy leaves the destination completely untouched. The route
raises HTTPException(500) instead of reporting success if any
directory's copy fails.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from backend.app.api.routes.settings import _raise_if_directories_failed, _restore_data_directory


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


class TestRestoreDataDirectorySuccess:
    def test_copies_backup_contents_into_destination(self, tmp_path):
        src_dir = tmp_path / "backup_src" / "archive"
        dest_dir = tmp_path / "live" / "archive"

        _write(src_dir / "print1.3mf", "backup-3mf-bytes")
        _write(src_dir / "sub" / "photo.jpg", "backup-photo-bytes")

        _write(dest_dir / "old_print.3mf", "old-live-bytes")

        _restore_data_directory("archive", src_dir, dest_dir)

        assert (dest_dir / "print1.3mf").read_text() == "backup-3mf-bytes"
        assert (dest_dir / "sub" / "photo.jpg").read_text() == "backup-photo-bytes"
        # Old content was replaced, not merged.
        assert not (dest_dir / "old_print.3mf").exists()

    def test_creates_destination_if_missing(self, tmp_path):
        src_dir = tmp_path / "backup_src" / "icons"
        dest_dir = tmp_path / "live" / "icons"  # does not exist yet

        _write(src_dir / "icon.png", "icon-bytes")

        _restore_data_directory("icons", src_dir, dest_dir)

        assert (dest_dir / "icon.png").read_text() == "icon-bytes"

    def test_no_staging_directory_left_behind_on_success(self, tmp_path):
        src_dir = tmp_path / "backup_src" / "projects"
        dest_dir = tmp_path / "live" / "projects"
        _write(src_dir / "p.json", "{}")

        _restore_data_directory("projects", src_dir, dest_dir)

        stage_dir = dest_dir.parent / f".{dest_dir.name}.restore-staging"
        assert not stage_dir.exists()


class TestRestoreDataDirectoryFailurePath:
    """The behavior T-017 fixes: a failed copy must not destroy live data
    and must not be silently swallowed into a false success."""

    def test_failed_copy_leaves_destination_completely_untouched(self, tmp_path, monkeypatch):
        src_dir = tmp_path / "backup_src" / "archive"
        dest_dir = tmp_path / "live" / "archive"

        # Backup has two files; we'll make the second one fail to copy
        # (simulating e.g. ENOSPC hit partway through a directory).
        _write(src_dir / "a.3mf", "new-a")
        _write(src_dir / "b.3mf", "new-b")

        # Live directory has the user's real, valuable data.
        _write(dest_dir / "irreplaceable_print.3mf", "precious-user-data")
        _write(dest_dir / "timelapse.mp4", "precious-timelapse-bytes")

        real_copy2 = shutil.copy2

        def flaky_copy2(src, dst, *args, **kwargs):
            if Path(src).name == "b.3mf":
                raise OSError(28, "No space left on device")  # ENOSPC
            return real_copy2(src, dst, *args, **kwargs)

        monkeypatch.setattr(shutil, "copy2", flaky_copy2)

        with pytest.raises(OSError):
            _restore_data_directory("archive", src_dir, dest_dir)

        # The critical assertion: the live directory must be exactly as
        # it was before the failed restore attempt. Nothing deleted,
        # nothing half-written from the backup.
        assert (dest_dir / "irreplaceable_print.3mf").read_text() == "precious-user-data"
        assert (dest_dir / "timelapse.mp4").read_text() == "precious-timelapse-bytes"
        assert not (dest_dir / "a.3mf").exists(), (
            "Destination must not contain partially-copied backup files after a failed restore"
        )
        assert not (dest_dir / "b.3mf").exists()

        # No leftover staging directory either.
        stage_dir = dest_dir.parent / f".{dest_dir.name}.restore-staging"
        assert not stage_dir.exists()

    def test_failed_copytree_leaves_destination_untouched(self, tmp_path, monkeypatch):
        """Same guarantee when the failure comes from a subdirectory copy
        (shutil.copytree) rather than a single file (shutil.copy2)."""
        src_dir = tmp_path / "backup_src" / "archive"
        dest_dir = tmp_path / "live" / "archive"

        _write(src_dir / "sub" / "photo.jpg", "new-photo")
        _write(dest_dir / "existing.3mf", "existing-live-data")

        def raising_copytree(*args, **kwargs):
            raise OSError(28, "No space left on device")

        monkeypatch.setattr(shutil, "copytree", raising_copytree)

        with pytest.raises(OSError):
            _restore_data_directory("archive", src_dir, dest_dir)

        assert (dest_dir / "existing.3mf").read_text() == "existing-live-data"
        assert not (dest_dir / "sub").exists()


class TestRaiseIfDirectoriesFailed:
    """`restore_backup` calls this immediately after attempting every data
    directory, before building the `{"success": True, ...}` response. It
    is the exact mechanism that turns a directory-copy failure into a
    reported failure instead of the pre-fix silent "success with a
    footnote"."""

    def test_no_failures_does_not_raise(self):
        _raise_if_directories_failed([])  # must not raise

    def test_any_failure_raises_http_500_not_success(self):
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc_info:
            _raise_if_directories_failed(["archive"])

        assert exc_info.value.status_code == 500
        assert "archive" in exc_info.value.detail

    def test_multiple_failures_are_all_named_in_the_error(self):
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc_info:
            _raise_if_directories_failed(["archive", "projects"])

        assert exc_info.value.status_code == 500
        assert "archive" in exc_info.value.detail
        assert "projects" in exc_info.value.detail
