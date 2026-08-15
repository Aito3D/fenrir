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
the bound being declared on `AitoTaskCreate`/`AitoTaskUpdate` only. (Also
present versus BASE at the point this task landed, on
`AitoProjectCreate.quote_status`, and unrelated to this change — it is a
different field, not one of the four description fields — is a one-line
`maxLength: 30` drop AND a six-value enum addition, both from T-009's
`quote_status` validation, not this fix: T-011's own contribution to the
golden's delta from BASE is exactly the 16 `maxLength` leaves above; T-009's
own contribution on that same field is 6 `enum` values gained and 1
`maxLength: 30` lost; together, at the point T-011 landed, that was the
golden's entire delta from BASE — 22 leaves added, 1 removed, 0 changed. Do
not read this total as the golden's CURRENT delta from BASE: later entries
in this file — T-037+T-049 (as amended by T-053) and T-048 — each add
further leaves of their own to `aito-pydantic-schemas`, on fields this task
never touched; see those entries for their own deltas, verified the same
way, against the golden as it stood when each of them landed.) Re-recorded
and re-verified 9/9.
`aito-openapi` (paths-only) and `SURFACE.md` are both unaffected — confirmed
byte-identical.

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

- `AitoProjectCreate.tasks: list[AitoTaskCreate] = Field(default_factory=list, max_length=300)`
  (raised from an original `max_length=50` — see the **T-053 correction**
  below for why) — bounded against BOTH of this field's live callers, not
  just one. Caller 1, the create drawer: `AiSummaryPanel.tsx` already calls
  `POST /aito/summarize` with this exact same task array on every drawer
  open/regenerate, and that sibling endpoint's own cap
  (`AitoSummarizeRequest.tasks`, still `max_length=50`, untouched by this
  change) means an operator building more than 50 tasks in the drawer today
  already loses the AI-generated summary past that point (the request 422s
  and `AiSummaryPanel` falls back to `buildFallbackSummary` silently — it
  does not block submission). A single `AitoTaskCreate` also carries its own
  `impression_quantity`, so a large batch of *identical* prints is one task
  with a quantity, not many task rows — 50 *distinct* tasks, each up to four
  priced services, comfortably covers a real order built by hand in the
  drawer. Caller 2, found only after this cap shipped at 50 and 422'd a real
  workflow: the Zoho quote-import preview
  (`aito_quote_import.build_preview`) builds exactly one `AitoTaskCreate` per
  HEADER GROUP of the imported Books estimate (`_build_task(group) for group
  in group_lines(lines)`) and posts the whole list to this same field — an
  estimate with more than the cap's header groups had its WHOLE IMPORT
  rejected, not just its summary. A header group is at most one recognised
  line per service in `SERVICE_RANK` (scan, modelisation, impression,
  usinage — 4 total; a repeated or lower-ranked service opens a new group),
  so 300 tolerates a Books estimate with up to 1200 recognised service line
  items — headroom no real imported estimate has come close to, not a
  realistic ceiling. Chosen inside the user-approved 200-500 range.
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
at 300, raised from an original 50 — see the **T-053 correction** below) and
`POST /aito/import` (`projects` capped at 1000, each item's `description`
capped at 10_000). No other endpoint is reachable through either bound —
`AitoTaskCreate` itself (and therefore `POST /aito/{project_id}/tasks`,
`PATCH /aito/tasks/{task_id}` and `POST /aito/summarize`) is unchanged; the
`AitoProjectCreate.tasks` bound is on the outer list field, not on
`AitoTaskCreate`'s own schema.

Confirmed via six new tests in `backend/tests/unit/test_aito_routes.py`:
`test_create_project_accepts_three_hundred_tasks` /
`_rejects_more_than_three_hundred_tasks` (renamed and re-numbered by T-053,
below — originally `..._fifty_tasks` / `_rejects_more_than_fifty_tasks`),
`test_import_accepts_a_thousand_projects` /
`_rejects_more_than_a_thousand_projects`, and
`test_import_accepts_a_project_description_at_the_cap` /
`_rejects_an_over_cap_project_description` — each pair accepts exactly at
the cap (201, value round-trips) and rejects one past it (422).
`tools/snapshot.py verify` shows exactly one probe moving,
`aito-pydantic-schemas`, with exactly four new leaves and nothing else in
the golden diff, AS ORIGINALLY LANDED (T-053, below, later moved one of
these four): `"maxItems": 50` on `AitoProjectCreate.tasks` (now `300`, see
the correction below), `"maxLength": 10000` on
`AitoProjectImportItem.description` (appearing twice — once as the item's
own top-level schema entry, once in its `$defs` copy embedded by
`AitoProjectImport`, both from the same single field declaration, and
UNCHANGED by T-053), and `"maxItems": 1000` on `AitoProjectImport.projects`
(also unchanged by T-053). `SURFACE.md` is unaffected: `bash
tools/gen_surface.sh` produces a byte-identical file (no new `def`/`class`,
export, or route dependency was added — only field-level constraints
changed). Backend sysmon coverage for the Aito subset held at 38 missed
statements (the ratchet), with all three new bounds fully exercised by the
tests above.

**Correction (2026-08-13), T-053, caught by the blind verifier — the 50 cap
above missed a second live caller and broke it.** `AitoProjectCreate.tasks`
was bounded to 50 by analogy with the create drawer's own workflow (via
`AitoSummarizeRequest.tasks`' identical, unrelated cap) without checking
every caller of the field it was actually placed on. A second caller existed
and was missed: the Zoho quote-import flow builds one `AitoTaskCreate` per
header group of the imported Books estimate
(`aito_quote_import.py:646`, `tasks = [_build_task(group) for group in
group_lines(lines)]`) and posts that whole preview to this same field. A
Books estimate with more than 50 header groups started 422ing its ENTIRE
IMPORT — a workflow that worked before this campaign and is unrelated to the
summary-generation limitation the original 50 was reasoned against. This did
not fail this task's own gate at the time: the approved delta ("over-cap
creates return 422") covered this caller correctly, and the entry's endpoint
list was complete — only the workflow analysis behind the *chosen number*
was incomplete.

The user chose to raise the cap for safety rather than special-case either
caller, and indicated 200-500 as the sensible range; 300 was chosen and
justified against both callers — see the tasks bullet above, now amended in
place rather than left to drift from what actually ships. Consequence,
written down per the user's request even though it predates this fix and is
not introduced by it: with the cap now above 50, an import of a Books
estimate with more than 50 header groups succeeds at `POST /aito/` while its
AI summary silently falls back — `POST /aito/summarize` (still capped at 50,
untouched) 422s for that same task list and `buildFallbackSummary` takes
over client-side. That was already true for any task list past 50 before
this correction (the create drawer could already hit it by hand); this
change only stops it from also blocking the import itself.

The two `AitoProjectCreate.tasks` cap tests were renumbered in place rather
than left describing a limit that no longer exists:
`test_create_project_accepts_three_hundred_tasks` (was `..._fifty_tasks`)
and `test_create_project_rejects_more_than_three_hundred_tasks` (was
`..._rejects_more_than_fifty_tasks`) — same shape, same assertions (accepts
exactly at the cap with a 201 and a round-tripped count, rejects one past it
with a 422), new number. `AitoProjectImport.projects` (1000) and
`AitoProjectImportItem.description` (10_000) were confirmed unchanged by
reading the schema directly, not just by not touching them.
`tools/snapshot.py record` then re-recorded the goldens; parsing both the
previous and current `aito-pydantic-schemas` JSON and diffing leaf-by-leaf
(not the raw text) shows exactly one changed leaf and nothing added or
removed: `AitoProjectCreate.properties.tasks.maxItems: 50 -> 300`.
`git status --porcelain snapshots/` after recording showed only
`snapshots/aito-pydantic-schemas.golden` modified. Re-verified 9/9.
`SURFACE.md` unaffected (no export/def/route dependency touched — a
`Field(...)` bound is not scraped by the generator). Backend sysmon coverage
for the Aito subset, full suite: 38 missed statements, unchanged from the
ratchet — the new cap value is exercised by the same two renamed tests the
old one was.

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

FOLLOW-UP (T-067, 2026-08-13, no new approval — this completes the change
approved above, it does not start a new one): this entry's claim that
`_broadcast_changed` was the only unfiltered emitter of `aito_changed` was
incomplete. `aito_quote_sync.py`'s `run_sync_once` has its own,
independent `aito_changed` broadcast (action `"quote-sync"`, sent after
every background sync tick that commits a project) which T-038 never
touched and which kept calling the unfiltered `ws_manager.broadcast()`.
That is now routed through `ws_manager.broadcast_aito()` too, so the
AITO_READ filter now covers both `aito_changed` emission sites, matching
what this entry already described as the intended behavior. See T-067's
own changelog entry for the fix and its regression test.

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
in the file (8 pre-existing + S1 + S3), run both
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

## T-044 — 2026-08-13 — user-approved behavior change

T-044 (implemented earlier this campaign) closed a race in
`aito_quote_sync.py`'s push path: `_create_quote`/`_update_quote` read the
project's own rows (`load_export_tasks`, `load_export_shipping`) before the
network write to Books, and an edit whose commit landed anywhere in that
window was a same-value no-op on an already-`'pending'` project's
`quote_sync_state` column — SQLAlchemy does not emit an `UPDATE` for a column
reassigned to the value it already holds, so the row carried no trace that a
requeue had happened. Before the fix, `_apply_estimate` unconditionally wrote
`quote_sync_state = "idle"` once the push returned, telling the card it was
in sync while the edit that raced the round trip was missing from Books —
silently dropped, with no record anywhere that it happened.

The fix is a process-local counter, `_requeue_marker: dict[int, int]`. The
bump happens in `_commit_and_wake`, immediately after `db.commit()` returns
and with no `await` in between — never inside `_mark_pending`/
`_mark_pending_if_ours` themselves, which run before that commit — plus a
hand-rolled post-commit site inside `restore_project`, whose own commit is
wrapped in its own `try`/`except` and so cannot be routed through
`_commit_and_wake`. Either way the bump is CONDITIONED ON THE COMMIT
SUCCEEDING: a handler that marks a project pending and then rolls back (an
`IntegrityError`, for instance) leaves no bump at all — bumping ahead of a
commit that never lands would let the sync worker's own snapshot capture an
edit whose row changes are not yet visible to it, narrowing the very race
this marker exists to catch instead of closing it.
`_create_quote`/`_update_quote` capture `_requeue_marker_for(project.id)`
before their own read of the project's rows; `_apply_estimate` compares that
captured value against the live one after the push returns, and only writes
the terminal `quote_sync_state = "idle"` when they still match — popping the
marker entry at the same time, since nothing else will ever need it once the
project has settled to idle. If they differ, an edit committed inside the
window and the project stays `pending` for the next sync tick to pick up and
push for real; the entry is deliberately left in place on that branch,
because the next tick's own comparison still needs it. Every other part of
`_apply_estimate`'s write (`quote_id`, `quote_number`, `quote_date`,
`quote_total`, `quote_synced_at`, the status copy-back, clearing
`quote_sync_error`/`quote_sync_failures`) is unconditional and still runs
exactly as before — only the terminal `'idle'` transition is gated on the
marker comparison.

A later iteration (T-051) moved the bump out of `_mark_pending` — which used
to call `_bump_requeue_marker` directly, ahead of its own caller's eventual
commit — to the post-commit sites described above. Both directions of that
change move the implementation TOWARD this entry's approved wording, not
past it: bumping only after a successful commit newly holds a card
`pending` for an edit whose commit lands during the Books round trip, which
is literally what the paragraph above describes; and no longer bumping on a
rollback removes a hold for an edit that never actually committed, which
this entry never approved in the first place. This is a refinement of
T-044's mechanism, not a new approved behavior — the observable envelope
described in the rest of this entry is unchanged, and no fresh approval was
needed or sought.

This is not, quite, behavior-preserving, and the user was shown why before
approving it. `ProjectDetailPanel.tsx:53-57` maps `quote_sync_state ===
'pending'` to a visible sync row (`aito.syncPendingLabel`, rendered at
`ProjectDetailPanel.tsx:680-681`). So, **inside the race window only**: a
card whose edit committed during the Books round trip now keeps showing that
"pending" sync row for one more interval, and gets pushed to Books again on
the next sync tick (a second Books PUT, and — once that second push lands —
a `sync.pushed` timeline event), where BASE showed no sync row at all and
silently settled to `'idle'` with the edit permanently missing from the
customer's Books estimate. The new behavior is strictly more truthful than
BASE's silent data loss, but it is observably different, which is why this
entry exists.

**What is NOT affected, confirmed by reading the exact gates, not assumed:**
the board card (`CardView.tsx:397`, `{!project.quote_number &&
project.quote_sync_state === 'pending' && (...)}`) and the pending-poll hook
(`useQuotePendingPoll.ts:76`, `.filter((p) => !p.quote_number &&
p.quote_sync_state === 'pending')`) are both additionally gated on
`!quote_number`, and by the time `_apply_estimate` runs `quote_id` is set
unconditionally but `quote_number` only when Books actually returned an
`estimate_number` (`if estimate.get("estimate_number") is not None:` guards
that one assignment) — so the board card and pending-poll exclusion above
holds whenever `estimate_number` is present, which is the case for every
real Books response seen in practice; a response that omitted it would leave
`quote_number` unset and widen this task's race window to those two surfaces
as well, a scenario judged unreachable against a real Books API rather than
a live risk. Only the detail panel's sync row is affected in the reachable
case. In every NON-raced path — no concurrent edit,
an edit landing before the marker is captured, a stale/never-bumped marker,
a simulated process restart mid-round-trip — `quote_synced_at`, `quote_total`,
status adoption, event ordering and board position are written identically
to BASE; the restart case in particular self-heals with no marker at all,
because a mid-round-trip crash never reaches the write that would have
cleared `'pending'`, so the DB row is already correctly `'pending'` for the
next tick regardless of process memory.

**Deployment constraint:** `_requeue_marker` is a plain process-local dict,
not a DB column (deliberately — the comment on the dict itself explains the
marker only has to survive the one in-flight round trip it is guarding). On
a multi-worker deployment, a requeue recorded by one worker process is
invisible to another, so the comparison can spuriously match across
processes and the fix silently reverts to BASE behavior — it can never
produce a false "stuck pending" hold, only a missed catch, which is the same
failure mode BASE always had. This is not reachable in this app's own
shipped configuration: the `Dockerfile`'s `CMD` runs `exec uvicorn
backend.app.main:app ...` with no `--workers` flag, i.e. a single process.

Documentation only — no code change accompanies this entry; T-044's
implementation is unmodified. `tools/snapshot.py verify` and `SURFACE.md`
are unaffected (nothing here touches a probed surface).

## T-048 — 2026-08-13 — user-approved behavior change

`send_quote_email` (`POST /aito/{project_id}/quote-email`) initialized
`marked_sent = False` and left it there for two structurally different
outcomes: (a) `should_move_card == False` — the card was already past the
Quote column, so no move was ever attempted (a legitimate re-send from
Waiting, or a re-send of an already-accepted/declined quote — see
`test_resending_an_accepted_quote_never_demotes_it`); and (b) the
`except SQLAlchemyError` degrade — a move WAS attempted, after the email
had already gone out, and failed (realistically "database is locked" from
the `aito_quote_sync` worker sharing the same SQLite file; this degrade
itself is the user-approved T-013 behavior and is unchanged here). The only
client that read the field, `useSendQuoteMutation.onSuccess`, ignored it
entirely and always fired the plain success toast, so case (b) — the one
where the card is stuck in Devis with an already-sent email and needs a
human to move it — was indistinguishable from an ordinary successful send,
inviting an operator to see the card still parked in Quote, assume the send
never happened, and re-send for real.

**Fix.** `AitoQuoteEmailResponse.marked_sent` is now `bool | None`
(nullable), not a plain `bool`. A nullable field on the existing field was
chosen over a second `move_failed` boolean: it maps each of the three
possible histories to exactly one value with no invalid or redundant
combination to guard against (`true` = moved, `None` = no move attempted —
not a failure, `false` = move attempted and failed); the field stays always
present and always required, so no consumer needs to start checking for a
missing key — but this is not a purely additive wire-contract change: all
three histories returned a plain `bool` before, and the no-move-attempted
history's value moves from `false` to `null`, so a strictly-typed consumer
doing a boolean check on that pre-existing, already-exercised path would
need updating; and it is the smaller change to the
response contract — one field's type widens rather than a second field
appearing alongside it. In `send_quote_email` the initial value moved from
`False` to `None`; the `except SQLAlchemyError` branch now sets
`marked_sent = False` explicitly rather than relying on a pre-set `False`
default, so `False` is only ever reached by the branch that actually
attempted and failed a move. `useSendQuoteMutation.onSuccess` now branches
on `result.marked_sent === false` specifically: that case shows a new
`aito.quoteEmailedCardMoveFailed` warning toast ("Quote sent to {{email}} —
the card could not be moved automatically. Move it manually."); every other
case (`true` or `null`) shows the unchanged `aito.quoteEmailed` plain
success toast. `frontend/src/api/client.ts`'s `sendAitoQuoteEmail` return
type was widened to match (`marked_sent: boolean | null`) — touched because
the fix requires it, not because it is Aito-scoped; it is the shared typed
API client used across the whole app, and this is a one-line type
annotation with no other change. `useSendQuoteMutation.ts` itself was also
touched despite living outside the `hooks/useAito*.ts` glob in the assigned
fence — flagged here per the SCOPE exception process: its sole consumer is
`components/aito/SendQuoteModal.tsx`, it is Aito-exclusive code that simply
predates the naming convention the fence pattern assumes (the same shape as
the frontend coverage gate's "14 real Aito tests not named `Aito*`" note
elsewhere in this run), and the task's own evidence names
`useSendQuoteMutation.onSuccess` as the exact fix location.

**Explicitly preserved, not changed:** the server still returns 200 in the
degrade case — this narrows what the client is TOLD, not what the server
DOES. The email is still sent exactly once on every path. A legitimate
re-send from Waiting (or from any later column) still shows the ordinary
plain success toast, `aito.quoteEmailed` — it is not a failure and must not
read as one; this is the entire reason `None` and `False` are now separate
values instead of both being `False`. The success path (card moved,
`marked_sent: true`) is unchanged end to end: same toast, same response
shape aside from the field's now-nullable type.

Thirteen locale files (`en`, `de`, `fr`, `es`, `it`, `pt-BR`, `ru`, `uk`,
`tr`, `ko`, `ja`, `zh-CN`, `zh-TW`) each gained one real,
non-English-identical translation for `aito.quoteEmailedCardMoveFailed`,
following the exact style of the adjacent `aito.quoteEmailed` /
`aito.clientSyncFailed` keys in each file. `node scripts/check-i18n-parity.mjs`
passes clean (all 13 locales at parity, 6615 leaves each, no
identical-to-English leak flagged for the new key in any locale).

Tested in `backend/tests/unit/test_aito_quote_email.py` (three existing
tests updated, one already-passing test left as the failure-case pin) and
`frontend/src/__tests__/components/AitoSendQuoteModal.test.tsx` (three new
cases added), covering exactly the three histories:
- card moved successfully: `test_send_from_devis_marks_sent_and_moves_to_waiting`
  still asserts `marked_sent is True`, response shape and success path
  unchanged; the new frontend case `'shows the plain success toast when the
  card moved'` asserts the `aito.quoteEmailed` text and asserts the warning
  text is absent.
- re-send from Waiting / already-decided (no move needed):
  `test_send_from_waiting_leaves_the_card_alone` and
  `test_resending_an_accepted_quote_never_demotes_it` were updated from
  `assert body["marked_sent"] is False` to `is None`, with a comment
  explaining why; the new frontend case `'shows the plain success toast —
  not a warning — for a re-send that needed no move'` drives the mutation
  with `marked_sent: null` and asserts the ordinary success toast, not the
  warning.
- card-move half fails with a DB error after the email is already sent:
  `test_a_failed_card_move_still_records_the_send` (pre-existing, unchanged
  assertions — already pinned `marked_sent is False`, `quote.emailed` in the
  event timeline, the email actually sent) continues to pass, confirming the
  T-013 degrade-to-200 behavior this task must preserve; the new frontend
  case `'warns, rather than showing plain success, when the card move failed
  after sending'` drives the mutation with `marked_sent: false` and asserts
  the exact warning text is shown and the plain success text is not.

`./venv/bin/python3 tools/snapshot.py verify`: 9/9 before manual golden
inspection turned up exactly one mismatch, `aito-pydantic-schemas` — expected,
since this task widens a Pydantic field's type and docstring. Parsed both the
golden and current JSON and diffed model-by-model rather than trusting the
single-line text diff: every model except `AitoQuoteEmailResponse` (including
`AitoProjectResponse` and `AitoTaskStepsResponse`, both `$ref`-nested inside
it) was byte-identical; the only change was `marked_sent`'s schema moving
from `{"type": "boolean"}` to `{"anyOf": [{"type": "boolean"}, {"type":
"null"}]}` and the model's `description` gaining the tri-state explanation
now in its docstring. Re-ran `snapshot.py record`, then
`git status --porcelain snapshots/` showed only
`snapshots/aito-pydantic-schemas.golden` modified — every other probe is
deterministic and reproduced byte-for-byte, so `record` did not silently
touch anything else. `aito-openapi` matched throughout, unaffected because it
only captures each path's shape (which references schemas by `$ref` name,
not inlined), not the referenced component schemas themselves. Re-verified
9/9 after re-recording. `bash tools/gen_surface.sh` diff against `SURFACE.md`:
empty both before and after — no new/renamed/removed top-level export in any
fenced file; the new toast logic lives inside an existing exported function's
body.

Backend: `ruff check` / `ruff format --check` both clean. Full suite
(`-n 30`, ignoring `test_bambu_ftp.py`): 10147 passed, 1 skipped, 0 failed.
Sysmon Aito coverage (`--include='*aito*'`): 38 missed statements — exactly
the ratchet ceiling, no regression (`routes/aito.py` 606/11, `schemas/aito.py`
298/3, `aito_quote_sync.py` 372/17, `aito_zoho_comments.py` 76/6; the file's
statement total moved with the added lines/comments, the missed count did
not).

Frontend: `npm run lint` clean. `npm run build` clean;
`git checkout -- static/` after, nothing under it committed. `npm run
test:run` (vitest + i18n parity): all Aito-related files pass; the only
failures were the six known `PrintModal.test.tsx` flakes under full-suite
parallel load (out of Aito scope, zero lines of this diff touch it),
confirmed not a regression by an isolated re-run (75/75 pass alone) per the
FLAKE PROTOCOL. Frontend Aito coverage gate: statements 1787/1918 (131
missed), branches 1765/1979 (214 missed), functions 603/647 (44 missed),
lines 1574/1649 (75 missed) — all four exactly at the existing ratchet
ceiling, no regression.

## T-075 — 2026-08-14 — user-approved behavior change

`AitoPage` rendered its "No projects yet" empty state for the whole duration
of the first board fetch: `useBoardDrag(undefined)` starts at `emptyBoard()`,
so `visibleCount === 0 && board.done.length === 0` is already true before
`aitoQuery` has resolved, and nothing in the file gated the empty-state block
on `aitoQuery.isPending`/`isLoading`. On a cold or slow load the page told the
operator a populated board had no projects. Fixed by adding an
`aitoQuery.isPending` branch ahead of the empty-state block, rendering the
same bare `Loader2` spinner `TrashGrid` uses for its own `isLoading` prop, and
gating the empty-state block itself on `!aitoQuery.isPending`. Observable
change, quoting the approved description verbatim: "during the initial board
fetch the page shows a loading indicator instead of the 'No projects yet'
message it shows today."

`./venv/bin/python3 tools/snapshot.py verify`: 9/9, unaffected — the only
frontend probe, `aito-frontend-pure`, covers the pure utils in
`frontend/src/utils/aito*.ts`, not React render output, and this change
touches neither. `bash tools/gen_surface.sh` diff against `SURFACE.md`: empty
— no top-level export added, renamed, or removed.

Added `it('shows a spinner rather than "no projects yet" while the first
fetch is still pending', ...)` to the `empty board` describe in
`AitoPage.test.tsx`, holding the GET response open by hand (same pattern the
file already uses elsewhere for "still pending" assertions) to assert the
spinner shows and the empty text does not, then releasing the response to
assert the empty state appears and the spinner is gone. This also surfaced
that the pre-existing "says there are no projects yet when nothing exists
anywhere" test's settle signal — `findByRole('button', { name: /show done
\(0\)/i })` — was not actually a settle signal in the zero-row case: `(0)`
is on screen from the very first render regardless of whether the fetch has
resolved, since `board.done.length` defaults to 0 either way (unlike the
sibling "(1)" test, where the count only becomes non-zero once real data
arrives). That test was passing before this task only because the old,
buggy empty-state block did not care whether the fetch was pending. Updated
it to `findByText` the empty message directly, which now IS a settle signal
because the empty message's own visibility is gated on `!isPending`.

Frontend: `npm run lint` clean. `npm run build` clean; `git checkout --
static/` after, nothing under it committed. `AitoPage.test.tsx` alone: 56/56
passed, re-run 3x with no flakes. Full Aito-scoped suite (54 files matching
`components/aito|utils/aito|hooks/useAito|pages/AitoPage`): 826/826 passed.
Aito coverage gate: statements 1820/1941 (121 missed), branches 1809/2021
(212 missed), functions 611/649 (38 missed), lines 1603/1668 (65 missed) —
all four exactly at the existing ratchet ceiling, no regression (the new
render branch's statements/branches are fully exercised by the new test, so
the denominator grew without growing the missed count).

## T-076 — 2026-08-14 — user-approved behavior change

`ActivityRail` destructured only `data`/`isLoading`/`fetchNextPage`/
`hasNextPage`/`isFetchingNextPage` from `useProjectEvents` (an
`useInfiniteQuery`), never `isError`. When `GET /aito/{id}/events` fails
(Zoho/DB hiccup, 500, offline — retried once per `App.tsx`'s `retry: 1`),
`isLoading` is false and `data` is `undefined`, so `events` falls back to
`[]` and the panel rendered `t('aito.history.empty')` ("Nothing recorded
yet") for a project with a full audit trail — no error indication, no retry
control, only reopening the panel to try again. Fixed by taking
`isError`/`refetch` from `useProjectEvents` and, ahead of the empty-state
check, rendering the same `aito.loadFailed` + `common.retry` pair
`AitoPage` and `TrashGrid` already use for their own failed fetches
(`AlertTriangle` icon, message, secondary `Button` calling `refetch()`).
Observable change, quoting the approved description verbatim: "a project
whose history fails to load now shows a load-failed message with a Retry
button where it previously showed 'Nothing recorded yet'."

`./venv/bin/python3 tools/snapshot.py verify`: 9/9, unaffected — the only
frontend probe, `aito-frontend-pure`, covers the pure utils in
`frontend/src/utils/aito*.ts`, not React render output, and this change
touches neither. `bash tools/gen_surface.sh` diff against `SURFACE.md`:
empty — the generator's `components/aito/*.tsx` glob is not recursive, so
it never looks inside `history/`, and no top-level export changed anyway.

Added two cases to `AitoActivityRail.test.tsx`: one mocking
`api.getAitoEvents` to reject once then resolve with an event, asserting
the load-failed message (and not the empty message) appears first, then
that clicking Retry re-fetches and the actor's name from the resolved
event appears while the load-failed message is gone; the pre-existing
"says so when there is nothing to show" test is untouched and continues
to assert the empty message on a genuine zero-event success, keeping the
two states distinguishable.

Frontend: `npm run lint` clean. `AitoActivityRail.test.tsx` alone: 15/15
passed. Full Aito-scoped suite (54 files matching
`components/aito|utils/aito|hooks/useAito|pages/AitoPage`): 827/827 passed.
Aito coverage gate: statements 1821/1942 (121 missed), branches 1811/2023
(212 missed), functions 612/650 (38 missed), lines 1604/1669 (65 missed) —
all four exactly at the existing ratchet ceiling, no regression (the new
render branch is fully exercised by the new test, so the denominator grew
without growing the missed count).

### CORRECTION — 2026-08-15 — loop-5 verifier fix, narrowing

A blind verifier caught that this fix went further than approved.
`useProjectEvents` is a `useInfiniteQuery`; in TanStack Query v5 `isError` is
the parent observer's OVERALL status, true for a failed `fetchNextPage` as
much as for a failed first fetch (`infiniteQueryObserver.js`'s
`isFetchNextPageError` is derived from it). The `isError` branch above ran
ahead of the event list unconditionally, so a "Load more" click that failed
replaced an ALREADY-RENDERED timeline with the load-failed panel — losing
history that was on screen a moment before, which BASE never did and which
the approved wording ("a project whose history fails to load...") never
covered; it was scoped to the first fetch only.

FIX: the error branch is now `isError && !data` rather than bare `isError`.
`data` (TanStack's accumulated pages) survives a failed `fetchNextPage` the
same way it survives on a regular `useQuery`, so this confines the panel to
the case `data` is genuinely absent — the first-fetch failure — and a failed
next page now leaves the rendered timeline up, with the pre-existing
Load-more button (unchanged, still outside the ternary) available to retry
it. Narrowing only: no case that showed the load-failed panel before still
shows anything else, and the first-fetch-failure test above still passes
unmodified.

Added one test to `AitoActivityRail.test.tsx`: first page resolves and
renders, `fetchNextPage` (via the Load More click) rejects, timeline and
Load More stay up and the load-failed text does not appear, then clicking
Load More again succeeds and appends the second page — pinning the failed-
load-more state as distinct from both the first-fetch-failure and the
plain-success paging states, which remain covered by the pre-existing tests.

`./venv/bin/python3 tools/snapshot.py verify`: 9/9. `bash tools/gen_surface.sh`
diff against `SURFACE.md`: empty. See T-091's correction block below for the
combined coverage-gate numbers (both fixes landed in the same pass).

## T-077 — 2026-08-14 — user-approved behavior change

`ActivityRail`'s note `<input>` carried no `maxLength`, but the server's
`AitoNoteCreate.note` (`backend/app/schemas/aito.py`) is
`Field(min_length=1, max_length=2000)`. Pasting a longer note (an email
thread, a client's message) 422s; the generic `noteFailed` toast names no
cause, and the same over-long text is put back in the box on every retry,
so the failure repeats identically with nothing on screen explaining why.
Every other free-text field in this feature (the panel description, the
import/summary textareas) already caps at its own server limit. Fixed by
adding `maxLength={2000}` to the note input, mirroring the verified server
cap exactly. Observable change, quoting the approved description verbatim:
"typing or pasting past 2000 characters into the note box stops being
accepted by the field instead of being accepted and then rejected by the
server."

`./venv/bin/python3 tools/snapshot.py verify`: 9/9, unaffected — no probe
touches this input. `bash tools/gen_surface.sh` diff against `SURFACE.md`:
empty — the generator's globs are not recursive into `history/`, and no
top-level export changed anyway.

Added a case to `AitoActivityRail.test.tsx` asserting the input carries
`maxLength={2000}` and that a note of exactly 2000 characters (set via
`fireEvent.change`, which bypasses the DOM's own maxLength enforcement)
is still submitted verbatim to `api.addAitoNote` — guarding against the
cap ever silently drifting to an off-by-one that would block a legal note.

Frontend: `npm run lint` clean. `AitoActivityRail.test.tsx` alone: 16/16
passed. Full Aito-scoped suite (54 files matching
`components/aito|utils/aito|hooks/useAito|pages/AitoPage`): 828/828 passed.
Aito coverage gate: statements 1821/1942 (121 missed), branches 1811/2023
(212 missed), functions 612/650 (38 missed), lines 1604/1669 (65 missed) —
all four exactly at the existing ratchet ceiling, no regression.

## T-078 — 2026-08-15 — user-approved behavior change

SANCTIONED RETROACTIVELY, and the sequence matters for the record. The
`audit-robustness` finding that produced T-078 was emitted with
`behavior_change: false`, on the reasoning that a prefetch only warms a
cache and the real fetch still happens on selection. The orchestrator
accepted that judgement, and the worker — instructed to stop if it
disagreed — also found no observable difference, because
`setHighlighted()` remained synchronous so nothing the user *sees* was
delayed. The iteration-2 blind verifier rejected all three of those
judgements and returned FAIL, with the case none of them had constructed:

  "a user who hovers and clicks inside that window sees the drawer's
   preview loading state where BASE had the fetch already in flight or
   cached"

That is observable, so it needed the user's decision and had not had it.
The user was then asked directly, shown both the defect and the cost, and
APPROVED keeping the change at the implemented 200 ms (the alternatives
offered were a full revert and a shortened ~100 ms dwell).

WHAT CHANGED. `frontend/src/components/aito/QuoteResultList.tsx`:
`highlight(index)` fired `prefetch(quote.id)` synchronously on every
`onMouseEnter` and every ArrowUp/ArrowDown. Each prefetch is
`GET /zoho/estimates/{id}/preview`, which on the server runs
`get_estimate` + `books_app_url` + `get_contact` against Books live, so
sweeping the pointer down a 20-row list or holding ArrowDown fired dozens
of upstream Books calls in about a second — against a per-org rate limit
SHARED WITH the `aito_quote_sync` worker. Browsing the picker could
therefore 429 the quote sync, not merely its own previews. The prefetch is
now gated behind a 200 ms dwell timer (`PREFETCH_DWELL_MS`), cleared on
the next highlight change and again on unmount.

OBSERVABLE CHANGE: a hover or arrow-key transit shorter than 200 ms that
issued a preview request at BASE now issues none, and a user who hovers
and clicks inside that window sees the preview's loading state where BASE
had the request already in flight or its result cached. Bounded by the
dwell: at most a 200 ms perceived delay, and only on hover-then-immediate-
click. `setHighlighted()` is untouched and still synchronous, so the
highlight itself never lags. The selection path is byte-identical.

KNOWN BENIGN SIDE EFFECT, recorded by the verifier rather than hidden:
selecting a quote early-returns to the selected-card branch instead of
unmounting, so a timer already pending can still fire one prefetch up to
200 ms after selection. Harmless — the query client is alive and the
effect is a cache write with no render consequence.

`./venv/bin/python3 tools/snapshot.py verify`: 9/9, unaffected — the only
frontend probe covers the pure utils in `frontend/src/utils/aito*.ts`, not
React render output. `bash tools/gen_surface.sh` diff against
`SURFACE.md`: empty — no top-level export added, renamed or removed.

CORRECTION to this entry's first draft, made before the squash and noted
rather than silently overwritten: the draft called `QuoteResultList.test.tsx`
a NEW file. It is not — it existed at BASE at 118 lines (confirmed by
`git show refactor-base:frontend/src/__tests__/components/QuoteResultList.test.tsx`),
and T-078 added a `describe('prefetch dwell gate')` block to it. The
verifier caught this on re-judgement; the tests themselves are exactly as
described below.

Tests added to the existing `QuoteResultList.test.tsx`, all on fake timers so no
wall-clock dependence enters a suite that already carries four load-induced
flakes: a fast sweep across rows fires at most one prefetch and only for
the row rested on; unmounting with a timer pending fires no prefetch and
leaks nothing; and the highlight still moves with zero time advanced,
which is what pins the "nothing visible was delayed" half of the claim.

Aito coverage gate at the time of the fix: statements 121 missed, branches
212, functions 38, lines 65 — all four exactly at the ratchet ceiling. The
worker's first attempt measured 122 missed statements because its guard
introduced an unreachable early return; it restructured to an `if (quote)`
block rather than accept the regression or add an uncoverable line.

## T-090 — 2026-08-15 — user-approved behavior change

`frontend/src/components/aito/NewProjectDrawer.tsx`: the drawer's own
`statusQuery = useQuery({ queryKey: ['zoho-status', ...], ... })` feeds
`configured` (`statusQuery.data?.configured === true`) and `defaultId`
(`statusQuery.data?.default_contact_id ?? ''`). With the app's default
`retry: 1`, one failed `GET /api/v1/zoho/status` leaves `statusQuery.data`
`undefined` for up to 60s. Unlike a *successful* response reporting
`configured: false` — which still ships a fallback `default_contact_id`,
so the default-contact effect seeds `draft` and `ClientSection` mounts and
shows its own "Zoho not configured" panel — an *errored* query leaves
`defaultId` empty, the seeding effect never fires, `draft` stays `null`,
and the Client section's body ternary (`creatingClient ? … : draft ? … :
null`) rendered bare `null`. The operator saw an empty Client step and a
Create button that, on every click, revealed no errors and did nothing.

Verified each link of the audit chain before building on it: confirmed
`statusQuery` had no `isError` consumer in this file; confirmed
`ClientSection` gates its "not configured" panel on
`statusQuery.data?.configured === false` only (`ClientSection.tsx:61`),
which an errored query never satisfies; confirmed `CreateChecklist`'s
client-account line is hard-coded `<Line state="ok" ...>`
(`CreateChecklist.tsx:113`) with no Zoho-specific line at all; confirmed
`draft` really stays `null` on an errored query (the seeding effect's
`defaultId` guard) so the section body renders `null`. All four links
held.

FIX, confined to the assigned file: added a third arm to the Client
section's body ternary — `statusQuery.isError ? <panel> : null` — showing
a small "unavailable" panel (same shape as `ClientSection`'s own
not-configured panel: a label plus a bordered text block) reusing the
EXISTING i18n key `aito.zohoUnreachable` ("Could not reach Zoho Books.
Please try again.", already present in all 15 locale files and already
used by `ClientCombobox.tsx`/`QuoteResultList.tsx` for the same failed-
Zoho-request condition). No new i18n key was added. `configured`,
`canCreate` and the retry/staleTime settings are untouched — Create stays
blocked exactly as before; only the reason is now visible.

OBSERVABLE CHANGE, quoting the approved description verbatim: "when the
Zoho status request fails, the new-project drawer will show an
'unavailable/not configured' message where it currently shows an empty
client section and a silently inert Create button."

`./venv/bin/python3 tools/snapshot.py verify`: 9/9, unaffected — no probe
covers React render output. `bash tools/gen_surface.sh` diff against
`SURFACE.md`: empty — no top-level export added, renamed or removed.

Added one test to `NewProjectDrawer.test.tsx` asserting all three states
are distinct: (1) the status GET rejects — the `zohoUnreachable` message
renders, the "not configured" settings link does not, and Create stays
`aria-disabled`; (2) the GET succeeds with `configured: false` — the
settings link renders, the unreachable message does not; (3) the shared
`beforeEach` happy path (`configured: true`) — neither renders.

Aito coverage gate: statements 83 missed, branches 171, functions 28,
lines 38 — all four exactly at the existing ratchet ceiling, no
regression; the new branch is exercised by state (1) of the new test.

## T-091 — 2026-08-15 — user-approved behavior change

`ImpressionFields`' `notConfigured` calc gated only on `referenceDataLoading`
(`filamentsQuery.isLoading || printersQuery.isLoading || defaultsQuery.isLoading`)
before falling through to `printers.length === 0 ? 'printers' : 'filaments'`.
In TanStack Query v5, `isLoading` is `isPending && isFetching`, which goes
FALSE the instant a query settles into its error state — it is not "loading
OR failed", just "loading". `printers`/`filaments` both default to `[]`
(`?? []`) before their query resolves, which is what a failed fetch also
leaves them at. So when GET /calculator/printers (or filaments, or defaults)
failed, the gate did not catch it: the band rendered
`t('aito.noPrintersConfigured')` plus a `/calculator` navigation link — a
false, actionable-looking claim that sends the operator to fix a calculator
that is not misconfigured, for a request that simply failed. Confirmed all
three of the auditor's claims hold before fixing: `isLoading`'s v5 semantics,
the `?? []` fallback on both query results, and that `handleChange` already
stops repricing whenever `defaultsQuery` itself has failed (via its existing
`!defaults` check) — that repricing short-circuit is pre-existing and out of
this task's scope, left untouched.

FIX, confined to `ImpressionFields.tsx` and `ImpressionCostBand.tsx`: added
`referenceDataError` (`filamentsQuery.isError || printersQuery.isError ||
defaultsQuery.isError`), checked FIRST in the `notConfigured` calc, ahead of
the loading/empty-list branches — matching the shape of commit `f2ba215ed`,
which added the equivalent loading-window gate. `notConfigured`'s type grew
a third value, `'unavailable'`, alongside the existing `'printers'` /
`'filaments'` / `null`. `ImpressionCostBand` renders it as its own line —
`t('aito.pricingUnavailable')`, no `/calculator` link, since there is
nothing misconfigured there to go fix — instead of falling into the
`'printers'`/`'filaments'` branch. One new i18n key, `aito.pricingUnavailable`
("Could not load calculator pricing. Please try again."), added to all 13
locale files (checked `aito.zohoUnreachable` and `aito.loadFailed` first per
the brief; both are worded for Zoho/board-specific failures and would
misdirect here, so neither was reused — `frontend/scripts/check-i18n-parity.mjs`
and the `src/__tests__/i18n` suite both pass with the new key).

OBSERVABLE CHANGE, quoting the approved description verbatim: "with the
calculator endpoints failing, the printing block will say pricing is
unavailable instead of claiming no printers are configured."

`./venv/bin/python3 tools/snapshot.py verify`: 9/9, unaffected — no probe
covers React render output. `bash tools/gen_surface.sh` diff against
`SURFACE.md`: empty — no top-level export added, renamed or removed.

Added three tests to `TaskEditor.test.tsx`, keeping all three `notConfigured`
states distinguishable: (1) `GET /calculator/printers/` rejects — the new
"Could not load calculator pricing" message renders, neither "not
configured" message nor the `/calculator` link appears; (2) printers resolve
to a genuinely empty list — "No printers configured" and the link still
render, the unavailable message does not; (3) filaments resolve to a
genuinely empty list — "No filaments configured" and the link still render,
the unavailable message does not. (2) and (3) were previously untested
gaps this task's brief asked to close without touching the printers-vs-
filaments selection itself (T-098's territory) — the new `'unavailable'`
branch sits ahead of that selection in the ternary and does not change it.

Aito coverage gate: statements 83 missed, branches 165, functions 28, lines
38 — statements/functions/lines unchanged at the ratchet ceiling, branches
dropped from 171 to 165 (the new `referenceDataError` branch is fully
covered by the three new tests), no regression.

### CORRECTION — 2026-08-15 — loop-5 verifier fix, narrowing

The verifier flagged (without failing the loop on) the same shape of
overreach here as in T-076's correction above. `referenceDataError` was
`filamentsQuery.isError || printersQuery.isError || defaultsQuery.isError` —
the bare `isError`. With `retry: 1`, `staleTime: 60_000` and v5's default
`refetchOnWindowFocus`, a query that already fetched successfully once can
still fail on a later BACKGROUND refetch while its previous `data` stays in
the cache. `isError` goes true in that case too, so the band would flip to
"Could not load calculator pricing" over a price it could still compute
perfectly well from the data it already had — a case the approved wording
never covered (it was scoped to a fetch that "fails to load", i.e. never
produces anything, not a fetch that succeeded and later degraded).

FIX: added a module-level `isFetchFailure(query)` helper —
`query.isError && !query.data`, mirroring the `isError && !data` shape used
in `ActivityRail` (T-076's correction) — and built `referenceDataError` from
it for all three reference-data queries instead of their bare `isError`
flags. One shared helper rather than three inline `isError && !data` checks:
istanbul counts branch hits at the SOURCE location, not per call site, so
three separate inline checks would have needed a background-failure test for
each of the three queries to keep the coverage ratchet from moving; routed
through one function, any one of them exercising the `isError && !data` path
covers the branch for all three. Narrowing only: a query that has never
resolved still reports unavailable exactly as before (`!query.data` is true
until the first success), so the original first-fetch-failure test and the
two "genuinely not configured" tests are unaffected.

Added one test to `TaskEditor.test.tsx`: renders with all three queries
resolving successfully first (band shows the real "Where the money goes"
split), then fails the next `GET /calculator/printers/` response and forces
a refetch directly on an externally-held `QueryClient`
(`client.refetchQueries`, since jsdom does not model `staleTime`/window-focus
timing deterministically) — asserts the band keeps showing the computed
price and never renders "Could not load calculator pricing", pinning this
state as distinct from the cold-cache failure test above.

`./venv/bin/python3 tools/snapshot.py verify`: 9/9. `bash tools/gen_surface.sh`
diff against `SURFACE.md`: empty — no top-level export changed in either
fix's files.

Combined (T-076 + T-091 corrections) Aito coverage gate, from `frontend/`:
statements 1873/1956 (83 missed), branches 1875/2040 (165 missed), functions
628/656 (28 missed), lines 1642/1680 (38 missed) — all four exactly at the
ratchet ceiling carried over from T-091's own pass, no regression. Full
Aito-scoped suite (56 files matching
`components/aito|utils/aito|hooks/useAito|pages/AitoPage`): 868/868 passed.
`npm run lint`: clean.

### CORRECTION — 2026-08-15 — loop-5 verifier fix #2, assertion point and a
### false coverage claim above

The blind verifier caught two separate problems with the correction directly
above this one.

**The new test did not guard the fix.** It reverted `isFetchFailure`'s body
to the bare `query.isError` — exactly the overreach this task's fix exists to
remove — and ran the whole `TaskEditor.test.tsx` file 5 times: 47/47 passed,
5/5 runs. Instrumenting `ImpressionFields`'s render sequence showed the error
render DOES eventually land (`printersQuery` does settle into `status:
"error"` with `data` retained, so the fix is genuinely needed), but
`await act(async () => { await client.refetchQueries(...) })` does not
reliably flush that propagation before the test's two synchronous assertions
run. The test was checking a negative (`queryByText(...).not.toBeInTheDocument()`)
with nothing forcing it to wait for the failed state to actually arrive first
— a negative assertion that races the state it is supposed to observe passes
whether or not the underlying narrowing exists.

FIX, confined to the test: before the two existing assertions, added
`await waitFor(() => expect(client.getQueryState(['calculatorPrinters'])?.status).toBe('error'))`
— positive evidence that the refetch has actually landed in `error` (with
`data` retained, since the query previously fetched successfully) before
asserting the unavailable message is absent and the price still renders.
Confirmed by direct measurement, not assumption: with `isFetchFailure`
temporarily reverted to bare `query.isError`, the revised test fails on 5/5
runs of the full file (1 failed, 46 passed each time); restoring the
narrowing, it passes 5/5. Source files (`ImpressionFields.tsx`,
`ActivityRail.tsx`) were not touched — the verifier confirmed both
narrowings are correct and the `ActivityRail` test is already
mutation-proven.

**The "one shared helper instead of three inline checks" coverage rationale
above, in this task's own text, is false.** It claimed three inline
`isError && !data` checks "would have needed a background-failure test for
each of the three queries to keep the coverage ratchet from moving." Istanbul
records `&&` branches by whether the second operand was EVALUATED, not
whether it was true — reaching `isError` with `data` still falsy already
exercises both sides of `isError && !data`, regardless of which query it is
attached to or whether that particular query ever undergoes a background
refetch. The verifier measured branch coverage at `ImpressionFields.tsx:22`
directly: `[274, 3]` (hit counts for the two operands) with the new test
present, `[193, 2]` with it deleted — both already fully covered (every
branch hit at least once) by the pre-existing cold-cache failure tests added
earlier in this same task, which reach `isError` with `data` absent. The new
background-refetch test contributes ZERO branch coverage; the coverage
number never depended on it, with or without a shared helper.

The shared `isFetchFailure` helper is NOT being undone by this correction —
it remains a reasonable design on its own terms (one reader for three
identically-treated queries, rather than three copies of the same
condition, hides nothing and cannot drift out of sync). But the coverage
argument for it was wrong and is struck; the actual reason to have the new
background-refetch test is behavioral verification (pinning that a
degraded-but-cached query still prices), not coverage — the coverage ratchet
was never at risk either way.

`./venv/bin/python3 tools/snapshot.py verify`: 9/9. `bash tools/gen_surface.sh`
diff against `SURFACE.md`: empty — this correction touches only test code and
this changelog.

Aito coverage gate, from `frontend/`, re-run after the test-only change:
statements 1873/1956 (83 missed), branches 1875/2040 (165 missed), functions
628/656 (28 missed), lines 1642/1680 (38 missed) — identical to the figures
above, flat as expected: the assertion-timing fix changes when the test
asserts, not what source lines/branches execute. `npm run lint`: clean.
