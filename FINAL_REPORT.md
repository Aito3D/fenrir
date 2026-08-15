# FINAL_REPORT.md — refactor-loop campaign 3 (frontend Aito scope)

**Branch:** `auto-refactor-loop` · **BASE:** tag `refactor-base` (`6f6debc94`) · **HEAD:** `d9a46c7cc`
**Upstream:** cut from `9bbc1c4eb` on `main` · **Dates:** 2026-08-14 → 2026-08-15
**Request that started it:** *"make more test for the Aito page"*

## Outcome

| | |
|---|---|
| Iterations run | **9** (`loop3-1` … `loop3-9`), every one gated by a blind verifier |
| Survey rounds | **2 of 2** (the configured maximum) |
| Commits on the branch | 10 — one setup commit plus one squashed commit per iteration |
| Tasks | 28 total · **27 DONE** · 0 OPEN · 0 BLOCKED · 1 WONTFIX-AUTO |
| Triaged for you | **23** findings, every one reproduced in full below |
| Why it ended | **MAX_ROUNDS** — round 2 was the last configured survey; its plan was worked to exhaustion |

**Verdicts:** 9 iterations, 12 verifier passes. **7 PASS, 3 FAIL** (iterations 2, 5, 5-again), each fixed and re-verified before the iteration was tagged. Iteration 5 needed three passes.

MAX_ITER was raised 8 → 10 by the user at iteration 7, on the grounds the campaign was producing. It ended at 9 anyway, when the plan ran dry with both survey rounds spent.

## Gates at exit

| Gate | BASE | Final |
|---|---|---|
| Frontend Aito **missed statements** | 128 | **74** (−42%) |
| Frontend Aito **missed branches** | 214 | **154** (−28%) |
| Frontend Aito **missed functions** | 41 | **25** (−39%) |
| Frontend Aito **missed lines** | 72 | **30** (−58%) |
| Aito gate test files | 54 | **56** |
| Aito gate tests | 821 | **884** (+63) |
| Backend suite | 10164 passed, 1 skipped, 0 failed | **10164 passed, 1 skipped, 0 failed** (identical) |
| Golden probes | 9/9 | **9/9** |
| SURFACE.md | frozen | **byte-identical**, regenerates identically |
| `tools/`, `PROBES.json`, `snapshots/` | — | **zero diff** |
| Known-broken list | 10 flaky + 1 time-of-day | **unchanged — none added, none removed** |

The ratchet metric throughout is the **missed count, not the percentage**. Removing covered duplicate lines shrinks the denominator and lowers the percentage with no coverage lost; a rising missed count is the real regression. All three campaigns on this scope have hit that trap.

## Campaign-wide test integrity

Verified by the final verifier over the whole standing diff, not asserted by the loop:

- **0 test files deleted. 0 renamed.** (`--name-status -M`: 3 A, 42 M, 0 D, 0 R.)
- **2 assertion lines removed in the entire campaign**, both relocations, both net **strengthenings**:
  - `await waitFor(() => expect(prefetched).toBe(1))` → a hard `expect(prefetched).toBe(1)` after `vi.advanceTimersByTime(500)`. Wall-clock race removed.
  - `expect(getByText(/no projects yet/i))` → `await findByText(...)`, same assertion with a correct settle signal. The `findByRole(/show done \(0\)/)` settle line went with it; that button's presence is still asserted in the adjacent test.
  - Totals under `__tests__`: **1423 lines added, 21 removed** (the other 19 are import edits and the moved test's body).
- **No `.skip` / `.only` / `.todo` added.**
- **Zero coverage-ignore comments of any flavour** anywhere in `frontend/src/` at HEAD — no `pragma: no cover`, `xfail`, `skipif`, `istanbul ignore`, `c8 ignore`, `v8 ignore`. One iteration floated an `istanbul ignore` rationale; it was retracted in the changelog and nothing landed.
- **Coverage gate intact.** `--coverage.all=true` and all four include globs used verbatim. The grep-discovered test set grew **54 → 56 purely additively** — a sorted-list diff shows only the two new files, so nobody quietly removed an `aito` import to shrink discovery. Config files compared **by blob hash, not eyeballed**, and byte-identical to BASE: `vitest.config.ts`, `vite.config.ts`, `package.json`, `package-lock.json`, `eslint.config.js`, `tsconfig.json`, `tsconfig.app.json`, `pyproject.toml`.
- **Changelog append-only:** 572 lines added, **0 removed**, across the whole campaign.
- **Zero backend files changed**, so every backend result is definitionally not this diff's doing.

## User-approved behavior changes

Seven, each recorded in `BASELINE-CHANGELOG.md`, each in a commit marked `(user-approved behavior change)`, each mapped 1:1 by the final verifier to a source hunk with **no orphans in either direction**.

| # | Change | Observable consequence |
|---|---|---|
| T-075 | `isPending` branch before AitoPage's empty state | The board shows a loader during the first fetch instead of "No projects yet" |
| T-076 | ActivityRail takes `isError`/`refetch` | A failed history fetch shows load-failed + Retry, not "Nothing recorded yet" |
| T-077 | `maxLength={2000}` on the note input | The note box stops accepting input at 2000 chars instead of 422ing on save |
| T-078 | 200 ms dwell before the quote-preview prefetch | A hover-then-click inside 200 ms sees a loading state where the cache used to be warm |
| T-090 | `statusQuery.isError` arm in the client section | A failed `GET /zoho/status` shows an unavailable message instead of an empty section and an inert Create button |
| T-091 | `isFetchFailure` gate on the calculator queries | A failed calculator fetch says pricing is unavailable instead of "No printers configured" |
| T-092 | Negative-rate validation on the shipping field | A negative rate is flagged in the field instead of 422ing the whole save or create |

**T-078's approval was obtained retroactively.** `audit-robustness` emitted it `behavior_change: false`; the orchestrator accepted that; the worker, explicitly invited to object, also found nothing observable. The blind verifier failed the iteration having constructed the case none of them did. The user was then asked directly, offered a revert and a shorter dwell, and approved keeping it at 200 ms.

**T-076 and T-091 were later NARROWED**, after the iteration-5 verifier found T-076's branch swallowed an already-rendered timeline when a *load-more* page failed — `useProjectEvents` is a `useInfiniteQuery` and v5's `isError` is the query's overall status, true for a failed `fetchNextPage` too. Both now gate on `isError && !data`. That is strictly inside the approved envelope, not outside it.

## What each survey round found

**Round 1 (iteration 0)** — 13 filed, 1 triaged, 0 suppressed. Zero suppressions is itself a result: the auditors genuinely honoured their `ALREADY_FILED` lists (46 dedup fingerprints seeded from campaign 2) rather than dedup having to catch repeats. `audit-tests` produced 6, `audit-robustness` 4, `audit-cleanliness` 3, `audit-security` 1 (triaged).

**Round 2 (iteration 4)** — 11 filed (3 needing approval), 1 triaged, 0 suppressed. **Not a dry round.** It found the campaign's only P1 (T-090, a failed Zoho-status query silently bricking the new-project drawer) and, pointedly, a gap in **this campaign's own T-078 fix** that the verifier had missed (T-093, triaged: the dwell timer is not cleared when the search term changes, so an abandoned search still spends a Books round trip).

`audit-security` returned `{"findings": []}` in round 2 — and it is a substantive negative, not a lazy one. It ran semgrep (210 rules, 0 findings over 62 in-scope files), gitleaks over 5257 commits (9 hits, none on an aito path), and npm audit; then traced the dompurify CVE's reachability to the single in-scope call site (`QuoteEmailPreview.tsx:42`, which uses neither `IN_PLACE` nor `addHook`) to confirm it does not apply. It also independently verified T-077's `maxLength={2000}` matches the server cap rather than being client-only validation. Its conclusion: *"the remaining browser-side surface here is genuinely small after three campaigns."*

## Findings by auditor

| Auditor | Filed | DONE | WONTFIX-AUTO | Triaged this campaign |
|---|---|---|---|---|
| audit-tests | 13 | 13 | 0 | 0 |
| audit-robustness | 7 | 7 | 0 | 1 (T-093) |
| audit-cleanliness | 4 | 3 | 1 | 0 |
| audit-security | 0 | 0 | 0 | 1 (T-074) |
| **verifier** | **4** | **4** | 0 | 0 |
| survey (hand-added) | 0 | 0 | 0 | 0 |

Two numbers worth reading together. **`audit-tests` filed 13 and all 13 landed** — the campaign did what you asked. And **4 of 28 tasks came from the blind verifier**, every one of them a defect the loop itself had introduced: an unsanctioned behavior change, a test that proved nothing, a test that flaked, and a comment the loop leaked into your repo.

No task was hand-added. Your request was already fully expressed by the `audit-tests` findings, with concrete evidence and named test files; a catch-all "write more tests" task would have had no acceptance criterion.

## Why the loop ended

**MAX_ROUNDS.** Round 2 was the last configured survey. Its plan was worked to exhaustion by iteration 9, at which point the cap check (`ROUND 2 >= MAX_ROUNDS 2`) exits before running a third panel. The campaign did **not** converge — convergence requires two consecutive dry rounds and neither round was dry, so **a third round would very likely have found more**. That is a budget decision, not a completeness claim.

## Tasks left for humans

**One retired task (WONTFIX-AUTO):**

**T-079 — delete the "unreferenced" `COLUMN_ORDER` export.** Retired because the premise was false, and this one is worth your attention as a process result. `audit-cleanliness` claimed it was provably unreferenced across `frontend/` and `backend/`. The mandatory step-zero re-verification found it is **live**: `tools/probe_boardrules.cjs:13` reads `rules.COLUMN_ORDER`, `tools/probe_aito_frontend.cjs:216` reads it via a namespace re-export, and its value is baked into two frozen goldens (`aito-board-rules-ts.golden`, `aito-frontend-pure.golden`). Deleting it would have made both reads `undefined` and moved two goldens. **The user had already approved the associated SURFACE.md deletion on those false grounds; nothing was deleted.** Re-scoping to edit the probe scripts and re-record two goldens was rejected without asking: weakening the behavioral alarm to remove one unused-looking constant is a bad trade, and `tools/` is frozen precisely to stop it.

The auditor searched `frontend/` and `backend/` but never `tools/` — a direct consequence of `tools/` being declared out of scope for *findings*. **`tools/` is out of scope for findings but very much in scope for reachability**, because the golden probes deliberately reach into the app's pure modules by name, including through namespace re-exports.

**23 triaged findings**, all reproduced verbatim in the appendix below. They are also in `TRIAGE.md` in the worktree, and a future campaign can act on any of them with `plan.py promote <id> --iteration N` (that flag is required; the command fails without it). 21 are inherited from campaign 2 and 2 are new this campaign (T-074, T-093).

## Standing gotchas for a fourth campaign

These are the durable findings — things that will still be true after this branch is merged and the worktree is gone.

### 1. The coverage gate has a third-generation blind spot

`frontend/src/utils/shippingDraft.ts` is **Aito-only code** — 11 Aito importers plus `AitoPage.tsx`, nothing outside the feature — whose name does not start with `aito`. It therefore does not match the gate's `--coverage.include='src/utils/aito*.ts'` and **has never been measured by any campaign's ratchet**. T-092's fix landed a new validation branch there, unmeasured (though directly tested, and mutation-proven by the verifier: reverting the price logic kills two tests).

This is the same failure mode three campaigns running: campaign 1's gate missed `TaskEditor.test.tsx` (filename-prefix glob), campaign 2 corrected a gate that excluded **14 real passing test files**, and campaign 3 missed a **source** file. A name-shaped glob keeps producing name-shaped holes.

**Deliberately not fixed mid-campaign.** Widening the include glob at iteration 6 would have pulled in a previously-unmeasured file's missed statements and invalidated every ratchet comparison behind it — indistinguishable from moving the goalposts, which is exactly why *narrowing* is a protocol violation. Correcting a gate is a SETUP-time act; campaign 2 did precisely that, before any task ran, and disclosed it in full.

**For next time:** at SETUP, audit `frontend/src/utils/` and `frontend/src/hooks/` for every Aito-only file whose name does not start with `aito`/`useAito`, add them to the include globs, and record the tightened baseline before the first task.

### 2. `.gitignore:38` has an unanchored `archive/` rule

It matches a directory named `archive/` **anywhere in the repo**. T-081's worker placed a new component in `frontend/src/components/aito/archive/` and git silently ignored the file — no error, it simply would not have been tracked. Caught with `git check-ignore -v` before committing and renamed to `archives/`. Any future source directory named `archive/` will vanish the same way.

### 3. SURFACE.md cannot see subdirectories

`tools/gen_surface.sh`'s R3 rule globs `frontend/src/components/aito/*.tsx` and `*.ts` **non-recursively**. `components/aito/history/` was already invisible; T-081 added `components/aito/archives/`. Anything exported from either subdirectory is outside the frozen public-contract record.

T-081's worker chose the `archives/` placement partly *because* it dodges the glob. The verifier judged it **"defensible, but the weaker of the two readings"** — `archives/` is a one-file directory whose two consumers sit outside it, unlike the `history/` cluster which is a genuine grouping — and noted a name collision with an unrelated file-local `ArchiveGrid` in `pages/ProjectDetailPage.tsx:120`. It did not fail on it: the surface freeze protects the public contract, and no public contract moved. **The orchestrator decided to leave it** rather than spend a task slot relocating a file in a test-first campaign, and rather than cost the user another approval for one SURFACE.md line. Widening the globs to `**` would move SURFACE.md immediately and needs your approval.

### 4. The known-flaky list is now ten, and `PrintModal` has got worse

`PrintModal.test.tsx` is documented as "fails under load, always passes alone". **This campaign repeatedly observed it failing in isolation too** (one verifier saw pass / fail / pass across three consecutive isolated runs). It is out of scope and untouched by this diff — no file it covers is in the campaign diff — but its character has changed and it is worth a look independently of this work.

Two further load-only flakes were observed in files this campaign never touched, both clean in isolation, both causally impossible for this diff (no backend file changed at all):
- `frontend/src/__tests__/components/ImportQuoteDrawer.test.tsx > shows the parsed tasks and pre-fills the description`
- `backend/tests/unit/test_slicer_stall_timeout.py::TestSliceIsNotCutOffWhileProgressing::test_a_slow_slice_that_reports_progress_completes`

Four of the backend flakes are SQLAlchemy/concurrency-shaped and surface only under `-n 30`. `test_extract_video_last_frame.py` is environmental: it hardcodes `/usr/bin/ffmpeg` where this machine has `/opt/homebrew/bin/ffmpeg`.

### 5. Two informational determinism notes in the shipped diff

Neither is destabilising; both are recorded so nobody rediscovers them cold.
- `AitoPage.test.tsx:1659,1668` — an unscoped `document.querySelector('.animate-spin')` pair added by T-075. **Both directions are asserted** (present while pending, absent after settle), so a stray match from an unrelated component fails deterministically rather than flakily.
- `ProjectDetailPanel.test.tsx` and `TaskEditor.test.tsx` retain **15 pre-existing `setTimeout(50)` wall-clock waits**, enumerated at BASE and at HEAD and identical line-for-line. **The campaign's net contribution of wall-clock waits is zero** — the one it introduced (600 ms) is the one iteration 9 removed.

## The verifier's evidence, in detail

Preserved here at your request, because `VERDICTS.log` does not survive the worktree.

### Iteration 4 — 12 mutations, 12 caught

The concern was legitimate: a large volume of new tests plus a sharp coverage drop is exactly what a campaign gaming its own metric looks like. Rather than reading the tests, the verifier built a sandboxed copy of `frontend/` (symlinked `node_modules`, never touching the worktree) and ran 12 targeted mutations against the code the new tests claimed to cover. **All 12 were caught by exactly the intended test:**

| Mutation | Caught by |
|---|---|
| `formatValue` boolean always `✓` | `eventKinds.test.ts` |
| `ArchiveGrid` drops `animate-rise-lg` | `ArchiveGrid.test.tsx` |
| Dwell reverted to synchronous prefetch | `QuoteResultList.test.tsx` (2 tests) |
| `FlagControl` outside-pointerdown listener no-op | `FlagControl.test.tsx` |
| `IslandCombobox` ArrowUp stops instead of wrapping | `AitoIslandCombobox.test.tsx` |
| `HoldButton` pointerleave no longer cancels | `HoldButton.test.tsx` |
| `ActivityRail` `maxLength` removed | `AitoActivityRail.test.tsx` |
| `ActivityRail` `isError` branch removed | `AitoActivityRail.test.tsx` |
| `AitoPage` `isPending` gate reverted | `AitoPage.test.tsx` |
| `ClientCombobox` ArrowDown no wrap | `ClientCombobox.test.tsx` |
| `deleteMutation` onError toast removed | `useAitoPageMutations.test.tsx` |
| Decline hold sends `accepted` | `AitoQuoteStatusActions.test.tsx` |

Its verdict: *"They assert observable things — `aria-selected` transitions, `onSelect` payloads, API call arguments, cache end-state after rollback, absence of a network call. Nothing renders-and-asserts-nothing."*

It named one honest concern rather than glossing it: `ArchiveGrid.test.tsx` asserts exact Tailwind class lists and `FlagControl.test.tsx` asserts `max-w-0`/`max-w-[9rem]`. In jsdom those class strings are the only proxy for visual state and the repo already uses the idiom — but they will need editing if anyone restyles those wrappers.

### Iteration 5 — the test that proved nothing

This is the campaign's most valuable single finding, and it would have shipped.

A test written to guard the `ImpressionFields` narrowing **survived a total revert of the code it existed to protect** — 47/47 passing across 5 runs with `isFetchFailure` reverted to bare `query.isError`. It was not an inert assertion (forcing the helper to `return true` failed 5 tests). The **assertion point** was wrong: `await act(async () => client.refetchQueries(...))` did not reliably flush the error propagation before the synchronous assertions ran. The verifier instrumented the render sequence to prove the error state *does* arrive with data retained — so the fix was genuinely needed — the test just raced it and lost, every time, in a full-file run.

Nothing in the normal toolchain would have caught this. Not the test passing, not lint, not the build, and **specifically not coverage** — the branch was already fully covered by older cold-cache tests.

The verifier also measured, and refuted, a plausible technical claim the loop had already relayed to the user as fact: that a shared helper was needed so one test could cover the branch for all three queries. **Istanbul's `&&` branch counter records whether the second operand was *evaluated*, not whether it was *true*.** The branch was covered either way; the new test contributed zero coverage and zero verification. It was scrupulously fair about the consequence — the shared helper is still reasonable design, hiding nothing; what was wrong was claiming coverage did the verification work.

On the third pass it reproduced the fixed guard's mutation itself, **7 for 7**: 5/5 full-file runs (the condition that previously lost the race), the full 56-file gate, and full-file under concurrent load. It then corrected **two of its own claims** — that the test fails at the new `waitFor` (it does not; the `waitFor` *passes* and is what makes the negative assertion deterministic), and that its own earlier hit-count comparison had been measured at two different scopes.

### Iteration 6 — a differential test over 600,027 inputs

For the `elapsedBucket` extraction it did not read the moved code and nod. It extracted the function bodies from BASE and HEAD and compared them mechanically (byte-identical modulo the added `export`), then differential-tested the new `elapsedBucket` against the old inline ternary over **600,027 inputs**, including 27 hand-picked edges — `NaN`, ±`Infinity`, `-0`, and every threshold boundary at 59/60/3599/3600/86399/86400. **Zero mismatches.**

It also found T-095's draft-row test vacuous, going further than that task's own worker had: the worker removed the panel guard and the test still passed; the verifier **also** removed the deeper `useProjectTasks.ts:454` guard and it *still* passed, defended by a third layer (`pendingRef.current.get(null)` → undefined). No single-line mutation of the guards it named could falsify it.

### Iteration 7 — the flake this campaign shipped

T-096's worker reported 141/141. **That did not reproduce** — six consecutive isolated runs gave 2, 1, 1, 2, 1, 2 failures. It never passed once. It was caught not by a verifier and not by the orchestrator, but by the **next worker** running the full suite.

Two root causes, both structural and both worth knowing about this suite generally:
1. `document.querySelector('.lucide-loader-circle')` was **unscoped**. `ActivityRail` renders its own `Loader2` with the same lucide class, and its `['aito-events']` query has **no mock in that describe block**; with `onUnhandledRequest: 'bypass'` the request went to a **real network call of variable latency**. The test was racing genuine network timing against an unrelated component's spinner.
2. msw's `delay(300)` raced `userEvent.type`, letting `setDraft` fire *between keystrokes* and splice the value (`"Support de caméramid-regenerate"`).

Fixed by scoping the selector to the description `PanelCard`'s `<section>`, replacing `delay()` with a promise the test itself resolves, and awaiting positive evidence (the mutation's own error toast) instead of racing a spinner's disappearance. The verifier confirmed the fix **structurally, not statistically** — it traced `PanelCard` to a `<section>` and confirmed `ActivityRail` sits in a sibling `<div>` outside every `PanelCard`, so the rail's spinner is now unreachable from that scope. 17 isolated runs at 141/141 (9 verifier, 8 orchestrator) against 0/6 before.

### Iteration 8 — sole-defender proofs

For each of three new tests it proved the stronger claim: not merely that the test fails under mutation, but that it is the **sole defender** of its branch, because sibling tests still passed under the same mutation. For the shipping-Cancel case it went further and rewired `cancel()` to call `api.updateAitoProject` directly, failing with *"expected updateAitoProject to not be called at all, but actually been called 1 times"* — proving the negative assertion is not vacuous, because the test's `api` module instance is the one the component actually calls.

## Three lessons worth carrying beyond this repo

1. **A green test is not evidence.** The only evidence a test guards something is that it *fails* when the thing breaks. For anything asynchronous that check must run under full-file conditions — the `ImpressionFields` test passed in isolation *and* under the revert.
2. **Coverage measures evaluation, not verification.** Istanbul's `&&` counter records whether the second operand was evaluated, never whether it was true. A ratchet built on it will go green on a condition nothing asserts. Both of this campaign's vacuous tests sat on fully-covered branches.
3. **Await positive evidence before a negative assertion.** `await waitFor(() => expect(x).not.toBeInTheDocument())` passes vacuously while waiting. Every fix in this campaign took the same shape: first await proof the state actually arrived, then assert the absence.

A fourth, about process: **three of four auditor claims that were checked hard turned out to be wrong or stale** — one "0 executions" on an indirectly-covered line, one "provably unreferenced" symbol that two `tools/` scripts read by name, one finding already fixed before it was written. Making "re-verify the claim before building on it" a standing instruction in every worker brief is what caught all three, and it cost nothing.

---

# APPENDIX A — the 23 triaged findings, verbatim

These were filed with full evidence but never worked, because their mapped priority fell into the campaign's TRIAGE setting (`P3`). 21 are inherited from campaign 2; **T-074** and **T-093** are new this campaign. Promote any of them into a future campaign with `plan.py promote <id> --iteration N`.

Two are worth calling out. **T-093** is a gap in *this campaign's own* T-078 fix, found by round 2: the prefetch dwell timer is not cleared when the search term changes, so an abandoned search still spends a Zoho Books round trip. **T-064** is a security finding a previous verifier explicitly cleared as harmless and a later auditor disagreed with, in writing — a genuine open disagreement worth your own read.

# TRIAGE (schema v2)

## T-005
priority: P2
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: get_invoice/get_invoice_pdf/get_quote_pdf/get_quote_email repeat a not-deleted project lookup instead of reusing _get_active_project_or_404
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1004 · Four newer routes each do: `project = await db.get(AitoProject, project_id)` then `if project is None or project.status == "deleted": raise HTTPException(status_code=404, detail="Project not found")` — get_invoice:1003-1005, get_invoice_pdf:1047-1049, get_quote_pdf:1099-1101, get_quote_email:1199-1201. `AitoProject.status` is a strict binary column (models/aito_project.py:25, comment `# active|deleted`; restore_project's own query at aito.py:1902 matches `status == "deleted"` specifically), so `status != "deleted"` and `status == "active"` are exactly equivalent for every row. That makes this pattern identical in effect to the already-extracted `_get_active_project_or_404` (aito.py:1336-1342, used at 6 other sites) — these 4 sites just re-derive it with `db.get` + a manual check instead of calling it, reintroducing the duplication campaign 1 removed everywhere else. Confirmed with `rg -n 'project.status == "deleted"' backend/app/api/routes/aito.py` -> only these 4 sites plus restore_project's own distinct 'deleted' lookup (out of scope for this change) and list_trash. SUGGESTED FIX (from audit-cleanliness): Replace `project = await db.get(AitoProject, project_id); if project is None or project.status == "deleted": raise HTTPException(...)` in these 4 handlers with `project = await _get_active_project_or_404(db, project_id)`, matching every other read/write route in the file.
fingerprint: 0b16f498f20c963c
source: audit-cleanliness

## T-006
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: aito_shipping._fold duplicates aito_quote_import._fold with a different Unicode normalization form
files: backend/app/services/aito_shipping.py
evidence: backend/app/services/aito_shipping.py:94 · aito_shipping.py:94-97: `def _fold(value): stripped = unicodedata.normalize("NFKD", (value or "").strip().lower()); return "".join(c for c in stripped if not unicodedata.combining(c))`. aito_quote_import.py:73-76: `def _fold(value): decomposed = unicodedata.normalize("NFD", value); return "".join(c for c in decomposed if not unicodedata.combining(c)).lower()`. Both exist solely to do case+accent-insensitive French-label matching, and the shipping module's own docstring at line 96 says 'Same idea as the importer's own `_fold`' — the duplication is acknowledged in comments but never extracted. They differ in normalization form (NFKD vs NFD) and operation order (strip+lower before vs after decomposition), which is harmless for plain accented Latin text but is a real, silent behavioral difference that a future edit to one could accidentally diverge further on. Confirmed with `rg -n 'def _fold' backend/app/services/aito_shipping.py backend/app/services/aito_quote_import.py` -> two separate definitions. SUGGESTED FIX (from audit-cleanliness): Extract one shared `fold_label()` helper (e.g. in a small aito_text_utils module or on whichever of the two files is imported by the other) and have both call sites use it, picking one normalization form deliberately. ORCHESTRATOR NOTE: NFKD vs NFD is NOT a no-op in general (NFKD also applies compatibility folding, e.g. ligatures and full-width forms). Whichever form is chosen, the worker must show the chosen form produces identical results for every label either function is actually called with, or this becomes a behavior change.
fingerprint: 9b986f384d17a272
source: audit-cleanliness

## T-008
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: TaskStepList duplicates the step-row gutter-spacer markup between the impression-meta line and the description line
files: frontend/src/components/aito/TaskStepList.tsx
evidence: frontend/src/components/aito/TaskStepList.tsx:167 · Lines 167-168: `{canTick && <span aria-hidden="true" className="w-4 flex-shrink-0" />}` then `<span aria-hidden="true" className="w-0.5 flex-shrink-0" />` inside the impression-meta block (162-182). Lines 195-196 repeat the identical two spacer elements inside the description block (183-199). The impression-meta block's own comment at 159-161 even says 'Shares the description's gutter exactly (see its comment below)', and the description block's comment at 188-194 explains the same trick in more detail — both comments point at each other instead of the code being factored into one place, so the two literal copies must be kept in sync by hand whenever the gutter widths (w-4/w-0.5/gap-3) change. SUGGESTED FIX (from audit-cleanliness): Extract a small local `<StepGutter canTick={canTick} />` (or a plain constant JSX fragment) used by both the impression-meta `<p>` and the description `<p>`, so the gutter geometry lives in one place.
fingerprint: 7667a68b3b24a2bc
source: audit-cleanliness

## T-010
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: quote_number reaches the Content-Disposition filename unfiltered in get_quote_pdf
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1111 · routes/aito.py:1111-1122 `filename = f"{project.quote_number or project.quote_id}.pdf"` then `headers={"Content-Disposition": build_content_disposition(filename, disposition="inline")}`. quote_number is client-supplied on POST /aito/ with only `max_length=50` and no charset check (schemas/aito.py:223) — unlike quote_id right above it, which is pinned to `^[A-Za-z0-9_-]+$` precisely because it reaches a URL path. build_content_disposition (backend/app/utils/http.py) strips non-ASCII and removes the double-quote and backslash characters, but ASCII control characters survive in the legacy `filename="..."` parameter. Verified in this worktree: build_content_disposition with a value containing a CR LF escape returns `inline; filename="DEV<CR><LF>X-Injected: 1.pdf"; filename*=UTF-8''DEV%0D%0A...` and h11 refuses it with `LocalProtocolError: Illegal header value`, so on this stack the result is an aborted/500 response rather than response splitting — i.e. exactly the unhandled-500 failure mode the helper's docstring says it exists to prevent, plus a latent injection if the ASGI layer's validation ever changes. Same sink at line 1070/1078 for the invoice number (upstream-controlled). SUGGESTED FIX (from audit-security), behaviour-preserving: strip control characters when building the filename at both call sites, e.g. `filename = re.sub(r"[\u0000-\u001f\u007f]", "", f"{project.quote_number or project.quote_id}") + ".pdf"`; optionally also add a charset pattern to quote_number in AitoProjectCreate.
fingerprint: 2a0f269a7c198cdf
source: audit-security

## T-014
priority: P2
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: addNote rollback writes to the depth cache current at failure time, not the one the optimistic row went into
files: frontend/src/components/aito/history/ActivityRail.tsx
evidence: frontend/src/components/aito/history/ActivityRail.tsx:84 · onMutate prepends the placeholder into `['aito-events', projectId, depth]` and onError removes it from `['aito-events', projectId, depth]` — both read `depth` from component scope, and react-query v5's MutationObserver.setOptions forwards the newest render's options to the in-flight mutation, so onError sees the depth at FAILURE time. Sequence: user types a note at depth 'detail' and submits; while the POST is in flight they click the 'Story' depth button; the POST fails. onError filters the placeholder id out of the ['aito-events', id, 'story'] pages (which never contained it) and leaves it in the ['aito-events', id, 'detail'] pages. Unlike onSuccess, onError does not invalidate, and the default staleTime is 60s (App.tsx:109), so switching back to Detail shows a note that was never persisted — an audit timeline asserting an event that does not exist — for up to a minute, while the toast said the save failed and the text was restored to the input for a retry. SUGGESTED FIX (from audit-robustness): Capture the depth in the mutation variables at mutate time and have onMutate/onError both key off that captured value; or have onError invalidate `['aito-events', projectId]` instead of hand-patching one page.
fingerprint: 0238e58a5d9c4630
source: audit-robustness

## T-015
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: the PDF blob object URL is never revoked when the component unmounts before the iframe settles
files: frontend/src/components/aito/PdfPrintButton.tsx
evidence: frontend/src/components/aito/PdfPrintButton.tsx:77 · The unmount cleanup is `if (frameRef.current) { frameRef.current.remove(); frameRef.current = null; }` plus a clearTimeout — it holds no reference to the object URL, and `URL.revokeObjectURL` is only ever reached from `cleanup()` (line 87, scheduled by the onload/openInTab paths) or the catch block (line 146). Sequence: click Print, the fetch resolves and `url = URL.createObjectURL(blob)` runs (line 105), then the operator closes the detail panel before the hidden iframe fires onload and before the IFRAME_LOAD_TIMEOUT fallback — the effect cleanup clears the timer and removes the frame, both onload and the fallback are then short-circuited by `!mountedRef.current`, so nothing ever schedules `cleanup()`. The multi-megabyte PDF blob stays pinned for the lifetime of the tab; repeating this on a long shift (print, close, print, close) accumulates one leaked blob per attempt. SUGGESTED FIX (from audit-robustness): Track the live object URL in a ref alongside frameRef and revoke it in the unmount cleanup (and in the `!mountedRef.current` early return after the fetch). ORCHESTRATOR NOTE: this is a SIBLING of hand-filed T-002 (QuotePrintButton's 60s revoke timer), not a duplicate — different file, different mechanism. Whoever works both should keep the two fixes consistent.
fingerprint: 59dadb0d655eae75
source: audit-robustness

## T-017
priority: P2
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: Zoho comment timestamp/UTC-offset parse-failure fallbacks are untested
files: backend/tests/unit/test_aito_zoho_comments.py
evidence: backend/tests/unit/test_aito_zoho_comments.py:144 · backend/app/services/aito_zoho_comments.py:144-157 (_comment_utc_offset_hours) falls back to DEFAULT_COMMENT_UTC_OFFSET_HOURS and logs a warning when the 'zoho_comment_utc_offset_hours' setting is not a valid float (the `except ValueError` at 155-157). Lines 160-176 (_comment_timestamp) fall back to `datetime.utcnow()` — NOT the org-local conversion — and log a warning when a comment's date+time string matches none of the three known formats (the `if local is None` branch at 174-176). grep across backend/tests/unit/test_aito_zoho_comments.py shows only test_comment_timestamps_convert_from_org_local_time_to_utc_by_default and test_comment_utc_offset_is_read_from_settings_not_hardcoded — both exercise the happy path with a valid numeric offset and a well-formed date/time; neither an unparseable offset setting nor an unparseable comment date/time string is ever fed in. A comment whose Zoho payload has an odd date format would silently mis-timestamp the mirrored event (using the instant of mirroring, not the comment's actual time), which feeds directly into `_is_our_echo`'s time-window comparison and could cause echo-detection false positives/negatives on the timeline. SUGGESTED FIX (from audit-tests): add (1) a case that sets 'zoho_comment_utc_offset_hours' to a non-numeric string (e.g. 'not-a-number') and asserts mirror_comments/_comment_utc_offset_hours falls back to DEFAULT_COMMENT_UTC_OFFSET_HOURS rather than raising; (2) a case with a comment dict whose 'date'/'time' fields match none of the three parsed formats (e.g. date='not-a-date') and assert the mirrored event is still written (no crash) with an occurred_at close to 'now' rather than a wrong historical time.
fingerprint: 1611d198f7ee346c
source: audit-tests

## T-019
priority: P2
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: EventItem's sync.conflict/sync.status_rejected detail line and ElapsedGutter day/hour bucketing are never rendered in any test
files: frontend/src/__tests__/components/AitoActivityRail.test.tsx
evidence: frontend/src/__tests__/components/AitoActivityRail.test.tsx:42 · frontend/src/components/aito/history/EventItem.tsx:42-45 renders the 'ours -> theirs' conflict line for kind 'sync.conflict' or 'sync.status_rejected' (via detailText), and lines 63-72 (ElapsedGutter) compute a human-readable gap using day/hour/minute Intl.RelativeTimeFormat buckets, shown only when showElapsed is true. `grep -rln "sync.conflict\|sync.status_rejected\|showElapsed\|ElapsedGutter" frontend/src/__tests__/` returns zero matches anywhere in the whole frontend test suite — not just the gate-visible subset. AitoActivityRail.test.tsx (the only test that renders EventItem) covers only the 'zoho.comment' detail branch (line 154: "renders the verbatim Books text for an unrecognised zoho.comment"). This is the exact UI surface a user sees when a local decision and Zoho's state disagree during concurrent edits — the multi-user sync work that landed after campaign 1 and is the least-tested code in the feature. A bug that always shows an empty conflict line, or crashes on an unexpected detail shape, would not be caught by any test today. ORCHESTRATOR NOTE: under the corrected coverage gate, history/EventItem.tsx is now the WEAKEST in-scope frontend file (66.66% stmts), which independently corroborates this finding. SUGGESTED FIX (from audit-tests): Add cases to AitoActivityRail.test.tsx (or a new AitoEventItem.test.tsx if EventItem is exported standalone): (1) render an event with kind 'sync.conflict' and detail={ours: 'accepted', theirs: 'declined'} and assert the rendered text contains 'accepted' and 'declined' in order; (2) same for 'sync.status_rejected'; (3) render two consecutive events with showElapsed=true whose occurred_at values differ by >1 day, >1 hour (but <1 day), and <1 minute, and assert the day/hour bucket text appears for the first two and no gutter row renders for the third (seconds < 60 returns null).
fingerprint: de520d7793faf967
source: audit-tests

## T-034
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 7
last_touched_iteration: 7
title: max_length=10_000 description cap is a repeated magic number (and repeated comment) instead of a named constant
files: backend/app/schemas/aito.py
evidence: backend/app/schemas/aito.py:196 · The literal `10_000` is hardcoded as a bare `max_length=10_000` in ten separate `Field(...)` declarations in this file: AitoTaskCreate's four description fields (lines 201-204) - `scan_description: str | None = Field(default=None, max_length=10_000)` / `modelisation_description` / `impression_description` / `usinage_description`; AitoTaskUpdate's identical four (lines 214-217, same four field names and same `Field(default=None, max_length=10_000)`); AitoProjectCreate.description at line 231 - `description: str = Field(min_length=1, max_length=10_000)`; and AitoProjectUpdate.description at line 350 - `description: str | None = Field(default=None, min_length=1, max_length=10_000)`. The explanatory comment is also copy-pasted verbatim twice: lines 196-197 above AitoTaskCreate ('10_000 is generous headroom over anything a human types - it exists to keep a pathological payload from ballooning the row or the AI summarizer's prompt.') and again at lines 229-230 above AitoProjectCreate.description, word for word. Confirmed exhaustive with `rg -n '10_000' backend/app/schemas/aito.py` -> exactly these 10 lines. IMPORTANT - the per-model redeclaration itself is DELIBERATE and must NOT be touched: AitoTaskCreate and AitoTaskUpdate each define their own bounded Field precisely so that AitoTaskBase (and AitoTaskResponse, which inherits from it) stays unbounded on the read path - an earlier attempt in this same campaign (T-011) put the bound on AitoTaskBase and it made GET /aito/{id}/tasks 500 on a legacy over-cap row; that was caught by the blind verifier, fixed, and pinned. Re-consolidating the four fields onto a shared base Field would reintroduce that exact regression. The only thing to consolidate is the bare literal `10_000` and its duplicated comment, not the field declarations. FIX: add one module-level constant near the top of the file, e.g. `MAX_DESCRIPTION_LENGTH = 10_000` with the rationale comment, then replace each of the 10 `max_length=10_000` occurrences with `max_length=MAX_DESCRIPTION_LENGTH`, and delete the now-redundant duplicate comment at lines 229-230. KEEP the field-level 'why redeclared here and not on AitoTaskBase' comments at lines 196-200 and 212-213 exactly as they are - those explain the deliberate redeclaration and must stay. Every field keeps its current class, bound and inheritance; only the literal and the generic 'why 10k' rationale move to one place. NOTE: this file feeds the aito-pydantic-schemas golden - a named constant must produce a byte-identical declared JSON schema, so verify with tools/snapshot.py verify (9/9, no re-record).
fingerprint: ec8ee103297e665f
source: audit-cleanliness

## T-035
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 7
last_touched_iteration: 7
title: summarize_project's docstring says it exists 'for the create drawer' but a second caller was added since
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:882 · Current docstring, routes/aito.py:882-884, on `async def summarize_project(...)`: '"""French project summary for the create drawer. Registered before the /{project_id} routes on purpose - a literal segment after a parametric route would 422 instead of matching."""'. This names only the create drawer as the reason the endpoint exists. But frontend/src/components/aito/ProjectDetailPanel.tsx:858-865 also calls this same endpoint, from `regenerateMutation`, and its own comment already says so: '// Regenerates the description from the live tasks through the same stateless /aito/summarize endpoint the creation drawer uses, then saves immediately through the manual-edit path...' followed by `mutationFn: () => api.summarizeAitoProject(tasks.map(taskDraftToTaskCreate)),`. `git log -p --follow -- backend/app/api/routes/aito.py | grep -n 'create drawer'` shows this backend docstring line was written once and never revised. A sibling comment was deliberately corrected for exactly this reason during this same campaign: BASELINE-CHANGELOG.md's T-011 entry was fixed by T-027/T-031 specifically to name both /aito/summarize call sites - but that fix only touched the changelog prose, not this route's own docstring, which still reads as if the create drawer is the only caller. FIX: reword the docstring to name both callers, following the same wording convention the campaign already used, e.g. 'French project summary, used by the create drawer and by ProjectDetailPanel's description-regenerate action. Registered before the /{project_id} routes on purpose - a literal segment after a parametric route would 422 instead of matching.' Comment-only change; no code touched. WARNING: this docstring is a ROUTED handler's docstring, which FastAPI publishes as the endpoint's OpenAPI description, so it WILL move the aito-openapi golden. That golden has no changelog entry authorising a move for this - report the move rather than re-recording it.
fingerprint: 5f9b280dd4d636aa
source: audit-cleanliness

## T-039
priority: P2
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 7
last_touched_iteration: 7
title: createMutation never sends shipping fields - the manual create-with-shipping payload path is completely untested
files: frontend/src/hooks/useAitoPageMutations.ts
evidence: frontend/src/hooks/useAitoPageMutations.ts:98 · coverage/coverage-final.json branch id 10 on useAitoPageMutations.ts line 98: counts=[0,11] - the truthy arm of `...(shipping ? shippingPayload(shipping) : {})` (line 98) is NEVER taken across the whole 799-test aito suite; every call to createMutation.mutationFn in the tests passes shipping=undefined. `grep -n 'createMutation|deleteMutation' frontend/src/__tests__/hooks/useAitoPageMutations.test.tsx` -> no matches (that file only tests importMutation's importableShipping gate). `grep -n 'onCreate\b' frontend/src/__tests__/components/NewProjectDrawer.test.tsx` shows onCreate is always a bare `vi.fn()` mock, so the drawer's own 'hands the shipment to onCreate' test (line 608) never reaches the real createProject/createMutation code. AitoPage.test.tsx's own createProject() helper (lines 162-177) never fills in a shipping block. So a regression that drops shipping from the manual-create POST body (e.g. swapping `shipping` for `!shipping`, or breaking shippingPayload) would pass every existing test while silently shipping a project with no delivery address attached. FIX: in frontend/src/__tests__/hooks/useAitoPageMutations.test.tsx add a describe('createMutation') block calling createMutation.mutate with a filled ShippingDraft and asserting api.createAitoProject's body includes shipping_island/shipping_first_name/shipping_last_name/shipping_phone/shipping_price (mirroring the existing importMutation shipping assertions in the same file); alternatively extend AitoPage.test.tsx's createProject() helper with a shipping-filled variant and assert the POST body via a captured spy.
fingerprint: ff7e842bb60968ce
source: audit-tests

## T-040
priority: P2
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 7
last_touched_iteration: 7
title: Board load-failure Retry button's onClick (aitoQuery.refetch) is rendered but never actually clicked
files: frontend/src/pages/AitoPage.tsx
evidence: frontend/src/pages/AitoPage.tsx:300 · coverage/coverage-final.json statement id 68 on AitoPage.tsx: {start:{line:300,column:53},end:{line:300,column:74}} count=0 - the arrow body `() => aitoQuery.refetch()` inside `<Button variant="secondary" onClick={() => aitoQuery.refetch()}>` (line 300) is never invoked. frontend/src/__tests__/pages/AitoPage.test.tsx lines 196-203 only assert the button and its role exist (`screen.getByRole('button', { name: 'Retry' })`) after a 500 response; it never clicks it or asserts a second fetch happens. A regression that wires the button to the wrong query, a no-op, or breaks refetch would leave a user permanently stuck on the error screen with no test catching it. FIX: extend the existing 'shows the load-failed error state' test (around line 196) to swap the mocked handler back to a 200 response after clicking Retry, and assert the board content (e.g. a known project's description) appears once refetch resolves.
fingerprint: f937c5d195215312
source: audit-tests

## T-041
priority: P2
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 7
last_touched_iteration: 7
title: TrashGrid's onRetry wiring to trashQuery.refetch() is never exercised through AitoPage
files: frontend/src/pages/AitoPage.tsx
evidence: frontend/src/pages/AitoPage.tsx:341 · coverage/coverage-final.json statement id 69 on AitoPage.tsx: {start:{line:341,column:25}} count=0 - the arrow body `() => trashQuery.refetch()` passed as onRetry to `<TrashGrid .../>` (line 341) is never invoked. `grep -n 'onRetry|Retry' frontend/src/__tests__/components/AitoTrashGrid.test.tsx` shows TrashGrid's own test only asserts a mocked `vi.fn()` onRetry is called (lines 108-112) - it never renders through AitoPage, so the REAL wiring at line 341 is untested. A regression pointing onRetry at the wrong query key (e.g. 'aito-projects' instead of 'aito-trash') would silently break the trash view's error recovery with nothing catching it. FIX: add a test to AitoPage.test.tsx that switches to the trash view, mocks the trash endpoint to 500 then 200, clicks the Retry button TrashGrid renders, and asserts the trashed project appears once the retry succeeds.
fingerprint: 54b19cee94eb7bfd
source: audit-tests

## T-042
priority: P2
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 7
last_touched_iteration: 7
title: NewProjectDrawer's onClose (Cancel/dismiss) callback from AitoPage is never invoked in any test
files: frontend/src/pages/AitoPage.tsx
evidence: frontend/src/pages/AitoPage.tsx:389 · coverage/coverage-final.json statement id 71 on AitoPage.tsx: {start:{line:389,column:53},end:{line:389,column:74}} count=0 - the arrow body `() => setShowModal(false)` inside `{showModal && <NewProjectDrawer onClose={() => setShowModal(false)} onCreate={createProject} />}` (line 389) is never run. Every AitoPage test that opens the drawer (AitoPage.test.tsx's createProject() helper, AitoPageClientSync.test.tsx's openDrawer()) always proceeds to submit or leaves the drawer open; none clicks Cancel, presses Escape, or otherwise triggers a dismissal to confirm the modal actually closes and showModal really flips back to false. A regression breaking this wiring (e.g. passing the wrong handler, or NewProjectDrawer's internal useDismissableDialog losing its onClose) would leave the create drawer permanently stuck open for anyone who tries to cancel, undetected. FIX: add a test that opens the drawer via the 'Project' button, dismisses it (Escape key or the drawer's own close control), and asserts the drawer unmounts (e.g. the 'Client account' text disappears) and the board is interactable again, without calling api.createAitoProject.
fingerprint: b5a27a299925c2fd
source: audit-tests

## T-043
priority: P2
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 7
last_touched_iteration: 7
title: mirror_comments silently drops any Zoho comment missing comment_id, contradicting the module's own LOSSLESS guarantee, with no test and no logging
files: backend/app/services/aito_zoho_comments.py
evidence: backend/app/services/aito_zoho_comments.py:214 · backend/app/services/aito_zoho_comments.py:212-215: `for comment in comments:` / `comment_id = comment.get("comment_id")` / `if not comment_id:` / `continue` - a comment payload from Books with no comment_id key (or an empty one) is skipped with ZERO logging and no event recorded. The module docstring (lines 1-6) explicitly promises 'CLASSIFICATION IS BEST-EFFORT AND LOSSLESS', but this path is neither logged nor tested: `grep -n 'comment_id' backend/tests/unit/test_aito_zoho_comments.py` shows every fixture supplies a comment_id (c-1, c-dup, c-2, c-3, c-tz-default, c-tz-configured) - none omits it. If Books ever returns a comment without an id (a future API version, or a malformed webhook payload), it vanishes from the timeline with no trace, which is exactly the 'lossless' promise this path breaks silently. FIX: add a test asserting mirror_comments(db, project, [{'description': 'no id', 'date': '2026-01-01', 'time': '10:00'}]) writes zero events and returns 0 - pinning the current drop-silently behavior EXPLICITLY rather than leaving it implicit. Whether a logger.warning should also fire on this path (to match the 'lossless' claim) is a PRODUCTION change and must be decided separately, not folded into the test task.
fingerprint: 240ce189e13f6924
source: audit-tests

## T-045
priority: P2
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 7
last_touched_iteration: 7
title: run_sync_once reads project.id after sync_project may have rolled the session back, losing the failure state it just wrote
files: backend/app/services/aito_quote_sync.py
evidence: backend/app/services/aito_quote_sync.py:1422 · `await _apply_rules(db, project, await _summary_for(db, project.id))` touches project.id (and _apply_rules then reads project.board_column / quote_status) immediately after `await sync_project(db, project)`. sync_project's comment-mirror handler and _terminal_error both call _rollback_after_terminal_failure, and Session.rollback() EXPIRES every attribute - confirmed empirically by the auditor: a bare `p.id` read after `await session.rollback()` raises MissingGreenlet: greenlet_spawn has not been called. sync_project only un-expires the row as a side effect of a record() flush, which it SKIPS in exactly two cases: the comment-mirror block (rolls back on a real zoho_comment_id IntegrityError, then just sets quote_sync_failures = 0 and returns) and _terminal_error when the sync.failed record is deduped (`if not already_in_error or previous_sync_error != ...`). In those cases this line raises MissingGreenlet, the surrounding `except Exception` rolls back and logs 'Aito quote sync failed to commit project %s' - so the 'error' state and message this tick computed are NEVER PERSISTED (the card shows no failure, the worker retries and re-spends Books calls next tick) and the operator is pointed at a commit problem that never happened. FIX: use the loop's own `project_id` int instead of `project.id`, and re-fetch the row with `await db.get(AitoProject, project_id)` after sync_project returns, before _apply_rules, so no possibly-expired instance is touched.
fingerprint: 1e4531679f997e3e
source: audit-robustness

## T-058
priority: P3
status: TRIAGED
attempts: 0
round: 3
first_seen_iteration: 12
last_touched_iteration: 12
title: Docstring line citations 'aito.py:744' and 'aito.py:1726-1730' no longer point at the commit/IntegrityError code they describe
files: backend/tests/unit/test_aito_active_quote_index_migration.py
evidence: backend/tests/unit/test_aito_active_quote_index_migration.py:219 · Line 219: 'race each other into `uq_aito_project_active_quote` at commit (aito.py:744)' - but aito.py:744 is now inside list_projects' query-building comment about flag ordering ('Ranked WITHIN each column, and display-only...'), NOT the create-path commit/except IntegrityError block, which is now at aito.py:923-928. Line 245 in the same file: 'T-001, the restore side (aito.py:1726-1730 in the evidence trail)' - aito.py:1726-1730 is no longer restore_project's except IntegrityError block, which is now at aito.py:2160-2164 (restore_project itself starts at line 2111). Confirmed by reading both cited line ranges in the current file and comparing to what the docstrings describe. These two were flagged as known pre-existing decay in T-057's brief ('do not fix these... recorded in the final report as a known decay problem') and were deliberately left unfixed through loop 12, so they are still live in the tracked file at HEAD. FIX: update the citations to the current line numbers - 'aito.py:744' -> the except IntegrityError block in create_project (currently aito.py:923-928), and 'aito.py:1726-1730' -> restore_project's except IntegrityError block (currently aito.py:2160-2164). Comment-only change, no behavior impact. NOTE FOR WHOEVER WORKS THIS: line numbers in this repo have decayed repeatedly across the campaign; consider citing a FUNCTION NAME plus a distinctive code fragment instead of a line number, so the citation cannot go stale the next time a docstring above it changes length.
fingerprint: 50d3c644ace7e3f9
source: audit-cleanliness

## T-059
priority: P3
status: TRIAGED
attempts: 0
round: 3
first_seen_iteration: 12
last_touched_iteration: 12
title: Comment cites 'core/database.py:220' for get_db's rollback-on-exception, but get_db is now at line 224
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1567 · Line 1567: 'Marking pending ahead of a possible 422 is safe - get_db rolls back on ANY exception (core/database.py:220), so a rejected PATCH persists nothing, including this mark.' backend/app/core/database.py:224 is `async def get_db() -> AsyncSession:` - the citation is 4 lines short of its target. This is the third citation T-057's brief explicitly logged as pre-existing decay and left unfixed. FIX: update the citation to core/database.py:224, or better, cite `get_db` by name rather than by line so it cannot decay again.
fingerprint: 30916e5286d82a15
source: audit-cleanliness

## T-060
priority: P3
status: TRIAGED
attempts: 0
round: 3
first_seen_iteration: 12
last_touched_iteration: 12
title: update_project's top-of-function version check has no pointer to the atomic re-check that follows it
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1838 · Line 1838: `if payload.expected_version is not None and payload.expected_version != (project.version or 0): raise HTTPException(...)` carries NO comment at all. The atomic re-check 35 lines later (line 1873, `_claim_expected_version`) DOES explain the relationship in its own comment: 'Re-assert the guard here, ATOMICALLY... the top-of-function compare above is a plain SELECT and only fast-fails the common case' (lines 1867-1872). So the two-guards-for-one-invariant design is documented ONLY at the second site - a reader who stops at the first raise (a plausible reading order, since it looks like a complete, self-contained guard) has no signal that it is merely an optimistic fast-path and that a real atomic guard follows. The risk is future-facing: someone tidying up 'duplicate' validation could delete either guard without realising the pair is deliberate. FIX: add a one-line comment above line 1838 noting it is a fast-path only and pointing forward to `_claim_expected_version` for the atomic re-check that actually closes the race, mirroring the pointer already present at the second site.
fingerprint: 5a35013a99229f23
source: audit-cleanliness

## T-061
priority: P2
status: TRIAGED
attempts: 0
round: 3
first_seen_iteration: 12
last_touched_iteration: 12
title: broadcast / broadcast_aito / broadcast_to_user repeat the same connection-loop-and-cleanup body three times
files: backend/app/core/websocket.py
evidence: backend/app/core/websocket.py:52 · broadcast() (lines 52-69), broadcast_aito() (lines 71-118) and broadcast_to_user() (lines 120-154) each INDEPENDENTLY re-implement the identical shape: `if not self.active_connections: return`, `data = json.dumps(message)`, `async with self._lock:` guarding a `disconnected = []` accumulator, a `for connection in self.active_connections: try: await connection.send_text(data) except Exception: disconnected.append(connection)` loop (with an extra continue-based filter predicate inserted in the latter two), then the same `for conn in disconnected: if conn in self.active_connections: self.active_connections.remove(conn)` cleanup. The ONLY real variance across the three is which predicate (none / aito_read / bambuddy_principal_user_id == user_id) gates a connection before send_text. broadcast_aito was added by THIS campaign (T-038) as a deliberate near-copy rather than a generic primitive, on the reasoning that a predicate API would leak ConnectionManager's internal state contract across the module boundary - that reasoning was sound for a single added method, but with three near-copies now standing the balance has shifted. FIX: extract the shared send-and-cleanup loop into ONE PRIVATE helper, e.g. `async def _broadcast_filtered(self, message, predicate=lambda conn: True)`, and have all three call it with their own predicate - private, so the internal-contract objection does not apply. Mechanical and behavior-preserving IF each call site's predicate reproduces exactly the current filter (none / aito_read defaulting TRUE for an unstamped connection / user_id match). IMPORTANT: this file is SHARED, cross-feature infrastructure used by printer status, print start/complete, archive events, queue toasts and spool warnings. It is outside the campaign's Aito fence and outside both coverage globs, so no ratchet measures it - any work here needs deliberate tests and a scope decision from the user first.
fingerprint: fad2a4e97703448e
source: audit-cleanliness

## T-064
priority: P2
status: TRIAGED
attempts: 0
round: 3
first_seen_iteration: 12
last_touched_iteration: 12
title: connection is admitted to the broadcast list before aito_read is stamped, and broadcast_aito defaults unstamped sockets to permitted
files: backend/app/api/routes/websocket.py
evidence: backend/app/api/routes/websocket.py:110 · THIRD INCOMPLETENESS IN T-038, and the one the iteration-9 verifier explicitly cleared as harmless - this auditor disagrees, with an argument worth weighing. The socket joins ws_manager.active_connections at line 110 (`await ws_manager.connect(websocket)`) but websocket.state.aito_read is not written until line 141, and for any real user principal there is an AWAITED DB ROUND TRIP in between (`async with async_session() as db: principal_user_id, aito_read = await _resolve_principal_and_aito_read(principal, db)`). During that await, broadcast_aito treats the socket as PERMITTED because it fails OPEN: `if not getattr(connection.state, "aito_read", True): continue` (core/websocket.py:109). So a principal denied AITO_READ - the default Viewers group - receives any aito_changed (project_id + action + the acting operator's username) or aito_presence_state (full username->project-id viewer map) that fires inside its own connect window, and CAN FARM THE WINDOW BY RECONNECTING IN A LOOP. The docstring at core/websocket.py:88-97 argues the True default 'is the safe direction', but the only thing it protects is one about-to-be-permitted connection missing one message, while what it costs is delivery to a connection that is about to be refused. FIX: set websocket.state.aito_read = False (Starlette's state is writable before accept()) BEFORE the ws_manager.connect(websocket) call, and change the getattr default in broadcast_aito to False so an unstamped socket is never fanned out to. NOTE the trade-off the iteration-9 verifier established and that this fix inverts: the True default is also what guarantees no OTHER feature's broadcast is ever silently muted by an unstamped connection - verify that property still holds after flipping the default, since broadcast_aito is the only caller of the getattr but a future filtered fan-out might not be.
fingerprint: cc2ae7bfb800edaf
source: audit-security

## T-074
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: print() object-URLs the fetched blob without pinning its MIME type before loading it same-origin
files: frontend/src/components/aito/PdfPrintButton.tsx
evidence: frontend/src/components/aito/PdfPrintButton.tsx:116 · url = URL.createObjectURL(blob); frame = document.createElement('iframe'); // line 117, no sandbox attribute element.src = objectUrl; document.body.appendChild(element); // line 152-153 window.open(url, '_blank'); // line 103 (openInTab fallback) · fix: re-wrap the bytes before creating the URL — `const pdf = new Blob([await blob.arrayBuffer()], { type: 'application/pdf' })` — so the object URL's type is fixed by this component rather than inherited from the response's Content-Type; provable by a case in src/__tests__/components/AitoQuotePrintButton.test.tsx that resolves fetchPdf with a `new Blob(['<script>'], {type: 'text/html'})` and asserts the blob handed to URL.createObjectURL has type application/pdf. Defence-in-depth only: backend/app/api/routes/aito.py currently hardcodes media_type="application/pdf" on both quote.pdf and invoice.pdf, and browsers key blob-URL rendering off the blob's type rather than sniffing, so there is no live exploit path today — the value is that this component is documented as the generic 'identical for any PDF' helper (its own header comment), so a future fetchPdf whose response carries text/html would silently turn line 152 into a same-origin script-execution sink with full access to the parent document.
fingerprint: f6266fa5579227a5
source: audit-security

## T-093
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 4
last_touched_iteration: 4
title: the prefetch dwell timer is not cleared when the search term changes
files: frontend/src/components/aito/QuoteResultList.tsx
evidence: frontend/src/components/aito/QuoteResultList.tsx:62 · `useEffect(() => setHighlighted(-1), [debouncedQuery]);` (line 62) resets the highlight when a new search lands but leaves `prefetchTimerRef.current` armed — only `highlight()` and the unmount cleanup clear it. Hover a row, then keep typing: 250ms later `debouncedQuery` changes and a new result set renders, and the still-pending 200ms timer fires `prefetch(quote.id)` for a quote from the ABANDONED result set, spending a GET /zoho/quote-preview round trip against the rate-limited Books API for a row nobody is looking at. This is a different trigger from the already-recorded selection case (which fires from the `if (selected)` early return) — this one fires on every abandoned search, not once per selection. · fix: clear prefetchTimerRef in the same effect that resets the highlight
fingerprint: eb3ee30f23df664b
source: audit-robustness


---

# APPENDIX B — how to reproduce every gate

Recorded here because `BASELINE.md` does not survive the worktree.

**Frontend Aito coverage gate** — the campaign's only ratchet. Run from `frontend/`, ~20s; totals land in `frontend/coverage/coverage-summary.json`:

```
npx vitest run --coverage --coverage.reporter=json-summary --coverage.reporter=text --coverage.all=true \
  --coverage.include='src/utils/aito*.ts' --coverage.include='src/hooks/useAito*.ts' \
  --coverage.include='src/pages/AitoPage.tsx' --coverage.include='src/components/aito/**' \
  $(grep -rlE "components/aito|utils/aito|hooks/useAito|pages/AitoPage" src/__tests__ | sort)
```

Two properties of this gate are deliberate and **both must be preserved**:
1. `--coverage.all=true` measures every in-scope source file, so a file no test imports still counts. Coverage cannot be inflated by avoiding a file.
2. **The test set is discovered by grep, not by filename glob.** Every test file importing an Aito module is included whatever it is called, and a new test file is picked up automatically. Campaign 1 used a `src/__tests__/components/Aito*` prefix instead; it silently excluded 14 real passing test files, reported the ratchet 164 statements too loose, and reported `NewContactForm.tsx` as "0%, 199 lines entirely untested" when it was in fact 93.75% covered. **Do not replace the grep with a hand-written path list.**

**Everything else:**
- Frontend full suite: `cd frontend && npx vitest run`
- Frontend static gate: `cd frontend && npm run build` — this is the real one; `npx tsc --noEmit` misses module-resolution errors and never type-checks `src/__tests__` (excluded by `tsconfig.app.json`). **Dirties ~74 files under `static/`; run `git checkout -- static/` afterwards and never stage them.**
- Frontend lint: `cd frontend && npm run lint`
- i18n parity: `cd frontend && node scripts/check-i18n-parity.mjs` — 13 locales, 6623 leaves each at HEAD
- Backend suite: `./venv/bin/python3 -m pytest backend/tests/ -q -n 30 -p no:cacheprovider --ignore=backend/tests/unit/services/test_bambu_ftp.py`
- Backend lint: `ruff check backend/ && ruff format --check backend/`
- Golden probes: `./venv/bin/python3 tools/snapshot.py verify` — 9 probes, any diff is a behavior change
- Surface: `bash tools/gen_surface.sh > /tmp/s.md && diff /tmp/s.md SURFACE.md` — must be empty

**Environment:** `./venv/bin/python3` in the worktree is a **symlink** to the main checkout's venv. `frontend/node_modules` was installed with `npm ci`. `.coverage` (160KB binary) is **tracked** in this repo and is dirtied by any backend coverage run — `git checkout -- .coverage`, never stage it.

---

# APPENDIX C — the known-flaky list at exit

Unchanged from BASE: **none added by this campaign, none removed.** A failure in any of these is not evidence of a regression until an isolated re-run of that file alone also fails.

**Frontend**
- `PrintModal.test.tsx` — by far the most frequent. **Character changed this campaign:** documented as "fails under load, passes 75/75 alone", it was repeatedly observed failing *in isolation* too (pass / fail / pass across three consecutive isolated runs). Worth investigating independently of this work.
- `ModelViewerModal.test.tsx` — "opens the selected local slicer from the Bambuddy dropdown"; 31/31 alone
- `LoginPage.test.tsx` — "does not redirect an unauthenticated visitor"; 31/31 alone
- `ImportQuoteDrawer.test.tsx` — "shows the parsed tasks and pre-fills the description"; load-only, 15/15 alone. First observed this campaign, in a file the campaign never touched.
- `SettingsPage`, `QueuePage`, `CalculatorPage` — occasionally, under heavy concurrent load

**Backend** (no backend file changed in this entire campaign, so none of these can be its doing)
- `test_aito_quote_sync.py::test_wake_drains_a_pending_project_without_waiting_for_the_interval`
- `test_print_archive*::test_loops_per_plate_when_cross_class_with_plate_zero`
- `test_scheduler_concurrent_dispatch.py::TestSharedLibraryRow::test_plain_library_file_still_fans_out_in_parallel`
- `test_library_slice_api.py::TestSliceArchiveResliceModel::...`
- `test_slicer_stall_timeout.py::TestSliceIsNotCutOffWhileProgressing::test_a_slow_slice_that_reports_progress_completes` — load-only, first observed this campaign
- `test_extract_video_last_frame.py` (2 tests) — **environmental, not a flake**: hardcodes `/usr/bin/ffmpeg`; this machine has `/opt/homebrew/bin/ffmpeg`. Fails only under `-n 30`.

Four of the backend entries are SQLAlchemy/concurrency-shaped and surface only under `-n 30`.

**Not a flake, a time-of-day bug:** `backend/tests/unit/services/test_plug_energy_history.py::test_nothing_derivable_before_the_first_midnight` fails **deterministically** for ~30 minutes a day around Europe/Berlin midnight (the fixture pins `TZ=Europe/Berlin`; the "this morning" snapshot at now−30min lands before local midnight). Pre-existing and out of scope for all three campaigns.

**Dependency vulnerabilities, deliberately untouched** by standing user decision across all three campaigns: starlette 0.52.1 (6 PYSEC), dompurify (moderate XSS — round 2 confirmed no reachable path in this scope), react-router (high; RSC-mode CSRF, and that mode is unused here). A bump touches the whole app and needs its own dedicated pass.
