# Hours Tab Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sharpen the Maintenance › Hours tab (direction C) and add the twelve tools the user picked: reading pass, wrong-number check, counter trust, pace flags, load, forecast, same-age mode, chart events, machine panel, fleet strip, readings-due reminder, cost per hour.

**Architecture:** The backend keeps one overview payload (`GET /maintenance/hours`) and grows it with trust, events, service threshold and due machines; one calibration helper is shared by the Hours save route and the Status tab's set-hours; the hourly sweep gains a once-a-day due check that files an inbox notification. The frontend keeps `HoursTab` as the single data owner, adds pure helpers in `hoursSeries.ts` for every number the page prints, and adds focused components (`FleetStrip`, `ReadingTimeline`, `ReadingPass`, `MachinePanel`, `TrustMark`, `Sparkline`) around the existing chart, rail and forms.

**Tech Stack:** FastAPI + SQLAlchemy async (SQLite/PostgreSQL), pytest (xdist); React 19 + TanStack Query + recharts + Tailwind 4, Vitest + Testing Library + msw, i18next (15 locales).

**Spec:** `docs/superpowers/specs/2026-11-01-hours-tab-tools-design.md`

## Global Constraints

- Run every command from the repo root with `./venv/bin/python3`; frontend commands from `frontend/`.
- New columns go through `run_migrations()` in `backend/app/core/database.py` with `_safe_execute` and `_table_has_column`; DDL must be valid on SQLite and PostgreSQL (`REAL`/`DOUBLE PRECISION` differences: use `REAL` for floats, `TIMESTAMP` for datetimes, `DATE` for dates, both dialects accept them). New tables come from `create_all`: register the model in `backend/app/models/__init__.py`, the import block inside `init_db()` in `database.py`, and the `test_engine` fixture import block in `backend/tests/conftest.py`.
- No new `Permission`. Reads use `Permission.MAINTENANCE_VIEW`, writes `MAINTENANCE_UPDATE`, deletes `MAINTENANCE_DELETE`, via `RequirePermissionIfAuthEnabled`.
- Every new i18n key is added to all 15 locale files under `maintenance.hours.*` (or `inbox.kind.*`) with a real translation; `cd frontend && npm run check:i18n` must stay green after each frontend task. Grep the namespace before adding a key.
- Dates are ISO `YYYY-MM-DD` strings handled as UTC day numbers (`dayNumber` in `hoursSeries.ts`); `today` always comes from the overview payload, never from `new Date()`.
- Numbers printed in the UI: `Math.round(n).toLocaleString(i18n.language)` followed by ` h`; percentages as whole numbers.
- Tolerances (spec): wrong-number `max(24, 0.2 × Δc)` hours; drift `max(24, 0.02 × manual value)` hours; stale pace when the last series point is older than 90 days; slowing when the newest period pace < 0.5 × previous; stopped when the newest period ≥ 30 days and pace < 1 h/month; reminder default 90 days, allowed 7–365.
- Vitest: run one file at a time from `frontend/` (`npx vitest run <file>`); backend: `./venv/bin/python3 -m pytest <file> -v`.
- Commit after each task; never push.

## Review Focus

1. A pass or form value typed with a comma or thin space ("1 234,5") must parse as 1234.5 and go through the check like any other number (Task 7 test `checkReading accepts locale-formatted input via parseHoursInput`).
2. A printer added after the last manual reading date, or a machine with no manual reading at all, has no reference: `checkReading` must return `ok` with `reason: 'noReference'`, never a question built on NaN (Task 7).
3. The Status tab's set-hours on a printer that has no `hour_machines` row yet must create the row before calibrating, not crash (Task 2 test `calibrate_from_status_creates_machine_row`).
4. The reading pass opened before midnight and saved after it must send the server's current `today`, not the one captured when it opened; the save goes through a refetch first (Task 13 test `pass saves with the refetched today`).
5. The reminder must not fire when there are no live machines, and must not fire twice within one interval even across restarts (Task 6 tests `no_live_machines_no_notification`, `reminder_once_per_interval_persists_in_settings`).

---

### Task 1: Schema — new columns, `hour_events` table, backfills

**Files:**
- Modify: `backend/app/models/maintenance.py` (HourMachine, HourReading, new HourEvent)
- Modify: `backend/app/models/__init__.py`, `backend/app/core/database.py` (`init_db()` import block + `run_migrations()`), `backend/tests/conftest.py` (test_engine import block)
- Test: `backend/tests/unit/test_hour_events_schema.py` (create), `backend/tests/unit/test_printer_hours_migrations.py` (create)

**Interfaces:**
- Produces: `HourMachine.calibrated_at: datetime | None`, `HourMachine.last_drift_hours: float | None`, `HourMachine.purchase_price: float | None`, `HourMachine.purchase_date: date | None`; `HourReading.raw_hours: float | None`; `HourEvent(id, machine_id FK hour_machines ON DELETE CASCADE index, event_date: date, kind: str(20), label: str(200), source_id: int | None, created_at)`; constants `EVENT_KINDS = ("note", "maintenance", "added", "retired", "calibrated")` in `backend/app/services/printer_hours.py`.

- [ ] **Step 1: Write the failing schema test**

```python
# backend/tests/unit/test_hour_events_schema.py
async def test_hour_event_round_trip_and_cascade(db_session):
    m = HourMachine(name="X1C04", model="X1C")
    db_session.add(m); await db_session.flush()
    db_session.add(HourEvent(machine_id=m.id, event_date=date(2026, 4, 25), kind="note", label="hotend changed"))
    await db_session.commit()
    assert (await db_session.execute(select(HourEvent))).scalar_one().label == "hotend changed"
    await db_session.execute(delete(HourMachine).where(HourMachine.id == m.id)); await db_session.commit()
    # SQLite does not enforce FKs here: the service deletes explicitly (Task 5); assert the table exists and the column set
    cols = {c.name for c in HourEvent.__table__.columns}
    assert cols == {"id", "machine_id", "event_date", "kind", "label", "source_id", "created_at"}

def test_hour_machine_and_reading_new_columns():
    assert {"calibrated_at", "last_drift_hours", "purchase_price", "purchase_date"} <= {c.name for c in HourMachine.__table__.columns}
    assert "raw_hours" in {c.name for c in HourReading.__table__.columns}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_hour_events_schema.py -v`
Expected: FAIL with `ImportError: cannot import name 'HourEvent'`

- [ ] **Step 3: Add the columns and the model; register `HourEvent` in the three import lists**

`HourEvent.__tablename__ = "hour_events"`, `Index("ix_hour_events_machine", "machine_id")`. Follow the `HourReading` docstring style (no ORM relationship, explicit deletes).

- [ ] **Step 4: Write the failing migration test**

Follow `backend/tests/unit/test_printer_maintenance_unique_migration.py`'s pattern (build an old-shape SQLite DB, run `run_migrations`, assert columns). Test names: `test_migration_adds_hour_columns`, `test_migration_backfills_calibrated_at_from_offset` (machine with a manual reading on 2026-04-25 and printer offset 120 → `calibrated_at` date 2026-04-25; offset but no manual reading → `calibrated_at` today; offset 0 → null; `last_drift_hours` null in all cases), `test_migration_is_idempotent` (run twice).

- [ ] **Step 5: Run it to verify it fails**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_printer_hours_migrations.py -v`
Expected: FAIL (columns missing after migration)

- [ ] **Step 6: Add the migration block in `run_migrations()`**

Four `ALTER TABLE hour_machines ADD COLUMN` statements (`calibrated_at TIMESTAMP`, `last_drift_hours REAL`, `purchase_price REAL`, `purchase_date DATE`) and `ALTER TABLE hour_readings ADD COLUMN raw_hours REAL`, each guarded by `_table_has_column`; then the `calibrated_at` backfill as a DML `UPDATE … WHERE calibrated_at IS NULL` inside `conn.begin_nested()`, using a correlated subquery for the newest manual `reading_date` and `CURRENT_DATE`/`date('now')` per dialect (`_is_postgres(conn)` already exists at `database.py:1033`). The `added` events backfill is done by the service on first overview (Task 3), not here.

- [ ] **Step 7: Run both test files and the PostgreSQL upgrade check**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_hour_events_schema.py backend/tests/unit/test_printer_hours_migrations.py -v` → PASS.
Run: `./venv/bin/python3 scripts/check_postgres_upgrade.py` if Docker is available (see memory `postgres-upgrade-check`); otherwise note it in the commit body.

- [ ] **Step 8: Commit**

```bash
git add backend/app/models backend/app/core/database.py backend/tests/conftest.py backend/tests/unit/test_hour_events_schema.py backend/tests/unit/test_printer_hours_migrations.py
git commit -m "hours: calibration, purchase and raw-counter columns, hour_events table"
```

---

### Task 2: Calibration helper shared by the Hours save route and the Status set-hours

**Files:**
- Modify: `backend/app/services/printer_hours.py`, `backend/app/api/routes/printer_hours.py:81-135`, `backend/app/api/routes/maintenance.py:786-815`
- Test: `backend/tests/unit/test_printer_hours_service.py`, `backend/tests/integration/test_printer_hours_api.py`

**Interfaces:**
- Produces: `async def calibrate_machine(db, machine: HourMachine, printer: Printer, total_hours: float, today: date) -> float` — returns the counter's actual value after recalibration; sets `printer.print_hours_offset` (via `recalibrate_printer`), `machine.calibrated_at = utcnow`, `machine.last_drift_hours = (counter before − total_hours)` or `None` when `machine.calibrated_at` was null before, upserts today's auto row with `hours=actual, raw_hours=runtime_seconds/3600`, adds `HourEvent(kind="calibrated", label=f"{total_hours:g} h", event_date=today)`. Does not commit.
- Produces: `async def machine_for_printer(db, printer_id: int) -> HourMachine` (runs `ensure_hour_machines` then returns the linked row).
- Changes: `upsert_reading(db, machine_id, reading_date, source, hours, raw_hours: float | None = None)`; `snapshot_today` passes `raw_hours=runtime/3600`.

- [ ] **Step 1: Write the failing service tests**

```python
async def test_calibrate_first_time_stores_no_drift(db_session, printer_factory): ...  # calibrated_at set, last_drift_hours None, auto row hours==total, raw_hours==runtime/3600, one "calibrated" event
async def test_calibrate_again_stores_drift(db_session, printer_factory): ...        # counter reads 3865 before, typed 3803 → last_drift_hours == 62.0
async def test_snapshot_writes_raw_hours(db_session, printer_factory): ...
async def test_calibrate_from_status_creates_machine_row(db_session, printer_factory): ...  # machine_for_printer on a printer without a row
```

- [ ] **Step 2: Run to verify they fail**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_printer_hours_service.py -v -k "calibrate or raw_hours"` → FAIL (`calibrate_machine` not defined)

- [ ] **Step 3: Implement `calibrate_machine`, `machine_for_printer`, extend `upsert_reading` and `snapshot_today`**

- [ ] **Step 4: Route the two callers through it**

In `save_readings`, replace the `recalibrate_printer` + manual auto upsert block with `calibrate_machine(...)`. In `set_printer_hours`, after loading the printer: `machine = await machine_for_printer(db, printer_id)`, `actual = await calibrate_machine(db, machine, printer, total_hours, date.today())`, keep the response shape (`runtime_hours` from `printer.runtime_seconds / 3600`).

- [ ] **Step 5: Write the failing API test**

In `test_printer_hours_api.py`: `test_status_set_hours_calibrates_machine` — PATCH `/api/v1/maintenance/printers/{id}/hours?total_hours=3803` then GET `/api/v1/maintenance/hours` shows that machine's `calibrated_at` not null (field arrives in Task 4; until then assert through `db_session`).

- [ ] **Step 6: Run both files**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_printer_hours_service.py backend/tests/integration/test_printer_hours_api.py -v` → PASS

- [ ] **Step 7: Commit**

```bash
git commit -am "hours: one calibration helper for the save route and the Status set-hours"
```

---

### Task 3: Trust state, events mirroring, added/retired events, next service threshold

**Files:**
- Modify: `backend/app/services/printer_hours.py`
- Test: `backend/tests/unit/test_printer_hours_service.py`

**Interfaces:**
- Produces: `def trust_state(machine: HourMachine, last_manual_hours: float | None) -> tuple[str | None, float | None]` → `("calibrated"|"drifting"|"uncalibrated"|None, last_drift_hours)`; `None` state for retired machines. Drifting when `abs(last_drift_hours) > max(24.0, 0.02 * last_manual_hours)`.
- Produces: `async def sync_events(db, machines: list[HourMachine]) -> None` — for each linked machine, inserts missing `maintenance` events from `maintenance_history` joined through `printer_maintenance.printer_id` (`source_id = history.id`, `label = maintenance_type.name`, `event_date = performed_at.date()`); inserts one `added` event per machine lacking one with `event_date = min(first manual reading date, printer.created_at.date())` (retired machines without a printer: first manual reading date); never deletes. Commits.
- Produces: `ensure_hour_machines` adds a `retired` event (label = printer name, event_date = today) when it retires a row, and clears `calibrated_at`/`last_drift_hours` on that row.
- Produces: `async def next_service_hours(db, printer_id: int) -> float | None` — min over enabled `PrinterMaintenance` items with `interval_type == "hours"` of `current_hours + hours_until_due`, read via `_get_printer_maintenance_internal(printer_id, db, commit=False)`; `None` when no such item.
- Produces: `def added_on(machine, first_manual: date | None, printer_created: date | None) -> date | None`.

- [ ] **Step 1: Write the failing tests**

```python
def test_trust_state_rules(): ...  # retired→(None,None); calibrated_at None→"uncalibrated"; drift 10 on 3803→"calibrated"; drift 100 on 3803→"drifting"; drift 30 on 500→"drifting" (24 h floor)
async def test_sync_events_mirrors_maintenance_history_once(db_session, printer_factory): ...  # two runs, one row per history id
async def test_sync_events_added_uses_first_reading_when_older_than_printer(db_session, printer_factory): ...  # reading 2024-07-19, printer created 2026-03-09 → added 2024-07-19
async def test_retiring_a_machine_writes_event_and_clears_calibration(db_session, printer_factory): ...
async def test_next_service_hours_takes_earliest_enabled_hours_item(db_session, printer_factory): ...  # items at 300 h and 1000 h intervals, hours_since 250 → current+50
```

- [ ] **Step 2: Run to verify they fail** → `./venv/bin/python3 -m pytest backend/tests/unit/test_printer_hours_service.py -v -k "trust or events or retiring or next_service"` FAIL

- [ ] **Step 3: Implement the four functions and the `ensure_hour_machines` change**

- [ ] **Step 4: Run the file** → PASS

- [ ] **Step 5: Commit** — `git commit -am "hours: trust state, event mirroring, next service threshold"`

---

### Task 4: Overview payload — schemas and `_overview`

**Files:**
- Modify: `backend/app/schemas/maintenance.py:142-165`, `backend/app/api/routes/printer_hours.py:40-80`
- Test: `backend/tests/integration/test_printer_hours_api.py`

**Interfaces:**
- Produces (Pydantic): `HourMachineOut` + `trust: Literal["calibrated","drifting","uncalibrated"] | None`, `last_drift_hours: float | None`, `calibrated_at: datetime | None`, `counter_raw_hours: float | None`, `next_service_hours: float | None`, `purchase_price: float | None`, `purchase_date: date | None`, `added_on: date | None`; `HourReadingOut` + `raw_hours: float | None`; `HourEventOut(id, machine_id, event_date, kind, label, source_id)`; `HoursOverview` + `events: list[HourEventOut]`, `reading_interval_days: int`, `due_machine_ids: list[int]`.
- Produces: `def due_machine_ids(machines, readings, interval_days: int, today: date) -> list[int]` in the service — live machines whose newest manual reading is older than `interval_days` or missing.
- Produces: `async def reading_interval_days(db) -> int` (setting `hours_reading_interval_days`, default 90) in the service.
- `_overview` calls `ensure_hour_machines`, `sync_events`, builds trust per machine from the newest manual reading, `next_service_hours` only when `trust == "calibrated"` or `"drifting"` (spec: null when uncalibrated), `counter_raw_hours = runtime/3600` for linked machines.

- [ ] **Step 1: Write the failing API tests**

```python
async def test_overview_carries_trust_events_and_due(async_client, db_session, printer_factory): ...
# uncalibrated printer with a 2026-04-25 reading, today far later → trust "uncalibrated", next_service_hours None, machine id in due_machine_ids, reading_interval_days == 90, an "added" event present
async def test_overview_next_service_only_when_calibrated(async_client, db_session, printer_factory): ...
```

- [ ] **Step 2: Run to verify they fail** → FAIL (fields missing)

- [ ] **Step 3: Implement schemas, `due_machine_ids`, `reading_interval_days`, `_overview`**

- [ ] **Step 4: Run the integration file and the service file** → PASS

- [ ] **Step 5: Commit** — `git commit -am "hours: overview carries trust, events, service threshold and due machines"`

---

### Task 5: Routes — events, interval setting, machine purchase fields

**Files:**
- Modify: `backend/app/api/routes/printer_hours.py` (after line 197), `backend/app/schemas/maintenance.py`
- Test: `backend/tests/integration/test_printer_hours_api.py`

**Interfaces:**
- `POST /maintenance/hours/machines/{machine_id}/events` body `HourEventCreate(event_date: date, label: str = Field(min_length=1, max_length=200))` → `HourEventOut`, kind forced to `note`, future dates rejected with `_reject_future`, `MAINTENANCE_UPDATE`.
- `DELETE /maintenance/hours/events/{event_id}` → 204; 409 when `kind != "note"`; `MAINTENANCE_UPDATE`.
- `PATCH /maintenance/hours/settings` body `HourSettingsUpdate(reading_interval_days: int = Field(ge=7, le=365))` → `HoursOverview`; `MAINTENANCE_UPDATE`; writes the setting with `set_setting` from `routes/settings.py`.
- `PATCH /maintenance/hours/machines/{machine_id}`: `HourMachineUpdate` + `purchase_price: float | None = Field(default=None, ge=0)`, `purchase_date: date | None`; name/model still only for retired machines (keep the 409 for those fields), purchase fields allowed on any machine.
- Machine delete (`DELETE /machines/{id}`) also deletes that machine's `hour_events` explicitly (SQLite FK).
- Register literal routes before parameterised ones.

- [ ] **Step 1: Write the failing tests** — `test_note_event_create_and_delete`, `test_mirrored_event_cannot_be_deleted` (409), `test_interval_setting_bounds` (6 → 422, 7 and 365 → 200, overview echoes it), `test_purchase_fields_on_live_machine`, `test_delete_machine_removes_its_events`; extend `test_hours_write_routes_enforce_update_and_delete_permissions` with the three new write routes.

- [ ] **Step 2: Run to verify they fail** → 404/405

- [ ] **Step 3: Implement the routes**

- [ ] **Step 4: Run the file** → PASS

- [ ] **Step 5: Commit** — `git commit -am "hours: note events, reading interval setting, purchase fields"`

---

### Task 6: Readings-due reminder in the sweep and the inbox kind

**Files:**
- Modify: `backend/app/services/printer_hours.py` (`PrinterHoursService`), `backend/app/services/inbox.py:55-76`, `backend/app/api/routes/inbox.py:31-36`
- Test: `backend/tests/unit/test_printer_hours_service.py`, `backend/tests/unit/test_inbox_kinds.py` (create if no inbox unit file covers `KINDS`)

**Interfaces:**
- `InboxKind` gains `available: bool = True`; `_available()` in `routes/inbox.py` uses `spec.available` (keep `available=bool(spec.events)` for Aito kinds by passing it explicitly in `KINDS`).
- `KINDS["hours.readings_due"] = InboxKind("printer", True, (), available=True)`; it lands in `DEFAULT_KINDS` (sound stays out: `sound_kinds_json` default is built from `DEFAULT_KINDS` today — exclude this kind there by filtering on a new `InboxKind.sound_default: bool = True`, set False for this kind).
- `async def remind_if_due(db, today: date) -> int` — returns recipients count; reads `reading_interval_days`, `due_machine_ids`; returns 0 when no live machine is due; reads setting `hours_reading_last_reminder` (ISO date) and returns 0 when it is within `interval_days` of today; otherwise creates `Notification(kind="hours.readings_due", family="printer", title="hours.readings_due", body=f"{n} machines · {last_date.isoformat()}", target_type="hours", target_id=None)` for each active user with `has_permission("maintenance:update")` whose `preferences_for(db, user.id).kinds_json` contains the kind; sets the setting to today; commits; calls `broadcast_pending(db)` after collecting recipients in `db.info[_PENDING_KEY]` the way `fan_out` does.
- The sweep loop calls `remind_if_due` after `snapshot_today`, at most once per calendar day (instance attribute `_last_reminder_check: date | None`).

- [ ] **Step 1: Write the failing tests** — `test_remind_if_due_notifies_opted_in_update_users`, `test_no_live_machines_no_notification`, `test_reminder_once_per_interval_persists_in_settings` (second call same day → 0; new service instance → still 0), `test_hours_kind_is_available_and_default_on_without_sound`.

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the two files plus `backend/tests/unit/test_inbox*.py` and `backend/tests/integration/test_inbox*.py`** → PASS

- [ ] **Step 5: Commit** — `git commit -am "hours: readings-due reminder through the inbox"`

---

### Task 7: Frontend types, fixtures and the pure helpers

**Files:**
- Modify: `frontend/src/api/client.ts` (HourMachine, HourReading, HoursOverview, new HourEvent + api methods), `frontend/src/utils/hoursSeries.ts`, `frontend/src/__tests__/components/HoursTab.test.tsx:21-41` (fixture gains the new fields), `frontend/src/__tests__/mocks/handlers.ts` if it serves `/maintenance/hours`
- Test: `frontend/src/__tests__/utils/hoursSeries.test.ts`

**Interfaces:**
- Types: `HourMachine` + `trust: 'calibrated' | 'drifting' | 'uncalibrated' | null; last_drift_hours: number | null; calibrated_at: string | null; counter_raw_hours: number | null; next_service_hours: number | null; purchase_price: number | null; purchase_date: string | null; added_on: string | null`; `HourReading` + `raw_hours: number | null`; `HourEvent { id; machine_id; event_date; kind: 'note'|'maintenance'|'added'|'retired'|'calibrated'; label; source_id: number | null }`; `HoursOverview` + `events: HourEvent[]; reading_interval_days: number; due_machine_ids: number[]`.
- API: `api.createHourEvent(machineId, { event_date, label })`, `api.deleteHourEvent(id)`, `api.updateHourSettings({ reading_interval_days })`, `api.updateHourMachine(id, { name?, model?, purchase_price?, purchase_date? })` (extend the existing method if present).
- Helpers (all exported from `hoursSeries.ts`):
  - `checkReading(machineId: number, typed: number, readings: HourReading[], counterRawNow: number | null): ReadingCheck` where `ReadingCheck = { level: 'ok' | 'question'; reason: 'ok' | 'noReference' | 'backwards' | 'farFromCounter'; last: HourPoint | null; counterDelta: number | null; expected: number | null }`. Reference raw at D: the auto reading with `raw_hours != null` on D or the first within 7 days after D.
  - `periodPaces(manual: HourPoint[]): { from: string; to: string; days: number; pace: number }[]` (consecutive manual pairs, pace in h/month using 30.44).
  - `behaviourFlag(periods): 'slowing' | 'stopped' | null`.
  - `loadShare(pace: number | null): number | null` = `pace / (24 × 30.44)`.
  - `ratePerMonth(points, today, windowDays = 90)` → returns `null` when `dayNumber(today) − dayNumber(last.date) > 90` (new rule; update the existing test's expectations).
  - `forecastDate(last: HourPoint, pace: number | null, target: number): string | null` (ISO date when pace > 0 and target > last.hours).
  - `sameAgePoints(points: HourPoint[]): { day: number; hours: number }[]` (day 0 = first point, hours relative).
  - `fleetFacts(machines, series, readings, today, dueIds): { lifetime: number; thisMonth: number; due: number; busiest: { id: number; pace: number } | null }`.
  - `gapInfo(machines, series, today): { lastDate: string | null; days: number }`.

- [ ] **Step 1: Write the failing tests** (one `it` per rule, exact values):

```ts
describe('checkReading', () => {
  it('questions a value below the last manual reading', ...)            // last 1743 → typed 1700 → reason 'backwards'
  it('questions a jump far from the counter delta', ...)                 // last 1743 at D, raw D=500, raw now=1112 (Δc 612), typed 2743 → 'farFromCounter', expected 2355
  it('accepts within max(24h, 20%)', ...)                                // typed 2300 with Δc 612 → ok (diff 55 < 122.4)
  it('uses the 24 h floor on a small delta', ...)                        // Δc 40 → tolerance 24: typed last+70 (diff 30) → question; typed last+60 (diff 20) → ok
  it('returns noReference without raw readings or without a manual', ...)
  it('accepts locale-formatted input via parseHoursInput', ...)          // parseHoursInput('1 234,5') === 1234.5 then ok
});
describe('pace and flags', () => { /* periodPaces on the sheet's H2S04 → [136.?, 228.?]; slowing when 290→169? no (0.58) → null; 290→120 → 'slowing'; 35 days at 0.5 h/mo → 'stopped'; retired handled by caller */ });
describe('stale rate', () => { it('is null when the last point is older than 90 days', ...) });
describe('forecast and same age', () => { it('forecastDate from 1743 at 228 h/mo to 2500 lands ~ +100 days', ...); it('sameAgePoints starts at day 0 hours 0', ...) });
describe('fleet facts', () => { it('lifetime sums sold machines, due counts ids, busiest picks highest pace', ...) });
```

- [ ] **Step 2: Run to verify they fail** → `cd frontend && npx vitest run src/__tests__/utils/hoursSeries.test.ts`

- [ ] **Step 3: Implement types, api methods, helpers; update the HoursTab fixture and any msw handler with the new fields (`events: []`, `reading_interval_days: 90`, `due_machine_ids: []`, `trust: 'uncalibrated'` etc.)**

- [ ] **Step 4: Run `hoursSeries.test.ts` and `HoursTab.test.tsx`, then `npm run typecheck`** → PASS

- [ ] **Step 5: Commit** — `git commit -am "hours: client types and pure helpers for checks, pace, forecast, fleet facts"`

---

### Task 8: Rail — sparklines, trust marks, no rate line

**Files:**
- Create: `frontend/src/components/maintenance/hours/Sparkline.tsx`, `frontend/src/components/maintenance/hours/TrustMark.tsx`
- Modify: `frontend/src/components/maintenance/hours/MachineList.tsx`, `HoursTab.tsx` (stats → pass `series`, `onOpen`, `onHover`), 15 locale files
- Test: `frontend/src/__tests__/components/HoursTab.test.tsx`, `frontend/src/__tests__/components/TrustMark.test.tsx` (create)

**Interfaces:**
- `Sparkline({ points: HourPoint[]; color: string; width?: number (70); height?: number (20) })` inline SVG, own scale, dot on the last point.
- `TrustMark({ machine: HourMachine; size?: 'sm' | 'md' })` renders nothing for `calibrated` or `null`; `drifting` → `AlertTriangle` amber with `title`/`aria-label` `t('maintenance.hours.trust.drifting', { hours })`; `uncalibrated` → `Circle` (hollow) grey with `t('maintenance.hours.trust.uncalibrated')`.
- `MachineList` props: remove `stats`, add `series: Map<number, MachineSeries>`, `values: Map<number, number | null>` (the machine's displayed hours, from HoursTab's existing `counterOk` rule), `onOpen(machine)`, `onHover(id | null)`; the name is a `<button>` with `aria-label={t('maintenance.hours.openMachine', { name })}` that calls `onOpen`; the row still toggles visibility.
- Locale keys: `maintenance.hours.trust.{calibrated,drifting,uncalibrated,notCalibratedHelp,driftHelp}`, `maintenance.hours.openMachine`.

- [ ] **Step 1: Write the failing tests** — in `HoursTab.test.tsx`: `rail rows show a sparkline and no per-month rate` (query `svg[data-testid=sparkline]` inside each row; `queryByText(/h\/month/)` null in the rail); `TrustMark.test.tsx`: three states.

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement components, wire in `HoursTab`, add the keys to all 15 locales**

- [ ] **Step 4: Run both test files, `npm run check:i18n`, `npm run typecheck`** → PASS

- [ ] **Step 5: Commit** — `git commit -am "hours: rail sparklines and trust marks"`

---

### Task 9: Chart — range picker, gap marker, auto-tail rule, focus

**Files:**
- Modify: `frontend/src/components/maintenance/hours/HoursChart.tsx`, `HoursTab.tsx`, locales
- Create: `frontend/src/components/maintenance/hours/FocusHeader.tsx`
- Test: `frontend/src/__tests__/components/HoursChart.test.tsx` (create), `HoursTab.test.tsx`

**Interfaces:**
- `HoursChartProps` + `range: '3m' | '12m' | 'all'`, `focusId: number | null`, `onFocus(id: number | null)`, `events: HourEvent[]` (used in Task 10), `gap: { lastDate: string | null; days: number }`.
- Range: x domain `[dayNumber(today) − 91 | 365 | dataMin, dayNumber(today)] × DAY_MS`; points outside are still passed (recharts clips).
- Gap marker: `ReferenceLine x={lastDate}` dashed amber with label `t('maintenance.hours.chart.lastReading', { date })`; when `gap.days > 30`, `ReferenceArea x1={lastDate} x2={today}` with `fill="url(#hours-gap-hatch)"` (pattern defined in a `<defs>` inside the chart) and a second label `t('maintenance.hours.chart.noReadingsFor', { months })`.
- Auto tail: the dashed `Line` is rendered only when `machine.trust === 'calibrated' || machine.trust === 'drifting'`.
- Focus: non-focused lines `strokeOpacity={0.2}`, focused `strokeWidth={3}`; `onMouseEnter`/`onMouseLeave` on each `Line` call `onFocus`; `Escape` keydown on the chart card clears a click focus (HoursTab owns `focusId` and `focusPinned`).
- `FocusHeader({ machine: HourMachine | null; series; today; fleetLine: string })` prints chip, name, family, last date, value, delta since the previous manual reading, pace or `t('maintenance.hours.lastReadingOn', { date })` when pace is null; behaviour flag badge (`maintenance.hours.flag.slowing|stopped`); when `machine` is null prints `fleetLine` (`t('maintenance.hours.fleetLine', { machines, date })`).
- Locale keys: `maintenance.hours.range.{3m,12m,all}`, `maintenance.hours.chart.{lastReading,noReadingsFor}`, `maintenance.hours.lastReadingOn`, `maintenance.hours.fleetLine`, `maintenance.hours.flag.{slowing,stopped}`, `maintenance.hours.delta` (`'+{{hours}} h since {{date}}'`).

- [ ] **Step 1: Write the failing tests** — `HoursChart.test.tsx`: `hides the auto tail for an uncalibrated machine` (count `path.recharts-line-curve[stroke-dasharray]` is 0 vs 1 when `trust: 'calibrated'`), `draws the gap band when the last reading is older than 30 days` (`ReferenceArea` → `.recharts-reference-area` present), `fades non-focused lines` (opacity attr). `HoursTab.test.tsx`: `range segment switches and focus header shows the hovered machine`.

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement; HoursTab holds `range`, `focusId`, `focusPinned`, passes `onHover` from the rail into `onFocus`**

- [ ] **Step 4: Run the tests, `check:i18n`, `typecheck`** → PASS

- [ ] **Step 5: Commit** — `git commit -am "hours: chart ranges, gap marker, calibrated-only auto tail, focus"`

---

### Task 10: Chart — forecast, service line, event ticks, Same age mode

**Files:**
- Modify: `HoursChart.tsx`, `HoursTab.tsx` (`MODES` gains `'sameAge'`), locales
- Create: `frontend/src/components/maintenance/hours/EventTicks.tsx` (recharts `Customized` child)
- Test: `HoursChart.test.tsx`

**Interfaces:**
- Forecast (Lifetime mode only): per visible machine with `ratePerMonth != null`, a dotted `Line` (`strokeDasharray="2 4"`, `dot={false}`, `legendType="none"`) from the last point to `today + 365 d` (or the range end) at that pace. For the focused machine with `next_service_hours != null`: `ReferenceLine y={next_service_hours}` amber dashed with label `t('maintenance.hours.chart.nextService', { hours, date: forecastDate(...) ?? '—' })`.
- `EventTicks({ events, machines, visibleIds, series, colors })` draws, via `Customized`, a 1×10 px tick at `(x(event_date), y(valueAt(series, event_date)))` per event of a visible machine, `title` = label; kinds map to glyphs: `note` → tick + small dot, `maintenance` → wrench glyph (`lucide` `Wrench` path or a plain `M` tick), `calibrated` → hollow circle, `added`/`retired` → omitted when they coincide with the first/last point.
- Same age mode: `LineChart` with `x = day` (numeric, tick formatter `Math.round(day / 30.44)` + `t('maintenance.hours.chart.months')`), `y = hours`, one `Line` per visible machine from `sameAgePoints(seriesPoints(series))`; when more than 4 machines are visible, render the hint `t('maintenance.hours.chart.sameAgeHint')` above the chart (chart still drawn).
- Locale keys: `maintenance.hours.modeSameAge`, `maintenance.hours.chart.{nextService,months,sameAgeHint,forecast}`.

- [ ] **Step 1: Write the failing tests** — `draws a forecast line for a machine with a current pace`, `draws the next service reference for the focused calibrated machine`, `same age mode starts every machine at day 0`, `renders one tick per visible event`.

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests, `check:i18n`, `typecheck`** → PASS

- [ ] **Step 5: Commit** — `git commit -am "hours: forecast, service line, event ticks, same-age mode"`

---

### Task 11: Fleet strip with expandable load table

**Files:**
- Create: `frontend/src/components/maintenance/hours/FleetStrip.tsx`
- Modify: `HoursTab.tsx`, locales
- Test: `frontend/src/__tests__/components/FleetStrip.test.tsx` (create)

**Interfaces:**
- `FleetStrip({ facts: ReturnType<typeof fleetFacts>; machines; paces: Map<number, number | null>; onTakeReadings(): void })`. Four tiles; the "Readings due" tile is a `<button>` (`aria-label` `t('maintenance.hours.strip.takeReadings')`) in amber when `facts.due > 0`, grey "0" otherwise; a chevron toggles the load table: one row per live machine sorted by `loadShare` desc with a bar (`width: {pct}%`) and `{pct} %`, grouped under family headers; machines with null pace at the bottom with `t('maintenance.hours.noRecentReading')`.
- Locale keys: `maintenance.hours.strip.{lifetime,thisMonth,readingsDue,busiest,takeReadings,load,machinesCount,soldCount}`, `maintenance.hours.noRecentReading`, `maintenance.hours.perMonth` (exists).

- [ ] **Step 1: Write the failing tests** — `shows the four facts from the helper`, `readings due tile opens the pass callback`, `expanding lists load bars sorted by share with stale machines last`.

- [ ] **Step 2–5:** fail → implement → `FleetStrip.test.tsx` + `HoursTab.test.tsx` + `check:i18n` + `typecheck` PASS → `git commit -am "hours: fleet strip with load table"`

---

### Task 12: Readings card — timeline, collapsed log, interval control

**Files:**
- Create: `frontend/src/components/maintenance/hours/ReadingTimeline.tsx`
- Modify: `ReadingLog.tsx` (accepts `limit?: number` and an "older" toggle), `HoursTab.tsx`, locales
- Test: `frontend/src/__tests__/components/ReadingTimeline.test.tsx` (create), `HoursTab.test.tsx`

**Interfaces:**
- `ReadingTimeline({ readings; today; due: boolean; onPick(date: string): void })`: a relative-positioned strip; one `<button>` per manual date at `left: {pct}%` (pct from the first manual date to today), size class by machine count (`< 5`, `< 12`, else), `title` = `date · n machines · Σ h`, click → `onPick(date)`; a warning dot at 100 % with `t('maintenance.hours.timeline.today')` when `due`.
- `ReadingLog` with `limit={2}` renders the two newest rows and a button `t('maintenance.hours.olderDates', { n })` that expands to all; `limit` undefined keeps today's full list.
- Interval control in the card header: `t('maintenance.hours.readingsEvery')` + `<input type="number" min=7 max=365>` bound to `overview.reading_interval_days`, saved on blur/Enter through `api.updateHourSettings`; mutation `onSuccess` sets the query data to the returned overview.
- Locale keys: `maintenance.hours.timeline.{today,dot}`, `maintenance.hours.olderDates`, `maintenance.hours.readingsEvery`, `maintenance.hours.days`.

- [ ] **Step 1: Write the failing tests** — timeline: `one dot per manual date, click picks the date`, `due shows the today marker`; HoursTab: `log shows two rows then expands`, `changing the interval calls the settings endpoint` (msw `http.patch('/api/v1/maintenance/hours/settings')`).

- [ ] **Step 2–5:** fail → implement → tests + `check:i18n` + `typecheck` PASS → `git commit -am "hours: readings timeline, collapsed log, reminder interval"`

---

### Task 13: Reading pass

**Files:**
- Create: `frontend/src/components/maintenance/hours/ReadingPass.tsx`
- Modify: `HoursTab.tsx` (`passOpen` state, `?pass=1` on mount, split button beside New reading), locales
- Test: `frontend/src/__tests__/components/ReadingPass.test.tsx` (create)

**Interfaces:**
- `ReadingPass({ machines: HourMachine[] (live, rail order); readings; today; colors; isSaving; onSave(entries: { machine_id: number; hours: number }[]): void; onClose(): void })`. Full-screen `fixed inset-0 z-50` panel, `role="dialog"`, focus trapped on the input; steps `index 0..n-1` then a summary step.
- Per step: header `t('maintenance.hours.pass.progress', { i, n })`, machine name + family, `t('maintenance.hours.pass.last', { hours, date })`, counter line from `checkReading(...).counterDelta` (`t('maintenance.hours.pass.counted', { hours, date })` or `t('maintenance.hours.pass.noReference')`), one `<input inputmode="decimal" aria-label={machine.name}>`, buttons Back / Skip / Next (Enter = Next). Next runs `checkReading`; a `question` result shows the reason text and changes Next into `t('maintenance.hours.pass.keepAnyway')`; a second Enter keeps the value and advances. Blank = skip.
- Summary step: table rows (machine, old, new, delta, flag text) and `t('maintenance.hours.pass.save', { n })`; `onSave` receives only filled values.
- HoursTab: `onSave` first `await queryClient.fetchQuery({ queryKey: ['maintenanceHours'], queryFn: api.getPrinterHours })` to refresh `today`, then calls `saveReadings.mutate({ date: fresh.today, entries })`; on success closes the pass and removes `pass` from the URL. `?pass=1` on mount opens the pass (after data loads). The New reading button becomes a split: main → form, menu item `t('maintenance.hours.pass.title')` → pass.
- Locale keys under `maintenance.hours.pass.*`: `title, progress, last, counted, noReference, keepAnyway, skip, back, next, summary, save, backwards, farFromCounter, okDelta, nothingToSave`.

- [ ] **Step 1: Write the failing tests**

```ts
it('walks machines in order, Enter advances, blank skips')
it('questions a backwards value and keeps it on a second Enter')
it('summary lists only filled machines and saves them')
it('pass saves with the refetched today')      // msw returns today '2031-02-15' on the refetch; the POST body has reading_date '2031-02-15'
it('?pass=1 opens the pass on load')            // HoursTab.test.tsx, render at '/maintenance?tab=hours&pass=1'
```

- [ ] **Step 2–5:** fail → implement → `ReadingPass.test.tsx` + `HoursTab.test.tsx` + `check:i18n` + `typecheck` PASS → `git commit -am "hours: one-machine-at-a-time reading pass"`

---

### Task 14: Wrong-number check inside the New reading / Edit form

**Files:**
- Modify: `frontend/src/components/maintenance/hours/ReadingFormModal.tsx`, locales
- Test: `HoursTab.test.tsx` (the existing `flags a value lower than the previous reading…` test grows)

**Interfaces:**
- Replace the form's own `lowerThanPrevious` logic with `checkReading(m.id, parsed, readingsBefore(date), m.counter_raw_hours)` where `readingsBefore` filters readings dated `< date` for an edit and all readings for today; render the question text under the field in amber and the `okDelta` line in muted text; the form never disables Save for a question (only for `invalid`).
- Reuse the `maintenance.hours.pass.{backwards,farFromCounter,okDelta,noReference}` keys; remove `form.lowerThanPrevious` from all 15 locales (grep first).

- [ ] **Step 1: Extend the failing test** — `questions a jump far from the counter in the form and still saves it`.
- [ ] **Step 2–5:** fail → implement → `HoursTab.test.tsx` + `check:i18n` + `typecheck` PASS → `git commit -am "hours: the form uses the shared wrong-number check"`

---

### Task 15: Machine panel

**Files:**
- Create: `frontend/src/components/maintenance/hours/MachinePanel.tsx`, `frontend/src/components/maintenance/hours/MachineEvents.tsx`, `frontend/src/components/maintenance/hours/MachineCost.tsx`
- Modify: `HoursTab.tsx` (`?machine=` ↔ `panelId`, mutations for events and purchase fields), locales
- Test: `frontend/src/__tests__/components/MachinePanel.test.tsx` (create), `HoursTab.test.tsx`

**Interfaces:**
- `MachinePanel({ machine; series; readings; events: HourEvent[]; today; color; currency: string; canEdit; onEditDate(date); onAddEvent(machineId, { event_date, label }); onDeleteEvent(id); onSavePurchase(machineId, { purchase_price, purchase_date }); onClose })`. 420 px slide-over (`fixed inset-y-0 right-0`, sheet from the bottom under 640 px), Escape closes, `role="dialog"` `aria-labelledby` the name.
- Sections in spec order: header (chip, name, family, `t('maintenance.hours.panel.added', { date: added_on })`, `TrustMark size="md"` + help text + `t('maintenance.hours.pass.title')` button when not calibrated, lifetime value with date); pace (`periodPaces` last 3 as columns `from → to`, pace; `behaviourFlag` badge; load bar); forecast line when `next_service_hours != null` and pace > 0: `t('maintenance.hours.panel.forecast', { pace, hours, date })`; readings table (date, hours, pace to previous, raw auto on that date in muted, row click → `onEditDate`); `MachineEvents` (list newest first with glyph + label + date; `note` rows get a delete icon; "Add a note" row: date input default `today`, text input, Save); `MachineCost` (shown when `canEdit` or `purchase_price != null`: price input, date input, Save; computed `t('maintenance.hours.cost.perHour', { amount })` using `Intl.NumberFormat(i18n.language, { style: 'currency', currency })` over `purchase_price / lifetime`; note `t('maintenance.hours.cost.basedOn', { date })` when trust is `uncalibrated`; line `t('maintenance.hours.cost.noRevenue')`).
- Retired machines: header, readings, events only.
- HoursTab: `useSearchParams`; `panelId` mirrors `?machine=`; `currency` from `useCurrency()`; rail `onOpen` and focus-header name set it.
- Locale keys under `maintenance.hours.panel.*` (`added, lifetimeOn, pace, period, readings, rawOnDate, events, addNote, noteDate, noteText, saveNote, deleteNote, forecast, takeReading`) and `maintenance.hours.cost.*` (`title, price, date, save, perHour, basedOn, noRevenue`).

- [ ] **Step 1: Write the failing tests** — `header shows trust help and added date`, `lists period paces and a flag`, `adds and deletes a note` (msw POST/DELETE), `cost per hour uses the app currency`, `retired machine hides pace and cost`; HoursTab: `clicking a rail name opens the panel and mirrors ?machine=`.
- [ ] **Step 2–5:** fail → implement → tests + `check:i18n` + `typecheck` PASS → `git commit -am "hours: machine panel with pace, readings, events and cost"`

---

### Task 16: Entry points — `?tab=hours`, inbox kind label and target

**Files:**
- Modify: `frontend/src/pages/MaintenancePage.tsx:1103` (initial tab from `?tab=`), `frontend/src/utils/inboxTarget.ts`, `frontend/src/components/notificationKinds.ts`, locales (`inbox.kind.hoursReadingsDue`)
- Test: `frontend/src/__tests__/utils/inboxTarget.test.ts` (create or extend), `frontend/src/__tests__/components/InboxPreferences.test.tsx` (kind appears), `frontend/src/__tests__/pages/MaintenancePage.test.tsx` if it exists (else a small test in `HoursTab.test.tsx` is not enough: add `MaintenancePageTab.test.tsx` rendering the page at `/maintenance?tab=hours` and asserting the Hours tab is active)

**Interfaces:**
- `inboxTarget`: `item.target_type === 'hours'` → `/maintenance?tab=hours&pass=1`; family `printer` fallback unchanged.
- `NOTIFICATION_KINDS['hours.readings_due'] = { icon: Timer, tone: 'text-amber-400 bg-amber-400/10', family: 'printer', titleKey: 'hoursReadingsDue' }`.
- `MaintenancePage`: `useState<TabType>(() => (searchParams.get('tab') as TabType) ?? 'status')` guarded to the three known values.

- [ ] **Step 1: Write the failing tests** — `hours target opens the pass`, `maintenance page opens on the hours tab from the URL`, InboxPreferences shows the new kind label.
- [ ] **Step 2–5:** fail → implement → tests + `check:i18n` + `typecheck` PASS → `git commit -am "hours: tab deep link and readings-due inbox kind"`

---

### Task 17: Whole-feature verification

**Files:** none new.

- [ ] **Step 1: Backend suite** — `./test_backend.sh` → green (rerun a single failing file alone before debugging; known unrelated flakes are listed in memory `suite-load-flakes`).
- [ ] **Step 2: Type baseline** — `./venv/bin/python3 -m basedpyright` with the pinned env (`requirements-typecheck.lock`); if the fork's error set changed, `basedpyright --writebaseline` and include `.basedpyright/baseline.json` in the commit.
- [ ] **Step 3: Frontend suite** — `./test_frontend.sh` → `typecheck=ok lint=ok tests=ok`, parity gate green; `cd frontend && npm run check:knip` → no unused file.
- [ ] **Step 4: Build** — `cd frontend && npm run build` → green (regex lookbehind and Safari 16 baseline). Do not commit `static/` unless the user asks.
- [ ] **Step 5: Manual pass on the dev stack** — restart :8000 (new columns and the `hour_events` table need the app's `init_db`), open `/maintenance?tab=hours`, check: rail sparklines, gap band after 25 Apr 2026, no auto tail on uncalibrated machines, fleet strip "Readings due 14", pass through two machines with one deliberate typo (question shown), panel on H2S04 with pace periods and an added note, timeline click opens the edit form. Screenshot with the headless-Brave driver in the session scratchpad if the extension is down.
- [ ] **Step 6: Commit anything the verification changed** — `git commit -am "hours: verification fixes"` (only if there is a diff).
