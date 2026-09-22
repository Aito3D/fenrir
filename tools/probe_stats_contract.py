"""Golden probe: the statistics endpoint's wire contract.

`GET /api/v1/aito/stats` answers with `AitoStatsResponse`, a tree of nineteen
`AitoStats*` models that the frontend mirrors field-for-field in TypeScript.
A renamed field, a widened type, a newly optional block or a dropped query
parameter is invisible to the aggregator probe (which reads the models it is
given) and invisible to the render tests (which build their own fixtures) —
but it breaks the page against a real backend.

This prints the operation's parameters and the fully resolved response schema
as a compact, sorted index: per model the property names with their types and
the required set. Descriptions are deliberately excluded, so rewording a
docstring does not re-record the snapshot.

Invoked by PROBES.json as `./venv/bin/python3 tools/probe_stats_contract.py`.
"""

import json
import os
import sys

sys.path.insert(0, os.getcwd())

from backend.app.main import app  # noqa: E402


def _type_of(schema: dict) -> str:
    """A short, stable spelling of a property's type."""
    if "$ref" in schema:
        return schema["$ref"].rsplit("/", 1)[-1]
    if "anyOf" in schema:
        return " | ".join(_type_of(s) for s in schema["anyOf"])
    if "allOf" in schema:
        return " & ".join(_type_of(s) for s in schema["allOf"])
    kind = schema.get("type", "any")
    if kind == "array":
        return f"array<{_type_of(schema.get('items', {}))}>"
    if "enum" in schema:
        return f"{kind}[{','.join(map(str, sorted(schema['enum'], key=str)))}]"
    return kind


def main() -> None:
    spec = app.openapi()
    out: dict = {}

    path = "/api/v1/aito/stats"
    operation = spec["paths"][path]["get"]
    out["operation"] = {
        "path": path,
        "operationId": operation.get("operationId"),
        "parameters": sorted(
            (
                {
                    "name": p["name"],
                    "in": p["in"],
                    "required": bool(p.get("required", False)),
                    "type": _type_of(p.get("schema", {})),
                }
                for p in operation.get("parameters", [])
            ),
            key=lambda p: (p["in"], p["name"]),
        ),
        "responses": {
            code: _type_of(body.get("content", {}).get("application/json", {}).get("schema", {}))
            for code, body in sorted(operation.get("responses", {}).items())
        },
        "security": operation.get("security"),
    }

    # Every component schema the stats tree is built from. Named by prefix
    # rather than walked from the root so a block that is dropped from the
    # response but left declared still shows up — an orphan model is a
    # refactoring loose end worth seeing.
    schemas = spec.get("components", {}).get("schemas", {})
    out["models"] = {}
    for name in sorted(schemas):
        if not name.startswith("AitoStats"):
            continue
        model = schemas[name]
        required = set(model.get("required", []))
        out["models"][name] = {
            "required": sorted(required),
            "properties": {
                prop: _type_of(body) for prop, body in sorted(model.get("properties", {}).items())
            },
        }

    print(json.dumps(out, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
