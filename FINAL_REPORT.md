# Refactor loop — final report (campaign RV2, Revenue page)

Branch `auto-refactor-loop`, based on upstream `6672584de`. Base tag `refactor-base` (ed4d8c82f).

## Summary

- Iterations run: 2 of 8 · survey rounds completed: 2 of 3
- Commits: 3. They are the setup commit, `loop-1` (64214cad1) and `loop-2` (ea1305de6). This report is a fourth commit.
- Tags: `refactor-base`, `loop-1`, `loop-2`
- **Why it ended:** the user stopped the campaign after iteration 2, before the round-3 survey. It did not converge or hit MAX_ROUNDS or MAX_ITER.
- Diff: 7 files, +229 / −5. Production changes are in `services/revenue/store.py`, `services/revenue/sync.py` and `routes/revenue.py`; the rest is tests and BASELINE-CHANGELOG.md.

## User-approved behavior changes

These are all in BASELINE-CHANGELOG.md:

- **T-010** (approved after the fact): a cash refresh no longer saves an invoice share computed before a scope change. The share is left queued and is re-read later.
- **T-011:** when Zoho re-lists items and the nature or brand of an item changes, the stored invoice shares are cleared.
- **T-012:** when the month check gets a 5xx from Zoho, the month is set to retry and the cash refresh still runs.
- **T-021** (approved after the fact; widens T-011): the T-011 comparison also looks at item name and item type.
- **T-022:** `/pvm` with a `from` date before the revenue history start returns a 422 instead of a 500.

T-020 (the share save re-checks the scope generation at commit time) is covered by the T-010 entry.

## Survey rounds

| Round | Security | Robustness | Cleanliness | Tests |
|---|---|---|---|---|
| 1 | clean | 3 filed (T-010 P1; T-011, T-012 behavior changes, approved) | 3 triaged | 6 triaged |
| 2 | clean | 1 filed (T-022, approved); 3 triaged (T-020, T-021 promoted by the user; T-023 left) | 3 triaged | 4 triaged |

## Findings by auditor

| Auditor | Filed to PLAN | DONE | BLOCKED | WONTFIX-AUTO | Triaged this campaign |
|---|---|---|---|---|---|
| audit-security | 0 | 0 | 0 | 0 | 0 |
| audit-robustness | 6 (4 filed directly + 2 promoted) | 6 | 0 | 0 | 3 (2 later promoted) |
| audit-cleanliness | 0 | 0 | 0 | 0 | 6 |
| audit-tests | 0 | 0 | 0 | 0 | 10 |

- 19 findings were triaged in total. 2 were promoted, so 17 remain in TRIAGE.md.
- TRIAGE.md is untracked and holds the full evidence for each one.
- To work one, run `python3 tools/plan.py promote T-xxx --iteration N`. The `--iteration` flag is required.

## Verification

- **Coverage (scoped statements):** backend 99.05% → 99.06%; frontend 95.21% → 95.21%.
- **Known-broken tests:** none before, none after.
- **Golden probes:** 9/9 match.
- **SURFACE.md:** unchanged.
- **Verifier runs:** each iteration first FAILed because a fix (T-010, then T-021) had no changelog entry yet. After the user approved each one and its changelog entry was committed, the rerun PASSed.
- **Load flakes:** these failed only under full-suite load and passed when run alone: StreamOverlayPage, PrintModal, FileManagerPage, test_aito_routes import_thousand and the terminal-payments lock test.

## Left for humans

- In PLAN.md, no tasks are OPEN, BLOCKED or WONTFIX-AUTO.
- These are the 17 triaged findings, kept here at the user's request:

| ID | Pri | Auditor | File | Finding |
|---|---|---|---|---|
| T-001 | P2 | tests | services/revenue/sync.py | The page-cap guards in the month check and the item listing (`_DayTooLarge`, `ZohoUpstreamError`) are never exercised |
| T-002 | P2 | tests | services/revenue/sync.py | The malformed-row warning and the budget-low paths of the background loop and the item refresh are untested |
| T-004 | P2 | tests | components/revenue/RevenueLabor.tsx | The labor provider's validation bounds, save failure and load-error retry are untested |
| T-005 | P2 | tests | components/revenue/RevenueFixedCosts.tsx | The fixed-costs editor's failure paths and validation are untested (81.66% covered) |
| T-013 | P2 | cleanliness | services/revenue/cohorts.py | `cohorts._shift` duplicates `dates._month_shift` |
| T-014 | P2 | cleanliness | components/revenue/RevenueLabor.tsx | RevenueLabor and RevenueFixedCosts repeat the same load, save, error and retry block |
| T-016 | P2 | tests | components/revenue/RevenueTable.tsx | The checkOk date is formatted in the machine's local timezone, while the test expects 'Nov 18' |
| T-017 | P2 | tests | components/revenue/RevenueChart.tsx | The chart tooltip's MarginBreakdown branch, including the margin-mode case with no costParts, is not asserted |
| T-003 | P3 | tests | api/routes/revenue.py | The from/to date validation (422) and the last-sale loop for dormant products are not covered |
| T-006 | P3 | tests | components/revenue/RevenueMovers.tsx | RevenueMovers tests use a real 20 ms sleep to prove no refetch happens |
| T-007 | P3 | cleanliness | api/routes/revenue.py | `get_items` inlines `series.item_breakdown` instead of calling `_breakdown()` |
| T-008 | P3 | cleanliness | api/routes/revenue.py | The day-range line filter is repeated four times |
| T-009 | P3 | cleanliness | api/routes/revenue.py | `get_pipeline` and `get_funnel` have near-identical route bodies |
| T-015 | P3 | cleanliness | components/revenue/RevenueNotes.tsx | Four files each define an INPUT constant with the same input classes |
| T-018 | P3 | tests | components/revenue/MarginBreakdown.tsx | MarginBreakdown has no unit test; the null-cost fallback and a negative margin are unchecked |
| T-019 | P3 | tests | components/revenue/RevenuePace.tsx | RevenuePace branches (76% covered) past the target, and the no-sales cases, are not asserted |
| T-023 | P3 | robustness | services/revenue/store.py | `revenue_data_stamp()` keys labor on `Settings.updated_at`, which has one-second resolution. A second labor save within the same second leaves the GET / memo stale |

## Caveats

- The share-race fixes (T-010, T-020) assume a single backend process.
- basedpyright was not run in its pinned environment. Locally it reports 75 errors, none of them in touched files, so the CI run is the authority.
- In T-021, an item with no `name` is compared as an empty string. If Zoho ever omits the name, every re-listing would clear the shares again. That costs extra Zoho reads but does not produce wrong figures.
