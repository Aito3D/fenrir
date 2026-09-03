# PLAN (schema v2)

## T-001
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 6
last_touched_iteration: 6
title: formatDuration()/formatDate() copy-pasted verbatim between PrintLogTable.tsx and FileHistoryModal.tsx
files: frontend/src/components/PrintLogTable.tsx
evidence: frontend/src/components/PrintLogTable.tsx:11 · diff of the two functions in frontend/src/components/FileHistoryModal.tsx:15-27 and frontend/src/components/PrintLogTable.tsx:11-22 is empty (byte-identical, both call the shared parseUTCDate from ../utils/date). rg -n '^function formatDuration|^function formatDate' frontend/src -> only these two files define this pair locally. · fix: move formatDuration/formatDate into frontend/src/utils/date.ts (which both files already import parseUTCDate from) and have both components import them
fingerprint: 03aa22df1c35a092
source: audit-cleanliness
reason: user chose rename-and-share: move the local copies into date.ts under distinct names, leaving the existing exports untouched

## T-002
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 7
title: Breakpoint matchMedia boolean hook reimplemented 5 times with different thresholds
files: frontend/src/hooks/useIsMobile.ts
evidence: frontend/src/hooks/useIsMobile.ts:1 · Same useState+useEffect+matchMedia(min/max-width)+addEventListener('change',...) shape appears independently in frontend/src/hooks/useIsMobile.ts:5-25 (768px, max-width), frontend/src/hooks/useIsWideLayout.ts:18-37 (1024px, min-width), frontend/src/hooks/useIsSidebarCompact.ts:5-24 (1144px, max-width), frontend/src/components/calculator/CalculatorMobileSummary.tsx:8-19 (local useBelowXl, 1279px, max-width), and inline in frontend/src/components/Dashboard.tsx:190-210 (parametrized stackBelow, with the addListener/removeListener legacy-browser fallback the other four omit). rg -n 'window.matchMedia' frontend/src confirms these are the only breakpoint-boolean call sites (the rest are one-shot prefers-reduced-motion checks, a different pattern). · fix: extract a single generic useMediaQuery(query: string): boolean (or useBreakpoint(px, direction)) hook in frontend/src/hooks/ and have the four bespoke hooks plus Dashboard.tsx call it with their own breakpoint constant
fingerprint: da5d710d9186609a
source: audit-cleanliness

## T-006
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: TwoFactorSettings has zero test coverage (2FA enable/disable, backup codes)
files: frontend/src/components/TwoFactorSettings.tsx
evidence: frontend/src/components/TwoFactorSettings.tsx:1 · frontend/coverage/coverage-final.json: src/components/TwoFactorSettings.tsx 0/128 statements covered (0.0%) | rg -l 'TwoFactorSettings' frontend/src/__tests__ -> no matches · fix: add frontend/src/__tests__/components/TwoFactorSettings.test.tsx covering: enabling TOTP (QR/secret display), verifying a code, disabling 2FA, regenerating/viewing backup codes, and the invalid-code error path
fingerprint: 75565b11005cd4e6
source: audit-tests

## T-007
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: UsersPage has zero test coverage (user create/edit/delete, role & password changes)
files: frontend/src/pages/UsersPage.tsx
evidence: frontend/src/pages/UsersPage.tsx:1 · frontend/coverage/coverage-final.json: src/pages/UsersPage.tsx 0/168 statements covered (0.0%) | rg -l 'UsersPage' frontend/src/__tests__ -> no matches · fix: add frontend/src/__tests__/pages/UsersPage.test.tsx covering: create user (local + LDAP tab), edit role/permissions, password change, and delete-user confirm flow
fingerprint: 3167aaf2337fd12d
source: audit-tests

## T-008
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: SetupPage (initial admin creation / enabling auth) has zero test coverage
files: frontend/src/pages/SetupPage.tsx
evidence: frontend/src/pages/SetupPage.tsx:1 · frontend/coverage/coverage-final.json: src/pages/SetupPage.tsx 0/40 statements covered (0.0%) | rg -l 'SetupPage' frontend/src/__tests__ -> no matches · fix: add frontend/src/__tests__/pages/SetupPage.test.tsx covering: enabling auth with a new admin account, submitting with auth disabled, and the admin-already-exists success path (data.admin_created false)
fingerprint: 189f863bd111f810
source: audit-tests

## T-009
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: CreateUserAdvancedAuthModal (LDAP/OIDC-aware user creation) has zero test coverage
files: frontend/src/components/CreateUserAdvancedAuthModal.tsx
evidence: frontend/src/components/CreateUserAdvancedAuthModal.tsx:1 · frontend/coverage/coverage-final.json: src/components/CreateUserAdvancedAuthModal.tsx 0/21 statements covered (0.0%) | rg -l 'CreateUserAdvancedAuthModal' frontend/src/__tests__ -> no matches · fix: add frontend/src/__tests__/components/CreateUserAdvancedAuthModal.test.tsx covering the local-vs-external auth source toggle and submit payload shape
fingerprint: 44d354634513dad9
source: audit-tests

## T-010
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: FinancePage (wallet transaction edit/delete, budget parsing) has zero test coverage
files: frontend/src/pages/FinancePage.tsx
evidence: frontend/src/pages/FinancePage.tsx:1 · frontend/coverage/coverage-final.json: src/pages/FinancePage.tsx 0/440 statements covered (0.0%) | rg -l 'FinancePage' frontend/src/__tests__ -> no matches; parsePrintChargeDescription()/parseBudgetValue() (money parsing helpers, lines ~22-50) are never exercised by any test · fix: add frontend/src/__tests__/pages/FinancePage.test.tsx covering: editing a wallet transaction amount, deleting a transaction, budget value parsing/validation, and the partial-print charge description parsing ([aborted:...]/[failed:...]/[cancelled:...] tags)
fingerprint: 0c8ffa7a21ed0424
source: audit-tests

## T-011
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 7
title: PrintModal.test.tsx: 57 of ~59 waitFor() calls rely on the default 1000ms testing-library timeout
files: frontend/src/__tests__/components/PrintModal.test.tsx
evidence: frontend/src/__tests__/components/PrintModal.test.tsx:131 · rg -n 'await waitFor' frontend/src/__tests__/components/PrintModal.test.tsx -> 57 calls with no {timeout} option; the 2 calls that were fixed (lines 1050-1052, 1098) carry the comment "this assertion has flaked at waitFor's 1s default under parallel full-suite CPU load (heavy neighbor files starve this worker)" but the fix was applied to only those 2 of 59 call sites in the same file · fix: in frontend/src/__tests__/components/PrintModal.test.tsx, either raise the global asyncUtilTimeout via a testing-library configure() call in frontend/src/__tests__/setup.ts, or add {timeout: 5000} to all remaining waitFor() calls in this file to match the pattern already used at lines 1050 and 1098
fingerprint: 6cfb84ce23be7d6e
source: audit-tests

## T-012
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 7
title: ModelViewerModal.test.tsx: every waitFor() call uses the default 1000ms timeout, same starvation pattern as PrintModal
files: frontend/src/__tests__/components/ModelViewerModal.test.tsx
evidence: frontend/src/__tests__/components/ModelViewerModal.test.tsx:123 · rg -n 'await waitFor' frontend/src/__tests__/components/ModelViewerModal.test.tsx -> 34 calls, none with a {timeout} override; file is on the KNOWN_FLAKY list · fix: in frontend/src/__tests__/components/ModelViewerModal.test.tsx, add {timeout: 5000} to the waitFor() calls (or raise testing-library's global asyncUtilTimeout in frontend/src/__tests__/setup.ts) to stop them tripping under parallel/coverage CPU load
fingerprint: 80670e9a2b60d230
source: audit-tests

## T-013
priority: P2
status: DONE
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: ArchivesPage.test.tsx: most waitFor() calls still use the default 1000ms timeout despite 4 call sites already bumped to 5000ms
files: frontend/src/__tests__/pages/ArchivesPage.test.tsx
evidence: frontend/src/__tests__/pages/ArchivesPage.test.tsx:117 · rg -n 'await waitFor' frontend/src/__tests__/pages/ArchivesPage.test.tsx -> 40 calls; only 4 have an explicit {timeout: 5000} (lines 793, 834, 875, 893) added after observed flakes -- the other 36 are unguarded; file is on the KNOWN_FLAKY list (excluding the separately-tracked known_broken ZIP-prep-fails test) · fix: in frontend/src/__tests__/pages/ArchivesPage.test.tsx, extend the same {timeout: 5000} treatment (already used at lines 793/834/875/893) to the remaining unguarded waitFor() calls
fingerprint: 1ef5aafc296eef9e
source: audit-tests
reason: covered by T-030: all 40 waitFor and 13 findBy call sites in ArchivesPage.test.tsx guarded in the same commit

## T-014
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 8
title: StatsPageUserFilter1894.test.tsx: both waitFor() assertions use the default 1000ms timeout against a heavy multi-widget StatsPage render
files: frontend/src/__tests__/pages/StatsPageUserFilter1894.test.tsx
evidence: frontend/src/__tests__/pages/StatsPageUserFilter1894.test.tsx:51 · frontend/src/__tests__/pages/StatsPageUserFilter1894.test.tsx lines 51-53 and 68-70: await waitFor(() => { expect(screen.getByText('All Users')).toBeInTheDocument(); }); with no {timeout} option, waiting on StatsPage (which fires many widget queries) to settle; file is on the KNOWN_FLAKY list · fix: in frontend/src/__tests__/pages/StatsPageUserFilter1894.test.tsx, add {timeout: 5000} to both waitFor() calls (lines 51 and 68)
fingerprint: bd1cc68f722d79af
source: audit-tests

## T-015
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 8
title: get_ffmpeg_path() memoizes into a module-level global, making test_get_ffmpeg_path_from_shutil_which order-dependent
files: backend/app/services/camera.py
evidence: backend/app/services/camera.py:98 · backend/app/services/camera.py:98-127 get_ffmpeg_path() reads/writes a module-level `global _ffmpeg_path` cache and returns the cached value on any call after the first (line 106-107: if _ffmpeg_path is not None: return _ffmpeg_path); backend/tests/unit/services/test_external_camera.py:254-260 patches shutil.which and asserts the mocked value is returned, but never resets _ffmpeg_path to None first -- if any earlier test in the same worker process already populated the cache with the real system ffmpeg path (or None), this test reads the stale cached value instead of the mock and fails; passes in isolation because nothing has populated the cache yet · fix: in backend/tests/unit/services/test_external_camera.py, add monkeypatch.setattr('backend.app.services.camera._ffmpeg_path', None) (or an autouse fixture resetting the module global) before patching shutil.which in TestGetFfmpegPath, so the test no longer depends on execution order
fingerprint: 5b405cfdc14a942b
source: audit-tests

## T-016
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 8
title: _wait_for_job() polls on a wall-clock deadline, making cross-class-arrange test flaky under CPU-starved parallel runs
files: backend/tests/integration/test_library_slice_api.py
evidence: backend/tests/integration/test_library_slice_api.py:83 · backend/tests/integration/test_library_slice_api.py:83-98 _wait_for_job loops `while asyncio.get_event_loop().time() < deadline: ... await asyncio.sleep(0.05)` against a real timeout budget; test_cross_class_arrange_survives_user_leaving_the_box_unticked (line 1198) calls it with timeout=15.0 (line 1261, already raised above the 5.0s default) yet still fails under -n 30 parallel load per KNOWN_FLAKY -- the assumption that the dispatcher's asyncio task gets scheduled within the wall-clock window doesn't hold when 30 workers contend for CPU · fix: in backend/tests/integration/test_library_slice_api.py, either poll on task-completion via an event/future the dispatcher signals instead of a wall-clock deadline, or make the slice dispatcher advance under a controllable/injectable clock so the test doesn't depend on real scheduling latency under load
fingerprint: 17a7647bda4b6327
source: audit-tests

## T-017
priority: P0
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: restore_backup() deletes the live data directories before copying, then reports success when the copy fails
files: backend/app/api/routes/settings.py
evidence: backend/app/api/routes/settings.py:1334 · The restore loop clears the destination first -- `for item in dest_dir.iterdir(): ... shutil.rmtree(item)` / `item.unlink()` -- and only then runs `shutil.copytree(item, dest_item)` (line 1345). The copy is wrapped in `except OSError as e: logger.warning("Could not restore %s directory: %s", name, e); skipped_dirs.append(name)` (line 1348), and the handler still returns {"success": True, "message": "Backup restored successfully..."} with only a " Note: Some directories could not be restored (archive)." appended. The ZIP has already been unpacked into a TemporaryDirectory on the same filesystem, so ENOSPC part-way through copying archive/ is the likely case, not the exotic one: the user's entire print archive (3MFs, timelapses, photos) has been erased, the replacement is half-written, and the UI says the restore succeeded. · fix: Copy into a sibling staging directory and swap it in only after the copy completes, or snapshot the destination before deleting so a failed copy can be undone; on any copy failure return a 500 rather than success=True. · user-visible change: a restore whose file copy fails will report failure (HTTP 500) instead of returning success with a note in the message.
fingerprint: d5f51f6512777ebe
source: audit-robustness
reason: user-approved behavior change

## T-018
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: create_backup_zip() runs copytree and ZIP compression synchronously on the event loop
files: backend/app/api/routes/settings.py
evidence: backend/app/api/routes/settings.py:814 · create_backup_zip is `async def` but every heavy step is blocking sync I/O with no await: shutil.copytree(src_dir, temp_path / name) (line 814) over base_dir/archive -- every archived 3MF, timelapse and photo, routinely gigabytes -- followed by `with zipfile.ZipFile(zip_file, "w", zipfile.ZIP_DEFLATED) as zf: for file_path in temp_path.rglob("*"): ... zf.write(file_path, arcname)` (line 849). Nothing yields for the minutes this takes. The scheduled 03:00 local backup (local_backup.run_backup) and the /settings/backup download both call it, so the whole FastAPI process freezes for the duration: no HTTP request is served, MQTT status callbacks queued onto the loop don't run, and WebSocket clients miss their keepalives and reconnect-storm when the loop finally resumes. services/printer_media.py already wraps the same kind of work in asyncio.to_thread, so this is inconsistent with house style, not an accepted trade-off. · fix: Move the copytree + zip body into asyncio.to_thread (as printer_media.py does for shutil.rmtree); restore_backup's zf.extractall / src_conn.backup / copytree block in the same file needs the same treatment.
fingerprint: a4110c3eff770b63
source: audit-robustness

## T-019
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: restore_backup() loads the entire uploaded backup ZIP into memory
files: backend/app/api/routes/settings.py
evidence: backend/app/api/routes/settings.py:1148 · `content = await file.read()` followed by `with zipfile.ZipFile(io.BytesIO(content), "r") as zf: ... zf.extractall(temp_path)`. The backup ZIP is a full snapshot of the archive/timelapse tree, so it is exactly as large as the data it protects -- multi-GB is the normal case, not the edge case. Restoring one holds the compressed bytes in content, the BytesIO view, and the decompressed tree on disk simultaneously; in a memory-capped container the process is OOM-killed mid-restore, which is precisely when the destination directories have already been cleared. · fix: Stream the UploadFile to a temp file in chunks (shutil.copyfileobj(file.file, tmp)) and open the ZipFile from that path instead of BytesIO.
fingerprint: 926d354c4be8d01d
source: audit-robustness

## T-020
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: ConnectionManager.broadcast() awaits every client send serially while holding the shared lock
files: backend/app/core/websocket.py
evidence: backend/app/core/websocket.py:52 · `async with self._lock: for connection in self.active_connections: try: await connection.send_text(data)`. uvicorn's websocket transport applies backpressure, so send_text to a client whose TCP window is full (a laptop that slept with the dashboard open, a phone on a dead cell link) does not return until the socket drains or dies. Every other broadcaster -- printer_status, print_complete, FTP upload progress, aito_changed -- plus connect() and disconnect() all take this same self._lock, so one wedged viewer stalls live updates for every other user in the farm and blocks new WebSocket connections from being registered. There is no send timeout anywhere on this path. · fix: Fan out with asyncio.gather(..., return_exceptions=True) under an asyncio.wait_for per send, and take a snapshot of active_connections under the lock rather than holding it across the I/O. · user-visible change: a client that cannot accept a broadcast within the timeout will be dropped from the connection list and have to reconnect, instead of silently holding everyone else up.
fingerprint: a64eb8fc7279adb2
source: audit-robustness
reason: user-approved behavior change

## T-021
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: _perform_update() runs git/pip/npm with no timeout and permanently wedges the updater when one hangs
files: backend/app/api/routes/updates.py
evidence: backend/app/api/routes/updates.py:683 · Every step is `await process.communicate()` with no asyncio.wait_for -- git fetch --prune --tags --force origin (line 790), git reset --hard (line 826), pip install -r requirements.txt (line 862), npm install (line 887). git has no default network timeout, so a half-open TCP connection to github.com leaves communicate() pending forever with _update_status['status'] stuck on 'downloading'. apply_update gates on exactly that value (line 933) and nothing ever resets it -- so the user's progress bar sits at 20% and every retry is refused until the process is restarted. · fix: Wrap each process.communicate() in asyncio.wait_for, kill the process on timeout, and set _update_status to the error shape so the guard clears. · user-visible change: an update that currently hangs indefinitely will instead fail with a timeout error after a bounded wait, and the Update button becomes usable again.
fingerprint: ab1de1574f4edb1a
source: audit-robustness
reason: reopened: verifier showed the reap path is itself unbounded (grandchildren hold the pipe open), so the approved bounded-wait is not fully delivered

## T-022
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: apply_update() checks the in-progress guard, then awaits, then sets it -- two concurrent requests both start an update
files: backend/app/api/routes/updates.py
evidence: backend/app/api/routes/updates.py:925 · The guard `if _update_status['status'] in ['downloading', 'installing']` runs at line 933, but `target_ref = await _discover_target_release(db)` (line 988) yields to the loop before _update_status is finally assigned at line 995. Two admins (or a double-clicked button) landing inside that GitHub round-trip both pass the guard and both background_tasks.add_task(_perform_update, target_ref). Two git fetch + git reset --hard + pip install runs then execute concurrently in the same working tree: one aborts on index.lock, and pip installing over itself can leave a half-written site-packages, so the app fails to import on restart. · fix: Set _update_status to the in-progress shape synchronously right after the guard (before any await), or hold an asyncio.Lock across the check-and-set. · user-visible change: a second /apply issued while an update is starting now reliably returns 'Update already in progress' instead of sometimes starting a second update.
fingerprint: b5e8c80b53f0e4fd
source: audit-robustness
reason: user-approved behavior change

## T-023
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: _on_message() catches only JSONDecodeError, so any parser error kills the paho network thread
files: backend/app/services/bambu_mqtt.py
evidence: backend/app/services/bambu_mqtt.py:1843 · `self._process_message(payload)` (line 1842) is followed by `except json.JSONDecodeError: pass` and nothing else. paho is left at suppress_exceptions = False, so anything else raised inside the ~7000-line status parser is re-raised by _handle_on_message on the network thread; loop_forever catches only OSError, so the thread dies and that printer's MQTT session never reconnects -- its card goes permanently stale until the whole app is restarted. The code already knows this: two field parsers at lines 3796 and 3812 carry comments saying an escaping exception 'takes the printer connection down over one unusable field', but they patch two fields rather than the entry point, so the next firmware that ships an unexpected type in any other field reproduces it. · fix: Add a trailing `except Exception: logger.exception(...)` to _on_message so one bad frame is dropped rather than taken out on the connection. · user-visible change: a printer whose firmware sends a frame the parser cannot handle stays connected (with that frame logged and skipped) instead of going permanently offline.
fingerprint: 7bbce17a02248365
source: audit-robustness
reason: user-approved behavior change

## T-024
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: _stream_mjpeg() grows its frame buffer without a cap when no JPEG end marker arrives
files: backend/app/services/external_camera.py
evidence: backend/app/services/external_camera.py:882 · Inside `async for chunk in response.content.iter_chunked(8192)` the inner loop does end_idx = buffer.find(jpeg_end, 2) / `if end_idx == -1: break` (line 901), falling back to the outer loop which appends the next chunk. Once a \xff\xd8 has been seen and no \xff\xd9 ever follows -- a user-configured URL that returns an HTML error page, a non-MJPEG content type, or a camera emitting a corrupt frame -- nothing ever trims the buffer and it grows for as long as the stream is open (ClientTimeout(total=None), so indefinitely), until the server is OOM-killed. _capture_mjpeg_frame two functions above already guards this exact case with `if len(buffer) > 5 * 1024 * 1024:` (line 484); the streaming path was never given the same cap. · fix: Apply the same 5 MB ceiling used in _capture_mjpeg_frame: bail out of the stream (or reset the buffer) once it exceeds the limit without yielding a frame. · user-visible change: an external camera URL that never emits a complete JPEG will end its stream with an error instead of appearing to stay connected.
fingerprint: f6852b0727afcf6a
source: audit-robustness
reason: user-approved behavior change

## T-025
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: process_timelapse() writes to temp paths keyed only on archive_id, so concurrent requests clobber each other
files: backend/app/api/routes/archives.py
evidence: backend/app/api/routes/archives.py:3119 · audio_temp_path = Path(tempfile.gettempdir()) / f'audio_{archive_id}{suffix}' and temp_output = Path(tempfile.gettempdir()) / f'processed_{archive_id}.mp4' (line 3128) are fixed, predictable names with no per-request component. Two requests for the same archive (a double-clicked Save, or two operators editing the same timelapse) both write processed_<id>.mp4: one ffmpeg re-encode writes into the file the other is about to shutil.move(str(output_path), str(timelapse_path)) (line 3153) over the original, so save_mode='replace' can overwrite the archived timelapse with a truncated file. The finally block also unlinks audio_temp_path while the other request's ffmpeg may still be reading it. On the success is False path temp_output is never removed either, so /tmp accumulates whole mp4s. · fix: Allocate both paths inside a per-request tempfile.TemporaryDirectory() so each invocation gets its own names and cleanup is automatic.
fingerprint: 369e2d5751d01ee2
source: audit-robustness

## T-026
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: _temp_based_off() and _delayed_off() leave auto_off_pending set when the turn-off does not happen
files: backend/app/services/smart_plug_manager.py
evidence: backend/app/services/smart_plug_manager.py:623 · _schedule_temp_based_off marks the row pending up front (spawn_background_task(self._mark_auto_off_pending(plug.id, True), ...), line 494), but _temp_based_off only clears it via _mark_auto_off_executed on `if success:`. When the poll loop times out it does logger.warning('Temperature-based turn-off timed out for plug %s after %ss', plug_id, max_wait) (line 623) and returns with the flag still True; likewise when service.turn_off(plug_info) returns False (plug briefly unreachable -- tasmota/rest turn_off return False rather than raising). The plug is never powered down, no retry is scheduled, and the UI keeps showing 'auto-off pending' forever, so an operator relying on auto-off leaves a printer energised overnight with the dashboard claiming a shutdown is queued. · fix: Clear the pending flag (and log at error level) on both the timeout path and the success is False path, mirroring the is_print_active skip path which already calls _mark_auto_off_pending(plug_id, False). · user-visible change: a plug whose auto-off failed or timed out will stop showing 'auto-off pending' in the UI and will surface an error instead.
fingerprint: e1907e9afa018a56
source: audit-robustness
reason: user-approved behavior change

## T-027
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: computeSha256 is fanned out with Promise.all, reading every selected file into memory at once
files: frontend/src/components/FileUploadModal.tsx
evidence: frontend/src/components/FileUploadModal.tsx:164 · `const withHashes = await Promise.all(checkable.map(async (uf) => { try { const hash = await computeSha256(uf.file); ... } catch { return uf; } }))` and computeSha256 starts with `const buffer = await file.arrayBuffer()` (line 20) -- the whole file, plus a second copy inside crypto.subtle.digest. There is no concurrency cap, so dragging a folder of 3MFs into the library upload modal allocates every file simultaneously: 50 x 40 MB is ~4 GB of live ArrayBuffers and the tab is killed by the browser. If it survives, the per-file `catch { return uf; }` swallows the RangeError, so the affected files silently skip duplicate detection and get re-uploaded with no message. · fix: Hash with a bounded worker pool (2-4 at a time) and stream each file through the digest in slices instead of one arrayBuffer(); surface the per-file failure rather than returning the unhashed entry silently.
fingerprint: 1e9fca333dabe51d
source: audit-robustness

## T-028
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: request() issues every API call with no AbortSignal, so a stalled backend hangs the UI forever
files: frontend/src/api/client.ts
evidence: frontend/src/api/client.ts:128 · `const response = await fetch(API_BASE + endpoint, { ...options, cache: 'no-store', credentials: 'include', headers });` -- no signal, no timeout, and this is the shared helper behind essentially every call in the client. When the backend event loop is blocked (see create_backup_zip) or a reverse proxy silently drops the connection, the promise never settles: React Query never fires onError or its retry, mutation buttons stay in their disabled spinner state, and the user's only recourse is a page reload. · fix: Give request() a default signal: AbortSignal.timeout(...) (merged with any caller-supplied signal), with an opt-out or a longer value for the known long-running endpoints (backup, restore, timelapse process, slicing). · user-visible change: requests that currently hang indefinitely will reject with a timeout error, so users see an error toast instead of a permanent spinner.
fingerprint: 506b47a29a830707
source: audit-robustness
reason: user-approved behavior change

## T-029
priority: P3
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: _safe_execute() swallows 'no such column' for every statement, not just RENAME COLUMN
files: backend/app/core/database.py
evidence: backend/app/core/database.py:1583 · `if (not any(k in msg for k in ('already exists', 'duplicate key', 'duplicate column name', 'no such column')) and not column_not_exists): ... raise`. The PostgreSQL equivalent is correctly narrowed -- column_not_exists = 'rename column' in sql.lower() and ... -- but the SQLite 'no such column' key is not gated on the statement kind. A CREATE INDEX ... ON t(col) naming a column that a prior migration failed to add raises 'no such column' on SQLite and is silently swallowed, so the index is permanently absent (the query it was meant to serve degrades under load) while the same DDL on Postgres aborts startup loudly. The docstring claims 'Any other error is logged and re-raised', which is not what the code does. · fix: Gate 'no such column' on 'rename column' in sql.lower() the same way column_not_exists already is. · user-visible change: a migration statement that references a genuinely missing column on SQLite will now abort startup instead of being silently skipped.
fingerprint: 9a5e1ba8ecc98b57
source: audit-robustness
reason: user-approved behavior change

## T-030
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: fix known-broken test: ArchivesPage 'shows a toast when printer video ZIP preparation fails'
files: frontend/src/__tests__/pages/ArchivesPage.test.tsx,frontend/src/pages/ArchivesPage.tsx
evidence: Pre-existing failure recorded in BASELINE.md known_broken. Failed in 4/4 baseline full runs AND when the file is run alone on an idle machine (npx vitest run src/__tests__/pages/ArchivesPage.test.tsx -> 1 failed | 38 passed), so it is genuinely broken rather than load-flaky. Fix it WITHOUT changing product behaviour: determine whether the test's expectation or the component's toast-on-ZIP-failure path is wrong, and say which in the commit message. If the component is at fault the fix is a bug fix (in scope); if the test is at fault, correct the test.
fingerprint: 
source: survey

## T-031
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: printer-control routes skip the API key printer_ids allowlist in pause_print and siblings
files: backend/app/api/routes/printers.py
evidence: backend/app/api/routes/printers.py:3356 · @router.post('/{printer_id}/print/pause') async def pause_print(printer_id: int, _=RequirePermissionIfAuthEnabled(Permission.PRINTERS_CONTROL), | contrast list_printer_files:1580 `_=RequirePrinterPermissionIfAuthEnabled(Permission.PRINTERS_FILES)` | check_printer_access() at core/auth.py:1606 is reached only via require_printer_permission_if_auth_enabled (core/auth.py:1683), which appears in printers.py on the 10 PRINTERS_FILES routes only · fix: swap RequirePermissionIfAuthEnabled for RequirePrinterPermissionIfAuthEnabled on every handler whose path carries {printer_id} (print/pause, print/resume, print/stop, temperature/*, fan-speed, *-jog, home-axes, ams/load, ams/unload, hms/*, clear-plate, connect, disconnect, drying/*, slot-presets/*, calibration, DELETE /{printer_id}); the same gap exists in print_queue.py:2048, spoolman.py:207, maintenance.py:498/708, inventory.py:1927 and calculator.py:321/342 · user-visible change: an API key created with a printer_ids allowlist that is today able to pause, heat, jog or delete printers outside its list will start receiving 403 on those printers.
fingerprint: 25b8e4938074eb9f
source: audit-security
reason: user-approved behavior change

## T-032
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: delete_old_history destroys AMS sensor history behind a read-only permission
files: backend/app/api/routes/ams_history.py
evidence: backend/app/api/routes/ams_history.py:103 · @router.delete('/{printer_id}') async def delete_old_history(... _: User | None = RequirePermissionIfAuthEnabled(Permission.AMS_HISTORY_READ), · fix: gate the DELETE on a write-level permission -- core/permissions.py defines only AMS_HISTORY_READ, so either add an AMS_HISTORY_DELETE permission or reuse an existing admin-level one, and remove the read permission from the gate; also add the per-printer allowlist check since the path is printer-scoped · user-visible change: members of the built-in 'Viewers' role (described as read-only, granted AMS_HISTORY_READ at core/permissions.py:543) can currently purge AMS humidity/temperature history and would start getting 403.
fingerprint: 501bec0f9de38848
source: audit-security
reason: user-approved behavior change

## T-033
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 6
title: delete_old_history destroys printer sensor history behind a read-only permission
files: backend/app/api/routes/printer_sensor_history.py
evidence: backend/app/api/routes/printer_sensor_history.py:110 · @router.delete('/{printer_id}') async def delete_old_history(... _: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTER_SENSOR_HISTORY_READ), · fix: gate the DELETE on a write-level permission rather than PRINTER_SENSOR_HISTORY_READ (core/permissions.py:136 defines only the read variant, so a new permission or an existing admin one is needed), and add the per-printer allowlist check · user-visible change: the built-in 'Viewers' role holds PRINTER_SENSOR_HISTORY_READ (core/permissions.py:544) and can currently purge sensor history; it would start getting 403.
fingerprint: e379fad7edc6037f
source: audit-security
reason: user-approved behavior change

## T-034
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 6
title: window.open on unvalidated archive.external_url in the archive card globe button
files: frontend/src/pages/ArchivesPage.tsx
evidence: frontend/src/pages/ArchivesPage.tsx:2509 · onClick={() => window.open((archive.external_url || archive.makerworld_url)!, '_blank')} | backend/app/schemas/archive.py:23 and :102 declare `external_url: str | None = None` with no field_validator, unlike backend/app/schemas/external_link.py:16 which enforces `if not v.startswith(('http://', 'https://')): raise ValueError` · fix: add a scheme field_validator to external_url and makerworld_url in backend/app/schemas/archive.py mirroring external_link.py, and re-check the scheme in the frontend before window.open (ArchivesPage.tsx lines 629, 1466, 2115 and 2509 all share the sink); normalise a scheme-less value to https:// rather than dropping it
fingerprint: f1e3553e8a5f4cbe
source: audit-security

## T-035
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: plate-detection calibration mutations gated on CAMERA_VIEW in delete_reference and siblings
files: backend/app/api/routes/camera.py
evidence: backend/app/api/routes/camera.py:3300 · @router.delete('/{printer_id}/camera/plate-detection/references/{index}') async def delete_reference(... _: User | None = RequirePermissionIfAuthEnabled(Permission.CAMERA_VIEW), · fix: gate calibrate_plate_detection (line 3051), delete_plate_calibration (3125), update_reference_label (3274) and delete_reference (3300) on a write-level printer permission (e.g. PRINTERS_UPDATE) instead of CAMERA_VIEW, and use RequirePrinterPermissionIfAuthEnabled so the API-key printer allowlist applies · user-visible change: the built-in 'Viewers' role holds CAMERA_VIEW and can today delete a printer's empty-plate reference images -- disabling the occupied-bed safety check -- and would start getting 403.
fingerprint: ee7d6b5a0abe803d
source: audit-security
reason: user-approved behavior change

## T-036
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: stop_logging flips the persisted debug setting and runtime log level under SETTINGS_READ
files: backend/app/api/routes/bug_report.py
evidence: backend/app/api/routes/bug_report.py:73 · @router.post('/stop-logging', response_model=StopLoggingResponse) async def stop_logging(was_debug: bool = Query(default=False), _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_READ), | its counterpart start_logging (line 50) uses Permission.SETTINGS_UPDATE · fix: require SETTINGS_UPDATE on stop-logging to match start-logging, since it calls _set_debug_setting(db, False) and _apply_log_level(False) on the whole process · user-visible change: a SETTINGS_READ-only principal (the built-in 'Viewers' role) can currently turn the server's debug logging off and would start getting 403.
fingerprint: 767ea5cd9e4d99d0
source: audit-security
reason: user-approved behavior change

## T-037
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: submit_bug_report ships install support info off-box under SETTINGS_READ
files: backend/app/api/routes/bug_report.py
evidence: backend/app/api/routes/bug_report.py:90 · @router.post('/submit', response_model=BugReportResponse) async def submit_bug_report(report: BugReportRequest, _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_READ), | services/bug_report.py:1 'posts to the bambuddy.cool relay which holds the GitHub PAT' · fix: require SETTINGS_UPDATE (or a dedicated support/bug-report permission) for the endpoint that forwards _collect_support_info() to the external relay · user-visible change: a read-only 'Viewers' account can currently publish this install's support bundle to the external relay and would start getting 403; the feature only functions when BUG_REPORT_RELAY_URL is configured.
fingerprint: b9e33865833ea8b3
source: audit-security
reason: user-approved behavior change

## T-038
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: verify_camera_stream_token is an unscoped capability accepted by 20 non-camera endpoints
files: backend/app/core/auth.py
evidence: backend/app/core/auth.py:843 · async def verify_camera_stream_token(token: str) -> bool: 'Verify a camera stream token is valid (reusable -- does not consume it).' | the token is minted by camera.py:2280 create_stream_token behind Permission.CAMERA_VIEW alone and carries no printer_id and no resource binding | RequireCameraStreamTokenIfAuthEnabled additionally gates archives.py (8 sites incl. /timelapse, /photos/, /project-image/), library.py (3), print_log.py, projects.py, printers.py /cover and external_links.py · fix: bind the token to the resource class it was minted for (mirroring create_slicer_download_token's nonce=f'{resource_type}:{resource_id}' at core/auth.py:694) so an archive/library/project media endpoint requires a token issued for that domain, and check the API key's printer_ids when the token is minted for a printer camera · user-visible change: an integration (Home Assistant, OBS, kiosk) that today reuses one camera-stream or long-lived STREAM_SCOPES token to fetch archive thumbnails, timelapses and project images would need a separately scoped token for those.
fingerprint: 961b93625beeff7f
source: audit-security
reason: user-approved behavior change

## T-039
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: extract_filament_requirements parses uploaded 3MF XML with stdlib ElementTree instead of defusedxml
files: backend/app/services/filament_requirements.py
evidence: backend/app/services/filament_requirements.py:56 · import xml.etree.ElementTree as ET | root = ET.fromstring(content) # noqa: S314 # nosec B314 | semgrep:python.lang.security.use-defused-xml.use-defused-xml | every other 3MF parse site uses defusedxml (utils/threemf_tools.py:23, api/routes/library.py:2968, api/routes/archives.py:3390, api/routes/printers.py:1700, api/routes/print_queue.py:9, services/slice_preview.py:39) · fix: import defusedxml.ElementTree as ET here as the rest of the codebase does, so a DTD in Metadata/slice_info.config raises EntitiesForbidden instead of expanding; backend/app/services/virtual_printer/manager.py:1253 has the identical inline stdlib import and should change with it
fingerprint: a3c6fcfb58473df5
source: audit-security

