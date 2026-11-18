"""SURFACE sections for the Order Board campaign (O3) that need Python (loop tooling, not app code).

  routes      every route under /api/v1/order-board, in registration order: method, path, handler, doors
  callables   public functions, classes and constants of the in-scope backend modules, with signatures
              (for the two packages: every name in __all__, wherever it is defined)
  schemas     Pydantic models the routes declare or take (route modules + the Aito schemas they reuse)
  ddl         CREATE TABLE/INDEX of order_board_docs / order_board_events, SQLite and PostgreSQL
  permissions ORDERS_* permissions: default groups, categories, API-key scope
  settings    defaults of OrderBoardSettings and the settings keys the scope reads
"""
import ast
import importlib
import inspect
import json
import pkgutil
import re
import sys

ADDR = re.compile(r" at 0x[0-9a-f]+")

sys.path.insert(0, ".")

MODULES = [
    "backend.app.api.routes.order_board",
    "backend.app.api.routes.order_board._common",
    "backend.app.api.routes.order_board.board",
    "backend.app.api.routes.order_board.fulfilment",
    "backend.app.api.routes.order_board.payment",
    "backend.app.api.routes.order_board.tracking",
    "backend.app.models.order_board_doc",
    "backend.app.models.order_board_event",
    "backend.app.services.order_board",
    "backend.app.services.order_board_events",
    "backend.app.services.order_board_payment",
    "backend.app.services.order_board_prep_sheet",
    "backend.app.services.order_board_sms",
    "backend.app.services.order_board_tracking",
    "backend.app.services.order_board_actions",
    "backend.app.services.order_board_sync",
]
PACKAGES = ("backend.app.services.order_board_actions", "backend.app.services.order_board_sync")
SCHEMA_MODULES = [m for m in MODULES if ".routes." in m] + ["backend.app.schemas.aito"]
SCHEMA_EXTRA = {"backend.app.schemas.aito": {"AitoNoteCreate", "AitoPaymentLinkView", "AitoTerminalPaymentView"}}
PREFIXES = ("/api/v1/order-board",)

sys.path.insert(0, "tools")
import probe_orders_lib  # noqa: E402,F401  (temp DATA_DIR before the app is imported)

what = sys.argv[1]
import backend.app.main as main_mod  # noqa: E402

if what == "routes":
    from fastapi.routing import APIRoute

    for r in main_mod.app.routes:
        if not isinstance(r, APIRoute) or not r.path.startswith(PREFIXES):
            continue
        def door(d):
            call = d.call
            name = getattr(call, "__qualname__", type(call).__name__)
            closure = {}
            for cell_name, cell in zip(getattr(call, "__code__", None) and call.__code__.co_freevars or [], getattr(call, "__closure__", None) or []):
                try:
                    closure[cell_name] = cell.cell_contents
                except ValueError:
                    pass
            shown = {k: (str(v) if not callable(v) else getattr(v, "__name__", str(v))) for k, v in closure.items() if k in ("permission", "permissions", "perm_strings", "user_permission", "scope_attr", "scope_name", "owner_needs_permission")}
            # sub-dependencies too: cloud_caller's permission door sits one level down
            inner = [door(x) for x in d.dependencies if getattr(x.call, "__name__", "") != "get_db"]
            return f"{name}{shown if shown else ''}" + (f" <- ({'; '.join(inner)})" if inner else "")

        doors = [door(d) for d in r.dependant.dependencies]
        for m in sorted(r.methods):
            print(f"{m} {r.path}  -> {r.endpoint.__name__}  [{'; '.join(doors)}]")

elif what == "callables":
    for modname in MODULES:
        mod = importlib.import_module(modname)
        print(f"## {modname}")
        if modname in PACKAGES:
            for name in sorted(mod.__all__):
                obj = getattr(mod, name)
                if inspect.isclass(obj):
                    print(f"class {name}({', '.join(b.__name__ for b in obj.__bases__)})")
                elif inspect.isfunction(obj):
                    print(ADDR.sub("", f"{'async ' if inspect.iscoroutinefunction(obj) else ''}def {name}{inspect.signature(obj)}"))
                elif isinstance(obj, (str, int, float, tuple, frozenset)):
                    print(f"{name} = {obj!r}")
                else:
                    print(f"{name}: {type(obj).__name__}")
            print()
            continue
        # constants carry no __module__: keep the ones this module assigns, not the ones it imports
        assigned = {t.id for n in ast.parse(inspect.getsource(mod)).body if isinstance(n, (ast.Assign, ast.AnnAssign)) for t in (n.targets if isinstance(n, ast.Assign) else [n.target]) if isinstance(t, ast.Name)}
        for name, obj in sorted(vars(mod).items()):
            if name.startswith("_") or getattr(obj, "__module__", modname if name in assigned else None) != modname:
                continue
            if inspect.isclass(obj):
                bases = ", ".join(b.__name__ for b in obj.__bases__)
                print(f"class {name}({bases})")
                for mname, m in sorted(vars(obj).items()):
                    if mname.startswith("_") and mname not in ("__init__",):
                        continue
                    if inspect.isfunction(m) or isinstance(m, (classmethod, staticmethod)):
                        f = m.__func__ if isinstance(m, (classmethod, staticmethod)) else m
                        try:
                            print(f"    {'async ' if inspect.iscoroutinefunction(f) else ''}def {mname}{inspect.signature(f)}")
                        except (TypeError, ValueError):
                            print(f"    def {mname}(...)")
            elif inspect.isfunction(obj):
                try:
                    print(ADDR.sub("", f"{'async ' if inspect.iscoroutinefunction(obj) else ''}def {name}{inspect.signature(obj)}"))
                except (TypeError, ValueError):
                    print(f"def {name}(...)")
            elif isinstance(obj, (str, int, float, tuple, frozenset)) or (isinstance(obj, (set, dict, list)) and len(repr(obj)) < 400):
                print(f"{name} = {obj!r}" if not isinstance(obj, (set, frozenset)) else f"{name} = {sorted(obj)!r}")
            else:
                print(f"{name}: {type(obj).__name__}")
        print()

elif what == "schemas":
    from pydantic import BaseModel

    for modname in SCHEMA_MODULES:
        mod = importlib.import_module(modname)
        print(f"## {modname}")
        for name, obj in sorted(vars(mod).items()):
            if modname in SCHEMA_EXTRA and name not in SCHEMA_EXTRA[modname]:
                continue
            if inspect.isclass(obj) and issubclass(obj, BaseModel) and obj.__module__ == modname:
                print(f"class {name}({', '.join(b.__name__ for b in obj.__bases__)})")
                for fname, f in obj.model_fields.items():
                    default = "required" if f.is_required() else f"default={f.default!r}" if f.default_factory is None else f"default_factory={f.default_factory.__name__}"
                    print(ADDR.sub("", f"    {fname}: {f.annotation!r}  {default}"))
        print()

elif what == "ddl":
    from sqlalchemy.dialects import postgresql, sqlite
    from sqlalchemy.schema import CreateIndex, CreateTable

    import backend.app.models as models_pkg
    from backend.app.core.database import Base

    for mod in pkgutil.iter_modules(models_pkg.__path__):
        importlib.import_module(f"backend.app.models.{mod.name}")
    tables = set()
    for modname in [m for m in MODULES if ".models." in m]:
        mod = importlib.import_module(modname)
        for obj in vars(mod).values():
            if inspect.isclass(obj) and hasattr(obj, "__tablename__") and obj.__module__ == modname:
                tables.add(obj.__tablename__)
    for tname in sorted(tables):
        t = Base.metadata.tables[tname]
        for d in (sqlite, postgresql):
            print(f"-- {d.dialect.name}")
            print(str(CreateTable(t).compile(dialect=d.dialect())).strip() + ";")
            for i in sorted(t.indexes, key=lambda i: i.name or ""):
                print(str(CreateIndex(i).compile(dialect=d.dialect())).strip() + ";")
        print()

elif what == "permissions":
    from backend.app.core import auth as a
    from backend.app.core import permissions as p

    P = [x for x in p.Permission if x.name.startswith("ORDERS_")]
    print(json.dumps({
        "values": [x.value for x in P],
        "groups": {g: [x.value for x in P if x.value in d["permissions"]] for g, d in sorted(p.DEFAULT_GROUPS.items())},
        "categories": {c: [x.value for x in P if x in v] for c, v in p.PERMISSION_CATEGORIES.items() if any(x in v for x in P)},
        "apikey_scope": {x.value: str(a._APIKEY_SCOPE_BY_PERMISSION.get(x)) for x in P},
        "apikey_denied": [x.value for x in P if x in a._APIKEY_DENIED_PERMISSIONS],
    }, indent=1, sort_keys=True))

elif what == "settings":
    import dataclasses
    import subprocess

    from backend.app.services.order_board_sync import OrderBoardSettings

    print("OrderBoardSettings:", [(f.name, str(f.type)) + (() if f.default is dataclasses.MISSING else (f.default,)) for f in dataclasses.fields(OrderBoardSettings)])
    keys = subprocess.run(
        ["grep", "-rhoE", r'"(order_board|orders)_[a-z_]+"', "backend/app/services", "backend/app/api/routes/order_board"],
        capture_output=True, text=True,
    ).stdout.split()
    print("keys:", sorted(set(keys)))
