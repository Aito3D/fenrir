"""The `filament_vendor` column on print_archives (calculator brand matching)
is added by an additive ALTER TABLE in `run_migrations`. These tests prove:

- a pre-feature database (no column) gains it on the next boot, with existing
  rows intact and their vendor NULL until a rescan backfills it;
- the migration is idempotent — a second boot must not fail or reset data.

Modelled on test_aito_flag_migration.py: schema built from the current models
via Base.metadata.create_all, then reshaped to look pre-feature by dropping
the column (SQLite ≥3.35 supports DROP COLUMN)."""

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


async def _column_names(conn) -> set[str]:
    rows = await conn.execute(text("PRAGMA table_info(print_archives)"))
    return {row[1] for row in rows.fetchall()}


async def _make_pre_feature_engine():
    engine = await _make_engine()
    async with engine.begin() as conn:
        await conn.execute(text("ALTER TABLE print_archives DROP COLUMN filament_vendor"))
        assert "filament_vendor" not in await _column_names(conn)
    return engine


async def _seed_archive(conn, filename: str) -> int:
    await conn.execute(
        text(
            "INSERT INTO print_archives "
            "(filename, file_path, file_size, status, filament_type, is_favorite, wallet_charge_skipped, quantity) "
            "VALUES (:f, 'archives/x.3mf', 1, 'completed', 'PLA', 0, 0, 1)"
        ),
        {"f": filename},
    )
    return (await conn.execute(text("SELECT MAX(id) FROM print_archives"))).scalar_one()


@pytest.mark.asyncio
async def test_pre_feature_database_gains_the_column():
    engine = await _make_pre_feature_engine()
    try:
        async with engine.begin() as conn:
            archive_id = await _seed_archive(conn, "old.gcode.3mf")

        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            assert "filament_vendor" in await _column_names(conn)
            row = (
                await conn.execute(
                    text("SELECT filament_type, filament_vendor FROM print_archives WHERE id = :i"),
                    {"i": archive_id},
                )
            ).one()
        # Existing rows survive with vendor NULL (backfilled per archive by rescan).
        assert row[0] == "PLA"
        assert row[1] is None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_migration_is_idempotent_and_preserves_data():
    engine = await _make_pre_feature_engine()
    try:
        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.begin() as conn:
            archive_id = await _seed_archive(conn, "new.gcode.3mf")
            await conn.execute(
                text("UPDATE print_archives SET filament_vendor = 'SUNLU' WHERE id = :i"),
                {"i": archive_id},
            )

        # Second boot: ALTER hits "duplicate column" and must be swallowed,
        # leaving the stored vendor untouched.
        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            vendor = (
                await conn.execute(text("SELECT filament_vendor FROM print_archives WHERE id = :i"), {"i": archive_id})
            ).scalar_one()
        assert vendor == "SUNLU"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_fresh_database_already_has_the_column():
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            assert "filament_vendor" in await _column_names(conn)
            await run_migrations(conn)  # must not fail on the pre-existing column
            assert "filament_vendor" in await _column_names(conn)
    finally:
        await engine.dispose()
