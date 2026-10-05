"""Aito task ↔ project link schema (spec §1.6)."""

import io

import pytest
from fastapi import UploadFile
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.aito_task_delivery import AitoTaskDelivery
from backend.app.models.project import Project
from backend.app.services import project_storage
from backend.app.services.project_files import add_revision, create_item, revision_is_used


@pytest.fixture(autouse=True)
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(project_storage, "projects_root", lambda: tmp_path)


async def _order_task(db, project_id=None):
    order = AitoProject(description="Commande", board_column="devis", status="active")
    db.add(order)
    await db.flush()
    task = AitoTask(project_id=order.id, title="Support", linked_project_id=project_id)
    db.add(task)
    await db.flush()
    return order, task


@pytest.mark.asyncio
async def test_task_link_column_and_delivery_table(db_session):
    project = Project(name="P")
    db_session.add(project)
    await db_session.flush()
    _order, task = await _order_task(db_session, project.id)
    assert task.linked_project_id == project.id
    db_session.add(AitoTaskDelivery(task_id=task.id, revision_id=123))
    await db_session.flush()
    assert (await db_session.execute(select(AitoTaskDelivery))).scalar_one().task_id == task.id


@pytest.mark.asyncio
async def test_delivered_revision_is_used(db_session):
    project = Project(name="P")
    db_session.add(project)
    await db_session.flush()
    item = await create_item(db_session, project, section="impression", name="Support", user_id=None)
    await db_session.commit()
    rev, _ = await add_revision(
        db_session,
        project,
        item,
        [UploadFile(filename="p.3mf", file=io.BytesIO(b"x"))],
        note=None,
        derived_from_id=None,
        user_id=None,
    )
    assert not await revision_is_used(db_session, rev.id)
    _order, task = await _order_task(db_session, project.id)
    db_session.add(AitoTaskDelivery(task_id=task.id, revision_id=rev.id))
    await db_session.flush()
    assert await revision_is_used(db_session, rev.id)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_project_with_linked_task_cannot_be_deleted(async_client: AsyncClient, db_session):
    project = (await async_client.post("/api/v1/projects/", json={"name": "Lié"})).json()
    await _order_task(db_session, project["id"])
    await db_session.commit()
    response = await async_client.delete(f"/api/v1/projects/{project['id']}")
    assert response.status_code == 409
