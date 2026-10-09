"""Campaign-24 golden probe: the Projects-PDM feature's HTTP contract, in full.

Prints every OpenAPI operation whose path belongs to the feature (any path
mentioning "project", the Aito task file-drop route, the task deliveries
route) verbatim — parameters, request body, responses, summary/description
(route docstrings are user-visible through the OpenAPI document) — plus the
transitive closure of component schemas those operations reference. A changed
field, default, status code, docstring or validator-driven constraint moves
this file.
"""
import json
import sys

sys.path.insert(0, ".")
from backend.app.main import app  # noqa: E402


def wanted(path: str) -> bool:
    lowered = path.lower()
    return "project" in lowered or path.endswith("/tasks/{task_id}/files") or "deliveries" in path


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
    if not wanted(path):
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
