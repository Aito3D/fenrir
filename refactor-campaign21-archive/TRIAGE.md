# TRIAGE (schema v2)

## T-066
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: _write_back_rounded_costs()'s project_id parameter is unused
files: backend/app/services/aito_quote_sync.py
evidence: backend/app/services/aito_quote_sync.py:777 · ruff (ARG001): 'Unused function argument: project_id' at aito_quote_sync.py:777; reading the function body (lines 776-813) confirms project_id is never referenced inside — only db and pushed_costs are used. Both call sites (lines 663 and 1260) pass project.id positionally. · fix: Drop the project_id parameter and update both call sites (lines 663, 1260) to `_write_back_rounded_costs(db, pushed_costs)`.
fingerprint: cb58642b4ce47799
source: audit-cleanliness

## T-072
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 11
last_touched_iteration: 11
title: zoho _seg leaves bare '.'/'..' ids unescaped, so httpx collapses them as dot segments in Books request paths
files: backend/app/services/zoho.py
evidence: backend/app/services/zoho.py:38 · return urlquote(value, safe="") — verified with the project's httpx: /books/v3/contacts/.. is sent as /books/v3 and /books/v3/estimates/../status/sent as /books/v3/status/sent. Contact ids on the zoho routes are free-text path params, so a percent-encoded %2E%2E reaches these calls (incl. PUT /contacts/{id}) with the org's OAuth token; stays inside /books/v3. The c21 Heimdall _seg (T-026) escapes bare dots; this one does not. · fix: mirror services/heimdall.py _seg: after quoting, if the segment is '.' or '..' replace '.' with '%2E' (or reject such ids at the zoho route boundary)
fingerprint: 07b30d26b8eafb03
source: audit-security

## T-076
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 11
last_touched_iteration: 11
title: `return isinstance(exc, HeimdallUnreachable)` "stand down the pass" idiom is repeated at 5 call sites across two files
files: backend/app/services/aito_payment_links.py
evidence: backend/app/services/aito_payment_links.py:792 · aito_payment_links.py:792, :806, :879, :1054 and aito_terminal_payments.py:553 all catch the Heimdall error family, record, commit, then return/assign isinstance(exc, HeimdallUnreachable). · fix: Optional: a tiny shared predicate (e.g. heimdall.py `stands_down(exc) -> bool`); only worth doing opportunistically.
fingerprint: 91c7d7420133d347
source: audit-cleanliness

## T-081
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 11
last_touched_iteration: 11
title: _bump_version_on_content_change() derives the new version from the loaded value, so overlapping writers land on the same number
files: backend/app/models/aito_project.py
evidence: backend/app/models/aito_project.py:308 · `target.version = (target.version or 0) + 1` writes a literal computed from the in-memory value, and pysqlite opens no transaction for SELECTs, so two sessions that both loaded version V and then write (the contact poll's _rename_cards, a sibling fan-out, edit_project_client's refresh-then-flush window) both commit V+1. A panel holding V+1 from the first write then passes the expected_version check and silently overwrites the second writer's change. · fix: Bump in SQL (`target.version = AitoProject.version + 1` in the listener, reading the result back after flush) or map `version` as the mapper's version_id_col, and have edit_project_client compare against the flushed server value before pinning.
fingerprint: f9ff31c5e7442452
source: audit-robustness

