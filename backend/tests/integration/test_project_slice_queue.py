"""Print queue ``slicing`` / ``slice_failed`` for project prints (design 2026-10-17, decisions 6, 7, 9, 12).

A project revision keeps its source ``.3mf``; a print of it runs the server-sliced
``.gcode.3mf``. Queued before the slice ends, the item waits in ``slicing`` (listed,
never dispatched) and follows the slice: ``pending`` on the G-code, or ``slice_failed``
with a retry. A printer never receives the unsliced source. The sidecar is an httpx
``MockTransport``: no test reaches a real slicer.
"""

from __future__ import annotations

import asyncio
from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select, update

from backend.app.api.routes.library import to_absolute_path
from backend.app.core import database
from backend.app.models.library import LibraryFile
from backend.app.models.print_batch import PrintBatch, PrintBatchPlate
from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant
from backend.app.models.project_item import ProjectRevision
from backend.app.services import project_slice
from backend.app.services.print_scheduler import PrintScheduler
from backend.app.services.slice_dispatch import slice_dispatch
from backend.tests.integration.test_project_slice import (  # noqa: F401  # fixtures
    _wait_job,
    roots,
    sidecar,
    test_engine,
)
from backend.tests.project_fixtures import (
    threemf_bytes,
    wal_engine_fixture,  # noqa: F401  # the ``wal_engine`` fixture
)


async def _upload(client: AsyncClient, filename: str = "support.3mf", content: bytes | None = None) -> dict:
    """A project revision holding one file; upload-triggered slicing stays off (conftest)."""
    project = (await client.post("/api/v1/projects/", json={"name": "Support caméra"})).json()
    item = (
        await client.post(f"/api/v1/projects/{project['id']}/items", json={"section": "impression", "name": "Support"})
    ).json()
    up = await client.post(
        f"/api/v1/projects/items/{item['id']}/revisions",
        files=[("files", (filename, content if content is not None else threemf_bytes(), "application/octet-stream"))],
    )
    assert up.status_code == 201, up.text
    return up.json()["revision"]


async def _slice_now(client: AsyncClient, revision_id: int) -> int:
    started = await client.post(f"/api/v1/projects/revisions/{revision_id}/slice")
    assert started.status_code == 202, started.text
    job_id = started.json()["job_id"]
    await _wait_job(job_id)
    return job_id


async def _queue(client: AsyncClient, file_id: int, **extra) -> dict:
    response = await client.post("/api/v1/queue/", json={"library_file_id": file_id, **extra})
    assert response.status_code == 200, response.text
    return response.json()


async def _revision(db, revision_id: int) -> ProjectRevision:
    db.expire_all()
    return await db.get(ProjectRevision, revision_id)


async def _item(db, item_id: int) -> PrintQueueItem:
    db.expire_all()
    return await db.get(PrintQueueItem, item_id)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_print_sliced_revision_queues_gcode(async_client: AsyncClient, db_session, sidecar):
    rev = await _upload(async_client)
    source_id = rev["files"][0]["id"]
    await _slice_now(async_client, rev["id"])
    revision = await _revision(db_session, rev["id"])
    assert revision.slice_status == "sliced"

    out = await _queue(async_client, source_id)
    assert out["status"] == "pending"
    assert out["library_file_id"] == revision.sliced_file_id
    assert out["revision_id"] == rev["id"]
    assert out["slice_job_id"] is None
    assert out["print_time_seconds"] == 3600  # the sliced file's own estimate
    assert len(sidecar.slice_requests) == 1  # no second slice


@pytest.mark.asyncio
@pytest.mark.integration
async def test_print_while_slicing_creates_slicing_item_then_pending(async_client: AsyncClient, db_session, sidecar):
    rev = await _upload(async_client)
    source_id = rev["files"][0]["id"]
    sidecar.block = True
    started = (await async_client.post(f"/api/v1/projects/revisions/{rev['id']}/slice")).json()
    await asyncio.wait_for(sidecar.entered.wait(), timeout=10)

    first = await _queue(async_client, source_id, plate_id=1)
    second = await _queue(async_client, source_id, plate_id=2)
    for out in (first, second):
        assert out["status"] == "slicing"
        assert out["library_file_id"] == source_id
        assert out["slice_job_id"] == started["job_id"]

    listed = {i["id"]: i for i in (await async_client.get("/api/v1/queue/")).json()}
    assert {listed[first["id"]]["status"], listed[second["id"]]["status"]} == {"slicing"}
    assert listed[first["id"]]["slice_job_id"] == started["job_id"]
    assert listed[second["id"]]["slice_job_id"] == started["job_id"]
    assert len(sidecar.slice_requests) == 1  # queueing joined the running slice

    sidecar.release.set()
    await _wait_job(started["job_id"])

    sliced_id = (await _revision(db_session, rev["id"])).sliced_file_id
    assert sliced_id is not None
    for item_id, plate in ((first["id"], 1), (second["id"], 2)):
        item = await _item(db_session, item_id)
        assert (item.status, item.library_file_id, item.plate_id, item.error_message) == (
            "pending",
            sliced_id,
            plate,
            None,
        )
    listed = {i["id"]: i for i in (await async_client.get("/api/v1/queue/")).json()}
    assert listed[first["id"]]["slice_job_id"] is None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_print_unsliced_legacy_revision_starts_slice(async_client: AsyncClient, db_session, sidecar):
    rev = await _upload(async_client)
    assert rev["slice_status"] is None
    sidecar.block = True

    out = await _queue(async_client, rev["files"][0]["id"])
    assert out["status"] == "slicing"
    revision = await _revision(db_session, rev["id"])
    assert revision.slice_status == "slicing"
    assert revision.slice_job_id is not None
    assert out["slice_job_id"] == revision.slice_job_id

    sidecar.release.set()
    await _wait_job(revision.slice_job_id)
    item = await _item(db_session, out["id"])
    assert item.status == "pending"
    assert item.library_file_id == (await _revision(db_session, rev["id"])).sliced_file_id


@pytest.mark.asyncio
@pytest.mark.integration
async def test_slice_failure_marks_items_and_retry_recovers(async_client: AsyncClient, db_session, sidecar):
    rev = await _upload(async_client)
    source_id = rev["files"][0]["id"]
    sidecar.mode = "down"

    out = await _queue(async_client, source_id)
    first_job = (await _revision(db_session, rev["id"])).slice_job_id
    await _wait_job(first_job)
    item = await _item(db_session, out["id"])
    assert item.status == "slice_failed"
    assert item.error_message
    assert item.library_file_id == source_id

    sidecar.mode = "ok"
    sidecar.block = True
    retried = await async_client.post(f"/api/v1/queue/{out['id']}/retry-slice")
    assert retried.status_code == 200, retried.text
    body = retried.json()
    assert body["status"] == "slicing"
    assert body["error_message"] is None
    assert body["slice_job_id"] not in (None, first_job)

    sidecar.release.set()
    await _wait_job(body["slice_job_id"])
    item = await _item(db_session, out["id"])
    assert item.status == "pending"
    assert item.library_file_id == (await _revision(db_session, rev["id"])).sliced_file_id


@pytest.mark.asyncio
@pytest.mark.integration
async def test_retry_slice_refuses_an_item_that_did_not_fail(async_client: AsyncClient, sidecar):
    rev = await _upload(async_client)
    await _slice_now(async_client, rev["id"])
    out = await _queue(async_client, rev["files"][0]["id"])
    assert out["status"] == "pending"
    response = await async_client.post(f"/api/v1/queue/{out['id']}/retry-slice")
    assert response.status_code == 400
    assert (await async_client.post("/api/v1/queue/987654/retry-slice")).status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
async def test_slice_finished_between_check_and_insert(async_client: AsyncClient, db_session, sidecar, monkeypatch):
    """The slice lands (and its completion hook runs) before the new ``slicing`` item is committed:
    the hook found no item, so the queue route must settle the item itself."""
    rev = await _upload(async_client)
    real_start = project_slice.start_revision_slice
    real_hook = project_slice.on_revision_slice_done

    async def instant_start(db, revision_id, *, user_id):
        async def hook_saw_nothing(*_args, **_kwargs):
            return None

        monkeypatch.setattr(project_slice, "on_revision_slice_done", hook_saw_nothing)
        job_id = await real_start(db, revision_id, user_id=user_id)
        await _wait_job(job_id)
        monkeypatch.setattr(project_slice, "on_revision_slice_done", real_hook)
        return job_id

    monkeypatch.setattr(project_slice, "start_revision_slice", instant_start)

    out = await _queue(async_client, rev["files"][0]["id"])
    sliced_id = (await _revision(db_session, rev["id"])).sliced_file_id
    assert sliced_id is not None
    assert out["status"] == "pending"
    assert out["library_file_id"] == sliced_id
    item = await _item(db_session, out["id"])
    assert (item.status, item.library_file_id) == ("pending", sliced_id)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_slice_failed_between_check_and_insert(async_client: AsyncClient, db_session, sidecar, monkeypatch):
    rev = await _upload(async_client)
    sidecar.mode = "down"
    real_start = project_slice.start_revision_slice
    real_hook = project_slice.on_revision_slice_done

    async def instant_start(db, revision_id, *, user_id):
        async def hook_saw_nothing(*_args, **_kwargs):
            return None

        monkeypatch.setattr(project_slice, "on_revision_slice_done", hook_saw_nothing)
        job_id = await real_start(db, revision_id, user_id=user_id)
        await _wait_job(job_id)
        monkeypatch.setattr(project_slice, "on_revision_slice_done", real_hook)
        return job_id

    monkeypatch.setattr(project_slice, "start_revision_slice", instant_start)

    out = await _queue(async_client, rev["files"][0]["id"])
    assert out["status"] == "slice_failed"
    assert out["error_message"]
    assert (await _item(db_session, out["id"])).status == "slice_failed"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_scheduler_ignores_slicing_items(async_client: AsyncClient, db_session, sidecar, printer_factory):
    printer = await printer_factory()
    rev = await _upload(async_client)
    sidecar.block = True
    waiting = await _queue(async_client, rev["files"][0]["id"], printer_id=printer.id)
    assert waiting["status"] == "slicing"

    scheduler = PrintScheduler()
    launched = MagicMock()
    start_print = AsyncMock()
    patches = [
        patch("backend.app.services.print_scheduler.async_session", database.async_session),
        patch("backend.app.services.print_scheduler.printer_manager.is_connected", MagicMock(return_value=True)),
        patch("backend.app.services.print_scheduler.printer_manager.get_status", MagicMock(return_value=None)),
        patch(
            "backend.app.services.print_scheduler.printer_manager.is_awaiting_plate_clear",
            MagicMock(return_value=False),
        ),
        patch("backend.app.services.print_scheduler.ha_sensor_manager.blocked_printers", AsyncMock(return_value={})),
        patch("backend.app.services.notification_service.notification_service.on_queue_job_waiting", AsyncMock()),
        patch("backend.app.services.notification_service.notification_service.on_queue_job_assigned", AsyncMock()),
        patch.object(scheduler, "_is_printer_idle", MagicMock(return_value=True)),
        patch.object(scheduler, "_check_auto_drying", AsyncMock()),
        patch.object(scheduler, "_ensure_ams_mapping", AsyncMock(return_value=None)),
        patch.object(scheduler, "_block_on_filament_deficit", AsyncMock(return_value=False)),
        patch.object(scheduler, "_get_smart_plugs", AsyncMock(return_value=[])),
        patch.object(scheduler, "_launch_uploads", launched),
        patch.object(scheduler, "_start_print", start_print),
    ]
    with ExitStack() as stack:
        for p in patches:
            stack.enter_context(p)
        await scheduler.check_queue()

    launched_ids = launched.call_args[0][0] if launched.called else []
    assert waiting["id"] not in launched_ids
    start_print.assert_not_called()
    assert (await _item(db_session, waiting["id"])).status == "slicing"

    sidecar.release.set()
    await _wait_job(waiting["slice_job_id"])


@pytest.mark.asyncio
@pytest.mark.integration
async def test_legacy_gcode_3mf_revision_unchanged(async_client: AsyncClient, db_session, sidecar):
    """A revision filed before server slicing may hold a .gcode.3mf (uploads refuse them now): it prints as is."""
    rev = await _upload(async_client)
    legacy = LibraryFile(
        filename="plate.gcode.3mf",
        file_path="/library/plate.gcode.3mf",
        file_size=1,
        file_type="gcode.3mf",
        revision_id=rev["id"],
    )
    db_session.add(legacy)
    await db_session.commit()
    file_id = legacy.id

    out = await _queue(async_client, file_id)
    assert out["status"] == "pending"
    assert out["library_file_id"] == file_id
    assert sidecar.slice_requests == []
    assert (await _revision(db_session, rev["id"])).slice_status is None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_get_queue_accepts_new_statuses(async_client: AsyncClient, db_session):
    lib = LibraryFile(filename="a.3mf", file_path="/library/a.3mf", file_size=1, file_type="3mf")
    db_session.add(lib)
    await db_session.flush()
    db_session.add(PrintQueueItem(library_file_id=lib.id, status="slicing", position=1))
    db_session.add(PrintQueueItem(library_file_id=lib.id, status="slice_failed", position=2, error_message="boom"))
    await db_session.commit()

    response = await async_client.get("/api/v1/queue/")
    assert response.status_code == 200, response.text
    assert sorted(i["status"] for i in response.json()) == ["slice_failed", "slicing"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_cancel_a_slicing_item(async_client: AsyncClient, db_session, sidecar):
    rev = await _upload(async_client)
    sidecar.block = True
    out = await _queue(async_client, rev["files"][0]["id"])
    assert out["status"] == "slicing"

    response = await async_client.post(f"/api/v1/queue/{out['id']}/cancel")
    assert response.status_code == 200, response.text
    sidecar.release.set()
    await _wait_job(out["slice_job_id"])
    assert (await _item(db_session, out["id"])).status == "cancelled"  # the landing slice leaves it alone


@pytest.mark.asyncio
@pytest.mark.integration
async def test_waiting_items_keep_their_place_in_the_queue(async_client: AsyncClient, db_session, sidecar):
    """A ``slicing`` item holds a position in the one queue sequence, so an item queued after it
    lands below it rather than on the same position."""
    rev = await _upload(async_client)
    sidecar.block = True
    waiting = await _queue(async_client, rev["files"][0]["id"])
    plain = LibraryFile(
        filename="plate.gcode.3mf", file_path="/library/plate.gcode.3mf", file_size=1, file_type="gcode.3mf"
    )
    db_session.add(plain)
    await db_session.commit()
    after = await _queue(async_client, plain.id)
    assert after["position"] > waiting["position"]
    sidecar.release.set()
    await _wait_job(waiting["slice_job_id"])


@pytest.mark.asyncio
@pytest.mark.integration
async def test_variants_refuse_an_unsliced_project_source(async_client: AsyncClient, sidecar, printer_factory):
    await printer_factory(model="X1C")
    rev = await _upload(async_client)
    response = await async_client.post(
        "/api/v1/queue/",
        json={"variants": [{"library_file_id": rev["files"][0]["id"], "target_model": "X1C"}]},
    )
    assert response.status_code == 400, response.text
    assert sidecar.slice_requests == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_variants_use_the_sliced_file_of_a_sliced_revision(
    async_client: AsyncClient, db_session, sidecar, printer_factory
):
    await printer_factory(model="X1C")
    rev = await _upload(async_client)
    await _slice_now(async_client, rev["id"])
    sliced_id = (await _revision(db_session, rev["id"])).sliced_file_id

    response = await async_client.post(
        "/api/v1/queue/", json={"variants": [{"library_file_id": rev["files"][0]["id"]}]}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "pending"
    db_session.expire_all()
    variants = (
        (await db_session.execute(select(PrintQueueVariant).where(PrintQueueVariant.queue_item_id == body["id"])))
        .scalars()
        .all()
    )
    assert [v.library_file_id for v in variants] == [sliced_id]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_batch_dispatch_clones_a_slicing_item_as_slicing(async_client: AsyncClient, db_session, sidecar):
    """An order's re-dispatch clones its latest run; a clone of a run still waiting for its G-code
    waits too (a ``pending`` clone would point a printer at the unsliced source)."""
    rev = await _upload(async_client)
    sidecar.block = True
    out = await _queue(async_client, rev["files"][0]["id"], plate_id=1)
    batch = PrintBatch(name="Order", quantity=3, status="active")
    db_session.add(batch)
    await db_session.flush()
    db_session.add(PrintBatchPlate(batch_id=batch.id, plate_id=1, quantity_target=3, sort_order=0))
    item = await db_session.get(PrintQueueItem, out["id"])
    item.batch_id = batch_id = batch.id
    await db_session.commit()

    response = await async_client.post(f"/api/v1/queue/batches/{batch_id}/dispatch", json={})
    assert response.status_code == 200, response.text
    db_session.expire_all()
    rows = (await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.batch_id == batch_id))).scalars().all()
    assert len(rows) == 3
    assert {r.status for r in rows} == {"slicing"}

    sidecar.release.set()
    await _wait_job(out["slice_job_id"])
    sliced_id = (await _revision(db_session, rev["id"])).sliced_file_id
    db_session.expire_all()
    rows = (await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.batch_id == batch_id))).scalars().all()
    assert {(r.status, r.library_file_id) for r in rows} == {("pending", sliced_id)}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_cross_model_gate_runs_when_the_slice_lands(
    async_client: AsyncClient, db_session, sidecar, printer_factory
):
    """A "slicing" item skips the queue-time gate (no G-code yet); the landing slice applies it."""
    await printer_factory(model="X1C")
    await printer_factory(model="H2D")
    rev = await _upload(async_client)
    sidecar.block = True
    fits = await _queue(async_client, rev["files"][0]["id"], target_model="X1C")
    wrong = await _queue(async_client, rev["files"][0]["id"], target_model="H2D")
    assert {fits["status"], wrong["status"]} == {"slicing"}

    sidecar.release.set()
    await _wait_job(fits["slice_job_id"])
    item = await _item(db_session, fits["id"])
    assert item.status == "pending"
    item = await _item(db_session, wrong["id"])
    assert item.status == "slice_failed"
    assert "sliced for X1C" in item.error_message
    assert item.library_file_id == rev["files"][0]["id"]  # never pointed at G-code it cannot run


@pytest.mark.asyncio
@pytest.mark.integration
async def test_model_based_item_reads_filament_types_from_the_slice(
    async_client: AsyncClient, db_session, sidecar, printer_factory, monkeypatch
):
    from backend.app.api.routes import print_queue as print_queue_routes

    def types_of(path, plate_id=None):
        return ["PETG"] if str(path).endswith(".gcode.3mf") else []

    monkeypatch.setattr(print_queue_routes, "_extract_filament_types_from_3mf", types_of)
    await printer_factory(model="X1C")
    rev = await _upload(async_client)
    sidecar.block = True
    out = await _queue(async_client, rev["files"][0]["id"], target_model="X1C", plate_id=1)
    assert out["required_filament_types"] is None  # the source names none

    sidecar.release.set()
    await _wait_job(out["slice_job_id"])
    item = await _item(db_session, out["id"])
    assert item.status == "pending"
    assert item.required_filament_types == '["PETG"]'


async def _legacy_two_source_revision(client: AsyncClient, db) -> tuple[dict, int, int]:
    """A legacy revision holding two project ``.3mf`` files (uploads now take one): the slice is made
    from the first only (``project_slice._source_file``)."""
    rev = await _upload(client, "partA.3mf")
    part_a = await db.get(LibraryFile, rev["files"][0]["id"])
    a_path = Path(part_a.file_path)
    b_rel = str(a_path.with_name("partB.3mf"))
    b_abs = to_absolute_path(b_rel)
    b_abs.write_bytes(threemf_bytes())
    part_b = LibraryFile(filename="partB.3mf", file_path=b_rel, file_size=1, file_type="3mf", revision_id=rev["id"])
    db.add(part_b)
    await db.commit()
    return rev, rev["files"][0]["id"], part_b.id


@pytest.mark.asyncio
@pytest.mark.integration
async def test_only_the_revision_source_prints_as_its_slice(
    async_client: AsyncClient, db_session, sidecar, printer_factory
):
    """partB never prints partA's G-code: it is refused, sliced revision or not."""
    await printer_factory(model="X1C")
    rev, part_a, part_b = await _legacy_two_source_revision(async_client, db_session)

    # not sliced yet: partA waits, partB is refused (single and as an alternative)
    response = await async_client.post("/api/v1/queue/", json={"library_file_id": part_b})
    assert response.status_code == 400
    assert response.json()["detail"] == "This file is not the revision's source; upload it as its own item."
    response = await async_client.post(
        "/api/v1/queue/", json={"variants": [{"library_file_id": part_b, "target_model": "X1C"}]}
    )
    assert response.status_code == 400
    assert "not the revision's source" in response.json()["detail"]
    waiting = await _queue(async_client, part_a)
    assert waiting["status"] == "slicing"
    revision = await _revision(db_session, rev["id"])
    await _wait_job(revision.slice_job_id)
    sliced_id = (await _revision(db_session, rev["id"])).sliced_file_id
    item = await _item(db_session, waiting["id"])
    assert (item.status, item.library_file_id) == ("pending", sliced_id)

    # sliced: partA (single and variant) runs the slice, partB is still refused
    assert (await _queue(async_client, part_a))["library_file_id"] == sliced_id
    response = await async_client.post("/api/v1/queue/", json={"variants": [{"library_file_id": part_a}]})
    assert response.status_code == 200, response.text
    db_session.expire_all()
    (variant,) = (
        (
            await db_session.execute(
                select(PrintQueueVariant).where(PrintQueueVariant.queue_item_id == response.json()["id"])
            )
        )
        .scalars()
        .all()
    )
    assert variant.library_file_id == sliced_id
    assert (await async_client.post("/api/v1/queue/", json={"library_file_id": part_b})).status_code == 400
    response = await async_client.post(
        "/api/v1/queue/", json={"variants": [{"library_file_id": part_b, "target_model": "X1C"}]}
    )
    assert response.status_code == 400
    assert len(sidecar.slice_requests) == 1


@pytest.mark.asyncio
@pytest.mark.integration
async def test_landing_slice_moves_only_items_on_the_source(async_client: AsyncClient, db_session, sidecar):
    """An item already waiting on another ``.3mf`` of the revision (e.g. inserted before this rule)
    is not moved onto the source's G-code."""
    rev, part_a, part_b = await _legacy_two_source_revision(async_client, db_session)
    db_session.add(PrintQueueItem(library_file_id=part_b, status="slicing", position=1, revision_id=rev["id"]))
    await db_session.commit()
    stray = (
        await db_session.execute(select(PrintQueueItem.id).where(PrintQueueItem.library_file_id == part_b))
    ).scalar_one()

    waiting = await _queue(async_client, part_a)
    await _wait_job((await _revision(db_session, rev["id"])).slice_job_id)
    assert (await _item(db_session, waiting["id"])).status == "pending"
    item = await _item(db_session, stray)
    assert (item.status, item.library_file_id) == ("slicing", part_b)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_a_revision_3mf_with_no_project_is_refused(async_client: AsyncClient, db_session, sidecar):
    """A revision ``.3mf`` that is neither G-code nor a project has nothing to slice: refused, not queued."""
    rev = await _upload(async_client)
    source = await db_session.get(LibraryFile, rev["files"][0]["id"])
    to_absolute_path(source.file_path).write_bytes(b"PK\x05\x06" + b"\x00" * 18)  # an empty zip
    response = await async_client.post("/api/v1/queue/", json={"library_file_id": rev["files"][0]["id"]})
    assert response.status_code == 400
    assert "no Bambu Studio project" in response.json()["detail"]
    assert sidecar.slice_requests == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_slice_failing_on_a_missing_source_fails_the_waiting_items(
    async_client: AsyncClient, db_session, sidecar
):
    """The source ``.3mf`` vanishes from disk while an item waits on it: the failed slice moves the
    item to ``slice_failed`` with the reason (it used to stay ``slicing`` forever)."""
    rev = await _upload(async_client)
    source_id = rev["files"][0]["id"]
    source_path = to_absolute_path((await db_session.get(LibraryFile, source_id)).file_path)
    db_session.add(PrintQueueItem(library_file_id=source_id, status="slicing", position=1, revision_id=rev["id"]))
    (await _revision(db_session, rev["id"])).slice_status = "slicing"
    await db_session.commit()
    source_path.unlink()

    with pytest.raises(Exception):  # noqa: B017  # the job's own error
        await project_slice._run_slice(rev["id"], user_id=None, job_id=0)

    db_session.expire_all()
    item = (await db_session.execute(select(PrintQueueItem))).scalar_one()
    item_id = item.id
    assert (item.status, item.error_message) == ("slice_failed", "The revision's source .3mf is missing")
    assert item.library_file_id == source_id
    assert (await _revision(db_session, rev["id"])).slice_status == "failed"
    assert sidecar.slice_requests == []
    retried = await async_client.post(f"/api/v1/queue/{item_id}/retry-slice")
    # a retry needs a source to slice: refused with the reason while it is gone, the item stays removable
    assert retried.status_code == 400
    assert "not the revision's source" in retried.json()["detail"]
    assert (await async_client.delete(f"/api/v1/queue/{item_id}")).status_code == 200


async def _slicing_item_on(db, file_id: int) -> int:
    item = PrintQueueItem(library_file_id=file_id, status="slicing", position=1)
    db.add(item)
    await db.commit()
    return item.id


@pytest.mark.asyncio
@pytest.mark.integration
async def test_settle_fails_items_when_the_sliced_file_is_gone(async_client: AsyncClient, db_session, sidecar):
    """A ``sliced`` revision whose G-code row is soft-deleted has nothing to run: the waiting item fails."""
    rev = await _upload(async_client)
    source_id = rev["files"][0]["id"]
    await _slice_now(async_client, rev["id"])
    sliced_id = (await _revision(db_session, rev["id"])).sliced_file_id
    item_id = await _slicing_item_on(db_session, source_id)
    sliced = await db_session.get(LibraryFile, sliced_id)
    sliced.deleted_at = datetime.now(timezone.utc)
    await db_session.commit()

    await project_slice.settle_waiting_queue_items(db_session, rev["id"])
    item = await _item(db_session, item_id)
    assert (item.status, item.error_message) == ("slice_failed", "The revision's sliced file is gone")
    assert item.library_file_id == source_id


@pytest.mark.asyncio
@pytest.mark.integration
async def test_settle_fails_items_when_the_sliced_file_id_is_unset(async_client: AsyncClient, db_session, sidecar):
    rev = await _upload(async_client)
    source_id = rev["files"][0]["id"]
    await _slice_now(async_client, rev["id"])
    item_id = await _slicing_item_on(db_session, source_id)
    (await _revision(db_session, rev["id"])).sliced_file_id = None
    await db_session.commit()

    await project_slice.settle_waiting_queue_items(db_session, rev["id"])
    item = await _item(db_session, item_id)
    assert (item.status, item.error_message) == ("slice_failed", "The revision's sliced file is gone")


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize(("slice_error", "expected"), [(None, "The slice could not start"), ("boom", "boom")])
async def test_settle_fails_items_of_a_revision_that_never_started_a_slice(
    async_client: AsyncClient, db_session, sidecar, slice_error, expected
):
    rev = await _upload(async_client)
    item_id = await _slicing_item_on(db_session, rev["files"][0]["id"])
    revision = await _revision(db_session, rev["id"])
    assert revision.slice_status is None
    revision.slice_error = slice_error
    await db_session.commit()

    await project_slice.settle_waiting_queue_items(db_session, rev["id"])
    item = await _item(db_session, item_id)
    assert (item.status, item.error_message) == ("slice_failed", expected)


async def _failed_items_on_source(db, printer_factory, async_client: AsyncClient):
    """A revision whose source has three ``slice_failed`` items: the caller's own, another user's, and one
    on a printer outside the caller's scope. Returns (revision, caller, own_id, other_id, out_of_scope_id, in_scope_printer)."""
    from backend.app.models.user import User

    rev = await _upload(async_client)
    source_id = rev["files"][0]["id"]
    caller = User(username="retrier", role="user")
    other = User(username="someone-else", role="user")
    db.add_all([caller, other])
    await db.flush()
    mine = await printer_factory()
    outside = await printer_factory()
    ids = []
    for owner, printer in ((caller, mine), (other, mine), (caller, outside)):
        item = PrintQueueItem(
            library_file_id=source_id,
            status="slice_failed",
            error_message="boom",
            position=1,
            revision_id=rev["id"],
            created_by_id=owner.id,
            printer_id=printer.id,
        )
        db.add(item)
        await db.flush()
        ids.append(item.id)
    await db.commit()
    # the route only reads ``user.id``; a plain object survives the route's own commits
    return rev, SimpleNamespace(id=caller.id), ids, mine


@pytest.mark.asyncio
@pytest.mark.integration
async def test_retry_slice_update_own_user_only_rearms_their_in_scope_items(
    async_client: AsyncClient, db_session, printer_factory, sidecar
):
    from backend.app.api.routes.print_queue import retry_queue_item_slice
    from backend.app.core.printer_scope import PrinterScope

    sidecar.block = True
    rev, caller, (own_id, other_id, outside_id), mine = await _failed_items_on_source(
        db_session, printer_factory, async_client
    )
    caller_id = caller.id

    await retry_queue_item_slice(
        own_id,
        db=db_session,
        auth_result=(caller, False),
        can_read_aito=True,
        printer_scope=PrinterScope(frozenset({mine.id})),
        actor=None,
    )

    assert (await _item(db_session, own_id)).status == "slicing"
    other = await _item(db_session, other_id)
    assert (other.status, other.error_message) == ("slice_failed", "boom")  # another user's job
    outside = await _item(db_session, outside_id)
    assert (outside.status, outside.error_message) == ("slice_failed", "boom")  # printer outside the scope
    assert outside.created_by_id == caller_id
    sidecar.release.set()
    await _wait_job((await _revision(db_session, rev["id"])).slice_job_id)
    assert (await _item(db_session, own_id)).status == "pending"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_retry_slice_update_all_user_rearms_every_item(
    async_client: AsyncClient, db_session, printer_factory, sidecar
):
    from backend.app.api.routes.print_queue import retry_queue_item_slice
    from backend.app.core.printer_scope import PrinterScope

    sidecar.block = True
    rev, caller, ids, _mine = await _failed_items_on_source(db_session, printer_factory, async_client)

    await retry_queue_item_slice(
        ids[0],
        db=db_session,
        auth_result=(caller, True),
        can_read_aito=True,
        printer_scope=PrinterScope(),
        actor=None,
    )

    for item_id in ids:
        assert (await _item(db_session, item_id)).status == "slicing"
    sidecar.release.set()
    await _wait_job((await _revision(db_session, rev["id"])).slice_job_id)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_retry_slice_hides_the_aito_task_without_aito_read(
    async_client: AsyncClient, db_session, printer_factory, sidecar
):
    from backend.app.api.routes.print_queue import retry_queue_item_slice
    from backend.app.core.printer_scope import PrinterScope
    from backend.app.models.aito_project import AitoProject
    from backend.app.models.aito_task import AitoTask

    sidecar.block = True
    rev, caller, (own_id, _other_id, _outside_id), mine = await _failed_items_on_source(
        db_session, printer_factory, async_client
    )
    order = AitoProject(description="Porte-canettes", board_column="print", client_name="Teva", due_date="2026-10-18")
    db_session.add(order)
    await db_session.flush()
    task = AitoTask(project_id=order.id, title="Porte-canettes", impression_quantity=6)
    db_session.add(task)
    await db_session.flush()
    mine_id, task_id = mine.id, task.id
    (await _item(db_session, own_id)).aito_task_id = task_id
    await db_session.commit()
    aito_fields = ("aito_task_id", "aito_task_title", "aito_client_name", "aito_due_date", "aito_quantity")

    async def retry(can_read_aito: bool):
        (await _item(db_session, own_id)).status = "slice_failed"
        await db_session.commit()
        return await retry_queue_item_slice(
            own_id,
            db=db_session,
            auth_result=(caller, True),
            can_read_aito=can_read_aito,
            printer_scope=PrinterScope(frozenset({mine_id})),
            actor=None,
        )

    visible = await retry(True)
    assert (visible.aito_task_id, visible.aito_task_title, visible.aito_client_name) == (
        task_id,
        "Porte-canettes",
        "Teva",
    )
    assert visible.aito_quantity == 6
    hidden = await retry(False)
    assert [getattr(hidden, name) for name in aito_fields] == [None] * 5
    sidecar.release.set()
    await _wait_job((await _revision(db_session, rev["id"])).slice_job_id)


async def _race_waiting_items(monkeypatch, name: str, cancel_id: int, delete_id: int, *, on_call: int = 1) -> None:
    """After the slice reads its waiting items, a user cancels one and deletes another (what PostgreSQL's
    READ COMMITTED allows between the SELECT and the write; the slice's own transaction stands in here)."""
    real = getattr(project_slice, name)
    calls = []

    async def raced(db, *args, **kwargs):
        items = await real(db, *args, **kwargs)
        calls.append(1)
        if len(calls) != on_call:
            return items
        await db.execute(
            update(PrintQueueItem)
            .where(PrintQueueItem.id == cancel_id)
            .values(status="cancelled")
            .execution_options(synchronize_session=False)
        )
        await db.execute(
            delete(PrintQueueItem).where(PrintQueueItem.id == delete_id).execution_options(synchronize_session=False)
        )
        return items

    monkeypatch.setattr(project_slice, name, raced)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_landing_slice_leaves_an_item_cancelled_or_deleted_meanwhile_alone(
    async_client: AsyncClient, db_session, sidecar, monkeypatch
):
    rev = await _upload(async_client)
    sidecar.block = True
    started = (await async_client.post(f"/api/v1/projects/revisions/{rev['id']}/slice")).json()
    await asyncio.wait_for(sidecar.entered.wait(), timeout=10)
    cancelled, deleted, kept_one, kept_two = [
        (await _queue(async_client, rev["files"][0]["id"], plate_id=n))["id"] for n in (1, 2, 3, 4)
    ]
    # the landing slice reads its items twice: ahead of the write lock (file reads), then to write them
    await _race_waiting_items(monkeypatch, "_waiting_items", cancelled, deleted, on_call=2)

    sidecar.release.set()
    await _wait_job(started["job_id"])

    assert slice_job_status(started["job_id"]) == "completed"  # a deleted item no longer fails the slice
    revision = await _revision(db_session, rev["id"])
    assert revision.slice_status == "sliced"
    sliced_id = revision.sliced_file_id
    cancelled_item = await _item(db_session, cancelled)
    assert (cancelled_item.status, cancelled_item.library_file_id) == ("cancelled", rev["files"][0]["id"])
    assert await _item(db_session, deleted) is None
    for item_id in (kept_one, kept_two):
        item = await _item(db_session, item_id)
        assert (item.status, item.library_file_id, item.print_time_seconds) == (
            "pending",
            sliced_id,
            3600,
        )


@pytest.mark.asyncio
@pytest.mark.integration
async def test_failing_slice_leaves_an_item_cancelled_or_deleted_meanwhile_alone(
    async_client: AsyncClient, db_session, sidecar, monkeypatch
):
    rev = await _upload(async_client)
    source_id = rev["files"][0]["id"]
    rows = [
        PrintQueueItem(library_file_id=source_id, status="slicing", position=n, revision_id=rev["id"])
        for n in (1, 2, 3)
    ]
    db_session.add_all(rows)
    (await _revision(db_session, rev["id"])).slice_status = "slicing"
    await db_session.commit()
    cancelled, deleted, kept = (row.id for row in rows)
    await _race_waiting_items(monkeypatch, "_slicing_items_of_revision", cancelled, deleted)
    sidecar.mode = "down"

    with pytest.raises(Exception):  # noqa: B017  # the job's own error
        await project_slice._run_slice(rev["id"], user_id=None, job_id=0)

    assert (await _revision(db_session, rev["id"])).slice_status == "failed"
    assert (await _item(db_session, cancelled)).status == "cancelled"
    assert await _item(db_session, deleted) is None
    item = await _item(db_session, kept)
    assert (item.status, bool(item.error_message)) == ("slice_failed", True)


def slice_job_status(job_id: int) -> str | None:
    job = slice_dispatch.get(job_id)
    return job.status if job is not None else None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_landing_slice_reads_its_files_once_per_plate_before_the_write_lock(
    async_client: AsyncClient, db_session, sidecar, printer_factory, monkeypatch
):
    from backend.app.api.routes import print_queue as print_queue_routes

    type_reads: list[int | None] = []
    time_reads: list[tuple[int | None, int | None]] = []  # (plate, id of the sliced row: None = not flushed yet)
    real_time = project_slice.library_file_print_time

    def types_of(path, plate_id=None):
        type_reads.append(plate_id)
        return ["PETG"]

    def time_of(library_file, plate_id):
        time_reads.append((plate_id, library_file.id))
        return real_time(library_file, plate_id)

    monkeypatch.setattr(print_queue_routes, "_extract_filament_types_from_3mf", types_of)
    monkeypatch.setattr(project_slice, "library_file_print_time", time_of)
    await printer_factory(model="X1C")
    rev = await _upload(async_client)
    sidecar.block = True
    started = (await async_client.post(f"/api/v1/projects/revisions/{rev['id']}/slice")).json()
    await asyncio.wait_for(sidecar.entered.wait(), timeout=10)
    ids = [
        (await _queue(async_client, rev["files"][0]["id"], target_model="X1C", plate_id=plate))["id"]
        for plate in (1, 1, 1, 2, 2)
    ]
    type_reads.clear()  # queueing read the source; only the landing slice's reads count
    time_reads.clear()
    real_read = project_slice._read_outcome_facts

    async def read_then_a_late_item(db, revision_id, sliced_file):
        facts = await real_read(db, revision_id, sliced_file)
        late = PrintQueueItem(
            library_file_id=rev["files"][0]["id"],
            status="slicing",
            position=99,
            revision_id=rev["id"],
            plate_id=7,
            target_model="X1C",
        )
        db.add(late)
        await db.flush()
        ids.append(late.id)
        return facts

    monkeypatch.setattr(project_slice, "_read_outcome_facts", read_then_a_late_item)

    sidecar.release.set()
    await _wait_job(started["job_id"])

    assert sorted(type_reads) == [1, 2, 7]  # one read per plate, the late plate on first use
    assert sorted(plate for plate, _ in time_reads) == [1, 2, 7]
    assert [row_id is None for plate, row_id in time_reads if plate in (1, 2)] == [True, True]  # before the flush
    for item_id in ids:
        item = await _item(db_session, item_id)
        assert (item.status, item.print_time_seconds, item.required_filament_types) == ("pending", 3600, '["PETG"]')


@pytest.mark.asyncio
@pytest.mark.integration
async def test_an_unreadable_plate_leaves_only_its_items_filament_types_as_they_were(
    async_client: AsyncClient, db_session, sidecar, printer_factory, monkeypatch, caplog
):
    from backend.app.api.routes import print_queue as print_queue_routes

    def types_of(path, plate_id=None):
        if not str(path).endswith(".gcode.3mf"):
            return []  # queue time reads the source
        if plate_id == 2:
            raise ValueError("unreadable plate")
        return ["PETG"]

    monkeypatch.setattr(print_queue_routes, "_extract_filament_types_from_3mf", types_of)
    await printer_factory(model="X1C")
    rev = await _upload(async_client)
    sidecar.block = True
    good = await _queue(async_client, rev["files"][0]["id"], target_model="X1C", plate_id=1)
    bad = await _queue(async_client, rev["files"][0]["id"], target_model="X1C", plate_id=2)

    sidecar.release.set()
    await _wait_job(good["slice_job_id"])

    assert (await _item(db_session, good["id"])).required_filament_types == '["PETG"]'
    item = await _item(db_session, bad["id"])
    assert (item.status, item.required_filament_types) == ("pending", None)
    assert f"Queue item {bad['id']}: unreadable filament types" in caplog.text
