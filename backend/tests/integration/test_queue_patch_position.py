"""PATCH /queue/{id} no longer moves a job (T-004): the position field is ignored; /reorder moves jobs."""

import pytest
from sqlalchemy import select

from backend.app.models.print_queue import PrintQueueItem

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


async def test_patch_with_a_position_does_not_move_the_job(async_client, db_session, printer_factory, archive_factory):
    printer = await printer_factory()
    archive = await archive_factory(printer.id)
    created = await async_client.post("/api/v1/queue/", json={"archive_id": archive.id, "printer_id": printer.id})
    item_id = created.json()["id"]
    before = created.json()["position"]

    response = await async_client.patch(
        f"/api/v1/queue/{item_id}", json={"position": before + 40, "manual_start": True}
    )

    assert response.status_code == 200, response.text
    assert response.json()["position"] == before
    assert response.json()["manual_start"] is True
    db_session.expire_all()
    item = await db_session.scalar(select(PrintQueueItem).where(PrintQueueItem.id == item_id))
    assert item.position == before


def test_the_update_schema_has_no_position_field():
    from backend.app.schemas.print_queue import PrintQueueItemUpdate

    assert "position" not in PrintQueueItemUpdate.model_fields
