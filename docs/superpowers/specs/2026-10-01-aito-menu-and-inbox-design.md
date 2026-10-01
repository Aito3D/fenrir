# Aito card menu actions and the notification inbox — design

Date: 2026-10-01. Branch `aito-menu-inbox`. Follows the card-merge feature (adf46aacc).

Agreed in chat with the operator (Aito3D). Two halves, shipped in this order:

- **Part A — the ⋯ menu on the Stage card grows:** Split, Move tasks, Copy summary,
  Transfer to another client, Print job ticket; Duplicate and Move to trash move into it;
  disabled items show a reason; `.` opens it.
- **Part B — a notification inbox:** a bell accessible from every page (sidebar bottom row
  first icon; right of the phone top bar), per-user rows, per-kind preferences in Settings,
  a chime on arrival, "Watch this card" per project, and deep links so a row opens the thing
  it is about. Designed for Aito kinds now and printer kinds later.

The GitHub link leaves both sidebar icon rows for good (operator decision).

---

## Part A — menu actions

### A0. Shared menu (`ActionMenu`)

`MobileMenu` becomes `ActionMenu` (same file renamed, same props plus):

- `items[].disabled?: boolean` and `items[].hint?: string` — a disabled row is muted,
  `aria-disabled`, not clickable, and shows `hint` as a second muted line.
- `items[].separatorBefore?: boolean` — a `role="separator"` rule above the row.
- `items[].danger?: boolean` — red text (Trash).

`MobileBoard`, `TabletBoard` and `ProjectActionsMenu` import the new name; their behaviour
does not change. `ProjectActionsMenu` is always rendered on the Stage card while the panel is
open (no more hiding), takes the project + permissions, and computes every row's `disabled`
and `hint` from one place:

| Row | Disabled when (hint key) |
|---|---|
| Merge another card… | invoiced (`aito.hintInvoiced`), trashed (`aito.hintTrashed`), lacks update+delete (`aito.hintNoPermission`) |
| Split into a new card… | invoiced, trashed, fewer than 2 tasks (`aito.hintNeedTwoTasks`), lacks update+create |
| Move tasks to another card… | invoiced, trashed, no tasks (`aito.hintNoTasks`), lacks update |
| Copy summary | never |
| Print job ticket | never |
| Transfer to another client… | invoiced, trashed, lacks update |
| Duplicate | lacks create, or host passes no `onDuplicate` |
| Move to trash (danger, separator before) | trashed, lacks delete, or host passes no `onDelete` |

Keyboard: while the panel is open and `document.activeElement` is not an input, textarea,
select or contenteditable, the `.` key opens the menu (focus lands on the menu, as today).

The Record card loses the Duplicate action; the panel footer loses the DeleteHoldButton. Trash
from the menu opens `ConfirmModal` (variant danger) whose confirm control is the existing
`HoldButton` (1000 ms), so the hold-to-confirm survives the move. The panel still calls the
host's `onDelete` once confirmed.

### A1. Split into a new card (`TaskTransferModal`, mode `split`)

Modal over the panel (z-[110], same shell as MergeProjectModal). Step 1 lists the project's
tasks with a checkbox each (none ticked), showing title, steps and price; a "Select all"
link. The Split button is enabled when 1 ≤ ticked < total. Below the list: "The ticked
tasks move to a new card for {client}. Done ticks are kept only if this card is accepted."

On confirm → `POST /aito/{id}/tasks/transfer` with `{task_ids, target_project_id: null}`.
On success: toast `aito.splitDone` ("{{count}} task(s) moved to #{{id}}"), invalidate
`['aito-tasks', source]`, `['aito-events', source]`, `['aito-projects']`, close the modal, and
call `onOpenCard(newId)` so the panel swaps to the new card.

### A2. Move tasks to another card (`TaskTransferModal`, mode `move`)

Same step 1 (Move enabled when ≥ 1 ticked; moving all is allowed and the note says "This card
will be left without tasks"). Step 2 is the merge picker list (reuse `mergeCandidates`,
`matchesCandidate` and the row component extracted from MergeProjectModal into
`CandidateList`). Confirm → same route with a real `target_project_id`. On success: toast
`aito.moveTasksDone`, invalidate tasks/events of both cards and the board, close; the panel
stays on the source.

### A3. Backend: `POST /aito/{project_id}/tasks/transfer`

Body `AitoTaskTransfer { task_ids: list[int] (1..300, unique), target_project_id: int | None }`.
Gate: `RequirePermissionIfAuthEnabled(AITO_UPDATE)`; when `target_project_id is None` the
handler additionally requires `AITO_CREATE` on `current_user` (403, same inline pattern as
`add_task`'s tick check), because it creates a card.

Rules, in order:
1. source = active or 404; `_reject_task_change_if_invoiced(source)` (409).
2. `task_ids` must all belong to the source → else 409 "task list changed".
3. `target is None`: moving every task is refused (409 "cannot split off every task"); the new
   card copies from the source: description (`"{source.description} — suite"` is NOT used;
   it copies the description verbatim), client_id/name/phone/email/is_company,
   client_contact_person_id, client social pair, quote_salesperson, created_by = actor;
   column starts at `devis`, position = append; quote_status `draft`, `quote_sync_state`
   `pending` via `_mark_pending`. The new card is flushed to get its id.
4. `target` given: target ≠ source (409), active or 404, not invoiced (409).
5. Move: `task.project_id = target.id`, positions appended after the target's max in the
   source order; remaining source tasks renumbered 0..n. Done ticks are cleared on the moved
   rows unless the target's `quote_status == "accepted"` (new card: always cleared).
6. Events: source gets `task.transferred_out` (story, subject the target card, detail
   `{task_count, target_id, split: bool}`); target gets `task.transferred_in` (story, subject
   the source). Both registered in `KINDS`.
7. Both marked pending (`_mark_pending_if_ours`), `_apply_rules` on both with fresh
   summaries (the source may step back a column, the target forward), commit + wake,
   requeue-marker bump for both, broadcast `task` for both ids.
8. Response: `AitoTaskTransferResponse { source: AitoProjectResponse, target: AitoProjectResponse }`.

Tests (`test_aito_task_transfer.py`): split creates the card with copied client fields and
the right positions on both sides; move appends after the target's tasks; done ticks rule;
every-task split refused; foreign/duplicate ids 409; invoiced either side 409; trashed 404;
events on both; permission sweep counts (+1 route, +1 write).

### A4. Copy summary (frontend only)

Menu row → builds the text and writes it with `navigator.clipboard.writeText`; falls back to a
hidden textarea + `execCommand('copy')` when the API is absent (iframe/HTTP). Toast
`aito.summaryCopied`. Format (one line each, blank line between blocks):

```
#41 · DEV26-2656 · Client de passage
Pièce carrosserie de BMW X3
- Pièce carrosserie de BMW X3 — 3 750 FCFP
- Boite pelicule — 31 000 FCFP
Total 34 750 FCFP
https://…/t/<token>          (only when a tracking link exists)
```

Money through `formatMoney(…, currency)`; the tracking link from the existing
`['aito-tracking-link', id]` query (`api.getAitoTrackingLink`), fetched on demand when the
row is chosen, so the menu costs no request.

### A5. Transfer to another client

Modal `TransferClientModal`: the existing `ClientCombobox` (Zoho search; `onCreateNew` is
not offered here) plus the walk-in choice the drawer has (`default_contact_id` from
`zoho-status`). Picking a contact shows a confirmation line "From {old} to {new}" and the
Transfer button.

Backend `PUT /aito/{project_id}/transfer-client`, body `AitoClientTransfer { client_id,
client_name, client_phone?, client_email?, client_is_company?, client_contact_person_id? }`
(same caps as `AitoProjectCreate`). Gate AITO_UPDATE. Rules: active or 404; invoiced → 409;
same client_id → 200 no-op (no event, no wake). Writes the six client fields, clears the
social pair (it belongs to the old client), keeps quote status (operator decision: a sent
quote stays sent), marks pending so the sync pushes the estimate's new customer, records
`client.transferred` (story, detail `{from_id, from_name, to_id, to_name}`), broadcasts
`project`. Response `AitoProjectResponse`.

Frontend on success: toast `aito.transferClientDone`, invalidate board + events + client
history keys, close.

Tests: fields written and social cleared; invoiced 409; trashed 404; no-op on same id;
event detail; pending marked; permission sweep (+1 route, +1 write).

### A6. Print job ticket (frontend only)

Menu row → `printJobTicket(project, tasks, services, trackingUrl)` renders `JobTicket` (a
React view) into a hidden iframe and calls `print()` — the pattern `ShippingLabelButton`
uses (`usePrintBlob` / iframe print). One A4 page, no prices:

- Header: card number, quote number, client name + phone, promised date, created date.
- QR of the tracking URL when one exists (reuse the tracking page's QR dependency if present
  in `package.json`; otherwise the plain URL in monospace).
- Description.
- One block per task: title, then one row per enabled step with a tick box, the step name,
  and the step's details (printer name, filament + colour, quantity, weight, time for
  Printing; quantity for Scan/Modeling/Machining; description under the row when present).
- Footer: "Printed {date} by {user}".

Printer and filament names come from the panel's existing printer/filament queries (same keys
as `ImpressionFields`).

Tests: a render test of `JobTicket` asserting the sections and that no money appears.

### A7. Locale keys (all 15 locales, `aito.*` unless noted)

`moreActions` exists. New: `splitProject`, `moveTasks`, `copySummary`, `printJobTicket`,
`transferClient`, `trashProject` (menu row), `hintInvoiced`, `hintTrashed`,
`hintNoPermission`, `hintNeedTwoTasks`, `hintNoTasks`, `transferTitleSplit`,
`transferTitleMove`, `transferSelectAll`, `transferNoteSplit`, `transferNoteMoveAll`,
`transferPickTarget`, `transferBack`, `splitConfirm`, `moveConfirm`,
`splitDone_one/_other`, `moveTasksDone_one/_other`, `summaryCopied`, `summaryTotal`,
`transferClientTitle`, `transferClientBody`, `transferClientFromTo`, `transferClientConfirm`,
`transferClientDone`, `jobTicketTitle`, `jobTicketPrintedBy`, `trashConfirmTitle`,
`trashConfirmBody`, `trashConfirmHold`. Roughly 40 keys.

---

## Part B — notification inbox

### B1. Data model

```
notifications            -- generic: Aito today, printers later
  id, user_id (FK users, index), kind (str 40), family (str 16: 'aito' | 'printer'),
  title (str 200), body (str 500), target_type (str 32 | null), target_id (int | null),
  created_at, read_at (null = unread)
aito_watches
  id, user_id, project_id, kinds_json (list[str]), created_at   -- unique (user_id, project_id)
user_inbox_preferences
  id, user_id (unique), kinds_json (list[str] enabled), sound_kinds_json (list[str]),
  auto_watch (bool, default true), created_at, updated_at
```

All three are new tables (create_all) and need the three model-import registrations
(models/__init__, init_db, tests conftest). `notifications` rows older than 30 days are
deleted by the existing hourly sweep (`aito_invoice_sweep` gets a sibling step).

Kinds (`backend/app/services/inbox.py: KINDS`), each with family, default-enabled, title key
and the Aito event kind that produces it:

| inbox kind | family | from event | default |
|---|---|---|---|
| `aito.quote_viewed` | aito | `quote.viewed` | on |
| `aito.quote_accepted` | aito | `quote.accepted` | on |
| `aito.quote_declined` | aito | `quote.declined` | on |
| `aito.paid` | aito | `payment_link.paid`, `payment.terminal.paid`, `payment.manual.recorded`, `invoice.paid`* | on |
| `aito.overdue` | aito | `project.due.overdue` (new, emitted by the hourly sweep once per card per day it is overdue) | off |
| `printer.job_sent` | printer | (later) | off |
| `printer.finished` | printer | (later) | off |
| `printer.failed` | printer | (later) | off |

\* only those of these that exist in `KINDS`; the producer maps by a dict and ignores unknown
names, so adding a payment kind later is one line.

### B2. Producer

`aito_events.record()` returns the event after `db.add`. A new hook in that function, after
the event object is built and before return, calls `inbox.fan_out(db, event, project)`:

1. Map `event.kind` → inbox kind; none → return.
2. Watchers = users with an `aito_watches` row for `project_id` whose `kinds_json` contains
   the inbox kind, intersected with users whose `user_inbox_preferences` enables the kind
   (no preference row = defaults). Users without the Aito read permission are skipped.
3. One `Notification` row per watcher, added to the same session (same transaction as the
   event — if the event rolls back, so does the row).
4. After the caller's commit, the WS layer broadcasts `{"type": "inbox_changed",
   "user_ids": [...]}`; the frontend refetches its own inbox when its user id is listed.
   The broadcast is issued from `_commit_and_wake`'s callers' existing `_broadcast_changed`
   path: `fan_out` records the user ids on the session (`db.info["inbox_users"]`), and
   `_broadcast_changed` drains that set after the commit. Non-Aito callers of `record` (the
   sync worker, the sweeps) call `inbox.broadcast_pending(db)` themselves after their commit.

Auto-watch: `create_project` (and the transfer's new card) inserts a watch for `created_by`
when that user's preference `auto_watch` is true, with the user's enabled Aito kinds.
Watches are deleted when a card is trashed? No — kept, so a restore keeps the watcher.
A card moving to Done does not delete the watch either (operator may still want "paid").

### B3. Routes (`backend/app/api/routes/inbox.py`, prefix `/api/v1/inbox`)

| Route | Gate | Body / result |
|---|---|---|
| `GET /inbox?limit=50&before=<id>` | authenticated | `{items: [...], unread: n}` newest first |
| `POST /inbox/{id}/read` | authenticated, own row | 204 |
| `POST /inbox/read-all` | authenticated | 204 |
| `GET /inbox/preferences` | authenticated | preference row (defaults if none) |
| `PUT /inbox/preferences` | authenticated | `{kinds, sound_kinds, auto_watch}` |
| `GET /aito/{project_id}/watch` | AITO_READ | `{watching: bool, kinds: [...]}` |
| `PUT /aito/{project_id}/watch` | AITO_UPDATE | `{kinds: [...]}` (empty list = unwatch) |

With auth disabled there is no user: the inbox routes answer an empty list / no-op, and the
bell is hidden (the frontend checks `authEnabled && user`). The two `/aito/...` routes bump
the permission sweep: +2 routes, `get_watch` read-only, `set_watch` write.

### B4. Frontend — bell and panel

`NotificationBell` (`components/NotificationBell.tsx`), mounted three times in `Layout`:
first icon of the expanded sidebar row, first icon of the collapsed rail, right of the phone
top bar. Rendered only when `authEnabled && user`. Queries: `['inbox']`
(`api.getInbox()`), refetched on `inbox_changed` WS messages naming the user and on window
focus. Unread badge = `unread` from the response (max "9+").

Panel: `position: fixed`, measured from the button rect (beside the rail bottom-aligned, or
under the top-bar button), 24rem wide, max-height min(34rem, 100vh − 4rem), `role="dialog"`,
Escape and scrim close. Header: title, unread count, sound toggle (writes
`sound_kinds` = all-or-none through the preferences PUT), "Mark all read", close. Filter chips
for the families the user has enabled (hidden when only one family is on). Rows: icon by kind,
title, body, relative time, unread dot (clicking the dot marks read without leaving), a
chevron that reads "Open" on hover. Clicking the row marks read and navigates via
`inboxTarget(item)`:

- `aito_project` → `/aito?card={id}`
- `printer` → `/printers?focus={id}`
- target missing (`target_id` null) → the family's page, plus toast `inbox.targetGone`.

Arrival: when a refetch brings a row newer than the last seen id, the bell shakes (the mock's
keyframes), the badge pops, and `chime()` plays if the kind is in `sound_kinds` and the page
has had a user gesture (`navigator.userActivation?.hasBeenActive`, else skipped silently).

### B5. Deep links

- `AitoPage`: on mount read `card` from the URL; once the projects query has data, if the id
  is active call `setExpandedId(id)` and scroll its column into view; if it is in the trash,
  toast `aito.cardInTrash`; then strip the parameter (`replace` navigation) so a refresh does
  not reopen it.
- `PrintersPage`: on mount read `focus`; once printers are loaded, `scrollIntoView` the
  `#printer-card-{id}` element and add a two-second ring class (`ring-2 ring-bambu-green`);
  unknown id → toast `printers.focusGone`; strip the parameter.

### B6. Watch this card

Menu row "Watch this card" / "Watching ✓" in the ⋯ menu (Part A's `ProjectActionsMenu`),
opening `WatchModal`: one checkbox per enabled Aito kind (kinds off in Settings are listed
greyed with "off in Settings"), Save / Stop watching. Query `['aito-watch', id]`. The panel
header shows a small eye icon when watching (tooltip "You watch this card").

### B7. Settings → Notifications → Inbox block

New `InboxPreferences` component rendered in the notifications section, under the providers,
above the template editor. Family switches (Aito, Printers) each with their kinds as
switches; printer kinds carry a "coming later" tag and are off by default; a "Ring" switch
per kind column; "Auto-watch cards I create". Saves through `PUT /inbox/preferences` on
change (debounced 400 ms), toast on failure. The section is per user and says so in one line.

### B8. Locale keys (all 15 locales)

Namespace `inbox.*`: `title`, `unread`, `markAllRead`, `soundOn`, `soundOff`, `open`,
`empty`, `filterAll`, `filterAito`, `filterPrinters`, `targetGone`, kind titles
(`kind.aitoQuoteViewed` … `kind.printerFailed`, 8), settings block (`settingsTitle`,
`settingsIntro`, `familyAito`, `familyPrinters`, `comingLater`, `ring`, `autoWatch`),
watch (`watchTitle`, `watchBody`, `watchSave`, `watchStop`, `watching`, `offInSettings`),
plus `aito.watchCard`, `aito.watchingCard`, `aito.cardInTrash`, `printers.focusGone`.
Roughly 40 keys.

---

## Out of scope (named so nobody builds them by accident)

- Printer kinds producing rows (only the kinds and settings exist); the hook point is
  `notification_service` where `event_type = "print_complete"` is decided.
- Per-user push channels (Pushcut/email per user).
- Admin defaults for new users' inbox preferences.
- An "unmerge" / restore guard for merged cards.

## Verification

Backend: new test files per route, permission sweep updated (+5 routes: transfer,
transfer-client, get_watch, set_watch under `/aito`; the `/inbox` routes are outside that
sweep but get their own auth tests), `./test_backend.sh`. Frontend: vitest per component
(`ActionMenu`, `ProjectActionsMenu` rows and hints, `TaskTransferModal` both modes,
`TransferClientModal`, `copySummary`, `JobTicket`, `NotificationBell`, `InboxPreferences`,
`WatchModal`, both deep links), `npm run typecheck`, `npm run lint`, `npm run check:i18n`,
`npm run build`. Then the sandbox demo (neutralized DB, :8041/:5194, headed Brave) walking
split → move → copy → transfer → ticket → watch → a simulated accepted quote ringing the
bell → row opens the card.
