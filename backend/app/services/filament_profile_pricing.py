"""Writing a synced Zoho price into a filament preset's JSON."""

import json
import math
from typing import Literal

# Mirrors ``_MONEY_CEILING`` in backend/app/schemas/calculator.py: a generous
# but finite ceiling on cost_per_kg. Kept as its own constant here rather than
# importing the calculator's (private, underscore-prefixed) one, so this
# feature does not reach into the calculator's schema module for it — but the
# value must be kept equal to that one; if it ever changes there, change it
# here too.
_MONEY_CEILING = 100_000_000.0

# "written" — filament_cost was set or overwritten in the returned content.
# "unchanged" — the preset already had this exact price; nothing to write.
# "unwritable" — content is empty, not valid JSON, or not a JSON object, so
#   there was nowhere to write a price at all. Distinct from "unchanged": the
#   caller must not report this as a confident, already-correct match.
# "bad_price" — cost_per_kg itself is non-finite, <= 0, or above the ceiling.
#   The preset's content is never even inspected; a bad upstream price must
#   not overwrite a previously-good one just because the content happens to
#   parse. Distinct from "unwritable": the problem is the price, not the
#   preset's own data.
ApplyFilamentCostOutcome = Literal["written", "unchanged", "unwritable", "bad_price"]


def apply_filament_cost(content: str, cost_per_kg: float) -> tuple[str, ApplyFilamentCostOutcome]:
    """Set ``filament_cost`` in a preset's JSON. Returns (content, outcome).

    ``filament_cost`` is stored the way every scalar preset field is stored — an
    array of one string, ``["19.90"]`` — because that is what Bambu Studio
    writes and what the frontend's reader expects. Reading tolerates a bare
    scalar too, since imported presets vary.

    Re-serialised with ``indent=4`` to match the frontend's
    ``JSON.stringify(out, null, 4)``. Without that, the first sync would rewrite
    every preset's entire file and bury the one line that actually changed.

    Malformed or non-object content is returned untouched rather than raising:
    one unparseable preset must not fail a sync over all the others. The
    caller is responsible for routing "unwritable" into its needs-attention
    list rather than counting it alongside a genuine already-correct match.

    ``cost_per_kg`` is validated before anything else: it comes from a Zoho
    item's dealer price divided by a weight parsed out of the item's name
    (see zoho_filaments._map_item), and a sub-denormal weight can divide a
    normal dealer price into inf. ``has_price`` (dealer > 0) does not catch
    that, so it is checked again here, right where the value is about to be
    written to disk — mirrors the calculator sync's guard at
    backend/app/api/routes/calculator.py.
    """
    if not math.isfinite(cost_per_kg) or cost_per_kg <= 0 or cost_per_kg > _MONEY_CEILING:
        return content, "bad_price"
    if not content:
        return content, "unwritable"
    try:
        data = json.loads(content)
    except (ValueError, RecursionError):
        # ValueError covers json.JSONDecodeError (malformed syntax) and any
        # other decoding failure the stdlib raises as a ValueError subclass.
        # RecursionError covers pathologically deep nesting (e.g. a preset
        # made of thousands of nested arrays) — the C accelerator still blows
        # the interpreter's recursion limit on that shape. Both are content
        # problems, not bugs in this function, so both are "unwritable"
        # rather than a crash that would abort every other preset's sync.
        return content, "unwritable"
    if not isinstance(data, dict):
        return content, "unwritable"

    formatted = f"{cost_per_kg:.2f}"
    existing = data.get("filament_cost")
    current = existing[0] if isinstance(existing, list) and existing else existing
    if current is not None and str(current) == formatted:
        return content, "unchanged"

    data["filament_cost"] = [formatted]
    return json.dumps(data, ensure_ascii=False, indent=4), "written"
