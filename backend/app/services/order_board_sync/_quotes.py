"""The product quotes (Books estimates) in the local copy: the listing each pass reconciles, and the read the tab serves.

Each stored ``estimate`` doc keeps the list row in ``header`` and the full estimate in ``detail``. The state doc keeps
``quotes_swept_at`` (our ISO time of the last complete full listing) and ``quotes_listed_at`` (Books-format watermark
for the modified-since listing, taken when a listing starts)."""

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_project import AitoProject
from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services.aito_poll_watermark import format_books_time
from backend.app.services.order_board_quotes import held_by_orders, is_quote_candidate, quote_row
from backend.app.services.order_board_sync._common import (
    OrderBoardSettings,
    _find_state,
    _now,
    _state,
    load_settings,
)
from backend.app.services.zoho import ZohoNotConfiguredError, zoho_service

FULL_LISTING_EVERY = timedelta(hours=24)
# A full listing is many pages: only start one while Books is nearly idle.
FULL_LISTING_MAX_CALLS = 10
_HEADER_FIELDS = (
    "status",
    "last_modified_time",
    "total",
    "date",
    "expiry_date",
    "customer_id",
    "customer_name",
    "estimate_number",
    "reference_number",
    "currency_code",
)


async def _stored_quotes(db: AsyncSession) -> dict[str, OrderBoardDoc]:
    docs = (await db.execute(select(OrderBoardDoc).where(OrderBoardDoc.kind == "estimate"))).scalars()
    return {d.zoho_id: d for d in docs}


async def _aito_quote_ids(db: AsyncSession) -> set[str]:
    """Estimates an Aito card owns: the Kanban shows those, never this tab."""
    rows = await db.execute(select(AitoProject.quote_id).where(AitoProject.quote_id.is_not(None)))
    return {str(q) for q in rows.scalars()}


def _full_listing_due(swept_at: str | None) -> bool:
    if not swept_at:
        return True
    try:
        return datetime.now(timezone.utc) - datetime.fromisoformat(swept_at) > FULL_LISTING_EVERY
    except (TypeError, ValueError):
        return True


async def reconcile_quotes(db: AsyncSession, settings: OrderBoardSettings) -> None:
    """List Books' estimates (all of them once a day, else the changed ones) and reconcile the stored docs."""
    state = await _state(db)
    current = state.detail or {}
    stored = await _stored_quotes(db)
    aito = await _aito_quote_ids(db)
    for estimate_id in aito & set(stored):  # moved to an Aito card: no Books call needed to know
        await db.delete(stored.pop(estimate_id))

    started = format_books_time(datetime.now(timezone.utc))
    listed_at = current.get("quotes_listed_at")
    full = (
        _full_listing_due(current.get("quotes_swept_at"))
        and zoho_service.calls_in_last_minute() <= FULL_LISTING_MAX_CALLS
    )
    truncated = False
    if full:
        rows = await zoho_service.list_estimates(db)
    elif listed_at:
        rows, truncated = await zoho_service.list_estimate_rows_modified_since(db, listed_at)
    else:  # never listed and Books is busy: the first full listing waits for a later pass
        await db.commit()
        return

    today = date.today()
    listed: set[str] = set()
    for header in rows:
        estimate_id = str(header.get("estimate_id") or "")
        listed.add(estimate_id)
        doc = stored.get(estimate_id)
        if not is_quote_candidate(header, today, settings.max_age_days, aito):
            if doc is not None:
                await db.delete(stored.pop(estimate_id))
            continue
        if doc is None:
            stored[estimate_id] = OrderBoardDoc(kind="estimate", zoho_id=estimate_id, header=header, pending=True)
            db.add(stored[estimate_id])
            continue
        if doc.detail is None or doc.header.get("last_modified_time") != header.get("last_modified_time"):
            doc.pending = True
        doc.header = header
    if full:
        for estimate_id in set(stored) - listed:  # deleted in Books, or gone from the listing
            await db.delete(stored.pop(estimate_id))

    detail = dict(current)
    if full:
        detail["quotes_swept_at"] = _now()
    if truncated:
        # The tail past the cut was never seen: keep the old watermark and run a full listing next.
        detail.pop("quotes_swept_at", None)
    else:
        detail["quotes_listed_at"] = started
    state.detail = detail
    await db.commit()


async def find_quote(db: AsyncSession, estimate_id: str) -> OrderBoardDoc | None:
    return (
        await db.execute(
            select(OrderBoardDoc)
            .where(OrderBoardDoc.kind == "estimate", OrderBoardDoc.zoho_id == estimate_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()


async def store_quote(db: AsyncSession, estimate: dict) -> OrderBoardDoc:
    """Store a full estimate as the quote's copy (insert or update). The caller commits."""
    estimate_id = str(estimate.get("estimate_id") or "")
    doc = await find_quote(db, estimate_id)
    if doc is None:
        doc = OrderBoardDoc(kind="estimate", zoho_id=estimate_id, header={"estimate_id": estimate_id})
        db.add(doc)
    doc.header = {**(doc.header or {}), **{f: estimate.get(f) for f in _HEADER_FIELDS}}
    doc.detail = estimate
    doc.pending = False
    return doc


async def read_quotes(db: AsyncSession) -> dict:
    """The quote rows from the local copy: one local read, no Zoho call."""
    state = await _find_state(db)
    current = (state.detail if state else None) or {}
    loading = (
        await db.execute(
            select(func.count())
            .select_from(OrderBoardDoc)
            .where(OrderBoardDoc.kind == "estimate", OrderBoardDoc.pending.is_(True))
        )
    ).scalar_one()
    # The first listing is always a full one, and a truncated change listing clears quotes_swept_at but never this.
    if not current.get("quotes_listed_at"):
        return {"rows": [], "loading": loading, "ready": False}
    # shortcut: rebuilt on every read (~1,100 stored details); cache in the state doc if the tab gets slow
    docs = (await db.execute(select(OrderBoardDoc).where(OrderBoardDoc.kind.in_(("estimate", "item"))))).scalars().all()
    settings = await load_settings(db)
    items = {d.zoho_id: d.header for d in docs if d.kind == "item"}
    held = held_by_orders(current.get("rows") or [])
    core = {brand.casefold() for brand in settings.core_brands}
    today = date.today()
    try:
        base = await zoho_service.books_app_url(db, "")
    except ZohoNotConfiguredError:
        base = None
    aito = await _aito_quote_ids(db)  # imported onto a card since the last pass: the Kanban owns it now
    rows = (
        quote_row(d.header, d.detail, items, held, today, core)
        for d in docs
        if d.kind == "estimate" and d.zoho_id not in aito
    )
    return {
        "rows": [{**r, "zoho_url": f"{base}{r['id']}" if base else None} for r in rows if r is not None],
        "loading": loading,
        "ready": True,
    }
