# TRIAGE (schema v2)

## T-009
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: Collect list renders 'late NaN days' for a non-ISO invoice_due_date
files: frontend/src/components/aito/stats/TodayStrip.tsx
evidence: frontend/src/components/aito/stats/TodayStrip.tsx:120 · `? Math.max(0, Math.round((parseLocalDateKey(brief.today).getTime() - parseLocalDateKey(p.invoice_due_date).getTime()) / DAY_MS))` — parseLocalDateKey does `key.slice(0,10).split('-').map(Number)`, so a Books-formatted '10/02/2026' yields an Invalid Date, the subtraction is NaN, Math.max(0, NaN) is NaN, and the row shows « Late NaN days » while the byWait comparator (b.waitDays - a.waitDays) returns NaN for it and leaves the collect list in arbitrary order. The backend already treats that string as untrustworthy — _overdue wraps date.fromisoformat in try/except for the same field — but this path has no guard. · fix: reuse a parse that returns null for a non-ISO key and fall back to the 0-day branch, the way the invoice_due_date-less case already does
fingerprint: 4c7c39f8873ee797
source: audit-robustness

## T-010
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: Overview peak finding uses the wide fold threshold the chart beside it does not use on a phone
files: frontend/src/components/aito/stats/OverviewScreen.tsx
evidence: frontend/src/components/aito/stats/OverviewScreen.tsx:26 · `if (daily.length > WEEKLY_ABOVE_DAYS) {` picks week-vs-day wording with the 45-day constant only, but ActivityChart folds at `narrow ? WEEKLY_ABOVE_DAYS_NARROW : WEEKLY_ABOVE_DAYS` (31 below 640px). On a phone with a 31–45 day range the chart is titled « per week » and draws weekly bars while the finding above it says « busiest day: 12 September », naming a day that has no bar on the chart — the exact disagreement the exported-constant comment in ActivityChart.tsx says the two must avoid. · fix: share the same narrow media query (or lift the fold decision into one hook both consume) so the finding and the chart agree on the threshold
fingerprint: c9278eb09fc24f72
source: audit-robustness

## T-013
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: the `sum(1 for at in X.values() if _in_range(at, start, end))` count idiom is repeated three times
files: backend/app/services/aito_stats.py
evidence: backend/app/services/aito_stats.py:500 · Identical shape at line 500 (`created = sum(1 for at in born.values() if _in_range(at, start, end))`), line 511 (`accepted=sum(1 for at in accepted.values() if _in_range(at, start, end))`), and line 594 (`declined=sum(1 for at in declined.values() if _in_range(at, prev_start, prev_end))`); confirmed by `grep -n "_in_range("`, which shows the pattern nowhere abstracted despite _in_range already existing as a shared filter primitive. · fix: Add a small `_count_in_range(moments, start, end)` helper and use it at these three call sites; purely a one-line inlining removal, no behavior change.
fingerprint: 84d08ddde326f4e4
source: audit-cleanliness

## T-026
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: Module docstring's "Seven read-only queries" omits the AitoTask query and undercounts the real total
files: backend/app/services/aito_stats.py
evidence: backend/app/services/aito_stats.py:1 · grep -n 'db.execute' -> 5 call sites; _first_moments (L163) runs once per call and compute_aito_stats calls it 4 times (born/sent/accepted/declined, L617-620), so a normal request issues 1 (_active_projects L107) + 4 (_first_moments) + 1 (_scan_stages L223) + 1 (_services L445, queries AitoTask when any card was accepted in the period) + 1 (_tracking L524) = 8 queries in the common case, not seven, and the docstring's source list ('projects, the event log, and tracking-page views') never mentions the fourth source (AitoTask, read via _services) at all. · fix: update the module docstring to name all four sources and correct the count, or note that the count is conditional on the request finding a decided/viewed card
fingerprint: 84e6703184f7e846
source: audit-cleanliness

## T-028
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: "parcels" count is computed identically in MoneyScreen and ClientsScreen
files: frontend/src/components/aito/stats/MoneyScreen.tsx
evidence: frontend/src/components/aito/stats/MoneyScreen.tsx:27 · MoneyScreen.tsx:27 `const parcels = islands.filter((i) => i.island !== null).reduce((s, i) => s + i.count, 0);` is identical to ClientsScreen.tsx:38. rg 'i.island !== null' -> only these two lines. · fix: extract a tiny parcelsShipped(islands) helper and call it from both screens
fingerprint: e7869f662df45c05
source: audit-cleanliness

## T-030
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: _bucket_totals (new) and the pre-existing _bucket are unrelated functions with confusingly overlapping names
files: backend/app/services/aito_stats.py
evidence: backend/app/services/aito_stats.py:326 · _bucket(firsts, projects, start, end) -> AitoStatsBucket (line 176, pre-existing) computes ONE range-filtered count+total. _bucket_totals(buckets, hits) -> dict[str, tuple[int, float]] (line 326, added this campaign) accumulates MANY named buckets from a hit list — a different operation entirely, plus _bucket_name (line 319) maps a day count to a bucket label. Three same-prefixed helpers doing three different jobs in one file. · fix: rename the new helper so it does not share the _bucket prefix with the unrelated range-bucket function, e.g. _accumulate_buckets or _named_bucket_totals
fingerprint: 4d8996ae3ef1e8ce
source: audit-cleanliness

## T-031
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: Two tests locally re-import datetime/timedelta instead of using the module-level import
files: backend/tests/unit/test_aito_stats.py
evidence: backend/tests/unit/test_aito_stats.py:520 · Module top imports `from datetime import date, timedelta` (line 3); test_quote_age_buckets_active_sent_quotes_as_of_today (line 520) does `from datetime import datetime, timedelta` inside the function body, and test_overdue_buckets_and_oldest_as_of_today (line 578) does `from datetime import datetime, timedelta, timezone` inside the body — both re-importing timedelta already available at module scope. · fix: add datetime and timezone to the module-level import and drop the two local re-imports
fingerprint: e32896afd69d70ba
source: audit-cleanliness

## T-032
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: AitoStatsResponse docstring still says "five blocks" for a 19-field response
files: backend/app/schemas/aito.py
evidence: backend/app/schemas/aito.py:1163 · `"""The pipeline widget's five blocks - see docs/.../2026-09-05-aito-pipeline-widget-design.md."""` (line 1162-1163) but the model now has 19 fields (board, conversion, stage_days, invoicing, tracking, throughput, previous, daily, quote_age, size_bands, overdue, stage_time, rework, services, clients, arrivals, islands, date_from, date_to); git log -p shows the count was bumped four -> five once before but never updated again as the response grew. · fix: either drop the stale count from the docstring or update it to reflect the current field count
fingerprint: 435a0105291d44b8
source: audit-cleanliness

## T-036
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: MoneyScreen's !overdue (backend predates the overdue block) empty state is never tested
files: frontend/src/components/aito/stats/MoneyScreen.tsx
evidence: frontend/src/components/aito/stats/MoneyScreen.tsx:85 · MoneyScreen.tsx:85-88: `!overdue ? <Empty>... : overdueCount === 0 ? ... : ...`. The 'degrades block by block' test (line 330) destructures out quote_age/size_bands/stage_time/services/islands/arrivals but never `overdue`, so every Money-tab test always has an overdue object present. · fix: extend the 'degrades block by block' fixture to also omit `overdue` and assert the Empty state renders in the aito-stats-overdue panel
fingerprint: fa761003132e646c
source: audit-tests

