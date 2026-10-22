# Refactor-loop campaign 29 — final report

Projects-as-PDM, sixth pass (scope-brief.md + its CAMPAIGN 29 ADDENDUM: server slicing, project page rework, source-only
uploads). Worktree `../bambuddy-refactor`, branch `auto-refactor-loop`, BASE `refactor-base` = a40fd3dbd (setup commit
on UPSTREAM 694a037b1 = campaign re-baseline of 8 goldens + SURFACE.md).

## Summary
- **Why the loop ended:** MAX_ITER (12 of 12 iterations). Survey rounds: 1 (setup panel); OPEN work remained throughout,
  so no RESURVEY ran. Params: MAX_ITER 12, MAX_ROUNDS 3, BATCH 3, TRIAGE none, auto, grouped, merge at exit.
- **Verdicts:** 12 iterations, all PASS — iteration 9 failed once (a basedpyright lock-mode error introduced in loop-2 by
  T-421 that earlier verifier briefs did not check), was fixed by a no-behavior type narrowing and re-verified PASS;
  basedpyright lock mode became a standing gate.
- **Commits / tags:** 12 squashed iteration commits + this report; tags loop-1 … loop-12 (loop-12 = 6dec8da53).
- **Tasks:** 56 filed (38 by the panel + 18 carried from campaign 28), 36 DONE, 19 OPEN, 0 BLOCKED, 1 WONTFIX-AUTO
  (T-432, duplicate of T-425 filed by two auditors).
- **Diff BASE..loop-12:** 40 files, +3090 / −927 (production under backend/app + frontend/src excl. tests: 20 files,
  +1406 / −889).
- **User reprioritisation:** for the last two iterations the user chose "approved fixes first" (T-423, T-425, T-426,
  T-445 worked; select's batch T-414..416 deferred, T-414/T-415 then worked in iteration 12).

## Resurvey rounds
- None ran (MAX_ITER reached with OPEN work left).

## Findings by auditor (plan.py stats, by_source)
| Source | Filed | DONE | OPEN | BLOCKED | WONTFIX-AUTO |
|---|---|---|---|---|---|
| audit-security | 6 | 6 | 0 | 0 | 0 |
| audit-robustness | 7 | 5 | 1 | 0 | 1 |
| audit-cleanliness | 14 | 4 | 10 | 0 | 0 |
| audit-tests | 11 | 8 | 3 | 0 | 0 |
| survey (c28 carry) | 18 | 13 | 5 | 0 | 0 |

Triaged this campaign: 0 (TRIAGE none). The tests auditor's first pass was thin (4 findings) and was resumed with a
checklist (+7). Ingest fingerprints did not catch the cross-auditor duplicate T-425/T-432 (different titles).

## User-approved behavior changes (BASELINE-CHANGELOG.md)
All approved 2026-10-19 unless noted; consequences beyond the approval text were put to the user and accepted.
- **T-427** waiting print jobs fail ("slice failed" + reason) when the slice source .3mf is gone, instead of hanging in
  `slicing`. Accepted extras: retry refused until a source exists; other non-derived .3mf jobs of the revision failed too.
- **T-421** retry-slice re-arms only jobs the caller may modify (own unless update_all; printer scope). Accepted: once a
  slice succeeds, the existing success sweep still pends every waiting job on that file (lead).
- **T-422** retry-slice response hides the Aito task fields (incl. board column) without aito:read.
- **T-424** a source .3mf whose settings part (> 8 MB) or unpacked total (> library_max_zip_extract_bytes) exceeds the
  cap fails the slice with a 413 and an explanatory message (zip-bomb guard).
- **T-428** a revision stuck in `slicing` with a dead job is re-claimed on any slice-start path (retry, upload, drop,
  queueing, dispatch, startup); in-process guard dedups a double-clicked Retry.
- **T-429** waiting queue items are written with conditional UPDATEs: a job cancelled/deleted while its slice lands stays
  cancelled/deleted (PostgreSQL race).
- **T-423** GET /projects/{id}/queue hides aito_task_id without aito:read.
- **T-425** a revision file reached through a symlink leaving the data dir reads as missing: 404 on downloads/zip/gcode/
  slicer link, 400 on slice start and queueing, fork skips it, re-slice 404. GAP (accepted, lead): a print already queued
  on such a file still stays pending — print_cost_estimate._source_path (out of scope) raises first.
- **T-426** unexpected slice failures show "Unexpected error while slicing" / "Could not start the slice"; the cause is
  logged server-side (job error detail generic too).
- **T-445** sub-project rows render the shared StatusBadge (colours, translated label, pill shape).
- **T-403** (approved 2026-10-16 in campaign 28) ProjectOptionLabel unexported.
- Additive internal exports (re-baselines): LinkedFoldersPanel, SubProjectsPanel, useProjectLinkedFiles (T-444),
  SliceLine (T-446), StatusBadge (T-445).

## Zero-behavior work (each proven by the worker and independently by the blind verifier)
- Server slicing: T-430 file reads before the write lock (_OutcomeFacts), T-431 at most two project slices at once.
- Splits with byte-identical DOM/trace proofs against the previous tag: T-443 ProjectKpiStrip, T-444 ProjectDetailPage
  panels, T-446 ItemCard (SliceLine, useItemRename), T-404 DeliveriesPicker, T-405 ItemRow (ItemHeader), T-406
  useCardDrop, T-407 useResliceJobs, T-408 ProjectsSettingsCard.
- T-409 grouped parameters of _store_group / _new_library_row / _add_revision_locked.
- Tests: T-452, T-456, T-448, T-449, T-450, T-453, T-454, T-455, T-410, T-411, T-412, T-413, T-414, T-415.

## Coverage, tests, probes
- Scoped coverage: backend 4551/4634 = 98.21% → 4678/4751 = **98.46%**; frontend 1646/1849 = 89.02% → 1708/1889 =
  **90.41%**.
- Tests: backend 23279 → 23328 passed (10 skipped); frontend 9310 → 9333 passed (1 skipped).
- known_broken: none → none. Probes 11/11 matching (no golden re-recorded during the loop). SURFACE.md: +5 additive
  exports, −ProjectOptionLabel, settings/permission usage counts (T-424, T-423) — all with changelog entries.
- Gates at the end: ruff, basedpyright lock (0), tsc, eslint, i18n parity (15 locales), knip, build (237 bundles, Safari 16).

## Left for humans
- **OPEN (19)**, full records in the appendix: cleanliness T-433..T-442, T-447 (mostly project_slice.py tidy-ups and the
  unused projectDetail i18n keys); tests T-416..T-420, T-451, T-457, T-458.
- **WONTFIX-AUTO:** T-432 (duplicate of T-425).
- **Leads** (unverified, c29-leads.md, copied to plans/refactor-campaign29/), highlights:
  - print_cost_estimate._source_path PathTraversalError keeps an already-queued symlinked-out print pending (T-425 gap).
  - Success sweep pends other users' / out-of-scope waiting jobs once someone's retry succeeds (T-421 follow-up).
  - A refused Aito drop leaves an empty project item behind; retry-slice's message is misleading when the source is gone.
  - ItemRow only renders legacy disabled-section items, so its edit branches are unreachable in the app.
  - tools/coverage_pdm.sh tails vitest output, hiding failing test names (tools/ frozen; noted for a future campaign).
- **Merge note:** main moved during the campaign to d780a90fd (Aito quote expiry = 1 calendar month, outside this scope).

## Preserved
At the user's request every loop file was copied to `plans/refactor-campaign29/` in the main checkout: PLAN.md,
BASELINE.md, VERDICTS.log, c29-leads.md, scope-brief.md, c29-worker-brief.md, batch files, raw auditor findings,
already-filed lists and this report.

## Appendix: OPEN and WONTFIX-AUTO task records

### T-416 [P3] OPEN — Lifespan wiring test for the orphan sweep pins source-text order via inspect.getsource
- files: backend/app/services/project_reslice.py · source: survey · reason: deferred by user choice: approved fixes first
- evidence: CARRIED from campaign 28 (T-398, source audit-tests); verify against HEAD — main changed since (server slicing, project page rework). backend/app/services/project_reslice.py:1 · backend/tests/integration/test_project_reslice.py:918-929: `source = inspect.getsource(lifespan); call = source.index("await sweep_orphan_intermediates("); assert source.index("await init_db()") < call; ... assert "except Exception" in source[call : source.index("\n\n", call)]`. Any reformat or helper extraction in main.py breaks it while behaviour is unchanged. main.py is upstream-owned, so each upstream merge risks a false failure. · fix: In backend/tests/integration/test_project_reslice.py, keep the wiring check but make it AST-based. Alternatively, extract the sweep call into a named startup helper with its own behaviour test: a raising sweep must not stop startup. Do not delete the check. If a production extraction is needed, set behavior_change false and note it is zero-behaviour.

### T-417 [P3] OPEN — Oversized project test files and 95-133 line test functions would benefit from splitting
- files: backend/app/services/project_files.py · source: survey
- evidence: CARRIED from campaign 28 (T-399, source audit-tests); verify against HEAD — main changed since (server slicing, project page rework). backend/app/services/project_files.py:1 · Measured: backend/tests/unit/test_project_files_service.py 3326 lines (test_reused_row_columns_are_pinned 103 lines at :1717, test_reuse_row_changed_during_copy_is_refused 95 lines at :2698); backend/tests/integration/test_projects_api.py 2597; test_aito_project_links_service.py 1291; test_project_filing_move.py 1148; test_project_reslice.py 930; test_aito_project_links_api.py 929; test_print_trace_queue.py 865; test_project_auto_filing.py 759; test_project_legacy_migration.py 705; test_project_item_delete_race.py 662; test_project_files_api.py 643; test_project_tree.py::test_load_tree_full_payload 133 lines at :199. Frontend: ProjectDetailPageActions.test.tsx 639, ProjectFilesPanelActions.test.tsx 627, ProjectFilesPanel.test.tsx 615 (ProjectsPage.test.tsx 976 is mostly upstream). · fix: In backend/tests/unit/, split test_project_files_service.py by operation (add_revision, remove and delete, rename, fork, cancel-commit) into test_project_files_service_*.py files sharing the same fixtures. Turn the two ~100-line tests into parametrized column tables. Move test_load_tree_full_payload's expected dict into a module constant. Pure moves only; no assertion is removed.

### T-418 [P3] OPEN — Files-panel tests find the destructive confirm button by the bg-red-500 class with a non-null assertion
- files: frontend/src/components/projects/files/RevisionBlock.tsx · source: survey
- evidence: CARRIED from campaign 28 (T-400, source audit-tests); verify against HEAD — main changed since (server slicing, project page rework). frontend/src/components/projects/files/RevisionBlock.tsx:1 · ProjectFilesPanelActions.test.tsx:81-82: `const dangerButton = (name) => screen.getAllByRole('button', { name }).find((b) => b.className.includes('bg-red-500'))!;`. ProjectFilesPanel.test.tsx:525: `...find((b) => b.className.includes('bg-red-500'))!`. If the class changes or two buttons share the name, `find` returns undefined or the wrong button. The click then throws a TypeError rather than a clear failure, or silently targets the row's own trigger. · fix: Keep the bg-red-500 pin and ADD scoping. Resolve the button inside the confirm dialog first, `within(screen.getByRole('dialog')).getByRole('button', {name})`, then assert `.className` still contains 'bg-red-500'. Add an expect that exactly one button matches before clicking. Do not remove the class assertion.

### T-419 [P3] OPEN — ProjectListPage grid-view test asserts only the table's absence; two grid-card click tests duplicate each other
- files: frontend/src/pages/ProjectListPage.tsx · source: survey
- evidence: CARRIED from campaign 28 (T-401, source audit-tests); verify against HEAD — main changed since (server slicing, project page rework). frontend/src/pages/ProjectListPage.tsx:97 · ProjectListPage.test.tsx:97-103: `await userEvent.click(screen.getByRole('button', { name: 'Grid view' })); expect(screen.queryByRole('table')).not.toBeInTheDocument();`. That passes on a blank page. :198-204 ('opens the project when a grid card is clicked') and :252-259 ('opens the project when its grid card is clicked') both click the P-0002 card and assert navigation to /projects/2 (one via location, one via a pushState spy). · fix: In frontend/src/__tests__/pages/ProjectListPage.test.tsx, ADD a positive assertion to the :97 test (a grid card button /P-0001/ is present). Fold the two grid-card tests into one that asserts both the pathname and the single pushState call. Do not drop either assertion.

### T-420 [P3] OPEN — useResliceJobs tests use real sleeps (up to 3.2 s) and the post-unmount assertions can pass vacuously
- files: frontend/src/components/projects/reslice/useResliceJobs.ts · source: survey
- evidence: CARRIED from campaign 28 (T-402, source audit-tests); verify against HEAD — main changed since (server slicing, project page rework). frontend/src/components/projects/reslice/useResliceJobs.ts:1 · useResliceJobs.test.tsx:14 `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));`, :150 `await sleep(POLL_MS * 2 + 200)`, :213 `await new Promise((r) => setTimeout(r, 200)); // the tree resolves after unmount: no throw` followed by `expect(result.current.printNext).toBeNull();`. That reads a stale result from an unmounted hook, so it is null whether or not the hook misbehaved after unmount. The earlier filed finding covered fake timers; the file now uses real timers. · fix: In useResliceJobs.test.tsx, count requests on the msw slice-jobs/:id and tree handlers. After unmount, assert the counts do not grow over a vi.useFakeTimers advance. Replace the printNext assertion with a spy on the toast or onPrint callback. Keep the real-timer polling tests as they are.

### T-433 [P3] OPEN — _store() undo rolls back before unlinking, so a failing rollback leaves the written .gcode.3mf in the revision folder
- files: backend/app/services/project_slice.py · source: audit-robustness
- evidence: backend/app/services/project_slice.py:469 · async def undo() -> None: await db.rollback() project_files._unlink_quietly(dest) # If the commit fails because the connection dropped, db.rollback() raises too. _CommitGuard.__aexit__ logs the undo's exception and moves on, so _unlink_quietly never runs. The slice file stays in R{n}/ with no library row. The next slice writes next to it under a de-duplicated name via claim_unique_file_path, and the orphan shows up in the projects tree browsed from the share. · fix: Unlink first and roll back second, or call _rollback_quietly(db, ...) so the unlink always runs.

### T-434 [P3] OPEN — _rollback_quietly re-implements db_quiet.rollback_quietly
- files: backend/app/services/project_slice.py · source: audit-cleanliness
- evidence: backend/app/services/project_slice.py:185 · project_slice.py:185 `async def _rollback_quietly(db, what): try: await db.rollback() except Exception: logger.warning('Rollback after %s failed', what, exc_info=True)` (called at :181, :199, :211, :544; `_mark_failed` :367-370 spells the same try/except a fifth time). backend/app/services/db_quiet.py:8 already defines `rollback_quietly(db, log, level, msg, *args)`, and project_filing.py:471, project_reslice.py:163, aito_project_links.py:536 and project_print_trace.py:175 all use it. Only project_slice has its own copy. · fix: delete _rollback_quietly and call db_quiet.rollback_quietly(db, logger, logging.WARNING, 'Rollback after %s failed', what). Use it in _mark_failed's inner except as well.

### T-435 [P3] OPEN — _error_status_and_message has two identical branches for HttpStatusError and HTTPException
- files: backend/app/services/project_slice.py · source: audit-cleanliness
- evidence: backend/app/services/project_slice.py:343 · project_slice.py:344-347: `if isinstance(exc, HttpStatusError): return exc.status_code, str(exc.detail)` followed by `if isinstance(exc, HTTPException): return exc.status_code, str(exc.detail)`. _run_slice (:381) then wraps the result in a new HTTPException only to feed http_exception_to_job_error, which does `_SliceJobError(exc.status_code, str(exc.detail))` (slice_dispatch.py:182-187). That is a round trip through an exception type just to build the job error. · fix: merge the two branches into `isinstance(exc, (HttpStatusError, HTTPException))`. Raise slice_dispatch._SliceJobError, or a small public factory, directly from _run_slice instead of constructing an HTTPException first.

### T-436 [P3] OPEN — source_file_of() is a one-line public alias of _source_file()
- files: backend/app/services/project_slice.py · source: audit-cleanliness
- evidence: backend/app/services/project_slice.py:267 · project_slice.py:267-269 `async def source_file_of(db, revision_id): return await _source_file(db, revision_id)`. `rg -n '\bsource_file_of\b' backend` -> only this definition and print_queue.py:2700 (via _project_slice().source_file_of). Every call inside project_slice.py uses the private name (:92, :134, :275, :394, :537). Two names exist for one function. · fix: rename _source_file to source_file_of (or drop the private name) and delete the wrapper, then update the 5 internal call sites.

### T-437 [P3] OPEN — library_file_print_time and _required_filament_types hand-write the absolute/relative library path resolution
- files: backend/app/services/project_slice.py · source: audit-cleanliness
- evidence: backend/app/services/project_slice.py:239 · project_slice.py:239-240 `lib_path = Path(library_file.file_path); path = lib_path if lib_path.is_absolute() else settings.base_dir / library_file.file_path` and the same two lines at :255-256 for sliced_file. print_queue.py (:375, :613, :887, :1114) and print_scheduler.py (:4517, :8723) spell the identical expression, and library.to_absolute_path (library.py:317) is the existing resolver. This is a new module adding two more copies. · fix: add one `_library_path(file_path) -> Path` helper in project_slice (or reuse library.to_absolute_path, which has the same is_absolute fast path) and use it at both sites. The older print_queue and print_scheduler copies are upstream-owned, so leave them alone.

### T-438 [P3] OPEN — _store reaches into six private project_files helpers
- files: backend/app/services/project_slice.py · source: audit-cleanliness
- evidence: backend/app/services/project_slice.py:455 · project_slice.py:439, 455, 464, 471, 474, 476, 511 use project_files._open_claimed, _item_lock, _claim_storage_dir, _unlink_quietly, _CommitGuard, _new_library_row and _remove_empty. The audit already filed this reach-into-private pattern for project_filing, aito_project_links and the routes. project_slice is a new module that repeats it, so a rename inside project_files breaks slicing silently. · fix: expose a public project_files entry point such as `store_derived_file(db, revision, content, ...)` under the item lock, or drop the underscores from these helpers. project_slice._store keeps only the slice-specific row and revision updates.

### T-439 [P3] OPEN — SLICE_STATUSES is never referenced while project_slice spells the literals everywhere
- files: backend/app/models/project_item.py · source: audit-cleanliness
- evidence: backend/app/models/project_item.py:41 · models/project_item.py:41 `SLICE_STATUSES = ('slicing', 'sliced', 'failed')`. `rg -n 'SLICE_STATUSES' .` (excluding node_modules and .md) -> only the definition and a comment at :74. The literals 'slicing', 'sliced' and 'failed' are written out about 20 times in services/project_slice.py, routes/project_files.py:425 and elsewhere. · fix: delete the constant, or (better) use it plus per-status constants in project_slice.py and routes/project_files.py in place of the literals.

### T-440 [P3] OPEN — main.py spells the slice-wait queue statuses by hand although SLICE_WAIT_STATUSES exists
- files: backend/app/main.py · source: audit-cleanliness
- evidence: backend/app/main.py:8026 · main.py:8026 `PrintQueueItem.status.in_(("pending", "printing", "slicing"))` and :8876 `PrintQueueItem.status.in_(("pending", "slicing", "slice_failed"))`. Every other PDM site uses the models.print_queue constant: `SLICE_WAIT_STATUSES = ("slicing", "slice_failed")` (queue_position.py:40, finance_budget.py:121, print_batch.py:425, projects.py:224, users.py:635). The main.py hunks are the fork's own lines. Neither spelling would pick up a future third wait status. · fix: use `("pending", "printing", "slicing")` -> `("pending", "printing", *SLICE_WAIT_STATUSES)`-style expressions built from the constant at both sites (check first whether :8026 deliberately excludes slice_failed).

### T-441 [P3] OPEN — Three pass-through wrappers around _project_slice() in print_queue.py
- files: backend/app/api/routes/print_queue.py · source: audit-cleanliness
- evidence: backend/app/api/routes/print_queue.py:924 · print_queue.py:932-942 `_is_unsliced_project_source`, `_sliced_file_of` and `_start_slice_for_waiting_items` each forward to _project_slice().<same name>. Their callers are :824, :825, :1066, :1067, :1389, :2711. The routes also call `_project_slice().library_file_print_time` (:1238), `.source_file_of` (:2700) and `.NOT_THE_SOURCE` (:2702) directly, so there are two calling styles for one module. · fix: drop the three wrappers and call _project_slice().x at the call sites, or import project_slice once inside a single late-import helper.

### T-442 [P3] OPEN — projectDetail.cost.title, cost.total, files.title and toast.partAdded/partRemoved/exportFailed are never used
- files: frontend/src/i18n/locales/en.ts · source: audit-cleanliness
- evidence: frontend/src/i18n/locales/en.ts:6143 · Key scan of en.ts `projectDetail` against every .ts/.tsx outside i18n/locales and __tests__. `rg -nF` for 'projectDetail.cost.title', 'cost.total'' (a quoted exact key), 'projectDetail.files.title', 'toast.partAdded', 'toast.partRemoved' and 'projectDetail.toast.exportFailed' -> no hits (the only 'exportFailed' hits are archives.toast.exportFailed in ArchivesPage). These are leftovers of the removed BOM, cost-card and parts UI. The same scan finds projectsPdm.files.addFiles (en.ts:10398) unused: `rg -nF 'files.addFiles'` -> none, and the only `addFiles` identifiers are useFileActions' function and FileUploadModal's own helper. The earlier c24-28 finding covered only projectsPdm.createTag, projectsPdm.files.title and projectsPdm.files.dropHint. · fix: delete these seven keys from en.ts and the 14 other locale files. Run check:i18n to confirm parity.

### T-447 [P3] OPEN — File-type badge colour chain is written three times (ItemCard.badgeCls, ProjectDetailPage, FileManagerPage)
- files: frontend/src/components/projects/files/ItemCard.tsx · source: audit-cleanliness
- evidence: frontend/src/components/projects/files/ItemCard.tsx:54 · ItemCard.tsx:54-59 `fileType === '3mf' ? 'bg-bambu-green/90 text-white' : fileType === 'gcode' || fileType === 'gcode.3mf' ? 'bg-blue-500/90 text-white' : 'bg-bambu-gray/90 text-white'`. ProjectDetailPage.tsx:625-629 repeats the chain with the translucent colours `bg-bambu-green/20 text-bambu-green` and `bg-blue-100 dark:bg-blue-500/20 ...`. FileManagerPage.tsx:1278-1279 has the 90% variant (upstream-owned). The ItemCard comment says it mirrors the File Manager card, so the rule is copied rather than shared. · fix: add `fileTypeBadgeTone(fileType): 'source' | 'sliced' | 'other'` to a new module under components/projects/files/ (NOT filesUi.ts, whose export list is pinned by the pdm-frontend-pure probe) and map tone to each site's class set. Leave FileManagerPage (upstream) alone.

### T-451 [P3] OPEN — formatFilament kilogram branch and projectCost null-wear fallback are untested
- files: frontend/src/components/projects/detail/format.ts · source: audit-tests
- evidence: frontend/src/components/projects/detail/format.ts:3 · format.ts: `if (grams >= 1000) return `${(grams/1000).toFixed(2)}kg``, and `stats.total_wear_cost ?? 0`. `rg "[0-9]kg'" frontend/src/__tests__/pages/ProjectDetail*` has no match and `rg 'formatFilament|projectCost' frontend/src/__tests__` has no match. Fixtures only use totals under 1000 g, and the wear fixtures set total_wear_cost to 0 or 2, never undefined. · fix: add frontend/src/__tests__/components/projects/detail/format.test.ts covering formatFilament(999.6)='1000g' vs formatFilament(1000)='1.00kg' vs 1250='1.25kg', and projectCost with total_wear_cost undefined, which should equal estimated_cost + total_energy_cost.

### T-457 [P3] OPEN — timelineGroups/useArrivals edge cases untested: equal stamps, unparseable stamps sorted last, month boundary, empty-first-load arrival
- files: frontend/src/components/projects/detail/timelineGroups.ts · source: audit-tests
- evidence: frontend/src/components/projects/detail/timelineGroups.ts:29 · timelineGroups.ts 29-32 `stamp()` returns NEGATIVE_INFINITY for junk and 36 sorts stably. timelineGroups.test.ts has one NOW (2026-10-17), tests only timelineDay('not a date') in isolation, and asserts no ordering of equal-timestamp events or of a junk-stamp event against dated ones (the rail's eventKey includes the timestamp, so ties matter). 'Yesterday' is only tested inside October, never on the 1st of a month. useArrivals.test.ts never starts with ready=true and an empty list, which is a project with no activity whose first event then arrives and must animate. It also never flips ready true->false->true (a refetch). · fix: in frontend/src/__tests__/components/projects/detail/timelineGroups.test.ts add: two events with identical timestamps keep input order; a junk-stamp event lands last in the 'earlier' group; NOW=2026-11-01T00:10 with an event on Oct 31 is 'yesterday'. In frontend/src/__tests__/hooks/useArrivals.test.ts add: initial {keys: [], ready: true} then keys ['a'] flags 'a'; ready false then true after a refetch does not flag the baseline keys.

### T-458 [P3] OPEN — test_project_reslice patches the process-wide asyncio.sleep via project_reslice.asyncio
- files: backend/tests/integration/test_project_reslice.py · source: audit-tests
- evidence: backend/tests/integration/test_project_reslice.py:751 · backend/tests/integration/test_project_reslice.py l.751-757: `real_sleep = asyncio.sleep` ... `monkeypatch.setattr(project_reslice.asyncio, "sleep", no_pause)`. `project_reslice.asyncio` is the global asyncio module, so every asyncio.sleep in the process (httpx, slice_dispatch, other tasks in the same xdist worker) becomes `no_pause` for the test's duration and is recorded in `pauses`. An assertion on `pauses` can pick up unrelated sleeps, and unrelated code loses its real waits. · fix: in backend/tests/integration/test_project_reslice.py, patch a module-local seam instead, for example a `_RETRY_PAUSE` helper in project_reslice or `monkeypatch.setattr(project_reslice, "_pause", no_pause)`. If that is not possible, filter `pauses` to the retry delay and assert it exactly.

### T-432 [P2] WONTFIX-AUTO — revision_file_path() raises ValueError instead of returning None for a relative path that resolves outside base_dir
- files: backend/app/services/project_files.py · source: audit-robustness · reason: duplicate of T-425 (same revision_file_path fix, approved there)
- evidence: backend/app/services/project_files.py:1468 · path = to_absolute_path(file_path) # to_absolute_path raises ValueError("Path escapes base directory") for a relative path whose resolved target leaves base_dir. That is exactly the case the docstring promises to read as missing ('a file there may have been swapped for a symlink'). The per-depth loop below wraps to_absolute_path in try/except ValueError; this first call does not. Trigger: on the share, a revision folder or file is replaced by a symlink pointing outside the data dir. Now that project_slice._source_file calls this for every file of the revision, the ValueError escapes from add_to_queue (_sliced_file_of -> 500), from the scheduler's hold_unsliced_dispatch (dispatch raises every tick), and from _store's completion hook (the finished slice is undone and the revision marked 'failed'). Download, fork and reslice also return 500 instead of 404. · fix: Wrap the first to_absolute_path call in try/except ValueError and return None. · user-visible change: A project file whose path was redirected outside the data directory would be reported as missing (404, or 'source .3mf is missing') instead of causing 500 errors when queuing, dispatching, slicing or downloading.
