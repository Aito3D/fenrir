"""Snapshot probe: the calculator's pure Zoho-filament decision logic.

Covers the three pieces of arithmetic and ranking the Zoho-linked calculator
filament feature rests on, over a fixed catalogue:

  * ``derive_sale_price`` -- the single home of the stored invariant
    ``sale_price_per_kg == round(cost_per_kg * (1 + margin_pct/100), 2)``.
    Python rounds half-to-EVEN while the boot migration's SQL ROUND rounds
    half-away-from-zero, so the half-cent cases below are load-bearing.
  * ``parse_filament_name`` / ``_map_item`` -- name splitting, the
    LAST-weight-wins rule, the inferred-weight flag, and the zero-dealer-price
    ``has_price`` guard that keeps a free item from zeroing a filament's cost.
  * ``_score`` / ``search_catalogue`` -- the ranking that makes "PETG" lead with
    PETG, and the all-terms-must-match filter.

Run from repo root: ./venv/bin/python3 tools/probe_calc_zoho.py
"""

import json
from dataclasses import asdict

from backend.app.api.routes.calculator import (
    _NULLABLE_FILAMENT_FIELDS,
    _filament_display_name,
    derive_sale_price,
)
from backend.app.services.zoho_filaments import (
    _CACHE_TTL,
    _MAX_PAGES,
    _PAGE_SIZE,
    FILAMENT_CATEGORY,
    _map_item,
    _score,
    parse_filament_name,
    search_catalogue,
)

# Names chosen to pin each documented rule: the canonical convention, the
# production item that repeats its weight suffix, a comma decimal, a
# no-weight name (1 kg inferred), a zero weight, and a short/garbage name.
NAMES = [
    "SUNLU - PLA Matte - Grey - 1.75mm - 1kg",
    "eSUN - PETG - Black - 1.75mm - 1kg - 1.75mm - 1kg",
    "Polymaker - ASA - White - 1.75mm - 2,5 kg",
    "Bambu Lab - PLA Basic - Jade White",
    "NoBrand - TPU - Clear - 1.75mm - 0kg",
    "Filament",
    "",
    " - - - ",
]

ITEMS = [
    {"item_id": 1, "name": NAMES[0], "sku": "SL-PLAM-GY", "brand": "SUNLU",
     "cf_prix_dealer_usd_unformatted": 11.5},
    {"item_id": 2, "name": NAMES[1], "sku": "ES-PETG-BK", "brand": "",
     "cf_prix_dealer_usd_unformatted": 13.0},
    {"item_id": 3, "name": NAMES[2], "sku": "PM-ASA-WH", "brand": "Polymaker",
     "cf_prix_dealer_usd_unformatted": 47.5},
    # has_price False: a zero dealer price must never reach a filament's cost.
    {"item_id": 4, "name": NAMES[3], "sku": "BL-PLAB-JW", "brand": "Bambu Lab",
     "cf_prix_dealer_usd_unformatted": 0},
    # Zero weight in the name falls back to 1 kg, not a ZeroDivisionError.
    {"item_id": 5, "name": NAMES[4], "sku": "NB-TPU-CL", "brand": None,
     "cf_prix_dealer_usd_unformatted": 22.0},
    # Missing everything: the mapper must still produce a row.
    {"item_id": 6, "name": NAMES[5], "sku": None, "brand": None,
     "cf_prix_dealer_usd_unformatted": None},
]

catalogue = [_map_item(item) for item in ITEMS]

QUERIES = ["", "  ", "pla", "PETG", "sunlu pla", "white", "bk", "asa 2", "nomatch"]

# Half-cent cases first: these are exactly where Python's banker's rounding and
# SQLite's ROUND disagree, which the migration's 0.011 tolerance exists to absorb.
SALE_CASES = [
    (11094.75, 50.0), (3731.0, 50.0), (25.0, 60.0), (25.0, 0.0),
    (0.0, 50.0), (25.0, -100.0), (0.005, 50.0), (1e6, 33.333),
]

print(
    json.dumps(
        {
            "constants": {
                "FILAMENT_CATEGORY": FILAMENT_CATEGORY,
                "_PAGE_SIZE": _PAGE_SIZE,
                "_MAX_PAGES": _MAX_PAGES,
                "_CACHE_TTL_seconds": _CACHE_TTL.total_seconds(),
                "_NULLABLE_FILAMENT_FIELDS": sorted(_NULLABLE_FILAMENT_FIELDS),
            },
            "parse_filament_name": {n: asdict(parse_filament_name(n)) for n in NAMES},
            "map_item": [asdict(p) for p in catalogue],
            "derive_sale_price": [
                {"cost": c, "margin": m, "sale": derive_sale_price(c, m)} for c, m in SALE_CASES
            ],
            "display_name": [
                _filament_display_name("SUNLU", "PLA Matte"),
                _filament_display_name("  SUNLU  ", "  "),
                _filament_display_name("", ""),
            ],
            "search": {
                q: [p.item_id for p in search_catalogue(catalogue, q)] for q in QUERIES
            },
            "search_limit": [p.item_id for p in search_catalogue(catalogue, "", limit=2)],
            "scores": {
                q: {p.item_id: _score(p, [t for t in q.lower().split() if t]) for p in catalogue}
                for q in ["pla", "petg", "sunlu pla", "white"]
            },
        },
        sort_keys=True,
        indent=1,
    )
)
