# Maintenance › Hours: focus layout and twelve tools — design

Date: 2026-11-01 · Builds on `2026-10-04-printer-hours-design.md` (the tab as it exists) · Mockups:
`.superpowers/brainstorm/35679-1793490822/content/01-directions-v2.html` (direction C) and `02-features.html`
(the tools, every card except "Copy the table back to the sheet").

## Intent

The operator keeps the lifetime hours of every machine in the shop (14 live printers, 5 sold) so they can
follow how each machine is used, see its evolution, and notice when one behaves differently. Until October
2026 this lived in a Google Sheet; the Hours tab replaced it. The sheet's history is now imported.

Two things went wrong with the first version and drive this round:

1. **Wrong or stale numbers look like real ones.** Fenrir's own counter started at 0 on 2026-03-09 and is
   not calibrated for most machines, so the tab showed hours lower than the sheet with a later date. The
   rail printed "0 h/month" for machines that simply had no reading for six months. Nothing on the page said
   "this figure is six months old" or "this counter is not trustworthy".
2. **The page shows curves but not behaviour.** Fourteen overlapping lines say little about which machine
   slowed down, which one carries the shop, or when the next service lands.

The user chose direction C (keep the current layout and sharpen it) and every proposed tool except the
copy-to-sheet export. The guiding rule they gave: *clean, modern, and make no mistake*.

## Goals, non-goals, anti-goals

**Goals**

- A reading can only reach the database after it has been compared with what Fenrir counted since the last
  one; a suspicious value is questioned in place, never silently accepted.
- Every number on the page carries its date and its trust level; a stale or uncalibrated figure is never
  shown the way a fresh calibrated one is.
- One glance at a machine tells its lifetime, its pace over the last periods, whether that pace changed, and
  whether its counter can be trusted.
- The fleet is visible as a whole: lifetime, this month, readings due, busiest machine.
- Readings stay regular: the page and the inbox bell say when they are due.

**Non-goals**

- Exporting back to the Google Sheet (declined by the user).
- Replacing the Status tab's maintenance scheduling. The Hours tab *reads* it for service markers.
- A new route or page. Everything stays on `/maintenance`, Hours tab, plus a side panel.
- Changing how auto readings are produced (hourly snapshot, offset recalibration on a today reading).

**Anti-goals** (the page fails if any of these happen even though it "works")

- A typed value that goes backwards, or a typo of one extra digit, is saved without a word.
- The pace column prints a number for a machine whose last reading is months old, as if it were current.
- An uncalibrated counter's dashed tail is drawn on the chart and read as real hours.
- The cost-per-hour block shows a figure built on uncalibrated hours as if it were an accounting fact.

## Constraints

- Fork-only feature (Fenrir). Backend under `backend/app/api/routes/printer_hours.py` and
  `backend/app/services/printer_hours.py`; frontend under `frontend/src/components/maintenance/hours/` and
  `frontend/src/utils/hoursSeries.ts`. Follow the registration checklist in `CLAUDE.md` (model import lists,
  `Permission` classification, i18n parity across 15 locales, knip, basedpyright baseline).
- No new permission: everything reuses `MAINTENANCE_VIEW` / `MAINTENANCE_UPDATE` / `MAINTENANCE_DELETE`.
- Schema changes are additive: new columns through `run_migrations()` (dialect-aware, see
  `check_postgres_upgrade.py`), new tables through `create_all`.
- Dates stay ISO day strings handled as UTC day numbers in the frontend (`hoursSeries.ts` convention);
  `today` always comes from the server.
- Desktop first (the mockups are 1240 px), but the reading pass is designed for a phone and the whole tab
  must still work at phone width as it does now (rail collapses to a horizontal strip).
- Numbers are formatted with the app locale (`toLocaleString`), hours rounded to the unit in the UI.
- Every string is translated in all 15 locales. Expect roughly 80 new keys under `maintenance.hours.*`.

## The page (direction C)

Layout as today: rail left (270 px), chart card right, readings card below the chart. Additions in order of
appearance:

### Fleet strip

A row of four facts above the chart card, inside the right column:

| fact | definition |
|---|---|
| Fleet lifetime | sum over **all** machines, sold included, of their value at `today` (manual + accepted auto series, flat after the last point) |
| This month | hours run by live machines since the first of the current month, from the same interpolated series |
| Readings due | count of live machines whose last manual reading is older than the reminder rhythm (see Reminder) |
| Busiest | the live machine with the highest current pace, with that pace |

"Readings due" is drawn in the warning colour when above 0 and is a button that opens the reading pass.

### Rail

One row per live machine, grouped by family as today, then sold machines. Each row: colour chip, name,
a 70×20 sparkline of the machine's own series (own scale, so the shape shows), lifetime value. The rate
line under the value is removed from the rail; pace lives in the machine panel and the pace column of the
chart's focus header. A trust mark (see Counter trust) sits between the name and the sparkline when the
machine is not calibrated or is drifting; a calibrated machine shows nothing there.

Clicking a row still toggles the machine on the chart. Clicking the name opens the machine panel. Hovering
a row puts the chart in focus on that machine.

### Chart card

Header: mode segment (Lifetime · Per month · Fleet total · Same age), range segment (3 m · 12 m · All,
default All), New reading button. Below the header a one-line **focus header** that shows the focused
machine: chip, name, family, hovered date, value at that date, delta since the previous manual reading,
pace. When nothing is focused it shows the fleet: "19 machines · last reading 25 Apr 2026".

Chart rules that apply in every mode:

- **Gap marker.** A dashed vertical line at the date of the newest manual reading in the visible set, with
  the label "last reading · {date}" and, when that is more than 30 days before `today`, a hatched band from
  that date to `today` labelled "no readings for {n} months". The band is the honest replacement for a flat
  line.
- **Auto tail.** The dashed auto continuation after the last manual reading is drawn only for machines whose
  counter is calibrated (see Counter trust). Uncalibrated or drifting counters get no tail.
- **Focus.** Hovering a rail row or a curve, or clicking a rail name, fades the other machines to 20 % and
  thickens the focused one; the focus header fills with its numbers. Escape or leaving the chart clears a
  hover focus; a click focus stays until the next click or Escape.
- **Events.** Thin vertical ticks at event dates (see Events), one glyph per kind; hovering a tick shows the
  note. Ticks only for visible machines.
- **Forecast.** In Lifetime mode, a dotted continuation from each visible machine's last point at its
  current pace, up to the end of the range (12 m from `today` when range is All). A horizontal
  warning-coloured line per focused machine at its next hour-based service threshold, labelled with the
  threshold and the date the forecast reaches it (see Forecast).

Modes: Lifetime, Per month and Fleet total as today. **Same age** is new: x axis is days since each visible
machine's first manual reading (labelled in months), y is hours since that reading; it is meant for 2–3
machines and shows a hint "pick two or three machines in the list" when more than 4 are visible.

### Readings card

Replaces the log list:

- A **timeline** of reading dates across the card width (Jul 2024 → today): one dot per manual date, the
  dot's size by number of machines read that day, a warning dot at `today` when readings are due. Hovering a
  dot shows the date, the machine count and the fleet sum; clicking it opens the existing edit form for
  that date.
- Under the timeline, the two newest dates as rows (date, machines, fleet sum, Edit, Delete) and a "{n}
  older dates" link that expands the full list, which is today's log.
- Paste from sheet stays in the card header.

## The tools

### 1. Reading pass ("Take readings, one machine at a time")

A full-screen dialog opened from the fleet strip's "Readings due" fact, from the New reading button's
split menu ("One by one"), and from the reminder notification. It walks the live machines in rail order:

- Header: "3 / 14", machine name and family, last manual reading with its date, and Fenrir's counter delta
  since that date ("Fenrir counted +612 h since 25 Apr").
- One large numeric input (`inputmode="decimal"`), empty. Enter or Next moves on; blank skips; Back returns.
  A progress bar; a "skip sold" note is unnecessary since sold machines never appear.
- Each value goes through the wrong-number check (tool 2) as soon as the field loses focus or Enter is
  pressed; a flagged value shows the question inline and Enter again means "keep anyway".
- Last step: a summary table (machine, old, new, delta, flag) and one Save. Save posts to the existing
  `POST /maintenance/hours/readings` with `reading_date = today`, so recalibration behaves exactly as the
  form does. Nothing is written before Save.
- Phone layout is the primary one: input and buttons reachable with a thumb, 100 dvh, no scrolling per step.

### 2. Wrong-number check ("Catch a wrong number before it is saved")

Pure function in `hoursSeries.ts`, used by the reading pass, the New reading form and the edit form:

```
checkReading(machine, typed, readings, today) → { level: 'ok' | 'question', expected?: number, reason }
```

Reference: the machine's last manual reading `M` at date `D`, and Fenrir's **raw** counter at `D` (the auto
row on `D`, or the first within 7 days after) and now (`HourMachineOut.counter_raw_hours`, the printer's
live `runtime_seconds / 3600`). The counter delta `Δc = raw(now) − raw(D)` must not depend on the offset,
so auto rows gain a column `raw_hours` (see Backend summary); `hours` keeps the offset-adjusted value for
the curves. Rows written before the column exists have `raw_hours` null and give no reference.

- `typed < M` → question: "lower than the {M} h read on {D}. Lifetime hours never go down."
- `Δc` available and `|typed − (M + Δc)| > max(24 h, 20 % of Δc)` → question: "{+typed−M} h typed, but Fenrir
  counted {+Δc} h since {D}. Expected about {M+Δc} h."
- `Δc` unavailable (no auto reading near `D`, machine added after `D`): only the backwards rule applies, and
  the inline help says "no counter reference for this period".
- Otherwise ok, with the confirmation line "+{typed−M} h, Fenrir counted +{Δc} h".

A question never blocks: the user confirms with a second Enter or a "Keep anyway" button. The flag and the
reason are shown again in the pass summary. The check is frontend-only; the backend keeps its current
validation (no future dates, retired rejected, `MAX_HOURS`).

### 3. Counter trust ("Show whether each counter is trustworthy")

Per live machine, one of three states, computed on the server and returned in `HourMachineOut`:

| state | rule |
|---|---|
| `calibrated` | `calibrated_at` is set and drift is within tolerance |
| `drifting` | `calibrated_at` is set and `|drift| > max(24 h, 2 % of the manual value)` |
| `uncalibrated` | `calibrated_at` is null (no today-dated manual reading ever recalibrated this printer) |

Between two readings there is no truth to measure the counter against, so drift is **captured at the moment
a calibration happens**: `drift = counter-with-offset just before recalibration − typed value`. It says how
far the counter had wandered since the previous calibration, which is exactly what tells the operator
whether the dashed tail can be believed. It is stored on the machine as `last_drift_hours` with
`calibrated_at`, and shown as "counter was {n} h off at the {date} reading". The first calibration of a
machine stores `drift = null` (the counter started at 0, the gap is not drift).

**What counts as a calibration.** Two paths rewrite `print_hours_offset`: the Hours save route (today-dated
manual reading) and the Status tab's set-hours (`set_printer_hours` in `routes/maintenance.py`). Both are the
operator stating the true hours, so both set `calibrated_at`, store the drift, write a `calibrated` event
and rewrite today's auto row (the Status route gains the last two; it still writes no manual reading).

New columns on `hour_machines`: `calibrated_at` (datetime, nullable) and `last_drift_hours` (float,
nullable); both cleared when the row is retired or re-linked to another serial. Backfill for existing rows:
`calibrated_at` is set to the newest manual reading's date for machines whose printer has
`print_hours_offset > 0` **and** at least one manual reading; a printer with an offset but no manual reading
(Status-tab edit only) gets `calibrated_at = today`. Drift stays null in the backfill.

Where it shows: a small mark in the rail (none / warning triangle "drifting {n} h" / hollow circle "not
calibrated"), the same mark in the machine panel header with the explanation and a "Take a reading" button,
and the chart's auto-tail rule above. `current_hours` keeps being returned but the UI never displays it as
the machine's hours for an uncalibrated machine (today's rule, now explicit).

### 4. Pace per period ("Pace per period and the drop that needs a look")

Pace between consecutive manual readings: `(h2 − h1) / days × 30.44`, computed in `hoursSeries.ts`. The
machine panel lists the last three periods side by side. A machine gets a **behaviour flag** when:

- `slowing`: the newest period's pace is below half of the previous period's and the machine is live;
- `stopped`: the newest period is at least 30 days long and its pace is below 1 h/month, machine live.

Flags appear in the machine panel and as a short badge in the chart focus header. The rail stays clean.

The "current pace" used by the fleet strip, forecast and load is the 90-day window rate already in
`ratePerMonth`, with one change: it returns `null` when the series' last point is older than 90 days, so a
stale machine never prints a pace. Where a pace would be printed and is null, the UI prints "last reading
{date}" instead.

### 5. Load ("Load: hours as a share of the hours available")

`load = pace / (24 × 30.44)`, shown as a bar with a percentage in the machine panel and, per family, in a
small table at the bottom of the fleet strip when expanded (the strip gets a chevron; expanded it shows one
bar per live machine sorted by load, families as group rows). Null pace → no bar, "no recent reading".

### 6. Forecast ("Forecast at the current pace")

Dotted continuation per visible machine in Lifetime mode (see Chart card). The next service threshold comes
from the Status tab's data: for the machine's printer, the earliest hour-based maintenance item
(`interval_type == 'hours'`) gives `due_at_hours = current_hours + hours_until_due`. That value is served
in `HourMachineOut.next_service_hours` (null when the printer has no hour-based item or is not calibrated,
because an uncalibrated counter's "hours until due" is meaningless). The date the forecast reaches it is
computed in the frontend from the pace.

### 7. Same age ("Compare machines at the same age")

Fourth chart mode, described under Chart card. No backend change.

### 8. Events ("Events on the chart")

New table `hour_events`:

| column | type | notes |
|---|---|---|
| id | int PK | |
| machine_id | int FK `hour_machines.id` ON DELETE CASCADE, index | |
| event_date | date | |
| kind | str(20) | `note` (user), `maintenance`, `added`, `retired`, `calibrated` |
| label | str(200) | the note text, or the maintenance type name |
| source_id | int nullable | `maintenance_history.id` for `maintenance` rows, so re-syncs are idempotent |
| created_at | datetime | |

- `added` means "joined the fleet": `added_on = min(first manual reading date, printer created_at)`, so a
  machine imported from the sheet is "added" in 2024, not on Fenrir's install day. The tick is not drawn
  when it coincides with the machine's first point (always true for sheet machines); the panel header still
  prints the date. Existing rows are backfilled once with that rule.
- `note` rows are created and deleted by the user (`POST /maintenance/hours/machines/{id}/events`,
  `DELETE /maintenance/hours/events/{id}`, both `MAINTENANCE_UPDATE`).
- `maintenance` rows are mirrored from `maintenance_history` for the machine's printer each time the
  overview is built (insert missing `source_id`s; never delete). `added` is written when a machine row is
  created for a printer (date as defined above), `retired` when `ensure_hour_machines` retires a row,
  `calibrated` when the save route recalibrates.
- `GET /maintenance/hours` returns `events: list[HourEventOut]`.
- On the chart: a tick per event at its date on the machine's curve; same glyph family as the trust marks.
  In the machine panel: a list, with an "Add a note" row (date defaults to today, text) and delete on
  `note` rows only.

### 9. Machine panel ("A machine page")

A slide-over panel (same pattern as the Aito card panel: 420 px, sheet at phone width, Escape closes),
opened by clicking a machine name in the rail or the focus header. URL mirrors it as `?machine={id}` so a
link can be shared. Content, top to bottom:

1. Header: chip, name, family, "added {date}", trust mark with explanation, lifetime value with its date.
2. Pace: last three periods, behaviour flag, load bar.
3. Forecast line: "at {pace} h/month, {threshold} h around {date}" when a threshold exists.
4. Readings: every manual reading, newest first, with the pace to the previous one; raw auto value on that
   date in a muted column when present; row click opens the edit form for that date.
5. Events: list and "Add a note".
6. Cost per hour block (tool 11) when the machine has a purchase price.

Retired machines open the same panel with the readings and events only.

### 10. Fleet strip

Described under The page. Expanded state holds the load table (tool 5).

### 11. Reminder ("A reminder when readings are due")

- Setting `hours_reading_interval_days` in the `settings` table, default 90, edited from a small "Readings
  every {n} days" control in the readings card header (number input, 7–365).
- A live machine is **due** when its newest manual reading is older than the interval, or it has none.
- The hourly `PrinterHoursService` sweep also checks, once per calendar day, whether any machine is due. If
  so and no `hours.readings_due` notification was created in the last interval, it creates one inbox
  notification (`kind = 'hours.readings_due'`, family `printer`, title "Readings due", body "{n} machines ·
  last reading {date}", `target_type = 'hours'`) for every user holding `MAINTENANCE_UPDATE`. Clicking it
  opens `/maintenance?tab=hours&pass=1`, which opens the reading pass.
- The inbox `KINDS` table gains `hours.readings_due` (family `printer`, no watch). `InboxKind` grows an
  explicit `available` flag so a kind with no Aito events can still be offered in Settings (today
  `available = bool(spec.events)`). The kind is in `DEFAULT_KINDS` (on by default, sound off), and the sweep
  respects each user's preference through `preferences_for` instead of inserting rows blindly, so a user can
  silence it from Settings like any other kind. Frontend: `eventKinds.ts` label and all locales.
- The "last reminder" timestamp lives in `settings` (`hours_reading_last_reminder`), not in the
  `notifications` table, which is purged after 30 days.

### 12. Cost per hour

Kept deliberately small until the hours are trustworthy:

- New columns on `hour_machines`: `purchase_price` (numeric, nullable) and `purchase_date` (date,
  nullable); edited in the machine panel (`PATCH /maintenance/hours/machines/{id}` already exists for retired
  machines and is extended to accept these two fields for any machine).
- Currency: the app's existing currency setting (the one the calculator and Aito use), formatted the same way.
- Shown in the machine panel only: price, hours, **price per hour = purchase_price / lifetime hours**, and
  the purchase date. Revenue, depreciation and profit from the sheet's top block are **not** built; the
  panel's block carries a one-line note "revenue per machine is not tracked".
- When the machine's trust state is `uncalibrated`, the figure is still shown but with the trust mark and
  the words "based on the last reading of {date}".

## Backend summary

- `hour_machines` + `calibrated_at`, `last_drift_hours`, `purchase_price`, `purchase_date`; `hour_readings` +
  `raw_hours` (migrations, dialect-aware). `snapshot_today` writes both `hours` and `raw_hours`.
- `hour_events` table (create_all; register in the three model import lists).
- `HourMachineOut` + `trust: 'calibrated' | 'drifting' | 'uncalibrated' | null` (null for retired),
  `last_drift_hours: float | null`, `calibrated_at`, `counter_raw_hours: float | null`,
  `next_service_hours: float | null`, `purchase_price`, `purchase_date`,
  `added_on: date | null`.
- `HoursOverview` + `events`, `reading_interval_days`, `due_machine_ids: list[int]`.
- Routes added: `POST /maintenance/hours/machines/{id}/events`, `DELETE /maintenance/hours/events/{id}`,
  `PATCH /maintenance/hours/settings` (interval). `PATCH /machines/{id}` extended.
- Save route and the Status tab's set-hours both set `calibrated_at`, store the drift, write a `calibrated`
  event and rewrite today's auto row (shared helper in `services/printer_hours.py`).
- Sweep: daily due check and notification.
- `test_aito_permissions.py` is Aito-only; the hours routes have their own permission tests in
  `test_printer_hours_*.py`, extend those.

## Frontend summary

- `HoursTab.tsx` grows the fleet strip, focus state, range state, panel state (`?machine=`), pass state
  (`?pass=1`).
- New components under `components/maintenance/hours/`: `FleetStrip`, `ReadingPass`, `MachinePanel`,
  `ReadingTimeline`, `TrustMark`, `EventTicks` (chart overlay). `HoursChart` gains focus, range, gap
  marker, forecast, events, Same age mode. `MachineList` gains sparklines and trust marks, loses the rate
  line. `ReadingLog` becomes the expanded list under the timeline.
- `hoursSeries.ts` gains `checkReading`, `periodPaces`, `behaviourFlag`, `load`, `forecastDate`,
  `sameAgePoints`, and the stale rule in `ratePerMonth`.
- Tests: Vitest for every pure helper (the wrong-number thresholds, stale pace, flags, same-age alignment)
  and for the pass flow (enter, flag, keep anyway, skip, save payload); backend tests for trust states,
  events mirroring, due detection and the notification's once-per-interval rule.

## Left to the builder

- Exact glyphs for trust marks and event ticks (use lucide icons already in the bundle).
- Chart implementation details within recharts (the gap band and forecast lines can be `ReferenceArea` /
  extra `Line`s); if recharts fights the focus fade, an SVG overlay is acceptable.
- Sparkline rendering (inline SVG, no library).
- Phone layout of the panel and the pass beyond the rules above.
- Order and wording of the roughly 80 locale keys, within the app's existing tone (sentence case, plain verbs).
- Whether the load table in the expanded fleet strip is a separate component.

## Calls I made that the user did not state

- Reminder rhythm default 90 days (the sheet was read every 3–4 months); editable from the readings card.
- Wrong-number tolerance `max(24 h, 20 %)` and drift tolerance `max(24 h, 2 %)`.
- Cost per hour is purchase price over lifetime hours only; the sheet's revenue, depreciation and profit
  columns stay out.
- The machine page is a slide-over panel with a `?machine=` URL, not a route.
- Readings card keeps the edit form per date; the timeline is a second way into it.
- `Same age` hides nothing by itself; it only hints when too many machines are visible.
- Drift is measured at calibration time, not live; the Status tab's set-hours counts as a calibration.
- Auto rows store the raw counter next to the adjusted value so the wrong-number check survives offset changes.
- "Added" is the first reading date for machines that predate Fenrir.
- The readings-due reminder is an ordinary inbox kind: on by default, no sound, can be switched off per user.
