# TRIAGE (schema v2)

## T-003
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: Debug console.log calls tagged [KProfile]/[KProfiles] left in save/delete/fetch mutations
files: frontend/src/components/KProfilesView.tsx
evidence: frontend/src/components/KProfilesView.tsx:267 · rg -n "console.log\('\[KProfile" frontend/src -> 8 hits, all in this file (lines 267, 271, 308, 312, 402, 423, 862, 864), each logging request payloads or raw API responses on every save/delete/fetch call; no other component in the repo has this density of tagged debug logging. · fix: remove the [KProfile]/[KProfiles]-tagged console.log statements (keep the console.error ones, which report real failures)
fingerprint: 1ea141d4d3fd7597
source: audit-cleanliness

## T-004
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: Stray debug console.log for ArchiveCard highlight state
files: frontend/src/pages/ArchivesPage.tsx
evidence: frontend/src/pages/ArchivesPage.tsx:317 · verbatim: lines 317-320 '// Debug: log when card is highlighted' then 'if (isHighlighted) { console.log(...) }' - the comment itself labels it debug output, and isHighlighted is otherwise consumed only for styling further down the component · fix: delete the if-block; isHighlighted's real behavior (styling) is unaffected
fingerprint: d5ae55c5ef08a160
source: audit-cleanliness

## T-005
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: users.py declares its logger ad hoc inside a function instead of at module scope
files: backend/app/api/routes/users.py
evidence: backend/app/api/routes/users.py:108 · grep -n 'logger = logging.getLogger' backend/app/api/routes/users.py -> line 108 does 'import logging' + 'logger = logging.getLogger(__name__)' inside the create-user endpoint body, and line 571 calls 'logging.getLogger(__name__).error(...)' inline without ever using the line-108 logger; all 62 other route modules declare a single module-level logger right after the imports · fix: hoist 'import logging' and 'logger = logging.getLogger(__name__)' to module level in users.py to match every other route module, and reuse that logger at line 571 instead of constructing a fresh one inline
fingerprint: c66b02190423a8bc
source: audit-cleanliness

