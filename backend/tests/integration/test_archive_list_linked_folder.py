"""The archive list carries each archive's linked library folder.

Every archive card and list row fetched /library/folders/by-archive/{id} on
mount to draw its folder badge: 50 requests per page view, one per archive in
"show all", each running a count query per folder. The list now answers it in
one batched query, for callers allowed to read the library.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


async def test_each_row_names_its_first_linked_folder(
    async_client: AsyncClient, archive_factory, printer_factory, db_session
):
    from backend.app.models.library import LibraryFolder

    printer = await printer_factory()
    linked = await archive_factory(printer.id)
    plain = await archive_factory(printer.id)
    db_session.add(LibraryFolder(name="Zeta", archive_id=linked.id))
    db_session.add(LibraryFolder(name="Alpha", archive_id=linked.id))
    await db_session.commit()

    rows = {r["id"]: r for r in (await async_client.get("/api/v1/archives/?limit=50")).json()}

    assert rows[linked.id]["linked_folder"]["name"] == "Alpha"
    assert isinstance(rows[linked.id]["linked_folder"]["id"], int)
    assert rows[plain.id]["linked_folder"] is None
