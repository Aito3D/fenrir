"""Each printer downloads its print file to its own temp folder.

Measured in the shop on 2026-10-03: the same "Kia cache_plate_2.gcode.3mf"
went to six printers within minutes, two X1Cs ten seconds apart. Every
printer wrote it to ``archive/temp/<name>``: one download opened the shared
path with "wb" (truncating the other's copy) and a 550 on one path unlinked
it, while the other printer's archive copy or cover read was using it.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from backend.app.core.config import settings
from backend.app.services.bambu_ftp import print_temp_path

pytestmark = pytest.mark.unit


class TestPrintTempPath:
    def test_two_printers_never_share_a_path(self):
        assert print_temp_path(1, "Part.gcode.3mf") != print_temp_path(2, "Part.gcode.3mf")

    def test_the_name_is_kept(self):
        assert print_temp_path(7, "Part.gcode.3mf").name == "Part.gcode.3mf"

    def test_it_stays_under_the_temp_root_so_cache_cleanup_still_owns_it(self):
        assert print_temp_path(7, "Part.gcode.3mf").is_relative_to(settings.archive_dir / "temp")

    def test_the_folder_exists(self):
        assert print_temp_path(7, "Part.gcode.3mf").parent.is_dir()

    @pytest.mark.parametrize("name", ["../evil.3mf", "sub/dir.3mf", "/abs.3mf"])
    def test_a_path_shaped_name_cannot_leave_the_folder(self, name):
        path = print_temp_path(7, name)
        assert path.parent == print_temp_path(7, "x.3mf").parent


@pytest.mark.asyncio
async def test_the_probe_downloads_into_the_printer_s_folder():
    from backend.app import main as main_module

    seen: list[Path] = []

    async def _download(ip, code, paths, dest, **kwargs):
        seen.append(Path(dest))
        return None

    with patch.object(main_module, "download_file_try_paths_async", _download):
        await main_module._probe_for_3mf(3, "1.2.3.4", "x", "H2C", ["Part.gcode.3mf"], None, 5)
        await main_module._probe_for_3mf(4, "1.2.3.5", "x", "H2C", ["Part.gcode.3mf"], None, 5)

    assert seen[0] == print_temp_path(3, "Part.gcode.3mf")
    assert seen[1] == print_temp_path(4, "Part.gcode.3mf")


class TestUploadTempFile:
    """Archive uploads get a private temp folder too: two people uploading
    ``plate_1.3mf`` at once used to share archive/temp/plate_1.3mf."""

    def test_two_uploads_of_one_name_never_share_a_path(self):
        from backend.app.api.routes.archives import _upload_temp_file

        with _upload_temp_file("plate_1.3mf") as a, _upload_temp_file("plate_1.3mf") as b:
            assert a != b
            assert a.name == b.name == "plate_1.3mf"
            assert a.is_relative_to(settings.archive_dir / "temp")

    def test_the_folder_is_removed_afterwards(self):
        from backend.app.api.routes.archives import _upload_temp_file

        with _upload_temp_file("plate_1.3mf") as path:
            path.write_bytes(b"x")
        assert not path.parent.exists()


@pytest.mark.asyncio
async def test_one_failed_file_does_not_fail_the_rest_of_a_bulk_upload(async_client, db_session):
    """A file whose archiving raises leaves the session in a failed transaction;
    without a rollback every later file in the batch failed with it."""
    import zipfile
    from io import BytesIO

    def _3mf():
        buf = BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("3D/3dmodel.model", "<model/>")
            zf.writestr("Metadata/slice_info.config", "<config/>")
        return buf.getvalue()

    from backend.app.services.archive import ArchiveService

    real = ArchiveService.archive_print
    calls = {"n": 0}

    async def _first_fails(self, *args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            # A flush that fails (here a NOT NULL violation) leaves the session
            # needing a rollback, like a commit that hits "database is locked".
            from backend.app.models.archive import PrintArchive

            self.db.add(PrintArchive(filename=None, file_path="", file_size=0))
            await self.db.flush()
        return await real(self, *args, **kwargs)

    with patch.object(ArchiveService, "archive_print", _first_fails):
        response = await async_client.post(
            "/api/v1/archives/upload-bulk",
            files=[
                ("files", ("a.3mf", _3mf(), "application/octet-stream")),
                ("files", ("b.3mf", _3mf(), "application/octet-stream")),
            ],
        )

    body = response.json()
    assert body["failed"] == 1
    assert body["uploaded"] == 1
