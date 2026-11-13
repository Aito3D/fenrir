"""Finished orders: which ones count, the list, one in full, and the detail kept or fetched on open."""

import asyncio
import time
from datetime import date, datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services.order_board import age_days, finished_is_core, order_row
from backend.app.services.order_board_payment import order_payment, quote_number_missing
from backend.app.services.order_board_sync import _common
from backend.app.services.order_board_sync._board import _add_links
from backend.app.services.order_board_sync._common import (
    CALL_CEILING,
    OrderNotFinished,
    ZohoBusy,
    _detail_locks,
    _find_state,
    _is_candidate,
    _is_finished,
    _naive_utc,
    _now,
    load_settings,
    open_rate_limit_window,
)
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoRateLimited, zoho_service

# A finished, paid order older than this keeps only its list row; its detail is read again when opened.
FINISHED_DETAIL_DAYS = 90
# A detail read on open is kept this long before being dropped again.
FINISHED_DETAIL_GRACE_DAYS = 7


def _archived(header: dict) -> bool:
    """A finished, paid order old enough that its detail is not kept nor fetched ahead of an open."""
    return (
        _is_finished(header)
        and header.get("paid_status") == "paid"
        and age_days(header.get("date") or "", date.today()) > FINISHED_DETAIL_DAYS
    )


def _drop_archived_detail(doc: OrderBoardDoc) -> bool:
    fetched = _naive_utc(str((doc.detail or {}).get("_fetched_at") or ""))
    return (
        doc.detail is not None
        and _archived(doc.header)
        and (
            fetched is None
            or (datetime.now(timezone.utc).replace(tzinfo=None) - fetched).days >= FINISHED_DETAIL_GRACE_DAYS
        )
    )


_PAID_FLAGS = {"paid": "paid", "partially_paid": "partial", "unpaid": "unpaid"}
# Header fields that, once they differ from the stored detail's, say the detail is out of date.
_FRESHNESS_FIELDS = ("last_modified_time", "paid_status", "invoiced_status")


def _is_stale(doc: OrderBoardDoc) -> bool:
    detail = doc.detail or {}
    return bool(detail.get("_stale")) or any(doc.header.get(f) != detail.get(f) for f in _FRESHNESS_FIELDS)


def _snapshot(doc: OrderBoardDoc) -> tuple | None:
    detail = doc.detail
    return None if detail is None else (detail.get("_fetched_at"), bool(detail.get("_stale")))


async def _finished_docs(db: AsyncSession, salesorder_id: str | None = None) -> list[OrderBoardDoc]:
    """Sales orders that count as finished, judged from stored rows only. A candidate with a stored
    detail that the stored board does not show has shipped since the board was computed."""
    state = await _find_state(db)
    current = (state.detail if state else None) or {}
    # shortcut: before the first computed board nothing is "off the board" yet, so only list-row shipping counts
    computed_at: str = current.get("computed_at") or ""
    on_board = {r["id"] for r in current.get("rows") or []} if computed_at else None
    settings = await load_settings(db)
    query = select(OrderBoardDoc).where(OrderBoardDoc.kind == "salesorder")
    if salesorder_id is not None:
        query = query.where(OrderBoardDoc.zoho_id == salesorder_id)
    docs = (await db.execute(query)).scalars().all()
    return [
        d
        for d in docs
        if _is_finished(d.header)
        or (
            on_board is not None
            and d.detail is not None
            and d.zoho_id not in on_board
            # fetched after the board was computed (a pass that failed before recompute): not shipped, just new
            and (d.detail.get("_fetched_at") or "~") <= computed_at
            and _is_candidate(d.kind, d.header, settings)
        )
    ]


async def read_finished(db: AsyncSession) -> dict:
    """Finished orders, newest first, from stored list rows: no Zoho call."""
    try:
        base = await zoho_service.books_salesorder_url_base(db)
    except ZohoNotConfiguredError:
        base = None
    today = date.today()
    core = {brand.casefold() for brand in (await load_settings(db)).core_brands}
    items = {
        d.zoho_id: d.header
        for d in (await db.execute(select(OrderBoardDoc).where(OrderBoardDoc.kind == "item"))).scalars().all()
    }
    docs = sorted(
        await _finished_docs(db),
        key=lambda d: (d.header.get("date") or "", d.header.get("salesorder_number") or ""),
        reverse=True,
    )
    rows = [
        {
            "id": d.zoho_id,
            "number": d.header.get("salesorder_number"),
            "customer": d.header.get("customer_name"),
            "date": d.header.get("date"),
            "total": d.header.get("total"),
            "currency": d.header.get("currency_code"),
            "reference": d.header.get("reference_number") or "",
            # The list row's own quantities: the "Shipped n/n" caption needs no detail.
            "units": {
                "shipped": float(d.header.get("quantity_shipped") or 0),
                "total": float(d.header.get("quantity") or 0),
            },
            # The day the last parcel left, from the stored detail: None once the detail is dropped.
            "handed_over": max(
                (p.get("shipment_date") or "" for p in (d.detail or {}).get("packages") or []), default=""
            )
            or None,
            "paid_flag": _PAID_FLAGS.get(d.header.get("paid_status") or ""),
            "payment": order_payment(d.detail, today) if d.detail and not _is_stale(d) else None,
            "is_core": finished_is_core(d.detail, items, core),
            "zoho_url": f"{base}{d.zoho_id}" if base else None,
        }
        for d in docs
    ]
    return {"rows": rows}


async def read_finished_order(db: AsyncSession, salesorder_id: str) -> dict:
    """One finished order in full. Fetched from Zoho only when no current copy is stored; then kept."""
    doc = next(iter(await _finished_docs(db, salesorder_id)), None)
    if doc is None:
        raise OrderNotFinished(salesorder_id)
    await _ensure_finished_detail(db, doc)
    rows = [order_row(doc.detail or {}, {}, date.today())]
    await _add_links(db, rows)
    return rows[0]


async def _ensure_finished_detail(db: AsyncSession, doc: OrderBoardDoc) -> None:
    """Fetch the finished order's detail when none is stored or the copy is out of date; otherwise nothing.

    One fetch per order at a time: operators opening the same order together, or an open racing the pass,
    share the first fetch instead of each calling Zoho. The re-read after the wait sees what it stored.
    """
    if doc.detail is not None and not _is_stale(doc):
        return
    async with _detail_locks.setdefault(doc.zoho_id, asyncio.Lock()):
        await db.refresh(doc)
        if doc.detail is None or _is_stale(doc):
            await _fetch_finished_detail(db, doc)


async def _store_quote_number(db: AsyncSession, doc: OrderBoardDoc) -> None:
    quote = await zoho_service.get_estimate(db, str((doc.detail or {}).get("estimate_id") or ""))
    await db.refresh(doc)
    doc.detail = {**(doc.detail or {}), "estimate_number": quote.get("estimate_number") or ""}
    await db.commit()


async def _fetch_finished_detail(db: AsyncSession, doc: OrderBoardDoc) -> None:
    salesorder_id = doc.zoho_id
    if time.monotonic() < _common._rate_limited_until or zoho_service.calls_in_last_minute() >= CALL_CEILING:
        raise ZohoBusy(salesorder_id)
    before = _snapshot(doc)
    try:
        fetched = await zoho_service.get_salesorder(db, salesorder_id)
    except ZohoRateLimited as e:
        open_rate_limit_window(e)
        raise ZohoBusy(salesorder_id) from e
    # No pass lock here (a pass can run long): if a pass wrote this row meanwhile, its mark or newer detail
    # must not be lost, so the fetched copy goes in marked stale and the next open fetches again.
    await db.refresh(doc)
    detail = {**fetched, "_fetched_at": _now(), **({"_stale": True} if _snapshot(doc) != before else {})}
    doc.detail = detail
    doc.pending = False
    await db.commit()
    if quote_number_missing(detail) and zoho_service.calls_in_last_minute() < CALL_CEILING:
        await _store_quote_number(db, doc)
