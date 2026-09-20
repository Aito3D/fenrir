# Aito statistics view — strip and screens

**Date:** 2026-09-19
**Status:** approved in chat (direction D of four mockups, then the seven refinements)
**Replaces the layout of:** `2026-09-19-aito-morning-brief-design.md` (the data blocks of `2026-09-19-aito-statistics-sections-design.md` are unchanged)

## Goal

Two ideas on one screen, in the order the morning goes: the board first, the period second. Above a hairline, today: the board drawn as a strip with the to-dos hanging under the stage their cards sit in. Below it, the period: a segmented control with one question per screen, each led by a sentence that states the finding, then the one chart that proves it and the facts beside it.

## Today (above the line, range-independent, from the board list)

1. **Day line** — « Friday 19 September · 17 in production » left; the to-do fragments right (« 2 quotes to chase · 2 clients to tell · 54 600 F to collect », zero fragments omitted, chase amber, collect red) plus « N deliveries due this week » when any.
2. **Money line + bar** — « 196 600 F on the board » (sum of `quote_total` over active, non-Done cards) and « the one waiting longest: Romain Pahuiri, 57 d in Printing » (max age via `ageAnchor`). One stacked bar in the six stage colours, segment ∝ money per stage; segments carry a title.
3. **Six stage cells** (`COLUMNS`, never Done): dot + name, count, amount (« no quote yet » when the count is > 0 and the money is 0), « oldest N d ». Only the cell holding the board's longest wait is amber. Done is not a stage; its period figure is the Overview's « completed ».
4. **Hang row** — the same six columns. Chase under Waiting, Collect under Printing, Tell under Finish. Each list: heading with dot and count (Collect: the amount), then cards that are buttons (name, chevron, wait in the tone colour, amount, first line of the description or « Ready for pickup »). Longest wait first, capped at 5 with « and N more ». Clicking opens the card (back to the board).
5. **Clear day** — all three lists empty: the hang row is one dashed line, « Nothing to chase, no one to tell, nothing to collect. » plus the due line when any.

Lists come from the page's follow-up `buckets` exactly as the brief did (`quoteOut` ∪ `linkExpiring`, `notTold` ∪ `notCollected`, `unpaid`).

## Period (below the line)

**Header**: the timeframe selector (moved here from the page toolbar; the toolbar keeps only the way back), the range as « 22 June – 19 September » from `date_from`/`date_to`, and a segmented control: Overview · Sales · Time · Money · Clients. WAI-ARIA tabs with arrow keys; the selected screen is remembered in `sessionStorage`. A range change keeps the previous numbers dimmed (`keepPreviousData` + `aria-busy`) as today.

Each screen: **finding** (24 px semibold, a lead clause in white and a muted second clause), then a two-column split (chart 2fr, facts 1fr; stacked under 900 px). No cards: hairline rows and block headings on the page ground.

| Screen | Finding rule | Chart | Facts |
|---|---|---|---|
| Overview | « {created} projects came in, {accepted} were accepted and {done} delivered. » + busiest week/day when anything happened | ActivityChart (unchanged) | added (delta), accepted + win rate (delta), completed (delta), quote to delivery + median (delta), accepted quotes |
| Sales | « You win {pct} % of quotes. » + lost clause; the « big ones » clause when the top size band holds the most declines; « No quotes were decided » otherwise | decisions per week/day (stacked accepted/declined) | sent, accepted, declined, completed (% of accepted), waiting 15+ days (snapshot, amber); win rate by ticket size rows below |
| Time | « A project takes {days} from quote to delivery. » + slowest stage + rework clause; « No project was delivered » otherwise | time per completed project (stacked rows) | median days in each stage (journey bar), quote to delivery + median, acceptance to delivery, backward moves |
| Money | « {accepted} accepted and {invoiced} invoiced. » + outstanding clause with overdue count and oldest; « Nothing is outstanding » otherwise | service mix rows + overdue invoices as of today | accepted quotes, invoiced, outstanding (red), lost with declined quotes, shipping billed |
| Clients | « {new} new clients and {returning} returning. » + peak arrival day/hour + parcels to the islands | arrivals heat grid | new (total), returning (total, share), islands, pickup |

Deltas use `previous` when present (`computeDelta` / `DeltaBadge`).

## Motion

- Board ⇄ strip: the existing `aito-view` scene change gets six more named groups, `aito-col-<column>`, on the board column headers and the strip cells, so the columns fold into the strip and unfold on the way back.
- Tabs: the incoming screen plays `rise`; the sentence swaps in place.
- Strip counts and Overview figures keep the value tick keyed on the value.

## Not done

No backend change. The « SMS sent » chip from the mockup is dropped: the app records « told », not how. Accordions, the jump strip and the figures band are removed.

## Testing

- `TodayStrip`: cells count/money/oldest with the amber max, the money bar segments, list membership/order/cap, row click, clear line.
- `StatsView`: tabs switch screens and remember the choice, Overview figures with deltas, each screen's finding and chart, hold-previous on range change, empty and error states, older-backend degradation.
- `AitoPage`: the timeframe selector lives in the view; a hang row returns to the board and opens the card.
- Frontend suite, i18n parity, build, headless capture.
