"""The Order Board's writes: print stamp and parcel creation. Zoho is a fake throughout."""

import asyncio
import time
from datetime import date

import pytest
from sqlalchemy import false, select
from sqlalchemy.exc import OperationalError

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services import order_board_actions as actions, order_board_sync as sync
from backend.app.services.zoho import ZohoRateLimited, ZohoRequestRejected, ZohoUpstreamError, zoho_service
from backend.tests.unit.test_order_board_sync import (  # noqa: F401
    _synced,
    file_sessions,
    no_back_off_left_over,
    order,
    zoho,
)


async def _doc(db, zoho_id):
    return (
        await db.execute(
            select(OrderBoardDoc).where(OrderBoardDoc.kind == "salesorder", OrderBoardDoc.zoho_id == zoho_id)
        )
    ).scalar_one()


@pytest.fixture
def parcels(zoho, monkeypatch):  # noqa: F811
    """create_package on the fake: records the call and boxes the units on the stored order."""
    zoho.created = []
    zoho.create_gate = None
    zoho.create_entered = asyncio.Event()
    zoho.create_error = None

    async def create_package(db, salesorder_id, *, date, line_items):
        zoho.create_entered.set()
        if zoho.create_gate:
            await zoho.create_gate.wait()
        if zoho.create_error:
            raise zoho.create_error
        zoho.created.append((salesorder_id, date, line_items))
        doc = zoho.orders[salesorder_id]
        for item in line_items:
            for line in doc["line_items"]:
                if line["line_item_id"] == item["so_line_item_id"]:
                    line["quantity_packed"] += item["quantity"]
        doc["packages"] = [{"package_id": "pk1", "package_number": "PKG-00001", "status": "not_shipped"}]
        return {"package_id": "pk1", "package_number": "PKG-00001"}

    monkeypatch.setattr(zoho_service, "create_package", create_package)
    return zoho


async def _board(db, zoho, *docs):
    await _synced(db, zoho, *docs)


@pytest.mark.asyncio
async def test_stamp_is_on_the_row_and_survives_a_sync_pass(db_session, zoho):
    await _board(db_session, zoho, order(1))
    row = await actions.stamp_print(db_session, "so1", "paul")
    assert row["prep"]["by"] == "paul"
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    assert (await sync.read_board(db_session))["rows"][0]["prep"] == row["prep"]
    assert (await sync.read_board(db_session))["sync"]["pending"] == 0


@pytest.mark.asyncio
async def test_stamp_on_an_order_off_the_board_is_refused(db_session, zoho):
    await _board(db_session, zoho, order(1))
    with pytest.raises(actions.OrderNotOnBoard):
        await actions.stamp_print(db_session, "nope", "paul")


@pytest.mark.asyncio
async def test_create_parcel_sends_lines_date_and_no_number(db_session, parcels):
    await _board(db_session, parcels, order(1, qty=3))
    number = await actions.create_parcel(db_session, "so1", {"l1": 2, "other": 0})
    assert number == "PKG-00001"
    assert parcels.created == [("so1", date.today().isoformat(), [{"so_line_item_id": "l1", "quantity": 2}])]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("asked", "code"),
    [
        ({}, "nothing_to_pack"),
        ({"l1": 0}, "nothing_to_pack"),
        ({"nope": 1}, "unknown_line"),
        ({"l1": 3}, "too_many"),
        ({"l1": -1}, "bad_quantity"),
        ({"l1": float("nan")}, "bad_quantity"),
        ({"l1": float("inf")}, "bad_quantity"),
    ],
)
async def test_create_parcel_refuses_without_calling_zoho(db_session, parcels, asked, code):
    await _board(db_session, parcels, order(1, qty=2))
    with pytest.raises(actions.OrderActionRefused) as e:
        await actions.create_parcel(db_session, "so1", asked)
    assert e.value.args[0] == code
    assert parcels.created == []


@pytest.mark.asyncio
async def test_create_parcel_on_an_order_off_the_board_is_refused(db_session, parcels):
    with pytest.raises(actions.OrderNotOnBoard):
        await actions.create_parcel(db_session, "so1", {"l1": 1})


@pytest.mark.asyncio
async def test_fractional_packable_can_be_packed_in_full(db_session, parcels):
    await _board(db_session, parcels, order(1, qty=2.5))
    await actions.create_parcel(db_session, "so1", {"l1": 2.5})
    assert parcels.created[0][2] == [{"so_line_item_id": "l1", "quantity": 2.5}]


@pytest.mark.asyncio
async def test_busy_zoho_is_not_called(db_session, parcels):
    await _board(db_session, parcels, order(1))
    parcels.meter = sync.CALL_CEILING
    with pytest.raises(sync.ZohoBusy):
        await actions.create_parcel(db_session, "so1", {"l1": 1})
    assert parcels.created == []


@pytest.mark.asyncio
async def test_second_writer_on_the_same_order_is_refused(file_sessions, parcels):
    async with file_sessions() as one, file_sessions() as two:
        await _board(one, parcels, order(1), order(2))
        parcels.create_gate = asyncio.Event()
        first = asyncio.create_task(actions.create_parcel(one, "so1", {"l1": 1}))
        await parcels.create_entered.wait()
        with pytest.raises(actions.OrderBusy):
            await actions.create_parcel(two, "so1", {"l1": 1})
        other = asyncio.create_task(actions.create_parcel(two, "so2", {"l2": 1}))
        parcels.create_gate.set()
        assert await first == await other == "PKG-00001"
        assert [c[0] for c in parcels.created] == ["so1", "so2"]


@pytest.mark.asyncio
async def test_parcel_clears_the_stamp_and_the_row_shows_the_boxed_units(db_session, parcels):
    await _board(db_session, parcels, order(1, qty=3))
    await actions.stamp_print(db_session, "so1", "paul")
    await actions.create_parcel(db_session, "so1", {"l1": 2})
    row = (await sync.read_board(db_session))["rows"][0]
    line = row["lines"][0]
    assert row["prep"] is None
    assert (line["packed_waiting"], line["packable"]) == (2, 1)
    assert row["packages"][0]["number"] == "PKG-00001"


@pytest.mark.asyncio
async def test_a_books_refusal_changes_nothing(db_session, parcels):
    await _board(db_session, parcels, order(1, qty=3))
    await actions.stamp_print(db_session, "so1", "paul")
    before = {k: v for k, v in (await _doc(db_session, "so1")).detail.items() if k != "_fetched_at"}
    parcels.create_error = ZohoRequestRejected("no")
    with pytest.raises(ZohoRequestRejected):
        await actions.create_parcel(db_session, "so1", {"l1": 1})
    assert (await sync.read_board(db_session))["rows"][0]["prep"]["by"] == "paul"
    assert {k: v for k, v in (await _doc(db_session, "so1")).detail.items() if k != "_fetched_at"} == before


@pytest.mark.asyncio
async def test_refresh_failure_after_the_write_still_returns_the_number(db_session, parcels, monkeypatch):
    await _board(db_session, parcels, order(1, qty=3))

    async def boom(db, salesorder_id):
        raise ZohoUpstreamError("boom")

    monkeypatch.setattr(zoho_service, "get_salesorder", boom)
    assert await actions.create_parcel(db_session, "so1", {"l1": 1}) == "PKG-00001"
    assert (await _doc(db_session, "so1")).pending is True
    assert (await db_session.execute(select(OrderBoardDoc).where(OrderBoardDoc.kind == "prep"))).first() is None


def _failing_reads(monkeypatch):
    real = zoho_service.get_salesorder

    async def boom(db, salesorder_id):
        raise ZohoUpstreamError("boom")

    monkeypatch.setattr(zoho_service, "get_salesorder", boom)
    return real


@pytest.mark.asyncio
async def test_after_an_unconfirmed_write_the_next_parcel_refreshes_first_and_is_refused(
    db_session, parcels, monkeypatch
):
    await _board(db_session, parcels, order(1, qty=2))
    real = _failing_reads(monkeypatch)
    await actions.create_parcel(db_session, "so1", {"l1": 2})  # written, re-read failed
    assert sync.needs_refresh("so1")
    monkeypatch.setattr(zoho_service, "get_salesorder", real)
    with pytest.raises(actions.OrderActionRefused) as e:
        await actions.create_parcel(db_session, "so1", {"l1": 2})
    assert e.value.args[0] == "too_many"
    assert len(parcels.created) == 1
    assert not sync.needs_refresh("so1")


@pytest.mark.asyncio
async def test_if_the_entry_refresh_fails_too_nothing_is_written(db_session, parcels, monkeypatch):
    await _board(db_session, parcels, order(1, qty=2))
    _failing_reads(monkeypatch)
    await actions.create_parcel(db_session, "so1", {"l1": 1})
    with pytest.raises(ZohoUpstreamError):
        await actions.create_parcel(db_session, "so1", {"l1": 1})
    assert len(parcels.created) == 1


@pytest.mark.asyncio
async def test_a_create_timeout_triggers_one_refresh_and_reraises(db_session, parcels):
    await _board(db_session, parcels, order(1, qty=2))
    parcels.create_error = ZohoUpstreamError("timeout")
    reads = parcels.calls["detail"]
    with pytest.raises(ZohoUpstreamError, match="timeout"):
        await actions.create_parcel(db_session, "so1", {"l1": 1})
    assert parcels.calls["detail"] == reads + 1


@pytest.mark.asyncio
async def test_a_create_timeout_whose_refresh_fails_leaves_the_order_unconfirmed(db_session, parcels, monkeypatch):
    await _board(db_session, parcels, order(1, qty=2))
    parcels.create_error = ZohoUpstreamError("timeout")
    _failing_reads(monkeypatch)
    with pytest.raises(ZohoUpstreamError, match="timeout"):
        await actions.create_parcel(db_session, "so1", {"l1": 1})
    assert sync.needs_refresh("so1")


@pytest.mark.asyncio
async def test_a_rate_limited_write_opens_the_back_off_window(db_session, parcels):
    await _board(db_session, parcels, order(1))
    parcels.create_error = ZohoRateLimited("429", retry_after=30)
    with pytest.raises(ZohoRateLimited):
        await actions.create_parcel(db_session, "so1", {"l1": 1})
    assert sync._rate_limited_until > time.monotonic() + 20


@pytest.mark.asyncio
async def test_a_database_error_on_the_stamp_delete_still_returns_the_number(db_session, parcels, monkeypatch):
    await _board(db_session, parcels, order(1, qty=2))
    await actions.stamp_print(db_session, "so1", "paul")
    real_commit = db_session.commit
    calls = []

    async def flaky():
        calls.append(1)
        if len(calls) == 1:
            raise OperationalError("COMMIT", {}, Exception("database is locked"))
        await real_commit()

    monkeypatch.setattr(db_session, "commit", flaky)
    assert await actions.create_parcel(db_session, "so1", {"l1": 1}) == "PKG-00001"
    assert (await _doc(db_session, "so1")).pending is True


@pytest.mark.asyncio
async def test_a_simultaneous_first_stamp_updates_the_winner_instead_of_failing(file_sessions, zoho, monkeypatch):
    async with file_sessions() as one, file_sessions() as two:
        await _board(one, zoho, order(1))
        real_query = actions._prep_query
        calls = []

        def blind_first(salesorder_id):
            calls.append(1)
            return select(OrderBoardDoc).where(false()) if len(calls) == 1 else real_query(salesorder_id)

        monkeypatch.setattr(actions, "_prep_query", blind_first)
        await actions.stamp_print(two, "so1", "winner")
        row = await actions.stamp_print(one, "so1", "loser")
        assert row["prep"]["by"] == "loser"
        stamps = (await one.execute(select(OrderBoardDoc).where(OrderBoardDoc.kind == "prep"))).scalars().all()
        assert len(stamps) == 1
