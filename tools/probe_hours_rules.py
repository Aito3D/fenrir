"""Campaign-31 golden probe: the Hours page's PURE backend rules.

Deterministic functions of their inputs in backend/app/services/printer_hours.py
and the route module's helpers — the counter formula, trust state and drift
threshold, added-on, recalibration offset, due-machine rule, the future-date
guard and the module constants. None of this is observable through the HTTP
probe for every edge, and all of it is what a refactor churns.
"""

import json
import sys
from datetime import date, datetime, timezone
from types import SimpleNamespace as NS

sys.path.insert(0, ".")

from fastapi import HTTPException  # noqa: E402

from backend.app.api.routes import printer_hours as routes  # noqa: E402
from backend.app.services import printer_hours as svc  # noqa: E402

out: dict = {}


def safe(fn):
    try:
        v = fn()
        return "__None__" if v is None else v
    except HTTPException as e:
        return {"__http__": e.status_code, "detail": e.detail}
    except Exception as e:  # noqa: BLE001
        return {"__threw__": f"{type(e).__name__}: {e}"}


out["constants"] = {
    "SOURCE_MANUAL": svc.SOURCE_MANUAL,
    "SOURCE_AUTO": svc.SOURCE_AUTO,
    "EVENT_KINDS": list(svc.EVENT_KINDS),
    "DRIFT_FLOOR_HOURS": svc.DRIFT_FLOOR_HOURS,
    "DRIFT_FRACTION": svc.DRIFT_FRACTION,
    "DEFAULT_READING_INTERVAL_DAYS": svc.DEFAULT_READING_INTERVAL_DAYS,
    "READINGS_DUE_KIND": svc.READINGS_DUE_KIND,
    "router_prefix": routes.router.prefix,
    "router_tags": list(routes.router.tags),
}

out["current_hours"] = [
    [args, svc.current_hours(*args)]
    for args in ((None, None), (0, 0.0), (3600, None), (None, 12.5), (3600 * 124, 10.0), (1800, 0.25), (-3600, 5.0))
]

cal = datetime(2026, 4, 20, tzinfo=timezone.utc)
machines = {
    "retired": NS(retired=True, calibrated_at=cal, last_drift_hours=100.0, printer_id=1),
    "uncalibrated": NS(retired=False, calibrated_at=None, last_drift_hours=50.0, printer_id=1),
    "calibrated_no_drift": NS(retired=False, calibrated_at=cal, last_drift_hours=None, printer_id=1),
    "drift_small": NS(retired=False, calibrated_at=cal, last_drift_hours=23.9, printer_id=1),
    "drift_at_floor": NS(retired=False, calibrated_at=cal, last_drift_hours=24.0, printer_id=1),
    "drift_over_floor": NS(retired=False, calibrated_at=cal, last_drift_hours=-24.1, printer_id=1),
    "drift_30": NS(retired=False, calibrated_at=cal, last_drift_hours=30.0, printer_id=1),
    "drift_minus_30": NS(retired=False, calibrated_at=cal, last_drift_hours=-30.0, printer_id=1),
}
out["trust_state"] = {
    name: {str(last): list(svc.trust_state(m, last)) for last in (None, 0.0, 1000.0, 1500.0, 2000.0)}
    for name, m in machines.items()
}

out["added_on"] = {
    "both_first_manual_older": str(svc.added_on(NS(printer_id=1), date(2024, 1, 1), date(2025, 1, 1))),
    "both_printer_older": str(svc.added_on(NS(printer_id=1), date(2025, 1, 1), date(2024, 1, 1))),
    "no_printer_id_ignores_created": str(svc.added_on(NS(printer_id=None), date(2025, 1, 1), date(2024, 1, 1))),
    "no_printer_id_no_manual": str(svc.added_on(NS(printer_id=None), None, date(2024, 1, 1))),
    "nothing": str(svc.added_on(NS(printer_id=1), None, None)),
    "only_created": str(svc.added_on(NS(printer_id=7), None, date(2024, 6, 1))),
}


def recal(runtime, total):
    p = NS(runtime_seconds=runtime, print_hours_offset=None)
    r = svc.recalibrate_printer(p, total)
    return {"runtime_hours": r, "offset": p.print_hours_offset}


out["recalibrate_printer"] = [[args, recal(*args)] for args in ((None, 100.0), (3600 * 100, 2629.0), (3600 * 100, 50.0), (0, 0.0), (1800, 0.5))]

today = date(2026, 5, 12)
ms = [NS(id=1, retired=False), NS(id=2, retired=False), NS(id=3, retired=True), NS(id=4, retired=False), NS(id=5, retired=False)]
rs = [
    NS(machine_id=1, source="manual", reading_date=date(2026, 5, 1)),
    NS(machine_id=1, source="manual", reading_date=date(2026, 1, 1)),
    NS(machine_id=2, source="manual", reading_date=date(2026, 2, 10)),  # 91 days before today
    NS(machine_id=2, source="auto", reading_date=date(2026, 5, 11)),  # auto never counts
    NS(machine_id=3, source="manual", reading_date=date(2025, 1, 1)),  # retired, never due
    NS(machine_id=4, source="manual", reading_date=date(2026, 2, 11)),  # exactly 90 days: not due
]
out["due_machine_ids"] = {
    "interval_90": svc.due_machine_ids(ms, rs, 90, today),
    "interval_7": svc.due_machine_ids(ms, rs, 7, today),
    "interval_365": svc.due_machine_ids(ms, rs, 365, today),
    "no_readings": svc.due_machine_ids(ms, [], 90, today),
    "no_machines": svc.due_machine_ids([], rs, 90, today),
}

out["_reject_future"] = {
    "today": safe(lambda: routes._reject_future(today, today)),
    "yesterday": safe(lambda: routes._reject_future(date(2026, 5, 11), today)),
    "tomorrow": safe(lambda: routes._reject_future(date(2026, 5, 13), today)),
    "next_year": safe(lambda: routes._reject_future(date(2027, 1, 1), today)),
}

print(json.dumps(out, indent=1, sort_keys=True, default=str))
