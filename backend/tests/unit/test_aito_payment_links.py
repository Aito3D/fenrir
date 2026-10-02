# backend/tests/unit/test_aito_payment_links.py
"""The payment-link reconciler over a fake Heimdall: the transition table,
reservations, polling, budget, failure isolation, throttle."""

from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.settings import set_setting
from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.models.aito_project import AitoProject
from backend.app.services import aito_payment_links as svc
from backend.app.services.aito_payment_documents import PaymentDocument
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
    HeimdallAmbiguous,
    HeimdallConflict,
    HeimdallInvalid,
    HeimdallNotConfigured,
    HeimdallNotFound,
    HeimdallRateLimited,
    HeimdallUnreachable,
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


def _expired_link(amount: int = 5000) -> AitoPaymentLink:
    return AitoPaymentLink(
        project_id=1,
        idempotency_key="k",
        heimdall_id="h1",
        reference="DEV-1",
        amount=amount,
        expires_on="2026-09-27",
        status="pending",
        checked_at=datetime(2026, 9, 30, 12, 0),
    )


def test_fields_match_accepts_a_link_whose_expiry_date_has_passed():
    """A quote whose validity ran out: the link's expiry equals the quote's
    and both are in the past. The clamped target (`expires_in_days` floors at
    one day) can never equal a past date, so the comparison used to report
    drift on every pass — while the patch builder, which compares the raw
    dates, had nothing to send: an empty PATCH, a 400 "Nothing to update",
    forever (seven production cards, ~290 warnings a day on 2026-10-01).
    Heimdall expires the link by itself; there is nothing to change."""
    today = date(2026, 10, 1)
    wanted = Wanted("DEV-1", 5000, "2026-09-27")
    assert svc._fields_match(_expired_link(), wanted, today) is True
    assert svc.needs_action(_expired_link(), wanted, today) is False


def test_fields_match_still_reports_a_changed_amount_on_such_a_link():
    today = date(2026, 10, 1)
    assert svc._fields_match(_expired_link(), Wanted("DEV-1", 6000, "2026-09-27"), today) is False


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
        id=1,
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
async def test_cancel_conflict_on_a_row_already_paid_returns_true_commits_and_records_no_cancel(db_session, fake):
    """The `was == "paid"` half of the money-wins branch. Unreachable through
    the pass today, so it is driven directly: the row is paid in the ledger,
    Heimdall refuses the cancel, and the cancel must still report money."""
    p = await _project(db_session)
    pid = p.id
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    fake.set_status("L1", "paid")
    (row,) = await _rows(db_session, pid)
    row_id = row.id
    row.status = "paid"
    await db_session.commit()

    assert await svc._cancel(db_session, p, row, now=NOW, reason="operator") is True

    assert fake.calls[-2:] == [("cancel", "L1"), ("get", "L1")]
    db_session.expire_all()
    stored = await db_session.get(AitoPaymentLink, row_id)
    assert stored.status == "paid"
    # Already paid, so the credit was not (re)run and no cancellation was told.
    kinds = await _kinds(db_session, pid)
    assert "payment_link.cancelled" not in kinds
    assert "payment_link.paid" not in kinds


@pytest.mark.asyncio
async def test_a_quote_with_nothing_left_to_pay_cancels_its_link_as_nothing_to_pay(db_session, fake):
    p = await _project(db_session)
    pid = p.id
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    p.quote_total = 0.0
    await db_session.commit()

    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)

    (r,) = await _rows(db_session, pid)
    assert r.status == "cancelled" and fake.calls[-1] == ("cancel", "L1")
    assert await _details(db_session, pid, "payment_link.cancelled") == [
        {"reference": r.reference, "reason": "nothing_to_pay", "heimdall_id": "L1"}
    ]


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


@pytest.mark.asyncio
async def test_a_lost_invoice_link_fails_in_place_instead_of_being_replaced(db_session, fake, monkeypatch):
    """A 404 on an INVOICE-kind link must not take the quote-link
    replace path (`_replace_lost` only knows how to mint a QUOTE link — a
    wrong turn here would mint a quote link off an invoice link's 404).
    The declined quote_status keeps `wanted_link` from wanting a quote link
    of its own, so the only Heimdall traffic in this pass is the poll that
    discovers the 404."""
    p = await _project(db_session, quote_status="declined")
    project_id = p.id
    invoice_row = AitoPaymentLink(
        project_id=project_id,
        idempotency_key=f"aito:{project_id}:1",
        reference="FA-1",
        amount=50,
        expires_on="2026-12-31",
        heimdall_id="ghost-1",  # never registered with `fake` — a bare 404
        status="pending",
        document_kind="invoice",
        document_number="FA-1",
    )
    db_session.add(invoice_row)
    await db_session.commit()
    await db_session.refresh(invoice_row)
    invoice_row_id = invoice_row.id
    accepted = []

    async def fake_accept(db, project, **kw):
        accepted.append(project.id)
        return True

    monkeypatch.setattr("backend.app.services.aito_quote_status.accept_quote", fake_accept)

    # `p` (the AitoProject) is never reloaded by the invoice branch under
    # test (unlike the quote-link path's `_replace_lost`, which re-fetches
    # the project) — a `db.rollback()` inside `_run_pass` therefore leaves
    # it expired, so `project_id` was captured above rather than reading
    # `p.id` again after the pass.
    visited = await reconcile_payment_links(db_session, now=NOW, today=TODAY, only_project_id=project_id, force=True)

    assert visited == 1
    rows = await _rows(db_session, project_id)
    assert len(rows) == 1, "no quote link was minted off the invoice link's 404"
    (row,) = rows
    assert row.id == invoice_row_id and row.document_kind == "invoice"
    assert row.status == "failed" and row.superseded_at is None
    assert row.sync_error and "404" in row.sync_error
    assert [c[0] for c in fake.calls] == ["get"]
    assert accepted == []


@pytest.mark.asyncio
async def test_the_lost_links_own_replacement_failing_is_recorded_not_silently_dropped(db_session, fake, monkeypatch):
    """`_replace_lost` marks the 404'd row dead and reserves a fresh one
    before it ever talks to Heimdall again (see `_create`) — so when THAT
    create call itself fails, there is still a live (unsuperseded) row: the
    reservation. The double-failure handler around `_replace_lost` must
    feed that reservation to `_record_failure` rather than letting the
    project end the pass with no current link and no visible error at all."""
    p = await _project(db_session)
    await reconcile_payment_links(db_session, now=NOW, today=TODAY)
    fake.forget("L1")
    fake.calls.clear()

    async def failing_create(db, **kw):
        raise HeimdallUpstreamError("replacement boom")

    monkeypatch.setattr(heimdall_service, "create_link", failing_create)

    visited = await reconcile_payment_links(db_session, now=NOW + timedelta(hours=1), today=TODAY)

    assert visited == 1
    old, reservation = await _rows(db_session, p.id)
    assert old.status == "failed" and old.superseded_at is not None and old.heimdall_id == "L1"
    assert reservation.heimdall_id is None, "the replacement create never landed at Heimdall"
    assert reservation.document_kind == "quote" and reservation.superseded_at is None
    assert reservation.sync_error and "replacement boom" in reservation.sync_error
    assert reservation.sync_failures == 1
    assert (await current_link(db_session, p.id)).id == reservation.id, "not silently dropped"
    assert (await _kinds(db_session, p.id)).count("payment_link.replaced") == 0


@pytest.mark.asyncio
async def test_a_rate_limit_during_the_lost_links_replacement_stands_the_whole_pass_down(db_session, fake, monkeypatch):
    """A 429 from the replacement's own create must not be swallowed like an
    ordinary Heimdall failure (`except HeimdallRateLimited: raise` ahead of
    the generic branch) — it propagates out of the double-failure handler to
    the pass's outer throttle logic instead of being recorded as a per-row
    sync failure."""
    p = await _project(db_session)
    await reconcile_payment_links(db_session, now=NOW, today=TODAY)
    fake.forget("L1")
    fake.calls.clear()

    async def rate_limited_create(db, **kw):
        raise HeimdallRateLimited("slow down", 120.0)

    monkeypatch.setattr(heimdall_service, "create_link", rate_limited_create)

    visited = await reconcile_payment_links(db_session, now=NOW + timedelta(hours=1), today=TODAY)

    assert visited == 1
    assert svc._throttled_until is not None
    old, reservation = await _rows(db_session, p.id)
    assert old.status == "failed" and old.superseded_at is not None
    assert reservation.heimdall_id is None
    assert reservation.sync_error is None, "the rate-limit path never reaches _record_failure"
    assert reservation.sync_failures == 0


@pytest.mark.asyncio
async def test_reconciles_own_404_replacement_failing_is_recorded_not_silently_dropped(db_session, fake, monkeypatch):
    """T-047: `reconcile_project` has its OWN `except HeimdallNotFound` block
    (create/patch answering 404), structurally identical to the poll's — and
    the double-failure handler around ITS `_replace_lost` call
    (`test_the_lost_links_own_replacement_failing_is_recorded_not_silently_dropped`
    above) was completely unexercised: every existing 404 was raised from
    the fake's `get_payment` (the poll-discovery path), never from
    `create_link`/`patch_link`. This drives the 404 from `patch_link`
    directly, reached through a drifted amount, so the SAME double-failure
    handler runs through the reconcile half instead."""
    p = await _project(db_session)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    fake.calls.clear()

    async def not_found_patch(db, heimdall_id, **kw):
        raise HeimdallNotFound(f"Heimdall HTTP 404 not_found: no payment {heimdall_id}")

    async def failing_create(db, **kw):
        raise HeimdallUpstreamError("replacement boom")

    monkeypatch.setattr(heimdall_service, "patch_link", not_found_patch)
    monkeypatch.setattr(heimdall_service, "create_link", failing_create)

    p.quote_total = 13000.0
    await db_session.commit()
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW + timedelta(hours=1))

    old, reservation = await _rows(db_session, p.id)
    assert old.status == "failed" and old.superseded_at is not None and old.heimdall_id == "L1"
    assert reservation.heimdall_id is None, "the replacement create never landed at Heimdall"
    assert reservation.document_kind == "quote" and reservation.superseded_at is None
    assert reservation.sync_error and "replacement boom" in reservation.sync_error
    assert reservation.sync_failures == 1
    assert (await current_link(db_session, p.id)).id == reservation.id, "not silently dropped"
    assert (await _kinds(db_session, p.id)).count("payment_link.replaced") == 0


@pytest.mark.asyncio
async def test_a_rate_limit_during_the_reconciles_own_replacement_propagates(db_session, fake, monkeypatch):
    """T-047's other half: a 429 from the replacement's own create, reached
    through reconcile_project's OWN 404 (not the poll's), must propagate out
    of `reconcile_project` itself (`except HeimdallRateLimited: raise` ahead
    of the generic branch) instead of being recorded as a per-row sync
    failure — mirroring
    `test_a_rate_limit_during_the_lost_links_replacement_stands_the_whole_pass_down`
    for this other, previously-untested `except HeimdallNotFound` block."""
    p = await _project(db_session)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    fake.calls.clear()

    async def not_found_patch(db, heimdall_id, **kw):
        raise HeimdallNotFound(f"Heimdall HTTP 404 not_found: no payment {heimdall_id}")

    async def rate_limited_create(db, **kw):
        raise HeimdallRateLimited("slow down", 120.0)

    monkeypatch.setattr(heimdall_service, "patch_link", not_found_patch)
    monkeypatch.setattr(heimdall_service, "create_link", rate_limited_create)

    p.quote_total = 13000.0
    await db_session.commit()

    with pytest.raises(HeimdallRateLimited):
        await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW + timedelta(hours=1))

    old, reservation = await _rows(db_session, p.id)
    assert old.status == "failed" and old.superseded_at is not None
    assert reservation.heimdall_id is None
    assert reservation.sync_error is None, "the rate-limit path never reaches _record_failure"
    assert reservation.sync_failures == 0


@pytest.mark.asyncio
async def test_an_unrelated_db_error_polling_one_row_rolls_back_and_still_polls_the_next(db_session, fake, monkeypatch):
    """The whole-iteration `except SQLAlchemyError` wrapping the poll must
    isolate to its own row, exactly like the reconcile half's equivalent
    guard — an unrelated DB error surfacing mid-poll (a dropped connection,
    a locked table) must roll back and move on to the next pending row
    rather than aborting the whole pass and stranding everything after it."""
    a = await _project(db_session, quote_number="DEV-A")
    b = await _project(db_session, quote_number="DEV-B")
    aid, bid = a.id, b.id
    await reconcile_payment_links(db_session, now=NOW, today=TODAY)
    fake.calls.clear()

    real_poll_link = svc.poll_link

    async def flaky_poll_link(db, row, *, now):
        if row.project_id == aid:
            raise SQLAlchemyError("connection dropped")
        return await real_poll_link(db, row, now=now)

    monkeypatch.setattr(svc, "poll_link", flaky_poll_link)

    later = NOW + timedelta(minutes=1)
    visited = await reconcile_payment_links(db_session, now=later, today=TODAY)

    assert visited == 2, "the reconcile half runs before the poll and never sees the failure"
    ra = await current_link(db_session, aid)
    rb = await current_link(db_session, bid)
    assert ra.checked_at == NOW, "a's own poll blew up before it could stamp anything new"
    assert ra.sync_error is None, "the whole-iteration guard just rolls back, it never records a failure"
    assert rb.checked_at == later, "b was still polled despite a's failure"


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


# --- create_invoice_link / cancel_invoice_link ---------------------------------


@pytest.mark.asyncio
async def test_create_invoice_link_reserves_posts_and_records(db_session, fake):
    p = await _project(db_session)
    fake.expires_at_override = "2026-10-08T23:59:59.999Z"
    doc = PaymentDocument(kind="invoice", id="inv-1", number="FA-26-0001", customer_id="c1", balance=23000)
    row = await svc.create_invoice_link(
        db_session,
        p,
        document=doc,
        amount=23000,
        actor_name="paul",
        now=datetime(2026, 9, 23),
        today=date(2026, 9, 23),
        validity_days=15,
    )
    creates = [c for c in fake.calls if c[0] == "create"]
    assert len(creates) == 1
    _, key, reference, amount, days = creates[0]
    assert reference == "FA-26-0001" and amount == 23000 and days == 15
    assert row.document_kind == "invoice" and row.url == "https://osb/pay/L1" and row.expires_on == "2026-10-08"
    kinds = await _kinds(db_session, p.id)
    assert "payment_link.created" in kinds
    ev = (
        await db_session.execute(
            select(AitoEvent).where(AitoEvent.project_id == p.id, AitoEvent.kind == "payment_link.created")
        )
    ).scalar_one()
    assert ev.actor_class == "user" and ev.actor_name == "paul"
    assert ev.detail["document_kind"] == "invoice"
    assert ev.detail["reference"] == "FA-26-0001"
    assert ev.detail["amount"] == 23000
    with pytest.raises(svc.InvoiceLinkExists):
        await svc.create_invoice_link(
            db_session,
            p,
            document=doc,
            amount=23000,
            actor_name=None,
            now=datetime(2026, 9, 23),
            today=date(2026, 9, 23),
            validity_days=15,
        )


@pytest.mark.asyncio
async def test_create_invoice_link_marks_reservation_on_not_configured_and_reraises(db_session, fake):
    p = await _project(db_session)
    doc = PaymentDocument(kind="invoice", id="inv-2", number="FA-26-0002", customer_id="c1", balance=5000)
    fake.fail_with = HeimdallNotConfigured("Heimdall is not configured (see Settings)")
    with pytest.raises(HeimdallNotConfigured):
        await svc.create_invoice_link(
            db_session,
            p,
            document=doc,
            amount=5000,
            actor_name="paul",
            now=datetime(2026, 9, 23),
            today=date(2026, 9, 23),
            validity_days=15,
        )
    (row,) = await _rows(db_session, p.id)
    assert row.heimdall_id is None and row.sync_error is not None and "configured" in row.sync_error.lower()
    assert row.sync_failures == 1


@pytest.mark.asyncio
async def test_create_invoice_link_replays_a_stuck_reservation_under_its_own_key(db_session, fake):
    p = await _project(db_session)
    doc = PaymentDocument(kind="invoice", id="inv-3", number="FA-26-0003", customer_id="c1", balance=7000)
    fake.fail_with = HeimdallUpstreamError("boom")
    with pytest.raises(HeimdallUpstreamError):
        await svc.create_invoice_link(
            db_session,
            p,
            document=doc,
            amount=7000,
            actor_name="paul",
            now=datetime(2026, 9, 23),
            today=date(2026, 9, 23),
            validity_days=15,
        )
    (stuck,) = await _rows(db_session, p.id)
    assert stuck.heimdall_id is None and stuck.sync_error == "boom"
    stuck_key = stuck.idempotency_key
    original_expires_on = stuck.expires_on
    original_created_at = stuck.created_at
    fake.fail_with = None
    fake.calls.clear()
    # A different `amount` on the replay call must be ignored: the
    # reservation replays under its own stored amount, not whatever the
    # caller passes this time.
    row = await svc.create_invoice_link(
        db_session,
        p,
        document=doc,
        amount=8888,
        actor_name="paul",
        now=datetime(2026, 10, 1),
        today=date(2026, 10, 1),
        validity_days=15,
    )
    assert row.id == stuck.id  # replayed the same reservation, not a second one
    rows = await _rows(db_session, p.id)
    assert len(rows) == 1
    creates = [c for c in fake.calls if c[0] == "create"]
    assert len(creates) == 1
    _, key, reference, amount, days = creates[0]
    assert key == stuck_key and reference == "FA-26-0003" and amount == 7000
    # Identical body: expires_in_days is recomputed from the ORIGINAL
    # reservation day, never from the later call's `now`/`today`.
    assert days == svc.expires_in_days(original_expires_on, original_created_at.date())


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["cancelled", "expired", "failed", "paid"])
async def test_create_invoice_link_falls_through_a_dead_link_to_a_new_row(db_session, fake, status):
    p = await _project(db_session)
    old = AitoPaymentLink(
        project_id=p.id,
        idempotency_key=f"aito:{p.id}:1",
        reference="FA-26-0005",
        amount=9000,
        expires_on="2026-12-31",
        heimdall_id="h-old",
        status=status,
        document_kind="invoice",
        document_number="FA-26-0005",
    )
    db_session.add(old)
    await db_session.commit()
    await db_session.refresh(old)
    old_id = old.id
    doc = PaymentDocument(kind="invoice", id="inv-5", number="FA-26-0005", customer_id="c1", balance=9000)
    row = await svc.create_invoice_link(
        db_session,
        p,
        document=doc,
        amount=9000,
        actor_name="paul",
        now=datetime(2026, 9, 23),
        today=date(2026, 9, 23),
        validity_days=15,
    )
    assert row.id != old_id
    assert row.idempotency_key.endswith(":2")
    await db_session.refresh(old)
    assert old.id == old_id and old.status == status and old.heimdall_id == "h-old"
    current = await svc.current_link(db_session, p.id, kind="invoice")
    assert current is not None and current.id == row.id


@pytest.mark.asyncio
async def test_create_invoice_link_replays_a_reservation_with_no_sync_error_yet(db_session, fake):
    """Final review, Important 1: an unminted reservation used to be refused
    `InvoiceLinkExists` until it grew a `sync_error`, so a create killed
    between the reservation commit and Heimdall's answer (client disconnect,
    restart) left the invoice with no link and no way to ask for one. Any
    unminted reservation is now replayed under its OWN key and body — a link
    create is not a charge, and Heimdall's idempotency makes the replay hand
    back the same link rather than minting a second one."""
    p = await _project(db_session)
    row = AitoPaymentLink(
        project_id=p.id,
        idempotency_key="aito:1:1",
        reference="FA-26-0004",
        amount=1000,
        expires_on="2026-12-31",
        status="pending",
        document_kind="invoice",
        document_number="FA-26-0004",
        created_at=NOW,
    )
    db_session.add(row)
    await db_session.commit()
    row_id = row.id
    doc = PaymentDocument(kind="invoice", id="inv-4", number="FA-26-0004", customer_id="c1", balance=1000)
    replayed = await svc.create_invoice_link(
        db_session,
        p,
        document=doc,
        amount=4242,  # ignored: the reservation replays under its own body
        actor_name="paul",
        now=datetime(2026, 9, 23),
        today=date(2026, 9, 23),
        validity_days=15,
    )
    assert replayed.id == row_id and len(await _rows(db_session, p.id)) == 1
    creates = [c for c in fake.calls if c[0] == "create"]
    assert len(creates) == 1 and creates[0][1] == "aito:1:1" and creates[0][3] == 1000


@pytest.mark.asyncio
async def test_the_pass_ages_out_an_abandoned_invoice_reservation_without_calling_heimdall(db_session, fake):
    """The mirror of the terminal sweep's rule: an unminted INVOICE
    reservation older than `ABANDONED_RESERVATION_SECONDS` is written off by
    the pass — no Heimdall call — so the block stops showing a link that is
    never coming and offers to create one again. A younger one is left alone
    for its own create to finish."""
    p = await _project(db_session, quote_sync_state="unmanaged")  # keeps the reconcile half out of the way

    def _reservation(key, created_at):
        return AitoPaymentLink(
            project_id=p.id,
            idempotency_key=key,
            reference="FA-26-0006",
            amount=1000,
            expires_on="2026-12-31",
            status="pending",
            document_kind="invoice",
            document_number="FA-26-0006",
            created_at=created_at,
        )

    old = _reservation("aito:abandoned:1", NOW)
    young = _reservation("aito:fresh:2", NOW + timedelta(minutes=9))
    db_session.add_all([old, young])
    await db_session.commit()
    old_id, young_id = old.id, young.id
    await reconcile_payment_links(db_session, now=NOW + timedelta(minutes=11), today=TODAY)
    assert fake.calls == []
    aged = await db_session.get(AitoPaymentLink, old_id)
    assert aged.status == "failed" and aged.sync_error == "reservation abandoned" and aged.heimdall_id is None
    still = await db_session.get(AitoPaymentLink, young_id)
    assert still.status == "pending" and still.sync_error is None
    cancelled = [
        e
        for e in (await db_session.execute(select(AitoEvent).where(AitoEvent.project_id == p.id))).scalars()
        if e.kind == "payment_link.cancelled"
    ]
    assert len(cancelled) == 1 and cancelled[0].detail["reason"] == "abandoned"
    assert cancelled[0].detail["document_kind"] == "invoice"


@pytest.mark.asyncio
async def test_cancel_invoice_link_refuses_a_quote_link(db_session):
    p = await _project(db_session)
    row = AitoPaymentLink(
        project_id=p.id,
        idempotency_key="k",
        reference="DEV-1",
        amount=1,
        expires_on="2026-12-31",
        heimdall_id="h",
        status="pending",
        document_kind="quote",
        document_number="DEV-1",
    )
    db_session.add(row)
    await db_session.commit()
    with pytest.raises(svc.QuoteLinkManaged):
        await svc.cancel_invoice_link(db_session, p, row, actor_name=None, now=datetime(2026, 9, 23))


@pytest.mark.asyncio
async def test_cancel_invoice_link_records_the_user_actor(db_session, fake):
    p = await _project(db_session)
    row = AitoPaymentLink(
        project_id=p.id,
        idempotency_key="k",
        reference="FA-1",
        amount=1,
        expires_on="2026-12-31",
        heimdall_id="h",
        status="pending",
        document_kind="invoice",
        document_number="FA-1",
    )
    db_session.add(row)
    await db_session.commit()
    fake.links["h"] = {"id": "h", "status": "pending", "amount": 1, "reference": "FA-1", "expires_at": None}
    paid = await svc.cancel_invoice_link(db_session, p, row, actor_name="paul", now=datetime(2026, 9, 23))
    assert paid is False and row.status == "cancelled"
    ev = (await db_session.execute(select(AitoEvent).where(AitoEvent.project_id == p.id))).scalars().all()
    cancelled = [e for e in ev if e.kind == "payment_link.cancelled"]
    assert len(cancelled) == 1 and cancelled[0].actor_class == "user" and cancelled[0].actor_name == "paul"


# --- one reservation at a time (T-029) ----------------------------------------

_INVOICE_DOC = PaymentDocument(kind="invoice", id="inv-9", number="FA-26-0009", customer_id="c1", balance=23000)


def _sessions(test_engine):
    from sqlalchemy.ext.asyncio import async_sessionmaker

    return async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)


@pytest.fixture
async def file_engine(test_engine, tmp_path):
    """A WAL file database, for tests whose sessions run CONCURRENTLY.
    `test_engine` is `:memory:` behind a StaticPool, so every session shares
    one sqlite3 connection, and one session's commit while another has a
    statement open fails with "cannot commit transaction - SQL statements in
    progress" (SQLite 3.46 on the CI runners; 3.53 on macOS lets it through).
    Production gives each session its own connection to a WAL file, as this
    does. Depends on `test_engine` only for its model registration."""
    from sqlalchemy import event
    from sqlalchemy.ext.asyncio import create_async_engine

    from backend.app.core.database import Base

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'race.db'}")

    @event.listens_for(engine.sync_engine, "connect")
    def _pragmas(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode = WAL")
        cursor.execute("PRAGMA busy_timeout = 15000")
        cursor.close()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest.fixture
def own_reserve_lock(monkeypatch):
    """`svc._reserve_lock` is a module global, and an `asyncio.Lock` binds
    itself to the running loop the first acquire that actually CONTENDS — so a
    contention test hands the module a lock of its own rather than leaving the
    shared one bound to a loop that is about to close."""
    import asyncio

    monkeypatch.setattr(svc, "_reserve_lock", asyncio.Lock())


def _slow_key(monkeypatch, delay: float = 0.02) -> None:
    """Widen the read-then-insert window `_next_key` opens (count rows, then
    insert, with awaits in between) so a second, unserialised reservation is
    certain to land inside it."""
    import asyncio

    real = svc._next_key

    async def slow(db, project_id):
        key = await real(db, project_id)
        await asyncio.sleep(delay)
        return key

    monkeypatch.setattr(svc, "_next_key", slow)


def _steal_the_key(monkeypatch, maker, *, status: str) -> None:
    """Another PROCESS claims `aito:{pid}:{n}` between our count and our
    commit — the one race an in-process lock cannot cover. A second session
    inserting that exact key from inside `_next_key` is that process."""
    real = svc._next_key

    async def steal(db, project_id):
        key = await real(db, project_id)
        async with maker() as other:
            other.add(
                AitoPaymentLink(
                    project_id=project_id,
                    idempotency_key=key,
                    reference="FA-26-0009",
                    amount=23000,
                    expires_on="2026-12-31",
                    created_at=NOW,
                    status=status,
                    document_kind="invoice",
                    document_number="FA-26-0009",
                )
            )
            await other.commit()
        return key

    monkeypatch.setattr(svc, "_next_key", steal)


@pytest.mark.asyncio
async def test_two_concurrent_invoice_link_creates_reserve_exactly_one_row(
    file_engine, fake, own_reserve_lock, monkeypatch
):
    """Two Create-link clicks on one card (two tabs, or two operators). Both
    used to count the same rows, compute the same `aito:{pid}:1` and the
    loser's commit died on the unique column — an unhandled IntegrityError,
    i.e. a 500 on the button. The reservation window is serialised now, so the
    second click finds the first's reservation and either replays it under its
    own key or is refused: one row, one key, one link at Heimdall, no 500."""
    import asyncio

    maker = _sessions(file_engine)
    async with maker() as setup:
        project_id = (await _project(setup)).id
    _slow_key(monkeypatch)

    async def click():
        async with maker() as db:
            project = await db.get(AitoProject, project_id)
            return await svc.create_invoice_link(
                db,
                project,
                document=_INVOICE_DOC,
                amount=23000,
                actor_name="paul",
                now=NOW,
                today=TODAY,
                validity_days=15,
            )

    outcomes = await asyncio.gather(click(), click(), return_exceptions=True)
    for outcome in outcomes:
        assert not isinstance(outcome, BaseException) or isinstance(outcome, svc.InvoiceLinkExists), repr(outcome)
    async with maker() as check:
        rows = await _rows(check, project_id)
    assert len(rows) == 1
    assert rows[0].idempotency_key == f"aito:{project_id}:1"
    assert rows[0].heimdall_id is not None  # minted, not left standing as a reservation
    assert len(fake.links) == 1  # the second POST replayed the key, it never minted a second link


@pytest.mark.asyncio
async def test_an_operator_create_racing_the_reconcilers_reserve_gets_a_distinct_key(
    file_engine, fake, own_reserve_lock, monkeypatch
):
    """The reconciler's `_create` and the invoice route draw from the SAME
    per-project key counter, and the HTTP path never takes `_pass_lock`: both
    used to reserve `aito:{pid}:1` and one of the two commits died on the
    unique column. `_reserve_lock` is shared by both paths — nested inside
    `_pass_lock` on the reconciler's side, which must not deadlock — so the
    two reservations take `:1` and `:2` in whichever order they arrive."""
    import asyncio

    maker = _sessions(file_engine)
    async with maker() as setup:
        project_id = (await _project(setup)).id
    _slow_key(monkeypatch)

    async def operator():
        async with maker() as db:
            project = await db.get(AitoProject, project_id)
            await svc.create_invoice_link(
                db,
                project,
                document=_INVOICE_DOC,
                amount=23000,
                actor_name="paul",
                now=NOW,
                today=TODAY,
                validity_days=15,
            )

    async def reconciler():
        async with maker() as db:
            project = await db.get(AitoProject, project_id)
            wanted = Wanted(reference="DEV-2026-1234", amount=12500, expires_on="2026-09-27")
            async with svc._pass_lock:  # where a real pass holds it
                await svc._create(db, project, wanted, now=NOW, kind="payment_link.created")

    await asyncio.gather(operator(), reconciler())
    async with maker() as check:
        rows = await _rows(check, project_id)
    assert {r.idempotency_key for r in rows} == {f"aito:{project_id}:1", f"aito:{project_id}:2"}
    assert {r.document_kind for r in rows} == {"invoice", "quote"}
    assert all(r.heimdall_id is not None for r in rows), "both reservations were minted, neither commit collided"


@pytest.mark.asyncio
async def test_a_key_collision_from_another_process_is_refused_as_link_exists(
    db_session, test_engine, fake, monkeypatch
):
    """A lock only reaches this process. When the unique key is taken anyway
    between the count and the commit, the loser rolls back, re-reads and
    answers with the refusal the operator already knows (`InvoiceLinkExists`
    → the route's 409 `link_exists`) instead of an IntegrityError escaping as
    a 500. Nothing is minted, and the session still works afterwards."""
    project_id = (await _project(db_session)).id  # read before the rollback expires the row
    project = await db_session.get(AitoProject, project_id)
    _steal_the_key(monkeypatch, _sessions(test_engine), status="pending")
    with pytest.raises(svc.InvoiceLinkExists):
        await svc.create_invoice_link(
            db_session,
            project,
            document=_INVOICE_DOC,
            amount=23000,
            actor_name="paul",
            now=NOW,
            today=TODAY,
            validity_days=15,
        )
    assert [c for c in fake.calls if c[0] == "create"] == []
    rows = await _rows(db_session, project_id)  # the session survived the rollback
    assert len(rows) == 1 and rows[0].idempotency_key == f"aito:{project_id}:1"


@pytest.mark.asyncio
async def test_a_key_collision_with_no_open_link_left_still_surfaces_the_database_error(
    db_session, test_engine, fake, monkeypatch
):
    """The corner the 409 cannot describe: the key was taken, but the row that
    took it is not an open link (here: already cancelled), so there is no
    "already open" to report. The IntegrityError surfaces rather than being
    swallowed into a misleading refusal — after a rollback that leaves the
    session usable."""
    from sqlalchemy.exc import IntegrityError

    project_id = (await _project(db_session)).id
    project = await db_session.get(AitoProject, project_id)
    _steal_the_key(monkeypatch, _sessions(test_engine), status="cancelled")
    with pytest.raises(IntegrityError):
        await svc.create_invoice_link(
            db_session,
            project,
            document=_INVOICE_DOC,
            amount=23000,
            actor_name="paul",
            now=NOW,
            today=TODAY,
            validity_days=15,
        )
    assert [c for c in fake.calls if c[0] == "create"] == []
    rows = await _rows(db_session, project_id)
    assert len(rows) == 1 and rows[0].status == "cancelled"


# --- T-056: a malformed Heimdall token ------------------------------------------

_BAD_TOKEN_ERROR = "Heimdall token is not an hmd_live.<id>.<secret> credential"


@pytest.mark.asyncio
async def test_a_malformed_token_is_recorded_on_every_project_instead_of_aborting_the_pass(db_session, monkeypatch):
    """T-056: `is_configured` only checks the token is non-empty, but every
    real call runs `parse_credential`, which raises `HeimdallNotConfigured`
    — NOT a `HeimdallUpstreamError` subclass. Against the REAL service (no
    fake), a token in the retired shape must land on each project's
    reservation as a sync_error, and the pass must keep going past the first
    project instead of dying there with a traceback."""
    monkeypatch.setattr(svc, "_throttled_until", None)
    await set_setting(db_session, "heimdall_base_url", "http://pos:8081")
    await set_setting(db_session, "heimdall_api_token", "legacy-token-without-dots")
    await db_session.commit()
    ids = [(await _project(db_session, quote_number=q)).id for q in ("DEV-A", "DEV-B")]

    visited = await reconcile_payment_links(db_session, now=NOW, today=TODAY)

    assert visited == 2
    for pid in ids:
        (row,) = await _rows(db_session, pid)
        assert row.heimdall_id is None, "the create never reached Heimdall"
        assert row.sync_error == _BAD_TOKEN_ERROR
        assert row.sync_failures == 1 and row.checked_at == NOW


@pytest.mark.asyncio
async def test_a_not_configured_poll_is_recorded_and_the_poll_half_still_runs(db_session, fake):
    """T-056: with the reconcile half failing on one project, the poll half
    still runs, and a pending link's GET failing `HeimdallNotConfigured` is
    stored on that row like any other Heimdall failure."""
    polled = await _project(db_session, quote_number="DEV-P")
    await reconcile_payment_links(db_session, now=NOW, today=TODAY)
    fresh = await _project(db_session, quote_number="DEV-F")
    fake.calls.clear()
    fake.fail_with = HeimdallNotConfigured(_BAD_TOKEN_ERROR)
    later = NOW + timedelta(hours=1)

    visited = await reconcile_payment_links(db_session, now=later, today=TODAY)

    assert visited == 2
    assert [c[0] for c in fake.calls] == ["create", "get"], "the poll half ran after the reconcile failure"
    (reservation,) = await _rows(db_session, fresh.id)
    assert reservation.heimdall_id is None and reservation.sync_error == _BAD_TOKEN_ERROR
    (minted,) = await _rows(db_session, polled.id)
    assert minted.status == "pending" and minted.heimdall_id == "L1"
    assert minted.sync_error == _BAD_TOKEN_ERROR and minted.sync_failures == 1 and minted.checked_at == later


@pytest.mark.asyncio
async def test_poll_link_stores_not_configured_on_the_row(db_session, fake):
    p = await _project(db_session)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    fake.fail_with = HeimdallNotConfigured(_BAD_TOKEN_ERROR)
    await poll_link(db_session, (await _rows(db_session, p.id))[0], now=NOW)
    (r,) = await _rows(db_session, p.id)
    assert r.status == "pending" and r.sync_error == _BAD_TOKEN_ERROR and r.sync_failures == 1


@pytest.mark.asyncio
async def test_a_not_configured_replacement_after_the_polls_404_is_recorded(db_session, fake, monkeypatch):
    """T-056: the poll half's `_replace_lost` handler treats
    `HeimdallNotConfigured` from the replacement's create like any other
    Heimdall failure — recorded on the fresh reservation."""
    p = await _project(db_session)
    await reconcile_payment_links(db_session, now=NOW, today=TODAY)
    fake.forget("L1")

    async def not_configured_create(db, **kw):
        raise HeimdallNotConfigured(_BAD_TOKEN_ERROR)

    monkeypatch.setattr(heimdall_service, "create_link", not_configured_create)

    visited = await reconcile_payment_links(db_session, now=NOW + timedelta(hours=1), today=TODAY)

    assert visited == 1
    old, reservation = await _rows(db_session, p.id)
    assert old.status == "failed" and old.superseded_at is not None
    assert reservation.heimdall_id is None and reservation.sync_error == _BAD_TOKEN_ERROR
    assert reservation.sync_failures == 1


@pytest.mark.asyncio
async def test_a_not_configured_replacement_after_reconciles_own_404_is_recorded(db_session, fake, monkeypatch):
    """T-056: the same, through `reconcile_project`'s OWN 404 handler (a
    PATCH answering 404 on a drifted amount)."""
    p = await _project(db_session)
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)

    async def not_found_patch(db, heimdall_id, **kw):
        raise HeimdallNotFound(f"Heimdall HTTP 404 not_found: no payment {heimdall_id}")

    async def not_configured_create(db, **kw):
        raise HeimdallNotConfigured(_BAD_TOKEN_ERROR)

    monkeypatch.setattr(heimdall_service, "patch_link", not_found_patch)
    monkeypatch.setattr(heimdall_service, "create_link", not_configured_create)
    p.quote_total = 13000.0
    await db_session.commit()

    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW + timedelta(hours=1))

    old, reservation = await _rows(db_session, p.id)
    assert old.status == "failed" and old.superseded_at is not None
    assert reservation.heimdall_id is None and reservation.sync_error == _BAD_TOKEN_ERROR
    assert reservation.sync_failures == 1


# --- a hung Heimdall stops the pass (T-057) -----------------------------------


async def _three_pending_links(db, fake):
    """Three quoted projects, each with a live pending link minted by a
    clean pass; the fake's call log is cleared afterwards."""
    ids = [(await _project(db, quote_number=f"DEV-{n}")).id for n in "ABC"]
    await reconcile_payment_links(db, now=NOW, today=TODAY)
    fake.calls.clear()
    return ids


def _get_failing_for(fake, monkeypatch, failing_id, exc):
    """`get_payment` raises `exc` for `failing_id` only; every GET is logged."""
    real = fake.get_payment

    async def get_payment(db, heimdall_id):
        if heimdall_id == failing_id:
            fake.calls.append(("get", heimdall_id))
            raise exc
        return await real(db, heimdall_id)

    monkeypatch.setattr(heimdall_service, "get_payment", get_payment)


@pytest.mark.asyncio
async def test_an_unreachable_poll_stops_the_pass_after_the_first_link(db_session, fake, monkeypatch):
    """A hung Heimdall costs the full client timeout per call: after the
    first `HeimdallUnreachable` the pass makes no further call. The row that
    hit it is stamped as before; the other two are left for the next tick,
    untouched (no sync_error of their own)."""
    ids = await _three_pending_links(db_session, fake)
    _get_failing_for(fake, monkeypatch, "L1", HeimdallUnreachable("Heimdall unreachable: timed out"))
    later = NOW + timedelta(minutes=1)
    await reconcile_payment_links(db_session, now=later, today=TODAY)
    assert fake.calls == [("get", "L1")]
    first, second, third = [await current_link(db_session, pid) for pid in ids]
    assert first.sync_error == "Heimdall unreachable: timed out" and first.checked_at == later
    for untouched in (second, third):
        assert untouched.sync_error is None and untouched.checked_at == NOW and untouched.sync_failures == 0
    # Only this pass stood down: no throttle window, the next tick polls all three.
    assert svc._throttled_until is None
    monkeypatch.setattr(heimdall_service, "get_payment", fake.get_payment)
    fake.calls.clear()
    await reconcile_payment_links(db_session, now=later + timedelta(minutes=1), today=TODAY)
    assert sorted(c[1] for c in fake.calls if c[0] == "get") == ["L2", "L3"]  # L1 is in its backoff


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "exc",
    [
        HeimdallUpstreamError("Heimdall HTTP 400 bad_request: no"),
        HeimdallInvalid("Heimdall HTTP 422 invalid_request: no"),
        HeimdallAmbiguous("Heimdall HTTP 503 :"),
    ],
    ids=["400", "422", "503"],
)
async def test_an_answered_failure_on_one_link_still_polls_the_rest(db_session, fake, monkeypatch, exc):
    """Heimdall ANSWERED (a 4xx refusal, or a 5xx): the transport works, so
    the pass carries on to the other links exactly as before T-057."""
    ids = await _three_pending_links(db_session, fake)
    _get_failing_for(fake, monkeypatch, "L1", exc)
    later = NOW + timedelta(minutes=1)
    await reconcile_payment_links(db_session, now=later, today=TODAY)
    assert [c[1] for c in fake.calls if c[0] == "get"] == ["L1", "L2", "L3"]
    first, second, third = [await current_link(db_session, pid) for pid in ids]
    assert first.sync_error == str(exc)
    assert second.checked_at == later and third.checked_at == later


@pytest.mark.asyncio
async def test_an_unreachable_create_stops_the_reconcile_half_and_skips_the_poll(db_session, fake):
    """The reconcile half stands down the same way: the first project's
    reservation carries the error, the next projects are not visited (no
    reservation, no call), and the poll half makes no call either."""
    ids = [(await _project(db_session, quote_number=f"DEV-{n}")).id for n in "ABC"]
    fake.fail_with = HeimdallUnreachable("Heimdall unreachable: connect refused")
    visited = await reconcile_payment_links(db_session, now=NOW, today=TODAY)
    assert visited == 1
    assert [c[0] for c in fake.calls] == ["create"]
    (stuck,) = await _rows(db_session, ids[0])
    assert stuck.heimdall_id is None and stuck.sync_error == "Heimdall unreachable: connect refused"
    assert await _rows(db_session, ids[1]) == [] and await _rows(db_session, ids[2]) == []
    assert svc._throttled_until is None


@pytest.mark.asyncio
async def test_an_unreachable_link_replacement_in_the_poll_stops_the_pass(db_session, fake, monkeypatch):
    """The poll half's own `_replace_lost` (a 404 on the GET) failing with
    `HeimdallUnreachable` stops the pass too."""
    ids = await _three_pending_links(db_session, fake)
    fake.forget("L1")

    async def unreachable_create(db, **kw):
        fake.calls.append(("create", kw["idempotency_key"]))
        raise HeimdallUnreachable("Heimdall unreachable: timed out")

    monkeypatch.setattr(heimdall_service, "create_link", unreachable_create)
    later = NOW + timedelta(minutes=1)
    await reconcile_payment_links(db_session, now=later, today=TODAY)
    assert [c[0] for c in fake.calls] == ["get", "create"]
    old, reservation = await _rows(db_session, ids[0])
    assert old.status == "failed" and reservation.sync_error == "Heimdall unreachable: timed out"
    for pid in ids[1:]:
        untouched = await current_link(db_session, pid)
        assert untouched.checked_at == NOW and untouched.sync_error is None


@pytest.mark.asyncio
async def test_reconcile_project_reports_only_a_transport_failure(db_session, fake, monkeypatch):
    """The return value the pass stands down on: True only for a stored
    `HeimdallUnreachable`, including from its own 404 replacement."""
    p = await _project(db_session)
    pid = p.id
    fake.fail_with = HeimdallUpstreamError("Heimdall HTTP 500 internal: boom")
    assert await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW) is False
    fake.fail_with = None
    p = await db_session.get(AitoProject, pid)
    assert await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW, force=True) is False

    async def not_found_patch(db, heimdall_id, **kw):
        raise HeimdallNotFound(f"Heimdall HTTP 404 not_found: no payment {heimdall_id}")

    async def unreachable_create(db, **kw):
        raise HeimdallUnreachable("Heimdall unreachable: timed out")

    monkeypatch.setattr(heimdall_service, "patch_link", not_found_patch)
    monkeypatch.setattr(heimdall_service, "create_link", unreachable_create)
    p = await db_session.get(AitoProject, pid)
    p.quote_total = 13000.0
    await db_session.commit()
    later = NOW + timedelta(hours=1)
    assert await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=later) is True
    p = await db_session.get(AitoProject, pid)
    fake.fail_with = HeimdallUnreachable("Heimdall unreachable: again")
    monkeypatch.setattr(heimdall_service, "create_link", fake.create_link)
    assert await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=later, force=True) is True


@pytest.mark.asyncio
async def test_the_panel_retry_still_calls_after_a_stood_down_pass(db_session, fake, monkeypatch):
    """No cross-tick throttle is armed, so the operator's Retry (forced,
    one project) makes its call right after a pass stood down."""
    ids = await _three_pending_links(db_session, fake)
    _get_failing_for(fake, monkeypatch, "L1", HeimdallUnreachable("Heimdall unreachable: timed out"))
    await reconcile_payment_links(db_session, now=NOW + timedelta(minutes=1), today=TODAY)
    monkeypatch.setattr(heimdall_service, "get_payment", fake.get_payment)
    fake.calls.clear()
    await reconcile_payment_links(db_session, only_project_id=ids[0], force=True, now=NOW + timedelta(minutes=2))
    assert fake.calls == [("get", "L1")]
    assert (await current_link(db_session, ids[0])).sync_error is None


# --- a paid quote link's acceptance is re-driven (T-060) ----------------------


def _fail_rules_once(monkeypatch):
    """`apply_quote_decision` raises once before its commit — the shape of
    SQLite 'database is locked' or a rules failure inside the acceptance."""
    from sqlalchemy.exc import OperationalError

    import backend.app.api.routes.aito as routes

    real = routes._apply_rules
    calls = []

    async def flaky(*a, **k):
        calls.append(1)
        if len(calls) == 1:
            raise OperationalError("UPDATE", {}, Exception("database is locked"))
        return await real(*a, **k)

    monkeypatch.setattr(routes, "_apply_rules", flaky)
    return calls


def _spy_notifications(monkeypatch):
    from backend.app.services.notification_service import notification_service

    notified = []

    async def spy(db, **kw):
        notified.append(kw)

    monkeypatch.setattr(notification_service, "on_aito_payment_received", spy)
    return notified


@pytest.mark.asyncio
async def test_a_failed_acceptance_leaves_the_link_pending_and_the_next_pass_credits_it_once(
    db_session, fake, monkeypatch
):
    """The acceptance raises once after the poll saw `paid`: nothing of the
    paid state is kept (the link reads `pending`, no event, quote untouched,
    nobody notified), so the next pass polls it again and credits it — the
    event, the acceptance and the notification exactly once — and a third
    pass does not touch it."""
    p = await _project(db_session)
    pid = p.id
    await reconcile_payment_links(db_session, now=NOW, today=TODAY)
    link = await current_link(db_session, pid)
    fake.set_status(link.heimdall_id, "paid")
    notified = _spy_notifications(monkeypatch)
    rules_calls = _fail_rules_once(monkeypatch)

    first = NOW + timedelta(minutes=5)
    await reconcile_payment_links(db_session, now=first, today=TODAY)
    assert len(rules_calls) == 1
    (r,) = await _rows(db_session, pid)
    await db_session.refresh(r)
    assert r.status == "pending" and r.paid_at is None
    kinds = await _kinds(db_session, pid)
    assert "payment_link.paid" not in kinds and "quote.accepted" not in kinds
    project = await db_session.get(AitoProject, pid)
    await db_session.refresh(project)
    assert project.quote_status == "sent"
    assert notified == []

    second = NOW + timedelta(minutes=10)
    await reconcile_payment_links(db_session, now=second, today=TODAY)
    (r,) = await _rows(db_session, pid)
    await db_session.refresh(r)
    assert r.status == "paid" and r.paid_at == second
    kinds = await _kinds(db_session, pid)
    assert kinds.count("payment_link.paid") == 1 and kinds.count("quote.accepted") == 1
    await db_session.refresh(project)
    assert project.quote_status == "accepted"
    assert len(notified) == 1 and notified[0]["source"] == "payment_link"

    fake.calls.clear()
    await reconcile_payment_links(db_session, now=second + timedelta(minutes=5), today=TODAY)
    assert [c for c in fake.calls if c[0] == "get"] == []
    kinds = await _kinds(db_session, pid)
    assert kinds.count("payment_link.paid") == 1 and kinds.count("quote.accepted") == 1
    assert len(notified) == 1


@pytest.mark.asyncio
async def test_a_failed_acceptance_on_a_cancel_conflict_is_retried_by_the_forced_pass(db_session, fake, monkeypatch):
    """The reconcile half finds the link paid while cancelling it (409) and
    the acceptance then fails: `reconcile_project` rolls back and records the
    failure on the still-`pending` row, and the panel's forced pass credits
    it — once."""
    p = await _project(db_session)
    pid = p.id
    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    fake.set_status("L1", "paid")
    p.quote_invoiced = True  # nothing wanted any more -> the reconcile tries to cancel
    await db_session.commit()
    notified = _spy_notifications(monkeypatch)
    _fail_rules_once(monkeypatch)

    await reconcile_project(db_session, p, pct=0, validity_days=15, today=TODAY, now=NOW)
    (r,) = await _rows(db_session, pid)
    await db_session.refresh(r)
    assert r.status == "pending" and r.paid_at is None and "database is locked" in r.sync_error
    assert "payment_link.paid" not in await _kinds(db_session, pid)
    assert notified == []

    later = NOW + timedelta(minutes=1)
    await reconcile_payment_links(db_session, only_project_id=pid, now=later, today=TODAY, force=True)
    (r,) = await _rows(db_session, pid)
    await db_session.refresh(r)
    assert r.status == "paid" and r.paid_at == later
    kinds = await _kinds(db_session, pid)
    assert kinds.count("payment_link.paid") == 1 and kinds.count("quote.accepted") == 1
    assert "payment_link.cancelled" not in kinds
    assert len(notified) == 1


# --- a paid link whose acceptance keeps failing backs off (T-083) --------------


def _accept_failing_for(monkeypatch, project_ids, exc):
    """`accept_quote` raises `exc` (NOT a SQLAlchemyError) for the given
    projects while `project_ids` is non-empty, before its commit; any other
    project is accepted for real. Returns the list of project ids it was
    called for."""
    import backend.app.services.aito_quote_status as quote_status

    real = quote_status.accept_quote
    calls = []

    async def accept(db, project, **kw):
        calls.append(project.id)
        if project.id in project_ids:
            raise exc
        return await real(db, project, **kw)

    monkeypatch.setattr(quote_status, "accept_quote", accept)
    return calls


@pytest.mark.asyncio
async def test_a_paid_link_whose_acceptance_raises_backs_off_and_the_rest_are_still_polled(
    db_session, fake, monkeypatch
):
    """`accept_quote` raising a non-SQLAlchemy error rolls the link back to
    `pending` (T-060). The poll no longer lets that escape the pass: the link
    carries a sync_error and backs off, the other links are polled and
    credited in the same pass, the backed-off link is not polled again until
    its back-off has passed, and once the acceptance works it is credited
    exactly once. The failure is written on a row RE-FETCHED after the
    rollback — writing it on the expired pre-rollback object would raise
    `MissingGreenlet` out of the handler and fail this test."""
    ids = await _three_pending_links(db_session, fake)
    for hid in ("L1", "L2", "L3"):
        fake.set_status(hid, "paid")
    failing = {ids[0]}
    accept_calls = _accept_failing_for(monkeypatch, failing, RuntimeError("Books said no"))

    first = NOW + timedelta(minutes=5)
    await reconcile_payment_links(db_session, now=first, today=TODAY)
    assert [c[1] for c in fake.calls if c[0] == "get"] == ["L1", "L2", "L3"]
    assert accept_calls == ids
    stuck, second_link, third_link = [await current_link(db_session, pid) for pid in ids]
    await db_session.refresh(stuck)
    assert stuck.status == "pending" and stuck.paid_at is None
    assert stuck.sync_error == "Books said no" and stuck.sync_failures == 1 and stuck.checked_at == first
    assert "payment_link.paid" not in await _kinds(db_session, ids[0])
    for pid, credited in ((ids[1], second_link), (ids[2], third_link)):
        await db_session.refresh(credited)
        assert credited.status == "paid" and credited.paid_at == first
        kinds = await _kinds(db_session, pid)
        assert kinds.count("payment_link.paid") == 1 and kinds.count("quote.accepted") == 1

    # Inside its back-off: not polled at all.
    fake.calls.clear()
    await reconcile_payment_links(db_session, now=first + timedelta(minutes=1), today=TODAY)
    assert [c for c in fake.calls if c[0] == "get"] == []

    # Past it, with the acceptance working again: credited exactly once.
    failing.clear()
    fake.calls.clear()
    third = first + timedelta(seconds=svc._TICK_SECONDS + 1)
    await reconcile_payment_links(db_session, now=third, today=TODAY)
    assert [c[1] for c in fake.calls if c[0] == "get"] == ["L1"]
    stuck = await current_link(db_session, ids[0])
    await db_session.refresh(stuck)
    assert stuck.status == "paid" and stuck.paid_at == third and stuck.sync_error is None
    kinds = await _kinds(db_session, ids[0])
    assert kinds.count("payment_link.paid") == 1 and kinds.count("quote.accepted") == 1
    project = await db_session.get(AitoProject, ids[0])
    await db_session.refresh(project)
    assert project.quote_status == "accepted"

    fake.calls.clear()
    await reconcile_payment_links(db_session, now=third + timedelta(minutes=5), today=TODAY)
    assert [c for c in fake.calls if c[0] == "get"] == []
    assert (await _kinds(db_session, ids[0])).count("payment_link.paid") == 1


@pytest.mark.asyncio
async def test_a_failing_acceptance_does_not_swallow_the_unreachable_stand_down(db_session, fake, monkeypatch):
    """The new catch sits behind the Heimdall handlers: an acceptance failure
    on L1 is stored and the pass moves on, but a `HeimdallUnreachable` on L2
    still stops the pass before L3."""
    ids = await _three_pending_links(db_session, fake)
    fake.set_status("L1", "paid")
    _accept_failing_for(monkeypatch, {ids[0]}, ValueError("bad total"))
    _get_failing_for(fake, monkeypatch, "L2", HeimdallUnreachable("Heimdall unreachable: timed out"))
    later = NOW + timedelta(minutes=1)
    await reconcile_payment_links(db_session, now=later, today=TODAY)
    assert [c[1] for c in fake.calls if c[0] == "get"] == ["L1", "L2"]
    first, second, third = [await current_link(db_session, pid) for pid in ids]
    for row in (first, second, third):
        await db_session.refresh(row)
    assert first.status == "pending" and first.sync_error == "bad total"
    assert second.sync_error == "Heimdall unreachable: timed out"
    assert third.checked_at == NOW and third.sync_error is None
    assert svc._throttled_until is None


@pytest.mark.asyncio
async def test_a_cancel_conflict_whose_acceptance_raises_does_not_abort_the_pass(db_session, fake, monkeypatch):
    """Same bug in the reconcile half: a cancel racing a payment (409) whose
    acceptance raises a non-SQLAlchemy error. The project's link is stored
    with the failure and backs off, the next project is still reconciled and
    the poll half still runs."""
    ids = await _three_pending_links(db_session, fake)
    fake.set_status("L1", "paid")
    project = await db_session.get(AitoProject, ids[0])
    project.quote_invoiced = True  # nothing wanted any more -> the reconcile tries to cancel
    await db_session.commit()
    _accept_failing_for(monkeypatch, {ids[0]}, RuntimeError("Books said no"))
    later = NOW + timedelta(minutes=1)
    visited = await reconcile_payment_links(db_session, now=later, today=TODAY)
    assert visited == 3
    assert fake.calls[0] == ("cancel", "L1")
    assert [c[1] for c in fake.calls if c[0] == "get"][-2:] == ["L2", "L3"]  # the poll half ran
    stuck = await current_link(db_session, ids[0])
    await db_session.refresh(stuck)
    assert stuck.status == "pending" and stuck.sync_error == "Books said no" and stuck.sync_failures == 1
    assert "payment_link.paid" not in await _kinds(db_session, ids[0])


@pytest.mark.asyncio
async def test_storing_an_unexpected_failure_skips_settled_rows_and_survives_a_db_error(db_session, fake, monkeypatch):
    """A row that is no longer pending gets no sync_error (a paid row is never
    re-adopted, so it would stick), and a failure of the store itself is only
    logged."""
    ids = await _three_pending_links(db_session, fake)
    link = await current_link(db_session, ids[0])
    rid = link.id
    link.status = "paid"
    await db_session.commit()
    await svc._store_unexpected_failure(db_session, RuntimeError("x"), NOW, row_id=rid)
    link = await db_session.get(AitoPaymentLink, rid)
    await db_session.refresh(link)
    assert link.sync_error is None and link.sync_failures == 0

    async def broken(db, project_id, **kw):
        raise SQLAlchemyError("database is locked")

    monkeypatch.setattr(svc, "current_link", broken)
    await svc._store_unexpected_failure(db_session, RuntimeError("x"), NOW, project_id=ids[1])


@pytest.mark.asyncio
async def test_a_rate_limited_poll_still_arms_the_throttle_past_the_new_catch(db_session, fake, monkeypatch):
    """The generic per-row catch must not swallow a 429 on the GET: the pass
    stops at L1 and the throttle is armed, exactly as before."""
    await _three_pending_links(db_session, fake)
    _get_failing_for(fake, monkeypatch, "L1", HeimdallRateLimited("slow down", 120.0))
    await reconcile_payment_links(db_session, now=NOW + timedelta(minutes=1), today=TODAY)
    assert [c[1] for c in fake.calls if c[0] == "get"] == ["L1"]
    assert svc._throttled_until is not None


def _abandoned_invoice_reservation(project_id: int, key: str, created_at: datetime) -> AitoPaymentLink:
    return AitoPaymentLink(
        project_id=project_id,
        idempotency_key=key,
        reference="FA-26-0006",
        amount=1000,
        expires_on="2026-12-31",
        status="pending",
        document_kind="invoice",
        document_number="FA-26-0006",
        created_at=created_at,
    )


@pytest.mark.asyncio
async def test_a_db_error_ageing_out_one_reservation_does_not_stop_the_sweep(db_session, monkeypatch):
    p = await _project(db_session, quote_sync_state="unmanaged")
    first = _abandoned_invoice_reservation(p.id, "aito:abandoned:1", NOW)
    second = _abandoned_invoice_reservation(p.id, "aito:abandoned:2", NOW)
    db_session.add_all([first, second])
    await db_session.commit()
    first_id, second_id = first.id, second.id

    real_commit = db_session.commit
    commits = 0

    async def commit_failing_once():
        nonlocal commits
        commits += 1
        if commits == 1:
            raise SQLAlchemyError("disk I/O error")
        await real_commit()

    monkeypatch.setattr(db_session, "commit", commit_failing_once)
    aged = await svc._age_out_abandoned_invoice_reservations(db_session, now=NOW + timedelta(minutes=11))
    monkeypatch.undo()

    assert aged == 1
    # Re-read by id: the rollback expired every tracked ORM object.
    by_id = {r.id: r for r in (await db_session.execute(select(AitoPaymentLink))).scalars()}
    assert by_id[first_id].status == "pending" and by_id[first_id].sync_error is None
    assert by_id[second_id].status == "failed" and by_id[second_id].sync_error == "reservation abandoned"


@pytest.mark.asyncio
async def test_a_db_error_reconciling_one_project_does_not_stop_the_pass(db_session, fake, monkeypatch):
    a = await _project(db_session, quote_number="DEV-A")
    b = await _project(db_session, quote_number="DEV-B")
    aid, bid = a.id, b.id
    real = svc.reconcile_project
    seen: list[int] = []

    async def flaky(db, project, **kw):
        seen.append(project.id)
        if project.id == aid:
            raise SQLAlchemyError("database is locked")
        return await real(db, project, **kw)

    monkeypatch.setattr(svc, "reconcile_project", flaky)
    n = await reconcile_payment_links(db_session, now=NOW, today=TODAY)

    assert n == 2 and seen == [aid, bid]
    assert await current_link(db_session, aid) is None
    assert (await current_link(db_session, bid)).heimdall_id == "L1"


@pytest.mark.asyncio
async def test_a_lost_invoice_link_whose_row_vanished_before_the_reread_does_not_end_the_pass(
    db_session, fake, monkeypatch
):
    p = await _project(db_session, quote_status="declined")
    project_id = p.id
    invoice_row = AitoPaymentLink(
        project_id=project_id,
        idempotency_key=f"aito:{project_id}:1",
        reference="FA-1",
        amount=50,
        expires_on="2026-12-31",
        heimdall_id="ghost-1",  # never registered with `fake` — a bare 404
        status="pending",
        document_kind="invoice",
        document_number="FA-1",
    )
    db_session.add(invoice_row)
    await db_session.commit()
    row_id = invoice_row.id

    real_get = db_session.get
    link_gets = 0

    async def get_none_on_the_reread(entity, ident, *a, **kw):
        nonlocal link_gets
        if entity is AitoPaymentLink:
            link_gets += 1
            if link_gets == 2:  # the re-read after the 404's rollback
                return None
        return await real_get(entity, ident, *a, **kw)

    monkeypatch.setattr(db_session, "get", get_none_on_the_reread)
    visited = await reconcile_payment_links(db_session, now=NOW, today=TODAY, only_project_id=project_id, force=True)
    monkeypatch.undo()

    assert visited == 1 and link_gets == 2
    (row,) = [r for r in await _rows(db_session, project_id) if r.id == row_id]
    assert row.status == "pending"  # nothing was marked failed: the re-read found no row
