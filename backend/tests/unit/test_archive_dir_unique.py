"""Two archives created in the same second never share a folder.

The folder was ``<printer>/<YYYYmmdd_HHMMSS>_<name>`` created with
``exist_ok=True``: two same-name 3MFs archived within a second (a bulk upload
of two exports both called plate_1.3mf) wrote into one folder, the second
overwrote the first's 3MF and thumbnail, and deleting either archive removed
the other's files with it.
"""

from __future__ import annotations

import shutil
import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest

from backend.app.core.config import settings

pytestmark = pytest.mark.asyncio


def _3mf(path: Path, marker: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("3D/3dmodel.model", f"<model>{marker}</model>")
        zf.writestr("Metadata/slice_info.config", "<config/>")
    return path


async def test_same_second_same_name_gets_two_folders(db_session, tmp_path):
    from backend.app.services.archive import ArchiveService

    first = _3mf(tmp_path / "a" / "plate_1.3mf", "a")
    second = _3mf(tmp_path / "b" / "plate_1.3mf", "b")
    service = ArchiveService(db_session)

    class _Frozen:
        @staticmethod
        def now(*_args, **_kwargs):
            from datetime import datetime

            return datetime(2026, 10, 4, 12, 0, 0)

    made = []
    try:
        with patch("backend.app.services.archive.datetime", _Frozen):
            a = await service.archive_print(printer_id=None, source_file=first)
            b = await service.archive_print(printer_id=None, source_file=second)
        made = [settings.base_dir / Path(x.file_path).parent for x in (a, b)]
        assert Path(a.file_path).parent != Path(b.file_path).parent
        with zipfile.ZipFile(settings.base_dir / a.file_path) as zf:
            assert zf.read("3D/3dmodel.model") == b"<model>a</model>"
    finally:
        for folder in made:
            shutil.rmtree(folder, ignore_errors=True)


async def test_a_failed_commit_removes_the_folder_and_rolls_back(db_session, tmp_path):
    """A commit that fails (SQLite 'database is locked' after the busy
    timeout, a full disk) left the copied folder with no row, and the session
    in a failed transaction for the caller's next statement."""
    from sqlalchemy import select
    from sqlalchemy.exc import OperationalError

    from backend.app.models.archive import PrintArchive
    from backend.app.services.archive import ArchiveService

    source = _3mf(tmp_path / "c" / "locked.3mf", "c")
    service = ArchiveService(db_session)
    created: list[Path] = []
    real_mkdir = Path.mkdir

    def _track(self, *args, **kwargs):
        real_mkdir(self, *args, **kwargs)
        if self.name.endswith("_locked"):
            created.append(self)

    async def _locked():
        raise OperationalError("COMMIT", {}, Exception("database is locked"))

    with (
        patch.object(Path, "mkdir", _track),
        patch.object(db_session, "commit", _locked),
        pytest.raises(OperationalError),
    ):
        await service.archive_print(printer_id=None, source_file=source)

    assert created, "archive_print never made its folder"
    assert not created[0].exists(), "the folder of the failed archive was left behind"
    # The session is usable again.
    await db_session.execute(select(PrintArchive.id).limit(1))
