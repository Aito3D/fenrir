"""Critical 1 fix, backfill half: rows that are `quote_sync_state = 'idle'`
AND `quote_id IS NULL` today are pre-feature legacy cards — the one-time
migration in `run_migrations` (core/database.py) marks them 'unmanaged' so
the (now explicit-ownership) sync guard leaves them alone forever, matching
what the OLD, inferred-ownership guard already did for them by accident.

Runs against a freshly created, already-current schema (so every ALTER TABLE
`run_migrations` issues hits "duplicate column" and is swallowed) — this test
only cares about the DML backfill, not the DDL around it.
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


async def _seed(conn, description, *, quote_sync_state, quote_id):
    await conn.execute(
        text(
            "INSERT INTO aito_projects (description, board_column, position, status, quote_sync_state, quote_id) "
            "VALUES (:d, 'devis', 0, 'active', :s, :q)"
        ),
        {"d": description, "s": quote_sync_state, "q": quote_id},
    )
    return (await conn.execute(text("SELECT MAX(id) FROM aito_projects"))).scalar_one()


@pytest.mark.asyncio
async def test_idle_quote_less_rows_are_backfilled_to_unmanaged():
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            legacy = await _seed(conn, "Vieille piece", quote_sync_state="idle", quote_id=None)

        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            state = (
                await conn.execute(text("SELECT quote_sync_state FROM aito_projects WHERE id = :p"), {"p": legacy})
            ).scalar_one()
        assert state == "unmanaged"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_idle_rows_with_a_quote_id_are_left_alone():
    """A project that genuinely finished a push (idle + quote_id set) must
    not be swept into 'unmanaged' by the backfill — only the quote_id-less
    shape is the legacy signature."""
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            synced = await _seed(conn, "Piece suivie", quote_sync_state="idle", quote_id="E1")

        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            state = (
                await conn.execute(text("SELECT quote_sync_state FROM aito_projects WHERE id = :p"), {"p": synced})
            ).scalar_one()
        assert state == "idle"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_pending_and_error_rows_are_left_alone():
    """Only 'idle' + quote_id-NULL is the legacy signature — a project mid
    outbox ('pending') or stuck on a real failure ('error') is unambiguously
    ours and must not be reclassified."""
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            pending = await _seed(conn, "En cours", quote_sync_state="pending", quote_id=None)
            errored = await _seed(conn, "En echec", quote_sync_state="error", quote_id=None)

        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            rows = dict(
                (
                    await conn.execute(
                        text("SELECT id, quote_sync_state FROM aito_projects WHERE id IN (:a, :b)"),
                        {"a": pending, "b": errored},
                    )
                ).all()
            )
        assert rows[pending] == "pending"
        assert rows[errored] == "error"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_backfill_is_idempotent_across_a_second_boot():
    """A second `run_migrations` call must not re-touch a row the first call
    already backfilled, nor sweep up a project that reached 'idle' with a
    quote_id AFTER the first boot (the ordinary, expected shape of a
    successfully-synced project)."""
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            legacy = await _seed(conn, "Vieille piece", quote_sync_state="idle", quote_id=None)

        async with engine.begin() as conn:
            await run_migrations(conn)

        # Between boots, an unrelated project of ours finishes a real sync.
        async with engine.begin() as conn:
            synced_after = await _seed(conn, "Piece suivie", quote_sync_state="idle", quote_id="E2")

        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            rows = dict(
                (
                    await conn.execute(
                        text("SELECT id, quote_sync_state FROM aito_projects WHERE id IN (:a, :b)"),
                        {"a": legacy, "b": synced_after},
                    )
                ).all()
            )
        assert rows[legacy] == "unmanaged"
        assert rows[synced_after] == "idle"
    finally:
        await engine.dispose()
