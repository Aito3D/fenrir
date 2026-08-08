# PLAN (schema v1)

## T-001
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: aito.py: map duplicate-quote IntegrityError race to 409
files: backend/app/api/routes/aito.py
evidence: aito.py:375-398 pre-check is TOCTOU; concurrent create/restore hits uq_aito_project_active_quote at commit (aito.py:744) and escapes as 500; wrap commit, re-raise as same 409. Pre-check must stay (index skipped on installs with pre-existing dupes, database.py:4458)

## T-002
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: quote_sync: debounce sync.locked in _update_quote tax-exclusive branch
files: backend/app/services/aito_quote_sync.py
evidence: aito_quote_sync.py:698 records sync.locked without was_already_locked guard unlike sibling sites 654/669, 366/371, 861/874; locked+tax-exclusive project re-edited writes one extra sync.locked row per edit, violating documented one-row-per-moment rule

## T-003
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: aito.py delete_task: use captured task_project_id after delete
files: backend/app/api/routes/aito.py
evidence: aito.py:1288 captures task_project_id 'before delete: unreadable on the row after' but aito.py:1303 still reads task.project_id after db.delete+flush; works only via SQLAlchemy keeping deleted-instance attrs until commit

## T-004
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: quote_sync: extract _terminal_error helper for 4 terminal handlers
files: backend/app/services/aito_quote_sync.py
evidence: aito_quote_sync.py:1068-1103,1104-1124,1125-1139,1174-1215 repeat rollback->state=error->quote_sync_error->failures=0->conditional record(sync.failed); ~90 lines collapse; makes counter-reset invariant (958-969) structural

## T-005
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: quote_sync: extract _lock_project helper for 4 lock blocks
files: backend/app/services/aito_quote_sync.py
evidence: aito_quote_sync.py:366-374,653-673,688-699,861-883 all set locked/_clear_block/zero failures/conditional sync.locked, differing only in error string, invoiced flag, status adoption; do AFTER the debounce fix task

## T-006
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: aito.py: extract _get_active_project_or_404 (6 copies)
files: backend/app/api/routes/aito.py
evidence: identical select+404 at aito.py:1028-1032,1367-1371,1440-1444,1557-1561,1618-1622,1759-1763 mirroring existing _get_task_or_404 (1136-1140); restore_project (1719-1723) uses status==deleted, keep separate

## T-007
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: aito.py: extract _commit_and_wake tail (6 copies)
files: backend/app/api/routes/aito.py
evidence: queued-capture/commit/_wake_worker at aito.py:1176-1179,1271-1274,1304-1307,1517-1519,1744-1747,1775-1778; ordering load-bearing (516-530); must NOT reorder _wake_worker vs _broadcast_changed which differs per handler

## T-008
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: quote_sync: drop unreachable pending clause in _still_selected
files: backend/app/services/aito_quote_sync.py
evidence: aito_quote_sync.py:1229-1230 early-returns True for pending so pending in not_in tuple at 1234 is dead; SQL mirror at 1265 is NOT dead, only Python copy changes

## T-009
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: aito.py: extract _project_response wrapper (8 call sites)
files: backend/app/api/routes/aito.py
evidence: aito.py:752,1109,1428,1531,1594,1630,1682,1749 repeat _to_response(project, summary, await _shipping_names(db)); preserve set_quote_status (1682) building response BEFORE Zoho call

## T-010
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: aito.py: extract _shipping_rates helper (2 identical projections)
files: backend/app/api/routes/aito.py
evidence: byte-identical rates dict comprehension at aito.py:672 and 1473 behind same _mentions_shipping guard; extract next to _shipping_names (248)

## T-011
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: aito.py: extract shared quote-email preamble
files: backend/app/api/routes/aito.py
evidence: aito.py:988-997 and 1028-1041 duplicate lookup->no-quote-404->_quote_email_content->_quote_email_http_error; keep the extra rollback at 1040 (belt-and-braces per 1065-1071)

## T-012
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 6
title: zoho_comments: batch seen-check instead of per-comment SELECT
files: backend/app/services/aito_zoho_comments.py
evidence: aito_zoho_comments.py:203 one SELECT per comment plus _is_our_echo query per survivor (181-192); one IN() pre-query is behaviour-identical (ids unique, models/aito_event.py:61)

## T-013
priority: P3
status: IN_PROGRESS
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 8
title: quote_sync: prune _deferred_reasons on terminal/deleted paths
files: backend/app/services/aito_quote_sync.py
evidence: entries added at 1049 removed only on normal return (1013); trashed/unresolvable projects leave module-dict entries (86) for process lifetime; bounded hygiene fix

## T-014
priority: P3
status: IN_PROGRESS
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 8
title: quote_import: hoist per-line set/map rebuilds out of hot loop
files: backend/app/services/aito_quote_import.py
evidence: aito_quote_import.py:353 rebuilds set((shipping_ids or {}).values()) per line in loop at 345; parse_shipping_line rebuilds inverted map per call at 295; hoist both, identical output

## T-015
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: HoldButton: cancel in-flight hold when disabled flips true (+fix contradictory PERIMETER comment)
files: frontend/src/components/aito/HoldButton.tsx
evidence: HoldButton.tsx:180-193 startHold checks disabled only at press; setTimeout at 185 survives disabled flip and fires onHold at 191 (callers gate on live mutation state: FlagControl.tsx:248, DoneGrid.tsx:39). Add effect clearing timer on disabled. Also HoldButton.tsx:60-63 comment claims separate map above an alias. Add characterization test for hold-commit path first (FlagControl 51% cov)

## T-016
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: ProjectDetailPanel: remove dead+stuck 'error' SaveState value
files: frontend/src/components/aito/ProjectDetailPanel.tsx
evidence: SaveIndicator (649-661) renders null for 'error'; setters at 823/863 set it; reset effect 802-806 only clears 'saved'; nothing reads it (1007 reads 'saving' only). Removing 'error' from SaveState (93) + setters is rendered-identical dead-code removal. Surfacing errors would be a feature -> final report

## T-017
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: aitoOptimistic applyShipping: resolve ??-fallback vs verbatim-doc contradiction
files: frontend/src/utils/aitoOptimistic.ts
evidence: aitoOptimistic.ts:188-189 doc promises five posted fields applied verbatim; 218-225 uses ?? project fallbacks; shippingDraft.ts:146 legitimately posts null price so clearing a rate leaves stale price in cache one roundtrip. CHECK tests first: if tests assert ?? deliberately, fix the doc only; else make verbatim per doc. Util is surface-frozen: no export renames

## T-018
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: NewProjectDrawer: persist current summarySignature (stale ref in save effect) + reuse allPriced
files: frontend/src/components/aito/NewProjectDrawer.tsx
evidence: 212-222 saves summarySignatureRef.current under deps [tasks,draft,summaryText,summaryEdited,shipping] w/ eslint-disable; openClient mutates ref at 241-242, resetDraft clears at 261, neither a dep -> persisted signature lags one change. Fix without touching save-debounce. Also 272 vs 301: canCreate recomputes projectHasPricedService(tasks) and redundant length check — reuse allPriced

## T-019
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 6
title: Extract useProjectPatchMutation (3 identical mutation configs)
files: frontend/src/components/aito/ProjectDetailPanel.tsx, frontend/src/components/aito/ShippingCard.tsx
evidence: ProjectDetailPanel.tsx:691-717,724-741 and ShippingCard.tsx:118-130 share identical mutationFn/flashId/onSuccess/onError, only transform differs; extract helper hook with zero behavior change

## T-020
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 6
title: DurationInput: delete dead w-16 class (silently loses to inputCls w-full)
files: frontend/src/components/aito/DurationInput.tsx
evidence: DurationInput.tsx:43 ${inputCls} w-16: formStyles.ts:4-5 starts with w-full; verified in shipped CSS (.w-16 @26377 before .w-full @27210, same specificity, w-full wins) so w-16 renders nothing; delete it. Do NOT wrap in w-16 div (would CHANGE rendered width)

## T-021
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 7
title: Extract shared restore-button className between DoneGrid and TrashGrid
files: frontend/src/components/aito/DoneGrid.tsx, frontend/src/components/aito/TrashGrid.tsx
evidence: DoneGrid.tsx:42 and TrashGrid.tsx:69 verbatim-identical className + durationMs/hint/icon children; one shared const in a component file (NOT a surface-frozen util)

## T-022
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 7
title: AitoPage: memoize done-column search filter beside visibleColumns
files: frontend/src/pages/AitoPage.tsx
evidence: 126-133 memoizes visibleColumns on [board,search]; 148 filters board.done unmemoized every render incl drag frames; fold into same memo. Do NOT touch inProduction at 149 (comment 136-147 forbids filtering it)

## T-023
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 7
title: ImportQuoteDrawer: adapt AitoTaskCreate->TaskLike and reuse summariseTasks/taskCost
files: frontend/src/components/aito/ImportQuoteDrawer.tsx
evidence: 29-36 hand-enumerates services in SERVICES order; 48-51 re-implements impression-discount rule owned by aitoBoardRules.ts:185-191; own comment 44-47 says reason is snake_case shape — small adapter, not a rewrite; assert identical totals via existing tests

## T-024
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 8
title: TaskEditor: prune editingKeys on row removal (char test first)
files: frontend/src/components/aito/TaskEditor.tsx
evidence: keys added at 85/128/175, only removal is toggle at 85; onRemove (167) drops row without pruning; uid-based keys never collide so prune is behavior-neutral; 58% cov — add characterization test on accordion/effectiveOpenKey path (103-106) first

## T-025
priority: P3
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: ProjectDetailPanel: add Object.hasOwn guards to 3 server-string lookups
files: frontend/src/components/aito/ProjectDetailPanel.tsx
evidence: quoteStatus.ts:23-28,47-54 established Object.hasOwn pattern; bare lookups at ProjectDetailPanel.tsx:673 (BLOCK_MESSAGE_KEY), 684/1142/1146 (SYNC_LABEL_KEY), 582 (ACTOR_FALLBACK_KEY); runtime-JSON edge only, aligns with file's own neighbours

## T-026
priority: P3
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: QuotePrintButton: track revoke timer + clear frameRef on success path
files: frontend/src/components/aito/QuotePrintButton.tsx
evidence: cleanup() at 72-77 schedules bare setTimeout(REVOKE_DELAY_MS) not stored in timeoutRef so unmount effect 55-68 can't clear it; frameRef set at 100 never nulled after successful cleanup at 122 so unmount may .remove() an already-removed node

## T-027
priority: P3
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: Fix misleading wording from verifier round 1 (test docstring + fail-open note)
files: backend/tests/unit/test_aito_quote_sync.py, backend/app/api/routes/aito.py
evidence: verifier iter-1: test docstring at test_aito_quote_sync.py:1450,1497 claims swept branch reaches _update_quote non-pending — control flow contradicts (returns at 887); reword to defensive-parity-with-366/654/865. Also note SQLite-message dependence as precondition in _is_duplicate_active_quote_error docstring (aito.py:414-424). Comment/docstring only, zero code change

## T-028
priority: P3
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: zoho_comments: regression test for same-batch duplicate comment_id
files: backend/tests/unit/test_aito_zoho_comments.py
evidence: verifier iter-6: the seen.add() invariant (same comment_id twice in ONE batch mirrors once) has no test; existing test only covers repetition across separate calls; a regression would ship silently. Test-only task, no source change

