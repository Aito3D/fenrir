"""Push an Aito project into its Zoho Books quote.

An outbox, not a callback: route handlers set ``quote_sync_state = 'pending'``
and return, and this module drains the queue in the background. Nothing on a
request path ever waits on Books, so a Zoho outage degrades to a retry rather
than a failed board edit, and a burst of task edits inside one tick collapses
into a single quote rewrite.

Phase 1 is push-only. ``quote_synced_at`` is written here and read by the
Phase 2 poller.
"""

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.filament import Filament
from backend.app.services.aito_quote_export import ExportTask, build_line_items
from backend.app.services.zoho import (
    ZohoNotConfiguredError,
    ZohoNotFound,
    ZohoRequestRejected,
    ZohoUpstreamError,
    zoho_service,
)

logger = logging.getLogger(__name__)

# Consecutive upstream failures before a project stops being retried. Five
# minutes of a Books outage at the default 60s tick, which rides out a restart
# without giving up, and stops a permanently broken project polling forever.
SYNC_FAILURE_LIMIT = 5


async def load_export_tasks(db: AsyncSession, project_id: int) -> list[ExportTask]:
    """The project's tasks, flattened for the I/O-free exporter.

    Resolving the filament to its bare type happens here rather than in
    ``aito_quote_export`` so that module stays pure. A filament that has since
    been deleted from the calculator simply yields no material row — the cost
    is already frozen on the task, so nothing else is lost.
    """
    rows = list(
        (
            await db.execute(
                select(AitoTask).where(AitoTask.project_id == project_id).order_by(AitoTask.position, AitoTask.id)
            )
        )
        .scalars()
        .all()
    )
    filament_ids = {row.impression_filament_id for row in rows if row.impression_filament_id is not None}
    materials: dict[int, str] = {}
    if filament_ids:
        found = (await db.execute(select(Filament).where(Filament.id.in_(filament_ids)))).scalars().all()
        materials = {f.id: f.type for f in found}
    return [
        ExportTask(
            title=row.title,
            description=row.description,
            scan_cost=row.scan_cost,
            modelisation_cost=row.modelisation_cost,
            usinage_cost=row.usinage_cost,
            impression_cost=row.impression_cost,
            impression_quantity=row.impression_quantity,
            impression_weight_g=row.impression_weight_g,
            impression_time_min=row.impression_time_min,
            impression_color=row.impression_color,
            material=materials.get(row.impression_filament_id or -1),
        )
        for row in rows
    ]


def _apply_estimate(project: AitoProject, estimate: dict) -> None:
    """Copy back what Books now says, so the card stops guessing.

    quote_status in particular: it used to be a snapshot frozen at import that
    went stale the moment a quote was accepted. Every push refreshes it.
    """
    project.quote_id = estimate.get("estimate_id") or project.quote_id
    project.quote_number = estimate.get("estimate_number") or project.quote_number
    project.quote_date = estimate.get("date") or project.quote_date
    project.quote_total = float(estimate.get("total") or 0)
    project.quote_status = estimate.get("status") or project.quote_status
    project.quote_synced_at = estimate.get("last_modified_time") or project.quote_synced_at
    project.quote_sync_state = "idle"
    project.quote_sync_error = None
    project.quote_sync_failures = 0


async def _create_quote(db: AsyncSession, project: AitoProject) -> None:
    catalogue = await zoho_service.get_catalogue(db)
    line_items = build_line_items(await load_export_tasks(db, project.id), [], catalogue)
    if not line_items:
        # Every project is meant to carry a priced service (the create modal
        # enforces it), but a project whose only task was emptied by hand would
        # otherwise POST an estimate with no lines. Stay pending, say nothing:
        # the next edit that adds a service fixes it.
        project.quote_sync_error = "Project has no priced service yet"
        return
    estimate = await zoho_service.create_estimate(
        db,
        {
            "customer_id": project.client_id,
            "reference_number": f"AITO-{project.id}",
            "is_inclusive_tax": True,
            "line_items": line_items,
        },
    )
    _apply_estimate(project, estimate)
    if project.quote_id:
        project.quote_url = await zoho_service.books_app_url(db, project.quote_id)


async def sync_project(db: AsyncSession, project: AitoProject) -> None:
    """One project's whole state machine. Never raises: every outcome is a state."""
    try:
        if not project.quote_id:
            await _create_quote(db, project)
        else:
            raise NotImplementedError("update path lands in Task 7")
    except ZohoNotConfiguredError:
        # Not a failure: sync is simply off. Leave the project pending so it
        # syncs the moment credentials are entered.
        return
    except ZohoRequestRejected as e:
        # Books rejected the payload. Retrying an identical body cannot help.
        project.quote_sync_state = "error"
        project.quote_sync_error = str(e)
    except ZohoNotFound:
        project.quote_sync_state = "error"
        project.quote_sync_error = "The quote no longer exists in Zoho Books"
    except ZohoUpstreamError as e:
        project.quote_sync_failures = (project.quote_sync_failures or 0) + 1
        project.quote_sync_error = str(e)
        if project.quote_sync_failures >= SYNC_FAILURE_LIMIT:
            project.quote_sync_state = "error"
        logger.warning("Aito quote sync failed for project %s: %s", project.id, e)


async def run_sync_once(db: AsyncSession) -> int:
    """Drain every pending project. Returns how many were attempted.

    Active and soft-deleted alike: a trashed project still owes Books a status
    change. Serial by design — the board holds a handful of cards, and one
    request at a time keeps the failure accounting above trivial.
    """
    projects = list(
        (
            await db.execute(
                select(AitoProject).where(AitoProject.quote_sync_state == "pending").order_by(AitoProject.id)
            )
        )
        .scalars()
        .all()
    )
    for project in projects:
        await sync_project(db, project)
    if projects:
        await db.commit()
    return len(projects)
