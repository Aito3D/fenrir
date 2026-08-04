"""The island -> Zoho shipping service table. Pure data, no DB and no HTTP."""

import unicodedata

from backend.app.services.aito_shipping import (
    ISLANDS,
    SERVICE_KEYS,
    SERVICE_LABELS,
    _fold,
    grouped_islands,
    island_for_label,
    island_label,
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
