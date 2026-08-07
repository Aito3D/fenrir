"""Critical fix: the one-time migration in `run_migrations` (core/database.py)
backfills the new three-state `flag` column from the dead `urgent` boolean on
Aito projects.

`run_migrations` runs on every application startup, and nothing ever writes
the dead `urgent` column again once `flag` replaces it — `urgent` is frozen at
whatever it was pre-migration, forever. So the backfill UPDATE must be gated
on the `flag` column not having existed yet (via `_column_exists`, captured
before the `ALTER TABLE` that adds it), NOT on `AND flag IS NULL`. The latter
looks idempotent but is not: the moment an operator clears a flag in the UI,
`flag` goes back to NULL while the frozen `urgent` is still TRUE, and the next
restart would silently resurrect the flag the operator just cleared, with no
timeline event.

Modelled on `test_aito_unmanaged_backfill_migration.py`'s fixture shape: most
tests run against a freshly created, already-current schema (`flag` already
exists, so the ALTER hits "duplicate column" and the backfill gate is closed).
The pre-feature tests instead build a schema shaped like a database that ran
every migration up to and including `urgent` but never `flag`, so the
column-newness gate is exercised for real.
"""

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import Base, run_migrations


async def _make_engine():
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
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine


async def _make_pre_feature_engine():
    """A schema shaped like a database that ran every migration up to and
    including `urgent`, but never the `flag` migration: `flag` (present on
    the current model) is dropped back off, and `urgent` (absent from the
    current model, but what the older migration would have added) is added
    back by hand, so `run_migrations`'s own `ALTER TABLE ... ADD COLUMN flag`
    genuinely adds it and the column-newness gate has something real to
    observe."""
    engine = await _make_engine()
    async with engine.begin() as conn:
        await conn.execute(text("ALTER TABLE aito_projects DROP COLUMN flag"))
        await conn.execute(text("ALTER TABLE aito_projects ADD COLUMN urgent BOOLEAN NOT NULL DEFAULT 0"))
    return engine


async def _seed_pre_feature(conn, description, *, urgent):
    await conn.execute(
        text(
            "INSERT INTO aito_projects (description, board_column, position, status, urgent) "
            "VALUES (:d, 'devis', 0, 'active', :u)"
        ),
        {"d": description, "u": 1 if urgent else 0},
    )
    return (await conn.execute(text("SELECT MAX(id) FROM aito_projects"))).scalar_one()


@pytest.mark.asyncio
async def test_urgent_project_is_backfilled_to_flag_urgent_on_first_ever_migration():
    engine = await _make_pre_feature_engine()
    try:
        async with engine.begin() as conn:
            project_id = await _seed_pre_feature(conn, "Piece urgente", urgent=True)

        async with engine.begin() as conn:
            await run_migrations(conn)  # first-ever boot: `flag` column newly added

        async with engine.connect() as conn:
            flag = (
                await conn.execute(text("SELECT flag FROM aito_projects WHERE id = :p"), {"p": project_id})
            ).scalar_one()
        assert flag == "urgent"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_non_urgent_project_is_left_unflagged_on_first_ever_migration():
    engine = await _make_pre_feature_engine()
    try:
        async with engine.begin() as conn:
            project_id = await _seed_pre_feature(conn, "Piece normale", urgent=False)

        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            flag = (
                await conn.execute(text("SELECT flag FROM aito_projects WHERE id = :p"), {"p": project_id})
            ).scalar_one()
        assert flag is None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_operator_cleared_flag_survives_a_restart():
    """Critical: an operator clearing a flag in the UI must not be undone by
    the next application restart. `urgent` never gets rewritten once `flag`
    exists, so a naive `AND flag IS NULL` re-run guard would see the still-TRUE
    `urgent` value and resurrect a flag the operator explicitly cleared. The
    fix gates the backfill on the `flag` column's newness instead, so it runs
    exactly once — on the boot that adds the column — and never again."""
    engine = await _make_pre_feature_engine()
    try:
        async with engine.begin() as conn:
            project_id = await _seed_pre_feature(conn, "Piece urgente", urgent=True)

        async with engine.begin() as conn:
            await run_migrations(conn)  # first-ever boot: backfilled to 'urgent'

        async with engine.connect() as conn:
            flag = (
                await conn.execute(text("SELECT flag FROM aito_projects WHERE id = :p"), {"p": project_id})
            ).scalar_one()
        assert flag == "urgent"

        # The operator clears the flag by hand in the UI.
        async with engine.begin() as conn:
            await conn.execute(text("UPDATE aito_projects SET flag = NULL WHERE id = :p"), {"p": project_id})

        async with engine.begin() as conn:
            await run_migrations(conn)  # second boot: an ordinary restart

        async with engine.connect() as conn:
            flag = (
                await conn.execute(text("SELECT flag FROM aito_projects WHERE id = :p"), {"p": project_id})
            ).scalar_one()
        assert flag is None, "restart silently resurrected a flag the operator cleared"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_backfill_does_not_rerun_once_the_flag_column_already_exists():
    """Ordinary idempotency check on the common path: a database that already
    has the `flag` column (i.e. every boot after the first) must not re-touch
    rows at all, whatever `urgent` says — the column-existence gate should
    already have closed by the time `_make_engine`'s current-schema fixture is
    used."""
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO aito_projects (description, board_column, position, status, flag) "
                    "VALUES ('Piece suivie', 'devis', 0, 'active', NULL)"
                )
            )
            project_id = (await conn.execute(text("SELECT MAX(id) FROM aito_projects"))).scalar_one()

        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            flag = (
                await conn.execute(text("SELECT flag FROM aito_projects WHERE id = :p"), {"p": project_id})
            ).scalar_one()
        assert flag is None
    finally:
        await engine.dispose()
