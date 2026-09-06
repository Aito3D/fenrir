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

`GET /api/v1/aito/stats?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD`

- Gated on `Permission.AITO_READ` (the calculator insights precedent:
  aggregates are computed server-side so an Aito reader needs nothing else).
- Both dates optional; absent means unbounded on that side. `date_to` is
  inclusive (the range ends at `date_to 23:59:59`). A `date_from` after
  `date_to` is a 422. Dates are interpreted as naive UTC calendar days,
  matching every `occurred_at` on the row.
- Implemented in `services/aito_stats.py`, one entry point
  `compute(db, date_from: date | None, date_to: date | None) -> AitoStatsResponse`.

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
- **Stage days**: order each project's `stage.changed` events by
  `occurred_at`; each event closes a stay in `changes[0].from` that began at
  the previous `stage.changed` event's `occurred_at`, or at the project's
  `created_at` for the first. A stay counts toward the period if its closing
  event falls in the range. `median_days` is the median of stay lengths in
  days (float, one decimal is the widget's job), `sample` the count. Stays
  in `done` are never produced (nothing leaves Done except a restore, which
  is not a stage), so `stage_days` lists the six columns before Done.
- **Invoicing**: `invoiced_total`/`invoiced_count` over active projects with
  `quote_invoiced` true whose first `quote.accepted` falls in the range;
  `outstanding_*` over all active invoiced projects with
  `invoice_balance > 0` (snapshot, dates ignored).

### Cost

Five small queries: the active project rows (board totals and invoicing are
summed in Python from them), three `MIN(occurred_at) GROUP BY project_id`
queries (sent/emailed, accepted, declined) restricted to those projects, and
one ordered scan of `stage.changed` events for them (the stay maths runs in
Python over that ordered list). SQLite handles the board sizes in question
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
(every count 0): one line, `stats.aitoPipelineEmpty`. Error: the dashboard's
standard error slot.

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
- Route: 422 on inverted range, permission is `aito:read` (static-closure
  test), absent dates allowed.

Frontend:
- `PipelineWidget.test.tsx`: renders all four sections from a fixture, the
  rate text, `—` for a null rate and a zero sample, the empty state, money
  formatting with the app currency.
- `StatsPage.test.tsx`: the widget appears with `aito:read` and not without.

## Open decisions, resolved

| Question | Decision |
|---|---|
| Content | All four blocks |
| Where rules run | Server, one endpoint, `aito:read` |
| Date range | Conversion, stage days, invoiced total follow the page range; board and outstanding are snapshots |
| Done column | In the board response; omitted from the bar, shown as a chip; no stage-days entry |
| "First event" semantics | MIN(occurred_at) per project and kind group |
