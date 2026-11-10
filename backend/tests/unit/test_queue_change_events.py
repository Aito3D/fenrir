"""Queue and pending-upload writes announce themselves over the WebSocket.

The sidebar badges (pending queue count, pending uploads) used to poll every
5 s on every page because nothing told other clients a queue changed. Every
write route now broadcasts ``queue_changed`` / ``pending_uploads_changed``
after its commit; the frontend invalidates on those and polls only as a
slow fallback.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from backend.app.services import queue_events

pytestmark = pytest.mark.asyncio


async def test_notify_swallows_socket_failures():
    """A dead socket must never fail the request that changed the queue."""
    with patch.object(queue_events.ws_manager, "broadcast", AsyncMock(side_effect=RuntimeError("socket gone"))):
        await queue_events.notify_queue_changed()
        await queue_events.notify_pending_uploads_changed()


async def test_notify_payloads():
    with patch.object(queue_events.ws_manager, "broadcast", AsyncMock()) as broadcast:
        await queue_events.notify_queue_changed()
        await queue_events.notify_pending_uploads_changed()
    broadcast.assert_any_await({"type": "queue_changed"})
    broadcast.assert_any_await({"type": "pending_uploads_changed"})


async def test_reorder_route_broadcasts_queue_changed(async_client):
    with patch.object(queue_events.ws_manager, "broadcast", AsyncMock()) as broadcast:
        response = await async_client.post("/api/v1/queue/reorder", json={"items": []})
    assert response.status_code == 200, response.text
    broadcast.assert_any_await({"type": "queue_changed"})


async def test_discard_all_route_broadcasts_pending_uploads_changed(async_client):
    with patch.object(queue_events.ws_manager, "broadcast", AsyncMock()) as broadcast:
        response = await async_client.delete("/api/v1/pending-uploads/discard-all")
    assert response.status_code == 200, response.text
    broadcast.assert_any_await({"type": "pending_uploads_changed"})


async def test_every_queue_write_route_notifies():
    """Each committing write route in the two routers calls its notifier.

    Checked on the source because the routes need printers, files and
    batches to exercise one by one; the two route tests above prove the
    wiring end to end.
    """
    from pathlib import Path

    routes = Path(__file__).resolve().parents[3] / "backend" / "app" / "api" / "routes"
    for file, notifier, skip in (
        ("print_queue.py", "notify_queue_changed", {"_refresh_batches_after_delete"}),
        # _store_pending is a helper; both routes calling it notify after it.
        ("pending_uploads.py", "notify_pending_uploads_changed", {"_store_pending"}),
    ):
        src = (routes / file).read_text()
        current = None
        missing: set[str] = set()
        for line in src.splitlines():
            if line.startswith("async def "):
                current = line[len("async def ") :].split("(")[0]
            elif "await db.commit()" in line and current and current not in skip:
                missing.add(current)
            elif f"await {notifier}()" in line and current in missing:
                missing.discard(current)
        assert not missing, f"{file}: routes committing without {notifier}: {sorted(missing)}"


async def test_virtual_printer_upload_notifies(test_engine, tmp_path):
    """A file landing on the virtual printer becomes a pending upload AND a broadcast."""
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from backend.app.models.pending_upload import PendingUpload
    from backend.app.services.virtual_printer.manager import VirtualPrinterInstance

    instance = object.__new__(VirtualPrinterInstance)
    instance.name = "vp-test"
    instance._session_factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    instance._pending_files = {}
    instance.id = None
    instance.upload_dir = tmp_path / "uploads"  # a review upload keeps its own copy here
    upload = tmp_path / "part.3mf"
    upload.write_bytes(b"not a real archive")

    with patch.object(queue_events.ws_manager, "broadcast", AsyncMock()) as broadcast:
        await instance._queue_file(upload, "192.0.2.10")

    broadcast.assert_any_await({"type": "pending_uploads_changed"})
    async with instance._session_factory() as db:
        rows = (await db.execute(select(PendingUpload).where(PendingUpload.filename == "part.3mf"))).scalars().all()
    assert len(rows) == 1 and rows[0].status == "pending"
