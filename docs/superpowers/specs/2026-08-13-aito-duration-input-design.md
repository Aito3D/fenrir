# Aito duration input — shared segmented control

**Date:** 2026-08-13
**Status:** approved, ready for planning

## Problem

In the Aito project card's expanded Impression 3D calculator — and in the identical
control inside New Project → Printing → calculator — the day/hour/minute inputs
collapse to about 34 px each and clip their own digits. A two-digit minute value is
unreadable; a single `0` is partly cut off.

### Root cause

`frontend/src/components/aito/DurationInput.tsx:43` applies the shared `inputCls` to
each `<input>`. `inputCls` begins with `w-full`. The three inputs sit inside
auto-width flex items (`flex items-center gap-1`), and `w-full` resolved against an
auto-width parent collapses to min-content. The input therefore sizes itself to its
own content rather than to a share of the row.

This is the same failure mode as the earlier `${inputCls} w-28` bug: `inputCls`
carries its own width, so any width the caller adds — or any width the caller
assumes it will inherit — silently loses.

### Two secondary defects, same screens

1. The unit letters (`d`, `h`, `min`) sit outside the input boxes, so the control
   reads as three unrelated fields rather than one value in three parts.
2. The Print time cell occupies one column of a `sm:grid-cols-2` grid, so it is
   half the width of the row and does not line up with Printer / Weight above it.

### Divergence

`CalculatorInputsCard.tsx:77` (`DurationField`) already renders a well-designed
version of this control: one bordered box, three equal segments, units inside, a
single focus ring, and overflow normalization on blur. The Aito copy shares none of
it. The app ships two duration controls that should be one.

## Chosen design

A single segmented field — the calculator page's existing look — extracted into a
shared primitive that both call sites adapt to.

```
┌────────────────────────────────────────────┐
│        0 d │        6 h │        30 min    │
└────────────────────────────────────────────┘
   one border · one focus ring · fills the row
```

Rejected alternatives: three equal boxes with captions underneath (costs a line of
height and gives the group three focus rings); the same field plus a decimal-hours
total chip (eats width in the drawer and adds a string to translate for a number the
operator rarely reconciles).

## Components

### New: `frontend/src/components/SegmentedDuration.tsx`

Top level, beside `NumberField` and `SearchableSelect`, which is where this codebase
keeps shared form primitives. Purely presentational — it performs no arithmetic and
holds no state.

```ts
interface DurationSegment {
  key: string;         // caller's field key, echoed back on change
  value: string;       // rendered verbatim; '' renders the placeholder
  unitLabel: string;   // visible suffix, e.g. 'h'
  ariaLabel: string;   // accessible name, e.g. 'Hours'
}

interface SegmentedDurationProps {
  segments: DurationSegment[];
  onSegmentChange: (key: string, raw: string) => void;
  /** Fired only when focus leaves the whole group, never when tabbing
   *  between its own segments. */
  onGroupBlur?: () => void;
  error?: boolean;
  /** Applied to the first segment's input, so an external <label htmlFor>
   *  still targets something real. */
  firstId?: string;
  /** id of the visible field label; becomes the group's aria-labelledby. */
  groupLabelId?: string;
}
```

Visual contract, lifted from `CalculatorInputsCard.DurationField`:

- outer `div`: `flex items-stretch divide-x rounded-lg border bg-bambu-dark`, with
  `focus-within:ring-2` and the green/error border pair already used there
- each segment: a `<label class="flex flex-1 items-baseline gap-1.5 px-3 py-2
  cursor-text">` wrapping the input and its unit `<span>`, so `flex-1` gives every
  segment an equal share of the row and clicking the unit focuses the input
- input: `w-full min-w-0 bg-transparent text-right tabular-nums no-spinner
  focus:outline-none`, `type="number"`, `inputMode="numeric"`, `min="0"`,
  `placeholder="0"`
- group blur: `onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget))
  onGroupBlur?.() }}`

Accessibility: `role="group"` with `aria-labelledby={groupLabelId}`, and one
`aria-label` per input. Today only the days input has an accessible name (inherited
from the field label); hours and minutes announce as bare spinbuttons.

### Adapter 1: `CalculatorInputsCard.DurationField`

Keeps its own value contract — three free-typed strings (`timeD` / `timeH` /
`timeM`) so the operator can type past a boundary — and keeps `splitDecimalHours`
normalization wired to `onGroupBlur`. It loses roughly thirty lines of markup and
gains nothing else. Rendered DOM stays equivalent, so the calculator page's tests
do not change.

### Adapter 2: `frontend/src/components/aito/DurationInput.tsx`

Keeps `minutes: number | null` and the rule that `null` means "not set" — that rule
is load-bearing, because `ImpressionFields` disables the Impression 3D service on a
null time rather than pricing it at zero. `splitMinutes` / `joinMinutes` stay where
they are in `utils/taskDraft.ts`.

It **gains** normalize-on-blur, which it does not have today: typing `90` into
minutes and tabbing away yields `1 h 30`. Normalization runs through the existing
`joinMinutes` → `splitMinutes` round trip and emits a single `onChange` only when
the split actually differs, so it cannot loop.

Null handling is unchanged: when `minutes === null` every segment renders `''` and
shows its placeholder, and an edit that leaves the total at zero with an emptied
field reports `null` back.

### Call sites: `ImpressionFields.tsx`

The Print time cell gets `sm:col-span-2` so it spans the full width of the
`sm:grid-cols-2` calculator grid and its left edge aligns with Printer above it.

Both screens in the report — the expanded card and New Project → Printing —
render this one component, so this is a single fix, not two.

## Translations

None. All six keys already exist in all thirteen locale files:
`calculator.durationDays` / `durationHours` / `durationMinutes` for the accessible
names, and the matching `*Short` keys for the visible suffixes.

## Testing

- **New unit tests for `SegmentedDuration`**: equal segment widths are a layout
  property and are not asserted; behaviour is. Cover that `onGroupBlur` fires when
  focus leaves the group, that it does *not* fire when focus moves between two of
  its own segments, that each segment exposes its `aria-label`, and that `firstId`
  lands on the first input.
- **Aito `DurationInput`**: normalization on blur (`90` min → `1 h 30`), that
  clearing every segment reports `null` rather than `0`, and that blur with an
  unchanged split emits no `onChange`.
- **Calculator page**: existing tests must pass untouched. That is the regression
  signal for the extraction.
- **One existing test changes.** `frontend/src/__tests__/components/TaskEditor.test.tsx:606`
  queries `getByLabelText(/print time/i)` and relies on the days input inheriting
  the field label's name. Per-segment `aria-label` outranks a `<label htmlFor>`, so
  that query must target the days segment instead. Its comment above, which
  documents the current name-inheritance quirk, is rewritten rather than left
  stale.

## Out of scope

`NumberField`, the quantity stepper, and the cost / quantity / discount row. They
work and they are not what was reported.

## Risk

The `inputCls`-carries-its-own-width trap is the reason this bug exists. The new
primitive never composes `inputCls`; it writes its own classes, so a caller cannot
reintroduce the collapse by adding a width.
