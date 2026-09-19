# Aito statistics view — design

**Date:** 2026-09-19
**Status:** approved in chat (default range = the Stats page's timeframe selector; counts lead with a small money strip; active toggles swap to a back arrow)

## Goal

Give the Aito board a third detour, next to Done and Trash: a **Statistics** view about every project the shop has managed. It answers, at a glance, "how much work comes in, how much goes out, and how long it takes" — the questions the Stats page's pipeline widget does not answer because it is money-first and has no time axis.

## Header

- The **Trash** toggle becomes icon-only. Its accessible name and `title` stay `aito.trash`, so screen readers and existing tests still find "Trash".
- A new icon-only **Statistics** toggle (`BarChart3`) sits immediately right of Trash. Accessible name `aito.statistics`.
- Both keep `ViewToggleButton`'s contract: `aria-pressed`, and when active the button shows the back arrow and reads `aito.backToBoard`. Icon-only buttons render the arrow alone (no text) so they never change width. Done keeps its text label and count.
- `ViewToggleButton` grows an `iconOnly?: boolean` prop. When set: no visible text, `aria-label` = inactive label or "Back to board", `title` = the same. The stacked-strut trick is unnecessary for a fixed-size square, so the icon-only branch renders a single icon.

## View state

`view` becomes `'board' | 'done' | 'trash' | 'stats'`. `changeView` already clears the search and closes the card; no other change. The board search stays visible (it filters nothing in the stats view, same as it filters nothing while a card is expanded); the follow-up strip is hidden like it is for Done/Trash. Reads/permissions: the stats view needs only `aito:read` (the same permission as the board), so no new gate.

## Timeframe selector

The Stats page's inline selector (preset dropdown + custom from/to) is extracted, unchanged in behaviour and markup, into `frontend/src/components/stats/TimeframeSelector.tsx`:

- exports `TimeframePreset`, `TimeframeState`, `TIMEFRAME_PRESETS`, `computeDateRange`, `useTimeframe(storageKey, defaultPreset)` (localStorage-persisted state + resolved `{dateFrom, dateTo}`), and the `TimeframeSelector` component (`{ timeframe, onChange }`).
- `StatsPage` uses the new module with its existing storage key `bambusy-stats-timeframe` and default `all-time`. No visual change there.
- The Aito stats view uses storage key `bambuddy-aito-stats-timeframe`, default `last-30`.

## Data — extend `GET /aito/stats`

Additive fields on `AitoStatsResponse` (the Stats page widget ignores them). All figures exclude trashed projects; import-time and creation-time events keep the existing "not a real move / not a real decision" handling via `_first_moments(..., born)` and `_is_creation_time`.

```
throughput: {
  created: int          # first `project.created` in range
  accepted: int         # same definition as conversion.accepted.count
  done: int             # first `stage.changed` with to == "done" in range (creation-time moves skipped)
  per_day: float | None # created / days in range (None for all-time with no projects; days = inclusive calendar days,
                        #   for all-time = days from the earliest project.created to today)
  lead_days: float | None        # MEAN of (done_at - created_at) in days over projects done in range
  lead_days_median: float | None
  production_days: float | None  # MEAN of (done_at - accepted_at) over done-in-range projects that have an acceptance
  active: int           # snapshot: active projects not in `done`
}
previous: {             # same block computed over the preceding window of equal length; None for all-time
  created, accepted, done, lead_days
} | None
daily: [ { day: "YYYY-MM-DD", created: int, accepted: int, done: int } ]  # one row per LOCAL calendar day in range,
                        # zero-filled; for all-time from the earliest event day to today
```

"Done" moment: the project's first `stage.changed` whose `changes[0].to == "done"` after the creation grace. A card later moved out of Done and back keeps its first done moment (a re-open is not a second completion). `quote_accepted_at` participates in `accepted` exactly as it does for `conversion`.

Day bucketing uses `tz_offset_minutes` (already sent by the client): `occurred_at + offset` → local date. Zero-filling happens in Python over the local date range.

Implementation: one new module-level pass in `aito_stats.py` — `_done_moments` (ordered scan like `_first_moments`, filtering on `changes`), `_daily(...)`, `_throughput(...)`, and `previous` by calling `_throughput` again with `(start - span, start - 1µs)`. Two extra queries at most; the event table is small.

## Panel — `frontend/src/components/aito/StatsView.tsx`

Layout (one column, max width like Done/Trash grids; sections separated by 24 px):

1. **Toolbar row**: `TimeframeSelector` right-aligned; left, a one-line caption "N active · M done all time".
2. **KPI tiles** (grid, 2 → 3 → 6 columns): Added, Accepted, Completed, Added per day, Avg lead time (created → done, with median as the secondary line), Production time (accepted → done). Added/Accepted/Completed/lead show a `DeltaBadge` versus `previous` (lower lead time is `good`). Tiles reuse the pipeline widget's `TileShell` look: `bg-bambu-dark`, label `text-xs text-bambu-gray`, value `text-lg font-semibold tabular-nums`.
3. **Daily activity chart** (Recharts `ComposedChart`, height 240): grouped bars for created / accepted / done, plus a 7-day rolling-average line for done. Categorical colours: created `#60a5fa` (blue), accepted `#fbbf24` (amber), done `#22c55e` (bambu green). Dark tooltip via `CHART_TOOLTIP_STYLE`; the day label is the short local date; ticks are thinned to ~8 by Recharts `interval="preserveStartEnd"`. A legend row is rendered by us (not Recharts') so it matches the tile typography. Empty range → the chart area shows `aito.stats.empty` centred instead of an empty grid.
4. **Flow**: the six working stages as pills — "median days per stage" from `stage_days` (already computed), in board order, each with its column dot colour. Below it a compact **funnel** row: quotes sent → accepted → completed as three numbers with the two conversion percentages between them.
5. **Money strip**: quoted-and-accepted total, invoiced total, outstanding balance — three small tiles, `formatMoney` with `useCurrency`. Hidden entirely when every figure is 0.

Loading: the same dimmed skeleton idiom the board uses (a `Loader2` centred is acceptable for v1). Error: `common.errorLoading` + retry.

`AitoStats` in `client.ts` gains the three optional fields (`throughput?`, `previous?`, `daily?`) so an older backend still renders the Stats page widget.

## i18n

New keys under `aito.stats.*` in all 13 locales (title, added, accepted, completed, perDay, leadTime, leadTimeMedian, productionTime, activity, flow, funnel, money, quoted, invoiced, outstanding, empty, rolling7) plus `aito.statistics`. The parity gate rejects EN-identical values, so every locale gets a real translation.

## Testing

- **pytest** (`test_aito_stats.py`): throughput counts and done-moment rule (creation-time move skipped, re-open keeps first moment), lead/production means, daily zero-fill with tz offset, `previous` window alignment, all-time yields `previous = None`.
- **Vitest**: `ViewToggleButton` icon-only accessible names (inactive/active); `AitoPage` — clicking Statistics shows the panel and hides the board, back arrow returns; `StatsView` renders tiles/deltas from a fixture and the empty state; `StatsPage` still passes with the extracted selector.
- `npm run build`, `./test_frontend.sh`, `./test_backend.sh`, i18n parity.

## Out of scope (proposed follow-ups, listed in the final report)

Per-client leaderboard, revenue per printer-hour, forecast of completion dates from the print backlog, CSV export, week/month bucketing toggle, comparison overlay of two ranges.

## As built (2026-09-19)

- Series colours are `#3d86e8` (added), `#c95aa0` (accepted), `#219653` (completed): the only trio that passed the categorical palette validator on the `#1a1a1a` surface with no colour-vision warning. Amber beside green fails the protan check.
- The chart folds days into Monday-start weeks past 45 days (31 on viewports under 640 px); the 7-day rolling line only exists in daily mode. Tooltip items are forced into series order (Recharts 3 sorts by name by default).
- `per_day` is rounded to three decimals server-side so a quiet shop does not read 0.0.
- The stage pills reuse `stage_days`; the funnel is sent → accepted → completed with the two ratios; the money strip is three tiles and hides at zero.
- Headings are sentence-case `text-sm font-semibold`, not the pipeline widget's uppercase eyebrow.
- Verified with the full frontend and backend suites and driven end to end in headless Chrome against a sanitised copy of the live database (the browser extension was not connected).
