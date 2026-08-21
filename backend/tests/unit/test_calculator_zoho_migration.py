"""The margin backfill that turns stored sale prices into a stored margin."""

import pytest
from sqlalchemy import text

from backend.app.core.database import run_migrations


@pytest.mark.asyncio
async def test_margin_is_backfilled_from_the_existing_sale_price(raw_conn):
    """A pre-migration row priced at 50% over cost must end up at margin_pct 50.

    ``raw_conn`` yields a connection with the ORM schema already created, so
    margin_pct exists with its default; nulling it reproduces the pre-migration
    state that the backfill has to repair.
    """
    await raw_conn.execute(
        text(
            "INSERT INTO calculator_filaments (name, brand, material, cost_per_kg, "
            "sale_price_per_kg, difficulty_pct) VALUES "
            "('SUNLU PETG', 'SUNLU', 'PETG', 1114.0, 1671.0, 100.0), "
            "('Bambu Lab ABS-GF', 'Bambu Lab', 'ABS-GF', 7199.0, 7199.0, 100.0)"
        )
    )
    await raw_conn.execute(text("UPDATE calculator_filaments SET margin_pct = NULL"))

    await run_migrations(raw_conn)

    rows = (
        await raw_conn.execute(text("SELECT material, margin_pct FROM calculator_filaments ORDER BY material"))
    ).all()
    margins = dict(rows)
    assert margins["ABS-GF"] == pytest.approx(0.0)
    assert margins["PETG"] == pytest.approx(50.0)


@pytest.mark.asyncio
async def test_rows_with_no_cost_get_a_zero_margin(raw_conn):
    """A zero cost cannot yield a margin; 0 keeps the derived-sale invariant true."""
    await raw_conn.execute(
        text(
            "INSERT INTO calculator_filaments (name, brand, material, cost_per_kg, "
            "sale_price_per_kg, difficulty_pct) VALUES ('X', '', 'X', 0.0, 0.0, 100.0)"
        )
    )
    await raw_conn.execute(text("UPDATE calculator_filaments SET margin_pct = NULL"))

    await run_migrations(raw_conn)

    margin = (await raw_conn.execute(text("SELECT margin_pct FROM calculator_filaments"))).scalar_one()
    assert margin == pytest.approx(0.0)


@pytest.mark.asyncio
async def test_migration_is_idempotent(raw_conn):
    await run_migrations(raw_conn)
    await run_migrations(raw_conn)
