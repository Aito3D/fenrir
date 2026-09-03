"""Campaign-9 golden probe: the whole app's HTTP contract, structurally.

The raw OpenAPI document is ~89k lines -- too large to review as a golden
diff. This prints a compact INDEX that still changes whenever the contract
changes: per operation the method, operationId, sorted parameter names (with
required-ness and location), the request-body schema ref, and the response
codes with their schema refs; per component schema the sorted property names
with their types and the required set.

Anything an API client could notice moves this file. Formatting-only changes
inside a schema description do not.
"""
import json
import sys

sys.path.insert(0, ".")
from backend.app.main import app  # noqa: E402


def ref(node):
    """Collapse a schema node to a stable short name."""
    if not isinstance(node, dict):
        return None
    if "$ref" in node:
        return node["$ref"].rsplit("/", 1)[-1]
    if "items" in node:
        return f"[{ref(node['items'])}]"
    for key in ("anyOf", "oneOf", "allOf"):
        if key in node:
            return f"{key}({','.join(str(ref(x)) for x in node[key])})"
    return node.get("type")


spec = app.openapi()
out = {"operations": {}, "schemas": {}}

for path in sorted(spec.get("paths", {})):
    for method in sorted(spec["paths"][path]):
        op = spec["paths"][path][method]
        if not isinstance(op, dict):
            continue
        params = sorted(
            f"{p.get('in')}:{p.get('name')}{'!' if p.get('required') else ''}"
            for p in op.get("parameters", [])
        )
        body = op.get("requestBody", {}).get("content", {})
        responses = {
            code: ref(r.get("content", {}).get("application/json", {}).get("schema"))
            for code, r in sorted(op.get("responses", {}).items())
        }
        out["operations"][f"{method.upper()} {path}"] = {
            "operationId": op.get("operationId"),
            "params": params,
            "requestBody": {ct: ref(c.get("schema")) for ct, c in sorted(body.items())},
            "responses": responses,
            "security": bool(op.get("security")),
        }

for name, schema in sorted(spec.get("components", {}).get("schemas", {}).items()):
    props = schema.get("properties", {})
    out["schemas"][name] = {
        "required": sorted(schema.get("required", [])),
        "properties": {p: ref(props[p]) for p in sorted(props)},
    }

print(json.dumps(out, sort_keys=True, indent=1))
