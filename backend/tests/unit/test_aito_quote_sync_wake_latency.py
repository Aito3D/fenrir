"""How fast a freshly created card gets its Zoho quote.

The card's POST marks it pending and wakes the sync loop; the quote itself is
minted by that loop. Two things used to push the wait from seconds to a whole
poll interval (300s by default):

1. A transient Books failure (ReadTimeout, ConnectError) on the wake drain
   left the card pending with no re-wake — the retry was the next periodic
   tick.
2. A wake landing while the periodic tick was mid-flight was served only after
   every reconcile, invoice poll, contact poll and Heimdall pass of that tick.

Every test here drives ``run_sync_loop``/``run_sync_once`` through the same
seams ``test_aito_quote_sync.py`` uses (fake collaborators for scheduling,
the MockTransport seam + in-memory engine for persistence); the fixtures are
imported from there so the module-level wake event, transport and process
memos get the same per-test reset.
"""

import asyncio
import contextlib
import time

import httpx
import pytest

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.services import aito_push_schedule, aito_quote_sync
from backend.app.services.aito_quote_sync import run_sync_once, sync_project
from backend.app.services.zoho import zoho_service
from backend.tests.unit.test_aito_quote_sync import (  # noqa: F401 — fixtures register by name
    _always,
    _configure_zoho,
    _estimate_body,
    fresh_wake_event,
    no_change_pass_in_loop_tests,
    reset_deferred_reasons,
    reset_requeue_marker,
    reset_zoho_service,
    zoho_handler,
)


@pytest.fixture(autouse=True)
def reset_fast_retry_state():
    """The fast-retry memo is process-local module state like ``_wake``."""
    aito_quote_sync._reset_fast_retry_state()
    yield
    aito_quote_sync._reset_fast_retry_state()


@contextlib.asynccontextmanager
async def _fake_session():
    yield None


def _pending_project(**task_fields) -> tuple[AitoProject, dict]:
    project = AitoProject(
        description="Nouveau",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_sync_state="pending",
    )
    return project, (task_fields or {"scan_cost": 5000})


async def _add_pending(db, **task_fields) -> AitoProject:
    project, fields = _pending_project(**task_fields)
    db.add(project)
    await db.flush()
    db.add(AitoTask(project_id=project.id, position=0, title="Helice", **fields))
    await db.commit()
    return project


async def _add_quoted_idle(db, estimate_id: str) -> AitoProject:
    project = AitoProject(
        description="Quoted",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_id=estimate_id,
        quote_number=f"DEV26-{estimate_id}",
        quote_sync_state="idle",
    )
    db.add(project)
    await db.flush()
    db.add(AitoTask(project_id=project.id, position=0, title="Helice", scan_cost=5000))
    await db.commit()
    return project


def _unreachable_handler(request: httpx.Request) -> httpx.Response:
    if "oauth" in request.url.path:
        return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
    raise httpx.ReadTimeout("slow Books", request=request)


# --------------------------------------------------------------------------
# 1. A transient failure on the wake drain is retried within seconds.
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_transient_failure_on_the_wake_drain_is_retried_within_seconds(monkeypatch):
    """One ReadTimeout on the drain a creation woke must not cost the operator
    the whole poll interval: the loop re-drains on its own after a short
    backoff, with no second ``request_immediate_sync``."""
    drains: list[float] = []
    second_drain = asyncio.Event()

    async def fake_run_sync_once(db, pending_only=False, fast_retry=False, attention_only=False):
        if not pending_only:
            return 0
        drains.append(time.monotonic())
        if len(drains) == 1:
            # What sync_project's ZohoUpstreamError handler does for a
            # pending card whose push failed transiently.
            aito_quote_sync._note_transient_push_failure()
            return 1
        second_drain.set()
        return 1

    monkeypatch.setattr(aito_quote_sync, "async_session", _fake_session)
    monkeypatch.setattr(aito_quote_sync, "run_sync_once", fake_run_sync_once)
    monkeypatch.setattr(aito_quote_sync, "sync_enabled", _always(True))
    monkeypatch.setattr(aito_quote_sync.zoho_service, "is_configured", _always(True))
    monkeypatch.setattr(aito_quote_sync, "sync_interval_seconds", _always(300))
    monkeypatch.setattr(aito_quote_sync, "sweep_invoices", _always(0))
    monkeypatch.setattr(aito_quote_sync, "FAST_RETRY_DELAYS", (0.1, 0.1, 0.1))

    loop_task = asyncio.create_task(aito_quote_sync.run_sync_loop())
    try:
        await asyncio.sleep(0.05)
        woke_at = time.monotonic()
        aito_quote_sync.request_immediate_sync()
        await asyncio.wait_for(second_drain.wait(), timeout=5)
        assert len(drains) == 2
        # Not before the backoff, and nowhere near the interval.
        assert drains[1] - drains[0] >= 0.1
        assert drains[1] - woke_at < 3
    finally:
        loop_task.cancel()
        await asyncio.gather(loop_task, return_exceptions=True)


@pytest.mark.asyncio
async def test_fast_retries_are_bounded_and_re_armed_by_the_next_wake(monkeypatch):
    """A Books outage must not turn into a tight retry loop: after the fixed
    schedule is spent the card waits for the periodic tick like before, and a
    fresh wake (a new card, an edit) gets a fresh schedule."""
    drains: list[float] = []
    drained = asyncio.Condition()

    async def fake_run_sync_once(db, pending_only=False, fast_retry=False, attention_only=False):
        if not pending_only:
            return 0
        drains.append(time.monotonic())
        aito_quote_sync._note_transient_push_failure()
        async with drained:
            drained.notify_all()
        return 1

    monkeypatch.setattr(aito_quote_sync, "async_session", _fake_session)
    monkeypatch.setattr(aito_quote_sync, "run_sync_once", fake_run_sync_once)
    monkeypatch.setattr(aito_quote_sync, "sync_enabled", _always(True))
    monkeypatch.setattr(aito_quote_sync.zoho_service, "is_configured", _always(True))
    monkeypatch.setattr(aito_quote_sync, "sync_interval_seconds", _always(300))
    monkeypatch.setattr(aito_quote_sync, "sweep_invoices", _always(0))
    monkeypatch.setattr(aito_quote_sync, "FAST_RETRY_DELAYS", (0.05, 0.05))

    async def wait_for_drains(n: int) -> None:
        async with drained:
            await asyncio.wait_for(drained.wait_for(lambda: len(drains) >= n), timeout=5)

    loop_task = asyncio.create_task(aito_quote_sync.run_sync_loop())
    try:
        await asyncio.sleep(0.05)
        aito_quote_sync.request_immediate_sync()
        # The wake's own drain plus the two scheduled retries, then silence.
        await wait_for_drains(3)
        await asyncio.sleep(0.4)
        assert len(drains) == 3

        aito_quote_sync.request_immediate_sync()
        await wait_for_drains(6)
        await asyncio.sleep(0.4)
        assert len(drains) == 6
    finally:
        loop_task.cancel()
        await asyncio.gather(loop_task, return_exceptions=True)


@pytest.mark.asyncio
async def test_sync_project_flags_a_transient_push_failure(db_session):
    """The pending (push) branch is what arms the fast retry. A ReadTimeout
    leaves the card pending, as before, and additionally notes the failure
    for the loop."""
    project = await _add_pending(db_session)
    await _configure_zoho(db_session)
    zoho_service.transport = httpx.MockTransport(_unreachable_handler)
    zoho_service.invalidate_token()

    await sync_project(db_session, project)

    assert project.quote_sync_state == "pending"
    assert project.quote_sync_failures == 1
    assert aito_quote_sync._take_transient_push_failure() is True
    # Consumed: the loop reads it once per drain.
    assert aito_quote_sync._take_transient_push_failure() is False


@pytest.mark.asyncio
async def test_a_reconcile_failure_does_not_arm_the_fast_retry(db_session):
    """A quoted, idle card's status read failing costs one tick of freshness
    and nothing more; nobody is waiting on it, so it must not schedule
    extra Books calls."""
    project = await _add_quoted_idle(db_session, "E1")
    await _configure_zoho(db_session)
    zoho_service.transport = httpx.MockTransport(_unreachable_handler)
    zoho_service.invalidate_token()

    await sync_project(db_session, project)

    assert project.quote_sync_failures == 1
    assert aito_quote_sync._take_transient_push_failure() is False


@pytest.mark.asyncio
async def test_a_fast_retry_does_not_spend_the_failure_budget(db_session):
    """SYNC_FAILURE_LIMIT was sized for one attempt per 300s tick (25 minutes
    of outage before the card shows an error). Three extra attempts inside the
    first minute must not eat three of those five slots."""
    project = await _add_pending(db_session)
    await _configure_zoho(db_session)
    zoho_service.transport = httpx.MockTransport(_unreachable_handler)
    zoho_service.invalidate_token()

    await run_sync_once(db_session, pending_only=True)
    await db_session.refresh(project)
    assert project.quote_sync_failures == 1

    await run_sync_once(db_session, pending_only=True, fast_retry=True)
    await db_session.refresh(project)
    assert project.quote_sync_failures == 1
    assert project.quote_sync_state == "pending"
    assert project.quote_sync_error == "Zoho Books unreachable: ReadTimeout"


# --------------------------------------------------------------------------
# 2. A wake during the periodic tick is served between its passes.
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_wake_during_the_ticks_polls_is_served_between_passes(monkeypatch):
    """A card created while the tick is inside its invoice/contact/Heimdall
    passes gets its pending drain at the next pass boundary, not after the
    whole tick."""
    from backend.app.services import aito_contact_poll, aito_invoice_poll, aito_payment_links, aito_terminal_payments

    drains: list[str] = []
    in_sweep = asyncio.Event()
    release_sweep = asyncio.Event()
    at_terminal_poll = asyncio.Event()
    release_end = asyncio.Event()

    async def fake_run_sync_once(db, pending_only=False, fast_retry=False, attention_only=False):
        drains.append("pending" if pending_only else "full")
        return 0

    async def fake_sweep(db):
        drains.append("sweep")
        in_sweep.set()
        await release_sweep.wait()
        return 0

    async def fake_terminal_poll(db):
        drains.append("terminal")
        at_terminal_poll.set()
        await release_end.wait()

    async def noop(db, *args, **kwargs):
        return None

    monkeypatch.setattr(aito_quote_sync, "async_session", _fake_session)
    monkeypatch.setattr(aito_quote_sync, "run_sync_once", fake_run_sync_once)
    monkeypatch.setattr(aito_quote_sync, "sync_enabled", _always(True))
    monkeypatch.setattr(aito_quote_sync.zoho_service, "is_configured", _always(True))
    monkeypatch.setattr(aito_quote_sync, "sync_interval_seconds", _always(300))
    monkeypatch.setattr(aito_quote_sync, "sweep_invoices", fake_sweep)
    monkeypatch.setattr(aito_quote_sync, "purge_tracking_views", noop)
    monkeypatch.setattr(aito_invoice_poll, "poll_invoices", noop)
    monkeypatch.setattr(aito_contact_poll, "poll_contacts", noop)
    monkeypatch.setattr(aito_payment_links, "reconcile_payment_links", noop)
    monkeypatch.setattr(aito_terminal_payments, "poll_open_terminal_payments", fake_terminal_poll)

    loop_task = asyncio.create_task(aito_quote_sync.run_sync_loop())
    try:
        await asyncio.wait_for(in_sweep.wait(), timeout=5)
        aito_quote_sync.request_immediate_sync()
        release_sweep.set()
        await asyncio.wait_for(at_terminal_poll.wait(), timeout=5)
        # The pending drain ran before the tick reached its last pass.
        assert drains == ["full", "sweep", "pending", "terminal"]
        release_end.set()
        # And the wake was consumed: no second, redundant drain after the tick.
        await asyncio.sleep(0.2)
        assert drains == ["full", "sweep", "pending", "terminal"]
    finally:
        release_sweep.set()
        release_end.set()
        loop_task.cancel()
        await asyncio.gather(loop_task, return_exceptions=True)


@pytest.mark.asyncio
async def test_an_edits_window_is_still_honoured_mid_tick(monkeypatch):
    """A creation is served at the next pass boundary; an EDIT keeps its
    card's quiet period, so a burst mid-tick is still absorbed into one drain
    once the card goes quiet rather than split across pass boundaries."""
    from backend.app.services import aito_contact_poll, aito_invoice_poll, aito_payment_links, aito_terminal_payments

    drains: list[str] = []
    in_sweep = asyncio.Event()
    release_sweep = asyncio.Event()
    tick_done = asyncio.Event()

    async def fake_run_sync_once(db, pending_only=False, fast_retry=False, attention_only=False):
        drains.append("pending" if pending_only else "full")
        # What the real drain does with the windows it serves.
        aito_push_schedule.drop_due_except(time.monotonic(), set())
        return 0

    async def fake_sweep(db):
        drains.append("sweep")
        in_sweep.set()
        await release_sweep.wait()
        return 0

    async def fake_terminal_poll(db):
        drains.append("terminal")
        tick_done.set()

    async def noop(db, *args, **kwargs):
        return None

    monkeypatch.setattr(aito_quote_sync, "async_session", _fake_session)
    monkeypatch.setattr(aito_quote_sync, "run_sync_once", fake_run_sync_once)
    monkeypatch.setattr(aito_quote_sync, "sync_enabled", _always(True))
    monkeypatch.setattr(aito_quote_sync.zoho_service, "is_configured", _always(True))
    monkeypatch.setattr(aito_quote_sync, "sync_interval_seconds", _always(300))
    monkeypatch.setattr(aito_push_schedule, "EDIT_QUIET_SECONDS", 0.3)
    monkeypatch.setattr(aito_quote_sync, "sweep_invoices", fake_sweep)
    monkeypatch.setattr(aito_quote_sync, "purge_tracking_views", noop)
    monkeypatch.setattr(aito_invoice_poll, "poll_invoices", noop)
    monkeypatch.setattr(aito_contact_poll, "poll_contacts", noop)
    monkeypatch.setattr(aito_payment_links, "reconcile_payment_links", noop)
    monkeypatch.setattr(aito_terminal_payments, "poll_open_terminal_payments", fake_terminal_poll)

    loop_task = asyncio.create_task(aito_quote_sync.run_sync_loop())
    try:
        await asyncio.wait_for(in_sweep.wait(), timeout=5)
        aito_quote_sync.request_debounced_sync(7)
        release_sweep.set()
        await asyncio.wait_for(tick_done.wait(), timeout=5)
        assert drains == ["full", "sweep", "terminal"]
        for _ in range(100):
            await asyncio.sleep(0.02)
            if len(drains) > 3:
                break
        assert drains == ["full", "sweep", "terminal", "pending"]
    finally:
        release_sweep.set()
        loop_task.cancel()
        await asyncio.gather(loop_task, return_exceptions=True)


@pytest.mark.asyncio
async def test_a_card_created_mid_sweep_gets_its_quote_before_the_remaining_reconciles(db_session, monkeypatch):
    """Inside ``run_sync_once``'s own project loop the wake is checked between
    projects: a creation that lands while quoted cards are being reconciled
    is pushed next, ahead of the cards still queued."""
    a = await _add_quoted_idle(db_session, "EA")
    b = await _add_quoted_idle(db_session, "EB")
    await _configure_zoho(db_session)
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/EA"): {"estimate": {"estimate_id": "EA", "status": "draft", "total": 5000}},
                ("GET", "/estimates/EB"): {"estimate": {"estimate_id": "EB", "status": "draft", "total": 5000}},
                ("GET", "/estimates/EA/comments"): {"comments": []},
                ("GET", "/estimates/EB/comments"): {"comments": []},
                ("GET", "/estimates"): {"estimates": []},
                ("POST", "/estimates"): _estimate_body("EP"),
            }
        )
    )
    zoho_service.invalidate_token()

    order: list[int] = []
    created: dict[str, int] = {}
    original_sync_project = aito_quote_sync.sync_project

    async def tracking_sync_project(db, project, *args, **kwargs):
        order.append(project.id)
        result = await original_sync_project(db, project, *args, **kwargs)
        if len(order) == 1:
            # A creation lands (committed through the worker's own session,
            # which is the only one the in-memory engine can safely take a
            # write from mid-tick) and wakes the loop, exactly as the POST
            # route does after its commit.
            new = await _add_pending(db)
            created["id"] = new.id
            aito_quote_sync.request_immediate_sync()
        return result

    monkeypatch.setattr(aito_quote_sync, "sync_project", tracking_sync_project)

    await run_sync_once(db_session)

    assert order == [a.id, created["id"], b.id]
    fresh = await db_session.get(AitoProject, created["id"])
    await db_session.refresh(fresh)
    assert fresh.quote_id == "EP"
    assert fresh.quote_sync_state == "idle"
    assert not aito_quote_sync._wake.is_set()


@pytest.mark.asyncio
async def test_the_full_sweep_pushes_pending_cards_before_reconciling_the_rest(db_session, monkeypatch):
    """Selected by the same tick, a pending card (someone is waiting on it)
    goes first; reconciles (nobody is) follow, regardless of id order."""
    a = await _add_quoted_idle(db_session, "EA")
    p = await _add_pending(db_session)
    await _configure_zoho(db_session)
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/EA"): {"estimate": {"estimate_id": "EA", "status": "draft", "total": 5000}},
                ("GET", "/estimates/EA/comments"): {"comments": []},
                ("GET", "/estimates"): {"estimates": []},
                ("POST", "/estimates"): _estimate_body("EP"),
            }
        )
    )
    zoho_service.invalidate_token()

    order: list[int] = []
    original_sync_project = aito_quote_sync.sync_project

    async def tracking_sync_project(db, project, *args, **kwargs):
        order.append(project.id)
        return await original_sync_project(db, project, *args, **kwargs)

    monkeypatch.setattr(aito_quote_sync, "sync_project", tracking_sync_project)

    await run_sync_once(db_session)

    assert a.id < p.id
    assert order == [p.id, a.id]


# --------------------------------------------------------------------------
# 3. Books calls reuse one HTTP client (keep-alive) instead of a TLS
#    handshake per call.
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_books_calls_share_one_http_client_per_transport(db_session):
    await _configure_zoho(db_session)
    zoho_service.transport = httpx.MockTransport(zoho_handler({("GET", "/estimates"): {"estimates": []}}))
    zoho_service.invalidate_token()

    first = await zoho_service._http()
    await zoho_service.find_estimate_by_reference(db_session, "AITO-1", "C1")
    await zoho_service.find_estimate_by_reference(db_session, "AITO-2", "C1")
    assert await zoho_service._http() is first
    assert not first.is_closed

    # The test seam still works: a swapped transport gets a fresh client and
    # the old one is closed rather than leaked.
    zoho_service.transport = httpx.MockTransport(zoho_handler({("GET", "/estimates"): {"estimates": []}}))
    second = await zoho_service._http()
    assert second is not first
    assert first.is_closed


@pytest.mark.asyncio
async def test_the_shared_client_is_rebuilt_on_a_new_event_loop():
    """Each test (and a uvicorn restart) gets a fresh loop; a client bound to
    a dead loop must never be handed out."""
    zoho_service.transport = httpx.MockTransport(zoho_handler({}))
    client = await zoho_service._http()
    zoho_service._http_loop = object()  # pretend it was built on another loop
    assert await zoho_service._http() is not client


# --------------------------------------------------------------------------
# 3. A rate-limit hold never delays a push.
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_creation_inside_a_rate_limit_hold_is_drained_at_once(monkeypatch):
    """The hold stops background reads. Until 2026-10-01 it also stopped the
    drain, and nothing re-woke the loop until the window closed: a card
    created inside a hold waited out Books' whole Retry-After (15 minutes at a
    time in production). The loop no longer waits on the hold at all."""
    drains: list[tuple[str, float]] = []

    async def fake_run_sync_once(db, pending_only=False, fast_retry=False, attention_only=False):
        drains.append(("pending" if pending_only else "full", time.monotonic()))
        aito_push_schedule.drop_due_except(time.monotonic(), set())
        return 0

    monkeypatch.setattr(aito_quote_sync, "async_session", _fake_session)
    monkeypatch.setattr(aito_quote_sync, "run_sync_once", fake_run_sync_once)
    monkeypatch.setattr(aito_quote_sync, "sync_enabled", _always(True))
    monkeypatch.setattr(aito_quote_sync.zoho_service, "is_configured", _always(True))
    monkeypatch.setattr(aito_quote_sync, "sync_interval_seconds", _always(300))
    monkeypatch.setattr(aito_quote_sync, "sweep_invoices", _always(0))

    loop_task = asyncio.create_task(aito_quote_sync.run_sync_loop())
    try:
        await asyncio.sleep(0.05)  # the start-up tick
        aito_quote_sync._throttled_until = time.monotonic() + 600
        drains.clear()
        asked_at = time.monotonic()
        aito_quote_sync.request_immediate_sync(7)
        await asyncio.sleep(0.2)
        assert [kind for kind, _ in drains] == ["pending"]
        assert drains[0][1] - asked_at < 0.2
    finally:
        loop_task.cancel()
        await asyncio.gather(loop_task, return_exceptions=True)


# --------------------------------------------------------------------------
# 4. An adopted orphan is finished in the same sync, not the next tick.
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_adopted_orphan_is_brought_into_sync_in_the_same_pass(db_session):
    """A create whose POST reached Books but whose response never came back
    (a ReadTimeout on the shop's side) is found again by reference on the
    retry. Adopting only its identity and leaving the card ``pending`` for
    "the next tick" meant a quote number on the card with the print button
    disabled for up to a poll interval. The same pass now continues into the
    normal update path: full re-read, line push, ``idle``."""
    project = await _add_pending(db_session)
    await _configure_zoho(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates"): {
                    "estimates": [
                        {
                            "estimate_id": "E-ORPHAN",
                            "estimate_number": "DEV26-9011",
                            "reference_number": f"AITO-{project.id}",
                            "customer_id": "C1",
                            "status": "draft",
                            "total": 5000,
                        }
                    ]
                },
                ("GET", "/estimates/E-ORPHAN"): {
                    "estimate": {
                        "estimate_id": "E-ORPHAN",
                        "estimate_number": "DEV26-9011",
                        "status": "draft",
                        "invoiced_amount": 0,
                        "is_inclusive_tax": True,
                        "expiry_date": "2026-08-13",
                        "line_items": [{"line_item_id": "L1", "sku": "P3DSCAN", "item_order": 1}],
                    }
                },
                ("PUT", "/estimates/E-ORPHAN"): {
                    "estimate": {
                        "estimate_id": "E-ORPHAN",
                        "estimate_number": "DEV26-9011",
                        "status": "draft",
                        "total": 5000,
                        "last_modified_time": "2026-09-30T09:00:00-1000",
                        "is_inclusive_tax": True,
                    }
                },
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session, pending_only=True) == 1
    await db_session.refresh(project)
    assert project.quote_id == "E-ORPHAN"
    assert project.quote_number == "DEV26-9011"
    assert project.quote_sync_state == "idle"
    assert project.quote_sync_failures == 0
    methods = [(m, p) for m, p, _ in seen]
    assert not any(m == "POST" for m, _ in methods)
    assert ("GET", "/books/v3/estimates/E-ORPHAN") in methods
    assert ("PUT", "/books/v3/estimates/E-ORPHAN") in methods
