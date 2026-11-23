"""Port of loki's revenue-sync.test.ts plus the pacing and failure cases; Zoho is mocked, nothing waits in real time."""

import asyncio
from datetime import datetime, timezone

import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.core import database
from backend.app.core.database import Base, _set_sqlite_pragmas, load_all_models
from backend.app.services.revenue import store, sync
from backend.app.services.revenue.config import SYNC
from backend.app.services.revenue.series import RevenueLine
from backend.app.services.zoho import (
    ZohoAmbiguous,
    ZohoNotConfiguredError,
    ZohoNotFound,
    ZohoRateLimited,
    ZohoRequestRejected,
    ZohoUpstreamError,
    zoho_service,
)

TODAY = "2026-10-15"


class FakeZoho:
    def __init__(self):
        self.sales_calls: list[tuple[str, int]] = []
        self.contact_calls: list[str] = []
        self.item_pages: list[int] = []
        self.range_calls: list[tuple[str, str, int]] = []
        self.range_rows = self.default_range
        self.sales = self.default_sales
        self.contact = self.default_contact
        self.items = self.default_items
        self.configured = True
        self.cash_calls: list[tuple] = []
        self.payment_pages = self.default_pages
        self.unpaid_pages = self.default_pages
        self.payment_detail = self.default_detail
        self.invoice_detail = self.default_detail

    async def default_pages(self, key, page):
        return [], False

    async def default_detail(self, doc_id):
        return {}

    async def list_customer_payments_page(self, db, since, page):
        self.cash_calls.append(("payments", since, page))
        return await self.payment_pages(since, page)

    async def list_unpaid_invoices_page(self, db, status, page):
        self.cash_calls.append(("unpaid", status, page))
        return await self.unpaid_pages(status, page)

    async def get_customer_payment(self, db, payment_id):
        self.cash_calls.append(("payment", payment_id))
        return await self.payment_detail(payment_id)

    async def get_invoice_raw(self, db, invoice_id):
        self.cash_calls.append(("invoice", invoice_id))
        return await self.invoice_detail(invoice_id)

    async def default_sales(self, day, page):
        return [], False

    async def default_contact(self, contact_id):
        raise ZohoNotFound("Not found in Zoho Books")

    async def default_items(self, page):
        return [], False

    async def default_range(self, from_date, to_date, page):
        return [], False

    async def sales_by_item_range(self, db, from_date, to_date, page):
        self.range_calls.append((from_date, to_date, page))
        return await self.range_rows(from_date, to_date, page)

    async def is_configured(self, db):
        return self.configured

    async def sales_by_item_by_customer(self, db, day, page):
        self.sales_calls.append((day, page))
        return await self.sales(day, page)

    async def get_contact(self, db, contact_id):
        self.contact_calls.append(contact_id)
        return await self.contact(contact_id)

    async def list_items_page_all(self, db, page):
        self.item_pages.append(page)
        return await self.items(page)


@pytest.fixture
async def engine(tmp_path, monkeypatch):
    load_all_models()
    eng = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'revenue.db'}")
    event.listen(eng.sync_engine, "connect", _set_sqlite_pragmas)
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(database, "engine", eng)
    monkeypatch.setattr(database, "async_session", async_sessionmaker(eng, expire_on_commit=False))
    yield eng
    await eng.dispose()


@pytest.fixture
def sleeps(monkeypatch):
    calls: list[float] = []

    async def fake_sleep(s):
        calls.append(s)
        await asyncio.sleep(0)

    monkeypatch.setattr(sync, "_sleep", fake_sleep)
    return calls


@pytest.fixture
def zoho(engine, sleeps, monkeypatch):
    fake = FakeZoho()
    for name in (
        "sales_by_item_by_customer",
        "get_contact",
        "list_items_page_all",
        "sales_by_item_range",
        "list_customer_payments_page",
        "list_unpaid_invoices_page",
        "get_customer_payment",
        "get_invoice_raw",
    ):
        monkeypatch.setattr(zoho_service, name, getattr(fake, name))
    monkeypatch.setattr(zoho_service, "calls_in_last_minute", lambda: 0)
    monkeypatch.setattr(zoho_service, "daily_remaining", None)
    monkeypatch.setattr(zoho_service, "is_configured", fake.is_configured)
    monkeypatch.setattr(sync, "org_today", lambda now=None: TODAY)
    monkeypatch.setattr(sync, "REVENUE_HISTORY_START", "2026-10-01")
    sync.reset_revenue_sync_state_for_tests()
    yield fake
    sync.reset_revenue_sync_state_for_tests()


async def day_index(engine):
    async with store.snapshot(engine) as conn:
        return await store.read_day_index(conn)


async def lines(engine, day):
    async with store.snapshot(engine) as conn:
        return await store.read_lines(conn, day, day)


async def status(engine):
    async with store.snapshot(engine) as conn:
        return await sync.get_revenue_sync_status(conn, datetime.now(timezone.utc))


def group(customer_id, *rows):
    return {"group_name": customer_id, "sales": list(rows)}


ROW_A = {"item_id": "i1", "item_name": "A", "quantity_sold": 1, "amount": 1034, "item": {"sku": ""}}


# ── ported from revenue-sync.test.ts ─────────────────────────────────────────


async def test_fetches_one_batch_of_missing_days_newest_first_one_report_call_per_day_and_reports_pending(zoho, engine):
    async def sales(day, page):
        return ([group("c1", ROW_A)] if day == TODAY else []), False

    zoho.sales = sales
    r = await sync.run_revenue_sync_batch()
    assert r["fetched"] == 10
    assert r["days"][0] == TODAY
    assert r["pending"] == 5
    assert len(zoho.sales_calls) == 10
    assert (TODAY, 1) in zoho.sales_calls
    assert await lines(engine, TODAY) == [RevenueLine(TODAY, "i1", "c1", "A", "", 1, 1034)]
    assert zoho.contact_calls == ["c1"]
    assert r["customers"] == 1
    idx = {d.day: d for d in await day_index(engine)}
    assert idx[TODAY].closed is False
    assert idx["2026-10-14"].closed is True


async def test_a_second_batch_finishes_the_back_fill_and_a_third_has_nothing_to_do(zoho):
    await sync.run_revenue_sync_batch()
    r2 = await sync.run_revenue_sync_batch()
    assert r2["fetched"] == 5
    assert r2["pending"] == 0
    r3 = await sync.run_revenue_sync_batch()
    assert r3["fetched"] == 0
    assert len(zoho.sales_calls) == 15


async def test_writes_every_day_that_succeeded_before_a_failing_one_records_last_error_and_rethrows(zoho, engine):
    async def sales(day, page):
        if len(zoho.sales_calls) == 3:
            raise ZohoRateLimited("Zoho Books error (HTTP 429)")
        return [], False

    zoho.sales = sales
    with pytest.raises(ZohoRateLimited):
        await sync.run_revenue_sync_batch()
    assert [d.day for d in await day_index(engine)] == ["2026-10-14", "2026-10-15"]
    assert (await status(engine))["lastError"] == "Zoho Books error (HTTP 429)"
    zoho.sales = zoho.default_sales
    await sync.run_revenue_sync_batch()
    assert (await status(engine))["lastError"] is None


async def test_hides_a_non_app_error_message_from_last_error(zoho, engine):
    async def sales(day, page):
        raise ConnectionRefusedError("connect ECONNREFUSED 10.0.0.1:443")

    zoho.sales = sales
    with pytest.raises(ConnectionRefusedError):
        await sync.run_revenue_sync_batch()
    assert (await status(engine))["lastError"] == "ConnectionRefusedError"


async def test_full_true_clears_the_cache_first_and_rebuilds_from_scratch(zoho, engine):
    async with database.async_session() as db:
        await store.write_day(
            db, "2026-10-10", [RevenueLine("2026-10-10", "x", "", "X", "", 1, 1)], True, datetime.now(timezone.utc), 2
        )
    await sync.run_revenue_sync_batch(full=True)
    assert await lines(engine, "2026-10-10") == []
    assert ("2026-10-10", 1) in zoho.sales_calls


async def _seed_day(day):
    async with database.async_session() as db:
        await store.write_day(db, day, [RevenueLine(day, "x", "", "X", "", 1, 1)], True, datetime.now(timezone.utc), 2)


async def test_full_rebuild_is_refused_and_keeps_the_cache_when_the_daily_budget_is_low(zoho, engine, monkeypatch):
    await _seed_day("2026-10-10")
    monkeypatch.setattr(zoho_service, "daily_remaining", SYNC.daily_budget_floor - 1)
    with pytest.raises(sync.RevenueRebuildRefused, match="budget"):
        await sync.run_revenue_sync_batch(full=True)
    assert len(await lines(engine, "2026-10-10")) == 1
    assert zoho.sales_calls == []


async def test_full_rebuild_is_refused_and_keeps_the_cache_when_zoho_is_not_configured(zoho, engine):
    await _seed_day("2026-10-10")
    zoho.configured = False
    with pytest.raises(sync.RevenueRebuildRefused, match="not configured"):
        await sync.run_revenue_sync_batch(full=True)
    assert len(await lines(engine, "2026-10-10")) == 1
    assert zoho.sales_calls == []


async def test_a_day_whose_org_day_ends_during_its_fetch_is_stored_open(zoho, engine, monkeypatch):
    today = {"v": TODAY}
    monkeypatch.setattr(sync, "org_today", lambda now=None: today["v"])

    async def sales(day, page):
        if day == TODAY:
            today["v"] = "2026-10-16"
        return [], False

    zoho.sales = sales
    await sync.run_revenue_sync_batch()
    idx = {d.day: d for d in await day_index(engine)}
    assert idx[TODAY].closed is False


async def test_concurrent_callers_share_one_in_flight_batch(zoho):
    a, b = await asyncio.gather(sync.run_revenue_sync_batch(), sync.run_revenue_sync_batch())
    assert a is b
    assert len(zoho.sales_calls) == 10


async def test_a_full_rebuild_requested_mid_batch_chains_behind_it_instead_of_sharing_its_promise(zoho):
    gate = asyncio.Event()

    async def sales(day, page):
        if len(zoho.sales_calls) == 1:
            await gate.wait()
        return [], False

    zoho.sales = sales
    a = asyncio.ensure_future(sync.run_revenue_sync_batch())
    while not zoho.sales_calls:
        await asyncio.sleep(0)
    b = asyncio.ensure_future(sync.run_revenue_sync_batch(full=True))
    await asyncio.sleep(0)
    gate.set()
    ra, rb = await asyncio.gather(a, b)
    assert ra["days"][0] == TODAY
    assert rb is not ra
    assert rb["days"][0] == TODAY
    assert rb["fetched"] == 10
    assert len([c for c in zoho.sales_calls if c[0] == TODAY]) == 2
    assert len(zoho.sales_calls) == 20


async def test_counts_fetched_vs_total_days_over_history_start_today_and_flags_backfilling(zoho, engine):
    s = await status(engine)
    assert s["running"] is False
    assert (s["fetchedDays"], s["totalDays"], s["missingDays"], s["backfilling"]) == (0, 15, 15, True)
    await sync.run_revenue_sync_batch()
    s = await status(engine)
    assert (s["fetchedDays"], s["totalDays"], s["missingDays"], s["backfilling"]) == (10, 15, 5, True)
    await sync.run_revenue_sync_batch()
    s = await status(engine)
    assert (s["fetchedDays"], s["missingDays"], s["backfilling"], s["legacyDays"]) == (15, 0, False, 0)
    assert s["lastBatchAt"] is not None


async def test_sync_state_survives_a_module_re_evaluation_and_stays_shared_with_the_original_instance(zoho, engine):
    # Python never re-evaluates the module (no --reload in production); state is the one module's, so a second
    # import must see the same cells.
    import importlib

    async def sales(day, page):
        raise ZohoRateLimited("Zoho Books error (HTTP 429)")

    zoho.sales = sales
    with pytest.raises(ZohoRateLimited):
        await sync.run_revenue_sync_batch()
    fresh = importlib.import_module("backend.app.services.revenue.sync")
    async with store.snapshot(engine) as conn:
        s = await fresh.get_revenue_sync_status(conn, datetime.now(timezone.utc))
    assert s["lastError"] == "Zoho Books error (HTTP 429)"
    assert s["running"] is False
    zoho.sales = zoho.default_sales
    await fresh.run_revenue_sync_batch()
    assert (await status(engine))["lastError"] is None
    assert (await status(engine))["lastBatchAt"] is not None


def test_wakes_at_the_live_ttl_so_today_is_re_fetched_when_due_t_1516():
    assert SYNC.idle_interval_s == SYNC.live_ttl_s


async def test_hands_the_heartbeat_the_revenue_sync_config_and_a_batch_adapter_reporting_pending(zoho, sleeps):
    def stop_after_first(s):
        sync._last_read_at = float("-inf")

    async def fake_sleep(s):
        sleeps.append(s)
        stop_after_first(s)

    sync._sleep = fake_sleep
    sync.ensure_revenue_sync_loop()
    task = sync._loop_task
    sync.ensure_revenue_sync_loop()
    assert sync._loop_task is task
    assert task.get_name() == "revenue-sync"
    await asyncio.wait_for(task, 5)
    assert sleeps[-1] == SYNC.batch_pause_s
    assert len(zoho.sales_calls) == 10


# ── pacing and failure handling ──────────────────────────────────────────────


async def test_not_configured_sets_public_error(zoho, engine, sleeps, caplog):
    async def sales(day, page):
        raise ZohoNotConfiguredError("Zoho credentials are not configured")

    async def items(page):
        raise ZohoNotConfiguredError("Zoho credentials are not configured")

    zoho.sales = sales
    zoho.items = items
    with pytest.raises(ZohoNotConfiguredError):
        await sync.run_revenue_sync_batch()
    assert (await status(engine))["lastError"] == "Zoho credentials are not configured"
    assert await day_index(engine) == []

    turns = []

    async def fake_sleep(s):
        if s >= 1:
            turns.append(s)
        if len(turns) == 2:
            sync._last_read_at = float("-inf")

    sync._sleep = fake_sleep
    sync.ensure_revenue_sync_loop()
    await asyncio.wait_for(sync._loop_task, 5)
    assert turns == [SYNC.error_backoff_s, SYNC.error_backoff_s]
    assert len([r for r in caplog.records if "credentials" in r.getMessage()]) == 1  # logged on change, not per turn


async def test_waits_on_shared_minute_ceiling(zoho, sleeps, monkeypatch):
    assert SYNC.call_ceiling == 20
    meter = iter([20, 0])
    monkeypatch.setattr(zoho_service, "calls_in_last_minute", lambda: next(meter, 0))
    seen_at_call = []

    async def sales(day, page):
        seen_at_call.append(list(sleeps))
        return [], False

    zoho.sales = sales
    r = await sync.run_revenue_sync_batch()
    assert r["fetched"] == 10
    assert seen_at_call[0] == [1.0]


async def test_does_not_wait_below_the_ceiling(zoho, sleeps, monkeypatch):
    monkeypatch.setattr(zoho_service, "calls_in_last_minute", lambda: 19)
    r = await sync.run_revenue_sync_batch()
    assert r["fetched"] == 10
    assert 1.0 not in sleeps


async def test_stops_below_daily_floor(zoho, engine, monkeypatch):
    monkeypatch.setattr(zoho_service, "daily_remaining", 4999)
    r = await sync.run_revenue_sync_batch()
    assert r["fetched"] == 0
    assert zoho.sales_calls == []
    assert await day_index(engine) == []


async def test_closed_read_before_fetch(zoho, engine, monkeypatch):
    today = {"v": "2026-10-14"}
    monkeypatch.setattr(sync, "org_today", lambda now=None: today["v"])

    async def sales(day, page):
        today["v"] = "2026-10-15"
        return [], False

    zoho.sales = sales
    await sync.run_revenue_sync_batch()
    idx = {d.day: d for d in await day_index(engine)}
    assert idx["2026-10-14"].closed is False


async def test_concurrent_callers_share_batch(zoho):
    tasks = [asyncio.ensure_future(sync.run_revenue_sync_batch()) for _ in range(3)]
    results = await asyncio.gather(*tasks)
    assert results[0] is results[1] is results[2]
    assert len(zoho.sales_calls) == 10


async def test_full_chains_behind_inflight(zoho, engine):
    gate = asyncio.Event()

    async def sales(day, page):
        if len(zoho.sales_calls) == 1:
            await gate.wait()
        return [], False

    zoho.sales = sales
    a = asyncio.ensure_future(sync.run_revenue_sync_batch())
    while not zoho.sales_calls:
        await asyncio.sleep(0)
    b = asyncio.ensure_future(sync.run_revenue_sync_batch(full=True))
    for _ in range(5):
        await asyncio.sleep(0)
    assert len(zoho.sales_calls) == 1  # b has not started beside a
    gate.set()
    ra, rb = await asyncio.gather(a, b)
    assert ra is not rb
    assert rb["fetched"] == 10
    assert sync._inflight is None


async def test_pages_capped(zoho, engine):
    async def sales(day, page):
        return [group("c1", ROW_A)], True

    zoho.sales = sales
    with pytest.raises(ZohoUpstreamError, match="pages"):
        await sync.run_revenue_sync_batch()
    assert len(zoho.sales_calls) == sync.DAY_PAGE_CAP
    assert await day_index(engine) == []


async def test_refresh_items_maps_zoho_fields_and_stamps(zoho, engine):
    async def items(page):
        row = {
            "item_id": f"i{page}",
            "name": "PLA",
            "sku": "S",
            "brand": "SUNLU",
            "cf_nature_du_produit": "Filaments",
            "item_type": "inventory",
            "tax_percentage": 16,
            "purchase_rate": 1000,
            "cf_prix_dealer_usd_unformatted": "",
            "status": "active",
        }
        return [row], page < 2

    zoho.items = items
    now = datetime.now(timezone.utc)
    async with database.async_session() as db:
        assert await sync.refresh_revenue_items(db, now) is True
    async with store.snapshot(engine) as conn:
        scope = await store.read_scope_items(conn)
        assert await store.items_synced_at(conn) == now.isoformat()
    assert sorted(scope) == ["i1", "i2"]
    assert (scope["i1"].brand, scope["i1"].nature, scope["i1"].tax_percentage) == ("SUNLU", "Filaments", 16)


async def test_refresh_items_keeps_one_row_for_an_item_listed_on_two_pages(zoho, engine):
    async def items(page):
        return [{"item_id": "i1", "name": f"PLA p{page}"}], page < 2

    zoho.items = items
    async with database.async_session() as db:
        assert await sync.refresh_revenue_items(db, datetime.now(timezone.utc)) is True
    async with store.snapshot(engine) as conn:
        scope = await store.read_scope_items(conn)
    assert list(scope) == ["i1"]
    assert scope["i1"].name == "PLA p2"


async def test_refresh_items_keeps_the_table_on_an_empty_listing(zoho, engine):
    async with database.async_session() as db:
        assert await sync.refresh_revenue_items(db, datetime.now(timezone.utc)) is False
    async with store.snapshot(engine) as conn:
        assert await store.items_synced_at(conn) is None


async def _one_loop_turn(sleeps):
    async def fake_sleep(s):
        sleeps.append(s)
        sync._last_read_at = float("-inf")

    sync._sleep = fake_sleep
    sync.ensure_revenue_sync_loop()
    await asyncio.wait_for(sync._loop_task, 5)


async def test_item_refresh_failure_does_not_skip_the_day_batch(zoho, engine, sleeps):
    async def items(page):
        raise ZohoUpstreamError("items down")

    zoho.items = items
    await _one_loop_turn(sleeps)
    assert len(zoho.sales_calls) == 10
    assert (await status(engine))["lastError"] == "items down"
    assert sleeps[-1] == SYNC.batch_pause_s


async def test_batch_failure_wins_over_item_refresh_failure(zoho, engine, sleeps):
    async def items(page):
        raise ZohoUpstreamError("items down")

    async def sales(day, page):
        raise ZohoUpstreamError("sales down")

    zoho.items = items
    zoho.sales = sales
    await _one_loop_turn(sleeps)
    assert (await status(engine))["lastError"] == "sales down"
    assert sleeps[-1] == SYNC.error_backoff_s


async def test_item_refresh_rate_limit_ends_the_turn(zoho, engine, sleeps):
    async def items(page):
        raise ZohoRateLimited("Zoho Books error (HTTP 429)")

    zoho.items = items
    await _one_loop_turn(sleeps)
    assert zoho.sales_calls == []
    assert sleeps[-1] == SYNC.error_backoff_s
    assert (await status(engine))["lastError"] == "Zoho Books error (HTTP 429)"


async def test_a_fetched_line_freezes_the_items_cost_and_tax_rate_a_later_change_does_not_move_it(zoho, engine):
    async def sales(day, page):
        return ([group("c1", ROW_A)] if day == TODAY else []), False

    async def set_item(purchase_rate, tax):
        row = {"item_id": "i1", "name": "A", "purchase_rate": purchase_rate, "tax_percentage": tax}
        async with database.async_session() as db:
            await store.replace_items(db, [sync._item_row(row)], datetime.now(timezone.utc))

    zoho.sales = sales
    await set_item(600, 16)
    await sync.run_revenue_sync_batch()
    await set_item(900, 13)
    [frozen] = await lines(engine, TODAY)
    assert (frozen.unit_cost, frozen.tax_percentage) == (600, 16)


# ── a day that keeps failing ─────────────────────────────────────────────────

BAD_DAY = "2026-10-14"


def _fail_on(day, exc):
    async def sales(d, page):
        if d == day:
            raise exc
        return [], False

    return sales


async def test_a_failing_day_is_skipped_by_the_next_batch_and_the_queue_moves_on(zoho, engine):
    zoho.sales = _fail_on(BAD_DAY, ZohoRequestRejected("Zoho rejected the request"))
    with pytest.raises(ZohoUpstreamError):
        await sync.run_revenue_sync_batch()
    assert [d.day for d in await day_index(engine)] == [TODAY]
    zoho.sales_calls.clear()
    r = await sync.run_revenue_sync_batch()
    assert BAD_DAY not in [c[0] for c in zoho.sales_calls]
    assert r["fetched"] == 10
    assert r["pending"] == 3  # 13 eligible missing days, 10 fetched; the failed one is not counted
    assert (await status(engine))["lastError"] is None


async def test_a_failing_days_back_off_doubles_and_caps_at_six_hours(zoho, monkeypatch):
    clock = {"t": 1000.0}
    monkeypatch.setattr(sync.time, "monotonic", lambda: clock["t"])
    zoho.sales = _fail_on(TODAY, ZohoRequestRejected("bad day"))
    waits = []
    for _ in range(10):
        with pytest.raises(ZohoUpstreamError):
            await sync.run_revenue_sync_batch()
        f = sync._day_failures[TODAY]
        waits.append(f.next_retry - clock["t"])
        clock["t"] = f.next_retry + 1
    assert waits[:3] == [SYNC.error_backoff_s, 2 * SYNC.error_backoff_s, 4 * SYNC.error_backoff_s]
    assert waits[-1] == sync.DAY_RETRY_CAP_S
    assert sync._day_failures[TODAY].attempts == 10


async def test_a_rate_limit_or_transport_error_marks_no_day(zoho):
    from backend.app.services.zoho import ZohoUnreachable

    for exc in (ZohoRateLimited("429"), ZohoUnreachable("timeout"), ConnectionRefusedError("x")):
        zoho.sales = _fail_on(TODAY, exc)
        with pytest.raises(type(exc)):
            await sync.run_revenue_sync_batch()
    assert sync._day_failures == {}


async def test_a_successful_fetch_clears_the_days_failure(zoho, monkeypatch):
    clock = {"t": 1000.0}
    monkeypatch.setattr(sync.time, "monotonic", lambda: clock["t"])
    zoho.sales = _fail_on(TODAY, ZohoRequestRejected("bad day"))
    with pytest.raises(ZohoUpstreamError):
        await sync.run_revenue_sync_batch()
    assert TODAY in sync._day_failures
    clock["t"] += SYNC.error_backoff_s + 1
    zoho.sales = zoho.default_sales
    r = await sync.run_revenue_sync_batch()
    assert r["days"][0] == TODAY
    assert sync._day_failures == {}


async def test_a_full_rebuild_clears_every_failure(zoho):
    zoho.sales = _fail_on(TODAY, ZohoRequestRejected("bad day"))
    with pytest.raises(ZohoUpstreamError):
        await sync.run_revenue_sync_batch()
    zoho.sales = zoho.default_sales
    r = await sync.run_revenue_sync_batch(full=True)
    assert r["days"][0] == TODAY
    assert sync._day_failures == {}


async def test_status_lists_failed_days_newest_first_and_stops_backfilling_when_only_they_remain(zoho, engine):
    async def sales(day, page):
        if day <= "2026-10-06":
            raise ZohoRequestRejected(f"bad {day}")
        return [], False

    zoho.sales = sales
    for _ in range(8):  # 9 good days, then one failure per batch for the 6 bad ones (one batch fails before any)
        try:
            await sync.run_revenue_sync_batch()
        except ZohoUpstreamError:
            pass
    s = await status(engine)
    assert s["failedCount"] == 6
    assert [f["day"] for f in s["failedDays"]] == ["2026-10-06", "2026-10-05", "2026-10-04", "2026-10-03", "2026-10-02"]
    first = s["failedDays"][0]
    assert (first["attempts"], first["error"]) == (1, "bad 2026-10-06")
    assert datetime.fromisoformat(first["nextRetryAt"]) > datetime.now(timezone.utc)
    assert (s["missingDays"], s["backfilling"]) == (6, False)


# ── month check against Zoho ─────────────────────────────────────────────────


@pytest.fixture
def with_september(zoho, monkeypatch):
    """History from 2026-09-28: September (3 days) is a closed month, 18 days in all, two batches to fill."""
    monkeypatch.setattr(sync, "REVENUE_HISTORY_START", "2026-09-28")

    async def sales(day, page):
        return ([group("c1", {**ROW_A, "amount": 500})] if day.startswith("2026-09") else []), False

    zoho.sales = sales
    return zoho


async def checks(engine):
    async with store.snapshot(engine) as conn:
        return await store.read_month_checks(conn)


async def test_a_complete_cache_checks_one_month_against_zohos_total_for_its_window(with_september, engine):
    async def range_rows(from_date, to_date, page):
        return ([{"item_id": "i1", "amount": 1000}] if page == 1 else [{"item_id": "i2", "amount": "501"}]), page == 1

    with_september.range_rows = range_rows
    first = await sync.run_revenue_sync_batch()
    assert first["checked"] is None and with_september.range_calls == []
    second = await sync.run_revenue_sync_batch()
    assert second["checked"] == "2026-09"
    assert with_september.range_calls == [("2026-09-28", "2026-09-30", 1), ("2026-09-28", "2026-09-30", 2)]
    [c] = await checks(engine)
    assert (c["month"], c["zohoAmount"], c["cacheAmount"]) == ("2026-09", 1501, 1500)
    with_september.range_calls.clear()
    third = await sync.run_revenue_sync_batch()
    assert third["checked"] is None and with_september.range_calls == []


async def test_an_incomplete_cache_checks_no_month(with_september, engine):
    async def sales(day, page):
        if day == "2026-10-02":
            raise ZohoUpstreamError("bad day")
        return [], False

    with_september.sales = sales
    for _ in range(3):
        try:
            await sync.run_revenue_sync_batch()
        except ZohoUpstreamError:
            pass
    assert with_september.range_calls == []
    assert await checks(engine) == []


async def test_a_low_budget_stops_the_month_check_and_saves_nothing(with_september, engine, monkeypatch):
    await sync.run_revenue_sync_batch()

    async def sales(day, page):
        if day == "2026-09-28":  # the batch's last day: the budget drops before the check
            monkeypatch.setattr(zoho_service, "daily_remaining", SYNC.daily_budget_floor - 1)
        return [], False

    with_september.sales = sales
    r = await sync.run_revenue_sync_batch()
    assert r["checked"] is None and with_september.range_calls == []
    assert await checks(engine) == []


async def test_a_zoho_error_while_checking_fails_the_batch_but_marks_no_day(with_september, engine):
    async def range_rows(from_date, to_date, page):
        raise ZohoUpstreamError("Zoho Books error (HTTP 500)")

    with_september.range_rows = range_rows
    await sync.run_revenue_sync_batch()
    with pytest.raises(ZohoUpstreamError):
        await sync.run_revenue_sync_batch()
    assert sync._day_failures == {}
    assert (await status(engine))["missingDays"] == 0
    assert await checks(engine) == []


# ── cash: payments and unpaid invoices ───────────────────────────────────────


def payment(pid, lmt, customer="c9", date="2026-10-01", amount=100):
    return {"payment_id": pid, "customer_id": customer, "date": date, "amount": amount, "last_modified_time": lmt}


def invoice(iid, balance, customer="c9", total=None):
    return {
        "invoice_id": iid,
        "invoice_number": f"INV-{iid}",
        "customer_id": customer,
        "customer_name": "Client",
        "date": "2026-10-01",
        "due_date": "2026-10-10",
        "total": total if total is not None else balance,
        "balance": balance,
    }


async def cash_rows(engine):
    async with store.snapshot(engine) as conn:
        since = await store.get_setting(conn, store.PAYMENTS_SINCE_KEY)
        return (
            await store.read_payments(conn, ""),
            {i["invoiceId"]: i for i in await store.read_invoice_shares(conn)},
            since,
        )


async def seed_items():
    async with database.async_session() as db:
        await store.replace_items(db, [{"item_id": "seed"}], sync._utcnow())


async def refresh_cash():
    async with database.async_session() as db:
        await sync._refresh_cash(db)


def cash_kinds(zoho):
    return [c[0] for c in zoho.cash_calls]


async def test_cash_runs_only_on_a_complete_cache_and_at_most_every_ttl(zoho, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(sync.time, "monotonic", lambda: clock[0])
    await sync.run_revenue_sync_batch()
    assert zoho.cash_calls == []  # 5 days still missing
    await sync.run_revenue_sync_batch()
    assert cash_kinds(zoho) == ["payments", "unpaid", "unpaid", "unpaid"]
    assert zoho.cash_calls[0] == ("payments", "2025-10-01T10:00:00+0000", 1)
    zoho.cash_calls.clear()
    clock[0] += SYNC.cash_ttl_s - 1
    await sync.run_revenue_sync_batch()
    assert zoho.cash_calls == []
    clock[0] += 1
    await sync.run_revenue_sync_batch()
    assert cash_kinds(zoho)[0] == "payments"


def keyset_zoho(zoho, stamps, page_size=1):
    """A Zoho listing sorted by last_modified_time: rows at or after `since`, `page_size` per page."""

    async def pages(since, page):
        rows = sorted(
            (payment(f"p{i}", t) for i, t in enumerate(stamps) if t >= since), key=lambda r: r["last_modified_time"]
        )
        chunk = rows[(page - 1) * page_size : page * page_size]
        return chunk, len(rows) > page * page_size

    zoho.payment_pages = pages


async def test_payment_cursor_moves_per_page_and_a_capped_run_resumes_there(zoho, engine):
    stamps = [f"2026-10-{d:02d}T08:00:00-1000" for d in range(1, 30)]
    keyset_zoho(zoho, stamps, page_size=2)
    await refresh_cash()
    calls = [c for c in zoho.cash_calls if c[0] == "payments"]
    assert len(calls) == sync.CASH_PAGE_CAP
    assert {c[2] for c in calls} == {1}  # keyset: a moving `since`, always page 1
    assert [c[1] for c in calls[1:]] == stamps[1 : sync.CASH_PAGE_CAP]
    payments, _, since = await cash_rows(engine)
    assert len(payments) == sync.CASH_PAGE_CAP + 1  # two rows per page, one repeated at each boundary
    assert since == stamps[sync.CASH_PAGE_CAP]  # the last page's last row
    zoho.cash_calls.clear()
    await refresh_cash()
    assert zoho.cash_calls[0] == ("payments", stamps[sync.CASH_PAGE_CAP], 1)


async def test_a_payment_edited_mid_listing_is_not_skipped(zoho, engine):
    stamps = ["2026-10-01T08:00:00-1000", "2026-10-02T08:00:00-1000", "2026-10-03T08:00:00-1000"]
    served: list[str] = []

    async def pages(since, page):
        rows = sorted(
            (payment(f"p{i}", t) for i, t in enumerate(stamps) if t >= since), key=lambda r: r["last_modified_time"]
        )
        if not served:  # p0 is edited in Books after the first page was served
            served.append("x")
            stamps[0] = "2026-10-09T08:00:00-1000"
        chunk = rows[(page - 1) * 1 : page * 1]
        return chunk, len(rows) > page

    zoho.payment_pages = pages
    await refresh_cash()
    assert {p["paymentId"] for p in (await cash_rows(engine))[0]} == {"p0", "p1", "p2"}


async def test_a_page_sharing_one_timestamp_pages_by_offset_and_the_cursor_holds(zoho, engine):
    same = "2026-10-05T08:00:00-1000"
    rows = [payment(f"p{i}", same) for i in range(5)] + [payment("late", "2026-10-06T08:00:00-1000")]

    async def pages(since, page):
        rest = [r for r in rows if r["last_modified_time"] >= since]
        return rest[(page - 1) * 2 : page * 2], len(rest) > page * 2

    zoho.payment_pages = pages
    await refresh_cash()
    assert {p["paymentId"] for p in (await cash_rows(engine))[0]} == {r["payment_id"] for r in rows}
    calls = [c[1:] for c in zoho.cash_calls if c[0] == "payments"]
    assert calls[0][1] == 1 and calls[1] == (same, 1) and calls[2] == (same, 2)
    assert len(calls) <= sync.CASH_PAGE_CAP


async def test_a_listing_that_never_advances_stops_at_the_page_cap(zoho, engine):
    same = "2026-10-05T08:00:00-1000"

    async def pages(since, page):
        return [payment(f"p{page}", same)], True

    zoho.payment_pages = pages
    await refresh_cash()
    assert len([c for c in zoho.cash_calls if c[0] == "payments"]) == sync.CASH_PAGE_CAP


async def test_a_payment_touched_again_forgets_its_applications(zoho, engine):
    async with database.async_session() as db:
        await store.save_payments(db, [sync._payment_row(payment("p1", "t1"))], None, sync._utcnow())
        await store.save_payment_applications(db, "p1", [{"invoiceId": "i1", "amount": 100}], 0, sync._utcnow())
        await store.save_payments(db, [sync._payment_row(payment("p1", "t1"))], None, sync._utcnow())
        assert (await cash_rows(engine))[0][0]["applications"] == [{"invoiceId": "i1", "amount": 100}]
        await store.save_payments(db, [sync._payment_row(payment("p1", "t2"))], None, sync._utcnow())
    assert (await cash_rows(engine))[0][0]["applications"] is None


async def test_unpaid_listings_union_and_a_paid_invoice_drops_to_zero_unless_a_listing_was_cut(zoho, engine):
    listing = {"unpaid": [invoice("a", 100)], "overdue": [invoice("a", 100), invoice("b", 50)], "partially_paid": []}

    async def unpaid(status, page):
        return listing[status], False

    async def detail(iid):  # the share read sees the same balance
        return next(i for rows in listing.values() for i in rows if i["invoice_id"] == iid)

    zoho.unpaid_pages, zoho.invoice_detail = unpaid, detail
    await refresh_cash()
    _, invoices, _ = await cash_rows(engine)
    assert {k: v["balance"] for k, v in invoices.items()} == {"a": 100, "b": 50}

    listing["overdue"] = [invoice("a", 100)]  # b was paid

    async def unpaid_cut(status, page):
        return listing[status], status == "partially_paid"  # never ends: capped

    zoho.unpaid_pages = unpaid_cut
    await refresh_cash()
    assert (await cash_rows(engine))[1]["b"]["balance"] == 50
    zoho.unpaid_pages = unpaid
    await refresh_cash()
    assert (await cash_rows(engine))[1]["b"]["balance"] == 0


async def test_detail_reads_stay_within_the_budget_payments_first_newest_first(zoho, engine):
    await seed_items()
    n = SYNC.cash_detail_budget + 5

    async def pages(since, page):
        return [payment(f"p{i:02d}", f"t{i:02d}", date=f"2026-0{1 + i % 9}-{10 + i:02d}") for i in range(n)], False

    async def unpaid(status, page):
        return ([invoice("open", 100)] if status == "unpaid" else []), False

    zoho.payment_pages, zoho.unpaid_pages = pages, unpaid
    await refresh_cash()
    details = [c for c in zoho.cash_calls if c[0] in ("payment", "invoice")]
    assert len(details) == SYNC.cash_detail_budget
    assert {c[0] for c in details} == {"payment"}
    dates = {p["paymentId"]: p["date"] for p in (await cash_rows(engine))[0]}
    asked = [dates[c[1]] for c in details]
    assert asked == sorted(asked, reverse=True)


async def test_detail_reads_fill_applications_and_invoice_shares(zoho, engine):
    async with database.async_session() as db:
        await store.replace_items(
            db, [{"item_id": "pla", "nature": "Filaments"}, {"item_id": "kayak", "nature": "Boats"}], sync._utcnow()
        )

    async def pages(since, page):
        return [payment("p1", "t1", amount=1000)], False

    async def pay_detail(pid):
        return {"invoices": [{"invoice_id": "i1", "amount_applied": 800}], "unused_amount": 200}

    async def inv_detail(iid):
        lines = [{"item_id": "pla", "item_total": 250}, {"item_id": "kayak", "item_total": 750}]
        return {**invoice(iid, 0, total=1130), "line_items": lines}

    zoho.payment_pages, zoho.payment_detail, zoho.invoice_detail = pages, pay_detail, inv_detail
    await refresh_cash()
    assert [c for c in zoho.cash_calls if c[0] in ("payment", "invoice")] == [("payment", "p1")]
    zoho.cash_calls.clear()
    await refresh_cash()  # the application's invoice is read on the next run
    assert [c for c in zoho.cash_calls if c[0] in ("payment", "invoice")] == [("invoice", "i1")]
    payments, invoices, _ = await cash_rows(engine)
    assert payments[0]["applications"] == [{"invoiceId": "i1", "amount": 800}]
    assert (invoices["i1"]["share"], invoices["i1"]["total"]) == (0.25, 1130)
    zoho.cash_calls.clear()
    await refresh_cash()
    assert [c for c in zoho.cash_calls if c[0] in ("payment", "invoice")] == []


async def test_a_payment_deleted_in_books_is_dropped_and_the_others_still_read(zoho, engine):
    await seed_items()

    async def pages(since, page):
        return [payment("gone", "t1"), payment("kept", "t2")], False

    async def pay_detail(pid):
        if pid == "gone":
            raise ZohoNotFound("Not found in Zoho Books")
        return {"invoices": [{"invoice_id": "i1", "amount_applied": 100}], "unused_amount": 0}

    zoho.payment_pages, zoho.payment_detail = pages, pay_detail
    await refresh_cash()
    payments = (await cash_rows(engine))[0]
    assert [p["paymentId"] for p in payments] == ["kept"]
    assert payments[0]["applications"] == [{"invoiceId": "i1", "amount": 100}]
    assert {c[1] for c in zoho.cash_calls if c[0] == "payment"} == {"gone", "kept"}


async def test_an_invoice_gone_from_books_is_saved_with_no_share_and_not_asked_again(zoho, engine):
    await seed_items()

    async def pages(since, page):
        return [payment("p1", "t1")], False

    async def pay_detail(pid):
        return {"invoices": [{"invoice_id": "i1", "amount_applied": 100}], "unused_amount": 0}

    async def inv_detail(iid):
        raise ZohoNotFound("Not found in Zoho Books")

    zoho.payment_pages, zoho.payment_detail, zoho.invoice_detail = pages, pay_detail, inv_detail
    await refresh_cash()
    zoho.cash_calls.clear()
    await refresh_cash()  # the application's invoice is read on the next run
    assert [c for c in zoho.cash_calls if c[0] == "invoice"] == [("invoice", "i1")]
    assert (await cash_rows(engine))[1]["i1"]["share"] == 0.0
    zoho.cash_calls.clear()
    await refresh_cash()
    assert [c for c in zoho.cash_calls if c[0] in ("payment", "invoice")] == []


async def test_a_cash_error_leaves_the_batch_and_banner_alone_and_waits_out_the_ttl(zoho, engine, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(sync.time, "monotonic", lambda: clock[0])

    async def boom(since, page):
        raise ZohoUpstreamError("Zoho Books error (HTTP 500)")

    zoho.payment_pages = boom
    await sync.run_revenue_sync_batch()
    r = await sync.run_revenue_sync_batch()
    assert r["fetched"] == 5
    assert (await status(engine))["lastError"] is None
    assert sync.cash_error() == "Zoho Books error (HTTP 500)"
    zoho.cash_calls.clear()
    clock[0] += 60
    await sync.run_revenue_sync_batch()
    assert zoho.cash_calls == []
    zoho.payment_pages = zoho.default_pages
    clock[0] += SYNC.cash_ttl_s
    await sync.run_revenue_sync_batch()
    assert sync.cash_error() is None


async def test_a_low_budget_stops_the_cash_step_quietly(zoho, engine, monkeypatch):
    async def pages(since, page):
        monkeypatch.setattr(zoho_service, "daily_remaining", SYNC.daily_budget_floor - 1)
        return [payment("p1", "t1")], True

    zoho.payment_pages = pages
    await sync.run_revenue_sync_batch()
    await sync.run_revenue_sync_batch()
    assert cash_kinds(zoho) == ["payments"]
    assert sync.cash_error() is None
    assert (await status(engine))["lastError"] is None
    assert len((await cash_rows(engine))[0]) == 1  # the page that completed is kept


# ── review fixes: what marks a day, steps that Zoho refuses, cash beside a failed day ───────────


async def test_a_token_or_other_zoho_wide_error_marks_no_day(zoho):
    zoho.sales = _fail_on(TODAY, ZohoUpstreamError("Token refresh failed (HTTP 400)"))
    with pytest.raises(ZohoUpstreamError):
        await sync.run_revenue_sync_batch()
    assert sync._day_failures == {}


async def test_a_5xx_marks_the_day_but_its_back_off_stops_at_ten_minutes(zoho, monkeypatch):
    clock = {"t": 1000.0}
    monkeypatch.setattr(sync.time, "monotonic", lambda: clock["t"])
    zoho.sales = _fail_on(TODAY, ZohoAmbiguous("Zoho Books error (HTTP 502)"))
    waits = []
    for _ in range(5):
        with pytest.raises(ZohoAmbiguous):
            await sync.run_revenue_sync_batch()
        f = sync._day_failures[TODAY]
        waits.append(f.next_retry - clock["t"])
        clock["t"] = f.next_retry + 1
    assert waits[0] == SYNC.error_backoff_s
    assert max(waits) == sync.DAY_RETRY_CAP_5XX_S


async def test_a_contact_zoho_refuses_waits_and_the_lookups_after_it_still_run(zoho, engine):
    async def sales(day, page):
        return ([group("c1", ROW_A), group("c2", {**ROW_A, "item_id": "i2"})] if day == TODAY else []), False

    async def contact(customer_id):
        if customer_id == "c1":
            raise ZohoRequestRejected("bad contact")
        return {"name": "Two"}

    zoho.sales, zoho.contact = sales, contact
    await sync.run_revenue_sync_batch()
    assert zoho.contact_calls == ["c1", "c2"]
    zoho.contact_calls.clear()
    await sync.run_revenue_sync_batch()
    assert "c1" not in zoho.contact_calls


async def test_a_month_check_zoho_refuses_waits_and_does_not_fail_the_batch(with_september, engine):
    async def range_rows(from_date, to_date, page):
        raise ZohoRequestRejected("bad month")

    with_september.range_rows = range_rows
    await sync.run_revenue_sync_batch()
    r = await sync.run_revenue_sync_batch()
    assert r["checked"] is None
    assert len(with_september.range_calls) == 1
    with_september.range_calls.clear()
    await sync.run_revenue_sync_batch()
    assert with_september.range_calls == []


async def test_a_month_check_zoho_answers_with_a_5xx_waits_and_the_cash_still_refreshes(with_september, engine):
    async def range_rows(from_date, to_date, page):
        raise ZohoAmbiguous("Zoho Books error (HTTP 502)")

    with_september.range_rows = range_rows
    await sync.run_revenue_sync_batch()
    r = await sync.run_revenue_sync_batch()
    assert r["checked"] is None
    assert [k for k in sync._step_retry if k.startswith("m:")] == ["m:2026-09"]
    assert "payments" in cash_kinds(with_september)


async def test_cash_still_refreshes_while_a_day_waits_out_its_back_off(zoho):
    zoho.sales = _fail_on(BAD_DAY, ZohoRequestRejected("bad day"))
    with pytest.raises(ZohoUpstreamError):
        await sync.run_revenue_sync_batch()
    for _ in range(3):
        await sync.run_revenue_sync_batch()
    assert "payments" in cash_kinds(zoho)


async def test_a_rate_limit_in_the_cash_step_reaches_the_loop(zoho, monkeypatch):
    async def pages(since, page):
        raise ZohoRateLimited("429")

    zoho.payment_pages = pages
    await sync.run_revenue_sync_batch()
    with pytest.raises(ZohoRateLimited):
        await sync.run_revenue_sync_batch()


async def test_a_refused_cash_detail_is_parked_and_the_step_still_completes(zoho, engine):
    await seed_items()
    n = SYNC.cash_detail_budget + 1
    ids = [f"p{i:02d}" for i in range(n)]

    async def pages(since, page):
        return [payment(pid, f"t{pid}", date=f"2026-10-{10 + i:02d}") for i, pid in enumerate(ids)], False

    async def pay_detail(pid):
        if pid == ids[-1]:  # newest first: asked first
            raise ZohoRequestRejected("Zoho Books refused the request (HTTP 400)")
        return {}

    zoho.payment_pages, zoho.payment_detail = pages, pay_detail
    await refresh_cash()
    asked = [c[1] for c in zoho.cash_calls if c[0] == "payment"]
    assert asked[0] == ids[-1] and len(asked) == SYNC.cash_detail_budget  # the parked read is the one that failed
    async with store.snapshot(engine) as conn:
        assert await store.get_setting(conn, store.CASH_SYNCED_KEY)
    zoho.cash_calls.clear()
    await refresh_cash()
    asked = [c[1] for c in zoho.cash_calls if c[0] == "payment"]
    assert ids[-1] not in asked  # parked, and it does not use up a slot of the budget


async def test_a_5xx_invoice_detail_is_parked_while_the_next_one_is_read(zoho, engine):
    await seed_items()

    async def unpaid(status, page):
        return ([invoice("bad", 100), invoice("good", 50)] if status == "unpaid" else []), False

    async def detail(iid):
        if iid == "bad":
            raise ZohoAmbiguous("Zoho Books error (HTTP 500)")
        return {**invoice(iid, 50), "line_items": []}

    zoho.unpaid_pages, zoho.invoice_detail = unpaid, detail
    await refresh_cash()
    assert {c[1] for c in zoho.cash_calls if c[0] == "invoice"} == {"bad", "good"}
    assert "good" in (await cash_rows(engine))[1]
    assert not sync._step_ready("i:bad")
    zoho.cash_calls.clear()
    await refresh_cash()
    assert "bad" not in [c[1] for c in zoho.cash_calls if c[0] == "invoice"]


def test_a_low_budget_reading_is_not_trusted_after_the_probe_age_and_a_changed_reply_restarts_the_wait(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(sync.time, "monotonic", lambda: clock[0])
    low = SYNC.daily_budget_floor - 1
    monkeypatch.setattr(zoho_service, "daily_remaining", low)
    assert sync._budget_low() is True
    clock[0] += SYNC.budget_probe_after_s - 1
    assert sync._budget_low() is True
    clock[0] += 1
    assert sync._budget_low() is False  # the reading is stale: one call may probe the reset
    monkeypatch.setattr(zoho_service, "daily_remaining", low - 1)  # the reply still says low: wait again
    assert sync._budget_low() is True
    clock[0] += SYNC.budget_probe_after_s
    assert sync._budget_low() is False
    monkeypatch.setattr(zoho_service, "daily_remaining", SYNC.daily_budget_floor + 1000)  # the quota reset
    assert sync._budget_low() is False
    monkeypatch.setattr(zoho_service, "daily_remaining", low)
    assert sync._budget_low() is True  # a fresh low reading starts its own wait
    sync.reset_revenue_sync_state_for_tests()
    assert sync._low_seen is None


async def test_cash_detail_step_waits_for_the_first_item_listing(zoho, engine):
    async def unpaid(status, page):
        return ([invoice("open", 100)] if status == "unpaid" else []), False

    zoho.unpaid_pages = unpaid
    await refresh_cash()
    assert [c for c in zoho.cash_calls if c[0] in ("payment", "invoice")] == []
    assert "open" in (await cash_rows(engine))[1]  # the invoice list was still saved
    await seed_items()
    await refresh_cash()
    assert [c for c in zoho.cash_calls if c[0] == "invoice"] == [("invoice", "open")]
