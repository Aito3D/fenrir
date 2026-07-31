"""The event table's shape, and the two invariants that are easy to lose.

occurred_at is when the thing HAPPENED, which for a mirrored Zoho comment is
Books' timestamp and not ours. zoho_comment_id is UNIQUE so re-pulling a
comment is a no-op rather than a duplicate — SQLite permits many NULLs in a
unique column, which is exactly what our own events need.
"""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.exc import IntegrityError

from backend.app.models.aito_event import AitoEvent


@pytest.mark.asyncio
async def test_event_round_trips_its_payload(db_session):
    event = AitoEvent(
        project_id=7,
        occurred_at=datetime(2026, 7, 29, 12, 0, tzinfo=timezone.utc).replace(tzinfo=None),
        kind="task.updated",
        actor_class="user",
        actor_name="paul",
        subject_type="task",
        subject_id=3,
        subject_label="Socle",
        changes=[{"field": "impression_cost", "from": 4200, "to": 5600}],
    )
    db_session.add(event)
    await db_session.commit()
    await db_session.refresh(event)

    assert event.id is not None
    assert event.changes[0]["to"] == 5600
    assert event.occurred_until is None  # instantaneous until something coalesces into it


@pytest.mark.asyncio
async def test_many_events_may_have_no_zoho_comment_id(db_session):
    """Our own events all carry NULL here; the unique index must tolerate that."""
    for _ in range(3):
        db_session.add(
            AitoEvent(
                project_id=7,
                occurred_at=datetime(2026, 7, 29, 12, 0),
                kind="task.added",
                actor_class="user",
            )
        )
    await db_session.commit()


@pytest.mark.asyncio
async def test_a_zoho_comment_id_cannot_be_mirrored_twice(db_session):
    """This is the mirror's whole idempotency guarantee: re-pulling the same
    comment on the next poll must not append a second copy."""
    for _ in range(2):
        db_session.add(
            AitoEvent(
                project_id=7,
                occurred_at=datetime(2026, 7, 29, 12, 0),
                kind="quote.viewed",
                actor_class="client",
                zoho_comment_id="c-1",
            )
        )
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_coalesced_events_carry_a_window(db_session):
    start = datetime(2026, 7, 29, 11, 0)
    event = AitoEvent(
        project_id=7,
        occurred_at=start,
        occurred_until=start + timedelta(minutes=4),
        kind="task.updated",
        actor_class="user",
        actor_name="paul",
        changes=[
            {"field": "title", "from": "Socle", "to": "Socle v2"},
            {"field": "impression_cost", "from": 4200, "to": 5600},
        ],
    )
    db_session.add(event)
    await db_session.commit()
    await db_session.refresh(event)

    assert event.occurred_until > event.occurred_at
    assert len(event.changes) == 2
