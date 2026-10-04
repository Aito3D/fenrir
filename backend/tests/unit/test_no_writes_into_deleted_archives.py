"""Nothing is written into an archive that was deleted while its print ran.

Deleting the archive of a running print removed its folder, but the
completion work still ran against the soft-deleted row: the timelapse attach
and the finish-photo writer recreated the folder and wrote a video (often
100 MB+) and a JPEG there, which nothing would ever delete -- the archive's
delete had already run.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.models.archive import PrintArchive
from backend.app.models.printer import Printer

pytestmark = pytest.mark.asyncio


async def _deleted_archive(engine):
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as db:
        printer = Printer(name="P", serial_number="S1", ip_address="10.0.0.3", access_code="1", model="X1C")
        db.add(printer)
        await db.commit()
        await db.refresh(printer)
        archive = PrintArchive(
            printer_id=printer.id,
            filename="gone.3mf",
            file_path="",
            file_size=0,
            photos=["run1.jpg"],
            deleted_at=datetime.now(timezone.utc),
        )
        db.add(archive)
        await db.commit()
        await db.refresh(archive)
        return maker, archive


async def test_no_timelapse_is_attached(test_engine):
    from backend.app.services.archive import ArchiveService
    from backend.app.utils.archive_paths import archive_dir

    maker, archive = await _deleted_archive(test_engine)
    async with maker() as db:
        assert await ArchiveService(db).attach_timelapse(archive.id, b"video", "deleted_probe_7c1.mp4") is False
    assert not (archive_dir(archive) / "deleted_probe_7c1.mp4").exists()


async def test_no_finish_photo_is_listed(test_engine):
    from backend.app import main as main_module

    maker, archive = await _deleted_archive(test_engine)
    with patch.object(main_module, "async_session", maker):
        await main_module._append_archive_photo(archive.id, "finish.jpg")
    async with maker() as db:
        assert (await db.get(PrintArchive, archive.id)).photos == ["run1.jpg"]


async def test_the_timelapse_frame_wait_stops_at_once(test_engine, tmp_path):
    from backend.app import main as main_module

    maker, archive = await _deleted_archive(test_engine)
    with patch.object(main_module, "async_session", maker):
        result = await main_module._capture_finish_photo_from_timelapse(archive.id, tmp_path / "a", timeout=30)
    assert result == (None, False)
    assert not (tmp_path / "a" / "photos").exists()
