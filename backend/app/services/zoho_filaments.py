"""Zoho filament catalogue: the Books items whose ``cf_nature_du_produit`` is
"Filaments", mapped into a shape the pricing calculator can link to.

Zoho stores the dealer price per SPOOL, and a spool is not always 1 kg — the
weight lives only inside the item name because Zoho's own ``weight`` field is
empty for every filament. Everything in this module exists to turn that name
string into a trustworthy cost per kg.
"""

import asyncio
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services.zoho import zoho_service

logger = logging.getLogger(__name__)

# Matches "1kg", "0.9 kg", "0,75kg". Deliberately requires the "kg" unit so the
# "1.75mm" diameter segment can never be read as a weight.
_WEIGHT_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*kg\b", re.IGNORECASE)

_SEGMENT_SEPARATOR = " - "


class ZohoFilamentMappingError(RuntimeError):
    """Every active item in a non-empty batch failed to map into a
    :class:`FilamentProduct`.

    Distinct from the plain ``RuntimeError`` a truncated or unreachable fetch
    raises (T-073's "Could not reach Zoho" 502 contract): this one signals a
    mapping/programming bug in ``_map_item`` rather than an upstream problem,
    so callers such as ``backend/app/api/routes/calculator.py`` can surface it
    as a 500 instead of folding it into "Zoho is unreachable" (T-074).
    """


FILAMENT_CATEGORY = "Filaments"
_PAGE_SIZE = 200
_MAX_PAGES = 20  # 256 items today; a runaway-loop backstop, not a real limit
_CACHE_TTL = timedelta(minutes=10)

# T-094: how long a caller waits to acquire _refresh_lock before giving up on
# an in-flight walk and answering with the stale cache (or a 502) instead.
# The walk this lock guards is bounded only by _MAX_PAGES x a per-page retry
# through zoho.py::_send's `httpx.AsyncClient(timeout=10.0)` — worst case
# roughly 20 pages x 2 attempts x 10s = ~400s. That is far longer than the
# frontend's 60s per-chunk budget, so waiting it out here would just mean
# every waiter times out on the client side anyway, after first pinning a DB
# connection for the whole wait. 20s keeps a comfortable margin under that
# 60s budget (so the route can still answer before the client gives up) while
# staying roughly 2x a single (possibly 401-retried) page fetch, so a normal,
# healthy walk of a page or two is not punished by a waiter bailing early.
_LOCK_ACQUIRE_TIMEOUT = 20.0

# T-094/T-091: how long a cold-cache (no previous catalogue at all) failure
# is remembered so a burst of callers arriving during a Zoho outage gets a
# fast failure each instead of every one of them repeating the full paged
# walk in turn behind _refresh_lock. Deliberately longer than
# _LOCK_ACQUIRE_TIMEOUT so a caller that just timed out waiting for the lock
# and retries lands on this fast path rather than starting its own walk, but
# far shorter than _CACHE_TTL so a real recovery is only masked for seconds,
# not minutes.
_FAIL_COOLDOWN = timedelta(seconds=30)

_cache: list["FilamentProduct"] | None = None
_cache_at: datetime | None = None

# T-094: set alongside a cold-cache failure (see the except branch in
# fetch_catalogue) so the next caller can answer from this instead of
# re-walking Zoho. Cleared on a successful refresh and by reset_cache().
_fail_at: datetime | None = None
_fail_exc: BaseException | None = None

# T-072: bumped every time reset_cache() runs. A refresh started before a
# reset (e.g. one parked on a slow Zoho page fetch while the operator rotates
# credentials in Settings) captures the generation that was current when it
# began its walk of Zoho; if that no longer matches by the time the walk
# finishes, the reset happened in the meantime and the result must not be
# published, or the previous org's catalogue would resurface for a full
# _CACHE_TTL window under the new credentials.
_generation = 0

# T-072: collapses concurrent refreshes (e.g. two browser tabs both opening
# the add-filament search on a cold cache) into a single Zoho walk.
#
# T-095: deliberately NOT rebuilt by reset_cache() (it used to be, T-072).
# Rebinding this to a fresh, unheld Lock() on every reset let a walk that was
# already parked mid-fetch under the OLD generation, plus a brand new caller
# arriving right after the reset, both hold a lock at the same time — two
# concurrent Zoho walks instead of one. Reusing this single lock means a
# reset can never manufacture a second walk: any caller racing a superseded
# one queues behind it exactly as it would without a reset in the middle.
_refresh_lock = asyncio.Lock()


@dataclass(frozen=True)
class ParsedName:
    """The pieces of a Zoho filament item name.

    ``weight_inferred`` is True when the name carried no weight at all and the
    1 kg default was applied, so the UI can flag it for correction.
    """

    brand: str
    material: str
    colour: str
    spool_weight_kg: float
    weight_inferred: bool


def parse_filament_name(name: str) -> ParsedName:
    """Split a Zoho filament item name into brand / material / colour / weight.

    The name convention is ``Brand - Material - Colour - 1.75mm - Weight``.
    One production item repeats its ``- 1.75mm - 1kg`` suffix, so the LAST
    weight match is authoritative rather than the first.
    """
    segments = [segment.strip() for segment in (name or "").split(_SEGMENT_SEPARATOR)]
    brand = segments[0] if segments else ""
    material = segments[1] if len(segments) > 1 else ""
    colour = segments[2] if len(segments) > 2 else ""

    matches = _WEIGHT_RE.findall(name or "")
    if matches:
        weight = float(matches[-1].replace(",", "."))
        if weight > 0:
            return ParsedName(brand, material, colour, weight, False)

    return ParsedName(brand, material, colour, 1.0, True)


@dataclass(frozen=True)
class FilamentProduct:
    """A Zoho filament item, priced per kg.

    ``has_price`` is False for the items whose dealer price is 0 — roughly a
    fifth of the catalogue. Those must never be written into a calculator
    filament's cost, or they silently zero out its printing cost.
    """

    item_id: str
    name: str
    sku: str
    brand: str
    material: str
    colour: str
    spool_weight_kg: float
    weight_inferred: bool
    dealer_price: float
    cost_per_kg: float
    has_price: bool


def reset_cache() -> None:
    """Drop the cached catalogue.

    Called by the settings save path whenever a Zoho credential or endpoint
    changes (``backend/app/api/routes/settings.py``), so rotating an
    organization does not keep serving the previous org's filaments for the
    rest of the TTL window. Tests call it to isolate each case.
    """
    global _cache, _cache_at, _generation, _fail_at, _fail_exc
    _cache = None
    _cache_at = None
    _generation += 1
    # T-095: _refresh_lock is intentionally NOT rebuilt here — see its
    # module-level docstring for why rebinding it let a reset manufacture a
    # second concurrent walk.
    # T-094: a failure recorded under the OLD credentials must not keep
    # answering "Zoho is down" fast-path style once they have just been
    # rotated to (presumably working) new ones.
    _fail_at = None
    _fail_exc = None


def _map_item(item: dict) -> FilamentProduct:
    parsed = parse_filament_name(item.get("name") or "")
    # Zoho's own brand field is authoritative when set; the name's first
    # segment is the fallback for items that never had it filled in.
    brand = (item.get("brand") or parsed.brand or "").strip()
    dealer = float(item.get("cf_prix_dealer_usd_unformatted") or 0.0)
    weight = parsed.spool_weight_kg or 1.0
    cost = round(dealer / weight, 2) if dealer > 0 else 0.0
    return FilamentProduct(
        item_id=str(item.get("item_id") or ""),
        name=(item.get("name") or "").strip(),
        sku=(item.get("sku") or "").strip(),
        brand=brand,
        material=parsed.material,
        colour=parsed.colour,
        spool_weight_kg=weight,
        weight_inferred=parsed.weight_inferred,
        dealer_price=dealer,
        cost_per_kg=cost,
        has_price=dealer > 0,
    )


async def fetch_catalogue(db: AsyncSession, *, refresh: bool = True) -> list[FilamentProduct]:
    """Every active Zoho filament item, priced per kg.

    Cached for ``_CACHE_TTL`` so opening the add-filament form costs no Zoho
    call. A failed refresh returns the previous cache; a failed refresh with no
    cache at all RE-RAISES, because answering "there are no filaments" would be
    indistinguishable from a genuinely empty catalogue. A malformed individual
    item (e.g. a non-numeric dealer price) is logged and skipped rather than
    failing the whole refresh — one bad Zoho record must not blank the
    catalogue or fall back to the stale cache. But if EVERY active item in a
    non-empty batch fails to map, that is treated as a refresh failure too
    (same stale-cache-or-raise handling) rather than silently caching an
    empty list — a systemic mapping bug must not look identical to "Zoho
    genuinely has no active filaments". A paged fetch that hits _MAX_PAGES
    while Zoho still has more to give is treated the same way (T-073):
    caching a silently truncated catalogue for the TTL would make every
    filament past the cut-off look "missing" rather than merely unfetched.

    T-094: waiting for ``_refresh_lock`` is bounded by _LOCK_ACQUIRE_TIMEOUT —
    a caller that queues behind a slow in-flight walk gets the stale cache
    (or, cold, a raise) instead of parking indefinitely behind a walk that
    can legitimately run for minutes. A cold-cache failure is also remembered
    for _FAIL_COOLDOWN so a burst of callers arriving during a Zoho outage
    fails fast instead of each repeating the whole paged walk in turn.

    T-095: if ``reset_cache()`` runs while this walk is in flight (e.g. a
    Zoho credential rotation mid-fetch), the walk RAISES once it finishes
    rather than handing its now-superseded catalogue back to the caller that
    started it — that caller gets the same stale-cache-or-502 answer as any
    other refresh failure instead of a freshly-labelled answer from the
    pre-rotation organisation.
    """
    global _cache, _cache_at, _fail_at, _fail_exc

    now = datetime.now(timezone.utc)
    fresh = _cache_at is not None and now - _cache_at < _CACHE_TTL
    if _cache is not None and (fresh or not refresh):
        return _cache

    # T-094/T-091: a cold cache with a recent failure is served immediately —
    # re-raising a fresh instance of whatever that failure was — rather than
    # taking the lock and repeating a walk that is very likely to fail again
    # the same way. type(...)(str(...)) rebuilds the exception (rather than
    # reusing the stored instance) so the class — and therefore whether the
    # route answers 500 or 502 — is preserved without dragging along a stale
    # traceback from the original failure.
    if _cache is None and _fail_at is not None and now - _fail_at < _FAIL_COOLDOWN:
        raise type(_fail_exc)(str(_fail_exc)) from None

    # Captured once, up front, rather than re-reading the global at release
    # time. reset_cache() no longer rebinds _refresh_lock (T-095), so this is
    # not guarding against a rebind any more — but `_refresh_lock` is still a
    # module global that another coroutine could in principle reassign, and
    # `async with` avoided that class of problem by evaluating its
    # context-manager expression once at entry; this local keeps that same
    # guarantee now that acquire/release are explicit, at zero cost.
    lock = _refresh_lock
    try:
        await asyncio.wait_for(lock.acquire(), timeout=_LOCK_ACQUIRE_TIMEOUT)
    except asyncio.TimeoutError:
        # The lock is held by a walk that has already run past a generous
        # budget. Waiting it out would only mean this caller's own HTTP
        # request times out on the client side anyway (see the constant's
        # docstring above), after pinning a DB connection for the wait —
        # answer now instead, from the stale cache if there is one.
        if _cache is not None:
            logger.warning(
                "Zoho filament catalogue refresh lock busy past %.0fs; serving the cached copy", _LOCK_ACQUIRE_TIMEOUT
            )
            return _cache
        raise RuntimeError("Zoho filament catalogue refresh is still in progress; try again shortly") from None

    try:
        # Re-check inside the lock: another coroutine may have already done
        # the refresh this call was about to do while it waited its turn —
        # collapsing what would otherwise be one Zoho walk per waiter into
        # one for the whole herd.
        now = datetime.now(timezone.utc)
        fresh = _cache_at is not None and now - _cache_at < _CACHE_TTL
        if _cache is not None and (fresh or not refresh):
            return _cache

        # T-072: captured only now — after the lock is held and the
        # freshness re-check above — so a reset_cache() that landed while
        # this call was queued on the lock is already reflected here. This
        # call is racing the CURRENT generation, not a snapshot taken before
        # it ever queued.
        generation = _generation

        try:
            items: list[dict] = []
            page = 1
            while page <= _MAX_PAGES:
                batch, has_more = await zoho_service.list_items_page(
                    db, category=FILAMENT_CATEGORY, page=page, per_page=_PAGE_SIZE
                )
                items.extend(batch)
                if not has_more:
                    break
                page += 1
            else:
                # The while/else `else` only runs when the loop exits by
                # exhausting its condition rather than by `break` — i.e. the
                # page bound was hit and `has_more` was still True. Zoho had
                # more pages than _MAX_PAGES allows for; the partial list
                # gathered so far must not be cached as if it were complete
                # (T-073, user-approved: the search and price-sync routes
                # return 502 in this case rather than quietly truncating).
                logger.error(
                    "Zoho filament catalogue fetch exceeded %d pages (%d items fetched so far); "
                    "refusing to cache a truncated catalogue",
                    _MAX_PAGES,
                    len(items),
                )
                raise RuntimeError(f"Zoho filament catalogue exceeded {_MAX_PAGES} pages ({len(items)} items fetched)")

            active_items = [item for item in items if (item.get("status") or "active") == "active"]
            mapped: list[FilamentProduct] = []
            for item in active_items:
                try:
                    mapped.append(_map_item(item))
                except Exception as exc:
                    # One malformed record (e.g. a non-numeric dealer price) must
                    # not blank the entire catalogue — skip it and keep going. The
                    # item_id and exception are logged explicitly so a systematic
                    # mapping bug is visible instead of looking like routine bad
                    # upstream data.
                    logger.warning(
                        "Skipping malformed Zoho filament item %s: %s", item.get("item_id"), exc, exc_info=True
                    )

            if active_items and not mapped:
                # Legitimate empties (no items at all, or all filtered out as
                # inactive) fall through below with an empty `mapped` and no
                # active_items — this branch only fires when items WERE active
                # and NONE of them mapped, which is a mapping failure, not an
                # empty catalogue. Route it through the same stale-cache-or-raise
                # handling as a fetch failure.
                raise ZohoFilamentMappingError(
                    f"None of the {len(active_items)} active Zoho filament items could be mapped"
                )
        except Exception as exc:
            if _cache is not None:
                logger.warning("Zoho filament catalogue refresh failed; serving the cached copy", exc_info=True)
                return _cache
            # T-094/T-091: cold-cache failure — record it so a burst of
            # concurrent callers doesn't repeat this whole walk one at a time
            # behind the lock; see the pre-lock check above. Stamped with NOW
            # (when the failure was observed), not the `now` captured before
            # the walk began — the walk itself can run for minutes (bounded
            # by _MAX_PAGES x retries x the httpx timeout), so re-using the
            # pre-walk timestamp could write a memo that is already past
            # _FAIL_COOLDOWN the moment it lands.
            _fail_at = datetime.now(timezone.utc)
            _fail_exc = exc
            raise

        if generation != _generation:
            # reset_cache() fired while this refresh was in flight (e.g. a
            # Zoho credential rotation). This walk belongs to a superseded
            # generation: handing its catalogue back to THIS caller — even
            # without publishing it into the module cache — would still let
            # the pre-rotation organisation's prices reach a caller such as
            # sync_calculator_filaments_from_zoho, which writes whatever it
            # gets straight into calculator_filaments and stamps it freshly
            # synced (T-095, user-approved). Raise instead, mapped by the
            # route to the same 502 any other unreachable-Zoho failure gets,
            # so the caller answers from its own stale cache (if it has one)
            # rather than from a rotated-away organisation's catalogue. A
            # plain RuntimeError, not ZohoFilamentMappingError — this is not
            # a mapping bug, and that subclass is reserved for the 500
            # contract (T-074).
            raise RuntimeError("Zoho filament catalogue refresh was superseded by a credential change; retry")

        _cache = mapped
        # Same reasoning as _fail_at above: stamped with the time the
        # walk FINISHED, not the pre-walk `now`, so a slow successful
        # walk does not shorten its own _CACHE_TTL window.
        _cache_at = datetime.now(timezone.utc)
        _fail_at = None
        _fail_exc = None
        return mapped
    finally:
        lock.release()


def _score(product: FilamentProduct, terms: list[str]) -> int:
    """Higher is better. Material matches outrank brand, which outranks colour
    and SKU, so searching "PETG" leads with PETG rather than with a red spool
    of something else that happens to mention it."""
    total = 0
    material = product.material.lower()
    brand = product.brand.lower()
    for term in terms:
        if material.startswith(term):
            total += 4
        elif term in material:
            total += 3
        if brand.startswith(term):
            total += 2
        if term in product.colour.lower():
            total += 1
        if term in product.sku.lower():
            total += 1
    return total


def search_catalogue(catalogue: list[FilamentProduct], query: str, limit: int = 25) -> list[FilamentProduct]:
    """Local search over the cached catalogue.

    Zoho's own ``search_text`` also matches item descriptions and returns
    unrelated products (searching "PLA" surfaces a boat anchor), so matching is
    done here instead. Every whitespace-separated term must appear somewhere in
    the product; results are ranked by ``_score`` then by name for stability.
    """
    terms = [term for term in query.lower().split() if term]
    if not terms:
        return catalogue[:limit]

    matches = []
    for product in catalogue:
        haystack = f"{product.brand} {product.material} {product.colour} {product.sku} {product.name}".lower()
        if all(term in haystack for term in terms):
            matches.append(product)

    matches.sort(key=lambda p: (-_score(p, terms), p.name))
    return matches[:limit]
