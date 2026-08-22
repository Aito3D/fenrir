"""Tests for fetching, caching and searching the Zoho filament catalogue."""

import asyncio
import logging

import pytest

from backend.app.services import zoho_filaments
from backend.app.services.zoho import zoho_service


def _item(item_id, name, dealer, sku="SKU", brand="Bambu Lab", status="active"):
    return {
        "item_id": item_id,
        "name": name,
        "sku": sku,
        "brand": brand,
        "status": status,
        "cf_nature_du_produit": "Filaments",
        "cf_prix_dealer_usd_unformatted": dealer,
        "purchase_rate": 9999,  # must never be used as a fallback
    }


PAGE_1 = [
    _item("1", "Bambu Lab - ABS-GF - Bleu (Blue) - 1.75mm - 1kg", 1866.0, "B50-B0-1.75-1000-SPL"),
    _item("2", "Bambu Lab - ABS-GF - Blanc (White) - 1.75mm - 1kg", 0.0, "B50-W0-1.75-1000-SPL"),
    _item("3", "Bambu Lab - PA6-CF - Noir (Black) - 1.75mm - 0.5kg", 6000.0, "B60-K0"),
    _item("4", "SUNLU - PETG - Rouge (Red) - 1.75mm - 1kg", 1114.0, "S-PETG-R", brand="SUNLU"),
]
PAGE_2 = [
    _item("5", "eSUN - PLA Silk - Or (Gold) - 1.75mm - 1kg", 2000.0, "E-PLAS-G", brand="eSUN"),
    _item("6", "eSUN - PLA - Vert - 1.75mm - 1kg", 1500.0, "E-PLA-V", brand="eSUN", status="inactive"),
]


@pytest.fixture(autouse=True)
def _clear_cache():
    zoho_filaments.reset_cache()
    yield
    zoho_filaments.reset_cache()


def _fake_request(pages, calls):
    """Stands in for ZohoService.list_items_page."""

    async def list_items_page(db, *, category, page, per_page):
        calls.append({"category": category, "page": page, "per_page": per_page})
        assert category == "Filaments"
        items = pages[page - 1] if page <= len(pages) else []
        return items, page < len(pages)

    return list_items_page


@pytest.mark.asyncio
async def test_fetch_paginates_and_maps(monkeypatch):
    calls = []
    monkeypatch.setattr(zoho_service, "list_items_page", _fake_request([PAGE_1, PAGE_2], calls))

    catalogue = await zoho_filaments.fetch_catalogue(None)

    assert len(calls) == 2  # paged until has_more_page was False
    # the inactive eSUN PLA is dropped
    assert [p.item_id for p in catalogue] == ["1", "2", "3", "4", "5"]

    blue = catalogue[0]
    assert blue.brand == "Bambu Lab"
    assert blue.material == "ABS-GF"
    assert blue.colour == "Bleu (Blue)"
    assert blue.dealer_price == 1866.0
    assert blue.cost_per_kg == 1866.0  # 1 kg spool
    assert blue.has_price is True
    assert blue.sku == "B50-B0-1.75-1000-SPL"


@pytest.mark.asyncio
async def test_half_kilo_spool_doubles_the_cost_per_kg(monkeypatch):
    monkeypatch.setattr(zoho_service, "list_items_page", _fake_request([PAGE_1], []))
    catalogue = await zoho_filaments.fetch_catalogue(None)
    pa6 = next(p for p in catalogue if p.item_id == "3")
    assert pa6.spool_weight_kg == 0.5
    assert pa6.cost_per_kg == 12000.0


@pytest.mark.asyncio
async def test_zero_dealer_price_never_falls_back_to_purchase_rate(monkeypatch):
    monkeypatch.setattr(zoho_service, "list_items_page", _fake_request([PAGE_1], []))
    catalogue = await zoho_filaments.fetch_catalogue(None)
    white = next(p for p in catalogue if p.item_id == "2")
    assert white.dealer_price == 0.0
    assert white.cost_per_kg == 0.0
    assert white.has_price is False


@pytest.mark.asyncio
async def test_second_fetch_is_served_from_cache(monkeypatch):
    calls = []
    monkeypatch.setattr(zoho_service, "list_items_page", _fake_request([PAGE_1], calls))
    await zoho_filaments.fetch_catalogue(None)
    await zoho_filaments.fetch_catalogue(None)
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_failed_refresh_returns_stale_cache(monkeypatch):
    monkeypatch.setattr(zoho_service, "list_items_page", _fake_request([PAGE_1], []))
    await zoho_filaments.fetch_catalogue(None)
    zoho_filaments._cache_at = None  # force the next call to refresh

    async def boom(db, **kwargs):
        raise RuntimeError("zoho down")

    monkeypatch.setattr(zoho_service, "list_items_page", boom)
    catalogue = await zoho_filaments.fetch_catalogue(None)
    assert len(catalogue) == 4  # previous contents, not an empty list


@pytest.mark.asyncio
async def test_failed_refresh_with_cold_cache_raises(monkeypatch):
    async def boom(db, **kwargs):
        raise RuntimeError("zoho down")

    monkeypatch.setattr(zoho_service, "list_items_page", boom)
    with pytest.raises(RuntimeError):
        await zoho_filaments.fetch_catalogue(None)


@pytest.mark.asyncio
async def test_malformed_item_is_skipped_and_does_not_destroy_the_warm_cache(monkeypatch):
    """A single item with a non-numeric dealer price must not blow up the
    whole refresh — it used to propagate a ValueError straight out of
    fetch_catalogue, bypassing the stale-cache fallback entirely."""
    monkeypatch.setattr(zoho_service, "list_items_page", _fake_request([PAGE_1], []))
    await zoho_filaments.fetch_catalogue(None)
    zoho_filaments._cache_at = None  # force the next call to refresh

    good = _item("1", "Bambu Lab - ABS-GF - Bleu (Blue) - 1.75mm - 1kg", 1866.0, "B50-B0-1.75-1000-SPL")
    malformed = _item("99", "Bambu Lab - PLA - Rouge (Red) - 1.75mm - 1kg", "N/A", "BAD-SKU")

    async def flaky_page(db, **kwargs):
        return [good, malformed], False

    monkeypatch.setattr(zoho_service, "list_items_page", flaky_page)
    catalogue = await zoho_filaments.fetch_catalogue(None)

    # the refresh succeeds (no exception), the malformed record is dropped,
    # and the good record from the same batch still comes through
    assert [p.item_id for p in catalogue] == ["1"]


@pytest.mark.asyncio
async def test_entirely_malformed_batch_falls_back_to_the_warm_cache(monkeypatch):
    """If every active item in the refreshed batch fails to map, that is a
    mapping failure, not a legitimately empty catalogue — it must behave like
    any other refresh failure and serve the stale cache unchanged."""
    monkeypatch.setattr(zoho_service, "list_items_page", _fake_request([PAGE_1], []))
    await zoho_filaments.fetch_catalogue(None)
    zoho_filaments._cache_at = None  # force the next call to refresh

    all_malformed = [
        _item("97", "Bambu Lab - PLA - Rouge (Red) - 1.75mm - 1kg", "N/A", "BAD-1"),
        _item("98", "Bambu Lab - PLA - Vert - 1.75mm - 1kg", "oops", "BAD-2"),
    ]

    async def flaky_page(db, **kwargs):
        return all_malformed, False

    monkeypatch.setattr(zoho_service, "list_items_page", flaky_page)
    catalogue = await zoho_filaments.fetch_catalogue(None)

    # unchanged: still the 4 items from the original warm cache
    assert len(catalogue) == 4
    assert [p.item_id for p in catalogue] == ["1", "2", "3", "4"]


@pytest.mark.asyncio
async def test_entirely_malformed_batch_with_cold_cache_raises(monkeypatch):
    """The cold-cache case must not silently return an empty list either —
    an all-malformed batch is indistinguishable from a real Zoho failure."""
    all_malformed = [
        _item("97", "Bambu Lab - PLA - Rouge (Red) - 1.75mm - 1kg", "N/A", "BAD-1"),
    ]

    async def flaky_page(db, **kwargs):
        return all_malformed, False

    monkeypatch.setattr(zoho_service, "list_items_page", flaky_page)
    with pytest.raises(RuntimeError):
        await zoho_filaments.fetch_catalogue(None)


@pytest.mark.asyncio
async def test_all_items_inactive_is_a_legitimate_empty_catalogue(monkeypatch):
    """Distinguishes the mapping-failure case above from the legitimate case
    where Zoho really has no active filaments — this must return an empty
    list without raising, cold cache or not."""
    all_inactive = [
        _item("50", "Bambu Lab - PLA - Rouge (Red) - 1.75mm - 1kg", 1000.0, "X-1", status="inactive"),
        _item("51", "Bambu Lab - PLA - Vert - 1.75mm - 1kg", 1000.0, "X-2", status="confirmation_pending"),
    ]

    async def inactive_page(db, **kwargs):
        return all_inactive, False

    monkeypatch.setattr(zoho_service, "list_items_page", inactive_page)
    catalogue = await zoho_filaments.fetch_catalogue(None)
    assert catalogue == []


@pytest.mark.asyncio
async def test_search_matches_all_terms_across_fields(monkeypatch):
    monkeypatch.setattr(zoho_service, "list_items_page", _fake_request([PAGE_1, PAGE_2], []))
    catalogue = await zoho_filaments.fetch_catalogue(None)

    assert [p.item_id for p in zoho_filaments.search_catalogue(catalogue, "abs-gf")] == ["2", "1"]
    assert [p.item_id for p in zoho_filaments.search_catalogue(catalogue, "abs-gf bleu")] == ["1"]
    assert [p.item_id for p in zoho_filaments.search_catalogue(catalogue, "sunlu")] == ["4"]
    assert [p.item_id for p in zoho_filaments.search_catalogue(catalogue, "B50-B0")] == ["1"]
    assert zoho_filaments.search_catalogue(catalogue, "nothingmatches") == []


@pytest.mark.asyncio
async def test_empty_search_returns_the_head_of_the_catalogue(monkeypatch):
    monkeypatch.setattr(zoho_service, "list_items_page", _fake_request([PAGE_1], []))
    catalogue = await zoho_filaments.fetch_catalogue(None)
    assert len(zoho_filaments.search_catalogue(catalogue, "  ", limit=2)) == 2


# --- T-072: the refresh lock collapses concurrent fetches --------------------


@pytest.mark.asyncio
async def test_concurrent_fetches_collapse_into_a_single_zoho_walk(monkeypatch):
    """Two callers racing a cold cache must not each walk Zoho: the second one
    queues on the refresh lock while the first is mid-fetch and, once it
    wakes up holding the lock, re-checks freshness and returns the catalogue
    the first call just published instead of re-fetching from Zoho."""
    gate = asyncio.Event()
    entered = asyncio.Event()
    calls = []

    async def gated_page(db, **kwargs):
        calls.append(1)
        entered.set()
        await gate.wait()
        return PAGE_1, False

    monkeypatch.setattr(zoho_service, "list_items_page", gated_page)

    first = asyncio.create_task(zoho_filaments.fetch_catalogue(None))
    await entered.wait()  # first call is parked inside list_items_page, holding the lock

    second = asyncio.create_task(zoho_filaments.fetch_catalogue(None))
    await asyncio.sleep(0)  # let the second call queue on the lock

    gate.set()  # release the first call; it publishes and releases the lock
    first_result = await first
    second_result = await second

    assert len(calls) == 1  # only ONE Zoho walk served both callers
    assert [p.item_id for p in second_result] == [p.item_id for p in first_result]


# --- T-072: reset_cache() during an in-flight fetch --------------------------


@pytest.mark.asyncio
async def test_reset_cache_during_inflight_fetch_does_not_publish_stale_catalogue(monkeypatch):
    """Auditor's repro: a Zoho credential rotation calls reset_cache() while a
    refresh that started under the OLD credentials is still parked mid-fetch.
    That refresh must still resolve for its own caller, but it must not land
    in the module cache afterwards — or the previous org's catalogue would
    serve every other caller for a full _CACHE_TTL window post-rotation."""
    gate = asyncio.Event()
    entered = asyncio.Event()

    async def gated_page(db, **kwargs):
        entered.set()
        await gate.wait()
        return PAGE_1, False

    monkeypatch.setattr(zoho_service, "list_items_page", gated_page)

    task = asyncio.create_task(zoho_filaments.fetch_catalogue(None))
    await entered.wait()  # the fetch is now parked inside list_items_page

    zoho_filaments.reset_cache()  # the rotation lands mid-fetch
    gate.set()
    old_org_result = await task

    # the in-flight caller still gets its answer...
    assert [p.item_id for p in old_org_result] == ["1", "2", "3", "4"]
    # ...but it must NOT have been published into the module cache.
    assert zoho_filaments._cache is None
    assert zoho_filaments._cache_at is None

    # A subsequent fetch must go back to Zoho — not serve the resurrected,
    # pre-rotation catalogue.
    calls = []

    async def new_org_page(db, **kwargs):
        calls.append(1)
        return PAGE_2, False

    monkeypatch.setattr(zoho_service, "list_items_page", new_org_page)
    fresh = await zoho_filaments.fetch_catalogue(None)
    assert len(calls) == 1
    assert [p.item_id for p in fresh] == ["5"]  # PAGE_2's inactive item is dropped


# --- T-073: a paged fetch that hits _MAX_PAGES must not cache a partial list -


@pytest.mark.asyncio
async def test_truncated_fetch_is_not_cached_and_raises_with_cold_cache(monkeypatch, caplog):
    """If Zoho still reports has_more=True after _MAX_PAGES pages, the partial
    list gathered so far must not be cached as a complete catalogue — it must
    go through the same stale-cache-or-raise handling as any other failure."""
    monkeypatch.setattr(zoho_filaments, "_MAX_PAGES", 2)

    async def always_more_page(db, *, category, page, per_page):
        n = 3 if page == 1 else 5
        batch = [_item(str(100 + page * 10 + i), "Bambu Lab - PLA - X - 1.75mm - 1kg", 100.0) for i in range(n)]
        return batch, True  # never signals has_more=False

    monkeypatch.setattr(zoho_service, "list_items_page", always_more_page)

    with caplog.at_level(logging.ERROR, logger="backend.app.services.zoho_filaments"), pytest.raises(RuntimeError):
        await zoho_filaments.fetch_catalogue(None)

    assert zoho_filaments._cache is None
    assert zoho_filaments._cache_at is None

    error_records = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert len(error_records) == 1
    # the log names the page count (_MAX_PAGES) and the total item count
    # fetched before the loop gave up, as the fix requires.
    assert error_records[0].args == (2, 8)


@pytest.mark.asyncio
async def test_truncated_fetch_serves_the_stale_cache_when_warm(monkeypatch):
    """Same truncation, but with a warm cache present: the stale catalogue is
    served (same as any other refresh failure) rather than raising, and the
    module cache is left holding the last GOOD catalogue, not the partial
    one gathered before truncation was detected."""
    monkeypatch.setattr(zoho_service, "list_items_page", _fake_request([PAGE_1], []))
    warm = await zoho_filaments.fetch_catalogue(None)
    zoho_filaments._cache_at = None  # force the next call to refresh

    monkeypatch.setattr(zoho_filaments, "_MAX_PAGES", 1)

    async def always_more_page(db, **kwargs):
        return PAGE_2, True  # never signals has_more=False

    monkeypatch.setattr(zoho_service, "list_items_page", always_more_page)

    result = await zoho_filaments.fetch_catalogue(None)
    assert [p.item_id for p in result] == [p.item_id for p in warm]
    assert zoho_filaments._cache is warm
