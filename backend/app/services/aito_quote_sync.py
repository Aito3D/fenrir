"""Push an Aito project into its Zoho Books quote.

An outbox, not a callback: route handlers set ``quote_sync_state = 'pending'``
and return, and this module drains the queue in the background. Nothing on a
request path ever waits on Books, so a Zoho outage degrades to a retry rather
than a failed board edit, and a burst of task edits inside one tick collapses
into a single quote rewrite.

WHEN a pending card is pushed is per card (``aito_push_schedule``). A brand-new
card, a closed panel or a route that needs the quote in Books right now
(``flush_and_wait``) is pushed at once: ``request_immediate_sync``. An edit is
pushed once its card has gone quiet for ten seconds, forty-five at most:
``request_debounced_sync``. Either way the loop runs a PENDING-ONLY drain,
which spends only the Books calls those cards were going to spend anyway.

Three things keep a push from degrading into "wait for the tick": a transient
Books failure on the drain schedules its own short retries
(``FAST_RETRY_DELAYS``); pushes that fall due while background work is running
are served between its steps (``_serve_due_pushes``); and a Books rate-limit
hold stops background reads only, never a push.

Books -> board runs on two cadences. Every minute the CHANGE PASS asks Books
what it touched (``aito_change_poll``: three listings, whatever the board's
size) and re-reads only the cards that names, plus a two-card trickle as a
safety net. The full tick, every ``aito_quote_poll_seconds``, retries the
cards in error and runs the invoice, contact, payment-link and terminal
passes. Re-reading every quoted card on every tick, as this module did until
2026-10-01, cost more calls than Books allows in a minute on a 77-card board.

Phase 1 is push-only. ``quote_synced_at`` is written here and read by the
Phase 2 poller.
"""

import asyncio
import contextlib
import logging
import math
import time
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import and_, case, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import async_session
from backend.app.core.tasks import spawn_background_task
from backend.app.core.websocket import ws_manager
from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.calculator import CalculatorFilament
from backend.app.services import aito_change_poll, aito_push_schedule
from backend.app.services.aito_board_rules import AWAY_STATUSES
from backend.app.services.aito_customer_credit import read_customer_credit
from backend.app.services.aito_events import record, utc_now_naive
from backend.app.services.aito_invoice_sweep import _same_reference, sweep_inbox, sweep_invoices
from backend.app.services.aito_payment_links import deposit_pct, required_amount
from backend.app.services.aito_quote_export import (
    SERVICES,
    SERVICES_WITH_QUANTITY,
    Catalogue,
    ExportShipping,
    ExportTask,
    build_line_items,
    enabled_services,
    missing_maindoeuvre_description,
)
from backend.app.services.aito_quote_import import client_snapshot
from backend.app.services.aito_quote_status import accept_quote, adopt_quote_status
from backend.app.services.aito_shipping import island_label
from backend.app.services.aito_tracking import (
    build_tracking_url,
    mint_unique_token,
    purge_tracking_views,
    with_tracking_notes,
)
from backend.app.services.aito_zoho_comments import mirror_comments, should_pull_comments
from backend.app.services.inbox import broadcast_pending
from backend.app.services.zoho import (
    ZohoAmbiguousReferenceError,
    ZohoNotConfiguredError,
    ZohoNotFound,
    ZohoRateLimited,
    ZohoRequestRejected,
    ZohoUpstreamError,
    zoho_service,
)

logger = logging.getLogger(__name__)


async def notes_with_tracking(db: AsyncSession, project: AitoProject, existing: str | None) -> str | None:
    """The estimate's customer notes as they should read — Books' own text
    with this card's tracking block under it — or None when there is nothing
    to write: no public URL configured (build_tracking_url), or the notes
    already carry exactly this block. Never the block alone: that would
    replace the org default printed beside the totals.

    Both call sites (the create and update paths) evaluate this argument
    right before their own ``update_estimate_notes``/``update_estimate_lines``
    Books round trip. ``build_tracking_url`` mints a token via
    ``ensure_tracking_token`` for a card that has none, and that mint only
    flushes — it does not commit, so the caller's session stayed in a write
    transaction across the HTTP call that followed (T-024), the same failure
    mode ``regenerate_tracking_token`` already documents and fixes by
    committing before it talks to Books. So: when the mint here actually
    produced a NEW token for this card, commit it right now, before
    returning control to the caller's Books call — the same ordering. A card
    that already had a token mints nothing and gets no extra commit, so its
    per-project transaction boundary (one commit, in run_sync_once) is
    unchanged. Nothing else pending on `project` is expected to ride along:
    both call sites invoke this before making any other mutation to
    `project` in their own function body."""
    had_token = project.tracking_token is not None
    url = await build_tracking_url(db, project)
    if not had_token and project.tracking_token is not None:
        await db.commit()
    if not url:
        return None
    merged = with_tracking_notes(existing, url, project.tracking_token or "")
    return None if merged == (existing or "") else merged


# Consecutive upstream failures before a project's push is escalated to
# 'error'. Twenty-five minutes of a Books outage at the default 300s tick, which
# rides out a restart without giving up.
#
# It does NOT stop the project being polled, and never claim it does: the sweep
# deliberately keeps selecting 'error' projects (see run_sync_once's SELECT,
# which excludes only 'unmanaged', 'locked', and a CONFIRMED-TERMINAL card —
# archived (board_column 'done') or a settled-the-other-way quote
# (quote_status 'declined'/'expired'), AND directly observed to agree with
# Books (quote_status_confirmed), see T-010/T-026 — for a project that HAS a
# quote_id — and, separately, also selects a quote_id-less 'error' project,
# the failed-CREATE case below), so a still-active, non-terminal (or
# terminal-but-unconfirmed) escalated project is still
# re-read every tick — and that read is exactly what lets sync_project's
# recovery branch bring it back to 'idle' once Books answers again. What the
# limit ends is the retrying of the PUSH, and it surfaces the failure on the
# card instead of leaving it silently 'pending' forever.
#
# A project whose very first push (the CREATE) is what failed never earns a
# quote_id in the first place, so the "has a quote_id" half of the SELECT
# above cannot be what re-selects it. Without a second clause for that case,
# such a project would match neither branch once escalated to 'error' and
# would sit showing its failure forever, never retried, even after Books
# recovers — see T-008. The fix is a second OR'd clause selecting active,
# quote_id-IS-NULL, 'error' projects, and sync_project's routing (the
# `quote_id is not None` guard on its reconcile branch) sends those straight
# into the same CREATE path a fresh 'pending' project takes, so
# find_estimate_by_reference's idempotency guard there also protects an
# orphan estimate left behind by a create that raced a commit failure.
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

# T-028: how long background reads (reconciles, the change polls, the invoice
# sweep and polls) stand down after Books returns a 429 — see the
# ``ZohoRateLimited`` handler in ``sync_project`` below. Pushes are NOT held:
# a creation or an edit goes out inside the window and gets its own short
# retries if Books refuses it. Used only when ``ZohoRateLimited.retry_after``
# is missing or not a finite, non-negative number (Books sent no
# ``Retry-After``, or T-025's malformed header case). 60s is the length of
# Books' per-minute window.
_RATE_LIMIT_FALLBACK_SECONDS = 60.0

# T-025 (triaged): an ``inf``/``nan``/negative ``Retry-After`` must not be
# honoured as-is (it would defer forever or not at all); such a value falls
# back to ``_RATE_LIMIT_FALLBACK_SECONDS`` above instead (see the handler).
# A very large but finite value is still capped here rather than trusted
# outright, so a malformed-but-parseable header (or a legitimate but huge
# one) cannot hold background reads for longer than this. Capped at one
# minute: Books' per-minute limit is the one this worker meets, and its
# ``Retry-After`` has been seen far above the time Books actually refused
# calls (2026-10-01: a 15-minute hold while Books was accepting writes). The
# hold only stops BACKGROUND reads, so coming back early costs one refused
# call a minute at worst.
_RATE_LIMIT_MAX_RETRY_SECONDS = 60.0

# Process-local "no background read before this ``time.monotonic()``
# instant" set by the ``ZohoRateLimited`` handler in ``sync_project`` and
# read by ``run_sync_once`` (which then pushes only) and ``run_change_pass``
# (which then does nothing). Mirrors ``zoho._shipping_fail_at`` /
# ``_SHIPPING_FAIL_COOLDOWN``'s shape (a process-local memo, cleared on the
# next success, never persisted — a restart should not inherit a stale
# throttle), in ``time.monotonic()`` terms rather than wall-clock because
# this module's other process-local timers already use that clock. ``None``
# means "not throttled".
_throttled_until: float | None = None

# Project id -> how many times an edit in routes/aito.py has actually landed
# (committed) for this project, in THIS process. Bumped by
# ``_bump_requeue_marker`` below, called from routes/aito.py's
# ``_commit_and_wake`` (and the equivalent post-commit site in
# ``restore_project``, which cannot use that helper -- see its own comment)
# immediately AFTER ``db.commit()`` returns, with no ``await`` in between --
# so the bump and the commit are atomic from every other coroutine's point of
# view. Deliberately NOT bumped from inside ``_mark_pending``/
# ``_mark_pending_if_ours`` themselves, which run BEFORE that commit: a
# handler that marks a project pending and then rolls back (a DB error before
# ``_commit_and_wake``) must leave no trace here, and a marker bumped at
# mark-time rather than commit-time can be captured by this module's own
# snapshot below before the edit it describes is actually visible to this
# session -- narrowing the race this marker exists to catch instead of
# closing it. Firing on every commit that left the project pending --
# including one that leaves ``quote_sync_state`` at the value it already
# held -- is still required, and not a hypothetical: it is the exact shape of
# the race this marker exists to catch. ``_update_quote``/``_create_quote``
# read the project's own rows (``load_export_tasks``, ``load_export_shipping``)
# BEFORE the network write to Books, and an edit whose commit lands anywhere
# in that window is a same-value no-op on an ALREADY-'pending' project's
# ``quote_sync_state`` column -- SQLAlchemy does not even emit an UPDATE for
# a column reassigned to the value it already holds, so the row carries no
# trace that a requeue happened. Nothing else re-queues that edit: it is not
# in the line_items just pushed, and unconditionally writing 'idle' once the
# push returns (the bug this marker fixes) would tell the card it is in sync
# while Books is missing it.
#
# A DB column would say the same thing more durably, but every column this
# feature ever adds is an ALTER TABLE in core/database.py's run_migrations —
# out of scope for this fix, and not needed here: the marker only has to
# survive the one in-flight round trip it is guarding, and a process restart
# mid-round-trip already leaves the project 'pending' in the DB (this module
# never reached the write that would have cleared it), so the next tick
# re-syncs it correctly with no marker at all. Process-local for the same
# reason and at the same cost as ``_deferred_reasons`` above -- and, like
# that dict, popped once its job for one push is done (see the pop inside
# ``_apply_estimate``'s matching branch below) rather than left to grow for
# the process lifetime.
_requeue_marker: dict[int, int] = {}


def _bump_requeue_marker(project_id: int) -> None:
    """Record that an edit to ``project_id`` has actually landed. See
    ``_requeue_marker``'s own comment for why this has to fire on every
    commit that leaves the project pending, not only a genuine state
    transition, and why it must be called only AFTER that commit, never
    before."""
    _requeue_marker[project_id] = _requeue_marker.get(project_id, 0) + 1


def _requeue_marker_for(project_id: int) -> int:
    """The current marker value, for a caller to snapshot before its own read
    and compare against after its own write."""
    return _requeue_marker.get(project_id, 0)


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
    update-path invoiced and tax-exclusive, the sweep's own invoiced catch-up,
    and the invoice poll's adoption of a bill raised in Books): all five
    capture `was_already_locked` before mutating state so the debounce below
    never double-records a project that was already locked. That debounce is
    load-bearing for the last two, which can reach the same conclusion about
    the same project on the same tick. The parameters carry each site's own variance -- the lock reason
    (or none, via the `_UNSET` sentinel, to leave `quote_sync_error`
    untouched entirely), whether `quote_invoiced` gets stamped, whether a
    quote status is adopted from a freshly-read estimate, and whether a
    stale block/failure count is cleared -- never normalized away.
    """
    was_already_locked = project.quote_sync_state == "locked"
    project.quote_sync_state = "locked"
    if invoiced:
        project.quote_invoiced = True
    if estimate is not None:
        remote_status = estimate.get("status")
        if remote_status is not None and not (
            project.quote_status in _DECIDED and remote_status != project.quote_status
        ):
            # The same guard `_apply_estimate` applies to its own copy-back,
            # and for the same reason: a snapshot of Books' status is not a
            # licence to unmake a decision of ours. It was missing here, and
            # locking is the ONE path where the remote status is guaranteed to
            # disagree — Books flips an estimate it has billed to 'invoiced',
            # which is not a board status at all. `evaluate` reads anything
            # that is not 'accepted' as "not authorised yet", so adopting it
            # dropped the card to Devis, and `_apply_rules` then persisted
            # that over `board_column` — destroying the operator's manual
            # Finish/Done choice irrecoverably, since the stored column is the
            # only record that choice has. Seen in production on the tick
            # right after a card was dragged to Done.
            #
            # Nothing is lost by declining the adoption: 'locked' leaves the
            # sweep for good, so there is no ongoing status to keep in sync —
            # the same argument the sweep's own lock branch already makes for
            # passing no `estimate` here at all. What IS still adopted is the
            # undecided case (a 'draft'/'sent' estimate locked for being
            # tax-exclusive), which is the one-time snapshot this parameter
            # was added for.
            adopt_quote_status(project, remote_status)
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
            scan_quantity=row.scan_quantity,
            modelisation_quantity=row.modelisation_quantity,
            usinage_quantity=row.usinage_quantity,
            scan_discount_pct=row.scan_discount_pct,
            modelisation_discount_pct=row.modelisation_discount_pct,
            impression_discount_pct=row.impression_discount_pct,
            usinage_discount_pct=row.usinage_discount_pct,
            maindoeuvre_cost=row.maindoeuvre_cost,
            maindoeuvre_description=row.maindoeuvre_description,
        )
        for row in rows
    ]


def _apply_estimate(project: AitoProject, estimate: dict, *, requeue_marker: int) -> None:
    """Copy back what Books now says, so the card stops guessing.

    quote_status in particular: it used to be a snapshot frozen at import that
    went stale the moment a quote was accepted. Every push refreshes it — but
    only in the direction reconcile_quote_status allows, never over a decision
    of ours Books has not caught up with yet. See the guard below.

    ``requeue_marker`` is the ``_requeue_marker_for(project.id)`` value the
    caller captured BEFORE its own read of the project's rows — i.e. before
    anything that decided what just got pushed. If it no longer matches the
    live value, an edit committed somewhere in the window between that read
    and this call, and nothing in it reached Books: the project must stay
    'pending' for the next tick to pick up, not go 'idle' and read as
    in sync. See ``_requeue_marker``'s own comment for the full shape of the
    race this guards.

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
    if estimate.get("expiry_date") is not None:
        project.quote_expiry_date = estimate["expiry_date"]
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
    if remote_status is not None and project.quote_status == remote_status:
        # T-026: Books' own report, taken from the same push response, just
        # matched what the card now holds locally — a direct observation of
        # agreement. Guards the case where `adopt_quote_status` itself
        # refused an unrecognised status (see its own docstring): that leaves
        # `project.quote_status` unequal to `remote_status`, correctly not
        # confirmed. Gates run_sync_once/_still_selected's terminal-card
        # exclusion — see AitoProject.quote_status_confirmed's own docstring.
        project.quote_status_confirmed = True
    _clear_block(project)
    if estimate.get("last_modified_time") is not None:
        project.quote_synced_at = estimate["last_modified_time"]
    # The push that just landed in Books succeeded either way, so the failure
    # accounting always resets — an edit racing the round trip is not a
    # reason to keep reporting a stale error or a nonzero failure count.
    # Only the terminal 'idle' is conditional: see the marker comparison
    # above.
    if _requeue_marker_for(project.id) == requeue_marker:
        project.quote_sync_state = "idle"
        # This branch is the ONLY place this entry is ever removed, and that
        # is deliberate: reaching here means nothing bumped the marker
        # between the snapshot the caller captured and this comparison, i.e.
        # this push's job is done and there is nothing left for a future
        # comparison to need this value for. Mirrors the `_deferred_reasons`
        # pop on every settle path in `sync_project` below -- the same
        # process-local-bookkeeping convention this dict never followed
        # before. Never pop in the `else` (non-matching) case: that branch
        # means a newer edit bumped the marker while this push was in
        # flight, so the project is being left 'pending' ON PURPOSE for the
        # next tick to retry, and that next tick's own comparison needs
        # exactly this value to know what "unchanged since then" means.
        # Discarding it there would throw away the signal that comparison is
        # based on and narrow the guard's margin for no benefit — a missing
        # key reads as 0, same as a project that was never bumped at all, so
        # popping early would erase the record of the edit this push already
        # caught, one tick before anything needs it gone.
        _requeue_marker.pop(project.id, None)
    project.quote_sync_error = None
    project.quote_sync_failures = 0


async def _create_quote(db: AsyncSession, project: AitoProject) -> None:
    # Captured before the first read that decides what gets pushed (see
    # _requeue_marker's own comment), so _apply_estimate below can tell
    # whether an edit landed anywhere in the window this function is about to
    # open with its own network calls.
    requeue_marker = _requeue_marker_for(project.id)
    catalogue = await zoho_service.get_catalogue(db)
    tasks = await load_export_tasks(db, project.id)
    # Captured in the same breath as `tasks` above, before ANY of this
    # function's own network calls (including the orphan lookup below) can
    # open a window for a concurrent cost edit -- see _write_back_rounded_costs'
    # own docstring for why this snapshot, and not a later re-select, is what
    # that write-back must round from.
    pushed_costs = await _snapshot_pushed_costs(db, project.id)
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
    if missing_maindoeuvre_description(tasks):
        # Labour's description is mandatory (see the helper). Terminal, like
        # the no-priced-service guard above and for the same reason: leaving
        # the state alone would re-select this project every tick forever.
        # The operator's fix is an edit, which re-marks it pending as normal.
        project.quote_sync_state = "error"
        project.quote_sync_error = "Main d'oeuvre line has no description"
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
        # scan line. Setting quote_sync_state to 'pending' here — even though
        # for most callers it already IS 'pending' and this is a same-value
        # no-op — means sync_project continues straight into the normal
        # _update_quote path (in this same pass; it used to be the next
        # tick), which re-reads the FULL estimate and pushes whatever the
        # project's lines currently are. This is no longer always a
        # no-op since T-008: a project swept back in from 'error' with no
        # quote_id reaches this same branch still carrying 'error', and
        # leaving that untouched would send the NEXT tick down the reconcile
        # branch above (quote_id is now set) instead of _update_quote —
        # permanently short of the full line-item push this orphan still
        # needs, and never clearing the card's stale error icon either. Also
        # deliberately not writing quote_synced_at: this summary's
        # last_modified_time is not the full estimate's and must not be
        # trusted by the Phase 2 poller's echo suppression.
        project.quote_sync_state = "pending"
        project.quote_id = estimate["estimate_id"]
        if estimate.get("estimate_number") is not None:
            project.quote_number = estimate["estimate_number"]
        project.quote_url = await zoho_service.books_app_url(db, project.quote_id)
        project.quote_sync_error = None
        project.quote_sync_failures = 0
        return
    # The payment link is minted by reconcile_payment_links right after this
    # tick's run_sync_once (run_sync_loop), keyed on quote_number.
    payload = {
        "customer_id": project.client_id,
        "reference_number": reference_number,
        "is_inclusive_tax": True,
        # The payment link dies the same day (services/aito_payment_links.py).
        "expiry_date": expiry_for(None, await quote_validity_days(db)),
        "line_items": line_items,
    }
    estimate = await zoho_service.create_estimate(db, payload)
    # Notes are deliberately NOT in the create payload: Books fills them
    # from the org default (the signature line the PDF prints beside the
    # totals), and sending ours would replace it. Read the default back and
    # append the tracking block under it in a second call. A failure there
    # must not cost the quote just created — the next line sync writes the
    # notes again, since notes_with_tracking sees they are still missing.
    notes = await notes_with_tracking(db, project, estimate.get("notes"))
    if notes and estimate.get("estimate_id"):
        try:
            await zoho_service.update_estimate_notes(db, estimate["estimate_id"], notes)
        except Exception:  # noqa: BLE001 — logged, retried by the next sync
            logger.warning("tracking notes not written on estimate %s", estimate["estimate_id"], exc_info=True)
    await _write_back_rounded_costs(db, project.id, pushed_costs)
    # `project.quote_status` may have been decided by a completely different
    # session (routes/aito.py's set_quote_status) while create_estimate's
    # network call above was in flight; this session never sees that commit
    # on its own. Re-read it right before _apply_estimate's _DECIDED guard
    # reads it -- a sync function cannot await mid-body, so the refresh has
    # to happen here, at the one call site, rather than inside the guard
    # itself. See _update_quote's identical refresh for the fuller story and
    # this fix's own regression test.
    await db.refresh(project, ["quote_status"])
    _apply_estimate(project, estimate, requeue_marker=requeue_marker)
    logger.info("Aito quote %s created for project %s", project.quote_number, project.id)
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

    Neither does a retainer invoice. Books sets `is_transaction_created` the
    moment ANY transaction hangs off the estimate, and a retainer (a deposit)
    is one — so that flag alone locked every quote the day its deposit was
    raised (production project 18: `sync.locked` on 2026-07-31, the day of
    RET-00268, weeks before the real invoice). A real invoice shows up as a
    non-empty `invoice_ids` and/or status 'invoiced'; `invoiced_amount` is 0
    on every invoiced estimate Books actually returns (the figure lives in
    `uninvoiced_amount`) but is kept as a belt-and-braces signal.

    Still fails closed: the flag with NEITHER list explaining it is an
    unknown transaction type, and unknown means locked.
    """
    if estimate.get("invoice_ids") or estimate.get("status") == "invoiced":
        return True
    if float(estimate.get("invoiced_amount") or 0) > 0:
        return True
    if not estimate.get("is_transaction_created"):
        return False
    return not estimate.get("retainerinvoices")


async def _snapshot_pushed_costs(db: AsyncSession, project_id: int) -> dict[int, dict[str, tuple[float, int]]]:
    """The exact ``<service>_cost``/``_quantity`` figures about to go out the
    door, captured at the SAME moment as ``load_export_tasks`` — i.e. before
    the caller's own network round trip (``create_estimate`` or
    ``update_estimate_lines``) opens the window a concurrent cost edit could
    land in. ``_write_back_rounded_costs`` rounds from THIS snapshot and
    nothing else, so what it writes back is provably the figure that was
    actually pushed, never whatever the database happens to hold once the
    round trip returns — a plain re-select at that later point cannot make
    that distinction (SQLAlchemy's identity map does not repopulate a live,
    unexpired instance without ``populate_existing``, so a re-select can
    silently hand back either this same stale snapshot or, once nothing
    still references those rows, a completely fresh — and by then
    unrelated-to-the-push — value; neither answers "what did we push").
    """
    rows = (await db.execute(select(AitoTask).where(AitoTask.project_id == project_id))).scalars().all()
    return {
        row.id: {
            service: (
                getattr(row, f"{service}_cost"),
                # Deliberate, not a blanket `getattr(..., None)`: only ask for
                # a quantity on the services SERVICES_WITH_QUANTITY says have
                # one. Maindoeuvre reads as the same "no quantity field" None
                # that `quantity_of` in aito_quote_export.py returns for it —
                # it is always one unit at the full cost (see
                # build_line_items). Every other service still does a BARE
                # attribute read: if `impression_quantity` were ever renamed,
                # this must raise, not silently read 1 and let
                # `_write_back_rounded_costs` overwrite a multi-unit cost with
                # `round(cost)` — real money lost with no exception.
                max(
                    1,
                    int((getattr(row, f"{service}_quantity") if service in SERVICES_WITH_QUANTITY else None) or 1),
                ),
            )
            for service in SERVICES
            if getattr(row, f"{service}_cost") is not None
        }
        for row in rows
    }


async def _write_back_rounded_costs(
    db: AsyncSession, project_id: int, pushed_costs: dict[int, dict[str, tuple[float, int]]]
) -> None:
    """Adopt the total the quote can actually express, for every service.

    ``<service>_cost`` is a pre-discount total for all units but a line is
    rate x quantity at price_precision 0, so 2401 over 2 units is
    unrepresentable. Writing the achievable figure back here means the project
    and the quote agree immediately — rather than agreeing a tick later, as a
    visible jitter, when the Phase 2 poller pulls the quote's number back.

    ``pushed_costs`` is ``_snapshot_pushed_costs``'s own return value,
    captured by the caller before its network round trip — never re-derived
    here, and this function does no SELECT of its own. An operator can PATCH
    a task's cost from a different session while that round trip is still in
    flight, committing a new value this session has no way to see without an
    explicit refresh; rounding from a re-select run once the round trip
    returns would either compute from stale pre-push data (an identity-map
    hit) or, just as wrongly, from the operator's own brand-new figure before
    it was ever pushed anywhere. So every write below is a Core UPDATE
    guarded by ``<service>_cost == pushed_value``: it only lands on a row
    whose stored cost STILL equals the value this function rounded from, so
    a row edited mid-round-trip is left exactly as the operator committed
    it — Books catches up on that task's real value next tick, via the
    normal ``_mark_pending_if_ours`` path, instead of this write-back
    erasing it.
    """
    for task_id, costs in pushed_costs.items():
        for service, (pushed_cost, quantity) in costs.items():
            rounded = round(pushed_cost / quantity) * quantity
            if rounded == pushed_cost:
                continue
            cost_column = getattr(AitoTask, f"{service}_cost")
            await db.execute(
                update(AitoTask)
                .where(AitoTask.id == task_id, cost_column == pushed_cost)
                .values(**{f"{service}_cost": rounded})
            )


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
    # `project` was loaded by run_sync_once's db.get() before the caller's own
    # get_estimate round trip (sync_project's sweep branch, the one call
    # site), and this session never refreshes it on its own
    # (expire_on_commit=False). A decision committed by a different session
    # (routes/aito.py's set_quote_status, which bumps no _requeue_marker) while
    # that network call was in flight would otherwise be invisible here, and
    # this function would adopt Books' still-stale remote status straight over
    # it. Full refresh, not just quote_status: the guards below also read
    # quote_status_block/quote_status_remote, and set_quote_status writes all
    # three together, so refreshing quote_status alone could leave this
    # function comparing a fresh decision against a stale block record. Safe
    # to refresh unconditionally: nothing on `project` has been mutated in
    # this session between the db.get() that loaded it and this call. See
    # this fix's own regression test for the interleaving.
    await db.refresh(project)
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
        # T-026: a direct observation that Books agrees with the CURRENT
        # local status — set on every tick this holds, not just the first,
        # so a card that later drifts back into agreement (e.g. a conflict
        # resolved by a human) is confirmed again. Gates
        # run_sync_once/_still_selected's terminal-card exclusion — see
        # AitoProject.quote_status_confirmed's own docstring.
        project.quote_status_confirmed = True

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
        # T-026: the push above returned without raising — Books just
        # accepted OUR decision, a direct observation of agreement. Gates
        # run_sync_once/_still_selected's terminal-card exclusion — see
        # AitoProject.quote_status_confirmed's own docstring. This is the
        # retry this whole task exists to unlock: a decline pushed while
        # Books was unreachable stays unconfirmed (and so stays selected by
        # the sweep) until a tick like this one lands the push for real.
        project.quote_status_confirmed = True
        _clear_block(project)
        return

    # Undecided: adopt Books' status. A client opening or letting a quote
    # expire is news to us, not something to overwrite — and an adopted
    # ACCEPTANCE is the same news the panel's Accept button delivers, so it
    # stamps quote_accepted_at through the shared helper.
    adopt_quote_status(project, zoho_status)
    if project.quote_status == zoho_status:
        # T-026: `adopt_quote_status` can itself refuse an unrecognised
        # remote status (see its own docstring), leaving `project.quote_status`
        # unchanged and unequal to `zoho_status` — that is NOT an observed
        # agreement, so it must not confirm. When it succeeds, this is a
        # direct copy of Books' own value: as much an observation of
        # agreement as the branch above. Gates run_sync_once/_still_selected's
        # terminal-card exclusion — see AitoProject.quote_status_confirmed's
        # own docstring.
        project.quote_status_confirmed = True
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
    # `project` was loaded before the caller's `get_estimate` round trip
    # (`_update_quote`, just above the one call site) and this session never
    # refreshes it on its own (`expire_on_commit=False`, no eager reload
    # elsewhere in this tick). Re-read `status` here, right before branching
    # on it, so a trash/restore committed by another session WHILE that
    # network call was in flight is not missed: acting on the stale cached
    # value here is exactly what can decline a card someone just restored,
    # against the live Books estimate, with nothing downstream able to
    # repair it (see this fix's own regression test for the interleaving).
    # Safe to refresh unconditionally: nothing on `project` has been mutated
    # in this session between the `db.get()` that loaded it and this call.
    await db.refresh(project)
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
        # ...but the sent-clock still has to start. A card whose quote was a
        # draft when it was trashed comes back as 'sent' (Books has no
        # /status/draft), and without this it would read "sent" on the board
        # with a NULL quote_sent_at -- invisible to the "quotes out" follow-up
        # bucket forever. Once-only, mirroring adopt_quote_status: a restore
        # to an away status that already carries a stamp keeps the original.
        if restore_target in AWAY_STATUSES and project.quote_sent_at is None:
            project.quote_sent_at = utc_now_naive()
        project.quote_status_before_trash = None
        _clear_block(project)
    return False


async def _update_quote(db: AsyncSession, project: AitoProject) -> None:
    # Captured before anything below reads the project's own rows or talks to
    # Books (see _requeue_marker's own comment) -- earlier than strictly
    # necessary is deliberately safe here: the only cost of a marker that is
    # "too early" is one extra tick spent re-pushing a project that turns out
    # not to have actually changed, never a lost edit.
    requeue_marker = _requeue_marker_for(project.id)
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
    # Captured in the same breath as `tasks` above, before this function's own
    # update_estimate_lines round trip below can open a window for a
    # concurrent cost edit -- see _write_back_rounded_costs' own docstring.
    pushed_costs = await _snapshot_pushed_costs(db, project.id)
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
    if missing_maindoeuvre_description(tasks):
        # Same reasoning as the create-path guard, but this one guards a live
        # PUT: writing line_items here would overwrite a real quote's items,
        # so a labour line with no description must block the write, not
        # just the initial POST. Terminal for the same reason as the
        # no-priced-service guard above, and recorded the same way so a
        # blocked update is as visible on the card's history as an emptied
        # one.
        project.quote_sync_state = "error"
        project.quote_sync_error = "Main d'oeuvre line has no description"
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
    # Pre-existing quotes get an expiry ONCE; one set by hand in Books is
    # never overwritten. Its own call, not folded into the line-item PUT, so
    # a rejected expiry can never cost a line-item push (and vice versa).
    if not estimate.get("expiry_date"):
        try:
            await zoho_service.update_estimate_fields(
                db, project.quote_id, {"expiry_date": expiry_for(estimate.get("date"), await quote_validity_days(db))}
            )
        except (ZohoUpstreamError, ZohoNotConfiguredError, ValueError):
            # ValueError too: `expiry_for` parses the estimate's own `date`,
            # and a non-ISO value from Books makes it raise before a request
            # is even made. None of the three may cost the line-item push
            # below — an expiry is a nicety, the lines are the job.
            logger.warning("expiry_date not written on estimate %s", project.quote_id, exc_info=True)
    # A card re-pointed at another contact (transfer-client) owes Books its
    # new customer: push it with the lines, or the next sweep's
    # _follow_customer reads the old customer back and undoes the transfer.
    # Decided by the explicit flag, never by "card and Books disagree": that
    # disagreement is also what a reassignment made IN Books looks like, and
    # pushing the card's customer then would silently write the old one back
    # (and bill it). Unflagged, the customer is left to _follow_customer.
    customer_move: dict = {}
    if project.client_push_pending and project.client_id:
        customer_move = {"customer_id": project.client_id, "contact_person_id": project.client_contact_person_id}
    updated = await zoho_service.update_estimate_lines(
        db,
        project.quote_id,
        line_items,
        notes=await notes_with_tracking(db, project, estimate.get("notes")),
        **customer_move,
    )
    if customer_move:
        # Cleared only once a PUT that carried the customer succeeded: a
        # failure above raises past this line and leaves the flag owed.
        project.client_push_pending = False
    await _write_back_rounded_costs(db, project.id, pushed_costs)
    # `project.quote_status` was loaded before this call's own get_estimate,
    # let alone this update_estimate_lines round trip -- and nothing in
    # between refreshes it (expire_on_commit=False). An Accept/Decline
    # committed by a different session (routes/aito.py's set_quote_status,
    # which does not mark the project pending and so bumps no
    # _requeue_marker either -- that machinery cannot see this) while either
    # network call was in flight would otherwise be invisible to the
    # _DECIDED guard inside _apply_estimate below, which would then adopt
    # Books' still-stale remote status straight over the fresh local
    # decision. Re-read it right before that guard runs; _apply_estimate
    # itself is synchronous and cannot await, so the refresh has to happen
    # here, at the call site. See this fix's own regression test for the
    # interleaving.
    await db.refresh(project, ["quote_status"])
    _apply_estimate(project, updated, requeue_marker=requeue_marker)
    await record(
        db,
        project.id,
        "sync.pushed",
        actor_class="system",
        subject_type="project",
        subject_id=project.id,
        detail={"lines": len(line_items)},
    )


async def _follow_customer(db: AsyncSession, project: AitoProject, estimate: dict) -> None:
    """Move the card to the customer the estimate now names, when they differ.

    Books is the record for WHO a quote belongs to: the board can only pick a
    contact at creation (the panel's contact sheet edits the contact's own
    details, it never swaps to another one), so a disagreement here always
    means the quote was re-assigned in Zoho. Runs on the read the sweep
    already pays for, so the common case — same customer — costs nothing and
    touches no versioned field.

    On a change, the five client fields are re-snapshotted from the new
    contact exactly as import does it. A contact read that fails degrades the
    same way import degrades: id and name from the estimate itself, no phone,
    email or company flag — the invoice poll, invoice list, rating and
    history all key on ``client_id``, so the card must follow even when the
    contact is unreachable, and the details land on a later tick's edit.

    Two card-only facts describe the OLD person and are cleared with it: the
    social handle pair (Books has no field it could have come from) and the
    contacted stamp (the new client was never told the job is ready, so the
    follow-up rules must re-arm). Recorded on the card's history as a system
    event; the cleared stamp gets its own ``project.contacted.cleared`` with
    ``cause: zoho`` beside the rule move's ``cause: rule``. The public
    tracking token, when the card has one, is rotated too: the old client
    holds that link.

    This IS a write to VERSIONED_FIELDS, on purpose: an operator mid-edit on
    that panel gets a 409 on save, which is right — their draft was based on
    the wrong client.
    """
    remote_id = str(estimate.get("customer_id") or "")
    if not remote_id or remote_id == (project.client_id or ""):
        return
    if project.client_push_pending:
        # A transfer Books has not received yet: the card is the side that
        # changed, and _update_quote pushes its customer. Following Books here
        # would undo the transfer. Any other disagreement is Books' own
        # reassignment, which the card follows.
        return
    try:
        contact = await zoho_service.get_contact(db, remote_id)
    except (ZohoNotConfiguredError, ZohoUpstreamError):
        logger.warning(
            "Aito: estimate %s moved to customer %s but the contact could not be read; adopting id and name only",
            project.quote_id,
            remote_id,
            exc_info=True,
        )
        contact = None
    snapshot = client_snapshot(estimate, contact)
    from_id, from_name = project.client_id, project.client_name
    project.client_id = snapshot["id"]
    project.client_name = snapshot["name"]
    project.client_phone = snapshot["phone"]
    project.client_email = snapshot["email"]
    project.client_is_company = snapshot["is_company"]
    project.client_social_network = None
    project.client_social_handle = None
    # The old client holds the card's public tracking link: rotate it so
    # that link stops showing the job, as transfer_client does.
    if project.tracking_token:
        project.tracking_token = await mint_unique_token(db)
    await record(
        db,
        project.id,
        "project.client.changed",
        actor_class="system",
        subject_type="project",
        subject_id=project.id,
        detail={"from_id": from_id, "from_name": from_name, "to_id": snapshot["id"], "to_name": snapshot["name"]},
    )
    if project.client_contacted_at is not None:
        project.client_contacted_at = None
        await record(
            db,
            project.id,
            "project.contacted.cleared",
            actor_class="system",
            subject_type="project",
            subject_id=project.id,
            detail={"cause": "zoho"},
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
    # This project just left the pending/swept flow for a state a retry
    # cannot climb out of on its own. Any deferral memory from before this
    # error is for a disposition that no longer holds, so drop it here too —
    # same hygiene as the pop on the normal-return path below, and safe for
    # the same reason: _deferred_reasons only ever gates the log line below
    # (sync_project's own ShippingCatalogueUnavailable handler, further down
    # this file), never a DB write or recorded event, so forgetting it early
    # just means the next ShippingCatalogueUnavailable (if this project ever
    # gets back to pending) logs once fresh instead of staying suppressed by
    # a reason that belongs to a different attempt.
    _deferred_reasons.pop(project_id, None)
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


def _arm_rate_limit_throttle(e: ZohoRateLimited) -> None:
    """Set ``_throttled_until`` from a caught ``ZohoRateLimited``.

    Extracted (T-006) so both callers that can observe a 429 — this
    module's own ``sync_project`` handler below, and ``run_sync_loop``'s
    ``sweep_invoices`` call site, which has no project to attribute the
    log line to and lets the exception propagate here instead of handling
    it inline — arm the exact same process-local backoff window instead of
    each keeping its own memo. See ``_throttled_until``'s module-level
    comment for the shape.

    ``e.retry_after`` is honoured only when it is a genuine, usable hint:
    not None, and a finite, non-negative number — ``inf``/``nan``/negative
    (T-025, triaged) fall back to the fixed window exactly like "no header
    at all" rather than being trusted at face value, which for a negative
    or NaN value would defer for zero time (no protection) or crash the
    comparison below, and for `inf` would defer forever. A large-but-finite
    value is still capped at _RATE_LIMIT_MAX_RETRY_SECONDS so a malformed
    (or simply huge) Retry-After cannot freeze the loop for longer than
    that.
    """
    global _throttled_until
    retry_after = e.retry_after
    if retry_after is not None and math.isfinite(retry_after) and retry_after >= 0:
        window = min(retry_after, _RATE_LIMIT_MAX_RETRY_SECONDS)
    else:
        window = _RATE_LIMIT_FALLBACK_SECONDS
    logger.warning(
        "Zoho Books rate limit (code %s, Retry-After %r): holding background reads for %.0fs",
        e.code,
        e.retry_after_raw,
        window,
    )
    _throttled_until = time.monotonic() + window


@dataclass
class _SyncAttempt:
    """What ``sync_project`` snapshots about one project before touching it.

    Every field but ``project`` is captured once at the top of
    ``sync_project`` and never changes afterwards (see the comments there for
    why each one must be a snapshot rather than a later read of the row).
    ``project`` is the instance every later step and every exception handler
    works on: ``_apply_deposit_trigger`` replaces it with the re-fetched row
    after a successful retainer acceptance, exactly as the local variable used
    to be rebound when all of this was one function.
    """

    project: AitoProject
    project_id: int
    already_in_error: bool
    previous_sync_error: str | None
    sync_failures_before: int
    push_path: bool


async def sync_project(
    db: AsyncSession,
    project: AitoProject,
    credit_cache: dict[str, float] | None = None,
    retainer_cache: dict[str, list[dict]] | None = None,
    *,
    fast_retry: bool = False,
) -> bool | None:
    """One project's whole state machine. Never raises: every outcome is a state.

    ``fast_retry`` marks a drain the loop scheduled itself from
    ``FAST_RETRY_DELAYS`` after a transient push failure. A transient failure
    on such a drain still records its message on the card but does not count
    toward ``SYNC_FAILURE_LIMIT`` — see the constant's own comment.

    ``credit_cache`` is the sweep's per-tick memo for the customer-credit side
    read (aito_customer_credit.read_customer_credit): ``run_sync_once`` hands
    one dict to every project of the tick so N projects of one customer cost
    one Books call. ``retainer_cache`` is the same thing for the other side
    read, the customer's retainer invoices (``_customer_retainers``, used by
    Trigger B to see a deposit taken at the counter). A direct caller passes
    neither and simply reads.

    Returns True only when the failure just handled was a Zoho rate limit
    (HTTP 429, see the ``ZohoRateLimited`` handler below) — ``run_sync_once``
    uses that to stop attempting the rest of this tick's projects instead of
    deepening the throttle one call at a time. Every other outcome, success
    or otherwise, returns None (falsy), same as before this return value
    existed.
    """
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
    # The push (create/update) branch is the one somebody may be waiting on;
    # a reconcile read failing costs a tick of freshness and nobody notices.
    # Mirrors the routing condition on the reconcile branch below.
    push_path = project.quote_sync_state == "pending" or project.quote_id is None
    # `project.id` itself is not exempt from this: Session.rollback() expires
    # EVERY attribute on every instance touched by the transaction, primary
    # key included, so a bare `project.id` read after
    # _rollback_after_terminal_failure is the exact async-unsafe lazy reload
    # the comment above warns about (it raised MissingGreenlet in practice,
    # not merely a hypothetical -- every record() call below needs the id,
    # and every terminal handler rolls back first). The id cannot change for
    # an already-persisted row, so a snapshot taken here is always accurate.
    project_id = project.id
    attempt = _SyncAttempt(
        project=project,
        project_id=project_id,
        already_in_error=already_in_error,
        previous_sync_error=previous_sync_error,
        sync_failures_before=sync_failures_before,
        push_path=push_path,
    )
    try:
        # Swept, not pending: reconcile status and nothing else. Emphatically
        # NOT _update_quote, which rebuilds the entire line_items array —
        # running that on every quoted project every tick would revert
        # hand-typed rows and catalogue overrides across the whole board (see
        # create_project's own note on why marking a fresh import pending is
        # unsafe).
        #
        # `quote_id is not None` guards this: run_sync_once's SELECT now also
        # sweeps 'error' projects that never got a quote_id (a failed CREATE —
        # see the module-level SYNC_FAILURE_LIMIT comment). There is no
        # estimate to reconcile for one of those — get_estimate(None) would
        # be a wrong call, not a retry — so it must fall through to the
        # `not project.quote_id` branch below and retry the CREATE instead,
        # exactly like a fresh 'pending' project with no quote yet.
        if project.quote_sync_state != "pending" and project.quote_id is not None:
            await _sync_reconcile(db, attempt, credit_cache, retainer_cache)
            return
        await _sync_push(db, project, project_id)
    except ZohoNotConfiguredError:
        # Not a failure: sync is simply off. Leave the project pending so it
        # syncs the moment credentials are entered.
        return
    except ShippingCatalogueUnavailable as e:
        await _defer_on_catalogue(db, project_id, e)
        return
    except ZohoRequestRejected as e:
        # Books rejected the payload. Retrying an identical body cannot help.
        #
        # already_in_error/previous_sync_error passed through are the
        # snapshot taken at the top of this function, not read from `project`
        # here -- the exception just caught can itself be a failed flush, and
        # _terminal_error's own rollback can expire the object's attributes
        # before this handler ever runs (see its docstring).
        await _terminal_error(db, attempt.project, project_id, str(e), already_in_error, previous_sync_error)
    except ZohoAmbiguousReferenceError as e:
        # find_estimate_by_reference found more than one plausible match, or
        # the lone survivor belongs to a different customer. Like a rejected
        # payload, retrying the identical lookup cannot resolve it — it needs
        # a human to sort out the duplicate/mismatched estimate in Books —
        # and it must never be treated as "create anyway", which is exactly
        # how a real customer's estimate would get adopted and overwritten.
        await _terminal_error(db, attempt.project, project_id, str(e), already_in_error, previous_sync_error)
    except ZohoNotFound:
        await _terminal_error(
            db,
            attempt.project,
            project_id,
            "The quote no longer exists in Zoho Books",
            already_in_error,
            previous_sync_error,
        )
    except ZohoRateLimited as e:
        _defer_on_rate_limit(project_id, e, push_path)
        return True
    except ZohoUpstreamError as e:
        await _escalate(db, attempt, e, fast_retry=fast_retry)
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
            attempt.project,
            project_id,
            f"Unexpected sync error ({e.__class__.__name__})",
            already_in_error,
            previous_sync_error,
        )
        logger.exception("Aito quote sync hit an unexpected error for project %s", project_id)


async def _sync_reconcile(
    db: AsyncSession,
    attempt: _SyncAttempt,
    credit_cache: dict[str, float] | None,
    retainer_cache: dict[str, list[dict]] | None,
) -> None:
    """``sync_project``'s swept route: a project already quoted and not pending.

    Reads the estimate and reconciles status, customer, total, deposits and
    comments from it -- never a line-item write. Exceptions propagate to
    ``sync_project``'s handlers unchanged.
    """
    global _throttled_until
    project = attempt.project
    project_id = attempt.project_id
    estimate = await zoho_service.get_estimate(db, project.quote_id)
    # T-028: a read that reaches this point succeeded — Books is
    # reachable, so any throttle recorded by a past ZohoRateLimited is
    # stale. Same "a successful call clears the memo" shape as
    # zoho._shipping_fail_at being cleared on a successful refresh.
    _throttled_until = None
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
        #
        # (The state flip described above is unconditional inside
        # `_lock_project` itself; the invoiced stamp, block clear and
        # failure reset described above are its invoiced=/clear_block=/
        # reset_failures= kwargs below -- each used to be its own
        # assignment here before `_lock_project` consolidated all four
        # lock sites into one helper. The rationale above still applies
        # unchanged to each of them.)
        await _lock_project(db, project, project_id, invoiced=True, clear_block=True, reset_failures=True)
        return
    await reconcile_quote_status(db, project, estimate)
    await _follow_customer(db, project, estimate)

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
    #
    # Done BEFORE Trigger B below on purpose: that block's money math
    # must read the total Books just reported, never the stale cached
    # figure from our last push — a total edited directly in Books
    # would otherwise feed the auto-accept threshold from a value
    # already known to be wrong.
    if estimate.get("total") is not None:
        project.quote_total = float(estimate["total"])

    await _apply_deposit_trigger(db, attempt, estimate, credit_cache, retainer_cache)
    # `_apply_deposit_trigger` may have swapped in a re-fetched row.
    project = attempt.project

    await _pull_comments(db, project, project_id, estimate)

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
    # no-priced-service guards in _create_quote/_update_quote, the
    # missing-maindoeuvre-description guards in the same two
    # functions, and all four terminal exception handlers below
    # (ZohoRequestRejected, ZohoAmbiguousReferenceError, ZohoNotFound
    # and the catch-all).
    # Keep that true if you ever add another: an 'error' that inherits
    # a count it did not earn would have its diagnostic erased here by
    # the next successful read. The ZohoUpstreamError handler for its
    # part always overwrites quote_sync_error with its own message
    # when it increments, so the message cleared here is guaranteed to
    # be the one that handler wrote — no other subsystem's diagnostic
    # can be destroyed, and no string has to be inspected to know it.
    #
    # Read from the snapshot taken at the top of sync_project, not
    # from `project` directly: the comment-mirror block just above can
    # have rolled the session back (see _rollback_after_terminal_failure),
    # which expires every attribute, and a bare read here would be the
    # same async-unsafe lazy reload that helper's own docstring warns
    # against. Neither column changes between that snapshot and here on
    # any path that reaches this line, so it is still accurate.
    if attempt.already_in_error and attempt.sync_failures_before >= SYNC_FAILURE_LIMIT:
        # A card that still owes Books its customer (a transfer whose
        # push escalated) goes back to pending so the push is retried;
        # settling it idle would let the next sweep follow Books back
        # to the old customer.
        project.quote_sync_state = "pending" if project.client_push_pending else "idle"
        project.quote_sync_error = None
    project.quote_sync_failures = 0


async def _apply_deposit_trigger(
    db: AsyncSession,
    attempt: _SyncAttempt,
    estimate: dict,
    credit_cache: dict[str, float] | None,
    retainer_cache: dict[str, list[dict]] | None,
) -> None:
    """The deposit side of ``_sync_reconcile``: retainer and credit figures, and Trigger B."""
    project = attempt.project
    project_id = attempt.project_id
    # Trigger B (spec §6.3): paid retainers that cover the required
    # amount are the client's go-ahead. The estimate's own
    # `retainerinvoices` list is read off the reconcile above — zero
    # extra Books calls — and covers every deposit Books attached to
    # the quote. Uses `project.quote_total` as just refreshed above,
    # not a value from before this tick's read.
    paid = _paid_retainer_total(estimate)
    # The estimate's customer, not the row's client_id, for the same
    # reason plan_invoice bills the estimate's customer.
    customer_id = str(estimate.get("customer_id") or project.client_id or "")
    needed = required_amount(project.quote_total, await deposit_pct(db))
    # T-010 (loop-20, user-approved 2026-09-23): the attached list is
    # NOT the whole story. A deposit taken at the counter (cash,
    # cheque, terminal — aito_manual_payments) and every deposit
    # Heimdall books for a paid link are raised as retainer invoices
    # that carry the QUOTE NUMBER in `reference_number` and are never
    # attached to the estimate (live DEV26-2684 / RET26-00295, see
    # aito_invoice_sweep.linked_credits). Counting only the attached
    # ones left `retainer_paid_total` at 0 for a fully paid deposit —
    # so the online link stayed live and the public tracking page
    # kept offering it, the panel's Encaissement block kept showing
    # the money as due, and the card never auto-accepted. Same
    # per-quote rule as the sweep's (`_same_reference`): a deposit
    # for a SIBLING job of the same customer still counts for
    # nothing here.
    #
    # Budget: one extra Books call per distinct customer per tick,
    # memoed in `retainer_cache` exactly like `credit_cache` below,
    # and skipped entirely when there is nothing to find — no deposit
    # required, the attached retainers already cover it, or no quote
    # number to match against. Best-effort: a Books hiccup leaves the
    # attached-only figure in place (what this line computed before
    # the fix), never a sync error; only a 429 escapes, for the same
    # reason it does out of read_customer_credit below.
    #
    # T-046 (loop-21, user-approved 2026-09-26): that 429 is held, not
    # raised on the spot. Raised here it skipped the credit read just
    # below, so one throttled retainer listing left BOTH deposit
    # figures stale for the tick. Now a throttled listing keeps the
    # previously stored `retainer_paid_total` (a partial,
    # attached-only figure is not written over it, and nothing below
    # may auto-accept on it), the credit read still runs, and the
    # held 429 is re-raised right after it — so sync_project's
    # ZohoRateLimited handler, the tick's stand-down and the retry
    # budget behave exactly as before.
    retainer_throttle: ZohoRateLimited | None = None
    if needed is not None and paid < needed and project.quote_number:
        try:
            retainers = await _customer_retainers(db, customer_id, retainer_cache)
        except ZohoRateLimited as e:
            retainer_throttle = e
        else:
            if retainers:
                paid += _referenced_retainer_total(estimate, retainers, project.quote_number)
    if retainer_throttle is None:
        project.retainer_paid_total = paid
    # Beside it, the CUSTOMER's unspent deposits — a different figure
    # with a different meaning (see aito_customer_credit): what they
    # still have on account across every retainer, quote-linked or
    # raised by hand, which is what the panel shows as "deposit
    # available". One extra Books call per customer per tick, memoed
    # in `credit_cache`; best-effort, so None leaves the stored
    # figure alone. Its own 429 propagates as always — unless the
    # retainer listing's 429 is already held, which is then the one
    # reported (the credit figure simply stays as stored).
    try:
        credit = await read_customer_credit(db, customer_id, credit_cache)
    except ZohoRateLimited:
        if retainer_throttle is None:
            raise
        credit = None
    if credit is not None:
        project.customer_credit_total = credit
    if retainer_throttle is not None:
        raise retainer_throttle
    if needed is not None and paid >= needed and project.quote_status != "accepted":
        accepted = await accept_quote(
            db, project, source="retainer", detail={"amount": paid, "reference": project.quote_number}
        )
        if accepted:
            # `accept_quote`'s Books push is best-effort, and a FAILED
            # push rolls the session back — which expires every ORM
            # object it tracks, `project` included. The very next bare
            # attribute read (should_pull_comments, just below) would
            # then raise MissingGreenlet, get caught by sync_project's
            # catch-all, and flip the card to quote_sync_state='error'
            # for a tick in which the acceptance actually SUCCEEDED.
            # Re-fetch by id (an awaited load, so no lazy IO off the
            # greenlet) before anything reads the project again. A None
            # here means the row vanished under us — fall through with
            # what we have rather than inventing a failure.
            refreshed = await db.get(AitoProject, project_id)
            if refreshed is not None:
                attempt.project = refreshed


async def _pull_comments(db: AsyncSession, project: AitoProject, project_id: int, estimate: dict) -> None:
    """The comment-mirror step of ``_sync_reconcile``; never raises."""
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


async def _sync_push(db: AsyncSession, project: AitoProject, project_id: int) -> None:
    """``sync_project``'s push route: create the quote, or push a pending update.

    Exceptions propagate to ``sync_project``'s handlers unchanged.
    """
    global _throttled_until
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
            # Same hygiene as the pop below on the normal-return path:
            # this tick never reached _create_quote/_update_quote, so
            # that pop never ran, and a stale deferral reason from before
            # the project was trashed would otherwise sit in the dict
            # forever. Safe for the same reason as everywhere else this
            # dict is touched -- it only gates the log line in the
            # ShippingCatalogueUnavailable handler below, never a DB
            # write -- so if this project is later restored and defers
            # again, it just logs once fresh instead of staying
            # suppressed by a reason that belongs to before the trash.
            _deferred_reasons.pop(project_id, None)
            return
        await _create_quote(db, project)
        if project.quote_id is not None and project.quote_sync_state == "pending":
            # _create_quote found and adopted an orphan (a POST that
            # reached Books but whose response or commit never landed):
            # identity only, lines unverified — see its own comment. Or
            # _apply_estimate's requeue guard saw an edit land mid-POST.
            # Either way the card now shows a quote number with the
            # print button disabled, and "the next tick" is up to a poll
            # interval away while the operator waits at the printer.
            # Finish the job in this same pass: the exact call the next
            # tick would have made, with a failure handled exactly as one
            # there would be.
            await _update_quote(db, project)
    else:
        await _update_quote(db, project)
    # Reached only when _create_quote/_update_quote returned WITHOUT
    # raising ShippingCatalogueUnavailable — this tick's push (or one of
    # their own terminal-error branches) completed normally. Drop any
    # stale deferral memory for this project so a later recurrence of the
    # same reason logs afresh rather than staying suppressed forever by a
    # dict entry from before whatever changed.
    _deferred_reasons.pop(project_id, None)
    # T-028: same "reached without a 429" signal as the reconcile branch's
    # own clear above.
    _throttled_until = None


async def _defer_on_catalogue(db: AsyncSession, project_id: int, e: ShippingCatalogueUnavailable) -> None:
    """``sync_project``'s ShippingCatalogueUnavailable handler body; never raises."""
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


def _defer_on_rate_limit(project_id: int, e: ZohoRateLimited, push_path: bool) -> None:
    """``sync_project``'s ZohoRateLimited handler body (the caller returns True)."""
    # Books is throttling this org (HTTP 429). Like
    # ShippingCatalogueUnavailable above, this is not evidence anything
    # is wrong with the project or its data -- retrying the identical
    # request will simply work once the window clears -- so it must not
    # spend a slot of SYNC_FAILURE_LIMIT's retry budget the way the plain
    # ZohoUpstreamError handler just below does. Stay `pending`, leave
    # quote_sync_error and quote_sync_failures exactly as they were, and
    # tell run_sync_once (via the return value) to stop attempting the
    # rest of this tick's projects rather than turning one throttled call
    # into one-per-remaining-card, deepening it further.
    #
    # Reuses _deferred_reasons the same way the ShippingCatalogueUnavailable
    # handler does: log-spam suppression only, no DB write, so a
    # sustained throttle logs once per process instead of once per tick.
    message = str(e)
    if _deferred_reasons.get(project_id) != message:
        logger.warning("Aito project %s deferred (Zoho Books rate limit): %s", project_id, e)
        _deferred_reasons[project_id] = message
    # T-028: remember when background reads may resume, so the sweep and
    # the change pass skip straight past a still-throttled window instead
    # of spending more requests on an org that just said back off — see
    # ``_throttled_until``'s own module-level comment for why this is
    # process-local and shaped like ``zoho._shipping_fail_at``.
    if push_path:
        # A push somebody may be waiting on: the hold armed below stops
        # background reads only, and the loop retries this card on the
        # fast schedule exactly as it does after a timeout.
        _note_transient_push_failure()
    _arm_rate_limit_throttle(e)


async def _escalate(db: AsyncSession, attempt: _SyncAttempt, e: ZohoUpstreamError, *, fast_retry: bool) -> None:
    """``sync_project``'s ZohoUpstreamError handler body: count the failure, escalate at the limit."""
    project = attempt.project
    project_id = attempt.project_id
    # Below the limit, this is a plain in-memory write, no flush -- so
    # there is nothing here for a poisoned session to break, and no
    # rollback is needed unless the escalation branch below is taken.
    #
    # A fast retry (see FAST_RETRY_DELAYS) records the message but not
    # the failure: the budget counts ticks, not the extra tries squeezed
    # in between them.
    failures = attempt.sync_failures_before if fast_retry else attempt.sync_failures_before + 1
    project.quote_sync_failures = failures
    project.quote_sync_error = str(e)
    if attempt.push_path and failures < SYNC_FAILURE_LIMIT:
        # Still pending, and for a reason a retry in a few seconds can
        # fix. The loop reads this right after the drain.
        _note_transient_push_failure()
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
        if not attempt.already_in_error or attempt.previous_sync_error != project.quote_sync_error:
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


def _sweep_predicate():
    """The full (non-``pending_only``) SELECT predicate ``run_sync_once`` uses
    to pick which project ids a periodic sweep tick attempts.

    Extracted to its own function (T-022) purely so the parity test in
    test_aito_quote_sync.py has one source of truth to query against instead
    of reproducing this expression by hand — the SQLAlchemy clause itself is
    unchanged, just no longer inlined in ``run_sync_once``. Mirrored in
    Python by ``_still_selected`` below for the per-iteration re-check; see
    that function's docstring.
    """
    return or_(
        AitoProject.quote_sync_state == "pending",
        and_(
            AitoProject.status == "active",
            AitoProject.quote_id.is_not(None),
            # 'unmanaged' is the one state meaning this feature
            # must never touch the quote. 'locked' is an
            # invoiced or tax-unsafe estimate, where a status
            # write is no safer than a line-item write.
            AitoProject.quote_sync_state.not_in(("pending", "unmanaged", "locked")),
            # T-010, gated by T-026: a TERMINAL card — archived
            # (board_column 'done') or a quote Books itself considers
            # settled the other way (quote_status 'declined'/'expired') —
            # costs one Books call per tick forever otherwise, growing
            # per-tick load with board HISTORY rather than active
            # workload (see the module's own comment on
            # SYNC_FAILURE_LIMIT). Excluding it here is a pure
            # reconcile-skip: it is not written to, not escalated, not
            # touched at all. The PENDING branch above is untouched — an
            # explicit edit still flips a terminal card to 'pending' and
            # is synced exactly once, same as before.
            #
            # T-026: that exclusion is now gated on quote_status_confirmed
            # — a card is only dropped once Books has been directly
            # OBSERVED to agree, never merely because a local write made
            # it LOOK terminal (see AitoProject.quote_status_confirmed's
            # own docstring, and reconcile_quote_status's confirm sites).
            # Without this, a decline written locally while Books was
            # unreachable (quote_status='declined', push best-effort and
            # failed) matched both this exclusion and the SQL's
            # board_column check the instant it was written, and Books —
            # still holding 'sent' — never received the retry that would
            # have settled it.
            or_(
                AitoProject.quote_status_confirmed.is_(False),
                and_(
                    AitoProject.board_column != "done",
                    or_(
                        AitoProject.quote_status.is_(None),
                        AitoProject.quote_status.not_in(("declined", "expired")),
                    ),
                ),
            ),
        ),
        and_(
            AitoProject.status == "active",
            AitoProject.quote_id.is_(None),
            # T-008: a project whose quote CREATE never succeeded has no
            # quote_id, so the clause above (which requires one) can
            # never re-select it once it is escalated to 'error' — it
            # would sit showing its failure forever, retried only if a
            # human edits the card back to 'pending'. This clause is the
            # fix: it is the ONLY state worth re-selecting for a
            # quote_id-less project ('idle' here means trashed before
            # ever quoted, see sync_project's own comment on that state,
            # and is correctly left alone). sync_project's routing sends
            # a project selected by this clause into the same CREATE
            # path a fresh 'pending' project takes.
            AitoProject.quote_sync_state == "error",
        ),
    )


def _attention_predicate():
    """Quoted cards that must be retried at the full tick's cadence whatever
    Books reports as changed: a card in 'error' (a failed create, or a push
    that spent its retry budget — the read that proves Books is back is what
    clears it), and a card whose status Books has not yet been seen to agree
    with (``quote_status_confirmed`` false): a decision made on the board
    while Books was unreachable, which the reconcile re-pushes until it
    lands (T-026). Two kinds of unconfirmed card: a terminal one is retried
    whatever else is recorded on it, exactly as the full sweep did; a
    non-terminal one only while no block is recorded — a decision Books
    REFUSED reads the same on every tick, so it is left to the trickle.
    Everything else is reached by the change pass."""
    return and_(
        AitoProject.status == "active",
        AitoProject.quote_sync_state.not_in(("pending", "unmanaged", "locked")),
        or_(
            AitoProject.quote_sync_state == "error",
            and_(
                AitoProject.quote_id.is_not(None),
                AitoProject.quote_status_confirmed.is_(False),
                or_(
                    AitoProject.board_column == "done",
                    AitoProject.quote_status.in_(("declined", "expired")),
                    AitoProject.quote_status_block.is_(None),
                ),
            ),
        ),
    )


def _reconcile_predicate():
    """What the change pass may reconcile: the sweep's cards, minus the ones a
    push is already owed for."""
    return and_(_sweep_predicate(), AitoProject.quote_sync_state != "pending")


def _still_selected(project: AitoProject) -> bool:
    """Mirrors ``run_sync_once``'s SELECT predicate (``_sweep_predicate``) in
    Python, for the per-iteration re-check below.

    The re-fetched row can no longer be assumed to still be ``'pending'`` —
    that was true back when the pending queue was the only source of ids, but
    the swept set now contributes ids whose state is never ``'pending'`` in
    the first place. Checking against the literal string here would silently
    skip every swept project, discarding the id selection above outright.
    """
    if project.quote_sync_state == "pending":
        return True
    if project.status != "active":
        return False
    if project.quote_id is not None:
        # 'pending' omitted here (unlike the SQL mirror's not_in): the early
        # return above already handles it, so this branch never sees it.
        # Checked BEFORE the terminal-and-confirmed check below: an
        # 'unmanaged'/'locked' card must never be re-selected regardless of
        # how its terminal/confirmed columns happen to read, matching the
        # SQL mirror's flat AND (order there does not matter, but it does
        # here since this is a sequence of early returns).
        if project.quote_sync_state in ("unmanaged", "locked"):
            return False
        # T-010, gated by T-026: an archived (board_column 'done') or
        # settled-the-other-way (quote_status 'declined'/'expired') card is
        # not re-attempted, but ONLY once Books has been directly OBSERVED to
        # agree (`quote_status_confirmed`) — see
        # AitoProject.quote_status_confirmed's own docstring. A terminal card
        # that is NOT yet confirmed (e.g. a decline pushed while Books was
        # unreachable) stays selected so the sweep keeps retrying the push.
        return not (
            (project.board_column == "done" or project.quote_status in ("declined", "expired"))
            and project.quote_status_confirmed
        )
    # No quote_id: only 'error' (a failed CREATE — see T-008 and
    # run_sync_once's own second SELECT clause) is swept back in. 'idle' with
    # no quote_id is a trashed-before-first-tick project (see sync_project's
    # own comment on that state) and 'unmanaged'/'locked' never apply without
    # a quote_id to begin with — none of those are re-selected here.
    return project.quote_sync_state == "error"


async def _commit_synced_project(db: AsyncSession, project_id: int) -> None:
    """Persist one project's sync outcome and tell the board. Shared by
    ``run_sync_once`` and the change pass's reconcile queue; the comments
    below are the reasoning for doing it per project and inside one try."""
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

        # sync_project's own terminal handlers may have called
        # _rollback_after_terminal_failure, which -- per that helper's
        # own docstring -- expires every attribute on `project` still
        # held in the identity map. A bare `project.id`/`project.
        # board_column` read at that point, outside the greenlet context
        # an awaited SQLAlchemy call runs inside, is exactly the "lazy
        # reload outside a greenlet context" trap this loop's own
        # comment above warns about: it raises MissingGreenlet, not a
        # silent reload. Re-fetch through the awaited db.get() (safe --
        # it runs inside a greenlet) using the loop's own `project_id`
        # local rather than touching the possibly-expired instance, and
        # feed the fresh instance to _apply_rules instead. `project` was
        # already confirmed non-None at the top of this iteration and
        # nothing since has deleted the row, so db.get() here is not
        # expected to return None -- same assumption every caller of
        # _apply_rules elsewhere in the codebase already makes.
        project = await db.get(AitoProject, project_id)
        await _apply_rules(db, project, await _summary_for(db, project_id))
        await db.commit()
        # Drains every inbox row this project's sync recorded (a quote
        # decision mirrored from Books, a client comment) — including
        # those an earlier mid-sync commit already landed.
        await broadcast_pending(db)
        try:
            await ws_manager.broadcast_aito(
                {"type": "aito_changed", "action": "quote-sync", "project_id": project_id, "actor": None}
            )
        except Exception:
            logger.warning("aito_changed broadcast failed for quote-sync", exc_info=True)
    except Exception:
        await db.rollback()
        logger.exception("Aito quote sync failed to commit project %s", project_id)


async def _reconcile_one(
    db: AsyncSession,
    project_id: int,
    credit_cache: dict[str, float],
    retainer_cache: dict[str, list[dict]],
    *,
    must_be_pending: bool = False,
    skip_if_pending: bool = False,
    fast_retry: bool = False,
) -> bool | None:
    """One card of a sync loop: re-fetch it, sync it, commit it. Shared by
    ``run_sync_once`` and the change pass's reconcile queue.

    Returns None when the card was skipped (gone, no longer selected, or its
    pending state ruled out by ``must_be_pending`` / ``skip_if_pending``) and
    sync_project was never called; otherwise whether it was rate limited.
    """
    # Re-fetched fresh on every iteration of the caller's loop rather than
    # loaded once as a list of instances before it. This looks like it trades
    # away a single SELECT for N of them, but that trade is load-bearing, not
    # an accident: SQLAlchemy's rollback() expires every object in the
    # session's identity map, not just the one whose commit failed —
    # regardless of expire_on_commit, which only governs commit(). If a
    # sibling project's instance were held from before the loop, the
    # commit-failure guard in _commit_synced_project would expire it, and the next attribute
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
    #
    # ``populate_existing``: read the ROW, not this session's memory of
    # it. The worker's sessions do not expire on commit, and a drain
    # served mid-tick (``_serve_due_pushes``) runs on a session that has
    # already loaded most of the board — the link reconciler and the
    # reconciles before it see to that. A card it read as 'idle' and that
    # a request handler has since committed 'pending' would otherwise
    # still read 'idle' here, be taken for "pushed by someone else"
    # below, and be skipped with its window spent and its waiter
    # released: pending, and nothing left to push it before the next
    # tick.
    project = await db.get(AitoProject, project_id, populate_existing=True)
    if project is None or not _still_selected(project):
        return None
    pending = project.quote_sync_state == "pending"
    if (must_be_pending and not pending) or (skip_if_pending and pending):
        return None
    # The kwarg only when set, for the same reason _drain_pending passes
    # its own only when set: tests fake sync_project with the positional
    # signature.
    rate_limited = await sync_project(
        db, project, credit_cache, retainer_cache, **({"fast_retry": True} if fast_retry else {})
    )
    await _commit_synced_project(db, project_id)
    return bool(rate_limited)


def _sync_selection(*, pending_only: bool, attention_only: bool):
    """The WHERE clause of ``run_sync_once``'s id selection, one per mode:

    - ``pending_only`` (the wake drain, and any call inside a rate-limit
      hold): pending cards only. Wins over ``attention_only``.
    - ``attention_only`` (the periodic tick): pending cards plus
      ``_attention_predicate``'s.
    - neither (full sweep): ``_sweep_predicate``, which already includes
      pending cards. A test seam: no production caller since the
      two-cadence loop.
    """
    selected = AitoProject.quote_sync_state == "pending"
    if not pending_only:
        # See _sweep_predicate's own docstring for why this is a function
        # call and not an inline expression here (T-022).
        selected = or_(selected, _attention_predicate()) if attention_only else _sweep_predicate()
    return selected


async def run_sync_once(
    db: AsyncSession, pending_only: bool = False, *, fast_retry: bool = False, attention_only: bool = False
) -> int:
    """Drain every pending project, and reconcile the status of every other
    non-terminal managed quote. Returns how many were actually attempted.

    Pending cards go first, whatever their id: a pending card is one somebody
    is waiting on (a creation, an edit), a reconcile is bookkeeping nobody
    watches. And between projects a non-pending pass looks for pushes that
    have fallen due (``_serve_due_pushes``): a card created while the pass is
    halfway through its reconciles gets its quote next, not after every
    remaining one — each of which is a Books round trip, ten seconds on a
    timeout.

    A pending card whose push window is still open (``aito_push_schedule``:
    an edit made less than its quiet period ago) is left alone; the drain its
    window closing wakes takes it.

    ``fast_retry`` is passed straight through to ``sync_project``; see there.

    "Non-terminal" (T-010, gated by T-026): the reconcile half skips a card
    that is archived (``board_column == "done"``) or whose quote is settled
    the other way (``quote_status`` 'declined'/'expired') — those no longer
    change on Books' side in any way that matters to the board, so
    reconciling them forever would only grow with board HISTORY, not with
    active workload. A change made directly in Zoho Books on one of those
    cards after it goes terminal is not reflected back automatically. An
    explicit edit still flips a terminal card back to 'pending' via the
    PENDING branch below (untouched by this exclusion) and syncs it exactly
    once, as before.

    The exclusion only applies once ``quote_status_confirmed`` is also True —
    i.e. once Books has been directly OBSERVED to agree with the card's
    current status, not merely assumed to (see
    ``AitoProject.quote_status_confirmed``'s own docstring). A card whose
    decision was written locally but never confirmed by Books (e.g. a
    decline pushed while Books was unreachable) looks terminal but stays
    selected, so the sweep keeps retrying the push until it lands.

    ``pending_only`` is the wake path (see ``request_immediate_sync``): it
    skips the reconcile half entirely so a wake costs no Books calls beyond
    the pushes that were already owed.

    Not the same as the number of ids selected up front: the skip guard below
    can pass over an id whose row vanished or whose state moved on before the
    loop reached it, and those never call sync_project, so they don't count.

    Active and soft-deleted alike: a trashed project still owes Books a status
    change. Serial by design — the board holds a handful of cards, and one
    request at a time keeps the failure accounting above trivial.

    A Books rate-limit hold (``_throttled_until``) stops RECONCILES, never
    pushes: inside the window any call of this function behaves as
    ``pending_only``. Before 2026-10-01 the hold stopped pushes too, and a
    429 earned by the sweep parked every creation and edit for the length of
    Books' Retry-After — 15 minutes at a time on the production board.

    ``attention_only`` is the periodic tick's selection: pending cards plus
    ``_attention_predicate``'s. The tick no longer reads every quoted card;
    ``run_change_pass`` re-reads the ones Books reports as changed.

    Neither flag set is the full sweep (``_sweep_predicate``). It has no
    production caller since the two-cadence loop — the wake drain passes
    ``pending_only``, the tick ``attention_only`` — and stays as the test
    seam the sync_project tests drive a whole pass through. See
    ``_sync_selection`` for the three modes side by side.
    """
    if _throttled_until is not None and time.monotonic() < _throttled_until:
        pending_only = True
    selected = _sync_selection(pending_only=pending_only, attention_only=attention_only)
    pending_first = case((AitoProject.quote_sync_state == "pending", 0), else_=1)
    # The state at selection time rides along with the id: a card selected
    # as pending that is no longer pending when the loop reaches it was
    # pushed by someone else in between (the mid-tick wake drain below, a
    # Force sync) and owes nothing more to this tick -- reconciling it here
    # would spend a Books read on a quote written moments ago.
    rows = (
        await db.execute(
            select(AitoProject.id, AitoProject.quote_sync_state).where(selected).order_by(pending_first, AitoProject.id)
        )
    ).all()
    now = time.monotonic()
    pending_ids = {row[0] for row in rows if row[1] == "pending"}
    # A due window for a card that is not pending any more (pushed by another
    # drain, trashed and settled) would keep the loop's wait at zero.
    aito_push_schedule.drop_due_except(now, pending_ids)
    # Pending cards still inside their quiet period are left for the drain
    # their window closing will wake. The windows of the ones taken are spent
    # here, up front and all at once: a drain cut short by a 429 must not
    # leave due windows behind to re-wake the loop into the same limit, and
    # an edit landing during a push must open a fresh window.
    due_ids = {pid for pid in pending_ids if aito_push_schedule.is_due(pid, now)}
    for pid in due_ids:
        aito_push_schedule.take(pid)
    # A waiter whose card is not pending (settled by another drain, or never
    # queued) would otherwise wait out its whole timeout.
    for pid in aito_push_schedule.waiting_ids():
        if pid not in pending_ids:
            aito_push_schedule.resolve(pid)
    # A card somebody is waiting on at a Print button goes first; after that,
    # pending before reconciles and id order, as the SELECT returned them.
    project_ids = sorted(
        (row[0] for row in rows if row[1] != "pending" or row[0] in due_ids),
        key=lambda pid: (not aito_push_schedule.has_waiter(pid), pid not in due_ids, pid),
    )
    selected_as_pending = due_ids
    attempted = 0
    # One customer-credit memo for the whole tick, so the projects of one
    # customer share a single payments read. Dies with the tick: nothing to
    # expire, and the next tick sees fresh figures.
    credit_cache: dict[str, float] = {}
    # Same shape, same lifetime, for Trigger B's retainer listing: the
    # projects of one customer share a single /retainerinvoices read.
    retainer_cache: dict[str, list[dict]] = {}
    for project_id in project_ids:
        if not pending_only:
            attempted += await _serve_due_pushes(db)
        # Skipped (None) when gone or already handled by something else since
        # the id was selected above — nothing left to sync. Not counted below:
        # it was never actually attempted. `must_be_pending`: selected as
        # pending but the state moved on before the loop got here.
        # _still_selected alone would wave a now-reconcilable row through to
        # sync_project's reconcile branch — an extra GET the wake path
        # promises never to spend, and one the full sweep has no reason to
        # spend on a quote it (or a Force sync) just wrote.
        rate_limited = await _reconcile_one(
            db,
            project_id,
            credit_cache,
            retainer_cache,
            must_be_pending=project_id in selected_as_pending,
            fast_retry=fast_retry,
        )
        if rate_limited is None:
            aito_push_schedule.resolve(project_id)
            continue
        attempted += 1
        # The attempt is committed, whatever it concluded: a route waiting on
        # this card (flush_and_wait) re-reads the row and decides. Cards a 429
        # break below never reaches keep their waiters; the fast retry that
        # follows resolves them, well inside the flush timeout.
        aito_push_schedule.resolve(project_id)
        if rate_limited:
            # sync_project just deferred this project on a 429 rather than
            # failing it (see its own ZohoRateLimited handler above); its
            # commit/broadcast for THIS project already ran normally. Every
            # other id still in project_ids would spend another request on an
            # org Books just told us to back off from, deepening the
            # throttle instead of clearing it. Stop here — they stay exactly
            # where the sweep found them (still selected next tick) and are
            # not counted in `attempted` below beyond this one.
            break
    return attempted


# How many open cards each change pass re-reads whatever Books reported: the
# safety net under the change polls. Two a minute walks a 77-card board in
# about forty minutes.
TRICKLE_PER_PASS = 2
# Background reads stop for the pass once this many Books calls went out in
# the last minute, from anyone in the process. Books refuses at 100; the
# other half is left to pushes and to operators.
BACKGROUND_CALL_CEILING = 50

# Card ids owed a reconcile, in order, no duplicates. Memory only: a restart
# empties it and the trickle re-covers every card within one cycle.
_reconcile_queue: list[int] = []
# The highest id the trickle has queued so far in this walk of the board.
_trickle_cursor = 0


def _enqueue_reconcile(project_ids: list[int]) -> None:
    for project_id in project_ids:
        if project_id not in _reconcile_queue:
            _reconcile_queue.append(project_id)


def _reset_change_pass_state() -> None:
    """Test seam."""
    global _trickle_cursor
    _reconcile_queue.clear()
    _trickle_cursor = 0


async def _cards_for_changes(db: AsyncSession, changes: aito_change_poll.Changes) -> list[int]:
    """The cards a pass's changes name: a changed estimate by its id, a
    changed payment or retainer by its customer (every open card of that
    customer — the deposit figures are per customer)."""
    named = []
    if changes.estimate_ids:
        named.append(AitoProject.quote_id.in_(changes.estimate_ids))
    if changes.customer_ids:
        named.append(AitoProject.client_id.in_(changes.customer_ids))
    if not named:
        return []
    result = await db.execute(
        select(AitoProject.id).where(_reconcile_predicate(), or_(*named)).order_by(AitoProject.id)
    )
    return list(result.scalars().all())


async def _next_trickle(db: AsyncSession) -> list[int]:
    """The next ``TRICKLE_PER_PASS`` reconcilable cards after the cursor,
    wrapping to the start of the board when the walk reaches its end."""
    global _trickle_cursor
    base = select(AitoProject.id).where(_reconcile_predicate()).order_by(AitoProject.id)
    ids = list((await db.execute(base.where(AitoProject.id > _trickle_cursor).limit(TRICKLE_PER_PASS))).scalars())
    if len(ids) < TRICKLE_PER_PASS:
        wrapped = (await db.execute(base.limit(TRICKLE_PER_PASS - len(ids)))).scalars()
        ids.extend(pid for pid in wrapped if pid not in ids)
    if ids:
        _trickle_cursor = ids[-1]
    return ids


async def _drain_reconcile_queue(db: AsyncSession) -> int:
    """Reconcile queued cards until the queue is empty, a hold is armed or
    the budget guard says stop. Whatever is left waits for the next pass."""
    credit_cache: dict[str, float] = {}
    retainer_cache: dict[str, list[dict]] = {}
    reconciled = 0
    while _reconcile_queue:
        await _serve_due_pushes(db)
        if _throttled_until is not None and time.monotonic() < _throttled_until:
            break
        if zoho_service.calls_in_last_minute() >= BACKGROUND_CALL_CEILING:
            break
        project_id = _reconcile_queue.pop(0)
        # Skipped when gone, settled, or owed a push: the push path will read
        # it. _reconcile_one reads the row, not this session's memory of it: a
        # card queued here may have been made pending by a request handler
        # since this session last read it.
        rate_limited = await _reconcile_one(db, project_id, credit_cache, retainer_cache, skip_if_pending=True)
        if rate_limited is None:
            continue
        if rate_limited:
            _reconcile_queue.insert(0, project_id)
            break
        reconciled += 1
    return reconciled


async def run_change_pass(db: AsyncSession) -> int:
    """Ask Books what changed, reconcile the cards that names plus the
    trickle. Returns how many cards were reconciled.

    Costs three listings whatever the board's size; the per-card reads are
    spent only on cards with a reason. Skipped whole inside a rate-limit
    hold, and stopped by ``BACKGROUND_CALL_CEILING``."""
    if _throttled_until is not None and time.monotonic() < _throttled_until:
        return 0
    started = time.monotonic()
    calls_before = zoho_service.calls_total
    changes = await aito_change_poll.poll_changes(db)
    _enqueue_reconcile(await _cards_for_changes(db, changes))
    if changes.rate_limited is not None:
        _arm_rate_limit_throttle(changes.rate_limited)
        return 0
    _enqueue_reconcile(await _next_trickle(db))
    reconciled = await _drain_reconcile_queue(db)
    logger.log(
        logging.INFO if reconciled else logging.DEBUG,
        "Aito change pass: %d card(s) in %.1fs, %d Books call(s), %d in the last minute, daily remaining %s, queue %d",
        reconciled,
        time.monotonic() - started,
        zoho_service.calls_total - calls_before,
        zoho_service.calls_in_last_minute(),
        zoho_service.daily_remaining,
        len(_reconcile_queue),
    )
    return reconciled


# The full tick's cadence. 300s, not 60s: the tick's passes are sized for it
# — the payment-link pass polls Heimdall for every pending link, and the
# invoice and contact polls rewind a five-minute overlap. What needs to be
# fresher than this runs on ``CHANGE_PASS_SECONDS``. See
# test_aito_quote_sync_interval.
_DEFAULT_INTERVAL_SECONDS = 300

_DEFAULT_QUOTE_VALIDITY_DAYS = 15


async def quote_validity_days(db: AsyncSession) -> int:
    from backend.app.api.routes.settings import get_setting

    raw = await get_setting(db, "aito_quote_validity_days")
    try:
        return max(1, min(365, int(raw))) if raw else _DEFAULT_QUOTE_VALIDITY_DAYS
    except ValueError:
        return _DEFAULT_QUOTE_VALIDITY_DAYS


def expiry_for(quote_date: str | None, validity_days: int) -> str:
    """The estimate's expiry_date: quote date + validity, ISO YYYY-MM-DD.
    Today when the quote has no date yet (a create, whose date Books
    assigns as today anyway)."""
    from datetime import date, timedelta

    start = date.fromisoformat(quote_date) if quote_date else date.today()
    return (start + timedelta(days=validity_days)).isoformat()


def _paid_retainer_total(estimate: dict) -> float:
    """Sum of the estimate's retainer invoices Books reports as paid. The
    same `retainerinvoices` list _is_locked and aito_invoice_create trust."""
    total = 0.0
    for entry in estimate.get("retainerinvoices") or []:
        if str(entry.get("status") or "") == "paid":
            try:
                total += float(entry.get("total") or 0)
            except (TypeError, ValueError):
                continue
    return total


def _referenced_retainer_total(estimate: dict, retainers: list[dict], quote_number: str | None) -> float:
    """Sum of the customer's PAID retainers that name this quote in
    `reference_number` and are NOT already on the estimate — the deposits
    `_paid_retainer_total` above cannot see (T-010, loop-20).

    A retainer invoice is a customer document: Books lists it under the
    estimate only when it was raised FROM the estimate. A deposit taken at
    the counter (aito_manual_payments) and every deposit Heimdall books for
    a paid payment link are raised against the customer with the quote
    number as their reference and nothing else, so they never appear in
    `estimate["retainerinvoices"]`.

    The reference rule is the sweep's own (`aito_invoice_sweep._same_reference`,
    imported rather than re-implemented so the two cannot drift), which keeps
    this figure per-QUOTE:
    an advance for another job of the same customer matches nothing here and
    is counted only as `customer_credit_total`. Rows already attached to the
    estimate are skipped so a retainer that is both attached AND referenced
    counts once. Tolerant of Books' sloppiness the same way
    `_paid_retainer_total` is: a missing or non-numeric total reads as zero
    rather than blanking the figure.
    """
    attached = {str(entry.get("retainerinvoice_id") or "") for entry in estimate.get("retainerinvoices") or []}
    attached.discard("")
    total = 0.0
    for row in retainers:
        if str(row.get("status") or "") != "paid":
            continue
        if str(row.get("retainerinvoice_id") or "") in attached:
            continue
        if not _same_reference(str(row.get("reference_number") or ""), quote_number):
            continue
        try:
            total += float(row.get("total") or 0)
        except (TypeError, ValueError):
            continue
    return total


async def _customer_retainers(
    db: AsyncSession, customer_id: str, cache: dict[str, list[dict]] | None = None
) -> list[dict] | None:
    """The customer's retainer invoices, or None when Books could not say.

    Shaped exactly like `aito_customer_credit.read_customer_credit`: the
    `cache` is the caller's per-tick memo (one Books call per customer per
    tick, dying with the tick), an empty id is refused before any call
    because Books reads an empty filter as no filter, failures are not
    cached, and a 429 is re-raised so `sync_project`'s own handler can arm
    the shared throttle instead of this side read deepening it. Every other
    Books failure returns None — "use what the estimate said" — rather than
    flipping a card that reconciled fine to a sync error.
    """
    if not customer_id:
        return None
    if cache is not None and customer_id in cache:
        return cache[customer_id]
    try:
        retainers = await zoho_service.list_customer_retainers(db, customer_id)
    except ZohoRateLimited:
        raise
    except (ZohoNotConfiguredError, ZohoUpstreamError) as e:
        logger.warning("Aito: could not list customer %s's retainers from Books: %s", customer_id, e)
        return None
    if cache is not None:
        cache[customer_id] = retainers
    return retainers


# Set whenever the loop's wait may need to end early or be recomputed: a
# drain was requested, or a card's push window was opened or changed. A plain
# Event, not a queue: N wakes before the loop gets there collapse into one.
_wake = asyncio.Event()

# True when somebody asked for a pending drain NOW (a creation, a panel
# close, a flush, a link change) as opposed to an edit merely opening its
# window. Read and written from both the request path and the loop, which is
# safe without a lock because both run on the same event loop and neither
# awaits between reading and writing it.
_drain_requested = False


def request_immediate_sync(project_id: int | None = None) -> None:
    """Ask the loop to drain pending cards now.

    Call this after the commit that made the project pending, never before:
    the loop reads through its own session, and a wake that fires ahead of
    the commit finds nothing.

    With ``project_id`` the card's push window is closed on the spot, so the
    drain takes it even if an edit had just opened a quiet period on it.
    Without one the drain still runs — it pushes every pending card whose
    window is not open and runs the payment-link change pass — which is what
    the callers with no card to push (a decline, a trashed import) are after.
    Other cards' windows are left alone: one operator's creation must not cut
    short the quiet period of a card somebody else is still editing.
    """
    global _drain_requested, _fast_retries_left
    if project_id is not None:
        aito_push_schedule.note_immediate(project_id, time.monotonic())
    _drain_requested = True
    _fast_retries_left = len(FAST_RETRY_DELAYS)
    _wake.set()


def request_debounced_sync(project_id: int) -> None:
    """An edit to this card was committed: push it once the card goes quiet.

    Each call restarts the card's quiet period (``aito_push_schedule``:
    ten seconds, bounded at forty-five from the first unsynced edit, so an
    operator who keeps editing cannot starve the push). The window is per
    card. Same "after the commit, never before" rule as above. The wake only
    makes the loop recompute its wait; nothing is drained until a window
    closes.
    """
    global _fast_retries_left
    aito_push_schedule.note_edit(project_id, time.monotonic())
    _fast_retries_left = len(FAST_RETRY_DELAYS)
    _wake.set()


def _take_drain_request() -> bool:
    """Read and clear: True when a drain was asked for since the last one."""
    global _drain_requested
    requested = _drain_requested
    _drain_requested = False
    return requested


# Backoff schedule for re-draining after a PENDING push failed transiently on
# a wake drain (a ReadTimeout, a ConnectError, a 5xx). Before this, one such
# blip on the drain a creation woke left the card pending until the next
# periodic tick — up to ``aito_quote_poll_seconds`` (300s) later, while an
# operator stood at the printer waiting for the quote. Three attempts inside
# the first minute cover a blip; a real outage then falls back to the tick
# cadence exactly as before. The schedule is re-armed by every wake, so a
# fresh creation or edit always gets its own three tries.
#
# A fast retry does NOT spend a slot of ``SYNC_FAILURE_LIMIT``'s budget (see
# ``sync_project``'s ``fast_retry`` flag): that limit was sized as "five
# consecutive TICKS", 25 minutes of outage before the card shows an error,
# and three extra attempts in the first minute must not turn it into six.
FAST_RETRY_DELAYS: tuple[float, ...] = (5.0, 15.0, 45.0)

# Set by ``sync_project`` when a pending push failed transiently, consumed by
# the loop right after the drain that ran it (``_arm_fast_retry_if_needed``).
# Same process-local, same-event-loop shape as ``_drain_requested`` above.
_transient_push_failure = False
# Retries still allowed for the wake most recently served, and the monotonic
# instant the next one is due (None when none is scheduled).
_fast_retries_left = 0
_fast_retry_deadline: float | None = None


def _note_transient_push_failure() -> None:
    """Record that this drain left a pending card unpushed for a transient
    reason. Called from ``sync_project``'s ``ZohoUpstreamError`` handler."""
    global _transient_push_failure
    _transient_push_failure = True


def _take_transient_push_failure() -> bool:
    """Read and clear the memo: True when the drain just run hit one."""
    global _transient_push_failure
    seen = _transient_push_failure
    _transient_push_failure = False
    return seen


def _arm_fast_retry_if_needed() -> None:
    """After a pending drain: schedule the next fast retry when the drain
    left a card unpushed transiently and the wake's schedule is not spent."""
    global _fast_retries_left, _fast_retry_deadline
    if not _take_transient_push_failure() or _fast_retries_left <= 0:
        return
    attempt = len(FAST_RETRY_DELAYS) - _fast_retries_left
    _fast_retries_left -= 1
    _fast_retry_deadline = time.monotonic() + FAST_RETRY_DELAYS[attempt]


def _fast_retry_delay() -> float | None:
    """Seconds until the scheduled fast retry, or None when none is due."""
    if _fast_retry_deadline is None:
        return None
    return max(0.0, _fast_retry_deadline - time.monotonic())


def _clear_fast_retry() -> None:
    global _fast_retry_deadline
    _fast_retry_deadline = None


def _reset_fast_retry_state() -> None:
    """Test seam: the three memos above are module state, reset per test."""
    global _transient_push_failure, _fast_retries_left, _fast_retry_deadline
    _transient_push_failure = False
    _fast_retries_left = 0
    _fast_retry_deadline = None


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


async def _drain_pending(db: AsyncSession, *, fast_retry: bool = False, where: str) -> int:
    """One pending-only drain plus the payment-link change pass that
    follows it, then the fast-retry bookkeeping. Shared by the loop's wake
    lap and by ``_serve_due_pushes``. Returns the drain's attempted count.

    A quote just created owes its link now, and a quote just pushed with a
    new total owes Heimdall the new amount now, not next tick — a client on
    the tracking page must never be offered a stale figure. Changes only
    (create / patch / cancel for the projects that drifted), no polling, so
    the Copy button lights up and the amount follows within seconds without
    spending the poll budget.
    """
    started = time.monotonic()
    # Only a failure inside THIS drain may arm a retry: the periodic tick's
    # own push attempts (a T-008 re-selected create, say) note the memo too,
    # and left standing it would schedule a retry after a later drain that
    # actually succeeded.
    _take_transient_push_failure()
    try:
        # The kwarg only when set: the loop's collaborator-level tests fake
        # run_sync_once with the two-argument signature.
        attempted = await run_sync_once(db, pending_only=True, **({"fast_retry": True} if fast_retry else {}))
        if attempted:
            logger.info("Aito %s drain: %d project(s) in %.1fs", where, attempted, time.monotonic() - started)
        try:
            from backend.app.services.aito_payment_links import reconcile_payment_links

            await reconcile_payment_links(db, changes_only=True)
        except Exception:
            logger.exception("Payment-link change drain failed")
        return attempted
    finally:
        _arm_fast_retry_if_needed()


async def _serve_due_pushes(db: AsyncSession) -> int:
    """Serve pushes from INSIDE background work. Returns how many projects
    the drain attempted (0 when nothing was due).

    Called between every background step — each project of a full sweep,
    each reconcile of the change pass, each pass of the tick — so a push
    waits for at most one step, a single Books round trip. Serves whatever
    is due: a requested drain (creation, flush, panel close) and every edit
    whose window has closed. An edit still inside its quiet period is left
    alone.

    Same session as the caller, so the drain's own commit-per-project keeps
    the caller's accounting intact; a failure is contained the way the wake
    lap contains it.
    """
    if not (_drain_requested or aito_push_schedule.any_due(time.monotonic())):
        return 0
    _take_drain_request()
    _wake.clear()
    try:
        return await _drain_pending(db, where="mid-tick wake")
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Aito mid-tick wake drain failed")
        with contextlib.suppress(Exception):
            await db.rollback()
        return 0


# How often the change pass runs between full ticks.
CHANGE_PASS_SECONDS = 60.0
# Below this many calls left in Books' daily budget the change pass stops
# running on its own cadence and rides only the full tick.
DAILY_BUDGET_FLOOR = 5000

# True while the loop is running AND its last check found sync enabled and
# Books configured. ``flush_and_wait`` does not wait on a worker that will
# never push.
_serving = False


def change_pass_seconds() -> float:
    remaining = zoho_service.daily_remaining
    if remaining is not None and remaining < DAILY_BUDGET_FLOOR:
        return float("inf")
    return CHANGE_PASS_SECONDS


# How long a route waits for its card's push before answering 503.
FLUSH_TIMEOUT_SECONDS = 20.0


def can_flush() -> bool:
    """Whether a flush has anyone to serve it: the loop is running and its
    last check found sync enabled and Books configured."""
    return _serving


async def flush_and_wait(project_id: int, timeout: float = FLUSH_TIMEOUT_SECONDS, *, request: bool = True) -> bool:
    """Wait for this card's next push attempt to be committed, asking for it
    now unless ``request`` is False.

    Returns True once an attempt has completed (whatever it concluded — the
    caller re-reads the row), False when none did within ``timeout`` or when
    no worker is serving. The waiter is always removed, on timeout and on
    cancellation alike.

    ``request=False`` is for a caller whose card is still pending after an
    attempt it already asked for: it joins the worker's own next attempt (a
    fast retry, the window an edit re-opened) instead of ordering another.
    Asking again on every lap would re-push a card Books just refused as fast
    as the refusals come back, and spend ``SYNC_FAILURE_LIMIT`` in seconds.
    """
    if not can_flush():
        return False
    waiter = aito_push_schedule.add_waiter(project_id)
    if request:
        request_immediate_sync(project_id)
    try:
        await asyncio.wait_for(asyncio.shield(waiter), timeout=timeout)
        return True
    except asyncio.TimeoutError:
        return False
    finally:
        aito_push_schedule.discard_waiter(project_id, waiter)


async def run_sync_loop() -> None:
    """Drain the outbox forever. Cancellation is the only way out.

    Two cadences. The full TICK, every ``aito_quote_poll_seconds``: pending
    pushes, the attention cards, one change pass, then the invoice, contact,
    payment-link and terminal passes. Between ticks, the CHANGE PASS every
    ``CHANGE_PASS_SECONDS`` and a pending drain whenever a push falls due.

    Every iteration takes its own session and swallows its own errors: one bad
    tick must not kill the loop, or a single transient failure would silently
    end syncing until the next restart.
    """
    global _serving
    try:
        while True:
            interval = _DEFAULT_INTERVAL_SECONDS
            tick_started = time.monotonic()
            # The tick's own pending-first pass IS any retry still scheduled.
            _clear_fast_retry()
            try:
                async with async_session() as db:
                    interval = await sync_interval_seconds(db)
                    # Whether anything can be pushed at all: the same gate the
                    # laps below apply before draining.
                    serving = await sync_enabled(db) and await zoho_service.is_configured(db)
                    _serving = serving
                    if serving:
                        # This drain IS any drain somebody just asked for.
                        _take_drain_request()
                        await run_sync_once(db, attention_only=True)
                        await _serve_due_pushes(db)
                        # Its own try, like every pass below: a failure here
                        # (a locked database while a watermark is stored, a
                        # bug) costs this tick's change pass only — never the
                        # invoice, contact, payment-link and terminal passes
                        # that follow it. Rolled back so a half-flushed pass
                        # cannot poison the session they share.
                        try:
                            await run_change_pass(db)
                        except Exception:
                            logger.exception("Aito change pass failed")
                            with contextlib.suppress(Exception):
                                await db.rollback()
                        # Piggybacks on the same gate: no Books access, no sweep.
                        # Its own hourly gate makes the 300 s tick a no-op most
                        # of the time.
                        #
                        # T-006: also skipped outright while a previous 429 (from
                        # either run_sync_once above or a past sweep) has this
                        # process inside its throttle window — the same reasoning
                        # as run_sync_once's own guard: an org that just said
                        # back off must not be re-hit by the sweep every tick
                        # either. And if the sweep itself is the one that hits
                        # the 429 (it has no throttle check of its own before
                        # this point, since it may not have run in a while),
                        # having already committed each refreshed project as it
                        # went (T-010), lets the exception propagate here, where
                        # it is handled exactly like sync_project's own 429 — arm
                        # the same shared window via ``_arm_rate_limit_throttle``
                        # — so a limit discovered by the sweep also pauses the
                        # sync side.
                        if _throttled_until is None or time.monotonic() >= _throttled_until:
                            try:
                                # T-102: pushes are served between the sweep's
                                # projects, and the pass stops at the shared
                                # per-minute ceiling like the change pass.
                                await sweep_invoices(
                                    db,
                                    serve_due_pushes=_serve_due_pushes,
                                    call_ceiling=BACKGROUND_CALL_CEILING,
                                )
                                # The other direction: the sweep above asks Books
                                # about invoices this board already knows it has,
                                # once an hour. This asks what Books has CHANGED
                                # since the last tick — one call for the whole
                                # board — which is what makes an invoice raised in
                                # Books (including one raised without converting
                                # the estimate, which the sweep is structurally
                                # blind to) reach the card within a tick instead
                                # of an hour or never. Imported here rather than
                                # at module scope because it imports
                                # `_lock_project` from this module; same shape as
                                # the payment-link reconcile below.
                                from backend.app.services.aito_invoice_poll import poll_invoices

                                await poll_invoices(db)
                            except ZohoRateLimited as e:
                                logger.warning("Aito invoice sweep deferred (Zoho Books rate limit): %s", e)
                                _arm_rate_limit_throttle(e)
                            except Exception:
                                # T-052: any other Books failure (5xx, unreachable)
                                # costs this tick's invoice passes only. Letting it
                                # reach the tick's outer handler would also skip the
                                # purge and the Heimdall passes below, so a Books
                                # outage would freeze online-payment detection for
                                # as long as it lasted. Rolled back like the contact
                                # poll below, so a half-flushed sweep cannot poison
                                # the session those passes share.
                                logger.exception("Aito invoice sweep/poll failed")
                                with contextlib.suppress(Exception):
                                    await db.rollback()
                            # Contacts renamed in Books, same one-call shape as
                            # the invoice poll above (services/aito_contact_poll.py).
                            # Its own try so a failure here neither skips the
                            # non-Books passes below nor is masked by them; a 429
                            # arms the shared window like every other Books read
                            # on this tick.
                            try:
                                from backend.app.services.aito_contact_poll import poll_contacts

                                await poll_contacts(db)
                            except ZohoRateLimited as e:
                                logger.warning("Aito contact poll deferred (Zoho Books rate limit): %s", e)
                                _arm_rate_limit_throttle(e)
                            except Exception:
                                logger.exception("Aito contact poll failed")
                                with contextlib.suppress(Exception):
                                    await db.rollback()
                        await _serve_due_pushes(db)
                    else:
                        # Nothing will push: windows left due would turn the
                        # wait below into a zero-timeout spin.
                        aito_push_schedule.drop_due_except(time.monotonic(), set())
                    # Retention for the tracking-view log: unlike the sweep above,
                    # this has nothing to do with Zoho — a Fenrir instance can
                    # run the public tracking page with only `external_url` set
                    # and no Books connection at all — so it runs every tick,
                    # gated only by its own try/except like the sweep guards each
                    # project: a purge failure costs this tick, never the loop.
                    # An indexed DELETE that usually deletes nothing is cheap
                    # enough to run at the full 300 s cadence.
                    try:
                        await purge_tracking_views(db)
                    except Exception as exc:
                        logger.warning("Tracking-view purge failed: %s", exc)
                        # A failed purge commit (e.g. "database is locked") leaves
                        # this session poisoned, exactly like the terminal
                        # failures `_rollback_after_terminal_failure` documents --
                        # the very next statement on it, `reconcile_payment_links`
                        # below, would otherwise raise its own unrelated
                        # `InvalidRequestError` and mask the lock that actually
                        # caused this. Nothing from this tick's purge was meant to
                        # survive its own failed commit anyway, so an
                        # unconditional rollback costs nothing on the (common)
                        # non-poisoned path.
                        with contextlib.suppress(Exception):
                            await db.rollback()
                    # Overdue events and the inbox purge: local like the purge
                    # above, so outside the Books gate — a Books outage or a 429
                    # window must not freeze either. Hourly by its own gate; it
                    # rolls back its own database failures. Anything else that
                    # escapes it gets the purge's treatment: logged, and the
                    # session rolled back so the passes below do not run on a
                    # poisoned one.
                    try:
                        await sweep_inbox(db)
                    except Exception:
                        logger.exception("Inbox sweep failed")
                        with contextlib.suppress(Exception):
                            await db.rollback()
                    # Payment links: gated on Heimdall, not Books — a link can
                    # be polled with Books down. Its own try/except like the
                    # purge: one failed pass costs this tick, never the loop.
                    try:
                        from backend.app.services.aito_payment_links import reconcile_payment_links

                        await reconcile_payment_links(db)
                    except Exception:
                        logger.exception("Payment-link reconcile failed")
                    if serving:
                        await _serve_due_pushes(db)
                    try:
                        from backend.app.services.aito_terminal_payments import poll_open_terminal_payments

                        await poll_open_terminal_payments(db)
                    except Exception:
                        logger.exception("Terminal payment poll failed")
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Aito quote sync tick failed")
            # One line per tick so a slow board (many quoted cards, a slow Books
            # day) is visible in the log rather than guessed at.
            logger.info("Aito quote sync tick took %.1fs", time.monotonic() - tick_started)
            loop = asyncio.get_running_loop()
            deadline = loop.time() + interval
            next_change = loop.time() + change_pass_seconds()
            while (remaining := deadline - loop.time()) > 0:
                # The wait ends at whichever comes first: the tick, the
                # change pass, a scheduled fast retry, a push window closing
                # — or a wake, which re-evaluates all of them. The tick keeps
                # its own fixed cadence: wakes run against a DEADLINE, not a
                # reset timer, so a steady stream of creations can never
                # starve it.
                due = [d for d in (_fast_retry_delay(), aito_push_schedule.next_due(time.monotonic())) if d is not None]
                timeout = min(remaining, max(0.0, next_change - loop.time()), *due)
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(_wake.wait(), timeout=timeout)
                # Cleared BEFORE draining: a wake that lands mid-drain either
                # made its row visible in time to be selected, or re-sets the
                # event and the next lap picks it up. Cleared after, it could
                # be lost.
                _wake.clear()
                retry_due = _fast_retry_delay() == 0.0
                push_due = _take_drain_request() or aito_push_schedule.any_due(time.monotonic())
                change_due = loop.time() >= next_change
                if not (retry_due or push_due or change_due):
                    # An edit opened or moved a window: nothing to drain yet,
                    # only a new timeout to compute.
                    continue
                if retry_due or push_due:
                    # The drain below IS the retry, if one was scheduled. A
                    # lap that only runs the change pass leaves it standing.
                    _clear_fast_retry()
                try:
                    async with async_session() as db:
                        serving = await sync_enabled(db) and await zoho_service.is_configured(db)
                        _serving = serving
                        if not serving:
                            aito_push_schedule.drop_due_except(time.monotonic(), set())
                        else:
                            if retry_due or push_due:
                                # A lap the loop scheduled itself is a retry;
                                # anything a wake or a window asked for is not.
                                retry_only = retry_due and not push_due
                                await _drain_pending(
                                    db, fast_retry=retry_only, where="fast-retry" if retry_only else "wake"
                                )
                            if change_due:
                                await run_change_pass(db)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception("Aito quote sync wake drain failed")
                    # The drain may have died before it took its windows.
                    aito_push_schedule.drop_due_except(time.monotonic(), set())
                if change_due:
                    next_change = loop.time() + change_pass_seconds()
    finally:
        _serving = False


def start_aito_quote_sync() -> None:
    spawn_background_task(run_sync_loop(), name="aito-quote-sync")
