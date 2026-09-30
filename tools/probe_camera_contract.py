"""Campaign-22 golden probe: the camera HTTP contract, structurally.

Same index shape as tools/probe_openapi.py (per operation: method, operationId,
parameters, request body ref, response refs; per schema: property names/types
and the required set) but restricted to the /camera operations and to the
component schemas they reference, plus the Pydantic models defined inside
routes/camera.py and the public method names of the grid-stream hub classes.
Anything a camera-wall client could notice moves this file.

Loop machinery, not app code — nothing in backend/ imports this.
"""

import inspect
import json
import sys

sys.path.insert(0, ".")
from pydantic import BaseModel  # noqa: E402

import backend.app.api.routes.camera as camera_routes  # noqa: E402
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


def collect_refs(node, acc):
    if isinstance(node, dict):
        if "$ref" in node:
            acc.add(node["$ref"].rsplit("/", 1)[-1])
        for v in node.values():
            collect_refs(v, acc)
    elif isinstance(node, list):
        for v in node:
            collect_refs(v, acc)


spec = app.openapi()
out = {"operations": {}, "schemas": {}, "route_models": {}, "hub_methods": {}, "websockets": []}
wanted = set()

for path in sorted(spec.get("paths", {})):
    if "/camera" not in path:
        continue
    for method in sorted(spec["paths"][path]):
        op = spec["paths"][path][method]
        if not isinstance(op, dict):
            continue
        collect_refs(op, wanted)
        params = sorted(
            f"{p.get('in')}:{p.get('name')}{'!' if p.get('required') else ''}" for p in op.get("parameters", [])
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

schemas = spec.get("components", {}).get("schemas", {})
# Follow nested refs so a schema referenced only through another one is included.
frontier = set(wanted)
while frontier:
    name = frontier.pop()
    if name in out["schemas"] or name not in schemas:
        continue
    schema = schemas[name]
    props = schema.get("properties", {})
    out["schemas"][name] = {
        "required": sorted(schema.get("required", [])),
        "properties": {p: ref(props[p]) for p in sorted(props)},
    }
    nested = set()
    collect_refs(schema, nested)
    frontier |= nested - set(out["schemas"])

for name, cls in sorted(vars(camera_routes).items()):
    if inspect.isclass(cls) and issubclass(cls, BaseModel) and cls.__module__ == camera_routes.__name__:
        out["route_models"][name] = {f: str(x.annotation) for f, x in sorted(cls.model_fields.items())}

for cls_name in ("SharedStreamHub", "_SharedStream", "_StreamState"):
    cls = getattr(camera_routes, cls_name, None)
    if cls is None:
        out["hub_methods"][cls_name] = None
        continue
    out["hub_methods"][cls_name] = sorted(
        n for n, m in vars(cls).items() if callable(m) and not n.startswith("__")
    )

out["websockets"] = sorted(r.path for r in app.routes if "/camera" in r.path and not hasattr(r, "methods"))

print(json.dumps(out, sort_keys=True, indent=1))
