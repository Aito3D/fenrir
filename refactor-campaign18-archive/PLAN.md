# PLAN (schema v2)

## T-001
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: fix known-broken test_delete_folder_removes_managed_files_from_disk without changing behavior
files: backend/tests/integration/test_library_api.py
evidence: BASELINE.md known_broken. The test asserts a precondition — os.getcwd() != settings.base_dir — that does not hold when pytest is invoked from the repo root, which is how every command in BASELINE.md runs it. It fails identically on pre-campaign main, so it is not a regression. The test's INTENT is sound (managed files are stored relative to settings.base_dir, so os.remove() on a raw relative path would silently no-op against the wrong directory); the fix is to make the test create the CWD-differs condition it needs (e.g. monkeypatch settings.base_dir to a tmp_path, or chdir) rather than assert the runner happens to provide it. Do not delete or skip the test, and do not change production behavior.
fingerprint: 
source: survey

## T-002
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: unbounded calendar loop in _daily() materialises one row per day of an attacker-chosen range
files: backend/app/services/aito_stats.py
evidence: backend/app/services/aito_stats.py:538 · day = first_day while day <= last_day: c = counts.get(day, [0, 0, 0, 0]) rows.append(AitoStatsDay(day=day, created=c[0], accepted=c[1], declined=c[2], done=c[3])) day += timedelta(days=1) | the route bounds only tz_offset_minutes and date_from<=date_to, never the SPAN, so GET /api/v1/aito/stats?date_from=0001-01-01 builds 739,879 AitoStatsDay models (measured: 880 MB RSS, 50 MB JSON body, on an empty DB) and date_from=5001-01-01&date_to=9999-12-31 builds 1,825,847 (~2.2 GB); a marginally wider span instead raises an unhandled OverflowError at line 588, `start - timedelta(days=days)`, returning 500 · fix: clamp the span in get_aito_stats(): reject with 422 any date_from/date_to pair whose day count exceeds a sane maximum (a few years), and keep _daily() defensive with a hard row cap so the loop can never be driven past it by a future caller · user-visible change: a client that asks for a range wider than the new cap — including any all-time-style request that passes a very old date_from — will get a 422 instead of a huge zero-filled `daily` array, so any saved bookmark or script using such a range stops returning data.
fingerprint: 6dc6f88d5e52ad1f
source: audit-security
reason: user-approved behavior change

## T-003
priority: P1
status: WONTFIX-AUTO
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: _daily() materialises one row per calendar day with no cap on the requested span
files: backend/app/services/aito_stats.py
evidence: backend/app/services/aito_stats.py:538 · `day = first_day\n while day <= last_day:\n c = counts.get(day, [0, 0, 0, 0])\n rows.append(AitoStatsDay(day=day, ...))\n day += timedelta(days=1)` — first_day/last_day come straight from the caller's `date_from`/`date_to`, which `get_aito_stats` only checks for from<=to. `GET /api/v1/aito/stats?date_from=0001-01-02` (a mistyped year, or any API-key client) makes this build ~739k AitoStatsDay models; measured on a 826-year span it produced 301,953 rows in 1.94 s at 309 MB peak, all inside a sync function on the event loop and before FastAPI then serialises the lot — so one request pins a CPU, allocates ~1 GB, stalls every other request (WS, MQTT status) for the duration. The same path is reachable without a hostile caller: `first_day` falls back to the earliest `project.created` moment, and an import backdates that from an unvalidated Books quote_date, so one card with a bad year turns the ordinary 'all time' preset into the same blowup. · fix: bound the span in get_aito_stats (422, or clamp first_day to a maximum number of days back from last_day) before compute_aito_stats runs, and keep _daily's row count derived from that bounded span · user-visible change: a request for a range wider than the new cap would return 422 (or a truncated series) instead of the full day-by-day array it returns today.
fingerprint: f23009ed4b204e92
source: audit-robustness
reason: duplicate of T-002 (audit-robustness found the same _daily span issue); its extra evidence — a backdated import making the ordinary all-time preset blow up with no hostile caller — is folded into T-002's briefing

## T-005
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: Overview lead-time tile fabricates a -100% improvement when lead_days is null
files: frontend/src/components/aito/stats/OverviewScreen.tsx
evidence: frontend/src/components/aito/stats/OverviewScreen.tsx:88 · `value={days(tp.lead_days)}` renders '—' when no card completed in the period, but the same tile passes `delta={computeDelta(tp.lead_days ?? 0, prev?.lead_days, 'more-is-bad')}` — computeDelta only bails on a missing PREVIOUS value, so null-current is coerced to 0 and yields pct = (0 - prev)/prev = -100 with tone 'good'. With the previous period's lead_days = 6 the operator sees '— ▼ 100%' in green next to « Lead time » and reads the shop as having halved its turnaround in a period where nothing was actually delivered. The existing fixture in AitoStatsView.test.tsx ('shows the empty line instead of a blank chart…', lead_days: null over previous.lead_days: 6) already renders that badge; no assertion covers it. · fix: pass null (not 0) as the current value when tp.lead_days is null so no badge renders — e.g. `delta={tp.lead_days == null ? null : computeDelta(tp.lead_days, prev?.lead_days, 'more-is-bad')}` · user-visible change: the green '▼ 100%' badge beside the lead-time dash disappears in periods with no completed card.
fingerprint: 64318fee57914e43
source: audit-robustness
reason: user-approved behavior change

## T-006
priority: P2
status: WONTFIX-AUTO
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: _is_creation_time() trusts project.created's occurred_at, which the startup backfill itself backdates
files: backend/app/services/aito_stats.py
evidence: backend/app/services/aito_stats.py:74 · `def _is_creation_time(at, born): return born is not None and timedelta(0) <= at - born <= _CREATION_MOVE_GRACE` — `born` is the project.created event's occurred_at, chosen over created_at because 'created_at can be backdated (an import carries the Books quote's date)'. But _backfill_aito_project_created in backend/app/core/database.py inserts exactly that backdated value: `SELECT p.id, p.created_at, 'project.created', ...`. For any card imported before the event log existed, born IS the Books quote date, so its creation-time board placement (recorded weeks or years later, at the real import instant) fails the 60-second grace: _scan_stages records a phantom stay of `import_instant - quote_date` in whatever column it left, which skews the Time screen's median days per stage and its per-card stacked bars, and the same miss lets _first_moments count that card's import-time quote.accepted as a sale in the import week — the exact outcome the docstring at line 88 says the born check prevents. · fix: treat a project.created whose occurred_at equals the project's created_at (the backfill's signature) as unusable for the grace, or stamp the synthesised rows with a marker in detail and skip the grace for them · user-visible change: stage medians, per-card stage bars and the weekly accepted counts shift for pre-event-log imported cards, so historical figures on the Time and Sales screens will not match what the page showed before.
fingerprint: 71a3e2847946507b
source: audit-robustness
reason: user decision after live-data measurement: 43 cards, 32 carry the backfill signature but only 8 are genuinely backdated imports (noon stamp + quote_id); the remaining 24 were backfilled with accurate creation instants, so the equality heuristic over-matches 4:1 and zeroed the probe's whole conversion block. The 8 real cases were imported with quote dates on or near the import day, so the phantom stay is hours, not weeks. Cost of the fix exceeds its benefit; figures left as they are.

## T-019
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: ScreenTabs keyboard navigation is untested except ArrowRight — ArrowLeft, Home and End never execute
files: frontend/src/components/aito/stats/ScreenTabs.tsx
evidence: frontend/src/components/aito/stats/ScreenTabs.tsx:18 · vitest coverage: ScreenTabs.tsx 70.83% stmts / 50% branch, uncovered lines 17-19 (`else if (e.key === 'ArrowLeft') ...`, `else if (e.key === 'Home') next = 0`, `else if (e.key === 'End') next = STATS_SCREENS.length - 1`); grep for ArrowLeft/{Home}/{End} across the three scoped test files returns no matches; only AitoStatsView.test.tsx:138 does `await user.keyboard('{ArrowRight}')`. The component's own docstring says 'arrow keys move focus and select' and the test's own comment ('Home returns to the first screen') describes behavior it never actually exercises. The focus hand-off (`document.getElementById(statsTabId(target))?.focus()`) is also never asserted, even for the one key that is tested. · fix: extend the 'switches screens through the tabs' test with ArrowLeft (wrap-around to the last tab), Home (jumps to Overview from any tab), and End (jumps to Clients), and assert both the resulting aria-selected tab and that document.activeElement is the newly selected tab button
fingerprint: 94c2a6ce6b9075da
source: audit-tests

## T-004
priority: P2
status: DONE
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: get_aito_stats returns 500 instead of 422 for dates near date.min/date.max
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1024 · `if date_from and date_to and date_from > date_to: raise HTTPException(status_code=422, ...)` is the endpoint's only validation; the dates themselves are unbounded `date` Query params. compute_aito_stats then calls local_day_bounds, which shifts them by tz_offset_minutes: `local_day_bounds(date(1,1,1), date(9999,12,31), 840)` raises `OverflowError: date value out of range`. So `GET /aito/stats?date_from=0001-01-01&tz_offset_minutes=780` (accepted: the offset is within the ge=-840/le=840 bounds) crashes with an unhandled OverflowError, and the Stats page shows the generic 'error loading' state with a 500 in the log instead of telling the caller the range is invalid. A span cap does not fix this — date_from=0001-01-01&date_to=0001-01-02 is a two-day span and still overflows. · fix: clamp or reject date_from/date_to to a supported range in get_aito_stats (e.g. reject anything outside date.min + 1 day .. date.max - 1 day) before calling compute_aito_stats
fingerprint: 81536837f932f6ed
source: audit-robustness
reason: shipped inside T-002's commit (the OverflowError->422 fix); verified present by the blind verifier

## T-007
priority: P2
status: DONE
attempts: 2
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: _overdue() drops an invoice whose due date will not parse, with no log line
files: backend/app/services/aito_stats.py
evidence: backend/app/services/aito_stats.py:336 · `try: due = date.fromisoformat(p.invoice_due_date)\n except ValueError: continue` — invoice_due_date is an unvalidated string echoed from Books (the same class of value the quote_sent_at backfill guards against with a GLOB, documenting '10/02/2026' as a real shape it has seen, and date.fromisoformat on the project's 3.10 target also rejects '2026-09-01T00:00:00'). An overdue invoice with such a value silently vanishes from the Money screen's overdue buckets and from oldest_days, so the operator reads « nothing overdue » while the money is still out, and nothing anywhere records that a row was skipped. · fix: log a warning with project id and the offending string in the except branch so a skipped invoice is diagnosable
fingerprint: b6ae0ed3bcf73339
source: audit-robustness
reason: reopened: the blind verifier judged the shipped implementation defective — the warning fires once per bad row PER REQUEST, and /aito/stats is hit on every view load and timeframe change, so one Books-shaped due date warns forever; it is also an observable side effect absent from BASELINE-CHANGELOG.md

## T-008
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: Every /stats request scans the whole event history regardless of the requested window
files: backend/app/services/aito_stats.py
evidence: backend/app/services/aito_stats.py:161 · `stmt = select(AitoEvent.project_id, AitoEvent.occurred_at, AitoEvent.changes).where(AitoEvent.kind == 'stage.changed', AitoEvent.project_id.in_(ids))` with only an upper bound applied; _first_moments runs the same shape four more times and _active_projects loads every active row (done cards keep status 'active', so that set only ever grows). A 'today' range therefore reads and materialises years of rows: scan.stays holds every closed stay for every card ever, and cost and memory track total history rather than the window. As the board ages the Stats page's first paint slides from instant to seconds, each range change repeats it, and React Query's keepPreviousData holds two full responses at once; the ids list also rides into SQLite as one bind parameter per active project. · fix: bound the stage scan below as well (only stays that can close at or after `start` need their opening row — fetch from the last event before `start` per project), and page or aggregate _active_projects instead of loading every active ORM row per request
fingerprint: 79730fc9c8431a66
source: audit-robustness
reason: safe half landed (_active_projects narrowed 54->16 columns); the stage-scan lower bound was assessed and deliberately NOT attempted — see VERDICTS.log for the T-011/T-008 tension

## T-011
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: _scan_stages and _done_moments each run a separate ordered scan over the same stage.changed events
files: backend/app/services/aito_stats.py
evidence: backend/app/services/aito_stats.py:154 · _scan_stages (line 161-163) runs `select(AitoEvent.project_id, AitoEvent.occurred_at, AitoEvent.changes).where(AitoEvent.kind == "stage.changed", AitoEvent.project_id.in_(ids))`; _done_moments (line 468-470) runs the identical filter over the same table for the same active-project set, just to extract a different projection (first move `to == "done"` vs. per-column stays/backward moves). Both are awaited unconditionally in compute_aito_stats (lines 572-573). The `_StageScan` dataclass docstring (line 146-148) already states the goal 'so the scan runs once' for stage_days/stage_time/rework, but done_moments (needed by throughput and stage_time) was left as its own separate walk. · fix: Fetch the stage.changed rows once (e.g. inside _scan_stages) and derive the first-move-to-done map from that same result set instead of issuing _done_moments as a second query.
fingerprint: f840d3f8e1180aef
source: audit-cleanliness

## T-012
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: _quote_age and _overdue duplicate the same named-bucket accumulator scaffold
files: backend/app/services/aito_stats.py
evidence: backend/app/services/aito_stats.py:273 · _quote_age (lines 273-284) and _overdue (lines 330-350) both build `rows: dict[str, list[float]] = {name: [0, 0.0] for name, _, _ in <BUCKETS>}`, then `rows[name][0] += 1; rows[name][1] += <amount>` after resolving a bucket via the shared `_bucket_name()`, then convert to a response list with the identical `for name, (c, t) in rows.items()` comprehension (each carrying its own `# type: ignore[arg-type]`). The only real difference is the extra `oldest` tracking in _overdue and which project field is filtered/summed. · fix: Extract a shared helper, e.g. `_bucket_amounts(projects, buckets, key_fn, amount_fn)` returning the `{name: (count, total)}` mapping, and have both _quote_age and _overdue build their response objects from it.
fingerprint: a3dfa75430be4902
source: audit-cleanliness

## T-014
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: the Monday-start week-folding algorithm is copy-pasted across ActivityChart, DecisionsChart and OverviewScreen
files: frontend/src/components/aito/stats/OverviewScreen.tsx
evidence: frontend/src/components/aito/stats/OverviewScreen.tsx:26 · The exact expression `start.setDate(date.getDate() - ((date.getDay() + 6) % 7))` appears verbatim in ActivityChart.tsx:33, DecisionsChart.tsx:31 and OverviewScreen.tsx:31 (3 hits), each paired with its own week-bucket Map. The threshold constants have already drifted into two independent copies: ActivityChart.tsx exports `WEEKLY_ABOVE_DAYS = 45` (with a local, unexported `WEEKLY_ABOVE_DAYS_NARROW = 31`), and DecisionsChart.tsx separately re-declares its own local `const WEEKLY_ABOVE_DAYS = 45; const WEEKLY_ABOVE_DAYS_NARROW = 31;` instead of importing ActivityChart's export — while OverviewScreen imports and reuses only `WEEKLY_ABOVE_DAYS` (not the narrow variant) for its own third copy of the folding loop. · fix: Factor the week-folding (threshold + Monday-start bucket key) into one shared function/module (e.g. a `weeklyFold.ts` beside palette.ts) that ActivityChart, DecisionsChart and OverviewScreen's peak-finder all call, so the three copies cannot drift further apart.
fingerprint: 9ad621f2128568fc
source: audit-cleanliness

## T-015
priority: P2
status: DONE
attempts: 2
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: _overdue() never tested for an invoice due today/tomorrow (days<=0), which is silently excluded from every bucket
files: backend/app/services/aito_stats.py
evidence: backend/app/services/aito_stats.py:343 · coverage: line 343 missing (pytest --cov-branch); `_bucket_name(days, _OVERDUE_BUCKETS)` returns None whenever days<=0 since _OVERDUE_BUCKETS starts at ('1-7',1,7), and line 343 `if name is None: continue` then drops the row entirely. test_overdue_buckets_and_oldest_as_of_today only sets due dates 3 and 45 days in the past, never today or in the future with a balance owed. · fix: add a case to test_overdue_buckets_and_oldest_as_of_today with a project whose invoice_due_date is today (and/or tomorrow) with a positive balance, and assert it appears in none of the buckets and does not move oldest_days
fingerprint: 74ef8df03697eea1
source: audit-tests
reason: reopened: its fixture races the real clock — dates derive from datetime.now(utc).date() while the endpoint re-reads today independently, so a UTC midnight between the two fails the run; the new due-today row widens that window

## T-017
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: _stage_time()'s documented anti-double-count rule (a stay closed by a re-open after done_at) is never exercised
files: backend/app/services/aito_stats.py
evidence: backend/app/services/aito_stats.py:225 · coverage: line 225->224 partial branch; the docstring at lines 216-218 says 'Only stays closed by the completion count: a re-open afterwards is a different story and would double the bar', but no test produces a stay whose `ended` is after the card's `done_at` (test_stage_time_per_completed_project_newest_first's re-open on `b` moves out of a non-tracked 'done' column, so it never creates a trackable stay after done_at) · fix: extend test_stage_time_per_completed_project_newest_first with a card that is completed, then reopened into a tracked stage (e.g. finish) and moved again, and assert the post-completion stage duration is NOT added to that card's `stages` total
fingerprint: 3cc5a4cb8e7f86c5
source: audit-tests

## T-018
priority: P2
status: DONE
attempts: 2
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: rework.share's null path (no cards moved) runs in almost every other test but is never asserted
files: backend/app/services/aito_stats.py
evidence: backend/app/services/aito_stats.py:254 · `AitoStatsRework(... share=(round(len(cards)/len(moved), 3) if moved else None))` at line 254 — this False branch executes incidentally in most tests that have no stage.changed events at all (e.g. test_board_counts_and_totals_per_column_with_all_seven_present, test_conversion_counts_first_events_in_range_only), which is why it doesn't show up as a coverage gap, but not one of those tests reads body['rework'] at all. test_rework_counts_backward_moves_and_share_of_moved_cards is the only test that asserts on `rework`, and it only covers the non-null share case (0.5). A regression that turned the null case into 0, or into a ZeroDivisionError caught elsewhere, would pass every existing test. · fix: add a case asserting body['rework'] == {'moves': 0, 'cards': 0, 'share': None} when no stage.changed rows exist in the period
fingerprint: 77167f06297fb37a
source: audit-tests
reason: reopened: the forward-only fixture backdates the project.created event but not created_at, producing a negative-duration stay — a physically impossible card that a future reader cannot safely extend to stage_days/stage_time assertions

## T-020
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: DecisionsChart's weekly-fold branch (identical in spirit to ActivityChart's, which IS tested) has no test at all
files: frontend/src/components/aito/stats/DecisionsChart.tsx
evidence: frontend/src/components/aito/stats/DecisionsChart.tsx:28 · vitest coverage: DecisionsChart.tsx 74.19% stmts / 40.9% branch, uncovered lines 29-33 (the `if (weekly) { ... }` week-bucketing block) and 69-71 (tooltip formatter/labelFormatter); grep for DecisionsChart across frontend/src/__tests__ finds zero direct test references — it is only mounted indirectly via SalesScreen in AitoStatsScreens.test.tsx, whose only chart assertion is `getByTestId('aito-stats-decisions').querySelectorAll('.recharts-bar').length == 2` with a 2-day fixture. Compare AitoStatsView.test.tsx which has a dedicated test ('folds days into weeks past 45 days...') for the same >45-day fold logic in ActivityChart.tsx. · fix: add a Sales-screen test with >45 days of `daily` data (mirroring the ActivityChart weekly-fold test) and assert the chart switches to the 'decisionsPerWeek' title and buckets accepted/declined by Monday-start week
fingerprint: 0f96fe45a7a94ef9
source: audit-tests

## T-021
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: TimeScreen's zero/null findings branches (no rework, no lead time, no completed cards) are never exercised
files: frontend/src/components/aito/stats/TimeScreen.tsx
evidence: frontend/src/components/aito/stats/TimeScreen.tsx:100 · vitest coverage: TimeScreen.tsx uncovered lines include 29-37 and 66-104, spanning `rework.moves > 0` (false), `rework.share !== null` (false, and moves===0), `tp?.lead_days == null -> timeNone`, and `longest > 0 ? ... : 0` (false); the Time-screen fixture always uses `rework: { moves: 2, cards: 1, share: 0.5 }` and `lead_days: 4.75` — the only null/zero throughput fixture (AitoStatsView.test.tsx:153) is used for the Overview screen, not Time. The existing 'degrades on a backend that predates these blocks' test removes `stage_time` entirely (triggering the Empty state), which is a different code path from a populated-but-all-zero board. · fix: add a Time-screen test with a legitimately empty/flat period: rework {moves:0, cards:0, share:null}, throughput.lead_days null, and stage_time rows totaling 0, asserting the finding reads the 'timeNone' key, the rework fact shows no tone/share note, and the stage-time bars render with 0 scale rather than dividing by zero
fingerprint: 3d764e0605f39309
source: audit-tests

## T-016
priority: P3
status: DONE
attempts: 0
round: 1
first_seen_iteration: 2
last_touched_iteration: 2
title: _overdue() silently swallows a malformed invoice_due_date with no test
files: backend/app/services/aito_stats.py
evidence: backend/app/services/aito_stats.py:338 · coverage: lines 338-339 missing; `except ValueError: continue` around `date.fromisoformat(p.invoice_due_date)` has no test driving a non-ISO invoice_due_date value · fix: add a case that sets invoice_due_date to a malformed string on an otherwise-qualifying project and asserts it is excluded from buckets/oldest_days without raising
fingerprint: befc421878847c01
source: audit-tests
reason: its test shipped inside T-007's commit (malformed invoice_due_date excluded from buckets AND now logged)

## T-022
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 6
last_touched_iteration: 6
title: compute_aito_stats merges quote_accepted_at into accepted but never merges quote_sent_at into sent
files: backend/app/services/aito_stats.py
evidence: backend/app/services/aito_stats.py:618 · `sent = await _first_moments(db, _SENT_KINDS, ids, end=end)` (line 618) builds the funnel's "sent" bucket from `quote.sent`/`quote.emailed` events only, while the block right below it (lines 626-631, `stamped = project.quote_accepted_at ... accepted[pid] = stamped ...`) explicitly repairs the same gap for acceptances. `aito_quote_status.adopt_quote_status` stamps `quote_sent_at` and records NO event (it is a plain attribute write; only routes/aito.py:2600 records `quote.sent`, on the app's own Email button), and `aito_quote_sync.py:972` calls it from the sweep's reconcile. So a quote emailed from Books and then accepted in Books yields `conversion.sent.count == 0` and `conversion.accepted.count == 1`: SalesScreen's funnel prints Sent 0 / Accepted 1, and on the same screen the 15+-day quote-age fact — which reads `p.quote_sent_at` directly at aito_stats.py:345 — counts a quote the funnel says was never sent. · fix: after the quote_accepted_at merge loop, fold `project.quote_sent_at` into `sent` the same way (take the earlier of the column and the event), or drop the accepted merge and derive both buckets from events alone so the two sides of the funnel are built from one source. · user-visible change: the Sales funnel's "sent" count and total will rise for any shop whose quotes leave through Books rather than the app's Email button.
fingerprint: e69b7097d627cefb
source: audit-robustness
reason: user-approved behavior change

## T-023
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 6
last_touched_iteration: 6
title: _daily()'s span clamp silently desyncs the daily series from throughput.created and per_day
files: backend/app/services/aito_stats.py
evidence: backend/app/services/aito_stats.py:590 · `if (last_day - first_day).days + 1 > MAX_STATS_SPAN_DAYS: first_day = last_day - timedelta(days=MAX_STATS_SPAN_DAYS - 1)` drops the oldest days from `daily` only — `throughput.created` (line 552, `_in_range(at, None, None)` on an all-time request counts every `born` moment) and `days`/`per_day` (line 642) are still computed over the FULL unclamped span. The trigger is one import older than five years: core/database.py:1516 backfills `project.created` with `occurred_at = p.created_at`, and an imported card's `created_at` is the Books quote_date, so a single 2018 quote pushes `earliest` to 2018. On "all time" the Overview then reads "43 came in" beside an ActivityChart whose bars start in 2021 and sum to 42, and `per_day` is divided by ~3100 days while the chart covers 1827. · fix: clamp once in compute_aito_stats — derive `first_day` already bounded and pass that same value into `_daily`, `days` and the throughput window — so one range drives every figure. · user-visible change: on an all-time range with history older than five years the headline counts and per-day rate drop to what the chart actually shows.
fingerprint: da062bd9650c6ecf
source: audit-robustness
reason: user-approved behavior change

## T-024
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 6
last_touched_iteration: 6
title: StatsView renders the new /stats 422s as a generic retryable error
files: frontend/src/components/aito/StatsView.tsx
evidence: frontend/src/components/aito/StatsView.tsx:80 · `) : query.isError || !data ? (` collapses every failure into `t('common.errorLoading')` plus a Retry button, discarding `ApiError.status` and `.message`. The custom timeframe's start input (`<input type="date" max={...}>` in components/stats/TimeframeSelector.tsx:75) carries no `min` and no form validation, so typing 1900-01-01 is accepted and reaches `api.getAitoStats`; routes/aito.py:1043 answers 422 "date_from/date_to must not span more than 1827 days" (or the MIN/MAX_STATS_DATE message for a 4-digit-year typo). The user sees a red triangle and a Retry that re-sends the identical request and fails identically, forever, with nothing on screen naming the range as the cause. · fix: branch on `query.error instanceof ApiError && query.error.status === 422`: show the backend's `message` (or a dedicated i18n string) and suppress the Retry button for that case. · user-visible change: a rejected custom range now shows a specific message instead of the generic load-error panel, and offers no Retry.
fingerprint: 6ab09c2f106fddb1
source: audit-robustness
reason: user-approved behavior change

## T-025
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 7
title: MoneyScreen's Totals panel presents the all-time outstanding snapshot as a period figure
files: frontend/src/components/aito/stats/MoneyScreen.tsx
evidence: frontend/src/components/aito/stats/MoneyScreen.tsx:116 · `{ label: t('aito.stats.outstanding'), value: money(outstanding), note: ... }` sits in `<Panel title={t('aito.stats.totals')}>` (line 109) with no `AsOfToday` marker, beside `quoted`, `lostWith` and `shippingBilled`, which ARE period-scoped. `outstanding` is `data.invoicing.outstanding_balance`, built at aito_stats.py:674 as `[p for p in projects.values() if p.quote_invoiced and (p.invoice_balance or 0.0) > 0]` — no `_in_range`, every active card ever. The finding sentence above repeats it (`moneyOut`, line 32). Selecting the "Today" timeframe therefore prints "accepted 0, invoiced 0" and "450 000 F outstanding across 12 invoices", which reads as today's billing; the Overdue panel two lines up (line 80) carries the `AsOfToday` marker for exactly this reason, so the omission is invisible as an omission. · fix: give the Totals panel an `AsOfToday` action for the outstanding row, or move outstanding/outstanding_count into the Overdue panel that already declares itself a snapshot.
fingerprint: acf4e88ac290654e
source: audit-robustness

## T-027
priority: P2
status: WONTFIX-AUTO
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 6
title: OverviewScreen and SalesScreen each re-derive the acceptance rate from raw counts instead of reusing conversion.acceptance_rate
files: frontend/src/components/aito/stats/OverviewScreen.tsx
evidence: frontend/src/components/aito/stats/OverviewScreen.tsx:18 · OverviewScreen.tsx:18-19 `const decided = data.conversion.accepted.count + data.conversion.declined.count; const rate = decided > 0 ? Math.round((data.conversion.accepted.count / decided) * 100) : null;` is byte-for-byte the same formula as SalesScreen.tsx:17-18 — and the backend already computes this in AitoStatsConversion.acceptance_rate (accepted.count / (accepted.count + declined.count) rounded to 3 places), which neither file reads. rg 'const decided' -> only these two sites. · fix: have both screens derive the percentage from data.conversion.acceptance_rate (multiply by 100 and round) instead of re-deriving decided/rate from the raw counts · user-visible change: switching to the backend's pre-rounded (3-decimal) fraction instead of rounding the raw ratio directly to a whole percent could shift the displayed percentage by 1 point in rare boundary cases (double rounding).
fingerprint: 17e167f60ccff564
source: audit-cleanliness
reason: user declined: the duplication is two lines; reusing the backend's pre-rounded 3-decimal fraction introduces double rounding that can display the wrong whole percent. Deduplicating a correct calculation into a slightly-wrong one is a bad trade.

## T-029
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 7
title: weeklyFold.ts only extracted the date math; the per-week accumulation loop is still copy-pasted three ways
files: frontend/src/components/aito/stats/weeklyFold.ts
evidence: frontend/src/components/aito/stats/weeklyFold.ts:47 · weeklyFold.ts exports weekStart/weekKey/the two thresholds, but the Map-based fold-into-buckets loop that uses them is still separately written in ActivityChart.tsx:27-38 (accumulates {day,created,accepted,done,label} per week), DecisionsChart.tsx:22-36 ({label,accepted,declined}, with its own extra day/week branch), and OverviewScreen.tsx:27-37's peak-finder (a single running total per week) — three near-identical `new Map<string,T>(); for (const d of daily) { key = weekKey(date); buckets.get(key) ?? seed; accumulate; buckets.set(...) }` loops that differ only in the seed/accumulate shape. · fix: give weeklyFold.ts a generic foldWeekly(daily, seed, accumulate) helper and have all three callers use it, so only the value shape differs per caller
fingerprint: 98e2beb169f86a6d
source: audit-cleanliness
reason: ActivityChart converted (12->9 lines, dead export removed); DecisionsChart declined (its loop branches per-row between a day key and a week key, so the helper version was longer); OverviewScreen declined on a COVERAGE-RATIO ARTIFACT — see VERDICTS.log

## T-033
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 7
title: get_aito_stats never tests date_to alone out of [MIN_STATS_DATE, MAX_STATS_DATE]
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1037 · pytest --cov=backend.app.api.routes.aito backend/tests/unit/test_aito_stats.py --cov-report=term-missing -> Missing includes '1037' (the `date_to must be between ...` raise). Every existing out-of-range case in test_dates_that_would_overflow_local_day_bounds_are_422_not_500 sends an out-of-range date_from (which trips the sibling check on line 1035 first); no test sends a valid/absent date_from with an out-of-range date_to. · fix: add a case like `await async_client.get(STATS, params={'date_to': '9999-12-31'})` (and one with a valid date_from + out-of-range date_to) asserting 422, alongside test_dates_that_would_overflow_local_day_bounds_are_422_not_500
fingerprint: 0ffd97c86ea96afb
source: audit-tests

## T-034
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 8
title: ActivityChart's weekly-fold bucket sums (created/accepted/done per week) are never asserted, only the mode label
files: frontend/src/components/aito/stats/ActivityChart.tsx
evidence: frontend/src/components/aito/stats/ActivityChart.tsx:26 · AitoStatsView.test.tsx:110-124 ('folds days into weeks past 45 days...') only checks `within(activity).getByText('Activity per week')`, the absence of the rolling-7 text/line, and OverviewScreen's independently-computed peak-week sentence — it never inspects the `rows` handed to recharts. Unlike DecisionsChart (which AitoStatsScreens.test.tsx now captures via a mocked BarChart's props.data), no test mocks ComposedChart to read ActivityChart's own weekly sums, so mutating `b.created += d.created` (e.g. to `b.accepted += d.created`) in ActivityChart.tsx would still pass every existing test. · fix: mock recharts.ComposedChart the same way BarChart is mocked (capture props.data) and assert the actual per-week created/accepted/done sums for a daily fixture spanning >45 days with known per-day values
fingerprint: 8bc247dcf93a848f
source: audit-tests

## T-035
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 8
title: ClientsScreen's clientsNone finding and the missing-clients-block degrade are never rendered in any test
files: frontend/src/components/aito/stats/ClientsScreen.tsx
evidence: frontend/src/components/aito/stats/ClientsScreen.tsx:44 · ClientsScreen.tsx:43-49 branches to t('aito.stats.finding.clientsNone') when `!clients || clients.new + clients.returning === 0`. rg 'clientsNone' frontend/src/__tests__ -> no matches. AitoStatsScreens.test.tsx's 'degrades block by block' test destructures out quote_age/size_bands/stage_time/services/islands/arrivals but keeps `clients` in every fixture, so `!clients` is also never hit. · fix: add a Clients-tab case with clients {new:0, returning:0, new_total:0, returning_total:0} asserting the clientsNone text, and extend the degrade fixture to also drop `clients` and assert the Empty state
fingerprint: def0d4ba96f7363b
source: audit-tests

## T-037
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 8
title: SalesScreen's plain salesLost wording (declines not concentrated in the top band) is never rendered by any test
files: frontend/src/components/aito/stats/SalesScreen.tsx
evidence: frontend/src/components/aito/stats/SalesScreen.tsx:37 · SalesScreen.tsx:26-38: the else branch at line 37 (t('aito.stats.finding.salesLost', ...)) only fires when the tie-break at line 29 (bands.length > 1 && top.declined > 0 && top.declined === mostDeclined) is false. rg 'salesLost' frontend/src/__tests__ only matches the salesLostBig assertion at AitoStatsScreens.test.tsx:130; no fixture puts the most declines in a band other than the last, so the plain wording and its {{count}}/{{total}} interpolation are unchecked. · fix: add a Sales-tab case with size_bands where the top (last) band has fewer declines than an earlier band, asserting the plain 'quote(s) were lost, worth ...' text instead of the big-tickets wording
fingerprint: a4dffeb5009078d1
source: audit-tests

