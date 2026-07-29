"""AitoProject model: defaults, soft-delete status, autoincrement ids."""

import pytest
from sqlalchemy import select

from backend.app.models.aito_project import AitoProject


@pytest.mark.asyncio
async def test_aito_project_defaults(db_session):
    p = AitoProject(description="Boîtier PETG", board_column="devis", position=0)
    db_session.add(p)
    await db_session.commit()
    await db_session.refresh(p)

    assert p.id is not None
    assert p.status == "active"
    assert p.client_id is None
    assert p.created_at is not None
    assert p.updated_at is not None


@pytest.mark.asyncio
async def test_aito_project_ids_increment(db_session):
    a = AitoProject(description="a", board_column="devis", position=0)
    b = AitoProject(
        description="b",
        board_column="print",
        position=0,
        client_id="123",
        client_name="ACME",
        client_phone="+33 6 00 00 00 00",
    )
    db_session.add_all([a, b])
    await db_session.commit()
    ids = (await db_session.execute(select(AitoProject.id).order_by(AitoProject.id))).scalars().all()
    assert ids[1] > ids[0]


@pytest.mark.asyncio
async def test_sync_columns_default_to_idle_and_zero(db_session):
    project = AitoProject(description="x", board_column="devis", position=0)
    db_session.add(project)
    await db_session.flush()
    await db_session.refresh(project)

    assert project.quote_sync_state == "idle"
    assert project.quote_sync_failures == 0
    assert project.quote_synced_at is None
    assert project.quote_sync_error is None
    assert project.quote_status_before_trash is None
