"""The one-time repair for the 'invoiced' quote statuses the sync worker used
to store (`_heal_invoiced_quote_status` in core/database.py).

Books' status vocabulary is wider than the board's. Locking an estimate Books
had billed copied its literal 'invoiced' status over the project's own
'accepted', and `aito_board_rules.evaluate` reads anything that is not
'accepted' as "not authorised yet" — so a finished card fell into Devis, and
`_apply_rules` then persisted that column over the operator's manual Done.

The write paths are guarded now (see `test_aito_quote_status.py` and
`test_aito_quote_sync.py`); this covers the repair of rows already written.
"""

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import Base, run_migrations


async def _make_engine():
    from backend.app.models import (  # noqa: F401
        active_print_spoolman,
        aito_event,
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
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine


async def _seed(conn, description, *, quote_status, board_column, status="active"):
    await conn.execute(
        text(
            "INSERT INTO aito_projects (description, board_column, position, status, quote_status, quote_sync_state) "
            "VALUES (:d, :c, 0, :st, :qs, 'locked')"
        ),
        {"d": description, "c": board_column, "st": status, "qs": quote_status},
    )
    return (await conn.execute(text("SELECT MAX(id) FROM aito_projects"))).scalar_one()


async def _seed_task(conn, project_id, **fields):
    columns = ", ".join(fields)
    placeholders = ", ".join(f":{name}" for name in fields)
    await conn.execute(
        text(
            f"INSERT INTO aito_tasks (project_id, position, title, {columns}) "  # noqa: S608
            f"VALUES (:pid, 0, 'Piece', {placeholders})"
        ),
        {"pid": project_id, **fields},
    )


async def _read(conn, project_id):
    return (
        await conn.execute(
            text("SELECT quote_status, board_column FROM aito_projects WHERE id = :p"), {"p": project_id}
        )
    ).one()


@pytest.mark.asyncio
async def test_an_invoiced_status_is_healed_back_to_accepted():
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            project = await _seed(conn, "Logo casquette", quote_status="invoiced", board_column="devis")
            await _seed_task(conn, project, impression_cost=15000.0, impression_done=True)

        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            quote_status, board_column = await _read(conn, project)
        assert quote_status == "accepted"
        # Every step is ticked, so the rules put it back on the board's far
        # right. Finish, NOT Done: the stored column was the only record that
        # the operator had dragged it to Done, and this bug overwrote it — the
        # one thing the repair genuinely cannot recover.
        assert board_column == "finish"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_a_healed_card_returns_to_the_stage_its_steps_say():
    """The repair re-derives rather than guessing: a card with work still
    outstanding goes back to that work's column, not to Finish."""
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            project = await _seed(conn, "Cache poussiere", quote_status="invoiced", board_column="devis")
            await _seed_task(conn, project, scan_cost=3500.0, scan_done=False, modelisation_cost=6750.0)

        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            quote_status, board_column = await _read(conn, project)
        assert quote_status == "accepted"
        assert board_column == "scan"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_projects_with_a_real_status_are_left_alone():
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            declined = await _seed(conn, "Refuse", quote_status="declined", board_column="done")
            waiting = await _seed(conn, "En attente", quote_status="sent", board_column="waiting")
            fresh = await _seed(conn, "Sans devis", quote_status=None, board_column="devis")

        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            assert await _read(conn, declined) == ("declined", "done")
            assert await _read(conn, waiting) == ("sent", "waiting")
            assert await _read(conn, fresh) == (None, "devis")
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_a_trashed_card_is_healed_too_so_a_restore_lands_correctly():
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            project = await _seed(
                conn, "A la corbeille", quote_status="invoiced", board_column="devis", status="deleted"
            )
            await _seed_task(conn, project, impression_cost=1500.0, impression_done=True)

        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            quote_status, board_column = await _read(conn, project)
        assert quote_status == "accepted"
        assert board_column == "finish"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_the_repair_runs_once_and_a_later_boot_leaves_the_board_alone():
    """The marker is what makes this a repair rather than a standing rule. If
    'invoiced' is ever made a first-class board status, an ungated version
    would rewrite it away on every restart."""
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            marker = (
                await conn.execute(text("SELECT value FROM settings WHERE key = 'aito_invoiced_status_healed'"))
            ).scalar_one_or_none()
        assert marker == "1"

        async with engine.begin() as conn:
            later = await _seed(conn, "Facture plus tard", quote_status="invoiced", board_column="print")

        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            assert await _read(conn, later) == ("invoiced", "print")
    finally:
        await engine.dispose()
