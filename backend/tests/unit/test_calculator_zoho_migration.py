"""The margin backfill that turns stored sale prices into a stored margin.

``raw_conn`` (backend/tests/conftest.py:284) hands us a connection against a
schema the ORM has already created — so ``margin_pct`` exists there as a
NOT NULL column before any test body runs. That is not the state a real
upgrade starts from: a genuine pre-migration database has no ``margin_pct``
column at all. Every test here reproduces that real starting point by
dropping the column first, then inserting pre-migration rows with plain SQL,
then letting ``run_migrations`` add the column back and backfill it. This is
deliberately the same path a live upgrade takes: ``ALTER TABLE ... ADD
COLUMN margin_pct FLOAT`` (no DB-level default) followed by the two backfill
UPDATEs — not a shortcut through the ORM's already-existing column.
"""

import pytest
from sqlalchemy import text

from backend.app.core.database import run_migrations


async def _drop_margin_pct(conn):
    await conn.execute(text("ALTER TABLE calculator_filaments DROP COLUMN margin_pct"))


@pytest.mark.asyncio
async def test_margin_is_backfilled_from_the_existing_sale_price(raw_conn):
    """A pre-migration row priced at 50% over cost must end up at margin_pct 50."""
    await _drop_margin_pct(raw_conn)
    await raw_conn.execute(
        text(
            "INSERT INTO calculator_filaments (name, brand, material, cost_per_kg, "
            "sale_price_per_kg, difficulty_pct) VALUES "
            "('SUNLU PETG', 'SUNLU', 'PETG', 1114.0, 1671.0, 100.0), "
            "('Bambu Lab ABS-GF', 'Bambu Lab', 'ABS-GF', 7199.0, 7199.0, 100.0)"
        )
    )

    await run_migrations(raw_conn)

    rows = (
        await raw_conn.execute(text("SELECT material, margin_pct FROM calculator_filaments ORDER BY material"))
    ).all()
    margins = dict(rows)
    assert margins["ABS-GF"] == pytest.approx(0.0)
    assert margins["PETG"] == pytest.approx(50.0)


@pytest.mark.asyncio
async def test_a_zero_margin_row_is_not_overwritten_with_the_default(raw_conn):
    """Regression pin: the migration used to ``ADD COLUMN margin_pct FLOAT
    DEFAULT 50.0``. In SQLite, ADD COLUMN with a DEFAULT fills *existing* rows
    with that default rather than leaving them NULL, so the backfill's
    ``WHERE margin_pct IS NULL`` matched nothing and every pre-existing
    filament silently got stamped at 50% margin — including ones that were
    genuinely priced at 0% margin (sale_price_per_kg == cost_per_kg), which
    would then have their derived cost inflated by 50% on the next edit or
    Zoho sync. This must never come back.
    """
    await _drop_margin_pct(raw_conn)
    await raw_conn.execute(
        text(
            "INSERT INTO calculator_filaments (name, brand, material, cost_per_kg, "
            "sale_price_per_kg, difficulty_pct) VALUES "
            "('Bambu Lab PPS-CF', 'Bambu Lab', 'PPS-CF', 9000.0, 9000.0, 100.0)"
        )
    )

    await run_migrations(raw_conn)

    margin = (await raw_conn.execute(text("SELECT margin_pct FROM calculator_filaments"))).scalar_one()
    assert margin == pytest.approx(0.0), "sale == cost must backfill to 0%, not silently become the 50% default"


@pytest.mark.asyncio
async def test_rows_with_no_cost_get_a_zero_margin(raw_conn):
    """A zero cost cannot yield a margin; 0 keeps the derived-sale invariant true."""
    await _drop_margin_pct(raw_conn)
    await raw_conn.execute(
        text(
            "INSERT INTO calculator_filaments (name, brand, material, cost_per_kg, "
            "sale_price_per_kg, difficulty_pct) VALUES ('X', '', 'X', 0.0, 0.0, 100.0)"
        )
    )

    await run_migrations(raw_conn)

    margin = (await raw_conn.execute(text("SELECT margin_pct FROM calculator_filaments"))).scalar_one()
    assert margin == pytest.approx(0.0)


@pytest.mark.asyncio
async def test_migration_is_idempotent(raw_conn):
    await _drop_margin_pct(raw_conn)
    await raw_conn.execute(
        text(
            "INSERT INTO calculator_filaments (name, brand, material, cost_per_kg, "
            "sale_price_per_kg, difficulty_pct) VALUES ('X', '', 'X', 100.0, 150.0, 100.0)"
        )
    )

    await run_migrations(raw_conn)
    await run_migrations(raw_conn)

    margin = (await raw_conn.execute(text("SELECT margin_pct FROM calculator_filaments"))).scalar_one()
    assert margin == pytest.approx(50.0)
