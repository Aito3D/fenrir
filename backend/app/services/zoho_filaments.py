"""Zoho filament catalogue: the Books items whose ``cf_nature_du_produit`` is
"Filaments", mapped into a shape the pricing calculator can link to.

Zoho stores the dealer price per SPOOL, and a spool is not always 1 kg — the
weight lives only inside the item name because Zoho's own ``weight`` field is
empty for every filament. Everything in this module exists to turn that name
string into a trustworthy cost per kg.
"""

import re
from dataclasses import dataclass

# Matches "1kg", "0.9 kg", "0,75kg". Deliberately requires the "kg" unit so the
# "1.75mm" diameter segment can never be read as a weight.
_WEIGHT_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*kg\b", re.IGNORECASE)

_SEGMENT_SEPARATOR = " - "


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
