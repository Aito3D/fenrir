"""The Order Board's local Zoho copy and its bounded sync pass. Zoho is a
fake throughout: nothing here may reach Books."""

import asyncio
from collections import Counter
from datetime import date, timedelta

import pytest
from sqlalchemy import select

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services import order_board_sync as sync
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoService, ZohoUpstreamError, zoho_service


def days_ago(n: int) -> str:
    return (date.today() - timedelta(days=n)).isoformat()


def order(n: int, *, age=5, status="open", qty=1, shipped=0, packed=0, item="A") -> dict:
    """A sales-order detail document; the fake derives its list header from it."""
    return {
        "salesorder_id": f"so{n}",
        "salesorder_number": f"SO-{n:05d}",
        "customer_name": f"Customer {n}",
        "date": days_ago(age),
        "status": status,
        "total": 1000.0,
        "currency_code": "XPF",
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

    async def get_salesorder(self, db, salesorder_id):
        self.calls["detail"] += 1
        return self.orders[salesorder_id]

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

    async def is_configured(self, db):
        return self.configured

    def calls_in_last_minute(self):
        return self.meter


@pytest.fixture(autouse=True)
def no_back_off_left_over():
    """The 429 back-off window is module state; one test must not hand it to the next."""
    sync._rate_limited_until = 0.0
    yield
    sync._rate_limited_until = 0.0


@pytest.fixture
def zoho(monkeypatch):
    fake = FakeZoho()
    for name in (
        "list_salesorders",
        "list_purchaseorders",
        "get_salesorder",
        "get_purchaseorder",
        "list_items_by_ids",
        "books_salesorder_url_base",
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
