"""Order-board campaign SURFACE helper: the introspected sections of tools/gen_surface_orders.sh.

Usage: probe_orders_surface.py routes|callables|zoho|schemas|ddl|permissions
Prints one section of the Order Board's public contract, from the imported app
(not from the source text, so reformatting a signature moves nothing). Sorted
output, no line numbers, no addresses: byte-reproducible.
"""

import dataclasses
import importlib
import inspect
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, ".")

MODULES = (
    "backend.app.api.routes.order_board",
    "backend.app.models.order_board_doc",
    "backend.app.services.order_board",
    "backend.app.services.order_board_actions",
    "backend.app.services.order_board_payment",
    "backend.app.services.order_board_prep_sheet",
    "backend.app.services.order_board_sync",
)


def signature(fn) -> str:
    return re.sub(r" at 0x[0-9a-f]+", "", str(inspect.signature(fn)))


def _required(route) -> str:
    """The permissions the route's dependencies check, read from the mounted app (not from the source)."""
    found = []
    for dep in route.dependant.dependencies:
        if getattr(dep.call, "__closure__", None):
            for value in inspect.getclosurevars(dep.call).nonlocals.values():
                items = value if isinstance(value, (list, tuple, set, frozenset)) else [value]
                found += [str(getattr(v, "value", v)) for v in items if isinstance(getattr(v, "value", v), str) and ":" in str(getattr(v, "value", v))]
    return ", ".join(sorted(set(found))) or "### NO PERMISSION FOUND"


def routes() -> None:
    """Method, path, handler, the permission its dependency checks and the response class."""
    from backend.app.main import app

    rows = [
        (r.path, method, r.endpoint.__name__, _required(r))
        for r in app.routes
        if hasattr(r, "methods") and "/order-board" in r.path
        for method in sorted(r.methods)
    ]
    for path, method, name, needs in sorted(rows):
        print(f"{method} {path}  ->  {name}  [{needs}]")
    print(f"{len(rows)} routes")


def callables() -> None:
    """Every public (non-underscore) function and class the seven backend modules define."""
    for name in MODULES:
        module = importlib.import_module(name)
        print(f"# {name}")
        for attr, obj in sorted(vars(module).items()):
            if attr.startswith("_") or getattr(obj, "__module__", None) != name:
                continue
            if inspect.isclass(obj):
                bases = ", ".join(b.__name__ for b in obj.__bases__)
                print(f"class {attr}({bases})")
                if dataclasses.is_dataclass(obj):
                    for f in dataclasses.fields(obj):
                        print(f"    {f.name}: {f.type if isinstance(f.type, str) else inspect.formatannotation(f.type)}")
                if hasattr(obj, "__table__"):
                    for column in obj.__table__.columns:
                        print(f"    {column.name}: {column.type} {'NULL' if column.nullable else 'NOT NULL'}")
                if hasattr(obj, "model_fields"):
                    for field, info in obj.model_fields.items():
                        print(f"    {field}: {inspect.formatannotation(info.annotation)}")
            elif inspect.isfunction(obj):
                kind = "async def" if inspect.iscoroutinefunction(obj) else "def"
                print(f"{kind} {attr}{signature(obj)}")
        source = Path(name.replace(".", "/") + ".py").read_text()
        constants = {a: v for a, v in vars(module).items() if re.search(rf"^{a} = ", source, re.M) and re.fullmatch(r"[A-Z][A-Z0-9_]+", a)}
        for attr, value in sorted(constants.items()):
            print(f"{attr} = {value!r}")
        print()


def zoho() -> None:
    """The ZohoService members the order modules call, with their signatures."""
    from backend.app.services.zoho import ZohoService

    used: dict[str, set[str]] = {}
    for name in MODULES:
        path = Path(name.replace(".", "/") + ".py")
        for member in re.findall(r"zoho_service\.(\w+)", path.read_text()):
            used.setdefault(member, set()).add(path.stem if "routes" not in name else "routes/" + path.stem)
    for member in sorted(used):
        obj = getattr(ZohoService, member, None)
        if inspect.isfunction(obj):
            kind = "async def" if inspect.iscoroutinefunction(obj) else "def"
            print(f"{kind} {member}{signature(obj)}   <- {', '.join(sorted(used[member]))}")
        else:
            print(f"attribute {member}   <- {', '.join(sorted(used[member]))}")
    print(f"{len(used)} members")


def schemas() -> None:
    from pydantic import BaseModel

    module = importlib.import_module(MODULES[0])
    out = {
        n: k.model_json_schema()
        for n, k in sorted(vars(module).items())
        if inspect.isclass(k) and issubclass(k, BaseModel) and k.__module__ == module.__name__
    }
    print(json.dumps(out, indent=1, sort_keys=True))


def ddl() -> None:
    from sqlalchemy.dialects import postgresql, sqlite
    from sqlalchemy.schema import CreateIndex, CreateTable

    import backend.app.main  # noqa: F401
    from backend.app.core.database import Base

    for dialect in (sqlite, postgresql):
        for name, table in sorted(Base.metadata.tables.items()):
            if name.startswith("order_board"):
                print(f"-- {dialect.__name__.rsplit('.', 1)[-1]}")
                print(str(CreateTable(table).compile(dialect=dialect.dialect())).strip() + ";")
                for index in sorted(table.indexes, key=lambda i: i.name or ""):
                    print(str(CreateIndex(index).compile(dialect=dialect.dialect())).strip() + ";")


def permissions() -> None:
    from backend.app.core import auth, permissions as p

    mine = [x for x in p.Permission if x.name.startswith("ORDERS_")]
    print(json.dumps({
        "values": {x.name: x.value for x in mine},
        "default_groups": {g: [x.value for x in mine if x.value in d["permissions"]] for g, d in sorted(p.DEFAULT_GROUPS.items())},
        "categories": {c: [x.value for x in mine if x in v] for c, v in p.PERMISSION_CATEGORIES.items() if any(x in v for x in mine)},
        "api_key_scope": {x.value: str(auth._APIKEY_SCOPE_BY_PERMISSION.get(x)) for x in mine},
        "api_key_denied": [x.value for x in mine if x in auth._APIKEY_DENIED_PERMISSIONS],
    }, indent=1, sort_keys=True))


SECTIONS = {f.__name__: f for f in (routes, callables, zoho, schemas, ddl, permissions)}
if len(sys.argv) != 2 or sys.argv[1] not in SECTIONS:
    sys.exit(f"usage: {sys.argv[0]} {'|'.join(SECTIONS)}")
try:
    SECTIONS[sys.argv[1]]()
except Exception as e:  # stderr is discarded by the generator: fail on stdout
    print(f"### SURFACE FAILURE in {sys.argv[1]}: {type(e).__name__}: {e}")
    sys.exit(1)
