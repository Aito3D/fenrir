"""Existing projects predate the event table; without this every card opens
onto an empty rail and looks broken rather than new.

Only project.created is synthesised. The Zoho side needs no backfill at all --
Books has kept its comments since the quote was written, so the mirror fills
that in on the first poll.
"""

from datetime import datetime

import pytest
from sqlalchemy import select, text

from backend.app.models.aito_event import AitoEvent


@pytest.mark.asyncio
async def test_backfill_uses_the_projects_own_created_at_not_the_migration_run_time(db_session):
    """occurred_at must come from the project's own created_at, not
    CURRENT_TIMESTAMP at migration time -- otherwise every backfilled card
    would claim to have been created today, defeating the whole point of
    seeding history for old projects."""
    from backend.app.core.database import _backfill_aito_events

    await db_session.execute(
        text(
            "INSERT INTO aito_projects (id, description, board_column, position, status, created_by, created_at) "
            "VALUES (1, 'Old', 'devis', 0, 'active', 'paul', '2020-03-15 08:30:00')"
        )
    )
    await db_session.commit()

    conn = await db_session.connection()
    await _backfill_aito_events(conn)
    await db_session.commit()

    event = (await db_session.execute(select(AitoEvent).where(AitoEvent.project_id == 1))).scalar_one()
    assert event.occurred_at == datetime(2020, 3, 15, 8, 30, 0)


@pytest.mark.asyncio
async def test_backfill_seeds_one_created_event_per_project(db_session):
    from backend.app.core.database import _backfill_aito_events

    await db_session.execute(
        text(
            "INSERT INTO aito_projects (id, description, board_column, position, status, created_by, created_at) "
            "VALUES (1, 'Old', 'devis', 0, 'active', 'paul', '2026-01-02 10:00:00')"
        )
    )
    await db_session.commit()

    conn = await db_session.connection()
    await _backfill_aito_events(conn)
    await db_session.commit()

    events = (await db_session.execute(select(AitoEvent).where(AitoEvent.project_id == 1))).scalars().all()
    assert len(events) == 1
    assert events[0].kind == "project.created"
    assert events[0].actor_name == "paul"


@pytest.mark.asyncio
async def test_backfill_is_idempotent(db_session):
    """run_migrations runs on every boot. A second pass must not double every
    project's history."""
    from backend.app.core.database import _backfill_aito_events

    await db_session.execute(
        text(
            "INSERT INTO aito_projects (id, description, board_column, position, status, created_at) "
            "VALUES (1, 'Old', 'devis', 0, 'active', '2026-01-02 10:00:00')"
        )
    )
    await db_session.commit()

    conn = await db_session.connection()
    await _backfill_aito_events(conn)
    await _backfill_aito_events(conn)
    await db_session.commit()

    events = (await db_session.execute(select(AitoEvent).where(AitoEvent.project_id == 1))).scalars().all()
    assert len(events) == 1
