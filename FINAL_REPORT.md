# Refactor-loop campaign 28 — final report

Projects-as-PDM, fifth pass (same scope text as campaigns 24-27; `scope-brief.md`). Worktree `../bambuddy-refactor`,
branch `auto-refactor-loop`, BASE `refactor-base` = 97619c3e7 (empty setup commit on UPSTREAM 61284b7a6).

## Summary
- **Why the loop ended:** MAX_ITER (12 of 12 iterations run). Survey rounds completed: 1 (round 1 at setup; no RESURVEY
  was reached, OPEN work remained throughout). MAX_ROUNDS 3, BATCH 3, TRIAGE none, MODE auto, COMMIT_STYLE grouped.
- **Iterations:** 12, every verdict PASS (VERDICTS.log). **Commits:** 12 squashed iteration commits + this report.
  **Tags:** loop-1 … loop-12 (loop-12 = dc6ca2cb3).
- **Tasks:** 50 filed, 30 DONE, 18 OPEN, 2 BLOCKED, 0 WONTFIX-AUTO.
- **Diff BASE..loop-12:** 55 files, +2250 / −695 (production files under backend/app + frontend/src excluding tests:
  33 files, +1082 / −624).

## Resurvey rounds
- None ran. Round 1 (setup panel) filed T-358..T-402 plus the c28 seeds T-353..T-357; every later pass still had OPEN work.

## Findings by auditor (plan.py stats, by_source)
| Source | Filed | DONE | OPEN | BLOCKED | WONTFIX-AUTO |
|---|---|---|---|---|---|
| audit-security | 4 | 4 | 0 | 0 | 0 |
| audit-robustness | 7 | 7 | 0 | 0 | 0 |
| audit-cleanliness | 18 | 10 | 7 | 1 | 0 |
| audit-tests | 16 | 5 | 11 | 0 | 0 |
| survey (seeds) | 5 | 4 | 0 | 1 | 0 |

Triaged this campaign: 0 (TRIAGE none; every finding went to PLAN.md). TRIAGE.md holds nothing for this campaign.

## User-approved behavior changes (BASELINE-CHANGELOG.md, 2026-10-16/17)
- **T-358** library.py: Slice/Combine/plates/plate thumbnail/filament requirements/Add to queue resolve project revision
  files through the symlink guard; a revision reached through a symlink answers 404 / "File not found on disk".
- **T-359** GET /queue and GET /queue/{id}: aito_task_id is null for callers without aito:read (every API key).
- **T-360** PUT /aito/tasks/{id}/deliveries needs projects:update (was projects:read).
- **T-361** import-library-files copy_failed reason is the fixed text "could not copy the file" (no server path).
- **T-362** record_and_broadcast: a failing rollback after a failed event write is logged, not raised (no 500).
- **T-363** item rename losing a same-name race → 409 instead of 500.
- **T-364** revision upload / PATCH re-check derived_from after flush → 400 instead of a dangling link.
- **T-366** slicer_name / slicer_version capped at 64 characters.
- **T-367** Re-trancher: a failing rollback after a failed intermediate delete no longer fails a successful job.
- **T-368** files dropped on a section whose item is still uploading show an error toast (new key
  projectsPdm.files.itemBusy, 15 locales; pdm-i18n golden re-recorded).
- **T-370** import-library-files / auto-filing: a failing rollback after an unexpected group error returns the normal result.
- **T-375** _stream_files: a failing cleanup unlink no longer replaces the upload error; earlier files are cleaned up.
- **T-378** inZone / isFileDrag de-exported; **T-379** PRINTABLE_EXTENSIONS de-exported (pdm-frontend-pure golden re-recorded).
- Sanctioned additive export: **T-371** may_auto_file.
- Approved but not reached: **T-380** (ProjectOptionLabel de-export, approved 2026-10-16) is still OPEN.

## Coverage, tests, probes
- Scoped coverage: backend 4057/4131 = 98.21% → 4103/4173 = **98.32%**; frontend 1509/1678 = 89.92% → 1553/1720 = **90.29%**.
- Tests: backend 20732 → 20770 passed (1 skipped); frontend 9113 (+1 failed under setup load, not reproduced) → 9126 passed (1 skipped), 639 files.
- known_broken: none → none. Snapshot probes: 11/11 match (goldens re-recorded only for T-368 pdm-i18n and T-379 pdm-frontend-pure).
- SURFACE.md: +may_auto_file (T-371), +projectsPdm.files.itemBusy (T-368), −inZone −isFileDrag (T-378),
  −PRINTABLE_EXTENSIONS (T-379); every line has a changelog entry.

## Left for humans
- **BLOCKED**
  - T-357 ProjectDetailPage split: BOM section is upstream-owned (maziggy 30537cfa5, db5cb86d3, 929c4c8cd).
  - T-374 `_unlink_old_bytes` dedupe: would change logger / message / exc_info; a byte-identical helper is not worth it.
- **OPEN (18)** — full records in the appendix below:
  - cleanliness: T-380 (approved), T-381..T-386 (component/hook splits, _store_group parameter count);
  - tests: T-392..T-402.
- **Leads for campaign 29** (unverified): `c28-leads.md`, copied to plans/refactor-campaign28/. Highlights:
  - aito_task_id still unredacted on PATCH /queue/{id}, POST /queue/{id}/start and GET /projects/{id}/queue;
  - DeliveriesPicker has no projects:update gate;
  - revision_file_path ValueError on an escaping symlink;
  - undo() rollback at project_files ~:946/:1112/:1461 skips file cleanup when it fails;
  - busy item's own row drop still silent.
- **Post-merge:** run `npm run check:knip` on main (the worktree predates the knip gate).

## Preserved
At the user's request all loop state files were copied to `plans/refactor-campaign28/` in the main checkout:
PLAN.md, BASELINE.md, VERDICTS.log, c28-leads.md, the worker/scope briefs, batch files, raw auditor findings and the
already-filed lists.

## Appendix: OPEN and BLOCKED task records

### T-357 [P3] BLOCKED — ProjectDetailPage is a 1391-line component with 19 useState calls
- files: frontend/src/pages/ProjectDetailPage.tsx · source: survey · reason: BOM section is upstream-owned (maziggy commits 30537cfa5, db5cb86d3, 929c4c8cd; identical in upstream/dev); extracting it would reshape ~330 upstream lines outside the fork's PDM hunks — not doable in scope
- evidence: CARRIED from campaign 27 T-350 (audit-cleanliness). frontend/src/pages/ProjectDetailPage.tsx:214 · `export function ProjectDetailPage() {` begins at line 214 and runs to the end of the 1603-line file. A scripted count finds 19 `useState` calls in it (notes, BOM add and edit fields, confirm modal, edit modal and others). The BOM form alone holds 12 separate state variables (lines 339-351). Much of this page is upstream-owned, so the fork's PDM hunks, not the whole page, should be the target. · fix: extract the BOM section (form, list and the 12 state variables, ideally as one object state or a small reducer) into components/projects/ as its own component. Leave upstream-owned parts alone to avoid merge conflicts. Rendered DOM must stay byte-identical.

### T-374 [P3] BLOCKED — _unlink_old_bytes re-spells project_files._unlink_quietly
- files: backend/app/services/project_filing.py · source: audit-cleanliness · reason: dedupe would change logger/message/exc_info of the cleanup warning (project_files vs project_filing); a byte-identical helper is more awkward than the two 4-line spellings
- evidence: backend/app/services/project_filing.py:209 · project_filing.py:209-214 `for path in paths: try: path.unlink(missing_ok=True) except OSError as exc: logger.warning("Moved %s into a project but couldn't remove the old file: %s", path, exc)`. project_files.py:373-378 `_unlink_quietly` does the same try/unlink/log-and-swallow. rg shows `.unlink(` at project_filing.py:212 and project_files.py:376, 435 and 443. · fix: loop over `project_files._unlink_quietly`, or promote it to a shared helper, and drop the local try/except. Keep the 'moved into a project' wording only if it matters.

### T-380 [P3] OPEN — ProjectOptionLabel is exported but only used inside ProjectCodeChip.tsx
- files: frontend/src/components/projects/ProjectCodeChip.tsx · source: audit-cleanliness · reason: user-approved behavior change
- evidence: frontend/src/components/projects/ProjectCodeChip.tsx:22 · `rg -nw ProjectOptionLabel frontend/src` -> ProjectCodeChip.tsx:22 (definition) and :88 (use). No other importer. · fix: drop the `export` keyword · user-visible change: Removes a module export; no importer exists in the repo.

### T-381 [P3] OPEN — DeliveriesPicker is a ~157-line component body
- files: frontend/src/components/projects/aito/DeliveriesPicker.tsx · source: audit-cleanliness
- evidence: frontend/src/components/projects/aito/DeliveriesPicker.tsx:37 · Measured with a line-count script: function DeliveriesPicker starts at DeliveriesPicker.tsx:37 and runs to the next top-level declaration, 157 lines. It holds a query, state and markup. It is not among the plan's T-353..T-357. · fix: extract the row list and the suggested-latest-approved logic into a child component and a hook

### T-382 [P3] OPEN — ItemRow is a ~152-line component body
- files: frontend/src/components/projects/files/ItemRow.tsx · source: audit-cleanliness
- evidence: frontend/src/components/projects/files/ItemRow.tsx:25 · Measured: ItemRow.tsx:25 `export function ItemRow(...)` spans ~152 lines. It mixes rename state, the drop zone, the header with its expand toggle, and the revision list. · fix: split the header (rename input and actions) into an ItemHeader component

### T-383 [P3] OPEN — useCardDrop is a ~136-line hook
- files: frontend/src/components/projects/aito/CardDropTarget.tsx · source: audit-cleanliness
- evidence: frontend/src/components/projects/aito/CardDropTarget.tsx:24 · Measured: CardDropTarget.tsx:24 `export function useCardDrop({` spans ~136 lines with one useState and one useEffect. It carries the permission checks, the native drag handlers and the drop upload. · fix: extract the drop upload (mutation and toasts) from the drag-state handling

### T-384 [P3] OPEN — useResliceJobs is a ~123-line hook with three useEffect calls
- files: frontend/src/components/projects/reslice/useResliceJobs.ts · source: audit-cleanliness
- evidence: frontend/src/components/projects/reslice/useResliceJobs.ts:34 · Measured: useResliceJobs.ts:34 `export function useResliceJobs(projectId)` spans ~123 lines (3 useEffect). It combines start, poll, finish and unmount cleanup. · fix: pull the poll loop and finish() into helpers, or a second hook

### T-385 [P3] OPEN — ProjectsSettingsCardBody is a ~121-line function
- files: frontend/src/components/projects/filing/ProjectsSettingsCard.tsx · source: audit-cleanliness
- evidence: frontend/src/components/projects/filing/ProjectsSettingsCard.tsx:33 · Measured: ProjectsSettingsCard.tsx:33 `function ProjectsSettingsCardBody()` spans ~121 lines. · fix: split the legacy-migration block from the auto-file setting

### T-386 [P3] OPEN — _store_group takes 10 parameters, and _new_library_row and _add_revision_locked take 9
- files: backend/app/services/project_filing.py · source: audit-cleanliness
- evidence: backend/app/services/project_filing.py:354 · ruff PLR0913 with max-args=7: project_filing.py:354 (10), project_files.py:556 `_new_library_row` (9), project_files.py:915 `_add_revision_locked` (9), project_files.py:752 `add_revision_from_sources` (9), aito_project_links.py:643 `_store_drop_group` (8), aito_project_links.py:490 `record_and_broadcast` (12). `_add_revision_locked` also mixes positional note, derived_from_id and user_id before the `*`. `_store_group` passes both `project` and `project_id`, and both `key` and `name`. · fix: bundle the revision metadata (note, derived_from_id, user_id, pipeline_id, pipeline_name) into one small dataclass, and the group (section, key, name, candidates) into another. Drop the redundant `project_id` parameter, which is `project.id`.

### T-392 [P3] OPEN — Empty file-picker selection for new revision and add files is untested
- files: frontend/src/components/projects/files/ItemRow.tsx · source: audit-tests
- evidence: frontend/src/components/projects/files/ItemRow.tsx:122 · Coverage: `ItemRow.tsx ... 64-66,122-124,133` and RevisionBlock.tsx `...48-150,218-220`. ItemRow.tsx:120-124: `const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) void actions.uploadRevision(item.id, files);`. RevisionBlock.tsx:216-220: `if (files.length) actions.addFiles(item.id, revision.id, files);`. No test fires change with zero files (picker cancelled). ItemRow.tsx:64 `(renaming ?? '')` is also uncovered (the c28 lead is confirmed in the table). · fix: In frontend/src/__tests__/components/projects/files/ProjectFilesPanelActions.test.tsx, fire change on `new-revision-input-<id>` and `add-files-input-<id>` with an empty FileList. Assert no POST is recorded and the input value is reset.

### T-393 [P3] OPEN — TaskProjectRow link-picker close and print-success cache invalidation uncovered
- files: frontend/src/components/projects/aito/TaskProjectRow.tsx · source: audit-tests
- evidence: frontend/src/components/projects/aito/TaskProjectRow.tsx:182 · Coverage: `TaskProjectRow.tsx | 96.49 | 94.64 | 93.1 | 96.22 | 182,235`. Line 182 is `onClose={() => setPicking(false)}` on ProjectLinkPicker. Line 235 is `onSuccess={() => invalidate(orderId, [project.id])}` on the PrintModal ('Links (counts), codes, the order timeline, tree and orders'). · fix: In frontend/src/__tests__/components/projects/aito/TaskProjectRow.test.tsx, add two tests. Open the picker and press Escape or close, and assert it unmounts. Complete a print from the row and assert the project-tree, project-orders and order-timeline queries refetch. Use a request counter on the msw handlers.

### T-394 [P3] OPEN — ProjectsSettingsCard null-code failure label, pending-start disable and default fallbacks untested
- files: frontend/src/components/projects/filing/ProjectsSettingsCard.tsx · source: audit-tests
- evidence: frontend/src/components/projects/filing/ProjectsSettingsCard.tsx:127 · Coverage: `ProjectsSettingsCard.tsx | 100 | 86.48 | 100 | 100 | 66-67,127,141`. Line 141: `{f.code ?? `#${f.project_id}`}`. Line 127: `disabled={startMutation.isPending}` plus the spinner. Lines 64-67: `autoFileMutation.variables ?? true` and `settings?.projects_auto_file_by_code ?? true`. · fix: In frontend/src/__tests__/components/projects/filing/ProjectsSettingsCard.test.tsx, add three cases. A migration status failure with code null shows '#<id>'. A held-open start request disables the start button. A settings payload lacking projects_auto_file_by_code renders the toggle on.

### T-395 [P3] OPEN — Two project tests hand-roll the AuthContext mock instead of fixtures/authPermissions.ts, and the fixture lacks hasAnyPermission
- files: frontend/src/components/projects/aito/ProjectOrdersCard.tsx · source: audit-tests
- evidence: frontend/src/components/projects/aito/ProjectOrdersCard.tsx:1 · ProjectOrdersCard.test.tsx:16-19: `vi.mock('../../../../contexts/AuthContext', async (importOriginal) => { const actual = ...; return { ...actual, useAuth: () => ({ hasPermission: (p) => granted.has(p) }) }; });`. FileManagerMoveToProject.test.tsx:19-30 hand-writes the `useAuth` wrapper with `hasPermission` and `hasAnyPermission`. dropZonePins.test.tsx:12 replaces the whole module: `vi.mock(... () => ({ useAuth: () => ({ hasPermission }) }))`. print/TaskPrinting.test.tsx, print/useOpenOrders.test.tsx and print/PrintFromRevision.test.tsx already use withGrantedPermissions. · fix: Switch ProjectOrdersCard.test.tsx (the granted Set is never null, so the helper behaves the same) and FileManagerMoveToProject.test.tsx to withGrantedPermissions. For the latter, add an optional hasAnyPermission to frontend/src/__tests__/fixtures/authPermissions.ts. Leave dropZonePins.test.tsx as is; it deliberately stubs the whole hook.

### T-396 [P3] OPEN — Zip-download failure test swallows the transport OSError, so its only status assertion may never run
- files: backend/app/api/routes/project_files.py · source: audit-tests
- evidence: backend/app/api/routes/project_files.py:1 · backend/tests/integration/test_project_files_api.py:148-155: `try: response = await async_client.get(.../download); assert response.status_code >= 500 except OSError: pass # the test transport may re-raise instead of answering 500`, then only `assert list(scratch.iterdir()) == []`. If the transport re-raises, the status assertion is skipped and the test checks cleanup alone. · fix: In backend/tests/integration/test_project_files_api.py (around line 148), use `with pytest.raises(OSError)` or an explicit `outcome = 'raised'` or `outcome = response.status_code` variable, and assert the outcome is one of the two. Keep the scratch-empty assertion. Optionally pin the 500 path with an ASGITransport(raise_app_exceptions=False) client.

### T-397 [P3] OPEN — Link-route error test pins the exact rollback call sequence including get_db teardown
- files: backend/app/api/routes/aito_project_links.py · source: audit-tests
- evidence: backend/app/api/routes/aito_project_links.py:1 · backend/tests/integration/test_aito_project_links_api.py:823 `monkeypatch.setattr(AsyncSession, "rollback", spy_rollback)` patches the class for all sessions, and ends with `assert calls == ["op", "rollback", "rollback"]` and the comment '# The route's own rollback, then get_db's teardown rollback'. A zero-behaviour change to session teardown, or any extra session rollback, breaks the test. The same pattern is at :851. · fix: In backend/tests/integration/test_aito_project_links_api.py:823 and :851, assert `calls[0] == 'op'` and `'rollback' in calls[1:]`, plus the 418 status and detail. Better, assert the observable effect that nothing was persisted. Keep the spy; do not remove the status or detail assertions.

### T-398 [P3] OPEN — Lifespan wiring test for the orphan sweep pins source-text order via inspect.getsource
- files: backend/app/services/project_reslice.py · source: audit-tests
- evidence: backend/app/services/project_reslice.py:1 · backend/tests/integration/test_project_reslice.py:918-929: `source = inspect.getsource(lifespan); call = source.index("await sweep_orphan_intermediates("); assert source.index("await init_db()") < call; ... assert "except Exception" in source[call : source.index("\n\n", call)]`. Any reformat or helper extraction in main.py breaks it while behaviour is unchanged. main.py is upstream-owned, so each upstream merge risks a false failure. · fix: In backend/tests/integration/test_project_reslice.py, keep the wiring check but make it AST-based. Alternatively, extract the sweep call into a named startup helper with its own behaviour test: a raising sweep must not stop startup. Do not delete the check. If a production extraction is needed, set behavior_change false and note it is zero-behaviour.

### T-399 [P3] OPEN — Oversized project test files and 95-133 line test functions would benefit from splitting
- files: backend/app/services/project_files.py · source: audit-tests
- evidence: backend/app/services/project_files.py:1 · Measured: backend/tests/unit/test_project_files_service.py 3326 lines (test_reused_row_columns_are_pinned 103 lines at :1717, test_reuse_row_changed_during_copy_is_refused 95 lines at :2698); backend/tests/integration/test_projects_api.py 2597; test_aito_project_links_service.py 1291; test_project_filing_move.py 1148; test_project_reslice.py 930; test_aito_project_links_api.py 929; test_print_trace_queue.py 865; test_project_auto_filing.py 759; test_project_legacy_migration.py 705; test_project_item_delete_race.py 662; test_project_files_api.py 643; test_project_tree.py::test_load_tree_full_payload 133 lines at :199. Frontend: ProjectDetailPageActions.test.tsx 639, ProjectFilesPanelActions.test.tsx 627, ProjectFilesPanel.test.tsx 615 (ProjectsPage.test.tsx 976 is mostly upstream). · fix: In backend/tests/unit/, split test_project_files_service.py by operation (add_revision, remove and delete, rename, fork, cancel-commit) into test_project_files_service_*.py files sharing the same fixtures. Turn the two ~100-line tests into parametrized column tables. Move test_load_tree_full_payload's expected dict into a module constant. Pure moves only; no assertion is removed.

### T-400 [P3] OPEN — Files-panel tests find the destructive confirm button by the bg-red-500 class with a non-null assertion
- files: frontend/src/components/projects/files/RevisionBlock.tsx · source: audit-tests
- evidence: frontend/src/components/projects/files/RevisionBlock.tsx:1 · ProjectFilesPanelActions.test.tsx:81-82: `const dangerButton = (name) => screen.getAllByRole('button', { name }).find((b) => b.className.includes('bg-red-500'))!;`. ProjectFilesPanel.test.tsx:525: `...find((b) => b.className.includes('bg-red-500'))!`. If the class changes or two buttons share the name, `find` returns undefined or the wrong button. The click then throws a TypeError rather than a clear failure, or silently targets the row's own trigger. · fix: Keep the bg-red-500 pin and ADD scoping. Resolve the button inside the confirm dialog first, `within(screen.getByRole('dialog')).getByRole('button', {name})`, then assert `.className` still contains 'bg-red-500'. Add an expect that exactly one button matches before clicking. Do not remove the class assertion.

### T-401 [P3] OPEN — ProjectListPage grid-view test asserts only the table's absence; two grid-card click tests duplicate each other
- files: frontend/src/pages/ProjectListPage.tsx · source: audit-tests
- evidence: frontend/src/pages/ProjectListPage.tsx:97 · ProjectListPage.test.tsx:97-103: `await userEvent.click(screen.getByRole('button', { name: 'Grid view' })); expect(screen.queryByRole('table')).not.toBeInTheDocument();`. That passes on a blank page. :198-204 ('opens the project when a grid card is clicked') and :252-259 ('opens the project when its grid card is clicked') both click the P-0002 card and assert navigation to /projects/2 (one via location, one via a pushState spy). · fix: In frontend/src/__tests__/pages/ProjectListPage.test.tsx, ADD a positive assertion to the :97 test (a grid card button /P-0001/ is present). Fold the two grid-card tests into one that asserts both the pathname and the single pushState call. Do not drop either assertion.

### T-402 [P3] OPEN — useResliceJobs tests use real sleeps (up to 3.2 s) and the post-unmount assertions can pass vacuously
- files: frontend/src/components/projects/reslice/useResliceJobs.ts · source: audit-tests
- evidence: frontend/src/components/projects/reslice/useResliceJobs.ts:1 · useResliceJobs.test.tsx:14 `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));`, :150 `await sleep(POLL_MS * 2 + 200)`, :213 `await new Promise((r) => setTimeout(r, 200)); // the tree resolves after unmount: no throw` followed by `expect(result.current.printNext).toBeNull();`. That reads a stale result from an unmounted hook, so it is null whether or not the hook misbehaved after unmount. The earlier filed finding covered fake timers; the file now uses real timers. · fix: In useResliceJobs.test.tsx, count requests on the msw slice-jobs/:id and tree handlers. After unmount, assert the counts do not grow over a vi.useFakeTimers advance. Replace the printNext assertion with a spy on the toast or onPrint callback. Keep the real-timer polling tests as they are.
