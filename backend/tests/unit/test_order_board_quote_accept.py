"""Accepting a quote creates its sales order in Books; undo deletes it again. Zoho is a fake throughout."""

import importlib
from datetime import date

import pytest
from sqlalchemy import select

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services import order_board_actions as actions, order_board_sync as sync
from backend.app.services.order_board_actions import quote_accept
from backend.app.services.order_board_sync import _common as sync_common
from backend.app.services.zoho import ZohoRateLimited, ZohoUpstreamError, zoho_service
from backend.tests.unit.test_order_board_actions import events_of
from backend.tests.unit.test_order_board_quote_actions import _stored, books, no_ref_left_over  # noqa: F401
from backend.tests.unit.test_order_board_quote_sync import quote
from backend.tests.unit.test_order_board_routes import tokens  # noqa: F401
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
    books.prefill_flags = {"is_inclusive_tax": True, "discount_type": "item_level", "is_discount_before_tax": True}
    books.delete_error = None  # (error, applied first)

    def link(estimate_id, salesorder_id, status):
        estimate = books.estimates[estimate_id]
        others = [s for s in estimate.get("salesorders") or [] if s["salesorder_id"] != salesorder_id]
        linked = [{"salesorder_id": salesorder_id, "salesorder_order_status": status}] if status else []
        books.estimates[estimate_id] = {**estimate, "salesorders": others + linked}

    async def salesorder_prefill_from_estimate(db, estimate_id):
        return {"customer_id": "c1", **books.prefill_flags, "line_items": books.prefill_lines}

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
        if books.delete_error and not books.delete_error[1]:
            raise books.delete_error[0]
        books.deleted.append(salesorder_id)
        gone = books.orders.pop(salesorder_id)
        link(gone["estimate_id"], salesorder_id, None)
        if books.delete_error:
            raise books.delete_error[0]

    for fn in (salesorder_prefill_from_estimate, create_salesorder, mark_salesorder_open, delete_salesorder):
        monkeypatch.setattr(zoho_service, fn.__name__, fn)
    return books


@pytest.fixture(autouse=True)
def _no_made_orders_left_over():
    quote_accept._made.clear()
    yield
    quote_accept._made.clear()


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
    assert await sync.find_board_row(db, "so9") is not None  # at once: no pass in between


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
    quote_accept._made["e2"] = "so9"  # past the made-here gate, so Books' own link is what refuses
    with pytest.raises(actions.OrderActionRefused, match="not_this_quote"):
        await actions.undo_accept(db_session, "e2", "so9", by=None)
    assert so_books.deleted == []


@pytest.mark.asyncio
async def test_undo_of_an_unstored_order_is_404(db_session, so_books):
    await _stored(db_session, so_books, quote(1, status="accepted"))
    with pytest.raises(actions.OrderNotOnBoard):
        await actions.undo_accept(db_session, "e1", "so404", by=None)
    assert so_books.deleted == []


@pytest.mark.asyncio
async def test_a_failing_reused_draft_is_never_deleted(db_session, so_books):
    draft = {"salesorder_id": "so7", "salesorder_order_status": "draft"}
    await _stored(db_session, so_books, {**quote(1, status="accepted"), "salesorders": [draft]})
    so_books.open_error = ZohoUpstreamError("refused")
    with pytest.raises(actions.OrderActionRefused, match="create_failed"):
        await actions.create_order_from_quote(db_session, "e1", by=None)
    assert (so_books.so_payloads, so_books.deleted) == ([], [])  # reused, not created here: left in Books


@pytest.mark.asyncio
async def test_accept_route_returns_the_new_row(async_client, db_session, so_books, tokens):  # noqa: F811
    await _stored(db_session, so_books, quote(1, status="sent"))
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    r = await async_client.post("/api/v1/order-board/quotes/e1/accept", headers=tokens["both"])
    assert r.status_code == 200
    body = r.json()
    assert (body["salesorder_id"], body["row"]["id"]) == ("so9", "so9")
    assert any(row["id"] == "so9" for row in body["board"]["rows"])


@pytest.mark.asyncio
async def test_a_pass_after_accept_keeps_one_doc_and_its_row(db_session, so_books):
    await _accepted_on_board(db_session, so_books)
    before = await sync.find_board_row(db_session, "so9")
    await sync.run_pass(db_session)
    docs = (
        await db_session.execute(
            select(OrderBoardDoc).where(OrderBoardDoc.kind == "salesorder", OrderBoardDoc.zoho_id == "so9")
        )
    ).scalars()
    assert len(list(docs)) == 1
    row = await sync.find_board_row(db_session, "so9")
    # The fake's items carry no stock: "to_order" either way; the listed header changed nothing in the row.
    assert (row["number"], row["status"]) == ("SO-00009", before["status"])
    assert [(line["id"], line["remaining"]) for line in row["lines"]] == [("l9", 1.0)]
    assert (await sync.find_stored(db_session, "so9")).header["status"] == "open"


def _quote_rows(quotes: dict) -> list:
    return [(r["id"], r["state"]) for r in quotes["rows"]]


@pytest.mark.asyncio
async def test_undo_whose_delete_landed_but_failed_shows_the_quote_accepted_again(db_session, so_books):
    await _accepted_on_board(db_session, so_books)
    so_books.delete_error = (ZohoUpstreamError("timeout"), True)
    with pytest.raises(ZohoUpstreamError):
        await actions.undo_accept(db_session, "e1", "so9", by=None)
    assert so_books.deleted == ["so9"]
    assert _quote_rows(await sync.read_quotes(db_session)) == [("e1", "accepted")]
    assert [e.kind for e in await events_of(db_session, "e1")] == ["quote.accepted"]  # not known to be undone


@pytest.mark.asyncio
async def test_undo_whose_delete_failed_keeps_the_order_and_the_quote_pending(db_session, so_books):
    await _accepted_on_board(db_session, so_books)
    so_books.delete_error = (ZohoUpstreamError("refused"), False)
    with pytest.raises(ZohoUpstreamError):
        await actions.undo_accept(db_session, "e1", "so9", by=None)
    assert await sync.find_board_row(db_session, "so9") is not None
    assert _quote_rows(await sync.read_quotes(db_session)) == []  # still converted
    assert (await sync.find_quote(db_session, "e1")).pending is True


@pytest.mark.asyncio
async def test_undo_with_no_board_row_is_too_late(db_session, so_books):
    await _stored(db_session, so_books, quote(1, status="sent"))
    await actions.accept_quote(db_session, "e1", by=None)  # the board was never computed: no row
    assert await sync.find_board_row(db_session, "so9") is None
    with pytest.raises(actions.OrderActionRefused, match="undo_too_late"):
        await actions.undo_accept(db_session, "e1", "so9", by=None)
    assert so_books.deleted == []


@pytest.mark.asyncio
async def test_accept_of_a_books_expired_quote_is_not_redated(db_session, so_books):
    await _stored(db_session, so_books, quote(1, status="expired"))
    await actions.accept_quote(db_session, "e1", by=None)
    assert so_books.sent == [("status", "e1", "accepted")]


@pytest.mark.asyncio
async def test_a_tax_exclusive_quote_converts_with_its_own_flags(db_session, so_books):
    await _stored(db_session, so_books, {**quote(1, status="accepted"), "is_inclusive_tax": False})
    so_books.prefill_flags = {"is_inclusive_tax": False, "discount_type": "item_level"}
    await actions.create_order_from_quote(db_session, "e1", by=None)
    [payload] = so_books.so_payloads
    assert payload["is_inclusive_tax"] is False
    assert "is_discount_before_tax" not in payload  # neither side states it: not sent as null


@pytest.mark.asyncio
async def test_a_converted_refusal_stores_the_fresh_copy(db_session, so_books):
    await _stored(db_session, so_books, quote(1, status="accepted"))
    await sync.run_pass(db_session)
    assert _quote_rows(await sync.read_quotes(db_session)) == [("e1", "accepted")]
    so_books.estimates["e1"] = {
        **so_books.estimates["e1"],
        "salesorders": [{"salesorder_id": "so5", "salesorder_order_status": "open"}],
    }
    with pytest.raises(actions.OrderActionRefused, match="quote_converted"):
        await actions.create_order_from_quote(db_session, "e1", by=None)
    assert _quote_rows(await sync.read_quotes(db_session)) == []


@pytest.mark.asyncio
async def test_undo_refused_when_the_quote_doc_goes_before_the_delete(db_session, so_books, monkeypatch):
    await _accepted_on_board(db_session, so_books)
    reread = importlib.import_module("backend.app.services.order_board_actions.quote_accept")._reread

    async def reread_then_dropped(db, salesorder_id):
        order = await reread(db, salesorder_id)
        await db.delete(await sync.find_quote(db, "e1"))  # a sync pass drops the doc mid-action
        await db.commit()
        return order

    monkeypatch.setattr(
        importlib.import_module("backend.app.services.order_board_actions.quote_accept"), "_reread", reread_then_dropped
    )
    with pytest.raises(actions.QuoteNotStored):
        await actions.undo_accept(db_session, "e1", "so9", by=None)
    assert so_books.deleted == []


@pytest.mark.asyncio
async def test_a_quote_books_now_reports_invoiced_leaves_the_rows(db_session, so_books):
    await _stored(db_session, so_books, quote(1, status="sent"))
    await sync.run_pass(db_session)
    assert _quote_rows(await sync.read_quotes(db_session)) == [("e1", "sent")]
    so_books.estimates["e1"] = {**so_books.estimates["e1"], "status": "invoiced", "invoice_ids": ["i1"]}
    with pytest.raises(actions.OrderActionRefused, match="quote_converted"):
        await actions.decline_quote(db_session, "e1", by=None)
    assert _quote_rows(await sync.read_quotes(db_session)) == []


@pytest.mark.asyncio
async def test_undo_refused_for_a_reused_draft_without_a_books_call(db_session, so_books, pings):
    draft = {"salesorder_id": "so9", "salesorder_order_status": "draft"}
    so_books.add({**order(9, estimate_id="e1"), "salesorder_id": "so9", "status": "draft"})
    await _stored(db_session, so_books, {**quote(1, status="accepted"), "salesorders": [draft]})
    await sync.run_pass(db_session)
    assert await actions.create_order_from_quote(db_session, "e1", by=None) == "so9"
    assert so_books.so_payloads == []  # reused, not created here
    sent = list(so_books.sent)
    with pytest.raises(actions.OrderActionRefused, match="undo_too_late"):
        await actions.undo_accept(db_session, "e1", "so9", by=None)
    assert (so_books.deleted, so_books.sent) == ([], sent)


@pytest.mark.asyncio
async def test_undo_refused_for_an_order_never_accepted_here(db_session, so_books):
    await _accepted_on_board(db_session, so_books)
    quote_accept._made.clear()  # as after a restart
    sent = list(so_books.sent)
    with pytest.raises(actions.OrderActionRefused, match="undo_too_late"):
        await actions.undo_accept(db_session, "e1", "so9", by=None)
    assert (so_books.deleted, so_books.sent) == ([], sent)


@pytest.mark.asyncio
async def test_a_second_undo_after_success_is_refused(db_session, so_books):
    await _accepted_on_board(db_session, so_books)
    await actions.undo_accept(db_session, "e1", "so9", by=None)
    assert so_books.deleted == ["so9"]
    assert "e1" not in quote_accept._made  # forgotten with the delete
    with pytest.raises(actions.OrderNotOnBoard):  # the stored order is gone too
        await actions.undo_accept(db_session, "e1", "so9", by=None)
    assert so_books.deleted == ["so9"]


@pytest.mark.asyncio
async def test_made_here_map_is_bounded(db_session, so_books):
    quote_accept._made.update({f"x{i}": "s" for i in range(300)})
    await _accepted_on_board(db_session, so_books)
    assert len(quote_accept._made) == 200 and quote_accept._made["e1"] == "so9"


@pytest.mark.asyncio
@pytest.mark.parametrize("draft,undoable", [(False, True), (True, False)])
async def test_order_responses_say_whether_this_click_made_the_order(
    async_client,
    db_session,
    so_books,
    tokens,
    draft,
    undoable,  # noqa: F811
):
    if draft:
        so_books.add({**order(9, estimate_id="e1"), "salesorder_id": "so9", "status": "draft"})
        row = {
            **quote(1, status="accepted"),
            "salesorders": [{"salesorder_id": "so9", "salesorder_order_status": "draft"}],
        }
    else:
        row = quote(1, status="sent")
    await _stored(db_session, so_books, row)
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    r = await async_client.post(
        f"/api/v1/order-board/quotes/e1/{'order' if draft else 'accept'}", headers=tokens["both"]
    )
    assert r.status_code == 200
    assert r.json()["undoable"] is undoable


@pytest.mark.asyncio
async def test_failed_cleanup_delete_leaves_the_draft_and_the_retry_reuses_it(db_session, so_books):
    await _stored(db_session, so_books, quote(1, status="sent"))
    so_books.open_error = ZohoUpstreamError("refused")
    so_books.delete_error = (ZohoUpstreamError("also refused"), False)
    with pytest.raises(actions.OrderActionRefused, match="create_failed"):
        await actions.accept_quote(db_session, "e1", by=None)
    assert (so_books.deleted, list(so_books.orders)) == ([], ["so9"])  # the draft is left in Books
    assert quote_accept._made == {}
    so_books.delete_error = None
    assert await actions.create_order_from_quote(db_session, "e1", by=None) == "so9"
    assert len(so_books.so_payloads) == 1  # no second order
    assert (so_books.opened, so_books.deleted) == (["so9"], [])
    assert quote_accept._made == {}  # reused, so undo stays refused


@pytest.mark.asyncio
async def test_undo_while_books_is_backed_off_is_busy_and_sends_nothing(db_session, so_books, monkeypatch):
    await _accepted_on_board(db_session, so_books)
    monkeypatch.setattr(sync, "zoho_busy", lambda: True)
    sent = list(so_books.sent)
    with pytest.raises(sync.ZohoBusy):
        await actions.undo_accept(db_session, "e1", "so9", by=None)
    assert (so_books.deleted, so_books.sent) == ([], sent)
    assert quote_accept._made == {"e1": "so9"}  # still undoable once the window passes


@pytest.mark.asyncio
async def test_undo_succeeds_when_the_stored_order_vanished_during_the_delete(db_session, so_books, monkeypatch):
    await _accepted_on_board(db_session, so_books)
    delete = zoho_service.delete_salesorder

    async def delete_and_drop_doc(db, salesorder_id):
        await delete(db, salesorder_id)
        await db.delete(await sync.find_stored(db, salesorder_id))  # a sync pass dropped it meanwhile
        await db.commit()

    monkeypatch.setattr(zoho_service, "delete_salesorder", delete_and_drop_doc)
    await actions.undo_accept(db_session, "e1", "so9", by=None)
    assert so_books.deleted == ["so9"]
    assert _statuses(so_books)[-1] == ("status", "e1", "sent")
    assert [e.kind for e in await events_of(db_session, "e1")] == ["quote.accepted", "quote.accept_undone"]


@pytest.mark.asyncio
async def test_accept_of_an_already_accepted_quote_writes_no_status(db_session, so_books):
    await _stored(db_session, so_books, quote(1, status="accepted"))
    assert await actions.accept_quote(db_session, "e1", by="ana") == "so9"
    assert so_books.sent == []  # no advance_estimate_status call
    assert [e.kind for e in await events_of(db_session, "e1")] == []  # no quote.accepted event either
    assert quote_accept._made == {"e1": "so9"}


async def _payment_rows(db, *, link=None, charge=None, booking=None, minted=True) -> None:
    from backend.app.models.aito_payment_link import AitoPaymentLink
    from backend.app.models.aito_terminal_payment import AitoTerminalPayment

    if link is not None:
        db.add(
            AitoPaymentLink(
                project_id=0,
                salesorder_id="so9",
                idempotency_key="k-link",
                heimdall_id="h-link" if minted else None,
                reference="r",
                amount=100,
                expires_on="2026-12-31",
                status=link,
            )
        )
    if charge is not None:
        db.add(
            AitoTerminalPayment(
                project_id=0,
                salesorder_id="so9",
                document_kind="salesorder",
                document_id="so9",
                document_number="SO-00009",
                idempotency_key="k-tpe",
                heimdall_id="h-tpe",
                amount=100,
                status=charge,
                booking_status=booking,
            )
        )
    await db.commit()


@pytest.mark.asyncio
@pytest.mark.parametrize(("link", "charge"), [("pending", None), (None, "processing"), (None, "pending")])
async def test_undo_refused_while_a_payment_is_in_flight(db_session, so_books, link, charge):
    await _accepted_on_board(db_session, so_books)
    await _payment_rows(db_session, link=link, charge=charge)
    with pytest.raises(actions.OrderActionRefused, match="undo_too_late"):
        await actions.undo_accept(db_session, "e1", "so9", by=None)
    assert so_books.deleted == []
    assert await sync.find_stored(db_session, "so9") is not None


@pytest.mark.asyncio
async def test_undo_refused_while_a_payment_link_is_still_being_made(db_session, so_books):
    await _accepted_on_board(db_session, so_books)
    await _payment_rows(db_session, link="pending", minted=False)
    with pytest.raises(actions.OrderActionRefused, match="undo_too_late"):
        await actions.undo_accept(db_session, "e1", "so9", by=None)
    assert so_books.deleted == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("charge", "booking"),
    [("needs_attention", None), ("paid", "pending"), ("paid", "failed"), ("paid", None)],
)
async def test_undo_refused_while_a_card_payment_is_not_in_books(db_session, so_books, charge, booking):
    await _accepted_on_board(db_session, so_books)
    await _payment_rows(db_session, charge=charge, booking=booking)
    with pytest.raises(actions.OrderActionRefused, match="undo_too_late"):
        await actions.undo_accept(db_session, "e1", "so9", by=None)
    assert so_books.deleted == []
    assert await sync.find_stored(db_session, "so9") is not None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("link", "charge"),
    [("expired", None), ("cancelled", None), (None, "paid"), (None, "failed"), (None, "cancelled")],
)
async def test_undo_still_deletes_when_the_payment_is_final(db_session, so_books, link, charge):
    await _accepted_on_board(db_session, so_books)
    await _payment_rows(db_session, link=link, charge=charge, booking="booked")
    await actions.undo_accept(db_session, "e1", "so9", by=None)
    assert so_books.deleted == ["so9"]


@pytest.mark.asyncio
async def test_accept_sends_numeric_line_discounts_as_numbers(db_session, so_books):
    """Books' prefill states the line discount as a number: 12.5 and a real 0 reach the order as they are."""
    so_books.prefill_lines = [
        {**PREFILL_LINE, "item_id": "A", "discount": 12.5},
        {**PREFILL_LINE, "item_id": "B", "discount": 0},
    ]
    await _stored(db_session, so_books, quote(1, status="sent"))
    await actions.accept_quote(db_session, "e1", by=None)
    sent = [(line["item_id"], line["discount"]) for line in so_books.so_payloads[0]["line_items"]]
    assert sent == [("A", 12.5), ("B", 0)]
    assert [type(d) for _, d in sent] == [float, int]
