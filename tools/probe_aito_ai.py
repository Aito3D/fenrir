"""Golden probe: the Aito AI service's pure prompt/response shaping.

openrouter.py is new to the campaign-5 scope and it is the one Aito backend
module whose output a user reads verbatim — a proofread field's text lands
straight back in the task. The network call is not probed; what IS probed is
everything a refactor can silently move: the prompt text and model/limit
constants that decide what gets sent, `_task_lines`'s summary rendering, and
`_unquote`'s strip-one-layer rule.

Invoked by PROBES.json as `./venv/bin/python3 tools/probe_aito_ai.py`.
Deterministic: no clock, no network, sort_keys on output.
"""

import json
import os
import sys

sys.path.insert(0, os.getcwd())

from backend.app.services import openrouter as o  # noqa: E402

TASKS = [
    {},                                                    # empty -> "Tâche 1: aucun service"
    {"title": "   "},                                      # blank title falls back to index
    {"title": "Capot", "impression_cost": 12.5, "impression_color": "noir",
     "impression_weight_g": 42.0, "impression_quantity": 3},
    {"title": "Capot", "impression_cost": 0, "impression_quantity": 1},   # qty 1 omitted
    {"title": "Capot", "impression_cost": 0, "impression_weight_g": 0},   # 0 g is not None
    {"title": "X" * 700, "impression_cost": 1},                            # title clamp at 500
    {"title": "Multi", "impression_cost": 1, "impression_description": "  spaced  "},
]

QUOTES = [
    ('"Capot"', "Capot"),          # stripped
    ('"Capot"', '"Capot"'),        # original was quoted -> kept
    ("«Capot»", "Capot"),
    ("“Capot”", "Capot"),
    ("'Capot'", "Capot"),
    ('"', '"'),                    # too short to be a pair
    ("Capot", "Capot"),            # untouched
    ('" Capot "', "Capot"),        # inner strip
    ('"Capot', "Capot"),           # unbalanced -> untouched
]


def main():
    out = {
        "constants": {
            "OPENROUTER_URL": o.OPENROUTER_URL,
            "DEFAULT_MODEL": o.DEFAULT_MODEL,
            "PROOFREAD_MODEL": o.PROOFREAD_MODEL,
            "PROOFREAD_MAX_CHARS": o.PROOFREAD_MAX_CHARS,
            "TIMEOUT_S": o.TIMEOUT_S,
        },
        "service_fields": [list(f) for f in o._SERVICE_FIELDS],
        "system_prompt": o._SYSTEM_PROMPT,
        "proofread_system_prompt": o._PROOFREAD_SYSTEM_PROMPT,
        "task_lines": o._task_lines(TASKS),
        "task_lines_empty": o._task_lines([]),
        "unquote": [[c, orig, o._unquote(c, orig)] for c, orig in QUOTES],
        "errors": sorted(
            c.__name__ for c in (o.OpenRouterNotConfiguredError, o.OpenRouterUpstreamError)
        ),
    }
    print(json.dumps(out, sort_keys=True, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
