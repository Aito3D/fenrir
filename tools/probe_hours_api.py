"""Campaign-31 golden probe: the Hours page's REST API, end to end over HTTP.

Drives the real FastAPI app through httpx's ASGI transport against a fresh
in-memory SQLite database (same get_db override and module-level session
patches as backend/tests/conftest.py's async_client fixture). Auth is off
because the database has no users, exactly as in the integration tests.

The sequence covers what the operator observes on the Hours tab: the overview
built from the printers table (one machine per printer, live counter, trust,
due list), back-dated and today's readings (today's recalibrates the printer
and writes the auto snapshot), the sanity refusals (future date, unknown
machine, out-of-range hours, empty batch), deleting a day's readings, the
sheet import (new retired machines by key, unknown key), machine edits
(name/model/purchase), note events and their removal, the reading-interval
setting, and retiring/deleting machines.

Today's date, tomorrow's and every timestamp are replaced by placeholders
before printing so the golden is stable from one day to the next.
"""

import asyncio
import json
import re
import sys
from datetime import date, datetime, time, timedelta
from unittest.mock import patch

sys.path.insert(0, ".")

from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402

import backend.app.main  # noqa: E402,F401  (registers every model on Base.metadata)
from backend.app.core.database import Base, get_db  # noqa: E402
from backend.app.main import app  # noqa: E402
from backend.app.models.printer import Printer  # noqa: E402

B = "/api/v1/maintenance/hours"


async def main() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sm = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def override_get_db():
        async with sm() as session:
            try:
                yield session
                await session.commit()
            except BaseException:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = override_get_db
    out = []

    def rec(step, r):
        ct = r.headers.get("content-type", "")
        entry = {"step": step, "status": r.status_code}
        entry["body"] = None if not r.content else (r.json() if ct.startswith("application/json") else r.text[:300])
        out.append(entry)
        return entry["body"]

    # Noon local today: the DB default (CURRENT_TIMESTAMP, UTC) would date the 'added' event tomorrow on
    # evenings west of UTC, while the scrub below only knows the local date.
    seeded_at = datetime.combine(date.today(), time(12))
    async with sm() as s:
        for i, (name, model, runtime, offset) in enumerate(
            (("X1C04", "X1C", 3600 * 124, 10.0), ("P1S01", "P1S", 3600 * 50, 0.0), ("H2D-02", "H2D", 0, 0.0)), 1
        ):
            s.add(Printer(name=name, model=model, serial_number=f"00M09A{i:09d}", ip_address=f"192.168.1.{100 + i}", access_code="12345678", is_active=True, auto_archive=True, runtime_seconds=runtime, print_hours_offset=offset, created_at=seeded_at))
        await s.commit()

    today = date.today()
    today_iso = today.isoformat()
    tomorrow_iso = (today + timedelta(days=1)).isoformat()

    with (
        patch("backend.app.core.database.async_session", sm),
        patch("backend.app.core.auth.async_session", sm),
        patch("backend.app.main.async_session", sm),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            ov = rec("01-overview-from-printers", await c.get(B))
            by_name = {m["name"]: m["id"] for m in ov["machines"]}
            x1, p1, h2 = by_name["X1C04"], by_name["P1S01"], by_name["H2D-02"]
            rec("02-backdated-readings", await c.post(f"{B}/readings", json={"reading_date": "2026-01-15", "entries": [{"machine_id": x1, "hours": 900}, {"machine_id": p1, "hours": 10}]}))
            rec("03-backdated-readings-2", await c.post(f"{B}/readings", json={"reading_date": "2026-03-01", "entries": [{"machine_id": x1, "hours": 1000.5}]}))
            rec("04-reading-today-recalibrates", await c.post(f"{B}/readings", json={"reading_date": today_iso, "entries": [{"machine_id": x1, "hours": 2629}]}))
            rec("05-reading-today-resave-same", await c.post(f"{B}/readings", json={"reading_date": today_iso, "entries": [{"machine_id": x1, "hours": 2629}]}))
            rec("06-reading-future-refused", await c.post(f"{B}/readings", json={"reading_date": tomorrow_iso, "entries": [{"machine_id": x1, "hours": 3000}]}))
            rec("07-reading-unknown-machine", await c.post(f"{B}/readings", json={"reading_date": "2026-02-01", "entries": [{"machine_id": 9999, "hours": 1}]}))
            rec("08-reading-negative-hours", await c.post(f"{B}/readings", json={"reading_date": "2026-02-01", "entries": [{"machine_id": x1, "hours": -1}]}))
            rec("09-reading-too-many-hours", await c.post(f"{B}/readings", json={"reading_date": "2026-02-01", "entries": [{"machine_id": x1, "hours": 10**9}]}))
            rec("10-reading-empty-batch", await c.post(f"{B}/readings", json={"reading_date": "2026-02-01", "entries": []}))
            rec("11-reading-bad-date", await c.post(f"{B}/readings", json={"reading_date": "15/01/2026", "entries": [{"machine_id": x1, "hours": 1}]}))
            rec("12-reading-null-deletes-cell", await c.post(f"{B}/readings", json={"reading_date": "2026-01-15", "entries": [{"machine_id": p1, "hours": None}]}))
            rec("13-delete-day", await c.delete(f"{B}/readings", params={"reading_date": "2026-03-01"}))
            rec("14-delete-day-missing", await c.delete(f"{B}/readings", params={"reading_date": "2020-01-01"}))
            rec("15-delete-day-no-param", await c.delete(f"{B}/readings"))
            rec("16-import", await c.post(f"{B}/import", json={
                "new_machines": [{"key": "X1C old", "name": "X1C old", "model": "X1C"}, {"key": "Total", "name": "Total", "model": None}],
                "readings": [
                    {"key": "X1C old", "reading_date": "2025-06-01", "hours": 400},
                    {"key": "X1C old", "reading_date": "2025-12-01", "hours": 420},
                    {"machine_id": p1, "reading_date": "2025-12-01", "hours": 5},
                    {"key": "Total", "reading_date": "2025-12-01", "hours": 425},
                ],
            }))
            rec("17-import-unknown-key", await c.post(f"{B}/import", json={"new_machines": [], "readings": [{"key": "nope", "reading_date": "2025-06-01", "hours": 1}]}))
            rec("18-import-unknown-machine", await c.post(f"{B}/import", json={"new_machines": [], "readings": [{"machine_id": 9999, "reading_date": "2025-06-01", "hours": 1}]}))
            rec("19-import-future", await c.post(f"{B}/import", json={"new_machines": [], "readings": [{"machine_id": p1, "reading_date": tomorrow_iso, "hours": 1}]}))
            rec("20-import-empty", await c.post(f"{B}/import", json={"new_machines": [], "readings": []}))
            rec("21-import-duplicate-key", await c.post(f"{B}/import", json={"new_machines": [{"key": "X1C old", "name": "X1C old", "model": "X1C"}], "readings": [{"key": "X1C old", "reading_date": "2025-07-01", "hours": 410}]}))
            ov = rec("22-overview-after-import", await c.get(B))
            old = next(m["id"] for m in ov["machines"] if m["name"] == "X1C old")
            total = next(m["id"] for m in ov["machines"] if m["name"] == "Total")
            rec("23-patch-machine", await c.patch(f"{B}/machines/{old}", json={"name": "X1C ancienne", "model": "X1C", "purchase_price": 1199.99, "purchase_date": "2023-05-04"}))
            rec("24-patch-machine-clear", await c.patch(f"{B}/machines/{old}", json={"model": None, "purchase_price": None, "purchase_date": None}))
            rec("25-patch-machine-blank-name", await c.patch(f"{B}/machines/{old}", json={"name": ""}))
            rec("26-patch-machine-negative-price", await c.patch(f"{B}/machines/{old}", json={"purchase_price": -5}))
            rec("27-patch-machine-missing", await c.patch(f"{B}/machines/9999", json={"name": "x"}))
            rec("28-patch-live-machine", await c.patch(f"{B}/machines/{x1}", json={"name": "renamed", "purchase_price": 1500}))
            ev = rec("29-add-note-event", await c.post(f"{B}/machines/{x1}/events", json={"event_date": "2026-02-02", "label": "Nozzle changed"}))
            rec("30-add-note-event-future", await c.post(f"{B}/machines/{x1}/events", json={"event_date": tomorrow_iso, "label": "later"}))
            rec("31-add-note-event-blank", await c.post(f"{B}/machines/{x1}/events", json={"event_date": "2026-02-02", "label": ""}))
            rec("32-add-note-event-missing-machine", await c.post(f"{B}/machines/9999/events", json={"event_date": "2026-02-02", "label": "x"}))
            rec("33-add-note-event-retired-machine", await c.post(f"{B}/machines/{old}/events", json={"event_date": "2025-08-01", "label": "stored"}))
            rec("34-delete-event", await c.delete(f"{B}/events/{ev['id']}"))
            rec("35-delete-event-again", await c.delete(f"{B}/events/{ev['id']}"))
            rec("36-settings-interval", await c.patch(f"{B}/settings", json={"reading_interval_days": 30}))
            rec("37-settings-interval-too-short", await c.patch(f"{B}/settings", json={"reading_interval_days": 6}))
            rec("38-settings-interval-too-long", await c.patch(f"{B}/settings", json={"reading_interval_days": 366}))
            rec("39-settings-interval-missing", await c.patch(f"{B}/settings", json={}))
            rec("40-delete-live-machine-refused", await c.delete(f"{B}/machines/{x1}"))
            rec("41-delete-retired-machine", await c.delete(f"{B}/machines/{total}"))
            rec("42-delete-machine-again", await c.delete(f"{B}/machines/{total}"))
            rec("43-delete-machine-missing", await c.delete(f"{B}/machines/9999"))
            rec("44-overview-final", await c.get(B))
            rec("45-h2d-untouched", await c.get(B))
            _ = h2

    text = json.dumps(out, indent=1, sort_keys=True, default=str)
    text = re.sub(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|\+00:00)?", "<TIMESTAMP>", text)
    text = text.replace(tomorrow_iso, "<TOMORROW>").replace(today_iso, "<TODAY>")
    print(text)


asyncio.run(main())
