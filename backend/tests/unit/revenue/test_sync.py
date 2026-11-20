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
    ZohoNotConfiguredError,
    ZohoNotFound,
    ZohoRateLimited,
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
    for name in ("sales_by_item_by_customer", "get_contact", "list_items_page_all", "sales_by_item_range"):
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
    zoho.sales = _fail_on(BAD_DAY, ZohoUpstreamError("Zoho Books error (HTTP 400)"))
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
    zoho.sales = _fail_on(TODAY, ZohoUpstreamError("bad day"))
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
    zoho.sales = _fail_on(TODAY, ZohoUpstreamError("bad day"))
    with pytest.raises(ZohoUpstreamError):
        await sync.run_revenue_sync_batch()
    assert TODAY in sync._day_failures
    clock["t"] += SYNC.error_backoff_s + 1
    zoho.sales = zoho.default_sales
    r = await sync.run_revenue_sync_batch()
    assert r["days"][0] == TODAY
    assert sync._day_failures == {}


async def test_a_full_rebuild_clears_every_failure(zoho):
    zoho.sales = _fail_on(TODAY, ZohoUpstreamError("bad day"))
    with pytest.raises(ZohoUpstreamError):
        await sync.run_revenue_sync_batch()
    zoho.sales = zoho.default_sales
    r = await sync.run_revenue_sync_batch(full=True)
    assert r["days"][0] == TODAY
    assert sync._day_failures == {}


async def test_status_lists_failed_days_newest_first_and_stops_backfilling_when_only_they_remain(zoho, engine):
    async def sales(day, page):
        if day <= "2026-10-06":
            raise ZohoUpstreamError(f"bad {day}")
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
