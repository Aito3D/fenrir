"""The Order Board's writes: print stamp and parcel creation. Zoho is a fake throughout."""

import asyncio
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


@pytest.mark.asyncio
async def test_a_pending_stored_copy_is_reread_before_a_parcel(db_session, parcels):
    """The pending flag survives a restart, where the in-memory unconfirmed mark does not."""
    await _board(db_session, parcels, order(1, qty=2))
    parcels.orders["so1"]["line_items"][0]["quantity_packed"] = 2  # boxed in Books meanwhile
    doc = await _doc(db_session, "so1")
    doc.pending = True
    await db_session.commit()
    with pytest.raises(actions.OrderActionRefused) as e:
        await actions.create_parcel(db_session, "so1", {"l1": 2})
    assert e.value.args[0] == "too_many"
    assert parcels.created == []


@pytest.mark.asyncio
async def test_an_unstored_order_needing_a_refresh_is_not_on_the_board(db_session, parcels):
    await _board(db_session, parcels, order(1))
    sync.note_write("so9")
    with pytest.raises(actions.OrderNotOnBoard):
        await actions.create_parcel(db_session, "so9", {"l9": 1})


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
    books.errors["create_shipment"] = ZohoRateLimited("429", retry_after=30)
    with pytest.raises(ZohoRateLimited):
        await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    assert sync._rate_limited_until > time.monotonic() + 20


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
    [(3, 1, "line_discount"), ("3.00", 1, "line_discount"), ("10%", 1, None), ("10.00%", 1, None), (3, 2, None)],
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

    monkeypatch.setattr(zoho_service, "create_package", bare)
    assert await actions.create_parcel(db_session, "so1", {"l1": 1}) == ""


@pytest.mark.asyncio
async def test_a_rate_limited_entry_reread_is_busy_and_opens_the_window(db_session, books):
    await _ready(db_session, books)
    doc = await _doc(db_session, "so1")
    doc.pending = True
    await db_session.commit()
    books.errors["get_salesorder"] = ZohoRateLimited("429", retry_after=30)
    with pytest.raises(sync.ZohoBusy):
        await actions.hand_over(db_session, "so1", "pk1", mode="pickup", apply_credit=False)
    assert sync._rate_limited_until > time.monotonic() + 20
    assert "get_package" not in _names(books)
