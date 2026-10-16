"""Queue items carry `revision_id` / `aito_task_id` as bare integers. The
timeline hover card shows the project, revision and client behind a bar, so
the queue list resolves those ids into display fields in bulk.
"""

import pytest
from httpx import AsyncClient

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision


async def _seed(db_session):
    printer = Printer(name="P", serial_number="S-TRACE-SUM", ip_address="127.0.0.1", access_code="x", model="X1C")
    project = Project(name="Monster can holders", code="PRJ-0142")
    db_session.add_all([printer, project])
    await db_session.flush()
    item = ProjectItem(project_id=project.id, section="impression", name="Can holder lid", name_key="can holder lid")
    db_session.add(item)
    await db_session.flush()
    rev = ProjectRevision(item_id=item.id, number=3, status="valide")
    order = AitoProject(
        description="Porte-canettes",
        board_column="print",
        client_name="Teva Marchand",
        due_date="2026-10-18",
    )
    db_session.add_all([rev, order])
    await db_session.flush()
    task = AitoTask(project_id=order.id, title="Porte-canettes ×6", impression_quantity=6)
    archive = PrintArchive(
        printer_id=printer.id, filename="a.3mf", file_path="archives/a.3mf", file_size=1, status="completed"
    )
    db_session.add_all([task, archive])
    await db_session.flush()
    return printer, archive, rev, task


@pytest.mark.asyncio
async def test_list_resolves_project_revision_and_client(async_client: AsyncClient, db_session):
    printer, archive, rev, task = await _seed(db_session)
    db_session.add(
        PrintQueueItem(printer_id=printer.id, archive_id=archive.id, revision_id=rev.id, aito_task_id=task.id)
    )
    await db_session.commit()

    rows = (await async_client.get("/api/v1/queue/")).json()
    assert len(rows) == 1
    row = rows[0]
    assert row["project_code"] == "PRJ-0142"
    assert row["project_name"] == "Monster can holders"
    assert row["revision_item_name"] == "Can holder lid"
    assert row["revision_number"] == 3
    assert row["revision_status"] == "valide"
    assert row["aito_task_title"] == "Porte-canettes ×6"
    assert row["aito_client_name"] == "Teva Marchand"
    assert row["aito_due_date"] == "2026-10-18"
    assert row["aito_quantity"] == 6
    assert row["aito_board_column"] == "print"


@pytest.mark.asyncio
async def test_list_leaves_summary_null_without_links(async_client: AsyncClient, db_session):
    printer, archive, _rev, _task = await _seed(db_session)
    db_session.add(PrintQueueItem(printer_id=printer.id, archive_id=archive.id))
    await db_session.commit()

    row = (await async_client.get("/api/v1/queue/")).json()[0]
    for key in ("project_code", "project_name", "revision_number", "aito_task_title", "aito_client_name"):
        assert row[key] is None


@pytest.mark.asyncio
async def test_list_survives_dangling_ids(async_client: AsyncClient, db_session):
    """A deleted revision or task leaves the integer behind; the list must
    not 500 and must not invent names."""
    printer, archive, _rev, _task = await _seed(db_session)
    db_session.add(PrintQueueItem(printer_id=printer.id, archive_id=archive.id, revision_id=9999, aito_task_id=9999))
    await db_session.commit()

    response = await async_client.get("/api/v1/queue/")
    assert response.status_code == 200
    row = response.json()[0]
    assert row["revision_id"] == 9999
    assert row["project_name"] is None
    assert row["aito_client_name"] is None


@pytest.mark.asyncio
async def test_get_single_item_resolves_too(async_client: AsyncClient, db_session):
    printer, archive, rev, task = await _seed(db_session)
    item = PrintQueueItem(printer_id=printer.id, archive_id=archive.id, revision_id=rev.id, aito_task_id=task.id)
    db_session.add(item)
    await db_session.commit()

    row = (await async_client.get(f"/api/v1/queue/{item.id}")).json()
    assert row["project_code"] == "PRJ-0142"
    assert row["aito_client_name"] == "Teva Marchand"
