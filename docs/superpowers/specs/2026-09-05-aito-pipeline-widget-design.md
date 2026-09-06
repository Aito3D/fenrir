# Aito pipeline widget — design

Date: 2026-09-05. Status: approved in chat, awaiting written review.

Fourth of six features from the 2026-09-03 brainstorm (after due date + rush,
the follow-ups strip, and the print backlog badge). A stats-page card that
answers "how is the Aito business flowing": money by stage, quote conversion,
time per stage, and invoicing.

## Goal

One dashboard widget on the Stats page, `PipelineWidget`, fed by one
aggregate endpoint, `GET /api/v1/aito/stats`, computed server-side from the
project rows and the Aito event log. Four blocks:

1. **Board by stage** (snapshot): count and Σ `quote_total` per board column.
2. **Conversion in the period**: quotes sent / accepted / declined, amounts,
   and the acceptance rate.
3. **Days per stage** (period): median days cards spent in each stage before
   moving on.
4. **Invoicing**: value invoiced in the period, and the balance still owed
   (snapshot).

## Non-goals

- No new permission, setting, column, or write path. Read-only aggregation.
- No per-client or per-salesperson breakdown.
- No charting library beyond what the stats page already uses; the widget is
  tiles and a segmented bar.
- Trashed projects (`status != 'active'`) are excluded from every block.

## 1. Endpoint

`GET /api/v1/aito/stats?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&tz_offset_minutes=N`

- Gated on `Permission.AITO_READ` (the calculator insights precedent:
  aggregates are computed server-side so an Aito reader needs nothing else).
- Both dates optional; absent means unbounded on that side. `date_to` is
  inclusive (the range ends at `date_to 23:59:59`). A `date_from` after
  `date_to` is a 422. The dates are the caller's LOCAL calendar days,
  converted to the naive-UTC window the `occurred_at` columns are stored in
  by `utils/dates.local_day_bounds` with `tz_offset_minutes` (minutes east of
  UTC, `-840…840`, default 0) — exactly what `/archives/stats` and
  `/smart-plugs/energy/history` do, so the widget's period is the same span of
  time as the sibling widgets sitting beside it on the Stats page. The client
  always sends the offset.
- Implemented in `services/aito_stats.py`, one entry point
  `compute_aito_stats(db, date_from, date_to, tz_offset_minutes) -> AitoStatsResponse`.

### Response

```
{
  "board": [ {"column": "devis", "count": 3, "total": 12300.0}, … ],   // all seven board columns, fixed order, done included
  "conversion": {
    "sent": {"count": 9, "total": 41000.0},
    "accepted": {"count": 6, "total": 30500.0},
    "declined": {"count": 1, "total": 2000.0},
    "acceptance_rate": 0.857                                            // accepted / (accepted + declined), null when both are 0
  },
  "stage_days": [ {"column": "devis", "median_days": 2.5, "sample": 8}, … ],  // six working columns in board order: devis, waiting, scan, model, print, finish
  "invoicing": {
    "invoiced_total": 28000.0,     // Σ quote_total of invoiced cards accepted in the period
    "invoiced_count": 5,
    "outstanding_balance": 7400.0, // Σ invoice_balance over active invoiced cards (snapshot)
    "outstanding_count": 2
  },
  "date_from": "2026-08-01", "date_to": "2026-09-05"
}
```

### Rules

- **Board**: over active projects, grouped by `board_column`, `total` sums
  `quote_total` treating NULL as 0. All seven columns appear (`devis`,
  `waiting`, `scan`, `model`, `print`, `finish`, `done`) so the widget can
  draw a stable bar; the widget decides whether to show Done.
- **Conversion**: one row per project, from the event log. A project counts
  as *sent* if its FIRST `quote.sent` or `quote.emailed` event falls in the
  range; *accepted* if its FIRST `quote.accepted` event falls in the range;
  *declined* likewise for `quote.declined`. "First" is `MIN(occurred_at)`
  per (project, kind-group). Amounts sum the project's `quote_total` (NULL as
  0). A project accepted then unaccepted still counts as accepted at its first
  acceptance. `acceptance_rate` = accepted / (accepted + declined), `null`
  when the denominator is 0.
- **Conversion — acceptances mirrored from Zoho**: `reconcile_quote_status`
  adopts a decision Books already holds and records only `poll.reconciled`, so
  a real client acceptance can exist with NO `quote.accepted` event. That path
  does stamp `project.quote_accepted_at`, so the acceptance moment for a
  project is `min(first quote.accepted event, quote_accepted_at)` over
  whichever of the two exist. There is no matching column for a decline, so a
  Zoho-side decline with no event stays invisible to this widget — accepted
  by design rather than inventing a write path for it.
- **Conversion — imported decisions**: a quote imported already-decided
  records `quote.{accepted,declined}` with `occurred_at = now` for a decision
  the client made at some past, unknown moment. Such a row is ignored when
  picking a project's first moment (hence the ordered scan + first-eligible
  row in Python instead of a SQL `MIN`), so an import never credits its own
  week with someone else's sale. A row counts as import-time when EITHER it
  carries `detail = {"cause": "import"}`, which `create_project` now stamps,
  OR its `occurred_at` falls within 60 seconds after the project's own
  `project.created` event — the same window and the same fetched map the
  stage-days rule uses. The second clause covers the cards imported before
  the marker existed, so no backfill migration is needed; the explicit cause
  check stays for new imports, whose decision is recorded from the same
  request but need not be assumed to stay inside that window.
- **Stage days**: order each project's `stage.changed` events by
  `occurred_at`; each event closes a stay in `changes[0].from` that began at
  the previous `stage.changed` event's `occurred_at`, or at the project's
  `created_at` for the first. A stay counts toward the period if its closing
  event falls in the range. `median_days` is the median of stay lengths in
  days (float, one decimal is the widget's job), `sample` the count. Stays
  in `done` are never produced (nothing leaves Done except a restore, which
  is not a stage), so `stage_days` lists the six columns before Done. A stay
  whose closing `stage.changed` lands within 60 seconds AFTER the project's
  own `project.created` event is skipped: that is the board rules placing a
  brand-new card, not a move. It matters because an imported card's
  `created_at` is backdated to the Books quote's date, which would otherwise
  turn that opening placement into a weeks-long fake stay in `devis`. A
  project with no `project.created` event (pre-event-log rows) keeps every
  stay. The skipped move still opens the next stay.
- **Invoicing**: `invoiced_total`/`invoiced_count` over active projects with
  `quote_invoiced` true whose first `quote.accepted` falls in the range;
  `outstanding_*` over all active invoiced projects with
  `invoice_balance > 0` (snapshot, dates ignored).

### Cost

Six small queries: the active project rows (board totals and invoicing are
summed in Python from them), four ordered `occurred_at` scans restricted to
those projects (sent/emailed, accepted, declined, and `project.created` — the
creation anchor, fetched once and reused by both the decision filter and the
stage-days rule; first eligible row per project taken in Python),
and one ordered scan of `stage.changed` events for them (the stay maths runs
in Python over that ordered list). SQLite handles the board sizes in question
(tens to hundreds of projects, low thousands of events) in milliseconds; no
cache. The `project_id IN (...)` lists carry one bound parameter per active
project, well under SQLite's variable limit at this scale.

## 2. Widget — `components/stats/PipelineWidget.tsx`

Registered in `StatsPage`'s widget list with `id: 'aito-pipeline'`,
`title: t('stats.aitoPipeline')`, `defaultSize: 2`, only when
`hasPermission('aito:read')` (same conditional-spread pattern as the
maintenance widget). Fetches `api.getAitoStats({ dateFrom, dateTo })` with
the page's effective range under `queryKey: ['aitoStats', dateFrom, dateTo]`.

Layout, top to bottom:

1. **Stage bar**: one segmented horizontal bar, width proportional to
   `total` per column for the six working columns (Done omitted from the bar,
   shown as a small trailing "Done N" chip), segment colours from the board's
   `COLUMNS` dots, a legend row of "column · count · amount". Zero-total
   columns keep a minimum 4px segment so they stay visible.
2. **Conversion**: three tiles — Sent, Accepted, Declined — each count over
   amount, and the rate as "N% accepted" beside the Accepted tile; "—" when
   the rate is null.
3. **Days per stage**: a compact row of six mini-tiles, column label over
   "N.N d" (`—` when `sample` is 0), with the sample as a tooltip.
4. **Invoicing**: two tiles — Invoiced (period) and Outstanding (snapshot) —
   count over amount.

Money through the existing `formatMoney(value, currency)`; currency from
`useCurrency()`. Loading: the same skeleton the energy widget uses. Empty
(every count 0): one line, `stats.aitoPipelineEmpty`. Error (`isError` from
the query, or no data): one line in the same slot, the existing
`common.errorLoading` — never the empty line, which would report a 403 or a
500 as a quiet board.

## 3. i18n

`stats.aitoPipeline`, `stats.aitoPipelineEmpty`, `stats.pipelineByStage`,
`stats.pipelineConversion`, `stats.pipelineSent`, `stats.pipelineAccepted`,
`stats.pipelineDeclined`, `stats.pipelineAcceptedRate` (`{{pct}}`),
`stats.pipelineStageDays`, `stats.pipelineInvoicing`,
`stats.pipelineInvoiced`, `stats.pipelineOutstanding`,
`stats.pipelineDays` (`{{days}}`), `stats.pipelineSample` (`{{count}}`),
all 13 locales. Column names reuse `aito.columns.*`.

## 4. Testing

Backend (`tests/unit/test_aito_stats.py`, seeded through the API and direct
event inserts):
- Board: counts and totals per column, NULL totals as 0, trashed excluded,
  all seven columns present.
- Conversion: first-event semantics (a second `quote.sent` does not double
  count; accepted-then-unaccepted counts once), range boundaries inclusive on
  both days, events of trashed projects ignored, rate null at 0/0.
- Stage days: a project that visited `devis → waiting → scan` yields two
  stays attributed to `devis` and `waiting`; the first stay starts at
  `created_at`; a stay closing outside the range is ignored; median over an
  even sample averages the middle two.
- Invoicing: period filter on invoiced total, snapshot on outstanding, a paid
  invoice (balance 0) not outstanding.
- Zoho-side acceptance: `quote_accepted_at` with no `quote.accepted` event
  counts (and reaches `invoiced_total`); with both, the earlier moment wins.
- Imported decision: a `quote.accepted` carrying `detail.cause == "import"`
  is not counted in the import's period; neither is an unmarked one 5 s after
  `project.created` (the legacy-import case), while the same event 2 days
  later is.
- Creation-time move: a `stage.changed` 5 s after `project.created` is no
  stay, one 2 days later is; a move out of `done` is no stay but still resets
  the clock for the next one.
- Timezone: with `tz_offset_minutes=-600`, an event at `2026-08-31 09:30` UTC
  is 30 August locally and falls outside `date_to=2026-08-31`.
- Route: 422 on inverted range, permission is `aito:read` (static-closure
  test), absent dates allowed.

Frontend:
- `PipelineWidget.test.tsx`: renders all four sections from a fixture, the
  rate text, `—` for a null rate and a zero sample, the empty state, money
  formatting with the app currency, the load error on a 500 (and NOT the
  empty line), and the query string carrying both dates plus
  `tz_offset_minutes`.
- `StatsPage.test.tsx`: the widget appears with `aito:read` and not without.

## Open decisions, resolved

| Question | Decision |
|---|---|
| Content | All four blocks |
| Where rules run | Server, one endpoint, `aito:read` |
| Date range | Conversion, stage days, invoiced total follow the page range; board and outstanding are snapshots |
| Done column | In the board response; omitted from the bar, shown as a chip; no stage-days entry |
| "First event" semantics | Earliest occurred_at per project and kind group, skipping import-time decisions (`detail.cause == "import"`, or within 60 s after `project.created`); an acceptance also considers `project.quote_accepted_at` |
