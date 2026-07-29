"""The 2026-07-29 Aito board migration: reconstruct step history from columns.

The back-fill runs against a raw connection with the OLD column set already in
the table, which is why these tests build rows with plain SQL rather than the
ORM — the model no longer knows the word 'pickup'.
"""

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import Base, _migrate_aito_board_columns, run_migrations


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


@pytest.mark.asyncio
async def test_run_migrations_gate_survives_a_second_boot():
    """The one-time gate is `run_migrations`' capture-before-ALTER ordering of
    `_aito_steps_existed`, not anything inside `_migrate_aito_board_columns`
    itself — every test above calls that function directly and so cannot see
    that ordering. Drive this one through `run_migrations`, seeding an
    `aito_tasks` table that (like the real pre-2026-07-29 database) does not
    yet have the four `*_done` columns, so the first pass has to ADD them
    before the gate can even ask whether they existed.
    """
    # `run_migrations` touches nearly every table in the app; register them all
    # on Base.metadata the same way `init_db()` does, or unrelated ALTERs below
    # fail with "no such table" before the aito ones are ever reached.
    from backend.app.models import (  # noqa: F401
        active_print_spoolman,
        aito_project,
        aito_task,
        ams_history,
        ams_label,
        api_key,
        archive,
        auth_ephemeral,
        bug_report,
        calculator,
        color_catalog,
        external_link,
        filament,
        filament_sku_settings,
        github_backup,
        group,
        kprofile_note,
        library,
        local_preset,
        location,
        long_lived_token,
        maintenance,
        notification,
        notification_template,
        oidc_provider,
        orca_base_cache,
        pending_upload,
        pipeline_run,
        print_batch,
        print_log,
        print_queue,
        printer,
        printer_sensor_history,
        project,
        project_bom,
        settings,
        shopping_list,
        slicer_pipeline,
        slot_preset,
        smart_plug,
        smart_plug_energy_snapshot,
        spool,
        spool_assignment,
        spool_catalog,
        spool_k_profile,
        spool_usage_history,
        spoolbuddy_device,
        spoolman_k_profile,
        spoolman_slot_assignment,
        user,
        user_email_pref,
        user_otp_code,
        user_totp,
        virtual_printer,
    )

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            # Simulate the pre-migration schema: SQLite 3.35+ supports DROP COLUMN.
            for service in ("scan", "modelisation", "impression", "usinage"):
                await conn.execute(text(f"ALTER TABLE aito_tasks DROP COLUMN {service}_done"))

        async with engine.begin() as conn:
            project_id = await _seed(conn, "print", impression_cost=1.0)

        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            quote_status = (
                await conn.execute(text("SELECT quote_status FROM aito_projects WHERE id = :p"), {"p": project_id})
            ).scalar_one()
        # Evidence the back-fill actually ran on this first pass: a card
        # outside `devis` is accepted. If the capture-before-ALTER ordering
        # were broken this would stay NULL.
        assert quote_status == "accepted"

        # Between boots the user does real work: finishes the last step and
        # declines the quote.
        async with engine.begin() as conn:
            await conn.execute(
                text("UPDATE aito_tasks SET impression_done = 1 WHERE project_id = :p"), {"p": project_id}
            )
            await conn.execute(
                text("UPDATE aito_projects SET quote_status = 'declined' WHERE id = :p"), {"p": project_id}
            )

        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            quote_status = (
                await conn.execute(text("SELECT quote_status FROM aito_projects WHERE id = :p"), {"p": project_id})
            ).scalar_one()
            impression_done = (
                await conn.execute(
                    text("SELECT impression_done FROM aito_tasks WHERE project_id = :p"), {"p": project_id}
                )
            ).scalar_one()
        assert quote_status == "declined", "a second run must not re-accept a quote the user declined"
        assert bool(impression_done) is True, "a second run must not un-tick a step the user completed"
    finally:
        await engine.dispose()
