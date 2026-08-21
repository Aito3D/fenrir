"""Tests for fetching, caching and searching the Zoho filament catalogue."""

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
