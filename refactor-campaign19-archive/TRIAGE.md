# TRIAGE (schema v2)

## T-003
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: The panel ids 'track-panel-pay' / 'track-panel-shop' are hand-typed in multiple places instead of derived from TrackingPanelId
files: frontend/src/pages/AitoTrackPage.tsx
evidence: frontend/src/pages/AitoTrackPage.tsx:144 · `grep -n "track-panel-pay\|track-panel-shop" frontend/src -r` -> AitoTrackPage.tsx:144-145 (`controls: 'track-panel-pay'`, `controls: 'track-panel-shop'`), AitoTrackPage.tsx:292-293 (`id="track-panel-pay" testId="track-panel-pay"`), and TrackingShopPanel.tsx:59 (`id="track-panel-shop" testId="track-panel-shop"`) — four independent literals that must all agree with hooks/useTrackingPanel.ts's own `` `track-panel-${id}` `` template (used in its `show()` focus hand-off, useTrackingPanel.ts:23) for the querySelector fallback to ever match. No shared constant or helper ties them together. · fix: Export a small `panelDomId(id: TrackingPanelId) => `track-panel-${id}`` helper from useTrackingPanel.ts (or trackingShell.ts) and use it everywhere an id/controls/testId string is built, instead of retyping the literal.
fingerprint: b8b9f944ec55613c
source: audit-cleanliness

## T-009
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: The pill's language-name fallback for an unresolved/unsupported current language is untested
files: frontend/src/components/aito/TrackingLanguageSelect.tsx
evidence: frontend/src/components/aito/TrackingLanguageSelect.tsx:14 · coverage: frontend/src/components/aito/TrackingLanguageSelect.tsx branches 50%, missing lines 14-15 (verified: `branches [('0', 1, 14, 'binary-expr'), ('1', 1, 15, 'binary-expr')]`, both the fallback (index 1) side of `i18n.resolvedLanguage ?? i18n.language` and of `availableLanguages.find(...)?.nativeName ?? current`). Every test that touches this component (AitoTrackPage.test.tsx, AitoTrackEntryPage.test.tsx) runs with i18n resolved to one of the app's own supported languages, so the pill's degraded display — falling back to the raw i18n language tag when `i18n.resolvedLanguage` is unset, or when the current code (e.g. a stale/legacy stored value) has no entry in `availableLanguages` — is never exercised. In that case the pill would show a raw tag like 'de-CH' instead of a name, and the native <select>'s `value={current}` would not match any of its own `<option>`s. · fix: in a new frontend/src/__tests__/components/AitoTrackingLanguageSelect.test.tsx, render <TrackingLanguageSelect/> after forcing i18n's resolved language to a code absent from availableLanguages (e.g. via i18n.services.languageUtils or a direct i18n.language override without changeLanguage) and assert the pill shows the raw code rather than crashing, and separately assert the select's displayed value degrades sensibly when no option matches
fingerprint: e4833a6c947bfac0
source: audit-tests

## T-013
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: _track_rate_limited's bucket sweep only drops fully-aged keys and costs O(n) on every request
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1208 · for stale in [h for h, calls in bucket.items() if not live(calls)]: — guarded by `if len(bucket) > _TRACK_RATE_SWEEP_ABOVE` (line 1207) and run on every admitted request for all three dicts. `live()` (line 1203) walks each host's whole stamp list, so once a dict exceeds 1200 keys each request scans every key of every bucket. A key is deleted only when ALL its stamps have aged past the 60 s window, so while a flood is in progress every key is live and nothing is ever swept. That makes the docstring's claim at 1176-1178 — "Once a dict outgrows what the window can hold, every host whose entries have all aged out is dropped, so a scanner cycling addresses cannot grow it without bound on a public route" — false: growth is bounded only by the per-net caps, which the /64 keying above makes cheap to multiply, and the scan cost grows linearly with the flood. · fix: bound the dicts directly (a fixed-capacity structure, or evict the oldest keys once a hard ceiling is reached) rather than relying on a full scan that can only reclaim idle keys, and correct the docstring's no-unbounded-growth claim
fingerprint: eafdbd59a8290343
source: audit-security

## T-023
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: The readyOverride/useTrackingLanguage mock scaffold is copy-pasted between the two tracking-page test files
files: frontend/src/__tests__/pages/AitoTrackPage.test.tsx
evidence: frontend/src/__tests__/pages/AitoTrackPage.test.tsx:17 · AitoTrackPage.test.tsx:18-38 and AitoTrackEntryPage.test.tsx:20-40 are byte-identical except for one trailing comment line (diff of the two 22-line blocks shows only that single line differs: 'the "locale chunk never settles" case (T-018) deterministically.' vs 'and gets the real hook untouched.'). The comment in AitoTrackPage.test.tsx even says 'copied from AitoTrackEntryPage.test.tsx's same override', acknowledging the duplication. · fix: move the readyOverride/setReadyOverride/vi.mock('../../hooks/useTrackingLanguage', ...) block into a shared test helper (e.g. frontend/src/__tests__/utils.tsx, which already hosts shared render helpers) and import it from both page test files
fingerprint: 7bdee929e62ca6a9
source: audit-cleanliness

