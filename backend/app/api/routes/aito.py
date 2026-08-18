"""Aito production board: DB-backed Kanban with soft delete."""

import logging
import re
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import and_, case, func, or_, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.core.websocket import ws_manager
from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.user import User
from backend.app.schemas.aito import (
    AitoEventPage,
    AitoEventResponse,
    AitoFlagUpdate,
    AitoInvoiceResponse,
    AitoNoteCreate,
    AitoProjectCreate,
    AitoProjectImport,
    AitoProjectMove,
    AitoProjectResponse,
    AitoProjectUpdate,
    AitoQuoteEmailContent,
    AitoQuoteEmailRecipient,
    AitoQuoteEmailRequest,
    AitoQuoteEmailResponse,
    AitoQuoteStatusResponse,
    AitoQuoteStatusUpdate,
    AitoShippingIsland,
    AitoShippingService,
    AitoShippingServicesResponse,
    AitoSummarizeRequest,
    AitoSummarizeResponse,
    AitoTaskCreate,
    AitoTaskReorder,
    AitoTaskResponse,
    AitoTaskStepsResponse,
    AitoTaskUpdate,
)
from backend.app.services.aito_board_rules import SERVICES, TaskSummary, evaluate, summarise
from backend.app.services.aito_events import diff_fields, kinds_for_depth, record
from backend.app.services.aito_quote_status import adopt_quote_status
from backend.app.services.aito_quote_sync import (
    _bump_requeue_marker,
    request_debounced_sync,
    request_immediate_sync,
)
from backend.app.services.aito_shipping import (
    SERVICE_LABELS,
    grouped_islands,
    service_for_island,
)
from backend.app.services.openrouter import OpenRouterNotConfiguredError, OpenRouterUpstreamError, summarize_tasks
from backend.app.services.zoho import (
    ZohoNotConfiguredError,
    ZohoNotFound,
    ZohoRequestRejected,
    ZohoUpstreamError,
    zoho_service,
)
from backend.app.utils.http import build_content_disposition

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/aito", tags=["aito"])

# Deliberately stricter than the client's own ClientDraft.formatPhone, which
# will happily emit something as short as +689-123: this is the API boundary
# that has to hold, not the form, so it requires 4+ national digits rather
# than merely matching the country-code-dash shape formatPhone produces.
_SHIPPING_PHONE_RE = re.compile(r"^\+\d{1,4}-\d{4,14}$")


_SHIPPING_COLUMNS = (
    "shipping_island",
    "shipping_service",
    "shipping_first_name",
    "shipping_last_name",
    "shipping_phone",
    "shipping_price",
)

# kind -> event, spelled out rather than f-string-built, so every kind in
# services/aito_events.KINDS stays greppable from its call site.
_FLAG_SET_EVENT: dict[str, str] = {
    "urgent": "project.urgent.set",
    "sav": "project.sav.set",
    "pause": "project.pause.set",
}
_FLAG_CLEARED_EVENT: dict[str, str] = {
    "urgent": "project.urgent.cleared",
    "sav": "project.sav.cleared",
    "pause": "project.pause.cleared",
}

# Display rank for the board. Urgent and SAV mean "look at this" and rise;
# pause means the opposite and sinks; unflagged sits between them. Stored
# `position` breaks ties inside each tier, exactly as before.
#
# ONE dict, three consumers — the SQL `case` below, the Python sort in the
# reorder handler, and (mirrored) `flagRank` in frontend/src/utils/aitoBoard.ts.
# Open-coding the comparison at each site is how the board starts saying one
# thing in SQL and another in the client.
_FLAG_RANK: dict[str, int] = {"urgent": 0, "sav": 0, "pause": 2}
_UNFLAGGED_RANK = 1


def _flag_rank(flag: str | None) -> int:
    """Rank for the Python-side sort. An unrecognised value ranks as
    unflagged rather than raising: this runs on a drag, and a row written by
    a newer version of the app must not make the board un-draggable."""
    return _UNFLAGGED_RANK if flag is None else _FLAG_RANK.get(flag, _UNFLAGGED_RANK)


# NULL compares as NULL (never True) in SQL, so an unflagged row falls
# through to `else_` and lands on _UNFLAGGED_RANK — same as _flag_rank.
_FLAG_ORDER = case(
    *[(AitoProject.flag == name, rank) for name, rank in _FLAG_RANK.items()],
    else_=_UNFLAGGED_RANK,
)


def _mentions_shipping(fields: dict) -> bool:
    """True when the payload touches at least one shipping column.

    Guards the ``get_shipping_catalogue`` RATE lookup that feeds
    ``_validated_shipping``: that call is a genuine Zoho fetch (unlike
    ``_shipping_names``'s cache-only read), so an ordinary edit that never
    mentions shipping — a description tweak, a client change — must not pay
    for it. ``_validated_shipping`` itself would no-op on such a payload
    (``supplied`` comes up empty), but only after the caller already paid for
    the catalogue read.
    """
    return any(key in fields for key in _SHIPPING_COLUMNS)


async def _tasks_by_project(db: AsyncSession, project_ids: list[int]) -> dict[int, list[AitoTask]]:
    """Every task row for the given projects, in ONE query, grouped by project.

    Replaces a hand-written GROUP BY that computed count, total, services and
    pending in SQL — a second definition of rules that already existed in
    aito_board_rules. Same query count, and 250-odd rows for a full board is
    not a volume worth a duplicate implementation.

    Projects with no tasks are absent from the result; callers pass `()` to
    `summarise`, which yields `TaskSummary()`.
    """
    if not project_ids:
        return {}
    stmt = select(AitoTask).where(AitoTask.project_id.in_(project_ids)).order_by(AitoTask.position, AitoTask.id)
    grouped: dict[int, list[AitoTask]] = {}
    for row in (await db.execute(stmt)).scalars().all():
        grouped.setdefault(row.project_id, []).append(row)
    return grouped


async def _summary_for(db: AsyncSession, project_id: int) -> TaskSummary:
    """`summarise` over one project's tasks. The single-project shape every
    handler that returns one card needs."""
    return summarise((await _tasks_by_project(db, [project_id])).get(project_id, ()))


def _validated_shipping(
    fields: dict, rates: dict[str, float | None], current: AitoProject | None = None
) -> dict | None:
    """The six shipping columns to write, or None when nothing was supplied.

    Returns every one of the six, so a caller can `setattr` them wholesale and
    never leave two of them disagreeing.

    Consistency is checked on the MERGED row, not on the payload — the same
    rule the client_id/client_name check in `update_project` follows, and for
    the same reason. On a PATCH, `current` is the stored project, so
    correcting one field of an existing shipment works without resending the
    other three; on a create there is nothing to merge with and a partial
    payload is a 422.

    An explicit `shipping_island: null` returns all six as None — the
    documented way to detach a shipment. A whitespace-only island (`"   "`),
    by contrast, is NOT treated as a detach — it is a 422, the same as a
    blank first name, last name or phone — so a client bug that trims an
    island down to nothing does not silently drop a shipment. `shipping_service`
    is derived from the island here and is never read from `fields`.

    Changing the island ALONE re-derives `shipping_service` from it, but
    KEEPS the stored `shipping_price` — the price is frozen at attach time,
    not re-looked-up on every edit. A caller that changes a shipment's island
    to a DIFFERENT service must resend `shipping_price` in the same request,
    or the shipment keeps billing the previous service's rate under the new
    service's name.
    """
    supplied = {key: fields[key] for key in fields if key in _SHIPPING_COLUMNS}
    if not supplied:
        return None

    def merged(key: str):
        if key in supplied:
            return supplied[key]
        return getattr(current, key, None) if current is not None else None

    raw_island = merged("shipping_island")
    if raw_island is not None and not raw_island.strip():
        # Distinguished from the None case below: an explicit blank string is
        # a client bug (or a UI regression) trying to clear the field, not
        # the documented way to detach a shipment — that is a literal null.
        raise HTTPException(status_code=422, detail="shipping_island must not be blank")
    island = (raw_island or "").strip()
    if not island:
        # Either an explicit detach (raw_island is None because the payload
        # sent shipping_island: null), or a field sent for a project that has
        # no shipment to correct (raw_island is None because neither the
        # payload nor `current` ever set one). Both end with all six
        # cleared, which is the right answer for the first and harmless for
        # the second: there was nothing there to lose.
        return dict.fromkeys(_SHIPPING_COLUMNS)

    service = service_for_island(island)
    if service is None:
        raise HTTPException(status_code=422, detail=f"Unknown shipping island {island!r}")

    first_name = (merged("shipping_first_name") or "").strip()
    last_name = (merged("shipping_last_name") or "").strip()
    phone = (merged("shipping_phone") or "").strip()
    if not first_name or not last_name or not phone:
        raise HTTPException(status_code=422, detail="Shipping needs a first name, a last name and a phone")
    if not _SHIPPING_PHONE_RE.match(phone):
        raise HTTPException(status_code=422, detail="shipping_phone must look like +689-89645864")

    price = merged("shipping_price")
    if price is None:
        price = rates.get(service)
    if price is None:
        raise HTTPException(status_code=422, detail="No rate is known for this service — supply shipping_price")

    return {
        "shipping_island": island,
        # Derived, never taken from the payload.
        "shipping_service": service,
        "shipping_first_name": first_name,
        "shipping_last_name": last_name,
        "shipping_phone": phone,
        "shipping_price": float(price),
    }


async def _shipping_names(db: AsyncSession) -> dict[str, str]:
    """Service key -> Books display name, resolved once per request and
    shared by every card `_to_response` builds for it.

    ``refresh=False``: this sits on the board's hot read path — polled every
    10s while a quote is pending, plus on every WebSocket invalidation and
    window focus (list_projects, list_trash, move_project, set_quote_status,
    restore_project all await it) — and a DISPLAY NAME needs a fresh rate
    even less than the ownership check in ``zoho.get_catalogue`` does: the
    name comes from our own ``SERVICE_LABELS``, not from anything Books
    returns, only the item id needs to have been learned at all. Mirrors the
    reasoning documented there. The cache is warmed elsewhere — the drawer's
    services endpoint and ``aito_quote_sync``'s deferral handler — so a stale
    or cold cache here just means an empty name map, never a network call."""
    return {
        service: item.name for service, item in (await zoho_service.get_shipping_catalogue(db, refresh=False)).items()
    }


async def _shipping_rates(db: AsyncSession) -> dict[str, float]:
    """Service key -> Books rate, for the two mutation paths that validate a
    shipping payload (create and update) and only need it once
    `_mentions_shipping` has already confirmed the request touches shipping.

    Deliberately NOT `refresh=False` like `_shipping_names` above: that one
    only needs a display name against an id already learned, but this one
    feeds `_validated_shipping`'s `shipping_price`, which gets frozen onto
    the row at attach time — a stale display name is harmless, a stale RATE
    quoted to a client is real money. Do not "unify" the two calls; the
    asymmetry is the point."""
    return {service: item.rate for service, item in (await zoho_service.get_shipping_catalogue(db)).items()}


def _to_response(p: AitoProject, summary: TaskSummary, shipping_names: dict[str, str]) -> AitoProjectResponse:
    """`summary` and `shipping_names` are both required, never defaulted. The
    detail panel writes PATCH (and move / quote-status / restore) responses
    straight into the board cache with setQueryData, replacing the row — so
    an endpoint that quietly returned zeros, or an empty shipping_names map,
    would blank a card's badges — or its shipping service name, on a card
    that HAS a shipment — and nothing would fail. Requiring both makes every
    call site state its intent instead of forgetting one silently.

    `shipping_names` is resolved ONCE per request by the caller
    (`_shipping_names`), not per row: the catalogue is one cached read and
    every card on the board shares it. This function stays synchronous —
    it cannot await the catalogue itself, or the board list would force one
    fetch per card. A caller with genuinely no shipment in play may pass an
    explicitly-named empty dict, but should prefer resolving it — it costs
    one cached settings read, and correctness beats the saving."""
    _, lock = evaluate(p.quote_status, p.board_column, summary.pending)
    return AitoProjectResponse(
        id=p.id,
        description=p.description,
        column=p.board_column,
        position=p.position,
        status=p.status,
        client_id=p.client_id,
        client_name=p.client_name,
        client_phone=p.client_phone,
        client_email=p.client_email,
        client_is_company=p.client_is_company,
        client_social_network=p.client_social_network,
        client_social_handle=p.client_social_handle,
        quote_id=p.quote_id,
        quote_number=p.quote_number,
        quote_date=p.quote_date,
        quote_total=p.quote_total,
        quote_url=p.quote_url,
        quote_salesperson=p.quote_salesperson,
        quote_status=p.quote_status,
        quote_accepted_at=p.quote_accepted_at,
        created_by=p.created_by,
        quote_sync_state=p.quote_sync_state or "idle",
        # Mirrors quote_sync_state's fallback above: the Python-side default
        # on the model column only applies at flush, so an AitoProject built
        # in memory and never flushed (see test_aito_board_summary.py) still
        # reads quote_invoiced as None here.
        quote_invoiced=bool(p.quote_invoiced),
        # No bool() coercion, unlike quote_invoiced above: the column is
        # nullable, so an in-memory AitoProject that never went through a DB
        # flush already reads as None, which is exactly "no flag".
        flag=p.flag,
        # Mirrors quote_invoiced above: in-memory rows that never flushed
        # read None.
        version=p.version or 0,
        quote_sync_error=p.quote_sync_error,
        quote_status_block=p.quote_status_block,
        quote_status_remote=p.quote_status_remote,
        task_count=summary.count,
        tasks_total=summary.total,
        task_services=list(summary.services),
        task_pending=list(summary.pending),
        steps_total=summary.steps_total,
        steps_done=summary.steps_done,
        task_steps=[
            AitoTaskStepsResponse(services=list(steps.services), done=list(steps.done), title=steps.title)
            for steps in summary.steps_by_task
        ],
        move_lock=lock,
        shipping_island=p.shipping_island,
        shipping_service=p.shipping_service,
        shipping_first_name=p.shipping_first_name,
        shipping_last_name=p.shipping_last_name,
        shipping_phone=p.shipping_phone,
        shipping_price=p.shipping_price,
        shipping_service_name=shipping_names.get(p.shipping_service or ""),
        created_at=p.created_at,
        updated_at=p.updated_at,
    )


async def _project_response(
    db: AsyncSession, p: AitoProject, summary: TaskSummary | None = None
) -> AitoProjectResponse:
    """`_to_response(p, summary, shipping_names)` with `shipping_names`
    always resolved here via `_shipping_names`, and `summary` resolved via
    `_summary_for` too when the caller has none in hand yet.

    Callers that already computed `summary` earlier — because a step before
    the response build needed it too (`_apply_rules`, `evaluate`, or simply
    because it was cheaper to derive from rows already in memory) — pass it
    explicitly, and this function only awaits `_shipping_names`. That keeps
    the original evaluation order in both cases: summary before shipping
    names.
    """
    if summary is None:
        summary = await _summary_for(db, p.id)
    return _to_response(p, summary, await _shipping_names(db))


def _task_to_response(t: AitoTask) -> AitoTaskResponse:
    return AitoTaskResponse(
        id=t.id,
        project_id=t.project_id,
        position=t.position,
        title=t.title,
        scan_description=t.scan_description,
        modelisation_description=t.modelisation_description,
        impression_description=t.impression_description,
        usinage_description=t.usinage_description,
        scan_cost=t.scan_cost,
        modelisation_cost=t.modelisation_cost,
        usinage_cost=t.usinage_cost,
        impression_printer_id=t.impression_printer_id,
        impression_filament_id=t.impression_filament_id,
        impression_weight_g=t.impression_weight_g,
        impression_time_min=t.impression_time_min,
        impression_quantity=t.impression_quantity,
        impression_color=t.impression_color,
        impression_cost=t.impression_cost,
        impression_discount_pct=t.impression_discount_pct,
        scan_done=t.scan_done,
        modelisation_done=t.modelisation_done,
        impression_done=t.impression_done,
        usinage_done=t.usinage_done,
        created_at=t.created_at,
        updated_at=t.updated_at,
    )


_DUPLICATE_QUOTE_DETAIL = "This quote already has a project on the board"


async def _reject_duplicate_quote(db: AsyncSession, quote_id: str | None, exclude_id: int | None = None) -> None:
    """A quote may back at most one ACTIVE project.

    Trashing frees the quote: soft-deleted rows are excluded, so re-importing a
    quote whose project was thrown away is allowed. That is a real workflow —
    the board carries several quotes with one active project and one or more
    trashed ones — not an oversight.

    ``quote_id`` NULL is the hand-made card, and never a duplicate of anything:
    a NULL check here rather than at every call site, because forgetting it
    would make every hand-made card collide with the first one.

    ``exclude_id`` is the row being restored, which must not count itself.

    This is a TOCTOU pre-check, not the enforcement: two concurrent requests
    can both pass it and then race each other into `uq_aito_project_active_quote`
    at commit. `_is_duplicate_active_quote_error` catches that race at the
    commit sites and raises this same 409 — this pre-check still has to stay,
    because the index is skipped at startup on installs with pre-existing
    duplicate quotes (see run_migrations in database.py), leaving it as the
    only guard there.
    """
    if quote_id is None:
        return
    stmt = select(AitoProject.id).where(
        AitoProject.quote_id == quote_id,
        AitoProject.status == "active",
    )
    if exclude_id is not None:
        stmt = stmt.where(AitoProject.id != exclude_id)
    if (await db.execute(stmt.limit(1))).scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail=_DUPLICATE_QUOTE_DETAIL)


def _is_duplicate_active_quote_error(exc: IntegrityError) -> bool:
    """True when ``exc`` is the `uq_aito_project_active_quote` race, not some other failure.

    SQLite's message for a partial-unique-index violation names the column the
    index is built on, not the index itself: "UNIQUE constraint failed:
    aito_projects.quote_id". That string is unambiguous here — `quote_id` is a
    plain indexed column (see aito_project.py), so this partial index is the
    only unique constraint that can ever produce it — which safely tells this
    race apart from unrelated IntegrityErrors that can surface from the same
    commit (e.g. `aito_events.zoho_comment_id`).

    This match is SQLite error-text specific by construction, not a generic
    constraint-name check: a different backend, or a future SQLite message
    format, simply would not match. That is deliberate and fails CLOSED — a
    non-match returns False, so both call sites `raise` the original
    IntegrityError unchanged instead of mis-reporting an unrelated failure as
    this 409.
    """
    return "aito_projects.quote_id" in str(exc.orig)


async def _active_in_column(db: AsyncSession, column: str, exclude_id: int | None = None) -> list[AitoProject]:
    stmt = (
        select(AitoProject)
        .where(AitoProject.status == "active", AitoProject.board_column == column)
        .order_by(AitoProject.position, AitoProject.id)
    )
    rows = list((await db.execute(stmt)).scalars().all())
    return [r for r in rows if r.id != exclude_id]


async def _apply_rules(db: AsyncSession, project: AitoProject, summary: TaskSummary, actor: str | None = None) -> None:
    """Recompute ``project.board_column`` from the rules and relocate it.

    Takes the summary rather than loading the tasks itself: several callers
    already need it for their own response, and loading twice per request was
    exactly the duplication this pass removes.

    An advancing project is appended to the END of its destination column —
    work arriving at a stage joins the back of that stage's queue — and the
    source column is renumbered contiguously. Both column listings are read
    BEFORE the row is mutated, so autoflush cannot make the second query
    observe the half-applied move.

    Does not commit: every caller is already inside a request that does.

    ``actor`` is the acting user's name, or None. actor_class is 'user', not
    'system': the machinery here is automatic, but a person caused it by
    ticking a step or editing a card, and the timeline should say who. The
    sync worker's call (``run_sync_once``, via a function-level import to
    avoid a circular import) passes nothing, which reads as an unattributed
    move rather than a false attribution to whichever user happened to be
    online when the worker's tick ran.
    """
    column, _ = evaluate(project.quote_status, project.board_column, summary.pending)
    if column == project.board_column:
        return

    source = project.board_column
    destination_rows = await _active_in_column(db, column, exclude_id=project.id)
    source_rows = await _active_in_column(db, source, exclude_id=project.id)
    project.board_column = column
    project.position = len(destination_rows)
    for index, row in enumerate(source_rows):
        row.position = index

    await record(
        db,
        project.id,
        "stage.changed",
        actor_class="user" if actor else "system",
        actor_name=actor,
        subject_type="project",
        subject_id=project.id,
        changes=[{"field": "column", "from": source, "to": project.board_column}],
        detail={"cause": "rule"},
    )


def _mark_pending(project: AitoProject) -> None:
    """Hand the project to the Zoho sync worker unconditionally.

    The only thing a request path ever does about Zoho. Clearing the failure
    counter is what makes an edit the natural way to retry a project stuck in
    'error' — the user fixes whatever Books objected to and saves.

    Called directly only from ``create_project``'s own-quote branch — every
    other handler edits an EXISTING project and must go through
    ``_mark_pending_if_ours`` instead, which adds the guard that keeps a
    legacy quote-less card from ever being marked. See that function's
    docstring for why the two must not be merged.

    Deliberately does NOT bump ``aito_quote_sync``'s ``_requeue_marker``
    itself — see ``_commit_and_wake``'s own comment for why that has to
    happen after this call's caller commits, not here. A handler that marks
    a project pending and then never reaches a commit (a DB error, an
    IntegrityError rollback) must leave no trace in that marker at all, and
    bumping it here — before the commit that makes this call's effect
    visible to any other session — is exactly the timing that let a
    concurrent edit's own bump be captured by the sync worker's snapshot
    before that edit's row changes were actually visible to it.
    """
    project.quote_sync_state = "pending"
    project.quote_sync_failures = 0


def _mark_pending_if_ours(project: AitoProject) -> None:
    """Like ``_mark_pending``, but only for a project this feature actually
    owns the quote lifecycle of.

    Ownership is EXPLICIT, not inferred: ``quote_sync_state = "unmanaged"`` is
    the only signal for "this feature must never touch this project's quote",
    and the only places that value is ever written are
    ``import_legacy_projects`` and the one-time migration backfill for rows
    that predate this column (``run_migrations`` in core/database.py). Every
    project this feature creates starts 'pending' (see ``create_project``'s
    unconditional ``_mark_pending`` call) and can move through
    'pending' / 'idle' / 'error' / 'locked' from there, but nothing in this
    module ever writes 'unmanaged' onto a project after creation — so any of
    those four states reliably means "yes, mark it", and the guard is a
    single check.

    This replaces an earlier, INCORRECT version of this guard that inferred
    ownership from `quote_id is not None or quote_sync_state != "idle"`,
    reasoning that a project of ours could never be simultaneously 'idle' and
    quote_id-less. That reasoning was false, two ways:

    - A project trashed before its first sync tick had ever run was set to
      'idle' by ``aito_quote_sync.sync_project``'s quote-less-deleted branch
      while still carrying no ``quote_id`` — making it byte-identical to a
      legacy card. Restoring it left it permanently unquotable, silently,
      with no error and no UI signal.
    - ``_apply_estimate`` set 'idle' unconditionally but only set ``quote_id``
      when the response actually carried one, so a 200 whose body omitted it
      could go 'idle' with a NULL ``quote_id`` while an estimate had, in
      fact, just been created in Books — orphaning it.

    Both are fixed at the source now (``sync_project``'s comment on that
    branch, and ``_apply_estimate`` itself), but the guard no longer depends
    on either invariant holding: explicit ownership has no equivalent blind
    spot to find.
    """
    if project.quote_sync_state != "unmanaged":
        _mark_pending(project)


def _wake_worker(queued: bool) -> None:
    """Ask the sync worker to drain, for an edit that left a project pending.

    Call AFTER the commit, never before — the worker reads through its own
    session, and a wake that fires ahead of the commit finds nothing (see
    ``request_debounced_sync``). ``queued`` must therefore be captured BEFORE
    the commit: ``expire_on_commit`` expires every attribute, so reading
    ``project.quote_sync_state`` afterwards is a lazy load on an async session.

    Debounced, not immediate: an edit gets a bounded wait rather than the full
    300s poll, while a burst of task ticks still collapses into one PUT.
    Creation uses ``request_immediate_sync`` instead — see there.
    """
    if queued:
        request_debounced_sync()


async def _commit_and_wake(db: AsyncSession, queued: bool, project_id: int | None = None) -> None:
    """Commit the session, bump the sync worker's requeue marker if this call
    left a project pending, then wake the worker.

    ``queued`` must already reflect the pre-commit state — see
    ``_wake_worker``'s docstring for why that capture has to happen before
    the commit performed here, not after. ``project_id`` must be the id of
    the SAME project ``queued`` was computed from; a couple of callers (the
    task endpoints, whose parent project can be missing) may have no project
    at all, in which case ``queued`` is already False and no bump is due
    regardless.

    The bump happens HERE, immediately after ``db.commit()`` returns and with
    no ``await`` in between — never inside ``_mark_pending``/
    ``_mark_pending_if_ours`` themselves, which run before this commit. Two
    bugs come from getting that ordering wrong, in opposite directions: bump
    before commit, and a caller that marks a project pending and then rolls
    back instead of reaching here leaves a phantom bump — the marker no
    longer matches what the sync worker last saw, so the next tick re-pushes
    a project that never actually changed. Bump before commit, and a bump
    that lands before ITS OWN commit can be captured by the sync worker's
    ``_requeue_marker_for`` snapshot before this call's row changes are
    actually visible to that worker's session — narrowing the race
    ``aito_quote_sync._requeue_marker`` exists to catch instead of closing
    it. Bumping only once this call's own commit has actually returned ties
    the marker to an edit being VISIBLE, not merely intended. See that
    module's own comment on ``_requeue_marker`` for the full shape of the
    race this protects.

    Not used by every commit-then-wake site: any handler where the commit is
    itself wrapped in error handling (see ``restore_project``'s
    ``IntegrityError`` branch) keeps its commit and wake calls separate,
    since folding them together here would pull the wake call inside that
    handler's try/except — those sites bump the marker themselves,
    immediately after their own commit, for the same reason as here.
    """
    await db.commit()
    if queued and project_id is not None:
        _bump_requeue_marker(project_id)
    _wake_worker(queued)


def _actor(user: User | None) -> str | None:
    """The username to snapshot on an event.

    None for auth-disabled installs and for API-key requests, which carry no
    user identity — the same rule ``created_by`` already follows on the
    project itself, so the two never disagree about who did something.
    """
    return user.username if user is not None else None


async def _broadcast_changed(action: str, project_id: int | None, actor: str | None) -> None:
    """Fan out one board-changed signal to every connected operator.

    Best-effort, after commit: the board must stay correct with the WS layer
    down (same stance as the Zoho push in set_quote_status), so failures are
    logged and swallowed. The payload names WHAT happened, not the new state
    — clients respond by refetching, which keeps one code path for all
    twelve mutations.
    """
    try:
        await ws_manager.broadcast_aito(
            {"type": "aito_changed", "action": action, "project_id": project_id, "actor": actor}
        )
    except Exception:
        logger.warning("aito_changed broadcast failed for %s on project %s", action, project_id, exc_info=True)


async def _mark_project_pending_for_task(db: AsyncSession, project_id: int) -> tuple[AitoProject | None, bool]:
    """Task endpoints address a task, not a project, so the parent has to be
    loaded to be marked. A missing parent is not an error here: the task's own
    404 already covers the case that matters. Returns the project (or None) so
    callers that also need to run `_apply_rules` on it don't load it twice.

    Also returns whether the project was ALREADY pending before this call.
    ``_mark_pending_if_ours`` is unconditional and idempotent — it re-marks a
    project that is already pending just as readily as one that was idle — so
    a caller emitting ``sync.queued`` off the post-call state alone would fire
    on every single task edit made before the sync worker's next tick, not
    just the one that actually queued the project. Callers compare this
    against the post-call state to catch only the genuine idle/error/locked
    -> pending transition.
    """
    project = (await db.execute(select(AitoProject).where(AitoProject.id == project_id))).scalar_one_or_none()
    if project is None:
        return None, False
    was_pending = project.quote_sync_state == "pending"
    _mark_pending_if_ours(project)
    return project, was_pending


def _imported_created_at(quote_id: str | None, quote_date: str | None) -> datetime | None:
    """When an import should backdate the card, the instant to use — else None,
    meaning leave ``created_at``'s server default alone.

    Import posts through this same endpoint as a manual card, so ``quote_id``
    is what distinguishes them: a hand-made card keeps its real creation
    instant.

    The hour is NOON, and that is load-bearing. ``quote_date`` is a date with
    no time, ``created_at`` is an instant, and the frontend reads the column as
    UTC (``parseUTCDate`` in utils/date.ts). Midnight UTC renders as the
    PREVIOUS calendar day everywhere west of Greenwich, which would show the
    wrong date on every install in the Americas. Noon is correct from UTC-11 to
    UTC+11; UTC+12/+13 still read a day late, and no single instant can satisfy
    every offset.

    ``quote_date`` is a client-supplied string (see AitoProjectCreate), so it
    is parsed, never trusted: anything unparseable falls back to the default.
    Naive, matching the column.
    """
    if quote_id is None or not quote_date:
        return None
    try:
        parsed = datetime.strptime(quote_date, "%Y-%m-%d")
    except ValueError:
        return None
    return parsed.replace(hour=12)


@router.get("/", response_model=list[AitoProjectResponse])
async def list_projects(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_READ),
):
    stmt = (
        select(AitoProject)
        .where(AitoProject.status == "active")
        # Ranked WITHIN each column, and display-only: stored `position`
        # values are untouched, so manual drag order still holds inside each
        # tier. The trade is that a card cannot be dragged out of its tier —
        # a flagged card snaps back above a normal one, and a paused card
        # snaps back below one, on the next fetch. Rewriting `position` on
        # flag would "fix" that by destroying the operator's ordering
        # irreversibly, which is worse.
        .order_by(AitoProject.board_column, _FLAG_ORDER, AitoProject.position, AitoProject.id)
    )
    projects = list((await db.execute(stmt)).scalars().all())
    task_rows = await _tasks_by_project(db, [p.id for p in projects])
    shipping_names = await _shipping_names(db)
    return [_to_response(p, summarise(task_rows.get(p.id, ())), shipping_names) for p in projects]


@router.get("/trash", response_model=list[AitoProjectResponse])
async def list_trash(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_READ),
):
    """Deleted projects, newest deletions first. Rows are never removed."""
    stmt = (
        select(AitoProject)
        .where(AitoProject.status == "deleted")
        .order_by(AitoProject.updated_at.desc(), AitoProject.id.desc())
    )
    projects = list((await db.execute(stmt)).scalars().all())
    task_rows = await _tasks_by_project(db, [p.id for p in projects])
    shipping_names = await _shipping_names(db)
    return [_to_response(p, summarise(task_rows.get(p.id, ())), shipping_names) for p in projects]


@router.post("/", response_model=AitoProjectResponse, status_code=201)
async def create_project(
    payload: AitoProjectCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE),
):
    if (
        payload.quote_status in ("accepted", "declined")
        and current_user is not None
        and not current_user.has_permission(Permission.AITO_UPDATE.value)
    ):
        # 'accepted'/'declined' are DECISIONS: the same trust boundary
        # `POST /{id}/quote-status` enforces with Permission.AITO_UPDATE.
        # Without this, aito:create alone (a real, supportable group
        # configuration — see the denylist comment on Permission.AITO_CREATE
        # in core/auth.py) could stamp a decided status on an imported quote
        # here and let the sync worker push it straight onto a live Zoho
        # estimate, bypassing set_quote_status's actor recording and 409
        # terminal-transition guards entirely.
        # `current_user is None` means auth is disabled (the only way an
        # AITO_CREATE-gated request reaches this body with no user — API
        # keys are denylisted for AITO_CREATE, see core/auth.py) and the
        # dependency above already granted unconditional access, so this
        # check stays silent for that case too, same as everywhere else in
        # this file.
        raise HTTPException(
            status_code=403,
            detail="quote_status 'accepted'/'declined' requires the aito:update permission",
        )
    await _reject_duplicate_quote(db, payload.quote_id)
    if payload.quote_id is None and not (
        (payload.client_phone or "").strip()
        or (payload.client_email or "").strip()
        or (payload.client_social_handle or "").strip()
    ):
        # Every hand-created project must be reachable on SOME channel — walk-in
        # included, whose coordinates live on the project row rather than in
        # Zoho. A social handle counts: some clients are only ever reached on
        # Messenger or Instagram, and the pairing validator has already
        # guaranteed a non-blank handle carries a network. Imports are exempt:
        # an existing Zoho quote's contact may carry none of the three.
        raise HTTPException(status_code=400, detail="Client must have a phone, an email or a social handle")
    create_fields = payload.model_dump(exclude_unset=True)
    rates = {}
    if _mentions_shipping(create_fields):
        rates = await _shipping_rates(db)
    shipping = _validated_shipping(create_fields, rates)
    # New cards land on top of the quote column: shift existing cards down.
    for row in await _active_in_column(db, "devis"):
        row.position += 1
    created_at = _imported_created_at(payload.quote_id, payload.quote_date)
    project = AitoProject(
        description=payload.description.strip(),
        board_column="devis",
        position=0,
        client_id=payload.client_id,
        client_name=payload.client_name,
        client_phone=payload.client_phone,
        client_email=payload.client_email,
        client_is_company=payload.client_is_company,
        client_social_network=payload.client_social_network,
        client_social_handle=payload.client_social_handle,
        quote_id=payload.quote_id,
        quote_number=payload.quote_number,
        quote_date=payload.quote_date,
        quote_total=payload.quote_total,
        quote_url=payload.quote_url,
        quote_salesperson=payload.quote_salesperson,
        quote_status=payload.quote_status,
        # None when auth is disabled, and for API-key requests — the dependency
        # returns None for both rather than a synthetic user.
        created_by=current_user.username if current_user else None,
        # Absent unless an import backdates it — an explicit None would write a
        # NULL rather than fall through to the column's server default.
        **({"created_at": created_at} if created_at else {}),
        **(shipping or {}),
    )
    for task_payload in payload.tasks:
        _reject_ticks_without_acceptance(payload.quote_status, task_payload.model_dump())
    db.add(project)
    if payload.quote_id is None:
        # A payload with no quote_id is a genuine new job: mark it pending so
        # the worker creates its estimate. A payload that already carries a
        # quote_id came through the Import flow — the imported project is by
        # definition already in sync with that quote (its tasks were derived
        # FROM it), so marking pending here would have the worker take the
        # UPDATE path within one tick and PUT a freshly-regenerated
        # line_items array onto a real customer estimate nobody has touched
        # yet: hand-typed rows deleted, names/SKUs reverted to catalogue
        # values, tax forced onto every line. The user's first real edit
        # marks it pending as normal, and the worker's next tick regenerates
        # the WHOLE line_items array from the project's current tasks —
        # `_update_quote` always rebuilds the full array, it does not diff —
        # and pushes that.
        _mark_pending(project)
    # Flush so the project has an id the tasks can reference; one commit still
    # covers both, so a failure creates neither.
    #
    # The flush (an INSERT of `project`) is the earliest point a concurrent
    # writer's own commit of the same active quote_id can be felt: SQLite
    # enforces the partial unique index immediately, per-statement, not
    # deferred to COMMIT — and every DB call from here on (this flush,
    # record()'s own flush, and any autoflush a later SELECT triggers on the
    # dirty `project` row) can be the one that surfaces it. Everything down to
    # the final commit is wrapped in the same try so none of those spots can
    # leak the race as an unhandled 500.
    try:
        await db.flush()
        await record(
            db,
            project.id,
            "project.created",
            actor_class="user",
            actor_name=_actor(current_user),
            subject_type="project",
            subject_id=project.id,
            detail={"imported_from": project.quote_number} if project.quote_number else None,
        )
        if payload.quote_status in ("accepted", "declined"):
            # Only reachable with a quote_id (the schema's
            # _decided_status_needs_a_quote_id validator gates the other
            # case), i.e. a genuine import of an already-decided Books quote.
            # Not routed through adopt_quote_status: that helper also stamps
            # quote_accepted_at, which must stay NULL for an import (see the
            # column comment on AitoProject.quote_accepted_at — the decision
            # already happened at some past, unknown moment in Books, so a
            # fresh "now" stamp would misdate it and desync the card's age
            # from its real history). This call exists only so the decision
            # has an actor on the timeline, same as the dedicated
            # /quote-status route records for a hand-made card.
            await record(
                db,
                project.id,
                f"quote.{payload.quote_status}",
                actor_class="user",
                actor_name=_actor(current_user),
                subject_type="project",
                subject_id=project.id,
            )
        new_tasks = [
            AitoTask(project_id=project.id, position=position, **task_payload.model_dump())
            for position, task_payload in enumerate(payload.tasks)
        ]
        db.add_all(new_tasks)
        # The tasks were just inserted from the payload, so they are already in
        # hand: summarise them rather than reading them back.
        summary = summarise(new_tasks)
        await _apply_rules(db, project, summary, actor=_actor(current_user))
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        if _is_duplicate_active_quote_error(exc):
            raise HTTPException(status_code=409, detail=_DUPLICATE_QUOTE_DETAIL) from exc
        raise
    if payload.quote_id is None:
        # After the commit, never before: the sync worker reads through its
        # own session, and a wake racing an uncommitted row drains nothing.
        # Only the own-quote branch — an import owes Books nothing yet.
        request_immediate_sync()
    await _broadcast_changed("create", project.id, _actor(current_user))
    await db.refresh(project)
    return await _project_response(db, project, summary)


@router.post("/summarize", response_model=AitoSummarizeResponse)
async def summarize_project(
    payload: AitoSummarizeRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE),
):
    """French project summary for the create drawer. Registered before the
    /{project_id} routes on purpose — a literal segment after a parametric
    route would 422 instead of matching."""
    try:
        summary, model = await summarize_tasks(db, [t.model_dump() for t in payload.tasks])
    except OpenRouterNotConfiguredError:
        raise HTTPException(status_code=409, detail="OpenRouter is not configured") from None
    except OpenRouterUpstreamError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return AitoSummarizeResponse(summary=summary, model=model)


@router.get("/shipping/services", response_model=AitoShippingServicesResponse)
async def list_shipping_services(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_READ),
):
    """The five air-freight services, their islands and their Books rates.

    Registered before the /{project_id} routes on purpose — a literal segment
    after a parametric route would 422 instead of matching (FastAPI would try
    to parse "shipping" as a project_id). Same reason /summarize sits where it
    does.

    The island list is app data and is always served; only the rates need
    Zoho.
    """
    catalogue = await zoho_service.get_shipping_catalogue(db)
    return AitoShippingServicesResponse(
        catalogue_resolved=bool(catalogue),
        services=[
            AitoShippingService(
                key=service,
                name=catalogue[service].name if service in catalogue else SERVICE_LABELS[service],
                rate=catalogue[service].rate if service in catalogue else None,
                islands=[AitoShippingIsland(key=key, label=label) for key, label in islands],
            )
            for service, islands in grouped_islands()
        ],
    )


@router.get("/{project_id}/tasks", response_model=list[AitoTaskResponse])
async def list_tasks(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_READ),
):
    stmt = select(AitoTask).where(AitoTask.project_id == project_id).order_by(AitoTask.position, AitoTask.id)
    return [_task_to_response(t) for t in (await db.execute(stmt)).scalars().all()]


@router.get("/{project_id}/events", response_model=AitoEventPage)
async def list_events(
    project_id: int,
    depth: Literal["story", "detail", "everything"] = "detail",
    before: int | None = None,
    before_at: datetime | None = None,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_READ),
) -> AitoEventPage:
    """This project's timeline, newest first.

    Ordered by occurred_at then id, so the cursor must be the PAIR
    (occurred_at, id), not id alone. An id-only cursor is only equivalent to
    the compound sort while id order and occurred_at order agree, and the
    backfill breaks that: it inserts each project's synthesised
    'project.created' row with a freshly-assigned HIGH id but an OLD
    occurred_at (the project's own created_at, possibly years earlier than
    every organic event). Filtering on `id < before` alone makes that row's
    id un-crossable — the cursor only ever shrinks past it — so it would never
    appear on any page, not merely be mis-ordered. Keying on both halves keeps
    the cursor stable when several events share a timestamp (also routine
    after a backfill) while still reaching rows whose id and occurred_at
    disagree.
    """
    project = await db.get(AitoProject, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    if (before is None) != (before_at is None):
        raise HTTPException(status_code=422, detail="The cursor needs both 'before' and 'before_at'")

    limit = max(1, min(limit, 200))
    query = (
        select(AitoEvent)
        .where(AitoEvent.project_id == project_id, AitoEvent.kind.in_(kinds_for_depth(depth)))
        .order_by(AitoEvent.occurred_at.desc(), AitoEvent.id.desc())
        .limit(limit + 1)  # one extra row is how has_more is answered without a count
    )
    if before is not None:
        query = query.where(
            or_(AitoEvent.occurred_at < before_at, and_(AitoEvent.occurred_at == before_at, AitoEvent.id < before))
        )

    rows = list((await db.execute(query)).scalars().all())
    return AitoEventPage(
        events=[AitoEventResponse.model_validate(row) for row in rows[:limit]],
        has_more=len(rows) > limit,
    )


@router.post("/{project_id}/events", response_model=AitoEventResponse, status_code=201)
async def add_note(
    project_id: int,
    payload: AitoNoteCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
) -> AitoEventResponse:
    """Append a note to the timeline.

    Local only — notes are never pushed to Zoho. The kind and actor_class are
    fixed here rather than taken from the body: this is the one client-writable
    event, and a caller able to name its own kind could fabricate an acceptance.
    """
    project = await db.get(AitoProject, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    event = await record(
        db,
        project_id,
        "note.added",
        actor_class="user",
        actor_name=_actor(current_user),
        subject_type="project",
        subject_id=project_id,
        note=payload.note,
    )
    await db.commit()
    await _broadcast_changed("comment", project_id, _actor(current_user))
    await db.refresh(event)
    return AitoEventResponse.model_validate(event)


@router.get("/{project_id}/invoice")
async def get_invoice(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_READ),
) -> AitoInvoiceResponse | None:
    """The invoice Books raised from this project's quote, if there is one.

    Read live rather than from a stored snapshot — see ``AitoInvoiceResponse``
    for why. That makes this the one Aito card that needs Zoho reachable.

    Returns ``null``, not a 404, when the project simply has no invoice: that
    is the ordinary state of every quoted job that has not been billed yet,
    and a 404 would have the client treat the commonest case as an error. A
    404 here means the PROJECT does not exist, which is a different fact.

    A project with no ``quote_id`` short-circuits without touching Zoho. That
    is not just an optimisation: see ``list_project_invoices`` for what Books
    does with an empty ``estimate_id``.
    """
    project = await db.get(AitoProject, project_id)
    if project is None or project.status == "deleted":
        raise HTTPException(status_code=404, detail="Project not found")
    if not project.quote_id:
        return None
    try:
        invoices = await zoho_service.list_project_invoices(db, project.quote_id, project.client_id or "")
        if not invoices:
            return None
        newest = invoices[0]
        url = await zoho_service.books_invoice_url(db, newest["id"])
    except (ZohoNotConfiguredError, ZohoUpstreamError) as e:
        # 502 for the same reason get_quote_pdf below uses it: the failure is
        # upstream, and that is what tells the operator to check Zoho rather
        # than this app's logs.
        logger.warning("Aito invoice lookup failed for project %s: %s", project_id, e)
        raise HTTPException(status_code=502, detail=str(e)) from e
    return AitoInvoiceResponse(**newest, url=url, invoice_count=len(invoices))


@router.get("/{project_id}/invoice.pdf")
async def get_invoice_pdf(
    project_id: int,
    invoice_id: str | None = None,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_READ),
) -> Response:
    """This project's Zoho invoice, rendered as a PDF for printing.

    A proxy rather than a redirect, and returned whole rather than streamed,
    for the reasons spelled out on ``get_quote_pdf`` below.

    The candidate invoices are always resolved server-side from the project's
    own estimate. ``invoice_id`` may only NARROW that set — it is checked for
    membership, never trusted — so it cannot be used to print an invoice this
    project has no claim to by walking ids.

    Why it exists: the card renders from a cached read (see InvoiceCard's
    staleTime) while this endpoint resolves live, and Books allows an estimate
    to be invoiced in parts. Without pinning, a second invoice raised while
    the panel sat open would make Print emit a document whose number the
    operator never saw. Omitting it keeps the previous behaviour — newest
    invoice — so existing callers are unaffected.
    """
    project = await db.get(AitoProject, project_id)
    if project is None or project.status == "deleted":
        raise HTTPException(status_code=404, detail="Project not found")
    if not project.quote_id:
        raise HTTPException(status_code=404, detail="This project has no Zoho quote")
    try:
        invoices = await zoho_service.list_project_invoices(db, project.quote_id, project.client_id or "")
        if not invoices:
            raise HTTPException(status_code=404, detail="This project has no Zoho invoice")
        if invoice_id:
            invoice = next((i for i in invoices if i["id"] == invoice_id), None)
            if invoice is None:
                # 404, not 403: from here "belongs to another customer" and
                # "was this project's until Books voided it a minute ago" are
                # indistinguishable, and they mean the same thing to the
                # caller — reopen the card and print from a fresh read.
                raise HTTPException(status_code=404, detail="That invoice is not one of this project's")
        else:
            invoice = invoices[0]
        pdf = await zoho_service.get_invoice_pdf(db, invoice["id"])
    except (ZohoNotConfiguredError, ZohoUpstreamError) as e:
        logger.warning("Aito invoice PDF failed for project %s: %s", project_id, e)
        raise HTTPException(status_code=502, detail=str(e)) from e
    filename = f"{invoice['number'] or invoice['id']}.pdf"
    return Response(
        content=pdf,
        media_type="application/pdf",
        # inline + the shared header helper, for the reasons on get_quote_pdf:
        # the browser prints this from a blob, and invoice_number is upstream
        # text that Starlette would fail to latin-1 encode if it contained an
        # em dash or a curly quote.
        headers={"Content-Disposition": build_content_disposition(filename, disposition="inline")},
    )


@router.get("/{project_id}/quote.pdf")
async def get_quote_pdf(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_READ),
) -> Response:
    """This project's Zoho estimate, rendered as a PDF for printing.

    A proxy rather than a redirect: the Books OAuth token is server-side only,
    and the browser has no way to authenticate against Zoho directly.

    Returned whole rather than streamed. A quote is a few pages, ``httpx`` has
    already buffered the whole body inside ``get_estimate_pdf`` by the time we
    see it, and a StreamingResponse over an in-memory ``bytes`` buys nothing
    but a harder failure mode: a mid-stream Zoho error becomes a truncated
    PDF the browser renders as a blank print dialog, instead of the 502 below.
    """
    project = await db.get(AitoProject, project_id)
    if project is None or project.status == "deleted":
        raise HTTPException(status_code=404, detail="Project not found")
    if not project.quote_id:
        raise HTTPException(status_code=404, detail="This project has no Zoho quote")
    try:
        pdf = await zoho_service.get_estimate_pdf(db, project.quote_id)
    except (ZohoNotConfiguredError, ZohoUpstreamError) as e:
        # 502, not 500: the failure is upstream, and the distinction is what
        # tells the operator to check Zoho rather than the app's own logs.
        logger.warning("Aito quote PDF failed for project %s: %s", project_id, e)
        raise HTTPException(status_code=502, detail=str(e)) from e
    filename = f"{project.quote_number or project.quote_id}.pdf"
    return Response(
        content=pdf,
        media_type="application/pdf",
        # inline, not attachment: the browser fetches this into a blob to
        # drive its own print dialog, and a download prompt would defeat that.
        # Built with the shared helper rather than a hand-written header:
        # quote_number is client-supplied and unrestricted, and Starlette
        # encodes response headers as latin-1 — a curly quote, em dash, or any
        # other non-Latin-1 character in it would raise UnicodeEncodeError and
        # turn this into an unhandled 500.
        headers={"Content-Disposition": build_content_disposition(filename, disposition="inline")},
    )


async def _quote_email_content(db: AsyncSession, project: AitoProject) -> tuple[dict, str | None]:
    """Books' email prefill for this project's quote, plus the address to preselect.

    The project's own ``client_email`` is folded in when Books does not
    already offer it: it is an address a human attached to this card on
    purpose, and dropping it would leave a hand-attached client unsendable.
    It also becomes the default — the card's client is who the shop means
    when they hit Send, whichever contact person Books happens to flag.

    Returns the content with its recipients widened, and the default address
    (None when there is nobody at all to send to).
    """
    content = await zoho_service.get_estimate_email_content(db, project.quote_id)
    recipients = list(content["recipients"])
    client_email = (project.client_email or "").strip()
    if client_email and not any(r["email"].lower() == client_email.lower() for r in recipients):
        recipients.insert(0, {"email": client_email, "name": project.client_name or "", "contact_person_id": ""})
    default = client_email or (recipients[0]["email"] if recipients else None)
    return {**content, "recipients": recipients}, default


def _quote_email_http_error(e: Exception) -> HTTPException:
    """Books' failures, mapped for the two quote-email routes.

    The isinstance order is load-bearing: ZohoNotFound and
    ZohoRequestRejected both subclass ZohoUpstreamError, so testing the base
    first would swallow them both into a 502 and lose Books' own message —
    which is what tells the user "this contact has no email address".
    """
    if isinstance(e, ZohoNotFound):
        return HTTPException(status_code=404, detail=str(e))
    if isinstance(e, ZohoRequestRejected):
        return HTTPException(status_code=400, detail=str(e))
    return HTTPException(status_code=502, detail=str(e))


async def _load_quote_email_content(
    db: AsyncSession, project: AitoProject, project_id: int, *, rollback_on_error: bool = False
) -> tuple[dict, str | None]:
    """Shared preamble for both quote-email routes: no-quote 404, then Books lookup.

    ``project`` is already resolved by the caller — the two routes fetch it
    differently (get_quote_email accepts any non-deleted status,
    send_quote_email requires "active" via ``_get_active_project_or_404``),
    so that part stays at the call site rather than being folded in here.

    ``rollback_on_error`` is only set by the send path. See the comment in
    ``send_quote_email`` for why it needs a clean session before re-raising;
    the preview path (``get_quote_email``) never had a rollback here and must
    not gain one.
    """
    if not project.quote_id:
        raise HTTPException(status_code=404, detail="This project has no Zoho quote")
    try:
        return await _quote_email_content(db, project)
    except (ZohoNotConfiguredError, ZohoUpstreamError) as e:
        logger.warning("Aito quote email prefill failed for project %s: %s", project_id, e)
        if rollback_on_error:
            await db.rollback()
        raise _quote_email_http_error(e) from e


@router.get("/{project_id}/quote-email", response_model=AitoQuoteEmailContent)
async def get_quote_email(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_READ),
):
    """What Books would send if this quote were emailed right now.

    Preview only. The send path deliberately re-reads all of this rather than
    trusting whatever the client echoes back — see ``send_quote_email``.
    """
    project = await db.get(AitoProject, project_id)
    if project is None or project.status == "deleted":
        raise HTTPException(status_code=404, detail="Project not found")
    content, default_email = await _load_quote_email_content(db, project, project_id)
    return AitoQuoteEmailContent(
        subject=content["subject"],
        body=content["body"],
        recipients=[AitoQuoteEmailRecipient(**r) for r in content["recipients"]],
        default_email=default_email,
    )


@router.post("/{project_id}/quote-email", response_model=AitoQuoteEmailResponse)
async def send_quote_email(
    project_id: int,
    payload: AitoQuoteEmailRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    """Email this project's quote through Books, then move the card.

    ZOHO-FIRST, deliberately against the local-first rule the rest of this
    file follows. In ``set_quote_status`` the board records a decision a human
    already made, so it must survive Books being unreachable. Here the email
    IS the act: a card parked in Waiting after a failed send is a lie about a
    message the client never received. So nothing is written locally until
    Books confirms.

    The card only moves when it is in the Quote column. Re-sending a quote
    that is already out — or already accepted — is a real thing to want, and
    it must never demote the card. Gated on ``board_column`` rather than
    ``quote_status`` because that is the rule as specified; ``evaluate()``
    derives one from the other, so they cannot disagree.

    The ``quote.emailed`` event is committed on its own, immediately after
    Books confirms the send and before the card-move work below. Once the
    email has gone out, that fact must survive even if moving the card hits
    a locked database (this app's single SQLite file is also written by the
    aito_quote_sync worker): losing the event AND 500ing the request would
    both erase the send from the timeline and invite a real second send on
    retry, which is the one thing this handler exists to prevent. The
    card-move half is left to fail independently and best-effort — it is
    idempotent and recoverable through the existing "already out" flows
    (``set_quote_status``, the sync worker's own reconciliation) without
    re-sending anything, so a failure there degrades to ``marked_sent=False``
    rather than a 500.
    """
    project = await _get_active_project_or_404(db, project_id)
    content, _ = await _load_quote_email_content(db, project, project_id, rollback_on_error=True)

    # Re-read rather than trust the request. An allowlist the caller supplies
    # is not an allowlist: without this the endpoint is an open relay, and any
    # authenticated user could send arbitrary addresses mail from the
    # company's Zoho account, on the company's own template and branding.
    #
    # Residual: this is not "addresses Books offers" — _quote_email_content
    # widens it with the project's own client_email, and client_email is
    # editable by anyone holding AITO_UPDATE, the same permission this route
    # requires. So a holder of that permission can widen the allowlist
    # themselves by editing the card's client_email first, then sending. This
    # is accepted, not closed: the widening is what lets a hand-attached
    # address stay sendable (see _quote_email_content), and it is already
    # audited — as a `project.updated` event when the edit happens, not as
    # part of `quote.emailed` here.
    recipient = payload.to.strip()
    if recipient.lower() not in {r["email"].lower() for r in content["recipients"]}:
        raise HTTPException(status_code=422, detail="That address is not a recipient of this quote")

    try:
        await zoho_service.email_estimate(db, project.quote_id, to_mail_ids=[recipient])
    except (ZohoNotConfiguredError, ZohoUpstreamError) as e:
        logger.warning("Aito quote email failed for project %s: %s", project_id, e)
        # Belt-and-braces, not load-bearing: unlike set_quote_status, this
        # handler re-raises rather than swallowing the error, so get_db's own
        # except-BaseException clause already rolls the session back before
        # propagating it — there is no implicit commit() on this path for a
        # PendingRollbackError to break. Rolling back here just leaves the
        # session clean immediately, in case any code is ever added between
        # this line and the raise that reads it.
        await db.rollback()
        raise _quote_email_http_error(e) from e

    await record(
        db,
        project.id,
        "quote.emailed",
        actor_class="user",
        actor_name=_actor(current_user),
        subject_type="project",
        subject_id=project.id,
        detail={"email": recipient},
    )
    # Committed here, on its own — see the docstring above. Everything past
    # this point is the card-move half, which is allowed to fail without
    # taking this event down with it.
    await db.commit()

    summary = await _summary_for(db, project.id)
    should_move_card = project.board_column == "devis"
    # None (not False): "no move was attempted" and "the move was attempted
    # and failed" are different stories for the client — see
    # AitoQuoteEmailResponse.marked_sent. Only the except branch below sets
    # this back to False, deliberately, once a move was actually attempted.
    marked_sent: bool | None = None
    if should_move_card:
        try:
            adopt_quote_status(project, "sent")
            # Our side just moved, so any recorded block describes an attempt
            # that no longer exists — same reasoning as set_quote_status.
            project.quote_status_block = None
            project.quote_status_remote = None
            await _apply_rules(db, project, summary, actor=_actor(current_user))
            await record(
                db,
                project.id,
                "quote.sent",
                actor_class="user",
                actor_name=_actor(current_user),
                subject_type="project",
                subject_id=project.id,
            )
            await db.commit()
            marked_sent = True
        except SQLAlchemyError:
            # Narrowed to database errors only ("database is locked" from the
            # aito_quote_sync worker sharing this SQLite file is the realistic
            # case this branch exists for — see the docstring above). A
            # genuine programming error (AttributeError, TypeError, or an
            # HTTPException raised from a helper) must propagate as a 500
            # rather than being reported to the client as a 200 with
            # marked_sent=False, which would hide a real bug behind a
            # "the send worked, only the card move failed" story.
            logger.warning(
                "Aito quote email for project %s was sent, but moving the card failed; "
                "quote.emailed is already recorded and the card stays where it was",
                project_id,
                exc_info=True,
            )
            # Explicit, not a fallthrough from the None default above: this is
            # the one branch where a move was actually attempted and failed,
            # which the client (see useSendQuoteMutation) surfaces as a
            # warning rather than the plain success toast the None/True
            # cases get.
            marked_sent = False
            # Undo the half-applied move so the session (and the response
            # built from it below) reflect what is actually committed, not
            # an in-memory state that was never persisted. rollback() expires
            # every object regardless of expire_on_commit, which is exactly
            # why the explicit db.refresh(project) below is unconditional.
            await db.rollback()

    # Refresh BEFORE broadcasting: the card-move rollback above (if it ran)
    # expired every attribute on `project` — including `id` — regardless of
    # expire_on_commit, and reading an expired attribute here would be a
    # synchronous lazy-load attempt on an async session (MissingGreenlet).
    await db.refresh(project)
    await _broadcast_changed("quote-email", project.id, _actor(current_user))
    return AitoQuoteEmailResponse(
        project=await _project_response(db, project, summary),
        marked_sent=marked_sent,
    )


def _reject_ticks_without_acceptance(quote_status: str | None, fields: dict) -> None:
    """A step may only be ticked once the quote is accepted.

    Acceptance is the board's single gate: ``evaluate()`` sends every other
    status to devis, waiting or done, so a tick on an unaccepted quote cannot
    move the card and does not describe authorised work.

    Only SETTING a flag is refused. Clearing one to False stays legal at every
    call site — a tick stranded by a status flip (a decline entered in Books)
    must always be undoable, or a mis-declined project keeps work marked done
    with no way back.
    """
    if quote_status == "accepted":
        return
    for service in SERVICES:
        if fields.get(f"{service}_done"):
            raise HTTPException(
                status_code=422,
                detail=f"{service} cannot be marked done until the quote is accepted",
            )


async def _get_task_or_404(db: AsyncSession, task_id: int) -> AitoTask:
    task = (await db.execute(select(AitoTask).where(AitoTask.id == task_id))).scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


async def _get_active_project_or_404(db: AsyncSession, project_id: int) -> AitoProject:
    project = (
        await db.execute(select(AitoProject).where(AitoProject.id == project_id, AitoProject.status == "active"))
    ).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.post("/{project_id}/tasks", response_model=AitoTaskResponse, status_code=201)
async def add_task(
    project_id: int,
    payload: AitoTaskCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE),
):
    project = (await db.execute(select(AitoProject).where(AitoProject.id == project_id))).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    _reject_ticks_without_acceptance(project.quote_status, payload.model_dump())
    # Captured before the mark: it is unconditional and idempotent, so
    # checking the post-mark state alone would fire sync.queued on every task
    # added to an already-pending project, not just the transition into it.
    was_pending = project.quote_sync_state == "pending"
    _mark_pending_if_ours(project)
    highest = await db.scalar(select(func.max(AitoTask.position)).where(AitoTask.project_id == project_id))
    task = AitoTask(project_id=project_id, position=(highest + 1) if highest is not None else 0, **payload.model_dump())
    db.add(task)
    await db.flush()  # so _summary_for's SELECT sees the new row
    await record(
        db,
        project_id,
        "task.added",
        actor_class="user",
        actor_name=_actor(current_user),
        subject_type="task",
        subject_id=task.id,
        subject_label=task.title,
    )
    if not was_pending and project.quote_sync_state == "pending":
        await record(db, project.id, "sync.queued", actor_class="system")
    await _apply_rules(db, project, await _summary_for(db, project_id), actor=_actor(current_user))
    queued = project.quote_sync_state == "pending"
    await _commit_and_wake(db, queued, project.id)
    await _broadcast_changed("task", task.project_id, _actor(current_user))
    await db.refresh(task)
    return _task_to_response(task)


@router.patch("/tasks/{task_id}", response_model=AitoTaskResponse)
async def update_task(
    task_id: int,
    payload: AitoTaskUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    """Only fields present in the body are written, so an omitted key is left
    alone and an explicit null disables that service.

    Three invariants hold across the write:

    - A done flag may not be set unless the project's quote is accepted.
      Acceptance is what authorises the work; clearing a flag stays legal
      regardless, so a tick stranded by a status flip can always be undone.
    - Clearing a cost to NULL clears its done flag. The step no longer exists,
      and leaving the flag set would bring the service back pre-ticked if it
      were ever re-enabled.
    - A done flag may not be set for a service with no cost. Checked against
      the MERGED row rather than the stored one, so enabling a service and
      ticking it in the same PATCH is legal while ticking a service that stays
      absent is a 422.
    """
    task = await _get_task_or_404(db, task_id)
    fields = payload.model_dump(exclude_unset=True)

    # Loaded before the write, not after: the guard needs the parent's quote
    # status, and one load then serves the pending mark and _apply_rules too.
    # Marking pending ahead of a possible 422 is safe — get_db rolls back on
    # ANY exception (core/database.py:220), so a rejected PATCH persists
    # nothing, including this mark.
    project, was_pending = await _mark_project_pending_for_task(db, task.project_id)
    _reject_ticks_without_acceptance(project.quote_status if project else None, fields)

    for service in SERVICES:
        cost_key, done_key = f"{service}_cost", f"{service}_done"
        merged_cost = fields.get(cost_key, getattr(task, cost_key))
        merged_done = fields.get(done_key, getattr(task, done_key))
        if merged_cost is None:
            if fields.get(done_key):
                raise HTTPException(status_code=422, detail=f"{service} has no cost, so it cannot be marked done")
            if merged_done:
                fields[done_key] = False

    # Captured after the SERVICES loop above but before the setattr loop
    # below applies fields to task: diff_fields must still run before the
    # write (it compares against task's pre-patch state), but the SERVICES
    # loop can itself flip a *_done flag to False when a cost is cleared —
    # a diff taken before that loop would miss that implicit untick, and
    # the board can move on it via _apply_rules even though no client ever
    # sent the flag, so skipping it here would silently drop the
    # task.step.unticked event an audit is most likely to be asked about.
    changes = diff_fields(task, fields)
    tick_changes = [c for c in changes if c["field"].endswith("_done")]
    field_changes = [c for c in changes if not c["field"].endswith("_done")]

    for key, value in fields.items():
        setattr(task, key, value)
    await record(
        db,
        task.project_id,
        "task.updated",
        actor_class="user",
        actor_name=_actor(current_user),
        subject_type="task",
        subject_id=task.id,
        subject_label=task.title,
        changes=field_changes,
    )
    for change in tick_changes:
        # One event per tick, never coalesced: each is a discrete decision
        # about whether work is finished, and the board column moves on it.
        await record(
            db,
            task.project_id,
            "task.step.ticked" if change["to"] else "task.step.unticked",
            actor_class="user",
            actor_name=_actor(current_user),
            subject_type="task",
            subject_id=task.id,
            subject_label=task.title,
            detail={"service": change["field"].removesuffix("_done")},
        )
    if project is not None and not was_pending and project.quote_sync_state == "pending":
        await record(db, project.id, "sync.queued", actor_class="system")
    if project:
        await _apply_rules(db, project, await _summary_for(db, task.project_id), actor=_actor(current_user))
    queued = project is not None and project.quote_sync_state == "pending"
    await _commit_and_wake(db, queued, project.id if project is not None else None)
    await _broadcast_changed("task", task.project_id, _actor(current_user))
    await db.refresh(task)
    return _task_to_response(task)


@router.delete("/tasks/{task_id}", status_code=204)
async def delete_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_DELETE),
):
    """Hard delete, unlike projects: tasks need no stable visible number, and
    hold-to-remove is already a deliberate gesture."""
    task = await _get_task_or_404(db, task_id)
    task_project_id = task.project_id  # captured before delete: unreadable on the row after
    project, _was_pending = await _mark_project_pending_for_task(db, task.project_id)
    await record(
        db,
        task.project_id,
        "task.removed",
        actor_class="user",
        actor_name=_actor(current_user),
        subject_type="task",
        subject_id=task.id,
        subject_label=task.title,
    )
    await db.delete(task)
    await db.flush()  # so the deleted row is out of _summary_for's SELECT
    if project:
        await _apply_rules(db, project, await _summary_for(db, task_project_id), actor=_actor(current_user))
    queued = project is not None and project.quote_sync_state == "pending"
    await _commit_and_wake(db, queued, project.id if project is not None else None)
    await _broadcast_changed("task", task_project_id, _actor(current_user))


@router.patch("/{project_id}/tasks/reorder", response_model=list[AitoTaskResponse])
async def reorder_tasks(
    project_id: int,
    payload: AitoTaskReorder,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    """Renumber the project's tasks to the payload's order. `position` is what
    every consumer sorts by — the task list endpoints and the Zoho quote sync
    (aito_quote_sync.py) — so persisting it here IS the quote reorder; no
    quote code is touched.

    The payload must be exactly the current task-id set. Anything else
    (missing, foreign, duplicate) means the client's list is stale — a
    concurrent add or delete — and renumbering from it would drop or collide
    positions, so it draws a 409 and the client refetches.

    No `_apply_rules` call, unlike the other task writes: order changes
    neither costs nor ticks, so the board column cannot move.
    """
    project = await _get_active_project_or_404(db, project_id)
    stmt = select(AitoTask).where(AitoTask.project_id == project_id).order_by(AitoTask.position, AitoTask.id)
    tasks = list((await db.execute(stmt)).scalars())
    by_id = {t.id: t for t in tasks}
    if sorted(payload.task_ids) != sorted(by_id):
        raise HTTPException(status_code=409, detail="The task list changed — refresh and try again")
    if payload.task_ids == [t.id for t in tasks]:
        # Dropped back into its own slot: nothing changed, so no event and no
        # Zoho push — an idle project must not be woken for a no-op.
        return [_task_to_response(t) for t in tasks]
    for index, task_id in enumerate(payload.task_ids):
        by_id[task_id].position = index
    was_pending = project.quote_sync_state == "pending"
    _mark_pending_if_ours(project)
    await record(
        db,
        project.id,
        "task.reordered",
        actor_class="user",
        actor_name=_actor(current_user),
        subject_type="project",
        subject_id=project.id,
    )
    if not was_pending and project.quote_sync_state == "pending":
        await record(db, project.id, "sync.queued", actor_class="system")
    queued = project.quote_sync_state == "pending"
    await _commit_and_wake(db, queued, project.id)
    await _broadcast_changed("task", project.id, _actor(current_user))
    # Refresh the tasks from the database after commit to ensure their state is valid.
    stmt = select(AitoTask).where(AitoTask.project_id == project_id).order_by(AitoTask.position, AitoTask.id)
    refreshed_tasks = list((await db.execute(stmt)).scalars())
    refreshed_by_id = {t.id: t for t in refreshed_tasks}
    return [_task_to_response(refreshed_by_id[task_id]) for task_id in payload.task_ids]


@router.post("/import", response_model=list[AitoProjectResponse], status_code=201)
async def import_legacy_projects(
    payload: AitoProjectImport,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE),
):
    """One-time localStorage migration. Guard counts ALL rows (incl. soft-deleted)
    so a double-fire can never duplicate the board."""
    total = await db.scalar(select(func.count(AitoProject.id)))
    if total:
        raise HTTPException(status_code=409, detail="Aito board is not empty")
    created = []
    for item in payload.projects:
        p = AitoProject(
            description=item.description,
            board_column=item.column,
            position=item.position,
            # Explicit ownership marker (see _mark_pending_if_ours): a legacy
            # card must never be picked up by the Zoho sync worker, even after
            # being edited, trashed and restored. 'idle' (the old default)
            # does NOT mean this — it is also the state an ordinary project
            # of ours can sit in — so this is spelled out here rather than
            # inferred from quote_id being NULL.
            quote_sync_state="unmanaged",
        )
        db.add(p)
        created.append(p)
    await db.flush()  # so each new row has an id for _apply_rules' column queries
    for p in created:
        # A legacy card's imported column is a hint, not a fact: with
        # quote_status NULL and no tasks, the rules may derive somewhere else
        # entirely (e.g. `devis`), and without this the card would land with
        # board_column == item.column while move_lock says otherwise.
        #
        # TaskSummary() rather than a query: these projects are task-free by
        # construction (the legacy localStorage board had no tasks), so the
        # per-project SELECT this used to run could only ever return nothing.
        await _apply_rules(db, p, TaskSummary())
    await db.commit()
    for p in created:
        await db.refresh(p)
    await _broadcast_changed("import", None, _actor(current_user))
    # Imported projects are task-free by construction: the legacy localStorage
    # board had no concept of tasks. Explicit empty map, not a resolved one:
    # AitoProjectImportItem carries no shipping fields at all, so no imported
    # project can have a shipment — an empty map is correct here, not merely
    # a shortcut.
    return [_to_response(p, TaskSummary(), {}) for p in created]


@router.patch("/{project_id}/move", response_model=AitoProjectResponse)
async def move_project(
    project_id: int,
    payload: AitoProjectMove,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    project = await _get_active_project_or_404(db, project_id)

    summary = await _summary_for(db, project.id)

    # Reordering inside a column is always allowed: it changes priority, not
    # state. Crossing columns is allowed only for a card the rules have
    # released, and only between Finish and Done — every other placement is
    # derived, so honouring a drag there would just be overwritten by the next
    # recompute. The UI already disables those droppables; this is the guard
    # for anything that reaches the API another way.
    if payload.column != project.board_column:
        _, lock = evaluate(project.quote_status, project.board_column, summary.pending)
        if (
            lock is not None
            or project.board_column not in ("finish", "done")
            or payload.column not in ("finish", "done")
        ):
            raise HTTPException(status_code=409, detail="This project's column is set by its quote and task steps")

    source_column = project.board_column
    destination = await _active_in_column(db, payload.column, exclude_id=project.id)
    # The client's `position` is an index into the DISPLAYED order, which puts
    # flagged cards first (see list_projects and the same sort in
    # frontend/src/utils/aitoBoard.ts). `_active_in_column` returns the STORED
    # order and must keep doing so — grouping flagged cards in `position`
    # itself would bake the flag into the operator's manual ordering
    # permanently. So renumber in display order here instead: without this,
    # every drag in a column holding a flagged card that is not already top
    # lands N slots off, and some slots become unreachable. Python's sort is
    # stable, so `position, id` order still holds inside each of the three
    # tiers.
    destination.sort(key=lambda row: _flag_rank(row.flag))
    insert_at = min(payload.position, len(destination))
    destination.insert(insert_at, project)
    project.board_column = payload.column
    for i, row in enumerate(destination):
        row.position = i
    if source_column != payload.column:
        for i, row in enumerate(await _active_in_column(db, source_column, exclude_id=project.id)):
            row.position = i
        # Only a genuine cross-column move is a stage change — reordering
        # within a column has source_column == payload.column and must stay
        # silent, or every in-column drag would fill the timeline with
        # from == to non-events.
        await record(
            db,
            project.id,
            "stage.changed",
            actor_class="user",
            actor_name=_actor(current_user),
            subject_type="project",
            subject_id=project.id,
            changes=[{"field": "column", "from": source_column, "to": project.board_column}],
        )
    await db.commit()
    await _broadcast_changed("move", project.id, _actor(current_user))
    await db.refresh(project)
    return await _project_response(db, project, summary)


async def _claim_expected_version(db: AsyncSession, project: AitoProject, expected: int) -> bool:
    """Atomically claim the right to write `project`, for `update_project`'s
    `expected_version` guard (T-046).

    A plain ``if expected != project.version`` compares against a SELECT that
    may be arbitrarily stale by the time the row is actually written — this
    handler can sit behind a live Zoho catalogue fetch (`_shipping_rates`) in
    between. Two operators who both read version 5 both pass that compare,
    and the second write lands on top of the first with neither seeing a
    conflict.

    This closes the window instead of narrowing it: `UPDATE ... WHERE id =
    :id AND version = :expected` is evaluated by the database against the
    LIVE row, not a Python-side snapshot, and taking the row's write lock is
    what makes it atomic — a concurrent caller racing the same claim either
    sees the pre-update version (and wins, if it gets there first) or blocks
    until this transaction resolves and then evaluates the WHERE clause
    against the now-changed row (and loses). `SET version = version` is a
    deliberate no-op: this claims the row, it does not bump it — the real
    bump is still `_bump_version_on_content_change`'s job, unconditionally
    triggered by the ORM writes that follow in the same transaction.

    Returns True if the caller may proceed, False if the version has already
    moved and the caller should 409.
    """
    result = await db.execute(
        update(AitoProject)
        .where(AitoProject.id == project.id, AitoProject.version == expected)
        # `updated_at` must be pinned explicitly, or it is NOT a no-op: the
        # column is `onupdate=func.now()`, and Core auto-appends a column's
        # `onupdate` default to the SET clause for any column absent from
        # `.values()` — self-assigning `version` alone left `updated_at`
        # silently getting `CURRENT_TIMESTAMP` here, on every guarded PATCH,
        # even a no-op one that touches no VERSIONED_FIELDS and so must NOT
        # move `updated_at` (verified emitted SQL both ways — see T-046's
        # changelog entry). Naming `updated_at` here with its own current
        # value suppresses that default, same as `version` above.
        .values(version=AitoProject.version, updated_at=AitoProject.updated_at)
        # `project` is already loaded and neither `version` nor `updated_at`
        # is actually changing (see the no-op SET above), so there is
        # nothing for the ORM to reconcile against the identity map here —
        # and the default "evaluate" sync strategy cannot evaluate a
        # column-valued SET expression client-side anyway.
        .execution_options(synchronize_session=False)
    )
    return result.rowcount > 0


@router.patch("/{project_id}", response_model=AitoProjectResponse)
async def update_project(
    project_id: int,
    payload: AitoProjectUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    """Edit a card's content. Only fields present in the body are written, so a
    null client_phone clears it while an omitted one is left alone."""
    project = await _get_active_project_or_404(db, project_id)

    if payload.expected_version is not None and payload.expected_version != (project.version or 0):
        raise HTTPException(
            status_code=409,
            detail={"code": "version_conflict", "message": "Project was updated by someone else"},
        )

    fields = payload.model_dump(exclude_unset=True)
    # A guard token, not a column — it must not reach diff_fields or setattr.
    fields.pop("expected_version", None)
    # Captured before anything is applied, or diff_fields would compare the
    # new value against itself and return [].
    changes = diff_fields(project, fields)

    # The client fields are a snapshot, so consistency has to hold for the MERGED
    # row, not just the payload: a lone {"client_name": null} passes any
    # payload-only check while leaving client_id pointing at a contact with no
    # name attached.
    merged_client_id = fields.get("client_id", project.client_id)
    merged_client_name = fields.get("client_name", project.client_name)
    if merged_client_id is not None and not merged_client_name:
        raise HTTPException(status_code=422, detail="client_name is required when client_id is set")

    # Only fetched when the payload actually mentions a shipping column: an
    # ordinary description or client edit must not pay for a Zoho catalogue
    # read it will never use. See `_mentions_shipping`.
    rates = {}
    if _mentions_shipping(fields):
        rates = await _shipping_rates(db)

    # Re-assert the guard here, ATOMICALLY, immediately before any field is
    # written and with no network call between this compare and the write
    # that follows — the top-of-function compare above is a plain SELECT and
    # only fast-fails the common case; `_shipping_rates` just above can be a
    # live Zoho HTTP call, and two operators who both passed that first
    # compare can both still be here. See `_claim_expected_version`.
    if payload.expected_version is not None and not await _claim_expected_version(
        db, project, payload.expected_version
    ):
        raise HTTPException(
            status_code=409,
            detail={"code": "version_conflict", "message": "Project was updated by someone else"},
        )

    # `current=project` so correcting ONE field of an existing shipment works
    # without resending the other three — the merged row is what has to be
    # consistent, not the payload.
    shipping = _validated_shipping(fields, rates, current=project)
    if shipping is not None:
        for key, value in shipping.items():
            setattr(project, key, value)

    if "description" in fields:
        project.description = fields["description"].strip()
    for key in (
        "client_id",
        "client_name",
        "client_phone",
        "client_email",
        "client_is_company",
        "client_social_network",
        "client_social_handle",
    ):
        if key in fields:
            setattr(project, key, fields[key])
    # Captured before the mark: it is unconditional and idempotent, so
    # checking the post-mark state alone would fire sync.queued on every edit
    # to an already-pending project, not just the transition into it. The
    # shipping fields above are applied before this line runs, so a
    # shipping-only PATCH on a project that had settled to idle/error/locked
    # is marked pending by this same call, exactly like any other field edit
    # — see test_patch_attaches_shipping_and_requeues_the_quote, which drives
    # a project to idle first and asserts the transition back into pending.
    was_pending = project.quote_sync_state == "pending"
    _mark_pending_if_ours(project)
    await record(
        db,
        project.id,
        "project.updated",
        actor_class="user",
        actor_name=_actor(current_user),
        subject_type="project",
        subject_id=project.id,
        changes=changes,
    )
    if not was_pending and project.quote_sync_state == "pending":
        await record(db, project.id, "sync.queued", actor_class="system")
    queued = project.quote_sync_state == "pending"
    await _commit_and_wake(db, queued, project.id)
    # Same no-op silence `set_project_flag` and `set_quote_status` already
    # give a repeated/empty write — see their own comments. `changes` alone
    # is not enough here: a shipping PATCH sends its six columns through
    # `_validated_shipping`/setattr rather than `diff_fields`, so `shipping
    # is not None` (the payload touched at least one shipping column) is
    # ORed in even though it does not itself prove the merged row changed —
    # matching the spec's error-handling table (only guarded PATCHes that
    # actually change something need the rest of the board to hear about it).
    if changes or shipping is not None:
        await _broadcast_changed("update", project.id, _actor(current_user))
    await db.refresh(project)
    return await _project_response(db, project)


@router.patch("/{project_id}/flag", response_model=AitoProjectResponse)
async def set_project_flag(
    project_id: int,
    payload: AitoFlagUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    """Set a project's board flag — 'urgent', 'sav', 'pause' — or clear it.

    Its own route rather than a field on `AitoProjectUpdate`, and the reason is
    the last thing `update_project` does: `_mark_pending_if_ours` runs
    unconditionally there, queueing a Zoho quote push on every edit. That is
    right for description and client fields, which Zoho mirrors. It is wrong
    for `flag` — Zoho has no field for any of them, so the push would carry
    nothing; it would churn `quote_sync_state` on `locked` quotes, where writes
    are already known to be unsafe; and it would fill the timeline with
    `sync.queued` noise generated by a purely local toggle. So this route
    deliberately does NOT call it, and a test asserts the sync state survives.

    Reuses `Permission.AITO_UPDATE` rather than introducing a permission: a new
    one would need adding to the API-key classification lists and the role
    defaults, and "may edit an Aito card" is exactly the right authority here.
    """
    project = await _get_active_project_or_404(db, project_id)

    # Idempotent: re-sending the value the row already holds is a 200 with no
    # event, so a double-tap does not spam the timeline with non-decisions.
    if project.flag != payload.flag:
        previous = project.flag
        project.flag = payload.flag
        # Switching flags is two facts, so it is two rows. Cleared first, so
        # the timeline reads in the order the change actually happened.
        if previous:
            await record(
                db,
                project.id,
                _FLAG_CLEARED_EVENT[previous],
                actor_class="user",
                actor_name=_actor(current_user),
                subject_type="project",
                subject_id=project.id,
            )
        if payload.flag:
            await record(
                db,
                project.id,
                _FLAG_SET_EVENT[payload.flag],
                actor_class="user",
                actor_name=_actor(current_user),
                subject_type="project",
                subject_id=project.id,
            )
        await db.commit()
        await _broadcast_changed("flag", project.id, _actor(current_user))
        await db.refresh(project)

    return await _project_response(db, project)


@router.post("/{project_id}/quote-status", response_model=AitoQuoteStatusResponse)
async def set_quote_status(
    project_id: int,
    payload: AitoQuoteStatusUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    """Move a project's quote to sent, accepted or declined.

    `sent` sends the card to Waiting, acceptance is the gate that releases it
    onto the work columns, and a decline sends it straight to Done. `sent` is
    accepted here because nothing else in the app produces that status — it
    would otherwise only ever arrive by importing an already-sent Zoho quote,
    leaving Waiting unreachable for a hand-made card.

    The local write happens FIRST and
    always: the board has to be correct with Zoho unreachable, which is the
    rule the rest of the Aito code follows. The Zoho push is best-effort and
    reported as ``zoho_synced`` — never a non-200, or a Books outage would
    block the shop from recording a decision the client already made.
    """
    project = await _get_active_project_or_404(db, project_id)

    if payload.status == project.quote_status:
        # Someone (possibly this same operator, double-clicking) already
        # applied this exact decision. Nothing to write, record, or push —
        # and no 'Zoho not updated' warning to trigger, hence zoho_synced=True.
        summary = await _summary_for(db, project.id)
        return AitoQuoteStatusResponse(
            project=await _project_response(db, project, summary),
            zoho_synced=True,
            no_op=True,
        )
    # Asymmetric on purpose: 409 fires only on transitions a fresh UI never
    # offers, so they can only arrive from a stale view (someone else already
    # decided while this operator was looking at an older board). "accepted"
    # is fully terminal here — QuoteStatusActions offers no button off an
    # accepted card, so any different request naming it must be stale.
    # "declined" is terminal only against "sent" (re-sending an already
    # -declined quote is not a flow the UI offers either). declined ->
    # accepted is deliberately exempt: QuoteStatusActions puts an Accept
    # button on a declined card, and "latest go-ahead wins" is the intended
    # reopen path, not a conflict.
    if project.quote_status == "accepted" or (project.quote_status == "declined" and payload.status == "sent"):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "quote_status_conflict",
                "current": project.quote_status,
                "message": f"Quote was already {project.quote_status} by someone else",
            },
        )

    adopt_quote_status(project, payload.status)
    # Our side just moved, so any recorded block describes an attempt that no
    # longer exists. This is what lets quote_status_remote alone identify a
    # blocked attempt — see the column comments on AitoProject.
    project.quote_status_block = None
    project.quote_status_remote = None
    summary = await _summary_for(db, project.id)
    await _apply_rules(db, project, summary, actor=_actor(current_user))
    await record(
        db,
        project.id,
        f"quote.{payload.status}",
        actor_class="user",
        actor_name=_actor(current_user),
        subject_type="project",
        subject_id=project.id,
    )
    await db.commit()
    await _broadcast_changed("quote-status", project.id, _actor(current_user))
    await db.refresh(project)

    # Built BEFORE the Zoho call, not after: the project's data cannot change
    # in between, and a DB-layer failure inside set_estimate_status's
    # _request (a token-refresh write, a settings read) can leave the session
    # needing a rollback — a following _project_response call would then
    # raise PendingRollbackError instead of the intended best-effort
    # zoho_synced=False response. Same reasoning covers _shipping_names: it
    # is itself a DB read, so it has to happen up here too.
    project_response = await _project_response(db, project, summary)

    zoho_synced = False
    if project.quote_id:
        try:
            # No `current`: this pays for one read rather than trusting
            # project.quote_status, which the model documents as a snapshot
            # that goes stale.
            await zoho_service.advance_estimate_status(db, project.quote_id, payload.status)
            zoho_synced = True
        except Exception:
            logger.warning(
                "Could not set Zoho estimate %s to %s for project %s",
                project.quote_id,
                payload.status,
                project.id,
                exc_info=True,
            )
            # A DB-layer failure inside set_estimate_status can leave this
            # session needing a rollback; without it, get_db's own implicit
            # commit() after this handler returns would raise
            # PendingRollbackError and turn this best-effort push into a 500.
            await db.rollback()

    return AitoQuoteStatusResponse(
        project=project_response,
        zoho_synced=zoho_synced,
    )


@router.post("/{project_id}/restore", response_model=AitoProjectResponse)
async def restore_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    """Un-delete: back onto the board at the end of its original column."""
    project = (
        await db.execute(select(AitoProject).where(AitoProject.id == project_id, AitoProject.status == "deleted"))
    ).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Deleted project not found")
    # Restoring must not produce a second active project for one quote —
    # `exclude_id` because this row is the one being brought back.
    await _reject_duplicate_quote(db, project.quote_id, exclude_id=project.id)
    # Compute the append position before flipping status: autoflush would otherwise
    # include this row in its own column's active count.
    position = len(await _active_in_column(db, project.board_column))
    project.status = "active"
    project.position = position
    _mark_pending_if_ours(project)
    # Flipping `status` to 'active' above only stages the change — SQLite
    # enforces the partial unique index immediately, per-statement, not
    # deferred to COMMIT, so any query from here on can be the one that
    # surfaces a concurrent restore/create of the same quote: autoflush on
    # `_summary_for`'s own SELECT, record()'s flush, or the final commit.
    # Everything down to the commit is wrapped in the same try so none of
    # those spots can leak the race as an unhandled 500.
    try:
        summary = await _summary_for(db, project.id)
        await _apply_rules(db, project, summary, actor=_actor(current_user))
        await record(
            db,
            project.id,
            "project.restored",
            actor_class="user",
            actor_name=_actor(current_user),
            subject_type="project",
            subject_id=project.id,
        )
        queued = project.quote_sync_state == "pending"
        await db.commit()
        # Not routed through `_commit_and_wake`: this commit is inside its
        # own try/except (see the comment above), so the bump lives here
        # instead, at the same point relative to the commit -- immediately
        # after it returns, with no `await` in between -- and for the same
        # reason: see `_commit_and_wake`'s own comment on why the marker must
        # never be bumped before the commit it is reporting.
        if queued:
            _bump_requeue_marker(project.id)
    except IntegrityError as exc:
        await db.rollback()
        if _is_duplicate_active_quote_error(exc):
            raise HTTPException(status_code=409, detail=_DUPLICATE_QUOTE_DETAIL) from exc
        raise
    _wake_worker(queued)
    await _broadcast_changed("restore", project.id, _actor(current_user))
    await db.refresh(project)
    return await _project_response(db, project, summary)


@router.delete("/{project_id}", status_code=204)
async def delete_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_DELETE),
):
    """Soft delete: the row is kept forever, only hidden from the board."""
    project = await _get_active_project_or_404(db, project_id)
    project.status = "deleted"
    _mark_pending_if_ours(project)
    await record(
        db,
        project.id,
        "project.trashed",
        actor_class="user",
        actor_name=_actor(current_user),
        subject_type="project",
        subject_id=project.id,
    )
    queued = project.quote_sync_state == "pending"
    await _commit_and_wake(db, queued, project.id)
    await _broadcast_changed("delete", project_id, _actor(current_user))
