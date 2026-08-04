# Aito Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every actionable finding from the 2026-08-04 eight-agent Aito area review: one CI-flake root cause, one latent correctness trap, missing drag-failure tests, and the agreed refactors/dedupes.

**Architecture:** No behavior changes anywhere except new backend field validation. Frontend work is extraction (page logic → hooks), dedupe (shared helpers), and test hardening. Every task keeps the area's heavy-rationale comment style intact — move comments with the code they explain.

**Tech Stack:** React 19 + TypeScript (Vitest, fake timers, MSW), FastAPI + Pydantic.

**Review source:** the eight-agent /code-review synthesis in-session; file:line references below were verified by those reviewers.

## Global Constraints

- No user-visible behavior changes (except Task 6's backend validation, which only rejects input the frontend already refuses).
- Preserve rationale comments verbatim when moving code; a comment explains the code next to it, so it moves with that code.
- Frontend tests: `cd frontend && npx vitest run <files>`; full gates at the end, not per edit.
- Known flakes: PrintModal tests flake under parallel load — retry in isolation before treating as real.
- Deliberately out of scope (decided at plan time): consolidating the hand-copied `makeProject` fixtures across test files (their own comments call the copies deliberate), the `ProjectDetailPanel.tsx` file split, and the Tailwind pill-class maps (both labeled opportunistic-only in the review).

---

### Task 1: Correctness pair — `aitoSummary` service derivation + shared `rowKey`

**Files:**
- Modify: `frontend/src/utils/aitoSummary.ts` (drop local `ServiceId` + `enabledServices`, derive from `aitoBoardRules`)
- Modify: `frontend/src/utils/taskDraft.ts` (add exported `rowKey`)
- Modify: `frontend/src/components/aito/TaskEditor.tsx:30-32` (import `rowKey`, delete local copy)
- Modify: `frontend/src/components/aito/NewProjectDrawer.tsx:38-43` (import `rowKey`, delete local copy and the "mirrors byte for byte" comment — replace with a short note that the shared helper is the invariant now)

**Interfaces:**
- Consumes: `SERVICES` and `taskCost(task, service)` from `frontend/src/utils/aitoBoardRules.ts` (`taskCost` returns `null` when the service is not priced on the task — the review confirmed `SERVICES.filter(s => taskCost(task, s) !== null)` reproduces `enabledServices`).
- Produces: `export function rowKey(task: TaskDraft): string` in `taskDraft.ts` returning the existing `persisted:${id}` / `draft:${uid}` format — both consumers must call this one.

- [ ] **Step 1:** In `aitoSummary.ts`, replace the local `ServiceId` union and `enabledServices()` with imports from `aitoBoardRules.ts`; keep the module's output (titles/signatures/fallback text) byte-identical. If the local type was exported and used elsewhere, re-export the canonical `ServiceId` from `aitoBoardRules` instead.
- [ ] **Step 2:** Move `rowKey` into `utils/taskDraft.ts` (exact body from `TaskEditor.tsx:30-32`), import it in both components, delete both local copies.
- [ ] **Step 3:** Run covering tests: `cd frontend && npx vitest run src/__tests__/utils src/__tests__/components/TaskEditor.test.tsx src/__tests__/components/NewProjectDrawer.test.tsx src/__tests__/components/AiSummaryPanel.test.tsx 2>/dev/null || npx vitest run src/__tests__` (fall back to the full unit dir only if the targeted paths don't all exist). Expected: PASS.
- [ ] **Step 4:** Commit: `refactor(aito): derive summary services from board rules, share rowKey helper`

### Task 2: Test hygiene — kill the flake mechanism + two anti-patterns

**Files:**
- Modify: `frontend/src/__tests__/hooks/useProjectTasksOptimistic.test.tsx:207-226` (`holdDelete` → fake timers)
- Modify: `frontend/src/__tests__/components/AitoQuoteStatusActions.test.tsx:187-226` (delete the self-described superseded test)
- Modify: `frontend/src/__tests__/pages/AitoPageClientSync.test.tsx:163,196` (replace sleep-then-assert-absence)

**Interfaces:**
- Consumes: the fake-timer hold pattern from `frontend/src/__tests__/components/ProjectDetailPanel.test.tsx:767-778` (`vi.useFakeTimers({ shouldAdvanceTime: true })` + `vi.advanceTimersByTimeAsync(1000)`) — copy that exact pattern.
- Produces: nothing; test-only.

- [ ] **Step 1:** Rewrite `holdDelete` to the fake-timer pattern; ensure setup/teardown (`vi.useRealTimers()`) matches how ProjectDetailPanel.test.tsx scopes it. Update the helper's comment — it may now truthfully say it mirrors that file.
- [ ] **Step 2:** Delete the redundant test block at `AitoQuoteStatusActions.test.tsx:187-226` (the one whose comment says "Superseded by the two 'offers only Mark as sent' tests below").
- [ ] **Step 3:** In `AitoPageClientSync.test.tsx`, replace each `await new Promise(r => setTimeout(r, 100)); expect(X).not.toHaveBeenCalled()` with an assertion keyed off something already awaited nearby (e.g. after `await waitFor(...)` on the positive signal that the same interaction produced, assert the negative). Do not simply shorten the sleep.
- [ ] **Step 4:** Run each modified file 3× to check determinism: `cd frontend && for i in 1 2 3; do npx vitest run src/__tests__/hooks/useProjectTasksOptimistic.test.tsx src/__tests__/components/AitoQuoteStatusActions.test.tsx src/__tests__/pages/AitoPageClientSync.test.tsx || break; done`. Expected: PASS ×3.
- [ ] **Step 5:** Commit: `test(aito): deterministic hold-delete timers, drop redundant + sleep-based assertions`

### Task 3: New tests — drag rollback and drag cancel

**Files:**
- Modify: `frontend/src/__tests__/pages/AitoPageDragLock.test.tsx` (or a new sibling file `AitoBoardDragFailure.test.tsx` if the harness there doesn't fit — implementer's call, keep the existing harness patterns)
- Read for context: `frontend/src/hooks/useBoardDrag.ts` (rollback at :108-113, snapshot mechanics, `onDragCancel` handling)

**Interfaces:**
- Consumes: the drag-test harness pattern (`CapturedHandlers`) used by existing drag tests; MSW or `vi.spyOn(api, ...)` per the file's existing convention.
- Produces: two behavior tests —
  1. a move whose PATCH fails restores the pre-drag board snapshot (cards return to original columns/positions in the rendered DOM or query cache) and shows the failure toast;
  2. `onDragCancel` (Escape mid-drag) restores the pre-drag state without issuing any PATCH.

- [ ] **Step 1:** Read the existing drag test harness; extend `CapturedHandlers` to capture `onDragCancel` if missing.
- [ ] **Step 2:** Write the failed-move rollback test (mock the move endpoint to 500). Assert on outcomes (board state + toast), not internals.
- [ ] **Step 3:** Write the drag-cancel test (fire `onDragCancel`, assert no move request was made and the board matches the pre-drag snapshot).
- [ ] **Step 4:** Run: `cd frontend && npx vitest run <the file(s) touched>`. Expected: PASS, and the new tests FAIL if you temporarily break the rollback (sanity-check once by inverting the mock, then restore).
- [ ] **Step 5:** Commit: `test(aito): cover drag rollback on failed move and Escape cancel`

### Task 4: Slim AitoPage — extract quote poll + page mutations into hooks

**Files:**
- Create: `frontend/src/hooks/useQuotePendingPoll.ts`
- Create: `frontend/src/hooks/useAitoPageMutations.ts` (create/import/delete + `syncClientToZoho`)
- Modify: `frontend/src/pages/AitoPage.tsx` (remove the extracted blocks, call the hooks)

**Interfaces:**
- Consumes: `useOptimisticBoardMutation`/`useBoardSync` exactly as the inline code does today; the poll constants `QUOTE_POLL_INTERVAL_MS`/`QUOTE_POLL_MAX_MS` move with the poll hook.
- Produces:
  - `useQuotePendingPoll(boardSync)` → returns the `refetchInterval` callback to pass to the board `useQuery` (same signature the inline closure has today; the two refs move inside the hook).
  - `useAitoPageMutations({...})` → returns `{ createProject, importQuote, deleteProject }` (or three separate hooks if the shapes don't share setup — implementer judgment, but ONE consistent style) with the exact same optimistic/placeholder/toast behavior. Move the rationale comments with the code.

- [ ] **Step 1:** Extract the poll logic (`AitoPage.tsx:49-131` region: constants, two refs, `refetchInterval` closure) into `useQuotePendingPoll`, preserving comments verbatim.
- [ ] **Step 2:** Extract `createMutation`/`importMutation`/`deleteMutation` + `syncClientToZoho` (`:189-304` region) into `useAitoPageMutations`, preserving comments and exact behavior (including where modals close — the "closed here, not in onSuccess" comments explain ordering that must not change).
- [ ] **Step 3:** AitoPage.tsx should now be orchestration + render (~450-480 lines). No JSX changes.
- [ ] **Step 4:** Run: `cd frontend && npx vitest run src/__tests__/pages/ src/__tests__/components/AitoBoardColumnDrag.test.tsx && npx tsc -b --noEmit`. Expected: PASS — these page tests exercise create/import/delete/poll through the page, so green means behavior survived the move.
- [ ] **Step 5:** Commit: `refactor(aito): extract quote poll and page mutations into hooks`

### Task 5: Shared helpers — currency, dialog dismiss, small dedupes

**Files:**
- Create: `frontend/src/hooks/useCurrency.ts`
- Create: `frontend/src/hooks/useDismissableDialog.ts`
- Modify: the 8 currency call sites (`NewProjectDrawer.tsx:161`, `ImportQuoteDrawer.tsx:83`, `TaskEditor.tsx:99`, `TaskRow.tsx:92`, `TaskStepFields.tsx:139`, `TaskStepList.tsx:45`, `ImpressionFields.tsx:85`, `ProjectDetailPanel.tsx:522`)
- Modify: the 3 dismiss-triad sites (`ImportQuoteDrawer.tsx:104-127`, `NewProjectDrawer.tsx:192-222`, `ProjectDetailPanel.tsx:563-588`)
- Modify: `frontend/src/utils/aitoSearch.ts` + `DoneGrid.tsx:75-85` + `TrashGrid.tsx:108-118` (shared `sortByRecencyDesc`)
- Modify: `frontend/src/utils/aitoOptimistic.ts:61-65,205-209` (shared `rankBySourceColumn`)
- Modify: `frontend/src/components/aito/CardView.tsx:240-252` (icon ternary → `const ClientIcon = ...`)
- Modify: `frontend/src/pages/AitoPage.tsx:530` (one-line "why" comment on `MeasuringStrategy.Always`: live cross-column relocation changes droppable rects mid-drag, so drag-start-only measuring breaks collision detection)

**Interfaces:**
- Produces:
  - `useCurrency(): string` — wraps the settings query (`queryKey: ['settings']`, `staleTime: 60_000`) and returns `settings?.currency || 'USD'`. React Query dedupes by key, so 8 consumers still share one fetch.
  - `useDismissableDialog(onClose, { animationMs? })` — returns what the three sites need (e.g. `{ closing, requestClose, dialogRef }`): Escape-to-close listener with cleanup, focus-on-mount (use the guarded `contains(document.activeElement)` variant — it's the drift-safe one), and the deferred-unmount closing state when `animationMs` is given. Where a site's behavior genuinely differs, parameterize; do NOT change observable behavior to force sharing.
  - `sortByRecencyDesc(projects, query)` in `aitoSearch.ts` (exact body from DoneGrid incl. the tie-break comment).
  - `rankBySourceColumn(projects, excludeId, column): Map<number, number>` in `aitoOptimistic.ts`, called from both `relocate` and `applyColumnMove`.

- [ ] **Step 1:** `useCurrency` + migrate 8 call sites (comments collapse into the hook).
- [ ] **Step 2:** `useDismissableDialog` + migrate 3 sites. This is the riskiest step of the task — diff each site's current behavior first (NewProjectDrawer focuses unconditionally; ImportQuoteDrawer guards; ProjectDetailPanel has its own animation timing) and preserve each site's observable behavior exactly, standardizing only the internals.
- [ ] **Step 3:** `sortByRecencyDesc` + `rankBySourceColumn` dedupes; CardView icon ternary; MeasuringStrategy comment.
- [ ] **Step 4:** Run: `cd frontend && npx vitest run src/__tests__/components/ src/__tests__/utils 2>/dev/null || npx vitest run src/__tests__ && npx tsc -b --noEmit`. Expected: PASS (drawer/panel tests cover Escape/focus/close behavior).
- [ ] **Step 5:** Commit: `refactor(aito): shared currency + dialog-dismiss hooks, dedupe sort/rank helpers`

### Task 6: Backend — validation parity for Aito project schemas

**Files:**
- Modify: `backend/app/schemas/aito.py:59-68,106-109` (`AitoProjectCreate`, `AitoProjectUpdate`)
- Reference: `backend/app/api/routes/zoho.py:127-159` (`ZohoContactCreate`'s `max_length` + `_check_email`/`_check_phone` validators — mirror this bar)
- Test: `backend/tests/` — find the existing aito route/schema test module and extend it

**Interfaces:**
- Produces: `client_email` validated (same check as Zoho's `_check_email`, empty/None allowed), `client_phone` validated likewise, `max_length` caps on `client_name`/`client_email`/`client_phone` matching the Zoho schema's caps, and a generous cap on `description` (e.g. 10_000) so pathological payloads can't balloon rows/AI prompts. All optional fields stay optional; existing valid data must still pass (additive constraints only — pick caps at least as large as anything the frontend allows).

- [ ] **Step 1:** Read `ZohoContactCreate` and copy its validator approach onto the two Aito schemas (shared helpers if the file layout allows without circular imports).
- [ ] **Step 2:** Add/extend backend tests: one accepted payload at the caps, one rejected over-cap description, one rejected malformed email — using the existing test file's fixtures/style.
- [ ] **Step 3:** Run: `./venv/bin/python3 -m pytest backend/tests/ -k "aito" -v` from project root (fall back to the specific test file). Expected: PASS including new tests.
- [ ] **Step 4:** Ruff: `ruff check backend/ && ruff format --check backend/`. Expected: clean.
- [ ] **Step 5:** Commit: `feat(aito): server-side validation parity for project client fields and description`

### Task 7: Full verification

- [ ] **Step 1:** `./test_frontend.sh` from project root (retry known flakes in isolation). Expected: green modulo known flakes.
- [ ] **Step 2:** `./venv/bin/python3 -m pytest backend/tests/ -n 30` . Expected: PASS.
- [ ] **Step 3:** `cd frontend && npm run build`. Expected: clean. Then rebuild + commit static: `git add -f static && git commit -m "chore: rebuild static frontend bundle"`.
- [ ] **Step 4:** Quick smoke in the running dev app (Aito page loads, create drawer opens/closes with Escape, done/trash views sort correctly).
