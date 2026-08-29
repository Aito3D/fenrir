"""Golden probe: parse_filament_name and match_profile over a fixed catalogue.

match_profile decides whether a profile gets priced automatically, gets left
alone, or is reported to the operator — the single decision the whole sync
feature rests on. A drift that turns one outcome into another either writes a
wrong price into a user's preset or silently stops pricing something that used
to be priced; neither shows up as a crash.

parse_filament_name feeds it: the brand/material/colour it splits out of the
Zoho item name ARE the match keys, and the spool weight it recovers is what
turns a per-spool dealer price into the cost per kg that gets written.
"""

import sys

sys.path.insert(0, ".")

from backend.app.services.zoho_filaments import (  # noqa: E402
    FilamentProduct,
    match_profile,
    parse_filament_name,
)

NAMES = [
    "Polymaker - PETG - Electric Blue - 1.75mm - 1kg",
    "Polymaker - PETG - Electric Blue - 1.75mm - 0.75kg",
    "Bambu Lab - PLA Basic - Jade White - 1.75mm - 1kg - 1.75mm - 1kg",
    "eSUN - PLA+ - Black - 1.75mm - 0,8 kg",
    "Brand - Material - Colour",
    "Brand - Material",
    "Brand",
    "",
    "   ",
    "No Separator At All 1kg",
    "Weightless - PLA - Red - 1.75mm",
    "Zero - PLA - Red - 0kg",
    "Trailing - PLA - Red - 2KG",
    "Diameter only - PLA - Red - 1.75mm",
]

print("=== parse_filament_name ===")
for name in NAMES:
    print(f"{name!r} -> {parse_filament_name(name)}")


def product(brand, material, colour, price=19.9, has_price=True, weight=1.0):
    return FilamentProduct(
        item_id=f"{brand}|{material}|{colour}",
        name=f"{brand} - {material} - {colour} - 1.75mm - {weight}kg",
        sku=f"SKU-{brand[:3]}",
        brand=brand,
        material=material,
        colour=colour,
        spool_weight_kg=weight,
        weight_inferred=False,
        dealer_price=price,
        cost_per_kg=price / weight if weight else price,
        has_price=has_price,
    )


CATALOGUE = [
    product("Polymaker", "PETG", "Electric Blue", 19.9),
    product("Polymaker", "PETG", "Black", 19.9),
    product("Polymaker", "PLA", "Electric Blue", 15.0),
    product("Bambu Lab", "PLA Basic", "Jade White", 24.99),
    product("eSUN", "PETG", "Grey", 0.0, has_price=False),
    product("Prusament", "PLA", "Galaxy Black", 29.9, weight=0.5),
    product("Dup", "PLA", "Same Colour", 10.0),
    product("Dup", "PLA", "Same Colour", 11.0),
]

CASES = [
    ("exact single match", "Polymaker", "PLA", "Electric Blue"),
    ("two candidates narrowed by colour", "Polymaker", "PETG", "Electric Blue"),
    ("two candidates, colour matches neither", "Polymaker", "PETG", "Pink"),
    ("two candidates, colour empty", "Polymaker", "PETG", ""),
    ("separator-insensitive brand", "poly-maker", "PLA", "electric blue"),
    ("separator-insensitive material", "Polymaker", "P.L.A", "Electric Blue"),
    ("case-insensitive", "POLYMAKER", "pla", "ELECTRIC BLUE"),
    ("space-insensitive brand", "BambuLab", "PLA Basic", "Jade White"),
    ("sole candidate, wrong colour, still accepted", "Bambu Lab", "PLA Basic", "Not A Colour"),
    ("sole candidate without a price", "eSUN", "PETG", "Grey"),
    ("sole candidate without a price, wrong colour", "eSUN", "PETG", "Anything"),
    ("unknown brand", "Nobody", "PLA", "Red"),
    ("known brand, unknown material", "Polymaker", "TPU", "Red"),
    ("empty brand", "", "PLA", "Red"),
    ("empty material", "Polymaker", "", "Red"),
    ("both empty", "", "", ""),
    ("brand that is only punctuation", "---", "PLA", "Red"),
    ("duplicate rows, identical colour", "Dup", "PLA", "Same Colour"),
    ("half-kg spool cost per kg", "Prusament", "PLA", "Galaxy Black"),
]

print()
print("=== match_profile ===")
for label, brand, material, colour in CASES:
    m = match_profile(CATALOGUE, brand, material, colour)
    prod = None if m.product is None else f"{m.product.item_id} cost_per_kg={m.product.cost_per_kg!r}"
    print(f"--- {label} | brand={brand!r} material={material!r} colour={colour!r}")
    print(f"outcome={m.outcome} product={prod} candidates={m.candidates}")

print()
print("=== match_profile on an empty catalogue ===")
print(match_profile([], "Polymaker", "PETG", "Electric Blue"))
