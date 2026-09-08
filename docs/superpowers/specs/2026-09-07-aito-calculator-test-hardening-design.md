# Aito & Calculator test hardening

Design, 2026-09-07.

## Why this is not "write more tests"

The starting point was measured, not assumed. One instrumented run of each
suite over the two features' scope lists (`tools/coverage_aito.sh`,
`tools/coverage_calc.sh` define those scopes):

| Scope | Statements | Branches |
| --- | --- | --- |
| Aito backend | 99.02% (2925/2954) | 95.84% (738/770) |
| Calculator backend | 99.78% (906/908) | 98.54% (203/206) |
| Both frontends | 94.10% (4691/4985) | 91.17% (4197/4603) |

Twelve refactor campaigns already swept the easy ground. What is left is not a
pool of untested functions:

- The backend's ~30 uncovered statements are mostly `try: await db.rollback()
  / except Exception: pass` guards and a `ValueError` fallback on a settings
  parse. Reaching them proves little and costs a lot of mocking.
- The frontend's 294 uncovered statements are concentrated in canvas drawing
  (`celebration/render.ts`, 81 statements at 2.4%), print/PDF blob plumbing,
  and hold-to-confirm timers — all awkward under jsdom.

Meanwhile the pure logic modules **state invariants in their own comments that
no test enforces as universals**. `sizeMargin` promises "never NaN" and a
result bounded by its two multipliers; `qtyFactor` promises "exactly 1 at
q = 1"; `unitMultiplier` promises "never below 1"; `filamentLineCost` promises
that `computePricing`'s cost part and margin part "split this line exactly".
Every one of those is a universally quantified claim currently checked by a
handful of examples.

So the goal is not a higher percentage. It is: **turn documented invariants
into enforced ones, and make the two stacks prove they still agree.** Coverage
rises as a by-product and is used only as a ratchet against regression.

## Scope

In scope are exactly the files named by the two existing coverage gates, plus
`frontend/src/utils/projectSeed.ts`, which is new and missing from the Aito
list. That omission is itself a finding: the gate's scope list must be
corrected, or the file is invisible to every future ratchet.

Out of scope: the shared spool/filament catalogue, the camera grid, and
`backend/app/core/database.py` (5.8k lines of unrelated migrations, excluded
by the calculator gate for the same reason today).

## Phase 1 — invariant hunt on the pure cores

Highest bug yield. Nothing here mocks a component; it drives pure functions.

### 1.1 The pricing engine (`frontend/src/utils/pricing.ts`)

Properties over generated inputs, including hostile ones — negative costs,
zero and fractional quantities, `NaN`/`Infinity`, an inverted `margin_max <
margin_min` pair, `margin_k <= 0`, `qty_min_factor` outside `(0, 1]`:

- `sizeMargin` is finite for every input, lies within `[mMin, mMax]`, and is
  non-increasing in unit cost.
- `qtyFactor` is exactly 1 at `q = 1`, lies within `[qMin, 1]`, and is
  non-increasing in quantity.
- `unitMultiplier >= 1` always — the discount only ever eats margin, never
  principal.
- `filamentLineCost(w, f, d)` equals `computePricing`'s filament cost plus its
  `margin_filament`, to within float tolerance. This is the comment's own
  claim and the one most likely to rot.
- `discountMatrix` is non-increasing in the discount column, and
  `breakEvenDiscount` round-trips: applying it lands at zero profit.
- `unitPriceCurve` is non-increasing in quantity.
- `computePricing` never returns `NaN` in any money field, and
  `total_ttc >= total_ht` for any non-negative tax.
- The `min_task_price` floor, when it applies, is actually applied.

### 1.2 Differential: `summarise` vs `summariseTasks`

`evaluate` is already pinned exhaustively — `backend/tests/aito_rules_fixture.py`
enumerates the full cartesian product of 8 statuses x 7 columns x 16 pending
sets — so it needs nothing.

`summarise` is not. It is checked against roughly a dozen hand-written shapes,
while the two implementations (`backend/app/services/aito_board_rules.py` and
`frontend/src/utils/aitoBoardRules.ts`) must agree on every field of
`TaskSummary`, including `print_minutes_pending`, which was added recently and
has to be mirrored in four places.

The fixture generator gains a **seeded random corpus**: several hundred
generated task lists spanning null vs zero costs, done flags, quantities,
discounts and rush, emitted into the same JSON contract the frontend replay
test already consumes. A fixed seed keeps it reproducible; regenerating is one
command.

### 1.3 Backend schema and validator fuzzing (hypothesis)

- Every Aito and Calculator Pydantic model: any payload hypothesis can build
  either validates or raises `ValidationError` — never anything else.
- The route layer: a request body that parses must not produce a 500. 4xx is a
  correct answer; a traceback is not.
- The hand-rolled validators — phone, email, `quote_id`'s charset, island keys
  — never raise on adversarial input (control characters, unicode, very long
  strings, empty segments).
- `_validated_shipping`'s merge logic: the six columns are written all-or-none
  for every combination of supplied and stored fields.

### 1.4 Draft and helper layers

Round-trips and total functions, where the code already claims them:

- `taskDraftFromAitoTask` -> `taskDraftToTaskCreate` preserves every priced
  field.
- `parsePhone` -> `formatPhone` round-trips for every country code in the
  table.
- `matchesSearch` never throws and is case- and accent-insensitive as
  documented.
- `followups` and the aging helpers behave across day boundaries and
  timezones — the known Berlin-midnight class of bug.
- `aito_shipping`: every island resolves to exactly one service, labels are
  unique, and `service_for_island` is total over the table.

## Phase 2 — the risky interactive branches

Ranked by uncovered *branches*, because that is where an error path hides,
not by file size:

| File | Missing branches |
| --- | --- |
| `calculator/CalculatorRealityCheckCard.tsx` | 16 |
| `hooks/useProjectTasks.ts` | 15 |
| `aito/ProjectDetailPanel.tsx` | 14 |
| `pages/CalculatorPage.tsx` | 14 |
| `aito/ShippingCard.tsx` | 13 |
| `calculator/MarginCurvePreview.tsx` | 13 |
| `aito/QuoteResultList.tsx` | 13 |
| `calculator/CalculatorSettingsPanel.tsx` | 10 |
| `hooks/useCalculatorState.ts` | 8 |
| `calculator/CalculatorFilamentsPanel.tsx` | 8 |

`CelebrationLayer` (19) and `HoldButton` (14) carry more uncovered branches
than several of these, and are deliberately held back to phase 3: both are
timer- and canvas-driven, so they belong with the other awkward machinery
rather than with the business logic.

These are the paths where a wrong branch loses an operator's edit or misprices
a quote. Each gets tests for its failure and conflict paths specifically:
rejected PATCHes, 409 version conflicts, empty and error query states,
permission-denied renders.

## Phase 3 — the awkward leftovers

- `celebration/render.ts` (81 statements, 2.4%): extract the pure layout and
  physics math — sprite placement, easing, lifetime — into its own module and
  property-test that. The remaining canvas calls stay thin and are exercised
  through a stub 2D context, so the untestable surface shrinks to a few
  `ctx.drawImage` lines instead of the whole file.
- `CelebrationLayer.tsx` (19 branches), `HoldButton.tsx` (14),
  `UnacceptHoldPill.tsx` (15), `PdfDownloadButton.tsx` (39.3% of statements)
  and `usePrintBlob`: blob URLs, print iframes and hold timers, driven with
  fake timers and stubbed object URLs.

## How bugs are handled

Per the agreed rule: a clear defect — a crash, wrong arithmetic, a swallowed
error — is fixed immediately in the same commit as the regression test that
catches it. Anything that changes visible behaviour is **not** fixed silently;
it is written up and brought back for a decision, the way the refactor
campaigns marked approved behaviour changes.

## Verification and the ratchet

- `tools/coverage_aito.sh` and `tools/coverage_calc.sh` are the gates. A
  baseline is recorded at the start; no iteration may lower it.
- `frontend/src/utils/projectSeed.ts` is added to the Aito scope list.
- Both full suites must stay green. Known load flakes (PrintModal,
  ArchivesPage, FileUploadModal) are re-run alone before being believed.
- Property tests are **seeded and bounded**: a fixed seed and a capped run
  count per property, so the suites stay near their current runtime (backend
  ~5 min at `-n 6`, frontend ~60 s) and CI's `pytest-split` duration records
  stay meaningful.
- `hypothesis` goes in `requirements-dev.txt` (CI installs it for the backend
  job); `fast-check` goes in `frontend` dev dependencies.

## Risks

- **Runtime.** Property tests are slower per assertion. Mitigated by the run
  budget above; if a property needs thousands of cases to be meaningful, it
  runs as its own marked test rather than inflating every suite run.
- **Flakiness.** Unseeded generators are a flake source. Every generator is
  seeded explicitly; hypothesis gets a profile with a deadline and no
  database-backed strategies.
- **False findings.** A property that encodes a wrong assumption produces a
  "bug" that is really a mis-stated invariant. Every finding is confirmed
  against the code's own documented intent before anything is changed.

## Not doing

- Chasing the backend's defensive `except: pass` rollback guards to reach
  100%.
- Mutation testing. It would be the natural next step after this, but it is a
  much larger runtime commitment and is better judged once the invariants
  above exist.
- Touching the refactor campaigns' golden snapshots, which are their baseline,
  not a gate on main.
