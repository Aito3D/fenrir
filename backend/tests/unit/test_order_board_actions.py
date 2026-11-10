"""The Order Board's writes: print stamp and parcel creation. Zoho is a fake throughout."""

import asyncio
import copy
import time
from collections import Counter
from datetime import date

import pytest
from sqlalchemy import false, select
from sqlalchemy.exc import OperationalError

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services import order_board_actions as actions, order_board_sync as sync
from backend.app.services.zoho import (
    ZohoNotFound,
    ZohoRateLimited,
    ZohoRequestRejected,
    ZohoUpstreamError,
    zoho_service,
)
from backend.tests.unit.test_order_board_sync import (  # noqa: F401
    _synced,
    file_sessions,
    no_back_off_left_over,
    order,
    zoho,
)


def _rate_limited():
    return ZohoRateLimited("429", retry_after=30)


def _assert_window_open():
    assert sync._rate_limited_until > time.monotonic() + 20


async def _doc(db, zoho_id):
    return (
        await db.execute(
            select(OrderBoardDoc).where(OrderBoardDoc.kind == "salesorder", OrderBoardDoc.zoho_id == zoho_id)
        )
    ).scalar_one()


@pytest.fixture
def parcels(zoho, monkeypatch):  # noqa: F811
    """Picklists and create_package on the fake: each call is recorded and shows on the stored order."""
    zoho.created = []
    zoho.create_gate = None
    zoho.create_entered = asyncio.Event()
    zoho.create_error = None
    zoho.picklists = {}
    zoho.writes = []
    zoho.bodies = {}
    zoho.prefill_error = None
    zoho.packages = {}
    zoho.steps = []  # (step, body) per write, for the parcel edit
    zoho.fail_step = None
    zoho.fail_with = ZohoUpstreamError

    def step(name, body):
        """Raise once on ``zoho.fail_step``, before Books changes anything; else record the write."""
        if zoho.fail_step == name:
            zoho.fail_step = None
            raise zoho.fail_with(f"{name} failed")
        zoho.steps.append((name, body))

    def bump(doc):
        """Books moves the order's last_modified_time on every write that touches it."""
        zoho.bumps = getattr(zoho, "bumps", 0) + 1
        doc["last_modified_time"] = f"2026-11-07T08:{zoho.bumps:02d}:00-1000"

    def order_of_picklist(picklist_id):
        return next(
            doc
            for doc in zoho.orders.values()
            if any(p["picklist_id"] == picklist_id for p in doc.get("picklists") or [])
        )

    def order_line(line_id):
        return next(
            line for doc in zoho.orders.values() for line in doc["line_items"] if line["line_item_id"] == line_id
        )

    def box(line_items, sign):
        """Count (sign 1) or uncount (-1) a package's units on the order lines and on the picklist rows."""
        for item in line_items:
            order_line(item["so_line_item_id"])["quantity_packed"] += sign * item["quantity"]
            for pl in zoho.picklists.values():
                for row in pl["line_items"]:
                    if row["line_item_id"] == item.get("picklist_item_id"):
                        row["quantity_packed"] += sign * item["quantity"]

    def listed(line_id):
        return sum(
            row["quantity_to_be_picked"]
            for pl in zoho.picklists.values()
            for row in pl["line_items"]
            if row["so_line_item_id"] == line_id
        )

    async def picklist_prefill(db, salesorder_id):
        if zoho.prefill_error:
            raise zoho.prefill_error
        lines = [
            {
                "salesorder_id": salesorder_id,
                "so_line_item_id": line["line_item_id"],
                "quantity_to_be_picked": line["quantity"] - listed(line["line_item_id"]),
                "quantity_picked": 0,
            }
            for line in zoho.orders[salesorder_id]["line_items"]
        ]
        return {"location_id": "loc1", "line_items": [line for line in lines if line["quantity_to_be_picked"] > 0]}

    def mirror(pl):
        for doc in zoho.orders.values():
            for entry in doc.get("picklists") or []:
                if entry["picklist_id"] == pl["picklist_id"]:
                    entry["status"] = pl["status"]

    async def create_picklist(db, body):
        step("create_picklist", body)
        zoho.writes.append("create_picklist")
        zoho.bodies["create_picklist"] = body
        pid = f"pl{len(zoho.picklists) + 1}"
        pl = {
            "picklist_id": pid,
            "picklist_number": f"PL-{len(zoho.picklists) + 1:05d}",
            "status": "yet_to_start",
            "date": body["date"],
            "location_id": body["location_id"],
            "line_items": [
                {**row, "line_item_id": f"{pid}-{row['so_line_item_id']}", "quantity_packed": 0}
                for row in body["line_items"]
            ],
        }
        zoho.picklists[pid] = pl
        doc = zoho.orders[body["line_items"][0]["salesorder_id"]]
        doc.setdefault("picklists", []).append(
            {"picklist_id": pid, "picklist_number": pl["picklist_number"], "status": pl["status"], "date": pl["date"]}
        )
        return copy.deepcopy(pl)

    async def get_picklist(db, picklist_id):
        if picklist_id not in zoho.picklists:
            raise ZohoNotFound("no such picklist")
        return copy.deepcopy(zoho.picklists[picklist_id])

    async def update_picklist(db, picklist_id, body):
        step("picklist", body)
        zoho.writes.append("update_picklist")
        zoho.bodies["update_picklist"] = zoho.bodies["picklist"] = body
        pl = zoho.picklists[picklist_id]
        bump(order_of_picklist(picklist_id))
        done = pl["status"] == "completed"
        if done:  # a completed picklist's units count as picked on the order
            for row in pl["line_items"]:
                order_line(row["so_line_item_id"])["quantity_picked"] -= row["quantity_picked"]
        sent = {row["line_item_id"]: row for row in body["line_items"] if row.get("line_item_id")}
        pl["line_items"] = [
            {**row, **sent[row["line_item_id"]]} for row in pl["line_items"] if row["line_item_id"] in sent
        ] + [
            {**row, "line_item_id": f"{picklist_id}-{row['so_line_item_id']}", "quantity_packed": 0}
            for row in body["line_items"]
            if not row.get("line_item_id")
        ]
        if done:
            for row in pl["line_items"]:
                order_line(row["so_line_item_id"])["quantity_picked"] += row["quantity_picked"]
        else:
            pl["status"] = "in_progress"
        mirror(pl)
        return copy.deepcopy(pl)

    async def complete_picklist(db, picklist_id):
        step("complete_picklist", picklist_id)
        zoho.writes.append("complete_picklist")
        pl = zoho.picklists[picklist_id]
        pl["status"] = "completed"
        mirror(pl)
        for row in pl["line_items"]:
            for doc in zoho.orders.values():
                for line in doc["line_items"]:
                    if line["line_item_id"] == row["so_line_item_id"]:
                        line["quantity_picked"] = line.get("quantity_picked", 0) + row["quantity_picked"]

    async def create_package(db, salesorder_id, *, date, line_items):
        zoho.create_entered.set()
        if zoho.create_gate:
            await zoho.create_gate.wait()
        if zoho.create_error:
            raise zoho.create_error
        step("create_package", line_items)
        zoho.writes.append("create_package")
        zoho.created.append((salesorder_id, date, line_items))
        doc = zoho.orders[salesorder_id]
        bump(doc)
        for item in line_items:
            for line in doc["line_items"]:
                if line["line_item_id"] == item["so_line_item_id"]:
                    line["quantity_packed"] += item["quantity"]
            for pl in zoho.picklists.values():
                for row in pl["line_items"]:
                    if row["line_item_id"] == item.get("picklist_item_id"):
                        row["quantity_packed"] += item["quantity"]
        doc["packages"] = [{"package_id": "pk1", "package_number": "PKG-00001", "status": "not_shipped"}]
        return {"package_id": "pk1", "package_number": "PKG-00001"}

    async def get_package(db, package_id):
        if package_id not in zoho.packages:
            raise ZohoNotFound("no such package")
        return copy.deepcopy(zoho.packages[package_id])

    async def update_package(db, package_id, salesorder_id, body):
        step("parcel", body)
        zoho.bodies["parcel"] = body
        bump(zoho.orders[salesorder_id])
        package = zoho.packages[package_id]
        box(package["line_items"], -1)
        package["line_items"] = copy.deepcopy(body["line_items"])
        box(package["line_items"], 1)
        return copy.deepcopy(package)

    async def delete_package(db, package_id):
        step("delete_package", package_id)
        box(zoho.packages.pop(package_id)["line_items"], -1)
        for doc in zoho.orders.values():
            if any(p["package_id"] == package_id for p in doc.get("packages") or []):
                bump(doc)
            doc["packages"] = [p for p in doc.get("packages") or [] if p["package_id"] != package_id]

    async def delete_picklist(db, picklist_id):
        step("delete_picklist", picklist_id)
        bump(order_of_picklist(picklist_id))
        pl = zoho.picklists.pop(picklist_id)
        if pl["status"] == "completed":
            for row in pl["line_items"]:
                order_line(row["so_line_item_id"])["quantity_picked"] -= row["quantity_picked"]
        for doc in zoho.orders.values():
            doc["picklists"] = [p for p in doc.get("picklists") or [] if p["picklist_id"] != picklist_id]

    for call in (
        picklist_prefill,
        create_picklist,
        get_picklist,
        update_picklist,
        complete_picklist,
        create_package,
        get_package,
        update_package,
        delete_package,
        delete_picklist,
    ):
        monkeypatch.setattr(zoho_service, call.__name__, call)
    return zoho


async def _board(db, zoho, *docs):
    await _synced(db, zoho, *docs)


async def _pick(db, salesorder_id, quantities) -> str:
    """A picklist made here, and the passes that confirm the stored copy afterwards (as when the operator
    comes back from the shelf)."""
    picklist = await actions.create_picklist(db, salesorder_id, quantities)
    await sync.run_pass(db)
    await sync.run_pass(db)
    return picklist["id"]


def _two_lines(n=1, qty=2):
    doc = order(n, qty=qty)
    doc["line_items"].append({**doc["line_items"][0], "line_item_id": "lb", "item_id": "B"})
    return doc


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


# --- Picklist ----------------------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_preview_offers_what_books_offers_within_what_the_shelf_covers(db_session, parcels):
    await _board(db_session, parcels, order(1, qty=3))
    assert await actions.picklist_preview(db_session, "so1") == {"lines": [{"line_id": "l1", "quantity": 3}]}
    parcels.stock["A"] = 2
    await sync.run_pass(db_session)
    assert await actions.picklist_preview(db_session, "so1") == {"lines": [{"line_id": "l1", "quantity": 2}]}
    assert parcels.writes == []


@pytest.mark.asyncio
async def test_preview_sets_aside_the_units_picked_and_not_boxed(db_session, parcels):
    doc = order(1, qty=5)
    doc["line_items"][0]["quantity_picked"] = 2  # an older, completed picklist that was never boxed
    parcels.stock["A"] = 4
    await _board(db_session, parcels, doc)
    assert await actions.picklist_preview(db_session, "so1") == {"lines": [{"line_id": "l1", "quantity": 2}]}
    assert (await sync.read_board(db_session))["rows"][0]["picked"] == 2


@pytest.mark.asyncio
async def test_create_picklist_sends_the_chosen_units_and_shows_on_the_row(db_session, parcels):
    await _board(db_session, parcels, _two_lines(qty=3))
    parcels.stock["B"] = 3
    await sync.run_pass(db_session)
    picklist = await actions.create_picklist(db_session, "so1", {"l1": 2, "lb": 0})
    assert picklist == {"id": "pl1", "number": "PL-00001"}
    assert parcels.bodies["create_picklist"] == {
        "date": date.today().isoformat(),
        "location_id": "loc1",
        "parent_entity": "salesorder",
        "group_by": "none",
        "line_items": [
            {"salesorder_id": "so1", "so_line_item_id": "l1", "quantity_to_be_picked": 2, "quantity_picked": 0}
        ],
    }
    row = (await sync.read_board(db_session))["rows"][0]
    assert row["picklists"] == [
        {"id": "pl1", "number": "PL-00001", "status": "yet_to_start", "date": date.today().isoformat()}
    ]


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
    ],
)
async def test_create_picklist_refuses_without_writing(db_session, parcels, asked, code):
    await _board(db_session, parcels, order(1, qty=2))
    with pytest.raises(actions.OrderActionRefused) as e:
        await actions.create_picklist(db_session, "so1", asked)
    assert e.value.args[0] == code
    assert parcels.writes == []


@pytest.mark.asyncio
async def test_one_open_picklist_at_a_time(db_session, parcels):
    await _board(db_session, parcels, order(1, qty=3))
    await _pick(db_session, "so1", {"l1": 1})
    for call in (actions.picklist_preview(db_session, "so1"), actions.create_picklist(db_session, "so1", {"l1": 1})):
        with pytest.raises(actions.OrderActionRefused) as e:
            await call
        assert e.value.args[0] == "picklist_open"
    assert parcels.writes == ["create_picklist"]


@pytest.mark.asyncio
async def test_a_rate_limited_prefill_is_busy_and_opens_the_window(db_session, parcels):
    await _board(db_session, parcels, order(1))
    parcels.prefill_error = _rate_limited()
    with pytest.raises(sync.ZohoBusy):
        await actions.create_picklist(db_session, "so1", {"l1": 1})
    _assert_window_open()
    assert parcels.writes == []


@pytest.mark.asyncio
async def test_a_picklist_timeout_triggers_one_refresh_and_reraises(db_session, parcels, monkeypatch):
    await _board(db_session, parcels, order(1))

    async def timeout(db, body):
        raise ZohoUpstreamError("timeout")

    monkeypatch.setattr(zoho_service, "create_picklist", timeout)
    reads = parcels.calls["detail"]
    with pytest.raises(ZohoUpstreamError, match="timeout"):
        await actions.create_picklist(db_session, "so1", {"l1": 1})
    assert parcels.calls["detail"] == reads + 1


@pytest.mark.asyncio
async def test_content_lists_what_is_left_to_box(db_session, parcels):
    await _board(db_session, parcels, order(1, qty=3))
    pl = await _pick(db_session, "so1", {"l1": 2})
    content = await actions.picklist_content(db_session, "so1", pl)
    assert content == {
        "id": "pl1",
        "number": "PL-00001",
        "status": "yet_to_start",
        "lines": [{"line_id": "l1", "quantity": 2}],
    }
    with pytest.raises(actions.OrderActionRefused) as e:
        await actions.picklist_content(db_session, "so1", "nope")
    assert e.value.args[0] == "unknown_picklist"


@pytest.mark.asyncio
async def test_busy_zoho_gives_no_picklist_preview(db_session, parcels):
    await _board(db_session, parcels, order(1))
    parcels.meter = sync.CALL_CEILING
    reads = parcels.calls["detail"]
    with pytest.raises(sync.ZohoBusy):
        await actions.picklist_preview(db_session, "so1")
    assert parcels.calls["detail"] == reads
    assert parcels.writes == []


@pytest.mark.asyncio
async def test_a_picklist_gone_from_books_is_unknown(db_session, parcels, monkeypatch):
    await _board(db_session, parcels, order(1))
    pl = await _pick(db_session, "so1", {"l1": 1})

    async def gone(db, picklist_id):
        raise ZohoNotFound("no such picklist")

    monkeypatch.setattr(zoho_service, "get_picklist", gone)
    with pytest.raises(actions.OrderActionRefused) as e:
        await actions.picklist_content(db_session, "so1", pl)
    assert e.value.args[0] == "unknown_picklist"
    assert sync._rate_limited_until == 0.0


@pytest.mark.asyncio
async def test_a_rate_limited_picklist_read_is_busy_and_opens_the_window(db_session, parcels, monkeypatch):
    await _board(db_session, parcels, order(1))
    pl = await _pick(db_session, "so1", {"l1": 1})

    async def limited(db, picklist_id):
        raise _rate_limited()

    monkeypatch.setattr(zoho_service, "get_picklist", limited)
    with pytest.raises(sync.ZohoBusy):
        await actions.picklist_content(db_session, "so1", pl)
    _assert_window_open()


# --- Parcel ------------------------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_parcel_completes_the_picklist_then_boxes_its_units(db_session, parcels):
    await _board(db_session, parcels, order(1, qty=3))
    pl = await _pick(db_session, "so1", {"l1": 2})
    number = await actions.create_parcel(db_session, "so1", pl, {"l1": 2, "other": 0})
    assert number == "PKG-00001"
    assert parcels.writes == ["create_picklist", "update_picklist", "complete_picklist", "create_package"]
    assert parcels.bodies["update_picklist"] == {
        "date": date.today().isoformat(),
        "location_id": "loc1",
        "line_items": [{"line_item_id": "pl1-l1", "quantity_to_be_picked": 2, "quantity_picked": 2}],
    }
    assert parcels.created == [
        ("so1", date.today().isoformat(), [{"so_line_item_id": "l1", "quantity": 2, "picklist_item_id": "pl1-l1"}])
    ]
    row = (await sync.read_board(db_session))["rows"][0]
    assert (row["picklists"][0]["status"], row["picked"]) == ("completed", 0)


@pytest.mark.asyncio
async def test_boxing_less_than_picked_frees_the_rest_for_a_second_picklist(db_session, parcels):
    await _board(db_session, parcels, _two_lines(qty=3))
    parcels.stock["B"] = 3
    await sync.run_pass(db_session)
    pl = await _pick(db_session, "so1", {"l1": 3, "lb": 3})
    await actions.create_parcel(db_session, "so1", pl, {"l1": 2})  # one missing on the shelf, lb left for later
    assert parcels.bodies["update_picklist"]["line_items"] == [
        {"line_item_id": "pl1-l1", "quantity_to_be_picked": 2, "quantity_picked": 2}
    ]
    assert await actions.picklist_preview(db_session, "so1") == {
        "lines": [{"line_id": "l1", "quantity": 1}, {"line_id": "lb", "quantity": 3}]
    }
    second = await _pick(db_session, "so1", {"l1": 1, "lb": 3})
    await actions.create_parcel(db_session, "so1", second, {"l1": 1, "lb": 3})
    row = (await sync.read_board(db_session))["rows"][0]
    assert [line["packable"] for line in row["lines"]] == [0, 0]
    assert [p["status"] for p in row["picklists"]] == ["completed", "completed"]


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
    await _board(db_session, parcels, order(1, qty=3))
    pl = await _pick(db_session, "so1", {"l1": 2})
    with pytest.raises(actions.OrderActionRefused) as e:
        await actions.create_parcel(db_session, "so1", pl, asked)
    assert e.value.args[0] == code
    assert parcels.writes == ["create_picklist"]


@pytest.mark.asyncio
async def test_a_picklist_of_another_order_or_shared_with_one_is_refused(db_session, parcels):
    await _board(db_session, parcels, order(1), order(2))
    other = await _pick(db_session, "so2", {"l2": 1})
    with pytest.raises(actions.OrderActionRefused) as e:
        await actions.create_parcel(db_session, "so1", other, {"l1": 1})
    assert e.value.args[0] == "unknown_picklist"
    mine = await _pick(db_session, "so1", {"l1": 1})
    parcels.picklists[mine]["line_items"].append({**parcels.picklists[other]["line_items"][0]})
    with pytest.raises(actions.OrderActionRefused) as e:
        await actions.create_parcel(db_session, "so1", mine, {"l1": 1})
    assert e.value.args[0] == "picklist_shared"
    assert parcels.writes == ["create_picklist", "create_picklist"]


@pytest.mark.asyncio
async def test_create_parcel_on_an_order_off_the_board_is_refused(db_session, parcels):
    with pytest.raises(actions.OrderNotOnBoard):
        await actions.create_parcel(db_session, "so1", "pl1", {"l1": 1})


@pytest.mark.asyncio
async def test_fractional_units_can_be_boxed_in_full(db_session, parcels):
    await _board(db_session, parcels, order(1, qty=2.5))
    pl = await _pick(db_session, "so1", {"l1": 2.5})
    await actions.create_parcel(db_session, "so1", pl, {"l1": 2.5})
    assert parcels.created[0][2] == [{"so_line_item_id": "l1", "quantity": 2.5, "picklist_item_id": "pl1-l1"}]


@pytest.mark.asyncio
async def test_busy_zoho_is_not_called(db_session, parcels):
    await _board(db_session, parcels, order(1))
    pl = await _pick(db_session, "so1", {"l1": 1})
    parcels.meter = sync.CALL_CEILING
    with pytest.raises(sync.ZohoBusy):
        await actions.create_parcel(db_session, "so1", pl, {"l1": 1})
    with pytest.raises(sync.ZohoBusy):
        await actions.picklist_content(db_session, "so1", pl)
    assert parcels.writes == ["create_picklist"]


@pytest.mark.asyncio
async def test_second_writer_on_the_same_order_is_refused(file_sessions, parcels):
    async with file_sessions() as one, file_sessions() as two:
        await _board(one, parcels, order(1), order(2))
        pl1, pl2 = await _pick(one, "so1", {"l1": 1}), await _pick(two, "so2", {"l2": 1})
        parcels.create_gate = asyncio.Event()
        first = asyncio.create_task(actions.create_parcel(one, "so1", pl1, {"l1": 1}))
        await parcels.create_entered.wait()
        with pytest.raises(actions.OrderBusy):
            await actions.create_parcel(two, "so1", pl1, {"l1": 1})
        with pytest.raises(actions.OrderBusy):
            await actions.create_picklist(two, "so1", {"l1": 1})
        other = asyncio.create_task(actions.create_parcel(two, "so2", pl2, {"l2": 1}))
        parcels.create_gate.set()
        assert await first == await other == "PKG-00001"
        assert [c[0] for c in parcels.created] == ["so1", "so2"]


@pytest.mark.asyncio
async def test_parcel_clears_the_stamp_and_the_row_shows_the_boxed_units(db_session, parcels):
    await _board(db_session, parcels, order(1, qty=3))
    pl = await _pick(db_session, "so1", {"l1": 2})
    await actions.stamp_print(db_session, "so1", "paul")
    await actions.create_parcel(db_session, "so1", pl, {"l1": 2})
    row = (await sync.read_board(db_session))["rows"][0]
    line = row["lines"][0]
    assert row["prep"] is None
    assert (line["packed_waiting"], line["packable"]) == (2, 1)
    assert row["packages"][0]["number"] == "PKG-00001"


@pytest.mark.asyncio
async def test_a_retry_after_a_refused_parcel_repeats_no_picklist_write(db_session, parcels):
    await _board(db_session, parcels, order(1, qty=3))
    pl = await _pick(db_session, "so1", {"l1": 2})
    await actions.stamp_print(db_session, "so1", "paul")
    parcels.create_error = ZohoRequestRejected("no")
    with pytest.raises(ZohoRequestRejected):
        await actions.create_parcel(db_session, "so1", pl, {"l1": 2})
    row = (await sync.read_board(db_session))["rows"][0]
    assert (row["prep"]["by"], row["lines"][0]["packed_waiting"], row["picked"]) == ("paul", 0, 2)
    assert row["picklists"][0]["status"] == "completed"
    parcels.create_error = None
    assert await actions.create_parcel(db_session, "so1", pl, {"l1": 2}) == "PKG-00001"
    assert parcels.writes == ["create_picklist", "update_picklist", "complete_picklist", "create_package"]


@pytest.mark.asyncio
@pytest.mark.parametrize("linked", [True, False])
async def test_a_parcel_books_created_behind_a_timeout_is_not_repeated(db_session, parcels, monkeypatch, linked):
    """Books made the package and the answer was lost. The retry is refused whether or not Books counted the
    package on the picklist row: the order's own picked-and-not-boxed units say there is nothing left."""
    await _board(db_session, parcels, order(1, qty=5))
    pl = await _pick(db_session, "so1", {"l1": 2})
    real = zoho_service.create_package

    async def lost_answer(db, salesorder_id, *, date, line_items):
        await real(
            db,
            salesorder_id,
            date=date,
            line_items=line_items if linked else [{**i, "picklist_item_id": ""} for i in line_items],
        )
        raise ZohoUpstreamError("timeout")

    monkeypatch.setattr(zoho_service, "create_package", lost_answer)
    with pytest.raises(ZohoUpstreamError, match="timeout"):
        await actions.create_parcel(db_session, "so1", pl, {"l1": 2})
    with pytest.raises(actions.OrderActionRefused) as e:
        await actions.create_parcel(db_session, "so1", pl, {"l1": 2})
    assert e.value.args[0] == "too_many"
    assert len(parcels.created) == 1
    assert parcels.writes.count("update_picklist") == parcels.writes.count("complete_picklist") == 1


@pytest.mark.asyncio
async def test_units_boxed_in_books_without_the_picklist_are_not_boxed_again(db_session, parcels):
    await _board(db_session, parcels, order(1, qty=2))
    pl = await _pick(db_session, "so1", {"l1": 2})
    parcels.orders["so1"]["line_items"][0]["quantity_packed"] = 2  # a parcel made in Books, not from the picklist
    doc = await _doc(db_session, "so1")
    doc.pending = True
    await db_session.commit()
    with pytest.raises(actions.OrderActionRefused) as e:
        await actions.create_parcel(db_session, "so1", pl, {"l1": 2})
    assert e.value.args[0] == "too_many"
    assert parcels.writes == ["create_picklist"]


@pytest.mark.asyncio
async def test_a_retry_that_boxes_less_leaves_the_rest_on_the_completed_picklist(db_session, parcels):
    await _board(db_session, parcels, order(1, qty=3))
    pl = await _pick(db_session, "so1", {"l1": 3})
    parcels.create_error = ZohoRequestRejected("no")
    with pytest.raises(ZohoRequestRejected):
        await actions.create_parcel(db_session, "so1", pl, {"l1": 3})
    parcels.create_error = None
    await actions.create_parcel(db_session, "so1", pl, {"l1": 2})
    assert (await actions.picklist_content(db_session, "so1", pl))["lines"] == [{"line_id": "l1", "quantity": 1}]
    assert (await sync.read_board(db_session))["rows"][0]["picked"] == 1
    assert await actions.create_parcel(db_session, "so1", pl, {"l1": 1}) == "PKG-00001"
    assert parcels.writes.count("update_picklist") == 1


@pytest.mark.asyncio
async def test_two_rows_for_one_line_are_left_to_books(db_session, parcels):
    await _board(db_session, parcels, order(1, qty=5))
    pl = await _pick(db_session, "so1", {"l1": 3})
    rows = parcels.picklists[pl]["line_items"]
    rows.append({**rows[0], "line_item_id": "pl1-l1-bis", "quantity_to_be_picked": 2})
    for call in (
        actions.picklist_content(db_session, "so1", pl),
        actions.create_parcel(db_session, "so1", pl, {"l1": 1}),
    ):
        with pytest.raises(actions.OrderActionRefused) as e:
            await call
        assert e.value.args[0] == "picklist_shared"
    assert parcels.writes == ["create_picklist"]


@pytest.mark.asyncio
async def test_a_row_already_boxed_stays_on_the_picklist_when_it_is_cut_down(db_session, parcels):
    await _board(db_session, parcels, _two_lines(qty=3))
    parcels.stock["B"] = 3
    await sync.run_pass(db_session)
    pl = await _pick(db_session, "so1", {"l1": 3, "lb": 2})
    row_b = next(r for r in parcels.picklists[pl]["line_items"] if r["so_line_item_id"] == "lb")
    row_b["quantity_packed"] = 2  # boxed in Books from the open picklist
    await actions.create_parcel(db_session, "so1", pl, {"l1": 1})
    assert parcels.bodies["update_picklist"]["line_items"] == [
        {"line_item_id": "pl1-l1", "quantity_to_be_picked": 1, "quantity_picked": 1},
        {"line_item_id": "pl1-lb", "quantity_to_be_picked": 2, "quantity_picked": 2},
    ]
    assert parcels.created[0][2] == [{"so_line_item_id": "l1", "quantity": 1, "picklist_item_id": "pl1-l1"}]


@pytest.mark.asyncio
async def test_prefill_rows_for_one_line_are_summed(db_session, parcels, monkeypatch):
    await _board(db_session, parcels, order(1, qty=5))

    async def split(db, salesorder_id):
        row = {"salesorder_id": "so1", "so_line_item_id": "l1", "quantity_picked": 0}
        return {
            "location_id": "loc1",
            "line_items": [{**row, "quantity_to_be_picked": 3}, {**row, "quantity_to_be_picked": 1}],
        }

    monkeypatch.setattr(zoho_service, "picklist_prefill", split)
    assert await actions.picklist_preview(db_session, "so1") == {"lines": [{"line_id": "l1", "quantity": 4}]}


@pytest.mark.asyncio
async def test_an_update_that_already_completes_the_picklist_is_not_completed_twice(db_session, parcels, monkeypatch):
    await _board(db_session, parcels, order(1))
    pl = await _pick(db_session, "so1", {"l1": 1})
    real = zoho_service.update_picklist

    async def completing(db, picklist_id, body):
        await real(db, picklist_id, body)
        parcels.picklists[picklist_id]["status"] = "completed"
        return {"status": "completed"}

    monkeypatch.setattr(zoho_service, "update_picklist", completing)
    await actions.create_parcel(db_session, "so1", pl, {"l1": 1})
    assert parcels.writes == ["create_picklist", "update_picklist", "create_package"]


@pytest.mark.asyncio
async def test_refresh_failure_after_the_write_still_returns_the_number(db_session, parcels, monkeypatch):
    await _board(db_session, parcels, order(1, qty=3))
    pl = await _pick(db_session, "so1", {"l1": 1})

    async def boom(db, salesorder_id):
        raise ZohoUpstreamError("boom")

    monkeypatch.setattr(zoho_service, "get_salesorder", boom)
    assert await actions.create_parcel(db_session, "so1", pl, {"l1": 1}) == "PKG-00001"
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
    pl = await _pick(db_session, "so1", {"l1": 2})
    real = _failing_reads(monkeypatch)
    await actions.create_parcel(db_session, "so1", pl, {"l1": 2})  # written, re-read failed
    assert sync.needs_refresh("so1")
    monkeypatch.setattr(zoho_service, "get_salesorder", real)
    with pytest.raises(actions.OrderActionRefused) as e:
        await actions.create_parcel(db_session, "so1", pl, {"l1": 2})
    assert e.value.args[0] == "too_many"
    assert len(parcels.created) == 1
    assert not sync.needs_refresh("so1")


@pytest.mark.asyncio
async def test_if_the_entry_refresh_fails_too_nothing_is_written(db_session, parcels, monkeypatch):
    await _board(db_session, parcels, order(1, qty=2))
    pl = await _pick(db_session, "so1", {"l1": 2})
    _failing_reads(monkeypatch)
    await actions.create_parcel(db_session, "so1", pl, {"l1": 1})
    with pytest.raises(ZohoUpstreamError):
        await actions.create_parcel(db_session, "so1", pl, {"l1": 1})
    assert len(parcels.created) == 1


@pytest.mark.asyncio
async def test_a_create_timeout_triggers_one_refresh_and_reraises(db_session, parcels):
    await _board(db_session, parcels, order(1, qty=2))
    pl = await _pick(db_session, "so1", {"l1": 1})
    parcels.create_error = ZohoUpstreamError("timeout")
    reads = parcels.calls["detail"]
    with pytest.raises(ZohoUpstreamError, match="timeout"):
        await actions.create_parcel(db_session, "so1", pl, {"l1": 1})
    assert parcels.calls["detail"] == reads + 1


@pytest.mark.asyncio
async def test_a_create_timeout_whose_refresh_fails_leaves_the_order_unconfirmed(db_session, parcels, monkeypatch):
    await _board(db_session, parcels, order(1, qty=2))
    pl = await _pick(db_session, "so1", {"l1": 1})
    parcels.create_error = ZohoUpstreamError("timeout")
    _failing_reads(monkeypatch)
    with pytest.raises(ZohoUpstreamError, match="timeout"):
        await actions.create_parcel(db_session, "so1", pl, {"l1": 1})
    assert sync.needs_refresh("so1")


@pytest.mark.asyncio
async def test_a_rate_limited_write_opens_the_back_off_window(db_session, parcels):
    await _board(db_session, parcels, order(1))
    pl = await _pick(db_session, "so1", {"l1": 1})
    parcels.create_error = _rate_limited()
    with pytest.raises(ZohoRateLimited):
        await actions.create_parcel(db_session, "so1", pl, {"l1": 1})
    _assert_window_open()


@pytest.mark.asyncio
async def test_a_database_error_on_the_stamp_delete_still_returns_the_number(db_session, parcels, monkeypatch):
    await _board(db_session, parcels, order(1, qty=2))
    pl = await _pick(db_session, "so1", {"l1": 1})
    await actions.stamp_print(db_session, "so1", "paul")
    real_commit = db_session.commit
    calls = []

    async def flaky():
        calls.append(1)
        if len(calls) == 1:
            raise OperationalError("COMMIT", {}, Exception("database is locked"))
        await real_commit()

    monkeypatch.setattr(db_session, "commit", flaky)
    assert await actions.create_parcel(db_session, "so1", pl, {"l1": 1}) == "PKG-00001"
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


@pytest.mark.asyncio
async def test_a_pending_stored_copy_is_reread_before_a_parcel(db_session, parcels):
    """The pending flag survives a restart, where the in-memory unconfirmed mark does not."""
    await _board(db_session, parcels, order(1, qty=2))
    # A picklist made in Books meanwhile: the stored copy does not list it yet.
    await zoho_service.create_picklist(
        db_session,
        {
            "date": "2026-11-01",
            "location_id": "loc1",
            "line_items": [
                {"salesorder_id": "so1", "so_line_item_id": "l1", "quantity_to_be_picked": 2, "quantity_picked": 0}
            ],
        },
    )
    with pytest.raises(actions.OrderActionRefused) as e:
        await actions.create_parcel(db_session, "so1", "pl1", {"l1": 2})
    assert e.value.args[0] == "unknown_picklist"
    doc = await _doc(db_session, "so1")
    doc.pending = True
    await db_session.commit()
    assert await actions.create_parcel(db_session, "so1", "pl1", {"l1": 2}) == "PKG-00001"


@pytest.mark.asyncio
async def test_an_unstored_order_needing_a_refresh_is_not_on_the_board(db_session, parcels):
    await _board(db_session, parcels, order(1))
    sync.note_write("so9")
    with pytest.raises(actions.OrderNotOnBoard):
        await actions.create_parcel(db_session, "so9", "pl1", {"l9": 1})


# --- Hand-over and invoice ---------------------------------------------------------------------------------------

TODAY = date.today().isoformat()


def _mirror_packages(zoho, salesorder_id):
    zoho.orders[salesorder_id]["packages"] = [
        {
            "package_id": p["package_id"],
            "package_number": p["package_number"],
            "status": p["status"],
            "shipment_id": p["shipment_id"],
            "quantity": sum(line["quantity"] for line in p["line_items"]),
        }
        for p in zoho.packages.values()
        if p["salesorder_id"] == salesorder_id
    ]


def handover_order(zoho, *, qty=3, box=2, status="not_shipped", invoiced=0, advance=0, method=None, service=False):
    """so1 with one line l1 (rate 500) of ``qty`` units; package pk1 holds ``box`` of them."""
    doc = order(1, qty=qty, packed=box)
    line = doc["line_items"][0]
    line["quantity_invoiced"] = doc["quantity_invoiced"] = invoiced
    if status != "not_shipped":
        line["quantity_shipped"] = doc["quantity_shipped"] = box
    if method is not None:
        doc["delivery_method"] = method
    if advance:
        doc["total"] = 1500.0
        doc["contact"] = {"unused_customer_credits": advance}
    if service:
        doc["line_items"].append(
            {
                "line_item_id": "l1s",
                "item_id": "",
                "product_type": "service",
                "name": "Design",
                "quantity": 1,
                "quantity_shipped": 0,
                "quantity_packed": 0,
                "quantity_cancelled": 0,
                "quantity_invoiced": 0,
            }
        )
    zoho.add(doc)
    zoho.packages["pk1"] = {
        "package_id": "pk1",
        "package_number": "PKG-00001",
        "salesorder_id": "so1",
        "status": status,
        "shipment_id": "" if status == "not_shipped" else "sh0",
        "line_items": [{"so_line_item_id": "l1", "quantity": box}],
    }
    _mirror_packages(zoho, "so1")
    return doc


@pytest.fixture
def books(zoho, monkeypatch):  # noqa: F811
    """A recording Books: every call lands in ``books.log`` as (name, args); writes change the stored orders the way
    Books does. ``books.errors[name]`` makes that call raise once, before it has any effect; ``books.late_errors[name]``
    once, after Books acted (a timeout on the way back). ``books.effects`` counts what Books did."""
    import copy

    zoho.log = []
    zoho.packages = {}
    zoho.errors = {}
    zoho.late_errors = {}
    zoho.effects = Counter()
    zoho.hide_shipment_id = False
    zoho.prefill_refused = False
    zoho.invoice_reply = None
    zoho.prefill_extra = {}
    zoho.line_discount = 0
    zoho.unused = []
    zoho.draft_counts = True
    zoho.ship_gate = None
    zoho.ship_entered = asyncio.Event()

    def rec(name, *args):
        zoho.log.append((name, args))
        if name in zoho.errors:
            raise zoho.errors.pop(name)

    def done(name):
        zoho.effects[name] += 1
        if name in zoho.late_errors:
            raise zoho.late_errors.pop(name)

    def count_invoiced(doc, payload):
        for item in payload["line_items"]:
            for line in doc["line_items"]:
                if line["line_item_id"] == item["salesorder_item_id"]:
                    line["quantity_invoiced"] += item["quantity"]

    async def get_salesorder(db, salesorder_id):
        rec("get_salesorder", salesorder_id)
        zoho.calls["detail"] += 1
        return copy.deepcopy(zoho.orders[salesorder_id])

    async def get_package(db, package_id):
        rec("get_package", package_id)
        if package_id not in zoho.packages:
            raise ZohoNotFound("no such package")
        package = copy.deepcopy(zoho.packages[package_id])
        if zoho.hide_shipment_id:
            package["shipment_id"] = ""
        return package

    async def create_shipment(db, salesorder_id, package_id, *, date, delivery_method):
        zoho.ship_entered.set()
        if zoho.ship_gate:
            await zoho.ship_gate.wait()
        rec("create_shipment", salesorder_id, package_id, date, delivery_method)
        package = zoho.packages[package_id]
        package.update(status="shipped", shipment_id="sh1")
        doc = zoho.orders[salesorder_id]
        for item in package["line_items"]:
            for line in doc["line_items"]:
                if line["line_item_id"] == item["so_line_item_id"]:
                    line["quantity_shipped"] += item["quantity"]
                    doc["quantity_shipped"] += item["quantity"]
        _mirror_packages(zoho, salesorder_id)
        done("create_shipment")
        return {"shipment_id": "sh1"}

    async def mark_shipment_delivered(db, shipment_id):
        rec("mark_shipment_delivered", shipment_id)
        package = next(p for p in zoho.packages.values() if p["shipment_id"] == shipment_id)
        package["status"] = "delivered"
        _mirror_packages(zoho, package["salesorder_id"])
        done("mark_shipment_delivered")

    async def invoice_prefill(db, salesorder_id):
        rec("invoice_prefill", salesorder_id)
        if zoho.prefill_refused:
            return None
        doc = zoho.orders[salesorder_id]
        lines = [
            {
                "line_item_id": "",
                "salesorder_item_id": line["line_item_id"],
                "item_id": line["item_id"],
                "name": line["name"],
                "description": "",
                "rate": 500.0,
                "quantity": line["quantity"] - line["quantity_invoiced"],
                "tax_id": "t1",
                "discount": zoho.line_discount,
                "item_total": 0,
            }
            for line in doc["line_items"]
            if line["quantity"] - line["quantity_invoiced"] > 0
        ]
        if not lines:
            return None
        return {
            "customer_id": doc["customer_id"],
            "is_inclusive_tax": True,
            "date": "2020-01-01",
            "discount": 0,
            "shipping_charge": 0,
            "adjustment": 0,
            "notes": "",
            "template_id": "tpl",
            "salesorder_id": salesorder_id,
            "line_items": lines,
            **zoho.prefill_extra,
        }

    async def create_invoice(db, payload):
        rec("create_invoice", payload)
        doc = next(d for d in zoho.orders.values() if d["customer_id"] == payload["customer_id"])
        if zoho.draft_counts:
            count_invoiced(doc, payload)
        total = sum(item["rate"] * item["quantity"] for item in payload["line_items"]) + float(
            payload.get("shipping_charge") or 0
        )
        number = f"INV-{len(doc['invoices']) + 1}"
        doc["invoices"].append(
            {"invoice_id": number.lower(), "invoice_number": number, "status": "draft", "_payload": payload}
        )
        done("create_invoice")
        if zoho.invoice_reply is not None:
            return zoho.invoice_reply
        return {"invoice_id": number.lower(), "invoice_number": number, "total": total, "balance": total}

    async def mark_invoice_sent(db, invoice_id):
        rec("mark_invoice_sent", invoice_id)
        for doc in zoho.orders.values():
            for invoice in doc["invoices"]:
                if invoice["invoice_id"] == invoice_id:
                    invoice["status"] = "sent"
                    if not zoho.draft_counts:  # this Books counts an invoice once it is sent
                        count_invoiced(doc, invoice["_payload"])
        done("mark_invoice_sent")

    async def list_customer_payments(db, customer_id):
        rec("list_customer_payments", customer_id)
        return copy.deepcopy(zoho.unused)

    async def apply_invoice_credits(db, invoice_id, invoice_payments):
        rec("apply_invoice_credits", invoice_id, invoice_payments)
        for applied in invoice_payments:
            for payment in zoho.unused:
                if payment["payment_id"] == applied["payment_id"]:
                    payment["unused_amount"] -= applied["amount_applied"]
        done("apply_invoice_credits")

    for fn in (
        get_salesorder,
        get_package,
        create_shipment,
        mark_shipment_delivered,
        invoice_prefill,
        create_invoice,
        mark_invoice_sent,
        list_customer_payments,
        apply_invoice_credits,
    ):
        monkeypatch.setattr(zoho_service, fn.__name__, fn)
    return zoho


async def _ready(db, books, **kw):
    handover_order(books, **kw)
    await sync.run_pass(db)
    await sync.run_pass(db)
    books.log.clear()


def _names(books):
    return [name for name, _ in books.log]


def _calls(books, name):
    return [args for n, args in books.log if n == name]


@pytest.mark.asyncio
async def test_pickup_runs_every_step_in_order(db_session, books):
    await _ready(db_session, books, advance=600)
    books.unused = [{"payment_id": "p1", "date": "2026-09-01", "unused_amount": 900}]
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=True)
    assert _names(books) == [
        "get_package",
        "create_shipment",
        "mark_shipment_delivered",
        "get_salesorder",
        "invoice_prefill",
        "create_invoice",
        "mark_invoice_sent",
        "list_customer_payments",
        "apply_invoice_credits",
        "get_salesorder",
    ]
    assert _calls(books, "create_shipment") == [("so1", "pk1", TODAY, "PICK UP")]
    assert _calls(books, "mark_shipment_delivered") == [("sh1",)]
    assert outcome == {
        "package_number": "PKG-00001",
        "shipment": "done",
        "delivered": "done",
        "invoice": "created",
        "invoice_number": "INV-1",
        "manual_reason": None,
        "credit_applied": 600.0,
        "failed_step": None,
        "error": None,
    }
    row = (await sync.read_board(db_session))["rows"][0]
    assert row["packages"][0]["status"] == "delivered"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "sent"), [(None, "Aito3D"), ("", "Aito3D"), ("pick up", "Aito3D"), ("Chronopost", "Chronopost")]
)
async def test_delivery_is_not_marked_delivered_and_uses_the_orders_method_or_aito3d(db_session, books, method, sent):
    await _ready(db_session, books, method=method)
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="delivery", apply_credit=False)
    assert _calls(books, "create_shipment") == [("so1", "pk1", TODAY, sent)]
    assert "mark_shipment_delivered" not in _names(books)
    assert (outcome["shipment"], outcome["delivered"], outcome["invoice"]) == ("done", "skipped", "created")


@pytest.mark.asyncio
async def test_a_parcel_already_shipped_gets_no_second_shipment(db_session, books):
    await _ready(db_session, books, status="shipped")
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    assert "create_shipment" not in _names(books)
    assert _calls(books, "mark_shipment_delivered") == [("sh0",)]
    assert (outcome["shipment"], outcome["delivered"], outcome["invoice"]) == ("skipped", "done", "created")


@pytest.mark.asyncio
async def test_a_parcel_already_delivered_only_gets_its_invoice(db_session, books):
    await _ready(db_session, books, status="delivered")
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    assert _names(books) == [
        "get_package",
        "get_salesorder",
        "invoice_prefill",
        "create_invoice",
        "mark_invoice_sent",
        "get_salesorder",
    ]
    assert (outcome["shipment"], outcome["delivered"], outcome["invoice"]) == ("skipped", "skipped", "created")


@pytest.mark.asyncio
async def test_nothing_left_to_invoice_creates_no_invoice(db_session, books):
    await _ready(db_session, books, invoiced=3)  # invoiced up front
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=True)
    assert "create_invoice" not in _names(books)
    assert (outcome["invoice"], outcome["invoice_number"], outcome["failed_step"]) == ("none", None, None)


@pytest.mark.asyncio
async def test_an_order_holding_a_draft_invoice_gets_no_second_one(db_session, books):
    """Should Books not count a draft in quantity_invoiced, the draft still blocks a duplicate."""
    await _ready(db_session, books)
    books.orders["so1"]["invoices"] = [{"invoice_id": "d1", "invoice_number": "INV-0", "status": "draft"}]
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    assert "create_invoice" not in _names(books)
    assert (outcome["invoice"], outcome["manual_reason"], outcome["invoice_number"], outcome["failed_step"]) == (
        "manual",
        "draft",
        "INV-0",
        None,
    )


@pytest.mark.asyncio
async def test_a_draft_with_nothing_left_to_invoice_is_just_nothing(db_session, books):
    await _ready(db_session, books, invoiced=3)
    books.orders["so1"]["invoices"] = [{"invoice_id": "d1", "invoice_number": "INV-0", "status": "draft"}]
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    assert (outcome["invoice"], outcome["manual_reason"], outcome["invoice_number"]) == ("none", None, None)


@pytest.mark.asyncio
async def test_preview_points_at_the_draft_that_blocks_the_invoice(db_session, books):
    doc = handover_order(books)
    doc["invoices"] = [{"invoice_id": "d1", "invoice_number": "INV-0", "status": "draft"}]
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    preview = await actions.handover_preview(db_session, "so1", "pk1")
    assert (preview["to_invoice"], preview["manual"], preview["manual_reason"]) == (False, True, "draft")
    assert (preview["covered_by"], preview["invoice_total"]) == (["INV-0"], None)


@pytest.mark.asyncio
async def test_a_service_line_rides_on_the_invoice(db_session, books):
    await _ready(db_session, books, service=True)
    await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    (payload,) = _calls(books, "create_invoice")[0]
    assert {(line["salesorder_item_id"], line["quantity"]) for line in payload["line_items"]} == {("l1", 2), ("l1s", 1)}


@pytest.mark.asyncio
async def test_partial_invoice_of_an_order_with_a_shipping_charge_is_left_to_books(db_session, books):
    await _ready(db_session, books, qty=3, box=2)
    books.prefill_extra = {"shipping_charge": 200}
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=True)
    assert "create_invoice" not in _names(books)
    assert (outcome["invoice"], outcome["manual_reason"], outcome["failed_step"]) == ("manual", "order_money", None)


@pytest.mark.asyncio
async def test_an_unparseable_order_money_field_counts_as_set_and_leaves_a_partial_invoice_to_books(db_session, books):
    await _ready(db_session, books, qty=3, box=2)
    books.prefill_extra = {"adjustment": "abc"}
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=True)
    assert "create_invoice" not in _names(books)
    assert (outcome["invoice"], outcome["manual_reason"], outcome["failed_step"]) == ("manual", "order_money", None)


@pytest.mark.asyncio
async def test_whole_remaining_invoice_keeps_the_orders_shipping_charge(db_session, books):
    await _ready(db_session, books, qty=2, box=2)
    books.prefill_extra = {"shipping_charge": 200}
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    (payload,) = _calls(books, "create_invoice")[0]
    assert payload["shipping_charge"] == 200
    assert outcome["invoice"] == "created"


@pytest.mark.asyncio
async def test_invoice_lines_carry_the_order_line_link_and_todays_date(db_session, books):
    await _ready(db_session, books, qty=3, box=2)
    await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    (payload,) = _calls(books, "create_invoice")[0]
    assert payload == {
        "customer_id": "c1",
        "is_inclusive_tax": True,
        "discount": 0,
        "shipping_charge": 0,
        "adjustment": 0,
        "date": TODAY,
        "line_items": [
            {
                "salesorder_item_id": "l1",
                "item_id": "A",
                "name": "Thing",
                "rate": 500.0,
                "quantity": 2,
                "tax_id": "t1",
                "discount": 0,
            }
        ],
    }


@pytest.mark.asyncio
async def test_credit_is_capped_by_the_orders_advance_and_by_the_invoice(db_session, books):
    payments = [
        {"payment_id": "p2", "date": "2026-10-02", "unused_amount": 500},
        {"payment_id": "p0", "date": "2026-08-01", "unused_amount": 0},
        {"payment_id": "p1", "date": "2026-09-01", "unused_amount": 400},
        {"payment_id": "p3", "date": "2026-10-03", "unused_amount": 300},
    ]
    await _ready(db_session, books, advance=600)  # invoice 1000, advance 600
    books.unused = [dict(p) for p in payments]
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=True)
    assert _calls(books, "apply_invoice_credits") == [
        ("inv-1", [{"payment_id": "p1", "amount_applied": 400}, {"payment_id": "p2", "amount_applied": 200}])
    ]
    assert outcome["credit_applied"] == 600

    books.orders.clear()
    books.packages.clear()
    await _ready(db_session, books, advance=5000)  # advance capped at the order's 1500, invoice 1000
    books.unused = [dict(p) for p in payments]
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=True)
    assert _calls(books, "apply_invoice_credits")[-1] == (
        "inv-1",
        [
            {"payment_id": "p1", "amount_applied": 400},
            {"payment_id": "p2", "amount_applied": 500},
            {"payment_id": "p3", "amount_applied": 100},
        ],
    )
    assert outcome["credit_applied"] == 1000


@pytest.mark.asyncio
@pytest.mark.parametrize(("advance", "apply_credit"), [(600, False), (0, True)])
async def test_no_credit_call_when_unticked_or_no_advance(db_session, books, advance, apply_credit):
    await _ready(db_session, books, advance=advance)
    books.unused = [{"payment_id": "p1", "date": "2026-09-01", "unused_amount": 900}]
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=apply_credit)
    assert "list_customer_payments" not in _names(books)
    assert "apply_invoice_credits" not in _names(books)
    assert (outcome["invoice"], outcome["credit_applied"], outcome["failed_step"]) == ("created", 0, None)


@pytest.mark.asyncio
async def test_no_unused_payment_is_not_a_failure(db_session, books):
    await _ready(db_session, books, advance=600)
    books.unused = [{"payment_id": "p1", "date": "2026-09-01", "unused_amount": 0}]
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=True)
    assert "apply_invoice_credits" not in _names(books)
    assert (outcome["invoice"], outcome["credit_applied"], outcome["failed_step"]) == ("created", 0, None)


@pytest.mark.asyncio
async def test_invoice_refused_reports_the_step_and_keeps_the_shipment(db_session, books):
    await _ready(db_session, books)
    books.errors["create_invoice"] = ZohoRequestRejected("Books says no")
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=True)
    assert outcome["shipment"] == outcome["delivered"] == "done"
    assert (outcome["invoice"], outcome["failed_step"], outcome["error"]) == ("failed", "invoice", "Books says no")
    assert _names(books)[-1] == "get_salesorder"  # the closing re-read ran
    row = (await sync.read_board(db_session))["rows"][0]
    assert row["packages"][0]["status"] == "delivered"


@pytest.mark.asyncio
async def test_retry_after_a_refused_invoice_creates_only_the_invoice(db_session, books):
    await _ready(db_session, books)
    books.errors["create_invoice"] = ZohoRequestRejected("Books says no")
    await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    assert (outcome["shipment"], outcome["delivered"], outcome["invoice"]) == ("skipped", "skipped", "created")
    assert len(_calls(books, "create_shipment")) == len(_calls(books, "mark_shipment_delivered")) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failing",
    ["mark_shipment_delivered", "invoice_prefill", "create_invoice", "mark_invoice_sent", "list_customer_payments"],
)
@pytest.mark.parametrize("qty", [3, 2])  # 2: the shipment takes the order off the board
@pytest.mark.parametrize("draft_counts", [True, False])
async def test_a_retry_after_any_failed_step_repeats_no_write(db_session, books, failing, qty, draft_counts):
    books.draft_counts = draft_counts
    await _ready(db_session, books, qty=qty, box=2, advance=600)
    books.unused = [{"payment_id": "p1", "date": "2026-09-01", "unused_amount": 900}]
    books.errors[failing] = ZohoUpstreamError("timeout")
    first = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=True)
    assert first["error"] == "timeout"
    await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=True)
    await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=True)
    succeeded = Counter(_names(books))
    succeeded[failing] -= 1  # the call that raised had no effect
    for write in ("create_shipment", "mark_shipment_delivered", "create_invoice"):
        assert succeeded[write] == 1, write
    # A draft whose "sent" failed stays a draft: the operator sends it in Books, Fenrir never re-invoices it.
    assert succeeded["mark_invoice_sent"] == (0 if failing == "mark_invoice_sent" else 1)
    assert books.packages["pk1"]["status"] == "delivered"
    assert len(books.orders["so1"]["invoices"]) == 1


@pytest.mark.asyncio
async def test_mark_sent_failure_leaves_a_draft_and_applies_no_credit(db_session, books):
    await _ready(db_session, books, advance=600)
    books.unused = [{"payment_id": "p1", "date": "2026-09-01", "unused_amount": 900}]
    books.errors["mark_invoice_sent"] = ZohoRequestRejected("cannot send")
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=True)
    assert (outcome["invoice"], outcome["invoice_number"], outcome["failed_step"]) == ("draft", "INV-1", "sent")
    assert outcome["credit_applied"] == 0
    assert "list_customer_payments" not in _names(books)
    again = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=True)
    assert again["invoice"] == "none"
    assert len(_calls(books, "create_invoice")) == 1


@pytest.mark.asyncio
async def test_shipment_refused_raises_and_nothing_else_runs(db_session, books):
    await _ready(db_session, books)
    books.errors["create_shipment"] = ZohoRequestRejected("refused")
    with pytest.raises(ZohoRequestRejected):
        await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=True)
    assert _names(books) == ["get_package", "create_shipment", "get_salesorder"]  # one look in case it went through


@pytest.mark.asyncio
async def test_rate_limited_shipment_opens_the_back_off_window(db_session, books):
    await _ready(db_session, books)
    books.errors["create_shipment"] = _rate_limited()
    with pytest.raises(ZohoRateLimited):
        await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    _assert_window_open()


@pytest.mark.asyncio
async def test_busy_zoho_hands_nothing_over(db_session, books):
    await _ready(db_session, books)
    doc = await _doc(db_session, "so1")
    doc.pending = True  # would need an entry re-read: busy must stop it first
    await db_session.commit()
    books.meter = sync.CALL_CEILING
    with pytest.raises(sync.ZohoBusy):
        await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    with pytest.raises(sync.ZohoBusy):
        await actions.invoice_shipped(db_session, "so1", apply_credit=False)
    assert books.log == []


@pytest.mark.asyncio
async def test_invoice_shipped_runs_the_invoice_part_alone(db_session, books):
    await _ready(db_session, books, status="shipped")  # shipped in Books by hand
    outcome = await actions.invoice_shipped(db_session, "so1", apply_credit=False)
    assert _names(books) == [
        "get_salesorder",
        "invoice_prefill",
        "create_invoice",
        "mark_invoice_sent",
        "get_salesorder",
    ]
    assert outcome == {
        "package_number": "",
        "shipment": "skipped",
        "delivered": "skipped",
        "invoice": "created",
        "invoice_number": "INV-1",
        "manual_reason": None,
        "credit_applied": 0.0,
        "failed_step": None,
        "error": None,
    }


@pytest.mark.asyncio
async def test_invoice_shipped_works_for_a_finished_order_with_no_board_row(db_session, books):
    await _ready(db_session, books, qty=2, box=2, status="delivered", service=True)
    assert (await sync.read_board(db_session))["rows"] == []
    outcome = await actions.invoice_shipped(db_session, "so1", apply_credit=True)
    (payload,) = _calls(books, "create_invoice")[0]
    assert {(line["salesorder_item_id"], line["quantity"]) for line in payload["line_items"]} == {("l1", 2), ("l1s", 1)}
    assert (outcome["invoice"], outcome["credit_applied"]) == ("created", 0)
    assert (outcome["failed_step"], outcome["error"]) == ("credit", "credit_off_board")
    with pytest.raises(actions.OrderNotOnBoard):
        await actions.invoice_shipped(db_session, "so9", apply_credit=False)


@pytest.mark.asyncio
async def test_hand_over_of_another_orders_package_is_refused(db_session, books):
    await _ready(db_session, books)
    books.packages["pk2"] = {**books.packages["pk1"], "package_id": "pk2", "salesorder_id": "so2"}
    for package in ("pk2", "nope"):
        with pytest.raises(actions.OrderActionRefused) as e:
            await actions.hand_over(db_session, "so1", package, mode="pickup", apply_credit=False)
        assert e.value.args[0] == "unknown_package"
    assert _names(books) == ["get_package", "get_package"]


@pytest.mark.asyncio
async def test_hand_over_of_an_order_off_the_board_is_refused(db_session, books):
    with pytest.raises(actions.OrderNotOnBoard):
        await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)


@pytest.mark.asyncio
async def test_preview_totals_the_kept_units_for_a_tax_inclusive_order(db_session, books):
    await _ready(db_session, books, qty=3, box=2, advance=600)
    preview = await actions.handover_preview(db_session, "so1", "pk1")
    assert preview == {
        "units": 2.0,
        "available": True,
        "to_invoice": True,
        "invoice_total": 1000.0,
        "manual": False,
        "manual_reason": None,
        "credit": 600.0,
        "covered_by": [],
    }
    assert _names(books) == ["get_package", "invoice_prefill"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("extra", "discount"), [({"is_inclusive_tax": False}, 0), ({}, "10%"), ({"shipping_charge": 200}, 0)]
)
async def test_preview_has_no_total_when_tax_is_exclusive_or_a_line_is_discounted(db_session, books, extra, discount):
    await _ready(db_session, books, qty=2, box=2, advance=600)
    books.prefill_extra, books.line_discount = extra, discount
    preview = await actions.handover_preview(db_session, "so1", "pk1")
    assert (preview["to_invoice"], preview["invoice_total"], preview["credit"]) == (True, None, 0)


@pytest.mark.asyncio
async def test_preview_says_manual_for_a_partial_invoice_with_order_money(db_session, books):
    await _ready(db_session, books, qty=3, box=2)
    books.prefill_extra = {"adjustment": -50}
    preview = await actions.handover_preview(db_session, "so1", "pk1")
    assert (preview["to_invoice"], preview["manual"], preview["invoice_total"]) == (True, True, None)
    assert preview["manual_reason"] == "order_money"


@pytest.mark.asyncio
async def test_preview_names_the_invoices_when_everything_is_invoiced(db_session, books):
    doc = handover_order(books, invoiced=3)
    doc["invoices"] = [
        {"invoice_id": "i1", "invoice_number": "INV-7", "status": "paid"},
        {"invoice_id": "i2", "invoice_number": "INV-6", "status": "void"},
    ]
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    books.log.clear()
    preview = await actions.handover_preview(db_session, "so1", "pk1")
    assert (preview["to_invoice"], preview["covered_by"], preview["invoice_total"]) == (False, ["INV-7"], None)
    assert "invoice_prefill" not in _names(books)


@pytest.mark.asyncio
async def test_preview_survives_a_books_failure(db_session, books):
    await _ready(db_session, books)
    books.errors["get_package"] = ZohoUpstreamError("down")
    assert await actions.handover_preview(db_session, "so1", "pk1") == {
        "units": 2.0,
        "available": False,
        "to_invoice": False,
        "invoice_total": None,
        "manual": False,
        "manual_reason": None,
        "credit": 0.0,
        "covered_by": [],
    }


@pytest.mark.asyncio
async def test_preview_of_a_package_not_on_the_order_is_refused(db_session, books):
    await _ready(db_session, books)
    with pytest.raises(actions.OrderActionRefused) as e:
        await actions.handover_preview(db_session, "so1", "nope")
    assert e.value.args[0] == "unknown_package"


@pytest.mark.asyncio
async def test_concurrent_hand_over_is_refused(db_session, books):
    await _ready(db_session, books)
    books.ship_gate = asyncio.Event()
    first = asyncio.create_task(actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False))
    await books.ship_entered.wait()
    with pytest.raises(actions.OrderBusy):
        await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    with pytest.raises(actions.OrderBusy):
        await actions.invoice_shipped(db_session, "so1", apply_credit=False)
    books.ship_gate.set()
    assert (await first)["shipment"] == "done"
    assert len(_calls(books, "create_shipment")) == 1


PREFILL = {
    "customer_id": "c1",
    "is_inclusive_tax": False,
    "discount": "",
    "notes": "Merci",
    "template_id": "tpl",
    "line_items": [
        {"salesorder_item_id": "a", "item_id": "A", "rate": 10, "quantity": 2, "tax_id": "", "item_total": 20},
        {"salesorder_item_id": "b", "item_id": "B", "rate": 5, "quantity": 0},
        {"salesorder_item_id": "c", "item_id": "C", "rate": 7, "quantity": 1},
    ],
}


def test_invoice_payload_never_exceeds_the_prefill_nor_sends_an_empty_line():
    payload, reason = actions.invoice_payload(PREFILL, {"a": 5, "b": 3, "zz": 1}, "2026-11-06")
    assert reason is None
    assert payload == {
        "customer_id": "c1",
        "is_inclusive_tax": False,
        "notes": "Merci",
        "date": "2026-11-06",
        "line_items": [{"salesorder_item_id": "a", "item_id": "A", "rate": 10, "quantity": 2}],
    }


def test_invoice_payload_leaves_split_order_money_to_books_and_sends_no_empty_invoice():
    charged = {**PREFILL, "shipping_charge": "12.50"}
    assert actions.invoice_payload(charged, {"a": 1, "c": 1}, "2026-11-06") == (None, "order_money")  # a reduced
    whole, reason = actions.invoice_payload(charged, {"a": 2, "c": 1}, "2026-11-06")
    assert reason is None and whole is not None and whole["shipping_charge"] == "12.50"
    assert actions.invoice_payload({**PREFILL, "discount": "10%"}, {"a": 2}, "2026-11-06") == (None, "order_money")
    assert actions.invoice_payload({**PREFILL, "adjustment": 0}, {"a": 2}, "2026-11-06")[0] is not None
    assert actions.invoice_payload(PREFILL, {"zz": 1}, "2026-11-06") == (None, None)


@pytest.mark.parametrize(
    ("discount", "keep_a", "reason"),
    [
        (3, 1, "line_discount"),
        ("3.00", 1, "line_discount"),
        ("abc", 1, "line_discount"),  # unparseable counts as set, and it is not a percentage
        ("10%", 1, None),
        ("10.00%", 1, None),
        (3, 2, None),
        ("abc", 2, None),
    ],
)
def test_a_fixed_line_discount_is_never_split(discount, keep_a, reason):
    lines = [{**PREFILL["line_items"][0], "discount": discount}]
    payload, why = actions.invoice_payload({**PREFILL, "line_items": lines}, {"a": keep_a}, "2026-11-06")
    assert why == reason
    assert (payload is None) == (reason is not None)
    if payload is not None:
        assert payload["line_items"][0]["discount"] == discount


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failing",
    ["create_shipment", "mark_shipment_delivered", "create_invoice", "mark_invoice_sent", "apply_invoice_credits"],
)
@pytest.mark.parametrize("qty", [3, 2])
@pytest.mark.parametrize("draft_counts", [True, False])
async def test_a_timeout_after_books_acted_is_never_repeated(db_session, books, failing, qty, draft_counts):
    books.draft_counts = draft_counts
    await _ready(db_session, books, qty=qty, box=2, advance=600)
    books.unused = [{"payment_id": "p1", "date": "2026-09-01", "unused_amount": 900}]
    books.late_errors[failing] = ZohoUpstreamError("timeout")
    for _ in range(3):
        try:
            await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=True)
        except ZohoUpstreamError:
            assert failing == "create_shipment" and books.effects["create_shipment"] == 1
    assert books.effects["create_shipment"] == books.effects["mark_shipment_delivered"] == 1
    assert books.effects["create_invoice"] == 1
    assert books.effects["mark_invoice_sent"] <= 1
    assert books.effects["apply_invoice_credits"] <= 1
    assert books.packages["pk1"]["status"] == "delivered"


@pytest.mark.asyncio
async def test_a_credit_left_undone_off_the_board_is_reported(db_session, books):
    await _ready(db_session, books, qty=2, box=2, advance=600)
    books.errors["create_invoice"] = ZohoRequestRejected("Books says no")
    await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=True)
    assert (await sync.read_board(db_session))["rows"] == []
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=True)
    assert (outcome["invoice"], outcome["failed_step"], outcome["error"]) == ("created", "credit", "credit_off_board")
    assert "apply_invoice_credits" not in _names(books)


@pytest.mark.asyncio
async def test_the_shipment_id_falls_back_to_the_stored_order(db_session, books):
    await _ready(db_session, books, status="shipped")
    books.hide_shipment_id = True
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    assert _calls(books, "mark_shipment_delivered") == [("sh0",)]
    assert (outcome["delivered"], outcome["failed_step"]) == ("done", None)


@pytest.mark.asyncio
async def test_a_broken_database_cannot_raise_out_of_the_closing_refresh(db_session, books, monkeypatch):
    await _ready(db_session, books)

    async def boom(*args, **kwargs):
        raise OperationalError("x", {}, Exception("disk I/O error"))

    monkeypatch.setattr(sync, "refresh_order", boom)
    monkeypatch.setattr(db_session, "rollback", boom)
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    assert (outcome["shipment"], outcome["invoice"]) == ("done", "created")


def _goods_and_service(doc):
    """Add an untracked GOODS line (no stock item: the board calls it "service") and a real service line."""
    for line_id, kind in (("l1g", "goods"), ("l1s", "service")):
        doc["line_items"].append(
            {
                "line_item_id": line_id,
                "item_id": "",
                "product_type": kind,
                "name": kind,
                "quantity": 1,
                "quantity_shipped": 0,
                "quantity_packed": 0,
                "quantity_cancelled": 0,
                "quantity_invoiced": 0,
            }
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("on_board", [True, False])
async def test_only_a_real_service_line_rides_before_it_ships(db_session, books, on_board):
    if on_board:
        doc = handover_order(books, qty=3, box=2)
    else:  # the stocked line has shipped in full: no board row is left
        doc = handover_order(books, qty=2, box=2, status="delivered")
    _goods_and_service(doc)
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    row = await sync.find_board_row(db_session, "so1")
    if on_board:
        assert row is not None and {line["id"]: line["state"] for line in row["lines"]}["l1g"] == "service"
        await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    else:
        assert row is None
        await actions.invoice_shipped(db_session, "so1", apply_credit=False)
    (payload,) = _calls(books, "create_invoice")[0]
    assert {(line["salesorder_item_id"], line["quantity"]) for line in payload["line_items"]} == {("l1", 2), ("l1s", 1)}


@pytest.mark.asyncio
async def test_a_refused_prefill_with_units_owed_is_a_failure_not_nothing(db_session, books):
    await _ready(db_session, books)
    books.prefill_refused = True
    preview = await actions.handover_preview(db_session, "so1", "pk1")
    assert (preview["available"], preview["covered_by"]) == (False, [])
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    assert (outcome["invoice"], outcome["failed_step"], outcome["error"]) == ("failed", "invoice", "prefill_refused")
    assert "create_invoice" not in _names(books)


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["", None, "in_transit"])
async def test_an_unexpected_package_status_stops_before_any_write(db_session, books, status):
    await _ready(db_session, books)
    books.packages["pk1"]["status"] = status
    assert (await actions.handover_preview(db_session, "so1", "pk1"))["available"] is False
    with pytest.raises(ZohoUpstreamError, match="unexpected package status"):
        await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    assert books.effects == Counter()


@pytest.mark.asyncio
async def test_an_invoice_answer_without_an_id_is_reported_not_raised(db_session, books):
    await _ready(db_session, books)
    books.invoice_reply = {}
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    assert (outcome["invoice"], outcome["invoice_number"], outcome["failed_step"]) == ("draft", None, "sent")
    assert outcome["error"] == "Books returned no invoice id"


@pytest.mark.asyncio
async def test_a_malformed_prefill_leaves_the_preview_unavailable(db_session, books, monkeypatch):
    await _ready(db_session, books)

    async def odd(db, salesorder_id):
        return {"line_items": ["not a line"]}

    monkeypatch.setattr(zoho_service, "invoice_prefill", odd)
    assert (await actions.handover_preview(db_session, "so1", "pk1"))["available"] is False


@pytest.mark.asyncio
async def test_a_parcel_answer_without_a_number_still_succeeds(db_session, parcels, monkeypatch):
    await _board(db_session, parcels, order(1, qty=2))

    async def bare(db, salesorder_id, *, date, line_items):
        return {}

    pl = await _pick(db_session, "so1", {"l1": 1})
    monkeypatch.setattr(zoho_service, "create_package", bare)
    assert await actions.create_parcel(db_session, "so1", pl, {"l1": 1}) == ""


@pytest.mark.asyncio
async def test_a_rate_limited_entry_reread_is_busy_and_opens_the_window(db_session, books):
    await _ready(db_session, books)
    doc = await _doc(db_session, "so1")
    doc.pending = True
    await db_session.commit()
    books.errors["get_salesorder"] = _rate_limited()
    with pytest.raises(sync.ZohoBusy):
        await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    _assert_window_open()
    assert "get_package" not in _names(books)


# --- Cancel ------------------------------------------------------------------------------------------------------


@pytest.fixture
def voids(zoho, monkeypatch):  # noqa: F811
    """void_salesorder on the fake: Books marks the order void, or refuses with `zoho.void_error`."""
    zoho.voided = []
    zoho.void_error = None

    async def void_salesorder(db, salesorder_id):
        if zoho.void_error:
            raise zoho.void_error
        zoho.voided.append(salesorder_id)
        zoho.orders[salesorder_id]["status"] = "void"

    monkeypatch.setattr(zoho_service, "void_salesorder", void_salesorder)
    return zoho


@pytest.mark.asyncio
async def test_cancel_voids_in_books_and_takes_the_order_off_the_board(db_session, voids):
    await _board(db_session, voids, order(1), order(2))
    await actions.cancel_order(db_session, "so1")
    assert voids.voided == ["so1"]
    assert [r["id"] for r in (await sync.read_board(db_session))["rows"]] == ["so2"]
    await sync.run_pass(db_session)
    assert [r["id"] for r in (await sync.read_board(db_session))["rows"]] == ["so2"]


@pytest.mark.asyncio
async def test_cancel_of_an_unknown_or_busy_order_writes_nothing(db_session, voids):
    await _board(db_session, voids, order(1))
    with pytest.raises(actions.OrderNotOnBoard):
        await actions.cancel_order(db_session, "nope")
    voids.meter = sync.CALL_CEILING
    with pytest.raises(sync.ZohoBusy):
        await actions.cancel_order(db_session, "so1")
    assert voids.voided == []


@pytest.mark.asyncio
async def test_a_refused_void_reraises_and_keeps_the_order_on_the_board(db_session, voids):
    await _board(db_session, voids, order(1))
    voids.void_error = ZohoUpstreamError("has shipments")
    with pytest.raises(ZohoUpstreamError):
        await actions.cancel_order(db_session, "so1")
    assert [r["id"] for r in (await sync.read_board(db_session))["rows"]] == ["so1"]


# --- Edit the order's lines --------------------------------------------------------------------------------------

VERSION = "2026-11-01T08:00:00-1000"


@pytest.fixture
def lines_edit(parcels, monkeypatch):
    """Books' order update and item lookups on the fake. so1: l1 (item A, qty 2, rate 1000), l2 (item C, qty 1)
    and a service line s1."""
    parcels.items_by_id = {
        "B": {"item_id": "B", "name": "Bee", "sku": "B1", "rate": 2900, "product_type": "goods"},
        "SVC": {"item_id": "SVC", "name": "Labour", "rate": 100, "product_type": "service"},
    }
    parcels.item_search = []

    stock_read = zoho_service.list_items_by_ids  # the sync fake's stock read, for the ids it knows

    async def list_items_by_ids(db, ids):
        return [parcels.items_by_id[i] for i in ids if i in parcels.items_by_id] + await stock_read(
            db, [i for i in ids if i not in parcels.items_by_id]
        )

    async def list_items(db, search_text):
        return parcels.item_search

    async def update_salesorder(db, salesorder_id, body):
        if parcels.create_error:
            raise parcels.create_error
        parcels.writes.append("update_salesorder")
        parcels.bodies["lines"] = body
        doc = parcels.orders[salesorder_id]
        old = {line["line_item_id"]: line for line in doc["line_items"]}
        doc["line_items"] = [
            {
                **old.get(line.get("line_item_id"), {}),
                **line,
                "line_item_id": line.get("line_item_id") or f"new-{line['item_id']}",
            }
            for line in body["line_items"]
        ]
        doc["last_modified_time"] = "2026-11-07T09:00:00-1000"
        return {}

    for call in (list_items_by_ids, list_items, update_salesorder):
        monkeypatch.setattr(zoho_service, call.__name__, call)
    return parcels


def _edit_order(**line_kw):
    doc = order(1, qty=2)
    doc["line_items"][0].update(rate=1000, product_type="goods", **line_kw)
    doc["line_items"].append(
        {
            **doc["line_items"][0],
            "line_item_id": "l2",
            "item_id": "C",
            "quantity": 1,
            "quantity_packed": 0,
            "quantity_invoiced": 0,
            "quantity_shipped": 0,
        }
    )
    doc["line_items"].append(
        {"line_item_id": "s1", "name": "Labour", "quantity": 1, "rate": 500, "product_type": "service"}
    )
    return doc


@pytest.mark.asyncio
async def test_edit_sends_the_whole_order_and_the_row_shows_it(db_session, lines_edit):
    await _board(db_session, lines_edit, _edit_order())
    row = await actions.edit_lines(
        db_session,
        "so1",
        VERSION,
        [{"line_id": "l1", "quantity": 3}, {"line_id": "l2", "quantity": 1}, {"item_id": "B", "quantity": 1}],
    )
    body = lines_edit.bodies["lines"]["line_items"]
    assert [line.get("line_item_id") for line in body] == ["l1", "l2", "s1", None]  # service kept, new line last
    assert body[0]["quantity"] == 3 and body[3] == {"item_id": "B", "quantity": 1, "rate": 2900.0}
    assert {line["id"]: line["quantity"] for line in row["lines"]}["l1"] == 3 and row["version"] != VERSION


@pytest.mark.asyncio
async def test_omitted_line_is_removed(db_session, lines_edit):
    await _board(db_session, lines_edit, _edit_order())
    row = await actions.edit_lines(db_session, "so1", VERSION, [{"line_id": "l1", "quantity": 2}])
    assert "l2" not in [line.get("line_item_id") for line in lines_edit.bodies["lines"]["line_items"]]
    assert "l2" not in [line["id"] for line in row["lines"]]


@pytest.mark.asyncio
async def test_floor_uses_books_cumulative_figures(db_session, lines_edit):
    await _board(
        db_session, lines_edit, _edit_order(quantity_packed=3, quantity_invoiced=1, quantity_shipped=2, quantity=5)
    )
    keep = {"line_id": "l2", "quantity": 1}
    await actions.edit_lines(db_session, "so1", VERSION, [{"line_id": "l1", "quantity": 3}, keep])  # accepted
    with pytest.raises(actions.OrderActionRefused, match="below_floor"):
        await actions.edit_lines(
            db_session, "so1", "2026-11-07T09:00:00-1000", [{"line_id": "l1", "quantity": 2.9}, keep]
        )


@pytest.mark.asyncio
async def test_a_floored_line_cannot_be_omitted(db_session, lines_edit):
    await _board(db_session, lines_edit, _edit_order(quantity_packed=1))
    with pytest.raises(actions.OrderActionRefused, match="below_floor"):
        await actions.edit_lines(db_session, "so1", VERSION, [{"line_id": "l2", "quantity": 2}])
    assert "lines" not in lines_edit.bodies


@pytest.mark.asyncio
async def test_a_moved_order_is_refused_before_any_write(db_session, lines_edit):
    await _board(db_session, lines_edit, _edit_order())
    lines_edit.orders["so1"]["last_modified_time"] = "2026-11-07T10:00:00-1000"  # someone saved in Books
    with pytest.raises(actions.OrderActionRefused, match="version"):
        await actions.edit_lines(
            db_session, "so1", VERSION, [{"line_id": "l1", "quantity": 3}, {"line_id": "l2", "quantity": 1}]
        )
    assert "lines" not in lines_edit.bodies


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("lines", "code"),
    [
        ([{"line_id": "s1", "quantity": 2}], "service_line"),
        ([{"line_id": "nope", "quantity": 1}], "unknown_line"),
        ([{"line_id": "l1", "quantity": 2}, {"item_id": "A", "quantity": 1}], "unknown_item"),
        ([{"line_id": "l1", "quantity": 2}, {"item_id": "SVC", "quantity": 1}], "unknown_item"),
        ([{"line_id": "l1", "quantity": 1.2345}], "bad_quantity"),
        ([{"line_id": "l1", "quantity": 2}, {"line_id": "l2", "quantity": 1}], "nothing_changed"),
    ],
)
async def test_edit_refuses_without_writing(db_session, lines_edit, lines, code):
    await _board(db_session, lines_edit, _edit_order())
    with pytest.raises(actions.OrderActionRefused, match=code):
        await actions.edit_lines(db_session, "so1", VERSION, lines)
    assert "lines" not in lines_edit.bodies


@pytest.mark.asyncio
async def test_edit_is_locked_while_a_picklist_is_open(db_session, lines_edit):
    await _board(db_session, lines_edit, _edit_order())
    lines_edit.stock["A"] = 5
    await sync.run_pass(db_session)
    await _pick(db_session, "so1", {"l1": 1})
    with pytest.raises(actions.OrderActionRefused, match="picklist_open"):
        await actions.edit_lines(
            db_session, "so1", VERSION, [{"line_id": "l1", "quantity": 3}, {"line_id": "l2", "quantity": 1}]
        )
    assert "lines" not in lines_edit.bodies


@pytest.mark.asyncio
async def test_an_edit_timeout_triggers_one_refresh_and_reraises(db_session, lines_edit, monkeypatch):
    await _board(db_session, lines_edit, _edit_order())
    lines_edit.create_error = ZohoUpstreamError("timeout")
    reads = lines_edit.calls["detail"]
    with pytest.raises(ZohoUpstreamError, match="timeout"):
        await actions.edit_lines(
            db_session, "so1", VERSION, [{"line_id": "l1", "quantity": 3}, {"line_id": "l2", "quantity": 1}]
        )
    assert lines_edit.calls["detail"] == reads + 2  # the forced re-read before, one after the failed write


def _with_shipped(doc):
    doc["line_items"].append(_extra_line("l3", "D", quantity_shipped=2, quantity_packed=2, quantity_invoiced=2))


def _with_untracked(doc):
    doc["line_items"].append(_extra_line("l3", "U"))


def _with_cancelled(doc):
    doc["line_items"].append(_extra_line("l3", "D", quantity_cancelled=2))


def _extra_line(line_id, item_id, **figures):
    return {
        "line_item_id": line_id,
        "item_id": item_id,
        "name": "Extra",
        "sku": "X1",
        "quantity": 2,
        "rate": 700,
        "product_type": "goods",
        "quantity_shipped": 0,
        "quantity_packed": 0,
        "quantity_cancelled": 0,
        "quantity_invoiced": 0,
        **figures,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("extra", "state", "code"),
    [
        (_with_shipped, "shipped", "unknown_line"),
        (_with_untracked, "service", "service_line"),
        (_with_cancelled, "cancelled", "unknown_line"),
    ],
)
async def test_a_line_that_is_not_live_rides_along_unchanged_and_is_not_editable(
    db_session, lines_edit, extra, state, code
):
    lines_edit.items_by_id["U"] = {
        "item_id": "U",
        "name": "Untracked",
        "product_type": "goods",
        "track_inventory": False,
    }
    doc = _edit_order()
    extra(doc)
    await _board(db_session, lines_edit, doc)
    assert {line["id"]: line["state"] for line in (await actions._row(db_session, "so1"))["lines"]}["l3"] == state
    with pytest.raises(actions.OrderActionRefused, match=code):
        await actions.edit_lines(db_session, "so1", VERSION, [{"line_id": "l3", "quantity": 3}])
    await actions.edit_lines(
        db_session, "so1", VERSION, [{"line_id": "l1", "quantity": 3}, {"line_id": "l2", "quantity": 1}]
    )
    body = lines_edit.bodies["lines"]["line_items"]
    assert [line["line_item_id"] for line in body] == ["l1", "l2", "s1", "l3"]
    assert body[3] == {
        "line_item_id": "l3",
        "item_id": doc["line_items"][3]["item_id"],
        "name": "Extra",
        "rate": 700,
        "quantity": 2,
    }  # only the fields an order update takes, as Books has them


@pytest.mark.asyncio
async def test_a_picklist_books_opened_since_the_stored_copy_locks_the_edit(db_session, lines_edit):
    await _board(db_session, lines_edit, _edit_order())
    lines_edit.orders["so1"]["picklists"] = [{"picklist_id": "pl9", "status": "in_progress"}]  # stored copy has none
    with pytest.raises(actions.OrderActionRefused, match="picklist_open"):
        await actions.edit_lines(
            db_session, "so1", VERSION, [{"line_id": "l1", "quantity": 3}, {"line_id": "l2", "quantity": 1}]
        )
    assert "lines" not in lines_edit.bodies


@pytest.mark.asyncio
async def test_search_items_drops_services_and_caps_at_five(db_session, lines_edit):
    lines_edit.item_search = [
        {"item_id": "svc", "name": "Labour", "product_type": "service"},
        *(
            {
                "item_id": f"i{n}",
                "name": f"Item {n}",
                "sku": f"S{n}",
                "rate": 10,
                "stock_on_hand": 3,
                "product_type": "goods",
            }
            for n in range(7)
        ),
    ]
    found = await actions.search_items(db_session, "item")
    assert [i["id"] for i in found] == ["i0", "i1", "i2", "i3", "i4"]
    assert found[0] == {
        "id": "i0",
        "name": "Item 0",
        "sku": "S0",
        "rate": 10.0,
        "stock_on_hand": 3.0,
        "product_type": "goods",
    }


# --- Edit a packed parcel ----------------------------------------------------------------------------------------


def _packed(zoho, *, qty=3, picked=2, parcels_=(("p1", 2),)):
    """so1: l1 (item A, qty ``qty``) picked on the completed picklist pl1 (row r1) and boxed in ``parcels_``
    (package id, units of l1 each); l2 (item C, qty 4, 4 on the shelf) not picked."""
    doc = order(1, qty=qty)
    boxed = sum(units for _, units in parcels_)
    doc["line_items"][0].update(quantity_picked=picked, quantity_packed=boxed)
    doc["line_items"].append({**doc["line_items"][0], "line_item_id": "l2", "item_id": "C", "quantity": 4})
    doc["line_items"][1].update(quantity_picked=0, quantity_packed=0)
    doc["picklists"] = [{"picklist_id": "pl1", "picklist_number": "PL-00001", "status": "completed"}]
    doc["packages"] = []
    zoho.stock["C"] = 4
    zoho.picklists["pl1"] = {
        "picklist_id": "pl1",
        "picklist_number": "PL-00001",
        "status": "completed",
        "date": "2026-11-06",
        "location_id": "loc1",
        "group_by": "none",
        "line_items": [
            {
                "line_item_id": "r1",
                "salesorder_id": "so1",
                "so_line_item_id": "l1",
                "quantity_to_be_picked": picked,
                "quantity_picked": picked,
                "quantity_packed": boxed,
            }
        ],
    }
    for n, (package_id, units) in enumerate(parcels_, 1):
        number = f"PKG-{n:05d}"
        doc["packages"].append({"package_id": package_id, "package_number": number, "status": "not_shipped"})
        zoho.packages[package_id] = {
            "package_id": package_id,
            "package_number": number,
            "salesorder_id": "so1",
            "date": "2026-11-06",
            "status": "not_shipped",
            "line_items": [{"so_line_item_id": "l1", "quantity": units, "picklist_item_id": "r1"}],
        }
    return doc


def _labels(zoho):
    return [name for name, _ in zoho.steps]


@pytest.mark.asyncio
async def test_content_lists_the_parcel_lines_with_their_ceiling_and_the_shelf_lines(db_session, parcels):
    await _board(db_session, parcels, _packed(parcels))
    assert await actions.package_content(db_session, "so1", "p1") == {
        "id": "p1",
        "number": "PKG-00001",
        "version": VERSION,
        "picklist_id": "pl1",
        "lines": [{"line_id": "l1", "quantity": 2, "max": 3}, {"line_id": "l2", "quantity": 0, "max": 4}],
    }
    with pytest.raises(actions.OrderActionRefused, match="unknown_package"):
        await actions.package_content(db_session, "so1", "nope")
    assert parcels.steps == []


@pytest.mark.asyncio
async def test_raising_a_line_writes_picklist_then_package(db_session, parcels):
    await _board(db_session, parcels, _packed(parcels))
    row = await actions.edit_parcel(db_session, "so1", "p1", VERSION, {"l1": 2}, {"l1": 3})
    assert _labels(parcels) == ["picklist", "parcel"]
    assert parcels.bodies["picklist"]["line_items"] == [
        {"line_item_id": "r1", "quantity_to_be_picked": 3, "quantity_picked": 3}
    ]
    assert parcels.bodies["parcel"] == {
        "date": "2026-11-06",
        "line_items": [{"so_line_item_id": "l1", "quantity": 3, "picklist_item_id": "r1"}],
    }
    assert row["lines"][0]["packed_waiting"] == 3


@pytest.mark.asyncio
async def test_lowering_a_line_writes_package_then_picklist(db_session, parcels):
    await _board(db_session, parcels, _packed(parcels))
    row = await actions.edit_parcel(db_session, "so1", "p1", VERSION, {"l1": 2}, {"l1": 1})
    assert _labels(parcels) == ["parcel", "picklist"]
    assert parcels.bodies["picklist"]["line_items"] == [
        {"line_item_id": "r1", "quantity_to_be_picked": 1, "quantity_picked": 1}
    ]
    assert (row["lines"][0]["packed_waiting"], row["picked"]) == (1, 0)


@pytest.mark.asyncio
async def test_adding_a_shelf_line_takes_its_picklist_row_id_from_the_fresh_picklist(db_session, parcels):
    await _board(db_session, parcels, _packed(parcels))
    await actions.edit_parcel(db_session, "so1", "p1", VERSION, {"l1": 2}, {"l1": 2, "l2": 1})
    assert _labels(parcels) == ["picklist", "parcel"]
    assert parcels.bodies["picklist"]["line_items"] == [
        {"line_item_id": "r1", "quantity_to_be_picked": 2, "quantity_picked": 2},
        {"salesorder_id": "so1", "so_line_item_id": "l2", "quantity_to_be_picked": 1, "quantity_picked": 1},
    ]
    assert parcels.bodies["parcel"]["line_items"] == [
        {"so_line_item_id": "l1", "quantity": 2, "picklist_item_id": "r1"},
        {"so_line_item_id": "l2", "quantity": 1, "picklist_item_id": "pl1-l2"},
    ]


@pytest.mark.asyncio
async def test_emptying_deletes_the_package_then_its_picklist(db_session, parcels):
    await _board(db_session, parcels, _packed(parcels))
    row = await actions.edit_parcel(db_session, "so1", "p1", VERSION, {"l1": 2}, {"l1": 0})
    assert parcels.steps == [("delete_package", "p1"), ("delete_picklist", "pl1")]
    assert (row["packages"], row["picklists"], row["lines"][0]["packed_waiting"]) == ([], [], 0)


@pytest.mark.asyncio
async def test_emptying_a_parcel_with_a_sibling_keeps_the_sibling_units_on_the_picklist(db_session, parcels):
    await _board(db_session, parcels, _packed(parcels, qty=5, picked=5, parcels_=(("p1", 2), ("p2", 3))))
    await actions.edit_parcel(db_session, "so1", "p1", VERSION, {"l1": 2}, {})
    assert _labels(parcels) == ["delete_package", "picklist"]
    assert parcels.bodies["picklist"]["line_items"] == [
        {"line_item_id": "r1", "quantity_to_be_picked": 3, "quantity_picked": 3}
    ]


@pytest.mark.asyncio
async def test_sibling_parcel_units_stay_on_the_picklist_row(db_session, parcels):
    # pl1 row r1: picked 5, packed 5 = p1 (2) + p2 (3); lowering p1 to 1 → row quantity 4, p2 untouched
    await _board(db_session, parcels, _packed(parcels, qty=5, picked=5, parcels_=(("p1", 2), ("p2", 3))))
    await actions.edit_parcel(db_session, "so1", "p1", VERSION, {"l1": 2}, {"l1": 1})
    assert _labels(parcels) == ["parcel", "picklist"]
    assert parcels.bodies["picklist"]["line_items"] == [
        {"line_item_id": "r1", "quantity_to_be_picked": 4, "quantity_picked": 4}
    ]
    assert parcels.packages["p2"]["line_items"][0]["quantity"] == 3


@pytest.mark.asyncio
async def test_retry_after_a_package_timeout_skips_the_done_step(db_session, parcels):
    await _board(db_session, parcels, _packed(parcels))
    parcels.fail_step = "parcel"
    with pytest.raises(ZohoUpstreamError):
        await actions.edit_parcel(db_session, "so1", "p1", VERSION, {"l1": 2}, {"l1": 3})
    assert _labels(parcels) == ["picklist"]
    assert parcels.picklists["pl1"]["line_items"][0]["quantity_picked"] == 3  # picklist ≥ package in Books
    parcels.steps.clear()
    version = (await actions.package_content(db_session, "so1", "p1"))["version"]
    await actions.edit_parcel(db_session, "so1", "p1", version, {"l1": 2}, {"l1": 3})  # same request again
    assert _labels(parcels) == ["parcel"]  # the picklist is already at 3


@pytest.mark.asyncio
async def test_retry_after_a_picklist_down_failure_finishes_the_job(db_session, parcels):
    await _board(db_session, parcels, _packed(parcels))
    parcels.fail_step = "picklist"
    with pytest.raises(ZohoUpstreamError):
        await actions.edit_parcel(db_session, "so1", "p1", VERSION, {"l1": 2}, {"l1": 1})
    assert _labels(parcels) == ["parcel"]
    parcels.steps.clear()
    with pytest.raises(actions.OrderActionRefused, match="version"):  # the package write moved the order on
        await actions.edit_parcel(db_session, "so1", "p1", VERSION, {"l1": 2}, {"l1": 1})
    version = (await actions.package_content(db_session, "so1", "p1"))["version"]
    await actions.edit_parcel(db_session, "so1", "p1", version, {"l1": 2}, {"l1": 1})  # the parcel already says 1
    assert _labels(parcels) == ["picklist"]
    assert parcels.picklists["pl1"]["line_items"][0]["quantity_picked"] == 1


@pytest.mark.asyncio
async def test_reopened_after_a_picklist_down_failure_the_save_runs_only_that_step(db_session, parcels):
    await _board(db_session, parcels, _packed(parcels))
    parcels.fail_step = "picklist"
    with pytest.raises(ZohoUpstreamError):
        await actions.edit_parcel(db_session, "so1", "p1", VERSION, {"l1": 2}, {"l1": 1})
    parcels.steps.clear()
    content = await actions.package_content(db_session, "so1", "p1")  # what the operator sees on reopening
    assert content["version"] != VERSION and content["lines"][0]["quantity"] == 1
    await actions.edit_parcel(db_session, "so1", "p1", content["version"], {"l1": 1}, {"l1": 1})
    assert parcels.steps == [
        (
            "picklist",
            {
                **parcels.bodies["picklist"],
                "line_items": [{"line_item_id": "r1", "quantity_to_be_picked": 1, "quantity_picked": 1}],
            },
        )
    ]
    assert parcels.picklists["pl1"]["line_items"][0]["quantity_picked"] == 1
    version = (await actions.package_content(db_session, "so1", "p1"))["version"]
    with pytest.raises(actions.OrderActionRefused, match="nothing_changed"):  # now nothing is left to do
        await actions.edit_parcel(db_session, "so1", "p1", version, {"l1": 1}, {"l1": 1})


def _ship(zoho):
    zoho.packages["p1"]["status"] = "shipped"


def _open_second_picklist(zoho):
    zoho.orders["so1"]["picklists"].append({"picklist_id": "pl2", "status": "in_progress"})


def _share(zoho):
    zoho.picklists["pl1"]["line_items"][0]["salesorder_id"] = "so2"


def _change(zoho):
    zoho.packages["p1"]["line_items"][0]["quantity"] = 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("setup", "version", "lines", "code"),
    [
        (_ship, VERSION, {"l1": 3}, "package_shipped"),
        (_open_second_picklist, VERSION, {"l1": 3}, "picklist_open"),
        (_share, VERSION, {"l1": 3}, "picklist_shared"),
        (_change, VERSION, {"l1": 3}, "package_changed"),
        (None, "2026-10-01T08:00:00-1000", {"l1": 3}, "version"),
        (None, VERSION, {"l1": 4}, "too_many"),
        (None, VERSION, {"l1": 2, "nope": 1}, "unknown_line"),
        (None, VERSION, {"l1": 2}, "nothing_changed"),
        (None, VERSION, {"l1": -1}, "bad_quantity"),
    ],
)
async def test_edit_parcel_refuses_without_writing(db_session, parcels, setup, version, lines, code):
    doc = _packed(parcels)
    await _board(db_session, parcels, doc)
    if setup:
        setup(parcels)
    with pytest.raises(actions.OrderActionRefused, match=code):
        await actions.edit_parcel(db_session, "so1", "p1", version, {"l1": 2}, lines)
    assert parcels.steps == []


@pytest.mark.asyncio
async def test_replace_mode_deletes_and_recreates(db_session, parcels, monkeypatch):
    monkeypatch.setattr(actions, "_PARCEL_EDIT_REPLACES", True)
    await _board(db_session, parcels, _packed(parcels))
    row = await actions.edit_parcel(db_session, "so1", "p1", VERSION, {"l1": 2}, {"l1": 3})
    assert _labels(parcels) == ["delete_package", "picklist", "create_package"]
    assert parcels.bodies["picklist"]["line_items"] == [
        {"line_item_id": "r1", "quantity_to_be_picked": 3, "quantity_picked": 3}
    ]
    assert parcels.created[-1][2] == [{"so_line_item_id": "l1", "quantity": 3, "picklist_item_id": "r1"}]
    assert row["lines"][0]["packed_waiting"] == 3


@pytest.mark.asyncio
async def test_replace_mode_recreates_a_picklist_books_will_not_change(db_session, parcels, monkeypatch):
    monkeypatch.setattr(actions, "_PARCEL_EDIT_REPLACES", True)
    await _board(db_session, parcels, _packed(parcels))
    parcels.fail_step, parcels.fail_with = "picklist", ZohoRequestRejected
    await actions.edit_parcel(db_session, "so1", "p1", VERSION, {"l1": 2}, {"l1": 1})
    assert _labels(parcels) == [
        "delete_package",
        "delete_picklist",
        "create_picklist",
        "complete_picklist",
        "create_package",
    ]
    assert parcels.created[-1][2] == [{"so_line_item_id": "l1", "quantity": 1, "picklist_item_id": "pl1-l1"}]


@pytest.mark.asyncio
async def test_replace_mode_emptying_the_only_parcel_deletes_its_picklist(db_session, parcels, monkeypatch):
    monkeypatch.setattr(actions, "_PARCEL_EDIT_REPLACES", True)
    await _board(db_session, parcels, _packed(parcels))
    await actions.edit_parcel(db_session, "so1", "p1", VERSION, {"l1": 2}, {})
    assert parcels.steps == [("delete_package", "p1"), ("delete_picklist", "pl1")]


@pytest.mark.asyncio
async def test_replace_mode_keeps_a_picklist_a_sibling_parcel_boxed_from(db_session, parcels, monkeypatch):
    monkeypatch.setattr(actions, "_PARCEL_EDIT_REPLACES", True)
    await _board(db_session, parcels, _packed(parcels, qty=5, picked=5, parcels_=(("p1", 2), ("p2", 3))))
    parcels.fail_step, parcels.fail_with = "picklist", ZohoRequestRejected
    with pytest.raises(ZohoRequestRejected):
        await actions.edit_parcel(db_session, "so1", "p1", VERSION, {"l1": 2}, {"l1": 1})
    assert _labels(parcels) == ["delete_package"]
    assert parcels.picklists["pl1"]["line_items"][0]["quantity_picked"] == 5  # p2's row untouched


@pytest.mark.asyncio
async def test_an_edit_that_takes_the_order_off_the_board_returns_nothing(db_session, lines_edit, monkeypatch):
    await _board(db_session, lines_edit, _edit_order())
    reads = iter([await actions._row(db_session, "so1")])  # the floors read; the read after the write finds nothing

    async def vanishing(db, salesorder_id):
        try:
            return next(reads)
        except StopIteration:
            raise actions.OrderNotOnBoard(salesorder_id) from None

    monkeypatch.setattr(actions, "_row", vanishing)
    lines = [{"line_id": "l1", "quantity": 3}, {"line_id": "l2", "quantity": 1}]
    assert await actions.edit_lines(db_session, "so1", VERSION, lines) == {}
    assert lines_edit.writes.count("update_salesorder") == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("failing", "kw", "step", "delivered", "invoice"),
    [
        ("mark_shipment_delivered", {}, "delivered", "skipped", "none"),
        ("get_salesorder", {}, "invoice", "done", "failed"),  # reads open the window in _finish itself
        ("invoice_prefill", {}, "invoice", "done", "failed"),
        ("create_invoice", {}, "invoice", "done", "failed"),
        ("mark_invoice_sent", {}, "sent", "done", "draft"),
        ("list_customer_payments", {"advance": 600}, "credit", "done", "created"),
        ("apply_invoice_credits", {"advance": 600}, "credit", "done", "created"),
    ],
)
async def test_a_429_after_the_shipment_opens_the_window_and_returns_the_outcome(
    db_session, books, failing, kw, step, delivered, invoice
):
    await _ready(db_session, books, **kw)
    books.unused = [{"payment_id": "p1", "date": "2026-09-01", "unused_amount": 900}]
    books.errors[failing] = _rate_limited()
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=True)
    assert (outcome["failed_step"], outcome["error"], outcome["shipment"]) == (step, "429", "done")
    assert (outcome["delivered"], outcome["invoice"], outcome["credit_applied"]) == (delivered, invoice, 0.0)
    _assert_window_open()
    sync._rate_limited_until = 0.0  # the retry is what the operator does once the window has passed
    await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=True)
    assert books.effects["create_shipment"] == 1
    assert books.effects["mark_shipment_delivered"] == 1
    assert books.effects["create_invoice"] == 1  # a 429 on create_invoice fired before Books acted
    assert len(books.orders["so1"]["invoices"]) == 1


@pytest.mark.asyncio
async def test_delivery_without_a_shipment_id_is_reported_as_the_delivered_step(db_session, books):
    await _ready(db_session, books, status="shipped")
    books.hide_shipment_id = True
    doc = await _doc(db_session, "so1")
    doc.detail = {**doc.detail, "packages": [{**p, "shipment_id": ""} for p in doc.detail["packages"]]}
    await db_session.commit()
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    assert (outcome["failed_step"], outcome["error"]) == ("delivered", "Books returned no shipment id")
    assert outcome["delivered"] == "skipped"
    assert "mark_shipment_delivered" not in _names(books)


@pytest.mark.asyncio
async def test_a_rate_limited_entry_get_package_reraises_raw_and_opens_the_window(db_session, books):
    await _ready(db_session, books)
    books.errors["get_package"] = _rate_limited()
    with pytest.raises(ZohoRateLimited) as e:
        await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    assert not isinstance(e.value, sync.ZohoBusy)  # today the raw error escapes, it is not turned into "busy"
    _assert_window_open()
    assert _names(books) == ["get_package"]  # no write, no look after it
    assert books.effects == Counter()


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["shipped", "delivered"])
async def test_a_shipped_parcel_of_an_order_off_the_board_still_gets_its_invoice(db_session, books, status):
    await _ready(db_session, books, qty=2, box=2, status=status)
    assert (await sync.read_board(db_session))["rows"] == []
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="delivery", apply_credit=False)
    assert "create_shipment" not in _names(books)
    assert (outcome["shipment"], outcome["invoice"], outcome["failed_step"]) == ("skipped", "created", None)
    assert books.effects["create_invoice"] == 1


@pytest.mark.asyncio
async def test_a_new_shipment_needs_the_row_still_on_the_board(db_session, books, monkeypatch):
    await _ready(db_session, books)

    async def gone(db, salesorder_id):
        return None

    monkeypatch.setattr(sync, "find_board_row", gone)
    with pytest.raises(actions.OrderNotOnBoard):
        await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    assert _names(books) == ["get_package"]  # refused after the look, before any write
    assert books.effects == Counter()


@pytest.mark.asyncio
async def test_busy_zoho_makes_the_preview_unavailable_without_a_call(db_session, books):
    await _ready(db_session, books)
    books.meter = sync.CALL_CEILING
    preview = await actions.handover_preview(db_session, "so1", "pk1")
    assert (preview["units"], preview["available"], preview["to_invoice"], preview["manual"]) == (
        2.0,
        False,
        False,
        False,
    )
    assert books.log == []


@pytest.mark.asyncio
async def test_a_rate_limited_prefill_in_the_preview_opens_the_window_and_leaves_it_unavailable(db_session, books):
    await _ready(db_session, books)
    books.errors["invoice_prefill"] = _rate_limited()
    preview = await actions.handover_preview(db_session, "so1", "pk1")
    assert (preview["available"], preview["to_invoice"]) == (False, False)
    _assert_window_open()


# --- Invoice now: packed units or the whole order, before the hand-over ------------------------------------------


@pytest.mark.asyncio
async def test_invoice_packed_bills_the_parcel_before_it_ships_and_the_hand_over_bills_nothing_more(db_session, books):
    await _ready(db_session, books, qty=3, box=2)
    outcome = await actions.invoice_shipped(db_session, "so1", apply_credit=False, scope="packed")
    (payload,) = _calls(books, "create_invoice")[0]
    assert [(line["salesorder_item_id"], line["quantity"]) for line in payload["line_items"]] == [("l1", 2)]
    assert (outcome["invoice"], outcome["invoice_number"], outcome["shipment"]) == ("created", "INV-1", "skipped")
    assert "create_shipment" not in _names(books)
    books.log.clear()
    outcome = await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    assert (outcome["shipment"], outcome["invoice"]) == ("done", "none")
    assert "create_invoice" not in _names(books)


@pytest.mark.asyncio
async def test_invoice_whole_bills_every_unit_not_invoiced_yet(db_session, books):
    await _ready(db_session, books, qty=3, box=2, invoiced=1)
    await actions.invoice_shipped(db_session, "so1", apply_credit=False, scope="whole")
    (payload,) = _calls(books, "create_invoice")[0]
    assert [(line["salesorder_item_id"], line["quantity"]) for line in payload["line_items"]] == [("l1", 2)]


@pytest.mark.asyncio
async def test_invoice_shipped_still_ignores_a_parcel_waiting_to_go_out(db_session, books):
    await _ready(db_session, books, qty=3, box=2)
    outcome = await actions.invoice_shipped(db_session, "so1", apply_credit=False)
    assert outcome["invoice"] == "none"
    assert "get_package" not in _names(books)


@pytest.mark.asyncio
async def test_invoice_packed_reports_a_books_failure_reading_the_parcel(db_session, books):
    await _ready(db_session, books, qty=3, box=2)
    books.errors["get_package"] = ZohoUpstreamError("down")
    outcome = await actions.invoice_shipped(db_session, "so1", apply_credit=False, scope="packed")
    assert (outcome["invoice"], outcome["failed_step"]) == ("failed", "invoice")
    assert "create_invoice" not in _names(books)


@pytest.mark.asyncio
async def test_invoice_preview_totals_packed_and_whole(db_session, books):
    await _ready(db_session, books, qty=3, box=2, advance=600)
    preview = await actions.invoice_preview(db_session, "so1")
    assert preview == {
        "available": True,
        "credit": 600.0,
        "drafts": [],
        "packed": {"units": 2.0, "invoice_total": 1000.0, "manual_reason": None},
        "whole": {"units": 3.0, "invoice_total": 1500.0, "manual_reason": None},
    }
    assert _names(books) == ["get_package", "invoice_prefill"]


@pytest.mark.asyncio
async def test_invoice_preview_with_nothing_to_invoice_does_not_ask_for_a_prefill(db_session, books):
    await _ready(db_session, books, qty=3, box=2, invoiced=3)
    preview = await actions.invoice_preview(db_session, "so1")
    assert preview["available"] is True
    assert preview["packed"]["units"] == preview["whole"]["units"] == 0
    assert "invoice_prefill" not in _names(books)


@pytest.mark.asyncio
async def test_invoice_preview_names_a_blocking_draft_and_survives_books(db_session, books):
    doc = handover_order(books)
    doc["invoices"] = [{"invoice_id": "d1", "invoice_number": "INV-0", "status": "draft"}]
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    preview = await actions.invoice_preview(db_session, "so1")
    assert (preview["available"], preview["drafts"]) == (True, ["INV-0"])
    books.orders["so1"]["invoices"] = []
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    books.errors["get_package"] = ZohoUpstreamError("down")
    assert (await actions.invoice_preview(db_session, "so1"))["available"] is False
