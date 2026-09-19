# Aito statistics view — four sections, ten more blocks

**Date:** 2026-09-19
**Status:** approved in chat (one page, four sections with a jump strip; the ten blocks below as listed)
**Builds on:** `2026-09-19-aito-statistics-view-design.md` (branch `aito-statistics-view`)

## Goal

Grow the statistics view from an overview into the operator's morning read: what to chase, why a job was late, when cash arrives, who the clients are. Ten blocks, all computed from data the app already records. No new event kinds, no new tables.

## Layout

The overview stays on top: caption + timeframe selector, the six KPI tiles, the activity chart. Below it, four sections in this order, each a labelled `<section>` with an `id`:

| id | Heading | Blocks |
|---|---|---|
| `sales` | Sales | funnel (now with declined value), quotes awaiting decision by age, win rate by ticket size |
| `time` | Time | days per stage (existing pills), stage time per completed project, rework |
| `money` | Money | money strip (existing), overdue invoices by age, service mix |
| `clients` | Clients | new vs returning clients, arrivals by weekday and hour, shipping by island |

A **jump strip** sits directly under the timeframe row: four pill buttons (Sales · Time · Money · Clients), `position: sticky; top: 0` inside the view with the page background, that `scrollIntoView({ block: 'start', behavior })` the section (`behavior: 'smooth'` unless `useReducedMotion`). The pill of the section currently under the strip is highlighted via an `IntersectionObserver` (threshold 0.3). On viewports under 640 px the strip scrolls horizontally.

Snapshot blocks (quote age, overdue) say so in a small caption « as of today » so the range selector is not read as applying to them.

## Data — `GET /aito/stats` additions

All additive, all excluding trashed cards. `tz_offset_minutes` bounds "today" and the weekday/hour grid the same way `daily` does.

```
quote_age: [ {bucket: "0-3"|"4-7"|"8-14"|"15+", count: int, total: float} ]
  # SNAPSHOT. Active cards with quote_status == "sent" and quote_sent_at set.
  # age = whole days between quote_sent_at and now (local). Four rows always present.

size_bands: [ {min: float, max: float, accepted: int, declined: int, rate: float|None} ]
  # RANGE. Every card whose first decision (accepted or declined, same moment maps as
  # conversion) falls in the range, with a quote_total. Sorted by quote_total and cut
  # into up to 4 equal-count bands (fewer when < 8 decisions: 1 band per 2 decisions,
  # minimum 1). min/max are the band's actual totals so the client formats money.
  # rate = accepted / (accepted + declined) per band.

overdue: { buckets: [ {bucket: "1-7"|"8-30"|"31+", count: int, balance: float} ], oldest_days: int|None }
  # SNAPSHOT. quote_invoiced, invoice_balance > 0, invoice_due_date < today (local).
  # days = today - due_date.

stage_time: [ {project_id: int, client_name: str|None, description: str, done_at: datetime,
               stages: { devis: float, waiting: float, scan: float, model: float, print: float, finish: float } } ]
  # RANGE. Cards whose first real move into Done (same rule as throughput.done) is in
  # range, newest first, capped at 30. Days per stage from the ordered stage.changed
  # scan: a stay opens at the previous move (or created_at) and closes at the next;
  # creation-time moves skipped; time in Done and any stay after a re-open ignored.
  # `description` is truncated server-side to 60 chars.

rework: { moves: int, cards: int, share: float|None }
  # RANGE. stage.changed in range where COLUMN_ORDER.index(to) < index(from), not
  # creation-time. cards = distinct projects with such a move; share = cards /
  # distinct projects with ANY stage.changed in range (None when that is 0).

services: [ {service: "scan"|"modelisation"|"impression"|"usinage", tasks: int, revenue: float} ]
  # RANGE. Tasks of cards whose first acceptance is in range. A task counts once per
  # service whose net_cost is not None; revenue is that net cost as is (the stored
  # cost is already unit × quantity, net_cost applies the discount) — the same
  # figure summarise() adds into the board total. Four rows always present, in
  # SERVICES order.

clients: { new: int, returning: int, new_total: float, returning_total: float }
  # RANGE. Cards created (project.created moment) in range. Returning = the card's
  # client_id also belongs to an active card with an earlier created_at. Cards
  # with no client_id count as new. Totals are quote_total sums.

arrivals: [[int; 24]; 7]
  # RANGE. project.created moments in range, bucketed by local weekday (Mon = 0)
  # and hour.

islands: [ {island: str|None, count: int, shipping_total: float} ]
  # RANGE. Cards created in range. island None = no shipping (pickup); listed last.
  # shipping_total sums shipping_price. Sorted by count desc.
```

Implementation lives in `aito_stats.py` next to the existing passes; the stage scan already exists in `_stage_days` and is generalised to return per-project stays so both consumers share one pass. `services` calls `aito_board_rules.net_cost`. One extra query for tasks of accepted-in-range cards; everything else reads the event rows already fetched.

## Panel

- **Funnel**: the Accepted step gets a fourth, muted line « lost: {declined count} · {declined total} » from `conversion.declined`.
- **Quotes awaiting decision**: four tiles in a row (2×2 on phone). Count leads, total under it. The 15+ tile turns its count `text-status-error` when > 0. Caption « as of today ».
- **Win rate by ticket size**: horizontal bars, one per band, label « {min} – {max} », bar length = rate, right-aligned « {rate}% · {n} ». Empty → « Not enough decided quotes yet ».
- **Stage time per project**: one horizontal stacked bar per card (max 30), stage colours from `COLUMNS` dots, total days at the right end, client + description at the left (truncate). Sorted by total days desc so the outlier is on top. Hover on a segment shows « {stage} · {days} d ». Empty → the shared empty line.
- **Rework**: one tile: moves, « {cards} cards · {share}% of cards moved ».
- **Overdue**: three tiles (1–7, 8–30, 31+) with count and balance; caption « as of today · oldest {n} d ». All zero → the block says « Nothing overdue » instead of tiles.
- **Service mix**: one full-width stacked bar of revenue share in four colours (validated set below) with a legend « {service} · {tasks} tasks · {revenue} ».
- **Clients**: two tiles new / returning with counts and totals, plus a one-line share « {pct}% of revenue from returning clients ».
- **Arrivals heatmap**: 7 rows × 24 cells, weekday labels from `Intl.DateTimeFormat(lang, {weekday:'short'})`, hour labels every 3 h, five-step green ramp like the Stats page heatmap, cell `title` « {weekday} {hour}h · {n} ».
- **Islands**: rows « {island} · {count} · {shipping_total} », pickup row last, labelled « Pickup ».

Service-mix palette (4 categorical slots on `#1a1a1a`, validate before shipping): scan `#3d86e8`, modelisation `#8b6ff0`, impression `#e07b2f`, usinage `#219653` — order fixed, re-run `validate_palette.js` and snap if it fails.

## i18n

New keys under `aito.stats.*`: sections (sales, time, money, clients), asOfToday, lost, quoteAge, quoteAgeBucket (0-3, 4-7, 8-14, 15+ as `{{from}}–{{to}} d` / `{{from}}+ d`), winRate, winRateEmpty, bandLabel, stageTime, rework, reworkMoves, reworkShare, overdue, overdueOldest, nothingOverdue, serviceMix, serviceTasks, clientsNew, clientsReturning, returningShare, arrivals, islands, pickup. Real translations in all 13 locales.

## Testing

- pytest: each block on fixtures — quote age buckets, band cutting (3, 8 and 20 decisions), overdue buckets and oldest, stage_time stays and cap, rework counting and share, services revenue via net_cost, new/returning classification, arrivals weekday×hour with tz offset, islands ordering with pickup last.
- Vitest: sections render with ids and the jump strip highlights/scrolls; each block from a fixture; the two snapshot captions; empty states; all-zero overdue.
- Suites, build, parity, headless capture as before.

## As built (2026-09-19)

- Service-mix palette is scan `#3d86e8`, modelisation `#c95aa0`, impression `#c26a1c`, usinage `#1f9e8a` (blue, magenta, orange, teal): the only four-slot order that passed the validator with no colour-vision warning.
- The view is split into `components/aito/stats/` (palette, primitives, activity chart, jump strip, four sections); `StatsView.tsx` is the shell.
- Section ids are `aito-stats-{sales,time,money,clients}`; the strip observes them with a `-56px / -55%` root margin so the highlighted pill is the section under the strip, not the one leaving.
- Stage-time bars are sorted longest first and scaled to the longest card; zero-day stages draw no segment.
