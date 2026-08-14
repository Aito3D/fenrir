# Aito — Impression 3D block, C4 layout

**Date:** 2026-08-14
**Component:** `frontend/src/components/aito/ImpressionFields.tsx`, `TaskStepFields.tsx`

## Problem

The `Impression 3D` block of the task editor wastes most of its width and is
the tallest block in the form. Three separate causes:

1. **A viewport-driven split inside a narrow column.** The calculator area
   uses `lg:grid-cols-2`, which keys off the *viewport*, not the block. In
   `ProjectDetailPanel` the tasks column is ~780px wide (three-column grid:
   `20rem | 1fr | 26rem`), so at any desktop width the block splits itself
   into two ~370px halves. The right half holds the cost breakdown — and is
   **empty whenever a price cannot be computed** (no printer selected, or an
   imported task that carries a cost but no print parameters). That empty half
   is the hole in the reported screenshot.
2. **A gutter for one button.** The calculator toggle occupies a fixed
   `w-6 + px-3` cell on the first row, and an `aria-hidden` spacer mirrors its
   metrics on the second — ~54px of width lost on two rows to align two rows
   under a single icon.
3. **Stacked labels everywhere.** Eight fields × (24px label + 42px input).
   `Print time` compounds it: it spans the full `sm:grid-cols-2` row but its
   three segments only fill half of it.

## Chosen layout — "C4"

Selected from five mocked variants (`printing-block-demo-c.html`) after a
first round of three broader directions. One grid, no inner cards, a
full-width price band in the footer.

```
┌─ Impression 3D ─────────────────────────────────────────────────┐
│ Matériau    [PLA Basic  ▾] │ Unitaire   [9000] F                │
│ Couleur     [NOIR       ]  │ Quantité   [1] pièce(s)            │
│ Imprimante  [X1 Carbon  ▾] │ Remise     [—  ▾]                  │
│ Poids       [100] g        │ Note       [+ Note pour le devis]  │
│ Temps       [0 j][5 h][0 m]│ Calculé    8 750 F  [Appliquer]    │
├─────────────────────────────────────────────────────────────────┤
│ ▇▇▇▇▇▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁                          9 000 F     │
│ Filament · Amort. · Énergie · Provisions · Pub · Marge  Total   │
│ ▸ Détail du coût                                                │
└─────────────────────────────────────────────────────────────────┘
```

### Grid

A single CSS grid holds both label/field pairs, so rows align across the
whole block:

- Wide (block ≥ 640px): `minmax(0,auto) minmax(0,1fr) 1px minmax(0,auto) minmax(0,1fr)`.
  Column 3 is a 1px divider element spanning all five rows.
- Narrow (< 640px): `minmax(0,auto) minmax(0,1fr)`; the divider is hidden and
  the right-column rows fall below the left ones. Labels stay *beside* their
  field at every width.

Breakpoints are **container queries on the block**, not `lg:` — the whole
point is to respond to the ~780px column rather than the window. Right-column
rows are `grid-column: span 2` + `grid-cols-subgrid`, so their label and field
land in the parent's columns 4 and 5 (and in columns 1 and 2 when narrow).

### Footer band

Spans all columns. Left: `CostSplitBar` + `SegmentLegend`, both reused
verbatim from `components/calculator/shared.tsx` (already used by
`CalculatorTotalsCard`). Right: the line total — unit × quantity, minus
discount — which is the figure the quote will carry.

That total is computed by `TaskStepFields` (it owns `impressionCost` and the
discount) and arrives as a new `lineTotal: number | null` prop; `null` renders
no amount, matching today's rule that an absent cost is not a zero cost. The
standalone `Total impression` row currently rendered by `TaskStepFields` under
`ImpressionFields` is removed — the band replaces it, and the total must not
appear twice.

Segments are built locally in this block over `total_ttc` and include a
`marge` segment, because in a quoting context the useful reading is "of the
8 750 F charged, 1 200 is filament and 6 400 is margin". This deliberately
differs from `CalculatorPage`'s segment list, which splits `total_cost` and
carries labor and base-fee segments that `computeImpressionCost` does not
produce. No shared helper is extracted for two different semantics.

When no price can be computed, the left side of the band carries one line of
guidance ("renseignez imprimante, poids et temps…") instead of the bar. The
band therefore always has content in both halves — the failure mode that
produced the original empty column cannot recur.

### The 7-line breakdown

Kept, in a collapsed `<details>` under the band. The bar's per-segment amount
and percentage live in its `title` tooltip, but the exact figures stay
auditable without leaving the panel.

### Description / note

The always-mounted textarea becomes a dashed `+ Note pour le devis` button
that reveals it, and renders already-expanded when `impressionDescription` is
non-empty. **Impression only** — Scan, Modélisation and Usinage keep their
always-visible textarea, and `StepDescriptionInput` itself is unchanged.

The button occupies the right column's fourth row, which is what keeps the two
columns at five rows each and leaves no half-empty row. The revealed textarea
does *not* go in that cell: it renders full-width below the band, where a
two-row textarea has room.

Both halves stay owned by `TaskStepFields` — it holds the `noteOpen` state and
`impressionDescription`. The button reaches the grid as a `noteField` slot row
(same subgrid contract as the other slots) and the textarea is rendered after
`ImpressionFields`, which ends with the band, so "after" and "below the band"
are the same place. No description value or callback is threaded into
`ImpressionFields`.

## Behaviour changes

### The calculator toggle is removed

`calculatorOpen` state, the toggle button, the `aria-hidden` gutter spacer and
the `impression-divider` element all go. Printer, weight and print time are
always on screen.

This reverses the earlier "closed by default, deliberately" decision. The
reason is the stated workflow: roughly half of printing tasks are priced by
the calculator and half by hand, so neither path may sit behind a disclosure.
C4 absorbs the three revealed fields into rows the block already needed, so
they cost no extra height.

The `no printers / no filaments configured` early return keeps its link to
`/calculator`; the message moves into the band's left side, since there is no
longer a toggle to hang it off.

### `Calculé … · Appliquer` (new)

A right-column row showing the computed unit price whenever it differs from
the stored one, with a button that adopts it.

This is **purely additive**. Auto-repricing on a calculator input change stays
exactly as it is today (`handleChange` → `onChange(next, computedCost)`), so
after any calculator edit the two agree and the row shows the figure without a
button. The button appears only after the unit cost is typed by hand, which is
precisely the case where today's UI silently loses the computed alternative.

Divergence is detected by comparing the stored unit cost against
`roundUpTo50(result.total_ttc)` — the same rounding `handleChange` applies —
not against the raw total, or the row would offer to "apply" a value equal to
what is already stored.

No provenance flag is introduced. The comparison *is* the signal, which is why
the previously-removed `hasEdited` flag is not coming back.

Applying needs no new prop either: the button calls the existing
`onChange(value, computedCost)` channel with the draft unchanged and the
computed cost in its stored (already multiplied by quantity) form — which is
exactly what that second argument has always meant. `TaskStepFields` therefore
adopts the price through the same path a calculator edit already uses.

When no price can be computed, the row shows the missing-input hint instead.

## Component boundaries

Unchanged in substance: `TaskStepFields` keeps owning `impressionCost` and its
null-vs-0 rule, the unit↔total conversion, and the discount; `ImpressionFields`
keeps owning the print parameters and the pricing side effect.

Only the **slot contract** changes. `costField` and `discountField` stop being
flex cells and become *fragments* of exactly two nodes — a `<label>` and its
control. `ImpressionFields` wraps each pair in the subgrid row itself, so it
alone owns row placement and the parent never learns the grid exists.
`noteField` joins them under the same contract. The prop docs must be rewritten
accordingly — they currently describe the flex-row contract in detail,
including a warning against wrapping the node, which inverts here: the parent
must *not* wrap the pair, or one element lands where the subgrid expects two.

New props on `ImpressionFields`: `noteField: React.ReactNode`,
`lineTotal: number | null` and `unitCost: number | null` — the last because the
divergence check below needs the stored unit price, which lives in
`TaskStepFields`.

`ImpressionFields` is currently 326 lines and gains the band, the segments and
the note reveal. If it passes ~400 lines, the band (bar + legend + total +
collapsed breakdown) is extracted to a sibling `ImpressionCostBand.tsx`; it
takes a computed result, a currency and a total, and owns no state.

## Tests

Existing sites that pin the old layout, all needing updates:

- `__tests__/components/AitoTaskStepFields.test.tsx` — two
  `getByTestId('impression-top-row')` queries (lines ~86, ~134).
- `__tests__/components/TaskEditor.test.tsx` — a `Calculator` toggle click
  (~174) and two `impression-divider` assertions (~733, ~742).
- `__tests__/components/ProjectDetailPanel.test.tsx` — three `Calculator`
  toggle clicks (~988, ~1015, ~1065).

`impression-top-row` and `impression-divider` are retired. The co-location
contract they encoded is re-pinned as `data-testid="impression-grid"` plus
label queries and DOM-order assertions, not nesting-depth assertions.

New coverage:

- Printer, weight and print time are reachable with no toggle interaction.
- The band renders a total with a hand-typed cost and no printer (the old
  empty-half case), and renders guidance rather than a bar.
- `Appliquer` is absent when computed and stored agree, present when they
  diverge, and adopts the computed unit price when clicked — asserting the
  stored `impressionCost` is `unit × quantity`.
- The note button reveals the textarea, and a task with an existing
  description renders it already expanded.

## i18n

New keys need real translations in all 13 locale files under
`frontend/src/i18n/locales/` — the i18n gate rejects English placeholders.
Reuse existing keys wherever they exist (`aito.serviceUnitCost`,
`aito.quantity`, `aito.discount`, `aito.material`, `aito.color`,
`aito.printer`, `aito.weightG`, `aito.printTime`, `aito.printingTotal`,
`calculator.cost*`, `calculator.durationDays*`). Genuinely new:
computed-price label, apply button, missing-input guidance (band and row
variants), breakdown disclosure label, add-note button.

## Out of scope

- **C5, the collapsed recap row.** Mocked and liked, but it is an addition on
  top of C4 rather than part of it, and it changes how the tasks *list* reads.
  Separate spec.
- Scan, Modélisation, Usinage and Livraison block layouts.
- The Calculator page itself.

## Verification

`cd frontend && npm run build`, then `./test_frontend.sh` from the project
root. Visual check of both mount points — `ProjectDetailPanel`'s tasks column
and `NewProjectDrawer` — at the panel width, the drawer width and a narrow
window, in each case with a computable price and with a hand-typed price and
no printer.
