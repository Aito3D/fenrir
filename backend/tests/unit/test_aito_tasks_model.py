"""The aito_tasks table exists with the columns the API depends on."""

import pytest
from sqlalchemy import select

from backend.app.models.aito_task import AitoTask


@pytest.mark.asyncio
async def test_task_row_round_trips(db_session):
    task = AitoTask(
        project_id=1,
        position=0,
        title="Boîtier",
        scan_cost=4000.0,
        impression_printer_id=7,
        impression_filament_id=3,
        impression_weight_g=120.0,
        impression_time_min=270,
        impression_quantity=2,
        impression_color="Noir",
        impression_cost=8400.0,
    )
    db_session.add(task)
    await db_session.commit()

    row = (await db_session.execute(select(AitoTask))).scalar_one()
    assert row.title == "Boîtier"
    assert row.scan_cost == 4000.0
    # Unset services stay NULL — that is how "disabled" is stored.
    assert row.modelisation_cost is None
    assert row.usinage_cost is None
    assert row.impression_quantity == 2


@pytest.mark.asyncio
async def test_step_done_flags_default_to_false(db_session):
    """Four booleans mirroring the four cost columns. NOT NULL with a server
    default, so a row inserted without them reads False rather than None."""
    task = AitoTask(project_id=1, position=0, scan_cost=1200.0)
    db_session.add(task)
    await db_session.commit()
    await db_session.refresh(task)
    assert task.scan_done is False
    assert task.modelisation_done is False
    assert task.impression_done is False
    assert task.usinage_done is False


@pytest.mark.asyncio
async def test_step_done_flags_persist(db_session):
    task = AitoTask(project_id=1, position=0, scan_cost=0.0, scan_done=True)
    db_session.add(task)
    await db_session.commit()
    await db_session.refresh(task)
    assert task.scan_done is True
