"""The archive list never decodes `_print_data`.

`_print_data` is a ~9 KB raw MQTT snapshot per archive (25 of the 30 MB of
extra_data on a 3k-archive install). The list response already dropped it, but
only after SQLAlchemy had loaded and JSON-decoded every row's full blob on the
event loop: ~0.45 s per list of 3k rows, ~1 s at the shop's 6.5k, stalling
MQTT and the WebSocket. The list now loads extra_data minus that key, computed
in SQL, and never the full column.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlalchemy import inspect

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


async def test_the_list_never_loads_the_full_column(archive_factory, printer_factory, db_session):
    from backend.app.services.archive import ArchiveService

    printer = await printer_factory()
    await archive_factory(
        printer.id, extra_data={"no_3mf_available": True, "_print_data": {"big": "x" * 1000}, "tags": ["a"]}
    )
    await db_session.commit()
    db_session.expunge_all()

    rows = await ArchiveService(db_session).list_archives(limit=10, slim_extra=True)

    assert rows
    assert "extra_data" in inspect(rows[0]).unloaded
    assert rows[0].list_extra_data == {"no_3mf_available": True, "tags": ["a"]}


async def test_the_list_response_keeps_every_key_but_print_data(
    async_client: AsyncClient, archive_factory, printer_factory, db_session
):
    printer = await printer_factory()
    archive = await archive_factory(
        printer.id, extra_data={"no_3mf_reason": "internal_storage", "_print_data": {"gcode_state": "RUNNING"}}
    )
    await db_session.commit()

    listed = (await async_client.get("/api/v1/archives/?limit=50")).json()
    row = next(r for r in listed if r["id"] == archive.id)
    assert row["extra_data"] == {"no_3mf_reason": "internal_storage"}

    detail = (await async_client.get(f"/api/v1/archives/{archive.id}")).json()
    assert detail["extra_data"]["_print_data"] == {"gcode_state": "RUNNING"}


async def test_an_archive_without_extra_data_lists_as_null(
    async_client: AsyncClient, archive_factory, printer_factory, db_session
):
    printer = await printer_factory()
    archive = await archive_factory(printer.id, extra_data=None)
    await db_session.commit()

    listed = (await async_client.get("/api/v1/archives/?limit=50")).json()
    assert next(r for r in listed if r["id"] == archive.id)["extra_data"] is None
