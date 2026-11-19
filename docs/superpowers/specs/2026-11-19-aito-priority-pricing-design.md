# Priority pricing (Normal / Priority / Urgent) — design

## Intent

A client who needs an order faster pays for jumping the queue. A three-level
priority control on the calculator and on the Aito new-project drawer raises the
price for Priority and Urgent work, and the surcharge appears on the Zoho quote
as its own line so the client sees what urgency costs and can drop back to
Normal (an upsell, not a hidden price rise).

History: a single "Rush" checkbox with a flat % existed 2026-09-04 → 2026-09-07
(`76e0d8002` removed it). This design replaces it, not restores it: three
levels, a minimum fee, project-level, visible on the quote.

## Goals

- Three levels: `normal` (default, +0), `priority`, `urgent`.
- Surcharge per level: `max(base × pct, min_fee)`; Normal is always 0.
- Calculator: control under quantity; surcharge shows live and as its own
  waterfall step after the minimum-price floor.
- New-project drawer (and the project panel, where the due date is edited):
  control beside the due date; the date pre-selects a level until the user
  touches the control.
- Zoho quote: one extra line "Priority service" / "Urgent service" when the
  level is not Normal.

## Non-goals

- No per-task priority (a per-task minimum fee would charge a 3-task project
  three times).
- No board ordering change by priority (overdue-first ordering stays as is).
- No surcharge on shipping.
- No change to archive estimates (`archivePricing.ts`).

## Anti-goals

- The surcharge must never be silently folded into print prices.
- A date change must never override a level the user picked by hand.
- Old projects and old defaults rows must price exactly as today (level
  `normal`, missing settings → defaults that yield the figures below).

## Algorithm

```
surcharge(level, base) = 0                                   if level = normal
                       = max(base × pct[level] / 100, min_fee[level])  otherwise
```

- Calculator: `base` = the task's HT total after the floor (`total_ht × qty`),
  surcharge added after the floor as `margin_priority` (its own `PricingResult`
  field and waterfall step), then tax applies as for every other line.
- Aito project: `base` = sum of the project's task HT prices (all task kinds,
  shipping excluded) — *my call: urgency speeds up the whole order, not only
  printing*. One surcharge per project.

Settings (new `calculator_defaults` columns, Margin-curve tab, XPF defaults):

| Column | Default |
|---|---|
| `priority_pct` | 15 |
| `priority_min_fee` | 500 |
| `urgent_pct` | 35 |
| `urgent_min_fee` | 1500 |
| `priority_days` | 5 |
| `urgent_days` | 2 |

Worked figures (HT, XPF): floor job 1 400 → 1 900 / 2 900; typical 2 031 →
2 531 / 3 531; big 20 000 → 23 000 / 27 000.

## Date suggestion

Calendar days from today to the due date: `≤ urgent_days` → urgent,
`≤ priority_days` → priority, else (or no date) normal. Applies only while the
control is untouched in this drawer session; once clicked, the date no longer
changes it. Existing projects never get re-suggested on load.

## UI (approved: mockup C + control A)

- Segmented 3-button control (`role="radiogroup"`), colour by level
  (neutral / amber / red), surcharge chip beside it (`+1 500 XPF`).
- Drawer: in the client section next to the due date input; a small "suggested
  from due date" hint while the level is still auto-picked.
- Calculator: under quantity, no date, plain control. The calculator → quote
  page hop carries the level (it is not a session-only field).
- Card: an Urgent/Priority glyph on the board card is left to the builder only
  if trivial; not required.

## Data

- `aito_projects.priority` `VARCHAR(10) NOT NULL DEFAULT 'normal'` (additive
  migration in `run_migrations()`).
- Six `calculator_defaults` columns above (NOT NULL with defaults; add them to
  the DROP list in `test_calculator_zoho_migration.py`).
- Project create/update payloads and responses carry `priority`; board golden
  fixture regenerated.

## Zoho lines (revised 2026-11-19, after the first build)

**No separate item or line.** The user rejected the dedicated "Priority /
Urgent service" line: the quote keeps only the items it already uses, and the
surcharge raises their prices.

- Every task service line (scan, modelling, print, machining, labour) has its
  rate multiplied by the same factor `f = 1 + surcharge / base`, where
  `surcharge` and `base` are exactly as in "Algorithm" (base = net task total,
  shipping excluded; surcharge rounded half-up). Pushed rate =
  `round_half_up(cost / qty × f)`. Discounts stay on the line, so the net
  rises by the same factor. Shipping is never scaled. Normal → `f = 1`, the
  push is byte-identical to before.
- Per-line rounding means the Books total may differ from
  `base + surcharge` by a few units. Accepted.
- The card keeps its un-surcharged task prices: the post-push rounding
  write-back stores the rounding of the UN-scaled rate, never the scaled one.
- Pull (Books → card) compares Books against the scaled rates the card would
  push; a rate edited in Books is read back into the task divided by `f`.
- Import cannot tell a raised price from a normal one: an imported quote
  comes in at level Normal with the prices as they are in Books.
- Removed from the first build: the two Books items and their settings keys,
  `PriorityCatalogueUnavailable`, recognising/stripping a priority line on
  import and pull, the discount rule for that line, the preview's
  `priority` / `priority_amount`, and the import drawer adding it to its total.
- Recomputed on every push, invoiced lock, pending-after-pull: unchanged.

## Approaches considered

UI: A segmented control · B true slider · C A beside the due date with
date suggestion. **Picked C.**
Algorithm: 1 flat % · 2 % with minimum fee · 3 per displaced machine-hour.
**Picked 2**: small jobs still pay a meaningful amount, big jobs scale; 1 is
the removed Rush and negligible on small jobs; 3 makes long prints explode.
Visibility: visible Zoho line vs folded into prices. **Picked visible**, then
revised by the user to: existing lines only, all raised by the same % (see
"Zoho lines").

## Calls made after the builder check (author's calls, reviewable)

- **Base is after task discounts**: the surcharge scales with what the client
  actually pays for the work. The priority line itself takes no discount;
  `discount_issues` flags a discount on it exactly like the shipping line.
- **Recomputed on every push** like the other card-built lines; changing the
  level is blocked by the invoiced-task lock (409) like other priced edits.
- **Date suggestion is drawer-only.** The project panel shows the control and
  saves what is clicked; editing a due date there never changes the level. No
  "hand-picked" column.
- **Calculator quote page prints the surcharge as its own line**; the unit
  price stays the print price (total before surcharge ÷ quantity).
- **Minimum fee is tax-inclusive in Aito** (ruling during the build): every
  Aito price is what the client pays (TTC), so `max(base × pct, min_fee)`
  yields a TTC line there; in the calculator the same figure is HT. A
  min-fee-bound job is therefore ~13 % cheaper in Aito than the calculator
  shows for a 13 %-tax client.
- **Aito task prices never include it**: `computeImpressionCost` passes
  `normal`; the project line is the only surcharge.

## Left to the builder

- Catalogue item creation/claim mechanics (follow the shipping / Main d'oeuvre
  pattern), i18n keys in all 16 locales, rounding of the surcharge to the
  currency's decimals (`moneyDecimals`), story event on priority change
  (follow `project.due.set`), whether the project panel shows the control in
  the masthead or the details tab.
