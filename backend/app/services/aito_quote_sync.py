"""Push an Aito project into its Zoho Books quote.

An outbox, not a callback: route handlers set ``quote_sync_state = 'pending'``
and return, and this module drains the queue in the background. Nothing on a
request path ever waits on Books, so a Zoho outage degrades to a retry rather
than a failed board edit, and a burst of task edits inside one tick collapses
into a single quote rewrite.

The one latency exception is project CREATION: a brand-new card owes Books an
estimate immediately, not at the next poll, so ``create_project`` calls
``request_immediate_sync`` after its commit and the loop runs a PENDING-ONLY
drain right away. That drain spends only the Books calls the pending projects
were going to spend anyway — it never reconciles quoted projects — so the wake
does not touch the quota budget the 300s interval below exists to protect.

Phase 1 is push-only. ``quote_synced_at`` is written here and read by the
Phase 2 poller.
"""

import asyncio
import logging
import time
from datetime import datetime

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import async_session
from backend.app.core.tasks import spawn_background_task
from backend.app.core.websocket import ws_manager
from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.calculator import CalculatorFilament
from backend.app.services.aito_events import record
from backend.app.services.aito_quote_export import (
    Catalogue,
    ExportShipping,
    ExportTask,
    build_line_items,
    enabled_services,
)
from backend.app.services.aito_quote_status import adopt_quote_status
from backend.app.services.aito_shipping import island_label
from backend.app.services.aito_zoho_comments import mirror_comments, should_pull_comments
from backend.app.services.zoho import (
    ZohoAmbiguousReferenceError,
    ZohoNotConfiguredError,
    ZohoNotFound,
    ZohoRequestRejected,
    ZohoUpstreamError,
    zoho_service,
)

logger = logging.getLogger(__name__)

# Consecutive upstream failures before a project's push is escalated to
# 'error'. Twenty-five minutes of a Books outage at the default 300s tick, which
# rides out a restart without giving up.
#
# It does NOT stop the project being polled, and never claim it does: the sweep
# deliberately keeps selecting 'error' projects (see run_sync_once's SELECT,
# which excludes only 'unmanaged' and 'locked'), so an escalated project is
# still re-read every tick — and that read is exactly what lets sync_project's
# recovery branch bring it back to 'idle' once Books answers again. What the
# limit ends is the retrying of the PUSH, and it surfaces the failure on the
# card instead of leaving it silently 'pending' forever.
SYNC_FAILURE_LIMIT = 5

# The statuses that represent a DECISION someone made, as opposed to where a
# quote merely happens to sit. We own ours (the shop accepted or declined);
# Books owns the client's. Everything else — draft, sent, viewed, expired — is
# undecided, and undecided always yields. Read by reconcile_quote_status (the
# full asymmetry) and by _apply_estimate (the copy-back's half of it).
_DECIDED = frozenset({"accepted", "declined"})

# Project id -> the deferral reason already logged for it in THIS process.
# Log-spam suppression only, which is why it is process-local: a restart
# costs exactly one extra WARNING and nothing else. Deliberately NOT
# persisted on the project. quote_sync_error belongs to the line-item sync
# path, and recording another subsystem's state in it is the mistake
# documented on AitoProject.quote_status_block — five defects across four
# review rounds. A deferral is not an error and must leave no trace on the
# row: the project stays `pending` with a clean error field, exactly as it
# was before this handler ran.
_deferred_reasons: dict[int, str] = {}


def _clear_block(project: AitoProject) -> None:
    """No reason to be blocked any more. Unconditional and always safe: these
    two columns are the status reconciler's own record, so there is no other
    subsystem's diagnostic to destroy — which is exactly the property
    `quote_sync_error` did not have, and the reason every "is this error mine?"
    guard that used to stand in reconcile_quote_status is gone.

    Called from every site that writes `project.quote_status`, not just the
    reconciler's own branches. The model's comment states the invariant
    plainly — a recorded block always describes an attempt made from the
    CURRENT `quote_status`, which is what lets `quote_status_remote` alone
    identify it — and each of those sites happens to write Books' own current
    status, so today's block would clear on the next tick's equality branch
    anyway. Relying on that is a subtle argument no future edit is obliged to
    preserve: clearing at the source makes the invariant true by construction
    instead. (`set_quote_status` in routes/aito.py is the one writer outside
    this module, and it clears both columns inline.)
    """
    project.quote_status_block = None
    project.quote_status_remote = None


class _Unset:
    """Sentinel distinguishing "leave quote_sync_error alone" from "set it to
    None" -- the swept branch of sync_project deliberately does the former
    (see its own comment), while the invoiced branch of _update_quote does
    the latter."""


_UNSET = _Unset()


async def _lock_project(
    db: AsyncSession,
    project: AitoProject,
    project_id: int,
    *,
    reason: str | None | _Unset = _UNSET,
    invoiced: bool = False,
    estimate: dict | None = None,
    clear_block: bool = False,
    reset_failures: bool = False,
) -> None:
    """Flip a project into 'locked' and record the transition exactly once.

    Shared by every site that locks a project (create-path tax-exclusive,
    update-path invoiced and tax-exclusive, and the sweep's own invoiced
    catch-up): all four capture `was_already_locked` before mutating state so
    the debounce below never double-records a project that was already
    locked. The parameters carry each site's own variance -- the lock reason
    (or none, via the `_UNSET` sentinel, to leave `quote_sync_error`
    untouched entirely), whether `quote_invoiced` gets stamped, whether a
    quote status is adopted from a freshly-read estimate, and whether a
    stale block/failure count is cleared -- never normalized away.
    """
    was_already_locked = project.quote_sync_state == "locked"
    project.quote_sync_state = "locked"
    if invoiced:
        project.quote_invoiced = True
    if estimate is not None and estimate.get("status") is not None:
        adopt_quote_status(project, estimate["status"])
    if not isinstance(reason, _Unset):
        project.quote_sync_error = reason
    if clear_block:
        _clear_block(project)
    if reset_failures:
        project.quote_sync_failures = 0
    if not was_already_locked:
        await record(db, project_id, "sync.locked", actor_class="system", subject_type="project", subject_id=project_id)


class ShippingCatalogueUnavailable(Exception):
    """The project carries shipping but its Books item is unknown.

    Raised rather than silently skipping the line: a quote written without the
    shipping it was promised is a quote that can be sent to a client, and that
    is not recoverable. The caller leaves the project `pending` so the next
    tick — by which time the catalogue may have resolved — tries again. See
    `sync_project`'s own `except ShippingCatalogueUnavailable` handler, which
    must sit before the broad handler that increments `quote_sync_failures`:
    nothing here is a failure of the project's own, so it must not spend any
    of the retry budget SYNC_FAILURE_LIMIT protects, nor land in the terminal
    'error' state the no-priced-service guards elsewhere in this module use.
    """


def load_export_shipping(project: AitoProject, catalogue: Catalogue) -> ExportShipping | None:
    """The project's shipment, flattened for the I/O-free exporter.

    `shipping_island IS NULL` is the definition of no shipping, so that field
    alone decides — nothing else on the project is consulted to reach that
    conclusion. An island whose key is no longer in the lookup table still
    exports, using the stored key itself as the label: the quote must keep
    saying what it said, and a table edit is not a reason to stop billing a
    job already in flight.
    """
    if not project.shipping_island:
        return None
    service = project.shipping_service or ""
    if service not in catalogue.shipping:
        raise ShippingCatalogueUnavailable(f"No Books item for shipping service {service!r}")
    return ExportShipping(
        service=service,
        island_label=island_label(project.shipping_island) or project.shipping_island,
        first_name=project.shipping_first_name or "",
        last_name=project.shipping_last_name or "",
        phone=project.shipping_phone or "",
        price=float(project.shipping_price or 0),
    )


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
        # CalculatorFilament, NOT the AMS inventory `filaments` table: the
        # drawer's picker is api.getCalculatorFilaments, so the ids stored on
        # tasks live in the calculator's id-space. `material` is the bare type
        # ("PETG", "PA6-CF") — exactly what ExportTask.material documents.
        found = (
            (await db.execute(select(CalculatorFilament).where(CalculatorFilament.id.in_(filament_ids))))
            .scalars()
            .all()
        )
        materials = {f.id: f.material for f in found}
    return [
        ExportTask(
            title=row.title,
            scan_description=row.scan_description,
            modelisation_description=row.modelisation_description,
            impression_description=row.impression_description,
            usinage_description=row.usinage_description,
            scan_cost=row.scan_cost,
            modelisation_cost=row.modelisation_cost,
            usinage_cost=row.usinage_cost,
            impression_cost=row.impression_cost,
            impression_quantity=row.impression_quantity,
            impression_weight_g=row.impression_weight_g,
            impression_time_min=row.impression_time_min,
            impression_color=row.impression_color,
            material=materials.get(row.impression_filament_id),
            impression_discount_pct=row.impression_discount_pct,
        )
        for row in rows
    ]


def _apply_estimate(project: AitoProject, estimate: dict) -> None:
    """Copy back what Books now says, so the card stops guessing.

    quote_status in particular: it used to be a snapshot frozen at import that
    went stale the moment a quote was accepted. Every push refreshes it — but
    only in the direction reconcile_quote_status allows, never over a decision
    of ours Books has not caught up with yet. See the guard below.

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
    remote_status = estimate.get("status")
    if remote_status is not None and not (project.quote_status in _DECIDED and remote_status != project.quote_status):
        # A copy-back is not a licence to unmake a decision. Books' status is
        # adopted whenever ours is merely where the quote sat; once ours is
        # DECIDED, the ONLY remote status still copied back is the identical
        # one, which changes nothing.
        #
        # The condition is `remote_status != project.quote_status`, NOT
        # `remote_status not in _DECIDED`. The two are not the same test and
        # the difference is a Critical: with local 'accepted' and remote
        # 'declined' the _DECIDED form is False, the guard passes, and this
        # line writes 'declined' straight over the acceptance — resolving a
        # conflict in Books' favour three lines under a comment promising it
        # does not. That is reachable, and it is the C1 scenario undone:
        # Accept on a declined card writes 'accepted' locally while the Books
        # POST is best-effort (`zoho_synced=False` on failure), and the next
        # pending event of any kind — a task edit, an add/delete, the panel's
        # own Retry sync — came back through here and silently re-declined the
        # card, with `_clear_block` erasing the conflict record on the way out.
        # Test the real condition ("does the remote disagree with our
        # decision?"), never a proxy for it.
        #
        # The sequence the guard as a whole closes: accepting a card whose
        # estimate is still a draft marks it sent first, and if the accept POST
        # then fails the board holds 'accepted' while Books holds 'sent'. Any
        # later task edit comes through here, and an unconditional write pulled
        # the card back to 'sent' — off its work column, Done toggle gone,
        # ticks 422'd — and left reconcile_quote_status unable to repair it,
        # because with a now-UNDECIDED local status it adopts Books' forever.
        #
        # Two decisions that DISAGREE are not resolved here either: this path
        # holds no evidence about which is right, and the reconciler already
        # records that case as a conflict for a human. Keeping ours simply
        # leaves it for the next sweep to see.
        adopt_quote_status(project, remote_status)
    _clear_block(project)
    if estimate.get("last_modified_time") is not None:
        project.quote_synced_at = estimate["last_modified_time"]
    project.quote_sync_state = "idle"
    project.quote_sync_error = None
    project.quote_sync_failures = 0


async def _create_quote(db: AsyncSession, project: AitoProject) -> None:
    catalogue = await zoho_service.get_catalogue(db)
    tasks = await load_export_tasks(db, project.id)
    if not any(enabled_services(task) for task in tasks):
        # Every project is meant to carry a priced service (the create modal
        # enforces it), but a project whose only task was emptied by hand would
        # otherwise POST an estimate with no lines. A terminal state, not a
        # silent no-op: leaving quote_sync_state alone here would have this
        # project re-selected and re-checked every single tick forever. The
        # user's next edit (which is required to fix this anyway) goes through
        # _mark_pending_if_ours and re-marks it pending as normal.
        #
        # Decided on TASK content, not on the built line_items array: shipping
        # alone must never make a project quotable. build_line_items appends
        # the shipping line unconditionally, so gating on "the array came out
        # empty" would let a project with zero priced tasks but shipping
        # attached POST a shipping-only estimate — this guard has to run
        # before shipping is ever threaded in.
        project.quote_sync_state = "error"
        project.quote_sync_error = "Project has no priced service yet"
        project.quote_sync_failures = 0
        return
    line_items = build_line_items(tasks, [], catalogue, shipping=load_export_shipping(project, catalogue))
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
    await record(
        db,
        project.id,
        "quote.created",
        actor_class="system",
        subject_type="project",
        subject_id=project.id,
        detail={"quote_number": project.quote_number},
    )
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
        await _lock_project(
            db,
            project,
            project.id,
            reason=(
                "This quote is tax-exclusive; Aito costs are tax-inclusive and cannot be pushed without inflating the total"
            ),
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


# A snapshotted pre-trash status -> the status a restore puts Books back into.
#
# 'draft' maps to 'sent', not to itself: Books offers no /status/draft, and the
# previous behaviour (treat draft as unrestorable) left the project permanently
# 'declined' after a restore — an absorbing state, since a declined quote also
# hides most of the board's actions. 'sent' is both Books' nearest legal state
# and the literal truth about that estimate: a draft cannot be declined
# directly, so the trash path's own sent-first chain
# (advance_estimate_status) really did mark it sent on the way out.
_RESTORE_TARGET = {"draft": "sent", "sent": "sent", "accepted": "accepted"}


async def reconcile_quote_status(db: AsyncSession, project: AitoProject, estimate: dict) -> None:
    """Make the board and Books agree about one quote's status.

    Asymmetric on purpose. We push a decision of ours that Books has not got
    (the case that stranded five accepted projects against draft estimates:
    Books rejects draft -> accepted, the route's push failed, and nothing
    recorded that it owed a retry). We adopt Books' status whenever ours is
    merely where the quote sat, because a client opening or letting a quote
    expire is news to us, not something to overwrite.

    When BOTH sides are decided and they disagree, neither wins: overwriting a
    client's decline with our acceptance — or the reverse — is destructive and
    unrecoverable, so it is recorded (`quote_status_block = "conflict"`) and
    left for a human. Both sides are left exactly as they were.

    Every guard below reads a STORED FACT — `quote_status_block` and
    `quote_status_remote`, this function's own record, which nothing outside
    this module and `set_quote_status` touches — never a human-readable
    string. `quote_sync_error` is read-only to this function
    (in truth, not even read): it belongs to the line-item sync path, and a
    project can be sitting in 'error' for a reason this function has no
    visibility into (e.g. `_update_quote`'s "no priced service left" guard)
    while its STATUS still needs reconciling, since the sweep deliberately
    does not exclude 'error'. Neither that message nor `quote_sync_state` is
    evidence about status in either direction, so neither is consulted and
    neither is written.
    """
    zoho_status = estimate.get("status") or ""
    local = project.quote_status

    if not zoho_status:
        # Books gave no usable signal at all on this read — not evidence of
        # agreement, disagreement or anything else, so nothing is recorded and
        # nothing already recorded is invalidated.
        return

    if zoho_status == local:
        # Genuine agreement: whatever was blocking, is not any more.
        _clear_block(project)

        # Steady state IS agreement, so recording this unconditionally fired
        # on every quoted project on every tick forever -- at the 300s default
        # with 17 active quoted projects that is ~4,900 rows/day, ~1.8M/year,
        # each carrying a JSON detail and three indexes, and it grows with
        # board size rather than workload: a finished, accepted card is polled
        # and re-recorded forever. It also drowned the activity rail's
        # 'Everything' depth in identical poll noise at exactly the volume
        # someone would need it legible.
        #
        # Debounced the same shape as sync.conflict/sync.status_rejected
        # above: record only on a transition INTO the state, never on a tick
        # that merely confirms it again. Those two debounce against a column
        # this same function owns (quote_status_block/quote_status_remote),
        # but there is no equivalent free column here: quote_status_remote
        # exists to describe a BLOCK only (see its own docstring on
        # AitoProject), and every write to quote_status clears it via
        # _clear_block -- including the one three lines up -- so it can never
        # carry "the status we last agreed on" across ticks without breaking
        # the invariant _clear_block's own docstring documents. So this is the
        # one 'trace' kind that genuinely needs a query rather than a stored
        # column.
        #
        # The natural key for "already reported" is the remote status THIS
        # tick agreed on: if the last poll.reconciled recorded for this
        # project already carries that same status in its detail, this tick
        # is not news. A single indexed lookup (project_id, newest id first)
        # is enough -- run_sync_once processes one project per commit, so
        # nothing else can be racing this same row between the read and the
        # record() below.
        last = (
            await db.execute(
                select(AitoEvent.detail)
                .where(AitoEvent.project_id == project.id, AitoEvent.kind == "poll.reconciled")
                .order_by(AitoEvent.id.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if last is not None and last.get("status") == zoho_status:
            return
        await record(
            db,
            project.id,
            "poll.reconciled",
            actor_class="system",
            subject_type="project",
            subject_id=project.id,
            detail={"status": project.quote_status},
        )
        return

    ours_decided = local in _DECIDED
    theirs_decided = zoho_status in _DECIDED

    if ours_decided and theirs_decided:
        # Recorded only on the tick this conflict first arises: a conflict
        # clears solely via a human calling set_quote_status (see
        # _clear_block's docstring), so an untouched conflict is otherwise
        # re-selected and re-diagnosed every single tick forever — the same
        # "one row per moment, not per tick" property the 'rejected' branch
        # below already enforces for its own repeated failure. The columns
        # are still written every time (nothing here changes what the card
        # displays); only the event is debounced.
        already_this_conflict = project.quote_status_block == "conflict" and project.quote_status_remote == zoho_status
        project.quote_status_block = "conflict"
        project.quote_status_remote = zoho_status
        if not already_this_conflict:
            await record(
                db,
                project.id,
                "sync.conflict",
                actor_class="system",
                subject_type="project",
                subject_id=project.id,
                detail={"ours": project.quote_status, "theirs": project.quote_status_remote},
            )
        return

    if ours_decided:
        if project.quote_status_block == "rejected" and project.quote_status_remote == zoho_status:
            # Books rejected this exact attempt on an earlier tick and nothing
            # has moved since — retrying an identical payload cannot help, and
            # a POST every 300s forever against a real customer estimate is the
            # failure this record exists to stop. `quote_status_remote` alone
            # is enough to identify the attempt: our side cannot have changed
            # without `set_quote_status` clearing both columns (see the model).
            return
        try:
            await zoho_service.advance_estimate_status(db, project.quote_id, local, current=zoho_status)
        except ZohoRequestRejected as e:
            project.quote_status_block = "rejected"
            # Books' status BEFORE advance_estimate_status's own sent-first
            # hop (a target in _STATUSES_NEEDING_SENT with a draft `current`
            # marks sent first, then POSTs the target) — not after. If THIS
            # call performed that hop before the rejection, the next tick's
            # GET reads 'sent', the record no longer matches, and one further
            # rejected POST happens before it stabilises. Judged self-limiting
            # (one extra attempt, no mutation ever lands) and left as is.
            project.quote_status_remote = zoho_status
            # Never silent: a write to Books that failed is operational news,
            # and the previous design lost the rejection entirely in one
            # branch.
            logger.warning(
                "Books rejected setting estimate %s to %s for project %s while it reads %s: %s",
                project.quote_id,
                local,
                project.id,
                zoho_status,
                e,
            )
            await record(
                db,
                project.id,
                "sync.status_rejected",
                actor_class="system",
                subject_type="project",
                subject_id=project.id,
                detail={"ours": project.quote_status, "theirs": project.quote_status_remote},
            )
            return
        _clear_block(project)
        return

    # Undecided: adopt Books' status. A client opening or letting a quote
    # expire is news to us, not something to overwrite — and an adopted
    # ACCEPTANCE is the same news the panel's Accept button delivers, so it
    # stamps quote_accepted_at through the shared helper.
    adopt_quote_status(project, zoho_status)
    _clear_block(project)


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
            # Direct assignment, not adopt_quote_status: a decline never stamps.
            project.quote_status = "declined"
            _clear_block(project)
        project.quote_sync_state = "idle"
        project.quote_sync_error = None
        project.quote_sync_failures = 0
        return True
    restore_target = _RESTORE_TARGET.get(project.quote_status_before_trash or "")
    if status == "declined" and restore_target is not None:
        await zoho_service.advance_estimate_status(db, project.quote_id, restore_target, current=status)
        # Direct assignment, NOT adopt_quote_status: the restore returns the
        # pre-trash status. The job was accepted long ago; restamping here
        # would reset the card's age to the day it came out of the trash.
        project.quote_status = restore_target
        project.quote_status_before_trash = None
        _clear_block(project)
    return False


async def _update_quote(db: AsyncSession, project: AitoProject) -> None:
    estimate = await zoho_service.get_estimate(db, project.quote_id)
    if _is_locked(estimate):
        # Sticky: Books does not practically un-invoice. Set only here, never
        # in the tax-exclusive lock branch below, and never back to False.
        #
        # A locked project leaves the sweep for good, so a block recorded
        # before it was invoiced would render on the card forever with nothing
        # left running that could ever clear it. There is also nothing left to
        # push: the block described an attempt this module will never make
        # again.
        await _lock_project(
            db,
            project,
            project.id,
            reason=None,
            invoiced=True,
            estimate=estimate,
            clear_block=True,
            reset_failures=True,
        )
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
        # Same as the invoiced branch above: 'locked' is excluded from the
        # sweep permanently, so nothing would ever clear a stale block again.
        await _lock_project(
            db,
            project,
            project.id,
            reason=(
                "This quote is tax-exclusive; Aito costs are tax-inclusive and cannot be pushed without inflating the total"
            ),
            estimate=estimate,
            clear_block=True,
            reset_failures=True,
        )
        return
    catalogue = await zoho_service.get_catalogue(db)
    tasks = await load_export_tasks(db, project.id)
    if not any(enabled_services(task) for task in tasks):
        # Mirrors the create-path guard: a project whose only priced service
        # was just cleared by hand would otherwise PUT an empty line_items
        # array, and Books deletes every Aito line a live quote had. A
        # terminal state, not a silent no-op: without one, this project would
        # be re-selected every tick forever — an unbounded GET
        # /estimates/{id} against Books every 300s for as long as it sits
        # empty. The next edit that adds a service back re-marks it pending
        # as normal, same as create.
        #
        # Decided on TASK content, not on the built line_items array, for the
        # same reason as the create-path guard: build_line_items appends the
        # shipping line unconditionally, and existing foreign lines are echoed
        # unconditionally too, so either alone would make "the array came out
        # empty" the wrong test — a project with zero priced tasks but
        # shipping attached would otherwise PUT a shipping-only line_items
        # array onto a LIVE quote, deleting every real task line it had. This
        # is the destructive half of the two guards; the other only skips a
        # POST.
        project.quote_sync_state = "error"
        project.quote_sync_error = "Project has no priced service left; nothing was written to the quote"
        project.quote_sync_failures = 0
        await record(
            db,
            project.id,
            "sync.failed",
            actor_class="system",
            subject_type="project",
            subject_id=project.id,
            detail={"error": project.quote_sync_error, "failures": project.quote_sync_failures},
        )
        return
    line_items = build_line_items(
        tasks,
        estimate.get("line_items") or [],
        catalogue,
        shipping=load_export_shipping(project, catalogue),
    )
    updated = await zoho_service.update_estimate_lines(db, project.quote_id, line_items)
    await _write_back_rounded_impression(db, project.id)
    _apply_estimate(project, updated)
    await record(
        db,
        project.id,
        "sync.pushed",
        actor_class="system",
        subject_type="project",
        subject_id=project.id,
        detail={"lines": len(line_items)},
    )


async def _rollback_after_terminal_failure(db: AsyncSession) -> None:
    """Undo any half-flushed writes from the failure just caught, before a
    terminal branch below writes its own state or calls ``record()`` --
    itself a flush. A no-op when the session was never actually poisoned.

    The exception just caught can ITSELF be a failed flush: ``record()``'s
    own ``IntegrityError`` from two overlapping ticks racing the same
    ``zoho_comment_id``, or ``_apply_estimate``'s writes landing on a
    ``quote_id`` the partial unique index ``uq_aito_project_active_quote``
    already holds for another active project. SQLAlchemy auto-aborts the
    DBAPI transaction the moment a flush fails -- without the caller having
    to ask -- so left alone, the very next operation against this session,
    including a bare attribute READ and not only another flush, raises
    ``PendingRollbackError``. ``Session.rollback()`` is what SQLAlchemy's own
    error message directs.

    Gated on ``db.is_active`` rather than called unconditionally: an earlier
    version of this helper always rolled back, on the theory that "nothing of
    this project's tick is committed yet, so there is nothing here to lose
    that the caller does not immediately rewrite" -- which is true for the
    four terminal `except` clauses in ``sync_project`` (each rewrites
    ``quote_sync_state``/``quote_sync_error``/``quote_sync_failures``
    immediately after calling this), but FALSE for the comment-mirror
    recovery site: most of what lands there is an ordinary network or mapping
    exception from ``list_estimate_comments``/``mirror_comments`` that never
    touched the database at all, and blindly rolling back there discarded
    ``reconcile_quote_status``'s already-flushed writes from earlier in the
    SAME tick with nothing to rewrite them -- caught by the existing test
    suite once the four terminal handlers stopped being the only callers.
    ``is_active`` is exactly the fact that matters: it is False only when a
    flush has already failed and left the session in SQLAlchemy's own
    "partial rollback" state, which is the one situation ``record()``'s next
    flush cannot survive.

    Deliberately does NOT read or refresh ``project`` afterwards. A bare
    attribute access on the now-expired instance, outside the greenlet
    context an awaited SQLAlchemy call runs inside, is exactly the "lazy
    reload outside a greenlet context" trap run_sync_once's own loop comment
    warns about (it would raise ``MissingGreenlet``, not silently reload).
    Every caller below reads "the state before this failure" from the local
    variables ``sync_project`` captures at its own top, before the try block,
    rather than by touching the object again here.
    """
    if not db.is_active:
        await db.rollback()


async def _terminal_error(
    db: AsyncSession,
    project: AitoProject,
    project_id: int,
    message: str,
    already_in_error: bool,
    previous_sync_error: str | None,
) -> None:
    """Shared terminal-failure sequence for four of ``sync_project``'s
    ``except`` clauses (``ZohoRequestRejected``, ``ZohoAmbiguousReferenceError``,
    ``ZohoNotFound``, and the catch-all) -- every one that treats the failure
    as final rather than something to retry: roll back any half-flushed
    writes, mark the project ``'error'``, store the message, and reset
    ``quote_sync_failures`` to 0.

    The reset is what the sweep path's SYNC_FAILURE_LIMIT recovery above
    relies on (see the comment there): a counter still AT the limit is a
    stored fact identifying the error as the ``ZohoUpstreamError`` escalation
    and nothing else, so every OTHER terminal error must clear it in the same
    breath it sets 'error', which is exactly what this helper makes
    structural instead of four independent copies to keep in sync.

    Deliberately NOT used by the ``ZohoUpstreamError`` handler: below its own
    escalation threshold that handler's counter increments rather than
    resetting, and even once escalated it re-derives the same failures/error
    values before AND after the rollback -- different enough from the other
    four's uniform "reset to 0" that folding it in here would blur the one
    invariant this helper exists to keep obvious.

    ``already_in_error``/``previous_sync_error`` must be the snapshot taken at
    the top of ``sync_project``, not read from ``project`` here: the rollback
    this helper performs can expire every attribute on the object (see
    ``_rollback_after_terminal_failure``'s own docstring), and a bare read of
    an already-expired instance outside a greenlet context raises
    ``MissingGreenlet``.

    ``sync.failed`` is recorded only on the tick this failure first arises,
    or whose message genuinely changes -- same transition-only rule in every
    caller, so a project stuck in 'error' but still re-selected by the sweep
    does not write one event row per tick for as long as it stays broken.
    """
    await _rollback_after_terminal_failure(db)
    project.quote_sync_state = "error"
    project.quote_sync_error = message
    project.quote_sync_failures = 0
    if not already_in_error or previous_sync_error != project.quote_sync_error:
        await record(
            db,
            project_id,
            "sync.failed",
            actor_class="system",
            subject_type="project",
            subject_id=project_id,
            detail={"error": project.quote_sync_error, "failures": project.quote_sync_failures},
        )


async def sync_project(db: AsyncSession, project: AitoProject) -> None:
    """One project's whole state machine. Never raises: every outcome is a state."""
    # Captured before anything below can touch the row, and read from these
    # locals everywhere a terminal branch or the comment-mirror recovery code
    # needs "was this already the state before this attempt" -- never by
    # re-reading `project` after a possible mid-function rollback (see
    # _rollback_after_terminal_failure), which would need an async-unsafe
    # attribute reload. Nothing between here and any exception site changes
    # these three columns (the swept branch touches only quote_status and its
    # block columns; the pending branch's own writes to them only ever happen
    # on a SUCCESS path or inside the terminal handlers themselves), so a
    # snapshot taken here is still accurate wherever it is read below.
    already_in_error = project.quote_sync_state == "error"
    previous_sync_error = project.quote_sync_error
    sync_failures_before = project.quote_sync_failures or 0
    # `project.id` itself is not exempt from this: Session.rollback() expires
    # EVERY attribute on every instance touched by the transaction, primary
    # key included, so a bare `project.id` read after
    # _rollback_after_terminal_failure is the exact async-unsafe lazy reload
    # the comment above warns about (it raised MissingGreenlet in practice,
    # not merely a hypothetical -- every record() call below needs the id,
    # and every terminal handler rolls back first). The id cannot change for
    # an already-persisted row, so a snapshot taken here is always accurate.
    project_id = project.id
    try:
        # Swept, not pending: reconcile status and nothing else. Emphatically
        # NOT _update_quote, which rebuilds the entire line_items array —
        # running that on every quoted project every tick would revert
        # hand-typed rows and catalogue overrides across the whole board (see
        # create_project's own note on why marking a fresh import pending is
        # unsafe).
        if project.quote_sync_state != "pending":
            estimate = await zoho_service.get_estimate(db, project.quote_id)
            if _is_locked(estimate):
                # Re-checked here from the estimate already in hand, not
                # trusted from whatever quote_sync_state this project last
                # settled into. Remembered state alone would miss an estimate
                # invoiced in Books since the last pending sync: it would
                # still read e.g. 'idle' and get a status POSTed onto it —
                # exactly the write the exclusion list on run_sync_once's
                # SELECT calls out as "no safer than a line-item write". No
                # extra API call: this reuses the read the sweep already did.
                #
                # Deliberately NOT mirroring _update_quote's own lock branch
                # any further than the state flip: that branch is reachable
                # at most once, only from the pending path, before the
                # project settles into 'idle' or stays 'pending' — adopting
                # Books' status there is a one-time snapshot. This branch
                # runs on EVERY quoted project EVERY tick, so adopting
                # `estimate["status"]` here would silently replace a local
                # DECIDED status (e.g. 'accepted') with whatever Books
                # happens to report mid-invoicing (often still 'draft' or
                # 'sent') on the very first sweep after the estimate is
                # invoiced — which then feeds _apply_rules below and can move
                # the card's board column too. Overwriting a board decision
                # is exactly what this whole module exists to never do
                # outside a deliberate push. Nothing is lost by leaving
                # quote_status and quote_sync_error alone: 'locked' is
                # excluded from every later sweep, so there is no ongoing
                # status to keep in sync, and no error to clear away either.
                # Sticky, same as _update_quote's lock branch above: Books
                # does not practically un-invoice.
                #
                # quote_status and quote_sync_error are deliberately left
                # alone (above), but a recorded block is neither: 'locked'
                # leaves the sweep for good, so a block kept here would render
                # "Books refused to change this quote to ..." beside "Quote
                # invoiced" forever, describing a push this module will never
                # attempt again.
                await _lock_project(db, project, project_id, invoiced=True, clear_block=True, reset_failures=True)
                return
            await reconcile_quote_status(db, project, estimate)

            # The estimate's own total, adopted from the read the reconcile
            # above already paid for. Before this, `quote_total` was written
            # ONLY by `_apply_estimate` — i.e. only on a push — so a quote
            # whose price was edited in Books kept reporting the figure it had
            # at our last push, for as long as nobody edited the project.
            #
            # Guarded on the key being present rather than coerced with
            # `or 0` the way `_apply_estimate` does it. That coercion is right
            # there and wrong here: it reads back the response to a write it
            # just made, where an absent total genuinely means "this quote has
            # no lines". This reads an estimate that already exists, so a
            # partial payload would zero a real quote's total instead.
            if estimate.get("total") is not None:
                project.quote_total = float(estimate["total"])

            now = datetime.utcnow()
            if should_pull_comments(project, estimate, now):
                try:
                    comments = await zoho_service.list_estimate_comments(db, project.quote_id)
                    await mirror_comments(db, project, comments)
                    project.zoho_comments_watermark = estimate.get("last_modified_time")
                    project.zoho_comments_checked_at = now
                except Exception:
                    # The try covers the fetch AND mirror_comments AND the two
                    # watermark writes, not just the network call. AitoEvent's
                    # zoho_comment_id is a UNIQUE column, so mirror_comments'
                    # own write path can raise (IntegrityError from two
                    # overlapping ticks racing the same comment_id) just as
                    # easily as the fetch can, and any other bug in the
                    # mapping or write path deserves the same containment. A
                    # failed comment pull must never fail the sync: the
                    # line-item and status work above is what the board
                    # depends on, and history that arrives one tick late costs
                    # nothing. Anything that escaped this block would instead
                    # reach sync_project's own outer catch-all below, which
                    # flips quote_sync_state to 'error' and overwrites
                    # quote_sync_error -- discarding this tick's
                    # already-successful reconcile_quote_status result and
                    # surfacing a misleading "sync error" for what is only a
                    # history-mirroring problem. Keeping the watermark writes
                    # inside the try is also what keeps them from advancing on
                    # a tick where mirror_comments raised: an exception here
                    # skips them, so the watermark still only moves once the
                    # pull has fully succeeded.
                    #
                    # The rollback is the same containment as every terminal
                    # handler below, and for the same reason: the IntegrityError
                    # this block exists to catch leaves the session's
                    # transaction aborted, and without an explicit rollback that
                    # poisoning survives this block -- surfacing two ticks later
                    # as _apply_rules or run_sync_once's own end-of-loop
                    # db.commit() failing and getting logged as "failed to
                    # commit project", which is the comment mirror's failure
                    # wearing a misleading name. It does mean any of
                    # reconcile_quote_status's writes still pending from just
                    # above are discarded along with the failed mirror attempt
                    # -- accepted here the same way a missed tick is accepted
                    # everywhere else in this module: the next sweep reconciles
                    # status again from scratch and costs nothing by being a
                    # tick late.
                    await _rollback_after_terminal_failure(db)
                    logger.warning("Aito comment mirror failed for project %s", project_id, exc_info=True)

            # A read that reaches this point succeeded, whatever
            # reconcile_quote_status went on to do with it — proof Books is
            # reachable right now. Reset the failure counter so a run of past
            # transient outages does not keep accumulating toward
            # SYNC_FAILURE_LIMIT and eventually strand an otherwise-healthy
            # project in 'error' with no way back except a user edit (I2).
            #
            # A counter still AT the limit is a stored fact identifying the
            # error below as sync_project's own ZohoUpstreamError escalation
            # and nothing else. That holds because EVERY other path that sets
            # 'error' resets this counter to 0 in the same breath — the
            # no-priced-service guards in _create_quote/_update_quote, and all
            # four terminal exception handlers below (ZohoRequestRejected,
            # ZohoAmbiguousReferenceError, ZohoNotFound and the catch-all).
            # Keep that true if you ever add another: an 'error' that inherits
            # a count it did not earn would have its diagnostic erased here by
            # the next successful read. The ZohoUpstreamError handler for its
            # part always overwrites quote_sync_error with its own message
            # when it increments, so the message cleared here is guaranteed to
            # be the one that handler wrote — no other subsystem's diagnostic
            # can be destroyed, and no string has to be inspected to know it.
            #
            # Read from the snapshot taken at the top of this function, not
            # from `project` directly: the comment-mirror block just above can
            # have rolled the session back (see _rollback_after_terminal_failure),
            # which expires every attribute, and a bare read here would be the
            # same async-unsafe lazy reload that helper's own docstring warns
            # against. Neither column changes between that snapshot and here on
            # any path that reaches this line, so it is still accurate.
            if already_in_error and sync_failures_before >= SYNC_FAILURE_LIMIT:
                project.quote_sync_state = "idle"
                project.quote_sync_error = None
            project.quote_sync_failures = 0
            return
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
        # Reached only when _create_quote/_update_quote returned WITHOUT
        # raising ShippingCatalogueUnavailable — this tick's push (or one of
        # their own terminal-error branches) completed normally. Drop any
        # stale deferral memory for this project so a later recurrence of the
        # same reason logs afresh rather than staying suppressed forever by a
        # dict entry from before whatever changed.
        _deferred_reasons.pop(project_id, None)
    except ZohoNotConfiguredError:
        # Not a failure: sync is simply off. Leave the project pending so it
        # syncs the moment credentials are entered.
        return
    except ShippingCatalogueUnavailable as e:
        # Not an error state: nothing is wrong with the project, the catalogue
        # simply has not resolved yet. Stay `pending` and retry next tick
        # rather than burning a failure and eventually going to 'error' — see
        # the exception's own docstring, and Catalogue.shipping_item_id's, for
        # why a terminal state here would be the opposite of what this
        # situation calls for.
        #
        # get_catalogue's own shipping read is always refresh=False (see the
        # comment above that call), so it is never what warms the cache. The
        # drawer's GET /aito/shipping/services endpoint (Task 7) warms it on
        # the happy path — it is the only other refresh=True caller now that
        # the board list's `_shipping_names` (aito.py) reads cache-only, since
        # a display name never needs a fresh rate. But that endpoint only
        # runs when someone has the drawer open. For a project that gained
        # shipping without going through it (an importer path, a wiped
        # settings row, first boot with Books down), nothing else would ever
        # fetch a resolution. Warm it here too, once, so the NEXT tick has a
        # chance even if this one still has to defer.
        message = str(e)
        # Logged only on the tick this exact deferral reason first appears,
        # via _deferred_reasons rather than any column on the project. This is
        # log-spam suppression, not a fact about the row, so a permanently
        # unresolvable service (e.g. Books' catalogue item was renamed) logs
        # once per process instead of one WARNING per tick forever — and
        # project.quote_sync_error is left untouched: a deferral is not an
        # error and must leave no trace on the row (see _deferred_reasons'
        # own comment for why this is deliberately NOT the same pattern as
        # the sync.failed handlers below, which do own that column).
        if _deferred_reasons.get(project_id) != message:
            logger.warning("Aito project %s deferred: %s", project_id, e)
            _deferred_reasons[project_id] = message
        try:
            await zoho_service.get_shipping_catalogue(db, refresh=True)
        except Exception:
            # Best-effort, and must stay that way: get_shipping_catalogue
            # already swallows ZohoNotConfiguredError/ZohoUpstreamError from
            # its own list_items call (see its docstring), but a DB error
            # from its get_setting/set_setting calls, or a bug in
            # merge_shipping_catalogue on a pathological /items payload,
            # would otherwise escape uncaught. Because this call sits INSIDE
            # an except block, no sibling handler in this same function would
            # catch that — it would escape sync_project entirely, breaking
            # its own "never raises" promise, and since run_sync_once calls
            # sync_project outside its own try, it would abort the whole tick
            # for every project still left in the batch. A failed warm-up
            # changes nothing about this tick's outcome: the project was
            # already deferring, and next tick tries the warm-up again.
            logger.warning("Aito shipping catalogue warm-up failed for project %s", project_id, exc_info=True)
        return
    except ZohoRequestRejected as e:
        # Books rejected the payload. Retrying an identical body cannot help.
        #
        # already_in_error/previous_sync_error passed through are the
        # snapshot taken at the top of this function, not read from `project`
        # here -- the exception just caught can itself be a failed flush, and
        # _terminal_error's own rollback can expire the object's attributes
        # before this handler ever runs (see its docstring).
        await _terminal_error(db, project, project_id, str(e), already_in_error, previous_sync_error)
    except ZohoAmbiguousReferenceError as e:
        # find_estimate_by_reference found more than one plausible match, or
        # the lone survivor belongs to a different customer. Like a rejected
        # payload, retrying the identical lookup cannot resolve it — it needs
        # a human to sort out the duplicate/mismatched estimate in Books —
        # and it must never be treated as "create anyway", which is exactly
        # how a real customer's estimate would get adopted and overwritten.
        await _terminal_error(db, project, project_id, str(e), already_in_error, previous_sync_error)
    except ZohoNotFound:
        await _terminal_error(
            db,
            project,
            project_id,
            "The quote no longer exists in Zoho Books",
            already_in_error,
            previous_sync_error,
        )
    except ZohoUpstreamError as e:
        # Below the limit, this is a plain in-memory write, no flush -- so
        # there is nothing here for a poisoned session to break, and no
        # rollback is needed unless the escalation branch below is taken.
        failures = sync_failures_before + 1
        project.quote_sync_failures = failures
        project.quote_sync_error = str(e)
        if failures >= SYNC_FAILURE_LIMIT:
            await _rollback_after_terminal_failure(db)
            project.quote_sync_failures = failures
            project.quote_sync_error = str(e)
            project.quote_sync_state = "error"
            # Recorded only once the retry budget is actually spent, AND only
            # on the tick that first spends it (or whose message genuinely
            # changes): every tick below the limit is a transient blip
            # _apply_estimate's own caller will simply retry, and — this is
            # the bug this guard fixes — an escalated project stays selected
            # by the sweep for as long as Books stays down (the escalation
            # does not stop it being polled, see the module-level comment on
            # SYNC_FAILURE_LIMIT), so without the guard a single outage wrote
            # one row per 300s tick for its entire duration instead of the one
            # row that matters: the moment this project actually stopped
            # retrying and surfaced on the card.
            if not already_in_error or previous_sync_error != project.quote_sync_error:
                await record(
                    db,
                    project_id,
                    "sync.failed",
                    actor_class="system",
                    subject_type="project",
                    subject_id=project_id,
                    detail={"error": project.quote_sync_error, "failures": project.quote_sync_failures},
                )
        logger.warning("Aito quote sync failed for project %s: %s", project_id, e)
    except Exception as e:
        # Anything not already handled above: a DB error, a bug in
        # build_line_items, an AttributeError on unexpected Zoho data. The
        # docstring's "never raises" promise depends on this clause — without
        # it, one project's unrelated bug unwinds out of run_sync_once's loop
        # and skips the commit that persists every other project's write
        # (including a just-created quote_id), which is how a retry turns
        # into a duplicate estimate in Books. Fail this project only.
        #
        # This is the handler FINDING 1 is really about: the exception `e`
        # caught here can BE a failed flush (record()'s own IntegrityError, or
        # any other DB error surfacing as a plain Exception), which is exactly
        # what _rollback_after_terminal_failure (called inside _terminal_error)
        # exists to recover from before the record() call does its own flush.
        #
        # The class name, never str(e). Unlike the ZohoUpstreamError branches
        # above — whose messages zoho._raise_for_status curates into "HTTP 429"
        # or Books' own user-actionable text — anything can land here, and a
        # SQLAlchemy DBAPIError's str() embeds the full statement and its bound
        # parameters (client names, phones, emails). quote_sync_error is a
        # public field of AitoProjectResponse, rendered verbatim in the detail
        # panel and as a card tooltip, and copied into the sync.failed event —
        # so str(e) would persist that PII to the immutable timeline as well as
        # showing it. The class name still discriminates one bug from the next,
        # which is what the dedupe check inside _terminal_error needs; the
        # detail stays in the logger.exception call below.
        await _terminal_error(
            db,
            project,
            project_id,
            f"Unexpected sync error ({e.__class__.__name__})",
            already_in_error,
            previous_sync_error,
        )
        logger.exception("Aito quote sync hit an unexpected error for project %s", project_id)


def _still_selected(project: AitoProject) -> bool:
    """Mirrors ``run_sync_once``'s SELECT predicate in Python, for the
    per-iteration re-check below.

    The re-fetched row can no longer be assumed to still be ``'pending'`` —
    that was true back when the pending queue was the only source of ids, but
    the swept set now contributes ids whose state is never ``'pending'`` in
    the first place. Checking against the literal string here would silently
    skip every swept project, discarding the id selection above outright.
    """
    if project.quote_sync_state == "pending":
        return True
    return (
        project.status == "active"
        and project.quote_id is not None
        and project.quote_sync_state not in ("pending", "unmanaged", "locked")
    )


async def run_sync_once(db: AsyncSession, pending_only: bool = False) -> int:
    """Drain every pending project, and reconcile the status of every other
    managed quote. Returns how many were actually attempted.

    ``pending_only`` is the wake path (see ``request_immediate_sync``): it
    skips the reconcile half entirely so a wake costs no Books calls beyond
    the pushes that were already owed.

    Not the same as the number of ids selected up front: the skip guard below
    can pass over an id whose row vanished or whose state moved on before the
    loop reached it, and those never call sync_project, so they don't count.

    Active and soft-deleted alike: a trashed project still owes Books a status
    change. Serial by design — the board holds a handful of cards, and one
    request at a time keeps the failure accounting above trivial.
    """
    selected = AitoProject.quote_sync_state == "pending"
    if not pending_only:
        selected = or_(
            selected,
            and_(
                AitoProject.status == "active",
                AitoProject.quote_id.is_not(None),
                # 'unmanaged' is the one state meaning this feature
                # must never touch the quote. 'locked' is an
                # invoiced or tax-unsafe estimate, where a status
                # write is no safer than a line-item write.
                AitoProject.quote_sync_state.not_in(("pending", "unmanaged", "locked")),
            ),
        )
    project_ids = list(
        (await db.execute(select(AitoProject.id).where(selected).order_by(AitoProject.id))).scalars().all()
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
        if project is None or not _still_selected(project):
            # Gone, or already handled by something else since the id was
            # selected above — nothing left to sync. Not counted below: it was
            # never actually attempted.
            continue
        if pending_only and project.quote_sync_state != "pending":
            # Selected as pending but the state moved on before the loop got
            # here. _still_selected alone would wave a now-reconcilable row
            # through to sync_project's reconcile branch — an extra GET the
            # wake path promises never to spend.
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
            # retry next tick. Function-level import: routes/aito.py imports
            # this module at module level (for request_immediate_sync), so a
            # module-level import here WOULD be a cycle.
            from backend.app.api.routes.aito import _apply_rules, _summary_for

            await _apply_rules(db, project, await _summary_for(db, project.id))
            await db.commit()
            try:
                await ws_manager.broadcast(
                    {"type": "aito_changed", "action": "quote-sync", "project_id": project_id, "actor": None}
                )
            except Exception:
                logger.warning("aito_changed broadcast failed for quote-sync", exc_info=True)
        except Exception:
            await db.rollback()
            logger.exception("Aito quote sync failed to commit project %s", project_id)
    return attempted


# 300s, not 60s: run_sync_once spends one Books call per active quoted
# project per tick, and Zoho allows 1,000-10,000 requests/day per org
# depending on plan. At 60s a single active quote cost 1,440 calls/day and
# two of them exhausted a Standard plan. See test_aito_quote_sync_interval.
_DEFAULT_INTERVAL_SECONDS = 300

# How long an EDIT waits before the drain it asked for actually runs. The
# window exists to keep the outbox's burst-collapsing: ten task ticks made
# while the operator works through a card still cost one PUT, not ten. Ten
# seconds because that is under the threshold at which a user goes looking for
# the quote in Books, and far enough above a human's typing cadence that an
# ordinary edit session lands as a single push.
#
# Note what this does NOT cost in quota: a wake drains PENDING projects only
# (run_sync_once(pending_only=True)), so it spends exactly the Books calls
# those projects were going to spend at the next tick anyway. It never
# reconciles the quoted-but-idle projects the 300s interval above exists to
# budget for.
EDIT_DEBOUNCE_SECONDS = 10.0

# Set by request_immediate_sync, consumed by run_sync_loop. A plain Event, not
# a queue: N wakes before the loop gets there collapse into one drain, which
# is exactly right — the drain re-reads every pending row anyway.
_wake = asyncio.Event()

# Monotonic instant the current edit window closes, or None when no edit is
# waiting. Read and written from both the request path and the loop, which is
# safe without a lock because both run on the same event loop and neither
# awaits between reading and writing it.
_debounce_deadline: float | None = None


def request_immediate_sync() -> None:
    """Ask the loop to drain PENDING projects now instead of at the next tick.

    Call this after the commit that made the project pending, never before:
    the loop reads through its own session, and a wake that fires ahead of the
    commit finds nothing, clears the event, and leaves the project waiting out
    the full interval after all.

    Creation is what this is for: the one moment a user is watching for a
    quote to appear. It also CANCELS any edit window in flight rather than
    queueing behind it — the drain re-reads every pending row, so the waiting
    edit rides along with the create instead of delaying it. Edits themselves
    go through ``request_debounced_sync``.
    """
    global _debounce_deadline
    _debounce_deadline = None
    _wake.set()


def request_debounced_sync() -> None:
    """Ask the loop to drain PENDING projects after a short window.

    The edit counterpart of ``request_immediate_sync``, and subject to the
    same "after the commit, never before" rule.

    The FIRST call opens the window; later calls inside it do NOT push the
    deadline out. That is a fixed window, not a trailing debounce, and the
    difference matters: a trailing timer lets an operator who keeps editing
    starve the push indefinitely, which is the failure this replaced (edits
    marked the project pending and then waited out the full 300s interval).
    A fixed window still collapses the burst into one PUT while bounding how
    long any single edit can wait at EDIT_DEBOUNCE_SECONDS.
    """
    global _debounce_deadline
    if _debounce_deadline is None:
        _debounce_deadline = time.monotonic() + EDIT_DEBOUNCE_SECONDS
    _wake.set()


def _debounce_delay() -> float:
    """Seconds still to wait on the open edit window, or 0 when none is."""
    if _debounce_deadline is None:
        return 0.0
    return max(0.0, _debounce_deadline - time.monotonic())


def _clear_debounce() -> None:
    global _debounce_deadline
    _debounce_deadline = None


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
        # Not a plain sleep: request_immediate_sync can cut the wait short for
        # a pending-only drain. The full tick above keeps its own fixed
        # cadence — wakes run against a DEADLINE, not a reset timer, so a
        # steady stream of creations can never starve reconciliation.
        deadline = asyncio.get_running_loop().time() + interval
        while (remaining := deadline - asyncio.get_running_loop().time()) > 0:
            try:
                await asyncio.wait_for(_wake.wait(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            # An edit's window, waited out here rather than in the request
            # handler: every further edit that lands during this sleep is
            # absorbed into the same drain, which is the whole point of the
            # window. A creation sets no deadline (and clears any standing
            # one), so it falls straight through with no delay.
            if (delay := _debounce_delay()) > 0:
                await asyncio.sleep(delay)
            _clear_debounce()
            # Cleared BEFORE draining: a wake that lands mid-drain either made
            # its row visible in time to be selected, or re-sets the event and
            # the next lap of this inner loop picks it up. Cleared after, it
            # could be lost.
            _wake.clear()
            try:
                async with async_session() as db:
                    if await sync_enabled(db) and await zoho_service.is_configured(db):
                        await run_sync_once(db, pending_only=True)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Aito quote sync wake drain failed")


def start_aito_quote_sync() -> None:
    spawn_background_task(run_sync_loop(), name="aito-quote-sync")
