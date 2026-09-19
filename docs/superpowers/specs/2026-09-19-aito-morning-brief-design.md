# Aito statistics view as a morning brief — design

**Date:** 2026-09-19
**Status:** approved in chat (direction A of two mockups; list rows open the card)
**Replaces the layout of:** `2026-09-19-aito-statistics-sections-design.md` (blocks unchanged, arrangement changed)

## Goal

The statistics view was too long and too flat: every block a card of the same weight, and the answer to "what do I do this morning" nowhere on screen. It becomes a brief: a sentence that answers the morning question, three short lists that are the work, one band of period figures, the activity chart, and the four analysis sections folded shut.

## Layout, top to bottom

1. **Date line** — « Friday 19 September · 17 in production » (`Intl.DateTimeFormat` long weekday/day/month, plus the existing `aito.inProduction` key).
2. **Sentence** — 28 px semibold, composed with `Trans` from three fragments so each language keeps its own grammar: chase (amber), tell (plain), collect (red, an amount). Zero forms per fragment; when all three are empty the sentence is the all-clear line.
3. **Sub line** — deliveries due within 7 days or past due (from `due_date` on unfinished cards), and projects completed in the period with the change against the previous period.
4. **Three lists** — Chase · Tell · Collect. Each row is a `<button>`: client name, first line of the description, the wait in days (late days for Collect), the amount (quote total, or invoice balance for Collect). Longest wait first, capped at 5 with an « and N more » line. Clicking a row returns to the board and opens that card.
   - Chase = `quoteOut` ∪ `linkExpiring` buckets.
   - Tell = `notTold` ∪ `notCollected` (the latter shows « Ready for pickup » instead of the description).
   - Collect = `unpaid`.
   All from `utils/aitoFollowups.followups()` over the board query, passed down by the page together with its clock, so an optimistic write moves a row in the same render.
5. **Figures band** — one row, hairlines above and below: added (with delta), accepted (with win rate), completed, quote-to-delivery (with delta), accepted quotes total. Replaces the six tiles.
6. **Activity chart** — unchanged.
7. **Four accordions** — native `<details>`, closed by default, summary = section name + a one-line teaser from the data (sales: acceptance and lost; time: lead time and backward moves; money: accepted and outstanding; clients: new and returning). Opening plays the page's `rise` on the body. The jump strip is removed.

The page toolbar is unchanged (way back + timeframe). The hold-previous, tile ticks and tooltip timings stay; the KPI cascade moves to the band's figures.

## Data

No backend change. The page passes `projects`, `buckets`, `now`, `today` and `onOpenCard` to `StatsView`. Due dates use `dueDateDays` from `utils/aitoAging`.

## Testing

- `Briefing`: sentence counts and zero forms, all-clear line, list membership and order, cap with « and N more », row click calls `onOpenCard`, due/finished sub line.
- `StatsView`: band figures, accordions closed by default with teasers, opening reveals the section content.
- `AitoPage`: a brief row click leaves the statistics view and opens the card's dialog.
- Frontend suite, parity, build, headless capture.
