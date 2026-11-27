"""retry_queue_item_slice: the ownership 403 and the "no project revision" 400 guards."""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from backend.app.api.routes.print_queue import retry_queue_item_slice
from backend.app.core.printer_scope import PrinterScope
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem


async def _retry(db, item_id, *, user, can_modify_all):
    with pytest.raises(HTTPException) as exc:
        await retry_queue_item_slice(
            item_id,
            db=db,
            auth_result=(user, can_modify_all),
            can_read_aito=True,
            printer_scope=PrinterScope(),
            actor=None,
        )
    return exc.value


async def _status(db, item_id):
    db.expire_all()
    return (await db.execute(select(PrintQueueItem.status).where(PrintQueueItem.id == item_id))).scalar_one()


@pytest.mark.asyncio
@pytest.mark.integration
async def test_retry_slice_of_someone_elses_item_is_403_for_an_own_only_user(db_session):
    item = PrintQueueItem(status="slice_failed", position=1, created_by_id=None)
    db_session.add(item)
    await db_session.commit()
    item_id = item.id

    err = await _retry(db_session, item_id, user=SimpleNamespace(id=999), can_modify_all=False)

    assert (err.status_code, err.detail) == (403, "You can only update your own queue items")
    assert await _status(db_session, item_id) == "slice_failed"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_retry_slice_without_a_project_revision_is_400(db_session):
    plain = LibraryFile(filename="a.3mf", file_path="/library/a.3mf", file_size=1, file_type="3mf")
    db_session.add(plain)
    await db_session.flush()
    no_file = PrintQueueItem(status="slice_failed", position=1)
    no_revision = PrintQueueItem(status="slice_failed", position=2, library_file_id=plain.id)
    db_session.add_all([no_file, no_revision])
    await db_session.commit()
    ids = [no_file.id, no_revision.id]

    for item_id in ids:
        err = await _retry(db_session, item_id, user=None, can_modify_all=True)
        assert (err.status_code, err.detail) == (400, "This item has no project revision to slice")
        assert await _status(db_session, item_id) == "slice_failed"
