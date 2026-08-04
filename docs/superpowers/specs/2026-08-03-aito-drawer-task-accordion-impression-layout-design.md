# Aito New-Project Drawer: Task Accordion + Impression3D Layout

## Problem

With many tasks, the New Project drawer's task list becomes unmanageable —
every task card is always fully expanded. Separately, in the Impression3D
block the Quantity field is buried in the calculator grid while the Cost it
directly drives sits at the top, and nothing separates the cost from the
calculator inputs.

## Design

### 1. Accordion tasks (New Project drawer only)

- `TaskEditor` gains `accordion?: boolean` (default false). Only
  `NewProjectDrawer` passes it; `ProjectDetailPanel` keeps always-open rows —
  its step "Done" ticks must stay one click away (deliberate prior decision,
  see `TaskRow`'s component doc).
- One task open at a time (`openKey: string | null`, keyed by `rowKey`).
  Clicking a task's header toggles it: opening one collapses the others;
  clicking the open one closes it (zero open is allowed).
- `TaskRow` gains `collapsed?: boolean` and `onToggleCollapse?: () => void`.
  When collapsible, the header (chevron + name + steps count + total) becomes
  a disclosure button (`aria-expanded`, accessible name = its own text — no
  new i18n key). Collapsed hides description, progress, and the body
  (form/step list); the body is conditionally rendered, preserving the
  "ImpressionFields' queries only run behind the pencil" property.
- EVERY row folds, unpriced drafts included (rev 2 — the first cut exempted
  stepless rows and left a drawer of unpriced drafts as a wall of forms). A
  dangling `openKey` (open row removed, or hold-to-reset swapping in fresh
  drafts) falls back to opening the first row; a `null` key — the user closed
  the open row on purpose — stays all-collapsed.
- "+ Add task" opens the new task (and thereby collapses the rest).
- The pencil on a collapsed task expands it AND forces edit mode on (never
  toggles edit off from a collapsed state).

### 2. Quantity beside the Impression3D cost — edited as a UNIT price

- `ImpressionFields` gains a required `costField: ReactNode` prop; the parent
  (`TaskStepFields`) still owns the cost input and its null-vs-0 rule, now
  handing it over as a slot (the node IS the row's flex cell) with a visible
  `Unit cost` label (`aito.serviceUnitCost`, translated in all 14 locales).
- The top row is: calculator toggle | unit cost | quantity, in every branch —
  including the no-printers / no-filaments early returns, so cost stays
  editable and quantity visible on unconfigured installs.
- STORED `impressionCost` remains the multiplied TOTAL — the task total, the
  board rules and the quote export/import contract are untouched. Only the
  printing block converts: the input shows `total ÷ quantity` and stores
  `unit × quantity`; a quantity edit rescales the total so the unit price
  holds (unless the calculator repriced, which wins).

### 3. Calculator behind a toggle, divider when open

- The six pricing fields + breakdown are hidden by default behind a
  calculator icon button at the left of the top row (`aria-expanded`,
  labelled with the existing `calculator.title` key). Closed even when the
  parameters are already filled — the collapsed row shows the two figures
  that matter.
- When repricing, the calculator writes the PER-PIECE price rounded UP to the
  next multiple of 50 (`roundUpTo50` in utils/taskDraft.ts: 123→150, 201→250,
  390→400), then multiplies by quantity into the stored total. Hand-typed
  costs are never rounded.
- A `border-t` separator (`data-testid="impression-divider"`) between the
  cost/quantity row and the calculator fields, rendered only while the
  calculator is open on a configured install.

### 4. Color + per-line discount + printing total (rev 3)

- Row two of the printing block (always visible, aligned under cost |
  quantity): the Color input (moved out of the calculator grid) and a
  Discount dropdown (—, 5…30%, step 5).
- The discount is a NEW task field `impression_discount_pct` (Float,
  nullable; additive migration). It is written onto the quote's impression
  line as `discount: "10%"` — the org discounts at item level (verified on
  DEV26-2469, where a hand-set "10.00%" sits per line) — and the import
  adopts it back, so pushes stop wiping hand-set percent discounts. Flat
  (non-percent) discounts are not adopted.
- `impression_cost` stays PRE-discount everywhere; the discount is applied
  by the totals engine (both mirrored `summarise` implementations + contract
  fixture case) so board cards and the drawer receipt say what the quote
  says. A "Printing total" row in the block shows the line's net figure.

## Testing

- TaskEditor accordion: initial open state, click-to-swap, add-task opens the
  new row, pencil-from-collapsed force-opens edit, no toggles when
  `accordion` is absent.
- Impression layout: cost and quantity adjacent, divider present, quantity
  edits still reprice the cost, unconfigured installs still show cost +
  quantity.
- Existing NewProjectDrawer tests adjusted where they assume all tasks stay
  expanded.
