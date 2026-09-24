# backend/tests/unit/test_aito_payment_links.py
"""The payment-link reconciler over a fake Heimdall: the transition table,
reservations, polling, budget, failure isolation, throttle."""

from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

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
    HeimdallNotFound,
    HeimdallRateLimited,
    HeimdallUpstreamError,
    LinkView,
    heimdall_service,
)
from backend.app.services.zoho import ZohoUpstreamError, zoho_service

TODAY = date(2026, 9, 12)
NOW = datetime(2026, 9, 12, 10, 0, 0)


_UNSET = object()


class FakeHeimdall:
    """In-memory Heimdall: replays idempotency keys, mutable statuses."""

    def __init__(self):
        self.links: dict[str, dict] = {}
        self.by_key: dict[str, str] = {}
        self.calls: list[tuple] = []
        self.fail_with: Exception | None = None
        self._n = 0
        # T-012: set to `None`/a garbage string to make `_confirm` (below)
        # hand back an absent/malformed `expires_at` on the NEXT create or
        # patch, instead of the auto-computed realistic one.
        self.expires_at_override: object = _UNSET
        # T-011: a Heimdall that answers 2xx to a PATCH but does not actually
        # apply the requested amount/expiry — a clamp, a stale read, or the
        # write simply not sticking. `patch_link` still returns the (now
        # stale) view, exactly like a real 200 would.
        self.stubborn: bool = False

    def _view(self, d):
        return LinkView(
            id=d["id"],
            status=d["status"],
            amount=d["amount"],
            currency="XPF",
            reference=d["reference"],
            url=f"https://osb/pay/{d['id']}",
            expires_at=d.get("expires_at"),
        )

    def _confirm(self, expires_in_days_value):
        """The absolute day Heimdall would confirm for a request carrying
        `expires_in_days_value` — TODAY is this fixture's request-time
        reference throughout the file (every reservation is created with
        `now=NOW`, whose `.date()` is TODAY, and every patch below uses
        `today=TODAY`), so this mirrors a real Heimdall reply without each
        test needing to compute it by hand. `expires_at_override` lets a
        T-012 test force the NEXT create/patch to confirm an absent
        (`None`) or malformed (any unparseable string) expiry instead."""
        if self.expires_at_override is not _UNSET:
            override, self.expires_at_override = self.expires_at_override, _UNSET
            return override
        return f"{(TODAY + timedelta(days=expires_in_days_value)).isoformat()}T23:59:59.999Z"

    async def create_link(self, db, *, idempotency_key, reference, amount, expires_in_days):
        self.calls.append(("create", idempotency_key, reference, amount, expires_in_days))
        if self.fail_with:
            raise self.fail_with
        if idempotency_key in self.by_key:
            return self._view(self.links[self.by_key[idempotency_key]])
        self._n += 1
        d = {
            "id": f"L{self._n}",
            "status": "pending",
            "amount": amount,
            "reference": reference,
            "expires_at": self._confirm(expires_in_days),
        }
        self.links[d["id"]] = d
        self.by_key[idempotency_key] = d["id"]
        return self._view(d)

    def _get(self, heimdall_id):
        """Heimdall's 404 for an id it has never seen (or has since lost)."""
        try:
            return self.links[heimdall_id]
        except KeyError:
            raise HeimdallNotFound(f"Heimdall HTTP 404 not_found: no payment {heimdall_id}") from None

    def forget(self, heimdall_id):
        """The link vanished at Heimdall (deleted there, or a restored backup)."""
        del self.links[heimdall_id]

    async def patch_link(self, db, heimdall_id, *, amount=None, expires_in_days=None):
        self.calls.append(("patch", heimdall_id, amount, expires_in_days))
        if self.fail_with:
            raise self.fail_with
        d = self._get(heimdall_id)
        if d["status"] != "pending":
            raise HeimdallConflict("not pending", "conflict")
        if self.stubborn:
            return self._view(d)  # 2xx, but nothing about `d` actually changed
        if amount is not None:
            d["amount"] = amount
        if expires_in_days is not None:
            d["expires_at"] = self._confirm(expires_in_days)
        return self._view(d)

    async def cancel_link(self, db, heimdall_id):
        self.calls.append(("cancel", heimdall_id))
        if self.fail_with:
            raise self.fail_with
        d = self._get(heimdall_id)
        if d["status"] != "pending":
            raise HeimdallConflict("not pending", "conflict")
        d["status"] = "cancelled"
        return self._view(d)

    async def get_payment(self, db, heimdall_id):
        self.calls.append(("get", heimdall_id))
        if self.fail_with:
            raise self.fail_with
        return self._view(self._get(heimdall_id))

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
    # A retainer smaller than the required amount still leaves a link to ask
    # for — the franc that is still outstanding.
    p.retainer_paid_total = 2999.0
    assert wanted_link(p, pct=30, validity_days=15, today=TODAY) == Wanted("DEV-1", 1, "2026-09-27")


def test_wanted_link_asks_only_for_what_the_paid_retainers_leave_outstanding():
    p = AitoProject(
        description="x",
        board_column="devis",
        position=0,
        status="active",
        quote_number="DEV-1",
        quote_total=1000.0,
        quote_status="sent",
        quote_expiry_date="2026-09-20",
    )
    # Quote 1000, 400 already paid by a retainer invoice: the link is for 600.
    p.retainer_paid_total = 400.0
    assert wanted_link(p, pct=0, validity_days=15, today=TODAY) == Wanted("DEV-1", 600, "2026-09-20")
    # Never a franc short: a fractional retainer rounds the outstanding UP.
    p.retainer_paid_total = 400.4
    assert wanted_link(p, pct=0, validity_days=15, today=TODAY) == Wanted("DEV-1", 600, "2026-09-20")
    # The deposit share is netted the same way: 60% of 1000 is 600, 400 paid -> 200.
    assert wanted_link(p, pct=60, validity_days=15, today=TODAY) == Wanted("DEV-1", 200, "2026-09-20")
    # A retainer covering the deposit share means nothing is outstanding.
    assert wanted_link(p, pct=40, validity_days=15, today=TODAY) is None
    # The whole total paid by retainers: no link at all.
    p.retainer_paid_total = 1000.0
    assert wanted_link(p, pct=0, validity_days=15, today=TODAY) is None


def test_expires_in_days_is_at_least_one():
    assert expires_in_days("2026-09-27", TODAY) == 15
    assert expires_in_days("2026-09-12", TODAY) == 1
    assert expires_in_days("2026-09-01", TODAY) == 1


def _view(expires_at):
    return LinkView(id="L1", status="pending", amount=1, currency="XPF", reference="R", url=None, expires_at=expires_at)


@pytest.mark.parametrize(
    "expires_at, expected",
    [
        # A plain UTC timestamp: take the calendar day verbatim.
        ("2026-10-01T23:59:59.999Z", "2026-10-01"),
        # A non-UTC offset must be converted to UTC before truncating to a
        # day — this is the exact bug the model comment warns against: a
        # link that closes at 23:59:59.999 UTC on the 1st must never read
        # as the 2nd (or the 30th) because the offset was ignored.
        ("2026-10-01T23:59:59.999-10:00", "2026-10-02"),
        ("2026-10-01T00:00:00.000+02:00", "2026-09-30"),
        # A naive (no offset) timestamp is assumed already UTC, not
        # reinterpreted in a local zone.
        ("2026-10-01T23:59:59.999", "2026-10-01"),
    ],
)
def test_confirmed_expiry_takes_the_utc_calendar_day(expires_at, expected):
    assert svc._confirmed_expiry(_view(expires_at), fallback="1999-01-01") == expected


@pytest.mark.parametrize("expires_at", [None, "", "not-a-timestamp", "2026-13-99T00:00:00Z"])
def test_confirmed_expiry_falls_back_when_absent_or_malformed(expires_at):
    """Heimdall's `expires_at` is optional and unvalidated on our side; a
    missing or garbled value must never raise (the column is NOT NULL) —
    the conservative choice is the date we actually asked for."""
    assert svc._confirmed_expiry(_view(expires_at), fallback="2026-09-27") == "2026-09-27"


def test_fields_match_tolerates_a_clamped_expiry():
    """A quote wanting more than 365 days out can never produce a row whose
    `expires_on` equals its raw date (Heimdall's `expires_in_days` caps at
    365) — comparing raw dates would mismatch on every single pass and the
    drift branch would re-PATCH forever. Comparing against what Heimdall
    would confirm TODAY for that request recognises a link already sitting
    at the ceiling as matching."""
    wanted = Wanted("DEV-1", 12500, "2033-01-01")
    at_ceiling = AitoPaymentLink(
        project_id=1,
        idempotency_key="k",
        reference="DEV-1",
        amount=12500,
        expires_on=(TODAY + timedelta(days=365)).isoformat(),
        status="pending",
    )
    assert svc._fields_match(at_ceiling, wanted, TODAY) is True
    one_day_short = AitoPaymentLink(
        project_id=1,
        idempotency_key="k",
        reference="DEV-1",
        amount=12500,
        expires_on=(TODAY + timedelta(days=364)).isoformat(),
        status="pending",
    )
    assert svc._fields_match(one_day_short, wanted, TODAY) is False
    # The ordinary, unclamped case behaves exactly as a raw comparison would.
    matching = Wanted("DEV-1", 12500, "2026-09-27")
    row = AitoPaymentLink(
        project_id=1, idempotency_key="k", reference="DEV-1", amount=12500, expires_on="2026-09-27", status="pending"
    )
    assert svc._fields_match(row, matching, TODAY) is True


def test_fields_match_freezes_the_clamp_ceiling_at_the_last_checked_day():
    """T-011's follow-on: once a row has actually been synced, the ceiling a
    clamped expiry is compared against is frozen at `row.checked_at`'s day,
    not the live `today` — so a link that settled at the ceiling ten days
    ago still reads as matching today, instead of falling ten days behind a
    ceiling that has kept advancing under it."""
    wanted = Wanted("DEV-1", 12500, "2033-01-01")
    checked_on = TODAY - timedelta(days=10)
    row = AitoPaymentLink(
        project_id=1,
        idempotency_key="k",
        reference="DEV-1",
        amount=12500,
        expires_on=(checked_on + timedelta(days=365)).isoformat(),
        status="pending",
        checked_at=datetime.combine(checked_on, datetime.min.time()),
    )
    # Comparing against TODAY's live ceiling would demand TODAY + 365 — ten
    # days later than what the row actually holds — and read as a mismatch.
    assert svc._fields_match(row, wanted, TODAY) is True


def test_link_view_minted_reflects_heimdall_id():
    """T-010 continuation: `minted` is the one field that tells a reservation
    (heimdall_id still NULL) apart from an adopted link — see the follow-ups
    strip's `linkExpiring` rule, which reads it instead of `url`."""
    reservation = AitoPaymentLink(
        project_id=1,
        idempotency_key="aito:1:1",
        reference="DEV-1",
        amount=12500,
        expires_on="2026-09-27",
        status="pending",
    )
    assert svc.link_view(reservation).minted is False

    reservation.heimdall_id = "L1"
    assert svc.link_view(reservation).minted is True


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
@pytest.mark.parametrize(
    "field,value,reason",
    [
        ("quote_status", "declined", "declined"),
        ("quote_invoiced", True, "invoiced"),
        ("status", "deleted", "trashed"),
    ],
)
async def test_a_reservation_for_a_dead_quote_completes_quietly_then_cancels(db_session, fake, field, value, reason):
    """The reservation's POST may already have reached Heimdall before the
    crash that left `heimdall_id` uncommitted. If the quote died in the
    meantime (declined, invoiced, trashed) while the reservation sat there,
    completing it under its ORIGINAL terms must not hand out a live,
    payable link for it — so it is completed quietly (no
    `payment_link.created`) and cancelled in the very same pass instead."""
    p = await _project(db_session)
    fake.fail_with = HeimdallUpstreamError("down")
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    (r,) = await _rows(db_session, p.id)
    assert r.heimdall_id is None  # still a reservation
    fake.fail_with = None
    setattr(p, field, value)
    await db_session.commit()
    later = NOW + timedelta(minutes=10)  # past the reservation's backoff window
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=later)
    (r,) = await _rows(db_session, p.id)
    assert r.status == "cancelled" and r.heimdall_id == "L1"
    assert [c[0] for c in fake.calls if c[0] in ("create", "cancel")][-2:] == ["create", "cancel"]
    kinds = await _kinds(db_session, p.id)
    assert "payment_link.created" not in kinds
    ev = (
        await db_session.execute(
            select(AitoEvent).where(AitoEvent.project_id == p.id, AitoEvent.kind == "payment_link.cancelled")
        )
    ).scalar_one()
    assert ev.detail["reason"] == reason


@pytest.mark.asyncio
async def test_a_reservation_whose_quote_was_renumbered_completes_quietly_then_replaces(db_session, fake):
    p = await _project(db_session)
    fake.fail_with = HeimdallUpstreamError("down")
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    fake.fail_with = None
    p.quote_number = "DEV-2026-9999"
    await db_session.commit()
    later = NOW + timedelta(minutes=10)  # past the reservation's backoff window
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=later)
    rows = await _rows(db_session, p.id)
    assert [r.reference for r in rows] == ["DEV-2026-1234", "DEV-2026-9999"]
    assert rows[0].status == "cancelled" and rows[0].superseded_at is not None
    assert rows[1].heimdall_id == "L2" and rows[1].status == "pending"
    kinds = await _kinds(db_session, p.id)
    assert "payment_link.created" not in kinds
    assert kinds[-1:] == ["payment_link.replaced"]
    ev = (
        await db_session.execute(
            select(AitoEvent).where(AitoEvent.project_id == p.id, AitoEvent.kind == "payment_link.replaced")
        )
    ).scalar_one()
    assert ev.detail["reason"] == "renumbered"


@pytest.mark.asyncio
async def test_a_reservation_whose_amount_moved_completes_quietly_then_replaces(db_session, fake):
    p = await _project(db_session)
    fake.fail_with = HeimdallUpstreamError("down")
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    fake.fail_with = None
    p.quote_total = 20000.0
    await db_session.commit()
    later = NOW + timedelta(minutes=10)  # past the reservation's backoff window
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=later)
    rows = await _rows(db_session, p.id)
    assert rows[0].status == "cancelled" and rows[0].amount == 12500
    assert rows[1].amount == 20000 and rows[1].status == "pending"
    kinds = await _kinds(db_session, p.id)
    assert "payment_link.created" not in kinds
    ev = (
        await db_session.execute(
            select(AitoEvent).where(AitoEvent.project_id == p.id, AitoEvent.kind == "payment_link.replaced")
        )
    ).scalar_one()
    assert ev.detail["reason"] == "repriced"


@pytest.mark.asyncio
async def test_a_stale_reservation_that_turns_out_paid_is_credited_not_replaced(db_session, fake, monkeypatch):
    """The quiet complete can itself discover the client already paid
    between the original POST and this pass's cancel attempt — money must
    win over the replacement, exactly like the already-completed-row case
    (`test_cancel_conflict_with_a_paid_link_credits_instead_of_cancelling`)."""
    p = await _project(db_session)
    pid = p.id
    fake.fail_with = HeimdallUpstreamError("down")
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    fake.fail_with = None
    p.quote_number = "DEV-2026-9999"
    await db_session.commit()

    real_create = fake.create_link

    async def create_then_pay(db, **kw):
        view = await real_create(db, **kw)
        fake.set_status(view.id, "paid")  # paid at OSB right as we complete it
        return view

    monkeypatch.setattr(heimdall_service, "create_link", create_then_pay)
    later = NOW + timedelta(minutes=10)  # past the reservation's backoff window
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=later)
    (r,) = await _rows(db_session, pid)
    assert r.status == "paid" and r.paid_at == later
    kinds = await _kinds(db_session, pid)
    assert "payment_link.paid" in kinds
    assert "payment_link.created" not in kinds and "payment_link.replaced" not in kinds
    accepted = await db_session.get(AitoProject, pid)
    assert accepted.quote_status == "accepted"


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
async def test_create_stores_the_confirmed_expiry_not_the_raw_quote_date(db_session, fake):
    """T-012, auditor's own example: a quote expiring far enough out that
    Heimdall's 1-365 day cap bites (12500 XPF, expiring 2030-01-01 — over
    three years out) must never leave `expires_on` reading a date the link
    will never actually reach."""
    p = await _project(db_session, quote_expiry_date="2030-01-01")
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    assert fake.calls == [("create", f"aito:{p.id}:1", "DEV-2026-1234", 12500, 365)]
    (r,) = await _rows(db_session, p.id)
    assert r.expires_on == (TODAY + timedelta(days=365)).isoformat()
    assert r.expires_on != "2030-01-01"


@pytest.mark.asyncio
async def test_patch_stores_the_confirmed_expiry_not_the_wanted_date(db_session, fake):
    """Same bug, reached through the drift/patch branch (where T-012's
    evidence traced the literal overwrite): once the quote's expiry moves
    beyond Heimdall's ceiling, the row must record what Heimdall actually
    confirmed, not the date we asked for — and a second pass on the same
    day must be stable (no immediate re-PATCH loop)."""
    p = await _project(db_session)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    p.quote_expiry_date = "2033-01-01"
    await db_session.commit()
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    assert fake.calls[-1] == ("patch", "L1", None, 365)
    (r,) = await _rows(db_session, p.id)
    assert r.expires_on == (TODAY + timedelta(days=365)).isoformat()
    assert r.expires_on != "2033-01-01"

    calls_before = len(fake.calls)
    p = await db_session.get(AitoProject, p.id)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    assert len(fake.calls) == calls_before, "already at the confirmed ceiling: no same-day re-patch"


@pytest.mark.asyncio
async def test_permanently_clamped_expiry_settles_instead_of_repatching_daily(db_session, fake):
    """T-011's follow-on to T-012's own comment: the previous fix stopped the
    every-tick re-PATCH for a clamped quote, but the ceiling it compared
    against (`today + 365`) still advances one calendar day per day, so a
    permanently-clamped link kept re-mismatching (and re-PATCHing) about
    once every 24h forever. Freezing the comparison's reference day at
    `row.checked_at` — the day the row was last actually synced — instead of
    the live `today` stops that residual drift without weakening detection
    of a real expiry change."""
    p = await _project(db_session, quote_expiry_date="2033-01-01")
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    (r,) = await _rows(db_session, p.id)
    assert r.expires_on == (TODAY + timedelta(days=365)).isoformat()

    calls_before = len(fake.calls)
    # A day later: the naive `today`-based ceiling would have advanced by a
    # day and mismatched again. It must not, now.
    p = await db_session.get(AitoProject, p.id)
    await reconcile_project(
        db_session, p, pct=0, validity_days=15, today=TODAY + timedelta(days=1), now=NOW + timedelta(days=1)
    )
    assert len(fake.calls) == calls_before, "a permanently-clamped link must not re-patch a day later"

    # A genuine expiry change — now well inside Heimdall's cap — is still
    # caught immediately.
    p = await db_session.get(AitoProject, p.id)
    p.quote_expiry_date = "2026-10-15"
    await db_session.commit()
    await reconcile_project(
        db_session, p, pct=0, validity_days=15, today=TODAY + timedelta(days=1), now=NOW + timedelta(days=1)
    )
    assert len(fake.calls) > calls_before, "a real expiry change must still be detected"
    (r,) = await _rows(db_session, p.id)
    # `fake._confirm` (this fixture) always answers off the module-level
    # TODAY, not the `today` this test advanced by a day — mirror that math
    # rather than assert a date the fixture would never actually produce.
    expected = (TODAY + timedelta(days=expires_in_days("2026-10-15", TODAY + timedelta(days=1)))).isoformat()
    assert r.expires_on == expected
    assert r.expires_on != (TODAY + timedelta(days=365)).isoformat()


@pytest.mark.asyncio
async def test_patch_that_never_converges_backs_off_instead_of_looping_forever(db_session, fake):
    """T-011, the auditor's exact scenario: Heimdall answers 200 to the PATCH
    but the confirmed link still doesn't reflect the requested amount
    (clamped server-side, a stale read, or the write simply not sticking).
    Blindly trusting the 2xx — the old behavior, where `_adopt` unconditionally
    reset `sync_failures`/`sync_error` — re-sent the identical PATCH forever
    with no visible error and no backoff. Four passes, an hour apart, must
    fail four times, each sending the SAME PATCH, with the row showing the
    failure and Heimdall's TRUE (unconverged) amount — never what was asked
    for. A fifth pass shortly after the fourth must be skipped: the backoff
    this failure count now carries actually engages."""
    p = await _project(db_session)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    p.quote_total = 20000.0
    await db_session.commit()
    fake.stubborn = True
    for i in range(4):
        p = await db_session.get(AitoProject, p.id)
        await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW + timedelta(hours=i))
    patch_calls = [c for c in fake.calls if c[0] == "patch"]
    assert patch_calls == [("patch", "L1", 20000, None)] * 4
    (r,) = await _rows(db_session, p.id)
    assert r.amount == 12500, "Heimdall's confirmed truth, never the amount we merely asked for"
    assert r.sync_failures == 4
    assert r.sync_error and "20000" in r.sync_error
    assert "payment_link.updated" not in await _kinds(db_session, p.id)

    # Backoff for 4 failures is min(4, 6) ticks == 20 minutes: a pass 5
    # minutes after the 4th must be skipped, not send a 5th identical PATCH.
    p = await db_session.get(AitoProject, p.id)
    await reconcile_project(
        db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW + timedelta(hours=3, minutes=5)
    )
    assert len([c for c in fake.calls if c[0] == "patch"]) == 4, "still inside its backoff window"


@pytest.mark.asyncio
async def test_patch_that_converges_records_the_change_with_no_error(db_session, fake):
    """The success-path counterpart: a PATCH that Heimdall actually applies
    must both clear any prior sync state AND tell the project's story — the
    matching blind spot the auditor's `04-amount-drift` golden scenario
    exposed (`events: []` even though the amount changed and a client who
    already saw the old figure was never told anything moved)."""
    p = await _project(db_session)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    p.quote_total = 13000.0
    await db_session.commit()
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    (r,) = await _rows(db_session, p.id)
    assert r.amount == 13000 and r.sync_error is None and r.sync_failures == 0
    kinds = await _kinds(db_session, p.id)
    assert kinds[-1] == "payment_link.updated"
    ev = (
        await db_session.execute(
            select(AitoEvent).where(AitoEvent.project_id == p.id, AitoEvent.kind == "payment_link.updated")
        )
    ).scalar_one()
    assert ev.detail == {
        "reference": "DEV-2026-1234",
        "amount": 13000,
        "expires_on": "2026-09-27",
        "previous_amount": 12500,
        "previous_expires_on": "2026-09-27",
        "heimdall_id": "L1",
    }


@pytest.mark.asyncio
async def test_absent_confirmed_expiry_falls_back_to_the_wanted_date_on_patch(db_session, fake):
    p = await _project(db_session)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    p.quote_expiry_date = "2026-09-30"
    await db_session.commit()
    fake.expires_at_override = None  # Heimdall's reply omits `expires_at`
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    (r,) = await _rows(db_session, p.id)
    assert r.expires_on == "2026-09-30"


@pytest.mark.asyncio
async def test_malformed_confirmed_expiry_falls_back_to_the_wanted_date_on_patch(db_session, fake):
    p = await _project(db_session)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    p.quote_expiry_date = "2026-09-30"
    await db_session.commit()
    fake.expires_at_override = "not-a-real-timestamp"
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    (r,) = await _rows(db_session, p.id)
    assert r.expires_on == "2026-09-30" and r.sync_error is None


@pytest.mark.asyncio
async def test_a_paid_retainer_shrinks_the_live_link_to_the_outstanding_amount(db_session, fake):
    p = await _project(db_session)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    (r,) = await _rows(db_session, p.id)
    assert r.amount == 12500
    # Books reports a 5000 retainer paid: the next reconcile patches the link
    # down to the 7500 still outstanding, exactly like a total change does
    # (amount only — the expiry did not move, so it is not re-sent).
    p.retainer_paid_total = 5000.0
    await db_session.commit()
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    assert fake.calls[-1] == ("patch", "L1", 7500, None)
    (r,) = await _rows(db_session, p.id)
    assert r.amount == 7500


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
async def test_force_bypasses_the_backoff(db_session, fake):
    """The panel's Retry is only OFFERED while the row carries a sync_error —
    which is exactly when the row is inside its backoff window. Without the
    bypass the button would be a no-op for the next 5–30 minutes."""
    p = await _project(db_session)
    pid = p.id
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    # A failed row that also has work waiting for it (a moved total), so a
    # bypassed pass has something to call Heimdall about.
    (r,) = await _rows(db_session, pid)
    r.sync_failures = 1
    r.sync_error = "down"
    r.checked_at = NOW
    p = await db_session.get(AitoProject, pid)
    p.quote_total = 13000.0
    await db_session.commit()
    later = NOW + timedelta(seconds=100)

    fake.calls.clear()
    p = await db_session.get(AitoProject, pid)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=later)
    assert fake.calls == []

    p = await db_session.get(AitoProject, pid)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=later, force=True)
    assert fake.calls == [("patch", "L1", 13000, None)]  # amount only; the expiry did not move
    (r,) = await _rows(db_session, pid)
    assert r.amount == 13000 and r.sync_error is None and r.sync_failures == 0


@pytest.mark.asyncio
async def test_a_renumber_that_finds_the_old_link_paid_survives_a_failed_books_push(db_session, fake, monkeypatch):
    """R8's renumber cancels the old link first, and that cancel can come back
    409/paid — the client paid while we were renumbering. The acceptance that
    follows pushes to Books best-effort, and a FAILED push rolls the session
    back, expiring the row. Re-reading `row.status` there raised
    MissingGreenlet, which the handler caught and turned into
    sync_error/sync_failures on a row that had just turned PAID — and a paid
    row is never re-adopted, so that error would have stuck forever."""
    p = await _project(db_session)
    pid = p.id
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    fake.set_status("L1", "paid")  # paid at OSB; our row still says pending

    async def boom(db, estimate_id, target, current=None):
        raise ZohoUpstreamError("Books is down")

    monkeypatch.setattr(zoho_service, "advance_estimate_status", boom)
    p = await db_session.get(AitoProject, pid)
    p.quote_number = "DEV-2026-9999"
    await db_session.commit()
    p = await db_session.get(AitoProject, pid)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)

    rows = await _rows(db_session, pid)
    assert len(rows) == 1, "money wins: the paid link is not superseded by a replacement"
    assert rows[0].status == "paid" and rows[0].superseded_at is None
    assert rows[0].sync_error is None and rows[0].sync_failures == 0
    kinds = await _kinds(db_session, pid)
    assert "payment_link.paid" in kinds
    assert "payment_link.replaced" not in kinds
    assert (await db_session.get(AitoProject, pid)).quote_status == "accepted"


@pytest.mark.asyncio
async def test_not_configured_is_a_silent_no_op(db_session, monkeypatch):
    async def off(db):
        return False

    monkeypatch.setattr(heimdall_service, "is_configured", off)
    await _project(db_session)
    assert await reconcile_payment_links(db_session, now=NOW, today=TODAY) == 0


# --- changes-only (the wake path) --------------------------------------------
W = Wanted("DEV-1", 12500, "2026-09-27")


def _row(**fields) -> AitoPaymentLink:
    base = {
        "project_id": 1,
        "heimdall_id": "L1",
        "reference": "DEV-1",
        "amount": 12500,
        "expires_on": "2026-09-27",
        "status": "pending",
    }
    base.update(fields)
    return AitoPaymentLink(**base)


@pytest.mark.parametrize(
    "row, wanted, expected",
    [
        (None, W, True),  # nothing yet, a link owed
        (None, None, False),  # nothing yet, nothing owed
        (_row(heimdall_id=None), W, True),  # a reservation always completes
        (_row(heimdall_id=None), None, True),
        (_row(), W, False),  # pending and in agreement: the steady state
        (_row(), None, True),  # pending, no longer wanted: cancel
        (_row(amount=9000), W, True),  # total moved: patch
        (_row(expires_on="2026-10-01"), W, True),  # expiry moved: patch
        (_row(reference="DEV-0"), W, True),  # renumbered: replace
        (_row(status="paid"), W, False),  # paid is never touched
        (_row(status="paid", amount=1), None, False),
        (_row(status="expired"), W, True),  # dead but owed: replace
        (_row(status="cancelled"), None, False),  # dead and settled
    ],
)
def test_needs_action_mirrors_the_transition_table(row, wanted, expected):
    assert svc.needs_action(row, wanted, TODAY) is expected


@pytest.mark.asyncio
async def test_changes_only_patches_a_moved_total_and_polls_nothing(db_session, fake):
    """The wake path after a quote push: a project whose total just changed
    gets its link patched right away, one in agreement is left alone, one
    without a link still gets one, and no polling budget is spent."""
    moved = await _project(db_session, quote_number="DEV-1")
    steady = await _project(db_session, quote_number="DEV-2")
    await reconcile_payment_links(db_session, now=NOW, today=TODAY)
    fresh = await _project(db_session, quote_number="DEV-3")
    fake.calls.clear()

    moved.quote_total = 9000.0
    await db_session.commit()
    n = await reconcile_payment_links(db_session, now=NOW, today=TODAY, changes_only=True)

    assert n == 2
    assert [c[0] for c in fake.calls] == ["patch", "create"]
    assert (await current_link(db_session, moved.id)).amount == 9000
    assert (await current_link(db_session, steady.id)).amount == 12500
    assert (await current_link(db_session, fresh.id)).heimdall_id is not None
    assert not [c for c in fake.calls if c[0] == "get"]


@pytest.mark.asyncio
async def test_changes_only_cancels_a_link_the_drain_just_invoiced(db_session, fake):
    p = await _project(db_session)
    await reconcile_payment_links(db_session, now=NOW, today=TODAY)
    fake.calls.clear()
    p.quote_invoiced = True
    await db_session.commit()
    await reconcile_payment_links(db_session, now=NOW, today=TODAY, changes_only=True)
    assert [c[0] for c in fake.calls] == ["cancel"]
    assert (await current_link(db_session, p.id)).status == "cancelled"


# --- lost links (Heimdall answers 404 for an id we hold) ----------------------


async def _details(db, project_id, kind):
    return [
        e.detail
        for e in (
            await db.execute(
                select(AitoEvent)
                .where(AitoEvent.project_id == project_id, AitoEvent.kind == kind)
                .order_by(AitoEvent.id)
            )
        ).scalars()
    ]


@pytest.mark.asyncio
async def test_a_link_lost_at_heimdall_is_replaced_in_the_same_pass(db_session, fake):
    """A pending link Heimdall no longer knows (deleted there, a restored
    backup) must not be retried forever under its old id: the row is marked
    dead and a fresh link is minted in the SAME pass, so the quote never
    sits without a live link. Reached here through the PATCH a moved total
    asks for."""
    p = await _project(db_session)
    await reconcile_payment_links(db_session, now=NOW, today=TODAY)
    fake.forget("L1")
    fake.calls.clear()
    p.quote_total = 9000.0
    await db_session.commit()

    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)

    old, new = await _rows(db_session, p.id)
    assert old.status == "failed" and old.superseded_at is not None and old.heimdall_id == "L1"
    assert old.sync_error and "404" in old.sync_error
    assert old.sync_failures == 0, "a lost link is dead, not backed off"
    assert new.status == "pending" and new.heimdall_id == "L2" and new.amount == 9000
    assert (await current_link(db_session, p.id)).id == new.id
    assert [c[0] for c in fake.calls] == ["patch", "create"]
    assert await _details(db_session, p.id, "payment_link.replaced") == [
        {
            "reference": "DEV-2026-1234",
            "amount": 9000,
            "expires_on": "2026-09-27",
            "heimdall_id": "L2",
            "reason": "lost",
        }
    ]


@pytest.mark.asyncio
async def test_a_lost_link_nobody_wants_anymore_is_marked_dead_and_told(db_session, fake):
    """The cancel a decline asks for meets a 404: nothing to cancel, nothing
    to replace — the row goes dead and the story says why, once."""
    p = await _project(db_session)
    await reconcile_payment_links(db_session, now=NOW, today=TODAY)
    fake.forget("L1")
    fake.calls.clear()
    p.quote_status = "declined"
    await db_session.commit()

    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)

    (row,) = await _rows(db_session, p.id)
    assert row.status == "failed" and row.superseded_at is None
    assert [c[0] for c in fake.calls] == ["cancel"]
    assert await _details(db_session, p.id, "payment_link.cancelled") == [
        {"reference": "DEV-2026-1234", "reason": "lost", "heimdall_id": "L1"}
    ]
    # And the next pass leaves it alone: dead and unwanted is settled.
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    assert [c[0] for c in fake.calls] == ["cancel"]


@pytest.mark.asyncio
async def test_a_lost_link_found_by_the_poll_is_replaced_in_the_same_pass(db_session, fake):
    """Steady state (no drift, so no PATCH) — only the poll can notice the
    404. The same tick then mints the replacement instead of leaving the
    quote linkless until the next one."""
    p = await _project(db_session)
    await reconcile_payment_links(db_session, now=NOW, today=TODAY)
    fake.forget("L1")
    fake.calls.clear()

    await reconcile_payment_links(db_session, now=NOW + timedelta(hours=1), today=TODAY)

    old, new = await _rows(db_session, p.id)
    assert old.status == "failed" and old.superseded_at is not None
    assert new.status == "pending" and new.heimdall_id == "L2"
    assert [c[0] for c in fake.calls] == ["get", "create"]
    assert (await _kinds(db_session, p.id)).count("payment_link.replaced") == 1


# --- one pass at a time -------------------------------------------------------


@pytest.mark.asyncio
async def test_two_passes_at_once_mint_one_link_not_two(test_engine, fake):
    """The panel's Retry and the loop's tick can hit the same quote in the
    same instant. Two passes that both read "no row yet" would both reserve
    and both POST, leaving a stray live link at OSB. Passes are serialised:
    the second waits and finds the first's link already pending."""
    import asyncio

    from sqlalchemy.ext.asyncio import async_sessionmaker

    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as setup:
        p = await _project(setup)
        project_id = p.id

    gate = asyncio.Event()
    inner = fake.create_link

    async def slow_create(db, **kw):
        await gate.wait()
        return await inner(db, **kw)

    heimdall_service.create_link = slow_create  # the fixture restores it

    async with maker() as s1, maker() as s2:
        t1 = asyncio.create_task(reconcile_payment_links(s1, now=NOW, today=TODAY))
        t2 = asyncio.create_task(reconcile_payment_links(s2, now=NOW, today=TODAY))
        await asyncio.sleep(0.05)
        gate.set()
        await asyncio.gather(t1, t2)

    async with maker() as check:
        rows = await _rows(check, project_id)
    assert len(rows) == 1 and rows[0].status == "pending"
    assert [c[0] for c in fake.calls if c[0] == "create"] == ["create"]


# --- document_kind -----------------------------------------------------------


@pytest.mark.asyncio
async def test_current_link_ignores_invoice_links_by_default(db_session):
    project = await _project(db_session)
    db_session.add(
        AitoPaymentLink(
            project_id=project.id,
            idempotency_key=f"aito:{project.id}:1",
            reference="DEV-1",
            amount=100,
            expires_on="2026-12-31",
            document_kind="quote",
            document_number="DEV-1",
        )
    )
    db_session.add(
        AitoPaymentLink(
            project_id=project.id,
            idempotency_key=f"aito:{project.id}:2",
            reference="FA-1",
            amount=50,
            expires_on="2026-12-31",
            document_kind="invoice",
            document_number="FA-1",
        )
    )
    await db_session.commit()
    quote = await svc.current_link(db_session, project.id)
    assert quote is not None and quote.document_kind == "quote"
    invoice = await svc.current_link(db_session, project.id, kind="invoice")
    assert invoice is not None and invoice.reference == "FA-1"
    assert (await svc.current_links(db_session, [project.id]))[project.id].document_kind == "quote"
    assert (await svc.current_links(db_session, [project.id], kind="invoice"))[project.id].reference == "FA-1"


@pytest.mark.asyncio
async def test_paid_invoice_link_records_but_never_accepts_the_quote(db_session, monkeypatch):
    project = await _project(db_session, quote_status="sent")
    row = AitoPaymentLink(
        project_id=project.id,
        idempotency_key=f"aito:{project.id}:1",
        reference="FA-1",
        amount=50,
        expires_on="2026-12-31",
        heimdall_id="h-1",
        status="paid",
        document_kind="invoice",
        document_number="FA-1",
    )
    db_session.add(row)
    await db_session.commit()
    accepted = []

    async def fake_accept(db, project, **kw):
        accepted.append(project.id)
        return True

    monkeypatch.setattr("backend.app.services.aito_quote_status.accept_quote", fake_accept)
    await svc._became_paid(db_session, row, now=datetime(2026, 9, 23))
    assert accepted == []
    events = (await db_session.execute(select(AitoEvent).where(AitoEvent.project_id == project.id))).scalars().all()
    paid = [e for e in events if e.kind == "payment_link.paid"]
    assert len(paid) == 1 and paid[0].detail["document_kind"] == "invoice"
