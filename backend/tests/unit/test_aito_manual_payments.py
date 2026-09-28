import asyncio
import time as real_time
from datetime import date

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from backend.app.api.routes.settings import set_setting
from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.services import aito_manual_payments as svc
from backend.app.services.aito_payment_documents import PaymentDocument
from backend.app.services.zoho import ZohoAmbiguous, ZohoUnreachable, ZohoUpstreamError, zoho_service

TODAY = date(2026, 9, 23)
INVOICE = PaymentDocument(kind="invoice", id="inv-1", number="FA-26-0001", customer_id="c1", balance=23000)
QUOTE = PaymentDocument(kind="quote", id="est-1", number="DEV26-0001", customer_id="c1", balance=None)


async def _project(db, **over):
    base = {
        "description": "d",
        "client_id": "c1",
        "client_name": "ACME",
        "board_column": "devis",
        "position": 0,
        "status": "active",
        "quote_id": "est-1",
        "quote_number": "DEV26-0001",
        "quote_status": "sent",
        "quote_sync_state": "idle",
    }
    base.update(over)
    p = AitoProject(**base)
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return p


@pytest.fixture(autouse=True)
def _clear_guard():
    svc._recent.clear()
    yield
    svc._recent.clear()


@pytest.fixture
def books(monkeypatch):
    state = {"calls": [], "fail_payment": False}

    async def request(db, method, path, *, params=None, json=None):
        state["calls"].append((method, path, json))
        if path == "/retainerinvoices" and method == "POST":
            return {"retainerinvoice": {"retainerinvoice_id": "ret-1", "retainerinvoice_number": "RET26-0001"}}
        if path == "/customerpayments" and method == "POST":
            if state["fail_payment"]:
                raise ZohoUpstreamError("Zoho HTTP 400: payment mode unknown")
            return {"payment": {"payment_id": "pay-1"}}
        if path == "/invoices" and method == "GET":
            return {
                "invoices": [
                    {
                        "invoice_id": "inv-1",
                        "invoice_number": "FA-26-0001",
                        "status": "paid",
                        "balance": 0,
                        "due_date": "2026-10-01",
                    }
                ]
            }
        if path == "/customerpayments" and method == "GET":
            return {"customerpayments": []}
        return {}

    monkeypatch.setattr(zoho_service, "_request", request)
    return state


async def _events(db, project_id, kind):
    rows = (await db.execute(select(AitoEvent).where(AitoEvent.project_id == project_id))).scalars().all()
    return [e for e in rows if e.kind == kind]


@pytest.mark.asyncio
async def test_invoice_payment_uses_the_configured_mode_and_records(db_session, books, monkeypatch):
    await set_setting(db_session, "aito_payment_mode_cheque", "Chèque")
    await db_session.commit()

    async def no_refresh(db, project_id, kind):
        return None

    monkeypatch.setattr(svc, "refresh_after_payment", no_refresh)
    p = await _project(db_session)
    out = await svc.record_manual_payment(
        db_session,
        p,
        document=INVOICE,
        mode="cheque",
        amount=23000,
        reference="0004521",
        actor_name="paul",
        today=TODAY,
    )
    assert out.zoho_payment_id == "pay-1" and out.retainer_number is None and out.mode_name == "Chèque"
    body = next(j for m, path, j in books["calls"] if path == "/customerpayments" and m == "POST")
    assert body["payment_mode"] == "Chèque" and body["invoices"] == [{"invoice_id": "inv-1", "amount_applied": 23000}]
    ev = await _events(db_session, p.id, "payment.manual.recorded")
    assert len(ev) == 1 and ev[0].detail["mode"] == "cheque" and ev[0].detail["reference"] == "0004521"
    assert ev[0].actor_name == "paul" and ev[0].detail["zoho_payment_id"] == "pay-1"


@pytest.mark.asyncio
async def test_invoice_amount_above_balance_is_refused_before_any_write(db_session, books):
    p = await _project(db_session)
    with pytest.raises(svc.AmountAboveBalance) as exc:
        await svc.record_manual_payment(
            db_session, p, document=INVOICE, mode="cash", amount=23001, reference=None, actor_name=None, today=TODAY
        )
    assert exc.value.balance == 23000 and books["calls"] == []


@pytest.mark.asyncio
async def test_quote_deposit_raises_a_retainer_then_pays_it(db_session, books, monkeypatch):
    async def no_refresh(db, project_id, kind):
        return None

    monkeypatch.setattr(svc, "refresh_after_payment", no_refresh)
    p = await _project(db_session)
    out = await svc.record_manual_payment(
        db_session, p, document=QUOTE, mode="cash", amount=25000, reference=None, actor_name=None, today=TODAY
    )
    assert out.retainer_number == "RET26-0001"
    paths = [(m, path) for m, path, _ in books["calls"]]
    assert paths.index(("POST", "/retainerinvoices")) < paths.index(("POST", "/customerpayments"))
    retainer = next(j for m, path, j in books["calls"] if path == "/retainerinvoices")
    assert retainer["reference_number"] == "DEV26-0001"
    payment = next(j for m, path, j in books["calls"] if path == "/customerpayments")
    assert payment["retainerinvoice_id"] == "ret-1" and payment["payment_mode"] == "cash"


@pytest.mark.asyncio
async def test_quote_payment_failure_after_the_retainer_is_partial(db_session, books):
    books["fail_payment"] = True
    p = await _project(db_session)
    with pytest.raises(svc.ManualPaymentPartial) as exc:
        await svc.record_manual_payment(
            db_session, p, document=QUOTE, mode="card", amount=100, reference=None, actor_name=None, today=TODAY
        )
    assert exc.value.retainer_number == "RET26-0001"
    ev = await _events(db_session, p.id, "payment.manual.partial")
    assert len(ev) == 1 and ev[0].detail["retainer_number"] == "RET26-0001"


@pytest.mark.asyncio
async def test_duplicate_within_the_window_is_refused(db_session, books, monkeypatch):
    async def no_refresh(db, project_id, kind):
        return None

    monkeypatch.setattr(svc, "refresh_after_payment", no_refresh)
    p = await _project(db_session)
    kw = {"document": INVOICE, "mode": "cash", "amount": 100, "reference": "r", "actor_name": None, "today": TODAY}
    await svc.record_manual_payment(db_session, p, **kw)
    with pytest.raises(svc.DuplicateManualPayment):
        await svc.record_manual_payment(db_session, p, **kw)

    # Rebind the MODULE-LEVEL `time` name inside aito_manual_payments itself
    # rather than mutating the real, process-wide `time` module: that module
    # is shared with asyncio's own event-loop clock, and a frozen/rewound
    # global monotonic() wedges asyncio internals that lean on real
    # wall-clock progress, hanging the test rather than failing it (the same
    # hazard documented on `_FakeMonotonicClock` in test_aito_quote_sync.py).
    future = real_time.monotonic() + svc.DUPLICATE_WINDOW_SECONDS + 1

    class _LaterClock:
        @staticmethod
        def monotonic():
            return future

    monkeypatch.setattr(svc, "time", _LaterClock)
    await svc.record_manual_payment(db_session, p, **kw)  # window elapsed


@pytest.mark.asyncio
async def test_expired_guard_entries_are_pruned_while_fresh_ones_still_refuse(db_session, books, monkeypatch):
    """T-014: the dict must not grow forever. An entry older than
    DUPLICATE_WINDOW_SECONDS is already ignored by the duplicate check (see
    the test above), so removing it on a later call changes nothing a caller
    can observe -- it just stops the process-lifetime dict from growing.
    A second, still-fresh entry made in the same later call must keep
    refusing a genuine duplicate."""

    async def no_refresh(db, project_id, kind):
        return None

    monkeypatch.setattr(svc, "refresh_after_payment", no_refresh)
    p = await _project(db_session)
    old_kw = {
        "document": INVOICE,
        "mode": "cash",
        "amount": 100,
        "reference": "old",
        "actor_name": None,
        "today": TODAY,
    }
    await svc.record_manual_payment(db_session, p, **old_kw)
    old_key = svc._guard_key(p.id, INVOICE, 100, "old")
    assert old_key in svc._recent

    future = real_time.monotonic() + svc.DUPLICATE_WINDOW_SECONDS + 1

    class _LaterClock:
        @staticmethod
        def monotonic():
            return future

    monkeypatch.setattr(svc, "time", _LaterClock)
    new_kw = {
        "document": INVOICE,
        "mode": "cash",
        "amount": 200,
        "reference": "new",
        "actor_name": None,
        "today": TODAY,
    }
    await svc.record_manual_payment(db_session, p, **new_kw)  # prunes `old_key` on entry
    new_key = svc._guard_key(p.id, INVOICE, 200, "new")

    assert old_key not in svc._recent  # evicted: past the window
    assert new_key in svc._recent  # this call's own key: still fresh

    with pytest.raises(svc.DuplicateManualPayment):
        await svc.record_manual_payment(db_session, p, **new_kw)  # still inside ITS window


@pytest.mark.asyncio
async def test_concurrent_duplicate_calls_only_one_payment_reaches_books(db_session, test_engine, monkeypatch):
    """Finding 2: the guard must reserve its key at ENTRY, before any Zoho
    round trip -- otherwise two requests for the same document/amount/
    reference a few hundred ms apart (a double-click, or two browser tabs)
    both pass the read check under async concurrency and Books gets two
    payments. Uses two separate sessions on the same engine, the way two
    concurrent FastAPI requests would each get their own session."""
    state = {"calls": []}

    async def request(db, method, path, *, params=None, json=None):
        if path == "/customerpayments" and method == "POST":
            await asyncio.sleep(0)  # let the two coroutines actually interleave
        state["calls"].append((method, path, json))
        if path == "/customerpayments" and method == "POST":
            return {"payment": {"payment_id": "pay-1"}}
        return {}

    monkeypatch.setattr(zoho_service, "_request", request)

    async def no_refresh(db, project_id, kind):
        return None

    monkeypatch.setattr(svc, "refresh_after_payment", no_refresh)

    p = await _project(db_session)
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as db2:
        p2 = await db2.get(AitoProject, p.id)
        kw = {"document": INVOICE, "mode": "cash", "amount": 100, "reference": "r", "actor_name": None, "today": TODAY}
        results = await asyncio.gather(
            svc.record_manual_payment(db_session, p, **kw),
            svc.record_manual_payment(db2, p2, **kw),
            return_exceptions=True,
        )

    successes = [r for r in results if isinstance(r, svc.ManualPaymentResult)]
    duplicates = [r for r in results if isinstance(r, svc.DuplicateManualPayment)]
    assert len(successes) == 1 and len(duplicates) == 1
    post_calls = [c for c in state["calls"] if c[1] == "/customerpayments" and c[0] == "POST"]
    assert len(post_calls) == 1


@pytest.mark.asyncio
async def test_a_zoho_failure_releases_the_duplicate_key(db_session, monkeypatch):
    async def failing_request(db, method, path, *, params=None, json=None):
        if path == "/customerpayments" and method == "POST":
            raise ZohoUpstreamError("Zoho HTTP 500: internal error")
        return {}

    monkeypatch.setattr(zoho_service, "_request", failing_request)
    p = await _project(db_session)
    kw = {"document": INVOICE, "mode": "cash", "amount": 100, "reference": "r", "actor_name": None, "today": TODAY}
    with pytest.raises(ZohoUpstreamError):
        await svc.record_manual_payment(db_session, p, **kw)
    # Immediate retry: must be refused by Books again, never by our own
    # guard -- the failed attempt must have released its reservation.
    with pytest.raises(ZohoUpstreamError):
        await svc.record_manual_payment(db_session, p, **kw)


@pytest.mark.asyncio
async def test_a_partial_failure_keeps_the_duplicate_guard(db_session, books):
    books["fail_payment"] = True
    p = await _project(db_session)
    kw = {"document": QUOTE, "mode": "card", "amount": 100, "reference": None, "actor_name": None, "today": TODAY}
    with pytest.raises(svc.ManualPaymentPartial):
        await svc.record_manual_payment(db_session, p, **kw)
    # An immediate reflex retry must be refused as a duplicate, never raise
    # a second retainer invoice on top of the one that already exists.
    with pytest.raises(svc.DuplicateManualPayment):
        await svc.record_manual_payment(db_session, p, **kw)


@pytest.mark.asyncio
async def test_refresh_after_invoice_payment_writes_the_invoice_figures(db_session, books):
    p = await _project(db_session, invoice_status="sent", invoice_balance=23000.0)
    await svc.refresh_after_payment(db_session, p.id, "invoice")
    await db_session.refresh(p)
    assert p.invoice_status == "paid" and p.invoice_balance == 0 and p.invoice_due_date == "2026-10-01"


@pytest.mark.asyncio
async def test_refresh_after_quote_payment_runs_sync_project(db_session, monkeypatch):
    p = await _project(db_session)
    seen = []

    async def fake_sync(db, project, credit_cache=None):
        seen.append(project.id)
        return None

    monkeypatch.setattr("backend.app.services.aito_quote_sync.sync_project", fake_sync)
    await svc.refresh_after_payment(db_session, p.id, "quote")
    assert seen == [p.id]


@pytest.mark.asyncio
async def test_refresh_never_raises(db_session, monkeypatch):
    p = await _project(db_session)

    async def boom(*a, **k):
        raise ZohoUpstreamError("down")

    monkeypatch.setattr(zoho_service, "list_project_invoices", boom)
    await svc.refresh_after_payment(db_session, p.id, "invoice")
    # A Zoho-READ failure never touches the session's transaction, so no
    # rollback is needed or wanted: is_active must stay True throughout.
    assert db_session.is_active is True


@pytest.mark.asyncio
async def test_a_db_failure_after_the_books_write_keeps_the_guard_and_names_the_payment(db_session, books, monkeypatch):
    """Final review, Minor 11 (money path): the payment IS in Zoho Books and
    the local `record(...)`+`commit()` fails. Releasing the duplicate guard
    and letting the exception out as a 500 invited the operator to click
    again and pay twice. The key is KEPT, the error names the Books payment,
    and the session is left usable.

    The failure is a GENUINE flush failure raised from inside the recording
    step (a NOT NULL violation), not a monkeypatched `commit()`: only a real
    one puts the session into the partial-rollback state (`is_active` False)
    that the recovery below is about — see the test after this one."""

    async def no_refresh(db, project_id, kind):
        return None

    async def bad_record(db, project_id, kind, **kw):
        db.add(AitoEvent(project_id=project_id, kind=None, actor_class="user"))  # kind is NOT NULL
        await db.flush()

    monkeypatch.setattr(svc, "refresh_after_payment", no_refresh)
    monkeypatch.setattr(svc, "record", bad_record)
    p = await _project(db_session)
    project_id = p.id  # read before the failure: the rollback expires `p`
    with pytest.raises(svc.ManualPaymentUnrecorded) as exc:
        await svc.record_manual_payment(
            db_session,
            p,
            document=INVOICE,
            mode="cash",
            amount=23000,
            reference=None,
            actor_name="paul",
            today=TODAY,
        )
    assert exc.value.zoho_payment_id == "pay-1"
    assert "pay-1" in str(exc.value)
    assert db_session.is_active is True  # rolled back out of the poisoned state
    # The guard key survives, so a reflex retry inside the window is refused
    # (`DuplicateManualPayment`) instead of writing a second payment into
    # Books. Asserted on the guard itself rather than by calling again: the
    # deliberately broken `record` above leaves a pending row in this test's
    # session that a second call would trip over first.
    assert svc._guard_key(project_id, INVOICE, 23000, None) in svc._recent
    posts = [c for c in books["calls"] if c[0] == "POST" and c[1] == "/customerpayments"]
    assert len(posts) == 1


@pytest.mark.asyncio
async def test_refresh_recovers_a_session_poisoned_by_a_failed_commit(db_session, books):
    """Finding 1: `db.commit()` inside the invoice branch can itself fail
    (e.g. SQLite "database is locked") *after* the Zoho payment was already
    written. SQLAlchemy answers a failed flush/commit by putting the session
    into "partial rollback" state (`is_active` False); the caller's very
    next statement on it would then raise `PendingRollbackError` instead of
    a clean error.

    Reproduced with a genuine flush failure — an unrelated pending row that
    violates a NOT NULL constraint — rather than monkeypatching
    `db_session.commit` to simply raise: in this in-memory SQLite test
    harness a monkeypatched `commit()` that never touches the real
    transaction leaves `is_active` True regardless of the fix, so it would
    not actually exercise the conditional-rollback branch under test.
    """
    p = await _project(db_session, invoice_status="sent", invoice_balance=23000.0)
    db_session.add(AitoEvent(project_id=p.id, kind=None, actor_class="user"))  # kind is NOT NULL -> flush fails

    await svc.refresh_after_payment(db_session, p.id, "invoice")  # must not raise

    assert db_session.is_active is True


def _timing_out_books(monkeypatch, *, fail_path):
    """Books answers everything except `POST fail_path`, which times out --
    the error `_send` raises for an httpx ReadTimeout."""
    calls = []

    async def request(db, method, path, *, params=None, json=None):
        calls.append((method, path, json))
        if method == "POST" and path == fail_path:
            raise ZohoUnreachable("Zoho Books unreachable: ReadTimeout")
        if path == "/retainerinvoices" and method == "POST":
            return {"retainerinvoice": {"retainerinvoice_id": "ret-1", "retainerinvoice_number": "RET26-0001"}}
        return {}

    monkeypatch.setattr(zoho_service, "_request", request)
    return calls


@pytest.mark.asyncio
async def test_invoice_payment_timeout_is_outcome_unknown_and_keeps_the_guard(db_session, monkeypatch):
    """T-051: a ReadTimeout on POST /customerpayments can land after Books
    recorded the payment. It must not read as a clean failure: the guard key
    stays, so an identical retry inside the window is refused rather than
    writing a second payment against the invoice."""
    calls = _timing_out_books(monkeypatch, fail_path="/customerpayments")
    p = await _project(db_session)
    kw = {"document": INVOICE, "mode": "cash", "amount": 100, "reference": "r", "actor_name": None, "today": TODAY}
    with pytest.raises(svc.ManualPaymentOutcomeUnknown) as exc:
        await svc.record_manual_payment(db_session, p, **kw)
    assert exc.value.retainer_number is None
    assert isinstance(exc.value.cause, ZohoUnreachable)
    assert "ReadTimeout" in str(exc.value)
    assert svc._guard_key(p.id, INVOICE, 100, "r") in svc._recent
    with pytest.raises(svc.DuplicateManualPayment):
        await svc.record_manual_payment(db_session, p, **kw)
    posts = [c for c in calls if c[:2] == ("POST", "/customerpayments")]
    assert len(posts) == 1
    assert await _events(db_session, p.id, "payment.manual.recorded") == []


@pytest.mark.asyncio
async def test_quote_payment_timeout_is_outcome_unknown_not_partial(db_session, monkeypatch):
    """T-051, quote path: the retainer was raised, then the payment on it
    timed out. `ManualPaymentPartial` ("record it by hand in Books") and its
    `payment.manual.partial` event would both claim the payment is missing
    when Books may hold it -- the outcome is unknown instead, the retainer is
    named, and the guard stays armed."""
    calls = _timing_out_books(monkeypatch, fail_path="/customerpayments")
    p = await _project(db_session)
    kw = {"document": QUOTE, "mode": "card", "amount": 100, "reference": None, "actor_name": None, "today": TODAY}
    with pytest.raises(svc.ManualPaymentOutcomeUnknown) as exc:
        await svc.record_manual_payment(db_session, p, **kw)
    assert exc.value.retainer_number == "RET26-0001"
    assert await _events(db_session, p.id, "payment.manual.partial") == []
    with pytest.raises(svc.DuplicateManualPayment):
        await svc.record_manual_payment(db_session, p, **kw)
    assert [c[:2] for c in calls if c[0] == "POST"] == [("POST", "/retainerinvoices"), ("POST", "/customerpayments")]


@pytest.mark.asyncio
async def test_retainer_creation_timeout_is_outcome_unknown_and_keeps_the_guard(db_session, monkeypatch):
    """T-079 (user-approved 2026-09-27; before: the plain upstream error with
    the guard released). A transport error on the retainer invoice itself can
    land after Books created it: the outcome is unknown, the guard stays
    armed so an identical retry is refused, no payment is attempted and only
    one POST /retainerinvoices ever reaches Books."""
    calls = _timing_out_books(monkeypatch, fail_path="/retainerinvoices")
    p = await _project(db_session)
    kw = {"document": QUOTE, "mode": "card", "amount": 100, "reference": None, "actor_name": None, "today": TODAY}
    with pytest.raises(svc.ManualPaymentOutcomeUnknown) as exc:
        await svc.record_manual_payment(db_session, p, **kw)
    assert exc.value.retainer_number is None
    assert exc.value.stage == "retainer"
    assert isinstance(exc.value.cause, ZohoUnreachable)
    assert "retainer invoice may already be" in str(exc.value)
    assert svc._guard_key(p.id, QUOTE, 100, None) in svc._recent
    with pytest.raises(svc.DuplicateManualPayment):
        await svc.record_manual_payment(db_session, p, **kw)
    assert [c[:2] for c in calls if c[0] == "POST"] == [("POST", "/retainerinvoices")]
    assert await _events(db_session, p.id, "payment.manual.partial") == []


# --- T-078: a Books 5xx / non-JSON answer on the payment call ------------------

_AMBIGUOUS_BOOKS_ANSWERS = [
    pytest.param(lambda: httpx.Response(500, json={"code": 1, "message": "internal"}), id="500-json"),
    pytest.param(lambda: httpx.Response(502, content=b"<html>502 Bad Gateway</html>"), id="502-html"),
    pytest.param(lambda: httpx.Response(503, json={"code": 1, "message": "busy"}), id="503-json"),
    pytest.param(lambda: httpx.Response(504, content=b"<html>504 Gateway Time-out</html>"), id="504-html"),
    pytest.param(lambda: httpx.Response(200, content=b"<html>ok?</html>"), id="200-html"),
]


def _books_over_http(monkeypatch, payment_answer):
    """Books over the real `_request`/`_raise_for_status`: `_send` is the
    seam, so the status/body mapping under test is the production one."""
    calls = []

    async def send(db, method, path, *, params=None, json=None):
        calls.append((method, path))
        if (method, path) == ("POST", "/customerpayments"):
            return payment_answer()
        if (method, path) == ("POST", "/retainerinvoices"):
            return httpx.Response(
                201, json={"retainerinvoice": {"retainerinvoice_id": "ret-1", "retainerinvoice_number": "RET26-0001"}}
            )
        return httpx.Response(200, json={})

    monkeypatch.setattr(zoho_service, "_send", send)
    return calls


@pytest.mark.asyncio
@pytest.mark.parametrize("answer", _AMBIGUOUS_BOOKS_ANSWERS)
async def test_invoice_payment_books_5xx_is_outcome_unknown_and_keeps_the_guard(db_session, monkeypatch, answer):
    """T-078: an edge 502/504 (or Books' own 5xx) can arrive after Books
    committed the payment. Same as a timeout: outcome unknown, guard kept,
    an identical retry is refused before it reaches Books."""
    calls = _books_over_http(monkeypatch, answer)
    p = await _project(db_session)
    kw = {"document": INVOICE, "mode": "cash", "amount": 100, "reference": "r", "actor_name": None, "today": TODAY}
    with pytest.raises(svc.ManualPaymentOutcomeUnknown) as exc:
        await svc.record_manual_payment(db_session, p, **kw)
    assert exc.value.retainer_number is None
    assert isinstance(exc.value.cause, ZohoAmbiguous)
    assert svc._guard_key(p.id, INVOICE, 100, "r") in svc._recent
    with pytest.raises(svc.DuplicateManualPayment):
        await svc.record_manual_payment(db_session, p, **kw)
    assert calls.count(("POST", "/customerpayments")) == 1
    assert await _events(db_session, p.id, "payment.manual.recorded") == []


@pytest.mark.asyncio
@pytest.mark.parametrize("answer", _AMBIGUOUS_BOOKS_ANSWERS)
async def test_quote_payment_books_5xx_is_outcome_unknown_not_partial(db_session, monkeypatch, answer):
    """T-078, quote path: not `ManualPaymentPartial`, whose "record the
    payment on it in Books" would book a payment Books may already hold."""
    calls = _books_over_http(monkeypatch, answer)
    p = await _project(db_session)
    kw = {"document": QUOTE, "mode": "card", "amount": 100, "reference": None, "actor_name": None, "today": TODAY}
    with pytest.raises(svc.ManualPaymentOutcomeUnknown) as exc:
        await svc.record_manual_payment(db_session, p, **kw)
    assert exc.value.retainer_number == "RET26-0001"
    assert isinstance(exc.value.cause, ZohoAmbiguous)
    assert await _events(db_session, p.id, "payment.manual.partial") == []
    with pytest.raises(svc.DuplicateManualPayment):
        await svc.record_manual_payment(db_session, p, **kw)
    assert [c for c in calls if c[0] == "POST"] == [("POST", "/retainerinvoices"), ("POST", "/customerpayments")]


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [400, 401, 404, 422])
async def test_invoice_payment_books_4xx_json_is_still_a_clean_failure(db_session, monkeypatch, status):
    """Books answered and refused: nothing was written, so the guard is
    released and an honest retry goes through."""
    _books_over_http(monkeypatch, lambda: httpx.Response(status, json={"code": 9, "message": "payment mode unknown"}))
    p = await _project(db_session)
    kw = {"document": INVOICE, "mode": "cash", "amount": 100, "reference": "r", "actor_name": None, "today": TODAY}
    with pytest.raises(ZohoUpstreamError) as exc:
        await svc.record_manual_payment(db_session, p, **kw)
    assert not isinstance(exc.value, (ZohoAmbiguous, ZohoUnreachable))
    assert svc._guard_key(p.id, INVOICE, 100, "r") not in svc._recent


@pytest.mark.asyncio
async def test_quote_payment_books_400_json_is_still_partial(db_session, monkeypatch):
    _books_over_http(monkeypatch, lambda: httpx.Response(400, json={"code": 9, "message": "payment mode unknown"}))
    p = await _project(db_session)
    kw = {"document": QUOTE, "mode": "card", "amount": 100, "reference": None, "actor_name": None, "today": TODAY}
    with pytest.raises(svc.ManualPaymentPartial) as exc:
        await svc.record_manual_payment(db_session, p, **kw)
    assert "payment mode unknown" in str(exc.value)
    assert len(await _events(db_session, p.id, "payment.manual.partial")) == 1


def _books_over_http_retainer(monkeypatch, retainer_answer):
    """Books over the real `_request`/`_raise_for_status`, with the answer to
    POST /retainerinvoices under test."""
    calls = []

    async def send(db, method, path, *, params=None, json=None):
        calls.append((method, path))
        if (method, path) == ("POST", "/retainerinvoices"):
            return retainer_answer()
        return httpx.Response(200, json={})

    monkeypatch.setattr(zoho_service, "_send", send)
    return calls


@pytest.mark.asyncio
@pytest.mark.parametrize("answer", _AMBIGUOUS_BOOKS_ANSWERS)
async def test_retainer_creation_books_5xx_is_outcome_unknown_and_keeps_the_guard(db_session, monkeypatch, answer):
    """T-079: a Books 5xx / edge HTML answer on the retainer creation is as
    ambiguous as a timeout -- guard kept, identical retry refused, one POST."""
    calls = _books_over_http_retainer(monkeypatch, answer)
    p = await _project(db_session)
    kw = {"document": QUOTE, "mode": "card", "amount": 100, "reference": None, "actor_name": None, "today": TODAY}
    with pytest.raises(svc.ManualPaymentOutcomeUnknown) as exc:
        await svc.record_manual_payment(db_session, p, **kw)
    assert exc.value.retainer_number is None
    assert exc.value.stage == "retainer"
    assert isinstance(exc.value.cause, ZohoAmbiguous)
    assert svc._guard_key(p.id, QUOTE, 100, None) in svc._recent
    with pytest.raises(svc.DuplicateManualPayment):
        await svc.record_manual_payment(db_session, p, **kw)
    assert [c for c in calls if c[0] == "POST"] == [("POST", "/retainerinvoices")]


@pytest.mark.asyncio
async def test_retainer_creation_books_400_json_is_still_a_clean_failure(db_session, monkeypatch):
    """T-079 leaves a clean refusal alone: Books answered and created
    nothing, so the plain upstream error, the guard released, and an honest
    retry reaches Books again."""
    calls = _books_over_http_retainer(
        monkeypatch, lambda: httpx.Response(400, json={"code": 9, "message": "customer unknown"})
    )
    p = await _project(db_session)
    kw = {"document": QUOTE, "mode": "card", "amount": 100, "reference": None, "actor_name": None, "today": TODAY}
    with pytest.raises(ZohoUpstreamError) as exc:
        await svc.record_manual_payment(db_session, p, **kw)
    assert not isinstance(exc.value, (ZohoAmbiguous, ZohoUnreachable))
    assert svc._guard_key(p.id, QUOTE, 100, None) not in svc._recent
    with pytest.raises(ZohoUpstreamError):
        await svc.record_manual_payment(db_session, p, **kw)
    assert calls.count(("POST", "/retainerinvoices")) == 2
    assert ("POST", "/customerpayments") not in calls
