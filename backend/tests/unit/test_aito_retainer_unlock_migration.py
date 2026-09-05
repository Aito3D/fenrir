"""One-time unlock of quotes locked by a retainer invoice (2026-09-05).

`_is_locked` used to read Books' `is_transaction_created` as "invoiced", and a
retainer invoice (a deposit) sets that flag too. A locked project leaves the
sweep for good, so the rule fix alone would never revisit a quote already
locked that way. This migration resets every invoice-lock (locked with no
recorded reason -- a tax-exclusive lock always carries one) back to 'idle'
and clears the invoiced stamp; the next sweep tick re-reads each estimate and
re-locks the genuinely invoiced ones through the existing catch-up branch.

Gated by a settings marker: re-running it on every boot would un-lock a
genuinely invoiced quote for one tick after every restart.
"""

import pytest
from sqlalchemy import text

from backend.app.core.database import run_migrations
from backend.tests.unit.test_aito_unmanaged_backfill_migration import _make_engine


async def _seed(conn, description, *, quote_sync_state, quote_sync_error=None, quote_invoiced=True):
    await conn.execute(
        text(
            "INSERT INTO aito_projects "
            "(description, board_column, position, status, quote_sync_state, quote_id, quote_sync_error, quote_invoiced) "
            "VALUES (:d, 'devis', 0, 'active', :s, 'E1', :e, :i)"
        ),
        {"d": description, "s": quote_sync_state, "e": quote_sync_error, "i": quote_invoiced},
    )
    return (await conn.execute(text("SELECT MAX(id) FROM aito_projects"))).scalar_one()


async def _row(engine, project_id):
    async with engine.connect() as conn:
        return tuple(
            (
                await conn.execute(
                    text("SELECT quote_sync_state, quote_invoiced FROM aito_projects WHERE id = :p"),
                    {"p": project_id},
                )
            ).one()
        )


@pytest.mark.asyncio
async def test_invoice_locked_rows_are_reset_to_idle_and_uninvoiced():
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            locked = await _seed(conn, "Acompte", quote_sync_state="locked")

        async with engine.begin() as conn:
            await run_migrations(conn)

        assert await _row(engine, locked) == ("idle", 0)
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_a_stale_unrelated_error_does_not_shield_an_invoice_lock():
    """The sweep's catch-up lock leaves `quote_sync_error` untouched, so a
    row locked that way still carries whatever the last failed push wrote
    ("Zoho Books unreachable: ConnectError" on six live rows). That text is
    not a lock reason; only the tax-exclusive message is. The reset must
    read the message, not its mere presence -- and clear it, since it
    describes nothing current."""
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            stale = await _seed(
                conn, "Acompte", quote_sync_state="locked", quote_sync_error="Zoho Books unreachable: ConnectError"
            )

        async with engine.begin() as conn:
            await run_migrations(conn)

        assert await _row(engine, stale) == ("idle", 0)
        async with engine.connect() as conn:
            error = (
                await conn.execute(text("SELECT quote_sync_error FROM aito_projects WHERE id = :p"), {"p": stale})
            ).scalar_one()
        assert error is None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_tax_exclusive_locks_keep_their_lock():
    """A lock WITH a recorded reason is the tax-exclusive kind: nothing about
    it has anything to do with invoices, and the sweep re-lock would not fire
    for it, so it must stay exactly as it is."""
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            tax = await _seed(
                conn,
                "Hors taxe",
                quote_sync_state="locked",
                quote_sync_error="This quote is tax-exclusive; Aito costs are tax-inclusive",
                quote_invoiced=False,
            )

        async with engine.begin() as conn:
            await run_migrations(conn)

        assert await _row(engine, tax) == ("locked", 0)
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_unlock_runs_exactly_once():
    """A row re-locked by the sweep after the first boot must survive the
    second boot untouched."""
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            await run_migrations(conn)
        async with engine.begin() as conn:
            relocked = await _seed(conn, "Facture", quote_sync_state="locked")

        async with engine.begin() as conn:
            await run_migrations(conn)

        assert await _row(engine, relocked) == ("locked", 1)
    finally:
        await engine.dispose()
