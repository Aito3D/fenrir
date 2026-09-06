"""T-026: the one-time migration in `run_migrations` (core/database.py) adds
`quote_status_confirmed` to `aito_projects` — a plain additive `ALTER TABLE`
with no backfill DML (unlike, say, `flag`'s urgent->flag copy), mirroring
`quote_invoiced`'s own migration shape. `_safe_execute` already swallows
"duplicate column" on a second boot, so idempotency here is about the ALTER
never erroring on a second `run_migrations` call and never disturbing a row
that has since been set True by application code — not about a backfill gate.

Modelled on `test_aito_unmanaged_backfill_migration.py`'s fixture shape: most
tests run against a freshly created, already-current schema (the column
already exists, so the ALTER hits "duplicate column" and is swallowed). One
test builds a schema shaped like a database that ran every migration up to
but not including this one, so the column-newness path is exercised for real.
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
    """A schema shaped like a database that ran every migration up to but not
    including this one: `quote_status_confirmed` (present on the current
    model) is dropped back off, so `run_migrations`'s own
    `ALTER TABLE ... ADD COLUMN quote_status_confirmed` genuinely adds it
    rather than hitting "duplicate column"."""
    engine = await _make_engine()
    async with engine.begin() as conn:
        await conn.execute(text("ALTER TABLE aito_projects DROP COLUMN quote_status_confirmed"))
    return engine


async def _seed(conn, description):
    await conn.execute(
        text(
            "INSERT INTO aito_projects (description, board_column, position, status) VALUES (:d, 'devis', 0, 'active')"
        ),
        {"d": description},
    )
    return (await conn.execute(text("SELECT MAX(id) FROM aito_projects"))).scalar_one()


@pytest.mark.asyncio
async def test_column_is_added_and_defaults_false_on_first_ever_migration():
    engine = await _make_pre_feature_engine()
    try:
        async with engine.begin() as conn:
            project_id = await _seed(conn, "Piece preexistante")

        async with engine.begin() as conn:
            await run_migrations(conn)  # first-ever boot: column newly added

        async with engine.connect() as conn:
            confirmed = (
                await conn.execute(
                    text("SELECT quote_status_confirmed FROM aito_projects WHERE id = :p"), {"p": project_id}
                )
            ).scalar_one()
        assert confirmed == 0
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_migration_is_idempotent_across_a_second_boot_and_preserves_a_confirmed_row():
    """A second `run_migrations` call (an ordinary restart) must not error on
    the already-present column, and must not disturb a row the application has
    since confirmed True."""
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            confirmed_id = await _seed(conn, "Piece confirmee")
            unconfirmed_id = await _seed(conn, "Piece non confirmee")
            await conn.execute(
                text("UPDATE aito_projects SET quote_status_confirmed = 1 WHERE id = :p"), {"p": confirmed_id}
            )

        async with engine.begin() as conn:
            await run_migrations(conn)  # second boot: an ordinary restart

        async with engine.connect() as conn:
            rows = dict(
                (
                    await conn.execute(
                        text("SELECT id, quote_status_confirmed FROM aito_projects WHERE id IN (:a, :b)"),
                        {"a": confirmed_id, "b": unconfirmed_id},
                    )
                ).all()
            )
        assert rows[confirmed_id] == 1
        assert rows[unconfirmed_id] == 0
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_a_freshly_created_row_defaults_to_unconfirmed():
    """The server_default applies even without going through `run_migrations`
    at all — a fresh install's `create_all` already carries it, matching the
    ORM's own `default=False`."""
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            project_id = await _seed(conn, "Piece toute neuve")

        async with engine.connect() as conn:
            confirmed = (
                await conn.execute(
                    text("SELECT quote_status_confirmed FROM aito_projects WHERE id = :p"), {"p": project_id}
                )
            ).scalar_one()
        assert confirmed == 0
    finally:
        await engine.dispose()
