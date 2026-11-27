"""Print queue campaign (Q1) golden probe: schemas/print_queue.py and the queue tables.

  1. every Pydantic model of backend.app.schemas.print_queue: bases, fields (annotation,
     default / required, constraints) and its JSON schema
  2. what the validators do, seen from outside: a table of inputs through model_validate
     (tri-state coercion, naive-UTC datetimes, null on required columns, reorder and batch
     rules, bounds) with the dumped model or the validation errors
  3. how the response serializes datetimes
  4. CREATE TABLE / CREATE INDEX of the tables models/print_queue.py declares, SQLite and PostgreSQL
Loop tooling, not app code.
"""
import importlib
import inspect
import json
import pkgutil
import re
import sys

sys.path.insert(0, "tools")
import probe_queue_lib  # noqa: E402,F401  (temp DATA_DIR before the app is imported)

from pydantic import BaseModel, ValidationError  # noqa: E402

import backend.app.schemas.print_queue as S  # noqa: E402

ADDR = re.compile(r" at 0x[0-9a-f]+")
models = {n: c for n, c in sorted(vars(S).items()) if inspect.isclass(c) and issubclass(c, BaseModel) and c.__module__ == S.__name__}

print("=== models")
for name, cls in models.items():
    print(f"class {name}({', '.join(b.__name__ for b in cls.__bases__)})")
    for fname, f in cls.model_fields.items():
        default = "required" if f.is_required() else f"default={f.default!r}" if f.default_factory is None else f"default_factory={f.default_factory.__name__}"
        print(ADDR.sub("", f"    {fname}: {f.annotation!r}  {default}  metadata={f.metadata!r}"))

print("=== json schemas")
print(json.dumps({n: c.model_json_schema() for n, c in models.items()}, sort_keys=True, indent=1))


def run(cls, data):
    try:
        m = models[cls].model_validate(data)
    except ValidationError as e:
        return {"errors": [{"loc": list(x["loc"]), "type": x["type"], "msg": x["msg"]} for x in e.errors()]}
    return {"ok": m.model_dump(mode="json", exclude_unset=True), "fields_set": sorted(m.model_fields_set)}


CASES = [
    ("PrintQueueItemCreate", {}),
    ("PrintQueueItemCreate", {"archive_id": 1, "bed_levelling": True, "flow_cali": False, "nozzle_offset_cali": "on"}),
    ("PrintQueueItemCreate", {"bed_levelling": 0, "flow_cali": 1, "nozzle_offset_cali": 2}),
    ("PrintQueueItemCreate", {"bed_levelling": "AUTO"}),
    ("PrintQueueItemCreate", {"bed_levelling": 3}),
    ("PrintQueueItemCreate", {"bed_levelling": None}),
    ("PrintQueueItemCreate", {"bed_levelling": "maybe"}),
    ("PrintQueueItemCreate", {"scheduled_time": "2026-05-01T10:00:00+02:00"}),
    ("PrintQueueItemCreate", {"scheduled_time": "2026-05-01T10:00:00Z"}),
    ("PrintQueueItemCreate", {"scheduled_time": "2026-05-01T10:00:00"}),
    ("PrintQueueItemCreate", {"scheduled_time": "not a date"}),
    ("PrintQueueItemCreate", {"scheduled_time": None}),
    ("PrintQueueItemCreate", {"preheat_override": "on", "preheat_chamber_target_override": 45}),
    ("PrintQueueItemCreate", {"preheat_override": "maybe"}),
    ("PrintQueueItemCreate", {"preheat_chamber_target_override": -1}),
    ("PrintQueueItemCreate", {"preheat_chamber_target_override": 1000}),
    ("PrintQueueItemCreate", {"quantity": 0}),
    ("PrintQueueItemCreate", {"quantity": 5000}),
    ("PrintQueueItemCreate", {"quantity": "3"}),
    ("PrintQueueItemCreate", {"ams_mapping": [0, -1, 3], "nozzle_rack_choice": {"1": 2}, "filament_overrides": [{"slot_id": 1, "type": "PLA"}]}),
    ("PrintQueueItemCreate", {"ams_mapping": "0,1"}),
    ("PrintQueueItemCreate", {"variants": [{"library_file_id": 4}, {"library_file_id": 5, "target_model": "H2D", "plate_id": 2}]}),
    ("PrintQueueItemCreate", {"variants": [{}]}),
    ("PrintQueueItemCreate", {"unknown_field": 1, "printer_id": "7"}),
    ("PrintQueueItemUpdate", {}),
    ("PrintQueueItemUpdate", {"manual_start": None, "timelapse": None, "bed_levelling": None, "printer_id": None, "scheduled_time": None}),
    ("PrintQueueItemUpdate", {"bed_levelling": True, "use_ams": False, "position": 3}),
    ("PrintQueueItemUpdate", {"add_copies": 998}),
    ("PrintQueueItemUpdate", {"add_copies": 999}),
    ("PrintQueueItemUpdate", {"add_copies": -1}),
    ("PrintQueueItemUpdate", {"add_copies": None}),
    ("PrintQueueItemUpdate", {"scheduled_time": "2026-05-01T10:00:00-10:00", "preheat_override": None}),
    ("PrintQueueReorder", {"items": []}),
    ("PrintQueueReorder", {"items": [{"id": 1, "position": 2}, {"id": 2, "position": 1}]}),
    ("PrintQueueReorder", {"items": [{"id": 1, "position": 1}, {"id": 1, "position": 2}]}),
    ("PrintQueueReorder", {"items": [{"id": 1, "position": 1}, {"id": 2, "position": 1}]}),
    ("PrintQueueReorder", {"items": [{"id": 1, "position": 0}]}),
    ("PrintQueueReorder", {"items": [{"id": 1, "position": -4}]}),
    ("PrintQueueReorder", {"items": [{"id": 1}]}),
    ("PrintQueueReorder", {}),
    ("PrintQueueBulkUpdate", {"item_ids": []}),
    ("PrintQueueBulkUpdate", {"item_ids": [1, 2], "timelapse": True, "bed_levelling": False, "vibration_cali": None}),
    ("PrintQueueBulkUpdate", {"timelapse": True}),
    ("PrintQueueBulkUpdate", {"item_ids": [1], "preheat_chamber_target_override": 500}),
    ("PrintQueueDuplicateRequest", {"item_ids": []}),
    ("PrintQueueDuplicateRequest", {"item_ids": [1, 1, 2]}),
    ("PrintQueueDuplicateRequest", {"item_ids": list(range(501))}),
    ("PrintBatchPlateTarget", {}),
    ("PrintBatchPlateTarget", {"plate_id": 2, "quantity_target": 0}),
    ("PrintBatchPlateTarget", {"quantity_target": 1000}),
    ("PrintBatchPlateTarget", {"quantity_target": -1}),
    ("PrintBatchCreate", {}),
    ("PrintBatchCreate", {"name": "b"}),
    ("PrintBatchCreate", {"name": "b", "archive_id": 1}),
    ("PrintBatchCreate", {"name": "b", "archive_id": 1, "library_file_id": 2}),
    ("PrintBatchCreate", {"name": "b", "item_ids": [1, 2]}),
    ("PrintBatchCreate", {"name": "b", "item_ids": [1], "archive_id": 1}),
    ("PrintBatchCreate", {"name": "b", "item_ids": []}),
    ("PrintBatchCreate", {"name": "b", "library_file_id": 1, "plates": [{"plate_id": 1, "quantity_target": 3}], "due_date": "2026-06-01T00:00:00Z", "notes": "n"}),
    ("PrintBatchCreate", {"name": "b", "library_file_id": 1, "external_source": "shopify", "external_ref": "#1079"}),
    ("PrintBatchCreate", {"name": "b", "library_file_id": 1, "external_source": "Shopify"}),
    ("PrintBatchCreate", {"name": "b", "library_file_id": 1, "external_source": "shopify"}),
    ("PrintBatchCreate", {"name": "b", "library_file_id": 1, "external_ref": "x"}),
    ("PrintBatchCreate", {"name": "b", "library_file_id": 1, "external_source": "", "external_ref": ""}),
    ("PrintBatchUpdate", {}),
    ("PrintBatchUpdate", {"name": None, "status": None, "notes": None, "due_date": None, "project_id": None}),
    ("PrintBatchUpdate", {"status": "cancelled"}),
    ("PrintBatchUpdate", {"status": "completed"}),
    ("PrintBatchDispatchRequest", {}),
    ("PrintBatchDispatchRequest", {"plate_id": 1, "only_plate": True, "limit": 999}),
    ("PrintBatchDispatchRequest", {"limit": 0}),
    ("PrintBatchDispatchRequest", {"limit": 1000}),
    ("QueueVariantCreate", {"library_file_id": 1, "nozzle_rack_choice": {"0": 1}, "ams_mapping": [1]}),
    ("ColorSubstitution", {"slot_id": 1, "type": "PLA", "wanted": "#fff", "got": "#000", "tray": 3}),
    ("ColorSubstitution", {"slot_id": 1}),
]
print("=== validation")
for cls, data in CASES:
    shown = data if len(json.dumps(data)) < 300 else "<long>"
    print(json.dumps({"model": cls, "input": shown, **run(cls, data)}, sort_keys=True))

print("=== response datetime serialization")
from datetime import datetime, timedelta, timezone  # noqa: E402

base = {"id": 1, "printer_id": None, "archive_id": None, "library_file_id": None, "position": 1, "require_previous_success": False,
        "auto_off_after": False, "manual_start": False, "status": "pending", "error_message": None}
for label, dt in (("none", None), ("naive", datetime(2026, 5, 1, 10, 0, 0)), ("utc", datetime(2026, 5, 1, 10, 0, 0, tzinfo=timezone.utc)),
                  ("offset", datetime(2026, 5, 1, 10, 0, 0, 123456, tzinfo=timezone(timedelta(hours=-10))))):
    r = S.PrintQueueItemResponse(**base, scheduled_time=dt, started_at=dt, completed_at=dt, created_at=dt or datetime(2026, 1, 1))
    d = r.model_dump(mode="json")
    print(label, json.dumps({k: d[k] for k in ("scheduled_time", "started_at", "completed_at", "created_at")}, sort_keys=True))
print("defaults", json.dumps(S.PrintQueueItemResponse(**base, scheduled_time=None, started_at=None, completed_at=None, created_at=datetime(2026, 1, 1)).model_dump(mode="json"), sort_keys=True))
try:
    S.PrintQueueItemResponse(**{**base, "status": "bogus"}, scheduled_time=None, started_at=None, completed_at=None, created_at=datetime(2026, 1, 1))
except ValidationError as e:
    print("bad status", [(x["loc"], x["type"]) for x in e.errors()])

print("=== ddl")
from sqlalchemy.dialects import postgresql, sqlite  # noqa: E402
from sqlalchemy.schema import CreateIndex, CreateTable  # noqa: E402

import backend.app.models as models_pkg  # noqa: E402
import backend.app.models.print_queue as M  # noqa: E402
from backend.app.core.database import Base  # noqa: E402

for mod in pkgutil.iter_modules(models_pkg.__path__):
    importlib.import_module(f"backend.app.models.{mod.name}")
print("constants", {n: v for n, v in sorted(vars(M).items()) if n.isupper() and isinstance(v, (str, int, tuple, frozenset))})
for tname in sorted(c.__tablename__ for c in vars(M).values() if inspect.isclass(c) and getattr(c, "__module__", "") == M.__name__ and hasattr(c, "__tablename__")):
    t = Base.metadata.tables[tname]
    for d in (sqlite, postgresql):
        print(f"-- {d.dialect.name}")
        print(str(CreateTable(t).compile(dialect=d.dialect())).strip() + ";")
        for i in sorted(t.indexes, key=lambda i: i.name or ""):
            print(str(CreateIndex(i).compile(dialect=d.dialect())).strip() + ";")
    print("columns", [(c.name, repr(c.default.arg) if c.default is not None and not callable(c.default.arg) else ("<callable>" if c.default is not None else None), str(c.server_default.arg) if c.server_default is not None else None) for c in t.columns])
for cname, cls in sorted(vars(M).items()):
    if inspect.isclass(cls) and getattr(cls, "__module__", "") == M.__name__ and hasattr(cls, "__mapper__"):
        print("relationships", cname, sorted((r.key, r.mapper.class_.__name__, r.direction.name, str(r.cascade), r.lazy) for r in cls.__mapper__.relationships))
