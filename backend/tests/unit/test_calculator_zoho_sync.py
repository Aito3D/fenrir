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
    catalogue = [
        _product("A", 2000.0),
        _product("B", 0.0),
        # Deliberately mismatched weight: the catalogue claims 1.0 kg while
        # tests store 0.5 kg on the filament, so a stored-weight assertion can
        # only pass if the route uses the STORED weight, not the product's.
        _product("C", 3000.0, weight=1.0),
        # A dealer price so small that dividing by even a 1 kg spool rounds to
        # 0.0 per kg, while ``has_price`` (dealer_price > 0) is still True.
        _product("TINY", 0.001),
        # Distinct item ids at distinct prices so a chunking test can prove
        # every row was visited exactly once (a repeat or a skip would leave
        # some price un-updated or double-applied). Offset from 1000 so none
        # collides with ``_create``'s default cost_per_kg (which would land
        # on "unchanged" instead of "updated").
        *[_product(f"D{index}", 1100.0 + index * 100) for index in range(6)],
    ]

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
    resp = await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"after_id": 0, "limit": 25})
    assert resp.status_code == 200
    assert resp.json()["updated"] == 1
    assert resp.json()["next_after_id"] is None

    row = (await async_client.get("/api/v1/calculator/filaments/")).json()[0]
    assert row["id"] == created["id"]
    assert row["cost_per_kg"] == 2000.0
    assert row["sale_price_per_kg"] == 3000.0  # margin 50% preserved
    assert row["zoho_synced_at"] is not None


@pytest.mark.asyncio
async def test_sync_uses_the_stored_spool_weight(async_client, zoho_catalogue):
    """The filament stores 0.5 kg while the catalogue product claims 1.0 kg.

    3000 / 0.5 = 6000 (stored weight, the only correct answer) versus
    3000 / 1.0 = 3000 (the catalogue's weight, which must lose).
    """
    await _create(async_client, zoho_item_id="C", material="PA6-CF", spool_weight_kg=0.5)
    await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"after_id": 0, "limit": 25})
    row = (await async_client.get("/api/v1/calculator/filaments/")).json()[0]
    assert row["cost_per_kg"] == 6000.0


@pytest.mark.asyncio
async def test_zero_dealer_price_is_skipped_not_written(async_client, zoho_catalogue):
    await _create(async_client, zoho_item_id="B", material="PETG")
    resp = await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"after_id": 0, "limit": 25})
    assert resp.json()["skipped_no_price"] == 1
    assert resp.json()["updated"] == 0
    row = (await async_client.get("/api/v1/calculator/filaments/")).json()[0]
    assert row["cost_per_kg"] == 1000.0  # untouched


@pytest.mark.asyncio
async def test_subcent_result_is_skipped_not_written_as_zero(async_client, zoho_catalogue):
    """A tiny dealer price over a 1 kg spool rounds to 0.0 per kg.

    ``product.has_price`` is True here (dealer_price = 0.001 > 0), so the
    guard must check the VALUE about to be written, not just that flag, or a
    near-zero result gets written and counted as ``updated`` — and a zero
    ``cost_per_kg`` permanently breaks the filament list response schema
    (``cost_per_kg`` is ``gt=0``).
    """
    await _create(async_client, zoho_item_id="TINY", material="PETG")
    resp = await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"after_id": 0, "limit": 25})
    assert resp.json()["skipped_no_price"] == 1
    assert resp.json()["updated"] == 0
    row = (await async_client.get("/api/v1/calculator/filaments/")).json()[0]
    assert row["cost_per_kg"] == 1000.0  # untouched


@pytest.mark.asyncio
async def test_filament_list_still_responds_after_a_subcent_sync(async_client, zoho_catalogue):
    """Regression guard: the list endpoint must stay readable after a sync."""
    await _create(async_client, zoho_item_id="TINY", material="PETG")
    await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"after_id": 0, "limit": 25})
    resp = await async_client.get("/api/v1/calculator/filaments/")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_item_missing_from_zoho_is_counted_and_left_alone(async_client, zoho_catalogue):
    await _create(async_client, zoho_item_id="GONE", material="PETG")
    resp = await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"after_id": 0, "limit": 25})
    assert resp.json()["missing"] == 1
    row = (await async_client.get("/api/v1/calculator/filaments/")).json()[0]
    assert row["cost_per_kg"] == 1000.0
    assert row["zoho_item_id"] == "GONE"  # the link is kept


@pytest.mark.asyncio
async def test_unchanged_price_is_counted_separately(async_client, zoho_catalogue):
    await _create(async_client, zoho_item_id="A", cost_per_kg=2000.0, material="ABS-GF")
    resp = await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"after_id": 0, "limit": 25})
    assert resp.json()["unchanged"] == 1
    assert resp.json()["updated"] == 0


@pytest.mark.asyncio
async def test_unlinking_clears_the_sync_stamp(async_client, zoho_catalogue):
    """A row that is no longer linked must not keep looking Zoho-priced.

    The settings panel reads a non-null ``zoho_synced_at`` as proof the cost is
    Zoho-owned and reconstructs a dealer price from it. A stamp surviving an
    unlink means that after re-linking to an unpriced product, a hand-typed
    cost would be treated as a dealer price and silently rescaled by a
    spool-weight correction.
    """
    created = await _create(async_client, zoho_item_id="A", material="ABS-GF")
    await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"after_id": 0, "limit": 25})
    assert (await async_client.get("/api/v1/calculator/filaments/")).json()[0]["zoho_synced_at"] is not None

    resp = await async_client.patch(
        f"/api/v1/calculator/filaments/{created['id']}",
        json={"zoho_item_id": None, "zoho_item_name": None, "zoho_sku": None, "spool_weight_kg": None},
    )
    assert resp.status_code == 200
    assert resp.json()["zoho_synced_at"] is None
    # And it stays cleared when read back, not just in the write's response.
    assert (await async_client.get("/api/v1/calculator/filaments/")).json()[0]["zoho_synced_at"] is None


@pytest.mark.asyncio
async def test_relinking_to_another_product_clears_the_sync_stamp(async_client, zoho_catalogue):
    """Re-pointing the row at a different item invalidates the old stamp too.

    The panel only offers the product search once the form is unlinked, but the
    resulting PATCH carries the NEW item id — nothing in it says "I unlinked
    first", so the stamp has to be cleared on any change of ``zoho_item_id``.
    """
    created = await _create(async_client, zoho_item_id="A", material="ABS-GF")
    await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"after_id": 0, "limit": 25})

    resp = await async_client.patch(
        f"/api/v1/calculator/filaments/{created['id']}",
        # "B" is the zero-dealer-price product: the sync will never stamp it,
        # so the cost below stays the operator's own.
        json={"zoho_item_id": "B", "zoho_item_name": "Item B", "zoho_sku": "SKU-B", "cost_per_kg": 1234.0},
    )
    assert resp.status_code == 200
    assert resp.json()["zoho_synced_at"] is None
    assert resp.json()["cost_per_kg"] == 1234.0


@pytest.mark.asyncio
async def test_unlinked_filaments_are_never_touched(async_client, zoho_catalogue):
    await _create(async_client, material="PLA")  # no zoho_item_id
    resp = await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"after_id": 0, "limit": 25})
    assert resp.json()["total"] == 0
    assert resp.json()["processed"] == 0
    assert resp.json()["next_after_id"] is None


@pytest.mark.asyncio
async def test_chunking_walks_every_row_exactly_once(async_client, zoho_catalogue):
    """Each row links to its OWN item id at its OWN price.

    A repeated or skipped row would show up two ways: the ``updated`` counts
    would not sum to 5, and/or some row's final price would not match its
    item's dealer price (a repeat lands on ``unchanged`` the second time
    through, so a naive count-only check could still add up to 5 by luck —
    the per-row price assertion below is what actually catches that case).
    """
    created = [await _create(async_client, zoho_item_id=f"D{index}", material=f"MAT{index}") for index in range(5)]

    seen, after_id, guard = 0, 0, 0
    while after_id is not None and guard < 10:
        body = (
            await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"after_id": after_id, "limit": 2})
        ).json()
        assert body["total"] == 5
        seen += body["updated"]
        after_id = body["next_after_id"]
        guard += 1

    assert seen == 5
    assert guard == 3  # 2 + 2 + 1

    rows = {row["id"]: row for row in (await async_client.get("/api/v1/calculator/filaments/")).json()}
    for index, filament in enumerate(created):
        expected_price = 1100.0 + index * 100
        assert rows[filament["id"]]["cost_per_kg"] == expected_price


@pytest.mark.asyncio
async def test_deleting_an_already_synced_row_mid_run_does_not_skip_a_later_row(async_client, zoho_catalogue):
    """The bug that motivated keyset paging.

    Offset paging re-queries "all linked rows, ordered by id" fresh on every
    chunk and slices it in Python by position. Deleting an already-processed
    row shifts every later row's *position* left by one, so the next chunk's
    offset window silently lands one row short of where it should — skipping
    a row while still reporting "sync complete". Keyset paging asks for
    "id > the last id I actually processed", which a deletion of an earlier
    row cannot shift.
    """
    created = [await _create(async_client, zoho_item_id=f"D{index}", material=f"MAT{index}") for index in range(6)]

    after_id, guard = 0, 0
    first_chunk = True
    while guard < 10:
        body = (
            await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"after_id": after_id, "limit": 2})
        ).json()
        guard += 1
        if first_chunk:
            # Delete the first row this chunk already synced — a row that is
            # done, not one still waiting to be processed.
            first_synced_id = created[0]["id"]
            resp = await async_client.delete(f"/api/v1/calculator/filaments/{first_synced_id}")
            assert resp.status_code == 200
            first_chunk = False
        after_id = body["next_after_id"]
        if after_id is None:
            break

    rows = {row["id"]: row for row in (await async_client.get("/api/v1/calculator/filaments/")).json()}
    assert len(rows) == 5  # the deleted row is gone, the other 5 remain
    for index, filament in enumerate(created):
        if filament["id"] == created[0]["id"]:
            continue  # deleted; nothing left to assert
        expected_price = 1100.0 + index * 100
        assert filament["id"] in rows, f"row {filament['id']} (D{index}) was skipped by the chunked walk"
        assert rows[filament["id"]]["cost_per_kg"] == expected_price


@pytest.mark.asyncio
async def test_row_added_mid_run_with_higher_id_is_picked_up_by_a_later_chunk(async_client, zoho_catalogue):
    """A row added between chunks of the SAME walk, with a higher id than
    anything queued so far, must still be reached once the walk continues.
    """
    first = await _create(async_client, zoho_item_id="D0", material="MAT0")
    second = await _create(async_client, zoho_item_id="D1", material="MAT1")

    # limit=1 with 2 rows already present guarantees the walk isn't done yet:
    # next_after_id comes back non-null.
    body = (await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"after_id": 0, "limit": 1})).json()
    assert body["updated"] == 1
    assert body["next_after_id"] is not None

    # Added after chunk 1 committed, with an id higher than "second" (still
    # unprocessed) and "first" (already processed).
    added = await _create(async_client, zoho_item_id="D2", material="MAT2")

    after_id, guard = body["next_after_id"], 0
    while after_id is not None and guard < 10:
        body = (
            await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"after_id": after_id, "limit": 25})
        ).json()
        after_id = body["next_after_id"]
        guard += 1

    rows = {row["id"]: row for row in (await async_client.get("/api/v1/calculator/filaments/")).json()}
    assert rows[first["id"]]["cost_per_kg"] == 1100.0
    assert rows[second["id"]]["cost_per_kg"] == 1200.0
    assert rows[added["id"]]["cost_per_kg"] == 1300.0  # picked up despite being added mid-walk


@pytest.mark.asyncio
async def test_after_id_beyond_the_highest_id_returns_nothing_to_process(async_client, zoho_catalogue):
    await _create(async_client, zoho_item_id="A", material="ABS-GF")
    resp = await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"after_id": 999_999, "limit": 25})
    body = resp.json()
    assert body["processed"] == 0
    assert body["next_after_id"] is None
    assert body["total"] == 1  # progress bar still sees the linked filament


@pytest.mark.asyncio
async def test_exact_multiple_of_limit_terminates_without_an_extra_empty_request(async_client, zoho_catalogue):
    """4 linked filaments at limit=2 must finish in exactly 2 requests, not 3.

    Fetching ``limit + 1`` rows per chunk is what lets the route know a chunk
    is the last one without a trailing request that processes nothing.
    """
    for index in range(4):
        await _create(async_client, zoho_item_id=f"D{index}", material=f"MAT{index}")

    after_id, requests = 0, 0
    while True:
        body = (
            await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"after_id": after_id, "limit": 2})
        ).json()
        requests += 1
        assert body["processed"] > 0  # never an empty trailing chunk
        after_id = body["next_after_id"]
        if after_id is None:
            break

    assert requests == 2


@pytest.mark.asyncio
async def test_counts_sum_to_processed(async_client, zoho_catalogue):
    await _create(async_client, zoho_item_id="A", material="ABS-GF")
    await _create(async_client, zoho_item_id="B", material="PETG")
    await _create(async_client, zoho_item_id="GONE", material="PLA")
    body = (await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"after_id": 0, "limit": 25})).json()
    assert body["updated"] + body["unchanged"] + body["skipped_no_price"] + body["missing"] == body["processed"]


@pytest.mark.asyncio
async def test_sync_is_unavailable_when_zoho_is_not_configured(async_client, monkeypatch):
    async def unconfigured(db):
        return False

    monkeypatch.setattr(zoho_service, "is_configured", unconfigured)
    resp = await async_client.post("/api/v1/calculator/filaments/zoho-sync", json={"after_id": 0, "limit": 25})
    assert resp.status_code == 503
