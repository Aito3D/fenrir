"""Print queue campaign (Q1) golden probe: the /queue HTTP scenario, end to end through the routes.

Run by pytest (PROBES.json) with the backend test conftest loaded as a plugin, so it gets the
suite's throwaway databases, the ASGI client and its autouse isolation, exactly as
backend/tests/integration/test_print_queue_api.py does. Auth is off (the suite default), so
every call is the anonymous all-permissions caller. No printer is connected: the one printer
call the scenario reaches (``printer_manager.stop_print``) is a recording stub that answers
"not sent", and httpx's real transports raise, so nothing can leave the machine. The
scheduler loop is never started.

Each step records method, url, request body, status and JSON body, plus what the route told
the outside world while it ran: WebSocket broadcasts, "job added" notifications, MQTT relay
events and scheduler nudges. Datetimes within a day of the wall clock become <NOW>; the fixed
dates the scenario seeds (2020 / 2031) stay as they are. Batch lists are shown sorted by id
(their own order is not stable within a second). Appended to the JSON file named by
$PROBE_OUT. Loop tooling, not app code. Not collected by the suite (it lives outside backend/tests).
"""

import asyncio
import json
import os
import re
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer

OUT = os.environ.get("PROBE_OUT", "/tmp/fenrir-queue-probe/http.json")
BASE = "/api/v1/queue"
RESULTS: list[dict] = []
ISO = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:\d{2})?Z?")


def _stable(value):
    """Datetimes the server stamped just now -> <NOW>; everything else untouched."""
    if isinstance(value, dict):
        return {k: _stable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_stable(v) for v in value]
    if isinstance(value, str):

        def swap(m):
            try:
                dt = datetime.fromisoformat(m.group(0).rstrip("Z").replace(" ", "T")[:19])
            except ValueError:
                return m.group(0)
            return "<NOW>" if abs(dt - datetime.now(timezone.utc).replace(tzinfo=None)) < timedelta(days=1) else m.group(0)

        return ISO.sub(swap, value)
    return value


def _plain(value):
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return f"<{type(value).__name__}>"


class Recorder:
    def __init__(self, client, monkeypatch, name):
        self.client, self.name, self.steps, self.events = client, name, [], []
        from backend.app.core.websocket import ws_manager
        from backend.app.services.mqtt_relay import mqtt_relay
        from backend.app.services.notification_service import notification_service
        from backend.app.services.print_scheduler import scheduler
        from backend.app.services.printer_manager import printer_manager

        def refuse(*a, **k):
            raise RuntimeError("probe: network blocked")

        monkeypatch.setattr(httpx.HTTPTransport, "handle_request", refuse)
        monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", refuse)

        def record(label, result=None, is_async=True):
            async def arecorder(*args, **kwargs):
                self.events.append({"call": label, "args": _plain(list(args)), "kwargs": _plain(kwargs)})
                return result

            def recorder(*args, **kwargs):
                self.events.append({"call": label, "args": _plain(list(args)), "kwargs": _plain(kwargs)})
                return result

            return arecorder if is_async else recorder

        monkeypatch.setattr(ws_manager, "broadcast", record("ws.broadcast"))
        monkeypatch.setattr(ws_manager, "send_archive_updated", record("ws.send_archive_updated"))
        monkeypatch.setattr(notification_service, "on_queue_job_added", record("notify.on_queue_job_added"))
        monkeypatch.setattr(mqtt_relay, "on_queue_job_added", record("mqtt_relay.on_queue_job_added"))
        monkeypatch.setattr(printer_manager, "stop_print", record("printer_manager.stop_print", False, is_async=False))
        for attr in ("notify_dispatch_cancelled", "wake"):
            if hasattr(scheduler, attr):
                monkeypatch.setattr(scheduler, attr, record(f"scheduler.{attr}", None, is_async=False))

    async def __call__(self, method, url, body=None, label=None):
        kwargs = {} if body is None else {"json": body}
        if os.environ.get("PROBE_TRACE"):
            print(f"[{self.name}] {label or url}", flush=True)
        # A hung route fails the probe here instead of stalling the whole verify.
        r = await asyncio.wait_for(getattr(self.client, method)(url, **kwargs), timeout=20)
        try:
            shown = r.json()
        except ValueError:
            shown = r.text
        # GET /batches orders by created_at alone, which SQLite stores to the second: batches made
        # within one second come back in no fixed order. The probe pins the set, by id.
        if method == "get" and isinstance(shown, list) and url.split("?")[0].endswith("/batches"):
            shown = sorted(shown, key=lambda b: b["id"])
        self.steps.append(
            {
                "step": label or f"{method.upper()} {url}",
                "request": f"{method.upper()} {url}",
                "request_body": body,
                "status": r.status_code,
                "body": _stable(shown),
                "side_effects": _stable(self.events[:]),
            }
        )
        self.events.clear()
        return r

    def done(self, extra=None):
        RESULTS.append({"scenario": self.name, "steps": self.steps, **(extra or {})})
        with open(OUT, "w", encoding="utf-8") as f:
            f.write(json.dumps(RESULTS, indent=1, sort_keys=True, ensure_ascii=False, default=str) + "\n")


async def _add(db, obj):
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return obj


async def _printer(db, n, **kw):
    return await _add(db, Printer(**{"name": f"Printer {n}", "ip_address": f"192.0.2.{n}", "serial_number": f"PROBE{n:04d}", "access_code": "12345678", "model": "X1C", **kw}))


async def _archive(db, n, **kw):
    defaults = {
        "filename": f"part_{n}.gcode.3mf", "print_name": f"Part {n}", "file_path": f"/nonexistent/fenrir-queue-probe/part_{n}.gcode.3mf",
        "file_size": 1024, "content_hash": f"probehash{n:08d}", "status": "completed", "print_time_seconds": 600 * n,
        "filament_used_grams": 12.5 * n, "filament_type": "PLA", "filament_color": "#FFFFFF", "sliced_for_model": "X1C",
    }
    return await _add(db, PrintArchive(**{**defaults, **kw}))


async def _library(db, n, **kw):
    defaults = {
        "filename": f"lib_{n}.gcode.3mf", "file_path": f"/nonexistent/fenrir-queue-probe/lib_{n}.gcode.3mf", "file_size": 2048, "file_type": "3mf",
        "file_metadata": {"print_name": f"Library Print {n}", "print_time_seconds": 3600 * n, "filament_used_grams": 30.0, "filament_type": "PETG"},
    }
    return await _add(db, LibraryFile(**{**defaults, **kw}))


ROW_COLUMNS = ("id", "position", "status", "printer_id", "target_model", "batch_id", "archive_id", "library_file_id", "ams_mapping",
               "skip_filament_check", "gate_acknowledged", "error_message", "manual_start")


async def _rows(db):
    """The queue as stored: what the HTTP bodies do not show (dispatch bookkeeping), in position order."""
    from sqlalchemy import select

    cols = [getattr(PrintQueueItem, c) for c in ROW_COLUMNS]
    result = await db.execute(select(*cols).order_by(PrintQueueItem.position, PrintQueueItem.id))
    return [dict(zip(ROW_COLUMNS, row)) for row in result.all()]


# --- 1. items: create, list, get, patch, reorder, bulk, duplicate, start, cancel, stop, delete ---------------------


@pytest.mark.asyncio
async def test_items(async_client, db_session, monkeypatch):
    rec = Recorder(async_client, monkeypatch, "items")
    db = db_session
    p1 = await _printer(db, 1)
    p2 = await _printer(db, 2, location="Lab", model="P1S")
    a1, a2, a3 = [await _archive(db, n) for n in (1, 2, 3)]
    lib1 = await _library(db, 1)

    await rec("get", f"{BASE}/", label="empty queue")
    await rec("get", f"{BASE}/history", label="empty history")
    await rec("get", f"{BASE}/batches", label="no batches")

    # creation paths
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "archive_id": a1.id}, "add: archive on a printer")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "library_file_id": lib1.id}, "add: library file on a printer")
    await rec("post", f"{BASE}/", {"target_model": "Bambu Lab X1C", "target_location": "Lab", "archive_id": a2.id, "required_filament_types": ["PLA", "PETG"],
                                   "filament_overrides": [{"slot_id": 1, "type": "PLA", "color": "#FF0000"}]}, "add: any printer of a model, with location and filaments")
    await rec("post", f"{BASE}/", {"archive_id": a3.id}, "add: unassigned")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "archive_id": a2.id, "quantity": 3}, "add: quantity 3 (auto batch)")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "archive_id": a3.id, "insert_at_top": True}, "add: at top")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "archive_id": a3.id, "insert_position": 2}, "add: at position 2")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "archive_id": a3.id, "insert_position": 999}, "add: position past the end")
    await rec("post", f"{BASE}/", {
        "printer_id": p1.id, "archive_id": a1.id, "manual_start": True, "scheduled_time": "2031-03-04T05:06:07+02:00", "require_previous_success": True,
        "auto_off_after": True, "ams_mapping": [0, -1, 2], "plate_id": 2, "bed_levelling": False, "flow_cali": True, "vibration_cali": False,
        "layer_inspect": True, "timelapse": True, "use_ams": False, "nozzle_offset_cali": "on", "confirm_outcome": True, "preheat_override": "on",
        "preheat_chamber_target_override": 45, "gcode_injection": True, "skip_filament_check": True, "nozzle_mapping": [0, 1], "nozzle_rack_choice": {"0": 3},
        "cleanup_library_after_dispatch": True, "estimated_cost": 4.2,
    }, "add: every option")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "target_model": "P1S", "archive_id": a1.id}, "add: printer and model together")
    await rec("post", f"{BASE}/", {"printer_id": p2.id, "archive_id": a1.id}, "add: file sliced for another model")
    await rec("post", f"{BASE}/", {"target_model": "C13", "archive_id": a1.id}, "add: model given as an internal code")
    await rec("post", f"{BASE}/", {"target_model": "X1C", "library_file_id": lib1.id, "target_location": "Nowhere"}, "add: model with no printer at the location")
    # refusals
    await rec("post", f"{BASE}/", {}, "add: no file")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "archive_id": 0, "library_file_id": 0}, "add: zero ids")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "archive_id": a1.id, "library_file_id": lib1.id}, "add: archive and library file together")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "archive_id": 9999}, "add: unknown archive")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "library_file_id": 9999}, "add: unknown library file")
    await rec("post", f"{BASE}/", {"printer_id": 9999, "archive_id": a1.id}, "add: unknown printer")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "archive_id": a1.id, "project_id": 9999}, "add: unknown project")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "archive_id": a1.id, "batch_id": 9999}, "add: unknown batch")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "archive_id": a1.id, "cost_center_id": 9999}, "add: unknown cost center")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "archive_id": a1.id, "aito_task_id": 9999}, "add: unknown aito task")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "archive_id": a1.id, "quantity": 0}, "add: quantity 0")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "archive_id": a1.id, "quantity": -3}, "add: negative quantity")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "archive_id": a1.id, "insert_position": 0}, "add: position 0")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "archive_id": a1.id, "bed_levelling": "maybe"}, "add: invalid option (422)")
    await rec("post", f"{BASE}/", {"printer_id": "x"}, "add: invalid type (422)")
    await rec("post", f"{BASE}/", {"target_model": "X1C", "variants": [{"library_file_id": lib1.id}]}, "add: a single cross-model variant")
    await rec("post", f"{BASE}/", {"variants": [{"library_file_id": lib1.id}, {"library_file_id": 9999}]}, "add: variant with an unknown file")
    lib_x1c = await _library(db, 2, file_metadata={"print_name": "Bracket X1C", "sliced_for_model": "X1C", "print_time_seconds": 1200})
    lib_p1s = await _library(db, 3, file_metadata={"print_name": "Bracket P1S", "sliced_for_model": "P1S", "print_time_seconds": 1500})
    await rec("post", f"{BASE}/", {"variants": [{"library_file_id": lib_x1c.id, "plate_id": 1, "ams_mapping": [0]}, {"library_file_id": lib_p1s.id}], "timelapse": True}, "add: cross-model job, two variants")
    await rec("post", f"{BASE}/", {"variants": [{"library_file_id": lib_x1c.id}, {"library_file_id": lib_x1c.id}]}, "add: the same variant twice")
    await rec("post", f"{BASE}/", {"variants": [{"library_file_id": lib_x1c.id}, {"library_file_id": 9999}]}, "add: variant file unknown")
    await rec("post", f"{BASE}/", {"variants": [{"library_file_id": lib_x1c.id}, {"library_file_id": lib_p1s.id, "target_model": "X1C"}]}, "add: two variants for one model")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "variants": [{"library_file_id": lib_x1c.id}, {"library_file_id": lib_p1s.id}]}, "add: variants on a named printer")

    # reads
    await rec("get", f"{BASE}/", label="list: all")
    for q in (f"printer_id={p1.id}", f"printer_id={p2.id}", "printer_id=-1", "printer_id=9999", "target_model=x1c", f"printer_id={p2.id}&target_model=X1C",
              "status=pending", "status=pending,printing", "status=completed", "status=bogus", "status=,", f"printer_id={p1.id}&status=pending&target_model=P1S"):
        r = await async_client.get(f"{BASE}/?{q}")
        rec.steps.append({"step": f"list ids: ?{q}", "status": r.status_code, "ids": [i["id"] for i in r.json()] if r.status_code == 200 else r.json()})
    await rec("get", f"{BASE}/?printer_id=abc", label="list: invalid printer (422)")
    await rec("get", f"{BASE}/1", label="get")
    await rec("get", f"{BASE}/9999", label="get: unknown")
    await rec("get", f"{BASE}/abc", label="get: not a number (422)")

    # edits
    await rec("patch", f"{BASE}/1", {"auto_off_after": True, "timelapse": True, "bed_levelling": "off", "plate_id": 3, "scheduled_time": "2031-01-02T03:04:05Z"}, "patch: options")
    await rec("patch", f"{BASE}/1", {"scheduled_time": None, "manual_start": None, "plate_id": None}, "patch: nulls")
    await rec("patch", f"{BASE}/1", {}, "patch: nothing")
    await rec("patch", f"{BASE}/1", {"ams_mapping": [1, 2], "skip_filament_check": True, "nozzle_mapping": [0], "nozzle_rack_choice": {"0": 1}}, "patch: printer-resolved settings")
    await rec("patch", f"{BASE}/1", {"plate_id": 4}, "patch: same printer keeps them")
    await rec("patch", f"{BASE}/1", {"printer_id": p2.id}, "patch: move to a printer of another model")
    await rec("patch", f"{BASE}/4", {"printer_id": p1.id, "ams_mapping": [3]}, "patch: assign a printer with a mapping")
    await rec("patch", f"{BASE}/4", {"printer_id": None, "target_model": "X1C", "target_location": "Lab"}, "patch: to any printer of a model")
    await rec("patch", f"{BASE}/4", {"target_location": None}, "patch: clear the location")
    await rec("patch", f"{BASE}/4", {"target_model": "H2D"}, "patch: model the file was not sliced for")
    await rec("patch", f"{BASE}/4", {"printer_id": 9999}, "patch: unknown printer")
    await rec("patch", f"{BASE}/4", {"position": 1}, "patch: position")
    await rec("patch", f"{BASE}/2", {"add_copies": 2, "timelapse": True}, "patch: add copies")
    await rec("patch", f"{BASE}/2", {"cost_center_id": 9999}, "patch: unknown cost center")
    await rec("patch", f"{BASE}/2", {"preheat_chamber_target_override": 500}, "patch: out of range (422)")
    await rec("patch", f"{BASE}/9999", {"timelapse": True}, "patch: unknown")

    # reorder
    ids = [i["id"] for i in (await async_client.get(f"{BASE}/?status=pending")).json()]
    await rec("post", f"{BASE}/reorder", {"items": [{"id": i, "position": n + 1} for n, i in enumerate(reversed(ids))]}, "reorder: reverse everything")
    await rec("post", f"{BASE}/reorder", {"items": [{"id": ids[0], "position": 1}, {"id": 9999, "position": 2}]}, "reorder: with an unknown id")
    await rec("post", f"{BASE}/reorder", {"items": [{"id": ids[0], "position": 1}, {"id": ids[1], "position": 1}]}, "reorder: duplicate positions (422)")
    await rec("post", f"{BASE}/reorder", {"items": []}, "reorder: nothing")
    await rec("post", f"{BASE}/reorder", {}, "reorder: no body fields (422)")
    rec.steps.append({"step": "stored after reorder", "rows": await _rows(db)})

    # states the routes cannot reach without a printer: seeded
    printing = await _add(db, PrintQueueItem(printer_id=p1.id, archive_id=a1.id, status="printing", position=0, started_at=datetime(2020, 1, 2, 3, 4, 5), auto_off_after=True))
    completed = await _add(db, PrintQueueItem(printer_id=p1.id, archive_id=a2.id, status="completed", position=0, started_at=datetime(2020, 1, 1, 1, 0, 0), completed_at=datetime(2020, 1, 1, 2, 0, 0)))
    dispatching = await _add(db, PrintQueueItem(printer_id=p1.id, archive_id=a2.id, status="pending", position=50, dispatching_at=datetime.now(timezone.utc).replace(tzinfo=None)))
    staged = await _add(db, PrintQueueItem(printer_id=p1.id, archive_id=a3.id, status="pending", position=51, manual_start=True))
    slicing = await _add(db, PrintQueueItem(printer_id=p1.id, library_file_id=lib1.id, status="slicing", position=52))
    slice_failed = await _add(db, PrintQueueItem(printer_id=p1.id, library_file_id=lib1.id, status="slice_failed", position=53, error_message="Slicer said no"))
    await rec("get", f"{BASE}/{printing.id}", label="get: printing")
    await rec("get", f"{BASE}/{slice_failed.id}", label="get: slice failed")
    await rec("patch", f"{BASE}/{printing.id}", {"timelapse": True}, "patch: printing item")
    await rec("patch", f"{BASE}/{completed.id}", {"timelapse": True}, "patch: completed item")
    await rec("patch", f"{BASE}/{dispatching.id}", {"printer_id": p2.id}, "patch: move an item being dispatched")
    await rec("patch", f"{BASE}/{dispatching.id}", {"plate_id": 9}, "patch: option on an item being dispatched")

    # bulk
    await rec("patch", f"{BASE}/bulk", {"item_ids": [ids[0], ids[1]], "timelapse": True, "bed_levelling": "on", "manual_start": True}, "bulk: options")
    await rec("patch", f"{BASE}/bulk", {"item_ids": [ids[0], printing.id, completed.id, 9999], "auto_off_after": True}, "bulk: pending, printing, completed, unknown")
    await rec("patch", f"{BASE}/bulk", {"item_ids": [ids[0], dispatching.id], "printer_id": p2.id}, "bulk: move, one being dispatched")
    await rec("patch", f"{BASE}/bulk", {"item_ids": [ids[1]], "printer_id": 9999}, "bulk: unknown printer")
    await rec("patch", f"{BASE}/bulk", {"item_ids": [ids[1]], "printer_id": None}, "bulk: unassign")
    await rec("patch", f"{BASE}/bulk", {"item_ids": [printing.id], "timelapse": False}, "bulk: nothing pending")
    await rec("patch", f"{BASE}/bulk", {"item_ids": [], "timelapse": True}, "bulk: no ids")
    await rec("patch", f"{BASE}/bulk", {"item_ids": [ids[0]]}, "bulk: no fields")
    await rec("patch", f"{BASE}/bulk", {"timelapse": True}, "bulk: ids missing (422)")
    await rec("patch", f"{BASE}/bulk", {"item_ids": [ids[0]], "manual_start": False, "scheduled_time": "2031-06-07T08:09:10"}, "bulk: schedule")

    # duplicate
    await rec("post", f"{BASE}/duplicate", {"item_ids": [ids[0], printing.id, completed.id, 9999]}, "duplicate: pending, printing, completed, unknown")
    await rec("post", f"{BASE}/duplicate", {"item_ids": [ids[2], ids[2]]}, "duplicate: same id twice")
    await rec("post", f"{BASE}/duplicate", {"item_ids": [completed.id]}, "duplicate: nothing duplicable")
    await rec("post", f"{BASE}/duplicate", {"item_ids": []}, "duplicate: no ids (422)")

    # start / cancel / stop / retry-slice / resume
    await rec("post", f"{BASE}/{staged.id}/start", label="start: staged item")
    await rec("post", f"{BASE}/{staged.id}/start", label="start: again")
    await rec("post", f"{BASE}/{staged.id}/start?skip_filament_check=true", label="start: print anyway")
    await rec("post", f"{BASE}/{printing.id}/start", label="start: printing item")
    await rec("post", f"{BASE}/{completed.id}/start", label="start: completed item")
    await rec("post", f"{BASE}/{slicing.id}/start", label="start: item waiting for its slice")
    await rec("post", f"{BASE}/9999/start", label="start: unknown")
    await rec("post", f"{BASE}/{slicing.id}/retry-slice", label="retry-slice: still slicing")
    await rec("post", f"{BASE}/{slice_failed.id}/retry-slice", label="retry-slice: failed slice without a revision")
    await rec("post", f"{BASE}/{staged.id}/retry-slice", label="retry-slice: pending item")
    await rec("post", f"{BASE}/9999/retry-slice", label="retry-slice: unknown")
    await rec("post", f"{BASE}/{staged.id}/stop", label="stop: pending item")
    await rec("post", f"{BASE}/9999/stop", label="stop: unknown")
    await rec("post", f"{BASE}/{printing.id}/stop", label="stop: printing item, printer not reachable")
    await rec("post", f"{BASE}/{printing.id}/stop", label="stop: again")
    await rec("get", f"{BASE}/{printing.id}", label="get: stopped item")
    await rec("post", f"{BASE}/{staged.id}/cancel", label="cancel: pending")
    await rec("post", f"{BASE}/{staged.id}/cancel", label="cancel: again")
    await rec("post", f"{BASE}/{slicing.id}/cancel", label="cancel: waiting for its slice")
    await rec("post", f"{BASE}/{completed.id}/cancel", label="cancel: completed")
    await rec("post", f"{BASE}/9999/cancel", label="cancel: unknown")

    failed = await _add(db, PrintQueueItem(printer_id=p1.id, archive_id=a1.id, status="failed", position=0, completed_at=datetime.now(timezone.utc).replace(tzinfo=None), error_message="Nozzle clog"))
    skipped = await _add(db, PrintQueueItem(printer_id=p1.id, archive_id=a1.id, status="skipped", position=0, require_previous_success=True, error_message="Previous print failed or was aborted"))
    skipped_model = await _add(db, PrintQueueItem(target_model="X1C", archive_id=a1.id, status="skipped", position=0, require_previous_success=True, error_message="Previous print failed or was aborted"))
    await rec("post", f"{BASE}/printer/{p1.id}/resume", label="resume: printer after a failure")
    await rec("post", f"{BASE}/printer/{p1.id}/resume", label="resume: printer, nothing left")
    await rec("post", f"{BASE}/printer/9999/resume", label="resume: unknown printer")
    await rec("post", f"{BASE}/model/x1c/resume", label="resume: model")
    await rec("post", f"{BASE}/model/NOPE/resume", label="resume: unknown model")
    rec.steps.append({"step": "stored after resume", "rows": [r for r in await _rows(db) if r["id"] in (failed.id, skipped.id, skipped_model.id)]})

    # delete
    await rec("delete", f"{BASE}/{ids[0]}", label="delete: pending")
    await rec("delete", f"{BASE}/{ids[0]}", label="delete: again")
    await rec("delete", f"{BASE}/{completed.id}", label="delete: completed")
    await rec("delete", f"{BASE}/{dispatching.id}", label="delete: item being dispatched")
    await rec("delete", f"{BASE}/9999", label="delete: unknown")
    await rec("get", f"{BASE}/", label="list: at the end")
    await rec("get", f"{BASE}/batches", label="batches: at the end")
    rec.steps.append({"step": "stored at the end", "rows": await _rows(db)})
    rec.done()


# --- 2. history: filters, sorts, paging, clear ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_history(async_client, db_session, monkeypatch):
    rec = Recorder(async_client, monkeypatch, "history")
    db = db_session
    p1 = await _printer(db, 1, name="Zulu", location="Lab")
    p2 = await _printer(db, 2, name="alpha", location="Shop")
    p3 = await _printer(db, 3, name="Mike")
    a = [await _archive(db, n, print_name=name) for n, name in ((1, "delta"), (2, "Alpha"), (3, "charlie"), (4, None))]
    lib = await _library(db, 1, file_metadata={"print_name": "bravo"})
    day = datetime(2020, 5, 1, 12, 0, 0)
    seeds = [
        ("completed", p1.id, a[0].id, None, 1, None, None), ("failed", p1.id, a[1].id, None, 2, None, "Nozzle clog"), ("skipped", p2.id, a[2].id, None, 3, None, "Previous print failed"),
        ("cancelled", p2.id, None, lib.id, 4, None, None), ("completed", None, a[3].id, None, 5, "X1C", None), ("completed", p3.id, a[0].id, None, 5, None, None),
        ("cancelled", None, a[1].id, None, None, "P1S", None), ("pending", p1.id, a[0].id, None, None, None, None), ("printing", p2.id, a[1].id, None, None, None, None),
    ]
    for status, printer_id, archive_id, library_file_id, offset, model, error in seeds:
        await _add(db, PrintQueueItem(
            status=status, printer_id=printer_id, archive_id=archive_id, library_file_id=library_file_id, target_model=model, position=0, error_message=error,
            target_location="Lab" if model == "P1S" else None,
            started_at=day + timedelta(days=offset, hours=-1) if offset else None, completed_at=day + timedelta(days=offset) if offset else None,
        ))

    rec.events.clear()  # the seeds' own scheduler nudges are not a route's doing

    await rec("get", f"{BASE}/history", label="history: default page")
    for q in ("sort_by=date", "sort_by=date&reverse=true", "sort_by=name", "sort_by=name&reverse=true", "sort_by=printer", "sort_by=printer&reverse=true",
              "limit=2", "limit=2&offset=2", "limit=2&offset=6", "offset=100", "status=completed", "status=failed", "status=skipped", "status=cancelled",
              "status=pending", "status=bogus", f"printer_id={p1.id}", f"printer_id={p2.id}&status=cancelled", "printer_id=-1", "printer_id=9999",
              "location=Lab", "location=Shop", "location=Nowhere", f"location=Lab&printer_id={p1.id}&status=failed&sort_by=name"):
        r = await async_client.get(f"{BASE}/history?{q}")
        body = r.json()
        rec.steps.append({"step": f"history ids: ?{q}", "status": r.status_code, "ids": [i["id"] for i in body["items"]], "total": body["total"], "locations": body["locations"]} if r.status_code == 200 else {"step": f"history: ?{q}", "status": r.status_code, "body": body})
    await rec("get", f"{BASE}/history?sort_by=size", label="history: unknown sort (422)")
    await rec("get", f"{BASE}/history?limit=0", label="history: limit 0 (422)")
    await rec("get", f"{BASE}/history?offset=-1", label="history: negative offset (422)")

    await rec("post", f"{BASE}/history/clear?status=bogus", label="clear: unknown status")
    await rec("post", f"{BASE}/history/clear?status=pending", label="clear: a status that is not history")
    await rec("post", f"{BASE}/history/clear?location=Nowhere", label="clear: nothing matches")
    await rec("post", f"{BASE}/history/clear?status=failed", label="clear: failed")
    await rec("post", f"{BASE}/history/clear?printer_id={p2.id}", label="clear: one printer")
    await rec("post", f"{BASE}/history/clear?printer_id=-1&location=Lab", label="clear: unassigned at a location")
    await rec("get", f"{BASE}/history?sort_by=name", label="history: after partial clears")
    await rec("post", f"{BASE}/history/clear", label="clear: everything")
    await rec("post", f"{BASE}/history/clear", label="clear: again")
    await rec("get", f"{BASE}/history", label="history: empty again")
    await rec("get", f"{BASE}/", label="queue: pending and printing untouched")
    rec.done()


# --- 3. batches: create, read, edit, dispatch, ungroup, cancel -----------------------------------------------------


@pytest.mark.asyncio
async def test_batches(async_client, db_session, monkeypatch):
    rec = Recorder(async_client, monkeypatch, "batches")
    db = db_session
    p1 = await _printer(db, 1)
    a1, a2 = await _archive(db, 1), await _archive(db, 2)
    lib1 = await _library(db, 1)
    for n in (1, 2, 3):
        await rec("post", f"{BASE}/", {"printer_id": p1.id, "archive_id": a1.id if n < 3 else a2.id}, f"queue item {n}")
    await rec("post", f"{BASE}/", {"target_model": "X1C", "library_file_id": lib1.id}, "queue item 4 (any X1C, library file)")

    await rec("post", f"{BASE}/batches", {"name": "Empty", "archive_id": a1.id}, "create: empty batch for an archive")
    await rec("post", f"{BASE}/batches", {"name": "Grouped", "item_ids": [1, 2]}, "create: from queue items")
    await rec("post", f"{BASE}/batches", {"name": "Order", "library_file_id": lib1.id, "plates": [{"plate_id": 1, "plate_name": "Lid", "quantity_target": 3}, {"plate_id": 2, "quantity_target": 2, "sort_order": 1}],
                                         "due_date": "2031-02-03T00:00:00Z", "notes": "Rush", "external_source": "shopify", "external_ref": "#1079"}, "create: order with plate targets and an external ref")
    await rec("post", f"{BASE}/batches", {"name": "Order again", "library_file_id": lib1.id, "external_source": "shopify", "external_ref": "#1079"}, "create: same external ref (conflict)")
    await rec("post", f"{BASE}/batches", {"name": "  "}, "create: blank name")
    await rec("post", f"{BASE}/batches", {"name": "No source"}, "create: no file and no items")
    await rec("post", f"{BASE}/batches", {"name": "Both", "archive_id": a1.id, "library_file_id": lib1.id}, "create: archive and library file")
    await rec("post", f"{BASE}/batches", {"name": "Ghost", "archive_id": 9999}, "create: unknown archive")
    await rec("post", f"{BASE}/batches", {"name": "Ghost", "library_file_id": 9999}, "create: unknown library file")
    await rec("post", f"{BASE}/batches", {"name": "Mixed", "item_ids": [3, 4]}, "create: items of different files")
    await rec("post", f"{BASE}/batches", {"name": "Taken", "item_ids": [1]}, "create: an item already in a batch")
    await rec("post", f"{BASE}/batches", {"name": "Ghost", "item_ids": [9999]}, "create: unknown item")
    await rec("post", f"{BASE}/batches", {"name": "P", "archive_id": a1.id, "project_id": 9999}, "create: unknown project")
    await rec("post", f"{BASE}/batches", {"name": "Dup plates", "archive_id": a1.id, "plates": [{"plate_id": 1}, {"plate_id": 1}]}, "create: the same plate twice")
    await rec("post", f"{BASE}/batches", {"name": "Half ref", "archive_id": a1.id, "external_source": "shopify"}, "create: external source without ref (422)")
    await rec("post", f"{BASE}/batches", {}, "create: no name (422)")

    await rec("get", f"{BASE}/batches", label="list")
    for q in ("status=active", "status=cancelled", "status=bogus", "project_id=9999", "external_source=shopify&external_ref=%231079", "external_source=shopify", "include_completed=true"):
        r = await async_client.get(f"{BASE}/batches?{q}")
        rec.steps.append({"step": f"batch ids: ?{q}", "status": r.status_code, "ids": sorted(b["id"] for b in r.json()) if r.status_code == 200 and isinstance(r.json(), list) else r.json()})
    await rec("get", f"{BASE}/batches/2", label="get: grouped")
    await rec("get", f"{BASE}/batches/9999", label="get: unknown")
    await rec("get", f"{BASE}/batches/abc", label="get: not a number (422)")

    await rec("patch", f"{BASE}/batches/1", {"name": "Renamed", "notes": "Careful", "due_date": "2031-04-05T06:07:08Z"}, "patch: name, notes, due date")
    await rec("patch", f"{BASE}/batches/1", {"notes": None, "due_date": None, "name": None}, "patch: nulls")
    await rec("patch", f"{BASE}/batches/1", {"name": " "}, "patch: blank name")
    await rec("patch", f"{BASE}/batches/1", {"plates": [{"plate_id": 1, "quantity_target": 2}]}, "patch: give it plate targets")
    await rec("patch", f"{BASE}/batches/3", {"plates": [{"plate_id": 1, "plate_name": "Lid", "quantity_target": 1}, {"plate_id": 3, "quantity_target": 4}]}, "patch: change plate targets")
    await rec("patch", f"{BASE}/batches/1", {"project_id": 9999}, "patch: unknown project")
    await rec("patch", f"{BASE}/batches/1", {"status": "completed"}, "patch: status not allowed (422)")
    await rec("patch", f"{BASE}/batches/9999", {"name": "x"}, "patch: unknown")

    await rec("post", f"{BASE}/batches/3/dispatch", {"limit": 1}, "dispatch: no run to copy settings from yet")
    await rec("post", f"{BASE}/", {"target_model": "X1C", "library_file_id": lib1.id, "plate_id": 1, "batch_id": 3, "timelapse": True, "bed_levelling": "off"}, "queue plate 1 of the order once")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "library_file_id": lib1.id, "plate_id": 3, "batch_id": 3, "ams_mapping": [2]}, "queue plate 3 of the order once")
    await rec("post", f"{BASE}/batches/3/dispatch", {"limit": 1}, "dispatch: one of the order")
    await rec("post", f"{BASE}/batches/3/dispatch", {"plate_id": 3, "only_plate": True, "limit": 2}, "dispatch: two of one plate")
    await rec("post", f"{BASE}/batches/3/dispatch", {"plate_id": 99, "only_plate": True}, "dispatch: plate with no target")
    await rec("post", f"{BASE}/batches/3/dispatch", {}, "dispatch: the rest")
    await rec("post", f"{BASE}/batches/3/dispatch", {}, "dispatch: nothing left")
    await rec("post", f"{BASE}/batches/2/dispatch", {}, "dispatch: a batch without targets")
    await rec("post", f"{BASE}/batches/3/dispatch", {"limit": 0}, "dispatch: limit 0 (422)")
    await rec("post", f"{BASE}/batches/9999/dispatch", {}, "dispatch: unknown")
    await rec("get", f"{BASE}/batches/3", label="get: order after dispatch")
    r = await async_client.get(f"{BASE}/")
    rec.steps.append({"step": "queue after dispatch", "items": [{k: i[k] for k in ("id", "position", "status", "printer_id", "target_model", "batch_id", "batch_name", "plate_id", "library_file_id", "archive_id")} for i in r.json()]})

    await rec("post", f"{BASE}/batches/2/ungroup", label="ungroup")
    await rec("post", f"{BASE}/batches/2/ungroup", label="ungroup: again")
    await rec("post", f"{BASE}/batches/9999/ungroup", label="ungroup: unknown")
    await rec("patch", f"{BASE}/batches/1", {"status": "cancelled"}, "patch: cancel")
    await rec("patch", f"{BASE}/batches/1", {"status": "active"}, "patch: reactivate")
    await rec("delete", f"{BASE}/batches/3", label="cancel the order")
    await rec("delete", f"{BASE}/batches/3", label="cancel: again")
    await rec("delete", f"{BASE}/batches/9999", label="cancel: unknown")
    await rec("post", f"{BASE}/batches/3/dispatch", {}, "dispatch: cancelled batch")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "archive_id": a1.id, "batch_id": 3}, "add an item to a cancelled batch")
    await rec("post", f"{BASE}/", {"printer_id": p1.id, "archive_id": a1.id, "batch_id": 1}, "add an item to an active batch")
    await rec("get", f"{BASE}/batches", label="list: at the end")
    await rec("get", f"{BASE}/batches?status=cancelled", label="list: cancelled")
    rec.steps.append({"step": "stored at the end", "rows": await _rows(db)})
    rec.done()
