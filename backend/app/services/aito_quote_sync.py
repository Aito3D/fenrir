"""Push an Aito project into its Zoho Books quote.

An outbox, not a callback: route handlers set ``quote_sync_state = 'pending'``
and return, and this module drains the queue in the background. Nothing on a
request path ever waits on Books, so a Zoho outage degrades to a retry rather
than a failed board edit, and a burst of task edits inside one tick collapses
into a single quote rewrite.

Phase 1 is push-only. ``quote_synced_at`` is written here and read by the
Phase 2 poller.
"""

import asyncio
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import async_session
from backend.app.core.tasks import spawn_background_task
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.filament import Filament
from backend.app.services.aito_quote_export import ExportTask, build_line_items
from backend.app.services.zoho import (
    ZohoAmbiguousReferenceError,
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

    A missing ``estimate_id`` is refused rather than silently marked 'idle':
    ``create_estimate``/``update_estimate_lines`` return
    ``payload.get("estimate", {})``, so a 200 whose body happens to omit the
    "estimate" key yields ``{}`` here. Going 'idle' on that would freeze the
    project as "in sync" forever while Books may already hold a write this
    project never recorded an id for (an orphaned estimate on create, or an
    unconfirmed line-item push on update). Raising routes through
    ``sync_project``'s ``ZohoUpstreamError`` handling instead, which keeps the
    project retrying (or escalates to 'error' after ``SYNC_FAILURE_LIMIT``)
    rather than freezing it silently — this was Critical 1's second bug.
    """
    if estimate.get("estimate_id") is None:
        raise ZohoUpstreamError("Zoho returned no estimate_id; the push cannot be confirmed")
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
        # otherwise POST an estimate with no lines. A terminal state, not a
        # silent no-op: leaving quote_sync_state alone here would have this
        # project re-selected and re-checked every single tick forever. The
        # user's next edit (which is required to fix this anyway) goes through
        # _mark_pending_if_ours and re-marks it pending as normal.
        project.quote_sync_state = "error"
        project.quote_sync_error = "Project has no priced service yet"
        project.quote_sync_failures = 0
        return
    # Idempotency guard: a prior tick can have POSTed successfully and then
    # died before the commit that would have recorded the returned
    # estimate_id (the project stays 'pending' either way). Without this
    # check, the next tick would POST a second estimate under the exact same
    # AITO-{id} reference, orphaning the first one in Books. A lookup failure
    # is NOT swallowed into "create anyway" — it propagates like any other
    # ZohoUpstreamError (or ZohoAmbiguousReferenceError, which sync_project
    # treats as an immediate, non-retried error — see there), so sync_project's
    # own handling retries next tick instead of risking a duplicate.
    reference_number = f"AITO-{project.id}"
    estimate = await zoho_service.find_estimate_by_reference(db, reference_number, project.client_id)
    if estimate is not None:
        # Adopt the orphan's IDENTITY only — never treat it as "in sync".
        # This is a list-summary object, not the full estimate (no
        # line_items), and the project may well have been edited since the
        # tick whose POST succeeded but whose commit didn't (the exact
        # scenario this lookup exists for): POST with a scan-only line ->
        # commit fails -> user adds an Impression3D service -> this tick
        # finds the orphan. Marking it 'idle' here (the bug this replaces)
        # would declare the card in sync while Books still holds only the
        # scan line. Leaving quote_sync_state at 'pending' (do not touch it)
        # means the very next tick takes the normal _update_quote path
        # instead, which re-reads the FULL estimate and pushes whatever the
        # project's lines currently are. Also deliberately not writing
        # quote_synced_at: this summary's last_modified_time is not the full
        # estimate's and must not be trusted by the Phase 2 poller's echo
        # suppression.
        project.quote_id = estimate["estimate_id"]
        if estimate.get("estimate_number") is not None:
            project.quote_number = estimate["estimate_number"]
        project.quote_url = await zoho_service.books_app_url(db, project.quote_id)
        project.quote_sync_error = None
        project.quote_sync_failures = 0
        return
    estimate = await zoho_service.create_estimate(
        db,
        {
            "customer_id": project.client_id,
            "reference_number": reference_number,
            "is_inclusive_tax": True,
            "line_items": line_items,
        },
    )
    await _write_back_rounded_impression(db, project.id)
    _apply_estimate(project, estimate)
    if project.quote_id:
        project.quote_url = await zoho_service.books_app_url(db, project.quote_id)
    if estimate.get("is_inclusive_tax") is not True:
        # Mirrors _update_quote's guard below (Important 4): the create
        # request ASKED for is_inclusive_tax: True, but the org can force a
        # tax-exclusive estimate anyway, and by the time the response is back
        # the estimate — inflated by the tax rate — already exists in Books.
        # _apply_estimate above already captured its identity (quote_id etc.),
        # so the card links to the real estimate; lock it exactly like an
        # invoiced quote so no further line items are ever written to it, and
        # record why. `is not True` fails closed: an absent field is treated
        # the same as an explicit False, never assumed safe.
        project.quote_sync_state = "locked"
        project.quote_sync_error = (
            "This quote is tax-exclusive; Aito costs are tax-inclusive and cannot be pushed without inflating the total"
        )


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


# Statuses Books can be put back into. There is no /status/draft, so a quote
# that was still a draft when its project was trashed cannot be recovered.
_RESTORABLE = ("sent", "accepted")


async def _reconcile_status(db: AsyncSession, project: AitoProject, estimate: dict) -> bool:
    """Bring the quote's status in line with whether the project is on the board.

    Declarative rather than an action queue: the worker compares two facts it
    can always read — is the project deleted, and what does Books say — so a
    missed tick, a restart or a double-fire all converge on the same result
    instead of replaying a stored intent.

    Returns True when the project is trashed, meaning the caller must not go on
    to rewrite the line items of a quote for a job that no longer exists.
    """
    status = estimate.get("status") if estimate.get("status") is not None else ""
    if project.status == "deleted":
        if status != "declined":
            project.quote_status_before_trash = status
            # Persisted BEFORE the decline call, not after: set_estimate_status
            # is a real, irreversible write to Books, and if the commit that
            # would normally save this snapshot happened only afterwards (as
            # the caller's later commit), a crash or failed commit in between
            # would leave Books already declined while the DB never recorded
            # what it was declined FROM. The next tick reads status ==
            # "declined" from Books and — correctly, to stay idempotent about
            # the decline itself — skips re-capturing, so a sent/accepted
            # history would be gone for good. Committing here closes that
            # window: worst case a crash right after this commit still loses
            # nothing, because the snapshot is already durable even though the
            # decline call hasn't happened yet, so it simply retries next tick.
            #
            # Two things about this commit are load-bearing, not incidental:
            # it commits whatever ELSE is dirty in this session too, not just
            # this attribute — acceptable only because sync_project's caller
            # (run_sync_once) processes one project per commit boundary, so
            # nothing unrelated should be pending here to be swept along. And
            # the `project.quote_id` read two lines below relies on this
            # session's `expire_on_commit=False` (see async_session in
            # core/database.py): a session with the SQLAlchemy default would
            # expire every attribute on commit, and touching `project.quote_id`
            # afterwards would attempt a lazy reload outside a greenlet
            # context and raise, rather than simply returning the value still
            # held in memory.
            await db.commit()
            # `current=status` is the estimate Books just gave us. A draft
            # estimate cannot be declined directly either, so a project trashed
            # before its quote ever went out needs the same sent-first chain.
            await zoho_service.advance_estimate_status(db, project.quote_id, "declined", current=status)
            project.quote_status = "declined"
        project.quote_sync_state = "idle"
        project.quote_sync_error = None
        project.quote_sync_failures = 0
        return True
    if status == "declined" and project.quote_status_before_trash in _RESTORABLE:
        await zoho_service.advance_estimate_status(
            db, project.quote_id, project.quote_status_before_trash, current=status
        )
        project.quote_status = project.quote_status_before_trash
        project.quote_status_before_trash = None
    return False


async def _update_quote(db: AsyncSession, project: AitoProject) -> None:
    estimate = await zoho_service.get_estimate(db, project.quote_id)
    if _is_locked(estimate):
        project.quote_sync_state = "locked"
        if estimate.get("status") is not None:
            project.quote_status = estimate["status"]
        project.quote_sync_error = None
        project.quote_sync_failures = 0
        return
    if await _reconcile_status(db, project, estimate):
        return
    if estimate.get("is_inclusive_tax") is not True:
        # Board costs are stored TTC (tax-inclusive) and this module never
        # converts them. Writing our line items onto a tax-EXCLUSIVE estimate
        # would have Books add tax on top of a figure that already includes
        # it, silently inflating the total by the tax rate on every push.
        # Treated exactly like an invoiced quote (see _is_locked above): no
        # line items may be written, and the reason is recorded for the user
        # rather than retried, since nothing about a retry would change it.
        # `is not True` (not `is False`): a response that OMITS the field
        # must fail closed, not fall through to the PUT below — this guard
        # protects real customer money and an absent field is not evidence
        # of anything safe.
        project.quote_sync_state = "locked"
        if estimate.get("status") is not None:
            project.quote_status = estimate["status"]
        project.quote_sync_error = (
            "This quote is tax-exclusive; Aito costs are tax-inclusive and cannot be pushed without inflating the total"
        )
        project.quote_sync_failures = 0
        return
    catalogue = await zoho_service.get_catalogue(db)
    line_items = build_line_items(
        await load_export_tasks(db, project.id),
        estimate.get("line_items") or [],
        catalogue,
    )
    if not line_items:
        # Mirrors the create-path guard: a project whose only priced service
        # was just cleared by hand would otherwise PUT an empty line_items
        # array, and Books deletes every Aito line a live quote had. A
        # terminal state, not a silent no-op: without one, this project would
        # be re-selected every tick forever — an unbounded GET
        # /estimates/{id} against Books every 60s for as long as it sits
        # empty. The next edit that adds a service back re-marks it pending
        # as normal, same as create.
        project.quote_sync_state = "error"
        project.quote_sync_error = "Project has no priced service left; nothing was written to the quote"
        project.quote_sync_failures = 0
        return
    updated = await zoho_service.update_estimate_lines(db, project.quote_id, line_items)
    await _write_back_rounded_impression(db, project.id)
    _apply_estimate(project, updated)


async def sync_project(db: AsyncSession, project: AitoProject) -> None:
    """One project's whole state machine. Never raises: every outcome is a state."""
    try:
        if not project.quote_id:
            if project.status == "deleted":
                # Trashed before it was ever quoted. Nothing to create, nothing
                # to decline; drop it from the queue without a Zoho call.
                #
                # Deliberately 'idle', NOT 'unmanaged': this project WAS
                # created (and marked pending) by this feature — it just
                # never got as far as a quote before being trashed. 'idle'
                # carries no special meaning to the ownership guard
                # (routes/aito.py:_mark_pending_if_ours checks only for
                # 'unmanaged'), so restoring — or any later edit — re-enqueues
                # it normally. 'unmanaged' is reserved exclusively for
                # legacy/imported cards this feature must never touch again
                # (see import_legacy_projects); using it here too would make
                # this project indistinguishable from one of those and
                # permanently block it from ever being marked pending again —
                # which is exactly Critical 1's bug (a trashed, never-quoted
                # project going 'idle' under the OLD, inferred-ownership
                # guard), reproduced under a new name instead of fixed.
                project.quote_sync_state = "idle"
                return
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
    except ZohoAmbiguousReferenceError as e:
        # find_estimate_by_reference found more than one plausible match, or
        # the lone survivor belongs to a different customer. Like a rejected
        # payload, retrying the identical lookup cannot resolve it — it needs
        # a human to sort out the duplicate/mismatched estimate in Books —
        # and it must never be treated as "create anyway", which is exactly
        # how a real customer's estimate would get adopted and overwritten.
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
            # Recompute and store board_column here too, not just on request
            # paths. sync_project can rewrite project.quote_status
            # (_apply_estimate, the invoiced-lock and tax-exclusive-lock
            # branches in _update_quote, and _reconcile_status) without
            # touching board_column, and _to_response derives move_lock from
            # the LIVE quote_status while returning the STORED board_column —
            # so skipping this leaves a self-contradictory row (e.g. a card
            # sitting in Printing but locked as "Waiting on the client").
            # Inside this try so a failure here is handled exactly like a
            # commit failure: roll back, log, leave the project pending, and
            # retry next tick. Function-level import: no circular import
            # today (routes/aito.py does not import this module), but this
            # keeps it that way if that ever changes.
            from backend.app.api.routes.aito import _apply_rules, _summary_for

            await _apply_rules(db, project, await _summary_for(db, project.id))
            await db.commit()
        except Exception:
            await db.rollback()
            logger.exception("Aito quote sync failed to commit project %s", project_id)
    return attempted


_DEFAULT_INTERVAL_SECONDS = 60


async def sync_interval_seconds(db: AsyncSession) -> int:
    from backend.app.api.routes.settings import get_setting

    raw = await get_setting(db, "aito_quote_poll_seconds")
    try:
        # Floor of 10s: the setting is an operator dial, not a foot-gun that
        # can be turned into a hot loop against Books.
        return max(10, int(raw)) if raw else _DEFAULT_INTERVAL_SECONDS
    except ValueError:
        return _DEFAULT_INTERVAL_SECONDS


async def sync_enabled(db: AsyncSession) -> bool:
    from backend.app.api.routes.settings import get_setting

    raw = await get_setting(db, "aito_quote_sync_enabled")
    return (raw or "true").strip().lower() not in ("false", "0", "no")


async def run_sync_loop() -> None:
    """Drain the outbox forever. Cancellation is the only way out.

    Every iteration takes its own session and swallows its own errors: one bad
    tick must not kill the loop, or a single transient failure would silently
    end syncing until the next restart.
    """
    while True:
        interval = _DEFAULT_INTERVAL_SECONDS
        try:
            async with async_session() as db:
                interval = await sync_interval_seconds(db)
                if await sync_enabled(db) and await zoho_service.is_configured(db):
                    await run_sync_once(db)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Aito quote sync tick failed")
        await asyncio.sleep(interval)


def start_aito_quote_sync() -> None:
    spawn_background_task(run_sync_loop(), name="aito-quote-sync")
