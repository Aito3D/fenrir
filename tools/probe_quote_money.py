"""Golden probe: the Aito quote money math, parsers and lookups.

Pure-function probe, no DB and no network. It pins the observable output of the
export/import/shipping helpers over an edge-case matrix (None vs 0 costs,
discounts, missing quantity/weight/time, foreign lines) so a refactor that
changes a rounding rule, a description string or a line-item shape shows up as
a snapshot diff rather than as a silent invoice difference.

Invoked by PROBES.json as `./venv/bin/python3 tools/probe_quote_money.py`.
Output must be deterministic: dict key order is normalised by sort_keys.
"""

import json
import os
import sys

# Running a script inside tools/ puts tools/ on sys.path, not the repo root, so
# `backend.*` would not import. The other probes use `python -c`, which gets the
# cwd for free; this one has to ask.
sys.path.insert(0, os.getcwd())

from backend.app.services.aito_board_rules import summarise  # noqa: E402
from backend.app.services.aito_events import diff_fields  # noqa: E402
from backend.app.services.aito_quote_export import (
    Catalogue,
    ExportShipping,
    ExportTask,
    build_description,
    build_line_items,
    build_shipping_description,
    cost_of,
    description_of,
    enabled_services,
    format_time,
    format_weight,
    is_foreign,
    rate_quantity,
)
from backend.app.services.aito_quote_import import (
    parse_description,
    parse_lines,
    parse_shipping_line,
    parse_time_min,
    parse_weight_g,
    service_for_sku,
)
from backend.app.services.aito_shipping import (
    grouped_islands,
    island_for_label,
    island_label,
    merge_shipping_catalogue,
    service_for_island,
)

SERVICES = ("scan", "modelisation", "impression", "usinage")


def task(**kw) -> ExportTask:
    """An ExportTask with every field defaulted to None, overridden by kw."""
    base = {
        "title": None,
        "scan_cost": None,
        "modelisation_cost": None,
        "usinage_cost": None,
        "impression_cost": None,
        "impression_quantity": None,
        "impression_weight_g": None,
        "impression_time_min": None,
        "impression_color": None,
        "material": None,
    }
    base.update(kw)
    return ExportTask(**base)


# An edge-case matrix over the fields the money math reads.
TASKS = {
    "all-none": task(),
    "zero-costs": task(title="Zero", scan_cost=0.0, modelisation_cost=0.0, impression_cost=0.0, usinage_cost=0.0),
    "scan-only": task(title="Scan only", scan_cost=1234.0),
    "impression-qty1": task(title="Imp q1", impression_cost=500.0, impression_quantity=1),
    "impression-qty7": task(title="Imp q7", impression_cost=700.0, impression_quantity=7),
    "impression-qty0": task(title="Imp q0", impression_cost=700.0, impression_quantity=0),
    "impression-qty-none": task(title="Imp qN", impression_cost=700.0, impression_quantity=None),
    "impression-discount-50": task(
        title="Imp disc", impression_cost=1000.0, impression_quantity=2, impression_discount_pct=50.0
    ),
    "impression-discount-100": task(
        title="Imp disc100", impression_cost=1000.0, impression_quantity=1, impression_discount_pct=100.0
    ),
    "impression-discount-0": task(
        title="Imp disc0", impression_cost=1000.0, impression_quantity=1, impression_discount_pct=0.0
    ),
    "impression-full-meta": task(
        title="Full",
        impression_cost=999.5,
        impression_quantity=3,
        impression_weight_g=1234.56,
        impression_time_min=605,
        impression_color="Rouge",
        material="PLA",
    ),
    "all-services": task(
        title="All",
        scan_cost=100.0,
        modelisation_cost=200.0,
        impression_cost=300.0,
        usinage_cost=400.0,
        impression_quantity=2,
        impression_weight_g=50.0,
        impression_time_min=90,
        material="PETG",
        impression_color="Noir",
    ),
    "with-descriptions": task(
        title="Described",
        scan_cost=10.0,
        impression_cost=20.0,
        impression_quantity=1,
        scan_description="scan desc",
        impression_description="imp desc",
        modelisation_description="mod desc",
        usinage_description="usi desc",
    ),
    "fractional": task(title="Frac", impression_cost=0.005, impression_quantity=3, impression_weight_g=0.4),
    "negative": task(title="Neg", scan_cost=-50.0, impression_cost=-10.0, impression_quantity=2),
}

CATALOGUE = Catalogue(
    scan_item_id="ITEM-SCAN",
    modelisation_item_id="ITEM-MODEL",
    impression_item_id="ITEM-IMP",
    usinage_item_id="ITEM-USI",
    tax_id="TAX-1",
    shipping={"aerien": "ITEM-SHIP-AIR", "bateau": "ITEM-SHIP-SEA"},
)

SHIPPINGS = {
    "none": None,
    "air-zero": ExportShipping(
        service="aerien", island_label="Tahiti", first_name="A", last_name="B", phone="87000000", price=0.0
    ),
    "air-priced": ExportShipping(
        service="aerien", island_label="Raiatea", first_name="Jean", last_name="Dupont", phone="87123456", price=1500.0
    ),
    "sea-priced": ExportShipping(
        service="bateau", island_label="Nuku Hiva", first_name="Ana", last_name="T", phone="40123456", price=2750.5
    ),
}

out: dict = {}

# --- per-task money math -----------------------------------------------------
out["per_task"] = {
    name: {
        "enabled_services": list(enabled_services(t)),
        "cost_of": {s: cost_of(t, s) for s in SERVICES},
        "description_of": {s: description_of(t, s) for s in SERVICES},
        "build_description": {s: build_description(s, t) for s in SERVICES},
        "impression_rate_quantity": list(rate_quantity(t, "impression")),
    }
    for name, t in sorted(TASKS.items())
}

# --- formatters --------------------------------------------------------------
out["format_weight"] = {
    repr(v): format_weight(v) for v in [None, 0, 0.0, 0.4, 1, 999, 999.5, 1000, 1234.56, 1_000_000, -5]
}
out["format_time"] = {
    repr(v): format_time(v) for v in [None, 0, 1, 59, 60, 61, 90, 119, 120, 605, 1440, 10080, -30]
}
out["parse_weight_g"] = {
    repr(v): parse_weight_g(v)
    for v in [None, "", " ", "0", "1g", "1 g", "1kg", "1.5 kg", "1,5 kg", "abc", "12", "-3g", "1e3g"]
}
out["parse_time_min"] = {
    repr(v): parse_time_min(v)
    for v in [None, "", " ", "0", "1min", "1 min", "1h", "1h30", "2 h 05", "90", "abc", "-5min", "1h0"]
}

# --- line items over the shipping matrix ------------------------------------
line_cases: dict = {}
for ship_name, ship in sorted(SHIPPINGS.items(), key=lambda kv: kv[0]):
    for task_set_name, task_set in [
        ("empty", []),
        ("single-all-services", [TASKS["all-services"]]),
        ("multi", [TASKS["scan-only"], TASKS["impression-qty7"], TASKS["impression-discount-50"]]),
        ("all-none-only", [TASKS["all-none"]]),
        ("zero-costs-only", [TASKS["zero-costs"]]),
    ]:
        key = f"{ship_name}/{task_set_name}"
        try:
            line_cases[key] = build_line_items(list(task_set), [], CATALOGUE, ship)
        except Exception as exc:  # a raise IS the behavior; pin the type+message
            line_cases[key] = {"__raised__": f"{type(exc).__name__}: {exc}"}
out["build_line_items"] = line_cases

# build_line_items with pre-existing line items (id reuse path)
existing = [
    {"line_item_id": "L1", "item_id": "ITEM-SCAN", "name": "old scan"},
    {"line_item_id": "L2", "item_id": "ITEM-IMP", "name": "old imp"},
]
out["build_line_items_existing"] = build_line_items(
    [TASKS["all-services"]], existing, CATALOGUE, SHIPPINGS["air-priced"]
)

out["build_shipping_description"] = {
    name: build_shipping_description(s) for name, s in sorted(SHIPPINGS.items()) if s is not None
}

# --- is_foreign -------------------------------------------------------------
out["is_foreign"] = {
    repr(line): is_foreign(line, CATALOGUE)
    for line in [
        {},
        {"item_id": "ITEM-SCAN"},
        {"item_id": "ITEM-IMP"},
        {"item_id": "ITEM-SHIP-AIR"},
        {"item_id": "ITEM-SHIP-SEA"},
        {"item_id": "SOMETHING-ELSE"},
        {"item_id": None},
        {"item_id": ""},
    ]
}

# --- import side ------------------------------------------------------------
out["service_for_sku"] = {
    repr(v): service_for_sku(v) for v in [None, "", "SCAN", "scan", "MODEL", "IMP", "USI", "unknown", "  scan  "]
}
out["parse_description"] = {
    repr(v): [dict(sorted(parse_description(v)[0].items())), list(parse_description(v)[1])]
    for v in [None, "", "no markers", "Couleur: Rouge", "Couleur: Rouge\nMatiere: PLA", "Poids: 12 g\nTemps: 1h30"]
}

SHIPPING_IDS = {"ITEM-SHIP-AIR": "aerien", "ITEM-SHIP-SEA": "bateau"}
ship_line_cases = [
    {},
    {"item_id": "ITEM-SHIP-AIR", "rate": 1500, "description": "Tahiti"},
    {"item_id": "ITEM-SHIP-SEA", "rate": 0, "description": ""},
    {"item_id": "ITEM-SCAN", "rate": 100},
]
out["parse_shipping_line"] = {}
for line in ship_line_cases:
    try:
        r = parse_shipping_line(line, SHIPPING_IDS)
        out["parse_shipping_line"][repr(line)] = None if r is None else repr(r)
    except Exception as exc:
        out["parse_shipping_line"][repr(line)] = f"__raised__ {type(exc).__name__}: {exc}"

estimate_cases = {
    "empty": {},
    "no-lines": {"line_items": []},
    "mixed": {
        "line_items": [
            {"item_id": "ITEM-SCAN", "rate": 100, "quantity": 1, "description": "scan"},
            {"item_id": "ITEM-IMP", "rate": 200, "quantity": 3, "description": "Couleur: Bleu"},
            {"item_id": "ITEM-SHIP-AIR", "rate": 1500, "quantity": 1, "description": "Bora Bora"},
            {"item_id": "FOREIGN", "rate": 9, "quantity": 1, "description": "other"},
        ]
    },
}
out["parse_lines"] = {}
for name, est in sorted(estimate_cases.items()):
    try:
        lines, leftovers, ship = parse_lines(est, SHIPPING_IDS)
        out["parse_lines"][name] = {
            "lines": [repr(x) for x in lines],
            "leftovers": leftovers,
            "shipping": None if ship is None else repr(ship),
            "grouped": [[repr(x) for x in g] for g in __import__(
                "backend.app.services.aito_quote_import", fromlist=["group_lines"]
            ).group_lines(lines)],
        }
    except Exception as exc:
        out["parse_lines"][name] = f"__raised__ {type(exc).__name__}: {exc}"

# --- shipping lookups -------------------------------------------------------
out["grouped_islands"] = [[g, [list(p) for p in items]] for g, items in grouped_islands()]
ISLANDS = [None, "", "tahiti", "Tahiti", "bora-bora", "Bora Bora", "nuku-hiva", "unknown-island"]
out["island_label"] = {repr(v): island_label(v) for v in ISLANDS}
out["island_for_label"] = {repr(v): island_for_label(v) for v in ISLANDS}
out["service_for_island"] = {repr(v): service_for_island(v) for v in ISLANDS}
out["merge_shipping_catalogue"] = {
    "empty+empty": merge_shipping_catalogue({}, []),
    "empty+items": merge_shipping_catalogue({}, [{"item_id": "S1", "name": "Air"}, {"item_id": "S2", "name": "Sea"}]),
    "cached+overlap": merge_shipping_catalogue(
        {"S1": {"item_id": "S1", "name": "Old"}}, [{"item_id": "S1", "name": "New"}, {"item_id": "S3", "name": "Z"}]
    ),
    "cached+empty": merge_shipping_catalogue({"S1": {"item_id": "S1", "name": "Keep"}}, []),
}

# --- board summarise + event diff -------------------------------------------


class _T:
    """Duck-typed task stand-in for summarise()."""

    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


SUMMARISE_SETS = {
    "empty": [],
    "one-open": [_T(scan_done=False, modelisation_done=False, impression_done=False, usinage_done=False)],
    "one-done": [_T(scan_done=True, modelisation_done=True, impression_done=True, usinage_done=True)],
    "mixed": [
        _T(scan_done=True, modelisation_done=False, impression_done=False, usinage_done=False),
        _T(scan_done=True, modelisation_done=True, impression_done=False, usinage_done=False),
    ],
}
out["summarise"] = {}
for name, ts in sorted(SUMMARISE_SETS.items()):
    try:
        out["summarise"][name] = repr(summarise(ts))
    except Exception as exc:
        out["summarise"][name] = f"__raised__ {type(exc).__name__}: {exc}"

out["diff_fields"] = {}
for name, (obj, patch) in sorted(
    {
        "no-change": (_T(a=1, b="x"), {"a": 1}),
        "one-change": (_T(a=1, b="x"), {"a": 2}),
        "none-to-value": (_T(a=None), {"a": 5}),
        "value-to-none": (_T(a=5), {"a": None}),
        "unknown-field": (_T(a=1), {"zzz": 9}),
        "empty-patch": (_T(a=1), {}),
    }.items()
):
    try:
        out["diff_fields"][name] = diff_fields(obj, patch)
    except Exception as exc:
        out["diff_fields"][name] = f"__raised__ {type(exc).__name__}: {exc}"

print(json.dumps(out, sort_keys=True, indent=1, default=repr))
