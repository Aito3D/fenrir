"""The Order Board's local Zoho copy and its bounded sync pass. Zoho is a
fake throughout: nothing here may reach Books."""

import asyncio
import time
from collections import Counter
from datetime import date, timedelta

import pytest
from sqlalchemy import select

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services import order_board_sync as sync
from backend.app.services.zoho import (
    ModifiedSinceRows,
    ZohoNotConfiguredError,
    ZohoService,
    ZohoUpstreamError,
    zoho_service,
)


def days_ago(n: int) -> str:
    return (date.today() - timedelta(days=n)).isoformat()


def order(
    n: int,
    *,
    age=5,
    status="open",
    qty=1,
    shipped=0,
    packed=0,
    item="A",
    invoices=(),
    estimate_id="",
    customer="c1",
    paid_status="unpaid",
    invoiced_status="not_invoiced",
) -> dict:
    """A sales-order detail document; the fake derives its list header from it."""
    return {
        "salesorder_id": f"so{n}",
        "salesorder_number": f"SO-{n:05d}",
        "customer_name": f"Customer {n}",
        "customer_id": customer,
        "paid_status": paid_status,
        "invoiced_status": invoiced_status,
        "date": days_ago(age),
        "status": status,
        "total": 1000.0,
        "currency_code": "XPF",
        "invoices": list(invoices),
        "estimate_id": estimate_id,
        "quantity": qty,
        "quantity_shipped": shipped,
        "quantity_packed": packed,
        "quantity_invoiced": 0,
        "last_modified_time": "2026-11-01T08:00:00-1000",
        "line_items": [
            {
                "line_item_id": f"l{n}",
                "item_id": item,
                "name": "Thing",
                "sku": "SKU",
                "quantity": qty,
                "quantity_shipped": shipped,
                "quantity_packed": packed,
                "quantity_cancelled": 0,
                "quantity_invoiced": 0,
            }
        ],
        "packages": [],
    }


def purchase(n: int, *, status="open", item="A", qty=5) -> dict:
    return {
        "purchaseorder_id": f"po{n}",
        "purchaseorder_number": f"PO-{n:04d}",
        "status": status,
        "billed_status": "to_be_billed",
        "received_status": "to_be_received",
        "quantity_yet_to_receive": qty,
        "last_modified_time": "2026-11-01T08:00:00-1000",
        "line_items": [
            {"item_id": item, "quantity": qty, "quantity_billed": 0, "quantity_received": 0, "quantity_cancelled": 0}
        ],
    }


class FakeZoho:
    def __init__(self):
        self.orders: dict[str, dict] = {}
        self.purchases: dict[str, dict] = {}
        self.stock: dict[str, float] = {"A": 100}
        self.calls: Counter = Counter()
        self.item_batches: list[list[str]] = []
        self.meter = 0
        self.configured = True
        self.fail: Exception | None = None
        self.slow = False
        self.payments: list[dict] = []
        self.payment_since: list[str] = []
        self.truncated = False
        self.fail_detail_once = False

    def add(self, *docs: dict):
        for doc in docs:
            if "salesorder_id" in doc:
                self.orders[doc["salesorder_id"]] = doc
            else:
                self.purchases[doc["purchaseorder_id"]] = doc

    async def list_salesorders(self, db):
        self.calls["list_so"] += 1
        if self.slow:
            await asyncio.sleep(0.05)
        if self.fail:
            raise self.fail
        return [{k: v for k, v in d.items() if k not in ("line_items", "packages")} for d in self.orders.values()]

    async def list_purchaseorders(self, db):
        self.calls["list_po"] += 1
        return [{k: v for k, v in d.items() if k != "line_items"} for d in self.purchases.values()]

    async def get_estimate(self, db, estimate_id):
        self.calls["estimate"] += 1
        return {"estimate_id": estimate_id, "estimate_number": f"DEV26-{estimate_id}"}

    async def get_salesorder(self, db, salesorder_id):
        self.calls["detail"] += 1
        if self.slow:
            await asyncio.sleep(0.05)
        if self.fail_detail_once:
            self.fail_detail_once = False
            raise ZohoUpstreamError("detail boom")
        return self.orders[salesorder_id]

    async def list_customer_payments_modified_since(self, db, since):
        self.calls["payments"] += 1
        self.payment_since.append(since)
        rows = ModifiedSinceRows(self.payments)
        rows.truncated = self.truncated
        return rows

    async def get_purchaseorder(self, db, purchaseorder_id):
        self.calls["detail"] += 1
        return self.purchases[purchaseorder_id]

    async def list_items_by_ids(self, db, item_ids):
        self.calls["items"] += 1
        self.item_batches.append(list(item_ids))
        return [
            {"item_id": i, "stock_on_hand": self.stock.get(i, 0), "brand": "eSUN", "track_inventory": True}
            for i in item_ids
        ]

    async def books_salesorder_url_base(self, db):
        return "https://books.example/app/1#/salesorders/"

    async def books_invoice_url(self, db, invoice_id):
        return "https://books.example/app/1#/invoices/" + invoice_id

    async def books_app_url(self, db, estimate_id):
        return "https://books.example/app/1#/quotes/" + estimate_id

    async def is_configured(self, db):
        return self.configured

    def calls_in_last_minute(self):
        return self.meter


@pytest.fixture(autouse=True)
def no_back_off_left_over():
    """The 429 back-off window is module state; one test must not hand it to the next."""
    sync._rate_limited_until = 0.0
    sync._unconfirmed.clear()
    sync._written_at.clear()
    yield
    sync._rate_limited_until = 0.0
    sync._unconfirmed.clear()
    sync._written_at.clear()


@pytest.fixture
def zoho(monkeypatch):
    fake = FakeZoho()
    for name in (
        "list_salesorders",
        "list_purchaseorders",
        "get_salesorder",
        "get_estimate",
        "get_purchaseorder",
        "list_items_by_ids",
        "list_customer_payments_modified_since",
        "books_salesorder_url_base",
        "books_invoice_url",
        "books_app_url",
        "is_configured",
        "calls_in_last_minute",
    ):
        monkeypatch.setattr(zoho_service, name, getattr(fake, name))
    return fake


@pytest.mark.asyncio
async def test_first_pass_is_bounded_and_computes_nothing_yet(db_session, zoho):
    zoho.add(*(order(n) for n in range(25)))
    assert await sync.run_pass(db_session) is True
    board = await sync.read_board(db_session)
    assert zoho.calls["detail"] == 20
    assert (board["computed_at"], board["rows"], board["sync"]["pending"]) == (None, [], 5)


@pytest.mark.asyncio
async def test_second_pass_finishes_and_computes(db_session, zoho):
    zoho.add(*(order(n) for n in range(25)), purchase(1))
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    board = await sync.read_board(db_session)
    assert board["sync"]["pending"] == 0
    assert board["computed_at"] and board["stock_loaded_at"] and board["sync"]["last_success_at"]
    assert len(board["rows"]) == 25
    assert board["rows"][0]["zoho_url"] == f"https://books.example/app/1#/salesorders/{board['rows'][0]['id']}"


@pytest.mark.asyncio
async def test_unchanged_headers_cost_no_detail_calls(db_session, zoho):
    zoho.add(order(1), purchase(1))
    await sync.run_pass(db_session)
    before = zoho.calls["detail"]
    await sync.run_pass(db_session)
    assert (before, zoho.calls["detail"]) == (2, 2)


@pytest.mark.asyncio
async def test_changed_header_is_refetched_and_the_board_follows(db_session, zoho):
    zoho.add(order(1, qty=2))
    await sync.run_pass(db_session)
    zoho.orders["so1"] = order(1, qty=2, packed=2)
    await sync.run_pass(db_session)
    board = await sync.read_board(db_session)
    assert zoho.calls["detail"] == 2
    assert board["rows"][0]["packed"] == 2


@pytest.mark.asyncio
async def test_stock_is_reread_every_pass(db_session, zoho):
    zoho.add(order(1, qty=3))
    zoho.stock["A"] = 0
    await sync.run_pass(db_session)
    assert (await sync.read_board(db_session))["rows"][0]["status"] == "to_order"
    zoho.stock["A"] = 3
    await sync.run_pass(db_session)
    assert (await sync.read_board(db_session))["rows"][0]["status"] == "to_ship"


@pytest.mark.asyncio
async def test_non_candidates_are_never_fetched(db_session, zoho):
    zoho.add(
        order(1, status="draft"),
        order(2, status="void"),
        order(3, qty=2, shipped=2),
        order(4, age=400),
        purchase(1, status="billed"),
        purchase(2, status="cancelled"),
    )
    await sync.run_pass(db_session)
    board = await sync.read_board(db_session)
    assert zoho.calls["detail"] == 0
    assert (board["rows"], board["sync"]["pending"]) == ([], 0)
    assert board["computed_at"]  # an empty board is still a computed one


@pytest.mark.asyncio
async def test_an_order_that_ships_completely_leaves_the_board(db_session, zoho):
    zoho.add(order(1, qty=2))
    await sync.run_pass(db_session)
    zoho.orders["so1"] = order(1, qty=2, shipped=2)
    await sync.run_pass(db_session)
    assert (await sync.read_board(db_session))["rows"] == []


@pytest.mark.asyncio
async def test_document_deleted_in_zoho_leaves_the_board(db_session, zoho):
    zoho.add(order(1), order(2))
    await sync.run_pass(db_session)
    del zoho.orders["so1"]
    await sync.run_pass(db_session)
    assert [r["id"] for r in (await sync.read_board(db_session))["rows"]] == ["so2"]
    kinds = (await db_session.execute(select(OrderBoardDoc.zoho_id).where(OrderBoardDoc.kind == "salesorder"))).all()
    assert [k[0] for k in kinds] == ["so2"]


@pytest.mark.asyncio
async def test_items_are_read_in_batches(db_session, zoho):
    zoho.add(*(order(n, item=f"I{n}") for n in range(120)))
    for _ in range(6):
        await sync.run_pass(db_session)
    last = zoho.item_batches[-3:]
    assert [len(b) for b in last] == [50, 50, 20]
    assert len({i for b in last for i in b}) == 120


@pytest.mark.asyncio
async def test_call_ceiling_stops_detail_fetches(db_session, zoho):
    zoho.add(order(1), order(2))
    zoho.meter = sync.CALL_CEILING
    await sync.run_pass(db_session)
    board = await sync.read_board(db_session)
    assert zoho.calls["detail"] == 0
    assert (board["sync"]["pending"], board["computed_at"]) == (2, None)


@pytest.mark.asyncio
async def test_zoho_error_keeps_the_last_board_and_records_the_reason(db_session, zoho):
    zoho.add(order(1))
    await sync.run_pass(db_session)
    good = await sync.read_board(db_session)
    zoho.fail = ZohoUpstreamError("boom")
    assert await sync.run_pass(db_session) is True
    board = await sync.read_board(db_session)
    assert board["rows"] == good["rows"] and board["computed_at"] == good["computed_at"]
    assert board["sync"]["last_error"] == "boom" and board["sync"]["last_error_at"]
    zoho.fail = None
    await sync.run_pass(db_session)
    assert (await sync.read_board(db_session))["sync"]["last_error"] is None


@pytest.mark.asyncio
async def test_unconfigured_zoho_is_recorded_not_raised(db_session, zoho):
    zoho.fail = ZohoNotConfiguredError("Zoho credentials are not configured")
    await sync.run_pass(db_session)
    assert (await sync.read_board(db_session))["sync"]["last_error"] == "Zoho credentials are not configured"


@pytest.mark.asyncio
async def test_concurrent_passes_run_once(db_session, zoho):
    zoho.add(order(1))
    zoho.slow = True
    results = await asyncio.gather(sync.run_pass(db_session), sync.run_pass(db_session))
    assert sorted(results) == [False, True]
    assert zoho.calls["list_so"] == 1


@pytest.mark.asyncio
async def test_settings_defaults_and_round_trip(db_session, zoho):
    defaults = await sync.load_settings(db_session)
    assert (defaults.sync_enabled, defaults.sync_minutes, defaults.max_age_days) == (True, 15, 365)
    assert defaults.core_brands == ["Bambu Lab", "eSUN", "SUNLU", "Polymaker", "Inslogic", "Magigoo"]
    await sync.save_settings(db_session, sync.OrderBoardSettings(False, 60, 30, ["Marlow"]))
    saved = await sync.load_settings(db_session)
    assert (saved.sync_enabled, saved.sync_minutes, saved.max_age_days, saved.core_brands) == (
        False,
        60,
        30,
        ["Marlow"],
    )


@pytest.mark.asyncio
async def test_lifting_the_age_limit_brings_old_orders_in_on_the_next_pass(db_session, zoho):
    zoho.add(order(1, age=400), order(2))
    await sync.run_pass(db_session)
    assert [r["id"] for r in (await sync.read_board(db_session))["rows"]] == ["so2"]
    current = await sync.load_settings(db_session)
    await sync.save_settings(db_session, sync.OrderBoardSettings(True, current.sync_minutes, 0, current.core_brands))
    await sync.run_pass(db_session)
    assert [r["id"] for r in (await sync.read_board(db_session))["rows"]] == ["so1", "so2"]


@pytest.mark.asyncio
async def test_changing_core_brands_recomputes_without_calling_zoho(db_session, zoho):
    zoho.add(order(1))
    await sync.run_pass(db_session)
    assert (await sync.read_board(db_session))["rows"][0]["is_core"] is True  # the fake's items are eSUN
    calls = sum(zoho.calls.values())
    current = await sync.load_settings(db_session)
    await sync.save_settings(db_session, sync.OrderBoardSettings(True, 15, current.max_age_days, ["Marlow"]))
    assert (await sync.read_board(db_session))["rows"][0]["is_core"] is False
    assert sum(zoho.calls.values()) == calls


@pytest.mark.asyncio
async def test_saving_settings_before_the_first_load_computes_nothing(db_session, zoho):
    await sync.save_settings(db_session, sync.OrderBoardSettings(True, 15, 365, ["eSUN"]))
    assert (await sync.read_board(db_session))["computed_at"] is None


@pytest.mark.asyncio
async def test_sync_block_reports_enabled_and_configured(db_session, zoho):
    board = await sync.read_board(db_session)
    assert (board["sync"]["enabled"], board["sync"]["configured"], board["sync"]["running"]) == (True, True, False)
    zoho.configured = False
    await sync.save_settings(db_session, sync.OrderBoardSettings(False, 15, 365, []))
    board = await sync.read_board(db_session)
    assert (board["sync"]["enabled"], board["sync"]["configured"]) == (False, False)


@pytest.mark.asyncio
async def test_lists_follow_every_page(db_session, monkeypatch):
    pages = {
        1: {"salesorders": [{"salesorder_id": "a"}], "page_context": {"has_more_page": True}},
        2: {"salesorders": [{"salesorder_id": "b"}], "page_context": {"has_more_page": False}},
    }
    seen = []

    async def fake_request(self, db, method, path, *, params=None, json=None):
        seen.append((method, path, params["page"], params["per_page"]))
        return pages[params["page"]]

    monkeypatch.setattr(ZohoService, "_request", fake_request)
    rows = await zoho_service.list_salesorders(db_session)
    assert [r["salesorder_id"] for r in rows] == ["a", "b"]
    assert seen == [("GET", "/salesorders", 1, 200), ("GET", "/salesorders", 2, 200)]


@pytest.mark.asyncio
async def test_items_are_requested_by_id(db_session, monkeypatch):
    async def fake_request(self, db, method, path, *, params=None, json=None):
        assert (method, path, params) == ("GET", "/items", {"item_ids": "1,2", "per_page": 200})
        return {"items": [{"item_id": "1"}, {"item_id": "2"}]}

    monkeypatch.setattr(ZohoService, "_request", fake_request)
    assert len(await zoho_service.list_items_by_ids(db_session, ["1", "2"])) == 2


async def _state_rows(db) -> int:
    return len((await db.execute(select(OrderBoardDoc).where(OrderBoardDoc.kind == "state"))).scalars().all())


@pytest.mark.asyncio
async def test_reading_the_board_writes_nothing(db_session, zoho):
    """The page polls this every few seconds, and two first reads can arrive
    together: a read that inserted the state row could collide with itself."""
    await sync.read_board(db_session)
    assert not db_session.new and not db_session.dirty
    await db_session.commit()
    assert await _state_rows(db_session) == 0


@pytest.mark.asyncio
async def test_saving_settings_before_the_first_load_creates_no_state_row(db_session, zoho):
    await sync.save_settings(db_session, sync.OrderBoardSettings(True, 15, 365, ["eSUN"]))
    assert await _state_rows(db_session) == 0


# --- the loop: when the next pass runs ---


@pytest.fixture
def passes(monkeypatch):
    calls = []

    async def fake_pass(db):
        calls.append(db)
        return True

    monkeypatch.setattr(sync, "run_pass", fake_pass)
    return calls


@pytest.mark.asyncio
async def test_iteration_skips_the_pass_and_rechecks_soon_when_sync_is_off(db_session, zoho, passes):
    await sync.save_settings(db_session, sync.OrderBoardSettings(False, 60, 365, []))
    assert await sync._iteration(db_session) == sync.PENDING_PAUSE_SECONDS  # not a whole hour
    assert passes == []


@pytest.mark.asyncio
async def test_iteration_rechecks_soon_when_zoho_is_not_connected(db_session, zoho, passes):
    zoho.configured = False
    assert await sync._iteration(db_session) == sync.PENDING_PAUSE_SECONDS
    assert passes == []


@pytest.mark.asyncio
async def test_iteration_waits_the_interval_once_caught_up(db_session, zoho, passes):
    await sync.save_settings(db_session, sync.OrderBoardSettings(True, 5, 365, []))
    assert await sync._iteration(db_session) == 5 * 60
    assert len(passes) == 1


@pytest.mark.asyncio
async def test_iteration_comes_back_in_a_minute_while_documents_are_pending(db_session, zoho):
    zoho.add(*(order(n) for n in range(25)))
    assert await sync._iteration(db_session) == sync.PENDING_PAUSE_SECONDS


class _NoSession:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


@pytest.mark.asyncio
async def test_saving_settings_wakes_the_loop_instead_of_waiting_out_the_interval(db_session, zoho, monkeypatch):
    """Turning sync on, or raising the age limit, must not show a loading page
    for up to an hour while nothing runs."""
    turns = []

    async def fake_iteration(db):
        turns.append(1)
        return 3600.0

    monkeypatch.setattr(sync, "_iteration", fake_iteration)
    monkeypatch.setattr(sync, "async_session", _NoSession)
    loop_task = asyncio.create_task(sync.run_loop())
    try:
        await asyncio.sleep(0.05)
        assert len(turns) == 1
        await sync.save_settings(db_session, sync.OrderBoardSettings(True, 15, 365, []))
        await asyncio.sleep(0.05)
        assert len(turns) == 2
    finally:
        loop_task.cancel()
        await asyncio.gather(loop_task, return_exceptions=True)


@pytest.mark.asyncio
async def test_a_loop_turn_that_raises_does_not_end_the_loop(monkeypatch):
    turns = []

    async def failing_iteration(db):
        turns.append(1)
        raise RuntimeError("database is locked")

    monkeypatch.setattr(sync, "_iteration", failing_iteration)
    monkeypatch.setattr(sync, "async_session", _NoSession)
    monkeypatch.setattr(sync, "PENDING_PAUSE_SECONDS", 0.01)
    loop_task = asyncio.create_task(sync.run_loop())
    try:
        await asyncio.sleep(0.1)
        assert len(turns) >= 2
    finally:
        loop_task.cancel()
        await asyncio.gather(loop_task, return_exceptions=True)


@pytest.mark.asyncio
async def test_refresh_during_a_zoho_back_off_sends_nothing(db_session, zoho):
    """Books said "not now" (429). A Refresh click must not send another call:
    the Kanban shares that budget and freezes while Books is throttling."""
    from backend.app.services.zoho import ZohoRateLimited

    zoho.add(order(1))
    zoho.fail = ZohoRateLimited("rate limited", retry_after=120)
    await sync.run_pass(db_session)
    zoho.fail = None
    before = sum(zoho.calls.values())
    assert await sync.run_pass(db_session) is False
    assert sum(zoho.calls.values()) == before
    sync._rate_limited_until = 0.0  # the window has passed
    assert await sync.run_pass(db_session) is True
    assert sum(zoho.calls.values()) > before


@pytest.mark.asyncio
async def test_the_loop_leaves_a_low_daily_budget_to_the_kanban(db_session, zoho, passes, monkeypatch):
    """Books also caps calls per day. When little is left, the board's own
    cadence stops (as the Kanban's change pass does) so quotes still sync."""
    monkeypatch.setattr(zoho_service, "daily_remaining", sync.DAILY_BUDGET_FLOOR - 1)
    assert await sync._iteration(db_session) == 15 * 60
    assert passes == []
    monkeypatch.setattr(zoho_service, "daily_remaining", sync.DAILY_BUDGET_FLOOR)
    await sync._iteration(db_session)
    assert len(passes) == 1


@pytest.mark.asyncio
async def test_rows_get_their_links(db_session, zoho):
    invoice = {"invoice_id": "i1", "invoice_number": "INV-1", "total": 400.0, "balance": 400.0, "status": "sent"}
    zoho.add(order(1, invoices=[invoice], estimate_id="e1"), order(2))
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    rows = {r["id"]: r for r in (await sync.read_board(db_session))["rows"]}
    assert rows["so1"]["payment"]["invoices"][0]["url"].endswith("#/invoices/i1")
    assert rows["so1"]["facts"]["quote_url"].endswith("#/quotes/e1")
    assert rows["so2"]["facts"]["quote_url"] is None


async def _doc(db, zoho_id):
    return (await db.execute(select(OrderBoardDoc).where(OrderBoardDoc.zoho_id == zoho_id))).scalar_one()


PAYMENT_C1 = {"id": "p1", "customer_id": "c1", "last_modified_time": "2026-11-05T09:00:00-1000"}


@pytest.mark.asyncio
async def test_first_pass_polls_nothing_and_later_passes_poll_once(db_session, zoho):
    zoho.add(order(1))
    await sync.run_pass(db_session)
    assert zoho.calls["payments"] == 0
    await sync.run_pass(db_session)
    assert zoho.calls["payments"] == 1


@pytest.mark.asyncio
async def test_a_customer_payment_refetches_that_customers_open_orders_only(db_session, zoho):
    zoho.add(order(1, customer="c1"), order(2, customer="c2"))
    await sync.run_pass(db_session)
    details = zoho.calls["detail"]
    zoho.payments = [PAYMENT_C1]
    await sync.run_pass(db_session)
    assert zoho.calls["detail"] == details + 1


@pytest.mark.asyncio
async def test_an_upgraded_install_refetches_every_open_order_once(db_session, zoho):
    zoho.add(order(1), order(2, customer="c2"), order(3, customer="c3"))
    await sync.run_pass(db_session)
    state = await sync._find_state(db_session)
    state.detail = {k: v for k, v in state.detail.items() if k != "payments_since"}
    await db_session.commit()
    before = zoho.calls["detail"]
    await sync.run_pass(db_session)
    assert zoho.calls["detail"] == before + 3
    await sync.run_pass(db_session)
    assert zoho.calls["detail"] == before + 3


@pytest.mark.asyncio
async def test_a_truncated_payment_poll_refetches_every_open_order(db_session, zoho):
    zoho.add(order(1), order(2, customer="c2"))
    await sync.run_pass(db_session)
    before = zoho.calls["detail"]
    zoho.truncated = True
    await sync.run_pass(db_session)
    assert zoho.calls["detail"] == before + 2
    zoho.truncated = False
    await sync.run_pass(db_session)
    assert zoho.calls["detail"] == before + 2


@pytest.mark.asyncio
async def test_a_paid_status_change_alone_refetches(db_session, zoho):
    zoho.add(order(1))
    await sync.run_pass(db_session)
    zoho.orders["so1"]["paid_status"] = "paid"
    await sync.run_pass(db_session)
    assert zoho.calls["detail"] == 2


@pytest.mark.asyncio
async def test_every_stored_detail_says_when_it_was_fetched(db_session, zoho):
    zoho.add(order(1), purchase(1))
    await sync.run_pass(db_session)
    assert (await _doc(db_session, "so1")).detail["_fetched_at"]
    assert (await _doc(db_session, "po1")).detail["_fetched_at"]


@pytest.mark.asyncio
async def test_an_order_that_ships_completely_keeps_its_detail_and_costs_no_stock_read(db_session, zoho):
    zoho.add(order(1, item="B", qty=2), order(2, item="A"))
    await sync.run_pass(db_session)
    zoho.orders["so1"] = order(1, item="B", qty=2, shipped=2)
    await sync.run_pass(db_session)
    doc = await _doc(db_session, "so1")
    assert doc.detail is not None and doc.pending is False
    assert [r["id"] for r in (await sync.read_board(db_session))["rows"]] == ["so2"]
    assert "B" not in zoho.item_batches[-1]


@pytest.mark.asyncio
async def test_a_payment_marks_a_finished_orders_detail_stale(db_session, zoho):
    zoho.add(order(1, qty=2))
    await sync.run_pass(db_session)
    zoho.orders["so1"] = order(1, qty=2, shipped=2)
    await sync.run_pass(db_session)
    details = zoho.calls["detail"]
    zoho.payments = [PAYMENT_C1]
    await sync.run_pass(db_session)
    doc = await _doc(db_session, "so1")
    assert doc.detail["_stale"] is True and doc.pending is False
    assert zoho.calls["detail"] == details


@pytest.mark.asyncio
async def test_a_failed_pass_after_the_poll_does_not_mark_orders_twice(db_session, zoho):
    zoho.add(order(1))
    await sync.run_pass(db_session)
    before = zoho.calls["detail"]
    zoho.payments = [PAYMENT_C1]
    zoho.fail_detail_once = True
    await sync.run_pass(db_session)  # polls, marks, then the fetch fails
    zoho.payments = []  # Books no longer returns it: the watermark moved past it with the marks
    await sync.run_pass(db_session)  # the mark survived the failure: refetched once
    await sync.run_pass(db_session)
    assert zoho.calls["detail"] == before + 2  # the failed attempt and one refetch
    assert (await _doc(db_session, "so1")).pending is False


async def _synced(db, zoho, *docs):
    zoho.add(*docs)
    await sync.run_pass(db)
    await sync.run_pass(db)


@pytest.mark.asyncio
async def test_finished_list_is_newest_first_and_costs_no_zoho_call(db_session, zoho):
    await _synced(
        db_session,
        zoho,
        order(1, age=10, shipped=1, paid_status="paid"),
        order(2, age=3, shipped=1, paid_status="partially_paid"),
        order(3),
    )
    before = sum(zoho.calls.values())
    rows = (await sync.read_finished(db_session))["rows"]
    assert [r["id"] for r in rows] == ["so2", "so1"]
    assert [r["paid_flag"] for r in rows] == ["partial", "paid"]
    assert rows[0]["number"] == "SO-00002" and rows[0]["customer"] == "Customer 2" and rows[0]["total"] == 1000.0
    assert rows[0]["currency"] == "XPF" and rows[0]["reference"] == "" and rows[0]["payment"] is None
    assert rows[0]["zoho_url"] == "https://books.example/app/1#/salesorders/so2"
    assert sum(zoho.calls.values()) == before


@pytest.mark.asyncio
async def test_a_fully_shipped_order_older_than_the_age_limit_is_listed(db_session, zoho):
    await _synced(db_session, zoho, order(1, age=400, shipped=1))
    assert [r["id"] for r in (await sync.read_finished(db_session))["rows"]] == ["so1"]


@pytest.mark.asyncio
async def test_an_unshipped_order_older_than_the_age_limit_is_not_listed(db_session, zoho):
    await _synced(db_session, zoho, order(1, age=400))
    assert (await sync.read_finished(db_session))["rows"] == []


@pytest.mark.asyncio
async def test_opening_a_finished_order_fetches_once_then_serves_the_copy(db_session, zoho):
    await _synced(db_session, zoho, order(1, age=10, shipped=1))
    before = zoho.calls["detail"]
    row = await sync.read_finished_order(db_session, "so1")
    assert row["status"] == "finished" and row["zoho_url"]
    assert zoho.calls["detail"] == before + 1
    assert (await _doc(db_session, "so1")).detail["_fetched_at"]
    await sync.read_finished_order(db_session, "so1")
    assert zoho.calls["detail"] == before + 1
    # With a copy stored, the list shows its payment.
    assert (await sync.read_finished(db_session))["rows"][0]["payment"] is not None


@pytest.mark.asyncio
async def test_a_pos_order_with_a_quote_gets_its_quote_number_once_and_a_shopify_link(db_session, zoho):
    """The reference is the Shopify order number and Books holds the quote's number: read once, then kept."""
    pos = {**order(1, estimate_id="e1"), "reference_number": "1102"}
    shop = {
        **order(2),
        "reference_number": "1091",
        "sales_channel_formatted": "Shopify",
        "account_identifier": "ab12-3",
    }
    converted = {**order(3, estimate_id="e3"), "reference_number": "DEV26-2948"}
    await _synced(db_session, zoho, pos, shop, converted)
    assert zoho.calls["estimate"] == 1  # the converted order's reference already is its quote number
    rows = {r["id"]: r["facts"] for r in (await sync.read_board(db_session))["rows"]}
    assert rows["so1"]["quote_number"] == "DEV26-e1" and rows["so1"]["shopify_order"] == "1102"
    assert rows["so1"]["shopify_url"] == "https://admin.shopify.com/store/ab12-3/orders?query=1102"
    assert rows["so2"]["shopify_order"] == "1091" and rows["so2"]["quote_number"] == ""
    assert rows["so3"]["quote_number"] == "DEV26-2948" and rows["so3"]["shopify_order"] == ""
    await sync.run_pass(db_session)
    assert zoho.calls["estimate"] == 1


@pytest.mark.asyncio
async def test_a_changed_list_row_or_a_stale_mark_refetches_on_open(db_session, zoho):
    await _synced(db_session, zoho, order(1, age=10, shipped=1))
    await sync.read_finished_order(db_session, "so1")
    calls = zoho.calls["detail"]
    # The list row moved on: refetch.
    zoho.orders["so1"] = {**order(1, age=10, shipped=1), "last_modified_time": "2026-11-04T08:00:00-1000"}
    await sync.run_pass(db_session)
    assert (await sync.read_finished(db_session))["rows"][0]["payment"] is None  # copy is out of date
    await sync.read_finished_order(db_session, "so1")
    assert zoho.calls["detail"] == calls + 1
    await sync.read_finished_order(db_session, "so1")
    assert zoho.calls["detail"] == calls + 1
    # A payment marks it stale: refetch, and the mark is cleared.
    zoho.payments = [PAYMENT_C1]
    await sync.run_pass(db_session)
    assert (await _doc(db_session, "so1")).detail["_stale"] is True
    await sync.read_finished_order(db_session, "so1")
    assert zoho.calls["detail"] == calls + 2
    assert "_stale" not in (await _doc(db_session, "so1")).detail


@pytest.mark.asyncio
async def test_opening_during_a_back_off_raises_busy_and_sends_nothing(db_session, zoho):
    await _synced(db_session, zoho, order(1, age=10, shipped=1))
    before = sum(zoho.calls.values())
    sync._rate_limited_until = time.monotonic() + 60
    with pytest.raises(sync.ZohoBusy):
        await sync.read_finished_order(db_session, "so1")
    sync._rate_limited_until = 0.0
    zoho.meter = sync.CALL_CEILING
    with pytest.raises(sync.ZohoBusy):
        await sync.read_finished_order(db_session, "so1")
    assert sum(zoho.calls.values()) == before


@pytest.mark.asyncio
async def test_a_rate_limited_open_opens_the_back_off_window(db_session, zoho, monkeypatch):
    from backend.app.services.zoho import ZohoRateLimited

    await _synced(db_session, zoho, order(1, age=10, shipped=1))

    async def limited(db, salesorder_id):
        raise ZohoRateLimited("slow down", retry_after=90)

    monkeypatch.setattr(zoho_service, "get_salesorder", limited)
    with pytest.raises(sync.ZohoBusy):
        await sync.read_finished_order(db_session, "so1")
    assert sync._rate_limited_until > time.monotonic()


@pytest.mark.asyncio
async def test_opening_an_open_or_unknown_order_is_not_found(db_session, zoho):
    await _synced(db_session, zoho, order(1), order(2, age=5, shipped=1))
    for missing in ("so1", "nope"):
        with pytest.raises(sync.OrderNotFinished):
            await sync.read_finished_order(db_session, missing)


@pytest.mark.asyncio
async def test_a_stale_mark_set_while_the_fetch_was_in_flight_survives_it(db_session, zoho, monkeypatch):
    """Simulated with the same session (the in-memory test database has one connection): the fake
    marks the stored detail stale while the Zoho call is running, as a concurrent pass would."""
    await _synced(db_session, zoho, order(1, age=10, shipped=1))
    await sync.read_finished_order(db_session, "so1")
    zoho.orders["so1"] = {**order(1, age=10, shipped=1), "last_modified_time": "2026-11-04T08:00:00-1000"}
    await sync.run_pass(db_session)  # the stored copy is now out of date: the next open fetches
    real = zoho.get_salesorder

    async def marked_meanwhile(db, salesorder_id):
        doc = await _doc(db, salesorder_id)
        doc.detail = {**doc.detail, "_stale": True}
        await db.commit()
        return await real(db, salesorder_id)

    monkeypatch.setattr(zoho_service, "get_salesorder", marked_meanwhile)
    calls = zoho.calls["detail"]
    row = await sync.read_finished_order(db_session, "so1")
    assert row["status"] == "finished"
    assert (await _doc(db_session, "so1")).detail["_stale"] is True
    monkeypatch.setattr(zoho_service, "get_salesorder", real)
    await sync.read_finished_order(db_session, "so1")
    assert zoho.calls["detail"] == calls + 2
    assert "_stale" not in (await _doc(db_session, "so1")).detail


@pytest.mark.asyncio
async def test_a_new_order_fetched_by_a_failed_pass_is_not_finished(db_session, zoho, monkeypatch):
    await _synced(db_session, zoho, order(1))
    zoho.add(order(2))
    real_items = zoho.list_items_by_ids

    async def boom(db, item_ids):
        raise ZohoUpstreamError("stock boom")

    monkeypatch.setattr(zoho_service, "list_items_by_ids", boom)
    await sync.run_pass(db_session)  # fetches and commits so2's detail, then fails before recompute
    assert (await _doc(db_session, "so2")).detail is not None
    assert (await sync.read_finished(db_session))["rows"] == []
    with pytest.raises(sync.OrderNotFinished):
        await sync.read_finished_order(db_session, "so2")
    monkeypatch.setattr(zoho_service, "list_items_by_ids", real_items)
    await sync.run_pass(db_session)
    assert {r["id"] for r in (await sync.read_board(db_session))["rows"]} == {"so1", "so2"}
    assert (await sync.read_finished(db_session))["rows"] == []


@pytest.fixture
async def file_sessions(tmp_path):
    """Two sessions must not share one in-memory connection: a file database."""
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

    from backend.app.core.database import Base, load_all_models

    load_all_models()
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'orders.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    await engine.dispose()


@pytest.mark.asyncio
async def test_operators_opening_the_same_finished_order_together_share_one_fetch(file_sessions, zoho):
    async with file_sessions() as db:
        await _synced(db, zoho, order(1, age=10, shipped=1))
    before = zoho.calls["detail"]
    zoho.slow = True

    async def open_order():
        async with file_sessions() as db:
            return await sync.read_finished_order(db, "so1")

    rows = await asyncio.gather(open_order(), open_order(), open_order())
    assert zoho.calls["detail"] == before + 1
    assert all(r["status"] == "finished" for r in rows)


async def _return(value):
    return value


@pytest.mark.asyncio
async def test_a_pass_does_not_store_a_copy_fetched_before_a_write(file_sessions, zoho, monkeypatch):
    """The pass's get is parked while refresh_order (another session) stores a newer detail."""
    async with file_sessions() as passing, file_sessions() as writing:
        await _synced(passing, zoho, order(1))
        old = order(1)
        zoho.orders["so1"] = {**old, "last_modified_time": "2026-11-02T08:00:00-1000"}  # list row moves on
        gate, parked = asyncio.Event(), asyncio.Event()

        async def parked_get(db, salesorder_id):
            parked.set()
            await gate.wait()
            return old

        monkeypatch.setattr(zoho_service, "get_salesorder", parked_get)
        running = asyncio.create_task(sync.run_pass(passing))
        await parked.wait()
        newer = {**old, "status": "confirmed", "reference_number": "NEWER"}
        monkeypatch.setattr(zoho_service, "get_salesorder", lambda db, i: _return(newer))
        await sync.refresh_order(writing, "so1")
        gate.set()
        await running
        doc = await _doc(writing, "so1")
        await writing.refresh(doc)
        assert doc.detail["reference_number"] == "NEWER"
        assert doc.pending is True


@pytest.mark.asyncio
async def test_a_pass_does_not_revert_an_order_refreshed_meanwhile_that_it_never_fetched(
    file_sessions, zoho, monkeypatch
):
    async with file_sessions() as passing, file_sessions() as writing:
        await _synced(passing, zoho, order(1), order(2))
        zoho.orders["so2"] = {**order(2), "last_modified_time": "2026-11-02T08:00:00-1000"}
        gate, parked = asyncio.Event(), asyncio.Event()
        real = zoho.get_salesorder

        async def parked_get(db, salesorder_id):
            parked.set()
            await gate.wait()
            return await real(db, salesorder_id)

        monkeypatch.setattr(zoho_service, "get_salesorder", parked_get)
        running = asyncio.create_task(sync.run_pass(passing))
        await parked.wait()
        monkeypatch.setattr(zoho_service, "get_salesorder", lambda db, i: _return(order(1, qty=3)))
        await sync.refresh_order(writing, "so1")
        gate.set()
        await running
        rows = {r["id"]: r for r in (await sync.read_board(writing))["rows"]}
        assert rows["so1"]["lines"][0]["quantity"] == 3


@pytest.mark.asyncio
async def test_a_write_that_begins_while_a_pass_stores_its_copy_leaves_the_order_pending(db_session, zoho, monkeypatch):
    """The write starts after the pass's newer-write check but before its commit lands."""
    await _synced(db_session, zoho, order(1))
    zoho.orders["so1"] = {**order(1), "last_modified_time": "2026-11-02T08:00:00-1000"}
    real_commit, fetched = db_session.commit, []
    real_get = zoho.get_salesorder

    async def get(db, salesorder_id):
        fetched.append(salesorder_id)
        return await real_get(db, salesorder_id)

    async def commit():
        if fetched == ["so1"]:
            fetched.append("written")
            sync.note_write("so1")  # a hand-over starts right now
        await real_commit()

    monkeypatch.setattr(zoho_service, "get_salesorder", get)
    monkeypatch.setattr(db_session, "commit", commit)
    await sync.run_pass(db_session)
    doc = (
        await db_session.execute(
            select(OrderBoardDoc).where(OrderBoardDoc.kind == "salesorder", OrderBoardDoc.zoho_id == "so1")
        )
    ).scalar_one()
    assert fetched == ["so1", "written"]
    assert doc.pending is True
