"""Creating a counter order from the Order Board. Zoho is a fake throughout."""

import asyncio
from datetime import date

import pytest
from sqlalchemy import select

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.models.order_board_event import OrderBoardEvent
from backend.app.services import order_board_actions as actions, order_board_sync as sync
from backend.app.services.order_board_actions import create as create_module
from backend.app.services.order_board_sync import _common as sync_common
from backend.app.services.zoho import (
    ZohoAmbiguous,
    ZohoNotConfiguredError,
    ZohoRateLimited,
    ZohoRequestRejected,
    ZohoUnreachable,
    ZohoUpstreamError,
    zoho_service,
)
from backend.tests.unit.test_order_board_actions import events_of
from backend.tests.unit.test_order_board_sync import (  # noqa: F401
    no_back_off_left_over,
    order,
    zoho,
)

ITEMS = {
    "A": {"item_id": "A", "name": "PLA", "rate": 2500, "product_type": "goods"},
    "B": {"item_id": "B", "name": "PETG", "rate": 3000, "product_type": "goods"},
    "S": {"item_id": "S", "name": "Main d'oeuvre", "rate": 5000, "product_type": "service"},
}


@pytest.fixture(autouse=True)
def no_ref_left_over():
    create_module._created.clear()
    create_module._ref_locks.clear()
    sync_common._pending_voids.clear()
    yield
    create_module._created.clear()
    create_module._ref_locks.clear()
    sync_common._pending_voids.clear()


@pytest.fixture
def books(zoho, monkeypatch):  # noqa: F811
    """create / confirm / void on the fake: each call recorded, the created order readable by get_salesorder."""
    zoho.payloads = []
    zoho.opened = []
    zoho.voided = []
    zoho.create_error = None
    zoho.open_error = None

    async def list_items_by_ids(db, item_ids):
        return [ITEMS[i] for i in item_ids if i in ITEMS]

    async def create_salesorder(db, payload):
        if zoho.create_error:
            raise zoho.create_error
        await asyncio.sleep(0)  # a concurrent second call gets its turn here
        zoho.payloads.append(payload)
        zoho.add({**order(9), "salesorder_id": "9", "reference_number": "Comptoir", "status": "draft"})
        return {"salesorder_id": "9", "salesorder_number": "SO-00009", "status": "draft"}

    async def mark_salesorder_open(db, salesorder_id):
        if zoho.open_error:
            raise zoho.open_error
        zoho.opened.append(salesorder_id)
        zoho.orders[salesorder_id]["status"] = "open"

    async def void_salesorder(db, salesorder_id):
        zoho.voided.append(salesorder_id)

    for fn in (list_items_by_ids, create_salesorder, mark_salesorder_open, void_salesorder):
        monkeypatch.setattr(zoho_service, fn.__name__, fn)
    return zoho


async def _docs(db):
    return list((await db.execute(select(OrderBoardDoc).where(OrderBoardDoc.kind == "salesorder"))).scalars())


@pytest.mark.asyncio
async def test_creates_confirms_stores_and_logs(db_session, books):
    lines = [{"item_id": "A", "quantity": 2}, {"item_id": "B", "quantity": 1, "discount": "10%"}]
    assert await actions.create_counter_order(db_session, "c1", lines, "ref-1", by="ana") == "9"
    assert books.payloads == [
        {
            "customer_id": "c1",
            "date": date.today().isoformat(),
            "reference_number": "Comptoir",
            "is_inclusive_tax": True,
            "discount_type": "item_level",
            "is_discount_before_tax": True,
            "line_items": [
                {"item_id": "A", "quantity": 2, "rate": 2500.0},
                {"item_id": "B", "quantity": 1, "rate": 3000.0, "discount": "10%"},
            ],
        }
    ]
    assert books.opened == ["9"]
    assert [d.zoho_id for d in await _docs(db_session)] == ["9"]
    assert (await sync.find_stored(db_session, "9")).detail["status"] == "open"  # re-read after the confirm
    events = await events_of(db_session, "9")
    assert [(e.kind, e.actor_name) for e in events] == [("order.created", "ana")]


@pytest.mark.asyncio
async def test_same_client_ref_creates_once(db_session, books):
    lines = [{"item_id": "A", "quantity": 1}]
    assert await actions.create_counter_order(db_session, "c1", lines, "ref-1", by=None) == "9"
    assert await actions.create_counter_order(db_session, "c1", lines, "ref-1", by=None) == "9"
    assert len(books.payloads) == 1


@pytest.mark.asyncio
async def test_a_retry_with_the_same_lines_in_another_order_returns_the_first_order(db_session, books):
    first = [{"item_id": "A", "quantity": 1}, {"item_id": "B", "quantity": 2, "discount": ""}]
    again = [{"item_id": "B", "quantity": 2}, {"item_id": "A", "quantity": 1}]
    assert await actions.create_counter_order(db_session, "c1", first, "ref-1", by=None) == "9"
    assert await actions.create_counter_order(db_session, "c1", again, "ref-1", by=None) == "9"
    assert len(books.payloads) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("customer_id", "lines"),
    [
        ("c1", [{"item_id": "A", "quantity": 2}]),
        ("c1", [{"item_id": "B", "quantity": 1}]),
        ("c1", [{"item_id": "A", "quantity": 1, "discount": "5%"}]),
        ("c1", [{"item_id": "A", "quantity": 1}, {"item_id": "B", "quantity": 1}]),
        ("c2", [{"item_id": "A", "quantity": 1}]),
    ],
)
async def test_a_known_ref_with_other_lines_or_client_is_refused_without_a_books_call(
    db_session, books, monkeypatch, customer_id, lines
):
    assert (
        await actions.create_counter_order(db_session, "c1", [{"item_id": "A", "quantity": 1}], "ref-1", by=None) == "9"
    )
    monkeypatch.setattr(sync, "zoho_busy", lambda: True)  # a refusal comes before the busy check too
    with pytest.raises(actions.OrderActionRefused, match="ref_reused"):
        await actions.create_counter_order(db_session, customer_id, lines, "ref-1", by=None)
    assert len(books.payloads) == 1


@pytest.mark.asyncio
async def test_a_changed_resubmit_waiting_on_the_lock_is_refused(db_session, books):
    results = await asyncio.gather(
        actions.create_counter_order(db_session, "c1", [{"item_id": "A", "quantity": 1}], "ref-2", by=None),
        actions.create_counter_order(db_session, "c1", [{"item_id": "B", "quantity": 1}], "ref-2", by=None),
        return_exceptions=True,
    )
    assert results[0] == "9"
    assert isinstance(results[1], actions.OrderActionRefused) and str(results[1]) == "ref_reused"
    assert len(books.payloads) == 1


@pytest.mark.asyncio
async def test_concurrent_same_client_ref_creates_once(db_session, books):
    lines = [{"item_id": "A", "quantity": 1}]
    ids = await asyncio.gather(
        actions.create_counter_order(db_session, "c1", lines, "ref-2", by=None),
        actions.create_counter_order(db_session, "c1", lines, "ref-2", by=None),
    )
    assert ids == ["9", "9"]
    assert len(books.payloads) == 1


@pytest.mark.asyncio
async def test_confirm_failure_voids_the_draft(db_session, books):
    books.open_error = ZohoUpstreamError("open boom")
    with pytest.raises(actions.OrderActionRefused) as e:
        await actions.create_counter_order(db_session, "c1", [{"item_id": "A", "quantity": 1}], "ref-1", by=None)
    assert e.value.args[0] == "create_failed"
    assert books.voided == ["9"]
    assert await _docs(db_session) == []
    assert create_module._created == {}  # a retry with the same ref tries again


@pytest.mark.asyncio
async def test_failed_creates_leave_no_lock_behind(db_session, books):
    books.open_error = ZohoUpstreamError("open boom")
    lines = [{"item_id": "A", "quantity": 1}]
    results = await asyncio.gather(
        actions.create_counter_order(db_session, "c1", lines, "ref-3", by=None),
        actions.create_counter_order(db_session, "c1", lines, "ref-3", by=None),
        return_exceptions=True,
    )
    assert all(isinstance(r, actions.OrderActionRefused) for r in results)
    assert len(books.payloads) == 2  # the waiter retried once the first had failed, never alongside it
    assert create_module._ref_locks == {}
    books.open_error = None
    assert await actions.create_counter_order(db_session, "c1", lines, "ref-3", by=None) == "9"
    assert create_module._ref_locks == {}


@pytest.mark.asyncio
async def test_an_order_a_pass_stored_first_is_reused(db_session, books, monkeypatch):
    """The pass commits the order between the stored-copy check and the insert: the unique key refuses the insert."""
    real = sync.find_stored
    calls = {"n": 0}

    async def find_stored(db, salesorder_id):
        calls["n"] += 1
        if calls["n"] == 1:
            db_session.add(OrderBoardDoc(kind="salesorder", zoho_id="9", header={"from": "pass"}, pending=False))
            await db_session.commit()
            return None
        return await real(db, salesorder_id)

    monkeypatch.setattr(sync, "find_stored", find_stored)
    assert await actions.create_counter_order(db_session, "c1", [{"item_id": "A", "quantity": 1}], "r", by="ana") == "9"
    docs = await _docs(db_session)
    assert len(docs) == 1 and docs[0].detail["status"] == "open"  # refreshed
    assert [e.kind for e in await events_of(db_session, "9")] == ["order.created"]
    assert {ref: order_id for ref, (_, order_id) in create_module._created.items()} == {"r": "9"}


@pytest.mark.asyncio
async def test_a_failure_after_the_confirm_never_creates_twice(db_session, books, monkeypatch):
    async def log_boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(create_module, "_log", log_boom)
    lines = [{"item_id": "A", "quantity": 1}]
    with pytest.raises(RuntimeError):
        await actions.create_counter_order(db_session, "c1", lines, "ref-4", by=None)
    assert await actions.create_counter_order(db_session, "c1", lines, "ref-4", by=None) == "9"
    assert len(books.payloads) == 1


@pytest.mark.asyncio
async def test_rate_limited_confirm_sends_no_void_and_remembers_the_draft(db_session, books):
    books.open_error = ZohoRateLimited("429", retry_after=30)
    with pytest.raises(sync.ZohoBusy):
        await actions.create_counter_order(db_session, "c1", [{"item_id": "A", "quantity": 1}], "ref-5", by=None)
    assert sync.zoho_busy()
    assert books.voided == []
    assert sync_common._pending_voids == {"9": "SO-00009"}
    assert await _docs(db_session) == []
    assert create_module._created == {}


@pytest.mark.asyncio
async def test_a_pass_after_the_window_voids_the_pending_draft(db_session, books):
    sync_common._pending_voids["9"] = "SO-00009"
    assert await sync.run_pass(db_session) is True
    assert books.voided == ["9"]
    assert sync_common._pending_voids == {}


@pytest.mark.asyncio
async def test_a_pass_inside_the_window_keeps_the_draft_and_a_429_reopens_it(db_session, books, monkeypatch):
    sync_common._pending_voids["9"] = "SO-00009"
    assert await sync.run_pass(db_session) is True  # window closed: voided

    sync_common._pending_voids["8"] = "SO-00008"

    async def void_429(db, salesorder_id):
        raise ZohoRateLimited("429", retry_after=30)

    monkeypatch.setattr(zoho_service, "void_salesorder", void_429)
    assert await sync.run_pass(db_session) is True
    assert sync.zoho_busy()
    assert sync_common._pending_voids == {"8": "SO-00008"}
    assert await sync.run_pass(db_session) is False  # inside the window nothing is sent


@pytest.mark.asyncio
async def test_a_failing_deferred_void_records_an_event_and_drops_the_draft(db_session, books, monkeypatch):
    sync_common._pending_voids["9"] = "SO-00009"

    async def void_boom(db, salesorder_id):
        raise ZohoUpstreamError("void boom")

    monkeypatch.setattr(zoho_service, "void_salesorder", void_boom)
    await sync.run_pass(db_session)
    assert sync_common._pending_voids == {}
    events = (
        (await db_session.execute(select(OrderBoardEvent).where(OrderBoardEvent.kind == "order.void_failed")))
        .scalars()
        .all()
    )
    assert [(e.salesorder_id, e.detail) for e in events] == [("9", {"order": "SO-00009"})]


@pytest.mark.asyncio
async def test_a_non_rate_limited_confirm_failure_still_voids_at_once(db_session, books):
    books.open_error = ZohoUpstreamError("open boom")
    with pytest.raises(actions.OrderActionRefused):
        await actions.create_counter_order(db_session, "c1", [{"item_id": "A", "quantity": 1}], "ref-6", by=None)
    assert books.voided == ["9"]
    assert sync_common._pending_voids == {}


@pytest.mark.asyncio
async def test_a_failed_void_still_refuses_create_failed(db_session, books, monkeypatch):
    books.open_error = ZohoUpstreamError("open boom")

    async def void_boom(db, salesorder_id):
        raise ZohoUpstreamError("void boom")

    monkeypatch.setattr(zoho_service, "void_salesorder", void_boom)
    with pytest.raises(actions.OrderActionRefused, match="create_failed"):
        await actions.create_counter_order(db_session, "c1", [{"item_id": "A", "quantity": 1}], "ref-1", by=None)


@pytest.mark.asyncio
async def test_a_failed_cleanup_void_goes_to_the_pending_void_retry(db_session, books, monkeypatch):
    books.open_error = ZohoUpstreamError("open boom")
    real_void = zoho_service.void_salesorder

    async def void_boom(db, salesorder_id):
        raise ZohoUpstreamError("void boom")

    monkeypatch.setattr(zoho_service, "void_salesorder", void_boom)
    with pytest.raises(actions.OrderActionRefused, match="create_failed"):
        await actions.create_counter_order(db_session, "c1", [{"item_id": "A", "quantity": 1}], "ref-7", by=None)
    assert sync_common._pending_voids == {"9": "SO-00009"}

    monkeypatch.setattr(zoho_service, "void_salesorder", real_void)
    await sync.run_pass(db_session)  # the pass voids the leftover order
    assert books.voided == ["9"]
    assert sync_common._pending_voids == {}


@pytest.mark.asyncio
async def test_rate_limited_create_is_busy(db_session, books):
    books.create_error = ZohoRateLimited("429", retry_after=30)
    with pytest.raises(sync.ZohoBusy):
        await actions.create_counter_order(db_session, "c1", [{"item_id": "A", "quantity": 1}], "ref-1", by=None)
    assert await _docs(db_session) == []
    assert sync.zoho_busy()


@pytest.mark.asyncio
async def test_retry_of_a_created_order_inside_a_backoff_window_returns_it(db_session, books):
    lines = [{"item_id": "A", "quantity": 1}]
    assert await actions.create_counter_order(db_session, "c1", lines, "ref-1", by=None) == "9"
    sync.open_rate_limit_window(ZohoRateLimited("429", retry_after=30))
    assert sync.zoho_busy()
    assert await actions.create_counter_order(db_session, "c1", lines, "ref-1", by=None) == "9"
    assert len(books.payloads) == 1


@pytest.mark.asyncio
async def test_warns_when_books_does_not_return_a_tax_inclusive_order(db_session, books, caplog):
    with caplog.at_level("WARNING"):
        await actions.create_counter_order(db_session, "c1", [{"item_id": "A", "quantity": 1}], "ref-1", by=None)
    assert "SO-00009 is not tax inclusive" in caplog.text


@pytest.mark.asyncio
async def test_busy_zoho_sends_nothing(db_session, books, monkeypatch):
    monkeypatch.setattr(sync, "zoho_busy", lambda: True)
    with pytest.raises(sync.ZohoBusy):
        await actions.create_counter_order(db_session, "c1", [{"item_id": "A", "quantity": 1}], "ref-1", by=None)
    assert books.payloads == []


@pytest.mark.asyncio
async def test_a_failed_reread_still_returns_the_new_order(db_session, books):
    books.fail_detail_once = True
    assert await actions.create_counter_order(db_session, "c1", [{"item_id": "A", "quantity": 1}], "r", by=None) == "9"
    doc = (await _docs(db_session))[0]
    assert doc.pending is True  # the next pass re-reads it
    assert [e.kind for e in await events_of(db_session, "9")] == ["order.created"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("lines", "code"),
    [
        ([{"item_id": "A", "quantity": 0}], "bad_quantity"),
        ([{"item_id": "A", "quantity": -1}], "bad_quantity"),
        ([{"item_id": "A", "quantity": 1.0004}], "bad_quantity"),
        ([{"item_id": "A", "quantity": float("nan")}], "bad_quantity"),
        ([{"item_id": "A", "quantity": 1}, {"item_id": "A", "quantity": 2}], "unknown_item"),
        ([{"item_id": "A", "quantity": 1, "discount": "101%"}], "bad_discount"),
        ([{"item_id": "A", "quantity": 1, "discount": "-5"}], "bad_discount"),
        ([{"item_id": "A", "quantity": 2, "discount": "5000.01"}], "bad_discount"),  # above 2 x 2500
        ([{"item_id": "A", "quantity": 1, "discount": "abc"}], "bad_discount"),
        ([{"item_id": "S", "quantity": 1}], "unknown_item"),
        ([{"item_id": "Z", "quantity": 1}], "unknown_item"),
    ],
)
async def test_refuses_bad_quantities_discounts_and_services(db_session, books, lines, code):
    with pytest.raises(actions.OrderActionRefused) as e:
        await actions.create_counter_order(db_session, "c1", lines, "ref-1", by=None)
    assert e.value.args[0] == code
    assert books.payloads == []
    assert await _docs(db_session) == []


@pytest.mark.asyncio
async def test_valid_discounts_are_sent_verbatim(db_session, books):
    lines = [
        {"item_id": "A", "quantity": 2, "discount": "10%"},
        {"item_id": "B", "quantity": 1, "discount": "5"},
    ]
    await actions.create_counter_order(db_session, "c1", lines, "ref-1", by=None)
    sent = books.payloads[0]["line_items"]
    assert [line["discount"] for line in sent] == ["10%", "5"]


@pytest.fixture
def void_attempts_reset():
    sync_common._void_attempts.clear()
    yield
    sync_common._void_attempts.clear()


async def _void_failed_events(db_session):
    result = await db_session.execute(select(OrderBoardEvent).where(OrderBoardEvent.kind == "order.void_failed"))
    return result.scalars().all()


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [ZohoUnreachable("down"), ZohoAmbiguous("502"), ZohoNotConfiguredError("no creds")])
async def test_a_transient_void_failure_keeps_the_draft_and_a_later_pass_voids_it(
    db_session, books, monkeypatch, void_attempts_reset, error
):
    sync_common._pending_voids["9"] = "SO-00009"
    real_void = zoho_service.void_salesorder

    async def void_down(db, salesorder_id):
        raise error

    monkeypatch.setattr(zoho_service, "void_salesorder", void_down)
    await sync.run_pass(db_session)
    assert sync_common._pending_voids == {"9": "SO-00009"}
    assert await _void_failed_events(db_session) == []

    monkeypatch.setattr(zoho_service, "void_salesorder", real_void)
    await sync.run_pass(db_session)
    assert books.voided == ["9"]
    assert sync_common._pending_voids == {}
    assert sync_common._void_attempts == {}
    assert await _void_failed_events(db_session) == []


@pytest.mark.asyncio
async def test_a_draft_is_given_up_at_the_attempt_cap_with_a_void_failed_event(
    db_session, books, monkeypatch, void_attempts_reset
):
    sync_common._pending_voids["9"] = "SO-00009"

    async def void_down(db, salesorder_id):
        raise ZohoUnreachable("down")

    monkeypatch.setattr(zoho_service, "void_salesorder", void_down)
    for _ in range(sync_common._VOID_ATTEMPT_CAP - 1):
        await sync.run_pass(db_session)
        assert sync_common._pending_voids == {"9": "SO-00009"}
        assert await _void_failed_events(db_session) == []
    await sync.run_pass(db_session)
    assert sync_common._pending_voids == {}
    assert sync_common._void_attempts == {}
    events = await _void_failed_events(db_session)
    assert [(e.salesorder_id, e.detail) for e in events] == [("9", {"order": "SO-00009"})]


@pytest.mark.asyncio
async def test_a_definitive_refusal_after_transient_failures_records_and_drops_at_once(
    db_session, books, monkeypatch, void_attempts_reset
):
    sync_common._pending_voids["9"] = "SO-00009"
    sync_common._void_attempts["9"] = 2

    async def void_refused(db, salesorder_id):
        raise ZohoRequestRejected("no")

    monkeypatch.setattr(zoho_service, "void_salesorder", void_refused)
    await sync.run_pass(db_session)
    assert sync_common._pending_voids == {}
    assert sync_common._void_attempts == {}
    assert len(await _void_failed_events(db_session)) == 1


@pytest.mark.asyncio
async def test_a_429_void_is_not_counted_as_an_attempt(db_session, books, monkeypatch, void_attempts_reset):
    sync_common._pending_voids["9"] = "SO-00009"

    async def void_429(db, salesorder_id):
        raise ZohoRateLimited("429", retry_after=30)

    monkeypatch.setattr(zoho_service, "void_salesorder", void_429)
    await sync.run_pass(db_session)
    assert sync_common._pending_voids == {"9": "SO-00009"}
    assert sync_common._void_attempts == {}
    assert await _void_failed_events(db_session) == []


@pytest.mark.asyncio
async def test_a_new_order_is_on_the_board_at_once_and_a_pass_keeps_one_copy(db_session, books):
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)  # the board is computed
    assert await actions.create_counter_order(db_session, "c1", [{"item_id": "A", "quantity": 1}], "r", by=None) == "9"
    row = await sync.find_board_row(db_session, "9")  # no pass in between
    assert (row["number"], row["units"]["shipped"], row["packed"]) == ("SO-00009", 0, 0)
    header = (await sync.find_stored(db_session, "9")).header
    assert (header["status"], header["quantity"], header["quantity_shipped"]) == ("open", 1, 0)
    await sync.run_pass(db_session)
    assert [d.zoho_id for d in await _docs(db_session)] == ["9"]
    after = await sync.find_board_row(db_session, "9")
    assert [(line["id"], line["remaining"]) for line in after["lines"]] == [("l9", 1.0)]


@pytest.mark.asyncio
async def test_a_failed_reread_leaves_the_create_header(db_session, books):
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    books.fail_detail_once = True
    await actions.create_counter_order(db_session, "c1", [{"item_id": "A", "quantity": 1}], "r", by=None)
    doc = await sync.find_stored(db_session, "9")
    assert (doc.header["status"], doc.pending) == ("open", True)
    assert await sync.find_board_row(db_session, "9") is None  # the next pass puts it on


async def _loaded_board(db):  # recompute does nothing before the first complete load
    loaded = {"stock_loaded_at": "2026-01-01T00:00:00+00:00", "computed_at": "2026-01-01T00:00:00+00:00", "rows": []}
    db.add(OrderBoardDoc(kind="state", zoho_id="board", header={}, detail=loaded))
    await db.commit()


@pytest.mark.asyncio
async def test_the_new_order_is_on_the_board_at_once(db_session, books, monkeypatch):
    await _loaded_board(db_session)
    real_create = zoho_service.create_salesorder

    async def create_with_quantities(db, payload):  # Books' create response is the whole order, quantities included
        return {**await real_create(db, payload), "quantity": 1, "quantity_shipped": 0}

    monkeypatch.setattr(zoho_service, "create_salesorder", create_with_quantities)
    await actions.create_counter_order(db_session, "c1", [{"item_id": "A", "quantity": 1}], "ref-board", by=None)
    assert (await sync.find_stored(db_session, "9")).header["status"] == "open"
    assert await sync.find_board_row(db_session, "9") is not None


@pytest.mark.asyncio
async def test_an_order_a_pass_stored_as_draft_is_confirmed_too(db_session, books):
    await _loaded_board(db_session)
    db_session.add(
        OrderBoardDoc(kind="salesorder", zoho_id="9", header={"status": "draft", "quantity": 1, "x": 1}, pending=False)
    )
    await db_session.commit()
    await actions.create_counter_order(db_session, "c1", [{"item_id": "A", "quantity": 1}], "ref-pass", by=None)
    assert (await sync.find_stored(db_session, "9")).header["status"] == "open"
    assert (await sync.find_stored(db_session, "9")).header["x"] == 1
    assert await sync.find_board_row(db_session, "9") is not None
