# Elapsed time in the Aito project detail panel

**Date:** 2026-08-04
**Status:** approved (design)
**Demo:** `docs/superpowers/demos/aito-panel-elapsed/index.html` — variants A–E with a live age slider; variant **C** was chosen.

## Problem

The board card shows how long a project has been running: `formatElapsedTime()` in the name row, tinted
by the 7-level heat ramp in `utils/aitoAging.ts` (`CardView.tsx:261-267`). Click the card and that fact
vanishes. `ProjectDetailPanel` — the surface where the work is actually done — shows only absolute dates,
buried in the third card of the left rail (`RecordCard`, `ProjectDetailPanel.tsx:432-440`).

So the one signal that says *act on this now* is present on the 260px card and absent from the 1200px panel
it morphs into.

## Solution

Give age a first-class slot in the panel header, beside the money cluster, and echo it in the Record card
where the exact dates already live.

**Money is how much, age is how long.** Those are the two facts that decide whether a project is opened
today, so they get equal billing and parallel structure in the masthead's right side.

### Rejected alternatives

| | Why not |
|---|---|
| **A** — chip in the eyebrow row | A bordered pill reads as *a status you can act on*; age is not one. The tinted background also mutes the ramp exactly where it must shout — red on a red wash is calmer than red on the band. |
| **B** — companion in the contact row | That row is the *copyable* values (`CopyableValue`, click-to-copy). A third item that does nothing on click breaks the row's one promise. |
| **D** — heat hairline down the masthead | A second signal doing the first one's job, and at level 0 it is a meaningless grey stripe. Explicitly out of scope. |
| **E** — Record card only | Correct information architecture, wrong outcome: the ramp exists to be caught peripherally, and a scrolling rail's third card is where you don't catch it. Kept *as well as* C, not instead. |

## Design

### 1. One anchor, one source of truth

The card already switches which timestamp it measures from: `quote_accepted_at` once the quote is accepted,
`created_at` otherwise (2026-08-02 age-from-acceptance spec). That logic is currently inline in `CardView`
and would have to be duplicated in the panel — two copies that can drift, on two surfaces the browser morphs
between. Extract it instead.

New export in `frontend/src/utils/aitoAging.ts`:

```ts
export type AgeAnchor = 'accepted' | 'created';

export function ageAnchor(project: {
  quote_status: string | null;
  quote_accepted_at: string | null;
  created_at: string;
}): { anchor: AgeAnchor; raw: string | null; at: Date | null }
```

- Returns `accepted` when `quote_status === 'accepted'` **and** `quote_accepted_at` parses.
- Falls back to `created` in every other case: quote not accepted, stamp null (imported already-accepted, or
  pre-migration with no event), stamp unparseable.
- `at` may still be `null` if `created_at` itself is unparseable — callers handle that.

This is a pure refactor of existing behaviour. `CardView` is rewritten to consume it, so the card and the
panel can never disagree mid-view-transition. No behavioural change to the card is intended, and the existing
card tests must keep passing untouched.

### 2. Header age stat

New component `frontend/src/components/aito/PanelAgeStat.tsx`, rendered in `PanelHeader` between a new
`w-px` divider and the existing money divider. It mirrors the money cluster's three-part structure:

```
        ACCEPTED          ← eyebrow, eyebrowCls + text-bambu-gray
    🕐 12 days ago        ← formatElapsedTime(), agingTextCls() colour
       23 Jul 2026        ← text-xs text-bambu-gray, tabular-nums
```

- **Value:** `formatElapsedTime(raw, t)`, coloured by `agingTextCls(project, at)` — the same call the card
  makes, exemptions included (non-`active` status, `done` column, unparseable date → calm grey). A `Clock`
  lucide glyph at `strokeWidth={2.5}`, `aria-hidden`, matching the header's other icon treatment.
- **Eyebrow:** the anchor, named. `aito.ageAnchorAccepted` ("Accepted") or the existing `aito.createdLabel`
  ("Created"). This is the word the card cannot afford and the reason the panel is worth the change: today
  the same "12 days ago" silently measures two different things depending on quote status.
- **Caption:** `at.toLocaleDateString(i18n.language, { dateStyle: 'medium' })`. Omitted entirely when
  `at === null`.
- **Tooltip:** `title` with the full localised date-time, matching the card's `dateTitle` habit.
- **Font weight:** the ramp's level-6 `font-medium` arrives through `agingTextCls`; no separate weight logic.

**Responsive rule.** The header is a flex row that already holds contacts, ring and total. The stat and its
divider are `hidden md:flex`; the absolute-date caption is `hidden lg:block`. Below `md` the client name keeps
the width and the Record card echo carries the age instead. Nothing is lost, only relocated.

### 3. Record card echo

The echo attaches to the row that owns the anchor, so the parenthetical never sits beside a date it isn't
measuring:

- **anchor `created`** — the existing `Created` row gains a heat-tinted `({{days}} d)` after the actor:
  `23/07/26 · admin (12 d)`.
- **anchor `accepted`** — a new `Accepted` row is inserted above `Created`, carrying
  `23/07/26 (12 d)` with the same tint. `Created` keeps its own untinted row.

Compact form only (`aito.ageDaysShort`, `'{{days}} d'`); the rail's rows must stay on one line, which is why
`RecordCard` uses short dates in the first place.

The placeholder is **`{{days}}`, deliberately not `{{count}}`**: i18next treats `count` as the plural
selector and resolves `key_one` / `key_other` instead of the bare key, which would mean plural variants in all
13 locales for an abbreviation that never inflects (compare `time.daysElapsed_one` / `_other`, which does need
them). A non-`count` placeholder keeps this to one flat key.

### 4. i18n

Two new keys under `aito`, added to all 13 locale files (`frontend/src/i18n/locales/*.ts`) with real
translations — the parity gate reads the directory and rejects both missing keys and English placeholders:

| key | en |
|---|---|
| `aito.ageAnchorAccepted` | `Accepted` |
| `aito.ageDaysShort` | `{{days}} d` |

`aito.createdLabel` is reused for the `created` anchor rather than duplicated.

### 5. Out of scope

- No backend change. `quote_status`, `quote_accepted_at`, `created_at`, `status` and `column` are already on
  `AitoProject`.
- No ticking timer. Granularity is calendar days; a value computed at render is correct until midnight, which
  is exactly what the card already does.
- No change to the ramp's thresholds, colours or exemptions.
- D's heat hairline.

## Testing

**`frontend/src/__tests__/utils/aitoAging.test.ts`** — extend:
- `ageAnchor` returns `accepted` for an accepted quote with a parseable stamp.
- Falls back to `created` when the status is not `accepted`, when `quote_accepted_at` is null, and when it is
  unparseable.
- `at` is `null` when `created_at` is unparseable, without throwing.

**`frontend/src/__tests__/components/ProjectDetailPanel.test.tsx`** — extend:
- The header stat renders the elapsed label and the anchor eyebrow, keyed on quote status.
- An accepted project measures from `quote_accepted_at`, not `created_at` (distinct dates, assert the label).
- The value carries the ramp class matching its age, and stays `text-bambu-gray` for a `done`-column project.
- The caption is omitted when the anchor date is unparseable.
- The Record card echo appears on the `Created` row for a created-anchor project, and on a separate
  `Accepted` row for an accepted-anchor one.

New test ids: `panel-age-anchor`, `panel-age-value`, `panel-age-date`, `record-accepted`.

**Regression:** existing `CardView` tests must pass with no edits — that is the proof the `ageAnchor`
extraction changed nothing on the card.

**Suites:** `cd frontend && npm run build`, then `./test_frontend.sh` from the project root.
