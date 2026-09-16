# FINAL_REPORT.md — refactor-loop campaign 16 (the settings feature)

Campaign 16 · worktree `../bambuddy-refactor-c16` · branch `auto-refactor-loop-c16` · BASE `refactor-base-c16` (a7edcbf47, cut from main 911c08b25 on 2026-09-14)
Scope: backend settings route/schema/model, SettingsPage.tsx and its 15 settings panels + SecurityStatusCard, settingsSearch.ts, and their tests (see BASELINE.md for the exact boundary and the upstream-vs-fork ownership caution).
Parameters: TRIAGE P3 · MAX_ITER 8 · MAX_ROUNDS 3 · BATCH 3 · MODE auto · COMMIT_STYLE grouped · MERGE_CADENCE at-exit.

## Run summary
- Iterations run: 8 (every one verified PASS by the blind verifier; two needed a second pass after an in-iteration revert)
- Survey rounds completed: 2 of 3
- Commits on the branch after squashing: 8 iteration commits + the setup commit (+ this report); tags: loop16-1 loop16-2 loop16-3 loop16-4 loop16-5 loop16-6 loop16-7 loop16-8
- Why the loop ended: **MAX_ITER** (iteration 9 would have exceeded the cap of 8). Round 2 was productive (11 workable tasks), so the campaign did not converge; 5 of those tasks are left OPEN.
- User-approved behavior changes this campaign: **none** (no BASELINE-CHANGELOG.md entry was added). The user was not available during the run, so every behavior-change finding was held — see the list below.

## What landed (all verified behavior-neutral)
8f6dab85d refactor(loop16-8): T-238, T-241, T-243 — streamed Postgres export, its end-to-end test, camera/go2rtc branch tests
a7030015b refactor(loop16-7): T-239, T-246 — reset endpoint and OIDCProviderSettings mutation tests
ee794b397 refactor(loop16-6): T-219 characterize ColorCatalogSettings update/delete/sync/import/export handlers
6bee2c296 refactor(loop16-5): T-214, T-215, T-218 — virtual-printer PUT validations, gcode_snippets validator, SpoolCatalogSettings handlers
c08ae87db refactor(loop16-4): T-202, T-213 — log swallowed reconfiguration failures, Spoolman switch-on tests
c6542015d refactor(loop16-3): T-195, T-201, T-217 — backup temp-file cleanup, shared input class, LDAPSettings tests
98e35edf4 refactor(loop16-2): T-211, T-212, T-216 — characterize the restore guards and the EmailSettings panel
9653a9033 refactor(loop16-1): T-209, T-210 — characterize the settings lock-out guard and the restore success path

Production changes (3): swallowed MQTT/camera/go2rtc reconfiguration failures now log a warning (T-202); the on-demand backup's temp ZIP is unlinked when the build fails (T-201); the PostgreSQL backup export streams in 1000-row partitions instead of loading each table twice (T-238). One cleanliness change: a shared `settingsInputCls` constant replaces 15 identical class literals in the three fork-owned panels (T-195).
Everything else is characterization tests: restore success path, ZipSlip guard, staging contract, restore 500 fallback pending, local-login lock-out guard, Spoolman switch-on, legacy virtual-printer PUT validations, gcode_snippets validator, reset endpoint, camera/go2rtc branches, Postgres export; EmailSettings, LDAPSettings, SpoolCatalogSettings, ColorCatalogSettings, OIDCProviderSettings panels.
Two worked fixes were FAILED by the verifier as unsanctioned behavior changes and reverted in-iteration (T-200 scheduler restart after a failed restore; T-206 SpoolmanSettings refetch guard); both are now held for approval.

## What each resurvey round found
- Round 1 (setup): 26 findings — cleanliness 2, robustness 10, security 3, tests 11 → 24 filed (19 workable, 5 blocked), 2 triaged.
- Round 2: 30 findings — cleanliness 6, robustness 9, security 4, tests 11 → 26 filed (11 workable after orchestrator holds and duplicate retirements, 15 blocked incl. holds), 4 triaged.

## Findings by auditor (plan.py stats, campaign 16 only)
| auditor | filed | DONE | BLOCKED | WONTFIX-AUTO | OPEN |
|---|---|---|---|---|---|
| audit-security | 7 | 0 | 6 | 1 | 0 |
| audit-robustness | 18 | 3 | 14 | 1 | 0 |
| audit-cleanliness | 4 | 1 | 3 | 0 | 0 |
| audit-tests | 21 | 15 | 0 | 1 | 5 |

## Triaged
6 findings were diverted to TRIAGE.md this campaign (cleanliness 4: T-194 T-222 T-224 T-225; robustness 1: T-208; tests 1: T-242). TRIAGE.md currently holds 31 entries — the other 25 are carried over from campaigns 14/15. Each has full evidence; promote one with `python tools/plan.py promote <id> --iteration N` (the flag is required).

## Quality gates
- Coverage (whole tree, line %): backend 73% → 73% (Miss 18268 → 18161, 107 fewer missed lines); frontend 61.81% → 62.77% (Stmts 60.94→61.86, Branch 56.29→56.88, Funcs 52.4→53.37).
- Tests: backend 13379 → 13424 passed (0 failed); frontend 6151 → 6200 passed (0 failed). known-broken: 0 → 0.
- Golden probes: 15/15 matching at every verification (5 settings-specific probes added at setup: schema dump, HTTP end-to-end API sequence, search index, page DOM/i18n/api contract, English settings copy). SURFACE.md: unchanged.
- Net diff vs BASE: 16 files, 2717 insertions, 40 deletions (deletions are import-line rewrites, one hoisted test mock, and the three production hunks above; no test deleted or weakened — verified each iteration).

## Left for humans
### OPEN (5, all test-only, ran out of iteration budget)
- T-244 restore_backup()'s generic `except Exception` catch-all (the 500 fallback) is never triggered by a test
- T-245 update_virtual_printer_settings(): ValueError/Exception translation around virtual_printer_manager.configure() has no test
- T-247 SpoolmanSettings' auto-save debounce and mutation success/error toasts (including the differentiated 503/400 AMS-sync error branch) are untested
- T-248 GitHubBackupSettings' download-backup and restore-from-file flows have no test
- T-249 TwoFactorSettings' email-OTP enable/disable, OIDC-unlink mutations, and the SMTP-specific error message are untested — only TOTP flows are covered

### BLOCKED — needs user approval (23)
Each is a real defect whose fix changes observable behavior. Decide per id; on approval run `python tools/plan.py set-status <id> OPEN --iteration N --reason "user-approved behavior change"` and re-enter the loop (the worker must add a BASELINE-CHANGELOG.md entry, re-record affected goldens, and mark the commit "(user-approved behavior change)"). T-199 is the P0: one PATCH with a null numeric field breaks every settings read until reset.
- **T-199 [P0]** update_settings() stores an explicit JSON null as the string "None", permanently breaking every settings read — `backend/app/api/routes/settings.py` (audit-robustness)
  user-visible change: A client that sends null for a numeric setting will get a 400 (or a silently ignored field) instead of a 200, and installs that already hold a "None" row will start returning the default value for that field rather than erroring.
- **T-196 [P1]** update_settings() lock-out refusal misses a JSON null for local_login_enabled — `backend/app/api/routes/settings.py` (audit-security)
  user-visible change: PUT/PATCH /api/v1/settings/ with local_login_enabled explicitly set to null currently returns 200 and disables local login; it would start returning HTTP 400 unless an enabled OIDC provider exists and the caller has an OIDC link.
- **T-197 [P1]** _SENSITIVE_FIELDS_FOR_API_KEY omits obico_ml_token — `backend/app/api/routes/settings.py` (audit-security)
  user-visible change: (no auditor fragment — orchestrator hold; see BASELINE.md for the observable difference)
- **T-200 [P1]** restore_backup() leaves the print scheduler and plug/digest loops permanently stopped when the restore fails — `backend/app/api/routes/settings.py` (audit-robustness)
  user-visible change: (no auditor fragment — orchestrator hold; see BASELINE.md for the observable difference)
- **T-220 [P1]** ZohoSettings' settings-seed useEffect lacks the seededRef guard its siblings AiSettings/HeimdallSettings use, so a save on either neighbor blanks in-progress Zoho edits — `frontend/src/components/ZohoSettings.tsx` (audit-cleanliness)
  user-visible change: (no auditor fragment — orchestrator hold; see BASELINE.md for the observable difference)
- **T-226 [P1]** reset_settings() deletes the auth_enabled/setup_completed rows, disabling authentication app-wide — `backend/app/api/routes/settings.py` (audit-security)
  user-visible change: (no auditor fragment — orchestrator hold; see BASELINE.md for the observable difference)
- **T-227 [P1]** _build_settings_response() only scrubs credentials for API-key callers, so any settings:read user gets mqtt_password/ha_token/prometheus_token in cleartext — `backend/app/api/routes/settings.py` (audit-security)
  user-visible change: users in the Operators/Viewers groups will see the MQTT password, HA token, Prometheus token and virtual-printer access code as empty fields on the Settings page instead of their real values.
- **T-230 [P1]** debounced auto-save effect in SettingsPage retries a rejected PUT forever with no cap or backoff — `frontend/src/pages/SettingsPage.tsx` (audit-robustness)
  user-visible change: (no auditor fragment — orchestrator hold; see BASELINE.md for the observable difference)
- **T-231 [P1]** docker_compose_dir and pipeline_max_copies are edited by updateSetting but omitted from the auto-save payload — `frontend/src/pages/SettingsPage.tsx` (audit-robustness)
  user-visible change: these two settings would start persisting to the server, so the compose directory survives a reload and the pipeline copy limit an operator sees becomes the one the admin typed.
- **T-198 [P2]** update_virtual_printer_settings() takes access_code as a query parameter — `backend/app/api/routes/settings.py` (audit-security)
  user-visible change: any existing script or integration that calls PUT /api/v1/settings/virtual-printer?access_code=... would stop taking effect and must send a JSON body instead.
- **T-203 [P2]** update_virtual_printer_settings() commits settings before configure(), so a configure failure leaves stored state diverged from runtime — `backend/app/api/routes/settings.py` (audit-robustness)
  user-visible change: (no auditor fragment — orchestrator hold; see BASELINE.md for the observable difference)
- **T-204 [P2]** importBackup() ignores response.ok and returns FastAPI's error shape as if it were a result — `frontend/src/api/client.ts` (audit-robustness)
  user-visible change: A failed restore that currently shows a blank error box will start showing the server's explanation (and go through the catch path), and non-JSON error bodies will produce a status-based message instead of a JSON parse error.
- **T-205 [P2]** exportBackup() buffers the entire backup ZIP in browser memory as a Blob — `frontend/src/api/client.ts` (audit-robustness)
  user-visible change: (no auditor fragment — orchestrator hold; see BASELINE.md for the observable difference)
- **T-206 [P2]** SpoolmanSettings init effect overwrites in-progress input whenever its own autosave refetches — `frontend/src/components/SpoolmanSettings.tsx` (audit-robustness)
  user-visible change: (no auditor fragment — orchestrator hold; see BASELINE.md for the observable difference)
- **T-207 [P2]** FailureDetectionSettings saveMutation has no onError, so a failed save is completely silent — `frontend/src/components/FailureDetectionSettings.tsx` (audit-robustness)
  user-visible change: Users will now see an error toast when a failure-detection setting fails to save, where the failure is currently invisible.
- **T-221 [P2]** clampInt() and AiSettings' clampDays() implement the same 'validate a day/percent field before save' rule with different, undocumented semantics — `frontend/src/components/HeimdallSettings.tsx` (audit-cleanliness)
  user-visible change: Unifying the two functions will change the on-save behavior for out-of-range keystrokes in whichever panel currently uses the other semantics (e.g. typing 400 into a Heimdall day field currently saves 365; under clampDays-style semantics it would instead be discarded and revert to the previously saved value).
- **T-223 [P2]** zoho/openrouter/pushcut/heimdall secrets listed in _SENSITIVE_FIELDS_FOR_API_KEY are already unconditionally blanked, making their entries there a no-op — `backend/app/api/routes/settings.py` (audit-cleanliness)
  user-visible change: (no auditor fragment — orchestrator hold; see BASELINE.md for the observable difference)
- **T-233 [P2]** saveArchivePurgeSettings() and saveTrashSettings() PUT on every keystroke from a stale cache snapshot — `frontend/src/pages/SettingsPage.tsx` (audit-robustness)
  user-visible change: the retention-age fields would save when the user finishes typing instead of on each keystroke, so the per-keystroke 'settings saved' toasts disappear.
- **T-234 [P2]** debounced auto-save cleanup in SettingsPage drops a pending save when the page unmounts — `frontend/src/pages/SettingsPage.tsx` (audit-robustness)
  user-visible change: a setting changed immediately before navigating away would now be persisted instead of discarded.
- **T-235 [P2]** ExternalLinksSettings deleteMutation has no onError, so a failed link delete is invisible — `frontend/src/components/ExternalLinksSettings.tsx` (audit-robustness)
  user-visible change: a failed sidebar-link deletion would now show an error toast where nothing appeared before.
- **T-236 [P2]** deleteLocalBackupMutation has no onError, leaving the confirm dialog stuck on failure — `frontend/src/components/GitHubBackupSettings.tsx` (audit-robustness)
  user-visible change: a failed scheduled-backup deletion would now close the dialog and show an error toast instead of leaving the dialog open silently.
- **T-237 [P2]** handleImport() issues one unbounded, uncancellable POST per catalog entry — `frontend/src/components/ColorCatalogSettings.tsx` (audit-robustness)
  user-visible change: (no auditor fragment — orchestrator hold; see BASELINE.md for the observable difference)
- **T-229 [P3]** create_backup_zip() writes the output_path archive with default umask permissions — `backend/app/api/routes/settings.py` (audit-security)
  user-visible change: scheduled local backup files stop being readable by other OS users/groups on the backup volume, so any external job that copies them under a different account will start failing with permission denied.

### WONTFIX-AUTO (3)
- T-232 ZohoSettings init effect re-seeds every field on each ['settings'] refetch, discarding in-progress input — duplicate of T-220 (ZohoSettings seededRef guard, BLOCKED pending approval)
- T-240 update_spoolman_settings(): switching Spoolman OFF never has its SpoolmanSlotAssignment-clearing branch (elif was_enabled and not now_enabled) tested — already covered: test_switch_to_internal_mode_clears_spoolman_slot_assignments drives the elif body (coverage arcs 668->669->671->672->673); round-2 finding was wrong
- T-228 update_settings() stores a JSON null as the literal "None", permanently 500-ing GET /settings and /ui-preferences for numeric fields — duplicate of T-199 (same null->"None" write bug, BLOCKED pending approval)

## Operational notes for the next campaign
See BASELINE.md "RUNTIME NOTES": subagents that end their turn waiting for a background job must be resumed; macOS has no `setsid`; run one backend worker at a time (shared backend/.coverage.* files); frontend coverage runs must use a scratchpad reportsDirectory. Auditors under-flag behavior changes — judge every production "fix" before dispatch. Round-2 audit-tests filed one already-covered branch (T-240); round-1 audit-security wrongly reported node_modules absent.
