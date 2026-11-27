"""Print queue campaign (Q1) golden probe: the queue service helpers, called directly.

  queue_item_printer    PRINTER_RESOLVED_DEFAULTS and drop_printer_resolved over a table of keeps
  queue_events          the two WebSocket messages, that a broadcast gets its own copy, that a failing socket is swallowed
  queue_position        max / next position over queue states, and the advisory lock statement per dialect
  queue_trace_summary   attach_trace_summaries: resolved, partly linked, dangling ids, the slice job only while slicing
  queue_announcements   announce_queue_jobs_added: the notification text and target per printer group, the MQTT relay
                        event per job, and that neither a failing notification nor a failing query raises

Only the public names of each module are called, so private helpers may move. Run by pytest
(PROBES.json) with the backend test conftest as a plugin, for its throwaway database. Appends
to the JSON file named by $PROBE_OUT. Loop tooling, not app code.
"""

import json
import os
from types import SimpleNamespace

import pytest

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.app.schemas.print_queue import PrintQueueItemResponse
from backend.app.services import queue_announcements, queue_events, queue_item_printer, queue_position, queue_trace_summary

OUT = os.environ.get("PROBE_OUT", "/tmp/fenrir-queue-probe/services.json")
RESULTS: dict = {}


def _done(section, value):
    RESULTS[section] = value
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(json.dumps(RESULTS, indent=1, sort_keys=True, ensure_ascii=False, default=str) + "\n")


def test_item_printer():
    out = {"PRINTER_RESOLVED_DEFAULTS": queue_item_printer.PRINTER_RESOLVED_DEFAULTS, "drop": {}}
    for keep in ((), ("ams_mapping",), ("skip_filament_check", "nozzle_mapping"), ("nozzle_rack_choice", "unknown"), tuple(queue_item_printer.PRINTER_RESOLVED_DEFAULTS), iter(["ams_mapping"])):
        item = SimpleNamespace(ams_mapping="[1,2]", skip_filament_check=True, nozzle_mapping="[0]", nozzle_rack_choice='{"0": 1}', plate_id=3, use_ams=False, filament_overrides="[]")
        label = "iterator" if not isinstance(keep, tuple) else ",".join(keep) or "(nothing)"
        out["drop"][label] = {"returned": queue_item_printer.drop_printer_resolved(item, keep), "item": vars(item)}
    bare = SimpleNamespace()
    queue_item_printer.drop_printer_resolved(bare)
    out["drop"]["item without the fields"] = vars(bare)
    _done("queue_item_printer", out)


@pytest.mark.asyncio
async def test_events(monkeypatch):
    sent = []

    async def broadcast(message):
        sent.append(dict(message))
        message["tampered"] = True  # a receiver's change must not reach the module constant

    monkeypatch.setattr(queue_events.ws_manager, "broadcast", broadcast)
    out = {"QUEUE_CHANGED": dict(queue_events.QUEUE_CHANGED), "PENDING_UPLOADS_CHANGED": dict(queue_events.PENDING_UPLOADS_CHANGED)}
    out["returns"] = [await queue_events.notify_queue_changed(), await queue_events.notify_pending_uploads_changed(), await queue_events.notify_queue_changed()]
    out["sent"] = sent
    out["constants_after"] = [dict(queue_events.QUEUE_CHANGED), dict(queue_events.PENDING_UPLOADS_CHANGED)]

    async def broken(message):
        raise RuntimeError("socket gone")

    monkeypatch.setattr(queue_events.ws_manager, "broadcast", broken)
    out["failing_socket"] = [await queue_events.notify_queue_changed(), await queue_events.notify_pending_uploads_changed()]
    _done("queue_events", out)


@pytest.mark.asyncio
async def test_position(db_session):
    db = db_session
    out = {"QUEUE_POSITION_LOCK_KEY": queue_position.QUEUE_POSITION_LOCK_KEY, "states": []}

    async def snapshot(label):
        out["states"].append({"after": label, "max": await queue_position.max_queue_position(db), "next": await queue_position.next_queue_position(db), "lock": await queue_position.lock_queue_positions(db)})

    await snapshot("empty queue")
    for label, status, position in (("completed at 10", "completed", 10), ("pending at 3", "pending", 3), ("printing at 8", "printing", 8), ("slicing at 5", "slicing", 5),
                                    ("slice_failed at 7", "slice_failed", 7), ("cancelled at 99", "cancelled", 99), ("pending at 0", "pending", 0), ("pending at 7 again", "pending", 7)):
        db.add(PrintQueueItem(status=status, position=position))
        await db.commit()
        await snapshot(label)

    class FakeSession:
        def __init__(self, dialect):
            self.dialect, self.statements = dialect, []

        def get_bind(self):
            return SimpleNamespace(dialect=SimpleNamespace(name=self.dialect))

        async def execute(self, statement, params=None):
            self.statements.append({"sql": str(statement), "params": params})
            return SimpleNamespace(scalar=lambda: 41)

    out["lock_statements"] = {}
    for dialect in ("postgresql", "sqlite", "mysql"):
        fake = FakeSession(dialect)
        await queue_position.lock_queue_positions(fake)
        out["lock_statements"][dialect] = fake.statements
    fake = FakeSession("postgresql")
    out["next_on_postgresql"] = {"next": await queue_position.next_queue_position(fake), "statements": [s["sql"].replace("\n", " ") for s in fake.statements]}
    _done("queue_position", out)


def _response(id_, **kw):
    base = {"id": id_, "printer_id": None, "archive_id": None, "library_file_id": None, "position": id_, "scheduled_time": None, "require_previous_success": False,
            "auto_off_after": False, "manual_start": False, "status": "pending", "started_at": None, "completed_at": None, "error_message": None, "created_at": "2020-01-01T00:00:00"}
    return PrintQueueItemResponse(**{**base, **kw})


TRACE_FIELDS = ("revision_id", "aito_task_id", "status", "project_code", "project_name", "revision_item_name", "revision_number", "revision_status", "slice_job_id",
                "aito_task_title", "aito_client_name", "aito_due_date", "aito_quantity", "aito_board_column")


@pytest.mark.asyncio
async def test_trace_summary(db_session):
    db = db_session
    project = Project(name="Monster can holders", code="PRJ-0142")
    other = Project(name="Second project", code="PRJ-0200")
    db.add_all([project, other])
    await db.flush()
    lid = ProjectItem(project_id=project.id, section="impression", name="Can holder lid", name_key="can holder lid")
    body = ProjectItem(project_id=other.id, section="impression", name="Body", name_key="body")
    db.add_all([lid, body])
    await db.flush()
    rev = ProjectRevision(item_id=lid.id, number=3, status="valide", slice_job_id=77)
    rev2 = ProjectRevision(item_id=body.id, number=1, status="brouillon")
    order = AitoProject(description="Porte-canettes", board_column="print", client_name="Teva Marchand", due_date="2026-10-18")
    order2 = AitoProject(description="Sans client", board_column="done")
    db.add_all([rev, rev2, order, order2])
    await db.flush()
    task = AitoTask(project_id=order.id, title="Porte-canettes ×6", impression_quantity=6)
    task2 = AitoTask(project_id=order2.id, title="Autre")
    db.add_all([task, task2])
    await db.commit()

    rows = [
        _response(1), _response(2, revision_id=rev.id, aito_task_id=task.id), _response(3, revision_id=rev.id, status="slicing"), _response(4, revision_id=rev.id, status="slice_failed"),
        _response(5, revision_id=rev2.id, aito_task_id=task2.id), _response(6, aito_task_id=task.id), _response(7, revision_id=9999, aito_task_id=9999),
        _response(8, revision_id=9999, aito_task_id=task.id, project_name="kept as given", slice_job_id=5), _response(9, revision_id=rev.id, aito_task_id=9999, status="completed", slice_job_id=5),
    ]
    out = {"returned": await queue_trace_summary.attach_trace_summaries(db, iter(rows))}
    out["rows"] = [{f: getattr(r, f) for f in TRACE_FIELDS} for r in rows]
    out["empty_list"] = await queue_trace_summary.attach_trace_summaries(db, [])
    _done("queue_trace_summary", out)


@pytest.mark.asyncio
async def test_announcements(db_session, monkeypatch):
    from backend.app.services.mqtt_relay import mqtt_relay
    from backend.app.services.notification_service import notification_service

    db = db_session
    calls = []

    async def notified(**kwargs):
        calls.append({"call": "notify", **{k: v for k, v in kwargs.items() if k != "db"}})

    async def relayed(**kwargs):
        calls.append({"call": "relay", **kwargs})

    monkeypatch.setattr(notification_service, "on_queue_job_added", notified)
    monkeypatch.setattr(mqtt_relay, "on_queue_job_added", relayed)

    p1 = Printer(name="Zulu", ip_address="192.0.2.1", serial_number="PROBE0001", access_code="12345678", model="X1C")
    p2 = Printer(name="Alpha", ip_address="192.0.2.2", serial_number="PROBE0002", access_code="12345678", model="P1S")
    archives = [PrintArchive(filename=name, file_path=f"/nonexistent/{n}", file_size=1, status="completed") for n, name in enumerate(("lid.gcode.3mf", "body.3mf", "cap.stl", "ring.gcode.3mf", "base.3mf.3mf", ""))]
    lib = LibraryFile(filename="shelf.gcode.3mf", file_path="/nonexistent/shelf", file_size=1, file_type="3mf")
    db.add_all([p1, p2, lib, *archives])
    await db.flush()
    lid, body, cap, ring, base, unnamed = archives

    async def item(position, **kw):
        row = PrintQueueItem(status="pending", position=position, **kw)
        db.add(row)
        await db.flush()
        return row.id

    cases = {
        "one job on a printer": [await item(1, printer_id=p1.id, archive_id=lid.id)],
        "three copies of one file": [await item(n, printer_id=p1.id, archive_id=lid.id) for n in (2, 3, 4)],
        "two files": [await item(5, printer_id=p1.id, archive_id=lid.id), await item(6, printer_id=p1.id, archive_id=body.id)],
        "four files, one twice (listed up to three)": [await item(n, printer_id=p1.id, archive_id=a.id) for n, a in ((7, lid), (8, body), (9, cap), (10, ring), (11, lid))],
        "exactly three files": [await item(n, printer_id=p1.id, archive_id=a.id) for n, a in ((12, cap), (13, body), (14, base))],
        "two printers and unassigned in one add": [await item(15, printer_id=p2.id, archive_id=lid.id), await item(16, printer_id=p1.id, archive_id=body.id), await item(17, archive_id=cap.id), await item(18, printer_id=p2.id, archive_id=lid.id)],
        "any printer of a model": [await item(19, target_model="X1C", archive_id=lid.id)],
        "any printer of two models": [await item(20, target_model="X1C", archive_id=lid.id), await item(21, target_model="P1S", archive_id=lid.id), await item(22, target_model="X1C", archive_id=lid.id)],
        "unassigned without a model": [await item(23, archive_id=lid.id)],
        "library file": [await item(24, printer_id=p1.id, library_file_id=lib.id)],
        "archive wins over library file": [await item(25, printer_id=p1.id, archive_id=body.id, library_file_id=lib.id)],
        "no file at all (cross-model job)": [await item(26, target_model="X1C")],
        "empty file name": [await item(27, printer_id=p1.id, archive_id=unnamed.id)],
        "position order, not id order": [await item(40, printer_id=p1.id, archive_id=lid.id), await item(30, printer_id=p1.id, archive_id=body.id)],
    }
    await db.commit()
    cases["ids given in reverse"] = list(reversed(cases["two files"]))
    cases["the same id twice"] = cases["one job on a printer"] * 2
    cases["unknown ids"] = [9998, 9999]
    cases["known and unknown"] = [cases["one job on a printer"][0], 9999]
    cases["no ids"] = []
    cases["a tuple of ids"] = tuple(cases["two files"])

    out = {}
    for label, ids in cases.items():
        calls.clear()
        returned = await queue_announcements.announce_queue_jobs_added(db, ids)
        out[label] = {"ids": list(ids), "returned": returned, "calls": calls[:]}

    async def notify_fails(**kwargs):
        calls.append({"call": "notify (raises)", "job_name": kwargs["job_name"], "target": kwargs["target"]})
        raise RuntimeError("provider down")

    async def relay_fails(**kwargs):
        calls.append({"call": "relay (raises)", "job_id": kwargs["job_id"]})
        raise RuntimeError("broker down")

    monkeypatch.setattr(notification_service, "on_queue_job_added", notify_fails)
    monkeypatch.setattr(mqtt_relay, "on_queue_job_added", relay_fails)
    calls.clear()
    returned = await queue_announcements.announce_queue_jobs_added(db, cases["two printers and unassigned in one add"])
    out["both channels failing"] = {"returned": returned, "calls": calls[:]}

    class Broken:
        async def execute(self, *a, **k):
            raise RuntimeError("database gone")

    calls.clear()
    out["query failing"] = {"returned": await queue_announcements.announce_queue_jobs_added(Broken(), [1]), "calls": calls[:]}
    _done("queue_announcements", out)
