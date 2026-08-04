"""The island -> Zoho shipping service table. Pure data, no DB and no HTTP."""

import unicodedata

from backend.app.services.aito_shipping import (
    ISLANDS,
    SERVICE_KEYS,
    SERVICE_LABELS,
    ShippingItem,
    _fold,
    grouped_islands,
    island_for_label,
    island_label,
    merge_shipping_catalogue,
    service_for_island,
)


def test_every_island_maps_to_a_known_service():
    for island_key, label, service in ISLANDS:
        assert service in SERVICE_KEYS, f"{island_key} points at unknown service {service}"
        assert label.strip() == label and label, f"{island_key} has a bad label"


def test_island_keys_and_labels_are_unique():
    keys = [row[0] for row in ISLANDS]
    labels = [row[1] for row in ISLANDS]
    assert len(keys) == len(set(keys))
    assert len(labels) == len(set(labels))


def test_island_keys_are_slugs():
    # The key is stored in the database and must survive a label spelling fix.
    for island_key, _, _ in ISLANDS:
        assert island_key == unicodedata.normalize("NFKD", island_key).encode("ascii", "ignore").decode()
        assert island_key.islower()
        assert " " not in island_key


def test_every_service_has_a_label_and_at_least_one_island():
    for service in SERVICE_KEYS:
        assert SERVICE_LABELS[service].startswith("Livraison Avion ")
        assert any(row[2] == service for row in ISLANDS)


def test_lookups():
    assert service_for_island("rangiroa") == "tuamotu"
    assert service_for_island("bora-bora") == "societe"
    assert service_for_island("mangareva") == "gambier"
    assert service_for_island("nuku-hiva") == "marquises"
    assert service_for_island("rurutu") == "australes"
    assert service_for_island("atlantis") is None
    assert island_label("rangiroa") == "Rangiroa"
    assert island_label("atlantis") is None


def test_reverse_lookup_folds_case_and_whitespace():
    # The importer reads this back out of a quote description a human may have
    # retyped, so case differences and whitespace must not prevent matching.
    assert island_for_label("Rangiroa") == "rangiroa"
    assert island_for_label("  rangiroa  ") == "rangiroa"
    assert island_for_label("RANGIROA") == "rangiroa"
    assert island_for_label("Tahaa") is None


def test_fold_strips_accents():
    """Guards the combining-mark stripping that `island_for_label` and — from
    Task 3 — the Zoho item-name match both rest on. No island label carries a
    diacritic today, so nothing else in this file would notice if `_fold` were
    reduced to a bare `.lower()`; the service labels it will be asked to match
    ("Livraison Avion Société") very much do."""
    assert _fold("Société") == "societe"
    assert _fold("SOCIÉTÉ") == "societe"
    assert _fold("Île") == "ile"
    assert _fold("  Île  ") == "ile"


def test_tahiti_is_absent():
    # The shop's own island: air freight to it is not a thing (see the spec).
    assert service_for_island("tahiti") is None


def test_grouped_islands_covers_every_service_in_canonical_order():
    grouped = grouped_islands()
    assert [service for service, _ in grouped] == list(SERVICE_KEYS)
    assert sum(len(islands) for _, islands in grouped) == len(ISLANDS)
    tuamotu = dict(grouped)["tuamotu"]
    assert ("rangiroa", "Rangiroa") in tuamotu


def test_merge_matches_items_by_name():
    merged = merge_shipping_catalogue(
        {},
        [
            {"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": 3200},
            {"item_id": "2", "name": "Livraison Avion Société", "rate": 1500},
            {"item_id": "9", "name": "Impression 3D", "rate": 100},
        ],
    )
    assert merged["tuamotu"] == {"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": 3200.0}
    assert merged["societe"]["item_id"] == "2"
    assert "marquises" not in merged  # not offered by Zoho this time round


def test_merge_matches_case_and_accent_insensitively():
    merged = merge_shipping_catalogue({}, [{"item_id": "1", "name": "LIVRAISON AVION SOCIETE", "rate": 1500}])
    assert merged["societe"]["item_id"] == "1"


def test_merge_never_forgets_a_known_item_id():
    # THE load-bearing rule. Catalogue.item_ids() is what tells is_foreign() a
    # line is ours; forgetting an id would make our own shipping line classify
    # as foreign — preserved by line_item_id AND re-emitted from the project —
    # duplicating itself a little more on every single sync.
    cached = {"tuamotu": {"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": 3200.0}}
    merged = merge_shipping_catalogue(cached, [])
    assert merged["tuamotu"]["item_id"] == "1"


def test_merge_updates_the_rate_of_a_known_item():
    cached = {"tuamotu": {"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": 3200.0}}
    merged = merge_shipping_catalogue(cached, [{"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": 3500}])
    assert merged["tuamotu"]["rate"] == 3500.0


def test_merge_keeps_the_cached_rate_when_zoho_omits_it():
    cached = {"tuamotu": {"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": 3200.0}}
    merged = merge_shipping_catalogue(cached, [{"item_id": "1", "name": "Livraison Avion Tuamotu"}])
    assert merged["tuamotu"]["rate"] == 3200.0


def test_merge_takes_a_new_item_id_for_a_replaced_catalogue_entry():
    # A genuine catalogue swap in Books: same name, new item. The id moves.
    cached = {"tuamotu": {"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": 3200.0}}
    merged = merge_shipping_catalogue(cached, [{"item_id": "7", "name": "Livraison Avion Tuamotu", "rate": 3300}])
    assert merged["tuamotu"]["item_id"] == "7"


def test_merge_keeps_the_cached_rate_when_zoho_sends_an_empty_string():
    # Books has been seen to send "" for an empty numeric field. Must not
    # raise, and must not forget the price already known.
    cached = {"tuamotu": {"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": 3200.0}}
    merged = merge_shipping_catalogue(cached, [{"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": ""}])
    assert merged["tuamotu"]["rate"] == 3200.0


def test_merge_keeps_the_cached_rate_when_zoho_sends_a_non_numeric_rate():
    cached = {"tuamotu": {"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": 3200.0}}
    merged = merge_shipping_catalogue(cached, [{"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": "abc"}])
    assert merged["tuamotu"]["rate"] == 3200.0


def test_merge_keeps_the_cached_rate_when_zoho_sends_nan():
    # ALSO FIX 9: float("nan") parses cleanly (no TypeError/ValueError) but
    # is not a usable rate — worse, json.dumps would serialise it as the bare
    # token `NaN`, which breaks JSON.parse for every reader of
    # /aito/shipping/services. Must fall back to the cached rate like the
    # non-numeric-string case above.
    cached = {"tuamotu": {"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": 3200.0}}
    merged = merge_shipping_catalogue(
        cached, [{"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": float("nan")}]
    )
    assert merged["tuamotu"]["rate"] == 3200.0


def test_merge_keeps_the_cached_rate_when_zoho_sends_infinity():
    cached = {"tuamotu": {"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": 3200.0}}
    merged = merge_shipping_catalogue(
        cached, [{"item_id": "1", "name": "Livraison Avion Tuamotu", "rate": float("inf")}]
    )
    assert merged["tuamotu"]["rate"] == 3200.0


def test_merge_ignores_an_item_whose_name_matches_no_service():
    assert merge_shipping_catalogue({}, [{"item_id": "1", "name": "Livraison Bateau Tuamotu", "rate": 1}]) == {}


def test_merge_ignores_an_item_with_no_id():
    assert merge_shipping_catalogue({}, [{"name": "Livraison Avion Tuamotu", "rate": 3200}]) == {}


def test_shipping_item_carries_an_absent_rate_as_none():
    assert ShippingItem(item_id="1", name="Livraison Avion Tuamotu", rate=None).rate is None
