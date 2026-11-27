"""Print queue campaign (Q1) golden probe: which permission guards each /queue route.

Read from the live app, not from the source text, so it survives the route module being
split: for every route under /api/v1/queue/ in registration order, its handler name and
each dependency ("door") with the Permission members its closure holds, sub-dependencies
included. Then the QUEUE_* permissions themselves: default groups, categories, API-key scope.
Loop tooling, not app code.
"""
import json
import sys

sys.path.insert(0, "tools")
import probe_queue_lib  # noqa: E402,F401  (temp DATA_DIR before the app is imported)

from fastapi.routing import APIRoute  # noqa: E402

from backend.app.core import auth as a  # noqa: E402
from backend.app.core import permissions as p  # noqa: E402
from backend.app.main import app  # noqa: E402


def perms(v):
    """Permissions a closure cell holds: members, their string values, or a list/tuple of either."""
    if isinstance(v, p.Permission):
        return [v.value]
    if isinstance(v, str):
        return [v] if v in VALUES else []
    if isinstance(v, (list, tuple, set, frozenset)):
        return sorted(x for i in v for x in perms(i))
    return []


VALUES = {x.value for x in p.Permission}


def held(call):
    """Permissions and flags in a dependency's closure, following a wrapped checker one level in."""
    out = {}
    for cell_name, cell in zip(getattr(getattr(call, "__code__", None), "co_freevars", ()), getattr(call, "__closure__", None) or ()):
        try:
            v = cell.cell_contents
        except ValueError:
            continue
        if perms(v):
            out[cell_name] = perms(v)
        elif isinstance(v, bool):
            out[cell_name] = v
        elif callable(v) and getattr(v, "__closure__", None) and v is not call:
            inner = held(v)
            if inner:
                out[cell_name] = inner
    return out


def door(d):
    name = getattr(d.call, "__qualname__", type(d.call).__name__)
    h = held(d.call)
    inner = [door(x) for x in d.dependencies if getattr(x.call, "__name__", "") != "get_db"]
    return name + (f" {json.dumps(h, sort_keys=True)}" if h else "") + (f" <- ({'; '.join(inner)})" if inner else "")


for r in app.routes:
    if isinstance(r, APIRoute) and r.path.startswith("/api/v1/queue/"):
        for m in sorted(r.methods):
            print(f"{m} {r.path} -> {r.endpoint.__name__}")
            for d in r.dependant.dependencies:
                if getattr(d.call, "__name__", "") != "get_db":
                    print(f"    {d.name}: {door(d)}")

P = [x for x in p.Permission if x.name.startswith("QUEUE_")]
print(json.dumps({
    "values": {x.name: x.value for x in P},
    "groups": {g: [x.value for x in P if x.value in d["permissions"]] for g, d in sorted(p.DEFAULT_GROUPS.items())},
    "categories": {c: [x.value for x in P if x in v] for c, v in p.PERMISSION_CATEGORIES.items() if any(x in v for x in P)},
    "apikey_scope": {x.value: str(a._APIKEY_SCOPE_BY_PERMISSION.get(x)) for x in P},
    "apikey_denied": [x.value for x in P if x in a._APIKEY_DENIED_PERMISSIONS],
}, indent=1, sort_keys=True))
