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
async def test_an_off_grid_margin_is_rounded_to_two_decimals(raw_conn):
    """The real row 1 of the user's database: cost 3731, sale 5597.

    ``(5597 / 3731 - 1) * 100`` is 50.013401232913424 — 18 significant digits
    that the margin dropdown would render verbatim as an option label. The
    backfill rounds to the same 2 decimals the money columns carry, and
    re-derives the sale price so the row still satisfies
    ``sale == round(cost * (1 + margin/100), 2)`` afterwards.
    """
    await _drop_margin_pct(raw_conn)
    await raw_conn.execute(
        text(
            "INSERT INTO calculator_filaments (name, brand, material, cost_per_kg, "
            "sale_price_per_kg, difficulty_pct) VALUES "
            "('SUNLU PA6-CF', 'SUNLU', 'PA6-CF', 3731.0, 5597.0, 150.0)"
        )
    )

    await run_migrations(raw_conn)

    cost, margin, sale = (
        await raw_conn.execute(text("SELECT cost_per_kg, margin_pct, sale_price_per_kg FROM calculator_filaments"))
    ).one()
    assert margin == pytest.approx(50.01)
    assert sale == pytest.approx(round(cost * (1 + margin / 100.0), 2))


@pytest.mark.asyncio
async def test_every_backfilled_row_satisfies_the_derived_sale_invariant(raw_conn):
    """Whatever the pre-migration prices were, the invariant holds afterwards."""
    await _drop_margin_pct(raw_conn)
    await raw_conn.execute(
        text(
            "INSERT INTO calculator_filaments (name, brand, material, cost_per_kg, "
            "sale_price_per_kg, difficulty_pct) VALUES "
            "('A', '', 'A', 3731.0, 5597.0, 100.0), "  # off-grid
            "('B', '', 'B', 1114.0, 1671.0, 100.0), "  # exactly 50%
            "('C', '', 'C', 7199.0, 7199.0, 100.0), "  # exactly 0%
            "('D', '', 'D', 999.0, 1301.0, 100.0)"  # 30.23%, off the 25% grid
        )
    )

    await run_migrations(raw_conn)

    rows = (
        await raw_conn.execute(
            text("SELECT material, cost_per_kg, margin_pct, sale_price_per_kg FROM calculator_filaments")
        )
    ).all()
    for material, cost, margin, sale in rows:
        assert margin == pytest.approx(round(margin, 2)), f"{material} margin is not rounded"
        assert sale == pytest.approx(round(cost * (1 + margin / 100.0), 2)), f"{material} breaks the invariant"


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


# 11094.75 is exactly what a Zoho sync writes: round(8321.0625 / 0.75, 2). At
# margin 50 the exact product is 16642.125 — a value sitting precisely on a
# half-cent, which is where SQLite's ROUND (half-away-from-zero) and Python's
# round (half-to-even, used by derive_sale_price) disagree by one cent.
_HALF_CENT_COST = 11094.75
_HALF_CENT_SALE = 16642.12  # what the route stores; SQLite would say 16642.13


async def _insert_half_cent_row(conn):
    await conn.execute(
        text(
            "INSERT INTO calculator_filaments (name, brand, material, cost_per_kg, "
            "sale_price_per_kg, difficulty_pct) VALUES "
            f"('Zoho PLA', 'Zoho', 'PLA', {_HALF_CENT_COST}, {_HALF_CENT_SALE}, 100.0)"
        )
    )


@pytest.mark.asyncio
async def test_a_sub_cent_disagreement_with_sqlites_rounding_is_left_alone(raw_conn):
    """The self-heal must not fight the route over half a cent.

    ``derive_sale_price`` rounds half-to-even and stores 16642.12; SQLite's
    ROUND rounds half-away-from-zero and would write 16642.13. That is a
    disagreement about rounding mode, not drift, so the migration's tolerance
    makes it a no-op.
    """
    await _drop_margin_pct(raw_conn)
    await _insert_half_cent_row(raw_conn)

    await run_migrations(raw_conn)

    cost, margin, sale = (
        await raw_conn.execute(text("SELECT cost_per_kg, margin_pct, sale_price_per_kg FROM calculator_filaments"))
    ).one()
    assert margin == pytest.approx(50.0)
    assert cost == _HALF_CENT_COST
    assert sale == _HALF_CENT_SALE, "a sub-cent rounding-mode disagreement must not be rewritten"


@pytest.mark.asyncio
async def test_the_sub_cent_row_does_not_oscillate_across_boots(raw_conn):
    """``run_migrations`` runs on every boot, so a rewrite here is forever.

    Before the tolerance, boot #1 wrote 16642.13, the next route write put
    16642.12 back, boot #2 wrote 16642.13 again... A second run must change
    nothing at all.
    """
    await _drop_margin_pct(raw_conn)
    await _insert_half_cent_row(raw_conn)

    columns = "cost_per_kg, margin_pct, sale_price_per_kg"
    await run_migrations(raw_conn)
    after_first = (await raw_conn.execute(text(f"SELECT {columns} FROM calculator_filaments"))).one()
    await run_migrations(raw_conn)
    after_second = (await raw_conn.execute(text(f"SELECT {columns} FROM calculator_filaments"))).one()

    assert after_first == (_HALF_CENT_COST, pytest.approx(50.0), _HALF_CENT_SALE)
    assert after_second == after_first, "the second boot must be a true no-op"


@pytest.mark.asyncio
async def test_genuine_drift_still_heals_despite_the_tolerance(raw_conn):
    """The tolerance is one cent wide, not wide enough to hide real drift.

    The user's real row 1 (cost 3731, sale 5597) is off by 0.13 from what its
    backfilled margin derives, and must still be healed to 5596.87.
    """
    await _drop_margin_pct(raw_conn)
    await raw_conn.execute(
        text(
            "INSERT INTO calculator_filaments (name, brand, material, cost_per_kg, "
            "sale_price_per_kg, difficulty_pct) VALUES "
            "('SUNLU PA6-CF', 'SUNLU', 'PA6-CF', 3731.0, 5597.0, 150.0)"
        )
    )

    await run_migrations(raw_conn)

    margin, sale = (
        await raw_conn.execute(text("SELECT margin_pct, sale_price_per_kg FROM calculator_filaments"))
    ).one()
    assert margin == pytest.approx(50.01)
    assert sale == pytest.approx(5596.87)


@pytest.mark.asyncio
async def test_a_sale_price_below_cost_backfills_a_negative_margin(raw_conn):
    """A hand-typed printing cost that undercuts the purchase cost.

    The migration must not clamp this: it backfills the arithmetic result
    verbatim, even though it lands outside the ``[0, 1000]`` range the
    write-side schemas enforce for new entries. Read-back tolerates it; only
    new writes are rejected (schemas/calculator.py).
    """
    await _drop_margin_pct(raw_conn)
    await raw_conn.execute(
        text(
            "INSERT INTO calculator_filaments (name, brand, material, cost_per_kg, "
            "sale_price_per_kg, difficulty_pct) VALUES "
            "('Legacy Cheap PLA', '', 'PLA', 25.0, 20.0, 100.0)"
        )
    )

    await run_migrations(raw_conn)

    margin = (await raw_conn.execute(text("SELECT margin_pct FROM calculator_filaments"))).scalar_one()
    assert margin == pytest.approx(-20.0)


@pytest.mark.asyncio
async def test_a_sale_price_far_above_cost_backfills_a_margin_past_1000(raw_conn):
    """A decimal-point slip on the purchase cost (e.g. 2.50 instead of 25.0).

    ``(55.0 / 2.5 - 1) * 100 == 2100.0``, more than double the ``le=1000``
    ceiling the write-side schemas enforce. The migration still backfills it
    verbatim rather than clamping or dropping the row.
    """
    await _drop_margin_pct(raw_conn)
    await raw_conn.execute(
        text(
            "INSERT INTO calculator_filaments (name, brand, material, cost_per_kg, "
            "sale_price_per_kg, difficulty_pct) VALUES "
            "('Legacy Typo PETG', '', 'PETG', 2.5, 55.0, 100.0)"
        )
    )

    await run_migrations(raw_conn)

    margin = (await raw_conn.execute(text("SELECT margin_pct FROM calculator_filaments"))).scalar_one()
    assert margin == pytest.approx(2100.0)


@pytest.mark.asyncio
async def test_margin_curve_columns_are_added_with_defaults(raw_conn):
    """Pre-migration table (no curve columns) gets them added back with the
    documented defaults, and re-running the migration is a no-op."""
    for column in ("margin_min_mult", "margin_max_mult", "margin_k", "qty_min_factor", "qty_k", "min_task_price"):
        await raw_conn.execute(text(f"ALTER TABLE calculator_defaults DROP COLUMN {column}"))
    # Every other column on this table is NOT NULL with no DB-level default, so
    # a bare "(id) VALUES (1)" insert violates those constraints; INSERT OR
    # IGNORE then silently drops the row instead of raising. Supply the full
    # pre-migration row.
    await raw_conn.execute(
        text(
            "INSERT OR IGNORE INTO calculator_defaults ("
            "id, electricity_tariff, labor_rate_per_hour, consumables_packaging_flat, failure_rate_pct, "
            "prototype_rate_pct, ads_rate_pct, filament_markup_pct, global_markup_pct, tax_pct, "
            "default_difficulty_pct, default_margin_over_cost_pct, stuff_markup_pct, base_fee_flat"
            ") VALUES (1, 120.0, 3000.0, 30.0, 30.0, 30.0, 5.0, 5.0, 50.0, 13.0, 100.0, 50.0, 20.0, 0.0)"
        )
    )

    await run_migrations(raw_conn)

    row = (
        await raw_conn.execute(
            text(
                "SELECT margin_min_mult, margin_max_mult, margin_k, qty_min_factor, qty_k, min_task_price "
                "FROM calculator_defaults WHERE id = 1"
            )
        )
    ).one()
    assert tuple(row) == (1.15, 1.6, 33.0, 0.4, 5.0, 12.0)

    await run_migrations(raw_conn)  # idempotent
