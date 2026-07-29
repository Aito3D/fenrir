"""Critical 1 fix, backfill half: the one-time migration in `run_migrations`
(core/database.py) marks pre-feature legacy cards 'unmanaged' so the (now
explicit-ownership) sync guard leaves them alone forever.

`quote_sync_state == 'idle' AND quote_id IS NULL` is NOT a reliable signal of
"pre-feature legacy card" on its own — it is also the live shape a card of
ours can be in (see `aito_quote_sync.sync_project`'s trashed-never-quoted
branch). The only reliable signal is *when* the row is seen: if
`quote_sync_state` did not exist as a column before this boot, every row in
the table predates the feature and is unconditionally legacy, trashed or not.
If the column already existed, the idle/quote_id-NULL shape is ambiguous and
must be left alone.

Most tests here run against a freshly created, already-current schema (so
every ALTER TABLE `run_migrations` issues hits "duplicate column" and is
swallowed, and the `quote_sync_state` column already exists) — these only
care about the DML backfill's idempotency, not the DDL around it. The
first-pass tests instead build the schema *without* `quote_sync_state` so the
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


async def _seed(conn, description, *, quote_sync_state, quote_id, status="active"):
    await conn.execute(
        text(
            "INSERT INTO aito_projects (description, board_column, position, status, quote_sync_state, quote_id) "
            "VALUES (:d, 'devis', 0, :st, :s, :q)"
        ),
        {"d": description, "st": status, "s": quote_sync_state, "q": quote_id},
    )
    return (await conn.execute(text("SELECT MAX(id) FROM aito_projects"))).scalar_one()


async def _make_pre_feature_engine():
    """A schema shaped like a database that has never run this feature's
    migration: everything current EXCEPT the `quote_sync_state` column
    itself, so `run_migrations`'s own `ALTER TABLE ... ADD COLUMN` genuinely
    adds it (rather than hitting "duplicate column" and being swallowed) and
    the column-newness gate has something real to observe."""
    engine = await _make_engine()
    async with engine.begin() as conn:
        await conn.execute(text("DROP INDEX IF EXISTS ix_aito_projects_quote_sync_state"))
        await conn.execute(text("ALTER TABLE aito_projects DROP COLUMN quote_sync_state"))
    return engine


async def _seed_pre_feature(conn, description, *, quote_id, status="active"):
    await conn.execute(
        text(
            "INSERT INTO aito_projects (description, board_column, position, status, quote_id) "
            "VALUES (:d, 'devis', 0, :st, :q)"
        ),
        {"d": description, "st": status, "q": quote_id},
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
async def test_a_trashed_legacy_card_is_marked_unmanaged_on_the_first_ever_migration():
    """On the one and only boot where this backfill actually matters in
    production — `quote_sync_state` did not exist before this call, so the
    ALTER TABLE above just created it — every row in the table predates the
    feature by definition, including cards already sitting in the trash: a
    trashed card is legacy by definition too, since ownership could not have
    existed before this migration ever ran. Excluding trashed rows here (the
    old `AND status != 'deleted'` behaviour) protected nothing on this pass
    and left every already-trashed legacy card stuck at 'idle' forever —
    restoring and editing one would enqueue a real `POST /estimates` for a
    card that was supposed to be untouchable."""
    engine = await _make_pre_feature_engine()
    try:
        async with engine.begin() as conn:
            trashed = await _seed_pre_feature(conn, "Piece a la corbeille (legacy)", quote_id=None, status="deleted")

        async with engine.begin() as conn:
            await run_migrations(conn)  # first-ever migration: column newly added

        async with engine.connect() as conn:
            state = (
                await conn.execute(text("SELECT quote_sync_state FROM aito_projects WHERE id = :p"), {"p": trashed})
            ).scalar_one()
        assert state == "unmanaged"
    finally:
        await engine.dispose()
