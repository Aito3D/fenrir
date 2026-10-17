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
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.api.routes.library import to_absolute_path
from backend.app.core import database
from backend.app.models.library import LibraryFile
from backend.app.models.print_batch import PrintBatch, PrintBatchPlate
from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant
from backend.app.models.project_item import ProjectRevision
from backend.app.services import project_slice
from backend.app.services.print_scheduler import PrintScheduler
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
