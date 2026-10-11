"""Project stats: the per-project queue counts (routes/projects.py ``_load_totals``)."""

import pytest

from backend.app.api.routes.projects import _load_totals, compute_project_stats
from backend.app.models.print_queue import PrintQueueItem
from backend.tests.project_fixtures import make_project


@pytest.mark.asyncio
async def test_queue_counts_split_pending_and_printing_per_project(db_session):
    mine = await make_project(db_session, "Mine")
    other = await make_project(db_session, "Other")
    db_session.add_all(
        [
            PrintQueueItem(project_id=mine.id, status="pending"),
            PrintQueueItem(project_id=mine.id, status="pending"),
            PrintQueueItem(project_id=mine.id, status="printing"),
            PrintQueueItem(project_id=mine.id, status="completed"),  # neither queued nor in progress
            PrintQueueItem(project_id=other.id, status="pending"),  # another project's queue is not counted
        ]
    )
    await db_session.flush()

    stats = await compute_project_stats(db_session, mine.id)

    assert (stats.queued_prints, stats.in_progress_prints) == (2, 1)


@pytest.mark.asyncio
async def test_a_project_with_nothing_queued_reports_zero(db_session):
    project = await make_project(db_session, "Idle")

    stats = await compute_project_stats(db_session, project.id)

    assert (stats.queued_prints, stats.in_progress_prints) == (0, 0)


@pytest.mark.asyncio
async def test_no_project_ids_load_no_totals(db_session):
    assert await _load_totals(db_session, []) == {}
