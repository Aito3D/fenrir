"""Golden probe: the tracking feature's wire contract.

Three operations — the public `GET /api/v1/aito/track/{token}` the page reads,
and the two AITO_UPDATE routes the detail panel's Copy / Regenerate buttons
call — plus every `AitoTracking*` model the payload is built from. The
frontend mirrors these field-for-field in TypeScript (api/client.ts), so a
renamed field, a widened type, a dropped response code or a security change on
the public route breaks the page against a real backend while every unit test
still passes on its own fixtures.

Prints each operation's parameters, response codes, and security flag, and per
model the property names with their types and the required set. Descriptions
are excluded, so rewording a docstring does not re-record the snapshot.

Invoked by PROBES.json as `./venv/bin/python3 tools/probe_tracking_contract.py`.
"""

import json
import os
import sys

sys.path.insert(0, os.getcwd())

from backend.app.main import app  # noqa: E402

OPERATIONS = [
    ("/api/v1/aito/track/{token}", "get"),
    ("/api/v1/aito/{project_id}/tracking-link", "get"),
    ("/api/v1/aito/{project_id}/tracking-token", "post"),
]


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
    if "format" in schema:
        return f"{kind}({schema['format']})"
    return kind


def main() -> None:
    spec = app.openapi()
    out: dict = {"operations": {}, "models": {}}

    for path, method in OPERATIONS:
        operation = spec["paths"][path][method]
        out["operations"][f"{method.upper()} {path}"] = {
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

    schemas = spec.get("components", {}).get("schemas", {})
    for name in sorted(schemas):
        if not name.startswith("AitoTracking"):
            continue
        model = schemas[name]
        out["models"][name] = {
            "required": sorted(model.get("required", [])),
            "properties": {prop: _type_of(body) for prop, body in sorted(model.get("properties", {}).items())},
        }

    print(json.dumps(out, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
