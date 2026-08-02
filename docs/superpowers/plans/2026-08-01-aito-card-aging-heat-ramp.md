# Aito Card Aging Heat Ramp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the board card timestamp's binary 7-day amber flip with a 7-level age-based heat ramp (gray → gold → amber → orange → red).

**Architecture:** One new pure util module (`frontend/src/utils/aitoAging.ts`) owns level computation and class mapping; `CardView.tsx` swaps its inline `aging` boolean for a call to it. No backend, no i18n, no other surfaces.

**Tech Stack:** TypeScript (strict), Tailwind 4 (complete-literal classes), Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-01-aito-card-aging-heat-ramp-design.md`. Thresholds (inclusive lower bounds, days): `[3, 7, 10, 15, 21, 30]`. Exact classes per level: 0 `text-bambu-gray`, 1 `text-[#d9c26b]`, 2 `text-amber-400`, 3 `text-orange-400`, 4 `text-orange-500`, 5 `text-[#f75c4c]`, 6 `text-red-500 font-medium`.
- Exemptions → always `text-bambu-gray`: `project.status !== 'active'`, `column === 'done'`, `created === null`.
- Every Tailwind class a complete literal (no interpolation of fragments).
- TDD: failing test first (RED shown), then implement (GREEN).
- Run everything from the project root; frontend verification is `cd frontend && npm run build` plus targeted vitest.
- Work on a feature branch off `main` (e.g. `aito-aging-heat-ramp`), created before Task 1.

---

### Task 1: `aitoAging` util

**Files:**
- Create: `frontend/src/utils/aitoAging.ts`
- Test: `frontend/src/__tests__/utils/aitoAging.test.ts` (the `utils/` test dir already exists — `aitoSummary.test.ts` lives there)

**Interfaces:**
- Consumes: nothing project-specific.
- Produces (Task 2 imports both by name):
  - `agingLevel(ageMs: number): 0 | 1 | 2 | 3 | 4 | 5 | 6`
  - `agingTextCls(project: { status: string; column: string }, created: Date | null, now?: number): string`

- [ ] **Step 1: Create the branch and write the failing test**

```bash
git checkout -b aito-aging-heat-ramp main
```

`frontend/src/__tests__/utils/aitoAging.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { agingLevel, agingTextCls } from '../../utils/aitoAging';

const DAY = 86_400_000;

describe('agingLevel', () => {
  it('maps the spec boundaries to their levels', () => {
    expect(agingLevel(0)).toBe(0);
    expect(agingLevel(2.9 * DAY)).toBe(0);
    expect(agingLevel(3 * DAY)).toBe(1);
    expect(agingLevel(6.9 * DAY)).toBe(1);
    expect(agingLevel(7 * DAY)).toBe(2);
    expect(agingLevel(10 * DAY)).toBe(3);
    expect(agingLevel(15 * DAY)).toBe(4);
    expect(agingLevel(21 * DAY)).toBe(5);
    expect(agingLevel(29.9 * DAY)).toBe(5);
    expect(agingLevel(30 * DAY)).toBe(6);
    expect(agingLevel(365 * DAY)).toBe(6);
  });
});

describe('agingTextCls', () => {
  const now = Date.parse('2026-08-01T12:00:00Z');
  const live = { status: 'active', column: 'devis' };
  const at = (days: number) => new Date(now - days * DAY);

  it('walks the heat ramp on a live card', () => {
    expect(agingTextCls(live, at(1), now)).toBe('text-bambu-gray');
    expect(agingTextCls(live, at(4), now)).toBe('text-[#d9c26b]');
    expect(agingTextCls(live, at(8), now)).toBe('text-amber-400');
    expect(agingTextCls(live, at(12), now)).toBe('text-orange-400');
    expect(agingTextCls(live, at(17), now)).toBe('text-orange-500');
    expect(agingTextCls(live, at(24), now)).toBe('text-[#f75c4c]');
    expect(agingTextCls(live, at(38), now)).toBe('text-red-500 font-medium');
  });

  it('stays gray for done, deleted, and unparseable cards regardless of age', () => {
    expect(agingTextCls({ status: 'active', column: 'done' }, at(38), now)).toBe('text-bambu-gray');
    expect(agingTextCls({ status: 'deleted', column: 'devis' }, at(38), now)).toBe('text-bambu-gray');
    expect(agingTextCls(live, null, now)).toBe('text-bambu-gray');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/utils/aitoAging.test.ts; cd ..`
Expected: FAIL — module `../../utils/aitoAging` not found.

- [ ] **Step 3: Implement `frontend/src/utils/aitoAging.ts`**

```typescript
/** Age-based heat ramp for the board card's elapsed-time label.
 *
 *  Spec: docs/superpowers/specs/2026-08-01-aito-card-aging-heat-ramp-design.md.
 *  The older a LIVE project, the hotter the label — gray is calm, amber is
 *  aging, red is act-now, matching the app's existing warning language. Done
 *  and trashed cards are exempt: a finished or discarded job is not late.
 */

const DAY_MS = 86_400_000;

/** Inclusive lower bounds, in days, for levels 1..6. */
const THRESHOLD_DAYS = [3, 7, 10, 15, 21, 30] as const;

export type AgingLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** One COMPLETE class string per level — Tailwind cannot see fragments.
 *  Level 6 adds weight: the final alarm is typographic, not animated. */
const LEVEL_CLS: Record<AgingLevel, string> = {
  0: 'text-bambu-gray',
  1: 'text-[#d9c26b]',
  2: 'text-amber-400',
  3: 'text-orange-400',
  4: 'text-orange-500',
  5: 'text-[#f75c4c]',
  6: 'text-red-500 font-medium',
};

export function agingLevel(ageMs: number): AgingLevel {
  let level: AgingLevel = 0;
  THRESHOLD_DAYS.forEach((days, index) => {
    if (ageMs >= days * DAY_MS) level = (index + 1) as AgingLevel;
  });
  return level;
}

/** The timestamp's text class for one card. Exempt cards (not active, done
 *  column, unparseable date) stay calm gray whatever their age. */
export function agingTextCls(
  project: { status: string; column: string },
  created: Date | null,
  now: number = Date.now(),
): string {
  if (project.status !== 'active' || project.column === 'done' || created === null) {
    return LEVEL_CLS[0];
  }
  return LEVEL_CLS[agingLevel(now - created.getTime())];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/__tests__/utils/aitoAging.test.ts; cd ..`
Expected: PASS (2 files' worth: 3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/aitoAging.ts frontend/src/__tests__/utils/aitoAging.test.ts
git commit -m "feat(aito): agingLevel/agingTextCls heat-ramp util"
```

---

### Task 2: Wire `CardView` to the ramp

**Files:**
- Modify: `frontend/src/components/aito/CardView.tsx:186-194` (the `AGING_DAYS`/`aging` block) and the timestamp `<span>` (~line 271, `data-testid="aito-card-elapsed"`)
- Modify: `frontend/src/__tests__/components/AitoCardView.test.tsx:449-468` (the three aging-guard tests)

**Interfaces:**
- Consumes: `agingTextCls(project, created)` from Task 1 (2-arg call — `now` defaults inside).
- Produces: no new exports; the card's timestamp class is now exactly `agingTextCls`'s return plus the existing `text-xs flex-shrink-0`.

- [ ] **Step 1: Update the guard tests first (RED)**

In `AitoCardView.test.tsx`, replace the three tests at lines 449–468 with (keep the surrounding `renderCard` helper usage identical):

```tsx
  it('walks the timestamp through the heat ramp with age', () => {
    const at = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    renderCard({ created_at: at(1) });
    expect(screen.getAllByTestId('aito-card-elapsed')[0].className).toContain('text-bambu-gray');
    renderCard({ created_at: at(4) });
    expect(screen.getAllByTestId('aito-card-elapsed')[1].className).toContain('text-[#d9c26b]');
    renderCard({ created_at: at(8) });
    expect(screen.getAllByTestId('aito-card-elapsed')[2].className).toContain('text-amber-400');
    renderCard({ created_at: at(12) });
    expect(screen.getAllByTestId('aito-card-elapsed')[3].className).toContain('text-orange-400');
    renderCard({ created_at: at(38) });
    const oldest = screen.getAllByTestId('aito-card-elapsed')[4];
    expect(oldest.className).toContain('text-red-500');
    expect(oldest.className).toContain('font-medium');
  });

  it('keeps the timestamp gray on done and deleted cards, even if aged', () => {
    const old = new Date(Date.now() - 38 * 86_400_000).toISOString();
    renderCard({ created_at: old, column: 'done' });
    expect(screen.getAllByTestId('aito-card-elapsed')[0].className).toContain('text-bambu-gray');
    renderCard({ created_at: old, status: 'deleted' });
    expect(screen.getAllByTestId('aito-card-elapsed')[1].className).toContain('text-bambu-gray');
  });
```

(The old 10-day test asserted `text-amber-400`; 10 days is now level 3 `text-orange-400` — that behavior change is the point of the feature. The old "fresh at 5 days stays white" case is superseded: 5 days is now level 1 gold.)

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd frontend && npx vitest run src/__tests__/components/AitoCardView.test.tsx; cd ..`
Expected: FAIL — 1-day card renders `text-bambu-gray` (passes) but the 4-day card still renders gray, not `text-[#d9c26b]`, and 38-day renders amber, not red.

- [ ] **Step 3: Implement in `CardView.tsx`**

Add the import (with the other `../../utils/` imports):

```tsx
import { agingTextCls } from '../../utils/aitoAging';
```

Delete lines 186–194 (the comment block, `AGING_DAYS`, and `aging`). At the timestamp `<span>` (~line 271), replace:

```tsx
            className={`text-xs flex-shrink-0 ${aging ? 'text-amber-400' : 'text-bambu-gray'}`}
```

with:

```tsx
            className={`text-xs flex-shrink-0 ${agingTextCls(project, created)}`}
```

Keep the comment above the span that explains why the aging fact belongs on the timestamp (adjust its wording from "amber past a week" to "heat ramp with age — see utils/aitoAging").

- [ ] **Step 4: Run tests and build**

Run: `cd frontend && npx vitest run src/__tests__/components/AitoCardView.test.tsx src/__tests__/utils/aitoAging.test.ts && npm run build; cd ..`
Expected: PASS + clean build.

- [ ] **Step 5: Full frontend suite, then commit**

Run: `./test_frontend.sh` (from root). Known pre-existing flake: `PrintModal.test.tsx` may fail in parallel runs — rerun that file in isolation before treating as failure.

```bash
git add frontend/src/components/aito/CardView.tsx frontend/src/__tests__/components/AitoCardView.test.tsx
git commit -m "feat(aito): card timestamp walks the aging heat ramp"
```

---

## Plan Self-Review (completed)

- **Spec coverage:** levels/classes/thresholds → Task 1; card wiring + exemptions kept + tooltip untouched → Task 2; test updates incl. the 10-day amber→orange change → Task 2 Step 1. Out-of-scope items introduce no tasks.
- **Placeholders:** none — full code in every step.
- **Type consistency:** `agingLevel(ageMs)` / `agingTextCls(project, created, now?)` identical in Task 1 (definition), Task 1 tests, and Task 2 usage.
