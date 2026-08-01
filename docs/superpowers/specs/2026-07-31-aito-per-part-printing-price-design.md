# Aito — the printing price is entered per part

**Date:** 2026-07-31
**Status:** approved

## Problem

The Printing step's Cost field holds the total for *all* units. When the
calculator prices a print of 3 parts at 123 each, the field shows 369, and the
quote line reads `rate 123 x qty 3`. Two things are wrong with that for the way
the shop actually quotes:

1. The number the user reasons about — and the one the client reads on the
   quote — is the price of **one part**. The form makes them do the division.
2. Calculator output is an arbitrary figure (123, 155, 1237). Real quotes are
   priced in round numbers.

The quantity itself already reaches the quote correctly:
`aito_quote_export.impression_rate_quantity()` emits
`rate = round(impression_cost / quantity)`, `quantity = impression_quantity`.
Nothing about that changes here — this spec only changes what the user types
and what the calculator writes.

## Decisions

**The stored figure keeps its meaning.** `impression_cost` stays the total for
all units in the DB, the API, the board totals, the quote import and the quote
export. The per-part figure is a *presentation* of it: the field divides on the
way out and multiplies on the way in. The alternative — storing per-unit — would
need a data migration plus matching edits to both rule-engine mirrors, the
importer, the exporter and their contract fixtures, for no behaviour the user
asked for.

**Rounding applies to calculator output only.** Every time the calculator
prices the print, the per-part figure it writes is rounded **up** to the next
multiple of 50 (123 → 150, 155 → 200, 150 → 150). A price typed by hand is
stored exactly as typed, so 175 stays 175 and an imported quote's odd figure is
never rewritten under the user.

**Quantity changes hold the per-part price, not the total.** On a row the
calculator can price this is automatic (it reprices). On a row it cannot — an
imported task with no printer or filament — raising quantity 1 → 3 keeps 450 in
the field and takes the total to 1350. Quoting more of the same part must not
silently cut its price.

## Design

### 1. Conversion helpers — `frontend/src/utils/taskDraft.ts`

```ts
export const IMPRESSION_PRICE_STEP = 50;

/** Up to the next multiple of `step`. 123 -> 150, 155 -> 200, 150 -> 150.
 *  0 stays 0: a step quoted free is a real step, not an absent one. */
export function roundUpToStep(value: number, step = IMPRESSION_PRICE_STEP): number;

/** The stored all-units total, per part. null (service disabled) stays null.
 *  Rounded to cents so an imported total that does not divide evenly
 *  (1240 over 3) renders as 413.33 rather than as float noise. */
export function impressionUnitCost(task: TaskDraft): number | null;

/** The inverse: stores a per-part price as the all-units total, multiplying
 *  by the task's OWN quantity. null clears the service; 0 stays 0 (free). */
export function withImpressionUnitCost(task: TaskDraft, unit: number | null): TaskDraft;
```

Both are pure and unit-tested. `IMPRESSION_PRICE_STEP` is a constant rather than
a setting: one shop, one rounding rule, and a setting no one changes is a
migration and a form field for nothing (YAGNI).

### 2. `ImpressionFields` reports the per-part price

The second argument of `onChange` becomes `computedUnitCost`:

```ts
roundUpToStep(result.total_ttc)
```

`total_ttc` is already the per-unit price — `pricing.ts` defines
`total_ttc_qty = total_ttc * quantity` — so this is a rounding, not a division.
Its existing contract is unchanged in every other respect: still `undefined`
when the reference data has not resolved or the parameter set is incomplete
(which is exactly what an imported task looks like), still delivered in the same
single call as the draft so neither can be built from a stale snapshot.

The breakdown panel keeps its per-unit cost rows untouched — they must go on
summing to `calculator.totalTTC`, which stays the unrounded figure — and gains
one row beneath it:

- **Price per part** (`aito.unitPrice`) — the rounded figure, always shown. This
  is the number in the cost field and the `rate` on the quote.
- The existing `calculator.forQuantity` row becomes rounded x quantity, so it
  equals the stored total and the quote line's amount.

### 3. `TaskStepFields` — the Printing cost input is per part

`CostInput` gains an optional label/placeholder override so the Printing block
can read "Price per part" while the other three keep "Cost". Its `aria-label`
follows, which is what the tests query by.

- Value shown: `impressionUnitCost(task)`.
- Typed edit: stores `unit * task.impression.quantity`, **unrounded**.
- Clearing it still emits `null` — absent, not free. The multiply must not turn
  `null` into `0`.
- On any `ImpressionFields` change:

  ```ts
  const quantityChanged = next.quantity !== task.impression.quantity;
  const unit = computedUnitCost ?? (quantityChanged ? impressionUnitCost(task) : null);
  impressionCost = unit === null ? task.impressionCost : unit * next.quantity;
  ```

  `computedUnitCost` is the calculator's rounded price when it could price;
  otherwise the row's current per-part price is carried onto the new quantity —
  but **only when the quantity is what changed**. Without that guard, editing
  the colour of an imported row whose total does not divide evenly (1240 over 3)
  would silently rewrite it as `413.33 * 3 = 1239.99`. A `null` unit means
  "leave the stored cost alone", which covers both the disabled service
  (`impressionUnitCost` returns `null`) and the untouched-quantity case.
  `next.quantity`, never `task`'s: state has not advanced yet at that point.

`TaskStepFields` is shared, so the new-project modal and the detail panel both
get this with no edit of their own. Read mode (`TaskStepList`), the board card's
step pills and the project total keep showing the line total — that is money on
the quote, and it is unchanged.

### 4. Backend

No change. `impression_rate_quantity()` already emits
`rate = round(total / quantity)`; with totals that are now per-part x quantity
that division is exact, so the line reads `150 x 3`.
`_write_back_rounded_impression()` becomes a no-op for calculator-priced rows
and still guards imported ones.

## Testing

`frontend/src/__tests__/utils/taskDraft.test.ts`
- `roundUpToStep`: 123 → 150, 155 → 200, 150 → 150, 0 → 0, 12.5 → 50.
- `impressionUnitCost`: 450/qty 3 → 150; `null` → `null`; 0 → 0; 1240/qty 3 →
  413.33.

`frontend/src/__tests__/components/AitoTaskStepFields.test.tsx`
- The Printing field shows the per-part price, not the stored total.
- Typing a per-part price stores it multiplied by the quantity, unrounded.
- Clearing the Printing field still emits `null`.
- Changing quantity on a row the calculator cannot price holds the per-part
  price and scales the total.
- Editing a non-quantity print field on such a row leaves the stored cost
  byte-identical (the 1240-over-3 case above).

`frontend/src/__tests__/components/AitoImpressionFields.test.tsx` (new, if the
calculator queries can be mocked cheaply; otherwise these ride in the
`TaskStepFields` test)
- Calculator output is rounded up to the next 50 before it reaches the task.

## i18n

One new key, `aito.unitPrice` ("Price per part"), used by both the input and the
breakdown row, translated in all 13 locales. No English placeholders — the i18n
test gate rejects them.

## Out of scope

- Rounding any of the other three services' costs.
- Making the rounding step configurable.
- Changing what read mode, the board card or the project total display.
