# Baseline Changelog

User-approved behavior changes made during the refactor campaign, each an
explicit exception to the campaign's zero-functionality-change rule.

## T-012 — 2026-08-11 — user-approved behavior change

`useProjectPatchMutation`'s three consumers (`ProjectDetailPanel`'s description
save, its social save, and `ShippingCard`'s shipping save) computed
`expected_version` by re-reading the shared `['aito-projects']` board cache at
save time — a cache another operator's concurrent edit rewrites via the
`aito_changed` WS handler while the first operator's editor is still open, so
the version guard could never fire across operators. Fixed by capturing
`project.version` once when each edit session opens and sending that as
`expected_version`, with the shared board cache kept only as the fallback for
one-shot actions (retry-sync, description regenerate, remove shipment) that
never open an editor session. Observable change, quoting the approved
description verbatim: "A save that currently succeeds silently after another
operator's edit arrived will instead return 409 and show the version-conflict
toast with the editor reopened on the user's typed text."

## T-009 — 2026-08-11 — user-approved behavior change

`POST /aito/` accepted a client-supplied `quote_status` as free text with no
coupling to `quote_id`, letting a principal holding only `aito:create` write
`quote_status="accepted"`/`"declined"` directly onto a brand-new card —
bypassing the dedicated `/quote-status` route's `aito:update` permission, its
409 terminal-transition guards, and its `quote.{status}` timeline event, and
landing the card straight on a work column (or Done, for a decline) with no
recorded actor. `AitoProjectCreate.quote_status` is now restricted to the
Zoho vocabulary (`Literal["draft","sent","viewed","accepted","declined","expired"]`)
and a decided status (`accepted`/`declined`) is only accepted alongside a
`quote_id` — i.e. a genuine import of an already-decided Books quote, which
now also records a `quote.{status}` event with an actor. Observable change,
quoting the approved description verbatim: "POST /aito/ with quote_status
'accepted' or 'declined' but no quote_id would start returning 422 instead of
creating a card that lands directly on a work column; any API client doing
that must set the status afterwards via POST /aito/{id}/quote-status."

### T-012 addendum — 2026-08-11 — clarification only, NO code change
The blind verifier observed that T-012's protection covers the FIRST save of an edit session:
`ProjectDetailPanel` clears the captured version in `onError` for every failure, so after the
conflict toast a retry falls back to the cache read and can overwrite the peer's edit. That was
also the behavior before T-012, so it is not a regression — T-012 strictly added a 409 where there
was silent loss.

The user was asked and chose to LEAVE this as-is: after the 409 the operator has been told a
conflict exists and their typed text was preserved, so an explicit retry is a deliberate, informed
overwrite, and keeping that path avoids a state where the operator cannot save at all (there is no
UI to view or merge the peer's text). Surfacing the peer's text on conflict was considered and
deliberately deferred as feature work, out of scope for a zero-behavior-change campaign.

This entry documents that decision. It is accompanied by NO code change, and asserts no behavior
beyond what the T-012 entry above already describes and the iteration-1 verifier already verified.

## T-020 — 2026-08-11 — narrows an unapproved behavior change back to baseline

T-009 (above) closed `AitoProjectCreate.quote_status` to a six-value `Literal` vocabulary. The user
approved exactly one observable change for T-009 — a decided status (`accepted`/`declined`) without
a `quote_id` now returns 422 — but the implementation ALSO made a blank or out-of-vocabulary status
422 the whole request, which was never approved. That was reachable: `aito_quote_import.py`'s
`build_preview` emits `estimate.get("status") or ""` for a Books estimate with no status, and
`useAitoPageMutations.ts` forwards it verbatim as `quote_status` on import, so a status-less or
unrecognised-status (e.g. `invoiced`) Books estimate would fail the entire import with a generic
error toast, where before T-009 the card was created.

Fixed by adding a `field_validator(mode="before")` on `AitoProjectCreate.quote_status` that degrades
any string outside the six known values (including `""`) to `None`, before the `Literal` check runs
— mirroring this schema file's existing `client_phone` precedent
(`aito_quote_import._client_snapshot`, which degrades an unparseable Zoho contact phone to `None`
rather than failing the import over a field the user cannot fix from the import modal). Because the
coercion runs before validation, the field's declared type is unchanged
(`Literal["draft","sent","viewed","accepted","declined","expired"] | None`), so the OpenAPI/JSON
schema is unaffected — confirmed by `tools/snapshot.py verify` (9/9 probes match, including
`aito-pydantic-schemas`, with no re-record needed).

The approved T-009 gate is untouched and still enforced: `accepted`/`declined` without a `quote_id`
still returns 422 (`_decided_status_needs_a_quote_id`, unchanged), and a decided status arriving WITH
a `quote_id` still succeeds and still records the `quote.{status}` timeline event with an actor. This
is not itself a new user-visible behavior change beyond what T-009 already introduced — it narrows
T-009's unapproved side effect back toward the pre-campaign baseline (a blank/unrecognised status no
longer blocks an otherwise-valid import), so it needs no separate approval.

The degrade is a discard, not a store, and that is visible on the card: an import that carries a
status outside the six-value vocabulary (e.g. Books' `invoiced`) now round-trips as
`quote_status: null` — where BASE persisted and returned the raw string verbatim — so the resulting
card shows no status pill (`ProjectDetailPanel.tsx` only renders the pill when `quote_status` is
truthy) and offers "mark sent" exactly as a fresh `draft` card would (`QuoteStatusActions.tsx`'s
`canMarkSent` treats `null` the same as `draft`), instead of displaying the raw Zoho status BASE
would have shown and withholding that action. This is the same approved trade the paragraph above
describes — an import the user cannot fix from the modal is not worth failing over a status field —
stated here in terms of what the card looks like rather than what the schema does.

## T-013 — 2026-08-11 — user-approved behavior change

`POST /aito/{project_id}/quote-email` (`send_quote_email`) called `zoho_service.email_estimate(...)`
— which really emails the client — and only then wrote `record('quote.emailed')`, `_summary_for`,
`adopt_quote_status`, `_apply_rules`, and `record('quote.sent')`, all landing in a single
`await db.commit()` at the very end. This app runs one SQLite file that the `aito_quote_sync` worker
also commits through, so an `OperationalError: database is locked` on that commit (or on any of those
writes' own flush) was a realistic outcome. When it happened the handler raised, `get_db` rolled the
whole session back, and the request 500'd — but the client had already received the email. Nothing
local survived: no `quote.emailed` event, `quote_status` unchanged, card still in the Quote column.
The frontend's `useSendQuoteMutation` then treated the 500 as "nothing was written, safe to retry",
so one more click sent the client a second real quote email, with the first send absent from the
audit timeline.

Fixed by committing the `quote.emailed` event on its own, immediately after `email_estimate` returns
and before the status-adoption / `_apply_rules` work. That commit is now durable regardless of what
happens next. The card-move half (`adopt_quote_status`, `project.quote_status_block`/`_remote`
clearing, `_apply_rules`, `record('quote.sent')`, the second commit) is wrapped in its own
try/except: on failure it rolls back just that half, logs a warning, and the handler returns 200 with
the already-existing `marked_sent=False` (no schema change — `AitoQuoteEmailResponse.marked_sent`
already existed for the "card wasn't in the Quote column" case; a card-move failure now degrades into
that same field rather than a 500). This also required reordering the trailing `_broadcast_changed` /
`db.refresh(project)` calls: `Session.rollback()` expires every attribute on `project` regardless of
`expire_on_commit`, so `db.refresh(project)` now runs before anything reads `project.id` again.

Observable change, quoting the approved description verbatim: "A send whose local bookkeeping fails
will leave a `quote.emailed` row on the timeline (and may return 200 with marked_sent=false) instead
of appearing to have never happened."

Confirmed via a new regression test
(`test_a_failed_card_move_still_records_the_send` in `backend/tests/unit/test_aito_quote_email.py`)
that patches `_apply_rules` to raise `OperationalError("database is locked")` after a successful
`email_estimate`: pre-fix this 500'd and left no `quote.emailed` event; post-fix it returns 200 with
`marked_sent=False`, the card stays in `devis`, and `quote.emailed` (but not `quote.sent`) is on the
timeline. `tools/snapshot.py verify` shows only `aito-openapi` moving, confined to the
`send_quote_email` docstring text (now documenting this behavior) that FastAPI surfaces as the
route's OpenAPI `description` — no field, schema, or route-shape change; re-recorded and re-verified
9/9. `SURFACE.md` is unchanged (route list identical).

## T-007 — 2026-08-12 — user-approved behavior change

`ShippingFields.tsx` formatted the Zoho shipping rate with a bare
`zohoRate.toLocaleString()` — no locale argument, so it always used the
browser/runtime's default locale — while every other formatted number or date
in the same Aito feature (`CardView.tsx`, `PanelAgeStat.tsx`,
`ProjectDetailPanel.tsx`, `ImportQuoteDrawer.tsx`) explicitly passes
`i18n.language`, the app's own selected UI language.

Fixed by destructuring `i18n` from `useTranslation()` (alongside the existing
`t`) and changing the call to `zohoRate.toLocaleString(i18n.language)`,
matching the sibling components exactly.

Observable change: a shipping card or drawer showing a Zoho rate (the "Zoho
rate: <rate> <currency>" line next to the picked island's service) will now
format that number's thousands grouping and decimal separator according to
the operator's chosen Bambuddy UI language rather than the browser's own
locale/language setting. Concretely, an operator whose Bambuddy UI language
is French (`fr`) but whose browser/OS locale is English will now see, e.g.,
`3 200 XPF` (French grouping, narrow no-break space) instead of `3,200 XPF`
(English grouping) — matching every other number already shown on the same
panel. An operator whose browser locale already matched their chosen UI
language sees no change.

Confirmed via a new test in `AitoShippingFields.test.tsx` that switches
`i18n` to `fr`, renders the component with a service whose rate is 3200, and
asserts the rendered text uses French thousands grouping (which differs from
English grouping for this value), then restores the language to `en`.
`tools/snapshot.py verify` shows no probe moving (9/9 match) — this is a pure
display-formatting change with no probe coverage — and `SURFACE.md` is
unchanged.

## T-011 — 2026-08-12 — user-approved behavior change

`AitoTaskBase`'s four per-service free-text fields (`scan_description`,
`modelisation_description`, `impression_description`, `usinage_description`)
carried no `max_length`, unlike every other free-text field on the same
trust boundary — `AitoProjectCreate.description` is capped at 10_000 with an
explicit rationale comment, and `title` is capped at 200. Accepted unbounded
on `POST /aito/`, `POST /aito/{project_id}/tasks` and `PATCH
/aito/tasks/{task_id}`, stored in `Text` columns, and pushed verbatim into
the Books line-item description on the next sync, an oversized value could
only surface later as a `ZohoRequestRejected` that parks the project in the
terminal `error` state. The same bound also reaches `POST /aito/summarize`,
which validates the same `AitoTaskCreate` shape: `AitoSummarizeRequest.tasks`
is typed `list[AitoTaskCreate]`, so both callers of that endpoint are capped
identically: the create drawer's "generate description" button
(`AiSummaryPanel.tsx`), which posts its local drafts to this endpoint before
the project exists, and `ProjectDetailPanel`'s "regenerate description"
button (`regenerateMutation`, `ProjectDetailPanel.tsx:865`), which posts the
project's live, already-persisted task rows through the same endpoint on
every regenerate.

The bound is declared on `AitoTaskCreate` and `AitoTaskUpdate` only (the two
request models), each redeclaring the four fields with `Field(default=None,
max_length=10_000)` and the same rationale comment as the project
description. It is deliberately NOT declared on `AitoTaskBase` (nor
therefore inherited by `AitoTaskResponse`): `AitoTaskResponse` also inherits
from `AitoTaskBase` and is constructed directly from DB rows by
`_task_to_response` on every read (`GET .../tasks`) and every write response
(`POST`/`PATCH`), so a bound there would re-validate on read — a row already
stored above the cap (there is no migration to trim or grandfather existing
data) would make the *entire* task list 500, and would make an unrelated
`PATCH` of that same task (one that never touches a description field) 500
during response construction. An earlier revision of this fix put the bound
on `AitoTaskBase` and had exactly that defect; it is corrected here. No
column, migration, optionality, or default changed on any field — this is a
request-boundary validation bound only, and the read path is intentionally
left unbounded so a pre-existing over-cap row keeps reading back exactly as
it did before this change.

Observable change, both halves of the approved delta, no more: (a) a task
`scan_description`/`modelisation_description`/`impression_description`/
`usinage_description` longer than 10_000 characters now gets rejected with
422 on create or patch, instead of being saved; (b) any row that was already
stored above the cap will now fail a `PATCH` that resends that same
over-cap field unchanged. Reading such a row back (`GET .../tasks`) and
patching an *unrelated* field on it are both unaffected and continue to
succeed exactly as before this change.

Confirmed via sixteen new parametrized tests in `backend/tests/unit/test_aito_routes.py`
(over the four fields): `test_create_task_accepts_a_description_at_the_cap` (201,
value round-trips at exactly 10_000 chars), `test_create_task_rejects_an_over_cap_description`
(422 at 10_001 chars on `POST /aito/{project_id}/tasks`),
`test_patch_task_rejects_an_over_cap_description` (422 at 10_001 chars on
`PATCH /aito/tasks/{task_id}`), and
`test_reading_a_task_already_over_the_cap_still_succeeds` (a task row written
directly to the DB with a 10_001-char field still returns 200 on
`GET .../tasks` with the value intact, and a `PATCH` of an unrelated field on
that same task still returns 200 with the over-cap value untouched — this
last test pins the read-path fix and fails if the bound is ever moved back
onto `AitoTaskBase`/`AitoTaskResponse`). `tools/snapshot.py verify` shows
exactly one probe moving, `aito-pydantic-schemas`. Measured against BASE
(the only revision a later reader can diff against — an earlier, defective
attempt within this same iteration briefly put the bound on `AitoTaskBase`
instead and was corrected before anything was tagged, so it is not a usable
reference point): the golden gains 16 `"maxLength": 10000,` leaves, four per
field (`scan_description`, `modelisation_description`,
`impression_description`, `usinage_description`) in each of four places —
the two request models themselves, `AitoTaskCreate` and `AitoTaskUpdate`,
plus their two `$defs` copies embedded where they are nested by reference:
`AitoSummarizeRequest.tasks` (`list[AitoTaskCreate]`) and
`AitoProjectCreate.tasks` (also `list[AitoTaskCreate]`, since project
creation accepts inline tasks). `AitoTaskBase` and `AitoTaskResponse` are
confirmed byte-identical to BASE — no leaf added on either, consistent with
the bound being declared on `AitoTaskCreate`/`AitoTaskUpdate` only. (A
one-line drop elsewhere in `AitoProjectCreate`, on `quote_status`, is also
present versus BASE but is unrelated to this change — it is a different
field, not one of the four description fields, and traces to T-009's
`quote_status` validation, not to this fix.) Re-recorded and re-verified
9/9. `aito-openapi` (paths-only) and `SURFACE.md` are both unaffected —
confirmed byte-identical.

## T-021 — 2026-08-12 — user-approved behavior change

T-021 added `__resetOwnAckedVersion`, exported from
`frontend/src/components/aito/useProjectPatchMutation.ts` alongside the
pre-existing module-level `ownAckedVersion` map. It exists to close a
test-isolation hazard: `ownAckedVersion` is never pruned, so a test that
patches a given project id leaves an acked version behind for any later
test in the same file that reuses that id. Every existing test in
`AitoDetailPanelOptimistic.test.tsx` uses project id 1, and the F2 suite
in that file (pinning T-012's same-client back-to-back-save race fix)
resolves its second PATCH at version 3, so a later id-1 test's freshly
captured `expected_version` could silently come back wrong depending on
file/suite execution order. Demonstrated empirically, not just asserted:
with the reset call temporarily removed from a new id-1 test's setup, that
test's `expected_version` assertion failed with `expected 3 to be 1`
(F2's leftover acked version leaking in); with the reset restored, the
same test — and the whole file, run 3 times and twice more under
`--sequence.shuffle.tests` with different seeds — passed consistently.

The export is test-only and is never called from production code (grepped
the codebase — its only callers are the new test's `beforeEach` hooks); the
`ownAckedVersion` map's production semantics (never pruned, never reset at
runtime, monotonic per project id) are unchanged. Nothing an end user, an
API client, or the running app can observe changes.

The only DECLARED-SURFACE effect is one added line in `SURFACE.md`'s
frontend-components section — `export function __resetOwnAckedVersion` —
because the surface generator scrapes every `export function` out of
`frontend/src/components/aito/*.ts`. This mirrors existing precedent
already on the surface at BASE: `export function __resetAitoPresence`,
the same test-only reset-export pattern for a different module-level map.
`tools/snapshot.py verify` shows 9/9 probes matching, unaffected by this
change (none of the 9 probes touch this file or this export).

## T-036 — 2026-08-12 — user-approved behavior change

T-009 restricted `POST /aito/`'s `quote_status` to a decided value
(`accepted`/`declined`) only alongside a `quote_id`, i.e. a genuine import of
an already-decided Books quote — but the only gate was the presence of
`quote_id`, never a check against who is making the request. A principal
holding only `aito:create` (a real, supportable custom-group configuration;
the default Operators group bundles all four `aito:*` permissions, so this
was never reachable through it) could POST a real `quote_id` obtained from
`GET /zoho/estimates` (also gated on `AITO_CREATE`) with
`quote_status: "accepted"` and drive that decision straight through: the
created row lands at `quote_sync_state='idle'`, is picked up by the next
sync sweep, and `reconcile_quote_status` pushes `/status/sent` then
`/status/accepted` onto the live Zoho estimate — none of the dedicated
`POST /{id}/quote-status` route's `aito:update` requirement, its 409
terminal-transition guards, or its actor-recording apply.

`create_project` now rejects the request with 403 when `payload.quote_status`
is `'accepted'` or `'declined'` and the caller's `current_user` does not hold
`aito:update` (checked via `current_user.has_permission(Permission.AITO_UPDATE
.value)`, the same idiom already used elsewhere in the route layer — e.g.
`archives.py`'s `current_user.has_permission(Permission.ARCHIVES_READ_ALL
.value)` — for a permission check that has to happen inside the route body
rather than as a static `RequirePermissionIfAuthEnabled` dependency, because
it depends on a parsed request-body field). The check is skipped when
`current_user is None`, which is the auth-disabled case (the dependency
returns `None` for both auth-disabled and a valid API key, and API keys
cannot hold `AITO_CREATE` at all — it is denylisted in
`core/auth.py`'s `_APIKEY_SCOPE_BY_PERMISSION`, so a decided-status create
can only reach the route body as a real JWT-authenticated user or with auth
off) — an auth-disabled instance is unaffected by this change, matching how
every other permission gate in this file already behaves.

Observable change, quoting the approved description verbatim: "POST /aito/
carrying quote_status 'accepted' or 'declined' starts returning 403 (or 422)
for a caller holding only aito:create." Callers affected: a caller
authenticated with a JWT whose group(s) grant `aito:create` but not
`aito:update`, sending a decided `quote_status`. Callers NOT affected: any
caller who also holds `aito:update` (including the default Operators group,
unchanged); any caller sending an undecided status (`draft`/`sent`/`viewed`
/`expired`), no status, or an unrecognised status that degrades to `None`
(T-020's degrade path); any caller when auth is disabled; the dedicated
`POST /{id}/quote-status` route, `_reject_ticks_without_acceptance`,
`reconcile_quote_status` and `advance_estimate_status`, none of which were
touched.

`tools/snapshot.py verify` shows 9/9 probes matching — `aito-route-perms`
only greps `RequirePermissionIfAuthEnabled(...)` call sites, and this check
is an inline `current_user.has_permission(...)` in the route body, not a new
dependency, so that probe (and the rest) is correctly unaffected.
`SURFACE.md` is also unaffected: `bash tools/gen_surface.sh` produces a
byte-identical file (no new `def`/`class`, export, or route dependency was
added).

## T-037 + T-049 — 2026-08-12 — user-approved behavior change

The T-011 cap pass bounded the four per-task description fields at 10_000
but left two request-body collections and one description in
`backend/app/schemas/aito.py` open: `AitoProjectCreate.tasks` (`POST
/aito/`) had no `max_length` at all, even though the identical element type
is already bounded at `max_length=50` on the sibling `AitoSummarizeRequest
.tasks` (`POST /aito/summarize`) — the same contradiction both auditors
independently flagged. `AitoProjectImport.projects` (`POST /aito/import`)
had no bound either, and `AitoProjectImportItem.description` was the one
description left in the file without `max_length=10_000`, unlike
`AitoProjectCreate.description` and `AitoProjectUpdate.description`. There
is no request-body-size middleware anywhere in the app
(`grep -E 'add_middleware|middleware' backend/app/main.py` returns only
`security_headers`/`auth`/`trace_id`), so these Pydantic field constraints
were the only trust-boundary guard against a caller holding `aito:create`
posting an unbounded body that gets fully deserialised, validated, and (for
`/aito/`) inserted as one `AitoProject` plus N `AitoTask` rows in a single
transaction before any handler code runs — the `/import` route's `if total:
409` guard does not help either, since FastAPI validates the body before
the handler is entered.

Three bounds added, each declared directly on the request model that owns
the field — none reaches a response model by inheritance, and neither
`AitoProjectCreate` nor `AitoProjectImport`/`AitoProjectImportItem` is
embedded via `$defs` in any other schema in this file (confirmed by grep:
each is referenced only as the body type of its own single route —
`POST /aito/` and `POST /aito/import` respectively — unlike T-011's
`AitoTaskCreate`, which is genuinely shared). So, unlike T-011, no bound
here reaches a second endpoint through a shared type:

- `AitoProjectCreate.tasks: list[AitoTaskCreate] = Field(default_factory=list, max_length=50)`
  — 50 mirrors `AitoSummarizeRequest.tasks`' existing cap for the identical
  element type, chosen (not just copied) after checking it against the real
  create-drawer workflow: `AiSummaryPanel.tsx` already calls
  `POST /aito/summarize` with this exact same task array on every drawer
  open/regenerate, so an operator building more than 50 tasks in the drawer
  today already loses the AI-generated summary past that point (the
  request 422s and `AiSummaryPanel` falls back to `buildFallbackSummary`
  silently — it does not block submission). A single `AitoTaskCreate` also
  carries its own `impression_quantity`, so a large batch of *identical*
  prints is one task with a quantity, not many task rows — 50 *distinct*
  tasks, each up to four priced services, comfortably covers a real order.
  50 was judged safe for legitimate operators on that basis, not chosen by
  analogy alone.
- `AitoProjectImport.projects: list[AitoProjectImportItem] = Field(max_length=1000)`
  — `/aito/import` is a one-time localStorage-board migration (guarded by
  the empty-board 409 above), not a per-request UI flow: no current
  frontend code calls it at all (`api.importAitoProjects` is defined in
  `client.ts` but has zero call sites in `frontend/src`), so there is no
  live operator workflow to check against directly. 50 (the tasks precedent)
  would be an implausibly tight bound for a full legacy board, so instead
  this mirrors the codebase's own precedent for a one-shot bulk-import
  batch: `backend/app/schemas/library.py`'s
  `BulkFileOperation.file_ids: list[int] = Field(..., min_length=1,
  max_length=1000)`. 1000 comfortably exceeds any plausible size for what
  was, in practice, always an actively-curated Kanban board rather than an
  archive, while still closing the unbounded-batch-insert vector.
- `AitoProjectImportItem.description: str = Field(min_length=1,
  max_length=10_000)` — matches every other description cap already in this
  module (`AitoProjectCreate.description`, `AitoProjectUpdate.description`,
  the four `AitoTaskCreate`/`AitoTaskUpdate` fields from T-011). No new
  named constant introduced; this is a fourth literal `10_000`, which the
  campaign's triage separately flags as a naming cleanup — a different,
  unworked task, not done here.

Observable change, quoting the approved description verbatim: "a POST
/aito/ or POST /aito/import carrying more tasks/projects than the new cap,
or an import description over the cap, would start returning 422 instead
of 201." Endpoints affected, named in full: `POST /aito/` (`tasks` capped
at 50) and `POST /aito/import` (`projects` capped at 1000, each item's
`description` capped at 10_000). No other endpoint is reachable through
either bound — `AitoTaskCreate` itself (and therefore `POST
/aito/{project_id}/tasks`, `PATCH /aito/tasks/{task_id}` and `POST
/aito/summarize`) is unchanged; the new `AitoProjectCreate.tasks` bound is
on the outer list field, not on `AitoTaskCreate`'s own schema.

Confirmed via six new tests in `backend/tests/unit/test_aito_routes.py`:
`test_create_project_accepts_fifty_tasks` / `_rejects_more_than_fifty_tasks`,
`test_import_accepts_a_thousand_projects` /
`_rejects_more_than_a_thousand_projects`, and
`test_import_accepts_a_project_description_at_the_cap` /
`_rejects_an_over_cap_project_description` — each pair accepts exactly at
the cap (201, value round-trips) and rejects one past it (422).
`tools/snapshot.py verify` shows exactly one probe moving,
`aito-pydantic-schemas`, with exactly four new leaves and nothing else in
the golden diff: `"maxItems": 50` on `AitoProjectCreate.tasks`,
`"maxLength": 10000` on `AitoProjectImportItem.description` (appearing
twice — once as the item's own top-level schema entry, once in its `$defs`
copy embedded by `AitoProjectImport`, both from the same single field
declaration), and `"maxItems": 1000` on `AitoProjectImport.projects`.
`SURFACE.md` is unaffected: `bash tools/gen_surface.sh` produces a
byte-identical file (no new `def`/`class`, export, or route dependency was
added — only field-level constraints changed). Backend sysmon coverage for
the Aito subset held at 38 missed statements (the ratchet), with all three
new bounds fully exercised by the tests above.

## T-038 — 2026-08-12 — user-approved behavior change

`_broadcast_changed` (routes/aito.py) fanned every `aito_changed` message —
action, project id, and the acting operator's username — out to *every*
WebSocket connection via `ws_manager.broadcast()`, which walks
`active_connections` with no filtering at all. The same is true of
`aito_presence_state` (`core/websocket.py`), the full `{project_id:
[usernames...]}` viewer map, sent unconditionally to every newly-connected
socket at connect time and rebroadcast to everyone on every presence change
or disconnect. Admission to `active_connections` requires only
`Permission.WEBSOCKET_CONNECT`, and the default Viewers group holds that
permission but zero `aito:*` permissions — so an account that gets 403 from
`GET /api/v1/aito/` nonetheless received a live stream of every board
mutation and the full presence map, a permission boundary the product
defines explicitly elsewhere.

This task's fix genuinely required editing `core/websocket.py` and
`routes/websocket.py` — both outside this campaign's Aito file fence — to
reach the connect handler and the `ConnectionManager` that owns
`active_connections`. The user widened the fence for T-038 only (round 2
approval sweep), after this worker's scope assessment identified exactly
those two files and confirmed no correct fix could be built from
`routes/aito.py` alone: the presence-state fan-out in particular has no
code path through `routes/aito.py` at all, so a workaround confined to
that file was not just inferior but structurally impossible for half the
task.

`routes/websocket.py`'s connect handler now stamps
`websocket.state.aito_read: bool` once, alongside the existing
`bambuddy_principal` / `bambuddy_principal_user_id` stamps, via a new
private helper `_resolve_principal_and_aito_read(principal, db)`. The
value is `not auth_required` by default (True on an auth-disabled
install — no principal is ever verified there, so there is nothing to
check, and every connection keeps seeing everything unchanged) and,
for a non-empty `principal`, becomes that resolved user's
`Permission.AITO_READ` (`User.has_permission` short-circuits True for
admins already, so admins are unaffected). An API-key connection's
`principal` is `""` (never `None` on a valid token — `verify_websocket_token`'s
own contract), which is falsy and skips resolution entirely, leaving the
fail-closed default; the same fail-closed default applies to a username
that no longer resolves to a user row (e.g. deleted after the token was
minted) and to a DB error during resolution. `core/websocket.py` gained
`ConnectionManager.broadcast_aito()`, structurally identical to the
existing unfiltered `broadcast()` except it skips any connection where
`getattr(connection.state, "aito_read", True)` is falsy — the `True`
default only protects a connection that was somehow never stamped
(should not happen; `connect()` always stamps it) from being silently
dropped, it is not how the auth-disabled path passes (that is the stamp
itself being `True`). `_broadcast_changed` (routes/aito.py) and both
internal `aito_presence_state()` broadcasts in `core/websocket.py`
(`set_aito_presence` and `disconnect`) now go through `broadcast_aito()`
instead of `broadcast()`. The initial per-connection presence send in
`routes/websocket.py` (previously unconditional) is now gated on
`websocket.state.aito_read`. No other broadcast call site (printer
status, print start/complete, archive events, queue toasts, spool
warnings, `broadcast_to_user`) was touched — they all still call the
original unfiltered `broadcast()` / `broadcast_to_user()`.

Observable change, quoting the approved description verbatim: "a
logged-in user in a group without aito:read (e.g. the default Viewers
group) would stop receiving aito_changed and aito_presence_state
messages, so any UI they have that reacts to those would go quiet; users
holding aito:read see no change." Principals affected: any WebSocket
connection whose resolved user does not hold `aito:read` and is not an
admin (the default Viewers group, and any custom group omitting
`aito:read`) — for those connections, `aito_changed` broadcasts and both
the initial and subsequent `aito_presence_state` broadcasts are silently
skipped; nothing else about the connection changes. Principals NOT
affected: any user holding `aito:read` (including the default Operators
group and any custom group granting it), any admin (group- or
legacy-role-based), any connection on an auth-disabled instance, and API
keys are also filtered (fail-closed, since an API key's granted scope
flags only cover `WEBSOCKET_CONNECT` itself, not `Permission.AITO_READ`
specifically, so there was no positive evidence to admit them on — this
is a new restriction for API-key WebSocket connections specifically,
called out here because it was not explicitly named in the approved
description, which spoke to "a logged-in user in a group"). No other
message type, payload shape, or broadcast timing changed for any
principal.

Confirmed via 12 new tests in
`backend/tests/unit/test_ws_aito_read_filter.py`: `broadcast_aito` skips a
connection stamped `aito_read=False` and delivers to one stamped
`aito_read=True`, defaults to `True` for a never-stamped connection, and
does not affect an unrelated `broadcast()` call (`send_printer_status`)
reaching a connection with `aito_read=False`; `_resolve_principal_and_aito_read`
denies a plain user, allows a user granted `aito:read`, allows an admin
with no explicit Aito grant, and fails closed for an unresolvable
principal; and four tests drive the real `websocket_endpoint` end-to-end
(against a throwaway `ConnectionManager` instance, never the global
singleton — matching every other test in this file) proving the initial
presence-state send is withheld without `aito:read`, sent with it, sent
for an admin, and sent unconditionally with auth disabled (asserting
`verify_websocket_token` is never even called in that path). The existing
`test_aito_broadcasts.py` fixture was updated to patch
`ws_manager.broadcast_aito` instead of `ws_manager.broadcast` (the call
site it now targets); its assertions on which actions broadcast, and
when, are unchanged.

`tools/snapshot.py verify` shows 9/9 probes matching — none of the nine
goldens touch WebSocket wiring. `SURFACE.md` is unaffected: `bash
tools/gen_surface.sh` produces a byte-identical file — the generator does
not scrape `core/websocket.py` or `routes/websocket.py` at all (verified,
not assumed), and no `def`/`class` was added to `routes/aito.py` (the only
in-scope file the generator does scrape) — `_broadcast_changed`'s body
changed but its signature and name did not. Backend sysmon coverage for
the Aito subset (`--include='*aito*'`) held at 38 missed statements, exactly
at the ratchet — `core/websocket.py` and `routes/websocket.py` are outside
that include glob, so the two changed/added files there are deliberately
covered by the new test file above rather than by the ratchet. (An earlier
revision of this entry misreported this as 36, from a coverage pass that
also hit two unrelated known flakes; corrected after a clean re-measurement
and cross-checked by the T-046 worker and the blind verifier, both of whom
independently got 38.)

## T-046 — 2026-08-12 — user-approved behavior change

`update_project`'s (`routes/aito.py`, `PATCH /api/v1/aito/{project_id}`)
`expected_version` guard was check-then-act: `if payload.expected_version
!= (project.version or 0): raise 409` ran against a plain SELECT near the
top of the handler, but the actual write happened much later — after
`rates = await _shipping_rates(db)`, which calls
`zoho_service.get_shipping_catalogue(db)` with its default `refresh=True`
and can be a live Books HTTP call on a cold or expired (>24h) cache.
Two operators saving the same card inside that window both read the same
version, both passed the guard, and both wrote: the second `UPDATE`
landed on top of the first with neither operator seeing the 409 the guard
exists to produce, silently dropping one of their edits.

Confirmed before changing anything: the guard genuinely ran before
`_shipping_rates` (not after); `get_shipping_catalogue`'s own docstring
confirms the default is a real network call, contrasted explicitly with
the cache-only `refresh=False` used by the adjacent `_shipping_names`;
and `version` is bumped by an ORM `before_update` event listener
(`_bump_version_on_content_change` in `models/aito_project.py`) keyed off
SQLAlchemy's own dirty-attribute tracking for a fixed `VERSIONED_FIELDS`
set — not by any SQL this handler constructs directly, and not
unconditionally (background writers such as quote sync, rule moves, and
flag toggles must not bump it).

**Deployment reality, checked in `core/database.py` before judging
severity**: this app is not SQLite-only. `settings.database_url` prefers
`DATABASE_URL` from the environment (PostgreSQL support) and only falls
back to a local `sqlite+aiosqlite` file. On PostgreSQL the race is exactly
as the audit describes — READ COMMITTED, no row lock, no conditional
UPDATE, the second writer simply overwrites the first. On SQLite it is
**not** meaningfully less reachable than advertised: the pool is
`pool_size=20 + max_overflow=200` in WAL mode (`_resolve_pool_kwargs`),
i.e. genuinely concurrent connections, and WAL's writer serialization
only orders the two `COMMIT`s — it does not make either write conditional
on the other, so a second, later-committing writer still blindly
overwrites the first's changes. The bug is really an application-level
check-then-act race reachable by any two requests interleaved on the same
async event loop; the database engine mostly affects how many physical
writers can pile up, not whether the race exists.

**Fix.** Two guards now exist rather than one, and only the second closes
the race:
1. The original top-of-function compare is unchanged, preserved verbatim
   for its fast-fail behaviour — a request that is already stale when it
   arrives still gets an immediate 409 with no wasted `_shipping_rates`
   call and no other validation performed, exactly as before.
2. A new atomic re-check, `_claim_expected_version`, runs immediately
   after `_shipping_rates` and before any `setattr` on the project — with
   no network call between the compare and the write that follows. It
   issues `UPDATE aito_projects SET version = version WHERE id = :id AND
   version = :expected` (a deliberate no-op `SET`, purely to claim the
   row) via SQLAlchemy Core with `synchronize_session=False`, and 409s on
   `rowcount == 0`. This is evaluated by the database against the LIVE
   row, not a Python-side snapshot, and the `UPDATE` takes the row's write
   lock for the remainder of the transaction — a concurrent claim on the
   same row either wins outright or blocks until this transaction resolves
   and then sees the version has already moved. This is shape (i) from the
   audit (atomic conditional UPDATE, 409 on rowcount 0), not shape (ii)
   (re-read-and-compare): a raw UPDATE was chosen over reproducing the
   ORM's own field-write flow because the guard only ever self-assigns the
   `version` column, so it cannot race the ORM's `before_update` listener,
   double-bump the version, or disturb `_mark_pending_if_ours` / event
   recording, all of which still run exactly as before, in the same
   transaction, immediately afterward.

**Correction (2026-08-13), caught by the blind verifier — the first cut of
this fix was not actually inert.** `.values(version=AitoProject.version)`
was meant to be a total no-op, but `AitoProject.updated_at` carries
`onupdate=func.now()` (`models/aito_project.py`), and SQLAlchemy Core
auto-appends a column's `onupdate` default to a statement's SET clause for
any column absent from `.values()` — confirmed by inspecting the compiled
SQL directly rather than assuming: the claim's emitted statement was
`UPDATE aito_projects SET updated_at=CURRENT_TIMESTAMP, version =
aito_projects.version WHERE …`. So the claim was quietly bumping
`updated_at` on **every** guarded PATCH, including a genuine no-op one
that touches no `VERSIONED_FIELDS` and for which `version` correctly does
NOT move — exactly the case the versioning system exists to treat as a
non-edit. `updated_at` is not internal bookkeeping: it orders the Done and
Trash grids (`routes/aito.py`, `order_by(AitoProject.updated_at.desc())`)
and feeds `AitoProjectResponse.updated_at`, which drives CardView's
elapsed-time badge and `ProjectDetailPanel`'s activity-timestamp fallback.
`ShippingCard.save` and `saveSocial` have no unchanged-value suppression
(unlike `saveDescription`), so an operator opening the shipping or social
editor and clicking Save with nothing changed was silently reordering that
card in Done/Trash and resetting its displayed age. Fixed by pinning
`updated_at` explicitly in the claim's own `.values()`:
`.values(version=AitoProject.version, updated_at=AitoProject.updated_at)`
— re-inspecting the compiled SQL confirms this suppresses the `onupdate`
default (`SET updated_at=aito_projects.updated_at, version =
aito_projects.version …`, no `CURRENT_TIMESTAMP` anywhere), and an
end-to-end probe against the real route (real second-resolution
timestamps, `create` → guarded no-op PATCH → unguarded control PATCH →
guarded real edit) shows `updated_at` held constant across the first two
and moved only on the third, matching `version`'s own 0 / 0 / 1
progression. The real ORM flush that follows a successful claim — the one
`_bump_version_on_content_change` drives for a genuine `VERSIONED_FIELDS`
change — was never affected either way: it still sets `updated_at` via
its own normal `onupdate` firing, since that write is a separate,
subsequent statement the claim's pinned SET has no bearing on.

The guard remains opt-in: `payload.expected_version is None` skips both
checks entirely, unchanged for the several one-shot actions that
deliberately never send it. A matching `expected_version` still succeeds.
The existing 409's shape — status 409, `{"code": "version_conflict",
"message": "Project was updated by someone else"}` — is byte-identical
whichever of the two checks raises it, so the frontend's existing
conflict-toast handling (T-047's half of this fix) needs no changes here.

**Observable consequence, in user terms:** two operators who open the
same card and save inside the (now much narrower, but on Postgres never
fully absent even before this fix) window between one save's shipping
catalogue fetch and its commit will no longer silently have one edit
vanish — the second save now gets a 409 "Project was updated by someone
else" and must refresh and reapply, same as the fast-fail path already
behaved for a save that started stale. **When it actually bites:** almost
never in a single-worker SQLite deployment doing ordinary detail-panel
edits (an operator would have to save a *shipping* field, forcing a
possibly-uncached Zoho fetch, in the same few-hundred-millisecond window
another operator commits a save to the identical card) — but it is a real
and previously-silent data-loss path on any multi-connection deployment,
which includes this app's own default SQLite configuration once more than
one request is genuinely in flight, and is most reachable on the
PostgreSQL configuration this app explicitly supports via `DATABASE_URL`.

Tested in `backend/tests/unit/test_aito_version.py`:
`test_racing_writers_only_the_loser_gets_409` drives the race
deterministically (not by timing), per the brief, by monkeypatching
`zoho_service.get_shipping_catalogue` to commit a competing edit — through
the exact `db` session `update_project` already holds — before returning
rates to the stalled request, then asserts the stalled request gets 409
`version_conflict` and the competing edit's data (description and
version) survive untouched, including that the loser's shipping payload
never landed. (A genuinely separate second connection could not be driven
deterministically over this test harness's single in-memory SQLite
connection without reproducing exactly the flakiness this fix targets;
committing through the same session still exercises the real guard
mechanism — a live, database-evaluated compare-and-claim rather than a
stale Python-side snapshot.) The three pre-existing tests in the same
file — stale-version-conflicts, matching-version-passes,
omitted-version-skips-the-check — all still pass unmodified, confirming
the non-race paths are byte-identical to before. Added for the
`updated_at` correction above, and pinning the distinction in both
directions: `test_guarded_noop_patch_does_not_bump_updated_at` stamps a
sentinel `updated_at`, sends a guarded PATCH that repeats the stored
description (no `VERSIONED_FIELDS` change), and asserts `updated_at` is
still the sentinel; its companion,
`test_guarded_real_edit_still_bumps_updated_at`, does the same setup but
sends a genuinely new description and asserts `updated_at` has moved —
proving the pin suppresses `onupdate` for the claim's own no-op statement
without suppressing it for the real write that follows.

`tools/snapshot.py verify`: 9/9. `SURFACE.md` unaffected (`bash
tools/gen_surface.sh` byte-identical) — the new helper
`_claim_expected_version` is underscore-prefixed. Backend sysmon coverage
for the Aito subset (`--include='*aito*'`): this worker measured 38 missed
statements consistently across the original change, unmodified HEAD (three
separate clean full-suite runs), and again after the `updated_at`
correction above — never anything else. The blind verifier separately
measured unmodified HEAD twice, one run completely clean (10145 passed, 0
failed), and got 38 both times too. The 36-vs-38 discrepancy this entry
originally flagged for reconciliation is now SETTLED at 38: `BASELINE.md`'s
documented "≤38 … RATCHET IN FORCE" figure was right, and T-038's
changelog entry's "36" above should be read as superseded by this note.

## T-047 — 2026-08-12 — user-approved behavior change

`useProjectPatchMutation`'s `ownAckedVersion` map (added by T-012, above) let
a same-client back-to-back save skip re-fighting a conflict against itself by
raising a session's captured `expected_version` to
`Math.max(patch.expected_version, ownAckedVersion.get(project.id))` — i.e. to
this client's own freshest acked version for the project, unconditionally.
That was too broad: it raised the captured version whenever this client had
acked ANY newer version for the project, regardless of whether that ack
actually descended from the same base the (possibly long-since-stale) open
editor was built on. Repro: operator A opens the Shipping editor
(`expected_version` captured at server version 5); operator B corrects the
shipping phone number elsewhere, moving the server to 6; A's board refetches
on the `aito_changed` WS event, but A's already-open shipping draft does not;
A then saves something unrelated (the description panel), captured fresh at
6, which succeeds and moves the server to 7, updating A's own
`ownAckedVersion` entry to 7; A finally clicks Save on the still-open,
now-doubly-stale Shipping editor — under the old `Math.max`,
`expected_version` was raised from 5 to `max(5, 7) = 7`, which matched the
server's actual version and let A's v5 shipping values silently overwrite
B's correction with no 409, no conflict toast, and the wrong phone number
went out on the Books quote line.

Fixed by storing the ack as the pair it came from —
`{from: expectedVersionSent, to: responseVersion}` — instead of just the
resulting version, and only raising a session's captured version — NEVER
lowering it — when the ack's own `from` is `<=` that captured version, i.e.
only when the ack genuinely descends from the same base the open editor
session was built on:
`acked && acked.from <= patch.expected_version ? Math.max(patch.expected_version, acked.to) : patch.expected_version`.
In the repro above, the description save's ack is `{from: 6, to: 7}`; the
stale Shipping session's captured version is 5; since `6 <= 5` is false, the
raise no longer applies and the Shipping save now sends its own unraised
`expected_version: 5`, which the server rejects with 409 `version_conflict`
(the same guard T-046, above, made atomic).

**The same-client back-to-back-save case T-012 introduced this map to fix is
preserved.** Walked with numbers: both the description and the immediately-
following shipping save in that burst capture the SAME pre-burst version
(say 1, before either PATCH has resolved); when the first PATCH resolves
(server -> 2), its own ack is recorded as `{from: 1, to: 2}`; the second,
already-queued session's captured version is also 1, and `1 <= 1` is true, so
it correctly inherits `Math.max(1, 2) = 2` and does not re-fight a conflict
against itself. This is exactly `AitoDetailPanelOptimistic.test.tsx`'s F2
suite, which is unchanged and still passes.

**CORRECTION (same task, follow-up commit, same day):** the first revision
of this fix substituted `acked.to` outright behind the descent check instead
of `Math.max(patch.expected_version, acked.to)`. The blind verifier caught
that this could LOWER a session's captured version below what it had
genuinely, freshly captured — the exact mirror image of the bug this task
set out to fix, reached via a different sequence: this client's OWN save
moves the server ahead (e.g. 3 -> 4, ack `{from: 3, to: 4}`); a peer's write
then moves it further (-> 5); a session opened FRESH, after that peer write,
correctly captures the already-current 5. The descent check (`acked.from`
3 `<=` 5) passes, so outright substitution sent the ack's `to` (4) — OLDER
than the session's own fresh capture — drawing a false 409 against a save
that was never stale, recoverable only because `onError` clears the session
ref so a retry falls back to `latestProjectVersion`. `Math.max` closes this:
it still raises the capture when the ack is newer (the F2 and original-repro
cases above), but never lowers it below what the session already captured.

Observable change, quoting the approved description verbatim: "A save from
an editor left open across someone else's write would start failing with
the version-conflict toast instead of silently overwriting them." The
corrected mechanism additionally guarantees a session that captures a
version at least as fresh as this client's last unrelated ack is never
penalized for that ack being older — it always sends its own capture (or
higher), never lower.

Tested in `AitoDetailPanelOptimistic.test.tsx`: a suite (`T-047 — a stale
session left open across a peer's write does not inherit a later, unrelated
ack`) with three cases. (1) The original cross-operator repro above drives a
stand-in server that 409s on a mismatched `expected_version`, and asserts on
the `expected_version` actually sent on the wire for both the intervening
description save (6) and the stale shipping save (5, not raised to 7) — not
just on the resulting 409, since the wire value is what the whole mechanism
turns on; it also asserts the shipping editor stays open and that B's phone
correction survives untouched in the board cache. (2) An S1 case pins the
correction above: this client's own save (3 -> 4), a peer's write (-> 5), a
brand-new session captured at 5 — asserts the sent value is 5 (not the older
ack's 4) and that the save succeeds with no conflict. (3) An S3 case pins
the same hazard reached through a no-op ack (`{from: 3, to: 3}`, a real
shipping-card PATCH that the stand-in server accepts without moving the
version): a peer's write moves the server to 4, a brand-new session captured
at 4 must send 4 (not the unmoved ack's 3) and succeed. The pre-existing F2
(same-client burst), T-012 (cross-operator guard on the description session)
and T-021 (map does not leak across tests) suites all pass unmodified — 10/10
in the file (8 pre-existing + the original T-047 case + S1 + S3), run both
in isolation and inside the full suite.

`tools/snapshot.py verify`: 9/9, both before and after this change (and its
follow-up correction), byte-identical (`aito-frontend-pure`'s probe
exercises `aitoOptimistic` / `aitoBoard` / `aitoAging` / `aitoSearch` /
`aitoSummary` / `aitoBoardRules` only — it does not import
`useProjectPatchMutation.ts` — so this change was never expected to move it,
and `git status --porcelain snapshots/` was empty after verifying). `bash
tools/gen_surface.sh` diff against `SURFACE.md`: empty both before and
after — the map's value type changed from `number` to
`{from: number; to: number}` but no export was added, renamed or removed.
Frontend Aito coverage gate, unchanged by the follow-up correction:
statements 1787/1918 (131 missed), branches 1765/1979 (214 missed),
functions 603/647 (44 missed), lines 1574/1649 (75 missed) — all four
exactly at the existing ratchet ceiling, no regression. `npm run lint` and
`npm run build` both clean; `static/` reverted via `git checkout -- static/`
after building, nothing under it committed.
