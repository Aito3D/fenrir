"""A late fill-in is checked against the print like a print-start download.

A fallback archive is filled in later from whatever 3MF turns up: the cover
endpoint's download, a retry, the completion-time cache. None of those paths
checked the file, so a stale same-name copy -- even the very one print start
had just rejected on its md5 -- became the archive's 3MF, thumbnail, filament
and cost. The fallback now records what print start knew (the dispatch md5,
the plate, the reported remaining time) and recovery judges every candidate
with it.
"""

from __future__ import annotations

import hashlib
import time
import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.models.archive import PrintArchive
from backend.app.models.printer import Printer

pytestmark = pytest.mark.asyncio

NAME = "Part.gcode.3mf"


def _write_3mf(path: Path, marker: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(
            "Metadata/slice_info.config", f"<config><plate><metadata key='index' value='1'/></plate>{marker}</config>"
        )
        zf.writestr("3D/3dmodel.model", "<model/>")
    return path


async def _seed(engine, check: dict | None):
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as db:
        printer = Printer(
            name="H2C01", serial_number="31B8BP5A1801820", ip_address="10.0.0.1", access_code="1", model="H2C"
        )
        db.add(printer)
        await db.commit()
        await db.refresh(printer)
        extra = {"no_3mf_available": True, "no_3mf_reason": "internal_storage"}
        if check is not None:
            extra["_recovery_check"] = check
        archive = PrintArchive(
            printer_id=printer.id,
            filename=NAME,
            file_path="",
            file_size=0,
            print_name="Part",
            status="printing",
            extra_data=extra,
        )
        db.add(archive)
        await db.commit()
        await db.refresh(archive)
        return maker, printer.id, archive.id


async def _recover(maker, printer_id, archive_id, source):
    from backend.app import main as main_module

    with (
        patch.object(main_module, "async_session", maker),
        patch.dict(main_module._active_prints, {(printer_id, NAME): archive_id}, clear=True),
    ):
        return await main_module.try_recover_fallback_archive(printer_id, NAME, source)


async def test_a_file_with_the_wrong_md5_is_not_attached(test_engine, tmp_path):
    right = _write_3mf(tmp_path / "right" / NAME, "right")
    wrong = _write_3mf(tmp_path / "wrong" / NAME, "wrong")
    md5 = hashlib.md5(right.read_bytes()).hexdigest()
    maker, printer_id, archive_id = await _seed(
        test_engine, {"md5": md5, "plate": None, "remaining_s": None, "at": time.time()}
    )

    assert await _recover(maker, printer_id, archive_id, wrong) is False

    async with maker() as db:
        archive = await db.get(PrintArchive, archive_id)
        assert not archive.file_path
        assert archive.extra_data["no_3mf_available"] is True


async def test_the_matching_file_is_attached(test_engine, tmp_path):
    right = _write_3mf(tmp_path / "right" / NAME, "right")
    md5 = hashlib.md5(right.read_bytes()).hexdigest()
    maker, printer_id, archive_id = await _seed(
        test_engine, {"md5": md5, "plate": None, "remaining_s": None, "at": time.time()}
    )

    assert await _recover(maker, printer_id, archive_id, right) is True

    async with maker() as db:
        archive = await db.get(PrintArchive, archive_id)
        assert archive.file_path
        assert archive.content_verified is True


async def test_a_fallback_from_before_the_check_still_recovers(test_engine, tmp_path):
    """Rows written before this change carry no check data: same as before."""
    some = _write_3mf(tmp_path / "some" / NAME, "x")
    maker, printer_id, archive_id = await _seed(test_engine, None)

    assert await _recover(maker, printer_id, archive_id, some) is True


async def test_the_print_start_fallback_records_what_it_knew():
    """The check data is written where recovery can read it."""
    from backend.app.main import _recovery_check

    check = _recovery_check("ABCDEF", 2, 3600)
    assert check["md5"] == "abcdef"
    assert check["plate"] == 2
    assert check["remaining_s"] == 3600
    assert abs(check["at"] - time.time()) < 5
    assert _recovery_check(None, None, None)["md5"] is None


async def test_the_remaining_time_ages_with_the_print():
    """Judged an hour later, a print that had 3 h left has about 2 h left."""
    from backend.app.main import _remaining_now

    check = {"remaining_s": 3 * 3600, "at": time.time() - 3600}
    assert abs(_remaining_now(check) - 2 * 3600) < 5
    assert _remaining_now({"remaining_s": 60, "at": time.time() - 3600}) is None
    assert _remaining_now({"remaining_s": None, "at": time.time()}) is None
