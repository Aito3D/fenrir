"""The 2026-07-29 Aito board migration: reconstruct step history from columns.

The back-fill runs against a raw connection with the OLD column set already in
the table, which is why these tests build rows with plain SQL rather than the
ORM — the model no longer knows the word 'pickup'.
"""

import pytest
from sqlalchemy import text

from backend.app.core.database import _migrate_aito_board_columns


async def _seed(conn, board_column, **task_costs):
    await conn.execute(
        text(
            "INSERT INTO aito_projects (description, board_column, position, status, quote_sync_state) "
            "VALUES (:d, :c, 0, 'active', 'idle')"
        ),
        {"d": f"card in {board_column}", "c": board_column},
    )
    project_id = (await conn.execute(text("SELECT MAX(id) FROM aito_projects"))).scalar_one()
    columns = ", ".join(task_costs)
    placeholders = ", ".join(f":{k}" for k in task_costs)
    await conn.execute(
        text(f"INSERT INTO aito_tasks (project_id, position, {columns}) VALUES (:pid, 0, {placeholders})"),
        {"pid": project_id, **task_costs},
    )
    return project_id


@pytest.mark.asyncio
async def test_backfill_reconstructs_flags_from_the_stored_column(raw_conn):
    in_model = await _seed(raw_conn, "model", scan_cost=1.0, modelisation_cost=1.0)
    in_print = await _seed(raw_conn, "print", scan_cost=1.0, modelisation_cost=1.0, impression_cost=1.0)
    in_devis = await _seed(raw_conn, "devis", scan_cost=1.0)

    await _migrate_aito_board_columns(raw_conn)

    async def flags(project_id):
        row = (
            await raw_conn.execute(
                text(
                    "SELECT scan_done, modelisation_done, impression_done, usinage_done "
                    "FROM aito_tasks WHERE project_id = :p"
                ),
                {"p": project_id},
            )
        ).one()
        return tuple(bool(v) for v in row)

    assert await flags(in_model) == (True, False, False, False)
    assert await flags(in_print) == (True, True, False, False)
    assert await flags(in_devis) == (False, False, False, False)


@pytest.mark.asyncio
async def test_backfill_marks_cards_past_devis_as_accepted(raw_conn):
    past = await _seed(raw_conn, "print", impression_cost=1.0)
    waiting = await _seed(raw_conn, "devis", scan_cost=1.0)

    await _migrate_aito_board_columns(raw_conn)

    async def status(project_id):
        return (
            await raw_conn.execute(text("SELECT quote_status FROM aito_projects WHERE id = :p"), {"p": project_id})
        ).scalar_one()

    assert await status(past) == "accepted"
    assert await status(waiting) is None


@pytest.mark.asyncio
async def test_backfill_leaves_a_declined_quote_alone_and_sends_it_to_done(raw_conn):
    declined = await _seed(raw_conn, "print", impression_cost=1.0)
    await raw_conn.execute(text("UPDATE aito_projects SET quote_status = 'declined' WHERE id = :p"), {"p": declined})

    await _migrate_aito_board_columns(raw_conn)

    row = (
        await raw_conn.execute(
            text("SELECT quote_status, board_column FROM aito_projects WHERE id = :p"), {"p": declined}
        )
    ).one()
    assert row[0] == "declined"
    assert row[1] == "done"


@pytest.mark.asyncio
async def test_an_imported_sent_quote_sorts_itself_into_waiting(raw_conn):
    """The migration never writes 'waiting'. Leaving a devis card's status
    alone is what lets the rules sort it on the re-derive pass."""
    sent = await _seed(raw_conn, "devis", scan_cost=1.0)
    await raw_conn.execute(text("UPDATE aito_projects SET quote_status = 'sent' WHERE id = :p"), {"p": sent})

    await _migrate_aito_board_columns(raw_conn)

    column = (
        await raw_conn.execute(text("SELECT board_column FROM aito_projects WHERE id = :p"), {"p": sent})
    ).scalar_one()
    assert column == "waiting"


@pytest.mark.asyncio
async def test_pickup_cards_land_on_finish_with_everything_ticked(raw_conn):
    picked = await _seed(raw_conn, "pickup", scan_cost=1.0, impression_cost=1.0, usinage_cost=1.0)

    await _migrate_aito_board_columns(raw_conn)

    column = (
        await raw_conn.execute(text("SELECT board_column FROM aito_projects WHERE id = :p"), {"p": picked})
    ).scalar_one()
    assert column == "finish"

    flags = (
        await raw_conn.execute(
            text("SELECT scan_done, impression_done, usinage_done FROM aito_tasks WHERE project_id = :p"),
            {"p": picked},
        )
    ).one()
    assert all(bool(v) for v in flags)


@pytest.mark.asyncio
async def test_every_project_satisfies_the_rules_afterwards(raw_conn):
    """The migration leaves the board self-consistent under the new rules, not
    merely close to its old shape."""
    await _seed(raw_conn, "devis", scan_cost=1.0)
    await _seed(raw_conn, "model", scan_cost=1.0, modelisation_cost=1.0)
    await _seed(raw_conn, "print", impression_cost=1.0)
    await _seed(raw_conn, "finish", scan_cost=1.0)

    await _migrate_aito_board_columns(raw_conn)

    rows = (await raw_conn.execute(text("SELECT id, quote_status, board_column FROM aito_projects"))).all()
    for project_id, quote_status, column in rows:
        tasks = (
            await raw_conn.execute(
                text(
                    "SELECT scan_cost, scan_done, modelisation_cost, modelisation_done, "
                    "impression_cost, impression_done, usinage_cost, usinage_done "
                    "FROM aito_tasks WHERE project_id = :p"
                ),
                {"p": project_id},
            )
        ).all()
        pending = set()
        names = ("scan", "modelisation", "impression", "usinage")
        for task in tasks:
            for index, name in enumerate(names):
                if task[index * 2] is not None and not task[index * 2 + 1]:
                    pending.add(name)
        from backend.app.services.aito_board_rules import evaluate

        assert evaluate(quote_status, column, pending)[0] == column
