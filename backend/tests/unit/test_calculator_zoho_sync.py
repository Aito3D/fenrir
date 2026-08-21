"""Tests for the chunked Zoho price sync."""

import pytest

from backend.app.services import zoho_filaments
from backend.app.services.zoho import zoho_service
from backend.app.services.zoho_filaments import FilamentProduct


def _product(item_id, dealer, weight=1.0):
    return FilamentProduct(
        item_id=item_id,
        name=f"Item {item_id}",
        sku=f"SKU-{item_id}",
        brand="Bambu Lab",
        material="ABS-GF",
        colour="Bleu (Blue)",
        spool_weight_kg=weight,
        weight_inferred=False,
        dealer_price=dealer,
        cost_per_kg=round(dealer / weight, 2) if dealer else 0.0,
        has_price=dealer > 0,
    )


@pytest.fixture
def zoho_catalogue(monkeypatch):
    """Install a catalogue; returns the mutable list so tests can reprice it."""
    catalogue = [_product("A", 2000.0), _product("B", 0.0), _product("C", 3000.0, weight=0.5)]

    async def configured(db):
        return True

    async def fetch(db, *, refresh=True):
        return catalogue

    monkeypatch.setattr(zoho_service, "is_configured", configured)
    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", fetch)
    return catalogue


async def _create(async_client, **overrides):
    payload = {
        "brand": "Bambu Lab",
        "material": "ABS-GF",
        "cost_per_kg": 1000.0,
        "margin_pct": 50.0,
        "spool_weight_kg": 1.0,
    }
    payload.update(overrides)
    resp = await async_client.post("/api/v1/calculator/filaments/", json=payload)
    assert resp.status_code == 200
    return resp.json()


@pytest.mark.asyncio
async def test_sync_updates_cost_and_recomputes_printing_cost(async_client, zoho_catalogue):
    created = await _create(async_client, zoho_item_id="A", material="ABS-GF")
    resp = await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"offset": 0, "limit": 25})
    assert resp.status_code == 200
    assert resp.json()["updated"] == 1
    assert resp.json()["next_offset"] is None

    row = (await async_client.get("/api/v1/calculator/filaments/")).json()[0]
    assert row["id"] == created["id"]
    assert row["cost_per_kg"] == 2000.0
    assert row["sale_price_per_kg"] == 3000.0  # margin 50% preserved
    assert row["zoho_synced_at"] is not None


@pytest.mark.asyncio
async def test_sync_uses_the_stored_spool_weight(async_client, zoho_catalogue):
    """A 0.5 kg spool at 3000 per spool is 6000 per kg."""
    await _create(async_client, zoho_item_id="C", material="PA6-CF", spool_weight_kg=0.5)
    await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"offset": 0, "limit": 25})
    row = (await async_client.get("/api/v1/calculator/filaments/")).json()[0]
    assert row["cost_per_kg"] == 6000.0


@pytest.mark.asyncio
async def test_zero_dealer_price_is_skipped_not_written(async_client, zoho_catalogue):
    await _create(async_client, zoho_item_id="B", material="PETG")
    resp = await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"offset": 0, "limit": 25})
    assert resp.json()["skipped_no_price"] == 1
    assert resp.json()["updated"] == 0
    row = (await async_client.get("/api/v1/calculator/filaments/")).json()[0]
    assert row["cost_per_kg"] == 1000.0  # untouched


@pytest.mark.asyncio
async def test_item_missing_from_zoho_is_counted_and_left_alone(async_client, zoho_catalogue):
    await _create(async_client, zoho_item_id="GONE", material="PETG")
    resp = await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"offset": 0, "limit": 25})
    assert resp.json()["missing"] == 1
    row = (await async_client.get("/api/v1/calculator/filaments/")).json()[0]
    assert row["cost_per_kg"] == 1000.0
    assert row["zoho_item_id"] == "GONE"  # the link is kept


@pytest.mark.asyncio
async def test_unchanged_price_is_counted_separately(async_client, zoho_catalogue):
    await _create(async_client, zoho_item_id="A", cost_per_kg=2000.0, material="ABS-GF")
    resp = await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"offset": 0, "limit": 25})
    assert resp.json()["unchanged"] == 1
    assert resp.json()["updated"] == 0


@pytest.mark.asyncio
async def test_unlinked_filaments_are_never_touched(async_client, zoho_catalogue):
    await _create(async_client, material="PLA")  # no zoho_item_id
    resp = await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"offset": 0, "limit": 25})
    assert resp.json()["total"] == 0
    assert resp.json()["processed"] == 0
    assert resp.json()["next_offset"] is None


@pytest.mark.asyncio
async def test_chunking_walks_every_row_exactly_once(async_client, zoho_catalogue):
    for index in range(5):
        await _create(async_client, zoho_item_id="A", material=f"MAT{index}")

    seen, offset, guard = 0, 0, 0
    while offset is not None and guard < 10:
        body = (
            await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"offset": offset, "limit": 2})
        ).json()
        assert body["total"] == 5
        seen += body["processed"]
        offset = body["next_offset"]
        guard += 1

    assert seen == 5
    assert guard == 3  # 2 + 2 + 1


@pytest.mark.asyncio
async def test_counts_sum_to_processed(async_client, zoho_catalogue):
    await _create(async_client, zoho_item_id="A", material="ABS-GF")
    await _create(async_client, zoho_item_id="B", material="PETG")
    await _create(async_client, zoho_item_id="GONE", material="PLA")
    body = (await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"offset": 0, "limit": 25})).json()
    assert body["updated"] + body["unchanged"] + body["skipped_no_price"] + body["missing"] == body["processed"]


@pytest.mark.asyncio
async def test_sync_is_unavailable_when_zoho_is_not_configured(async_client, monkeypatch):
    async def unconfigured(db):
        return False

    monkeypatch.setattr(zoho_service, "is_configured", unconfigured)
    resp = await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"offset": 0, "limit": 25})
    assert resp.status_code == 503
