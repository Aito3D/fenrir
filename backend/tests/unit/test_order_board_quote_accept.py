"""Accepting a quote creates its sales order in Books; undo deletes it again. Zoho is a fake throughout."""

from datetime import date

import pytest

from backend.app.services import order_board_actions as actions, order_board_sync as sync
from backend.app.services.order_board_sync import _common as sync_common
from backend.app.services.zoho import ZohoRateLimited, ZohoUpstreamError, zoho_service
from backend.tests.unit.test_order_board_actions import events_of
from backend.tests.unit.test_order_board_quote_actions import _stored, books, no_ref_left_over  # noqa: F401
from backend.tests.unit.test_order_board_quote_sync import quote
from backend.tests.unit.test_order_board_sync import (  # noqa: F401
    no_back_off_left_over,
    order,
    pings,
    zoho,
)

PREFILL_LINE = {
    "item_id": "A",
    "name": "Thing",
    "description": "",
    "rate": 500,
    "quantity": 2,
    "discount": "10%",
    "tax_id": "t1",
    "unit": "pcs",
    "item_order": 1,
    "line_item_id": "",  # Books' prefill carries keys the POST must not resend
    "item_total": 900,
    "warehouse_id": "w1",
}


@pytest.fixture
def so_books(books, monkeypatch):  # noqa: F811
    """Sales-order writes on the fake, linked to the estimate the way Books links them."""
    books.so_payloads = []
    books.opened = []
    books.deleted = []
    books.create_error = None
    books.open_error = None
    books.prefill_lines = [PREFILL_LINE]

    def link(estimate_id, salesorder_id, status):
        estimate = books.estimates[estimate_id]
        others = [s for s in estimate.get("salesorders") or [] if s["salesorder_id"] != salesorder_id]
        linked = [{"salesorder_id": salesorder_id, "salesorder_order_status": status}] if status else []
        books.estimates[estimate_id] = {**estimate, "salesorders": others + linked}

    async def salesorder_prefill_from_estimate(db, estimate_id):
        return {
            "customer_id": "c1",
            "is_inclusive_tax": True,
            "discount_type": "item_level",
            "is_discount_before_tax": True,
            "line_items": books.prefill_lines,
        }

    async def create_salesorder(db, payload):
        if books.create_error:
            raise books.create_error
        books.so_payloads.append(payload)
        books.add({**order(9, estimate_id=payload["estimate_id"]), "salesorder_id": "so9", "status": "draft"})
        link(payload["estimate_id"], "so9", "draft")
        return {"salesorder_id": "so9", "salesorder_number": "SO-00009", "status": "draft"}

    async def mark_salesorder_open(db, salesorder_id):
        if books.open_error:
            error, books.open_error = books.open_error, None
            raise error
        books.opened.append(salesorder_id)
        books.orders[salesorder_id]["status"] = "open"
        link(books.orders[salesorder_id]["estimate_id"], salesorder_id, "open")

    async def delete_salesorder(db, salesorder_id):
        books.deleted.append(salesorder_id)
        gone = books.orders.pop(salesorder_id)
        link(gone["estimate_id"], salesorder_id, None)

    for fn in (salesorder_prefill_from_estimate, create_salesorder, mark_salesorder_open, delete_salesorder):
        monkeypatch.setattr(zoho_service, fn.__name__, fn)
    return books


def _statuses(books) -> list:
    return [c for c in books.sent if c[0] == "status"]


@pytest.mark.asyncio
async def test_accept_marks_accepted_creates_linked_open_order_and_stores_it(db_session, so_books, pings):
    await _stored(db_session, so_books, quote(1, status="sent"))
    assert await actions.accept_quote(db_session, "e1", by="ana") == "so9"
    assert _statuses(so_books) == [("status", "e1", "accepted")]
    assert so_books.so_payloads == [
        {
            "customer_id": "c1",
            "estimate_id": "e1",
            "date": date.today().isoformat(),
            "reference_number": "QT-00001",
            "is_inclusive_tax": True,
            "discount_type": "item_level",
            "is_discount_before_tax": True,
            "line_items": [
                {
                    "item_id": "A",
                    "name": "Thing",
                    "rate": 500,
                    "quantity": 2,
                    "discount": "10%",
                    "tax_id": "t1",
                    "unit": "pcs",
                    "item_order": 1,
                }
            ],
        }
    ]
    assert so_books.opened == ["so9"]
    assert (await sync.find_stored(db_session, "so9")).detail["status"] == "open"
    assert [e.kind for e in await events_of(db_session, "so9")] == ["order.created"]
    assert [(e.kind, e.actor_name) for e in await events_of(db_session, "e1")] == [("quote.accepted", "ana")]
    # Converted now: the stored copy says so and the quote leaves the rows.
    assert (await sync.find_quote(db_session, "e1")).detail["salesorders"][0]["salesorder_order_status"] == "open"
    assert pings[-1]["quotes"] is True


@pytest.mark.asyncio
async def test_accept_from_draft_goes_through_sent(db_session, so_books):
    await _stored(db_session, so_books, quote(1, status="draft"))
    await actions.accept_quote(db_session, "e1", by=None)
    assert _statuses(so_books) == [("status", "e1", "sent"), ("status", "e1", "accepted")]


@pytest.mark.asyncio
async def test_accept_of_expired_quote_is_not_redated(db_session, so_books):
    await _stored(db_session, so_books, {**quote(1, status="sent"), "date": "2026-09-01", "expiry_date": "2026-09-15"})
    await actions.accept_quote(db_session, "e1", by=None)
    assert [c[0] for c in so_books.sent] == ["status"]  # no field write: the dates stand
    assert _statuses(so_books) == [("status", "e1", "accepted")]


@pytest.mark.asyncio
async def test_order_creation_failure_leaves_quote_accepted_and_visible(db_session, so_books):
    await _stored(db_session, so_books, quote(1, status="sent"))
    await sync.run_pass(db_session)
    so_books.create_error = ZohoUpstreamError("boom")
    with pytest.raises(ZohoUpstreamError):
        await actions.accept_quote(db_session, "e1", by=None)
    assert (await sync.find_quote(db_session, "e1")).detail["status"] == "accepted"
    assert [(r["id"], r["state"]) for r in (await sync.read_quotes(db_session))["rows"]] == [("e1", "accepted")]
    assert [e.kind for e in await events_of(db_session, "e1")] == ["quote.accepted"]


@pytest.mark.asyncio
async def test_retry_after_confirm_failure_reuses_the_draft_order(db_session, so_books):
    await _stored(db_session, so_books, quote(1, status="sent"))
    so_books.open_error = ZohoRateLimited("slow down", retry_after=0)
    with pytest.raises(sync.ZohoBusy):
        await actions.accept_quote(db_session, "e1", by=None)
    assert (so_books.deleted, len(so_books.so_payloads)) == ([], 1)  # the draft stays for the retry
    assert sync_common._pending_voids == {}  # a void would keep the quote converted
    sync_common._rate_limited_until = 0.0  # the back-off window has passed
    assert await actions.create_order_from_quote(db_session, "e1", by=None) == "so9"
    assert len(so_books.so_payloads) == 1  # no second order
    assert so_books.opened == ["so9"]
    assert (await sync.find_stored(db_session, "so9")).detail["status"] == "open"


@pytest.mark.asyncio
async def test_confirm_failure_deletes_the_draft_order(db_session, so_books):
    await _stored(db_session, so_books, quote(1, status="sent"))
    so_books.open_error = ZohoUpstreamError("refused")
    with pytest.raises(actions.OrderActionRefused, match="create_failed"):
        await actions.accept_quote(db_session, "e1", by=None)
    assert so_books.deleted == ["so9"]
    assert await sync.find_stored(db_session, "so9") is None
    assert so_books.estimates["e1"]["status"] == "accepted"


@pytest.mark.asyncio
async def test_prefill_without_lines_is_refused_before_any_order(db_session, so_books):
    await _stored(db_session, so_books, quote(1, status="accepted"))
    so_books.prefill_lines = []
    with pytest.raises(actions.OrderActionRefused, match="create_failed"):
        await actions.create_order_from_quote(db_session, "e1", by=None)
    assert so_books.so_payloads == []


@pytest.mark.asyncio
async def test_second_accept_is_refused_as_converted(db_session, so_books):
    await _stored(db_session, so_books, quote(1, status="sent"))
    await actions.accept_quote(db_session, "e1", by=None)
    with pytest.raises(actions.OrderActionRefused, match="quote_converted"):
        await actions.accept_quote(db_session, "e1", by=None)
    with pytest.raises(actions.OrderActionRefused, match="quote_converted"):
        await actions.create_order_from_quote(db_session, "e1", by=None)
    assert len(so_books.so_payloads) == 1


@pytest.mark.asyncio
async def test_create_order_from_quote_needs_an_accepted_quote(db_session, so_books):
    await _stored(db_session, so_books, quote(1, status="sent"))
    with pytest.raises(actions.OrderActionRefused, match="not_accepted"):
        await actions.create_order_from_quote(db_session, "e1", by=None)
    assert (so_books.sent, so_books.so_payloads) == ([], [])
    so_books.estimates["e1"]["status"] = "accepted"
    assert await actions.create_order_from_quote(db_session, "e1", by=None) == "so9"
    assert _statuses(so_books) == []  # already accepted: no status write


async def _accepted_on_board(db, books) -> None:
    """A quote accepted from the board, its order on a computed board."""
    await _stored(db, books, quote(1, status="sent"))
    await sync.run_pass(db)
    await sync.run_pass(db)
    await actions.accept_quote(db, "e1", by=None)
    await sync.run_pass(db)
    assert await sync.find_board_row(db, "so9") is not None


@pytest.mark.asyncio
async def test_undo_deletes_order_and_returns_quote_to_sent(db_session, so_books, pings):
    await _accepted_on_board(db_session, so_books)
    await actions.undo_accept(db_session, "e1", "so9", by="ana")
    assert so_books.deleted == ["so9"]
    assert await sync.find_stored(db_session, "so9") is None
    assert await sync.find_board_row(db_session, "so9") is None
    assert _statuses(so_books)[-1] == ("status", "e1", "sent")
    stored = (await sync.find_quote(db_session, "e1")).detail
    assert (stored["status"], stored["salesorders"]) == ("sent", [])
    assert [e.kind for e in await events_of(db_session, "e1")] == ["quote.accepted", "quote.accept_undone"]
    assert pings[-1]["quotes"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "started",
    [
        {"quantity_packed": 1},
        {"quantity_shipped": 1},
        {"quantity_invoiced": 1},
        {"invoices": [{"invoice_id": "i1", "status": "sent", "total": 1000, "balance": 1000}]},
        {"invoices": [{"invoice_id": "i1", "status": "paid", "total": 1000, "balance": 0}]},
    ],
)
async def test_undo_refused_once_packed_or_paid(db_session, so_books, started):
    await _accepted_on_board(db_session, so_books)
    so = so_books.orders["so9"]
    so["line_items"][0] = {
        **so["line_items"][0],
        "quantity": 2,
        **{k: v for k, v in started.items() if k != "invoices"},
    }
    so["invoices"] = started.get("invoices", [])
    with pytest.raises(actions.OrderActionRefused, match="undo_too_late"):  # Books as it is now decides
        await actions.undo_accept(db_session, "e1", "so9", by=None)
    assert so_books.deleted == []
    assert await sync.find_stored(db_session, "so9") is not None


@pytest.mark.asyncio
async def test_undo_refused_for_an_order_of_another_quote(db_session, so_books):
    await _accepted_on_board(db_session, so_books)
    await _stored(db_session, so_books, quote(2, status="sent"))
    with pytest.raises(actions.OrderActionRefused, match="not_this_quote"):
        await actions.undo_accept(db_session, "e2", "so9", by=None)
    assert so_books.deleted == []


@pytest.mark.asyncio
async def test_undo_of_an_unstored_order_is_404(db_session, so_books):
    await _stored(db_session, so_books, quote(1, status="accepted"))
    with pytest.raises(actions.OrderNotOnBoard):
        await actions.undo_accept(db_session, "e1", "so404", by=None)
    assert so_books.deleted == []
