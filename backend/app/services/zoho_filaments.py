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

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services.zoho import ZohoNotConfiguredError, zoho_service

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


class ZohoFilamentRefreshBusyError(RuntimeError):
    """Raised by ``fetch_catalogue`` when another refresh already holds
    ``_refresh_lock`` and there is no stale cache to answer from instead
    (T-094's bounded lock-acquire timeout).

    A ``RuntimeError`` subclass — not an unrelated type — so any caller that
    still does a broad ``except RuntimeError`` keeps catching this. But
    ``_fetch_catalogue_or_502`` (T-036) matches it with ``isinstance`` rather
    than comparing ``str(exc)`` against a second, hand-duplicated copy of
    ``_SYNC_IN_PROGRESS_DETAIL``: a reword of the message here can no longer
    silently detach the 409 contract from the text actually raised.
    """


FILAMENT_CATEGORY = "Filaments"
_PAGE_SIZE = 200
_MAX_PAGES = 20  # 256 items today; a runaway-loop backstop, not a real limit
_CACHE_TTL = timedelta(minutes=10)

# T-010: an "ambiguous" ProfileMatch reports at most this many colliding item
# names. Without a cap, a hand-typed profile whose colour never appears in
# Zoho reports every same-brand-and-material item in the catalogue — up to
# _MAX_PAGES x _PAGE_SIZE of them — as one unwrapped wall of names. The true
# collision size still travels in ProfileMatch.candidates_total so nothing is
# silently hidden, just not all rendered.
_MAX_REPORTED_CANDIDATES = 5

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

# T-094/T-091/T-035: how long a recent failure is remembered so a burst (or a
# steady trickle) of callers arriving during a Zoho outage gets the fast
# answer each instead of every one of them repeating the full paged walk in
# turn behind _refresh_lock. This applies whether or not a catalogue exists
# to fall back to: cold, the memoized failure is re-raised (see the pre-lock
# check below); warm, the cached copy is served straight back without ever
# taking the lock. Deliberately longer than _LOCK_ACQUIRE_TIMEOUT so a caller
# that just timed out waiting for the lock and retries lands on this fast
# path rather than starting its own walk, but far shorter than _CACHE_TTL so
# a real recovery is only masked for seconds, not minutes.
_FAIL_COOLDOWN = timedelta(seconds=30)

_cache: list["FilamentProduct"] | None = None
_cache_at: datetime | None = None

# T-034: the ``_cache_at`` of whatever catalogue the MOST RECENT
# fetch_catalogue() call returned, but only when that call reached one of the
# two "refresh failed/timed out, serve the stale copy anyway" branches below
# rather than a genuine fresh fetch or an unexpired cache hit. None means the
# most recent call did NOT take a stale-serve branch. fetch_catalogue's own
# signature and return type are frozen (backend/app/api/routes/calculator.py
# also calls it and is out of scope for T-034), so this module global is the
# side channel `_fetch_catalogue_or_502` reads immediately after `await
# fetch_catalogue(...)` returns -- with no `await` in between, so nothing
# else can run and overwrite it first -- to learn whether the profile-sync
# route just wrote prices from an arbitrarily old catalogue. Set/cleared at
# every return point inside fetch_catalogue below.
_last_stale_serve_at: datetime | None = None

# T-094/T-035: set alongside EVERY refresh failure, cold or warm (see the
# except branch in fetch_catalogue) so the next caller can answer from this
# instead of re-walking Zoho. Cleared on a successful refresh and by
# reset_cache().
_fail_at: datetime | None = None
_fail_exc: BaseException | None = None


def _clone_exc(exc: BaseException) -> BaseException:
    """Build a fresh, traceback/cause/context-free instance of ``exc``'s
    exact class and message/attributes, WITHOUT calling its ``__init__``.

    T-037: used both to memoize ``_fail_exc`` (so the stored instance never
    accumulates a traceback of its own, which would pin the failed walk's
    frames -- DB session, httpx objects -- in memory for the whole
    _FAIL_COOLDOWN) and to hand each fast-fail caller its OWN object rather
    than the shared stored one (so concurrent callers within the same
    cooldown window each unwind a private exception instead of racing to
    mutate one shared object's ``__traceback__``).

    Deliberately does NOT go through ``copy.copy()``: that relies on
    ``BaseException.__reduce_ex__``, which reconstructs by calling
    ``type(exc)(*exc.args)`` -- and a subclass whose ``__init__`` folds
    multiple constructor arguments into one combined message (exactly what
    ``exc.args`` then holds) breaks that call with a ``TypeError``, the same
    fragility this fix is meant to avoid. Calling ``cls.__new__(cls,
    *exc.args)`` directly sidesteps ``__init__`` entirely -- every
    ``BaseException`` subclass's ``__new__`` accepts ``*args`` and only
    stores them, regardless of what ``__init__`` later expects -- so the
    class, message and any extra attributes on ``exc.__dict__`` (e.g.
    DBAPIError's ``orig``) survive undisturbed.
    """
    cls = type(exc)
    clone = cls.__new__(cls, *exc.args)
    clone.__dict__.update(exc.__dict__)
    clone.__traceback__ = None
    clone.__cause__ = None
    clone.__context__ = None
    return clone


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


@dataclass(frozen=True)
class ProfileMatch:
    """The result of matching one filament profile against the catalogue.

    ``outcome`` is one of:

    ``matched``    exactly one candidate, and it has a price — safe to write
    ``no_match``   nothing in the catalogue shares its brand and material
    ``ambiguous``  two or more candidates survived; picking one would be a guess
    ``no_price``   one candidate, but its dealer price is 0

    ``no_price`` is separate from ``no_match`` because it is a different problem
    with a different fix: the item exists upstream and simply has no price.
    Roughly a fifth of the catalogue is in that state and writing any of them
    would silently zero out a profile's cost.

    ``candidates_total`` is the TRUE number of catalogue items behind
    ``candidates``. For ``ambiguous`` that can exceed ``len(candidates)``:
    the name list is capped at ``_MAX_REPORTED_CANDIDATES`` so a large
    collision does not turn into an unbounded wall of text, while this field
    still carries the real count for a "+N more" style report. For every
    other outcome the list is never capped, so this simply equals
    ``len(candidates)`` (0 for ``no_match``, 1 for ``matched``/``no_price``).
    """

    outcome: str
    product: FilamentProduct | None
    candidates: list[str]
    candidates_total: int


def _normalise(value: str) -> str:
    """Lowercase and drop every non-alphanumeric character.

    "Poly-maker" and "polymaker", "PET-G" and "PETG", "Bambu Lab" and
    "BambuLab" must compare equal: the profile's fields are typed by hand while
    the Zoho name is parsed out of a vendor string, so they agree on the word
    and disagree on the separators.

    Separators are REMOVED, not replaced with a space — replacing them leaves
    "poly maker", which still does not equal "polymaker". Nothing needs
    collapsing afterwards because no whitespace survives.
    """
    return re.sub(r"[^a-z0-9]+", "", (value or "").lower())


@dataclass(frozen=True)
class CatalogueIndex:
    """A catalogue pre-grouped by its own (normalised brand, normalised
    material) pairs.

    Built once per catalogue by :func:`build_match_index` so a caller matching
    many profiles against the same catalogue (the zoho-sync route) does the
    O(catalogue) normalisation work exactly once instead of once per profile
    (T-011) — :func:`match_profile_indexed` then does only O(1) dict work plus
    the small per-candidate colour narrowing ``match_profile`` always did.

    Each bucket preserves the catalogue's own item order, since a matched
    "ambiguous" outcome's ``candidates`` ordering is part of the contract
    :func:`match_profile` has always honoured.
    """

    by_brand_material: dict[tuple[str, str], list[FilamentProduct]]


def build_match_index(catalogue: list[FilamentProduct]) -> CatalogueIndex:
    """Group ``catalogue`` by (normalised brand, normalised material) once.

    Pass the result to :func:`match_profile_indexed` for every profile in a
    batch instead of calling :func:`match_profile` (which rebuilds this same
    grouping on every call) — see T-011.
    """
    by_brand_material: dict[tuple[str, str], list[FilamentProduct]] = {}
    for item in catalogue:
        key = (_normalise(item.brand), _normalise(item.material))
        by_brand_material.setdefault(key, []).append(item)
    return CatalogueIndex(by_brand_material)


def _match_candidates(candidates: list[FilamentProduct], colour: str) -> ProfileMatch:
    """The colour-narrowing half of matching, shared by ``candidates``
    however they were gathered (a fresh scan or a prebuilt index bucket).

    Brand AND material must both agree — brand alone matches every filament
    that vendor sells. Colour only narrows a collision. A SOLE candidate is
    only accepted when the profile's own colour agrees with it (or the
    profile carries no colour at all): dealer price DOES vary by colour
    within a brand and material (e.g. Bambu ABS-GF is 1866 in Blue and 3208
    in Black — see the calculator's own docstring), so a colour-blind sole
    match could silently write the wrong price. A colour-mismatched sole
    candidate is reported as "ambiguous" rather than accepted — same as any
    other case where colour cannot pick a single safe answer.

    Deliberately not built on ``_score``: that is a relevance ranker for the
    search box and always yields a best row, so it can order candidates but can
    never answer "is this a match at all".
    """
    if not candidates:
        return ProfileMatch("no_match", None, [], 0)

    if len(candidates) > 1:
        want_colour = _normalise(colour)
        narrowed = [item for item in candidates if _normalise(item.colour) == want_colour] if want_colour else []
        if len(narrowed) != 1:
            # Either the colour matched nothing (report the whole collision) or
            # it matched several (report those). Both are the operator's call.
            collision = narrowed or candidates
            names = [item.name for item in collision]
            return ProfileMatch("ambiguous", None, names[:_MAX_REPORTED_CANDIDATES], len(names))
        candidates = narrowed

    product = candidates[0]
    want_colour = _normalise(colour)
    if want_colour and _normalise(product.colour) != want_colour:
        # T-025: a lone candidate whose colour disagrees with the profile's
        # must not be auto-priced — price per kg DOES vary by colour within a
        # brand and material. Reported as "ambiguous" (not a new reason): the
        # UI already renders candidates for it, and there genuinely is no
        # single safe answer for this profile in the catalogue.
        return ProfileMatch("ambiguous", None, [product.name], 1)
    if not product.has_price:
        return ProfileMatch("no_price", product, [product.name], 1)
    return ProfileMatch("matched", product, [product.name], 1)


def match_profile_indexed(
    index: CatalogueIndex,
    brand: str,
    material: str,
    colour: str,
) -> ProfileMatch:
    """Like :func:`match_profile`, but against a prebuilt :func:`build_match_index`.

    Use this (with one shared index) when matching many profiles against the
    same catalogue — see T-011. Behaviour is byte-identical to calling
    ``match_profile(catalogue, brand, material, colour)`` with the catalogue
    the index was built from.
    """
    want_brand = _normalise(brand)
    want_material = _normalise(material)
    if not want_brand or not want_material:
        return ProfileMatch("no_match", None, [], 0)

    candidates = index.by_brand_material.get((want_brand, want_material), [])
    return _match_candidates(candidates, colour)


def match_profile(
    catalogue: list[FilamentProduct],
    brand: str,
    material: str,
    colour: str,
) -> ProfileMatch:
    """Find the one catalogue item that prices this profile, or say why not.

    Matching a single profile against a catalogue that will only be used
    once. A caller matching MANY profiles against the same catalogue (e.g. a
    sync loop) should build one :class:`CatalogueIndex` with
    :func:`build_match_index` and call :func:`match_profile_indexed` per
    profile instead — this function rebuilds that same index on every call,
    which is fine for one-off lookups but O(catalogue) work each time (T-011).
    """
    return match_profile_indexed(build_match_index(catalogue), brand, material, colour)


def reset_cache() -> None:
    """Drop the cached catalogue.

    Called by the settings save path whenever a Zoho credential or endpoint
    changes (``backend/app/api/routes/settings.py``), so rotating an
    organization does not keep serving the previous org's filaments for the
    rest of the TTL window. Tests call it to isolate each case.
    """
    global _cache, _cache_at, _generation, _fail_at, _fail_exc, _last_stale_serve_at
    _cache = None
    _cache_at = None
    _generation += 1
    # T-034: a stale-serve memo from before the reset must not be attributed
    # to whatever the next fetch_catalogue() call does.
    _last_stale_serve_at = None
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
    can legitimately run for minutes. A failure is also remembered for
    _FAIL_COOLDOWN, cold or warm, so a burst — or a steady trickle — of
    callers arriving during a Zoho outage is answered fast instead of each
    repeating the whole paged walk in turn: cold, the memoized failure is
    re-raised; warm, the cached copy is served back without ever taking the
    lock (T-035). A warm short-circuit still counts as a stale serve for
    T-034's purposes.

    T-095: if ``reset_cache()`` runs while this walk is in flight (e.g. a
    Zoho credential rotation mid-fetch), the walk RAISES once it finishes
    rather than handing its now-superseded catalogue back to the caller that
    started it — that caller gets the same stale-cache-or-502 answer as any
    other refresh failure instead of a freshly-labelled answer from the
    pre-rotation organisation.

    T-034: this signature and return type are relied on by
    ``backend/app/api/routes/calculator.py`` and must not change. Whether a
    given call served the previous cache because a refresh FAILED (as opposed
    to it merely being unexpired) is recorded in the module-private
    ``_last_stale_serve_at`` instead, for ``_fetch_catalogue_or_502`` to read.
    """
    global _cache, _cache_at, _fail_at, _fail_exc, _last_stale_serve_at

    now = datetime.now(timezone.utc)
    fresh = _cache_at is not None and now - _cache_at < _CACHE_TTL
    if _cache is not None and (fresh or not refresh):
        _last_stale_serve_at = None  # T-034: genuine cache hit, not a failure fallback
        return _cache

    # T-094/T-091: a cold cache with a recent failure is served immediately —
    # re-raising the memoized failure — rather than taking the lock and
    # repeating a walk that is very likely to fail again the same way.
    # T-107/T-037: this raises `_clone_exc(_fail_exc)`, not a same-class
    # reconstruction from `str(_fail_exc)`, because `_fail_exc` is whatever
    # `except Exception` caught around the whole walk, and that walk reaches
    # SQLAlchemy/httpx — e.g. a DBAPIError subclass whose __init__ takes
    # (statement, params, orig), not a single string. Rebuilding from one
    # string argument crashes with a TypeError for those; `_clone_exc`
    # preserves the class, message and any other attributes regardless of
    # constructor shape without ever calling `__init__` (see its docstring).
    # It is ALSO not a re-raise of the stored instance itself
    # (`_fail_exc.with_traceback(None)`, the previous approach): during a
    # cold-cache outage several concurrent requests take this branch inside
    # the same _FAIL_COOLDOWN window, and mutating one shared object's
    # __traceback__ from each of them raced — a traceback logged for one
    # request could carry another request's frames, or none at all. Cloning
    # first gives every caller its own exception object to unwind, so its
    # __traceback__ is exclusively that call's. `_fail_exc` itself already
    # has no traceback/cause/context to inherit (cleared at the memo-write
    # site below), so the clone starts clean and is framed entirely by this
    # call, not the long-finished walk that first observed the failure.
    if _cache is None and _fail_at is not None and now - _fail_at < _FAIL_COOLDOWN:
        raise _clone_exc(_fail_exc) from None

    # T-035: the warm-cache twin of the fast-fail above. Once a refresh has
    # already failed once, a warm cache within _FAIL_COOLDOWN is served
    # straight back — WITHOUT taking _refresh_lock or walking a single page —
    # instead of repeating a walk that just failed and is very likely to fail
    # again the same way. Before this fix, only the cold branch above
    # remembered a failure, so every sync during a Zoho outage that ever had
    # a catalogue cached re-walked up to _MAX_PAGES pages (worst case ~400s)
    # before serving the same stale list back. Still counts as a stale serve
    # for T-034: the catalogue handed back here is exactly as old as it was
    # the moment the failure was first observed.
    if _cache is not None and _fail_at is not None and now - _fail_at < _FAIL_COOLDOWN:
        logger.warning("Zoho filament catalogue refresh failed recently; serving the cached copy without retrying yet")
        _last_stale_serve_at = _cache_at
        return _cache

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
            # T-034: the lock-busy fallback answers with whatever `_cache_at`
            # already was -- unbounded age, since the walk that would have
            # advanced it never got to.
            _last_stale_serve_at = _cache_at
            return _cache
        raise ZohoFilamentRefreshBusyError(
            "Zoho filament catalogue refresh is still in progress; try again shortly"
        ) from None

    try:
        # Re-check inside the lock: another coroutine may have already done
        # the refresh this call was about to do while it waited its turn —
        # collapsing what would otherwise be one Zoho walk per waiter into
        # one for the whole herd.
        now = datetime.now(timezone.utc)
        fresh = _cache_at is not None and now - _cache_at < _CACHE_TTL
        if _cache is not None and (fresh or not refresh):
            _last_stale_serve_at = None  # T-034: genuine cache hit, not a failure fallback
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
            # T-094/T-091/T-035: record the failure regardless of whether a
            # cache exists to fall back to, so a repeat within
            # _FAIL_COOLDOWN short-circuits instead of repeating this whole
            # walk — cold, via the pre-lock re-raise above; warm, via the
            # pre-lock short-circuit above. Stamped with NOW (when the
            # failure was observed), not the `now` captured before the walk
            # began — the walk itself can run for minutes (bounded by
            # _MAX_PAGES x retries x the httpx timeout), so re-using the
            # pre-walk timestamp could write a memo that is already past
            # _FAIL_COOLDOWN the moment it lands.
            _fail_at = datetime.now(timezone.utc)
            # T-037: memoize a CLONE of `exc` (see `_clone_exc`) with its
            # traceback/cause/context stripped, not `exc` itself. The bare
            # `raise` a few lines below (the real, first-observed failure
            # propagating to whatever logs it) still uses `exc` with its
            # traceback intact — this only affects what gets stashed for
            # later fast-fail reads. Storing the live `exc` would keep the
            # whole walk's frames (DB session, httpx objects it closed over)
            # reachable for the entire _FAIL_COOLDOWN window purely because a
            # traceback pins them; clearing it here, at the moment the memo
            # is written, is what actually releases them.
            _fail_exc = _clone_exc(exc)
            if _cache is not None:
                logger.warning("Zoho filament catalogue refresh failed; serving the cached copy", exc_info=True)
                # T-034: this refresh failed with no upper bound on how long
                # ago `_cache_at` was -- it is left un-advanced on purpose.
                _last_stale_serve_at = _cache_at
                return _cache
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
        _last_stale_serve_at = None  # T-034: a genuine fresh refresh just landed
        return mapped
    finally:
        lock.release()


# T-009/T-036: the exact message fetch_catalogue's lock-acquire timeout
# raises when another refresh is already in flight and there is no cache to
# fall back to (see the asyncio.TimeoutError branch above, and
# ZohoFilamentRefreshBusyError). This constant is the HTTP detail text for
# the 409 response below — the classifier no longer compares against it by
# string equality (that matched on ``str(exc)``, so a reword here would have
# silently degraded the 409 to a 502); it now checks the exception's type via
# ``isinstance``, and this constant only supplies the response body.
_SYNC_IN_PROGRESS_DETAIL = "Zoho filament catalogue refresh is still in progress; try again shortly"


async def _fetch_catalogue_or_502(db: AsyncSession, *, context: str) -> tuple[list[FilamentProduct], datetime | None]:
    """``fetch_catalogue`` wrapped in the is-configured check and error
    contract every HTTP caller needs: 503 when Zoho isn't configured (either
    up front, or discovered mid-refresh if credentials were cleared in the
    check-then-act window between the check above and the token refresh),
    409 when another refresh is already in flight with no cache to answer
    from, 500 when the catalogue fetched but failed to map, 502 for anything
    else.

    ``context`` is folded into the log message (e.g. ``"during profile
    sync"``) so a caller's logs can be told apart without duplicating this
    block per route. Private (leading underscore): every current caller lives
    in this codebase, so there is no reason to widen it into the module's
    public surface.

    T-034: returns ``(catalogue, stale_since)``. ``fetch_catalogue`` itself
    must keep returning a bare list (its signature is frozen — see
    ``_last_stale_serve_at``'s docstring), so this wrapper reads that module
    global immediately after the call to learn whether THIS call happened to
    land on a failed-refresh stale-cache fallback rather than a genuine fetch.
    ``stale_since`` is ``None`` for a fresh catalogue, or the timestamp the
    served catalogue was last actually captured at otherwise.
    """
    if not await zoho_service.is_configured(db):
        raise HTTPException(status_code=503, detail="Zoho is not configured")
    try:
        catalogue = await fetch_catalogue(db)
        # No `await` between the call above and this read — see
        # `_last_stale_serve_at`'s module-level docstring for why that makes
        # this safe against interleaving from other concurrent callers.
        return catalogue, _last_stale_serve_at
    except ZohoFilamentMappingError as exc:
        logger.error("Zoho filament catalogue mapping failure %s: %s", context, exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Zoho filament catalogue could not be mapped") from exc
    except ZohoNotConfiguredError as exc:
        # Credentials were cleared between the is_configured() check above
        # and the token refresh inside fetch_catalogue — a genuine
        # check-then-act race, not an unreachable Zoho.
        logger.warning("Zoho credentials were cleared %s: %s", context, exc)
        raise HTTPException(status_code=503, detail="Zoho is not configured") from exc
    except ZohoFilamentRefreshBusyError as exc:
        # Caught by type, not by comparing str(exc) against _SYNC_IN_PROGRESS_
        # DETAIL (T-036) — that constant now only supplies the 409 body text.
        logger.warning("Zoho filament catalogue refresh already in progress %s", context)
        raise HTTPException(status_code=409, detail=_SYNC_IN_PROGRESS_DETAIL) from exc
    except RuntimeError as exc:
        logger.warning("Zoho filament catalogue unavailable %s: %s", context, exc, exc_info=True)
        raise HTTPException(status_code=502, detail="Could not reach Zoho") from exc
    except Exception as exc:
        logger.warning("Zoho filament catalogue unavailable %s: %s", context, exc, exc_info=True)
        raise HTTPException(status_code=502, detail="Could not reach Zoho") from exc


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
