# Margin-curve explorability — design

Date: 2026-08-27. Branch: `worktree-archive-suggested-price-curve`
(the settings-layout commit `4b9c29676` is already on it).

Follow-up to `2026-08-27-hyperbolic-margin-design.md`. The two-curve
margin model is shipped; this spec makes it *legible*: the user can see
what the curves do to a real job, shape them by dragging, read the
formula with their own numbers in it, get warned when a setting makes a
curve degenerate, pick K from the cost of their own prints, and trace an
archive's suggested price back to the multiplier that produced it.

Six features, all additive. No schema change, no new permission, no new
backend endpoint (see §7 for why).

## Shared plumbing

### `unitCost` on the archive estimate (`utils/archivePricing.ts`)

`ArchivePriceEstimate` gains:

```ts
/** Full unit cost the size margin was evaluated at (computePricing total_cost). */
unitCost: number;
/** Size-margin multiplier applied (sizeMargin(unitCost)); qty factor is 1 for archives. */
sizeMargin: number;
/** True when min_task_price lifted the price above the curve. */
floorApplied: boolean;
```

All three are already computed by `computePricing` (`total_cost`,
`size_margin`, `floor_applied`); they are just surfaced. Used by §5 and §7.

### Curve geometry helper (`components/calculator/curveGeometry.ts`, new)

Pure module shared by the preview, the drag handles and the example dot:

```ts
export const sizeDomain = (k: number) => [0, k * 10] as const;   // x-range of the size chart
export const QTY_DOMAIN = [1, 100] as const;
/** Pixel x → unit cost, given the chart's plot-area width. Clamped to domain. */
export function xToUnitCost(px: number, plotWidth: number, k: number): number;
export function xToQuantity(px: number, plotWidth: number): number;
```

Recharts exposes the plot area via `useChartWidth()`/`useOffset()`
(recharts ≥ 3) — we use those inside a custom child component rather
than measuring the DOM ourselves.

## 1. Example job overlay

**What.** Two small inputs above the charts on the Margin curves card —
*Example unit cost* (currency) and *Example quantity* — plus a green dot
on each curve at that point, and a one-line readout:

> `×1.833 size margin · ×0.93 quantity factor → ×1.775 on cost`

**Defaults.** Prefilled from the last calculator job when one is
persisted (`useCalculatorState` exposes the persisted inputs; the unit
cost is `computePricing(...).total_cost` of that job, quantity is the
job's quantity). Falls back to `K` / `1`. Editable in place; the values
are UI state only — never saved, never part of the Save bar's `dirty`.

**Where the state lives.** `MarginCurvePreview` receives
`example: { unitCost: number; quantity: number }` and an `onExampleChange`.
`SettingsForm` owns the state (`useState`, seeded once from the
persisted job via a lazy initialiser). Keeping it above the preview lets
§3 (drag) and §6 (warnings) read the same value.

**Rendering.** A `<ReferenceDot>` on each chart, `r={5}`, green fill,
white 1.5px stroke (recharts 3.5 has no `isFront`; its default z-order
already draws the dot in front). The readout uses the same
`text-[11px] uppercase tracking` style as the strip labels, with the
three multipliers in `tabular-nums`. The dot jumps to its new position
when the curve morphs — recharts does not animate `ReferenceDot`.

**Out of range.** If the example unit cost exceeds the size chart's
domain (`10 K`), the chart's domain extends to `1.1 × unitCost` so the
dot is always visible. Quantity above 100 likewise extends the quantity
domain to `1.1 × q`. Both are clamped at the field bounds
(`0 < unitCost ≤ 1e9`, `1 ≤ q ≤ 1e6`, matching the calculator's own inputs).
The quantity curve is sampled at a fixed count (≤ 200 points spread over
the domain), never one point per unit — otherwise a large example
quantity would build a million-point chart.

## 3. Drag K and KQ on the charts

**What.** The dashed green reference line on each chart becomes a drag
handle: horizontal drag moves it and writes `margin_k` / `qty_k` into
the form (so the Save bar opens, validation runs, curves morph — exactly
as if typed).

**Handle.** A custom recharts child (`<DragHandle x={k} onDrag=…/>`)
renders, on top of the ReferenceLine: an invisible 24px-wide hit strip
the full plot height, and a visible 12×12 rounded grip at the top of
the line (`bg-bambu-green`, ring on hover/focus). Cursor `ew-resize`.
Pointer events via `setPointerCapture` so the drag survives leaving the
SVG. Touch works because pointer events cover it; the 24px strip meets
the touch target minimum.

**Value mapping.** `xToUnitCost` / `xToQuantity` from the geometry
helper. The written value is rounded to a sensible step: K to 3
significant figures (`5000`, `12 300`), KQ to an integer ≥ 1. The form
field updates live on every pointer move (no debounce — the morph
animation is already 350 ms and reads well); the ReferenceLine follows
the *form* value, not the pointer, so what you see is what will be saved.

**Keyboard.** The grip is a `<button type="button">` with
`aria-label` (`calculator.dragK`, `calculator.dragKQ`) and
`aria-valuenow`; ←/→ move by 1 % of the domain, Shift+← / → by 10 %.
Focus ring matches `focusRingCls`.

**Read-only viewers** (`!canUpdate`): the handle renders without the
grip and without pointer handlers — the line is inert, as the fields are.

**Reduced motion.** No new animation is introduced. `MarginCurvePreview`
currently hard-codes `animationDuration={350}`; this spec switches it to
the `prefersReducedMotion()` helper already in `components/calculator/shared.tsx`
(0 ms when reduced), which also covers the example dot and the drag follow.

## 4. Formula popover

**What.** An `ⓘ` icon button next to each chart title. Click/tap toggles
a popover. The app's `Tooltip` is hover/focus-only (aria-describedby), so
this is a small `FormulaPopover` — a `<button aria-expanded>` toggling an
absolutely-positioned panel, closed on Escape and outside click — showing the formula with the *current form
values* substituted:

```
Size margin
m(u) = M_MIN + (M_MAX − M_MIN) · K / (u + K)
     = 1.50 + 0.50 · 5 000 / (u + 5 000)
At u = 12 300 FCFP → ×1.645
```

```
Quantity factor
f(q) = Q_MIN + (1 − Q_MIN) · KQ / (q − 1 + KQ)
     = 0.60 + 0.40 · 20 / (q + 19)
At q = 25 → 0.782
```

The "At …" line uses the §1 example. Rendered in `font-mono text-xs`,
`tabular-nums`. Two i18n keys per chart (formula body, "At {{x}} →
{{y}}"); the symbols themselves are not translated.

## 5. Multiplier in the archive-card tooltip

**What.** `archives.card.suggestedPriceTooltip` becomes:

```
Suggested sale price from the calculator (excludes labor)
Filament: {{filament}}
Printer: {{printer}}
Unit cost {{unitCost}} → ×{{sizeMargin}} size margin
```

plus a final line `Minimum task price applied` when `floorApplied`.
Uses the new fields from *Shared plumbing*. The card view is the only
place the suggested price renders (`ArchivesPage.tsx:1301`); the list
row view has no price and therefore no tooltip. All 13 locales get the
new lines; `ArchivesPage` tests that assert on the tooltip text are
updated.

## 6. Inline sanity warnings

**What.** Amber (not red — these are valid values the backend accepts)
hints under the relevant field, `text-xs text-amber-400`, i18n'd:

| Condition | Field | Key |
|---|---|---|
| `M_MAX === M_MIN` | margin_max_mult | `calculator.warnFlatSize` — "Size curve is flat: every part gets ×{{m}}." |
| `K > 20 × exampleUnitCost` (when an example exists) | margin_k | `calculator.warnKFar` — "K is far above your example cost; the curve barely bends where your jobs are." |
| `K < exampleUnitCost / 20` | margin_k | `calculator.warnKNear` — "K is far below your example cost; every job sits at M_MIN." |
| `Q_MIN === 1` | qty_min_factor | `calculator.warnNoQtyDiscount` — "No quantity discount." |
| `min_task_price > priceAtExample` (example price pre-tax, quantity 1) | min_task_price | `calculator.warnFloorDominates` — "The floor exceeds your example's price; the curves never apply below it." |

Existing hard errors (`M_MAX < M_MIN`, out of range) stay red and keep
blocking Save; warnings never block. `NumberField` gains an optional
`warning?: string` prop rendered in place of `error` when there is no
error (error wins). Pure predicate module `curveWarnings.ts` with unit
tests — the component only maps keys to strings.

## 7. K hint from your own prints

**What.** Under the K field, when data exists:

> Median unit cost of your last {{n}} prints: **{{median}}** — [Use it]

"Use it" writes the median into `margin_k` (rounded to 3 s.f.), through
the normal `setField`, so the Save bar opens.

**Data source — deviation from the answer given during brainstorming.**
The chosen option was a dedicated backend endpoint. During design it
turned out the backend has **no pricing engine**: unit cost requires
matching the archive to a calculator filament/printer profile and
running `computePricing`, both of which live only in the frontend
(`archivePricing.ts`). A backend endpoint would mean porting the engine
and the matcher to Python — two implementations of the price to keep in
sync, the thing the hyperbolic-margin spec explicitly avoided.

The existing `GET /archives/slim` (`archives.py:586`) already returns,
in one query, every field `estimateArchiveSalePrice` needs
(`filament_used_grams`, `print_time_seconds`, `actual_time_seconds`,
`filament_type`, `filament_vendor`, `energy_kwh`, `printer_id`, `status`).
So:

- The Settings tab queries `/archives/slim?date_from=<90 days ago>`
  (React Query, `staleTime` 5 min, `enabled` only when the user has
  `archives:read_all` or `archives:read_own` — the same gate the
  archives page uses). Without that permission the hint is simply absent.
- Filters `status === 'completed'`, takes the most recent 100, maps each
  through `estimateArchiveSalePrice` (printer hint = the printer's name
  via the printers list already loaded on the page), collects `unitCost`,
  and takes the median. Fewer than 5 usable prints → no hint.
- This is a pure function `medianUnitCost(archives, calcConfig, printers)`
  in `utils/archivePricing.ts`, unit-tested.

If the backend later grows a pricing engine, the endpoint can be added
and this becomes a one-line swap. That is the reason to keep the
median computation in its own function.

## Component layout after this spec

```
CalculatorSettingsPanel.tsx
  SettingsForm
    ├─ example state (§1)          useState, seeded from persisted job
    ├─ warnings (§6)               curveWarnings(previewDefaults, example)
    ├─ kHint (§7)                  useQuery(/archives/slim) → medianUnitCost
    └─ <MarginCurvePreview d example onExampleChange onDragK onDragKQ readOnly>
          ├─ ExampleInputs (§1)
          ├─ Curve[size]  → ReferenceLine + DragHandle (§3) + ReferenceDot (§1) + FormulaPopover (§4)
          └─ Curve[qty]   → same
```

New files: `curveGeometry.ts`, `curveWarnings.ts`, `DragHandle.tsx`,
`FormulaPopover.tsx` (all under `components/calculator/`). The
`MarginCurvePreview.tsx` file grows; if it passes ~250 lines the two
`Curve` blocks split into `SizeCurve.tsx` / `QtyCurve.tsx`.

## Testing

- `curveGeometry.test.ts` — px↔value round-trips, clamping, rounding.
- `curveWarnings.test.ts` — each predicate, boundary values, no-example case.
- `archivePricing.test.ts` — `unitCost`/`sizeMargin`/`floorApplied` surfaced; `medianUnitCost` (odd/even counts, <5 → null, non-completed filtered).
- `MarginCurvePreview.test.tsx` — example dot renders at the given coordinates; drag handle: pointerdown/move/up on the strip calls `onDragK` with the mapped value; keyboard arrows step; read-only renders no grip.
- `CalculatorSettingsPanel.test.tsx` — dragging opens the Save bar; "Use it" writes K; warnings appear/disappear as fields change; formula popover text contains substituted values.
- `ArchivesPage.test.tsx` — tooltip contains the multiplier line; floor line only when applied.
- i18n gate: every new key present in all 13 locales.
- Manual: drag on a touch device (iPad Safari), reduced-motion on, 1280px and 1920px widths.

## Out of scope

Presets (#2 from the brainstorm) — separately later. Dragging
M_MIN / M_MAX / Q_MIN. Backend pricing engine.
