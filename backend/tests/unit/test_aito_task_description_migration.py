"""The 2026-08-03 Aito task-description migration: the legacy task-level
description is copied onto the FIRST enabled service (scan -> modelisation ->
impression -> usinage). Raw SQL against raw_conn, in the style of
test_aito_board_migration.py — the legacy column is re-added by hand so these
tests keep passing once the ORM model drops it."""

import pytest
from sqlalchemy import text

from backend.app.core.database import _migrate_aito_task_descriptions, _safe_execute


async def _seed(conn, description, **task_costs):
    await conn.execute(
        text(
            "INSERT INTO aito_projects (description, board_column, position, status, quote_sync_state) "
            "VALUES ('card', 'devis', 0, 'active', 'idle')"
        )
    )
    project_id = (await conn.execute(text("SELECT MAX(id) FROM aito_projects"))).scalar_one()
    columns = ", ".join(["description", *task_costs])
    placeholders = ", ".join([":description", *(f":{k}" for k in task_costs)])
    await conn.execute(
        text(f"INSERT INTO aito_tasks (project_id, position, {columns}) VALUES (:pid, 0, {placeholders})"),
        {"pid": project_id, "description": description, **task_costs},
    )
    return (await conn.execute(text("SELECT MAX(id) FROM aito_tasks"))).scalar_one()


async def _descriptions(conn, task_id):
    row = (
        await conn.execute(
            text(
                "SELECT scan_description, modelisation_description, impression_description, usinage_description "
                "FROM aito_tasks WHERE id = :t"
            ),
            {"t": task_id},
        )
    ).one()
    return tuple(row)


@pytest.fixture(autouse=True)
async def _legacy_column(raw_conn):
    # No-op while the ORM still maps `description`; re-adds it once Task 4
    # drops it from the model (and therefore from create_all's schema).
    await _safe_execute(raw_conn, "ALTER TABLE aito_tasks ADD COLUMN description TEXT")


@pytest.mark.asyncio
async def test_description_lands_on_the_first_enabled_service(raw_conn):
    on_scan = await _seed(raw_conn, "note A", scan_cost=1.0, impression_cost=2.0)
    on_impression = await _seed(raw_conn, "note B", impression_cost=2.0, usinage_cost=3.0)
    on_usinage = await _seed(raw_conn, "note C", usinage_cost=3.0)

    await _migrate_aito_task_descriptions(raw_conn)

    assert await _descriptions(raw_conn, on_scan) == ("note A", None, None, None)
    assert await _descriptions(raw_conn, on_impression) == (None, None, "note B", None)
    assert await _descriptions(raw_conn, on_usinage) == (None, None, None, "note C")


@pytest.mark.asyncio
async def test_no_enabled_service_copies_nothing(raw_conn):
    task_id = await _seed(raw_conn, "orphan note")
    await _migrate_aito_task_descriptions(raw_conn)
    assert await _descriptions(raw_conn, task_id) == (None, None, None, None)


@pytest.mark.asyncio
async def test_blank_description_copies_nothing(raw_conn):
    task_id = await _seed(raw_conn, "   ", scan_cost=1.0)
    await _migrate_aito_task_descriptions(raw_conn)
    assert await _descriptions(raw_conn, task_id) == (None, None, None, None)
