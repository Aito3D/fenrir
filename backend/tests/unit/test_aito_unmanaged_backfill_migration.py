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


async def _seed(conn, description, *, quote_sync_state, quote_id, status="active"):
    await conn.execute(
        text(
            "INSERT INTO aito_projects (description, board_column, position, status, quote_sync_state, quote_id) "
            "VALUES (:d, 'devis', 0, :st, :s, :q)"
        ),
        {"d": description, "st": status, "s": quote_sync_state, "q": quote_id},
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


@pytest.mark.asyncio
async def test_a_card_that_reaches_idle_with_no_quote_id_after_the_first_boot_survives_a_second_boot():
    """Critical: idle + quote_id-NULL is not only the pre-feature legacy
    shape at migration time — it is ALSO the live shape `sync_project`'s
    trashed-never-quoted branch deliberately leaves a project of ours in
    (see `aito_quote_sync.sync_project`'s quote-less-deleted branch). A card
    created, trashed before its first sync tick runs, and ticked to 'idle'
    with `quote_id` still NULL — all of that happening AFTER the first boot's
    backfill already ran — must not be swept into 'unmanaged' by a later
    restart or deploy. Before the gate, this UPDATE re-ran on every call to
    `run_migrations` and would reclassify this row on the second boot,
    permanently blocking restore + re-quote with no error and no UI signal —
    reopening the exact bug this backfill exists to close."""
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            await run_migrations(conn)  # first boot: nothing to backfill yet

        # Between boots: a card of ours is created, trashed before its first
        # sync tick, and ticked to idle + quote_id-NULL by sync_project's
        # quote-less-deleted branch — still ours, not legacy.
        async with engine.begin() as conn:
            owned = await _seed(conn, "Piece annulee avant tick", quote_sync_state="idle", quote_id=None)

        async with engine.begin() as conn:
            await run_migrations(conn)  # second boot: a restart/deploy

        async with engine.connect() as conn:
            state = (
                await conn.execute(text("SELECT quote_sync_state FROM aito_projects WHERE id = :p"), {"p": owned})
            ).scalar_one()
        assert state == "idle"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_a_trashed_card_is_never_marked_unmanaged_even_on_the_first_pass():
    """Defence in depth: even on the one-shot backfill pass, a card sitting
    in the trash must never be claimed — `status != 'deleted'` guards against
    reclassifying a trashed card regardless of the idle/quote_id ambiguity
    the rest of this migration resolves."""
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            trashed = await _seed(
                conn, "Piece a la corbeille", quote_sync_state="idle", quote_id=None, status="deleted"
            )

        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            state = (
                await conn.execute(text("SELECT quote_sync_state FROM aito_projects WHERE id = :p"), {"p": trashed})
            ).scalar_one()
        assert state == "idle"
    finally:
        await engine.dispose()
