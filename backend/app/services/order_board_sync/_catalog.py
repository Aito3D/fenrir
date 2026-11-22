"""A local copy of the Books goods catalogue, so the "add an item" search answers without a Zoho call.

The pass sweeps ``/items`` in full when the copy is older than ``CATALOG_TTL_SECONDS`` and swaps the ``catalog``
rows. Stock (on hand, and available = on hand minus what confirmed orders committed) on the copy is as old as the sweep, except for the items on open orders, whose stock the pass re-reads
every time (the ``item`` rows): those win. Prices on the copy are only shown; creating an order re-reads Books.
"""

import logging
from datetime import datetime, timezone

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services.order_board_sync._common import (
    CALL_CEILING,
    _find_state,
    _now,
    _state,
    open_rate_limit_window,
    zoho_busy,
)
from backend.app.services.zoho import ZohoRateLimited, ZohoUpstreamError, zoho_service
from backend.app.utils.text import fold_text

logger = logging.getLogger(__name__)

CATALOG_TTL_SECONDS = 30 * 60
_CATALOG_RETRY_SECONDS = 5 * 60  # a failed or cut-short sweep waits this long (5 pass intervals) before starting over
_STAGE = "catalog_stage"  # pages of a sweep in progress, beside the live "catalog" rows
CATALOG_PAGE_CAP = 100  # 20,000 items; a runaway has_more stops here
# The codes a product can be searched by: SKU (UGS in French Books), barcodes, part number, the shop's own reference.
CODES = ("sku", "upc", "ean", "isbn", "part_number", "cf_r_f_rence")
_FIELDS = (
    "item_id",
    "name",
    "sku",
    "upc",
    "ean",
    "isbn",
    "part_number",
    "cf_r_f_rence",
    "rate",
    "stock_on_hand",
    "available_for_sale",
    "product_type",
    "cf_nature_du_produit",
)

# (catalog_loaded_at, prepared rows): rebuilt only after a sweep, not on every search.
_cache: tuple[str, list[tuple[dict, str, list[str]]]] | None = None


def _stale(loaded_at: str | None) -> bool:
    if not loaded_at:
        return True
    return (datetime.now(timezone.utc) - datetime.fromisoformat(loaded_at)).total_seconds() >= CATALOG_TTL_SECONDS


async def _note_sweep_failed(db: AsyncSession) -> None:
    state = await _state(db)
    state.detail = {**(state.detail or {}), "catalog_failed_at": _now()}
    await db.commit()


def _age_seconds(stamp: str) -> float:
    return (datetime.now(timezone.utc) - datetime.fromisoformat(stamp)).total_seconds()


async def _discard_stage(db: AsyncSession) -> None:
    await db.execute(delete(OrderBoardDoc).where(OrderBoardDoc.kind == _STAGE))


async def _stage_page(db: AsyncSession, rows: list[dict]) -> None:
    """Keep the active goods of one page beside the live copy, which stays in place until the sweep completes."""
    goods = {
        str(it["item_id"]): {k: it.get(k) for k in _FIELDS}
        for it in rows
        if it.get("item_id")
        and (it.get("status") or "active") == "active"
        and not (it.get("product_type") or "").endswith("service")
    }
    have = set((await db.execute(select(OrderBoardDoc.zoho_id).where(OrderBoardDoc.kind == _STAGE))).scalars())
    db.add_all(OrderBoardDoc(kind=_STAGE, zoho_id=i, header=h) for i, h in goods.items() if i not in have)


async def refresh_catalog_if_stale(db: AsyncSession) -> None:
    """Sweep Books' items when the copy is stale and the call budget allows, re-checking the budget before each page.
    The pages are staged as they arrive (``catalog_sweep`` in the board state holds the next page and the start time)
    and replace the live copy in one go when the last one is in. A tripped budget stops the sweep and the next pass
    resumes it, no back-off; a failure keeps the staged pages too but waits ``_CATALOG_RETRY_SECONDS``. Progress older
    than ``CATALOG_TTL_SECONDS`` is dropped, so a sweep never mixes very old pages with new ones. Never fails the
    pass: the search falls back to asking Books."""
    state = await _state(db)
    detail = state.detail or {}
    if not _stale(detail.get("catalog_loaded_at")) or zoho_busy(CALL_CEILING):
        return
    failed_at = detail.get("catalog_failed_at")
    if failed_at and _age_seconds(failed_at) < _CATALOG_RETRY_SECONDS:
        return
    sweep = detail.get("catalog_sweep")
    if not sweep or _age_seconds(sweep["started_at"]) >= CATALOG_TTL_SECONDS:
        await _discard_stage(db)
        sweep = {"started_at": _now(), "next_page": 1}
    first = page = sweep["next_page"]
    try:
        while page <= CATALOG_PAGE_CAP:
            if page > first and zoho_busy(CALL_CEILING):
                logger.warning("Order board: catalogue sweep paused at page %d, call budget spent", page)
                break
            rows, more = await zoho_service.list_items_page_all(db, page)
            page += 1
            await _stage_page(db, rows)
            state = await _state(db)
            state.detail = {**(state.detail or {}), "catalog_sweep": {**sweep, "next_page": page}}
            await db.commit()
            if not more:
                page = CATALOG_PAGE_CAP + 1
    except ZohoRateLimited as e:
        open_rate_limit_window(e)
        logger.warning("Order board: catalogue sweep rate limited, keeping the old copy")
        await _note_sweep_failed(db)
        return
    except ZohoUpstreamError as e:
        logger.warning("Order board: catalogue sweep failed (%s), keeping the old copy", e)
        await _note_sweep_failed(db)
        return
    if page <= CATALOG_PAGE_CAP:
        return  # paused: the next pass resumes at ``page``
    staged = (await db.execute(select(OrderBoardDoc.id).where(OrderBoardDoc.kind == _STAGE).limit(1))).first()
    state = await _state(db)
    rest = {k: v for k, v in (state.detail or {}).items() if k not in ("catalog_sweep", "catalog_failed_at")}
    if not staged:  # an empty listing is a Books hiccup, not an empty shop
        state.detail = rest
        await db.commit()
        return
    await db.execute(delete(OrderBoardDoc).where(OrderBoardDoc.kind == "catalog"))
    await db.execute(update(OrderBoardDoc).where(OrderBoardDoc.kind == _STAGE).values(kind="catalog"))
    state.detail = {**rest, "catalog_loaded_at": _now()}
    await db.commit()


def _near(token: str, word: str) -> bool:
    """``token`` is one edit (typo, missing or extra letter) from the start of ``word``. Only for 4+ letters."""
    # The first or second letter must agree: cheap, and it skips the distance for nearly every word.
    if len(token) < 4 or (word[:1] != token[:1] and word[1:2] != token[1:2]):
        return False
    for size in (len(token) - 1, len(token), len(token) + 1):
        head = word[:size]
        if len(head) < size:
            continue
        prev = list(range(len(head) + 1))
        for i, a in enumerate(token, 1):
            cur = [i]
            for j, b in enumerate(head, 1):
                cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a != b)))
            prev = cur
        if prev[-1] <= 1:
            return True
    return False


async def _prepared(db: AsyncSession, loaded_at: str) -> list[tuple[dict, str, list[str]]]:
    global _cache
    if _cache is None or _cache[0] != loaded_at:
        rows = (await db.execute(select(OrderBoardDoc.header).where(OrderBoardDoc.kind == "catalog"))).scalars()
        prepared = []
        for h in rows:
            hay = fold_text(" ".join(str(h.get(k) or "") for k in ("name", *CODES)))
            prepared.append((h, hay, hay.replace("-", " ").split()))
        _cache = (loaded_at, prepared)
    return _cache[1]


async def search_catalog(db: AsyncSession, query: str, limit: int) -> list[dict] | None:
    """Catalogue items holding every word of ``query`` (any order, accents and case aside, one typo allowed per word
    of 4+ letters), best first: an exact SKU or barcode, then fewest typos, then available to sell, then words that start a
    word of the name, then the shorter name. None when there is no local copy yet."""
    state = await _find_state(db)
    loaded_at = ((state.detail if state else None) or {}).get("catalog_loaded_at")
    if not loaded_at:
        return None
    tokens = fold_text(query).split()
    code = fold_text(query)
    live_stock = {
        d.zoho_id: d.header
        for d in (await db.execute(select(OrderBoardDoc).where(OrderBoardDoc.kind == "item"))).scalars()
    }
    prepared = await _prepared(db, loaded_at)
    scored = []
    # Typos are only looked for when the exact words fill fewer than ``limit`` slots.
    for fuzzy in (False, True):
        for h, hay, words in prepared:
            typos = starts = 0
            for t in tokens:
                if t in hay:
                    starts += any(w.startswith(t) for w in words)
                elif fuzzy and any(_near(t, w) for w in words):
                    typos += 1
                else:
                    break
            else:
                if fuzzy and not typos:
                    continue  # already scored by the exact pass
                live = live_stock.get(h["item_id"], {})
                item = {**h, **{k: live[k] for k in ("stock_on_hand", "available_for_sale") if k in live}}
                exact = code in {fold_text(h.get(k)) for k in CODES if h.get(k)}
                in_stock = (item.get("available_for_sale", item.get("stock_on_hand")) or 0) > 0
                scored.append(((not exact, typos, not in_stock, -starts, len(h.get("name") or "")), item))
        if len(scored) >= limit:
            break
    scored.sort(key=lambda s: s[0])
    return [item for _, item in scored[:limit]]
