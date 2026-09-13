# backend/tests/unit/test_aito_payment_links.py
"""The payment-link reconciler over a fake Heimdall: the transition table,
reservations, polling, budget, failure isolation, throttle."""

from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import select

from backend.app.api.routes.settings import set_setting
from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.models.aito_project import AitoProject
from backend.app.services import aito_payment_links as svc
from backend.app.services.aito_payment_links import (
    Wanted,
    current_link,
    expires_in_days,
    poll_link,
    reconcile_payment_links,
    reconcile_project,
    wanted_link,
)
from backend.app.services.heimdall import (
    HeimdallConflict,
    HeimdallRateLimited,
    HeimdallUpstreamError,
    LinkView,
    heimdall_service,
)
from backend.app.services.zoho import ZohoUpstreamError, zoho_service

TODAY = date(2026, 9, 12)
NOW = datetime(2026, 9, 12, 10, 0, 0)


class FakeHeimdall:
    """In-memory Heimdall: replays idempotency keys, mutable statuses."""

    def __init__(self):
        self.links: dict[str, dict] = {}
        self.by_key: dict[str, str] = {}
        self.calls: list[tuple] = []
        self.fail_with: Exception | None = None
        self._n = 0

    def _view(self, d):
        return LinkView(
            id=d["id"],
            status=d["status"],
            amount=d["amount"],
            currency="XPF",
            reference=d["reference"],
            url=f"https://osb/pay/{d['id']}",
            expires_at=None,
        )

    async def create_link(self, db, *, idempotency_key, reference, amount, expires_in_days):
        self.calls.append(("create", idempotency_key, reference, amount, expires_in_days))
        if self.fail_with:
            raise self.fail_with
        if idempotency_key in self.by_key:
            return self._view(self.links[self.by_key[idempotency_key]])
        self._n += 1
        d = {"id": f"L{self._n}", "status": "pending", "amount": amount, "reference": reference}
        self.links[d["id"]] = d
        self.by_key[idempotency_key] = d["id"]
        return self._view(d)

    async def patch_link(self, db, heimdall_id, *, amount=None, expires_in_days=None):
        self.calls.append(("patch", heimdall_id, amount, expires_in_days))
        if self.fail_with:
            raise self.fail_with
        d = self.links[heimdall_id]
        if d["status"] != "pending":
            raise HeimdallConflict("not pending", "conflict")
        if amount is not None:
            d["amount"] = amount
        return self._view(d)

    async def cancel_link(self, db, heimdall_id):
        self.calls.append(("cancel", heimdall_id))
        if self.fail_with:
            raise self.fail_with
        d = self.links[heimdall_id]
        if d["status"] != "pending":
            raise HeimdallConflict("not pending", "conflict")
        d["status"] = "cancelled"
        return self._view(d)

    async def get_payment(self, db, heimdall_id):
        self.calls.append(("get", heimdall_id))
        if self.fail_with:
            raise self.fail_with
        return self._view(self.links[heimdall_id])

    def set_status(self, heimdall_id, status):
        self.links[heimdall_id]["status"] = status


@pytest.fixture
def fake(monkeypatch):
    f = FakeHeimdall()
    for name in ("create_link", "patch_link", "cancel_link", "get_payment"):
        monkeypatch.setattr(heimdall_service, name, getattr(f, name))

    async def configured(db):
        return True

    monkeypatch.setattr(heimdall_service, "is_configured", configured)
    svc._throttled_until = None
    yield f
    svc._throttled_until = None


@pytest.fixture(autouse=True)
def no_books(monkeypatch):
    async def ok(db, estimate_id, target, current=None):
        return None

    monkeypatch.setattr(zoho_service, "advance_estimate_status", ok)


async def _project(db, **fields) -> AitoProject:
    base = {
        "description": "x",
        "board_column": "devis",
        "position": 0,
        "status": "active",
        "client_id": "z1",
        "quote_id": "EST1",
        "quote_number": "DEV-2026-1234",
        "quote_total": 12500.0,
        "quote_status": "sent",
        "quote_expiry_date": "2026-09-27",
        "quote_sync_state": "idle",
    }
    base.update(fields)
    row = AitoProject(**base)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def _rows(db, project_id):
    return list(
        (
            await db.execute(
                select(AitoPaymentLink).where(AitoPaymentLink.project_id == project_id).order_by(AitoPaymentLink.id)
            )
        ).scalars()
    )


async def _kinds(db, project_id):
    return [
        e.kind
        for e in (
            await db.execute(select(AitoEvent).where(AitoEvent.project_id == project_id).order_by(AitoEvent.id))
        ).scalars()
    ]


# --- pure ---------------------------------------------------------------------


def test_wanted_link_shapes():
    p = AitoProject(
        description="x",
        board_column="devis",
        position=0,
        status="active",
        quote_number="DEV-1",
        quote_total=10000.0,
        quote_status="sent",
        quote_expiry_date="2026-09-20",
    )
    assert wanted_link(p, pct=0, validity_days=15, today=TODAY) == Wanted("DEV-1", 10000, "2026-09-20")
    assert wanted_link(p, pct=30, validity_days=15, today=TODAY) == Wanted("DEV-1", 3000, "2026-09-20")
    p.quote_expiry_date = None
    assert wanted_link(p, pct=0, validity_days=15, today=TODAY) == Wanted("DEV-1", 10000, "2026-09-27")
    for field, value in [
        ("status", "deleted"),
        ("quote_status", "declined"),
        ("quote_status", "expired"),
        ("quote_invoiced", True),
        ("retainer_paid_total", 10000.0),
        ("quote_total", 0.0),
    ]:
        q = AitoProject(
            description="x",
            board_column="devis",
            position=0,
            status="active",
            quote_number="DEV-1",
            quote_total=10000.0,
            quote_status="sent",
            quote_expiry_date="2026-09-20",
        )
        setattr(q, field, value)
        assert wanted_link(q, pct=0, validity_days=15, today=TODAY) is None, field
    # A retainer smaller than the required amount changes nothing.
    p.retainer_paid_total = 2999.0
    assert wanted_link(p, pct=30, validity_days=15, today=TODAY) is not None


def test_expires_in_days_is_at_least_one():
    assert expires_in_days("2026-09-27", TODAY) == 15
    assert expires_in_days("2026-09-12", TODAY) == 1
    assert expires_in_days("2026-09-01", TODAY) == 1


# --- transition table ---------------------------------------------------------


@pytest.mark.asyncio
async def test_create_reserves_then_completes(db_session, fake):
    p = await _project(db_session)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    rows = await _rows(db_session, p.id)
    assert len(rows) == 1
    r = rows[0]
    assert r.idempotency_key == f"aito:{p.id}:1" and r.heimdall_id == "L1" and r.status == "pending"
    assert r.amount == 12500 and r.reference == "DEV-2026-1234" and r.expires_on == "2026-09-27"
    assert r.url == "https://osb/pay/L1" and r.sync_error is None
    assert fake.calls == [("create", f"aito:{p.id}:1", "DEV-2026-1234", 12500, 15)]
    assert await _kinds(db_session, p.id) == ["payment_link.created"]


@pytest.mark.asyncio
async def test_a_reservation_is_retried_with_the_same_key(db_session, fake):
    p = await _project(db_session)
    fake.fail_with = HeimdallUpstreamError("down")
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    (r,) = await _rows(db_session, p.id)
    assert r.heimdall_id is None and r.sync_error and r.sync_failures == 1
    fake.fail_with = None
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW + timedelta(minutes=10))
    (r,) = await _rows(db_session, p.id)
    assert r.heimdall_id == "L1" and r.sync_error is None and r.sync_failures == 0
    assert [c[1] for c in fake.calls if c[0] == "create"] == [f"aito:{p.id}:1", f"aito:{p.id}:1"]


@pytest.mark.asyncio
async def test_pending_and_equal_does_nothing(db_session, fake):
    p = await _project(db_session)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    n = len(fake.calls)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    assert len(fake.calls) == n


@pytest.mark.asyncio
async def test_amount_or_expiry_change_patches(db_session, fake):
    p = await _project(db_session)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    p.quote_total = 13000.0
    p.quote_expiry_date = "2026-09-30"
    await db_session.commit()
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    assert fake.calls[-1] == ("patch", "L1", 13000, 18)
    (r,) = await _rows(db_session, p.id)
    assert r.amount == 13000 and r.expires_on == "2026-09-30"


@pytest.mark.asyncio
async def test_reference_change_replaces(db_session, fake):
    p = await _project(db_session)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    p.quote_number = "DEV-2026-9999"
    await db_session.commit()
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    rows = await _rows(db_session, p.id)
    assert [r.reference for r in rows] == ["DEV-2026-1234", "DEV-2026-9999"]
    assert rows[0].superseded_at is not None and rows[0].status == "cancelled"
    assert rows[1].idempotency_key == f"aito:{p.id}:2" and rows[1].heimdall_id == "L2"
    assert ("cancel", "L1") in fake.calls
    kinds = await _kinds(db_session, p.id)
    assert kinds[-1:] == ["payment_link.replaced"]
    # One event for a renumber, not a cancelled/replaced pair.
    assert "payment_link.cancelled" not in kinds
    ev = (
        await db_session.execute(
            select(AitoEvent).where(AitoEvent.project_id == p.id, AitoEvent.kind == "payment_link.replaced")
        )
    ).scalar_one()
    assert ev.detail["reason"] == "renumbered"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field,value,reason",
    [
        ("quote_status", "declined", "declined"),
        ("quote_status", "expired", "expired"),
        ("quote_invoiced", True, "invoiced"),
        ("retainer_paid_total", 12500.0, "retainer"),
        ("status", "deleted", "trashed"),
    ],
)
async def test_pending_with_nothing_wanted_cancels(db_session, fake, field, value, reason):
    p = await _project(db_session)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    setattr(p, field, value)
    await db_session.commit()
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    (r,) = await _rows(db_session, p.id)
    assert r.status == "cancelled" and fake.calls[-1] == ("cancel", "L1")
    ev = (
        await db_session.execute(
            select(AitoEvent).where(AitoEvent.project_id == p.id, AitoEvent.kind == "payment_link.cancelled")
        )
    ).scalar_one()
    assert ev.detail["reason"] == reason


@pytest.mark.asyncio
async def test_paid_is_never_touched_even_when_the_total_moves(db_session, fake):
    p = await _project(db_session)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    fake.set_status("L1", "paid")
    await poll_link(db_session, (await _rows(db_session, p.id))[0], now=NOW)
    p.quote_total = 20000.0
    await db_session.commit()
    n = len(fake.calls)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    assert len(fake.calls) == n
    (r,) = await _rows(db_session, p.id)
    assert r.status == "paid" and r.amount == 12500 and r.superseded_at is None


@pytest.mark.asyncio
@pytest.mark.parametrize("dead", ["expired", "cancelled", "failed"])
async def test_a_dead_link_on_an_open_quote_is_replaced(db_session, fake, dead):
    p = await _project(db_session)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    fake.set_status("L1", dead)
    await poll_link(db_session, (await _rows(db_session, p.id))[0], now=NOW)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    rows = await _rows(db_session, p.id)
    assert len(rows) == 2 and rows[0].superseded_at is not None and rows[1].status == "pending"
    assert rows[1].idempotency_key == f"aito:{p.id}:2"
    assert (await current_link(db_session, p.id)).id == rows[1].id
    assert "payment_link.replaced" in await _kinds(db_session, p.id)


@pytest.mark.asyncio
async def test_patch_conflict_rereads_instead_of_retrying(db_session, fake):
    p = await _project(db_session)
    pid = p.id
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    fake.set_status("L1", "paid")  # paid at OSB, we don't know yet
    p.quote_total = 13000.0
    await db_session.commit()
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    (r,) = await _rows(db_session, pid)
    assert r.status == "paid" and r.sync_error is None and r.paid_at == NOW
    assert fake.calls[-1] == ("get", "L1")
    # A paid discovered via a PATCH-409 must be credited exactly like one
    # discovered by a poll: the event, and the quote accepted.
    kinds = await _kinds(db_session, pid)
    assert "payment_link.paid" in kinds
    accepted = await db_session.get(AitoProject, pid)
    assert accepted.quote_status == "accepted"


@pytest.mark.asyncio
async def test_cancel_conflict_with_a_paid_link_credits_instead_of_cancelling(db_session, fake):
    p = await _project(db_session)
    pid = p.id
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    fake.set_status("L1", "paid")  # paid at OSB, right as we go to cancel it
    p.quote_invoiced = True  # nothing wanted any more -> reconcile_project tries to cancel
    await db_session.commit()
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    (r,) = await _rows(db_session, pid)
    assert r.status == "paid" and r.paid_at == NOW and r.sync_error is None
    assert fake.calls[-1] == ("get", "L1")
    kinds = await _kinds(db_session, pid)
    assert "payment_link.paid" in kinds
    assert "payment_link.cancelled" not in kinds
    accepted = await db_session.get(AitoProject, pid)
    assert accepted.quote_status == "accepted"


@pytest.mark.asyncio
async def test_a_retried_reservation_replays_the_same_expiry(db_session, fake):
    """A retry days later must send the SAME body under the same
    idempotency key, or Heimdall answers 409 idempotency_conflict forever
    instead of replaying the first response."""
    p = await _project(db_session)
    fake.fail_with = HeimdallUpstreamError("down")
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    fake.fail_with = None
    later = NOW + timedelta(days=2)
    p = await db_session.get(AitoProject, p.id)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=later.date(), now=later)
    creates = [c for c in fake.calls if c[0] == "create"]
    assert len(creates) == 2
    assert creates[0][4] == creates[1][4] == 15


# --- polling ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_poll_paid_stamps_records_and_accepts(db_session, fake):
    p = await _project(db_session)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    fake.set_status("L1", "paid")
    await poll_link(db_session, (await _rows(db_session, p.id))[0], now=NOW)
    (r,) = await _rows(db_session, p.id)
    assert r.status == "paid" and r.paid_at == NOW and r.checked_at == NOW
    await db_session.refresh(p)
    assert p.quote_status == "accepted"
    kinds = await _kinds(db_session, p.id)
    assert "payment_link.paid" in kinds and "quote.accepted" in kinds
    ev = (
        await db_session.execute(
            select(AitoEvent).where(AitoEvent.project_id == p.id, AitoEvent.kind == "quote.accepted")
        )
    ).scalar_one()
    assert ev.actor_class == "system" and ev.detail == {
        "source": "payment_link",
        "amount": 12500,
        "reference": "DEV-2026-1234",
    }


@pytest.mark.asyncio
async def test_poll_failure_is_stored_and_counted(db_session, fake):
    p = await _project(db_session)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    fake.fail_with = HeimdallUpstreamError("boom")
    await poll_link(db_session, (await _rows(db_session, p.id))[0], now=NOW)
    (r,) = await _rows(db_session, p.id)
    assert r.status == "pending" and "boom" in r.sync_error and r.sync_failures == 1 and r.checked_at == NOW


# --- the pass -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_pass_creates_backfills_polls_and_caps_at_forty(db_session, fake):
    await set_setting(db_session, "heimdall_base_url", "http://pos:8081")
    await set_setting(db_session, "heimdall_api_token", "hmd_live.84f32b71ac095ed2.s3cret")
    await db_session.commit()
    ids = [(await _project(db_session, quote_number=f"DEV-{i}")).id for i in range(45)]
    await _project(db_session, quote_number=None)  # no quote: never touched
    await _project(db_session, quote_sync_state="unmanaged")  # never touched
    n = await reconcile_payment_links(db_session, now=NOW, today=TODAY)
    assert n == 45
    assert len([c for c in fake.calls if c[0] == "create"]) == 45
    fake.calls.clear()
    await reconcile_payment_links(db_session, now=NOW + timedelta(minutes=5), today=TODAY)
    gets = [c for c in fake.calls if c[0] == "get"]
    assert len(gets) == svc.MAX_POLLS_PER_TICK == 40
    # Least-recently-checked first: the five rows pass two did not reach
    # (still stamped from pass one) are the first five GETs of pass three.
    rows = [await current_link(db_session, i) for i in ids]
    stale = {r.heimdall_id for r in rows if r.checked_at is None or r.checked_at < NOW + timedelta(minutes=5)}
    assert len(stale) == 5
    fake.calls.clear()
    await reconcile_payment_links(db_session, now=NOW + timedelta(minutes=10), today=TODAY)
    first_five = [c[1] for c in fake.calls if c[0] == "get"][:5]
    assert set(first_five) == stale


@pytest.mark.asyncio
async def test_one_failure_does_not_stop_the_pass(db_session, fake, monkeypatch):
    a = await _project(db_session, quote_number="DEV-A")
    b = await _project(db_session, quote_number="DEV-B")
    real = fake.create_link

    async def flaky(db, **kw):
        if kw["reference"] == "DEV-A":
            raise HeimdallUpstreamError("nope")
        return await real(db, **kw)

    monkeypatch.setattr(heimdall_service, "create_link", flaky)
    await reconcile_payment_links(db_session, now=NOW, today=TODAY)
    assert (await current_link(db_session, a.id)).heimdall_id is None
    assert (await current_link(db_session, b.id)).heimdall_id == "L1"


@pytest.mark.asyncio
async def test_a_dirty_transaction_from_one_project_does_not_break_the_next(db_session, fake, monkeypatch):
    """A failure that leaves a real transaction open on `db` (not just the
    fake's own bookkeeping) rolls back and expires every ORM object the
    session tracks. The pass must still process the next project — it can
    only do that by re-fetching per project rather than holding onto
    objects loaded before the loop started."""
    a = await _project(db_session, quote_number="DEV-A")
    b = await _project(db_session, quote_number="DEV-B")
    aid, bid = a.id, b.id
    real = fake.create_link

    async def dirty_then_fail(db, **kw):
        if kw["reference"] == "DEV-A":
            await db.execute(select(AitoProject.id))  # opens a real transaction
            raise HeimdallUpstreamError("nope")
        return await real(db, **kw)

    monkeypatch.setattr(heimdall_service, "create_link", dirty_then_fail)
    n = await reconcile_payment_links(db_session, now=NOW, today=TODAY)
    assert n == 2
    assert (await current_link(db_session, aid)).heimdall_id is None
    assert (await current_link(db_session, bid)).heimdall_id == "L1"


@pytest.mark.asyncio
async def test_a_books_failure_on_one_paid_row_does_not_break_the_next_poll(db_session, fake, monkeypatch):
    """`push_quote_status` (inside `accept_quote`) swallows its own Zoho
    failure and rolls back, which — like any rollback — expires every ORM
    object the session tracks. The next pending row in the SAME poll batch
    must still get polled, which only holds if the poll loop re-fetches
    each row by id rather than iterating objects loaded before the loop."""
    a = await _project(db_session, quote_number="DEV-A")
    b = await _project(db_session, quote_number="DEV-B")
    aid, bid = a.id, b.id
    await reconcile_payment_links(db_session, now=NOW, today=TODAY)
    a_link = await current_link(db_session, aid)
    fake.set_status(a_link.heimdall_id, "paid")

    async def boom(db, estimate_id, target, current=None):
        raise ZohoUpstreamError("nope")

    monkeypatch.setattr(zoho_service, "advance_estimate_status", boom)
    later = NOW + timedelta(minutes=1)
    await reconcile_payment_links(db_session, now=later, today=TODAY)
    ra = await current_link(db_session, aid)
    rb = await current_link(db_session, bid)
    assert ra.status == "paid" and ra.paid_at == later
    assert "payment_link.paid" in await _kinds(db_session, aid)
    assert rb.checked_at == later  # b was still polled despite a's Books failure


@pytest.mark.asyncio
async def test_rate_limit_arms_a_throttle_that_skips_the_next_pass(db_session, fake, monkeypatch):
    await _project(db_session)
    fake.fail_with = HeimdallRateLimited("slow down", 120.0)
    await reconcile_payment_links(db_session, now=NOW, today=TODAY)
    assert svc._throttled_until is not None
    fake.fail_with = None
    fake.calls.clear()
    assert await reconcile_payment_links(db_session, now=NOW, today=TODAY) == 0
    assert fake.calls == []


@pytest.mark.asyncio
async def test_backoff_skips_a_failing_row_for_a_few_ticks(db_session, fake):
    p = await _project(db_session)
    pid = p.id
    fake.fail_with = HeimdallUpstreamError("down")
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    # A real rollback (a transaction was genuinely open when the failure
    # hit) expires every ORM object the session tracks, `p` included — the
    # production pass loop now re-fetches by id every iteration rather than
    # holding a stale reference across calls (see reconcile_payment_links);
    # mirror that here instead of reusing the same possibly-expired `p`.
    p = await db_session.get(AitoProject, pid)
    # One failure: skipped for one tick (300 s) counted from checked_at.
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW + timedelta(seconds=100))
    (r,) = await _rows(db_session, pid)
    assert r.sync_failures == 1 and r.checked_at == NOW
    p = await db_session.get(AitoProject, pid)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW + timedelta(seconds=400))
    (r,) = await _rows(db_session, pid)
    assert r.sync_failures == 2 and r.checked_at == NOW + timedelta(seconds=400)
    fake.calls.clear()
    p = await db_session.get(AitoProject, pid)
    # Two failures: skipped until 2 * 300 s have passed since the last attempt.
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW + timedelta(seconds=900))
    assert fake.calls == []
    p = await db_session.get(AitoProject, pid)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW + timedelta(seconds=1100))
    assert fake.calls != []


@pytest.mark.asyncio
async def test_not_configured_is_a_silent_no_op(db_session, monkeypatch):
    async def off(db):
        return False

    monkeypatch.setattr(heimdall_service, "is_configured", off)
    await _project(db_session)
    assert await reconcile_payment_links(db_session, now=NOW, today=TODAY) == 0
