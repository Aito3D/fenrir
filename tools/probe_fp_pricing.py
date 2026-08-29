"""Golden probe: apply_filament_cost over a fixed matrix of preset contents.

This is the function that writes a synced price INTO a user's preset file, so
its exact output — the ["19.90"] one-element-array shape, indent=4, key order,
non-ASCII passthrough, and the (content, changed) split — is user-visible: it
lands on disk and is read back by Bambu Studio and by the frontend's parser.
Any drift here silently rewrites every preset on the next sync.
"""

import json
import sys

sys.path.insert(0, ".")

from backend.app.services.filament_profile_pricing import apply_filament_cost  # noqa: E402

CASES = [
    ("empty string", "", 19.9),
    ("whitespace only", "   ", 19.9),
    ("not json", "{not json", 19.9),
    ("json list not object", "[1, 2]", 19.9),
    ("json scalar not object", "42", 19.9),
    ("json null", "null", 19.9),
    ("empty object", "{}", 19.9),
    ("no filament_cost key", json.dumps({"name": "PLA"}), 19.9),
    ("cost as one-element list, different", json.dumps({"filament_cost": ["10.00"]}), 19.9),
    ("cost as one-element list, identical", json.dumps({"filament_cost": ["19.90"]}), 19.9),
    ("cost as bare scalar string, identical", json.dumps({"filament_cost": "19.90"}), 19.9),
    ("cost as bare scalar number, identical", json.dumps({"filament_cost": 19.9}), 19.9),
    ("cost as empty list", json.dumps({"filament_cost": []}), 19.9),
    ("cost as multi-element list", json.dumps({"filament_cost": ["19.90", "20.00"]}), 19.9),
    ("cost null", json.dumps({"filament_cost": None}), 19.9),
    ("non-ascii values preserved", json.dumps({"name": "Rouge Écarlate ✓", "filament_cost": ["1.00"]}, ensure_ascii=False), 2.5),
    ("key order preserved", json.dumps({"z": "1", "a": "2", "filament_cost": ["0.00"]}), 3.0),
    ("nested structures preserved", json.dumps({"a": {"b": [1, {"c": 2}]}, "filament_cost": ["0.00"]}), 3.0),
    ("rounds half up or even at .005", json.dumps({"name": "x"}), 1.005),
    ("rounds at .015", json.dumps({"name": "x"}), 1.015),
    ("truncates a long float", json.dumps({"name": "x"}), 19.899999999),
    ("zero price", json.dumps({"name": "x"}), 0.0),
    ("negative price", json.dumps({"name": "x"}), -5.0),
    ("very large price", json.dumps({"name": "x"}), 1234567.891),
    ("very small price", json.dumps({"name": "x"}), 0.001),
    ("integer-valued float", json.dumps({"name": "x"}), 20.0),
]

for label, content, price in CASES:
    out, changed = apply_filament_cost(content, price)
    print(f"--- {label} | price={price!r}")
    print(f"changed={changed}")
    print(f"content={out!r}")
    print(f"identity={'SAME OBJECT' if out is content else 'new string'}")
