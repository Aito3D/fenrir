"""Port of loki's revenue-store.test.ts against a file-backed SQLite (two sessions cannot share :memory:)."""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.core.database import Base, _set_sqlite_pragmas, load_all_models
from backend.app.services.revenue import store
from backend.app.services.revenue.customers import RevenueCustomerFacts
from backend.app.services.revenue.scope import ScopeItem
from backend.app.services.revenue.sync_plan import DayRow

NOW = datetime(2026, 10, 15, 20, 0, tzinfo=timezone.utc)
LATER = datetime(2026, 10, 16, 5, 0, tzinfo=timezone.utc)
L1 = {"item_id": "i1", "name": "Impression3D - Prestation", "sku": "", "quantity": 2, "amount": -11681}
L2 = {"item_id": "i2", "name": "SUNLU PLA", "sku": "SNL-PLA", "quantity": 3, "amount": 10785}


def line(day, base, customer_id=""):
    from backend.app.services.revenue.series import RevenueLine

    return RevenueLine(day=day, customer_id=customer_id, **base)


@pytest.fixture
async def engine(tmp_path):
    load_all_models()
    eng = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'revenue.db'}")
    event.listen(
        eng.sync_engine, "connect", _set_sqlite_pragmas
    )  # WAL, as in the app: a reader must not block the writer
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest.fixture
def sessions(engine):
    return async_sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
async def db(sessions):
    async with sessions() as session:
        yield session


async def write(db, day, lines, closed=True, now=NOW):
    await store.write_day(db, day, [line(day, b) if isinstance(b, dict) else b for b in lines], closed, now, 2)


async def read_index(engine):
    async with store.snapshot(engine) as conn:
        return await store.read_day_index(conn)


async def read_lines(engine, from_, to):
    async with store.snapshot(engine) as conn:
        return await store.read_lines(conn, from_, to)


async def test_is_empty_before_anything_is_written(engine):
    assert await read_index(engine) == []
    assert await read_lines(engine, "2024-01-01", "2026-12-31") == []


async def test_write_day_stores_the_day_row_and_its_lines_a_day_with_no_sales_still_gets_its_row(engine, db):
    await write(db, "2026-10-01", [L1, L2])
    await write(db, "2026-10-02", [])
    assert await read_index(engine) == [
        DayRow("2026-10-01", True, NOW.isoformat(), 2),
        DayRow("2026-10-02", True, NOW.isoformat(), 2),
    ]
    assert await read_lines(engine, "2026-10-01", "2026-10-02") == [
        line("2026-10-01", L1),
        line("2026-10-01", L2),
    ]


async def test_write_day_replaces_a_days_lines_rather_than_merging_and_refreshes_fetched_at_closed(engine, db):
    await write(db, "2026-10-15", [L1, L2], closed=False)
    await write(db, "2026-10-15", [L2], closed=True, now=LATER)
    assert await read_lines(engine, "2026-10-15", "2026-10-15") == [line("2026-10-15", L2)]
    async with store.snapshot(engine) as conn:
        assert await store.read_days(conn, "2026-10-15", "2026-10-15") == [
            DayRow("2026-10-15", True, LATER.isoformat(), 2)
        ]


async def test_write_day_keeps_empty_day_row(engine, db):
    await write(db, "2026-10-01", [L1])
    await write(db, "2026-10-01", [])
    assert [d.day for d in await read_index(engine)] == ["2026-10-01"]
    assert await read_lines(engine, "2026-10-01", "2026-10-01") == []


async def test_read_days_read_lines_are_inclusive_on_both_ends_and_ordered_by_day_then_item(engine, db):
    await write(db, "2026-10-03", [L2])
    await write(db, "2026-10-01", [L2, L1])
    await write(db, "2026-10-02", [L1])
    async with store.snapshot(engine) as conn:
        days = await store.read_days(conn, "2026-10-01", "2026-10-02")
    assert [d.day for d in days] == ["2026-10-01", "2026-10-02"]
    assert [f"{x.day}/{x.item_id}" for x in await read_lines(engine, "2026-10-01", "2026-10-02")] == [
        "2026-10-01/i1",
        "2026-10-01/i2",
        "2026-10-02/i1",
    ]


async def totals(engine):
    async with store.snapshot(engine) as conn:
        return sorted(await store.item_totals(conn), key=lambda t: t["itemId"])


async def test_item_totals_sums_amount_and_quantity_per_item_over_the_whole_cache_and_keeps_the_last_day(engine, db):
    await write(db, "2026-09-30", [{**L1, "amount": 20000, "quantity": 4}])
    await write(db, "2026-10-01", [L1, L2])
    assert await totals(engine) == [
        {"itemId": "i1", "name": L1["name"], "sku": "", "totalHt": 8319, "quantity": 6, "lastDay": "2026-10-01"},
        {
            "itemId": "i2",
            "name": L2["name"],
            "sku": "SNL-PLA",
            "totalHt": 10785,
            "quantity": 3,
            "lastDay": "2026-10-01",
        },
    ]


async def test_item_totals_maps_a_zero_sum_a_negative_sum_and_a_credit_note_only_item_straight_through(engine, db):
    await write(
        db,
        "2026-10-01",
        [
            {"item_id": "z", "name": "Zero", "sku": "", "quantity": 0, "amount": 0},
            {"item_id": "c", "name": "Credit", "sku": "", "quantity": -2, "amount": -5000},
        ],
    )
    assert await totals(engine) == [
        {"itemId": "c", "name": "Credit", "sku": "", "totalHt": -5000, "quantity": -2, "lastDay": "2026-10-01"},
        {"itemId": "z", "name": "Zero", "sku": "", "totalHt": 0, "quantity": 0, "lastDay": "2026-10-01"},
    ]


async def test_clear_revenue_cache_drops_days_and_lines_but_keeps_decisions(engine, db):
    await write(db, "2026-10-01", [L1])
    await store.set_decision(db, "i9", True, NOW)
    await store.clear_revenue_cache(db)
    assert await read_index(engine) == []
    assert await read_lines(engine, "2024-01-01", "2026-12-31") == []
    async with store.snapshot(engine) as conn:
        assert await store.read_decisions(conn) == [store.RevenueDecision("i9", True, NOW.isoformat())]


async def test_clear_cache_keeps_decisions_targets_notes_customers(engine, db):
    await write(db, "2026-10-01", [L1])
    await store.set_decision(db, "i9", True, NOW)
    await store.set_target(db, "2026-10", 5, NOW)
    await store.add_annotation(db, "2026-10-01", "note", NOW)
    await store.save_customer(db, "c1", {"name": "A", "company_name": "", "sub_type": None}, NOW)
    await store.clear_revenue_cache(db)
    async with store.snapshot(engine) as conn:
        assert len(await store.read_decisions(conn)) == 1
        assert len(await store.read_targets(conn)) == 1
        assert len(await store.read_annotations(conn)) == 1
        assert set(await store.read_customer_facts(conn)) == {"c1"}


async def test_set_decision_inserts_then_overwrites_clear_decision_reports_whether_a_row_existed(engine, db):
    assert await store.set_decision(db, "i1", True, NOW) == {
        "itemId": "i1",
        "included": True,
        "decidedAt": NOW.isoformat(),
    }
    await store.set_decision(db, "i1", False, LATER)
    async with store.snapshot(engine) as conn:
        assert await store.read_decisions(conn) == [store.RevenueDecision("i1", False, LATER.isoformat())]
    assert await store.clear_decision(db, "i1") is True
    assert await store.clear_decision(db, "i1") is False
    async with store.snapshot(engine) as conn:
        assert await store.read_decisions(conn) == []


async def test_item_totals_takes_name_and_sku_from_the_items_most_recent_line_not_an_earlier_one(engine, db):
    base = {"item_id": "i2", "quantity": 1, "amount": 100}
    await write(db, "2026-09-30", [{**base, "name": "SUNLU PLA (ancien)", "sku": "OLD"}])
    await write(db, "2026-10-01", [{**base, "name": "SUNLU PLA", "sku": "SNL-PLA"}])
    await write(db, "2026-09-15", [{**base, "name": "SUNLU PLA (très ancien)", "sku": "VERY-OLD"}])
    assert await totals(engine) == [
        {"itemId": "i2", "name": "SUNLU PLA", "sku": "SNL-PLA", "totalHt": 300, "quantity": 3, "lastDay": "2026-10-01"}
    ]


async def test_snapshot_returns_what_the_separate_reads_return(engine, db):
    await write(db, "2026-10-01", [{"item_id": "i1", "name": "A", "sku": "A1", "quantity": 1, "amount": 10}])
    async with store.snapshot(engine) as conn:
        lines = await store.read_lines(conn, "2026-10-01", "2026-10-02")
        days = await store.read_days(conn, "2026-10-01", "2026-10-02")
    assert len(lines) == 1
    assert [d.day for d in days] == ["2026-10-01"]


async def test_snapshot_serves_every_read_from_one_snapshot_a_day_committed_by_another_session_stays_invisible(
    engine, sessions, db
):
    await write(db, "2026-10-01", [{"item_id": "i1", "name": "A", "sku": "A1", "quantity": 1, "amount": 10}])
    async with store.snapshot(engine) as conn:
        days = await store.read_days(conn, "2026-10-01", "2026-10-05")
        async with sessions() as other:
            await write(other, "2026-10-02", [L1])
        lines = await store.read_lines(conn, "2026-10-01", "2026-10-05")
    assert [d.day for d in days] == ["2026-10-01"]
    assert [x.day for x in lines] == ["2026-10-01"]
    assert [d.day for d in await read_index(engine)] == ["2026-10-01", "2026-10-02"]


async def test_snapshot_hides_day_committed_between_reads(engine, sessions, db):
    async with store.snapshot(engine) as conn:
        assert await store.read_days(conn, "2026-10-01", "2026-10-05") == []
        async with sessions() as other:
            await write(other, "2026-10-02", [L1])
        assert await store.read_lines(conn, "2026-10-01", "2026-10-05") == []


def test_snapshot_isolation_option():
    assert store.snapshot_isolation("postgresql") == "REPEATABLE READ"
    assert store.snapshot_isolation("sqlite") == "AUTOCOMMIT"


async def test_lists_the_line_customers_no_cache_knows_and_stops_listing_them_once_saved_found_or_not(engine, db):
    await store.save_customer(db, "known", {"name": "Known", "company_name": "Known SARL", "sub_type": "business"}, NOW)
    await store.write_day(
        db,
        "2026-10-01",
        [line("2026-10-01", L1, "known"), line("2026-10-01", L2, "c-new"), line("2026-10-01", {**L2, "item_id": "i3"})],
        True,
        NOW,
        2,
    )
    assert await store.unknown_customer_ids(db) == ["c-new"]
    await store.save_customer(db, "c-new", None, NOW)
    assert await store.unknown_customer_ids(db) == []


async def test_read_customer_facts_returns_only_found_rows_and_the_latest_save(engine, db):
    await store.save_customer(db, "a", {"name": "Old name", "company_name": "", "sub_type": "individual"}, NOW)
    await store.save_customer(
        db, "a", {"name": "Fresh name", "company_name": "Fresh SARL", "sub_type": "business"}, LATER
    )
    await store.save_customer(db, "b", {"name": "Bea", "company_name": "", "sub_type": "individual"}, NOW)
    await store.save_customer(db, "gone", None, NOW)
    async with store.snapshot(engine) as conn:
        facts = await store.read_customer_facts(conn)
    assert facts["a"] == RevenueCustomerFacts("a", "Fresh name", "Fresh SARL", "business")
    assert facts["b"].sub_type == "individual"
    assert "gone" not in facts


async def test_targets_upsert_list_by_month_and_clear(engine, db):
    await store.set_target(db, "2026-11", 1_500_000, NOW)
    await store.set_target(db, "2026-10", 1_000_000, NOW)
    await store.set_target(db, "2026-11", 1_600_000, NOW)
    async with store.snapshot(engine) as conn:
        targets = await store.read_targets(conn)
    assert [(t["month"], t["amountHt"]) for t in targets] == [("2026-10", 1_000_000), ("2026-11", 1_600_000)]
    assert await store.clear_target(db, "2026-10") is True
    assert await store.clear_target(db, "2026-10") is False


async def test_the_data_stamp_moves_on_a_day_write_a_decision_a_target_and_a_customer_lookup(engine, db):
    async def stamp():
        async with store.snapshot(engine) as conn:
            return await store.revenue_data_stamp(conn)

    stamps = [await stamp()]
    await write(db, "2026-10-01", [L1])
    stamps.append(await stamp())
    await store.set_decision(db, "i1", True, NOW)
    stamps.append(await stamp())
    await store.set_target(db, "2026-10", 1, NOW)
    stamps.append(await stamp())
    await store.save_customer(db, "x", None, NOW)
    stamps.append(await stamp())
    await store.clear_target(db, "2026-10")
    stamps.append(await stamp())
    await store.add_annotation(db, "2026-10-01", "n", NOW)
    stamps.append(await stamp())
    await store.replace_items(db, [{"item_id": "i1", "name": "A"}], NOW)
    stamps.append(await stamp())
    assert len(set(stamps)) == len(stamps)


async def test_customer_first_days_ignores_unidentified_lines(engine, db):
    await write(db, "2026-10-05", [line("2026-10-05", L1, "c1")])
    await write(db, "2026-10-02", [line("2026-10-02", L2, "c1"), line("2026-10-02", {**L2, "item_id": "i3"})])
    async with store.snapshot(engine) as conn:
        assert await store.customer_first_days(conn) == {"c1": "2026-10-02"}


async def test_annotations_add_list_delete(engine, db):
    a = await store.add_annotation(db, "2026-10-02", "second", NOW)
    b = await store.add_annotation(db, "2026-10-01", "first", NOW)
    assert a["label"] == "second" and store.MAX_ANNOTATION_LABEL == 80
    async with store.snapshot(engine) as conn:
        assert [x["label"] for x in await store.read_annotations(conn)] == ["first", "second"]
    assert await store.delete_annotation(db, b["id"]) is True
    assert await store.delete_annotation(db, b["id"]) is False


async def test_scope_items_maps_a_blank_brand_and_nature_to_none_and_computes_the_unit_cost(engine, db):
    await store.replace_items(
        db,
        [
            {"item_id": "a", "name": "A", "brand": "  ", "nature": "", "item_type": "inventory", "tax_percentage": 16},
            {"item_id": "b", "name": "B", "brand": "Hobie", "nature": "Filaments"},
            {"item_id": "d", "name": "D", "purchase_rate": 500, "dealer_price": 800},
            {"item_id": "p", "name": "P", "purchase_rate": 500, "dealer_price": 0},
            {"item_id": "n", "name": "N", "purchase_rate": 0},
        ],
        NOW,
    )
    async with store.snapshot(engine) as conn:
        items = await store.read_scope_items(conn)
        synced = await store.items_synced_at(conn)
    assert items["a"] == ScopeItem("a", "A", "", None, None, "inventory", 16, None, None)
    assert items["b"].brand == "Hobie" and items["b"].nature == "Filaments" and items["b"].item_type is None
    assert [items[k].unit_cost for k in "dpn"] == [800, 500, None]
    assert synced == NOW.isoformat()
    await store.replace_items(db, [{"item_id": "z", "name": "Z"}], LATER)
    async with store.snapshot(engine) as conn:
        assert set(await store.read_scope_items(conn)) == {"z"}


async def test_items_synced_at_is_none_before_any_refresh(engine):
    async with store.snapshot(engine) as conn:
        assert await store.items_synced_at(conn) is None


async def test_timestamps_are_timezone_aware(engine, db):
    await write(db, "2026-10-01", [L1], now=NOW + timedelta(0))
    day = (await read_index(engine))[0]
    assert datetime.fromisoformat(day.fetched_at).tzinfo is not None
    async with store.snapshot(engine) as conn:
        assert (await conn.execute(text("select count(*) from revenue_days"))).scalar() == 1


async def test_write_day_keeps_each_lines_frozen_cost_and_tax_rate_null_when_unknown(engine, db):
    from backend.app.services.revenue.series import RevenueLine

    frozen = RevenueLine("2026-10-01", "i1", "", "A", "", 2, 1000, unit_cost=300, tax_percentage=16)
    await write(db, "2026-10-01", [frozen, line("2026-10-01", L2)])
    [a, b] = await read_lines(engine, "2026-10-01", "2026-10-01")
    assert (a.unit_cost, a.tax_percentage) == (300, 16)
    assert (b.unit_cost, b.tax_percentage) == (None, None)


async def test_month_checks_upsert_list_newest_first_and_move_the_stamp(engine, db):
    async def stamp():
        async with store.snapshot(engine) as conn:
            return await store.revenue_data_stamp(conn)

    before = await stamp()
    await store.save_month_check(db, "2026-08", 100, 100, NOW)
    await store.save_month_check(db, "2026-09", 200, 150, NOW)
    await store.save_month_check(db, "2026-09", 210, 210, LATER)
    async with store.snapshot(engine) as conn:
        checks = await store.read_month_checks(conn)
    assert checks == [
        {"month": "2026-09", "zohoAmount": 210, "cacheAmount": 210, "checkedAt": LATER.isoformat()},
        {"month": "2026-08", "zohoAmount": 100, "cacheAmount": 100, "checkedAt": NOW.isoformat()},
    ]
    assert await stamp() != before


async def test_month_line_sum_covers_every_line_of_the_month_only(engine, db):
    await write(db, "2026-08-31", [L2])
    await write(db, "2026-09-01", [L1, L2])
    await write(db, "2026-09-30", [L2])
    await write(db, "2026-10-01", [L2])
    assert await store.month_line_sum(db, "2026-09") == -11681 + 10785 * 2
    assert await store.month_line_sum(db, "2026-07") == 0


async def test_clear_month_drops_its_days_lines_and_check_and_nothing_else(engine, db):
    await write(db, "2026-08-31", [L2])
    await write(db, "2026-09-01", [L1, L2])
    await write(db, "2026-09-30", [])
    await store.save_month_check(db, "2026-09", 1, 2, NOW)
    await store.save_month_check(db, "2026-08", 1, 1, NOW)
    assert await store.clear_month(db, "2026-09") == 2
    assert [d.day for d in await read_index(engine)] == ["2026-08-31"]
    assert [ln.day for ln in await read_lines(engine, "2026-08-01", "2026-09-30")] == ["2026-08-31"]
    async with store.snapshot(engine) as conn:
        assert [c["month"] for c in await store.read_month_checks(conn)] == ["2026-08"]


async def test_a_full_cache_clear_drops_the_month_checks(engine, db):
    await store.save_month_check(db, "2026-09", 1, 1, NOW)
    await store.clear_revenue_cache(db)
    async with store.snapshot(engine) as conn:
        assert await store.read_month_checks(conn) == []
