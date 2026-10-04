# Printer Hours History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third Maintenance tab, **Hours**, where the operator records each machine's lifetime hours by date (typed or pasted from Google Sheets). Fenrir snapshots its own counter daily. The tab charts per-machine curves, hours per month and the fleet total.

**Architecture:** Two new tables (`hour_machines`, `hour_readings`) in `models/maintenance.py`. Logic lives in a service `services/printer_hours.py`, which owns the machine sync, upserts, snapshot and hourly scheduler. A new route module `routes/printer_hours.py` sits under `/api/v1/maintenance/hours`. The frontend adds a pure `utils/hoursSeries.ts` (parsing, interpolation, monthly buckets, colours) and five components in `components/maintenance/hours/`, mounted as a third tab in `MaintenancePage.tsx`.

**Tech Stack:** FastAPI + SQLAlchemy async (SQLite), Pydantic v2, pytest/xdist; React 19, TanStack Query, recharts 3, i18next (15 locales), Vitest + msw.

**Spec:** `docs/superpowers/specs/2026-10-04-printer-hours-design.md`

## Global Constraints

- Work only in the worktree `/Users/paultheis/Documents/Code/bambuddy/.claude/worktrees/printer-hours` (branch `printer-hours`). Never `git stash`, never `git add -A`; add files by path.
- Python: `./venv/bin/python3` (the worktree's `venv` symlink), line length 120, Ruff rules E,W,F,I,B,C4,UP,ARG,SIM, double quotes, Python 3.10 compatible (no `datetime.UTC`).
- Run vitest from `frontend/`, one file per command: `cd frontend && npx vitest run <file>`.
- No new `Permission` member: reads use `MAINTENANCE_READ`, writes `MAINTENANCE_UPDATE`, deletes `MAINTENANCE_DELETE`.
- **Recalibration happens only for a manual reading whose `reading_date` equals the server's `date.today()`.** Backdated readings and imports never touch `print_hours_offset`.
- The New reading form lists only machines with `retired == false`. Retired machines are created and corrected only through the paste import.
- "Today" in the UI is always the server's `today` from `GET /maintenance/hours`, never the browser's date.
- Every new i18n key gets a real translation in all 15 locale files (`en de es fr it ja ko nl pt-BR ru sv tr uk zh-CN zh-TW`). No English copied into other locales, and no `{{count}}` plurals.
- Bundle baseline is Safari 16: no regex lookbehind.
- Do not run `npm run build` until Task 10 (it dirties the tracked `static/`). Do not commit `static/`.
- Never touch the root `bambuddy.db`; manual checks use a copy (Task 10).

## Review Focus

1. **Server and browser disagree on "today".** The container may run UTC while the shop is UTC-10. A reading typed in the afternoon must still recalibrate, and must never 422 as "future". The form takes `today` from the API (Task 7/8 test: the form's default date equals the API's `today`, not `new Date()`).
2. **The sheet's `Total` column and blank header cells.** They must not become retired machines. Unmatched columns default to *Ignore* unless the header looks like a printer name (Task 6 test: `planImport` ignores `Total` and an empty header).
3. **French number formats in pasted cells**: `1 470`, `1 470` (narrow NBSP), `471,5`, and `1,470` as a thousands separator. All must parse to the right number (Task 6 tests on `parseHoursCell`).
4. **A deleted printer whose id SQLite reuses.** The old history must not attach to the new printer (Task 1 test: serial mismatch retires the old machine and creates a new one).
5. **Concurrent machine sync.** The hourly snapshot and a GET both creating the same machine row must not 500 (Task 1 test: `ensure_hour_machines` recovers from an `IntegrityError`).

---

## File Map

| File | Responsibility |
|---|---|
| `backend/app/models/maintenance.py` (modify) | `HourMachine`, `HourReading` models |
| `backend/app/models/__init__.py` (modify) | export the two names |
| `backend/app/services/printer_hours.py` (create) | `current_hours`, `recalibrate_printer`, `ensure_hour_machines`, `upsert_reading`, `snapshot_today`, `PrinterHoursService` scheduler |
| `backend/app/schemas/maintenance.py` (modify) | hours request/response schemas |
| `backend/app/api/routes/maintenance.py` (modify) | use `current_hours`/`recalibrate_printer`; extract `notify_maintenance_attention` |
| `backend/app/api/routes/printer_hours.py` (create) | `/maintenance/hours` routes |
| `backend/app/main.py` (modify) | include router, start/stop scheduler |
| `backend/tests/unit/test_printer_hours_service.py` (create) | service tests |
| `backend/tests/integration/test_printer_hours_api.py` (create) | route tests |
| `frontend/src/api/client.ts` (modify) | types + 5 API functions |
| `frontend/src/utils/hoursSeries.ts` (create) | pure parsing / series maths / colours / import planning |
| `frontend/src/components/maintenance/hours/HoursTab.tsx` (create) | data, state, layout, mutations |
| `frontend/src/components/maintenance/hours/MachineList.tsx` (create) | left list / chips |
| `frontend/src/components/maintenance/hours/HoursChart.tsx` (create) | three chart modes |
| `frontend/src/components/maintenance/hours/ReadingLog.tsx` (create) | per-date log |
| `frontend/src/components/maintenance/hours/ReadingFormModal.tsx` (create) | new/edit reading |
| `frontend/src/components/maintenance/hours/PasteImportModal.tsx` (create) | paste import |
| `frontend/src/pages/MaintenancePage.tsx` (modify) | third tab |
| `frontend/src/i18n/locales/*.ts` (modify ×15) | `maintenance.hours.*` |
| `frontend/src/__tests__/utils/hoursSeries.test.ts` (create) | util tests |
| `frontend/src/__tests__/components/HoursTab.test.tsx` (create) | component tests |

---

### Task 1: Models and service core

**Files:**
- Modify: `backend/app/models/maintenance.py`
- Modify: `backend/app/models/__init__.py`
- Create: `backend/app/services/printer_hours.py`
- Test: `backend/tests/unit/test_printer_hours_service.py`

**Interfaces:**
- Produces:
  - `HourMachine(id, printer_id: int|None, name, model: str|None, serial_number: str|None, retired: bool, created_at)`.
  - `HourReading(id, machine_id, reading_date: date, hours: float, source: str, created_at, updated_at)`.
  - Service functions:
    - `current_hours(runtime_seconds: int|None, offset_hours: float|None) -> float`
    - `recalibrate_printer(printer: Printer, total_hours: float) -> float` (returns runtime hours; caller commits)
    - `async ensure_hour_machines(db) -> list[HourMachine]` (commits; call it before staging other writes)
    - `async upsert_reading(db, machine_id: int, reading_date: date, source: str, hours: float|None) -> None` (`None` deletes; no commit)
    - `async snapshot_today(db, today: date|None = None) -> int` (commits)
  - Constants `SOURCE_MANUAL = "manual"`, `SOURCE_AUTO = "auto"`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/unit/test_printer_hours_service.py`:

```python
"""Unit tests for the printer hours service (Maintenance → Hours tab)."""

from datetime import date

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from backend.app.models.maintenance import HourMachine, HourReading
from backend.app.services import printer_hours
from backend.app.services.printer_hours import (
    SOURCE_AUTO,
    SOURCE_MANUAL,
    current_hours,
    ensure_hour_machines,
    recalibrate_printer,
    snapshot_today,
    upsert_reading,
)


def test_current_hours_adds_runtime_and_offset():
    assert current_hours(7200, 10.5) == pytest.approx(12.5)
    assert current_hours(None, None) == 0.0


def test_recalibrate_sets_offset_and_never_goes_negative():
    class P:
        runtime_seconds = 3600 * 100
        print_hours_offset = 0.0

    p = P()
    assert recalibrate_printer(p, 4102.0) == pytest.approx(100.0)
    assert p.print_hours_offset == pytest.approx(4002.0)
    recalibrate_printer(p, 50.0)
    assert p.print_hours_offset == 0.0


@pytest.mark.asyncio
async def test_ensure_creates_one_machine_per_printer_and_syncs_names(db_session, printer_factory):
    p = await printer_factory(name="X1C04", model="X1C")
    machines = await ensure_hour_machines(db_session)
    assert [(m.printer_id, m.name, m.model, m.retired) for m in machines] == [(p.id, "X1C04", "X1C", False)]

    p.name = "X1C04-renamed"
    await db_session.commit()
    machines = await ensure_hour_machines(db_session)
    assert len(machines) == 1
    assert machines[0].name == "X1C04-renamed"


@pytest.mark.asyncio
async def test_ensure_retires_machine_of_deleted_printer(db_session, printer_factory):
    p = await printer_factory(name="H2S02", model="H2S")
    [m] = await ensure_hour_machines(db_session)
    await db_session.delete(p)
    await db_session.commit()

    machines = await ensure_hour_machines(db_session)
    assert [(x.id, x.printer_id, x.retired) for x in machines] == [(m.id, None, True)]


@pytest.mark.asyncio
async def test_ensure_retires_on_serial_mismatch_instead_of_hijacking(db_session, printer_factory):
    """SQLite may hand a deleted printer's id to the next printer; the serial guards the link."""
    p = await printer_factory(name="Old", serial_number="SERIAL-OLD")
    [old] = await ensure_hour_machines(db_session)
    p.serial_number = "SERIAL-NEW"  # same id, different physical printer
    p.name = "New"
    await db_session.commit()

    machines = await ensure_hour_machines(db_session)
    by_name = {m.name: m for m in machines}
    assert by_name["Old"].id == old.id and by_name["Old"].retired and by_name["Old"].printer_id is None
    assert by_name["New"].printer_id == p.id and not by_name["New"].retired


@pytest.mark.asyncio
async def test_ensure_recovers_from_concurrent_insert(db_session, printer_factory, monkeypatch):
    await printer_factory(name="A101", model="A1")
    real_sync = printer_hours._sync_machines
    calls = {"n": 0}

    async def flaky_sync(db):
        calls["n"] += 1
        if calls["n"] == 1:
            raise IntegrityError("INSERT", {}, Exception("UNIQUE constraint failed: hour_machines.printer_id"))
        await real_sync(db)

    monkeypatch.setattr(printer_hours, "_sync_machines", flaky_sync)
    machines = await ensure_hour_machines(db_session)
    assert [m.name for m in machines] == ["A101"]
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_upsert_inserts_replaces_and_deletes(db_session):
    m = HourMachine(name="X1C01", model="X1C", retired=True)
    db_session.add(m)
    await db_session.commit()
    d = date(2026, 4, 25)

    await upsert_reading(db_session, m.id, d, SOURCE_MANUAL, 4102.0)
    await upsert_reading(db_session, m.id, d, SOURCE_MANUAL, 4103.0)
    await upsert_reading(db_session, m.id, d, SOURCE_AUTO, 3000.0)
    await db_session.commit()
    rows = (await db_session.execute(select(HourReading).order_by(HourReading.source))).scalars().all()
    assert [(r.source, r.hours) for r in rows] == [("auto", 3000.0), ("manual", 4103.0)]

    await upsert_reading(db_session, m.id, d, SOURCE_MANUAL, None)
    await db_session.commit()
    rows = (await db_session.execute(select(HourReading))).scalars().all()
    assert [(r.source, r.hours) for r in rows] == [("auto", 3000.0)]


@pytest.mark.asyncio
async def test_snapshot_today_is_idempotent_and_skips_retired(db_session, printer_factory):
    p = await printer_factory(name="X1C05", model="X1C")
    p.runtime_seconds = 3600 * 10
    p.print_hours_offset = 100.0
    db_session.add(HourMachine(name="X1C01", model="X1C", retired=True))
    await db_session.commit()
    today = date(2026, 10, 4)

    assert await snapshot_today(db_session, today) == 1
    p.runtime_seconds = 3600 * 12
    await db_session.commit()
    assert await snapshot_today(db_session, today) == 1

    rows = (await db_session.execute(select(HourReading))).scalars().all()
    assert [(r.reading_date, r.source, r.hours) for r in rows] == [(today, "auto", 112.0)]
```

- [ ] **Step 2: Run to verify it fails**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_printer_hours_service.py -v -p no:xdist`
Expected: FAIL at collection: `ImportError: cannot import name 'HourMachine'`.

- [ ] **Step 3: Add the models**

In `backend/app/models/maintenance.py`:
- Change the imports to:

```python
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, String, Text, UniqueConstraint, func
```

- Insert the two classes **before** the trailing `# Import at end to avoid circular imports` block:

```python
class HourMachine(Base):
    """A machine whose lifetime hours are tracked on the Maintenance → Hours tab.

    Linked to its printer while that printer exists in Fenrir. Retired machines
    (sold, or deleted from Fenrir) keep their history with ``printer_id`` NULL.
    No ORM relationship to readings on purpose: SQLite does not enforce the FK
    cascade, so deletes remove readings explicitly.
    """

    __tablename__ = "hour_machines"

    id: Mapped[int] = mapped_column(primary_key=True)
    printer_id: Mapped[int | None] = mapped_column(
        ForeignKey("printers.id", ondelete="SET NULL"), nullable=True, unique=True
    )
    name: Mapped[str] = mapped_column(String(100))
    model: Mapped[str | None] = mapped_column(String(50), nullable=True)
    # Linked printer's serial: SQLite can reuse a deleted printer's id, and a
    # mismatch retires this row instead of attaching its history to a new printer.
    serial_number: Mapped[str | None] = mapped_column(String(50), nullable=True)
    retired: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class HourReading(Base):
    """One lifetime-hours value for a machine on a date: typed (manual) or Fenrir's counter (auto)."""

    __tablename__ = "hour_readings"
    __table_args__ = (UniqueConstraint("machine_id", "reading_date", "source", name="uq_hour_reading"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    machine_id: Mapped[int] = mapped_column(ForeignKey("hour_machines.id", ondelete="CASCADE"), index=True)
    reading_date: Mapped[date] = mapped_column(Date)
    hours: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String(10))  # "manual" | "auto"
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
```

In `backend/app/models/__init__.py`:
- Change line 27 to `from backend.app.models.maintenance import HourMachine, HourReading, MaintenanceHistory, MaintenanceType, PrinterMaintenance`.
- Add `"HourMachine",` and `"HourReading",` after `"MaintenanceHistory",` in `__all__`.

`init_db()` and `tests/conftest.py` already import the `maintenance` module, so nothing else is needed to create the tables.

- [ ] **Step 4: Write the service**

Create `backend/app/services/printer_hours.py`:

```python
"""Machine-hours history behind the Maintenance → Hours tab.

Manual readings are the operator's lifetime hours off each printer's screen;
auto readings are Fenrir's own counter (runtime + offset), snapshotted daily.
A manual reading dated today also recalibrates the printer's counter — that
rule lives in the route, this module provides the pieces.
"""

import asyncio
import logging
from datetime import date

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core import database as _database
from backend.app.models.maintenance import HourMachine, HourReading
from backend.app.models.printer import Printer

logger = logging.getLogger(__name__)

SOURCE_MANUAL = "manual"
SOURCE_AUTO = "auto"


def current_hours(runtime_seconds: int | None, offset_hours: float | None) -> float:
    """Fenrir's counter: active runtime (RUNNING only, #1521) plus the operator baseline."""
    return (runtime_seconds or 0) / 3600.0 + (offset_hours or 0.0)


def recalibrate_printer(printer: Printer, total_hours: float) -> float:
    """Set the offset so the printer's counter reads ``total_hours``. Returns runtime hours; caller commits."""
    runtime_hours = (printer.runtime_seconds or 0) / 3600.0
    printer.print_hours_offset = max(0.0, total_hours - runtime_hours)
    return runtime_hours


async def _sync_machines(db: AsyncSession) -> None:
    printers = {p.id: p for p in (await db.execute(select(Printer))).scalars().all()}
    machines = (await db.execute(select(HourMachine))).scalars().all()
    linked: set[int] = set()
    for m in machines:
        if m.printer_id is None:
            m.retired = True
            continue
        p = printers.get(m.printer_id)
        if p is None or (m.serial_number and p.serial_number != m.serial_number):
            m.printer_id = None
            m.retired = True
            continue
        linked.add(p.id)
        if (m.name, m.model, m.serial_number, m.retired) != (p.name, p.model, p.serial_number, False):
            m.name, m.model, m.serial_number, m.retired = p.name, p.model, p.serial_number, False
    # Release unlinked printer ids before inserting rows that claim them (printer_id is unique).
    await db.flush()
    for p in printers.values():
        if p.id not in linked:
            db.add(HourMachine(printer_id=p.id, name=p.name, model=p.model, serial_number=p.serial_number))
    await db.flush()


async def ensure_hour_machines(db: AsyncSession) -> list[HourMachine]:
    """Create/sync one machine per printer, retire orphans, and return every machine by name.

    Commits — call it before staging other writes in the same session.
    """
    try:
        await _sync_machines(db)
        await db.commit()
    except IntegrityError:
        # The hourly snapshot and a GET raced to create the same row; the winner's row is there now.
        await db.rollback()
        await _sync_machines(db)
        await db.commit()
    result = await db.execute(select(HourMachine).order_by(HourMachine.name, HourMachine.id))
    return list(result.scalars().all())


async def upsert_reading(
    db: AsyncSession, machine_id: int, reading_date: date, source: str, hours: float | None
) -> None:
    """Insert or replace the (machine, date, source) reading; ``hours=None`` deletes it. No commit."""
    result = await db.execute(
        select(HourReading).where(
            HourReading.machine_id == machine_id,
            HourReading.reading_date == reading_date,
            HourReading.source == source,
        )
    )
    existing = result.scalar_one_or_none()
    if hours is None:
        if existing is not None:
            await db.delete(existing)
        return
    if existing is None:
        db.add(HourReading(machine_id=machine_id, reading_date=reading_date, source=source, hours=hours))
    else:
        existing.hours = hours


async def snapshot_today(db: AsyncSession, today: date | None = None) -> int:
    """Write today's auto reading for every linked machine. Idempotent per day. Returns rows written."""
    today = today or date.today()
    machines = await ensure_hour_machines(db)
    rows = (await db.execute(select(Printer.id, Printer.runtime_seconds, Printer.print_hours_offset))).all()
    hours_by_printer = {pid: current_hours(runtime, offset) for pid, runtime, offset in rows}
    written = 0
    for m in machines:
        if m.retired or m.printer_id not in hours_by_printer:
            continue
        await upsert_reading(db, m.id, today, SOURCE_AUTO, round(hours_by_printer[m.printer_id], 1))
        written += 1
    await db.commit()
    return written
```

(The scheduler class is added in Task 5.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_printer_hours_service.py -v -p no:xdist`
Expected: 8 passed.

- [ ] **Step 6: Lint and commit**

```bash
ruff check backend/app/models/maintenance.py backend/app/models/__init__.py backend/app/services/printer_hours.py backend/tests/unit/test_printer_hours_service.py
ruff format backend/app/models/maintenance.py backend/app/services/printer_hours.py backend/tests/unit/test_printer_hours_service.py
git add backend/app/models/maintenance.py backend/app/models/__init__.py backend/app/services/printer_hours.py backend/tests/unit/test_printer_hours_service.py
git commit -m "feat(maintenance): hour machines/readings models and service core"
```

---

### Task 2: Share the counter maths with the existing hours route

**Files:**
- Modify: `backend/app/api/routes/maintenance.py` (`get_printer_total_hours` ~L125, `set_printer_hours` ~L708-765)
- Test: `backend/tests/integration/test_maintenance_api.py` (existing, must stay green) + one new test

**Interfaces:**
- Consumes: `current_hours`, `recalibrate_printer` (Task 1).
- Produces: `async notify_maintenance_attention(db: AsyncSession, printer_id: int, printer_name: str) -> None` in `routes/maintenance.py`. It never raises; it logs a warning on failure.

- [ ] **Step 1: Write the failing test**

Append to `class TestPrinterHoursAPI` in `backend/tests/integration/test_maintenance_api.py`:

```python
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_set_printer_hours_offset_uses_runtime(self, async_client: AsyncClient, printer_factory):
        """Offset = total - runtime, so the overview's total reads back the typed value."""
        printer = await printer_factory(name="Offset Printer", runtime_seconds=3600 * 100)
        response = await async_client.patch(
            f"/api/v1/maintenance/printers/{printer.id}/hours", params={"total_hours": 4102.0}
        )
        assert response.status_code == 200
        assert response.json()["offset_hours"] == pytest.approx(4002.0)
        overview = await async_client.get(f"/api/v1/maintenance/printers/{printer.id}")
        assert overview.json()["total_print_hours"] == pytest.approx(4102.0)

    @pytest.mark.asyncio
    async def test_notify_maintenance_attention_swallows_errors(self, db_session, monkeypatch):
        from backend.app.api.routes import maintenance as maintenance_routes

        async def boom(*_args, **_kwargs):
            raise RuntimeError("db gone")

        monkeypatch.setattr(maintenance_routes, "ensure_default_types", boom)
        await maintenance_routes.notify_maintenance_attention(db_session, 1, "X")  # must not raise
```

- [ ] **Step 2: Run to verify it fails**

Run: `./venv/bin/python3 -m pytest backend/tests/integration/test_maintenance_api.py -k "offset_uses_runtime or swallows_errors" -v -p no:xdist`
Expected: `test_notify_maintenance_attention_swallows_errors` FAILS with `AttributeError: ... has no attribute 'notify_maintenance_attention'`. The offset test may already pass; it pins behaviour for the refactor.

- [ ] **Step 3: Refactor**

In `backend/app/api/routes/maintenance.py`:
- Add the import `from backend.app.services.printer_hours import current_hours, recalibrate_printer`.
- Replace the body of `get_printer_total_hours` after the query with:

```python
    row = result.one_or_none()
    if not row:
        return 0.0
    return current_hours(row[0], row[1])
```

- Add above `set_printer_hours`:

```python
async def notify_maintenance_attention(db: AsyncSession, printer_id: int, printer_name: str) -> None:
    """Send the maintenance-due notification when a printer's new hours put items in warning/due."""
    try:
        await ensure_default_types(db)
        overview = await _get_printer_maintenance_internal(printer_id, db, commit=True)
        items_needing_attention = [
            {"name": item.maintenance_type_name, "is_due": item.is_due, "is_warning": item.is_warning}
            for item in overview.maintenance_items
            if item.enabled and (item.is_due or item.is_warning)
        ]
        if items_needing_attention:
            await notification_service.on_maintenance_due(printer_id, printer_name, items_needing_attention, db)
            logger.info(
                "Sent maintenance notification for printer %s: %s items need attention",
                printer_id,
                len(items_needing_attention),
            )
    except Exception as e:
        logger.warning("Failed to send maintenance notification: %s", e)
```

- Replace the body of `set_printer_hours` from `# Get current runtime hours` to the end with:

```python
    runtime_hours = recalibrate_printer(printer, total_hours)
    printer_name = printer.name
    await db.commit()
    await notify_maintenance_attention(db, printer_id, printer_name)
    return {
        "printer_id": printer_id,
        "total_hours": total_hours,
        "runtime_hours": runtime_hours,
        "offset_hours": printer.print_hours_offset,
    }
```

- [ ] **Step 4: Run the whole maintenance API file**

Run: `./venv/bin/python3 -m pytest backend/tests/integration/test_maintenance_api.py backend/tests/unit/test_maintenance_rod_filtering.py -v -p no:xdist`
Expected: all pass.

- [ ] **Step 5: Lint and commit**

```bash
ruff check backend/app/api/routes/maintenance.py backend/tests/integration/test_maintenance_api.py && ruff format backend/app/api/routes/maintenance.py backend/tests/integration/test_maintenance_api.py
git add backend/app/api/routes/maintenance.py backend/tests/integration/test_maintenance_api.py
git commit -m "refactor(maintenance): share counter maths and the due notification with the hours tab"
```

---

### Task 3: Read, save and delete routes

**Files:**
- Modify: `backend/app/schemas/maintenance.py`
- Create: `backend/app/api/routes/printer_hours.py`
- Modify: `backend/app/main.py` (import list ~L59, `include_router` ~L11166)
- Test: `backend/tests/integration/test_printer_hours_api.py`

**Interfaces:**
- Consumes: Task 1 service functions; `notify_maintenance_attention` (Task 2).
- Produces:
  - `GET /api/v1/maintenance/hours` → `HoursOverview {today: "YYYY-MM-DD", machines: [{id, printer_id, name, model, retired, current_hours}], readings: [{id, machine_id, reading_date, hours, source}]}`.
  - `POST /api/v1/maintenance/hours/readings` body `{reading_date, entries: [{machine_id, hours|null}]}` → `HoursOverview`.
  - `DELETE /api/v1/maintenance/hours/readings?reading_date=` → `HoursOverview`.
  - Router object `router` in `routes/printer_hours.py`; Task 4 adds to it.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/integration/test_printer_hours_api.py`:

```python
"""Integration tests for /api/v1/maintenance/hours (Maintenance → Hours tab)."""

from datetime import date, timedelta

import pytest
from httpx import AsyncClient

from backend.app.models.maintenance import HourMachine

BASE = "/api/v1/maintenance/hours"


async def _machine_for(async_client: AsyncClient, name: str) -> dict:
    data = (await async_client.get(BASE)).json()
    return next(m for m in data["machines"] if m["name"] == name)


@pytest.mark.asyncio
@pytest.mark.integration
class TestHoursRead:
    async def test_overview_lists_printers_with_live_counter(self, async_client: AsyncClient, printer_factory):
        await printer_factory(name="X1C04", model="X1C", runtime_seconds=3600 * 124, print_hours_offset=10.0)
        response = await async_client.get(BASE)
        assert response.status_code == 200
        data = response.json()
        assert data["today"] == date.today().isoformat()
        [m] = data["machines"]
        assert (m["name"], m["model"], m["retired"], m["current_hours"]) == ("X1C04", "X1C", False, 134.0)
        assert data["readings"] == []


@pytest.mark.asyncio
@pytest.mark.integration
class TestHoursSave:
    async def test_backdated_reading_is_stored_without_recalibrating(
        self, async_client: AsyncClient, printer_factory, db_session
    ):
        p = await printer_factory(name="X1C05", runtime_seconds=3600 * 100)
        m = await _machine_for(async_client, "X1C05")
        response = await async_client.post(
            f"{BASE}/readings",
            json={"reading_date": "2026-04-25", "entries": [{"machine_id": m["id"], "hours": 3336}]},
        )
        assert response.status_code == 200
        readings = response.json()["readings"]
        assert [(r["reading_date"], r["hours"], r["source"]) for r in readings] == [("2026-04-25", 3336.0, "manual")]
        await db_session.refresh(p)
        assert p.print_hours_offset == 0.0

    async def test_today_reading_recalibrates_and_rewrites_auto(
        self, async_client: AsyncClient, printer_factory, db_session
    ):
        p = await printer_factory(name="X1C06", runtime_seconds=3600 * 100)
        m = await _machine_for(async_client, "X1C06")
        today = date.today().isoformat()
        response = await async_client.post(
            f"{BASE}/readings", json={"reading_date": today, "entries": [{"machine_id": m["id"], "hours": 2629}]}
        )
        assert response.status_code == 200
        data = response.json()
        assert sorted((r["source"], r["hours"]) for r in data["readings"]) == [("auto", 2629.0), ("manual", 2629.0)]
        assert next(x for x in data["machines"] if x["id"] == m["id"])["current_hours"] == 2629.0
        await db_session.refresh(p)
        assert p.print_hours_offset == pytest.approx(2529.0)

    async def test_resave_replaces_and_null_deletes(self, async_client: AsyncClient, printer_factory):
        await printer_factory(name="X1C07")
        m = await _machine_for(async_client, "X1C07")
        body = {"reading_date": "2026-01-01", "entries": [{"machine_id": m["id"], "hours": 1629}]}
        await async_client.post(f"{BASE}/readings", json=body)
        body["entries"][0]["hours"] = 1630
        data = (await async_client.post(f"{BASE}/readings", json=body)).json()
        assert [r["hours"] for r in data["readings"]] == [1630.0]
        body["entries"][0]["hours"] = None
        data = (await async_client.post(f"{BASE}/readings", json=body)).json()
        assert data["readings"] == []

    @pytest.mark.parametrize(
        ("reading_date", "hours", "detail"),
        [
            ((date.today() + timedelta(days=1)).isoformat(), 10, "future"),
            ("2026-01-01", -1, None),
        ],
    )
    async def test_rejects_future_dates_and_negative_hours(
        self, async_client: AsyncClient, printer_factory, reading_date, hours, detail
    ):
        await printer_factory(name="X1C08")
        m = await _machine_for(async_client, "X1C08")
        response = await async_client.post(
            f"{BASE}/readings", json={"reading_date": reading_date, "entries": [{"machine_id": m["id"], "hours": hours}]}
        )
        assert response.status_code == 422
        if detail:
            assert detail in response.json()["detail"]

    async def test_rejects_retired_unknown_and_duplicate_machines(self, async_client: AsyncClient, db_session):
        retired = HourMachine(name="X1C01", model="X1C", retired=True)
        db_session.add(retired)
        await db_session.commit()
        for entries in (
            [{"machine_id": retired.id, "hours": 1}],
            [{"machine_id": 99999, "hours": 1}],
        ):
            response = await async_client.post(f"{BASE}/readings", json={"reading_date": "2026-01-01", "entries": entries})
            assert response.status_code == 422
        response = await async_client.post(
            f"{BASE}/readings",
            json={"reading_date": "2026-01-01", "entries": [{"machine_id": retired.id, "hours": 1}] * 2},
        )
        assert response.status_code == 422


@pytest.mark.asyncio
@pytest.mark.integration
class TestHoursDelete:
    async def test_delete_date_removes_manual_only(self, async_client: AsyncClient, printer_factory):
        await printer_factory(name="X1C09")
        m = await _machine_for(async_client, "X1C09")
        today = date.today().isoformat()
        await async_client.post(f"{BASE}/readings", json={"reading_date": today, "entries": [{"machine_id": m["id"], "hours": 5}]})
        response = await async_client.delete(f"{BASE}/readings", params={"reading_date": today})
        assert response.status_code == 200
        assert [r["source"] for r in response.json()["readings"]] == ["auto"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_hours_routes_require_auth_when_enabled(async_client: AsyncClient):
    setup = await async_client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": "hoursadmin", "admin_password": "TestPass1!"},
    )
    assert setup.status_code == 200
    assert (await async_client.get(BASE)).status_code == 401
    body = {"reading_date": "2026-01-01", "entries": [{"machine_id": 1, "hours": 1}]}
    assert (await async_client.post(f"{BASE}/readings", json=body)).status_code == 401
```

Before relying on `printer_factory(runtime_seconds=..., print_hours_offset=...)`, confirm that `printer_factory` forwards kwargs into `Printer(**defaults)`. It does (`backend/tests/conftest.py:705-733`), so these fields are accepted.

- [ ] **Step 2: Run to verify it fails**

Run: `./venv/bin/python3 -m pytest backend/tests/integration/test_printer_hours_api.py -v -p no:xdist`
Expected: FAIL, every request returns 404.

- [ ] **Step 3: Add the schemas**

Append to `backend/app/schemas/maintenance.py`. Change the top import to `from datetime import date, datetime`, and add `from typing import Literal` and `from pydantic import ConfigDict`.

```python
# Printer hours history (Maintenance → Hours tab)
MAX_HOURS = 200_000.0


class HourMachineOut(BaseModel):
    id: int
    printer_id: int | None
    name: str
    model: str | None
    retired: bool
    current_hours: float | None  # Fenrir's live counter; None for retired machines


class HourReadingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    machine_id: int
    reading_date: date
    hours: float
    source: Literal["manual", "auto"]


class HoursOverview(BaseModel):
    today: date  # the server's date — the UI's "today" for defaults and the recalibration rule
    machines: list[HourMachineOut]
    readings: list[HourReadingOut]


class HourReadingEntry(BaseModel):
    machine_id: int
    hours: float | None = Field(default=None, ge=0, le=MAX_HOURS)  # None deletes that cell


class HourReadingBatch(BaseModel):
    reading_date: date
    entries: list[HourReadingEntry] = Field(..., min_length=1)
```

- [ ] **Step 4: Write the routes**

Create `backend/app/api/routes/printer_hours.py`:

```python
"""Maintenance → Hours tab: lifetime-hours history per machine."""

import logging
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.maintenance import notify_maintenance_attention
from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.maintenance import HourMachine, HourReading
from backend.app.models.printer import Printer
from backend.app.models.user import User
from backend.app.schemas.maintenance import (
    HourMachineOut,
    HourReadingBatch,
    HourReadingOut,
    HoursOverview,
)
from backend.app.services.printer_hours import (
    SOURCE_AUTO,
    SOURCE_MANUAL,
    current_hours,
    ensure_hour_machines,
    recalibrate_printer,
    upsert_reading,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/maintenance/hours", tags=["maintenance"])


async def _overview(db: AsyncSession) -> HoursOverview:
    machines = await ensure_hour_machines(db)
    rows = (await db.execute(select(Printer.id, Printer.runtime_seconds, Printer.print_hours_offset))).all()
    hours_by_printer = {pid: current_hours(runtime, offset) for pid, runtime, offset in rows}
    readings = (
        await db.execute(select(HourReading).order_by(HourReading.reading_date, HourReading.machine_id, HourReading.id))
    ).scalars()
    return HoursOverview(
        today=date.today(),
        machines=[
            HourMachineOut(
                id=m.id,
                printer_id=m.printer_id,
                name=m.name,
                model=m.model,
                retired=m.retired,
                current_hours=(
                    None
                    if m.retired or m.printer_id not in hours_by_printer
                    else round(hours_by_printer[m.printer_id], 1)
                ),
            )
            for m in machines
        ],
        readings=[HourReadingOut.model_validate(r) for r in readings],
    )


def _reject_future(reading_date: date) -> None:
    if reading_date > date.today():
        raise HTTPException(status_code=422, detail="Reading date is in the future")


@router.get("", response_model=HoursOverview)
async def get_hours(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.MAINTENANCE_READ),
):
    return await _overview(db)


@router.post("/readings", response_model=HoursOverview)
async def save_readings(
    body: HourReadingBatch,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.MAINTENANCE_UPDATE),
):
    """Upsert one date's manual readings. Readings dated today recalibrate their printer's counter."""
    _reject_future(body.reading_date)
    ids = [e.machine_id for e in body.entries]
    if len(set(ids)) != len(ids):
        raise HTTPException(status_code=422, detail="A machine appears twice in entries")
    await ensure_hour_machines(db)
    machines = {m.id: m for m in (await db.execute(select(HourMachine).where(HourMachine.id.in_(ids)))).scalars()}
    for machine_id in ids:
        m = machines.get(machine_id)
        if m is None:
            raise HTTPException(status_code=422, detail=f"Unknown machine {machine_id}")
        if m.retired:
            raise HTTPException(status_code=422, detail=f"{m.name} is retired; correct its history by pasting")

    is_today = body.reading_date == date.today()
    recalibrated: list[tuple[int, str]] = []
    for entry in body.entries:
        m = machines[entry.machine_id]
        await upsert_reading(db, m.id, body.reading_date, SOURCE_MANUAL, entry.hours)
        if entry.hours is None or not is_today or m.printer_id is None:
            continue
        printer = await db.get(Printer, m.printer_id)
        if printer is None:  # deleted mid-request: keep the reading, skip the counter
            continue
        recalibrate_printer(printer, entry.hours)
        await upsert_reading(db, m.id, body.reading_date, SOURCE_AUTO, entry.hours)
        recalibrated.append((printer.id, printer.name))
    await db.commit()

    for printer_id, printer_name in recalibrated:
        await notify_maintenance_attention(db, printer_id, printer_name)
    return await _overview(db)


@router.delete("/readings", response_model=HoursOverview)
async def delete_readings(
    reading_date: date,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.MAINTENANCE_DELETE),
):
    """Delete every manual reading on a date; Fenrir's auto snapshots stay."""
    await db.execute(
        delete(HourReading).where(HourReading.reading_date == reading_date, HourReading.source == SOURCE_MANUAL)
    )
    await db.commit()
    return await _overview(db)
```

In `backend/app/main.py`:
- Add `printer_hours,` to the `from backend.app.api.routes import (...)` block, in alphabetical order near `maintenance,` (~L59).
- After `app.include_router(maintenance.router, prefix=app_settings.api_prefix)` (~L11166), add `app.include_router(printer_hours.router, prefix=app_settings.api_prefix)`.

The name `printer_hours` must not collide with an existing name in `main.py`. Run `grep -n "printer_hours" backend/app/main.py` first; if anything matches, import the route module as `printer_hours as printer_hours_routes` and use that name instead.

- [ ] **Step 5: Run the tests**

Run: `./venv/bin/python3 -m pytest backend/tests/integration/test_printer_hours_api.py backend/tests/unit/test_route_auth_coverage.py -v -p no:xdist`
Expected: all pass. The auth-coverage sweep sees the new routes' `require_` dependency.

- [ ] **Step 6: Lint and commit**

```bash
ruff check backend/app/api/routes/printer_hours.py backend/app/schemas/maintenance.py backend/app/main.py backend/tests/integration/test_printer_hours_api.py
ruff format backend/app/api/routes/printer_hours.py backend/app/schemas/maintenance.py backend/tests/integration/test_printer_hours_api.py
git add backend/app/api/routes/printer_hours.py backend/app/schemas/maintenance.py backend/app/main.py backend/tests/integration/test_printer_hours_api.py
git commit -m "feat(maintenance): hours overview, save and delete routes"
```

---

### Task 4: Import and retired-machine routes

**Files:**
- Modify: `backend/app/schemas/maintenance.py`
- Modify: `backend/app/api/routes/printer_hours.py`
- Test: `backend/tests/integration/test_printer_hours_api.py`

**Interfaces:**
- Produces:
  - `POST /api/v1/maintenance/hours/import` body `{new_machines: [{key, name, model}], readings: [{machine_id?|key?, reading_date, hours}]}` → `{machines_created, readings_written}`.
  - `PATCH /api/v1/maintenance/hours/machines/{id}` body `{name?, model?}` → `HourMachineOut`.
  - `DELETE /api/v1/maintenance/hours/machines/{id}` → `{"status": "deleted"}`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/integration/test_printer_hours_api.py`:

```python
@pytest.mark.asyncio
@pytest.mark.integration
class TestHoursImport:
    async def test_import_creates_retired_machines_and_never_recalibrates(
        self, async_client: AsyncClient, printer_factory, db_session
    ):
        p = await printer_factory(name="X1C04", runtime_seconds=3600 * 124)
        m = await _machine_for(async_client, "X1C04")
        today = date.today().isoformat()
        body = {
            "new_machines": [{"key": "X1C01", "name": "X1C01", "model": "X1C"}],
            "readings": [
                {"key": "X1C01", "reading_date": "2024-07-19", "hours": 1470},
                {"key": "X1C01", "reading_date": "2026-04-25", "hours": 4102},
                {"machine_id": m["id"], "reading_date": "2026-04-25", "hours": 3803},
                {"machine_id": m["id"], "reading_date": today, "hours": 3900},
            ],
        }
        response = await async_client.post(f"{BASE}/import", json=body)
        assert response.status_code == 200
        assert response.json() == {"machines_created": 1, "readings_written": 4}
        data = (await async_client.get(BASE)).json()
        retired = next(x for x in data["machines"] if x["name"] == "X1C01")
        assert retired["retired"] is True and retired["current_hours"] is None
        assert len([r for r in data["readings"] if r["machine_id"] == retired["id"]]) == 2
        await db_session.refresh(p)
        assert p.print_hours_offset == 0.0  # imports never recalibrate, even for today's date

    async def test_import_replaces_existing_dates(self, async_client: AsyncClient, printer_factory):
        await printer_factory(name="H2S01")
        m = await _machine_for(async_client, "H2S01")
        row = {"machine_id": m["id"], "reading_date": "2026-01-01", "hours": 861}
        await async_client.post(f"{BASE}/import", json={"readings": [row]})
        row["hours"] = 862
        await async_client.post(f"{BASE}/import", json={"readings": [row]})
        data = (await async_client.get(BASE)).json()
        assert [r["hours"] for r in data["readings"]] == [862.0]

    @pytest.mark.parametrize(
        "body",
        [
            {"readings": [{"reading_date": "2026-01-01", "hours": 1}]},  # neither machine_id nor key
            {"readings": [{"key": "nope", "reading_date": "2026-01-01", "hours": 1}]},  # unknown key
            {"readings": [{"machine_id": 99999, "reading_date": "2026-01-01", "hours": 1}]},  # unknown id
            {
                "new_machines": [{"key": "a", "name": "A"}, {"key": "a", "name": "B"}],
                "readings": [{"key": "a", "reading_date": "2026-01-01", "hours": 1}],
            },
        ],
    )
    async def test_import_validation_rejects_without_writing(self, async_client: AsyncClient, body):
        response = await async_client.post(f"{BASE}/import", json=body)
        assert response.status_code == 422
        assert (await async_client.get(BASE)).json()["machines"] == []

    async def test_import_rejects_new_machine_named_like_existing(self, async_client: AsyncClient, printer_factory):
        await printer_factory(name="X1C02")
        body = {
            "new_machines": [{"key": "k", "name": "x1c02"}],
            "readings": [{"key": "k", "reading_date": "2026-01-01", "hours": 1}],
        }
        assert (await async_client.post(f"{BASE}/import", json=body)).status_code == 422


@pytest.mark.asyncio
@pytest.mark.integration
class TestRetiredMachines:
    async def _retired(self, db_session) -> HourMachine:
        m = HourMachine(name="H2C03", model="H2C", retired=True)
        db_session.add(m)
        await db_session.commit()
        return m

    async def test_rename_retired_machine(self, async_client: AsyncClient, db_session):
        m = await self._retired(db_session)
        response = await async_client.patch(f"{BASE}/machines/{m.id}", json={"name": "H2C03 (sold)"})
        assert response.status_code == 200
        assert response.json()["name"] == "H2C03 (sold)"

    async def test_delete_retired_machine_removes_readings(self, async_client: AsyncClient, db_session):
        m = await self._retired(db_session)
        await async_client.post(
            f"{BASE}/import", json={"readings": [{"machine_id": m.id, "reading_date": "2026-04-25", "hours": 345}]}
        )
        assert (await async_client.delete(f"{BASE}/machines/{m.id}")).status_code == 200
        data = (await async_client.get(BASE)).json()
        assert data["machines"] == [] and data["readings"] == []

    async def test_linked_machine_cannot_be_renamed_or_deleted(self, async_client: AsyncClient, printer_factory):
        await printer_factory(name="H2D01")
        m = await _machine_for(async_client, "H2D01")
        assert (await async_client.patch(f"{BASE}/machines/{m['id']}", json={"name": "x"})).status_code == 409
        assert (await async_client.delete(f"{BASE}/machines/{m['id']}")).status_code == 409

    async def test_unknown_machine_404(self, async_client: AsyncClient):
        assert (await async_client.delete(f"{BASE}/machines/99999")).status_code == 404
```

- [ ] **Step 2: Run to verify it fails**

Run: `./venv/bin/python3 -m pytest backend/tests/integration/test_printer_hours_api.py -k "Import or Retired" -v -p no:xdist`
Expected: FAIL with 404/405.

- [ ] **Step 3: Schemas**

Append to `backend/app/schemas/maintenance.py`:

```python
class HourMachineCreate(BaseModel):
    key: str = Field(..., min_length=1, max_length=100)  # the paste column header; readings refer to it
    name: str = Field(..., min_length=1, max_length=100)
    model: str | None = Field(default=None, max_length=50)


class HourImportReading(BaseModel):
    machine_id: int | None = None
    key: str | None = None
    reading_date: date
    hours: float = Field(..., ge=0, le=MAX_HOURS)


class HourImportBody(BaseModel):
    new_machines: list[HourMachineCreate] = Field(default_factory=list)
    readings: list[HourImportReading] = Field(..., min_length=1)


class HourImportResult(BaseModel):
    machines_created: int
    readings_written: int


class HourMachineUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    model: str | None = Field(default=None, max_length=50)
```

- [ ] **Step 4: Routes**

In `backend/app/api/routes/printer_hours.py`, extend the schema import with `HourImportBody, HourImportResult, HourMachineUpdate` and append:

```python
@router.post("/import", response_model=HourImportResult)
async def import_readings(
    body: HourImportBody,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.MAINTENANCE_UPDATE),
):
    """Bulk upsert manual readings from a pasted sheet, creating retired machines. Never recalibrates."""
    keys = [nm.key for nm in body.new_machines]
    if len(set(keys)) != len(keys):
        raise HTTPException(status_code=422, detail="Duplicate machine key")
    existing = await ensure_hour_machines(db)
    existing_ids = {m.id for m in existing}
    existing_names = {m.name.casefold() for m in existing}
    for nm in body.new_machines:
        if nm.name.strip().casefold() in existing_names:
            raise HTTPException(status_code=422, detail=f"A machine named {nm.name} already exists")
    for r in body.readings:
        if (r.machine_id is None) == (r.key is None):
            raise HTTPException(status_code=422, detail="Each reading needs exactly one of machine_id or key")
        if r.key is not None and r.key not in keys:
            raise HTTPException(status_code=422, detail=f"Unknown machine key {r.key}")
        if r.machine_id is not None and r.machine_id not in existing_ids:
            raise HTTPException(status_code=422, detail=f"Unknown machine {r.machine_id}")
        _reject_future(r.reading_date)

    created: dict[str, HourMachine] = {}
    for nm in body.new_machines:
        machine = HourMachine(name=nm.name.strip(), model=nm.model, retired=True)
        db.add(machine)
        created[nm.key] = machine
    await db.flush()
    for r in body.readings:
        machine_id = r.machine_id if r.machine_id is not None else created[r.key].id
        await upsert_reading(db, machine_id, r.reading_date, SOURCE_MANUAL, r.hours)
    await db.commit()
    return HourImportResult(machines_created=len(created), readings_written=len(body.readings))


async def _retired_machine(db: AsyncSession, machine_id: int) -> HourMachine:
    machine = await db.get(HourMachine, machine_id)
    if machine is None:
        raise HTTPException(status_code=404, detail="Machine not found")
    if not machine.retired:
        raise HTTPException(status_code=409, detail="Only retired machines can be changed here")
    return machine


@router.patch("/machines/{machine_id}", response_model=HourMachineOut)
async def update_machine(
    machine_id: int,
    body: HourMachineUpdate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.MAINTENANCE_UPDATE),
):
    await ensure_hour_machines(db)
    machine = await _retired_machine(db, machine_id)
    if body.name is not None:
        others = (await db.execute(select(HourMachine.name).where(HourMachine.id != machine_id))).scalars()
        if body.name.strip().casefold() in {n.casefold() for n in others}:
            raise HTTPException(status_code=422, detail=f"A machine named {body.name} already exists")
        machine.name = body.name.strip()
    if body.model is not None:
        machine.model = body.model or None
    await db.commit()
    return HourMachineOut(
        id=machine.id,
        printer_id=machine.printer_id,
        name=machine.name,
        model=machine.model,
        retired=machine.retired,
        current_hours=None,
    )


@router.delete("/machines/{machine_id}")
async def delete_machine(
    machine_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.MAINTENANCE_DELETE),
):
    await ensure_hour_machines(db)
    machine = await _retired_machine(db, machine_id)
    # SQLite does not enforce the FK cascade; remove the history explicitly.
    await db.execute(delete(HourReading).where(HourReading.machine_id == machine.id))
    await db.delete(machine)
    await db.commit()
    return {"status": "deleted"}
```

- [ ] **Step 5: Run the tests**

Run: `./venv/bin/python3 -m pytest backend/tests/integration/test_printer_hours_api.py -v -p no:xdist`
Expected: all pass.

- [ ] **Step 6: Lint and commit**

```bash
ruff check backend/app/api/routes/printer_hours.py backend/app/schemas/maintenance.py backend/tests/integration/test_printer_hours_api.py
ruff format backend/app/api/routes/printer_hours.py backend/app/schemas/maintenance.py backend/tests/integration/test_printer_hours_api.py
git add backend/app/api/routes/printer_hours.py backend/app/schemas/maintenance.py backend/tests/integration/test_printer_hours_api.py
git commit -m "feat(maintenance): sheet import and retired-machine routes for the hours tab"
```

---

### Task 5: Hourly snapshot scheduler

**Files:**
- Modify: `backend/app/services/printer_hours.py`
- Modify: `backend/app/main.py` (startup ~L10325, shutdown ~L10425)
- Test: `backend/tests/unit/test_printer_hours_service.py`

**Interfaces:**
- Produces: `printer_hours_service: PrinterHoursService` with `async start_scheduler()` and `stop_scheduler()`. The loop sleeps `_startup_delay` (60 s), then runs `snapshot_today` every `_check_interval` (3600 s).

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/unit/test_printer_hours_service.py`:

```python
@pytest.mark.asyncio
async def test_scheduler_snapshots_and_survives_errors(monkeypatch):
    import asyncio
    from contextlib import asynccontextmanager

    from backend.app.core import database as _database

    calls: list[str] = []

    async def fake_snapshot(_db):
        calls.append("snap")
        if len(calls) == 1:
            raise RuntimeError("transient")
        return 3

    @asynccontextmanager
    async def fake_session():
        yield object()

    monkeypatch.setattr(printer_hours, "snapshot_today", fake_snapshot)
    monkeypatch.setattr(_database, "async_session", fake_session)
    service = printer_hours.PrinterHoursService()
    service._startup_delay = 0
    service._check_interval = 0.01
    await service.start_scheduler()
    await asyncio.sleep(0.1)
    service.stop_scheduler()
    assert len(calls) >= 2  # the first failure did not kill the loop
```

- [ ] **Step 2: Run to verify it fails**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_printer_hours_service.py -k scheduler -v -p no:xdist`
Expected: FAIL with `AttributeError: ... no attribute 'PrinterHoursService'`.

- [ ] **Step 3: Implement**

Append to `backend/app/services/printer_hours.py`:

```python
class PrinterHoursService:
    """Hourly sweep writing today's auto reading. Hourly, not at midnight, so a restart never loses a day."""

    def __init__(self):
        self._scheduler_task: asyncio.Task | None = None
        self._startup_delay = 60
        self._check_interval = 3600

    async def start_scheduler(self):
        if self._scheduler_task is not None:
            return
        logger.info("Starting printer hours snapshot sweeper")
        self._scheduler_task = asyncio.create_task(self._scheduler_loop())

    def stop_scheduler(self):
        if self._scheduler_task:
            self._scheduler_task.cancel()
            self._scheduler_task = None
            logger.info("Stopped printer hours snapshot sweeper")

    async def _scheduler_loop(self):
        delay = self._startup_delay
        while True:
            try:
                await asyncio.sleep(delay)
                delay = self._check_interval
                async with _database.async_session() as db:
                    written = await snapshot_today(db)
                logger.debug("Printer hours snapshot: %s machines", written)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning("Printer hours snapshot failed: %s", e)


printer_hours_service = PrinterHoursService()
```

The loop calls the module-level `snapshot_today` by name, which is what the monkeypatch in the test relies on.

In `backend/app/main.py`:
- Add the import `from backend.app.services.printer_hours import printer_hours_service` next to `from backend.app.services.archive_purge import archive_purge_service` (~L110).
- After `await archive_purge_service.start_scheduler()`, add:

```python

    # Snapshot each printer's hour counter daily for the Maintenance → Hours tab
    await printer_hours_service.start_scheduler()
```

- After `archive_purge_service.stop_scheduler()` in shutdown, add `printer_hours_service.stop_scheduler()`.

- [ ] **Step 4: Run the tests**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_printer_hours_service.py -v -p no:xdist`
Expected: 9 passed.

- [ ] **Step 5: Backend suite**

Run: `./test_backend.sh`
Expected: Ruff clean and pytest green. If one file fails only in the full run, rerun it alone before debugging (it's usually load from the 30 parallel workers).

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/printer_hours.py backend/app/main.py backend/tests/unit/test_printer_hours_service.py
git commit -m "feat(maintenance): hourly printer hours snapshot"
```

---

### Task 6: Frontend API types and pure series utilities

**Files:**
- Modify: `frontend/src/api/client.ts` (types near `PrinterMaintenanceOverview` ~L4250; API functions after `setPrinterHours` ~L8426)
- Create: `frontend/src/utils/hoursSeries.ts`
- Test: `frontend/src/__tests__/utils/hoursSeries.test.ts`

**Interfaces:**
- Produces:
  - Types `HourMachine`, `HourReading`, `HoursOverview`, `HourImportBody` (in `client.ts`).
  - API functions `api.getPrinterHours()`, `api.saveHourReadings(date, entries)`, `api.deleteHourReadings(date)`, `api.importHourReadings(body)`, `api.deleteHourMachine(id)`.
  - From `utils/hoursSeries.ts`:
    - `HourPoint {date: string; hours: number}`
    - `MachineSeries {manual: HourPoint[]; auto: HourPoint[]}`
    - `dayNumber(iso)`
    - `machineSeries(readings, machineId)`
    - `seriesPoints(series)`
    - `valueAt(points, iso)`
    - `monthStarts(fromIso, toIso)`
    - `monthlyHours(points, months)`
    - `fleetTotal(pointsList, dates)`
    - `ratePerMonth(points, today, windowDays = 90)`
    - `parseHoursCell(cell)`
    - `parseHoursInput(text)`
    - `parseDateCell(cell)`
    - `parseSheetPaste(text)`
    - `guessModel(name)`
    - `machineColors(machines)`
    - `planImport(paste, machines, choices, today)` → `ImportPlan`

- [ ] **Step 1: Add client types and functions**

In `frontend/src/api/client.ts`, after the `PrinterMaintenanceOverview` interface:

```ts
// Maintenance → Hours tab (lifetime hours history)
export interface HourMachine {
  id: number;
  printer_id: number | null;
  name: string;
  model: string | null;
  retired: boolean;
  current_hours: number | null;
}

export interface HourReading {
  id: number;
  machine_id: number;
  reading_date: string; // YYYY-MM-DD
  hours: number;
  source: 'manual' | 'auto';
}

export interface HoursOverview {
  today: string; // the server's date
  machines: HourMachine[];
  readings: HourReading[];
}

export interface HourImportBody {
  new_machines: { key: string; name: string; model: string | null }[];
  readings: { machine_id?: number; key?: string; reading_date: string; hours: number }[];
}
```

After `setPrinterHours`:

```ts
  getPrinterHours: () => request<HoursOverview>('/maintenance/hours'),
  saveHourReadings: (readingDate: string, entries: { machine_id: number; hours: number | null }[]) =>
    request<HoursOverview>('/maintenance/hours/readings', {
      method: 'POST',
      body: JSON.stringify({ reading_date: readingDate, entries }),
    }),
  deleteHourReadings: (readingDate: string) =>
    request<HoursOverview>(`/maintenance/hours/readings?reading_date=${encodeURIComponent(readingDate)}`, {
      method: 'DELETE',
    }),
  importHourReadings: (body: HourImportBody) =>
    request<{ machines_created: number; readings_written: number }>('/maintenance/hours/import', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteHourMachine: (machineId: number) =>
    request<{ status: string }>(`/maintenance/hours/machines/${machineId}`, { method: 'DELETE' }),
```

- [ ] **Step 2: Write the failing util tests**

Create `frontend/src/__tests__/utils/hoursSeries.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { HourMachine, HourReading } from '../../api/client';
import {
  fleetTotal,
  guessModel,
  machineColors,
  machineSeries,
  monthStarts,
  monthlyHours,
  parseDateCell,
  parseHoursCell,
  parseHoursInput,
  parseSheetPaste,
  planImport,
  ratePerMonth,
  seriesPoints,
  valueAt,
} from '../../utils/hoursSeries';

// The operator's Google Sheet, verbatim (0 = machine not owned yet).
const DATES = ['2024-07-19', '2024-10-25', '2025-01-07', '2025-03-11', '2025-07-07', '2026-01-01', '2026-04-25'];
const SHEET: Record<string, number[]> = {
  X1C01: [1470, 1786, 2260, 2500, 2970, 4102, 4102], X1C02: [212, 591, 1069, 1325, 1760, 2696, 2696],
  X1C03: [491, 908, 1364, 1721, 2248, 3500, 3500], X1C04: [243, 752, 1186, 1510, 2063, 3297, 3803],
  X1C05: [0, 205, 605, 980, 1450, 2788, 3336], X1C06: [0, 0, 0, 174, 713, 2039, 2629],
  X1C07: [0, 0, 0, 171, 688, 1629, 2252], X1C08: [0, 0, 0, 63, 673, 1900, 2461],
  X1C09: [0, 0, 0, 0, 0, 821, 1430], A101: [0, 0, 0, 0, 0, 500, 500],
  H2D01: [0, 0, 0, 0, 471, 2178, 2810], H2S01: [0, 0, 0, 0, 0, 861, 1691],
  H2S02: [0, 0, 0, 0, 0, 0, 906], H2S03: [0, 0, 0, 0, 0, 946, 1798], H2S04: [0, 0, 0, 0, 0, 890, 1743],
  H2C01: [0, 0, 0, 0, 0, 0, 345], H2C02: [0, 0, 0, 0, 0, 0, 384], H2C03: [0, 0, 0, 0, 0, 0, 345],
  H2C04: [0, 0, 0, 0, 0, 0, 384],
};
const NAMES = Object.keys(SHEET);
const machines: HourMachine[] = NAMES.map((name, i) => ({
  id: i + 1, printer_id: i + 1, name, model: guessModel(name), retired: false, current_hours: null,
}));
let rid = 0;
const readings: HourReading[] = NAMES.flatMap((name, i) =>
  DATES.flatMap((d, k) =>
    SHEET[name][k] > 0
      ? [{ id: ++rid, machine_id: i + 1, reading_date: d, hours: SHEET[name][k], source: 'manual' as const }]
      : [],
  ),
);
const pts = (name: string) => seriesPoints(machineSeries(readings, NAMES.indexOf(name) + 1));

describe('series maths', () => {
  it('fleet total on 25/04/2026 counts every machine (the sheet formula skipped the H2s)', () => {
    expect(fleetTotal(NAMES.map(pts), ['2026-04-25'])).toEqual([37115]);
  });

  it('interpolates linearly, is 0 before the first reading and flat after the last', () => {
    const x = pts('X1C04');
    expect(valueAt(x, '2024-07-01')).toBe(0);
    expect(valueAt(x, '2026-01-01')).toBe(3297);
    expect(valueAt(x, '2026-02-26')).toBeCloseTo(3297 + (506 * 56) / 114, 5);
    expect(valueAt(x, '2026-10-04')).toBe(3803);
  });

  it('keeps only auto readings newer than the last manual one', () => {
    const r: HourReading[] = [
      { id: 1, machine_id: 9, reading_date: '2026-04-20', hours: 124, source: 'auto' },
      { id: 2, machine_id: 9, reading_date: '2026-04-25', hours: 3803, source: 'manual' },
      { id: 3, machine_id: 9, reading_date: '2026-05-01', hours: 3840, source: 'auto' },
    ];
    expect(machineSeries(r, 9)).toEqual({
      manual: [{ date: '2026-04-25', hours: 3803 }],
      auto: [{ date: '2026-05-01', hours: 3840 }],
    });
  });

  it('buckets hours by calendar month without counting lifetime hours before the first reading', () => {
    const months = monthStarts('2026-03-15', '2026-05-02');
    expect(months).toEqual(['2026-03-01', '2026-04-01', '2026-05-01']);
    const x = pts('X1C04'); // 3297 on 01/01 → 3803 on 25/04 = 506 h over 114 days
    const [mar, apr, may] = monthlyHours(x, months);
    expect(mar).toBeCloseTo((506 * 31) / 114, 1);
    expect(apr).toBeCloseTo((506 * 24) / 114, 1);
    expect(may).toBe(0);
    // H2S02's single reading (906 h) must not show up as 906 h in April
    expect(monthlyHours(pts('H2S02'), ['2026-04-01'])).toEqual([0]);
  });

  it('clamps counter resets to zero instead of negative months', () => {
    const p = [{ date: '2026-01-01', hours: 500 }, { date: '2026-02-01', hours: 10 }];
    expect(monthlyHours(p, ['2026-01-01'])).toEqual([0]);
  });

  it('rate per month over the last 90 days', () => {
    expect(ratePerMonth(pts('X1C04'), '2026-04-25')).toBeCloseTo(135.1, 0);
    expect(ratePerMonth(pts('A101'), '2026-04-25')).toBe(0);
    expect(ratePerMonth(pts('H2C01'), '2026-04-25')).toBeNull(); // a single reading has no rate
  });
});

describe('parsing', () => {
  it.each([
    ['1470', 1470], ['1 470', 1470], ['1 470', 1470], ['1 470', 1470],
    ['471,5', 471.5], ['1,470', 1470], ['12,345,678', 12345678], ['0', null], ['', null], ['-5', null], ['abc', null],
  ])('parseHoursCell(%j) = %j', (cell, expected) => {
    expect(parseHoursCell(cell)).toBe(expected);
  });

  it.each([
    ['', null], ['0', 0], ['3 803', 3803], ['3803,5', 3803.5], ['x', undefined], ['-1', undefined],
  ])('parseHoursInput(%j) = %j', (text, expected) => {
    expect(parseHoursInput(text)).toBe(expected);
  });

  it.each([
    ['19/07/2024', '2024-07-19'], ['1/1/2026', '2026-01-01'], ['2026-04-25', '2026-04-25'],
    ['31/02/2026', null], ['Date', null], ['', null],
  ])('parseDateCell(%j) = %j', (cell, expected) => {
    expect(parseDateCell(cell)).toBe(expected);
  });

  it('parses a Google Sheets copy, skipping rows without a date', () => {
    const text = 'Date\tX1C01\tH2S02\tTotal\r\n19/07/2024\t1470\t0\t1470\n\t\t\t0\n25/04/2026\t4 102\t906\t5008\n';
    expect(parseSheetPaste(text)).toEqual({
      headers: ['X1C01', 'H2S02', 'Total'],
      rows: [
        { date: '2024-07-19', values: [1470, null, 1470] },
        { date: '2026-04-25', values: [4102, 906, 5008] },
      ],
      skipped: 1,
    });
  });
});

describe('planImport', () => {
  const fenrir: HourMachine[] = [
    { id: 7, printer_id: 3, name: 'X1C04', model: 'X1C', retired: false, current_hours: 124 },
  ];
  const paste = parseSheetPaste(
    'Date\tx1c04\tX1C01\tTotal\t\n25/04/2026\t3803\t4102\t7905\t\n05/10/2099\t1\t1\t2\t\n',
  );

  it('matches by name, creates printer-like columns as retired, ignores Total, blanks and future rows', () => {
    const plan = planImport(paste, fenrir, {}, '2026-10-04');
    expect(plan.columns.map((c) => [c.header, c.action])).toEqual([
      ['x1c04', 'match'], ['X1C01', 'create'], ['Total', 'ignore'],
    ]);
    expect(plan.futureRows).toBe(1);
    expect(plan.body).toEqual({
      new_machines: [{ key: 'X1C01', name: 'X1C01', model: 'X1C' }],
      readings: [
        { machine_id: 7, reading_date: '2026-04-25', hours: 3803 },
        { key: 'X1C01', reading_date: '2026-04-25', hours: 4102 },
      ],
    });
  });

  it('honours an explicit ignore choice', () => {
    const plan = planImport(paste, fenrir, { X1C01: 'ignore' }, '2026-10-04');
    expect(plan.body.new_machines).toEqual([]);
    expect(plan.body.readings).toHaveLength(1);
  });
});

describe('colours', () => {
  it('gives each machine a stable colour, shaded within its model family', () => {
    const colors = machineColors(machines);
    expect(colors.get(1)).toMatch(/^hsl\(212 /); // X1C family hue
    expect(colors.get(1)).not.toBe(colors.get(2));
    expect(new Set(colors.values()).size).toBe(machines.length);
  });

  it('guesses the model from a printer-style name', () => {
    expect(guessModel('X1C01')).toBe('X1C');
    expect(guessModel('h2s04')).toBe('H2S');
    expect(guessModel('A101')).toBe('A1');
    expect(guessModel('Total')).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/utils/hoursSeries.test.ts`
Expected: FAIL with "Failed to resolve import ../../utils/hoursSeries".

- [ ] **Step 4: Implement**

Create `frontend/src/utils/hoursSeries.ts`:

```ts
/**
 * Pure helpers for the Maintenance → Hours tab: series building, interpolation,
 * monthly buckets, sheet-paste parsing, import planning and family colours.
 * Dates are ISO `YYYY-MM-DD` strings handled as UTC day numbers, so the
 * browser's timezone never shifts a reading by a day.
 */
import type { HourImportBody, HourMachine, HourReading } from '../api/client';

export interface HourPoint {
  date: string;
  hours: number;
}

export interface MachineSeries {
  manual: HourPoint[];
  auto: HourPoint[];
}

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

export function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

const byDate = (a: HourPoint, b: HourPoint) => a.date.localeCompare(b.date);

/** Manual readings, plus auto readings newer than the last manual one (older ones predate calibration). */
export function machineSeries(readings: HourReading[], machineId: number): MachineSeries {
  const mine = readings.filter((r) => r.machine_id === machineId);
  const manual = mine
    .filter((r) => r.source === 'manual')
    .map((r) => ({ date: r.reading_date, hours: r.hours }))
    .sort(byDate);
  const lastManual = manual.length ? manual[manual.length - 1].date : null;
  const auto = mine
    .filter((r) => r.source === 'auto' && (lastManual === null || r.reading_date > lastManual))
    .map((r) => ({ date: r.reading_date, hours: r.hours }))
    .sort(byDate);
  return { manual, auto };
}

export function seriesPoints(series: MachineSeries): HourPoint[] {
  return [...series.manual, ...series.auto];
}

function valueAtDay(points: HourPoint[], day: number): number {
  if (points.length === 0) return 0;
  if (day < dayNumber(points[0].date)) return 0;
  const last = points[points.length - 1];
  if (day >= dayNumber(last.date)) return last.hours;
  for (let i = 1; i < points.length; i++) {
    const xb = dayNumber(points[i].date);
    if (day <= xb) {
      const a = points[i - 1];
      const xa = dayNumber(a.date);
      return a.hours + ((points[i].hours - a.hours) * (day - xa)) / (xb - xa);
    }
  }
  return last.hours;
}

/** Linear interpolation; 0 before the first reading, flat after the last. */
export function valueAt(points: HourPoint[], iso: string): number {
  return valueAtDay(points, dayNumber(iso));
}

/** First day of every month from `fromIso`'s month through `toIso`'s month. */
export function monthStarts(fromIso: string, toIso: string): string[] {
  let [y, m] = fromIso.split('-').map(Number);
  const [ty, tm] = toIso.split('-').map(Number);
  const out: string[] = [];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${pad(m)}-01`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function nextMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
}

/**
 * Hours run in each calendar month, measured only between the machine's first and
 * last reading, so a first reading of 906 h never counts as 906 h in one month.
 * Counter resets clamp to 0.
 */
export function monthlyHours(points: HourPoint[], months: string[]): number[] {
  if (points.length < 2) return months.map(() => 0);
  const first = dayNumber(points[0].date);
  const last = dayNumber(points[points.length - 1].date);
  return months.map((start) => {
    const lo = Math.max(dayNumber(start), first);
    const hi = Math.min(dayNumber(nextMonth(start)), last);
    if (hi <= lo) return 0;
    return Math.max(0, Math.round((valueAtDay(points, hi) - valueAtDay(points, lo)) * 10) / 10);
  });
}

/** Sum over machines of their interpolated value at each date (retired machines stay at their last value). */
export function fleetTotal(pointsList: HourPoint[][], dates: string[]): number[] {
  return dates.map((d) => Math.round(pointsList.reduce((sum, p) => sum + valueAt(p, d), 0) * 10) / 10);
}

/** Average hours per month over the last `windowDays` (from the first reading if later). Null below 2 readings. */
export function ratePerMonth(points: HourPoint[], today: string, windowDays = 90): number | null {
  if (points.length < 2) return null;
  const end = dayNumber(today);
  const start = Math.max(end - windowDays, dayNumber(points[0].date));
  if (end - start < 7) return null;
  return ((valueAtDay(points, end) - valueAtDay(points, start)) / (end - start)) * 30.44;
}

const SPACES = /[\s  ]/g;
const THOUSANDS_COMMA = /^\d{1,3}(,\d{3})+$/;

function parseNumber(text: string): number | undefined {
  let s = text.replace(SPACES, '');
  if (s === '') return undefined;
  s = THOUSANDS_COMMA.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return undefined;
  return Number(s);
}

/** A pasted sheet cell: positive hours, or null for empty / zero ("not owned yet") / junk. */
export function parseHoursCell(cell: string): number | null {
  const n = parseNumber(cell);
  return n === undefined || n <= 0 ? null : n;
}

/** A form field: null when empty, undefined when invalid, otherwise the number (0 allowed). */
export function parseHoursInput(text: string): number | null | undefined {
  if (text.replace(SPACES, '') === '') return null;
  return parseNumber(text);
}

const DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDateCell(cell: string): string | null {
  const s = cell.trim();
  let y: number;
  let m: number;
  let d: number;
  const dmy = DMY.exec(s);
  const ymd = YMD.exec(s);
  if (dmy) [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  else if (ymd) [y, m, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

export interface SheetPaste {
  headers: string[];
  rows: { date: string; values: (number | null)[] }[];
  skipped: number;
}

/** Tab-separated copy from Google Sheets: first row = header (first cell ignored), first column = date. */
export function parseSheetPaste(text: string): SheetPaste {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return { headers: [], rows: [], skipped: 0 };
  const headers = lines[0].split('\t').slice(1).map((h) => h.trim());
  while (headers.length && headers[headers.length - 1] === '') headers.pop();
  const rows: SheetPaste['rows'] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const date = parseDateCell(cells[0] ?? '');
    if (!date) {
      skipped += 1;
      continue;
    }
    rows.push({ date, values: headers.map((_, i) => parseHoursCell(cells[i + 1] ?? '')) });
  }
  return { headers, rows, skipped };
}

const MODEL_PREFIX = /^(X1C|X1E|P1S|P1P|P2S|A1|H2D|H2S|H2C)/i;

export function guessModel(name: string): string | null {
  const m = MODEL_PREFIX.exec(name.trim());
  return m ? m[1].toUpperCase() : null;
}

const FAMILY_HUE: Record<string, number> = {
  X1C: 212, X1E: 212, P1S: 190, P1P: 190, P2S: 50, A1: 28, H2D: 275, H2S: 170, H2C: 330,
};

export function familyOf(machine: Pick<HourMachine, 'model' | 'name'>): string {
  return (machine.model ?? guessModel(machine.name) ?? '').toUpperCase().replace(/\s.*$/, '') || 'OTHER';
}

/** One stable colour per machine: hue by model family, lightness spread across the family's machines. */
export function machineColors(machines: HourMachine[]): Map<number, string> {
  const families = new Map<string, HourMachine[]>();
  for (const m of [...machines].sort((a, b) => a.name.localeCompare(b.name))) {
    const f = familyOf(m);
    families.set(f, [...(families.get(f) ?? []), m]);
  }
  const colors = new Map<number, string>();
  for (const [family, members] of families) {
    const hue = FAMILY_HUE[family];
    members.forEach((m, i) => {
      const light = members.length === 1 ? 55 : Math.round(40 + (32 * i) / (members.length - 1));
      colors.set(m.id, hue === undefined ? `hsl(0 0% ${light}%)` : `hsl(${hue} 75% ${light}%)`);
    });
  }
  return colors;
}

export type ColumnChoice = 'create' | 'ignore';

export interface ImportColumn {
  header: string;
  action: 'match' | 'create' | 'ignore';
  machineId: number | null;
  model: string | null;
}

export interface ImportPlan {
  columns: ImportColumn[];
  body: HourImportBody;
  dates: number;
  futureRows: number;
}

/**
 * Turn a parsed paste into an import body. Columns match machines by case-insensitive
 * name; an unmatched column is created as a retired machine when it looks like a printer
 * name (else ignored, which keeps the sheet's `Total` column out), unless `choices` says
 * otherwise. Blank and repeated headers are dropped, as are rows dated after `today`.
 */
export function planImport(
  paste: SheetPaste,
  machines: HourMachine[],
  choices: Record<string, ColumnChoice>,
  today: string,
): ImportPlan {
  const byName = new Map(machines.map((m) => [m.name.trim().toLowerCase(), m]));
  const seen = new Set<string>();
  const columns: (ImportColumn | null)[] = paste.headers.map((header) => {
    const k = header.toLowerCase();
    if (!header || seen.has(k)) return null;
    seen.add(k);
    const match = byName.get(k);
    if (match) return { header, action: 'match', machineId: match.id, model: match.model };
    const model = guessModel(header);
    const action = choices[header] ?? (model ? 'create' : 'ignore');
    return { header, action, machineId: null, model };
  });
  const rows = paste.rows.filter((r) => r.date <= today);
  const body: HourImportBody = {
    new_machines: columns
      .filter((c): c is ImportColumn => c !== null && c.action === 'create')
      .map((c) => ({ key: c.header, name: c.header, model: c.model })),
    readings: [],
  };
  for (const row of rows) {
    columns.forEach((c, i) => {
      const hours = row.values[i];
      if (!c || c.action === 'ignore' || hours === null) return;
      body.readings.push(
        c.action === 'match'
          ? { machine_id: c.machineId as number, reading_date: row.date, hours }
          : { key: c.header, reading_date: row.date, hours },
      );
    });
  }
  return {
    columns: columns.filter((c): c is ImportColumn => c !== null),
    body,
    dates: rows.length,
    futureRows: paste.rows.length - rows.length,
  };
}

```

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npx vitest run src/__tests__/utils/hoursSeries.test.ts`
Expected: all pass. If the `ratePerMonth(X1C04)` expectation is off, recompute by hand: window start 2026-01-25, `valueAt` = 3297 + 506·24/114 = 3403.5, so (3803 − 3403.5)/90·30.44 = 135.1. Fix the code, not the number.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
cd frontend && npm run typecheck && npx eslint src/utils/hoursSeries.ts src/__tests__/utils/hoursSeries.test.ts src/api/client.ts && cd ..
git add frontend/src/api/client.ts frontend/src/utils/hoursSeries.ts frontend/src/__tests__/utils/hoursSeries.test.ts
git commit -m "feat(maintenance): hours API client and series utilities"
```

---

### Task 7: Hours tab: list, chart and log

**Files:**
- Create: `frontend/src/components/maintenance/hours/HoursTab.tsx`, `MachineList.tsx`, `HoursChart.tsx`, `ReadingLog.tsx`
- Modify: `frontend/src/pages/MaintenancePage.tsx` (L95 `TabType`, header subtitle ~L1252-1262, tabs ~L1266-1288, body ~L1292)
- Modify: all 15 `frontend/src/i18n/locales/*.ts` (`maintenance.hours`)
- Test: `frontend/src/__tests__/components/HoursTab.test.tsx`

**Interfaces:**
- Consumes: Task 6 utilities and API functions.
- Produces: `<HoursTab />` (no props). `HoursTab` has `openForm(date)` and `pasteOpen` state, wired to placeholders here and filled in Tasks 8 and 9.

- [ ] **Step 1: Add i18n keys (all 15 locales)**

In each locale's `maintenance: { ... }` block, before `configureSettings`, add a `hours` object. English (`en.ts`):

```ts
    hours: {
      tab: 'Hours',
      subtitle: 'Lifetime hours per machine',
      modeCumulative: 'Cumulative hours',
      modeMonthly: 'Hours / month',
      modeTotal: 'Fleet total',
      newReading: 'New reading',
      pasteFromSheet: 'Paste from sheet',
      machines: 'Machines',
      showAll: 'all',
      showNone: 'none',
      retired: 'Retired',
      perMonth: '{{hours}} h/month',
      readingLog: 'Reading log',
      manual: 'manual',
      auto: 'auto',
      autoToday: 'Fenrir counters · today',
      machineCount: 'Machines: {{n}}',
      empty: 'No readings yet. Add one or paste your sheet.',
      partialMonth: 'The current month is still in progress.',
      deleteTitle: 'Delete readings',
      deleteMessage: "Delete the manual readings of {{date}}? Fenrir's automatic snapshots are kept.",
      deleteMachineTitle: 'Delete retired machine',
      deleteMachineMessage: 'Delete {{name}} and its whole hours history?',
      saved: 'Readings saved',
      deleted: 'Readings deleted',
      machineDeleted: 'Machine deleted',
    },
```

French (`fr.ts`):

```ts
    hours: {
      tab: 'Heures',
      subtitle: 'Heures cumulées par machine',
      modeCumulative: 'Heures cumulées',
      modeMonthly: 'Heures / mois',
      modeTotal: 'Total du parc',
      newReading: 'Nouveau relevé',
      pasteFromSheet: 'Coller depuis le tableur',
      machines: 'Machines',
      showAll: 'toutes',
      showNone: 'aucune',
      retired: 'Retirées',
      perMonth: '{{hours}} h/mois',
      readingLog: 'Historique des relevés',
      manual: 'manuel',
      auto: 'automatique',
      autoToday: "Compteurs Fenrir · aujourd'hui",
      machineCount: 'Machines : {{n}}',
      empty: 'Aucun relevé. Ajoutez-en un ou collez votre tableur.',
      partialMonth: 'Le mois en cours n’est pas terminé.',
      deleteTitle: 'Supprimer les relevés',
      deleteMessage: 'Supprimer les relevés manuels du {{date}} ? Les instantanés automatiques de Fenrir sont conservés.',
      deleteMachineTitle: 'Supprimer la machine retirée',
      deleteMachineMessage: 'Supprimer {{name}} et tout son historique d’heures ?',
      saved: 'Relevés enregistrés',
      deleted: 'Relevés supprimés',
      machineDeleted: 'Machine supprimée',
    },
```

Translate the same 26 keys for de, es, it, ja, ko, nl, pt-BR, ru, sv, tr, uk, zh-CN, zh-TW. Keep the `{{hours}}`, `{{n}}`, `{{date}}` and `{{name}}` placeholders. The gate rejects any value identical to English that isn't trivially short. fr `machines: 'Machines'` is correct French, so add `'Machines'` to `FR_COGNATES` in `frontend/scripts/check-i18n-parity.mjs` (it isn't there yet; `'Date'` already is). For `auto` (4 letters, so it's flagged), use a translated word in each locale rather than a cognate entry (fr `automatique`, de `automatisch`, …).

Run: `cd frontend && npm run check:i18n`
Expected: PASS.

- [ ] **Step 2: Write the failing component test**

Create `frontend/src/__tests__/components/HoursTab.test.tsx`:

```tsx
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { HoursTab } from '../../components/maintenance/hours/HoursTab';
import type { HoursOverview } from '../../api/client';

// jsdom has no layout, so ResponsiveContainer renders nothing; pin a size.
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: (props: ComponentProps<typeof actual.ResponsiveContainer>) => (
      <actual.ResponsiveContainer {...props} width={800} height={300} />
    ),
  };
});

const overview: HoursOverview = {
  today: '2026-10-04',
  machines: [
    { id: 1, printer_id: 6, name: 'X1C04', model: 'X1C', retired: false, current_hours: 3900 },
    { id: 2, printer_id: 3, name: 'H2S02', model: 'H2S', retired: false, current_hours: 1200 },
    { id: 3, printer_id: null, name: 'X1C01', model: 'X1C', retired: true, current_hours: null },
  ],
  readings: [
    { id: 1, machine_id: 1, reading_date: '2026-01-01', hours: 3297, source: 'manual' },
    { id: 2, machine_id: 1, reading_date: '2026-04-25', hours: 3803, source: 'manual' },
    { id: 3, machine_id: 2, reading_date: '2026-04-25', hours: 906, source: 'manual' },
    { id: 4, machine_id: 3, reading_date: '2026-04-25', hours: 4102, source: 'manual' },
    { id: 5, machine_id: 1, reading_date: '2026-10-04', hours: 3900, source: 'auto' },
    { id: 6, machine_id: 2, reading_date: '2026-10-04', hours: 1200, source: 'auto' },
  ],
};

function serve(data: HoursOverview = overview) {
  server.use(http.get('/api/v1/maintenance/hours', () => HttpResponse.json(data)));
}

describe('HoursTab', () => {
  it('lists active machines by family and retired ones last', async () => {
    serve();
    render(<HoursTab />);
    const list = await screen.findByTestId('hours-machine-list');
    const names = within(list).getAllByTestId('hours-machine-row').map((r) => r.dataset.name);
    expect(names).toEqual(['H2S02', 'X1C04', 'X1C01']);
    expect(within(list).getByText('Retired')).toBeInTheDocument();
  });

  it('logs manual dates newest first plus one auto row for today', async () => {
    serve();
    render(<HoursTab />);
    const log = await screen.findByTestId('hours-reading-log');
    const rows = within(log).getAllByTestId('hours-log-row').map((r) => r.dataset.date + ':' + r.dataset.source);
    expect(rows).toEqual(['2026-10-04:auto', '2026-04-25:manual', '2026-01-01:manual']);
  });

  it('switches chart modes', async () => {
    serve();
    const user = userEvent.setup();
    render(<HoursTab />);
    await screen.findByTestId('hours-machine-list');
    await user.click(screen.getByRole('button', { name: 'Hours / month' }));
    expect(await screen.findByText('The current month is still in progress.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fleet total' }));
    expect(screen.queryByText('The current month is still in progress.')).not.toBeInTheDocument();
  });

  it('toggles a machine off and back on', async () => {
    serve();
    const user = userEvent.setup();
    render(<HoursTab />);
    const row = (await screen.findAllByTestId('hours-machine-row')).find((r) => r.dataset.name === 'X1C04')!;
    await user.click(row);
    expect(row).toHaveAttribute('aria-pressed', 'false');
    await user.click(row);
    expect(row).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the empty state', async () => {
    serve({ today: '2026-10-04', machines: overview.machines.slice(0, 1), readings: [] });
    render(<HoursTab />);
    expect(await screen.findByText('No readings yet. Add one or paste your sheet.')).toBeInTheDocument();
  });

  it('deletes a manual date after confirmation', async () => {
    serve();
    let deleted: string | null = null;
    server.use(
      http.delete('/api/v1/maintenance/hours/readings', ({ request }) => {
        deleted = new URL(request.url).searchParams.get('reading_date');
        return HttpResponse.json(overview);
      }),
    );
    const user = userEvent.setup();
    render(<HoursTab />);
    const log = await screen.findByTestId('hours-reading-log');
    const row = within(log).getAllByTestId('hours-log-row').find((r) => r.dataset.date === '2026-01-01')!;
    await user.click(within(row).getByRole('button', { name: 'Delete' }));
    await screen.findByText('Delete readings');
    // ConfirmModal has no dialog role; it renders after the log, so its confirm is the last "Delete".
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    await user.click(deleteButtons[deleteButtons.length - 1]);
    await waitFor(() => expect(deleted).toBe('2026-01-01'));
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/components/HoursTab.test.tsx`
Expected: FAIL with "Failed to resolve import ../../components/maintenance/hours/HoursTab".

- [ ] **Step 4: Implement `MachineList.tsx`**

```tsx
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { HourMachine } from '../../../api/client';
import { familyOf } from '../../../utils/hoursSeries';

export interface MachineStat {
  hours: number | null;
  rate: number | null;
}

interface MachineListProps {
  machines: HourMachine[];
  colors: Map<number, string>;
  hidden: Set<number>;
  stats: Map<number, MachineStat>;
  canDelete: boolean;
  onToggle: (id: number) => void;
  onShowAll: () => void;
  onHideAll: () => void;
  onDeleteRetired: (machine: HourMachine) => void;
}

const fmt = (n: number) => Math.round(n).toLocaleString();

export function MachineList({
  machines, colors, hidden, stats, canDelete, onToggle, onShowAll, onHideAll, onDeleteRetired,
}: MachineListProps) {
  const { t } = useTranslation();
  const active = machines.filter((m) => !m.retired);
  const families = [...new Set(active.map(familyOf))].sort();
  const groups: { label: string; items: HourMachine[] }[] = [
    ...families.map((f) => ({
      label: f === 'OTHER' ? '—' : f,
      items: active.filter((m) => familyOf(m) === f).sort((a, b) => a.name.localeCompare(b.name)),
    })),
    { label: t('maintenance.hours.retired'), items: machines.filter((m) => m.retired) },
  ].filter((g) => g.items.length > 0);

  return (
    <div data-testid="hours-machine-list" className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-2 text-xs text-bambu-gray">
        <span>{t('maintenance.hours.machines')}</span>
        <span className="flex gap-2">
          <button type="button" className="text-bambu-green hover:underline" onClick={onShowAll}>
            {t('maintenance.hours.showAll')}
          </button>
          <button type="button" className="text-bambu-green hover:underline" onClick={onHideAll}>
            {t('maintenance.hours.showNone')}
          </button>
        </span>
      </div>
      <div className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
        {groups.map((g) => (
          <div key={g.label} className="flex gap-1 md:flex-col">
            <div className="hidden px-2 pt-3 text-[0.7rem] uppercase tracking-wider text-bambu-gray md:block">
              {g.label}
            </div>
            {g.items.map((m) => {
              const on = !hidden.has(m.id);
              const stat = stats.get(m.id);
              return (
                <div key={m.id} className="group flex shrink-0 items-center">
                  <button
                    type="button"
                    data-testid="hours-machine-row"
                    data-name={m.name}
                    aria-pressed={on}
                    onClick={() => onToggle(m.id)}
                    className={`flex flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-opacity hover:bg-bambu-dark-tertiary ${on ? '' : 'opacity-40'}`}
                  >
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colors.get(m.id) }} />
                    <span className="text-white">{m.name}</span>
                    <span className="ml-auto hidden text-right tabular-nums md:block">
                      {stat?.hours != null && <span className="text-white">{fmt(stat.hours)} h</span>}
                      {stat?.rate != null && (
                        <span className="block text-[0.7rem] text-bambu-gray">
                          {t('maintenance.hours.perMonth', { hours: fmt(stat.rate) })}
                        </span>
                      )}
                    </span>
                  </button>
                  {m.retired && canDelete && (
                    <button
                      type="button"
                      aria-label={t('maintenance.hours.deleteMachineTitle')}
                      onClick={() => onDeleteRetired(m)}
                      className="hidden p-1 text-bambu-gray opacity-0 hover:text-red-400 group-hover:opacity-100 md:block"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Implement `HoursChart.tsx`**

```tsx
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { HourMachine } from '../../../api/client';
import {
  dayNumber, fleetTotal, monthStarts, monthlyHours, seriesPoints, type HourPoint, type MachineSeries,
} from '../../../utils/hoursSeries';

export type HoursChartMode = 'cumulative' | 'monthly' | 'total';

interface HoursChartProps {
  mode: HoursChartMode;
  machines: HourMachine[];
  hidden: Set<number>;
  series: Map<number, MachineSeries>;
  colors: Map<number, string>;
  today: string;
}

const DAY_MS = 86_400_000;
const toXY = (p: HourPoint) => ({ x: dayNumber(p.date) * DAY_MS, y: p.hours });
const GRID = 'var(--color-bambu-dark-tertiary)';
const AXIS = { stroke: 'var(--color-bambu-gray)', fontSize: 11 };

export function HoursChart({ mode, machines, hidden, series, colors, today }: HoursChartProps) {
  const { t, i18n } = useTranslation();
  const num = (v: number) => Math.round(v).toLocaleString(i18n.language);
  const monthFmt = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: 'short', year: '2-digit', timeZone: 'UTC' }),
    [i18n.language],
  );
  const dayFmt = useMemo(() => new Intl.DateTimeFormat(i18n.language, { timeZone: 'UTC' }), [i18n.language]);
  const visible = machines.filter((m) => !hidden.has(m.id));

  if (mode === 'monthly') {
    const firstDates = visible.map((m) => seriesPoints(series.get(m.id)!)[0]?.date).filter(Boolean) as string[];
    const from = firstDates.sort()[0] ?? today;
    const months = monthStarts(from, today);
    const perMachine = new Map(visible.map((m) => [m.id, monthlyHours(seriesPoints(series.get(m.id)!), months)]));
    const rows = months.map((start, i) => ({
      month: dayNumber(start) * DAY_MS,
      ...Object.fromEntries(visible.map((m) => [`m${m.id}`, perMachine.get(m.id)![i]])),
    }));
    return (
      <>
        <ResponsiveContainer width="100%" height={380}>
          <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="month" tickFormatter={(v: number) => monthFmt.format(v)} tick={AXIS} />
            <YAxis tickFormatter={(v: number) => `${num(v)} h`} tick={AXIS} width={64} />
            <Tooltip
              labelFormatter={(v) => monthFmt.format(Number(v))}
              formatter={(v, name) => [`${num(Number(v))} h`, name]}
              contentStyle={{ background: 'var(--color-bambu-dark-secondary)', border: `1px solid ${GRID}` }}
            />
            {visible.map((m) => (
              <Bar key={m.id} dataKey={`m${m.id}`} name={m.name} stackId="h" fill={colors.get(m.id)} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
        <p className="mt-2 text-xs text-bambu-gray">{t('maintenance.hours.partialMonth')}</p>
      </>
    );
  }

  if (mode === 'total') {
    const all = machines.map((m) => seriesPoints(series.get(m.id)!));
    const dates = [...new Set(all.flat().map((p) => p.date))].sort();
    const totals = fleetTotal(all, dates);
    const data = dates.map((d, i) => ({ x: dayNumber(d) * DAY_MS, y: totals[i] }));
    return (
      <ResponsiveContainer width="100%" height={380}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="x" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(v: number) => monthFmt.format(v)} tick={AXIS} />
          <YAxis tickFormatter={(v: number) => `${num(v)} h`} tick={AXIS} width={72} />
          <Tooltip
            labelFormatter={(v) => dayFmt.format(Number(v))}
            formatter={(v) => [`${num(Number(v))} h`, t('maintenance.hours.modeTotal')]}
            contentStyle={{ background: 'var(--color-bambu-dark-secondary)', border: `1px solid ${GRID}` }}
          />
          <Area dataKey="y" stroke="var(--color-bambu-green)" fill="var(--color-bambu-green)" fillOpacity={0.12} strokeWidth={2.5} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={380}>
      <LineChart margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="x" type="number" scale="time" domain={['dataMin', 'dataMax']} allowDuplicatedCategory={false} tickFormatter={(v: number) => monthFmt.format(v)} tick={AXIS} />
        <YAxis tickFormatter={(v: number) => `${num(v)} h`} tick={AXIS} width={64} />
        <Tooltip
          labelFormatter={(v) => dayFmt.format(Number(v))}
          formatter={(v, name) => [`${num(Number(v))} h`, name]}
          contentStyle={{ background: 'var(--color-bambu-dark-secondary)', border: `1px solid ${GRID}` }}
        />
        {visible.flatMap((m) => {
          const s = series.get(m.id)!;
          const color = colors.get(m.id);
          const lastManual = s.manual[s.manual.length - 1];
          const auto = s.auto.length ? [...(lastManual ? [lastManual] : []), ...s.auto].map(toXY) : [];
          return [
            <Line key={`${m.id}-m`} data={s.manual.map(toXY)} dataKey="y" name={m.name} type="monotone" stroke={color} strokeWidth={2} dot={{ r: 3, fill: color, strokeWidth: 0 }} isAnimationActive={false} />,
            auto.length > 0 && (
              <Line key={`${m.id}-a`} data={auto} dataKey="y" name={`${m.name} · ${t('maintenance.hours.auto')}`} type="monotone" stroke={color} strokeWidth={1.5} strokeDasharray="4 4" dot={false} legendType="none" isAnimationActive={false} />
            ),
          ];
        })}
      </LineChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 6: Implement `ReadingLog.tsx`**

```tsx
import { useTranslation } from 'react-i18next';
import type { HourReading } from '../../../api/client';
import { Button } from '../../Button';

interface ReadingLogProps {
  readings: HourReading[];
  today: string;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (date: string) => void;
  onDelete: (date: string) => void;
}

interface LogRow {
  date: string;
  source: 'manual' | 'auto';
  count: number;
  sum: number;
}

export function ReadingLog({ readings, today, canEdit, canDelete, onEdit, onDelete }: ReadingLogProps) {
  const { t, i18n } = useTranslation();
  const dayFmt = new Intl.DateTimeFormat(i18n.language, { timeZone: 'UTC' });
  const byDate = new Map<string, LogRow>();
  for (const r of readings) {
    if (r.source === 'auto' && r.reading_date !== today) continue;
    const key = `${r.reading_date}|${r.source}`;
    const row = byDate.get(key) ?? { date: r.reading_date, source: r.source, count: 0, sum: 0 };
    row.count += 1;
    row.sum += r.hours;
    byDate.set(key, row);
  }
  const rows = [...byDate.values()].sort((a, b) =>
    a.date === b.date ? (a.source === 'auto' ? -1 : 1) : b.date.localeCompare(a.date),
  );

  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-bambu-gray">{t('maintenance.hours.empty')}</p>;
  }
  return (
    <div data-testid="hours-reading-log" className="flex flex-col">
      {rows.map((row) => (
        <div
          key={`${row.date}-${row.source}`}
          data-testid="hours-log-row"
          data-date={row.date}
          data-source={row.source}
          className="flex items-center gap-3 border-b border-bambu-dark-tertiary py-2.5 text-sm last:border-b-0"
        >
          <span className={`rounded-full px-2 py-0.5 text-[0.7rem] ${row.source === 'manual' ? 'bg-bambu-green/20 text-bambu-green' : 'bg-bambu-dark-tertiary text-bambu-gray-light'}`}>
            {t(`maintenance.hours.${row.source}`)}
          </span>
          <span className="font-semibold text-white">
            {row.source === 'auto' ? t('maintenance.hours.autoToday') : dayFmt.format(new Date(`${row.date}T00:00:00Z`))}
          </span>
          <span className="text-bambu-gray">{t('maintenance.hours.machineCount', { n: row.count })}</span>
          <span className="ml-auto tabular-nums text-bambu-gray">Σ {Math.round(row.sum).toLocaleString(i18n.language)} h</span>
          {row.source === 'manual' && canEdit && (
            <Button variant="secondary" size="sm" onClick={() => onEdit(row.date)}>{t('common.edit')}</Button>
          )}
          {row.source === 'manual' && canDelete && (
            <Button variant="ghost" size="sm" onClick={() => onDelete(row.date)}>{t('common.delete')}</Button>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 7: Implement `HoursTab.tsx`**

```tsx
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ClipboardPaste, Loader2, Plus } from 'lucide-react';
import { api, type HourMachine } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import { machineColors, machineSeries, ratePerMonth, seriesPoints } from '../../../utils/hoursSeries';
import { Button } from '../../Button';
import { Card, CardContent } from '../../Card';
import { ConfirmModal } from '../../ConfirmModal';
import { HoursChart, type HoursChartMode } from './HoursChart';
import { MachineList, type MachineStat } from './MachineList';
import { ReadingLog } from './ReadingLog';

const MODES: HoursChartMode[] = ['cumulative', 'monthly', 'total'];
const MODE_KEY: Record<HoursChartMode, string> = {
  cumulative: 'maintenance.hours.modeCumulative',
  monthly: 'maintenance.hours.modeMonthly',
  total: 'maintenance.hours.modeTotal',
};

export function HoursTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('maintenance:update');
  const canDelete = hasPermission('maintenance:delete');

  const { data, isLoading } = useQuery({ queryKey: ['maintenanceHours'], queryFn: api.getPrinterHours });
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<HoursChartMode>('cumulative');
  const [formDate, setFormDate] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [confirmDate, setConfirmDate] = useState<string | null>(null);
  const [confirmMachine, setConfirmMachine] = useState<HourMachine | null>(null);

  const machines = useMemo(() => data?.machines ?? [], [data]);
  const series = useMemo(
    () => new Map(machines.map((m) => [m.id, machineSeries(data?.readings ?? [], m.id)])),
    [machines, data],
  );
  const colors = useMemo(() => machineColors(machines), [machines]);
  const stats = useMemo(() => {
    const out = new Map<number, MachineStat>();
    for (const m of machines) {
      const pts = seriesPoints(series.get(m.id)!);
      out.set(m.id, {
        hours: m.current_hours ?? (pts.length ? pts[pts.length - 1].hours : null),
        rate: data ? ratePerMonth(pts, data.today) : null,
      });
    }
    return out;
  }, [machines, series, data]);

  const deleteDate = useMutation({
    mutationFn: (date: string) => api.deleteHourReadings(date),
    onSuccess: (overview) => {
      queryClient.setQueryData(['maintenanceHours'], overview);
      showToast(t('maintenance.hours.deleted'));
    },
    onError: (e: Error) => showToast(e.message, 'error'),
    onSettled: () => setConfirmDate(null),
  });
  const deleteMachine = useMutation({
    mutationFn: (id: number) => api.deleteHourMachine(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['maintenanceHours'] });
      showToast(t('maintenance.hours.machineDeleted'));
    },
    onError: (e: Error) => showToast(e.message, 'error'),
    onSettled: () => setConfirmMachine(null),
  });

  if (isLoading || !data) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-bambu-green" /></div>;
  }

  const toggle = (id: number) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="grid gap-4 md:grid-cols-[280px_1fr]">
      <Card className="md:max-h-[640px] md:overflow-auto">
        <CardContent>
          <MachineList
            machines={machines}
            colors={colors}
            hidden={hidden}
            stats={stats}
            canDelete={canDelete}
            onToggle={toggle}
            onShowAll={() => setHidden(new Set())}
            onHideAll={() => setHidden(new Set(machines.map((m) => m.id)))}
            onDeleteRetired={setConfirmMachine}
          />
        </CardContent>
      </Card>
      <div className="flex min-w-0 flex-col gap-4">
        <Card>
          <CardContent>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-0.5">
                {MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`rounded-md px-3 py-1 text-sm ${mode === m ? 'bg-bambu-dark-tertiary text-white' : 'text-bambu-gray hover:text-white'}`}
                  >
                    {t(MODE_KEY[m])}
                  </button>
                ))}
              </div>
              {canEdit && (
                <Button className="ml-auto" size="sm" onClick={() => setFormDate(data.today)}>
                  <Plus className="h-4 w-4" />
                  {t('maintenance.hours.newReading')}
                </Button>
              )}
            </div>
            <HoursChart mode={mode} machines={machines} hidden={hidden} series={series} colors={colors} today={data.today} />
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="mb-1 flex items-center">
              <h3 className="font-semibold text-white">{t('maintenance.hours.readingLog')}</h3>
              {canEdit && (
                <Button className="ml-auto" variant="secondary" size="sm" onClick={() => setPasteOpen(true)}>
                  <ClipboardPaste className="h-4 w-4" />
                  {t('maintenance.hours.pasteFromSheet')}
                </Button>
              )}
            </div>
            <ReadingLog
              readings={data.readings}
              today={data.today}
              canEdit={canEdit}
              canDelete={canDelete}
              onEdit={setFormDate}
              onDelete={setConfirmDate}
            />
          </CardContent>
        </Card>
      </div>

      {/* Task 8 mounts ReadingFormModal on formDate; Task 9 mounts PasteImportModal on pasteOpen. */}
      {formDate === null && pasteOpen === false ? null : null}

      {confirmDate && (
        <ConfirmModal
          title={t('maintenance.hours.deleteTitle')}
          message={t('maintenance.hours.deleteMessage', { date: confirmDate })}
          confirmText={t('common.delete')}
          variant="danger"
          isLoading={deleteDate.isPending}
          onConfirm={() => deleteDate.mutate(confirmDate)}
          onCancel={() => setConfirmDate(null)}
        />
      )}
      {confirmMachine && (
        <ConfirmModal
          title={t('maintenance.hours.deleteMachineTitle')}
          message={t('maintenance.hours.deleteMachineMessage', { name: confirmMachine.name })}
          confirmText={t('common.delete')}
          variant="danger"
          isLoading={deleteMachine.isPending}
          onConfirm={() => deleteMachine.mutate(confirmMachine.id)}
          onCancel={() => setConfirmMachine(null)}
        />
      )}
    </div>
  );
}
```

The `formDate === null && pasteOpen === false ? null : null` line only keeps the two state setters referenced until Tasks 8 and 9 replace it with the real modals. If ESLint/tsc still flag `formDate`/`pasteOpen` as unused, keep this line; otherwise delete it.

- [ ] **Step 8: Mount the tab in `MaintenancePage.tsx`**

- Change L95 to `type TabType = 'status' | 'settings' | 'hours';`.
- Add `import { HoursTab } from '../components/maintenance/hours/HoursTab';` to the imports.
- In the header subtitle, change `) : (\n            t('maintenance.configureSettings')\n          )}` so that the `settings` tab shows `configureSettings` and the `hours` tab shows `t('maintenance.hours.subtitle')`:

```tsx
          ) : activeTab === 'hours' ? (
            t('maintenance.hours.subtitle')
          ) : (
            t('maintenance.configureSettings')
          )}
```

- After the Settings tab button, add a third button with the same classes, using `activeTab === 'hours'`, `onClick={() => setActiveTab('hours')}` and the label `{t('maintenance.hours.tab')}`.
- Change the body switch `{activeTab === 'status' ? ( ...status... ) : ( ...settings... )}` to render `<HoursTab />` when `activeTab === 'hours'`. Wrap it: `{activeTab === 'hours' ? <HoursTab /> : activeTab === 'status' ? (...) : (...)}`.

- [ ] **Step 9: Run tests**

Run: `cd frontend && npx vitest run src/__tests__/components/HoursTab.test.tsx`
Then: `cd frontend && npx vitest run src/__tests__/pages/MaintenancePage.test.tsx`
Expected: both PASS.

- [ ] **Step 10: Typecheck, lint, i18n, commit**

```bash
cd frontend && npm run typecheck && npm run lint && npm run check:i18n && cd ..
git add frontend/src/components/maintenance/hours frontend/src/pages/MaintenancePage.tsx frontend/src/i18n/locales frontend/scripts/check-i18n-parity.mjs frontend/src/__tests__/components/HoursTab.test.tsx
git commit -m "feat(maintenance): hours tab with machine list, chart modes and reading log"
```

---

### Task 8: New / edit reading form

**Files:**
- Create: `frontend/src/components/maintenance/hours/ReadingFormModal.tsx`
- Modify: `frontend/src/components/maintenance/hours/HoursTab.tsx`
- Modify: all 15 locale files (`maintenance.hours.form`)
- Test: `frontend/src/__tests__/components/HoursTab.test.tsx`

**Interfaces:**
- Consumes: `parseHoursInput`, `machineSeries` (Task 6); `api.saveHourReadings`.
- Produces: `<ReadingFormModal initialDate today machines readings isSaving onSave(date, entries) onClose />`.

- [ ] **Step 1: i18n keys (all 15 locales)**

Inside `maintenance.hours`, add en:

```ts
      form: {
        title: 'New reading',
        editTitle: 'Edit reading',
        date: 'Date',
        hint: "Type each machine's lifetime hours from its screen. Grey values are Fenrir's counters; empty fields are skipped.",
        recalibrateNote: "Readings dated today recalibrate each machine's counter, so maintenance due dates follow the printer screen.",
        backdatedNote: 'Backdated readings are stored for the history only.',
        lowerThanPrevious: 'Lower than the previous reading ({{hours}} h)',
        invalid: 'Not a number',
      },
```

fr:

```ts
      form: {
        title: 'Nouveau relevé',
        editTitle: 'Modifier le relevé',
        date: 'Date',
        hint: 'Saisissez les heures cumulées affichées sur l’écran de chaque machine. Les valeurs grisées sont les compteurs Fenrir ; les champs vides sont ignorés.',
        recalibrateNote: 'Les relevés datés d’aujourd’hui recalent le compteur de chaque machine : les échéances de maintenance suivent l’écran de l’imprimante.',
        backdatedNote: 'Les relevés antérieurs sont conservés uniquement pour l’historique.',
        lowerThanPrevious: 'Inférieur au relevé précédent ({{hours}} h)',
        invalid: 'Nombre invalide',
      },
```

Translate the same keys for the other 13 locales (`Date` is a cognate in fr; check `FR_COGNATES`).

- [ ] **Step 2: Write the failing tests**

Append to `HoursTab.test.tsx` inside `describe('HoursTab', ...)`:

```tsx
  it('form lists only Fenrir printers, defaults to the server date and shows counters as placeholders', async () => {
    serve();
    const user = userEvent.setup();
    render(<HoursTab />);
    await user.click(await screen.findByRole('button', { name: 'New reading' }));
    const dialog = await screen.findByTestId('hours-reading-form');
    expect(within(dialog).getByLabelText('Date')).toHaveValue('2026-10-04'); // server today, not the browser's
    const fields = within(dialog).getAllByRole('textbox');
    expect(fields.map((f) => f.getAttribute('name'))).toEqual(['H2S02', 'X1C04']); // no retired X1C01
    expect(within(dialog).getByRole('textbox', { name: 'X1C04' })).toHaveValue('');
    expect(within(dialog).getByRole('textbox', { name: 'X1C04' })).toHaveAttribute('placeholder', expect.stringContaining('3'));
    expect(within(dialog).getByText(/recalibrate/)).toBeInTheDocument();
  });

  it('flags a value lower than the previous reading and saves only filled fields', async () => {
    serve();
    let body: unknown = null;
    server.use(
      http.post('/api/v1/maintenance/hours/readings', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(overview);
      }),
    );
    const user = userEvent.setup();
    render(<HoursTab />);
    await user.click(await screen.findByRole('button', { name: 'New reading' }));
    const dialog = await screen.findByTestId('hours-reading-form');
    await user.type(within(dialog).getByRole('textbox', { name: 'X1C04' }), '3 700');
    expect(within(dialog).getByText('Lower than the previous reading (3,803 h)')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(body).toEqual({ reading_date: '2026-10-04', entries: [{ machine_id: 1, hours: 3700 }] }),
    );
  });

  it('edit prefills the date values and clearing a field sends null', async () => {
    serve();
    let body: unknown = null;
    server.use(
      http.post('/api/v1/maintenance/hours/readings', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(overview);
      }),
    );
    const user = userEvent.setup();
    render(<HoursTab />);
    const log = await screen.findByTestId('hours-reading-log');
    const row = within(log).getAllByTestId('hours-log-row').find((r) => r.dataset.date === '2026-04-25')!;
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByTestId('hours-reading-form');
    expect(within(dialog).getByText(/history only/)).toBeInTheDocument();
    const x1c04 = within(dialog).getByRole('textbox', { name: 'X1C04' });
    expect(x1c04).toHaveValue('3803');
    await user.clear(within(dialog).getByRole('textbox', { name: 'H2S02' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(body).toEqual({
        reading_date: '2026-04-25',
        entries: [{ machine_id: 2, hours: null }, { machine_id: 1, hours: 3803 }],
      }),
    );
  });

  it('disables save on an invalid number', async () => {
    serve();
    const user = userEvent.setup();
    render(<HoursTab />);
    await user.click(await screen.findByRole('button', { name: 'New reading' }));
    const dialog = await screen.findByTestId('hours-reading-form');
    await user.type(within(dialog).getByRole('textbox', { name: 'H2S02' }), '12a');
    expect(within(dialog).getByText('Not a number')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  });
```

The number format in `'Lower than the previous reading (3,803 h)'` depends on the test i18n language. If the test renders in `en`, `toLocaleString('en')` gives `3,803`. Adjust the expected string to whatever the `render` helper's language produces, as long as it contains the previous value.

- [ ] **Step 3: Run to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/components/HoursTab.test.tsx`
Expected: the 4 new tests FAIL (no `hours-reading-form`).

- [ ] **Step 4: Implement `ReadingFormModal.tsx`**

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HourMachine, HourReading } from '../../../api/client';
import { parseHoursInput } from '../../../utils/hoursSeries';
import { Button } from '../../Button';

interface ReadingFormModalProps {
  initialDate: string;
  today: string;
  machines: HourMachine[];
  readings: HourReading[];
  colors: Map<number, string>;
  isSaving: boolean;
  onSave: (date: string, entries: { machine_id: number; hours: number | null }[]) => void;
  onClose: () => void;
}

export function ReadingFormModal({
  initialDate, today, machines, readings, colors, isSaving, onSave, onClose,
}: ReadingFormModalProps) {
  const { t, i18n } = useTranslation();
  const active = useMemo(
    () => machines.filter((m) => !m.retired).sort((a, b) => a.name.localeCompare(b.name)),
    [machines],
  );
  const manualOn = (date: string) =>
    new Map(readings.filter((r) => r.source === 'manual' && r.reading_date === date).map((r) => [r.machine_id, r.hours]));
  const prefill = (date: string) => {
    const existing = manualOn(date);
    return Object.fromEntries(active.map((m) => [m.id, existing.has(m.id) ? String(existing.get(m.id)) : '']));
  };
  const [date, setDate] = useState(initialDate);
  const [values, setValues] = useState<Record<number, string>>(() => prefill(initialDate));
  const isEdit = manualOn(initialDate).size > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const previous = (machineId: number) =>
    readings
      .filter((r) => r.machine_id === machineId && r.source === 'manual' && r.reading_date < date)
      .sort((a, b) => b.reading_date.localeCompare(a.reading_date))[0];

  const existing = manualOn(date);
  let invalid = false;
  const entries: { machine_id: number; hours: number | null }[] = [];
  for (const m of active) {
    const parsed = parseHoursInput(values[m.id] ?? '');
    if (parsed === undefined) invalid = true;
    else if (parsed === null) {
      if (existing.has(m.id)) entries.push({ machine_id: m.id, hours: null });
    } else entries.push({ machine_id: m.id, hours: parsed });
  }
  const fmt = (n: number) => Math.round(n).toLocaleString(i18n.language);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-overlay-in" onClick={onClose}>
      <div
        data-testid="hours-reading-form"
        role="dialog"
        aria-modal="true"
        className="max-h-[88vh] w-[min(720px,94vw)] overflow-auto rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-white">
          {isEdit ? t('maintenance.hours.form.editTitle') : t('maintenance.hours.form.title')}
        </h2>
        <p className="mt-1 text-sm text-bambu-gray">{t('maintenance.hours.form.hint')}</p>
        <label className="mt-4 flex items-center gap-3 text-sm text-bambu-gray-light">
          {t('maintenance.hours.form.date')}
          <input
            type="date"
            value={date}
            max={today}
            onChange={(e) => {
              if (!e.target.value) return;
              setDate(e.target.value);
              setValues(prefill(e.target.value));
            }}
            className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1.5 text-white"
          />
        </label>
        <div className="mt-4 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
          {active.map((m) => {
            const raw = values[m.id] ?? '';
            const parsed = parseHoursInput(raw);
            const prev = previous(m.id);
            const lower = typeof parsed === 'number' && prev !== undefined && parsed < prev.hours;
            return (
              <div key={m.id} className="flex flex-col">
                <label className="flex items-center gap-2 text-sm">
                  <span className="flex w-24 items-center gap-1.5 text-bambu-gray-light">
                    <span className="h-2 w-2 rounded-full" style={{ background: colors.get(m.id) }} />
                    {m.name}
                  </span>
                  <input
                    name={m.name}
                    aria-label={m.name}
                    inputMode="decimal"
                    value={raw}
                    placeholder={date === today && m.current_hours != null ? fmt(m.current_hours) : ''}
                    onChange={(e) => setValues((v) => ({ ...v, [m.id]: e.target.value }))}
                    className={`w-full rounded-lg border bg-bambu-dark px-2 py-1.5 text-right tabular-nums text-white placeholder:text-bambu-gray-dark ${parsed === undefined ? 'border-red-500' : lower ? 'border-amber-500' : 'border-bambu-dark-tertiary'}`}
                  />
                </label>
                {parsed === undefined && <span className="pl-24 text-xs text-red-400">{t('maintenance.hours.form.invalid')}</span>}
                {lower && (
                  <span className="pl-24 text-xs text-amber-500">
                    {t('maintenance.hours.form.lowerThanPrevious', { hours: fmt(prev.hours) })}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-4 rounded-lg bg-bambu-dark p-3 text-xs text-bambu-gray">
          {date === today ? t('maintenance.hours.form.recalibrateNote') : t('maintenance.hours.form.backdatedNote')}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={invalid || entries.length === 0 || isSaving} onClick={() => onSave(date, entries)}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

If `react-hooks/exhaustive-deps` or `react-compiler` lint rules complain about `prefill` inside `useState`'s initialiser, inline the initial computation. Don't silence the rule.

- [ ] **Step 5: Wire it in `HoursTab.tsx`**

Add the import `import { ReadingFormModal } from './ReadingFormModal';` and a mutation:

```tsx
  const saveReadings = useMutation({
    mutationFn: ({ date, entries }: { date: string; entries: { machine_id: number; hours: number | null }[] }) =>
      api.saveHourReadings(date, entries),
    onSuccess: (overview) => {
      queryClient.setQueryData(['maintenanceHours'], overview);
      queryClient.invalidateQueries({ queryKey: ['maintenanceOverview'] });
      queryClient.invalidateQueries({ queryKey: ['maintenanceSummary'] });
      setFormDate(null);
      showToast(t('maintenance.hours.saved'));
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
```

Replace the placeholder line `{formDate === null && pasteOpen === false ? null : null}` with:

```tsx
      {formDate !== null && (
        <ReadingFormModal
          initialDate={formDate}
          today={data.today}
          machines={machines}
          readings={data.readings}
          colors={colors}
          isSaving={saveReadings.isPending}
          onSave={(date, entries) => saveReadings.mutate({ date, entries })}
          onClose={() => setFormDate(null)}
        />
      )}
      {pasteOpen ? null : null}
```

(`pasteOpen` is still referenced; Task 9 replaces that line.) Declare the mutation **before** the early `isLoading` return; hooks must not follow a conditional return.

The Status tab's hours come from `['maintenanceOverview']`; invalidating it makes a recalibration show up there.

- [ ] **Step 6: Run tests, typecheck, lint, i18n, commit**

```bash
cd frontend && npx vitest run src/__tests__/components/HoursTab.test.tsx && npm run typecheck && npm run lint && npm run check:i18n && cd ..
git add frontend/src/components/maintenance/hours frontend/src/i18n/locales frontend/scripts/check-i18n-parity.mjs frontend/src/__tests__/components/HoursTab.test.tsx
git commit -m "feat(maintenance): new/edit hours reading form with recalibration note"
```

---

### Task 9: Paste-from-sheet import

**Files:**
- Create: `frontend/src/components/maintenance/hours/PasteImportModal.tsx`
- Modify: `frontend/src/components/maintenance/hours/HoursTab.tsx`
- Modify: all 15 locale files (`maintenance.hours.paste`)
- Test: `frontend/src/__tests__/components/HoursTab.test.tsx`

**Interfaces:**
- Consumes: `parseSheetPaste`, `planImport`, `ColumnChoice` (Task 6); `api.importHourReadings`.
- Produces: `<PasteImportModal machines today isImporting onImport(body) onClose />`.

- [ ] **Step 1: i18n keys (all 15 locales)**

en, inside `maintenance.hours`:

```ts
      paste: {
        title: 'Paste from sheet',
        hint: 'Select the header row and the date rows in your sheet, copy, and paste here. Columns are matched to printers by name; zeros and empty cells are skipped.',
        summary: '{{dates}} dates · {{columns}} columns · {{readings}} readings',
        matched: 'Matched',
        unmatched: 'Not in Fenrir',
        createRetired: 'Create as retired machine',
        ignore: 'Ignore',
        replaceNote: 'Dates already on file are replaced.',
        noRows: 'No row starts with a date. Copy the header row together with the date rows.',
        futureRows: 'Rows dated in the future are skipped: {{n}}',
        import: 'Import',
        imported: 'Readings imported: {{n}}',
      },
```

fr:

```ts
      paste: {
        title: 'Coller depuis le tableur',
        hint: 'Sélectionnez la ligne d’en-tête et les lignes datées dans votre tableur, copiez, puis collez ici. Les colonnes sont associées aux imprimantes par leur nom ; les zéros et cellules vides sont ignorés.',
        summary: '{{dates}} dates · {{columns}} colonnes · {{readings}} relevés',
        matched: 'Associée',
        unmatched: 'Absente de Fenrir',
        createRetired: 'Créer comme machine retirée',
        ignore: 'Ignorer',
        replaceNote: 'Les dates déjà enregistrées sont remplacées.',
        noRows: 'Aucune ligne ne commence par une date. Copiez la ligne d’en-tête avec les lignes datées.',
        futureRows: 'Lignes datées dans le futur ignorées : {{n}}',
        import: 'Importer',
        imported: 'Relevés importés : {{n}}',
      },
```

Translate the same keys for the other 13 locales.

- [ ] **Step 2: Write the failing tests**

Append inside `describe('HoursTab', ...)`:

```tsx
  it('previews a pasted sheet and imports matched + new retired columns', async () => {
    serve();
    let body: unknown = null;
    server.use(
      http.post('/api/v1/maintenance/hours/import', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ machines_created: 1, readings_written: 3 });
      }),
    );
    const user = userEvent.setup();
    render(<HoursTab />);
    await user.click(await screen.findByRole('button', { name: 'Paste from sheet' }));
    const dialog = await screen.findByTestId('hours-paste-import');
    const text = 'Date\tX1C04\tX1C02\tTotal\n19/07/2024\t243\t212\t455\n25/04/2026\t3803\t0\t3803\n';
    await user.click(within(dialog).getByRole('textbox'));
    await user.paste(text);
    expect(within(dialog).getByText('2 dates · 2 columns · 3 readings')).toBeInTheDocument(); // Total is ignored
    const x1c02 = within(dialog).getByTestId('paste-column-X1C02');
    expect(within(x1c02).getByRole('combobox')).toHaveValue('create');
    expect(within(within(dialog).getByTestId('paste-column-Total')).getByRole('combobox')).toHaveValue('ignore');
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(body).toEqual({
        new_machines: [{ key: 'X1C02', name: 'X1C02', model: 'X1C' }],
        readings: [
          { machine_id: 1, reading_date: '2024-07-19', hours: 243 },
          { key: 'X1C02', reading_date: '2024-07-19', hours: 212 },
          { machine_id: 1, reading_date: '2026-04-25', hours: 3803 },
        ],
      }),
    );
  });

  it('explains a paste without dated rows and keeps Import disabled', async () => {
    serve();
    const user = userEvent.setup();
    render(<HoursTab />);
    await user.click(await screen.findByRole('button', { name: 'Paste from sheet' }));
    const dialog = await screen.findByTestId('hours-paste-import');
    await user.click(within(dialog).getByRole('textbox'));
    await user.paste('X1C04\t3803');
    expect(within(dialog).getByText(/No row starts with a date/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Import' })).toBeDisabled();
  });
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/components/HoursTab.test.tsx`
Expected: the 2 new tests FAIL.

- [ ] **Step 4: Implement `PasteImportModal.tsx`**

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HourImportBody, HourMachine } from '../../../api/client';
import { parseSheetPaste, planImport, type ColumnChoice } from '../../../utils/hoursSeries';
import { Button } from '../../Button';

interface PasteImportModalProps {
  machines: HourMachine[];
  today: string;
  isImporting: boolean;
  onImport: (body: HourImportBody) => void;
  onClose: () => void;
}

export function PasteImportModal({ machines, today, isImporting, onImport, onClose }: PasteImportModalProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [choices, setChoices] = useState<Record<string, ColumnChoice>>({});
  const paste = useMemo(() => parseSheetPaste(text), [text]);
  const plan = useMemo(() => planImport(paste, machines, choices, today), [paste, machines, choices, today]);
  const placeholder = useMemo(
    () => ['Date', ...machines.slice(0, 3).map((m) => m.name)].join('\t') + '\n19/07/2024\t1470\t212\t491',
    [machines],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const hasText = text.trim() !== '';
  const noRows = hasText && plan.dates === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-overlay-in" onClick={onClose}>
      <div
        data-testid="hours-paste-import"
        role="dialog"
        aria-modal="true"
        className="max-h-[88vh] w-[min(760px,94vw)] overflow-auto rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-white">{t('maintenance.hours.paste.title')}</h2>
        <p className="mt-1 text-sm text-bambu-gray">{t('maintenance.hours.paste.hint')}</p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className="mt-3 h-36 w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-2 font-mono text-xs text-white"
        />
        {noRows && <p className="mt-2 text-sm text-amber-500">{t('maintenance.hours.paste.noRows')}</p>}
        {hasText && !noRows && (
          <>
            <p className="mt-3 text-sm text-white">
              {t('maintenance.hours.paste.summary', {
                dates: plan.dates,
                columns: plan.columns.filter((c) => c.action !== 'ignore').length,
                readings: plan.body.readings.length,
              })}
            </p>
            {plan.futureRows > 0 && (
              <p className="text-xs text-amber-500">{t('maintenance.hours.paste.futureRows', { n: plan.futureRows })}</p>
            )}
            <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {plan.columns.map((c) => (
                <div key={c.header} data-testid={`paste-column-${c.header}`} className="flex items-center gap-2 text-sm">
                  <span className="w-24 truncate text-white">{c.header}</span>
                  {c.action === 'match' ? (
                    <span className="text-bambu-green">{t('maintenance.hours.paste.matched')}</span>
                  ) : (
                    <select
                      aria-label={`${c.header} · ${t('maintenance.hours.paste.unmatched')}`}
                      value={c.action}
                      onChange={(e) => setChoices((prev) => ({ ...prev, [c.header]: e.target.value as ColumnChoice }))}
                      className="flex-1 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1 text-sm text-white"
                    >
                      <option value="create">{t('maintenance.hours.paste.createRetired')}</option>
                      <option value="ignore">{t('maintenance.hours.paste.ignore')}</option>
                    </select>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-3 rounded-lg bg-bambu-dark p-3 text-xs text-bambu-gray">{t('maintenance.hours.paste.replaceNote')}</p>
          </>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={plan.body.readings.length === 0 || isImporting} onClick={() => onImport(plan.body)}>
            {t('maintenance.hours.paste.import')}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Wire it in `HoursTab.tsx`**

Import `PasteImportModal` and add (before the early return):

```tsx
  const importReadings = useMutation({
    mutationFn: api.importHourReadings,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['maintenanceHours'] });
      setPasteOpen(false);
      showToast(t('maintenance.hours.paste.imported', { n: result.readings_written }));
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });
```

Replace `{pasteOpen ? null : null}` with:

```tsx
      {pasteOpen && (
        <PasteImportModal
          machines={machines}
          today={data.today}
          isImporting={importReadings.isPending}
          onImport={(body) => importReadings.mutate(body)}
          onClose={() => setPasteOpen(false)}
        />
      )}
```

- [ ] **Step 6: Run tests, typecheck, lint, i18n, commit**

```bash
cd frontend && npx vitest run src/__tests__/components/HoursTab.test.tsx && npm run typecheck && npm run lint && npm run check:i18n && cd ..
git add frontend/src/components/maintenance/hours frontend/src/i18n/locales frontend/scripts/check-i18n-parity.mjs frontend/src/__tests__/components/HoursTab.test.tsx
git commit -m "feat(maintenance): paste a Google Sheet into the hours history"
```

---

### Task 10: Full verification and sandbox demo

**Files:** none new. This task is verification only, plus fixes for anything it finds.

- [ ] **Step 1: Full suites**

```bash
./test_backend.sh
./test_frontend.sh
```

Expected: both green. `test_frontend.sh` ends with a `FAILED: typecheck=… lint=… tests=…` line on failure; read it. If a backend file fails only in the full run, rerun it alone first.

- [ ] **Step 2: Production bundle check (do not commit `static/`)**

```bash
cd frontend && npm run build && cd ..
git status --short static | head -3
git checkout -- static && git clean -fdq static
```

Expected: the build passes the Safari 16 baseline check. The `static/` changes are discarded; rebuilding `static/` is a separate, deliberate commit at merge time.

- [ ] **Step 3: Sandbox backend on a DB copy**

Follow the memory recipe "Sandboxed test server": copy `/Users/paultheis/Documents/Code/bambuddy/bambuddy.db` into the scratchpad. Neutralise it so the sandbox can't reach real printers or Zoho/Heimdall (deactivate printers by setting `is_active=0` on the copy). Start this worktree's backend on :8031 with `DATA_DIR` pointing at the copy's directory, and Vite on :5184 with `BACKEND_PORT=8031 VITE_USE_POLLING=1`. Never start it against the root DB.

- [ ] **Step 4: Demo in Brave**

Open `http://localhost:5184/maintenance` and sign in to the sandbox. On the Hours tab:
1. Paste the operator's sheet: X1C01–03 and H2C03–04 are proposed as retired, Total is ignored.
2. Check the fleet total on 25/04/2026 reads 37,115 h.
3. Add a reading for X1C04 dated today. The Status tab's X1C04 hours then match it.
4. Edit 25/04 and check that retired machines are absent from the form.
5. Check the Hours / month bars, and the phone layout at 390 px width.

Take screenshots for the user.

- [ ] **Step 5: Stop the sandbox, then report**

Stop the :8031 and :5184 processes and delete the DB copy. Report to the user: suites green (with counts), screenshots, and that the change has not been merged into `main` nor pushed. Merging means rebuilding `static/` and restarting the user's :8000 server (the new tables are created by `create_all` at startup).
