"""The payment-link ledger row and the two new project columns, through the
real migrations (run_migrations creates the table on a bare schema)."""

import pytest
from sqlalchemy import select, text

from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.models.aito_project import AitoProject


async def _project(db, **fields) -> AitoProject:
    base = {"description": "x", "board_column": "devis", "position": 0, "status": "active"}
    base.update(fields)
    row = AitoProject(**base)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@pytest.mark.asyncio
async def test_ledger_row_round_trips(db_session):
    p = await _project(db_session, quote_number="DEV-2026-1234", quote_total=12500.0)
    row = AitoPaymentLink(
        project_id=p.id,
        idempotency_key=f"aito:{p.id}:1",
        reference="DEV-2026-1234",
        amount=12500,
        expires_on="2026-09-27",
    )
    db_session.add(row)
    await db_session.commit()
    await db_session.refresh(row)
    assert row.status == "pending" and row.currency == "XPF" and row.sync_failures == 0
    assert row.heimdall_id is None and row.superseded_at is None and row.created_at is not None


@pytest.mark.asyncio
async def test_idempotency_key_and_heimdall_id_are_unique_but_null_ids_may_repeat(db_session):
    from sqlalchemy.exc import IntegrityError

    p = await _project(db_session)
    db_session.add(
        AitoPaymentLink(project_id=p.id, idempotency_key="k1", reference="R", amount=1, expires_on="2026-09-27")
    )
    db_session.add(
        AitoPaymentLink(project_id=p.id, idempotency_key="k2", reference="R", amount=1, expires_on="2026-09-27")
    )
    await db_session.commit()  # two reservations, both heimdall_id NULL — allowed
    db_session.add(
        AitoPaymentLink(project_id=p.id, idempotency_key="k1", reference="R", amount=1, expires_on="2026-09-27")
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_project_columns_exist(db_session):
    p = await _project(db_session, quote_expiry_date="2026-09-27", retainer_paid_total=3000.0)
    got = (await db_session.execute(select(AitoProject).where(AitoProject.id == p.id))).scalar_one()
    assert got.quote_expiry_date == "2026-09-27" and got.retainer_paid_total == 3000.0


async def _make_engine():
    """A schema shaped like a database that has run every migration except
    this one: every current model's table exists (Base.metadata.create_all),
    so run_migrations's unrelated ALTERs (pipeline_runs, etc.) have a table to
    land on, but the payment-link table and the two project columns are new.
    Modelled on test_aito_flag_migration.py::_make_engine.
    """
    from sqlalchemy.ext.asyncio import create_async_engine

    import backend.app.models  # noqa: F401 — registers every mapped model
    from backend.app.core.database import Base

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(text("DROP TABLE aito_payment_links"))
        await conn.execute(text("ALTER TABLE aito_projects DROP COLUMN quote_expiry_date"))
        await conn.execute(text("ALTER TABLE aito_projects DROP COLUMN retainer_paid_total"))
        await conn.execute(text("ALTER TABLE aito_projects DROP COLUMN customer_credit_total"))
    return engine


@pytest.mark.asyncio
async def test_migration_creates_table_and_columns_on_a_bare_schema():
    from backend.app.core.database import run_migrations

    engine = await _make_engine()
    async with engine.begin() as conn:
        await run_migrations(conn)
        cols = {r[1] for r in (await conn.execute(text("PRAGMA table_info(aito_projects)"))).fetchall()}
        assert {"quote_expiry_date", "retainer_paid_total", "customer_credit_total"} <= cols
        link_cols = {r[1] for r in (await conn.execute(text("PRAGMA table_info(aito_payment_links)"))).fetchall()}
        assert {"idempotency_key", "heimdall_id", "status", "superseded_at"} <= link_cols
    await engine.dispose()
