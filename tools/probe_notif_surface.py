"""SURFACE.md sections for the notifications campaign that need Python (loop tooling, not app code).

  routes      every route under /notifications, /notification-templates, /user-notifications:
              method, path, handler, required permission(s) / door
  callables   public functions, classes and constants of the in-scope backend modules, with signatures
  schemas     Pydantic models of the in-scope schema modules: name and field list with types/defaults
  ddl         CREATE TABLE/INDEX of the tables the in-scope models own, SQLite and PostgreSQL
  permissions the notification permissions: values, default groups, categories, API-key scope
"""
import importlib
import inspect
import json
import pkgutil
import re
import sys

ADDR = re.compile(r" at 0x[0-9a-f]+")

sys.path.insert(0, ".")

MODULES = [
    "backend.app.api.routes.notifications",
    "backend.app.api.routes.notification_templates",
    "backend.app.api.routes.user_notifications",
    "backend.app.models.notification",
    "backend.app.models.notification_inbox",
    "backend.app.models.notification_live_activity",
    "backend.app.models.notification_lock_screen_widget",
    "backend.app.models.notification_template",
    "backend.app.schemas.notification",
    "backend.app.schemas.notification_template",
    "backend.app.schemas.user_notifications",
    "backend.app.services.notification_service",
    "backend.app.services.notify_client",
    "backend.app.services.notify_live_activities",
    "backend.app.services.notify_widgets",
    "backend.app.services.notify_worker",
    "backend.app.services.spool_assignment_notifications",
    "backend.app.utils.notification_photos",
]
PREFIXES = ("/api/v1/notifications", "/api/v1/notification-templates", "/api/v1/user-notifications")

what = sys.argv[1]
import backend.app.main as main_mod  # noqa: E402

if what == "routes":
    from fastapi.routing import APIRoute

    for r in main_mod.app.routes:
        if not isinstance(r, APIRoute) or not r.path.startswith(PREFIXES):
            continue
        doors = []
        for d in r.dependant.dependencies:
            call = d.call
            name = getattr(call, "__qualname__", repr(call))
            perms = [str(p) for p in getattr(call, "permissions", []) or []] or [str(getattr(call, "permission", ""))]
            closure = {}
            for cell_name, cell in zip(getattr(call, "__code__", None) and call.__code__.co_freevars or [], getattr(call, "__closure__", None) or []):
                try:
                    closure[cell_name] = cell.cell_contents
                except ValueError:
                    pass
            shown = {k: (str(v) if not callable(v) else getattr(v, "__name__", str(v))) for k, v in closure.items() if k in ("permission", "permissions", "perm_strings", "user_permission", "scope_attr", "scope_name", "owner_needs_permission")}
            doors.append(f"{name}{shown if shown else ''}")
        for m in sorted(r.methods):
            print(f"{m} {r.path}  -> {r.endpoint.__name__}  [{'; '.join(doors)}]")

elif what == "callables":
    for modname in MODULES:
        mod = importlib.import_module(modname)
        print(f"## {modname}")
        for name, obj in sorted(vars(mod).items()):
            if name.startswith("_") or getattr(obj, "__module__", None) != modname:
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

    for modname in [m for m in MODULES if ".schemas." in m]:
        mod = importlib.import_module(modname)
        print(f"## {modname}")
        for name, obj in sorted(vars(mod).items()):
            if inspect.isclass(obj) and issubclass(obj, BaseModel) and obj.__module__ == modname:
                print(f"class {name}({', '.join(b.__name__ for b in obj.__bases__)})")
                for fname, f in obj.model_fields.items():
                    default = "required" if f.is_required() else f"default={f.default!r}" if f.default_factory is None else f"default_factory={f.default_factory.__name__}"
                    print(f"    {fname}: {f.annotation!r}  {default}")
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

    P = [x for x in p.Permission if "NOTIF" in x.name]
    print(json.dumps({
        "values": [x.value for x in P],
        "groups": {g: [x.value for x in P if x.value in d["permissions"]] for g, d in sorted(p.DEFAULT_GROUPS.items())},
        "categories": {c: [x.value for x in P if x in v] for c, v in p.PERMISSION_CATEGORIES.items() if any(x in v for x in P)},
        "apikey_scope": {x.value: str(a._APIKEY_SCOPE_BY_PERMISSION.get(x)) for x in P},
        "apikey_denied": [x.value for x in P if x in a._APIKEY_DENIED_PERMISSIONS],
    }, indent=1, sort_keys=True))
