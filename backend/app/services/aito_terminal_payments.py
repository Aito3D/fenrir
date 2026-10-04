"""Card charges on the Heimdall terminal, started from a project card.

Query helpers and the API view live here; the reserve/create/settle/poll
machinery is added alongside (see spec §4)."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_terminal_payment import AitoTerminalPayment
from backend.app.services.aito_events import record, utc_now_naive as _now
from backend.app.services.aito_payment_documents import PaymentDocument
from backend.app.services.heimdall import (
    HeimdallAmbiguous,
    HeimdallNotConfigured,
    HeimdallNotFound,
    HeimdallRateLimited,
    HeimdallUnreachable,
    HeimdallUpstreamError,
    LinkView,
    heimdall_service,
)
from backend.app.services.inbox import broadcast_pending

logger = logging.getLogger(__name__)

OPEN_STATUSES = frozenset({"pending", "processing"})
# What stops a NEW charge on the project. `needs_attention` is deliberately
# NOT in here (spec §4.3/§8, amended 2026-09-23): that ROW is immutable —
# never retried, never re-polled — but once the operator has read the paper
# roll, charging the project again is a new row, not a refusal. Leaving it
# blocking made one unknown terminal answer freeze the card forever.
BLOCKING_STATUSES = frozenset({"pending", "processing"})
STATUSES = ("pending", "processing", "paid", "failed", "cancelled", "expired", "needs_attention")

REFRESH_MIN_SECONDS = 2.0
# How long an unminted reservation (`heimdall_id IS NULL`) may sit before the
# sweep writes it off. The handler died between the reservation commit and
# Heimdall's answer; nothing but an operator standing at the counter may
# replay it, so the sweep's only job is to stop it blocking the project.
ABANDONED_RESERVATION_SECONDS = 600
SETTLED_STATUSES = frozenset({"paid", "failed", "cancelled", "expired", "needs_attention"})
# How long a settle's owed effects (`effects_pending_at`) are left to the call
# that claimed the settle before the sweep re-drives them. That call clears
# the marker within a few DB round trips of its claim unless it failed; the
# grace only keeps the sweep from racing a settle still in flight.
EFFECTS_REDRIVE_GRACE_SECONDS = 300
# How many consecutive re-drives of one settle's effects may fail before the
# sweep gives up on it (T-082). Past that the failure is deterministic (an
# event or acceptance that will never commit), and re-driving it every tick
# forever would also crowd newer re-drives out of the `limit`. Giving up
# clears `effects_pending_at` (the row is no longer selected) and leaves the
# failure in `sync_error`, where the operator can see it.
MAX_EFFECTS_REDRIVE_FAILURES = 3

# Consecutive re-drive failures, per terminal row id. Module state, as the
# invoice/contact polls' failure stores: the durable facts are the row's own
# `effects_pending_at` (cleared at the cap) and `sync_error` (written on every
# failure); a restart re-earning the remaining attempts is harmless.
_redrive_failures: dict[int, int] = {}


def _reset_redrive_failures() -> None:
    """Forget every counted failure — tests run this around each pass."""
    _redrive_failures.clear()


# Serialises the guard-check + reservation-insert in `start_terminal_payment`.
# Single-process app; same rationale as `aito_payment_links._pass_lock` — two
# starts that straddle the guard would both see "nothing blocking" and both
# reserve a row (computing colliding `:n`/`:n+1` idempotency keys). Held only
# through the reservation commit; released before the Heimdall POST.
_start_lock = asyncio.Lock()

# Row ids whose `start_terminal_payment` is between its reservation commit and
# Heimdall's answer, in this process, right now. A reservation in here is NOT
# abandoned — see the replay guard in `start_terminal_payment`. Emptied by a
# restart, which is precisely when every reservation left behind IS abandoned.
_in_flight: set[int] = set()


async def current_terminal_payment(db: AsyncSession, project_id: int) -> AitoTerminalPayment | None:
    stmt = (
        select(AitoTerminalPayment)
        .where(AitoTerminalPayment.project_id == project_id)
        .order_by(AitoTerminalPayment.id.desc())
        .limit(1)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def current_terminal_payments(db: AsyncSession, project_ids: list[int]) -> dict[int, AitoTerminalPayment]:
    if not project_ids:
        return {}
    stmt = (
        select(AitoTerminalPayment)
        .where(AitoTerminalPayment.project_id.in_(project_ids))
        .order_by(AitoTerminalPayment.project_id, AitoTerminalPayment.id.desc())
    )
    out: dict[int, AitoTerminalPayment] = {}
    for row in (await db.execute(stmt)).scalars():
        out.setdefault(row.project_id, row)
    return out


def terminal_view(row: AitoTerminalPayment | None):
    from backend.app.schemas.aito import AitoTerminalPaymentView

    if row is None:
        return None
    return AitoTerminalPaymentView(
        id=row.id,
        document_kind=row.document_kind,
        document_number=row.document_number,
        status=row.status if row.status in STATUSES else "pending",
        amount=row.amount,
        amount_confirmed=row.amount_confirmed,
        booking_status=row.booking_status
        if row.booking_status in ("pending", "booked", "failed", "not_booked")
        else None,
        booking_error=row.booking_error,
        sync_error=row.sync_error,
        created_at=row.created_at,
        settled_at=row.settled_at,
    )


class TerminalInProgress(Exception):
    """Another charge for this project is still open at Heimdall. One
    exchange at a time, by design. A row waiting for a human to read the
    paper roll (`needs_attention`) does NOT raise this — see
    `BLOCKING_STATUSES`."""


async def _blocking_row(db: AsyncSession, project_id: int) -> AitoTerminalPayment | None:
    stmt = select(AitoTerminalPayment).where(
        AitoTerminalPayment.project_id == project_id, AitoTerminalPayment.status.in_(BLOCKING_STATUSES)
    )
    return (await db.execute(stmt)).scalars().first()


async def _next_key(db: AsyncSession, project_id: int) -> str:
    count = len(
        (await db.execute(select(AitoTerminalPayment.id).where(AitoTerminalPayment.project_id == project_id)))
        .scalars()
        .all()
    )
    return f"aito-tpe:{project_id}:{count + 1}"


def _adopt(row: AitoTerminalPayment, view: LinkView, now: datetime) -> None:
    row.heimdall_id = view.id
    row.status = view.status
    row.native_state = view.native_state
    row.amount_confirmed = view.amount_confirmed
    row.booking_status = view.booking_status
    row.booking_error = view.booking_error
    row.zoho_payment_id = view.zoho_payment_id
    row.checked_at = now
    row.sync_error = None


async def start_terminal_payment(
    db: AsyncSession,
    project: AitoProject,
    *,
    document: PaymentDocument,
    amount: int,
    actor_name: str | None,
    now: datetime,
) -> AitoTerminalPayment:
    """Reserve a row, commit, fire the terminal, adopt Heimdall's answer.

    The reservation commit comes first so a crash between the POST and the
    second commit leaves a row the operator sees as `pending` with no
    heimdall_id — never a silent second charge. A Heimdall REFUSAL (a 4xx
    answer, or `HeimdallNotConfigured`, which is NOT a subclass of
    `HeimdallUpstreamError`) marks the row `failed` (with the reason) and
    re-raises for the route to map: Heimdall answered, so nothing was
    created. A TRANSPORT failure (`HeimdallUnreachable` — connect refused,
    read timeout) or an AMBIGUOUS answer (`HeimdallAmbiguous` — a 5xx, a
    non-JSON body such as a proxy's 504 page, or a 2xx whose body cannot be
    read as a payment) says the opposite: the POST
    carries `confirm: true`, so either is precisely the case where the
    terminal may already be asking for the card. Such a row is therefore left exactly as it was reserved —
    `pending`, `heimdall_id` NULL, never `settled_at` — with the reason in
    `sync_error`, i.e. an ordinary unminted reservation: replayable by the
    operator under its own idempotency key (below), replaced if they charge
    something else, aged out by `_age_out_abandoned_reservations` if they
    walk away. Stamping it `failed` would hide a charge that reached the
    terminal from every reconciler. The guard-check-then-insert is itself
    serialised by `_start_lock` so two concurrent starts cannot both see
    "nothing blocking".

    Such an unminted reservation blocks the project, and neither the GET nor
    the sweep may clear it by asking Heimdall (there is no id to ask about,
    and a replay carries `confirm: true` — it FIRES the terminal). This
    function is the one place it can be resolved, because it only runs on an
    operator action with somebody standing at the counter (spec §4.3,
    amended 2026-09-23):

    * same document and same amount → REPLAY it: re-POST under the row's own
      idempotency key with the body rebuilt from the ROW, never from this
      call's arguments (Heimdall fingerprints `amount` + `document` +
      `confirm` and answers `409 idempotency_conflict` to any change), so
      Heimdall re-fires the stranded draft (202) or hands back the payment it
      already made (200);
    * a different document or amount → the reservation is abandoned (marked
      `failed`, never re-sent) and a fresh one takes its place."""
    project_id = project.id
    async with _start_lock:
        blocking = await _blocking_row(db, project_id)
        row: AitoTerminalPayment | None = None
        if blocking is not None:
            # `_in_flight`: a reservation whose OWN start is still between its
            # commit and Heimdall's answer, right now, in this process. It
            # looks exactly like an abandoned one in the database, so without
            # this two clicks a few hundred ms apart would both POST (same
            # key, so Heimdall still charges once — but one of them would
            # adopt a row the other is writing). Only a reservation nobody is
            # driving any more is replayable.
            if blocking.status != "pending" or blocking.heimdall_id is not None or blocking.id in _in_flight:
                raise TerminalInProgress("A terminal payment is already in progress for this project")
            if (
                blocking.document_kind == document.kind
                and blocking.document_id == document.id
                and blocking.amount == int(amount)
            ):
                row = blocking
            else:
                blocking.status = "failed"
                blocking.sync_error = "reservation abandoned (replaced by a new charge)"
                blocking.checked_at = now
                blocking.settled_at = now
                await db.commit()
        if row is None:
            row = AitoTerminalPayment(
                project_id=project_id,
                document_kind=document.kind,
                document_id=document.id,
                document_number=document.number,
                idempotency_key=await _next_key(db, project_id),
                amount=int(amount),
                created_by=actor_name,
                created_at=now,
            )
            db.add(row)
            await db.commit()
        # Claimed while still under the lock, so no concurrent start can read
        # this row as abandoned. Released in the `finally` below — including
        # on a client disconnect (`CancelledError`), which is exactly the case
        # that leaves a genuinely abandoned reservation behind.
        _in_flight.add(row.id)
    # True on both paths (a replay only ever replays an UNMINTED row), so the
    # `payment.terminal.started` event below is recorded exactly once per row:
    # it is only ever written after a successful POST, which is precisely what
    # this row has never had.
    record_started = row.heimdall_id is None
    try:
        try:
            view = await heimdall_service.create_terminal_payment(
                db,
                idempotency_key=row.idempotency_key,
                amount=row.amount,
                document={"type": row.document_kind, "id": row.document_id},
            )
        except (HeimdallUnreachable, HeimdallAmbiguous) as exc:
            # No answer at all, or one that does not say what happened (a
            # 5xx, a proxy's HTML 502/504, an unreadable 2xx body): the terminal may be dialling right
            # now. Leave the reservation unminted and open so the operator's
            # next start replays this same idempotency key and adopts whatever
            # Heimdall actually did. `_in_flight` is released in the `finally` below,
            # so that replay is not refused as still-in-progress.
            row.sync_error = str(exc)[:500]
            row.checked_at = now
            await db.commit()
            raise
        except (HeimdallUpstreamError, HeimdallNotConfigured) as exc:
            row.status = "failed"
            row.sync_error = str(exc)[:500]
            row.checked_at = now
            row.settled_at = now
            await db.commit()
            raise
        # Heimdall's own document-level double-charge guard, or a plain replay
        # of this idempotency key, can answer with a payment id ALREADY held by
        # another row (heimdall_id is unique) — most often the one Heimdall
        # just matched us against. Adopting it here would raise IntegrityError
        # on commit and strand this reservation `pending` forever. Fail the
        # fresh reservation instead and point at what already holds the charge.
        conflict = (
            await db.execute(
                select(AitoTerminalPayment.id).where(
                    AitoTerminalPayment.heimdall_id == view.id, AitoTerminalPayment.id != row.id
                )
            )
        ).scalar_one_or_none()
        if conflict is not None:
            row.status = "failed"
            row.sync_error = f"Heimdall already holds this charge (payment {view.id})"[:500]
            row.checked_at = now
            row.settled_at = now
            await db.commit()
            raise TerminalInProgress(f"Heimdall already holds this charge (payment {view.id})")
        _adopt(row, view, now)
        if record_started:
            await record(
                db,
                project_id,
                "payment.terminal.started",
                actor_class="user",
                actor_name=actor_name,
                subject_type="project",
                subject_id=project_id,
                detail={
                    "document_kind": row.document_kind,
                    "document_number": row.document_number,
                    "amount": row.amount,
                    "heimdall_id": row.heimdall_id,
                },
            )
        await db.commit()
        if row.status in SETTLED_STATUSES:
            # A 200 replay of an already-settled payment: settle it now.
            await apply_terminal_state(db, row, view, now=now)
        return row
    finally:
        _in_flight.discard(row.id)


async def apply_terminal_state(db: AsyncSession, row: AitoTerminalPayment, view: LinkView, *, now: datetime) -> None:
    """The one place a Heimdall view lands on a row. Commits. Idempotent:
    the transition events fire once, on the FIRST settle (whether the row
    was already open when this is called, or arrives here already adopted as
    settled — e.g. `start_terminal_payment`'s 200-replay branch), and a later
    poll only refreshes `booking_*`. Never guarded on the in-memory
    `settled_at` alone: a row can be handed in with `row.status` already
    equal to `view.status` (the caller adopted it first) and must still
    record/accept/refresh exactly once — see the claim below.

    The claim commits `effects_pending_at` with `settled_at`, and the
    settle's effects (the timeline event and, for a paid quote, the
    acceptance) clear it in their own single commit. If anything between the
    two fails, the marker survives and `poll_open_terminal_payments`
    re-drives the effects (`_redrive_settle_effects`) instead of them being
    lost behind `settled_at`."""
    was_settled = row.settled_at is not None
    _adopt(row, view, now)
    if was_settled or row.status not in SETTLED_STATUSES:
        await db.commit()
        return
    # THE SETTLE IS CLAIMED, not check-then-acted. `refresh_terminal_payment`
    # is reached both from the operator's 3 s poll and from
    # `poll_open_terminal_payments` (which forces, so REFRESH_MIN_SECONDS does
    # not keep them apart), on rows loaded into two different sessions. Two
    # callers whose Heimdall round trips straddle each other both read
    # `settled_at IS NULL` and would both fall through — two
    # `payment.terminal.paid` events, two `accept_quote` pushes, two
    # notifications for ONE card payment. Only the UPDATE that matches the
    # NULL guard wins; the loser re-reads the row and returns quietly. Same
    # idiom as `aito_tracking.ensure_tracking_token`, and unlike a module lock
    # (`_start_lock`) it holds across processes too.
    claimed = (
        await db.execute(
            update(AitoTerminalPayment)
            .where(AitoTerminalPayment.id == row.id, AitoTerminalPayment.settled_at.is_(None))
            .values(settled_at=now, effects_pending_at=now)
            .execution_options(synchronize_session=False)
        )
    ).rowcount
    await db.commit()
    if not claimed:
        await db.refresh(row)
        return
    set_committed_value(row, "settled_at", now)
    set_committed_value(row, "effects_pending_at", now)
    await _settle_effects(db, row)


async def _settle_effects(db: AsyncSession, row: AitoTerminalPayment) -> None:
    """What a claimed settle triggers: the timeline event, and for a PAID
    QUOTE charge the quote acceptance (with its notification, inside
    `accept_quote`), committed TOGETHER with clearing `effects_pending_at`
    (`apply_quote_decision`'s commit carries the event and the clear; the
    commit below does when nothing is accepted). A failure before that commit
    leaves the marker set for the sweep's re-drive. Then, for a paid charge,
    the best-effort figures refresh. Shared by the first settle and the
    re-drive; each runs only for the caller holding the claim."""
    project_id = row.project_id
    status = row.status
    document_kind = row.document_kind
    detail = {
        "document_kind": row.document_kind,
        "document_number": row.document_number,
        "amount": row.amount,
        "amount_confirmed": row.amount_confirmed,
        "heimdall_id": row.heimdall_id,
        "native_state": row.native_state,
        "zoho_payment_id": row.zoho_payment_id,
    }
    if status == "paid":
        kind = "payment.terminal.paid"
    elif status == "needs_attention":
        kind = "payment.terminal.attention"
    else:
        kind = "payment.terminal.failed"
    amount = row.amount_confirmed if row.amount_confirmed is not None else row.amount
    reference = row.document_number
    try:
        await record(
            db, project_id, kind, actor_class="system", subject_type="project", subject_id=project_id, detail=detail
        )
        row.effects_pending_at = None
        if status == "paid" and document_kind == "quote":
            from backend.app.services.aito_quote_status import accept_quote

            project = await db.get(AitoProject, project_id)
            if project is not None and project.status == "active":
                await accept_quote(db, project, source="terminal", detail={"amount": amount, "reference": reference})
        await db.commit()
        await broadcast_pending(db)
    except Exception:
        # Never leave a caller holding the cleared marker without the event
        # and acceptance it stands for: discard it, the marker stays set.
        await db.rollback()
        raise
    if status != "paid":
        return
    from backend.app.services.aito_manual_payments import refresh_after_payment

    await refresh_after_payment(db, project_id, document_kind)
    # accept_quote's Books push (aito_quote_status.push_quote_status) rolls
    # the session back on failure, which expires every ORM object in it —
    # including `row`. A caller reading `row.status` right after this call
    # (or building `terminal_view(row)`) must not have to know that, or hit
    # MissingGreenlet on the implicit reload. Cheap and correct either way:
    # a no-op re-read when nothing rolled back.
    await db.refresh(row)


async def _redrive_settle_effects(db: AsyncSession, *, now: datetime, limit: int) -> int:
    """Re-run `_settle_effects` for settles whose effects are still owed
    (`effects_pending_at` set more than EFFECTS_REDRIVE_GRACE_SECONDS ago —
    the call that claimed the settle failed before its effects committed).
    No Heimdall call: the charge is already settled. Each row is claimed
    like the settle (conditional UPDATE clearing the marker, committed with
    the effects), so the event, acceptance and notification happen once.
    Returns the number of rows re-driven."""
    cutoff = now - timedelta(seconds=EFFECTS_REDRIVE_GRACE_SECONDS)
    stmt = (
        select(AitoTerminalPayment.id)
        .where(
            AitoTerminalPayment.effects_pending_at.is_not(None),
            AitoTerminalPayment.effects_pending_at <= cutoff,
        )
        .order_by(AitoTerminalPayment.effects_pending_at, AitoTerminalPayment.id)
        .limit(limit)
    )
    redriven = 0
    for rid in list((await db.execute(stmt)).scalars().all()):
        try:
            row = await db.get(AitoTerminalPayment, rid)
            if row is None:
                continue
            won = (
                await db.execute(
                    update(AitoTerminalPayment)
                    .where(AitoTerminalPayment.id == rid, AitoTerminalPayment.effects_pending_at.is_not(None))
                    .values(effects_pending_at=None)
                    .execution_options(synchronize_session=False)
                )
            ).rowcount
            if not won:
                await db.rollback()
                continue
            set_committed_value(row, "effects_pending_at", None)
            if rid in _redrive_failures:
                # The `sync_error` an earlier failed re-drive wrote: cleared
                # in the same commit as the effects (rolled back with them).
                row.sync_error = None
            logger.info("terminal payment sweep: re-driving the settle effects of row %s", rid)
            await _settle_effects(db, row)
            _redrive_failures.pop(rid, None)
            redriven += 1
        except Exception as exc:  # noqa: BLE001 — one row's failure must not end the pass
            await db.rollback()
            await _record_redrive_failure(db, rid, exc)
    return redriven


async def _record_redrive_failure(db: AsyncSession, rid: int, exc: Exception) -> None:
    """Count a failed re-drive (T-082): write it to the row's `sync_error`
    and, at MAX_EFFECTS_REDRIVE_FAILURES, stop re-driving by clearing
    `effects_pending_at`, logging ERROR once. Both writes are guarded on the
    marker still being set, so a row whose effects did commit (a failure
    after that commit) is never branded with an error."""
    failures = _redrive_failures.get(rid, 0) + 1
    values: dict = {"sync_error": f"Settle effects failed: {exc}"[:500]}
    if failures < MAX_EFFECTS_REDRIVE_FAILURES:
        _redrive_failures[rid] = failures
        logger.warning("terminal payment sweep: re-driving the settle effects of row %s failed: %s", rid, exc)
    else:
        _redrive_failures.pop(rid, None)
        values["effects_pending_at"] = None
        logger.error(
            "terminal payment sweep: giving up on the settle effects of row %s after %d consecutive failures; "
            "the error stays in its sync_error. Last error: %s",
            rid,
            failures,
            exc,
        )
    try:
        await db.execute(
            update(AitoTerminalPayment)
            .where(AitoTerminalPayment.id == rid, AitoTerminalPayment.effects_pending_at.is_not(None))
            .values(**values)
            .execution_options(synchronize_session=False)
        )
        await db.commit()
    except Exception as write_exc:  # noqa: BLE001 — best effort; the next tick re-drives the row anyway
        logger.warning("terminal payment sweep: recording the re-drive failure of row %s failed: %s", rid, write_exc)
        await db.rollback()


async def refresh_terminal_payment(
    db: AsyncSession, row: AitoTerminalPayment, *, now: datetime, force: bool = False
) -> AitoTerminalPayment:
    """One GET, throttled to REFRESH_MIN_SECONDS since the last contact.
    Never raises, except a 429 which the caller must handle (the poll's
    sweep stops the pass on it — see `poll_open_terminal_payments`). Every
    other Heimdall failure, including `HeimdallNotConfigured` (not a subclass
    of `HeimdallUpstreamError`), lands in `sync_error` and the stored row is
    returned as-is. A 404 (Heimdall lost the payment) marks an OPEN row
    `failed` — with a `payment.terminal.failed` event saying why — so the
    operator can start again; a row that is already `paid` (or otherwise
    settled) only records the 404 in `sync_error`/`checked_at`, because
    Heimdall forgetting a charge never un-charges the card."""
    await _refresh_terminal_payment(db, row, now=now, force=force)
    return row


async def _refresh_terminal_payment(db: AsyncSession, row: AitoTerminalPayment, *, now: datetime, force: bool) -> bool:
    """The body of `refresh_terminal_payment`. Returns True only when the GET
    never got an answer (`HeimdallUnreachable`, stored in `sync_error` like
    any other failure) — `poll_open_terminal_payments` stops its pass on it."""
    if row.heimdall_id is None:
        return False
    # A `paid` row with no `settled_at` was adopted as paid but its settle
    # never committed (`start_terminal_payment`'s 200-replay commits the
    # adoption before `apply_terminal_state`, which then failed): polled
    # again so the settle, its event and the quote acceptance happen.
    open_row = row.status in OPEN_STATUSES or (
        row.status == "paid" and (row.booking_status == "pending" or row.settled_at is None)
    )
    if not open_row:
        return False
    if not force and row.checked_at is not None and (now - row.checked_at) < timedelta(seconds=REFRESH_MIN_SECONDS):
        return False
    try:
        view = await heimdall_service.get_payment(db, row.heimdall_id)
    except HeimdallNotFound as exc:
        row.sync_error = str(exc)[:500]
        row.checked_at = now
        if row.status == "paid" or row.settled_at is not None:
            # The card WAS charged; Heimdall forgetting the payment does not
            # un-charge it. `open_row` above deliberately keeps polling a paid
            # row whose Zoho booking is still pending, so a repointed base URL,
            # a rotated key or a lost record used to answer 404 here and
            # rewrite a real counter payment as `failed`. Record the 404 and
            # leave `status`, `booking_status` and `settled_at` alone — the
            # sweep re-reads the row on the next tick (one cheap GET), and if
            # Heimdall comes back the booking still lands. No event: nothing
            # about the payment changed, only our view of it.
            await db.commit()
            return False
        # An open row Heimdall lost: nothing will ever settle it, so close it
        # so the operator can charge again. Unlike every other close this one
        # is decided here rather than in `apply_terminal_state` (which never
        # runs — there is no view), so the timeline event is recorded by hand,
        # in the same shape `_age_out_abandoned_reservations` uses. The status
        # flip and its event share ONE commit: if the event write fails, the
        # row stays open (the caller rolls back) and the next poll retries it,
        # instead of a failed row with no timeline entry nothing re-selects.
        row.status = "failed"
        row.settled_at = now
        await record(
            db,
            row.project_id,
            "payment.terminal.failed",
            actor_class="system",
            subject_type="project",
            subject_id=row.project_id,
            detail={
                "document_kind": row.document_kind,
                "document_number": row.document_number,
                "amount": row.amount,
                "heimdall_id": row.heimdall_id,
                "reason": "not_found",
            },
        )
        await db.commit()
        return False
    except HeimdallRateLimited:
        raise
    except (HeimdallUpstreamError, HeimdallNotConfigured) as exc:
        row.sync_error = str(exc)[:500]
        row.checked_at = now
        await db.commit()
        return isinstance(exc, HeimdallUnreachable)
    await apply_terminal_state(db, row, view, now=now)
    return False


async def _age_out_abandoned_reservations(db: AsyncSession, *, now: datetime, limit: int) -> int:
    """Write off unminted reservations older than
    `ABANDONED_RESERVATION_SECONDS`, so one dead handler cannot block a
    project's counter forever.

    THE MONEY RULE: not one Heimdall call happens here. Re-POSTing a
    reservation means `confirm: true`, which makes the terminal ask for a
    card — that may only ever happen from `start_terminal_payment`, with an
    operator present. The sweep ages the row out and stops there; if Heimdall
    did charge the card before the handler died, the operator's paper roll
    and Heimdall's own ledger are the record, and the abandoned event says
    where to look.

    T-123: a reservation being replayed right now (in `_in_flight`) is
    skipped, and the write-off is a conditional claim, so a row the replay
    adopted after the listing keeps its adoption and gets no event."""
    cutoff = now - timedelta(seconds=ABANDONED_RESERVATION_SECONDS)
    stmt = (
        select(AitoTerminalPayment.id)
        .where(
            AitoTerminalPayment.heimdall_id.is_(None),
            AitoTerminalPayment.status == "pending",
            AitoTerminalPayment.created_at < cutoff,
        )
        .order_by(AitoTerminalPayment.id)
        .limit(limit)
    )
    aged = 0
    for rid in list((await db.execute(stmt)).scalars().all()):
        try:
            row = await db.get(AitoTerminalPayment, rid)
            if row is None:
                continue
            # T-123: a reservation an operator is replaying right now (its
            # `start_terminal_payment` POST in flight, in this process) is
            # not abandoned. Checked after the fetch's await, right before
            # the claim.
            if rid in _in_flight:
                continue
            # A conditional claim, not an ORM set: a row the replay already
            # adopted (minted, re-opened or settled) since the listing above
            # matches nothing and is left alone, with no event.
            claimed = await db.execute(
                update(AitoTerminalPayment)
                .where(
                    AitoTerminalPayment.id == rid,
                    AitoTerminalPayment.status == "pending",
                    AitoTerminalPayment.heimdall_id.is_(None),
                    AitoTerminalPayment.settled_at.is_(None),
                )
                .values(status="failed", sync_error="reservation abandoned", checked_at=now, settled_at=now)
                .execution_options(synchronize_session=False)
            )
            if claimed.rowcount != 1:
                await db.rollback()
                continue
            # The loaded row mirrors the claim (same idiom as the settle claim
            # in `apply_terminal_state`); a rollback below expires it again.
            set_committed_value(row, "status", "failed")
            set_committed_value(row, "sync_error", "reservation abandoned")
            set_committed_value(row, "checked_at", now)
            set_committed_value(row, "settled_at", now)
            # The write-off and its event share ONE commit: a failed event
            # write rolls the row back to `pending`, so the next pass ages it
            # out again rather than leaving a failed row with no event.
            await record(
                db,
                row.project_id,
                "payment.terminal.failed",
                actor_class="system",
                subject_type="project",
                subject_id=row.project_id,
                detail={
                    "document_kind": row.document_kind,
                    "document_number": row.document_number,
                    "amount": row.amount,
                    "heimdall_id": None,
                    "reason": "abandoned",
                },
            )
            await db.commit()
            aged += 1
        except Exception as exc:  # noqa: BLE001 — one row's failure must not end the pass
            logger.warning("terminal payment sweep: ageing out reservation %s failed: %s", rid, exc)
            await db.rollback()
    return aged


async def poll_open_terminal_payments(db: AsyncSession, *, now: datetime | None = None, limit: int = 40) -> int:
    """The tick's sweep: abandoned reservations are aged out (never re-sent —
    see `_age_out_abandoned_reservations`), then every open row, plus paid
    rows whose Zoho booking is still pending or whose settle never committed
    (`settled_at` NULL), oldest contact first. Settles whose event or quote
    acceptance failed are re-driven first (`_redrive_settle_effects`, no
    Heimdall call). Returns
    the number of rows acted on. A 429 stops the polling half (the
    reconciler's own throttle covers the next tick); so does a
    `HeimdallUnreachable` (stored on the row it hit), for this pass only."""
    if not await heimdall_service.is_configured(db):
        return 0
    now = now or _now()
    visited = await _age_out_abandoned_reservations(db, now=now, limit=limit)
    visited += await _redrive_settle_effects(db, now=now, limit=limit)
    stmt = (
        select(AitoTerminalPayment.id)
        .where(
            AitoTerminalPayment.heimdall_id.is_not(None),
            (AitoTerminalPayment.status.in_(OPEN_STATUSES))
            | (
                (AitoTerminalPayment.status == "paid")
                & ((AitoTerminalPayment.booking_status == "pending") | AitoTerminalPayment.settled_at.is_(None))
            ),
        )
        .order_by(AitoTerminalPayment.checked_at.asc().nulls_first(), AitoTerminalPayment.id)
        .limit(limit)
    )
    ids = list((await db.execute(stmt)).scalars().all())
    for rid in ids:
        try:
            row = await db.get(AitoTerminalPayment, rid)
            if row is None:
                continue
            visited += 1
            if await _refresh_terminal_payment(db, row, now=now, force=True):
                # A hung Heimdall costs the full client timeout per GET: stop
                # here and leave the remaining rows for the next tick (no
                # throttle window — the next tick and the GET route try again).
                logger.warning("terminal payment poll: Heimdall unreachable, stopping this pass")
                break
        except HeimdallRateLimited as exc:
            logger.warning("terminal payment poll: rate limited, stopping: %s", exc)
            await db.rollback()
            break
        except Exception as exc:  # noqa: BLE001 — one row's failure must not end the pass
            logger.warning("terminal payment poll: row %s failed: %s", rid, exc)
            await db.rollback()
    return visited
