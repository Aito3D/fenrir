# Refactor-loop campaign 33 — the Aito board and everything behind it — final report

Date: 2026-11-17. Branch `auto-refactor-loop-a33` in `../bambuddy-refactor-a33`, based on local main `2c8d80901`
(BASE = tag `a33-base`, setup commit `43d0c7d11`). Ran in parallel with the order-board campaign O3 under its own names.
Ask (2026-11-16): "check the Aito page, look at each feature and optimize everything, fix all the bugs and issues it can
have — I need something bulletproof to errors and bugs." Zero feature changes except what the user approved one by one.

Full loop state (plan with per-task evidence, the 43-item TRIAGE.md, verifier log, raw auditor findings, briefs) is
copied to `plans/refactor-campaign33/` in the main checkout.

## Outcome

| | |
|---|---|
| Iterations run | 9 (8 with commits + 1 empty), budget 12 |
| Survey rounds | 3 of 3 (MAX_ROUNDS) |
| Why it ended | **MAX_ROUNDS** — round 3 was productive, its plan was worked, no rounds left |
| Commits | 1 setup + 8 squashed iteration commits (`a33-loop-1` … `a33-loop-8`) |
| Tags | `a33-base`, `a33-loop-1` … `a33-loop-9` (`a33-loop-9` = same tree as `a33-loop-8`) |
| Tasks | 22 DONE · 0 OPEN · 0 BLOCKED · 3 WONTFIX-AUTO (2 duplicates + 1 deferred feature) |
| Triaged for humans | 43 (TRIAGE.md) |
| Coverage, backend scoped statements | 98.06% (9558/9747) → **98.19%** (9674/9852) |
| Coverage, frontend scoped statements | 94.57% (6376/6742) → **94.73%** (6422/6779) |
| Snapshot probes | 35/35 matching (9 goldens re-recorded, each under a user-approved changelog entry) |
| SURFACE.md | changed only by approved additions (see below) |
| known_broken | `test_printer_hours_migrations.py::test_migration_backfills_calibrated_at_from_offset` before → still (date-boundary; out of scope) |
| Tests | backend 27,969 → 28,007 passing (+38); frontend 11,401 → 11,417 (+16) |
| Diff | 63 files, +1,800 / −148 (production +413/−100 in 18 files; tests +871/−29) |

Every iteration passed the blind verifier (build, lint, both type checks, knip, i18n parity, full suites, coverage
ratchet, 35 probes, surface diff). Three verifies failed first and were fixed before tagging: loop-2 (a test still
pinned the old 5xx message), loop-6 (a commit overwrote another task's changelog line), and loop-3 once ran out of CPU
(load 67–148) and was re-run.

## What changed (all user-approved behavior changes, recorded in BASELINE-CHANGELOG.md)

**.3mf import into the new-project modal (new, never audited before)**
- T-632 the real slicer call is now tested (it never ran in any test).
- T-646 imports share the slicer's 2-slot limit instead of piling onto the sidecar.
- T-647 Retry after "Import not found or expired" re-uploads and re-slices instead of repeating the error forever.
- T-648 a failed printers/filaments list shows an error with Retry instead of an endless "Slicing…" spinner.
- T-653 zip-bomb guard: a thumbnail over 2 MiB comes back empty, a `model_settings.config` over 8 MiB is refused (413);
  reads are capped even when the zip header lies.
- T-654 the import has its own 512 MiB upload cap (was 2 GiB held in memory). The "one import per user" 409 was
  **withheld**: it would block re-picking a file and, with auth off, block every user.
- T-685 new `DELETE /aito/import-3mf/{job_id}`: closing the panel, picking another file or retrying cancels the old job.
- T-696 the cancel really aborts the sidecar request (it used to wait for the slice to finish); this edits the shared
  `slicer_api.py`, so project slices cancelled at shutdown also stop at once.

**Zoho Books and Heimdall clients**
- T-641 malformed Heimdall replies (e.g. `{"error":"bad gateway"}`) map to typed errors instead of crashing a pass.
- T-642 a gateway's non-JSON 429 now triggers the rate-limit freeze; non-JSON 5xx message is "Zoho Books error (HTTP n)".
- T-682 fixes a regression T-642 introduced: a non-JSON 404 (and other non-429 4xx) is transient again, so an edge
  page can no longer mark a live quote "no longer exists".
- T-656 a client id of literally `.` / `..` is refused (409 "Invalid Zoho Books id") instead of hitting the wrong path.
- T-655 the unlinked-deposit warning is rate-limited (60/min); past it the warning just hides.

**Deposits and invoices**
- T-657 when Books rate-limits a deposit apply, the sweep/force sync stop and arm the throttle; a timed-out apply is
  recorded as an outcome-unknown deposit event instead of "applied 0".
- T-683 fixes a regression T-657 introduced: deposit events that landed before a mid-sweep 429 are committed at once.
- T-660 "refused" now means refused; force sync flags an outcome-unknown deposit as failed with the new reason
  "Outcome unknown — check the invoice in Zoho Books".
- T-684 creating an invoice records outcome-unknown deposits (existing warning toast) and arms the throttle on 429;
  retainer rows gain an `outcome` field.
- T-699 a deposit skipped by a 429 reads `not_attempted`, not `refused`.
- T-698 a deposit Books refuses gets one timeline entry, "Zoho Books refused the deposit for the invoice" (once, not
  hourly; no toast).

**Board toasts (new Zoho-result toasts)**
- T-638 / T-686 the acting operator no longer gets a second toast for their own email/invoice/payment-link/counter
  payment; colleagues still do. (Verified: those kinds are only recorded on success, so no failure is hidden.)
- T-649 the first Zoho toast of a kind shows at once; the rest of a 1.5 s burst fold into one summary toast (22 new
  translated keys). Known wording quirk: a burst of 3 reads "Payment link ready for A-1" then "2 payment links ready".

**API/SURFACE additions:** route `DELETE /api/v1/aito/import-3mf/{job_id}` (Aito route count 76 → 77, read-only class),
client method `cancelAito3mfImport`, helpers `record_deposit_application`, `record_deposit_refusal`, field
`AitoRetainerApplied.outcome`, i18n keys `aito.forceSyncReasonOutcomeUnknown`, `aito.history.invoiceDepositRefused`,
22 `aito.zohoToast.*Many_one/_other`, event kind `invoice.deposit_refused`.

## Survey rounds

| Round | Filed (new → plan) | Needed approval | Triaged | Notes |
|---|---|---|---|---|
| 1 | 13 + 2 carried c32 approvals | 12 (10 approved, 2 duplicates) | 11 | .3mf import, toasts, Zoho/Heimdall errors |
| 2 | 6 | 6 (all approved) | 24 | found 2 regressions in this campaign's own fixes (T-682, T-683); security clean |
| 3 | 4 | 4 (all approved; T-695 later deferred) | 8 | found the T-685 cancel gap (T-696); security clean |

## Findings by auditor

| Auditor | Filed to plan | DONE | WONTFIX-AUTO | Triaged |
|---|---|---|---|---|
| audit-security | 3 | 3 | 0 | 0 |
| audit-robustness | 12 | 12 | 0 | 5 |
| audit-cleanliness | 7 | 4 | 3 | 19 |
| audit-tests | 1 | 1 | 0 | 19 |
| survey (c32 approvals) | 2 | 2 | 0 | — |

43 findings triaged this campaign (tests 19, cleanliness 19, robustness 5). All sit in TRIAGE.md with full evidence;
promote one with `python tools/plan.py promote <id> --iteration N` (flag required). Worth a look first:
- T-689 cancelling a .3mf import before its job task starts leaves the job unmarked.
- T-697 the frontend upload has no AbortSignal, so a closed panel still uploads the whole file before the cancel fires.
- T-690 `CompactBoardCard` defeats `CardView`'s memo — every phone/tablet card re-renders on each board render.
- T-652 concurrent per-customer tax-default saves can drop one (read-modify-write of one JSON blob).
- T-650 `extend_quote_expiry()`'s lock pre-check is racy (c32 carry).
- T-670 / T-672 / T-688 untested sweep-429, force-sync failure and create-invoice broadcast paths.

## Left for humans

- **T-695 (deferred feature):** the board poll ships every Done card (and Trash loads every deleted card on open).
  Splitting Done out is a frontend redesign: Done cards also feed the "Show Done (N)" count, search over Done, the
  merge pickers, the import-quote "already imported" marker (double-import guard), panel/`?card=` lookup, and ~30
  writers of the `['aito-projects']` cache. A safe version needs a server-side Done count, a third panel source, one
  shared cache-writer helper and picker reads. Trash is already on-demand (not polled) and can stay.
- **One-import-per-user 409 (T-654 half):** now possible since T-685/T-696 added a real cancel; still needs a decision
  for auth-off installs (owner id is null for everyone).
- **Live checks owed:** nothing here was smoke-tested against real Zoho Books, Heimdall or the slicer sidecar (all
  stubbed). Worth one live pass: a deposit apply on a test invoice, a .3mf import + cancel, and the toast bursts.
- Probe weak spots (stable, pre-existing): `aito-frontend-pure` pins 30 TypeErrors from stale probe fixtures,
  `aito-quote-money` pins 3 AttributeErrors; `tools/gen_surface_aito32.sh` greps a deleted `pushcut.py`.
