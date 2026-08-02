"""Projects accepted before quote_accepted_at existed still deserve a real
acceptance moment: the quote.accepted event log has one for panel acceptances
and client acceptances mirrored from Zoho comments. Runs exactly once, on the
migration that adds the column — see _column_exists' docstring for why."""

from datetime import datetime

import pytest
from sqlalchemy import text


async def _seed_project(db_session, pid: int, quote_status: str | None):
    await db_session.execute(
        text(
            "INSERT INTO aito_projects (id, description, board_column, position, status, quote_status) "
            "VALUES (:id, 'Old', 'print', 0, 'active', :qs)"
        ),
        {"id": pid, "qs": quote_status},
    )


async def _seed_event(db_session, pid: int, kind: str, occurred_at: str):
    await db_session.execute(
        text("INSERT INTO aito_events (project_id, occurred_at, kind, actor_class) VALUES (:pid, :at, :kind, 'user')"),
        {"pid": pid, "at": occurred_at, "kind": kind},
    )


async def _accepted_at(db_session, pid: int):
    return (
        await db_session.execute(text("SELECT quote_accepted_at FROM aito_projects WHERE id = :id"), {"id": pid})
    ).scalar_one()


@pytest.mark.asyncio
async def test_backfill_uses_the_latest_accepted_event(db_session):
    from backend.app.core.database import _backfill_aito_quote_accepted_at

    await _seed_project(db_session, 1, "accepted")
    await _seed_event(db_session, 1, "quote.accepted", "2025-11-02 09:00:00")
    # A decline and re-accept later: the LATEST go-ahead wins.
    await _seed_event(db_session, 1, "quote.accepted", "2026-01-20 14:15:00")
    await db_session.commit()

    await _backfill_aito_quote_accepted_at(await db_session.connection())
    await db_session.commit()

    assert await _accepted_at(db_session, 1) == "2026-01-20 14:15:00"


@pytest.mark.asyncio
async def test_backfill_leaves_eventless_and_unaccepted_projects_null(db_session):
    from backend.app.core.database import _backfill_aito_quote_accepted_at

    # Accepted but no event (imported already-accepted): stays NULL, the card
    # falls back to created_at.
    await _seed_project(db_session, 1, "accepted")
    # Not accepted, but has a stray accepted event from before a decline:
    # stays NULL — the stamp only matters while the status is 'accepted', and
    # seeding it here would claim a decision the row no longer holds.
    await _seed_project(db_session, 2, "declined")
    await _seed_event(db_session, 2, "quote.accepted", "2025-11-02 09:00:00")
    await db_session.commit()

    await _backfill_aito_quote_accepted_at(await db_session.connection())
    await db_session.commit()

    assert await _accepted_at(db_session, 1) is None
    assert await _accepted_at(db_session, 2) is None
