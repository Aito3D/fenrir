"""The 2026-09-20 Main d'œuvre migration: three additive columns on
aito_tasks. No backfill — no existing task can carry a labour step."""

from sqlalchemy import text


async def test_maindoeuvre_columns_exist_after_migrations(raw_conn):
    row = (
        await raw_conn.execute(
            text("SELECT maindoeuvre_cost, maindoeuvre_description, maindoeuvre_done FROM aito_tasks WHERE 1 = 0")
        )
    ).all()
    assert row == []


async def test_existing_row_reads_null_cost_and_false_done(raw_conn):
    await raw_conn.execute(
        text(
            "INSERT INTO aito_projects (description, board_column, position, status, quote_sync_state) "
            "VALUES ('card', 'devis', 0, 'active', 'idle')"
        )
    )
    project_id = (await raw_conn.execute(text("SELECT MAX(id) FROM aito_projects"))).scalar_one()
    await raw_conn.execute(
        text("INSERT INTO aito_tasks (project_id, position, scan_cost) VALUES (:p, 0, 100)"),
        {"p": project_id},
    )
    task_id = (await raw_conn.execute(text("SELECT MAX(id) FROM aito_tasks"))).scalar_one()
    cost, description, done = (
        await raw_conn.execute(
            text("SELECT maindoeuvre_cost, maindoeuvre_description, maindoeuvre_done FROM aito_tasks WHERE id = :t"),
            {"t": task_id},
        )
    ).one()
    assert cost is None
    assert description is None
    assert not done
