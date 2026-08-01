# Aito: subtask descriptions in the panel, and the hybrid board card

**Date:** 2026-08-01
**Status:** approved via browser demo, ready for an implementation plan
**Demos:** chosen from live mockups (scratchpad `demo/subtask-desc-demo.html`,
`demo/project-card-demo.html`) — panel variant **C (Clamp)**, board card
**A+C Hybrid** with a white, optically centred client-type icon.

## Part 1 — the subtask description in the detail panel

### Problem

Every task carries a `description`, but the panel's read mode never shows it:
it is only visible after opening the pencil's edit form. The one place the
operator reads a task is the one place its brief is hidden.

### Chosen design (variant C — Clamp)

`TaskRow`'s read mode gains a description block between the header row and the
progress bar:

- `line-clamp-2`, `text-[.82rem] text-bambu-gray-light whitespace-pre-wrap
  break-words` — a step quieter than the step list so it reads as context, not
  as another control row.
- A **more/less** toggle beneath it, `text-xs text-bambu-green-light`, rendered
  ONLY when the text actually clamps (measure `scrollHeight >
  clientHeight + 1`, the same +1 tolerance `CardView`'s hover-reveal uses; a
  `ResizeObserver` is overkill — measure on render and on toggle). Click
  toggles the clamp; `aria-expanded` carries the state.
- An empty description renders nothing — the panel's omission rule. No label,
  no toggle, no reserved space.
- Edit mode is untouched: the description field already lives there.

New i18n keys `aito.showMore` / `aito.showLess`, translated in all 13 locales
(the i18n gate rejects EN placeholders).

## Part 2 — the board card (A+C Hybrid)

### What the redesign keeps from today, verbatim

These behaviours are load-bearing and must survive the rework unchanged:

- The drag **grip** as the only drag activator (inert twin on non-board
  surfaces), `dragHandleRef`/`dragHandleProps` API unchanged.
- The single click region + transparent a11y button, with the actions area
  stopping propagation.
- The `actions` slot (mark-sent / mark-done hold buttons), `footerNote`,
  `placeholder` dimming, and the sync-state icons (error triangle, lock) plus
  the *devis en attente* italic.
- The 2-second hover-reveal float of the clamped description (shell holds the
  height; card floats over its neighbours).
- `data-aito-card`, `data-aito-card-id` on the card box and `data-flip-key` on
  the wrapper — the morph, the flight and the reflow all key on these.

### The new anatomy (top to bottom)

1. **Name row** — no header band; the card is one flat surface
   (`bg-bambu-dark-secondary`, `rounded-xl`, existing border/shadow/hover).
   Client-type icon (building/person, `strokeWidth 2.5`) in **white** like the
   name, wrapped in a flex container so it centres optically against the text
   (the sr-only company/person label stays). Then the name (`text-sm
   font-semibold tracking-[-0.01em]`, truncating), then the **elapsed time**
   (`text-xs`), then the grip. The elapsed time turns `text-amber-400` when
   the project is older than **7 days** (`AGING_DAYS = 7`, from `created_at`)
   AND the card is live work — `column !== 'done'` and `status === 'active'` —
   so archived and trashed cards never nag. The `title` tooltip with exact
   created/updated dates stays on it.
2. **Description** — `line-clamp-2` (was 3; the task rows below recover the
   information density). Hover-reveal unclamps it exactly as today.
3. **Task rows** — one row per task, replacing `StepGrid`'s pill grid:
   - task title, truncating, `text-xs text-bambu-gray-light`; empty title
     falls back to `aito.taskFallbackName` ("Task N"), the panel's own rule;
   - micro-segments, fixed width right of the title: one segment per enabled
     service (`h-[.28rem] rounded-full flex-1`), `bg-bambu-dark-tertiary`
     until done, then the service's stage colour — the same mapping
     `TaskStepList.STAGE_DOT` derives (scan teal-400, modelisation violet-400,
     impression orange-400, usinage bambu-green), extracted to a shared
     helper rather than duplicated;
   - a `done/total` count, `text-xs text-bambu-gray tabular-nums`.
   - Accessibility mirrors StepGrid's rule: the row carries an accessible
     name stating title and count ("Support principal — 2/3 steps"); the
     segments are `aria-hidden` decoration.
4. **Footer** — left: `aito.stepsCount` ("3/6 steps") when there are steps,
   or the existing *devis en attente* italic; then quote number and the sync
   icons as today; far right: the `actions` slot, unchanged.
5. **No bottom edge bar.** The per-task segments plus the footer count replace
   `ProjectProgress` on the card. `ProjectProgress` itself stays (the panel
   uses it).

`StepGrid` becomes unused (CardView is its only consumer — verify at
implementation time) and is deleted with its tests, replaced by the new task
rows component (`TaskMiniRows`) and its tests.

### The data gap: task titles on the board

`GET /aito/` ships `task_steps` as `{services, done}` per task — no title. The
hybrid's task rows need one. Additive change, mirrored in three places that
must stay in lockstep:

1. **Backend** — `AitoTaskStepsResponse` gains `title: str` (empty string when
   the task has none); `summariseTasks`' `steps_by_task` carries it through.
2. **Frontend type** — `AitoTaskSteps` gains `title: string`.
3. **Frontend mirror** — `summariseTasks` in `utils/aitoBoardRules.ts` (the
   optimistic mirror) emits the title too, or an optimistic write would strip
   titles from the card until the next refetch. The existing backend↔mirror
   contract test is extended to pin the new field.

A server older than the bundle may omit `title`; the card treats
`undefined`/`''` as "use the fallback name", so the degrade is cosmetic — same
posture as the existing `task_steps ?? []` guard.

### Out of scope, deliberately

- Money on the card — stays off, per the standing decision ("a price is read
  once, deliberately, on the project you have opened").
- B-lane ideas (stage stripe, stamp, strike-through chips) — not chosen.
- The DragOverlay clone and DoneGrid/TrashGrid automatically inherit the new
  card; no separate work.

## Testing

- Panel: clamp renders under the header for a task with a description; no
  block and no toggle for an empty one; toggle appears only when clamped
  (stub `scrollHeight`/`clientHeight`), flips `aria-expanded` and the clamp
  class; existing TaskRow tests untouched.
- Card: task rows render title + count per task with the fallback name;
  segments carry stage colours only for done services; footer shows steps
  count / quote / pending italic; amber elapsed at >7d on an active board card
  and never on done/deleted; grip, actions slot, morph/flight data attributes
  all still present (existing tests keep passing where behaviour is kept).
- Backend: `task_steps[*].title` in the board payload; contract test pins the
  mirror.
- Full suites + build, both sides.
