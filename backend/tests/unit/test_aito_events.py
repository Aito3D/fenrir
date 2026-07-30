"""The recorder's two jobs: classify, and refuse to be noisy.

Coalescing is what keeps "every action registered" from producing a wall the
user cannot read. TaskEditor saves on row blur, so editing a title, then a
cost, then a quantity is three PATCHes and would otherwise be three rows.
"""

import logging
from datetime import datetime, timedelta

import pytest

from backend.app.models.aito_event import AitoEvent
from backend.app.services.aito_events import (
    COALESCE_WINDOW,
    diff_fields,
    kinds_for_depth,
    record,
)


def test_depth_is_cumulative():
    """Story events stay visible at every level. The client accepting a quote
    is never something the user should have to change depth to find."""
    story = set(kinds_for_depth("story"))
    detail = set(kinds_for_depth("detail"))
    everything = set(kinds_for_depth("everything"))

    assert "quote.accepted" in story
    assert story < detail < everything
    assert "task.updated" in detail and "task.updated" not in story
    assert "sync.failed" in everything and "sync.failed" not in detail


def test_diff_fields_reports_only_real_changes():
    class Row:
        title = "Socle"
        impression_cost = 4200.0

    changes = diff_fields(Row(), {"title": "Socle", "impression_cost": 5600.0})
    assert changes == [{"field": "impression_cost", "from": 4200.0, "to": 5600.0}]


def test_diff_fields_ignores_fields_absent_from_the_patch():
    class Row:
        title = "Socle"
        impression_cost = 4200.0

    assert diff_fields(Row(), {}) == []


@pytest.mark.asyncio
async def test_record_writes_nothing_when_nothing_changed(db_session):
    """A PATCH that changes nothing must be silent. TaskEditor fires on row
    blur, so tabbing through a task without editing it is the common case."""
    event = await record(
        db_session,
        1,
        "task.updated",
        actor_class="user",
        actor_name="paul",
        subject_type="task",
        subject_id=3,
        changes=[],
    )
    assert event is None


@pytest.mark.asyncio
async def test_consecutive_edits_by_one_actor_coalesce(db_session):
    first = await record(
        db_session,
        1,
        "task.updated",
        actor_class="user",
        actor_name="paul",
        subject_type="task",
        subject_id=3,
        subject_label="Socle",
        changes=[{"field": "title", "from": "Socle", "to": "Socle v2"}],
    )
    second = await record(
        db_session,
        1,
        "task.updated",
        actor_class="user",
        actor_name="paul",
        subject_type="task",
        subject_id=3,
        subject_label="Socle v2",
        changes=[{"field": "impression_cost", "from": 4200, "to": 5600}],
    )

    assert second.id == first.id
    assert len(second.changes) == 2
    assert second.occurred_until is not None


@pytest.mark.asyncio
async def test_a_field_edited_back_to_its_original_disappears(db_session):
    """4200 -> 5600 -> 4200 in one sitting is not a change, and a timeline that
    claims otherwise is lying about what the record says."""
    await record(
        db_session,
        1,
        "task.updated",
        actor_class="user",
        actor_name="paul",
        subject_type="task",
        subject_id=3,
        changes=[{"field": "impression_cost", "from": 4200, "to": 5600}],
    )
    result = await record(
        db_session,
        1,
        "task.updated",
        actor_class="user",
        actor_name="paul",
        subject_type="task",
        subject_id=3,
        changes=[{"field": "impression_cost", "from": 5600, "to": 4200}],
    )

    assert result is None  # the event deleted itself
    remaining = (await db_session.execute(AitoEvent.__table__.select())).all()
    assert remaining == []


@pytest.mark.asyncio
async def test_a_merged_field_keeps_the_earliest_from_and_latest_to(db_session):
    await record(
        db_session,
        1,
        "task.updated",
        actor_class="user",
        actor_name="paul",
        subject_type="task",
        subject_id=3,
        changes=[{"field": "impression_cost", "from": 1000, "to": 2000}],
    )
    merged = await record(
        db_session,
        1,
        "task.updated",
        actor_class="user",
        actor_name="paul",
        subject_type="task",
        subject_id=3,
        changes=[{"field": "impression_cost", "from": 2000, "to": 3000}],
    )

    assert merged.changes == [{"field": "impression_cost", "from": 1000, "to": 3000}]


@pytest.mark.asyncio
async def test_a_different_actor_does_not_coalesce(db_session):
    """Two people editing the same task in the same minute is exactly what an
    audit exists to distinguish."""
    await record(
        db_session,
        1,
        "task.updated",
        actor_class="user",
        actor_name="paul",
        subject_type="task",
        subject_id=3,
        changes=[{"field": "title", "from": "a", "to": "b"}],
    )
    second = await record(
        db_session,
        1,
        "task.updated",
        actor_class="user",
        actor_name="marie",
        subject_type="task",
        subject_id=3,
        changes=[{"field": "title", "from": "b", "to": "c"}],
    )

    rows = (await db_session.execute(AitoEvent.__table__.select())).all()
    assert len(rows) == 2
    assert second.actor_name == "marie"


@pytest.mark.asyncio
async def test_an_edit_outside_the_window_does_not_coalesce(db_session):
    first = await record(
        db_session,
        1,
        "task.updated",
        actor_class="user",
        actor_name="paul",
        subject_type="task",
        subject_id=3,
        changes=[{"field": "title", "from": "a", "to": "b"}],
    )
    first.occurred_at = datetime.utcnow() - COALESCE_WINDOW - timedelta(minutes=1)
    first.occurred_until = first.occurred_at
    await db_session.commit()

    await record(
        db_session,
        1,
        "task.updated",
        actor_class="user",
        actor_name="paul",
        subject_type="task",
        subject_id=3,
        changes=[{"field": "title", "from": "b", "to": "c"}],
    )

    rows = (await db_session.execute(AitoEvent.__table__.select())).all()
    assert len(rows) == 2


@pytest.mark.asyncio
async def test_ticks_never_coalesce(db_session):
    """Each tick is a discrete decision, and the single thing an audit is most
    likely to be asked about."""
    await record(
        db_session,
        1,
        "task.step.ticked",
        actor_class="user",
        actor_name="paul",
        subject_type="task",
        subject_id=3,
        detail={"service": "scan"},
    )
    await record(
        db_session,
        1,
        "task.step.ticked",
        actor_class="user",
        actor_name="paul",
        subject_type="task",
        subject_id=3,
        detail={"service": "modelisation"},
    )

    rows = (await db_session.execute(AitoEvent.__table__.select())).all()
    assert len(rows) == 2


@pytest.mark.asyncio
async def test_anonymous_edits_coalesce_with_each_other(db_session):
    """actor_name=None is the DEFAULT, not an edge case: it is what every edit
    looks like on installs with auth disabled and for API-key requests. The
    coalescing query has to use `actor_name.is_(None)` rather than
    `actor_name == None`, since SQL's `= NULL` never matches anything -- if
    that ternary regressed to plain equality, anonymous edits would never
    coalesce and every PATCH would land as its own row."""
    first = await record(
        db_session,
        1,
        "task.updated",
        actor_class="user",
        actor_name=None,
        subject_type="task",
        subject_id=3,
        changes=[{"field": "title", "from": "Socle", "to": "Socle v2"}],
    )
    second = await record(
        db_session,
        1,
        "task.updated",
        actor_class="user",
        actor_name=None,
        subject_type="task",
        subject_id=3,
        changes=[{"field": "impression_cost", "from": 4200, "to": 5600}],
    )

    assert second.id == first.id
    assert len(second.changes) == 2


@pytest.mark.asyncio
async def test_project_level_edits_coalesce_with_no_subject_id(db_session):
    """project.updated events describe the project itself, not a child row, so
    subject_id is None rather than pointing at a task. The same IS-NULL vs.
    equals-NULL trap applies here as it does for actor_name, on the other
    column the coalescing query filters on."""
    first = await record(
        db_session,
        1,
        "project.updated",
        actor_class="user",
        actor_name="paul",
        subject_type="project",
        subject_id=None,
        changes=[{"field": "name", "from": "Vitrine", "to": "Vitrine v2"}],
    )
    second = await record(
        db_session,
        1,
        "project.updated",
        actor_class="user",
        actor_name="paul",
        subject_type="project",
        subject_id=None,
        changes=[{"field": "budget", "from": 1000, "to": 2000}],
    )

    assert second.id == first.id
    assert len(second.changes) == 2


@pytest.mark.asyncio
async def test_an_unregistered_kind_is_refused_and_logged(db_session, caplog):
    """The read path filters by `kind IN (...)` derived entirely from KINDS, so
    a row written with a kind absent from that registry could never be
    returned by any depth -- it would just be dead weight in the table.
    Refusing loudly (not just returning None silently) is what lets an
    unregistered kind be caught in review instead of discovered as a
    mysteriously missing timeline entry."""
    with caplog.at_level(logging.ERROR, logger="backend.app.services.aito_events"):
        result = await record(
            db_session,
            1,
            "not.a.real.kind",
            actor_class="user",
            actor_name="paul",
            subject_type="task",
            subject_id=3,
            changes=[{"field": "title", "from": "a", "to": "b"}],
        )

    assert result is None
    assert "not.a.real.kind" in caplog.text
    rows = (await db_session.execute(AitoEvent.__table__.select())).all()
    assert rows == []
