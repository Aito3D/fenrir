# Regenerate Description Button — Design

**Date:** 2026-08-04
**Status:** Approved

## Summary

Add a small AI-regenerate button to the "Product description" card in the Aito
project expanded panel (`ProjectDetailPanel`). Clicking it regenerates the
description from the project's tasks using the same OpenRouter process the
creation drawer uses, and saves the result immediately.

## Scope

Frontend-only. The stateless backend endpoint `POST /api/v1/aito/summarize`
(used by `AiSummaryPanel` in `NewProjectDrawer`) already accepts a task list and
returns `{ summary, model }`. The panel already holds the project's live tasks
via `useProjectTasks(project.id)` and can map them with `taskDraftToTaskCreate`.

## UI

- `PanelCard` (in `ProjectDetailPanel.tsx`) gains an optional `action?: ReactNode`
  prop, rendered right-aligned on the title row.
- The Product description card passes a small icon-only button:
  - `RefreshCw` icon, violet accent to match the drawer's `AiSummaryPanel`
    regenerate styling (AI actions are violet across Aito).
  - `title` and `aria-label` = `t('aito.regenerate')` (existing key).
  - Icon spins (`animate-spin`) while generation is pending.

## Behavior (save immediately)

1. Click → mutation calls
   `api.summarizeAitoProject(tasks.map(taskDraftToTaskCreate))`.
2. On success → the summary is saved straight through the existing
   `updateMutation` path (same as a manual edit), reusing the `descState`
   saving → saved indicator and the optimistic board-cache update.
   - If the generated text equals the current description, skip the save and
     flash "saved".
3. On generation failure → toast `t('aito.summaryFallback')`
   ("AI unavailable — write the description yourself"); the description is
   left untouched. Unlike the drawer, `buildFallbackSummary` is never seeded
   here: the panel always has an existing description, and overwriting it with
   the crude fallback would lose information.
4. Save failure is already handled by `updateMutation`'s `onError` toast
   (`aito.saveFailed`) and the `descState` error revert.

## Disabled states

The button is disabled while:
- generation is pending,
- a description save is in flight (`descState === 'saving'`),
- the edit textarea is open (`editingDesc`),
- the project has no tasks (nothing to summarize).

## i18n

No new keys. Reuses `aito.regenerate`, `aito.summaryFallback`, `aito.saveFailed`.

## Testing

Vitest tests on `ProjectDetailPanel`:
- Success: clicking regenerate calls `summarizeAitoProject` with the mapped
  tasks and patches the project with the returned summary.
- Failure: toast shown, no patch sent, description text unchanged.
- Disabled when the project has no tasks.

## Workflow

Implemented on a feature branch in a git worktree, merged back to `main`.
