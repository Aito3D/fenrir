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
            material=materials.get(row.impression_filament_id),
        )
        for row in rows
    ]


def _apply_estimate(project: AitoProject, estimate: dict) -> None:
    """Copy back what Books now says, so the card stops guessing.

    quote_status in particular: it used to be a snapshot frozen at import that
    went stale the moment a quote was accepted. Every push refreshes it.
    """
    if estimate.get("estimate_id") is not None:
        project.quote_id = estimate["estimate_id"]
    if estimate.get("estimate_number") is not None:
        project.quote_number = estimate["estimate_number"]
    if estimate.get("date") is not None:
        project.quote_date = estimate["date"]
    # `or 0` is intentional here, not a bug: an absent/None total means the
    # quote genuinely has no lines yet, and 0 is exactly the right value —
    # unlike the string fields above, there's no falsy-but-valid float this
    # could clobber.
    project.quote_total = float(estimate.get("total") or 0)
    if estimate.get("status") is not None:
        project.quote_status = estimate["status"]
    if estimate.get("last_modified_time") is not None:
        project.quote_synced_at = estimate["last_modified_time"]
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


def _is_locked(estimate: dict) -> bool:
    """An estimate that has become an invoice is accounting, not a draft.

    Zoho itself enforces nothing — sent, accepted and declined estimates all
    accept a PUT — so this is the app's own guard and the only one there is.
    Accepted deliberately does NOT lock: a client agreeing a price is no
    reason a typo in the print weight cannot be corrected.
    """
    return bool(estimate.get("is_transaction_created")) or float(estimate.get("invoiced_amount") or 0) > 0


async def _write_back_rounded_impression(db: AsyncSession, project_id: int) -> None:
    """Adopt the total the quote can actually express.

    impression_cost is a total for all units but a line is rate x quantity at
    price_precision 0, so 2401 over 2 units is unrepresentable. Writing the
    achievable figure back here means the project and the quote agree
    immediately — rather than agreeing a tick later, as a visible jitter, when
    the Phase 2 poller pulls the quote's number back.
    """
    rows = (await db.execute(select(AitoTask).where(AitoTask.project_id == project_id))).scalars().all()
    for row in rows:
        if row.impression_cost is None:
            continue
        quantity = max(1, int(row.impression_quantity or 1))
        row.impression_cost = round(row.impression_cost / quantity) * quantity


async def _update_quote(db: AsyncSession, project: AitoProject) -> None:
    estimate = await zoho_service.get_estimate(db, project.quote_id)
    if _is_locked(estimate):
        project.quote_sync_state = "locked"
        project.quote_status = estimate.get("status") or project.quote_status
        project.quote_sync_error = None
        return
    catalogue = await zoho_service.get_catalogue(db)
    line_items = build_line_items(
        await load_export_tasks(db, project.id),
        estimate.get("line_items") or [],
        catalogue,
    )
    updated = await zoho_service.update_estimate_lines(db, project.quote_id, line_items)
    await _write_back_rounded_impression(db, project.id)
    _apply_estimate(project, updated)


async def sync_project(db: AsyncSession, project: AitoProject) -> None:
    """One project's whole state machine. Never raises: every outcome is a state."""
    try:
        if not project.quote_id:
            await _create_quote(db, project)
        else:
            await _update_quote(db, project)
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
    except Exception as e:
        # Anything not already handled above: a DB error, a bug in
        # build_line_items, an AttributeError on unexpected Zoho data. The
        # docstring's "never raises" promise depends on this clause — without
        # it, one project's unrelated bug unwinds out of run_sync_once's loop
        # and skips the commit that persists every other project's write
        # (including a just-created quote_id), which is how a retry turns
        # into a duplicate estimate in Books. Fail this project only.
        project.quote_sync_state = "error"
        project.quote_sync_error = str(e)
        logger.exception("Aito quote sync hit an unexpected error for project %s", project.id)


async def run_sync_once(db: AsyncSession) -> int:
    """Drain every pending project. Returns how many were actually attempted.

    Not the same as the number of ids selected up front: the skip guard below
    can pass over an id whose row vanished or whose state moved on before the
    loop reached it, and those never call sync_project, so they don't count.

    Active and soft-deleted alike: a trashed project still owes Books a status
    change. Serial by design — the board holds a handful of cards, and one
    request at a time keeps the failure accounting above trivial.
    """
    project_ids = list(
        (
            await db.execute(
                select(AitoProject.id).where(AitoProject.quote_sync_state == "pending").order_by(AitoProject.id)
            )
        )
        .scalars()
        .all()
    )
    attempted = 0
    for project_id in project_ids:
        # Re-fetched fresh on every iteration rather than loaded once as a
        # list of instances before the loop. This looks like it trades away a
        # single SELECT for N of them, but that trade is load-bearing, not an
        # accident: SQLAlchemy's rollback() expires every object in the
        # session's identity map, not just the one whose commit failed —
        # regardless of expire_on_commit, which only governs commit(). If a
        # sibling project's instance were held from before the loop, the
        # commit-failure guard below would expire it, and the next attribute
        # touch on it (e.g. `if not project.quote_id:` in sync_project) would
        # try to lazily reload outside a greenlet context and raise
        # MissingGreenlet — crashing the whole tick, which is exactly the
        # "one failure aborts the batch" failure mode this guard exists to
        # prevent. Holding ids instead of instances closes that hole: nothing
        # from before the loop survives a rollback for us to accidentally
        # touch, because we ask for it again afterwards. Do not "optimise"
        # this back into a single select of full rows — the board holds a
        # handful of cards, and correctness beats saving a few primary-key
        # lookups.
        project = await db.get(AitoProject, project_id)
        if project is None or project.quote_sync_state != "pending":
            # Gone, or already handled by something else since the id was
            # selected above — nothing left to sync. Not counted below: it was
            # never actually attempted.
            continue
        attempted += 1
        await sync_project(db, project)
        # Commit per project, not once after the loop. sync_project's own
        # catch-all keeps it from raising, but a single end-of-batch commit
        # would still make every project's durability depend on none of its
        # neighbours failing first — the whole point of the catch-all is
        # defeated if a skipped commit can still discard a sibling's already-
        # written quote_id. Committing here means the next project's work
        # never risks the previous one's write.
        #
        # Residual window: the process can still die between Zoho returning
        # an estimate_id and this commit landing, in which case the next tick
        # re-creates the quote. Closing that needs a distributed transaction
        # (or an idempotency key Books doesn't offer); noted, not solved here.
        #
        # The commit itself can also fail (a DB hiccup, a lock timeout). Left
        # unguarded, that exception would propagate out of this loop exactly
        # like the pre-fix batch commit did: it aborts every remaining
        # project for the tick, and leaves the session mid-transaction and
        # unusable until something rolls it back. So this is caught too: roll
        # back, log, move on. The rollback discards this project's in-memory
        # changes, but its row was never written, so it is still `pending` —
        # sync_project's "idle"/"error" update never made it to the DB — and
        # the next tick retries it from scratch, same as any other transient
        # failure. Projects already committed earlier in this loop are
        # unaffected on disk, and projects still to come are unaffected in
        # memory too: the rollback expires every instance in the session,
        # including ones loaded earlier in this loop, but nothing from a
        # previous iteration is still referenced here, and the next
        # iteration re-fetches its project fresh via db.get() rather than
        # reusing an expired one.
        try:
            await db.commit()
        except Exception:
            await db.rollback()
            logger.exception("Aito quote sync failed to commit project %s", project_id)
    return attempted
