from datetime import datetime

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import Base


@pytest.mark.asyncio
async def test_row_round_trips_with_defaults(db_session):
    from backend.app.models.aito_terminal_payment import AitoTerminalPayment

    row = AitoTerminalPayment(
        project_id=7,
        document_kind="invoice",
        document_id="460000000123456",
        document_number="FA-26-4358",
        idempotency_key="aito-tpe:7:1",
        amount=23000,
        created_at=datetime(2026, 9, 23, 1, 0, 0),
    )
    db_session.add(row)
    await db_session.commit()
    await db_session.refresh(row)
    assert row.status == "pending" and row.heimdall_id is None and row.amount_confirmed is None
    assert row.booking_status is None and row.settled_at is None and row.checked_at is None


@pytest.mark.asyncio
async def test_idempotency_key_is_unique(db_session):
    from sqlalchemy.exc import IntegrityError

    from backend.app.models.aito_terminal_payment import AitoTerminalPayment

    for _ in range(2):
        db_session.add(
            AitoTerminalPayment(
                project_id=7,
                document_kind="quote",
                document_id="e1",
                document_number="DEV-1",
                idempotency_key="aito-tpe:7:1",
                amount=100,
                created_at=datetime(2026, 9, 23),
            )
        )
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_migration_creates_the_table_on_a_bare_schema():
    from backend.app.core.database import run_migrations

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(text("DROP TABLE aito_terminal_payments"))
    async with engine.begin() as conn:
        await run_migrations(conn)
        cols = {r[1] for r in (await conn.execute(text("PRAGMA table_info(aito_terminal_payments)"))).fetchall()}
        assert {
            "project_id",
            "document_kind",
            "document_id",
            "document_number",
            "idempotency_key",
            "heimdall_id",
            "amount",
            "amount_confirmed",
            "status",
            "native_state",
            "booking_status",
            "booking_error",
            "zoho_payment_id",
            "sync_error",
            "created_by",
            "created_at",
            "checked_at",
            "settled_at",
            "updated_at",
        } <= cols
    await engine.dispose()
