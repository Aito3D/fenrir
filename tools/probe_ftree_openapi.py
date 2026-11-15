"""Filament-tree campaign (F1) golden probe: the /filament-trees HTTP contract, in full.

Every OpenAPI operation under /api/v1/filament-trees verbatim (parameters, request body,
responses, summary/description) plus the transitive closure of the component schemas
they reference. A changed field, default, status code, docstring or constraint moves it.
"""
import json
import sys

sys.path.insert(0, "tools")
import probe_ftree_lib  # noqa: E402,F401  (temp DATA_DIR before the app is imported)

from backend.app.main import app  # noqa: E402


def refs(node, acc: set):
    if isinstance(node, dict):
        if "$ref" in node:
            acc.add(node["$ref"].rsplit("/", 1)[-1])
        for v in node.values():
            refs(v, acc)
    elif isinstance(node, list):
        for v in node:
            refs(v, acc)


spec = app.openapi()
schemas = spec.get("components", {}).get("schemas", {})
ops = {}
pending: set = set()
for path in sorted(spec.get("paths", {})):
    if not path.startswith("/api/v1/filament-trees"):
        continue
    for method in sorted(spec["paths"][path]):
        op = spec["paths"][path][method]
        if isinstance(op, dict):
            ops[f"{method.upper()} {path}"] = op
            refs(op, pending)

closure = {}
while pending:
    name = pending.pop()
    if name in closure or name not in schemas:
        continue
    closure[name] = schemas[name]
    refs(schemas[name], pending)

print(json.dumps({"operations": ops, "schemas": closure}, sort_keys=True, indent=1))
