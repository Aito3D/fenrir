"""Writing a synced Zoho price into a filament preset's JSON."""

import json


def apply_filament_cost(content: str, cost_per_kg: float) -> tuple[str, bool]:
    """Set ``filament_cost`` in a preset's JSON. Returns (content, changed).

    ``filament_cost`` is stored the way every scalar preset field is stored — an
    array of one string, ``["19.90"]`` — because that is what Bambu Studio
    writes and what the frontend's reader expects. Reading tolerates a bare
    scalar too, since imported presets vary.

    Re-serialised with ``indent=4`` to match the frontend's
    ``JSON.stringify(out, null, 4)``. Without that, the first sync would rewrite
    every preset's entire file and bury the one line that actually changed.

    Malformed or non-object content is returned untouched rather than raising:
    one unparseable preset must not fail a sync over all the others.
    """
    if not content:
        return content, False
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return content, False
    if not isinstance(data, dict):
        return content, False

    formatted = f"{cost_per_kg:.2f}"
    existing = data.get("filament_cost")
    current = existing[0] if isinstance(existing, list) and existing else existing
    if current is not None and str(current) == formatted:
        return content, False

    data["filament_cost"] = [formatted]
    return json.dumps(data, ensure_ascii=False, indent=4), True
