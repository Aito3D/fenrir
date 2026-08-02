# Aito Card Aging Heat Ramp — Design

Date: 2026-08-01
Status: approved (scale chosen from 4 browser propositions; prototype `.superpowers/brainstorm/20682-1785663038/content/aging-color-scales.html`, proposition A)

## Problem

The board card's elapsed-time label ("17 days ago") flips from gray to a flat amber at 7 days (`CardView.tsx:186-194`) — one bit of urgency. The operator wants a gradient: the older a live project, the more urgent it must look.

## Decision

Replace the binary flip with a **7-level heat ramp on the timestamp text only** (no dot, no card border), using the app's existing warning language: gray = calm, amber = aging, red = act now.

### Levels

Age is measured from `project.created_at` (same `parseUTCDate` value the card already computes). Thresholds are inclusive lower bounds, in days:

| level | age | color | Tailwind class (complete literal) |
|---|---|---|---|
| 0 | < 3 d | calm gray | `text-bambu-gray` |
| 1 | ≥ 3 d | muted gold `#d9c26b` | `text-[#d9c26b]` |
| 2 | ≥ 7 d | amber `#fbbf24` | `text-amber-400` |
| 3 | ≥ 10 d | orange `#fb923c` | `text-orange-400` |
| 4 | ≥ 15 d | deep orange `#f97316` | `text-orange-500` |
| 5 | ≥ 21 d | soft red `#f75c4c` | `text-[#f75c4c]` |
| 6 | ≥ 30 d | red + weight | `text-red-500 font-medium` |

Level 6 adds `font-medium` — weight, not animation, carries the final alarm. The ramp raises lightness/saturation monotonically before shifting hue, so urgency remains readable under color-vision deficiency.

### Scope and exemptions (unchanged from today)

- Applies to the board card (`CardView.tsx`) only — not the detail panel, DoneGrid, or TrashGrid.
- Exempt: `project.status !== 'active'` or `column === 'done'` → always `text-bambu-gray`. A finished or discarded job is not late.
- `created_at` unparseable (`created === null`) → `text-bambu-gray`.
- The `title` tooltip (full created/updated dates) and `formatElapsedTime` are untouched.

## Implementation shape

- New pure helper in `frontend/src/utils/aitoAging.ts`:
  - `agingLevel(ageMs: number): 0 | 1 | 2 | 3 | 4 | 5 | 6` — thresholds `[3, 7, 10, 15, 21, 30]` days.
  - `agingTextCls(project: { status: string; column: string }, created: Date | null, now?: number): string` — returns one of the seven complete class strings above (exemptions included). `now` defaults to `Date.now()`; injectable for tests.
- `CardView.tsx`: delete the `AGING_DAYS`/`aging` block; the timestamp `<span>`'s class becomes `` `text-xs flex-shrink-0 ${agingTextCls(project, created)}` ``.

## Testing

- Unit tests for `agingLevel`/`agingTextCls`: boundary days (2.9 → level 0, 3 → 1, 7 → 2, 10 → 3, 15 → 4, 21 → 5, 30 → 6), exemption for done column, non-active status, and null `created`.
- Update the existing CardView aging-guard tests (they pin gray-under-7-days and amber-over-7-days) to the new classes: under 3 days → `text-bambu-gray`, over 7 days → `text-amber-400`, and add one ≥ 30 d case asserting `text-red-500 font-medium`.

## Out of scope

- Any color on the card border/dot; aging on detail panel or grids; configurable thresholds; animations.
