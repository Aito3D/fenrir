# Printer hours history — design

Date: 2026-10-04 · Branch: `printer-hours` · Mock: proposal C ("Split view") of the scratch demo

## Goal

Replace the operator's Google Sheet of machine hours with a third Maintenance tab, **Hours**. The operator
records each machine's lifetime hours (read off the printer screen) on a given date. The tab shows how each
machine's hours evolved, the hours per month, and the fleet total. The sheet's history (7 dates since
19/07/2024, 19 machines) is pasted in once.

### Decisions taken in brainstorming

- **Manual + auto.** Typed readings are the truth. Fenrir also snapshots its own counter daily, so curves fill
  in between readings.
- **A manual reading recalibrates Fenrir's counter** (`print_hours_offset`), so the Status tab and maintenance
  intervals match the printer screen. This applies only to readings **dated today**; see Recalibration.
- **History comes in through a paste dialog** fed from Google Sheets. It stays available for future bulk entry.
- **The 5 sheet machines unknown to Fenrir (X1C01–03, H2C03–04) are sold.** They are kept as *retired*
  machines: hours history only, not printers.
- **The New reading form lists only printers that are in Fenrir.** Retired machines never appear there, including
  when a past date is edited from the log. Their values are corrected by re-pasting.
- **Layout C**: printer list on the left, chart with three modes on the right, reading log below.

### Out of scope

The sheet's cost/revenue/profit block (Cost, CA, Decote, Benef), reminders to take a reading, linking a
retired machine back to a printer, and CSV/XLSX file import (paste only).

## Data model

Two new tables, created by `create_all`, so no `run_migrations()` change. Both models live in
`backend/app/models/maintenance.py`, which the `init_db()` and `tests/conftest.py` import lists already import, so
only `models/__init__.py` gains the two names.

### `hour_machines` (`HourMachine`)

| column | type | notes |
|---|---|---|
| id | int PK | |
| printer_id | int FK `printers.id` `ON DELETE SET NULL`, nullable, unique | NULL for retired machines |
| name | str(100) | printer name at creation; the printer's live name wins when linked |
| model | str(50) nullable | e.g. `X1C`, `H2S`; drives the family colour |
| serial_number | str(50) nullable | linked printer's serial; SQLite can reuse a deleted printer's id, so a serial mismatch retires the row instead of hijacking it |
| retired | bool, default false | |
| created_at | datetime | |

- Each Fenrir printer gets a row lazily, the first time `GET /hours` runs or the snapshot job runs
  (`ensure_hour_machines()`).
- When a printer is deleted from Fenrir, `ON DELETE SET NULL` keeps the row. `ensure_hour_machines()` marks rows
  with `printer_id IS NULL` as `retired`. SQLite does not enforce FKs here (see `oidc_provider.py`), so the code
  also treats a `printer_id` pointing at a missing printer as retired.
- An inactive printer (`is_active = false`) stays non-retired: it is still in Fenrir.

### `hour_readings` (`HourReading`)

| column | type | notes |
|---|---|---|
| id | int PK | |
| machine_id | int FK `hour_machines.id` `ON DELETE CASCADE` | |
| reading_date | date | the operator's calendar date |
| hours | float | lifetime hours, ≥ 0 |
| source | str(10) | `manual` or `auto` |
| created_at / updated_at | datetime | |

Unique `(machine_id, reading_date, source)`. Writes are upserts: a manual reading for a date that already has one
replaces it.

## Backend

### Service: `backend/app/services/printer_hours.py`

- `current_hours(printer)`: `runtime_seconds / 3600 + print_hours_offset`. Same formula as
  `get_printer_total_hours` in `routes/maintenance.py`, which is refactored to call it.
- `ensure_hour_machines(db)`: creates missing rows for printers, syncs `name`/`model` from linked printers, and
  marks orphans retired.
- `snapshot_today(db)`: for every non-retired machine with a printer, upserts today's `auto` reading with
  `current_hours`. Idempotent; a re-run the same day overwrites the value.
- Scheduler: `start_scheduler()`/`stop_scheduler()` run `snapshot_today` every hour (first run ~60 s after startup).
  They are wired into `main.py` lifespan next to the other schedulers. Hourly rather than at midnight so a restart
  never loses a day. "Today" is the server's local date (`date.today()`), the same date the frontend sends for a
  reading made today.

### Recalibration

When a **manual** reading is saved for a machine linked to a printer **and its `reading_date` is today**, the
printer's offset is set so `current_hours == hours`. This reuses the body of `set_printer_hours` (offset maths plus
the maintenance-due notification), extracted into a shared helper. Today's `auto` reading is then rewritten to the
same value.

Backdated readings and imports never touch the offset. Otherwise pasting the sheet's 25/04 values would wind every
counter back to April.

### Routes (new module `routes/printer_hours.py`, prefix `/maintenance/hours`, included in `main.py` next to `maintenance.router`)

| method & path | permission | body / result |
|---|---|---|
| `GET /hours` | `MAINTENANCE_READ` | `{machines: HourMachineOut[], readings: HourReadingOut[], today: date}`. `HourMachineOut` = `id, printer_id, name, model, retired, current_hours` (`current_hours` null when retired) |
| `POST /hours/readings` | `MAINTENANCE_UPDATE` | `{reading_date, entries: [{machine_id, hours: float \| null}]}`. Upserts manual readings, and `null` deletes that cell. Rejects (422) retired machines, unknown ids, negative hours and future dates. Recalibrates per the rule above. Returns the updated machine + reading payload |
| `DELETE /hours/readings?reading_date=` | `MAINTENANCE_DELETE` | deletes every **manual** reading on that date (auto rows kept) |
| `POST /hours/import` | `MAINTENANCE_UPDATE` | `{new_machines: [{key, name, model}], readings: [{machine_id \| key, reading_date, hours}]}`. One transaction: creates retired machines, then upserts manual readings (retired allowed here). Never recalibrates. Returns counts |
| `PATCH /hours/machines/{id}` | `MAINTENANCE_UPDATE` | rename / change model; retired machines only (409 otherwise) |
| `DELETE /hours/machines/{id}` | `MAINTENANCE_DELETE` | retired machines only; cascades readings |

The maintenance router has no root-level parameterised route, so nothing shadows `/hours`. No new `Permission`
member.

Schemas go in `backend/app/schemas/maintenance.py`; client types and functions in `frontend/src/api/client.ts`.

## Frontend

`MaintenancePage.tsx` gets `TabType = 'status' | 'settings' | 'hours'` and a third tab button. The tab body is a new component. The subtitle for this tab is a static line ("Lifetime hours per machine").

### Files

- `components/maintenance/hours/HoursTab.tsx`: query `['maintenanceHours']`, layout, selection state.
- `components/maintenance/hours/MachineList.tsx`: grouped by model family, then a **Retired** group. Each row has a
  colour dot, name, current hours (last reading for retired) and h/month over the last 90 days. Click toggles the
  machine on the chart; plus "all / none" links. Below `md` it becomes a horizontally scrolling chip row above the
  chart.
- `components/maintenance/hours/HoursChart.tsx` (recharts) with a segmented control:
  - **Cumulative**: per machine, a solid line + dots for manual readings, then a dashed line for auto readings
    *newer than that machine's latest manual reading*. Older auto points are pre-calibration and are not drawn.
  - **Hours / month**: stacked bars per calendar month, from each machine's cumulative curve interpolated linearly
    at month boundaries. The current month is partial and labelled as such.
  - **Fleet total**: the sum over machines of their interpolated value at each date. Before a machine's first
    reading it contributes 0; after its last one (retired machines) it stays at its last value.
- `components/maintenance/hours/ReadingLog.tsx`: one row per date, newest first: badge (manual/auto), date, machine
  count, total. Auto readings appear as one "Fenrir counters · today" row (today's snapshot only; daily auto rows would flood
  the log). Manual rows have **Edit** (opens the form for that date) and delete.
- `components/maintenance/hours/ReadingFormModal.tsx`: date input (default and max = the server's `today` from `GET /hours`, so
  the browser's and the server's "today" never disagree) and one numeric field per **non-retired** machine.
  Fenrir's `current_hours` is shown as the field's grey *placeholder*, not its value: an untouched field is skipped,
  so a machine nobody read is never recorded as a manual reading. An edited date prefills that date's manual values. Each field shows its delta against the machine's previous manual
  reading, amber when negative. A note explains that today's readings recalibrate the counter. Clearing a
  previously filled field deletes that cell.
- `components/maintenance/hours/PasteImportModal.tsx`: textarea plus a live preview. Columns are matched to machines
  by case-insensitive name. Each unmatched column gets a select (*Create as retired machine* · *Ignore*; model
  guessed from the name prefix). It shows counts of dates, matched columns and readings, and a note that dates
  already on file are replaced. Zeros and empty cells are skipped.
- `utils/hoursSeries.ts`: pure functions.
  - `parseSheetPaste(text)`: TSV, first row is the header, first column a date in `DD/MM/YYYY` (also `YYYY-MM-DD`).
    Numbers accept spaces and `,`/`.`. Rows without a valid date are ignored.
  - `machineSeries(readings, machineId)`: `{manual, auto}` with the "auto after last manual" filter.
  - `valueAt(series, date)`: linear interpolation (0 before the first reading, flat after the last).
  - `monthlyHours(series, months)`, `fleetTotal(machines, readings, dates)`.
  - `ratePerMonth(series, days)`.
- Colours: hue per model family (X1C blue, A1 orange, H2D purple, H2S teal, H2C pink, others grey), lightness spread
  across the family's machines. Stable, sorted by name.

### i18n

New keys under `maintenance.hours.*` in all 15 locales with real translations (the parity gate rejects copied
English).

## Error handling

- Mutations show a toast on error; the form stays open with its values.
- Paste: an unparseable header or zero valid rows disables Import and shows the reason inline.
- The snapshot job logs a warning on failure and retries next hour; it never raises into the loop.
- Recalibration failure (printer deleted mid-request) skips that machine's recalibration and still saves the
  reading.

## Testing

- **Backend** (`tests/unit/test_printer_hours*.py`):
  - `ensure_hour_machines`: creation, rename sync, orphan retirement.
  - `snapshot_today`: idempotence; skips retired machines.
  - `POST /readings`: upsert, null delete, retired 422, future 422, recalibrates today only, backdated leaves the
    offset untouched, today's auto row rewritten.
  - `POST /import`: creates retired machines + readings atomically, replaces existing dates, never recalibrates.
  - Machine PATCH/DELETE: retired only.
  - Permissions on each route.
  - `get_printer_total_hours` behaviour unchanged after the refactor.
- **Frontend**:
  - `hoursSeries.test.ts` against the real sheet data: parse, interpolation, monthly buckets, fleet total
    (37 115 h on 25/04/2026), auto-after-manual filter.
  - Component tests: tab switch renders; the form lists no retired machines; a negative delta turns amber; paste
    preview counts and unmatched-column choices.
- **Manual**: in a sandbox (copy of the DEV DB), paste the sheet, add a today reading, and check the Status tab
  hours and the chart in Brave.
