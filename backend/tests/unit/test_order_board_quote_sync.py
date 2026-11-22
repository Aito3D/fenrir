"""The sync pass keeps the Books estimates (product quotes) too. Zoho is a fake throughout."""

import re
import time
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from backend.app.models.aito_project import AitoProject
from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services import order_board_sync as sync
from backend.app.services.zoho import (
    ZohoNotConfiguredError,
    ZohoNotFound,
    ZohoRateLimited,
    ZohoRequestRejected,
    ZohoUpstreamError,
    zoho_service,
)
from backend.tests.unit.test_order_board_sync import (  # noqa: F401
    days_ago,
    no_back_off_left_over,
    order,
    pings,
    zoho,
)


def quote(n: int, *, status="sent", age=3, item="A", modified="2026-11-01T08:00:00-1000", salesorders=()) -> dict:
    """A full estimate; the fake derives its list row from it."""
    return {
        "estimate_id": f"e{n}",
        "estimate_number": f"QT-{n:05d}",
        "customer_id": "c1",
        "customer_name": f"Customer {n}",
        "date": days_ago(age),
        "expiry_date": days_ago(-30),
        "status": status,
        "total": 500.0,
        "currency_code": "XPF",
        "reference_number": "",
        "is_inclusive_tax": True,
        "discount_type": "item_level",
        "last_modified_time": modified,
        "line_items": [{"line_item_id": f"ql{n}", "item_id": item, "name": "Thing", "quantity": 1, "rate": 500}],
        "salesorders": list(salesorders),
        "invoice_ids": [],
    }


def add_quotes(zoho, *quotes: dict) -> None:
    for q in quotes:
        zoho.estimates[q["estimate_id"]] = q


async def stored_quotes(db) -> dict[str, OrderBoardDoc]:
    docs = (await db.execute(select(OrderBoardDoc).where(OrderBoardDoc.kind == "estimate"))).scalars().all()
    return {d.zoho_id: d for d in docs}


async def set_state(db, **values) -> None:
    state = await sync._find_state(db)
    state.detail = {**state.detail, **values}
    await db.commit()


@pytest.mark.asyncio
async def test_first_pass_lists_everything_then_only_changes(db_session, zoho, pings):
    add_quotes(zoho, quote(1))
    await sync.run_pass(db_session)
    assert (zoho.calls["list_estimates"], zoho.calls["estimate"]) == (1, 1)
    assert pings[-1]["quotes"] is True
    await sync.run_pass(db_session)
    assert (zoho.calls["list_estimates"], zoho.calls["estimate_changes"]) == (1, 1)
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d{4}", zoho.estimate_since[0])  # Books' dialect
    assert not any(p["quotes"] for p in pings[1:])  # nothing changed on the second pass
    assert (await stored_quotes(db_session))["e1"].detail["line_items"][0]["item_id"] == "A"


@pytest.mark.asyncio
async def test_invoiced_and_aito_rows_are_not_stored(db_session, zoho):
    db_session.add(AitoProject(description="card", board_column="devis", quote_id="e2"))
    await db_session.commit()
    add_quotes(zoho, quote(1, status="invoiced"), quote(2), quote(3))
    await sync.run_pass(db_session)
    assert set(await stored_quotes(db_session)) == {"e3"}


@pytest.mark.asyncio
async def test_stored_quote_linked_to_an_aito_card_is_dropped(db_session, zoho):
    add_quotes(zoho, quote(1), quote(2))
    await sync.run_pass(db_session)
    db_session.add(AitoProject(description="card", board_column="devis", quote_id="e1"))
    await db_session.commit()
    await sync.run_pass(db_session)  # e1 is not in the change listing: dropped without asking Books
    assert set(await stored_quotes(db_session)) == {"e2"}


@pytest.mark.asyncio
async def test_quote_deleted_in_books_goes_on_the_next_full_listing(db_session, zoho):
    add_quotes(zoho, quote(1), quote(2))
    await sync.run_pass(db_session)
    del zoho.estimates["e1"]
    await sync.run_pass(db_session)
    assert set(await stored_quotes(db_session)) == {"e1", "e2"}  # a change listing cannot see a deletion
    await set_state(db_session, quotes_swept_at=(datetime.now(timezone.utc) - timedelta(hours=25)).isoformat())
    await sync.run_pass(db_session)
    assert zoho.calls["list_estimates"] == 2
    assert set(await stored_quotes(db_session)) == {"e2"}


@pytest.mark.asyncio
async def test_changed_row_is_refetched_and_unchanged_is_not(db_session, zoho):
    add_quotes(zoho, quote(1), quote(2))
    await sync.run_pass(db_session)
    zoho.estimates["e1"] = quote(1, modified="2026-11-02T08:00:00-1000", item="B")
    zoho.touched = {"e1", "e2"}
    await sync.run_pass(db_session)
    assert zoho.calls["estimate"] == 3
    assert (await stored_quotes(db_session))["e1"].detail["line_items"][0]["item_id"] == "B"


@pytest.mark.asyncio
async def test_orders_are_fetched_before_quotes(db_session, zoho):
    zoho.add(*(order(n) for n in range(25)))
    add_quotes(zoho, *(quote(n) for n in range(5)))
    await sync.run_pass(db_session)
    assert (zoho.calls["detail"], zoho.calls["estimate"]) == (20, 0)


@pytest.mark.asyncio
async def test_board_first_computes_with_quote_details_pending(db_session, zoho):
    zoho.add(order(1))
    add_quotes(zoho, *(quote(n) for n in range(25)))
    await sync.run_pass(db_session)
    board = await sync.read_board(db_session)
    assert board["computed_at"] and [r["id"] for r in board["rows"]] == ["so1"]
    assert (await sync.read_quotes(db_session))["loading"] == 6  # 19 of 25 quote details fetched


@pytest.mark.asyncio
async def test_read_quotes_reports_loading_and_hides_accepted_without_detail(db_session, zoho):
    assert await sync.read_quotes(db_session) == {"rows": [], "loading": 0, "ready": False}
    # The accepted quote is the oldest: newest first, its detail misses this pass's 20 slots.
    add_quotes(zoho, quote(0, status="accepted", age=40), *(quote(n, age=n) for n in range(1, 21)))
    await sync.run_pass(db_session)
    quotes = await sync.read_quotes(db_session)
    assert (quotes["ready"], quotes["loading"]) == (True, 1)
    assert sorted(r["id"] for r in quotes["rows"]) == sorted(f"e{n}" for n in range(1, 21))
    assert quotes["rows"][0]["lines"][0]["available"] == 100  # stock loaded for the quote lines


@pytest.mark.asyncio
async def test_rejected_estimate_detail_drops_the_doc(db_session, zoho):
    zoho.rejected_estimates = {"e1"}
    add_quotes(zoho, quote(1), quote(2))
    await sync.run_pass(db_session)
    assert set(await stored_quotes(db_session)) == {"e2"}
    assert (await sync.read_board(db_session))["sync"]["last_error"] is None


@pytest.mark.asyncio
async def test_full_listing_waits_when_books_is_busy(db_session, zoho):
    zoho.meter = 11
    add_quotes(zoho, quote(1))
    await sync.run_pass(db_session)
    assert (zoho.calls["list_estimates"], zoho.calls["estimate_changes"]) == (0, 0)
    assert (await sync.read_quotes(db_session))["ready"] is False


@pytest.mark.asyncio
async def test_truncated_change_listing_forces_a_full_one(db_session, zoho):
    add_quotes(zoho, quote(1))
    await sync.run_pass(db_session)
    zoho.estimates_truncated = True
    await sync.run_pass(db_session)
    assert zoho.calls["list_estimates"] == 1
    await sync.run_pass(db_session)
    assert zoho.calls["list_estimates"] == 2


@pytest.mark.asyncio
async def test_a_write_during_the_fetch_keeps_the_quote_pending(db_session, zoho, monkeypatch):
    add_quotes(zoho, quote(1))
    fetch = zoho.get_estimate

    async def written_meanwhile(db, estimate_id):
        sync.note_write(estimate_id)
        return await fetch(db, estimate_id)

    monkeypatch.setattr(sync._pass.zoho_service, "get_estimate", written_meanwhile)
    await sync.run_pass(db_session)
    doc = (await stored_quotes(db_session))["e1"]
    assert (doc.detail, doc.pending) == (None, True)


@pytest.mark.asyncio
async def test_pending_quote_details_do_not_raise_the_board_pending_count(db_session, zoho):
    zoho.add(order(1))
    add_quotes(zoho, *(quote(n) for n in range(25)))
    await sync.run_pass(db_session)
    assert (await sync.read_quotes(db_session))["loading"] == 6
    assert (await sync.read_board(db_session))["sync"]["pending"] == 0


@pytest.mark.asyncio
async def test_quote_rows_carry_the_books_address_or_none(db_session, zoho, monkeypatch):  # noqa: F811
    zoho.estimates["e1"] = quote(1)
    await sync.run_pass(db_session)
    rows = (await sync.read_quotes(db_session))["rows"]
    assert rows and all(r["zoho_url"].endswith("#/quotes/" + r["id"]) for r in rows)

    async def unconfigured(db, estimate_id):
        raise ZohoNotConfiguredError("no")

    monkeypatch.setattr(zoho_service, "books_app_url", unconfigured)
    assert all(r["zoho_url"] is None for r in (await sync.read_quotes(db_session))["rows"])


async def _quote_clock(db) -> tuple:
    detail = (await sync._find_state(db)).detail
    return detail.get("quotes_listed_at"), detail.get("quotes_swept_at")


@pytest.mark.asyncio
async def test_not_found_estimate_detail_drops_the_doc_and_the_pass_continues(db_session, zoho, monkeypatch):
    add_quotes(zoho, quote(1), quote(2))
    fetch = zoho.get_estimate

    async def gone(db, estimate_id):
        if estimate_id == "e1":
            raise ZohoNotFound("gone")
        return await fetch(db, estimate_id)

    monkeypatch.setattr(zoho_service, "get_estimate", gone)
    await sync.run_pass(db_session)
    assert set(await stored_quotes(db_session)) == {"e2"}
    assert (await stored_quotes(db_session))["e2"].detail is not None


@pytest.mark.asyncio
async def test_a_listing_that_raises_leaves_the_watermark_and_sweep_time(db_session, zoho, monkeypatch):
    add_quotes(zoho, quote(1))
    await sync.run_pass(db_session)
    before = await _quote_clock(db_session)
    await set_state(db_session, quotes_swept_at=(datetime.now(timezone.utc) - timedelta(hours=25)).isoformat())
    swept = (await _quote_clock(db_session))[1]

    async def boom(db):
        raise ZohoUpstreamError("listing boom")

    monkeypatch.setattr(zoho_service, "list_estimates", boom)
    with pytest.raises(ZohoUpstreamError):
        await sync._quotes.reconcile_quotes(db_session, await sync.load_settings(db_session))
    assert await _quote_clock(db_session) == (before[0], swept)


@pytest.mark.asyncio
async def test_an_empty_estimate_body_is_never_stored_under_another_id(db_session, zoho, monkeypatch):
    add_quotes(zoho, quote(1))

    async def empty(db, estimate_id):
        return {}

    monkeypatch.setattr(zoho_service, "get_estimate", empty)
    await sync.run_pass(db_session)
    assert await stored_quotes(db_session) == {}  # dropped, not pending forever: the next full listing re-adds it


@pytest.mark.asyncio
async def test_a_rejected_estimate_listing_does_not_stop_the_orders(db_session, zoho, monkeypatch):
    add_quotes(zoho, quote(1))
    await sync.run_pass(db_session)
    await set_state(db_session, quotes_swept_at=(datetime.now(timezone.utc) - timedelta(hours=25)).isoformat())
    before = await _quote_clock(db_session)

    async def rejected(db):
        raise ZohoRequestRejected("no estimates")

    monkeypatch.setattr(zoho_service, "list_estimates", rejected)
    zoho.add(order(1))
    await sync.run_pass(db_session)
    assert zoho.calls["detail"] == 1
    assert (await sync.find_stored(db_session, "so1")).detail is not None
    assert await _quote_clock(db_session) == before


@pytest.mark.asyncio
async def test_a_rate_limited_estimate_listing_still_ends_the_pass(db_session, zoho, monkeypatch):
    async def limited(db):
        raise ZohoRateLimited("slow down", retry_after=90)

    monkeypatch.setattr(zoho_service, "list_estimates", limited)
    zoho.add(order(1))
    await sync.run_pass(db_session)
    assert zoho.calls["detail"] == 0
    assert sync._common._rate_limited_until > time.monotonic()


@pytest.mark.asyncio
async def test_a_converted_accepted_quote_has_its_items_left_out_of_the_stock_read(db_session, zoho):
    done = quote(
        1, status="accepted", item="B", salesorders=[{"salesorder_id": "so9", "salesorder_order_status": "open"}]
    )
    add_quotes(zoho, done, quote(2, item="A"))
    await sync.run_pass(db_session)
    assert [i for batch in zoho.item_batches for i in batch] == ["A"]
