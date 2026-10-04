"""The finish photo is saved on an archive that already has photos.

``photos`` is a plain JSON column. The finish-photo writer appended to the
loaded list in place and assigned the same object back, so SQLAlchemy saw no
change and committed nothing: on a reprint (the row keeps run one's photo) or
after a photo uploaded during the print, the new finish photo was written to
disk and never listed -- the gallery missed it and the notification's photo
link answered 404.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.models.archive import PrintArchive
from backend.app.models.printer import Printer

pytestmark = pytest.mark.asyncio


async def _seed(engine, photos):
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as db:
        printer = Printer(
            name="X1C04", serial_number="00M09C431502598", ip_address="10.0.0.2", access_code="1", model="X1C"
        )
        db.add(printer)
        await db.commit()
        await db.refresh(printer)
        archive = PrintArchive(printer_id=printer.id, filename="a.3mf", file_path="", file_size=0, photos=photos)
        db.add(archive)
        await db.commit()
        await db.refresh(archive)
        return maker, archive.id


@pytest.mark.parametrize("existing", [["run1.jpg"], None, []])
async def test_the_finish_photo_is_listed(test_engine, existing):
    from backend.app import main as main_module

    maker, archive_id = await _seed(test_engine, existing)
    with patch.object(main_module, "async_session", maker):
        await main_module._append_archive_photo(archive_id, "finish_2.jpg")

    async with maker() as db:
        archive = await db.get(PrintArchive, archive_id)
        assert archive.photos == [*(existing or []), "finish_2.jpg"]
