"""quote_sent_at: when a quote first left the shop. Backfilled once from the
event log for rows that predate the column; stamped once by the app after."""

import pytest
from sqlalchemy import text


async def _seed_project(db_session, pid: int, quote_status: str | None, quote_date: str | None = None):
    await db_session.execute(
        text(
            "INSERT INTO aito_projects (id, description, board_column, position, status, quote_status, quote_date, created_at) "
            "VALUES (:id, 'Old', 'devis', 0, 'active', :qs, :qd, '2026-01-05 10:00:00')"
        ),
        {"id": pid, "qs": quote_status, "qd": quote_date},
    )


async def _seed_event(db_session, pid: int, kind: str, occurred_at: str):
    await db_session.execute(
        text("INSERT INTO aito_events (project_id, occurred_at, kind, actor_class) VALUES (:pid, :at, :kind, 'user')"),
        {"pid": pid, "at": occurred_at, "kind": kind},
    )


async def _sent_at(db_session, pid: int):
    return (
        await db_session.execute(text("SELECT quote_sent_at FROM aito_projects WHERE id = :id"), {"id": pid})
    ).scalar_one()


@pytest.mark.asyncio
async def test_backfill_takes_the_earliest_sent_or_emailed_event(db_session):
    from backend.app.core.database import _backfill_aito_quote_sent_at

    await _seed_project(db_session, 1, "viewed", "2026-02-01")
    await _seed_event(db_session, 1, "quote.emailed", "2026-02-03 09:00:00")
    await _seed_event(db_session, 1, "quote.sent", "2026-02-02 14:15:00")
    await db_session.commit()

    await _backfill_aito_quote_sent_at(await db_session.connection())
    await db_session.commit()

    assert await _sent_at(db_session, 1) == "2026-02-02 14:15:00"


@pytest.mark.asyncio
async def test_backfill_falls_back_to_quote_date_then_created_at(db_session):
    from backend.app.core.database import _backfill_aito_quote_sent_at

    await _seed_project(db_session, 1, "sent", "2026-02-10")
    await _seed_project(db_session, 2, "accepted", None)
    await _seed_project(db_session, 3, None, "2026-02-10")
    await db_session.commit()

    await _backfill_aito_quote_sent_at(await db_session.connection())
    await db_session.commit()

    assert await _sent_at(db_session, 1) == "2026-02-10 00:00:00"
    assert await _sent_at(db_session, 2) == "2026-01-05 10:00:00"
    assert await _sent_at(db_session, 3) is None


@pytest.mark.asyncio
async def test_backfill_never_overwrites_a_stamp(db_session):
    from backend.app.core.database import _backfill_aito_quote_sent_at

    await _seed_project(db_session, 1, "sent", "2026-02-10")
    await db_session.execute(text("UPDATE aito_projects SET quote_sent_at = '2026-03-01 08:00:00' WHERE id = 1"))
    await db_session.commit()

    await _backfill_aito_quote_sent_at(await db_session.connection())
    await db_session.commit()

    assert await _sent_at(db_session, 1) == "2026-03-01 08:00:00"


@pytest.mark.asyncio
async def test_project_response_carries_the_new_fields_as_null(async_client):
    created = await async_client.post(
        "/api/v1/aito/",
        json={"description": "Support", "client_id": "z1", "client_name": "ACME", "client_phone": "+689 87 00 00 01"},
    )
    assert created.status_code == 201, created.text
    body = created.json()
    for key in ("quote_sent_at", "invoice_status", "invoice_balance", "invoice_due_date", "invoice_checked_at"):
        assert key in body and body[key] is None
