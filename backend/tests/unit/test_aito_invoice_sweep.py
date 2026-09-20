"""The hourly invoice sweep: one Books call per open invoice, stops when paid."""

import asyncio
import contextlib
import time
from datetime import datetime

import pytest
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.models.aito_project import AitoProject
from backend.app.services import aito_invoice_sweep, aito_quote_sync
from backend.app.services.aito_invoice_sweep import sweep_invoices
from backend.app.services.zoho import ZohoRateLimited, ZohoUpstreamError, zoho_service


@pytest.fixture(autouse=True)
def reset_gate():
    aito_invoice_sweep._last_run = 0.0
    yield
    aito_invoice_sweep._last_run = 0.0


@pytest.fixture(autouse=True)
def reset_throttle():
    """``_throttled_until`` is process-local, module-level state shared with
    aito_quote_sync (T-006) -- mirrors the reset fixtures in
    test_aito_quote_sync.py for the same reason: it must not leak into a
    later test."""
    aito_quote_sync._throttled_until = None
    yield
    aito_quote_sync._throttled_until = None


def _invoice(balance: float, status: str = "unpaid", due: str = "2026-03-01") -> dict:
    return {
        "id": "INV1",
        "number": "INV-1",
        "date": "2026-02-01",
        "due_date": due,
        "total": 100.0,
        "balance": balance,
        "currency_code": "XPF",
        "status": status,
    }


async def _project(db, **fields) -> AitoProject:
    base = {
        "description": "x",
        "board_column": "finish",
        "position": 0,
        "status": "active",
        "client_id": "z1",
        "quote_id": "EST1",
        "quote_invoiced": True,
    }
    base.update(fields)
    row = AitoProject(**base)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


def _fake(responses: dict[str, list[dict] | Exception], calls: list[str]):
    async def list_project_invoices(db, estimate_id, customer_id):
        calls.append(estimate_id)
        out = responses.get(estimate_id, [])
        if isinstance(out, Exception):
            raise out
        return out

    return list_project_invoices


@pytest.mark.asyncio
async def test_selection_and_field_writes(db_session, monkeypatch):
    open_ = await _project(db_session, quote_id="EST-OPEN")
    paid = await _project(db_session, quote_id="EST-PAID", invoice_balance=0.0)
    not_invoiced = await _project(db_session, quote_id="EST-NO", quote_invoiced=False)
    trashed = await _project(db_session, quote_id="EST-TRASH", status="deleted")
    quoteless = await _project(db_session, quote_id=None)
    # Captured before expire_all(): an expired AsyncSession object can't
    # reload its own PK synchronously (MissingGreenlet), so `.id` has to be
    # read while the row is still fresh, not off the post-expire object.
    open_id, other_ids = open_.id, [paid.id, not_invoiced.id, trashed.id, quoteless.id]
    calls: list[str] = []
    monkeypatch.setattr(
        zoho_service, "list_project_invoices", _fake({"EST-OPEN": [_invoice(40.0, "partially_paid")]}, calls)
    )

    updated = await sweep_invoices(db_session, force=True)

    assert calls == ["EST-OPEN"]
    assert updated == 1
    db_session.expire_all()
    row = await db_session.get(AitoProject, open_id)
    assert (row.invoice_status, row.invoice_balance, row.invoice_due_date) == ("partially_paid", 40.0, "2026-03-01")
    assert isinstance(row.invoice_checked_at, datetime)
    for other_id in other_ids:
        assert (await db_session.get(AitoProject, other_id)).invoice_checked_at is None


@pytest.mark.asyncio
async def test_paid_drops_out_and_the_newest_invoice_wins(db_session, monkeypatch):
    p = await _project(db_session, quote_id="EST1")
    p_id = p.id  # captured before expire_all(); see note above
    calls: list[str] = []
    monkeypatch.setattr(
        zoho_service,
        "list_project_invoices",
        _fake({"EST1": [_invoice(0.0, "paid", "2026-03-10"), _invoice(100.0, "unpaid", "2026-01-01")]}, calls),
    )
    await sweep_invoices(db_session, force=True)
    db_session.expire_all()
    row = await db_session.get(AitoProject, p_id)
    assert (row.invoice_status, row.invoice_balance, row.invoice_due_date) == ("paid", 0.0, "2026-03-10")

    await sweep_invoices(db_session, force=True)
    assert calls == ["EST1"]  # paid: never asked again


@pytest.mark.asyncio
async def test_an_upstream_error_skips_one_project_only(db_session, monkeypatch):
    bad = await _project(db_session, quote_id="EST-BAD")
    good = await _project(db_session, quote_id="EST-GOOD")
    bad_id, good_id = bad.id, good.id  # captured before expire_all(); see note above
    monkeypatch.setattr(
        zoho_service,
        "list_project_invoices",
        _fake({"EST-BAD": ZohoUpstreamError("boom"), "EST-GOOD": [_invoice(10.0)]}, []),
    )
    updated = await sweep_invoices(db_session, force=True)
    assert updated == 1
    db_session.expire_all()
    assert (await db_session.get(AitoProject, bad_id)).invoice_checked_at is None
    assert (await db_session.get(AitoProject, good_id)).invoice_balance == 10.0


@pytest.mark.asyncio
async def test_a_malformed_payload_skips_one_project_only(db_session, monkeypatch):
    bad = await _project(db_session, quote_id="EST-BAD")
    good = await _project(db_session, quote_id="EST-GOOD")
    bad_id, good_id = bad.id, good.id  # captured before expire_all(); see note above
    bad_invoice = {"balance": "not-a-number", "status": "unpaid", "due_date": "2026-03-01"}
    monkeypatch.setattr(
        zoho_service,
        "list_project_invoices",
        _fake({"EST-BAD": [bad_invoice], "EST-GOOD": [_invoice(10.0)]}, []),
    )
    updated = await sweep_invoices(db_session, force=True)
    assert updated == 1
    db_session.expire_all()
    bad_row = await db_session.get(AitoProject, bad_id)
    assert bad_row.invoice_checked_at is None
    assert bad_row.invoice_status is None
    assert (await db_session.get(AitoProject, good_id)).invoice_balance == 10.0


@pytest.mark.asyncio
async def test_no_invoice_yet_still_stamps_checked_at(db_session, monkeypatch):
    p = await _project(db_session, quote_id="EST1")
    p_id = p.id  # captured before expire_all(); see note above
    monkeypatch.setattr(zoho_service, "list_project_invoices", _fake({}, []))
    await sweep_invoices(db_session, force=True)
    db_session.expire_all()
    row = await db_session.get(AitoProject, p_id)
    assert row.invoice_checked_at is not None
    assert row.invoice_status is None and row.invoice_balance is None


@pytest.mark.asyncio
async def test_an_invoice_deleted_in_books_clears_the_stale_cached_fields(db_session, monkeypatch):
    """T-007: Books answering ``[]`` for a project that previously had an
    invoice (deleted, or its estimate/customer link removed) must clear the
    cached status/balance/due date rather than leave the last-seen figures
    in place -- otherwise the unpaid follow-up chip keeps chasing a client
    for an invoice that no longer exists."""
    p = await _project(
        db_session,
        quote_id="EST1",
        invoice_status="unpaid",
        invoice_balance=100.0,
        invoice_due_date="2026-01-01",
    )
    p_id = p.id  # captured before expire_all(); see note on the other tests
    monkeypatch.setattr(zoho_service, "list_project_invoices", _fake({}, []))

    updated = await sweep_invoices(db_session, force=True)

    assert updated == 1
    db_session.expire_all()
    row = await db_session.get(AitoProject, p_id)
    assert (row.invoice_status, row.invoice_balance, row.invoice_due_date) == (None, None, None)
    # The call still succeeded, so this counts as a real refresh -- the
    # operator can trust invoice_checked_at, it isn't a stale timestamp.
    assert isinstance(row.invoice_checked_at, datetime)


@pytest.mark.asyncio
async def test_a_project_still_owing_keeps_refreshing_as_before(db_session, monkeypatch):
    """A live, still-unpaid invoice is unaffected by the T-007 ``else``
    branch: the sweep still refreshes it from the newest invoice every
    pass, exactly like before that fix."""
    p = await _project(db_session, quote_id="EST1")
    p_id = p.id  # captured before expire_all(); see note on the other tests
    monkeypatch.setattr(zoho_service, "list_project_invoices", _fake({"EST1": [_invoice(25.0)]}, []))

    updated = await sweep_invoices(db_session, force=True)

    assert updated == 1
    db_session.expire_all()
    row = await db_session.get(AitoProject, p_id)
    assert (row.invoice_status, row.invoice_balance, row.invoice_due_date) == ("unpaid", 25.0, "2026-03-01")


@pytest.mark.asyncio
async def test_a_cleared_row_is_still_selected_on_the_next_pass(db_session, monkeypatch):
    """T-007 decision (a): the reset sets ``invoice_balance`` to ``None``
    rather than ``0.0``, so the row keeps matching the selection's
    ``invoice_balance.is_(None)`` clause and is asked about again next
    pass -- it does not silently drop out of the sweep the way a paid
    invoice (balance == 0.0) does."""
    await _project(
        db_session,
        quote_id="EST1",
        invoice_status="unpaid",
        invoice_balance=100.0,
        invoice_due_date="2026-01-01",
    )
    calls: list[str] = []
    monkeypatch.setattr(zoho_service, "list_project_invoices", _fake({}, calls))

    await sweep_invoices(db_session, force=True)
    aito_invoice_sweep._last_run = 0.0  # bypass the hourly gate for the next pass
    await sweep_invoices(db_session, force=True)

    assert calls == ["EST1", "EST1"]


@pytest.mark.asyncio
async def test_the_hourly_gate_skips_a_second_pass(db_session, monkeypatch):
    await _project(db_session, quote_id="EST1")
    calls: list[str] = []
    monkeypatch.setattr(zoho_service, "list_project_invoices", _fake({"EST1": [_invoice(10.0)]}, calls))
    await sweep_invoices(db_session)
    await sweep_invoices(db_session)
    assert calls == ["EST1"]
    assert await sweep_invoices(db_session, force=True) == 1
    assert calls == ["EST1", "EST1"]


@pytest.mark.asyncio
async def test_a_429_stops_the_sweep_and_commits_what_is_already_refreshed(db_session, monkeypatch):
    """T-006: a Books rate limit on one project must not be treated like an
    ordinary upstream error (skip one project, keep going) -- it must stop
    the whole pass right there, without touching any project still waiting
    in the queue, while keeping whatever was already refreshed."""
    good = await _project(db_session, quote_id="EST-GOOD")
    bad = await _project(db_session, quote_id="EST-BAD")
    never = await _project(db_session, quote_id="EST-NEVER")
    # Captured before expire_all(); see note on the other tests in this file.
    good_id, bad_id, never_id = good.id, bad.id, never.id
    calls: list[str] = []
    monkeypatch.setattr(
        zoho_service,
        "list_project_invoices",
        _fake(
            {
                "EST-GOOD": [_invoice(10.0)],
                "EST-BAD": ZohoRateLimited("Too many requests", retry_after=5.0),
            },
            calls,
        ),
    )
    commit_calls: list[None] = []
    original_commit = db_session.commit

    async def _tracking_commit():
        commit_calls.append(None)
        await original_commit()

    monkeypatch.setattr(db_session, "commit", _tracking_commit)

    with pytest.raises(ZohoRateLimited):
        await sweep_invoices(db_session, force=True)

    # Never reached EST-NEVER: the loop stopped dead at the 429, not merely
    # skipped the one project like a plain ZohoUpstreamError would.
    assert calls == ["EST-GOOD", "EST-BAD"]
    # Exactly one commit -- T-010's per-project commit for EST-GOOD, taken
    # right after that project succeeds and well before EST-BAD is even
    # attempted. There is no longer a second, end-of-pass commit for this
    # path to also take (dropped as dead code by T-010: by the time a 429
    # can fire, every prior success is already committed).
    assert len(commit_calls) == 1

    db_session.expire_all()
    good_row = await db_session.get(AitoProject, good_id)
    assert good_row.invoice_balance == 10.0
    assert good_row.invoice_checked_at is not None
    # EST-BAD's own row was never marked as checked either: the 429 fires
    # before that project's fields are set, so it is left exactly as
    # untouched as the one still waiting behind it in the queue.
    bad_row = await db_session.get(AitoProject, bad_id)
    assert bad_row.invoice_checked_at is None
    never_row = await db_session.get(AitoProject, never_id)
    assert never_row.invoice_checked_at is None
    # T-010: a pass that ends in ZohoRateLimited does not spend the hourly
    # slot either -- the throttle window run_sync_loop arms already
    # prevents hammering Books again immediately, so the sweep should
    # simply resume on the very next tick once that window clears.
    assert aito_invoice_sweep._last_run == 0.0


@pytest.mark.asyncio
async def test_a_mid_pass_commit_failure_skips_that_project_but_keeps_going(db_session, test_engine, monkeypatch):
    """T-027: a per-project commit failure (SQLite "database is locked", or
    anything else) costs only the project it happened on -- both the
    project already refreshed before it AND the project still queued behind
    it are refreshed in the same pass. T-031: the pass still ran to
    completion (the loop itself absorbed the failure), so the hourly slot
    is spent exactly like an all-success pass -- the very next, non-forced
    call must return 0 rather than re-entering the sweep."""
    good = await _project(db_session, quote_id="EST-GOOD")
    bad = await _project(db_session, quote_id="EST-BAD")
    later = await _project(db_session, quote_id="EST-LATER")
    good_id, bad_id, later_id = good.id, bad.id, later.id  # captured before expire_all(); see note above
    monkeypatch.setattr(
        zoho_service,
        "list_project_invoices",
        _fake(
            {"EST-GOOD": [_invoice(10.0)], "EST-BAD": [_invoice(20.0)], "EST-LATER": [_invoice(30.0)]},
            [],
        ),
    )
    original_commit = db_session.commit
    commit_n = {"count": 0}

    async def _flaky_commit():
        commit_n["count"] += 1
        if commit_n["count"] == 2:
            raise OperationalError("COMMIT", {}, Exception("database is locked"))
        await original_commit()

    monkeypatch.setattr(db_session, "commit", _flaky_commit)

    updated = await sweep_invoices(db_session, force=True)

    # Only EST-BAD's commit failed -- EST-GOOD (before it) and EST-LATER
    # (behind it) both count as successful refreshes.
    assert updated == 2

    # Read through a brand-new session against the same engine rather than
    # db_session itself: db_session's own transaction may still carry
    # SQLAlchemy-internal state from the failed second commit, so only a
    # fresh session proves what actually reached the database.
    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as fresh:
        good_row = await fresh.get(AitoProject, good_id)
        assert good_row.invoice_balance == 10.0
        assert good_row.invoice_checked_at is not None
        # EST-BAD's own row is untouched: the failed commit was rolled back.
        bad_row = await fresh.get(AitoProject, bad_id)
        assert bad_row.invoice_checked_at is None
        assert bad_row.invoice_balance is None
        # EST-LATER, queued behind the failure, still committed cleanly --
        # proof the rolled-back project's pending writes did not leak into
        # the next project's transaction.
        later_row = await fresh.get(AitoProject, later_id)
        assert later_row.invoice_balance == 30.0
        assert later_row.invoice_checked_at is not None

    # The pass ran to completion despite the mid-pass commit failure, so the
    # hourly slot was spent exactly like a fully successful pass -- the next
    # non-forced call must return 0, not re-enter the sweep.
    assert aito_invoice_sweep._last_run != 0.0
    calls: list[str] = []
    monkeypatch.setattr(zoho_service, "list_project_invoices", _fake({"EST-BAD": [_invoice(20.0)]}, calls))
    assert await sweep_invoices(db_session) == 0
    assert calls == []


@pytest.mark.asyncio
async def test_an_exception_outside_the_loop_still_spends_the_hourly_slot(db_session, monkeypatch):
    """T-031: an exception that escapes the pass without ever being a
    ``ZohoRateLimited`` (the SELECT itself blowing up, here) still stamps
    ``_last_run`` before propagating -- only the 429 path is exempt."""
    await _project(db_session, quote_id="EST1")

    async def _boom(stmt):
        raise RuntimeError("select exploded")

    monkeypatch.setattr(db_session, "execute", _boom)

    with pytest.raises(RuntimeError):
        await sweep_invoices(db_session, force=True)

    assert aito_invoice_sweep._last_run != 0.0


@pytest.mark.asyncio
async def test_a_commit_failure_survives_a_rollback_that_also_fails(db_session, monkeypatch):
    """T-027: the rollback issued to recover from a failed commit is itself
    guarded -- if it also raises (a closed connection, say), the sweep still
    just skips that one project and moves on rather than letting the
    rollback failure escape and take down the whole pass."""
    await _project(db_session, quote_id="EST-BAD")
    monkeypatch.setattr(zoho_service, "list_project_invoices", _fake({"EST-BAD": [_invoice(10.0)]}, []))

    async def _failing_commit():
        raise OperationalError("COMMIT", {}, Exception("database is locked"))

    async def _failing_rollback():
        raise OperationalError("ROLLBACK", {}, Exception("no such savepoint"))

    monkeypatch.setattr(db_session, "commit", _failing_commit)
    monkeypatch.setattr(db_session, "rollback", _failing_rollback)

    updated = await sweep_invoices(db_session, force=True)

    assert updated == 0
    assert aito_invoice_sweep._last_run != 0.0


@pytest.mark.asyncio
async def test_a_fully_successful_pass_spends_the_hourly_slot(db_session, monkeypatch):
    """T-010: only a pass that runs to completion stamps ``_last_run`` --
    the mirror image of the two tests above, confirming the ordinary
    success path still gates the next call for the full hour."""
    await _project(db_session, quote_id="EST1")
    calls: list[str] = []
    monkeypatch.setattr(zoho_service, "list_project_invoices", _fake({"EST1": [_invoice(10.0)]}, calls))

    updated = await sweep_invoices(db_session, force=True)

    assert updated == 1
    assert aito_invoice_sweep._last_run != 0.0
    assert await sweep_invoices(db_session) == 0
    assert calls == ["EST1"]  # the second, non-forced call never re-asked


@pytest.mark.asyncio
async def test_the_selection_visits_least_recently_checked_projects_first(db_session, monkeypatch):
    """T-026: the SELECT is ordered by ``invoice_checked_at`` ascending with
    nulls first (never-swept projects), id as the tiebreaker -- not left in
    whatever order the database happens to return. Seeded in a scrambled id
    order (recent, never-checked, old) to prove the order comes from the
    ORDER BY and not from insertion/id order."""
    recent = await _project(db_session, quote_id="EST-RECENT", invoice_checked_at=datetime(2026, 3, 1, 0, 0, 0))
    never = await _project(db_session, quote_id="EST-NEVER", invoice_checked_at=None)
    old = await _project(db_session, quote_id="EST-OLD", invoice_checked_at=datetime(2026, 1, 1, 0, 0, 0))
    assert recent.id < never.id < old.id  # scrambled relative to checked-at order
    calls: list[str] = []
    monkeypatch.setattr(
        zoho_service,
        "list_project_invoices",
        _fake(
            {
                "EST-RECENT": [_invoice(10.0)],
                "EST-NEVER": [_invoice(10.0)],
                "EST-OLD": [_invoice(10.0)],
            },
            calls,
        ),
    )

    await sweep_invoices(db_session, force=True)

    assert calls == ["EST-NEVER", "EST-OLD", "EST-RECENT"]


@pytest.mark.asyncio
async def test_a_pass_resumed_after_a_429_starts_with_the_cut_off_tail(db_session, monkeypatch):
    """T-026: after a 429 aborts a pass part-way through, the projects it
    never reached (B, C) have the oldest ``invoice_checked_at`` (null, since
    they were never touched) once the sweep resumes -- so the next pass
    visits them before re-visiting A, which was just refreshed."""
    a = await _project(db_session, quote_id="EST-A")
    b = await _project(db_session, quote_id="EST-B")
    c = await _project(db_session, quote_id="EST-C")
    a_id, b_id, c_id = a.id, b.id, c.id  # captured before expire_all(); see note above
    first_calls: list[str] = []
    monkeypatch.setattr(
        zoho_service,
        "list_project_invoices",
        _fake(
            {
                "EST-A": [_invoice(10.0)],
                "EST-B": ZohoRateLimited("Too many requests", retry_after=5.0),
            },
            first_calls,
        ),
    )

    with pytest.raises(ZohoRateLimited):
        await sweep_invoices(db_session, force=True)

    # First pass: A (lowest id, all nulls tie) refreshed and stamped, B hit
    # the 429 before being stamped, C was never reached.
    assert first_calls == ["EST-A", "EST-B"]
    db_session.expire_all()
    assert (await db_session.get(AitoProject, a_id)).invoice_checked_at is not None
    assert (await db_session.get(AitoProject, b_id)).invoice_checked_at is None
    assert (await db_session.get(AitoProject, c_id)).invoice_checked_at is None

    second_calls: list[str] = []
    monkeypatch.setattr(
        zoho_service,
        "list_project_invoices",
        _fake({"EST-A": [_invoice(10.0)], "EST-B": [_invoice(10.0)], "EST-C": [_invoice(10.0)]}, second_calls),
    )

    await sweep_invoices(db_session, force=True)

    # B and C (both still null, id tiebreak) come before A, which now has
    # the freshest invoice_checked_at of the three.
    assert second_calls == ["EST-B", "EST-C", "EST-A"]


@pytest.fixture
def fresh_wake_event():
    """``_wake`` is a module-level ``asyncio.Event`` that binds to the first
    event loop that awaits it, and every test gets a fresh loop -- mirrors
    the identically-named fixture in test_aito_quote_sync.py, needed here by
    the two tests below that actually drive ``run_sync_loop``."""
    aito_quote_sync._wake = asyncio.Event()
    aito_quote_sync._debounce_deadline = None
    yield
    aito_quote_sync._debounce_deadline = None


@pytest.mark.asyncio
async def test_run_sync_loop_arms_the_shared_throttle_on_a_sweep_side_429(
    db_session, test_engine, fresh_wake_event, monkeypatch
):
    """T-006: a 429 seen only by the sweep (never by sync_project) must still
    arm the same process-local ``_throttled_until`` the quote sync path
    reads, so the next tick's ``run_sync_once`` also backs off instead of
    the sweep alone knowing about the limit."""
    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(aito_quote_sync, "async_session", maker)
    monkeypatch.setattr(aito_quote_sync, "sync_enabled", lambda db: _immediate(True))
    monkeypatch.setattr(aito_quote_sync.zoho_service, "is_configured", lambda db: _immediate(True))
    monkeypatch.setattr(aito_quote_sync, "sync_interval_seconds", lambda db: _immediate(300))
    monkeypatch.setattr(aito_quote_sync, "run_sync_once", lambda db, pending_only=False: _immediate(0))

    async def _raise_once(db):
        raise ZohoRateLimited("Too many requests", retry_after=42.0)

    monkeypatch.setattr(aito_quote_sync, "sweep_invoices", _raise_once)

    before = time.monotonic()
    loop_task = asyncio.create_task(aito_quote_sync.run_sync_loop())
    try:
        await asyncio.sleep(0.05)
        assert aito_quote_sync._throttled_until is not None
        assert before + 40 <= aito_quote_sync._throttled_until <= before + 45
    finally:
        loop_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await loop_task


@pytest.mark.asyncio
async def test_run_sync_loop_skips_the_sweep_while_already_throttled(
    db_session, test_engine, fresh_wake_event, monkeypatch
):
    """T-006: while a previous 429 (either side) has this process inside the
    backoff window, the periodic tick must not call the sweep at all -- not
    even once -- the same way ``run_sync_once`` already refuses to spend a
    Books call of its own during that window."""
    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(aito_quote_sync, "async_session", maker)
    monkeypatch.setattr(aito_quote_sync, "sync_enabled", lambda db: _immediate(True))
    monkeypatch.setattr(aito_quote_sync.zoho_service, "is_configured", lambda db: _immediate(True))
    monkeypatch.setattr(aito_quote_sync, "sync_interval_seconds", lambda db: _immediate(300))
    monkeypatch.setattr(aito_quote_sync, "run_sync_once", lambda db, pending_only=False: _immediate(0))

    sweep_calls: list[None] = []

    async def _tracked_sweep(db):
        sweep_calls.append(None)
        return 0

    monkeypatch.setattr(aito_quote_sync, "sweep_invoices", _tracked_sweep)
    aito_quote_sync._throttled_until = time.monotonic() + 1000

    loop_task = asyncio.create_task(aito_quote_sync.run_sync_loop())
    try:
        await asyncio.sleep(0.05)
        assert sweep_calls == []
    finally:
        loop_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await loop_task


async def _immediate(value):
    """A coroutine that resolves to ``value`` immediately -- used to stand in
    for the module-level async helpers ``run_sync_loop`` awaits, since
    ``monkeypatch.setattr`` needs a plain callable, not the value itself."""
    return value


# --- Quote-linked deposits are applied to the open invoice -----------------
#
# An invoice raised in Books by hand (or before its retainer was paid) owes
# its full total while the customer's deposit sits unused. The sweep is the
# one place that already reads every open invoice, so it spends the deposits
# that belong to THIS quote on it, refreshes the row at once, and leaves any
# advance that is not linked to the quote for the operator.

from sqlalchemy import select  # noqa: E402

from backend.app.models.aito_event import AitoEvent  # noqa: E402


def _estimate(*retainer_ids: str, customer_id: str = "z1") -> dict:
    return {
        "estimate_id": "EST1",
        "customer_id": customer_id,
        "retainerinvoices": [
            {"retainerinvoice_id": rid, "retainerinvoice_number": f"RET-{rid}", "status": "paid", "total": 4000.0}
            for rid in retainer_ids
        ],
    }


def _payment(payment_id: str, retainer_id: str | None, unused: float, amount: float | None = None) -> dict:
    return {
        "payment_id": payment_id,
        "payment_number": "4601",
        "retainerinvoice_id": retainer_id or "",
        "amount": amount if amount is not None else unused,
        "unused_amount": unused,
        "date": "2026-09-17",
    }


class _Books:
    """The Books surface the deposit step touches, all patched at once."""

    def __init__(
        self, monkeypatch, *, invoices, estimate=None, payments=None, fresh=None, apply_error=None, retainers=None
    ):
        self.applied: list[tuple[str, list[dict]]] = []
        self.reread: list[str] = []
        calls: list[str] = []
        monkeypatch.setattr(zoho_service, "list_project_invoices", _fake(invoices, calls))

        async def get_estimate(db, estimate_id):
            if isinstance(estimate, Exception):
                raise estimate
            return estimate or {}

        async def list_customer_payments(db, customer_id):
            return list(payments or [])

        async def list_customer_retainers(db, customer_id):
            # `retainers` stands in for the customer's whole retainer list —
            # the live org carries retainers the estimate never lists (every
            # online payment Heimdall books is one). Absent, the list is
            # derived from the estimate as before.
            if retainers is not None:
                return list(retainers)
            return [
                {"retainerinvoice_id": r["retainerinvoice_id"], "retainerinvoice_number": r["retainerinvoice_number"]}
                for r in (estimate or {}).get("retainerinvoices", [])
                if not isinstance(estimate, Exception)
            ]

        async def apply_invoice_credits(db, invoice_id, invoice_payments):
            self.applied.append((invoice_id, invoice_payments))
            if apply_error is not None:
                raise apply_error

        async def get_invoice(db, invoice_id):
            self.reread.append(invoice_id)
            return fresh or {}

        monkeypatch.setattr(zoho_service, "get_estimate", get_estimate)
        monkeypatch.setattr(zoho_service, "list_customer_payments", list_customer_payments)
        monkeypatch.setattr(zoho_service, "list_customer_retainers", list_customer_retainers)
        monkeypatch.setattr(zoho_service, "apply_invoice_credits", apply_invoice_credits)
        monkeypatch.setattr(zoho_service, "get_invoice", get_invoice)


async def _events(db, project_id: int) -> list[AitoEvent]:
    return list((await db.execute(select(AitoEvent).where(AitoEvent.project_id == project_id))).scalars().all())


@pytest.mark.asyncio
async def test_linked_deposit_is_applied_and_the_row_refreshes_at_once(db_session, monkeypatch):
    p = await _project(db_session, quote_id="EST1", customer_credit_total=0.0)
    p_id = p.id
    books = _Books(
        monkeypatch,
        invoices={"EST1": [_invoice(4000.0, "overdue")]},
        estimate=_estimate("RET1"),
        payments=[_payment("P1", "RET1", 4000.0)],
        fresh=_invoice(0.0, "paid"),
    )

    updated = await sweep_invoices(db_session, force=True)

    assert updated == 1
    assert books.applied == [("INV1", [{"payment_id": "P1", "amount_applied": 4000.0}])]
    assert books.reread == ["INV1"]
    db_session.expire_all()
    row = await db_session.get(AitoProject, p_id)
    assert (row.invoice_status, row.invoice_balance) == ("paid", 0.0)
    assert row.customer_credit_total == 0.0
    events = await _events(db_session, p_id)
    assert [e.kind for e in events] == ["invoice.deposit_applied"]
    assert events[0].actor_class == "system"
    assert events[0].detail == {"retainer_number": "RET-RET1", "invoice_number": "INV-1", "amount": 4000.0}


@pytest.mark.asyncio
async def test_application_is_capped_at_the_balance(db_session, monkeypatch):
    p = await _project(db_session, quote_id="EST1")
    p_id = p.id
    books = _Books(
        monkeypatch,
        invoices={"EST1": [_invoice(1000.0, "partially_paid")]},
        estimate=_estimate("RET1"),
        payments=[_payment("P1", "RET1", 4000.0)],
        fresh=_invoice(0.0, "paid"),
    )

    await sweep_invoices(db_session, force=True)

    assert books.applied == [("INV1", [{"payment_id": "P1", "amount_applied": 1000.0}])]
    db_session.expire_all()
    row = await db_session.get(AitoProject, p_id)
    assert row.invoice_balance == 0.0
    # What the customer still has on account after the sweep spent 1000 of it.
    assert row.customer_credit_total == 3000.0
    assert (await _events(db_session, p_id))[0].detail["amount"] == 1000.0


@pytest.mark.asyncio
async def test_advance_not_linked_to_the_quote_is_left_for_the_operator(db_session, monkeypatch):
    p = await _project(db_session, quote_id="EST1", customer_credit_total=None)
    p_id = p.id
    books = _Books(
        monkeypatch,
        invoices={"EST1": [_invoice(4000.0, "overdue")]},
        estimate=_estimate("RET1"),
        # One retainer from ANOTHER quote, one plain advance with no retainer.
        payments=[_payment("P9", "RET-OTHER", 4000.0), _payment("P8", None, 500.0)],
    )

    await sweep_invoices(db_session, force=True)

    assert books.applied == []
    assert books.reread == []
    db_session.expire_all()
    row = await db_session.get(AitoProject, p_id)
    assert (row.invoice_status, row.invoice_balance) == ("overdue", 4000.0)
    # The credit figure is refreshed anyway: it froze the day the quote was
    # invoiced, since the status reconcile stops reading a locked estimate.
    assert row.customer_credit_total == 4500.0
    assert await _events(db_session, p_id) == []


@pytest.mark.asyncio
async def test_retainer_referencing_the_quote_number_is_applied_without_an_estimate_link(db_session, monkeypatch):
    """Modelled on DEV26-2684 / FA-26-4358 (live, 2026-09-19): Heimdall books
    an online payment as a retainer that references the QUOTE NUMBER but is
    never attached to the estimate, so `retainerinvoices` stays empty and the
    deposit sat unused while the invoice went overdue. The reference number
    is as unambiguous as the estimate link, so the sweep spends it."""
    p = await _project(db_session, quote_id="EST1", quote_number="DEV26-2684", customer_credit_total=4000.0)
    p_id = p.id
    books = _Books(
        monkeypatch,
        invoices={"EST1": [_invoice(4000.0, "overdue")]},
        estimate=_estimate(),  # no retainer listed on the estimate
        payments=[_payment("P1", "RET-HMD", 4000.0)],
        retainers=[
            {
                "retainerinvoice_id": "RET-HMD",
                "retainerinvoice_number": "RET26-00295",
                "reference_number": "dev26-2684 ",
            }
        ],
        fresh=_invoice(0.0, "paid"),
    )

    updated = await sweep_invoices(db_session, force=True)

    assert updated == 1
    assert books.applied == [("INV1", [{"payment_id": "P1", "amount_applied": 4000.0}])]
    db_session.expire_all()
    row = await db_session.get(AitoProject, p_id)
    assert (row.invoice_status, row.invoice_balance) == ("paid", 0.0)
    assert row.customer_credit_total == 0.0
    events = await _events(db_session, p_id)
    assert [e.kind for e in events] == ["invoice.deposit_applied"]
    assert events[0].detail == {"retainer_number": "RET26-00295", "invoice_number": "INV-1", "amount": 4000.0}


@pytest.mark.asyncio
async def test_retainer_referencing_another_quote_is_left_alone(db_session, monkeypatch):
    """The same customer's deposit for a SIBLING job: referenced to a
    different quote number, not listed on this estimate — the operator's
    call, never the sweep's. A plain advance with no retainer behind it and
    no estimate link stays untouched too, whatever its description says."""
    p = await _project(db_session, quote_id="EST1", quote_number="DEV26-2684", customer_credit_total=None)
    p_id = p.id
    books = _Books(
        monkeypatch,
        invoices={"EST1": [_invoice(4000.0, "overdue")]},
        estimate=_estimate(),
        payments=[_payment("P9", "RET-SIB", 4000.0), _payment("P8", None, 500.0)],
        retainers=[
            {"retainerinvoice_id": "RET-SIB", "retainerinvoice_number": "RET26-00290", "reference_number": "DEV26-2601"}
        ],
    )

    await sweep_invoices(db_session, force=True)

    assert books.applied == []
    db_session.expire_all()
    row = await db_session.get(AitoProject, p_id)
    assert (row.invoice_status, row.invoice_balance) == ("overdue", 4000.0)
    assert row.customer_credit_total == 4500.0
    assert await _events(db_session, p_id) == []


@pytest.mark.asyncio
async def test_spent_linked_retainer_is_not_applied_twice(db_session, monkeypatch):
    p = await _project(db_session, quote_id="EST1")
    books = _Books(
        monkeypatch,
        invoices={"EST1": [_invoice(4000.0, "overdue")]},
        estimate=_estimate("RET1"),
        payments=[_payment("P1", "RET1", 0.0, amount=4000.0)],
    )

    await sweep_invoices(db_session, force=True)

    assert books.applied == []
    assert await _events(db_session, p.id) == []


@pytest.mark.asyncio
async def test_failed_application_keeps_the_balance_and_records_nothing(db_session, monkeypatch):
    p = await _project(db_session, quote_id="EST1")
    p_id = p.id
    books = _Books(
        monkeypatch,
        invoices={"EST1": [_invoice(4000.0, "overdue")]},
        estimate=_estimate("RET1"),
        payments=[_payment("P1", "RET1", 4000.0)],
        apply_error=ZohoUpstreamError("Books said no"),
    )

    updated = await sweep_invoices(db_session, force=True)

    assert updated == 1
    assert len(books.applied) == 1
    assert books.reread == []
    db_session.expire_all()
    row = await db_session.get(AitoProject, p_id)
    assert (row.invoice_status, row.invoice_balance) == ("overdue", 4000.0)
    assert row.customer_credit_total == 4000.0
    assert isinstance(row.invoice_checked_at, datetime)
    assert await _events(db_session, p_id) == []


@pytest.mark.asyncio
async def test_deposit_read_failure_still_refreshes_the_invoice(db_session, monkeypatch):
    p = await _project(db_session, quote_id="EST1", customer_credit_total=7.0)
    p_id = p.id
    books = _Books(
        monkeypatch,
        invoices={"EST1": [_invoice(4000.0, "overdue")]},
        estimate=ZohoUpstreamError("boom"),
    )

    updated = await sweep_invoices(db_session, force=True)

    assert updated == 1
    assert books.applied == []
    db_session.expire_all()
    row = await db_session.get(AitoProject, p_id)
    assert (row.invoice_status, row.invoice_balance) == ("overdue", 4000.0)
    assert row.customer_credit_total == 7.0


@pytest.mark.asyncio
async def test_paid_invoice_costs_no_deposit_reads(db_session, monkeypatch):
    await _project(db_session, quote_id="EST1")
    books = _Books(
        monkeypatch,
        invoices={"EST1": [_invoice(0.0, "paid")]},
        estimate=ZohoUpstreamError("must not be read"),
    )
    reads: list[str] = []

    async def get_estimate(db, estimate_id):
        reads.append(estimate_id)
        raise ZohoUpstreamError("must not be read")

    monkeypatch.setattr(zoho_service, "get_estimate", get_estimate)

    await sweep_invoices(db_session, force=True)

    assert reads == []
    assert books.applied == []


@pytest.mark.asyncio
async def test_rate_limit_during_the_deposit_read_propagates(db_session, monkeypatch):
    await _project(db_session, quote_id="EST1")
    _Books(
        monkeypatch,
        invoices={"EST1": [_invoice(4000.0, "overdue")]},
        estimate=ZohoRateLimited("Too many requests", retry_after=5.0),
    )

    with pytest.raises(ZohoRateLimited):
        await sweep_invoices(db_session, force=True)
