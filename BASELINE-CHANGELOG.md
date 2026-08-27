# Baseline Changelog

User-approved behavior changes made during the refactor campaign, each an
explicit exception to the campaign's zero-functionality-change rule.

## T-003 — 2026-08-20 — user-approved behavior change

`AitoProjectCreate.client_id` (`Field(min_length=1)`) and `AitoProjectUpdate.client_id`
(`str | None = None`) carried no upper bound, unlike every sibling identifier field in the
same module (`quote_id`: `max_length=50, pattern=r"^[A-Za-z0-9_-]+$"`; `client_name`:
`max_length=200`). The backing column is `String(50)` (`models/aito_project.py`) and SQLite
does not enforce VARCHAR length, so an over-length value was silently stored and echoed back
in `AitoProjectResponse.client_id` on every `GET /api/v1/aito/`.

Fixed by adding `max_length=50` to `client_id` on both `AitoProjectCreate` and
`AitoProjectUpdate`, matching the column. The auditor's finding also suggested reusing
`quote_id`'s `^[A-Za-z0-9_-]+$` character-class pattern; the user explicitly **declined**
that half — a Zoho contact id is opaque and, unlike `quote_id`, is never interpolated into a
URL path or trusted as a filesystem-adjacent token, so a character-class restriction would
only risk rejecting a real Zoho client id already in use, for no corresponding safety
benefit. Only the length bound was added.

Consumer enumeration for both schemas (including composition, not just inheritance) before
the change: grepped `backend/app/` for `AitoProjectCreate` and `AitoProjectUpdate`. Both
names appear only as (a) the class definitions themselves, (b) FastAPI request-body
parameters on `POST /api/v1/aito/` and `PATCH /api/v1/aito/{id}` in `routes/aito.py`, and (c)
comments in `routes/zoho.py` and `services/aito_quote_import.py` referencing the shape by
name, not by import/composition. Neither class is imported or constructed anywhere else in
`backend/`, and neither is composed as a field type (`x: AitoProjectCreate` /
`list[AitoProjectCreate]`) on any other schema — unlike the `AitoTaskCreate` composition
found during T-001/T-009. `AitoProjectResponse.client_id` is its own independently-declared
field (`client_id: str | None` with no `max_length`), not inherited from either write schema,
so it keeps reading back an already-stored over-length value unchanged rather than raising —
confirmed with a test that constructs `AitoProjectResponse` directly with a 60-character
`client_id` and asserts it still validates.

Observable change, quoting the approved description verbatim: "a client_id longer than 50
characters is currently accepted and stored, and would start returning 422."

Snapshot fallout: `aito-pydantic-schemas` mismatched (pydantic's `model_json_schema()` emits
`maxLength` in JSON Schema, unlike `allow_inf_nan`) and was re-recorded — confirmed by
diffing golden vs. current JSON Schema output that the only two fields that changed were
`AitoProjectCreate.properties.client_id` and `AitoProjectUpdate.properties.client_id`, each
gaining `"maxLength": 50` and nothing else. `aito-openapi` was unaffected: that probe only
captures `spec["paths"]`, where request bodies appear as a `$ref` to the components schema,
not the inlined schema itself. `SURFACE.md` did not move (no schema class added or removed).

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

## T-092 — 2026-08-15 — user-approved behavior change

`ShippingFields`' rate input typed straight into `ShippingDraft.price` via
`Number(e.target.value)`, with no floor: `Number('-50')` is `-50`. Verified
all three of the auditor's claims before fixing: `min={0}` on the input is
inert because nothing in either caller submits a `<form>` — `ShippingCard`'s
Save (`onClick={save}`) and `NewProjectDrawer`'s Create (`onClick={create}`)
are both `type="button"`; `shippingDraftErrors` (`utils/shippingDraft.ts`)
checked only `draft.price !== null`, so a negative figure passed as
"complete"; and the server field is `shipping_price: float | None =
Field(default=None, ge=0)` (`backend/app/schemas/aito.py:171`), which 422s.
A negative price previously reached `isShippingComplete`/`shippingPayload`
undetected — from the panel that surfaced as the generic `aito.saveFailed`
toast, and from the create drawer as the whole-project `aito.createFailed`
toast, in both cases with no field named as the cause.

CHOSEN SHAPE: a validation branch in `shippingDraftErrors`, not a
`Math.max(0, ...)` clamp. `ShippingFields`/`shippingDraft.ts` already treat
every other invalid state this way — island, name and phone are each a pure
`shippingDraftErrors` check, revealed via `blurred` and rendered with
`FieldError` under the field, and gate `isShippingComplete`/`canCreate`
identically. A silent clamp would also have been the shape the task
explicitly warned about: clamping toward 0 cannot mis-bill a *different*
positive charge, but it would still swallow a typo like "-50" into "0" (a
free shipment) with nothing on screen telling the operator their figure was
rejected — the opposite of "flagged". Reusing the existing validation
machinery keeps both surfaces (panel Save, drawer Create) blocked from
submitting a negative price with no code changes needed in either caller:
`ShippingCard.save()` and `NewProjectDrawer.create()` already gate on
`isShippingComplete`/`visibleShippingDraftErrors`.

FIX, confined to `shippingDraft.ts` and `ShippingFields.tsx`:
`shippingDraftErrors().price` now returns `'aito.shippingNoRate'` for a null
price (unchanged) and the new `'aito.shippingRateNegative'` for a negative
one — a distinct key, since null and negative are different problems with
different fixes. `ShippingFields` surfaces the negative case directly on the
rate input: `aria-invalid` + the same red-border class the other fields use,
plus a `FieldError` line underneath, gated so it fires ONLY on the negative
branch (`value.price !== null && value.price < 0`) — the null branch is
left alone because the existing amber "No rate from Zoho — enter one" text
already covers it per-service, and surfacing `errors.price` unconditionally
would have doubled that message. One new i18n key,
`aito.shippingRateNegative` ("Rate cannot be negative" / per-locale
translations), added to all 13 locale files, following the
`aito.pricingUnavailable` precedent exactly; `check-i18n-parity.mjs` passes
(6623 leaves in every locale).

OBSERVABLE CHANGE, quoting the approved description verbatim: "typing a
negative shipping rate will be corrected/flagged in the field instead of
being accepted and later failing the whole save or create." Concretely: the
rate input gets a red border and an inline "Rate cannot be negative" message
the moment a negative figure is typed (the field only ever renders once an
island is picked, which already sets `blurred.island` — no extra blur is
needed to reveal it), and both Save and Create refuse to submit while it
stays negative.

`./venv/bin/python3 tools/snapshot.py verify`: 9/9. `bash tools/gen_surface.sh`
diff against `SURFACE.md`: empty — no top-level export added, renamed or
removed.

Added one test to `shippingDraft.test.ts` (negative price gets the new key,
distinctly from a null one; `isShippingComplete` goes false; `-0` is not
flagged) and two to `AitoShippingFields.test.tsx`: typing `-50` into the
rate input renders "cannot be negative" and sets `aria-invalid`, and
correcting it to `50` clears both; a service with no Zoho rate and a null
price renders the "No rate from Zoho" line exactly once (not doubled by the
new field-level error). Reverted the two source files
(`git checkout --` against the committed `HEAD`, leaving the new tests and
i18n additions in place) and ran the two affected test files three times:
2 failed / 32 passed on every run (the two new negative-price tests, the
same two each time). Restored the source fix and re-ran three more times:
34 passed / 34 passed / 34 passed. Confirmed a clean tracked tree afterward.

Aito coverage gate, from `frontend/`: statements 1874/1957 (83 missed),
branches 1885/2050 (165 missed), functions 628/656 (28 missed), lines
1643/1681 (38 missed) — all four sit at the same ratchet ceiling as before
this task (the new branch is fully covered by the new tests; `shippingDraft.ts`
itself falls outside this gate's `src/utils/aito*.ts` glob, so its own new
branch is exercised only by `shippingDraft.test.ts`, not counted in this
report). `npm run lint`: clean. `npm run build`: succeeds; `static/`
reverted afterward and left untouched. Full `npx vitest run`: 3 pre-existing
failures, all in the briefing's known-flaky list (`PrintModal.test.tsx` x2,
`LoginPage.test.tsx` x1) — all three pass in isolation, confirmed flaky and
unrelated to this change.

### CORRECTION — 2026-08-15 — T-091 prose drift, caught by the iteration-6 verifier

The T-091 entry above describes `referenceDataError` as

    filamentsQuery.isError || printersQuery.isError || defaultsQuery.isError

That was true of the FIRST version of the fix and is stale. The shipped code applies a per-query
`isFetchFailure(query) = query.isError && !query.data` to all three reference queries — the
narrowing made by the loop-5 verifier fix and described in the correction blocks above. The
prose in the original entry was simply never updated when the code was narrowed.

This matters only for accuracy of the record, not for scope: `isError && !data` is strictly
NARROWER than `isError`, so a failed BACKGROUND refetch with cached data still present keeps the
BASE behavior (the real price stays on screen) instead of claiming pricing is unavailable. The
observable change therefore sits INSIDE the envelope the user approved, not outside it. Nothing
needs re-approval; the entry above simply overstated what changed.

Recorded as an append rather than an edit, consistent with this file's append-only history across
the whole campaign (`git diff refactor-base..HEAD -- BASELINE-CHANGELOG.md` has zero removed lines).

## T-022 — 2026-08-16 — user-approved behavior change

T-022: camera wall health (stale/degraded/error overlays + live count basis) now derived from decoded frames instead of parsed network frames; terminal 'unavailable' overlays when decode-worker restarts are exhausted. user-approved 2026-08-16.

## T-019 — 2026-08-16 — user-approved behavior change

T-019: AitoPage now gates its board write controls (New project, Import quote, delete/trash) on aito:create / aito:delete permissions, mirroring CalculatorPage; auth-disabled installs unaffected. user-approved 2026-08-16.

## T-026 — 2026-08-16 — user-approved behavior change

T-026: grid toolbar live-camera count recomputed each stats tick from decoded-frame recency; a camera that stops delivering frames now drops out of the count (and returns on recovery). user-approved 2026-08-16.

## T-028 — 2026-08-16 — user-approved behavior change

T-028: useMjpegStream counts consecutive decode failures; past the threshold the stream reports an error and enters the reconnect/give-up flow instead of spinning forever. user-approved 2026-08-16.

## T-029 — 2026-08-16 — user-approved behavior change

T-029: calculator 'save as default'/profile saves clear the session override only on success; failures show an error toast and keep the measured value applied. user-approved 2026-08-16.

## T-031 — 2026-08-16 — user-approved behavior change

T-031: calculator DefaultsForm no longer remounts on background refetch; an untouched form follows server changes, a dirty form keeps the operator's typed values (own saves still adopt + reset). user-approved 2026-08-16.

## T-033 — 2026-08-16 — user-approved behavior change

T-033: PdfPrintButton detects a blocked popup — shows a failure toast and hands the PDF over via download instead of falsely claiming it opened in a tab. user-approved 2026-08-16.

## T-020 — 2026-08-16 — user-approved behavior change

T-020: Calculator settings panels (Filaments/Printers/Defaults) hide their Add/Edit/Delete/Save controls without calculator:update; read-only listing unchanged; auth-disabled installs unaffected. user-approved 2026-08-16.

## T-021 — 2026-08-16 — user-approved behavior change

T-021: logging out clears the persisted new-project draft (client PII) from localStorage; next login starts with an empty drawer. user-approved 2026-08-16.

## T-049 — 2026-08-16 — user-approved behavior change

T-049: off-screen camera tiles are exempt from stale/degraded/error classification and keep counting as live; scrolling back no longer shows false "Camera unavailable" overlays, and the toolbar count reads N/N on a scrolled wall. user-approved 2026-08-16.

## T-050 — 2026-08-16 — user-approved behavior change

T-050: after a grid-stream reconnect, cameras that never resume decoding now fall into the error state ("Camera unavailable") instead of freezing silently on the last frame. user-approved 2026-08-16.

## T-047 — 2026-08-16 — user-approved behavior change

T-047: session expiry (auth:expired 401 path) now clears the persisted new-project draft like explicit logout does. user-approved 2026-08-16.

## T-048 — 2026-08-16 — user-approved behavior change

T-048: Aito board write controls (drag-move, flag, quote-status, send-quote, task editing, restore) now hidden/disabled without aito:update (task add/remove follow their backend permissions); auth-disabled installs unaffected. user-approved 2026-08-16.

## T-051 — 2026-08-16 — user-approved behavior change

T-051: decode-worker restart budget replenishes when a restarted worker recovers (and on stream reconnect); only consecutive unrecovered stalls latch the terminal "Camera unavailable" state. user-approved 2026-08-16.

## T-052 — 2026-08-16 — user-approved behavior change

T-052: useMjpegStream self-recovers after the decode-failure budget trips when the caller supplies no onError (bounded backoff, generation-guarded); callers with onError keep exclusive control of recovery. user-approved 2026-08-16.

## T-053 — 2026-08-16 — user-approved behavior change

T-053: WebRTC SDP negotiation now times out (bounded) when go2rtc never answers; the tile shows the error state and enters backoff retry instead of spinning forever. user-approved 2026-08-16.

## T-057+T-062 — 2026-08-16 — user-approved behavior change

T-057+T-062: all three grid health timers (startup, reconnect grace, periodic) now share the visibility exemption; tiles skipped while off-screen get a fresh grace window on scroll-back and error only if they still fail to decode. user-approved 2026-08-16.

## T-065 — 2026-08-16 — user-approved behavior change

T-065: useMjpegStream's onError-less self-restart now also covers network failures and clean EOF (same backoff and generation guards), so overlay/kiosk streams recover from any termination; callers with onError unchanged. user-approved 2026-08-16.

## T-001 — 2026-08-18 — user-approved behavior change

`add_task` (`POST /aito/{project_id}/tasks`) writes the four `*_done` step
flags (`scan_done`/`modelisation_done`/`impression_done`/`usinage_done`) onto
the new task straight from `payload.model_dump()`. `_reject_ticks_without_
acceptance` only checks the PARENT PROJECT's `quote_status`, never who is
making the request, so once a project's quote is accepted, a principal
holding only `aito:create` (a real, supportable custom-group configuration —
the default Operators group bundles all four `aito:*` permissions, so this
was never reachable through it) could POST a task with a step already ticked
onto that EXISTING, already-accepted project. The identical write via `PATCH
/aito/tasks/{task_id}` (`update_task`) has always required `Permission.
AITO_UPDATE`. The same `add_task` call also runs `_mark_pending_if_ours` and
`_apply_rules`, so the ticked, priced line the sync worker picks up gets
pushed onto the project's live Zoho estimate via `_update_quote`'s full
`line_items` rebuild — bypassing `update_task`'s trust boundary entirely.

`add_task` now mirrors `create_project`'s existing in-body check (T-036,
2026-08-12): it rejects the request with 403 when any of the four `*_done`
fields is truthy in the payload and the caller's `current_user` does not hold
`aito:update` (checked via `current_user.has_permission(Permission.AITO_UPDATE
.value)`, the same idiom `create_project` already uses). The check is skipped
when `current_user is None`, the auth-disabled case (the dependency returns
`None` for both auth-disabled and a valid API key, and API keys cannot hold
`AITO_CREATE` at all — it is denylisted in `core/auth.py`'s `_APIKEY_SCOPE_BY_
PERMISSION`, so a ticked-task create can only reach the route body as a real
JWT-authenticated user or with auth off) — an auth-disabled instance is
unaffected, matching every other permission gate in this file.

**Remediation (same day):** the check was initially wired in BEFORE
`_reject_ticks_without_acceptance(task_fields)`, so an `aito:create`-only
caller POSTing a ticked step to a NON-accepted project got 403 instead of the
pre-existing, unapproved-change 422. The user approved only the
already-accepted-project case quoted below, so the ordering was corrected:
the 403 check now runs strictly AFTER `_reject_ticks_without_acceptance`.
Final ordering, both branches verified by test: (1) non-accepted project +
ticked step → 422, unchanged from BASE and untouched by this task, regardless
of the caller's permissions; (2) accepted project + ticked step + caller
lacks `aito:update` → 403, the approved change below. The 403 check's
permission lookup is now only reached once `_reject_ticks_without_acceptance`
has already let the request past the quote-acceptance gate.

Observable change, quoting the approved description verbatim: "a user in a
group granted aito:create without aito:update can currently POST a task with
a step already ticked to an accepted project and would start getting 403;
groups holding both permissions (including the default Operators group) see
no change." Callers affected: a caller authenticated with a JWT whose
group(s) grant `aito:create` but not `aito:update`, POSTing a task with at
least one `*_done` flag truthy, to a project whose `quote_status` is already
`"accepted"`. Callers NOT affected: any caller who also holds `aito:update`
(including the default Operators group, unchanged); any caller POSTing a task
with no ticked steps (the common case); any caller POSTing a ticked step to a
NON-accepted project (still 422, from `_reject_ticks_without_acceptance`,
which now runs first and is unchanged in behavior); any caller when auth is
disabled; `update_task`, `_reject_ticks_without_acceptance`'s own logic, and
every other route in this file, none of which were touched.

`tools/snapshot.py verify` shows 12/12 probes matching — `aito-route-perms`
only greps `RequirePermissionIfAuthEnabled(...)` call sites, and this check
is an inline `current_user.has_permission(...)` in the route body, not a new
dependency, so that probe is correctly unaffected; `aito-openapi` captures
the `/aito` paths' OpenAPI schema (route metadata and request/response
shapes), which this in-body runtime check does not alter either.
`SURFACE.md` is also unaffected: `bash tools/gen_surface.sh` produces a
byte-identical file (no new `def`/`class`, export, or route dependency was
added). Backend coverage over the Aito scope: 2012/2051 statements (98.10%),
542/570 branches (95.09%) — both at or above the 98.09%/95.07% baseline.

## T-006 — 2026-08-18 — user-approved behavior change

`useAitoPresence.ts`'s module-level `viewers` map is written exclusively by
`setAitoPresenceState`, which only ever runs when the server sends an
`aito_presence_state` WebSocket message. `useWebSocket` calls
`registerPresenceSender(null)` from `ws.onclose`, but `registerPresenceSender`
only ever swapped the `sender` reference and (when registering a real sender)
replayed `sendAitoPresence`'s own project id — it never touched `viewers`.
Once the socket dropped, the server's own presence bookkeeping for our
connection was already gone, yet every card (`useAitoViewers`) and the
detail-panel banner kept rendering the last-received operators as "viewing
now" — stale for as long as the reconnect took, indefinitely if the backend
stayed down, since only a fresh `aito_presence_state` after reconnecting
could ever refresh the map.

`registerPresenceSender` now clears `viewers` and calls the module's existing
`emit()` (the same notify path `setAitoPresenceState` uses, so
`useSyncExternalStore` re-renders every subscribed card and the panel
banner) whenever it is invoked with `send === null` — the disconnect case —
and `viewers` is non-empty. Registering a real sender (reconnect) is
untouched: the existing own-presence replay (`send({ type: 'aito_presence',
project_id: ownProjectId })`) still fires when applicable, and the clear
branch is gated on `!send`, so it cannot run on that path. The emptiness
check (`Object.keys(viewers).length > 0`) avoids an emit (and the resulting
re-render fan-out) on a null-sender call that has nothing to clear, e.g. a
second `ws.onclose` before any reconnect populated the map — matching the
file's existing convention of not calling `emit()` when nothing observable
changed.

Observable change, quoting the approved description verbatim: "The 'X is
viewing now' banner and card markers would vanish while the WebSocket is
disconnected instead of showing the last-known viewers." Callers affected:
any operator with the Aito board or a project's detail panel open at the
moment another operator's (or their own) WebSocket disconnects — the
viewing-now markers for whoever the server had last reported now clear
instead of persisting stale. Callers NOT affected: `sendAitoPresence`,
`setAitoPresenceState`, and the reconnect replay path, none of which
changed; any observer while the socket stays connected (`viewers` is only
ever cleared from the null-sender branch).

`tools/snapshot.py verify` shows 12/12 probes matching, including
`aito-frontend-pure` — this hook's logic is not part of that probe's
bundled pure-function set, so no re-record was needed or performed.
`SURFACE.md` is also unaffected: `bash tools/gen_surface.sh` produces a
byte-identical file (no new export, route, or public signature was added).
Frontend coverage over the Aito scope: 1930/2005 statements (96.25%),
1976/2132 branches (92.68%) — both at or above the 96.25%/92.66% baseline.

## T-003 — 2026-08-18 — user-approved behavior change

`run_sync_once`'s per-project try block ended with `await _apply_rules(db,
project, await _summary_for(db, project.id))`, reading `project.id` off the
SAME `AitoProject` instance `sync_project` had just been handed. When
`sync_project` hits one of its four terminal `except` clauses (a Zoho error
its own logic treats as final rather than retryable), it calls
`_terminal_error`, which first calls `_rollback_after_terminal_failure` —
`await db.rollback()` when the session is not `is_active` — and that rollback
expires every attribute SQLAlchemy is holding on `project`, per that helper's
own docstring. `_terminal_error` then sets `project.quote_sync_state =
"error"`, `project.quote_sync_error = message`, and `project.quote_sync_
failures = 0` directly (plain attribute writes, which do not require a
reload even on an expired instance), and — ONLY when the failure is new or
its message changed since the last tick — calls `record(...)`, which flushes
and, as a side effect of building that flush's UPDATE statement, reloads
`project`'s expired attributes from inside the awaited flush's own greenlet
context, leaving the instance safe to read afterwards.

But when the SAME flush failure repeats on a later tick with an unchanged
message, `_terminal_error`'s debounce (`if not already_in_error or previous_
sync_error != project.quote_sync_error`) skips that `record()` call — by
design, so a project stuck in `'error'` does not write one `sync.failed`
event row per tick forever. With no flush in between, `project` stays
expired when control returns to `run_sync_once`. The bare `project.id` read
back in the loop is a plain synchronous attribute access, not an `await`, so
it runs outside the greenlet context every awaited SQLAlchemy call in this
file executes inside — exactly the "lazy reload outside a greenlet context"
trap `run_sync_once`'s own loop comment already warned about elsewhere in
this file. That raised `MissingGreenlet`, which propagated out of the try
block into the loop's own `except Exception: await db.rollback(); logger.
exception(...)`. That second rollback then discarded every uncommitted write
`sync_project`/`_terminal_error` had just made in-memory for this
project — the terminal `quote_sync_state="error"`, `quote_sync_error`, and
`quote_sync_failures` reset — none of which had been committed yet, because
the loop's `await db.commit()` sits AFTER the now-failing `_apply_rules`
call.

The fix re-fetches the project through the loop's own `project_id` local
(`project = await db.get(AitoProject, project_id)`, an `await`ed call that
runs inside a greenlet and is therefore always safe against an expired or
even a fully evicted instance) immediately before `_apply_rules`, rather than
reading off the possibly-expired `project` reference `sync_project` was
handed. `_summary_for` is called with `project_id` directly rather than
`project.id` for the same reason.

Observable change: BEFORE this fix, a project whose Books flush failed
REPEATEDLY with an unchanged error message (the debounced-record case above)
was, from that tick onward, left exactly as it was before the tick started —
the terminal error state `_terminal_error` had just computed was silently
discarded by the loop's own rollback, no `aito_changed` WebSocket broadcast
fired, the project's card kept showing no sync error at all, and the project
remained `quote_sync_state="pending"` (or whatever pre-failure state made it
eligible), so it was re-selected and retried — and spent another Zoho Books
API call — on every subsequent tick, indefinitely, with no visible sign of
the underlying failure. AFTER this fix, the terminal state and the freshly
recomputed `board_column` persist through `db.commit()`, the project stops
being re-selected as pending, the card's `quote_sync_error`/`quote_sync_
state` (both public fields of `AitoProjectResponse`, rendered directly on
the Aito board card) show the failure, and the `aito_changed` broadcast
fires to connected clients same as any other successful tick. Callers
affected: any project whose Zoho sync hits one of `sync_project`'s four
terminal failure branches with the SAME error message on two or more
consecutive ticks — the first occurrence of a given message was never
affected, since `_terminal_error`'s debounce only skips `record()` (and thus
only reproduces the bug) once `already_in_error` is already true with an
identical `previous_sync_error`. Callers NOT affected: the non-repeating
first-failure tick (already flushed and safe by way of `record()`'s own
flush); any tick that completes `_apply_rules` without a terminal exception;
`_terminal_error`, `_rollback_after_terminal_failure`, `sync_project`, and
`record()` themselves, none of which were touched — only the two reads at
the bottom of `run_sync_once`'s per-project loop changed.

This was approved by the user on 2026-08-18 after the blind verifier flagged
it as an unrecorded behavior change on iteration 1; the auditor that produced
`TRIAGE.md`/`PLAN.md` had originally classified this task's diff as
`behavior_change: false` on the theory that it was purely defensive
(preventing a crash), missing that the crash's own `except Exception` was
itself silently discarding the terminal error state, a state the fix now
lets survive to be committed and observed.

`tools/snapshot.py verify` shows 12/12 probes matching — this change touches
neither a route signature nor `_apply_rules`'/`_summary_for`'s own public
call shape, only which `AitoProject` instance and which id `run_sync_once`
feeds them, so no probe recorded a change. `SURFACE.md` is also unaffected:
`bash tools/gen_surface.sh` produces a byte-identical file (no new
`def`/`class` or export was added). Backend coverage over the Aito scope
remains at or above the 98.09%/95.07% baseline — see the combined
verification run covering T-001 and T-003 together.

## T-006 — 2026-08-19 — user-approved behavior change

`proofread_text` sized `max_tokens` from a CHARACTER count using a fixed
2-chars-per-token ratio (`min(1000, len(source) // 2 + 120)`), and `_chat`
returned `response.json()["choices"][0]["message"]["content"].strip()`
without ever looking at `finish_reason`. French prose dense in accents,
digits and references can tokenise under 2 chars/token, so a long, dense
field (up to `PROOFREAD_MAX_CHARS` = 2000 chars, the request schema's own
cap) could hit the 1000-token ceiling before the model finished the
sentence — the completion still came back as a normal 200, differed from
`sent`, and `AiTextField` swapped it straight into the field, silently
deleting whatever came after the cut.

Two changes, both approved: (1) `max_tokens` is now sized from a
conservative (i.e. token-dense) estimate of 1.5 chars/token instead of 2
(`int(len(source) / 1.5) + 120`), giving real headroom for dense French text
without an arbitrary hard cap — the schema's own `PROOFREAD_MAX_CHARS` bound
already limits the worst case. (2) `_chat` now raises
`OpenRouterUpstreamError` when the chosen completion's `finish_reason ==
"length"`, i.e. the model was cut off before finishing, instead of returning
the truncated text as a valid answer.

Observable change, quoting the approved description verbatim: the caller
(`proofread_text`'s route) already treats `OpenRouterUpstreamError` as a
silent no-op that leaves the user's text alone with no error surfaced in the
UI — that silence is intentional and approved, not a follow-up gap. Callers
affected: any proofread request whose upstream completion is truncated
(`finish_reason == "length"`) now gets no correction applied (previously: a
truncated correction silently replaced the field's full text). Callers NOT
affected: any completion that finishes normally (`finish_reason` anything
other than `"length"`, including absent), which is unaffected by either
change beyond a larger `max_tokens` budget in the outgoing request;
`summarize_tasks`, which does not go through this code path's `max_tokens`
formula and was not touched by change (1).

`tools/snapshot.py verify` shows 11/11 probes matching before and after —
`aito-ai-prompts` pins `openrouter.py`'s constants, prompt text,
`_task_lines` and `_unquote`, none of which changed; it does not probe
`_chat` or `proofread_text`'s `max_tokens` sizing or `finish_reason`
handling, so neither approved change touched a golden. `SURFACE.md` is also
unaffected: `bash tools/gen_surface_aito.sh` produces a byte-identical file
(no `def`/`class`/export was added or removed).

### Correction — 2026-08-19, same day, after the blind verifier ran

The paragraph above, as originally committed (`8fb761324`), understated the
blast radius of change (2). The `finish_reason == "length"` guard was placed
inside `_chat`, the helper SHARED by `proofread_text` AND `summarize_tasks`
(`_chat(..., max_tokens=200)` at the summarize call site), with no
caller-specific gating. "Callers NOT affected" above claimed `summarize_tasks`
"was not touched" — true only of change (1)'s `max_tokens` formula, and
false of change (2): `summarize_tasks` was fully affected by the new
`finish_reason` guard, exactly like `proofread_text`. Only change (1) — the
approved one — was scoped to the proofread path; change (2) — approved for
proofread only — silently applied to both.

Concretely: BEFORE this campaign, a summarize call whose completion was cut
off by the hard-coded `max_tokens=200` budget returned the truncated summary
string as-is (BASE behavior, unchanged since before this campaign). AS
COMMITTED in `8fb761324`, the same truncated completion instead raised
`OpenRouterUpstreamError` out of `summarize_tasks`, which propagates to a
502 at `POST /api/v1/aito/projects/{id}/summarize`
(`backend/app/api/routes/aito.py`), which `AiSummaryPanel.tsx` catches by
flipping to its `failed` state and substituting a locally-built
`buildFallbackSummary(...)` string in place of the model's (truncated but
real) output — a different, unapproved, user-visible change on a caller
`summarize_tasks` runs against a user-configurable model with a fixed
200-token cap, where hitting that cap is plausibly common rather than rare.

The blind verifier reproduced this directly (feeding a
`finish_reason: "length"` payload to `summarize_tasks` and observing BASE
return the summary while HEAD raised) and failed the iteration on it. Per
the user's instruction, the guard was narrowed to the proofread path only:
`_chat` gained an opt-in `raise_on_truncation: bool = False` parameter
(default preserves BASE behavior for every existing caller), and only
`proofread_text` passes `raise_on_truncation=True`. `summarize_tasks` is
unchanged from BASE for both the `max_tokens` formula (never touched, see
above) and `finish_reason` handling (now, again, not checked at all) —
a truncated summary is once more returned as the summary. Proofread's
observable behavior, including the ordering where a truncated AND empty
completion reports "OpenRouter truncated its answer (finish_reason=length)"
rather than "OpenRouter returned an empty answer", is byte-identical to what
`8fb761324` committed. A regression test
(`test_summarize_returns_truncated_content_instead_of_raising` in
`backend/tests/unit/test_openrouter_service.py`) now pins the split: it was
run against the unnarrowed `_chat` first and failed (raised
`OpenRouterUpstreamError` instead of returning content), then passed after
the narrowing. `tools/snapshot.py verify` remains 11/11 after the narrowing.

## T-001 — 2026-08-19 — user-approved behavior change

Every money/quantity `float` field on `AitoTaskBase`, `AitoShippingInput` and
`AitoProjectCreate` used a plain `ge=0` (or `gt=0, le=100`) constraint, which
admits `float('inf')` — `inf >= 0` is `True` — and Starlette parses the
request body with plain `json.loads`, which (unlike the JSON spec) accepts
the non-standard `Infinity`/`NaN` literals. A request carrying
`"shipping_price": Infinity` or `"impression_cost": Infinity` was accepted
and persisted with the row storing `inf`; Pydantic v2 then serialises a
non-finite float back out as JSON `null`, which is how the corruption stayed
invisible in the response (`tasks_total`, `shipping_price`, the task's own
cost all read back as `null`, not an error). `services/aito_board_rules.py`
accumulates task costs into `TaskSummary.total`, so one poisoned task made
the whole project's `tasks_total` non-finite too.

Fixed by adding `allow_inf_nan=False` to every field the audit named:
`scan_cost`, `modelisation_cost`, `usinage_cost`, `impression_cost`,
`impression_weight_g`, `impression_discount_pct` (on `AitoTaskBase`),
`shipping_price` (on `AitoShippingInput`) and `quote_total` (on
`AitoProjectCreate`). The update-path schemas needed no separate change:
`AitoTaskUpdate` inherits `AitoTaskBase`'s cost fields, and
`AitoProjectUpdate` inherits `AitoShippingInput`'s `shipping_price`, without
redeclaring either — so PATCH `/aito/tasks/{id}` and PATCH `/aito/{id}` are
closed by the very same constraint (`AitoProjectUpdate` has no `quote_total`
field at all; it is create-only). `impression_discount_pct`'s existing
`gt=0, le=100` bounds already rejected `NaN` (`nan > 0` is `False` in
Python) and `inf` (`inf <= 100` is `False`), so `allow_inf_nan=False` there
is redundant but harmless, added for consistency with the rest of the
approval's field list.

Observable change, quoting the approved description verbatim: "a request
sending Infinity or NaN for a cost or shipping price is currently accepted
and stored, and will start returning 422." In practice, end-to-end the
response is not a clean 422 today: FastAPI's default
`RequestValidationError` handler builds its body with
`jsonable_encoder(exc.errors())`, which does not sanitise a non-finite float
carried in a validation error's own `input` field, and Starlette's
`JSONResponse.render` then calls `json.dumps(..., allow_nan=False)`, which
raises on that float — the attempt to report "you sent an invalid number"
crashes trying to echo the number back. In this app that crash currently
surfaces as a misleading 503 ("Authentication service temporarily
unavailable") via `auth_middleware`'s broad `except Exception` around
`call_next` in its auth-disabled fast path (main.py). This is a
PRE-EXISTING, framework-level bug — the identical crash reproduces on
unmodified BASE code by sending `Infinity` to `impression_time_min` (a
plain `int` field this task never touched) — so it predates this fix and is
out of T-001's scope (`schemas/aito.py` cannot fix error-response
serialisation in FastAPI/Starlette or exception handling in a shared
middleware). What this fix does guarantee, and what the added tests prove:
the request is rejected before the route handler runs, so nothing is ever
persisted — the security-relevant half of the audit finding. The exact HTTP
status code returned for this one input shape is a separate, follow-up
finding.

`tools/snapshot.py verify` showed 11/11 probes matching both BEFORE and
AFTER the change — `allow_inf_nan` is a validation-only Pydantic
constructor argument with no JSON Schema representation, so neither
`aito-pydantic-schemas` (which serialises `model_json_schema()`) nor
`aito-openapi` (which serialises the routes' schemas) recorded any diff; no
probe was re-recorded. `SURFACE.md` is also unaffected:
`bash tools/gen_surface_aito.sh` produces a byte-identical file (no
`def`/`class`/export was added or removed). Backend coverage over the Aito
scope (the 13 `backend/app/**/aito*.py` source files) measured identically
before and after this change — 98.07% statements / 94.93% branches in both
cases, with `schemas/aito.py` itself unchanged at 98.27% — because
`allow_inf_nan` is enforced inside pydantic-core's Rust validator and adds
no new Python-visible statement or branch for `coverage.py` to count; the
new tests exercise it via the resulting `ValidationError`, not via a
source-level branch.

## T-005 — 2026-08-19 — user-approved behavior change (approval given RETROACTIVELY)

**This entry was written after the fact.** Iteration 1's blind verifier
FAILED the iteration because commit `260375eeb` ("refactor(loop-1): T-005
AiTextField unmount guard on proofread onSuccess") made an observable
behavior change with no backing entry in this file. The change itself was
not reverted or altered — the user reviewed it after the fact and approved
it retroactively; this entry exists solely to bring the record into line
with what already shipped, not to introduce anything new.

`frontend/src/components/aito/AiTextField.tsx`'s proofread mutation's
`onSuccess` swapped a returned correction into the field via `onChange`
whenever the (possibly stale) `sent` text still matched the field's current
value, but never checked whether the field itself was still mounted.
`TaskRow.tsx:262` mounts `TaskStepFields` (and therefore `AiTextField`)
behind `!collapsed`, so an operator who blurs a field (starting an up-to-8s
`POST /aito/proofread`) and then deletes or simply collapses that task row
unmounts the field mid-request. When the response then landed, `onChange`
still ran — through the parent's last-rendered, by-then-stale closure —
against the PRE-delete task array. `useProjectTasks` saw that array grow
relative to its own current state, took its append branch, and put the
already-removed row back on screen, which then got POSTed as a brand-new
task: a duplicate of an already-persisted task that the Zoho sync worker
went on to push onto the client's quote as a genuine, unwanted duplicate
line.

Fixed by adding a `mountedRef` (set `true` on creation, flipped to `false`
in the component's existing unmount cleanup effect) and returning early
from `onSuccess` when it is `false`, before either the `sent`-still-matches
check or the `onChange` call:

    settledRef.current.add(data.text);
    if (!mountedRef.current) return;
    if (valueRef.current.trim() !== sent) return;
    ...
    onChange(data.text);

Observable change: BEFORE, a proofread correction that resolved after its
`AiTextField` had unmounted was still applied, via the stale parent
closure, and could resurrect an already-deleted task as a duplicate.
AFTER, that correction is silently dropped — nothing is shown to the user,
and no `onChange` fires for a field that is no longer there. A correction
that resolves while the field is still mounted is completely unaffected.

Confirmed via a new test in the accompanying test file,
`does not apply a correction that lands after the field has unmounted`.
The blind verifier itself reproduced the bug empirically as part of
flagging this change: it staged BASE's `frontend/` into a scratch tree,
dropped in HEAD's test file unmodified, and ran it — the new test FAILS
against BASE with `AssertionError: expected 6 to be 5`, confirming BASE
really did fire the extra, unwanted `onChange` this fix suppresses.


### Correction — 2026-08-19, iteration-1 blind verifier run #3, after this
### iteration's own commits landed

**Both corrections below were written after the fact**, following the same
pattern as the T-006 Correction above: the underlying fixes were made in a
new commit on top of `8fb761324`/`4d9e71eea` (not by amending them), and
these paragraphs bring the record for the two entries above into line with
what actually shipped, rather than silently rewriting history.

**T-005, above:** the paragraph "Observable change: ... A correction that
resolves while the field is still mounted is completely unaffected" was
false in a development build. The fix added a `mountedRef` that starts
`true` and was flipped to `false` in `AiTextField`'s existing unmount-cleanup
effect — but nothing ever flipped it back to `true`. `frontend/src/main.tsx`
wraps the whole app in root-level `<StrictMode>`, and React 19's development
runtime runs every effect as `setup | cleanup | setup` on first commit (a
deliberate double-invoke, to surface exactly this class of bug). The
cleanup half of that sequence set `mountedRef.current = false` on the FIRST,
discarded setup, and nothing in the component ever set it back to `true` —
so from that point on, in `npm run dev`, `onSuccess` read `mountedRef.current
=== false` for the field's entire remaining lifetime and returned early on
every single response, for every `AiTextField` on the page. No proofread
correction was ever applied to any Aito task field in a development build;
only the production bundle (which strips `<StrictMode>`'s double-invoking
behavior) worked as the entry above described.

Fixed by moving the `mountedRef.current = true` assignment into the START of
the same effect, so a StrictMode-driven re-setup re-arms the flag exactly as
the cleanup half disarmed it:

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        ...
      };
    }, []);

This is the standard shape for this exact hazard and changes nothing about
the fix's actual intent (dropping a correction that lands after a genuine
unmount) — it only repairs whether the flag is live across StrictMode's
extra setup/cleanup pair, which it never was before.

The gap that let this ship: `frontend/src/__tests__/utils.tsx`'s shared
`render` helper does not put `<StrictMode>` at the root of the tree handed
to `ReactDOM`, so none of the 13 existing `AiTextField` tests (which all go
through that helper) ever double-invoked an effect, even though the app
itself does. A new test,
`still applies a correction under root-level StrictMode (dev double-effects)`
in `frontend/src/__tests__/components/AitoAiTextField.test.tsx`, builds its
own minimal tree with `<QueryClientProvider>` wrapped directly in
`<StrictMode>` (bypassing the shared helper for this one case, on purpose)
and asserts the correction is applied. Run against the code as originally
committed, it failed: `expected the element to have value: Capot avec 3
pièces, Received: capot avec 3 pieces` (the raw, uncorrected text — proving
`onSuccess` really did bail out under root-level StrictMode). It passes
after the `useEffect` fix above. The other 13 tests in that file, and the
shared helper itself, are unchanged.

**T-001, above:** the paragraph beginning "Fixed by adding `allow_inf_nan=
False` to every field the audit named" listed the update-path consequences
it had worked out (`AitoTaskUpdate` inheriting from `AitoTaskBase`,
`AitoProjectUpdate` inheriting from `AitoShippingInput`) but never checked
`AitoTaskResponse`, which ALSO inherits `AitoTaskBase` — the one inheritor
of that class that is a READ path, not a write path. This file already
carried the precedent for exactly this hazard, in the comment on
`AitoTaskCreate`'s `max_length` description caps (originally at
`schemas/aito.py:205-208`, before this correction's edits shifted line
numbers below it): those caps were deliberately placed on
`AitoTaskCreate`/`AitoTaskUpdate` rather than on `AitoTaskBase`, specifically
because `AitoTaskResponse` also inherits `AitoTaskBase` and a bound placed
there would make reading back an already-over-the-cap stored row raise
instead of just refusing to write a new one over it. `allow_inf_nan=False`
was placed on `AitoTaskBase` anyway, violating the file's own precedent one
class down.

Concretely: a task row that already stored a non-finite cost — which BASE
accepted and persisted, and which this very entry's own opening paragraph
documents ("A request carrying ... `Infinity` was accepted and persisted
with the row storing `inf`") — made `AitoTaskResponse(**row_fields)` raise
`ValidationError` the moment `_task_to_response`
(`backend/app/api/routes/aito.py:392`) tried to build a response model from
it, turning `GET /api/v1/aito/{id}/tasks` into a 500 for that project instead
of reading the field back as `null`, which is what BASE did and what the
rest of this entry's own reasoning (the "Pydantic v2 then serialises a
non-finite float back out as JSON `null`" sentence, two paragraphs up) says
should still happen. This was never part of the approved change: the
approval quoted verbatim above covers only "a request sending Infinity or
NaN ... will start returning 422" — a write-path guarantee — and says
nothing about reads of rows already on disk.

Fixed by following the file's own precedent exactly: `allow_inf_nan=False`
was removed from the six affected fields on `AitoTaskBase` (`scan_cost`,
`modelisation_cost`, `usinage_cost`, `impression_cost`,
`impression_weight_g`, `impression_discount_pct`) and redeclared on
`AitoTaskCreate` and `AitoTaskUpdate` individually, alongside those classes'
existing `max_length` redeclarations for the same reason. The write path is
unaffected — `AitoTaskCreate` and `AitoTaskUpdate` still reject a non-finite
value exactly as before, and the existing T-001 tests for both still pass
unmodified. `AitoTaskResponse` now constructs from a non-finite stored value
exactly as it did at BASE, and round-trips it out as JSON `null`.

The other seven fields the original entry named were re-audited individually
against this same question — "does any response/read schema inherit the
class this field's constraint sits on?" — rather than assuming the one named
field was the only casualty:

- `modelisation_cost`, `usinage_cost`, `impression_cost`,
  `impression_weight_g` (`AitoTaskBase`): same defect as `impression_cost`
  above (all four are inherited by `AitoTaskResponse`); same fix, moved to
  `AitoTaskCreate`/`AitoTaskUpdate` alongside it.
- `impression_discount_pct` (`AitoTaskBase`): inherited by
  `AitoTaskResponse` the same way, so moved for consistency with the other
  five — but its pre-existing `gt=0, le=100` bounds already reject both
  `inf` (fails `le=100`) and `nan` (fails the same comparison) with no
  `allow_inf_nan` involved at all, verified directly against the
  `refactor-base` tag's schema before and after this fix. Read and write
  paths for this one field are therefore byte-identical to BASE either way;
  moving it closes the structural hole for consistency, not because it was
  ever observably exploitable.
- `shipping_price` (`AitoShippingInput`): inherited only by
  `AitoProjectCreate` and `AitoProjectUpdate`, both write-only schemas.
  `AitoProjectResponse` (`schemas/aito.py:482`) is declared as a standalone
  `BaseModel`, not as a subclass of `AitoShippingInput`, `AitoProjectCreate`
  or anything else that carries the constraint — its own `shipping_price:
  float | None` field is unconstrained, exactly as it was before T-001. Safe
  as originally placed; no read schema is affected.
- `quote_total` (`AitoProjectCreate`): declared directly on
  `AitoProjectCreate`, which nothing else in this module inherits from.
  `AitoProjectResponse`'s own `quote_total: float | None` is likewise a
  separate, unconstrained field. Safe as originally placed; no read schema
  is affected.

New tests in `backend/tests/unit/test_aito_routes.py`:
`test_task_response_still_accepts_infinite_money_fields` (constructs
`AitoTaskResponse` directly with `impression_cost`/etc. `= math.inf` for
each of the five plain-`ge=0` fields, asserts it succeeds and round-trips as
JSON `null`) and `test_task_response_rejects_non_finite_discount_pct_same_as
_base` (pins that `impression_discount_pct` rejects both `inf` and `nan` on
`AitoTaskResponse`, unaffected by either arrangement of the constraint, as
verified against `refactor-base`). Run against the code as originally
committed (`allow_inf_nan=False` still on `AitoTaskBase`), the five
`_infinite_money_fields` cases failed with
`pydantic_core._pydantic_core.ValidationError: ... Input should be a finite
number`, confirming the regression; they pass after the fix. The existing
write-path tests (`test_task_create_rejects_non_finite_money_fields`,
`test_task_update_rejects_non_finite_money_fields`,
`test_task_create_rejects_non_finite_discount_pct`,
`test_shipping_input_rejects_non_finite_price`,
`test_project_update_rejects_non_finite_shipping_price`,
`test_project_create_rejects_non_finite_quote_total`) were re-run unmodified
and still pass — the write-side guarantee this task was approved for is
intact.

`tools/snapshot.py verify` shows 11/11 probes matching after both fixes in
this correction — `allow_inf_nan`'s presence or absence has no JSON Schema
representation (same reasoning as the original T-001 entry above), and
nothing about `AiTextField`'s public shape, props or rendered DOM changed.

## T-002 — 2026-08-19 — user-approved behavior change

`add_task` (`POST /aito/{project_id}/tasks`) resolved its parent project with
a bare `select(AitoProject).where(AitoProject.id == project_id)` — no status
filter — unlike every other project-scoped write in this file, which goes
through `_get_active_project_or_404` (adds `AitoProject.status == "active"`).
`update_task` (`PATCH /aito/tasks/{task_id}`) and `delete_task`
(`DELETE /aito/tasks/{task_id}`) both resolved their task via
`_get_task_or_404`, which filtered on the task's own id alone and never
consulted the parent project's status at all. Confirmed against the app
before this fix: after soft-deleting a project (`DELETE /aito/{id}`, 204,
sets `status = "deleted"`), `POST /{id}/tasks` still returned 201,
`PATCH /tasks/{tid}` still returned 200, and `DELETE /tasks/{tid}` still
returned 204. Each write also calls `_mark_pending_if_ours`
(unconditionally, regardless of status), which requeues the trashed project
for the Zoho sync worker. `list_projects` excludes deleted rows from the
board, so a priced task could be added or a cost changed on a card nobody
can see, and that edit rides onto the live Zoho estimate once the project is
later restored.

Consumer enumeration performed before touching either helper:

- `_get_task_or_404` had exactly two callers in the whole codebase (grepped
  across `backend/`, not just this file): `update_task` (line ~1622) and
  `delete_task` (line ~1701). Both are WRITE endpoints. **No read endpoint
  calls this helper** — `list_tasks` (`GET /{project_id}/tasks`) queries
  `AitoTask` directly by `project_id` with no status join at all, and does
  not go through `_get_task_or_404`. Gating the helper on the parent's
  status therefore only affects the two write endpoints; it cannot touch a
  read path, because none exists among its callers. This was the exact
  "enumerate every consumer" check the campaign's standing rule calls for,
  and it came back negative for a read-path hit — confirmed independently
  with a new regression test (below) that pins the read path still working
  after the fix.
- `_get_active_project_or_404` already had seven callers before this change
  (`send_quote_email`, `reorder_tasks`, and four other project-level write
  routes), all pre-existing and already status-filtered; `add_task` is now
  an eighth, using the same helper rather than duplicating its logic. None
  of the seven existing callers were touched — `add_task` only stopped
  inlining its own weaker check and started calling the shared helper that
  already existed for this exact purpose.

Fix: `add_task` now resolves its parent via `project = await
_get_active_project_or_404(db, project_id)` instead of its own unfiltered
query. `_get_task_or_404` now joins `AitoProject` and filters on
`AitoProject.status == "active"` in addition to the task's own id, so both
`update_task` and `delete_task` 404 when the parent project is not active.
`list_tasks` was not touched.

Observable change, quoting the approved description verbatim: "adding,
editing or deleting a task on a trashed project currently succeeds and would
start returning 404, so any client that edits tasks between a trash and a
restore would break." Confirmed exactly as scoped: `POST /{id}/tasks`,
`PATCH /tasks/{tid}` and `DELETE /tasks/{tid}` against a trashed project's
task now 404; `GET /{id}/tasks` against the same trashed project is
unaffected and still returns 200 with the task list.

New tests in `backend/tests/unit/test_aito_routes.py`:
`test_task_writes_404_once_the_parent_project_is_trashed` (soft-deletes a
project, then asserts `add_task`/`update_task`/`delete_task` all 404) and
`test_task_reads_still_work_on_a_trashed_project` (pins that `list_tasks`
still returns 200 with the task's data on the same trashed project, so a
future change cannot silently gate the read path too). Run against the
code as it stood before this fix (verified via `git apply -R` on this
commit's diff to `backend/app/api/routes/aito.py`, then `git apply` to
restore it — no `git stash` used, per the campaign's shared-stash hazard),
`test_task_writes_404_once_the_parent_project_is_trashed` failed at its
first assertion: `add_task` returned 201 instead of 404
(`assert 201 == 404`). It passes after the fix. The read-path pin test
passes both before and after the fix, as expected — it does not by itself
prove anything about the fix (a test that passes on both sides of a change
proves nothing about that change), but it does prevent a future regression
from gating the read path silently.

`tools/snapshot.py verify` showed 11/11 probes matching both before and
after this change (re-verified independently by reverting/reapplying the
diff the same way as the test proof above). `aito-route-perms` and
`aito-openapi` were checked specifically, per this task's instructions —
neither route's permission decorator, path, method, status code, or request/
response schema changed; only an internal WHERE-clause filter did, which is
invisible to both probes. No probe needed re-recording.
`bash tools/gen_surface_aito.sh` produced a byte-identical `SURFACE.md` — no
route, request/response model, or exported name was added or removed.

### Correction — 2026-08-20, iteration-2 blind verifier run, read-path
### consequence found by a third verification pass

**This correction does not change or revert the fix above; it documents a
consequence of it that the original T-001 entry did not enumerate.**

`AitoTaskCreate` is not only the write-path schema `T-001` was approved to
harden — it is also composed into a response model.
`backend/app/api/routes/zoho.py:291` declares:

    class ZohoQuotePreview(BaseModel):
        tasks: list[AitoTaskCreate]

and `zoho.py:313` serves `GET /api/v1/zoho/estimates/{estimate_id}/preview`
with `response_model=ZohoQuotePreview`. That is a direct use of
`AitoTaskCreate` itself (not `AitoTaskResponse`, which only inherits
`AitoTaskBase`), so the `allow_inf_nan=False` constraints this task added at
`schemas/aito.py:221-228` (`scan_cost`, `modelisation_cost`, `usinage_cost`,
`impression_weight_g`, `impression_cost`, `impression_discount_pct`) now sit
directly on this response path too. BEFORE this task, a non-finite value on
one of those fields serialised out of this endpoint as JSON `null` (200).
AFTER, the same value raises `ResponseValidationError` inside FastAPI while
building the response, and the endpoint 500s instead.

Reachability was checked, not assumed — this is producible from real
estimate data reaching `preview_estimate`, not only by hand-crafting a
request body:

- `_line_amount({'quantity': 1e200, 'rate': 1e200}, inclusive=True,
  precision=2)` returns `inf`.
- `parse_weight_g('9'*310 + ' g')` returns `inf` — the weight regex's `\d+`
  is unbounded, so an absurdly long digit run in a Zoho line description
  overflows a Python `float` on conversion.

Both functions live in `backend/app/services/aito_quote_import.py` and both
feed fields on the `AitoTaskCreate` instances this endpoint builds and
returns.

Severity is LOW, and the record should say so plainly rather than let the
mechanism above read as alarming:

- it needs a magnitude past roughly `1.8e308` arriving from Zoho Books —
  not an operational input for a quantity, rate, or weight field;
- the hazard CLASS is pre-existing, not introduced by this task.
  `AitoTaskCreate` already carried `max_length=10_000` on its four
  `*_description` fields at BASE, and an 11,000-character Zoho line
  description already 500s this same `preview_estimate` endpoint today, on
  unmodified BASE code — `AitoTaskCreate` was already a write schema leaking
  into a response before this task touched it;
- `backend/app/api/routes/zoho.py` is OUT of this campaign's scope, so no
  fix to the response model itself was made or attempted here.

Also worth recording honestly: the T-001 entry above states that the
remaining, unconstrained fields were re-audited against the question "does
any response/read schema INHERIT the class this field's constraint sits
on?" That audit was inheritance-only, checking `AitoTaskResponse`'s
inheritance of `AitoTaskBase`, and by its own framing could not have caught
a schema that is instead composed directly into a response model's field
type, which is what `ZohoQuotePreview.tasks: list[AitoTaskCreate]` does. Two
verification passes over this task saw `ZohoQuotePreview`'s use of
`AitoTaskCreate` and judged it unreachable in practice; a third pass found
the reachability path documented above.

The user was shown this finding and approved it on 2026-08-20, choosing to
record it here rather than change code — consistent with `routes/zoho.py`
being out of this campaign's scope. The proper fix — giving
`ZohoQuotePreview` its own response model instead of reusing
`AitoTaskCreate`, a write schema, on a read path — is left as follow-up
work for whoever owns `backend/app/api/routes/zoho.py`.

## Tooling repair — 2026-08-20 — sanctioned fix to frozen campaign machinery

`tools/` is frozen for the duration of this campaign, but `tools/coverage_aito.sh` — the
campaign's coverage gate — was shown to the user to be silently unable to fail. Both of its
suite invocations pipe through `tail` for output trimming:

```
./venv/bin/python3 -m pytest ... 2>&1 | tail -6  || rc=1
( cd frontend && npx vitest run ... 2>&1 | tail -40 ) || rc=1
```

A pipeline's exit status is its LAST command's, so each `|| rc=1` was reading `tail`'s exit
status — which is (almost) always 0 — never pytest's or vitest's. This has two consequences,
the second worse than the first: (1) the script cannot report a suite failure through its
exit code, so both guards were dead; and (2) a flaky run reports a DEPRESSED coverage number
alongside a success exit, indistinguishable from a real ratchet breach. This actually
happened: a verifier's frontend run read 95.48% with `aitoOptimistic.ts` at 73%, while a
direct re-run of the same code gave the true 96.84%.

The user reviewed this defect and explicitly authorised repairing it — this specific fix, to
this specific script, on 2026-08-20 — as a sanctioned exception to `tools/` being otherwise
off-limits.

The fix: added `set -o pipefail` next to the script's existing `set -u`. Before applying it,
every pipeline in the script was inventoried (there are exactly two — the pytest|tail and
vitest|tail lines above; every other `|` in the file is part of a `||` logical-or, not a
pipe). Both `tail -6` and `tail -40` must read their entire input to know the last N lines,
so neither closes its pipe early the way `head` would — there is no risk of `pipefail`
turning a merely-truncated-early read into a false failure. No other pipeline in the script
(no tolerant grep, no early-closing head) exists that `pipefail` would newly break. No scope
file list, include glob, coverage flag, reporter, or `cov_filter.py` invocation was touched —
only error propagation changed.

Expected consequence, not a bug: with the guards now live, `bash tools/coverage_aito.sh
frontend` will exit non-zero on any run where a documented load-flake fires (PrintModal,
ModelViewerModal, StatsPageUserFilter1894, LoginPage, CalculatorPage — all out of campaign
scope, all pass when re-run alone). The script's own `--coverage.reportOnFailure=true`
comment already exists precisely so a full coverage report is still produced on such a
failing run; a non-zero exit alongside a valid report is the intended shape now, not
something to work around.

## T-004 — 2026-08-20 — user-approved behavior change (correction to an entry omitted at commit time)

**This entry was written after the fact.** Commit `cad0f792c` ("refactor(loop-5): T-003,
T-004, T-009 — bound client_id, strip control chars from the PDF filename, stop a
quote-pair reply blanking a field") shipped T-004 — `_CONTROL_CHARS_RE = re.compile(r"[\x00-
\x1f\x7f]")` in `backend/app/api/routes/aito.py`, stripped from the quote PDF filename
before it reaches `build_content_disposition` in `get_quote_pdf` — with no changelog entry,
on the stated rationale that the guard only "turns an aborted response into a normal one,
not the other way around." A blind verifier in a later iteration FAILED the range on this
item: that rationale is true for only 5 of the 33 characters the regex strips, and false for
the other 28. The mis-reasoning originated in the orchestrator's brief for the task, not in
anything the implementing worker invented; the guard itself is unaffected by any of this and
was already, and remains, correct.

The split, checked against h11's actual header-value grammar (`field_value =
([^\x00\s]+(?:[ \t]+[^\x00\s]+)*)?`, from `h11/_abnf.py`):

- **5 characters are REJECTED by h11**: `\x00`, `\x0a` (LF), `\x0b` (VT), `\x0c` (FF), `\x0d`
  (CR). For these, BASE's response really is aborted outright — h11 refuses to send a header
  value containing them — and the fix genuinely turns a broken response into a working one.
  There is no observable change here anyone could depend on.
- **28 characters are ACCEPTED by h11**: `\x01`–`\x08`, `\x09` (TAB), `\x0e`–`\x1f`
  (including `\x1b` ESC), and `\x7f` (DEL). For these, BASE returns a normal `200` and the
  fix changes that working response's header content. Demonstrated directly with
  `quote_number = "AB\x07CD"`:
  - BASE: `200`, `Content-Disposition: inline; filename="AB\x07CD.pdf";
    filename*=UTF-8''AB%07CD.pdf`
  - HEAD: `200`, `Content-Disposition: inline; filename="ABCD.pdf";
    filename*=UTF-8''ABCD.pdf`

  Reachable in production: `quote_number` is `Field(default=None, max_length=50)` with no
  pattern (`schemas/aito.py`), and `AitoProjectCreate(quote_number="AB\x01CD")` validates
  without error — nothing upstream of `get_quote_pdf` rejects or sanitizes this value first.

So T-004 is an observable behavior change for 28 of the 33 stripped characters, not merely a
fix for an already-broken response, and it needed an entry in this file from the start.

The user was shown this 5-vs-28 split, together with the `AB\x07CD` before/after evidence
above, on 2026-08-20, and approved keeping the full `[\x00-\x1f\x7f]` strip as originally
shipped — choosing to document the change here rather than narrow the regex to just the
5 h11-rejects-outright characters. The regex itself, `_CONTROL_CHARS_RE`, is unchanged from
commit `cad0f792c` and no test was added or altered; the existing
`test_quote_pdf_strips_control_characters_from_the_filename`
(`backend/tests/unit/test_aito_routes.py`) already pins all four of `\x00`, `\x07`, `\x1b`,
and `\x7f` being stripped, spanning both halves of the split.

Why the full strip is correct regardless of the split: a control character has no legitimate
place in a downloaded filename. TAB and DEL both corrupt the name a browser ends up saving
the file under; ESC (`\x1b`) can drive terminal escape sequences in any context where the
filename is later echoed to a terminal (e.g. a shell script or log viewer that prints
`Content-Disposition` verbatim). Stripping only the 5 that h11 rejects outright and leaving
the other 28 in place would still hand a client-controlled control character straight into a
filename a browser writes to disk, for no benefit beyond a paper-thin "BASE technically
returned a 200" argument.

Out of scope, unfixed, left as a known follow-up: `backend/app/utils/http.py`'s
`build_content_disposition` — the shared helper used across roughly eight call sites — has
the same gap (it strips only non-ASCII, quotes, and backslashes, never C0/DEL) and is not
touched by this fix. `get_quote_pdf` is the only call site patched. The shared helper is the
better long-term home for this guard, since fixing it there would close the gap for every
caller at once instead of one call site at a time; that consolidation was not undertaken here
because `backend/app/utils/http.py` was out of this task's scope.

## T-009 — 2026-08-20 — user-approved behavior change (approval given RETROACTIVELY)

**This entry was written after the fact.** Commit `cad0f792c` ("refactor(loop-5): T-003,
T-004, T-009 — bound client_id, strip control chars from the PDF filename, stop a
quote-pair reply blanking a field") shipped T-009's fix to `proofread_text`
(`backend/app/services/openrouter.py`) with no changelog entry, on the stated rationale
that it "restores a documented contract" — the function's own docstring already promised
"never returns \"\"". Iteration 5's blind verifier FAILED the range on this item: the
docstring promise is true, but the endpoint's 200 response body still moved for a real,
reachable class of upstream replies, and that is what needed an entry regardless of whether
the change also happens to be a bug fix. The user was shown the finding and approved the
change as shipped, on 2026-08-20.

`_unquote(corrected, source)` strips one layer of quote punctuation the model wrapped its
answer in, but does not special-case a reply that IS the quote pair with nothing inside it —
`corrected[1:-1].strip()` on a 2-character input returns `""`. BASE:

    return _unquote(corrected, source), PROOFREAD_MODEL

HEAD:

    unquoted = _unquote(corrected, source)
    ...
    return unquoted or source, PROOFREAD_MODEL

Measured against the shipped `_unquote` with `source = 'capot avec 3 pieces'`, five reply
shapes that are each exactly a quote pair:

    reply '""'   -> BASE returns ''  | HEAD returns 'capot avec 3 pieces'
    reply '«»'   -> BASE returns ''  | HEAD returns 'capot avec 3 pieces'
    reply '« »'  -> BASE returns ''  | HEAD returns 'capot avec 3 pieces'
    reply '“”'   -> BASE returns ''  | HEAD returns 'capot avec 3 pieces'
    reply "''"   -> BASE returns ''  | HEAD returns 'capot avec 3 pieces'

So `POST /api/v1/aito/proofread` answered `200 {"text": ""}` at BASE for any of these five
reply shapes, and answers `200 {"text": "<the operator's own text>"}` at HEAD — the
endpoint's OUTPUT genuinely moved, not just an internal implementation detail. `_chat`'s
empty-answer guard does not intercept this: the raw model reply is two non-empty characters,
and the emptiness is produced afterward, by `_unquote`'s own stripping. `AitoProofreadResponse
.text` carries no `min_length`, so the schema layer does not stop `""` from serialising out
either.

Why this was reachable and why it mattered: `AiTextField.onSuccess` applies `data.text` via
`onChange` whenever the response differs from what the field last sent — its ONLY skip
condition is `data.text === sent`, an exact-string equality guard, not an emptiness check. A
`""` response therefore always fails that equality (the operator's text is never itself
empty — the request schema rejects a blank field before this endpoint is even called) and
gets applied, wiping the task title or description the operator had just typed on blur —
text that is printed on the client's quote — for no reason evident to the operator, since a
proofread call is not something they see complete.

Why `source` (returning the operator's own text unchanged) was chosen, over two rejected
alternatives:
- Returning the quote-pair string verbatim (e.g. `'""'` or `'« »'`) would put
  punctuation-only garbage directly into the field.
- Raising `OpenRouterUpstreamError` would mislabel this: the model DID answer — a
  degenerate one — so treating it as an upstream failure conflates a local post-processing
  artifact (`_unquote` stripping a pair down to nothing) with an actual upstream problem, and
  would add a spurious 502 the caller's existing silent-no-op handling for that error class
  was never designed to absorb quietly for this cause.
- `source` was chosen specifically because it makes `AiTextField.onSuccess`'s existing
  `data.text === sent` equality guard fire and skip `onChange` entirely — the field does not
  even flicker, and the observable result is indistinguishable from "nothing needed
  correcting", which is the true semantic content of a quote-pair-only reply.

**This is the third instance, in this campaign, of an entry omitted at commit time on the
same mis-reasoning** — "it's a bug fix restoring a documented contract, so it doesn't need an
entry" — after T-005 (2026-08-19, `AiTextField` unmount guard) and T-004 (2026-08-20, PDF
filename control-character strip). All three times a blind verifier proved the change also
moved observable output, and none of the three fixes has been reverted or altered — the
reasoning was always wrong about whether an entry was needed, never about whether the fix
itself was correct. The mis-reasoning originated in the orchestrator's brief each time, not
with the worker implementing the fix; it is recorded here, a third time, because the
repetition itself is the useful part of this record, not any one instance of it.

Also worth recording for consistency: this change sits in the same function as, and is
adjacent to, T-006 (2026-08-19, above) — another degenerate-reply case in `proofread_text`,
where a truncated (`finish_reason == "length"`) completion is turned into a raised
`OpenRouterUpstreamError` instead of a silently-applied partial correction. T-006 was
recorded as a user-approved behavior change at commit time, without needing a blind verifier
to catch the omission. That T-009's own entry only exists now, after the same kind of
after-the-fact correction as T-005 and T-004, is itself part of what this entry is
documenting — the same file, the same function, two adjacent degenerate-reply fixes, treated
inconsistently at commit time for no principled reason.

No code, comment, or test changed as part of writing this entry. `_unquote` and
`proofread_text` are unchanged from commit `cad0f792c`. `tools/snapshot.py verify` is
unaffected — none of the 11 probes touch `openrouter.py`'s runtime behavior or
`AitoProofreadResponse`'s schema (`min_length` was not added).

## ActivityRail note-rollback depth — 2026-08-20 — user-approved behavior change (approval given RETROACTIVELY)

*(Note on ids: this campaign's task ids restart every few iterations and collide across
dates — there is already an unrelated `## T-007 — 2026-08-12` entry above, about a Zoho
shipping-rate locale bug. This entry is titled by component and dated, not by id, so the two
are never confused; the underlying task was also labelled T-007, in loop-2.)*

**This entry was written after the fact.** Commit `0684e98d9` ("refactor(loop-2): T-002,
T-007, T-008 — trashed-project task writes, note rollback depth, PDF blob leak
(user-approved behavior change)") shipped T-007 — `frontend/src/components/aito/history/
ActivityRail.tsx`'s `addNote` mutation now carries `depth` in its variables and keys both
`onMutate` and `onError` on that captured value, instead of on the component's current
`depth` state — with no changelog entry, on the commit's own stated rationale: "T-007 and
T-008 are contract-neutral bug fixes and carry no entry by design." The commit's subject
line carries "(user-approved behavior change)", but that marker covered only T-002 of the
commit's three items; T-007 and T-008 were explicitly called out in the same commit body as
needing none. The marker overstated what had actually been approved.

Why BASE was wrong: `onMutate` and `onError` both closed over the component's `depth` state
directly, keying the optimistic-note cache write and its rollback on `['aito-events',
projectId, depth]` read at whatever moment each callback happened to run — not on the depth
that was current when the mutation was fired. TanStack Query refreshes a PENDING mutation's
options on every re-render of the component that owns it — confirmed in `node_modules/
@tanstack/query-core@5.90.20/build/modern/mutationObserver.js`: `else if
(this.#currentMutation?.state.status === "pending") this.#currentMutation.setOptions
(this.options)`. So if the operator moved the depth control while a note `POST` was still in
flight, and that POST then failed, `onError` ran with the NEW `depth` closed over by the
freshly-rebuilt options — filtering the placeholder out of the cache entry for the depth the
control had moved TO, a cache entry that never held it — while the optimistic row the
mutation had actually written, under the OLD depth's cache entry, was never touched.

The user-visible consequence: the operator gets the "note failed" toast and their typed text
back, so nothing looks wrong in the moment — but switching the rail back to the depth it was
on when they hit send still shows the failed note sitting in the timeline as though it were
real, with a negative placeholder id, until something unrelated invalidates that query. In a
feature whose whole purpose is an accountability timeline — what happened, and when — a note
the server REJECTED remaining visible as though it were accepted is exactly the wrong kind of
wrong.

Fixed by capturing `depth` in the mutation's variables at `mutate()`-time (passed alongside
the existing `body` and `optimistic` fields) and reading `mutationDepth` off those variables
in both `onMutate` and `onError`, instead of reading the component's live `depth` state in
either. Both callbacks now key the same cache entry regardless of what the depth control does
while the request is in flight.

Empirical proof the output moves, performed by the blind verifier that caught this: it
staged `refactor-base`'s `frontend/` into a scratch tree, dropped in HEAD's
`AitoActivityRail.test.tsx` unmodified, and ran it — the test FAILS against BASE at line 247,
`expected false, received true`, with the failed note still present in `['aito-events', 12,
'detail']`.

This is the FOURTH change in this campaign shipped without an entry on the reasoning that a
bug fix restoring intended behavior is not an observable change — after T-005 (2026-08-19,
`AiTextField` unmount guard), T-004 (2026-08-20, PDF filename control-character strip), and
T-009 (2026-08-20, proofread quote-pair reply). It is also the first of the four that TWO
verification passes actively CLEARED before a third caught it: commit `0684e98d9` sits in
`loop-2`, an iteration that had already PASSED verification twice, with the iteration-5
verifier examining T-007 specifically and judging it "contract-neutral… repair of a broken
state, not movement of a valid output," before iteration-6's verifier FAILED the range on
this same item. That judgement was wrong, and how it was overturned is worth recording in
its own right: after the third failure, a mechanical test replaced the judgement call — does
any input produce a different response body, status, rendered text, or persisted value than
at BASE? For this change the answer is unambiguously yes, and the rule caught what two
rounds of reasoning had waved through.

The user was shown this finding — the mechanism, the reproduction, and the two-pass miss —
and approved the change as shipped on 2026-08-20. No code, comment, or test changed as part
of writing this entry; `ActivityRail.tsx` is unchanged from commit `0684e98d9`.
`tools/snapshot.py verify` is unaffected by this entry (documentation only).

## T-071 — 2026-08-21 — user-approved behavior change

T-071: `cost_per_kg`, `purchase_price`, `power_watts`, `electricity_tariff`, `labor_rate_per_hour`,
`consumables_packaging_flat` and `base_fee_flat` no longer accept `Infinity`/`-Infinity`/`NaN` or an
absurd finite magnitude (new `le=1e8` ceiling) on create/update. Before this fix, `float('inf')`
satisfied every `gt=0` bound in `backend/app/schemas/calculator.py` (`inf > 0` is `True`), so a POST
with a non-finite `cost_per_kg` returned 200, stored `inf` in the row, and every later `GET` silently
serialized that field back as JSON `null` — computePricing then multiplied by `null`, so the filament
line of a quote silently priced at 0 with no error anywhere, and the poisoned row could not be
repaired through the UI (the edit form's Save stayed disabled because `String(inf)` round-trips as
`"null"`). An equivalent finite-overflow path existed too: `derive_sale_price(1e308, 1000)` overflows
to `inf` downstream even though `1e308 > 0` is a valid `gt=0` input, hence the new upper bound rather
than relying on non-finite rejection alone. A second write path had the same hole: the Zoho price sync
(`routes/calculator.py`) computed `new_cost = dealer_price / weight` and guarded only `new_cost <= 0`
— `inf <= 0` is `False`, so a sub-denormal spool weight parsed from a Zoho item name could divide a
normal dealer price into `inf` and have it written, uncaught by that guard. Fixed by adding
`math.isfinite(new_cost)` to that guard as well.

The `allow_inf_nan=False`/`le=` ceiling was added to `CalculatorFilamentCreate` and
`CalculatorPrinterCreate` (not to `CalculatorFilamentBase`/`CalculatorPrinterBase`, which the
task briefing suggested): those Base classes are also the parent of the Response schemas, and
tightening them there would have changed a SECOND, unapproved thing — a pre-existing
out-of-range row already in the database would 500 on every `GET` instead of rendering the
`null` it does today. Verified empirically both ways (`CalculatorFilamentResponse.model_validate`
on a fake row with `cost_per_kg=inf` succeeds unchanged before and after this fix). Only the
write-side schemas carry the new constraint, so existing rows keep reading exactly as before;
only new writes of a non-finite or overflow value are rejected.

A second, unplanned fix was required in `backend/app/main.py` to actually deliver the promised
422: FastAPI's default `RequestValidationError` handler echoes the rejected value back in
`errors()[i]["input"]`, and Starlette's `JSONResponse` renders with `allow_nan=False` — so a
request that fails validation *because* its value is non-finite makes that very serialization
step raise, turning the intended 422 into an unhandled exception (observed as a 503 from this
app's auth-gateway middleware, which fails closed on any exception raised while auth is
disabled). This is a **pre-existing** bug, not something this task introduced — confirmed by
posting `margin_pct: Infinity` against the unmodified `le=1000` bound that predates T-071 and
getting the identical 503 crash. Since the task's own approved statement promised "422", and
without this fix the actual result was a 503 (a materially worse regression than the original
200+null bug — the whole endpoint breaks, not just one field), a narrow `RequestValidationError`
handler was added that is byte-identical to FastAPI's default for every other validation error
and differs only by setting `allow_nan=True`, which is what makes the crashing case render
instead of raising. This is a shared-file touch outside the task's stated file list
(`backend/app/schemas/calculator.py`, `backend/app/api/routes/calculator.py`); it was necessary
to make the approved change actually behave as promised rather than a strict scope violation.

Mutation-tested: reverting the `le`/`allow_inf_nan` additions on `CalculatorFilamentCreate` and
`CalculatorPrinterCreate` made `test_create_rejects_infinite_cost`,
`test_create_rejects_cost_above_ceiling`, `test_create_rejects_infinite_purchase_price` and
`test_create_rejects_purchase_price_above_ceiling` fail as expected; reverting the
`math.isfinite(new_cost)` guard in the Zoho sync route made
`test_overflowing_result_is_skipped_not_written_as_inf` fail as expected; reverting the new
`RequestValidationError` handler in `main.py` made every non-finite-input test in
`test_calculator_routes.py` fail with 503 instead of 422, as expected.

user-approved 2026-08-21: "An API client that posts a non-finite number for a calculator money
field currently gets 200 and a null back; it would start getting 422."

## T-068 — 2026-08-22 — user-approved behavior change

T-068: `GET /calculator/zoho-filaments` now requires `calculator:update` instead of `calculator:read` — its response carries Zoho's confidential dealer-side pricing (dealer_price, cost_per_kg, sku, spool_weight_kg) and its only caller (ZohoFilamentSearch, rendered only inside the update-gated FilamentForm) already needs `calculator:update`. This matches every other Zoho item/contact/estimate route, which requires a write permission (AITO_CREATE) rather than a read one. user-approved 2026-08-22: "an API client or user holding only calculator:read (the default Viewers role) would start getting 403 from GET /api/v1/calculator/zoho-filaments instead of the Zoho product list."

## T-072, T-073 — 2026-08-22 — T-073 is a user-approved behavior change

T-072: `reset_cache()` did not cancel or invalidate a `fetch_catalogue` refresh that was
already in flight when it ran, so a Zoho credential rotation landing mid-fetch let the
pre-rotation catalogue publish into the module cache right after the reset and serve every
caller (the add-filament search, the price sync) for a full 10-minute `_CACHE_TTL` window
under the NEW credentials. Fixed with a module-level generation counter (`_generation`)
bumped by `reset_cache()`: `fetch_catalogue` now captures the generation only after it holds
the (also `reset_cache()`-rebuilt) `_refresh_lock` and re-checks freshness inside it, and only
publishes into `_cache`/`_cache_at` if that generation still matches when the Zoho walk
finishes — a superseded refresh still resolves for its own caller but is never written into
the shared cache. The `asyncio.Lock` additionally collapses concurrent refreshes (e.g. two
browser tabs opening the add-filament search on a cold cache) into a single Zoho walk; it is
rebuilt (not reused) by `reset_cache()` specifically so a lock that happened to block on one
asyncio event loop is never awaited from a different one later, which is what pytest-asyncio's
per-test event loops would otherwise risk. No externally visible behavior changes for T-072:
the function's signature, its return values, and every existing success/failure path are
unchanged — only the internal publish-vs-discard decision after a race is different, and that
race previously mis-published.

T-073: the paged fetch inside `fetch_catalogue` fell out of its `while page <= _MAX_PAGES` loop
silently when the page bound was hit with Zoho's `has_more` still `True`, and the partial item
list gathered so far was cached as a complete catalogue for the full TTL — with no log, flag,
or error. Every calculator filament linked to an item past page 20 would then be reported as
"missing" (the schema's documented meaning is "Linked item no longer in the Zoho catalogue" —
a wrong diagnosis inviting an operator to unlink good rows) and the add-filament search would
simply never find those products. Fixed by detecting the page-bound exit (via the `while`
loop's `else` clause, which only runs when the loop is *not* exited via `break`), logging an
`ERROR` naming `_MAX_PAGES` and the total item count fetched, and raising instead of falling
through to caching — routing the truncation through the exact same stale-cache-or-raise
handling an ordinary Zoho fetch failure already uses. This is a **behavior change**: if a usable
cached catalogue exists it is still served (the stale-cache branch, unchanged for callers); only
with no usable cache does `fetch_catalogue` now raise, which `GET /calculator/zoho-filaments`
and `POST /calculator/filaments/zoho-sync` already turn into a 502 for any other refresh
failure. Before this fix, hitting `_MAX_PAGES` returned 200 with a silently truncated catalogue
instead. user-approved 2026-08-22: "If the catalogue ever exceeds 20 pages, the filament search
and price sync would start returning 502 instead of quietly operating on the first 4000 items."

`fetch_catalogue`'s public signature (`async def fetch_catalogue(db, *, refresh: bool = True) ->
list[FilamentProduct]`) is unchanged; `SURFACE.md` was regenerated and is byte-identical to the
committed copy.

Mutation-tested: reverting the `generation == _generation` publish guard back to an
unconditional publish made `test_reset_cache_during_inflight_fetch_does_not_publish_stale_catalogue`
fail as expected (the pre-rotation catalogue landed in `_cache`). Reverting the truncation
`else`-clause guard (restoring the old loop with no `else` branch) made both
`test_truncated_fetch_is_not_cached_and_raises_with_cold_cache` and
`test_truncated_fetch_serves_the_stale_cache_when_warm` fail as expected (no `RuntimeError` was
raised, and the partial 1-item list overwrote the 4-item warm cache instead of being discarded
in favor of it).

## T-074 — 2026-08-22 — user-approved behavior change

T-074: `search_zoho_filaments` (`GET /calculator/zoho-filaments`) and
`sync_calculator_filaments_from_zoho` (`POST /calculator/filaments/zoho-sync`) each caught
every exception `fetch_catalogue` could raise — a genuinely unreachable Zoho, T-073's
truncation-at-`_MAX_PAGES` guard, and `fetch_catalogue`'s own "None of the N active Zoho
filament items could be mapped" mapping-failure guard (plus any stray `TypeError`/`AttributeError`
from `_map_item`) — in one `except Exception` block, logged a one-line `logger.warning(...)`
with no `exc_info`, and always raised `HTTPException(502, "Could not reach Zoho")`. A mapping or
programming bug inside the catalogue service was therefore indistinguishable, both to the
caller and in the logs, from Zoho's network genuinely being down, and the log carried no stack
trace to tell them apart after the fact.

Fixed by giving `backend/app/services/zoho_filaments.py` a dedicated
`ZohoFilamentMappingError(RuntimeError)`, raised only by the "every active item failed to map"
guard; the truncation guard (T-073) continues to raise a plain `RuntimeError`, unchanged. Both
routes now catch `ZohoFilamentMappingError` first — logging at `ERROR` with `exc_info=True` and
raising `HTTPException(500, "Zoho filament catalogue could not be mapped")` — before falling
through to the existing `except Exception` branch, which now also logs with `exc_info=True` but
keeps its `HTTPException(502, "Could not reach Zoho")` detail string unchanged for every other
failure, including T-073's truncation `RuntimeError`. This is a **behavior change**: a mapping
failure inside the catalogue service now returns 500 with a different detail instead of the
previous 502 "Could not reach Zoho". user-approved 2026-08-22: "A mapping failure inside the
catalogue service would return 500 with a different detail instead of the current 502 'Could not
reach Zoho'."

`SURFACE.md` moved: `ZohoFilamentMappingError(RuntimeError)` is a new public class in
`backend/app/services/zoho_filaments.py`, picked up by `gen_surface_calc.sh`'s
`^(def|class|async def) [a-zA-Z]` grep over that file's "Calculator backend callables" section.
Regenerated and committed alongside this entry.

Mutation-tested: reverting the `except zoho_filaments.ZohoFilamentMappingError` branch in both
routes (folding mapping failures back into the generic `except Exception` 502 branch) made
`test_mapping_failure_is_reported_as_internal_server_error` and
`test_sync_mapping_failure_returns_500_not_bad_gateway` fail as expected (502 instead of 500) —
`test_truncated_catalogue_is_still_reported_as_bad_gateway_not_internal_error` and its sync
counterpart still passed, confirming the truncation path was untouched by the revert. Reverting
`exc_info=True` on all four `logger.warning`/`logger.error` calls made
`test_upstream_failure_logs_a_stack_trace`, `test_mapping_failure_is_reported_as_internal_server_error`,
`test_sync_upstream_failure_returns_502_and_logs_a_stack_trace` and
`test_sync_mapping_failure_returns_500_not_bad_gateway` all fail as expected (`record.exc_info`
was `None`). Both mutations were reverted afterward and the full suite re-verified green.

## T-075 (calculator) — 2026-08-22 — user-approved behavior change

Fix-up to the T-075 Zoho price-sync fix (`frontend/src/components/CalculatorSettingsPanels.tsx`),
after independent verification found the first attempt shipped a third, unapproved user-visible
change alongside the approved one.

The reported bug: `CalculatorFilamentsPanel`'s `runSync` chunk walk had no `AbortController` and
its guard/progress lived in local `useState`, so `CalculatorPage` unmounting the panel on a tab
switch (or any remount) discarded the guard while the walk itself kept running and kept issuing
chunk POSTs. An operator could tab away and back mid-walk, see an idle "Sync Zoho prices" button
with no progress, and click it again — starting a second overlapping walk over the same rows.

The first attempt fixed that, but did so by moving the walk's *entire* state — in-flight guard,
live progress, the completed summary, and any error — into the app-lifetime `QueryClient` cache
(`gcTime`/`staleTime: Infinity`). That over-fixed it: a completed summary or a failed walk's error
text then persisted across tab switches **and** page navigation for the rest of the page session,
with no dismissal path, and a chunk request that never settled (no timeout, no abort) left the
button disabled for the same unbounded window. The user was shown all three effects and decided:
keep the guard/progress survival (the reported bug), narrow the summary/error persistence back to
the pre-fix (BASE) behavior, and add a per-chunk timeout so a stalled request cannot wedge the
button.

This fix-up:
- Keeps only the in-flight guard and live `{ done, total }` progress in the shared `QueryClient`
  cache (`ZOHO_SYNC_PROGRESS_KEY`), unchanged from the first attempt: a remount mid-walk still
  shows live progress and still refuses to start a second walk (the actually-reported bug stays
  fixed).
- **Narrows the completed summary and any sync error back to ordinary component `useState`**,
  exactly as the panel had them before T-075 shipped. Because `runSync`'s closure belongs to the
  mount that started it, a walk that ends while its panel is unmounted has nothing to write into a
  now-defunct closure's setters, so the panel's summary/error simply cannot outlive the mount that
  is watching them — restoring the invariant "unmount after the walk ends ⇒ next mount shows no
  summary and no error" without any special-casing. Direct, user-approved consequence, quoted from
  the brief: "an error that occurs while the panel is unmounted is again not shown on return."
- Adds a **60-second per-chunk timeout** (`SYNC_CHUNK_TIMEOUT_MS`, via a small `withTimeout`
  helper that races the chunk request against a `setTimeout` and never touches or aborts the
  underlying request itself): a chunk that never settles now ends the walk with the same
  `catch`/`finally` path as any other sync failure — a normal "Sync stopped: sync request timed
  out" error and a released guard — instead of leaving the button disabled for the rest of the
  page session. 60 s was chosen against the backend's own budget: `zoho.py`'s
  `httpx.AsyncClient(timeout=10.0)` bounds each individual Zoho HTTP call, and a chunk only
  triggers more than one of those when the 10-minute filament-catalogue cache
  (`zoho_filaments.py`, `_CACHE_TTL`) is cold, in which case `fetch_catalogue` pages the catalogue
  in up to `_MAX_PAGES` (20) page fetches — a real but rare worst case of several tens of seconds.
  60 s comfortably covers that case (and any ordinary slow network) without being so tight that a
  slow-but-healthy sync is misreported as hung. Unmount never aborts the walk — it is only ever
  ended early by this timeout (or by a genuine request failure/success), so every remaining chunk
  still gets written even if the panel that started the sync is long gone, exactly as before this
  fix-up.
- This is itself a **user-approved behavior change**: quoting the brief, "a Zoho price sync whose
  chunk request never settles now ends with a sync error and re-enables the button, instead of
  leaving it disabled for the page session."

No `SURFACE.md` change: `withTimeout` and `SYNC_CHUNK_PROGRESS_KEY`/`ZOHO_SYNC_PROGRESS_KEY` are
module-scope but not exported; the file's only exports (`CalculatorFilamentsPanel`,
`CalculatorPrintersPanel`, `CalculatorDefaultsPanel`, `MARGIN_STEPS`) are unchanged.

Tests: updated `CalculatorSettingsPanels.test.tsx`'s "keeps the guard and progress alive across an
unmount/remount..." test — its guard/progress/second-click assertions are unchanged, but its final
step no longer expects the completed summary to reappear on the remounted panel once the
background-continuing walk finishes (that expectation belonged to the reverted design; the
narrowed design cannot and should not route a finished walk's summary into a different mount's
state). Replaced "surfaces a sync error after a remount even though it failed while the panel was
unmounted" (which asserted exactly the unapproved persistence) with "does not surface a sync error
that happened while the panel was unmounted (narrowed to BASE semantics)", asserting positive
evidence of a clean remount (`Sync prices` present and enabled) before asserting the error text is
absent. Added "does not show a completed sync summary after an unmount/remount" (the same
narrowing for the success path) and "ends a chunk request that never settles with a sync error and
re-enables the button" (the new timeout, driven entirely by vitest fake timers — `vi.useFakeTimers
({ shouldAdvanceTime: true })` plus `vi.advanceTimersByTimeAsync`, never `msw`'s `delay()` or a
wall-clock sleep). No test was deleted.

Mutation-tested: reverting the narrowing (moving `syncSummary`/`syncError` back into a
session-scoped store instead of component `useState`) made "does not show a completed sync summary
after an unmount/remount" fail as expected (`expected <p>...9 updated...</p> to be null`, i.e. the
stale summary reappeared). Reverting the timeout (calling
`api.syncCalculatorFilamentsFromZoho` directly instead of through `withTimeout`) made "ends a chunk
request that never settles with a sync error and re-enables the button" fail as expected (the
`findByText(/sync stopped/i)` wait timed out — the walk never ended). Both mutations were reverted
afterward; `CalculatorSettingsPanels.test.tsx` re-verified at 51/51 passing, 3 consecutive clean
runs.

Frontend: `npx tsc -b --noEmit` clean, `npx eslint .` clean. `tools/coverage_calc.sh frontend`:
statements 90.69% (985/1086), at/above the 90.58% (972/1073) ratchet (two unrelated documented
load flakes, `PrintModal.test.tsx` and `StatsPageUserFilter1894.test.tsx`, both re-verified passing
alone). `tools/snapshot.py verify`: 10/10, nothing moved.

## T-094, T-101 — 2026-08-22 — T-094 is a user-approved behavior change

T-094: `fetch_catalogue`'s `_refresh_lock` (T-072) wrapped the entire paged Zoho walk with no
acquisition timeout. Each page goes through `zoho.py::_send`'s `httpx.AsyncClient(timeout=10.0)`
with one 401-retry, so the critical section was bounded only at roughly `_MAX_PAGES(20) x 2 x 10s
~= 400s` — far longer than the frontend's 60s per-chunk timeout budget. A second caller arriving
during a cold-cache refresh queued behind the whole walk with no way out, pinning its
`Depends(get_db)` pool connection for the wait. The failure path also recorded nothing on a
cold-cache failure, so a burst of concurrent callers each repeated the full walk in turn instead
of learning from the first one's failure — measured by the auditor as 4 concurrent cold requests
producing 4 separate upstream walks.

Fixed with the two auditor/user-approved halves:
- **Bounded lock acquisition**: `asyncio.wait_for(lock.acquire(), timeout=_LOCK_ACQUIRE_TIMEOUT)`
  (20.0s), `lock` captured once up front (not re-read from the module global at release time, so a
  `reset_cache()` landing mid-wait — which rebinds `_refresh_lock` to a new `Lock()`, T-072/T-095 —
  can never make the release target the wrong lock). On `asyncio.TimeoutError`, the stale cache is
  returned if one exists, otherwise a plain `RuntimeError` is raised (the route's existing generic
  `except Exception` branch turns this into a 502, matching T-073's contract for "Zoho isn't
  answering"). 20s was chosen well under the 60s client budget (so the route still answers before
  the client gives up) while staying roughly 2x a single (possibly 401-retried) page fetch, so a
  healthy walk of a page or two is not punished by an early bail-out — and nowhere near the ~400s
  pathological worst case, so waiters no longer pile up behind it.
- **Negative caching**: a cold-cache failure (no `_cache` to fall back to) records `_fail_at` +
  the failing exception (`_fail_exc`); the next call checks this *before* touching the lock at all
  and, if still within `_FAIL_COOLDOWN` (30s), re-raises a fresh instance of the *same exception
  class* immediately — no Zoho walk, no lock contention. The class is reconstructed
  (`type(_fail_exc)(str(_fail_exc))`) rather than reusing the stored instance, so a persistent
  all-malformed batch (`ZohoFilamentMappingError`, 500) is never silently downgraded to "Zoho is
  unreachable" (502) by the fast path, and vice versa. 30s is deliberately longer than the 20s
  lock-acquire timeout (so a caller that just timed out waiting for the lock and retries lands on
  this fast path instead of starting its own walk) but far shorter than the 10-minute `_CACHE_TTL`
  (a real recovery is only masked for seconds, not minutes). `reset_cache()` also clears
  `_fail_at`/`_fail_exc` (a credential rotation must not keep answering "Zoho is down" under the
  new, presumably-working credentials) — this does **not** touch the `_refresh_lock` rebind line
  itself, which stays exactly as T-072 left it (T-095's territory).
- The walk itself was deliberately left unbounded: bounding it would change what the *leader*
  request gets back (turning a slow-but-eventually-successful walk into a failure), which is a
  materially different, larger behavior change than the approved statement ("a second caller...
  would get a fast 502/503 ... instead of waiting") calls for. The lock-acquisition timeout already
  protects every other waiter; only the single in-flight leader can still run the full worst-case
  duration, same as before this fix.

user-approved 2026-08-22: "a second caller arriving during a cold-cache refresh would get a fast
502/503 (or a stale catalogue) instead of waiting for the in-flight Zoho walk to finish."

`SURFACE.md` moved: two new module-level constants, `_FAIL_COOLDOWN` and `_LOCK_ACQUIRE_TIMEOUT`,
in `backend/app/services/zoho_filaments.py`, picked up by `gen_surface_calc.sh`'s
`^_?[A-Z][A-Z0-9_]+ =` grep over that file's "Calculator backend module constants" section. No
new module-level `def`/`class` was added (the pre-lock negative-cache check and lock handling were
written inline rather than as new helpers), so the "Calculator backend callables" section is
unchanged. Regenerated and committed alongside this entry.

T-101: mutation-proven by the auditor that changing `raise ZohoFilamentMappingError(...)` (the
"every active item failed to map" guard) to `raise RuntimeError(...)` left the full suite green —
`test_zoho_filaments_catalogue.py`'s `test_entirely_malformed_batch_with_cold_cache_raises` only
asserted `pytest.raises(RuntimeError)` (the parent class, satisfied by any subclass or the plain
class alike), and both route-level mapping-failure tests (`test_calculator_zoho_routes.py`,
`test_calculator_zoho_sync.py`) monkeypatched `zoho_filaments.fetch_catalogue` itself to raise
`ZohoFilamentMappingError`, bypassing the service's own mapping-failure branch entirely. So T-074's
approved "all items fail to map => 500" contract was pinned only by two halves that shared an
unproven assumption: that the real service actually raises that specific subclass.

Fixed by tightening `test_entirely_malformed_batch_with_cold_cache_raises`'s assertion to
`pytest.raises(zoho_filaments.ZohoFilamentMappingError)`, and adding
`test_mapping_failure_from_the_real_service_is_reported_as_internal_server_error` to
`test_calculator_zoho_routes.py`, which stubs only `zoho_service.list_items_page` (an
all-malformed batch) — never `fetch_catalogue` itself — so it proves the real service raising the
subclass is what actually drives the route's 500 branch. The auditor's other referenced line
(`test_zoho_filaments_catalogue.py`'s `test_failed_refresh_with_cold_cache_raises`) was
deliberately left untouched: its `boom()` raises a plain `RuntimeError` simulating an unreachable
Zoho, an entirely different failure mode (T-073/T-074's 502 contract) — tightening that assertion
to the mapping subclass would have made the test permanently fail and would have been factually
wrong, not a real gap.

The critical regression guard for T-094 touching this same function: the pre-existing
`test_truncated_catalogue_is_still_reported_as_bad_gateway_not_internal_error` (already stubbing
`list_items_page` through the real `fetch_catalogue`, not `fetch_catalogue` itself) continues to
pin the *other* direction — a catalogue truncated at `_MAX_PAGES` must still raise a plain
`RuntimeError` (502), never `ZohoFilamentMappingError` (500) — and was re-verified against both new
T-094 code paths (the bounded lock and the negative cache) to confirm neither accidentally routes
the truncation raise through the mapping-error subclass.

Mutation-tested: mutating the mapping-failure raise site to plain `RuntimeError` made
`test_entirely_malformed_batch_with_cold_cache_raises`,
`test_negative_cache_preserves_the_mapping_failure_exception_type`, and the new
`test_mapping_failure_from_the_real_service_is_reported_as_internal_server_error` all fail as
expected (502 instead of 500, or `RuntimeError` not matching the tightened `pytest.raises`).
Mutating the truncation raise site to `ZohoFilamentMappingError` made
`test_truncated_catalogue_is_still_reported_as_bad_gateway_not_internal_error` fail as expected
(500 instead of 502). For T-094: removing the `asyncio.wait_for` around the lock acquisition made
`test_lock_acquire_timeout_raises_promptly_with_cold_cache` hang indefinitely (no
`pytest-timeout` plugin is installed in this project, so the run had to be killed manually — the
mutation genuinely reintroduces the reported unbounded-wait bug). Removing the pre-lock
negative-cache check made `test_cold_cache_failure_is_remembered_so_a_retry_skips_the_walk` fail as
expected (`assert 2 == 1`, i.e. a second upstream walk happened). All mutations were reverted
afterward and the full suite re-verified green (52/52 across the three Zoho filament test files,
3 consecutive runs, no flakes).

`ruff check`/`ruff format --check`: clean. `tools/snapshot.py verify`: 10/10, nothing moved.

## T-094 fix — 2026-08-23 — negative-cache memo now stamped when the failure is observed

Loop-7's blind verifier found that the negative cache described above did not actually protect a
*slow* Zoho outage. Inside `_refresh_lock`, `now = datetime.now(timezone.utc)` was captured once,
before the paged walk began; the `except` branch then wrote `_fail_at = now`, so the memo was
timestamped with when the walk *started*, not when it *failed*. Since the walk itself is bounded
only at roughly `_MAX_PAGES(20) x 2 x 10s ~= 400s` — far longer than `_FAIL_COOLDOWN`'s 30s — any
cold-cache walk slow enough to actually need the memo wrote one that was already expired the
instant it landed. Fails safe (never masks a recovery longer than intended), so this was a feature
that silently didn't fire, not a correctness bug: the fast-outage case (loop-7's own repro, `boom()`
raising immediately) was unaffected and its tests stayed green throughout.

Fixed by re-reading the clock at the point each timestamp is actually meaningful, rather than
reusing the pre-walk `now`: `_fail_at = datetime.now(timezone.utc)` in the failure branch, and
`_cache_at = datetime.now(timezone.utc)` on the success branch (same class of bug — a slow
*successful* walk would otherwise shorten its own `_CACHE_TTL` window). No new module-level name,
no locking/generation-guard change, `_FAIL_COOLDOWN`'s value untouched.

This does not change the approved behavior itself — the user already approved (2026-08-22) that a
cold-cache failure is remembered for up to `_FAIL_COOLDOWN`; this only makes that hold for a walk
slow enough to need it, which the fast-outage tests already exercised as working.

New regression test `test_cold_cache_failure_memo_survives_a_walk_slower_than_the_cooldown` in
`test_zoho_filaments_catalogue.py` monkeypatches the module's `datetime` name with a scripted clock
(`_ScriptedClock`, no real sleeping) so a cold-cache walk can be simulated as taking longer than a
monkeypatched, shortened `_FAIL_COOLDOWN` (5s) without slowing the suite down. Mutation-proven: with
the pre-walk `now` restored (i.e. the original bug), the test fails with `assert 2 == 1` — the
second call incorrectly falls outside the (mis-stamped) cooldown window and repeats the upstream
walk; with the fix restored it passes at `1 == 1`. The two named T-094 regression tests
(`test_cold_cache_failure_is_remembered_so_a_retry_skips_the_walk`,
`test_negative_cache_preserves_the_mapping_failure_exception_type`) and the full
`test_zoho_filaments_catalogue.py` file (21/21) were re-verified green. T-095 (the superseded-walk
raise and the `_refresh_lock` rebind in `reset_cache()`) was left untouched, per that task's
ownership.

`ruff check`/`ruff format --check`: clean. `tools/snapshot.py verify`: 10/10, nothing moved.
`SURFACE.md`: unchanged — no module-level constant added, renamed or removed.

## T-089 fix — 2026-08-23 — spool-cost rows now suppressed under the MIN_SAMPLE floor (user-approved behavior change)

Audit `audit-security` found that `_spool_costs` and `_spool_costs_by_brand` in
`calculator_insights.py` were the only two aggregates in that file NOT gated by the module's
`MIN_SAMPLE` (5) floor — their comprehensions were guarded only by `if material` /
`if brand and material`. With a single priced, unarchived spool in the database,
`GET /api/v1/calculator/insights` returned a `sample: 1` row whose `avg_cost_per_kg` was that one
spool's verbatim purchase cost, and — for the by-brand grouping — its exact supplier brand. Since
the route is gated only on `CALCULATOR_READ` (held by the default Viewers role), this was a
per-record inventory cost disclosure dressed up as an aggregate, not a permission bug.

The user approved exactly one remedy: apply the file's existing `MIN_SAMPLE` floor to both
methods, the same way `_failure_rates`, `_power_draw` and `_daily_usage` already do it. The
auditor's alternative suggestion — requiring `Permission.INVENTORY_READ` for the per-brand block
— was offered and explicitly declined; no permission change was made.

**User-visible effect:** the calculator's reality-check panel now shows no spool-cost row (by
material, or by brand+material) for any group with fewer than 5 unarchived priced spools. Small
inventories that saw a row today (based on 1-4 spools) will see none. Groups at or above 5 are
unaffected — same average, same `sample` count as before.

Fixed with a one-line guard added to each comprehension's filter (`count >= MIN_SAMPLE`), matching
the existing idiom exactly; no new module-level name, no permission change, no other aggregate
touched.

New/updated tests in `test_calculator_insights.py`: `test_spool_costs_average_by_material` and
`test_spool_costs_average_by_brand` were rewritten to seed exactly `MIN_SAMPLE` priced spools for
the surviving group (previously 2) and assert the under-`MIN_SAMPLE` group is now **absent** from
the response, not merely present with a low `sample`. Two new boundary tests per grouping —
`test_spool_costs_by_{material,brand}_below_min_sample_is_absent` (`MIN_SAMPLE - 1` spools, row
absent) and `test_spool_costs_by_{material,brand}_at_min_sample_is_present` (`MIN_SAMPLE` spools,
row present with the right average) — pin the exact off-by-one boundary. Mutation-proven: reverting
the `count >= MIN_SAMPLE` guard back to the pre-fix filter made both `*_below_min_sample_is_absent`
tests fail (`assert ("POLYMAKER", "PLA") not in rows` / `assert "PLA" not in rows` — the single-spool
row reappeared), confirming the tests actually exercise the floor rather than passing vacuously.
`ruff check`/`ruff format --check`: clean. `tools/snapshot.py verify`: 10/10 after re-recording
`calc-pydantic-schemas` (moved by T-090, see below) — `calc-insights-pure` (which pins this
module's constants and pure helpers) did NOT move, confirming the fix is a local/inline guard, not
a module-level signature change. `SURFACE.md`: unchanged — no new module-level def/class/constant.

## T-090 fix — 2026-08-23 — Zoho filament sync no longer writes an unbounded derived price (user-approved behavior change)

Audit `audit-security` found a hole in T-071 (shipped this same campaign): the sync's skip guard
checked `math.isfinite(new_cost)` but never checked the *derived* `sale_price_per_kg` computed on
the next lines, and the sync applied no upper ceiling of its own (unlike the write-side schemas,
which gained `le=1e8` in T-071). Separately, `spool_weight_kg`'s `gt=0` bound admitted denormals
like `1e-307`. End-to-end: `POST /calculator/filaments/` with `spool_weight_kg: 1e-307,
margin_pct: 1000.0`, linked to an ordinary Zoho product priced at 5.0, then one sync chunk reported
`updated: 1` and stored `cost_per_kg: 5e+307` / `sale_price_per_kg` serialized as JSON `null`
(`inf` has no JSON representation) against a response schema that declares `sale_price_per_kg` as
non-optional. The row was self-perpetuating: every later PATCH re-derives off the stored `5e+307`
and writes `inf` again.

The user approved both halves of the fix: (a) a client posting a spool weight below 1 g now gets a
422 instead of a 200, and (b) a Zoho-linked filament whose derived cost exceeds the money ceiling
is counted as `skipped_no_price` by the sync rather than having its price rewritten.

**User-visible effect:** `POST`/`PATCH .../filaments/` now reject `spool_weight_kg` values below
0.001 kg (1 g) with 422, where they were previously accepted. The Zoho sync now counts a filament
as `skipped_no_price` (price left untouched) whenever the freshly-derived `cost_per_kg` would
exceed the existing `_MONEY_CEILING` (1e8) or the derived `sale_price_per_kg` would not be finite,
instead of writing the poisoned value and counting it as `updated`.

Fixed in two files: `schemas/calculator.py` — `spool_weight_kg` changed from `gt=0` to `ge=0.001`
on both `CalculatorFilamentCreate` (previously inherited unbounded from the base schema; now
explicitly overridden there too, the same pattern `cost_per_kg` already uses) and
`CalculatorFilamentUpdate`. `routes/calculator.py` — the sync loop now computes
`new_sale = derive_sale_price(new_cost, filament.margin_pct)` *before* the guard, and the guard's
condition gained `new_cost > _MONEY_CEILING or not math.isfinite(new_sale)`, reusing the existing
`_MONEY_CEILING` constant imported from `schemas/calculator.py` (no second copy of `1e8`). The
`filament.sale_price_per_kg = derive_sale_price(...)` write below was replaced with the
already-computed `new_sale` to avoid a second derivation.

Reproduced the auditor's exact 5e+307/inf scenario end-to-end BEFORE fixing (temporarily reverted
both files to their pre-fix state in the worktree to confirm): `CREATE` returned 200 with
`sale_price_per_kg: 11000.0`, `SYNC` returned `{'updated': 1, ...}`, and the subsequent `LIST`
showed `cost_per_kg: 5e+307`, `sale_price_per_kg: null` — byte-for-byte the audit's reported
values. After restoring the fix, the identical request sequence now 422s at `CREATE`.

New tests: `test_create_rejects_denormal_spool_weight` / `test_update_rejects_denormal_spool_weight`
in `test_calculator_routes.py` pin the 422 at `1e-307` on both the create and patch routes. Because
the write-side floor closes the auditor's literal repro at the API boundary, a second, independent
vector was added to `test_calculator_zoho_sync.py` —
`test_derived_cost_beyond_the_money_ceiling_is_skipped_not_written` — which corrupts the
*catalogue product's own* `spool_weight_kg` (parsed from a Zoho item name, never pydantic-validated)
to `1e-307` instead, reproducing the identical `5e+307` overflow through the sync's other,
still-untrusted input, and asserts `skipped_no_price: 1`, `updated: 0`, and the row's
`cost_per_kg`/`sale_price_per_kg` left unchanged. Mutation-proven: reverting the guard to only
`not product.has_price or new_cost <= 0 or not math.isfinite(new_cost)` (i.e. dropping the
`new_cost > _MONEY_CEILING or not math.isfinite(new_sale)` clause) made
`test_derived_cost_beyond_the_money_ceiling_is_skipped_not_written` fail exactly as expected,
showing `updated: 1` and the poisoned `cost_per_kg: 5e+307` written to the row — the same failure
mode the audit reported. All pre-existing `test_calculator_zoho_sync.py` /
`test_calculator_routes.py` tests re-verified green (103/103 across the three
`test_calculator_*.py` files).

`ruff check`/`ruff format --check`: clean. Full backend suite: 11695 passed, 1 skipped. Scoped
coverage (`tools/coverage_calc.sh backend`): 683/686 statements = 99.56% (no drop from the 681/684
baseline; the 2 new statements are both covered). `tools/snapshot.py verify`: `calc-pydantic-schemas`
moved as expected — `spool_weight_kg`'s JSON Schema gained `"minimum": 0.001` and lost
`"exclusiveMinimum": 0` on both `CalculatorFilamentCreate` and `CalculatorFilamentUpdate` — and was
re-recorded; all other 9 probes matched unchanged, including `calc-insights-pure`. `SURFACE.md`:
unchanged — `_MONEY_CEILING` is imported/reused, not redefined; no new module-level def/class/constant.

## T-095 — 2026-08-23 — a superseded Zoho walk now fails instead of returning the pre-rotation catalogue (user-approved behavior change)

Audit `audit-robustness` found that the `_generation` guard added for T-072 only blocked the
module cache WRITE when `reset_cache()` fired mid-walk (a Zoho credential rotation landing while a
refresh was still parked on a paged fetch) — the superseded walk's freshly-mapped catalogue was
still handed back to its own caller via `return mapped`, even though it belonged to the OLD
organisation. Reproduced with a page fetch parked on an `asyncio.Event`, `reset_cache()` called
mid-walk while flipping the fake org's dealer price 1000 -> 2000, then released: the superseded
walk returned `cost_per_kg = 1000.0` (the pre-rotation org's price) with the module cache correctly
left at `None`. `sync_calculator_filaments_from_zoho` consumes exactly that return value
(`by_item_id = {product.item_id: product for product in catalogue}`) and writes
`filament.cost_per_kg`, sets `filament.zoho_synced_at = now`, and commits — so an operator rotating
Zoho credentials while a sync chunk was mid-walk could have up to `limit` rows of the OLD
organisation's prices written into `calculator_filaments` and stamped as freshly synced, which is
exactly what would stop anything from flagging them for correction.

A second, related finding: `reset_cache()` rebound `_refresh_lock` to a brand new, unheld `Lock()`
on every reset (a leftover from before T-094's bounded acquisition, originally there so a lock
that blocked on one asyncio event loop could never be awaited from a different one — the test
suite runs each async test on its own loop). This meant a caller arriving right after a reset could
acquire the NEW lock immediately and start its own Zoho walk while the superseded walk — still
holding the OLD lock object — was also still running: two concurrent walks instead of the one
`_refresh_lock` exists to guarantee. The auditor measured this directly: 2 page fetches after a
`reset_cache()` landing mid-walk, where 1 (the second caller queuing behind the first) was
required.

The user approved this exact framing: "a search or sync request that happens to be walking Zoho
when someone saves new Zoho credentials would fail with 502 instead of answering from the previous
organisation's catalogue."

**User-visible effect:** if a Zoho credential/endpoint save (`reset_cache()`) lands while
`/calculator/zoho-filaments` or `/calculator/filaments/zoho-sync` is mid-walk of a paged Zoho
fetch, that in-flight request now fails with the same 502 "Could not reach Zoho" any other
unreachable-Zoho failure gets (falling back to its own stale cache first, same as any other
refresh failure), instead of succeeding with the pre-rotation organisation's catalogue. A second
caller racing a reset that lands mid-walk now always queues behind the in-flight (superseded) walk
rather than starting a concurrent second walk of its own.

Fixed in `backend/app/services/zoho_filaments.py`:
- The `if generation == _generation: _cache = mapped; ...` / `return mapped` branch was inverted:
  `if generation != _generation:` now `raise RuntimeError("Zoho filament catalogue refresh was
  superseded by a credential change; retry")` before ever reaching the cache-publish or return
  lines. A **plain** `RuntimeError`, not the `ZohoFilamentMappingError` subclass — this is not a
  mapping bug, and that subclass is reserved for T-074's 500 contract; both `search_zoho_filaments`
  and `sync_calculator_filaments_from_zoho` in `routes/calculator.py` catch
  `ZohoFilamentMappingError` first (-> 500) and everything else (-> 502), so the exception TYPE
  alone decides the status code with no route change needed.
- `reset_cache()` no longer rebinds `_refresh_lock` — the `global` statement dropped
  `_refresh_lock`, and the `_refresh_lock = asyncio.Lock()` line inside it was removed. The single
  module-level lock (created once at import) is now reused for the life of the process, so a reset
  can never manufacture a second concurrent walk. The `lock = _refresh_lock` local capture in
  `fetch_catalogue` (added for T-094 specifically to survive a mid-wait rebind) was deliberately
  KEPT even though the rebind it was guarding against is gone — it is still cheap insurance against
  any future reassignment of the module global, and removing it bought nothing.

T-104 (an open task proposing a characterization test for the `reset_cache()` lock REBUILD) is now
moot as originally scoped — the rebuild it would have characterized no longer exists — and should
be re-scoped to "reset_cache() must not create a second concurrent walk" or retired.

Test-suite-only consequence of removing the rebind: this repo's async tests each run on their OWN
event loop (confirmed empirically — `asyncio.get_running_loop()` differs test-to-test despite a
session-scoped `event_loop` fixture in `conftest.py`, which pytest-asyncio 1.3.0 no longer honors),
and `asyncio.Lock` only binds to a loop the first time it is actually CONTENDED (the uncontended
fast path in `Lock.acquire()` never touches `_get_loop()`). Reusing one `_refresh_lock` module
singleton is exactly the correct, intended behavior for a real long-running single-event-loop
process, but it meant a lock contended by one test's concurrency scenario would leak forward and
raise "bound to a different event loop" the next time a DIFFERENT test's scenario contended it
(observed directly: `test_lock_acquire_timeout_raises_promptly_with_cold_cache` followed by
`test_lock_acquire_timeout_serves_the_stale_cache_when_warm` failed together, passed individually).
Fixed as test-isolation bookkeeping only (no production equivalent) in the `_clear_cache` autouse
fixture in `test_zoho_filaments_catalogue.py`: `zoho_filaments._refresh_lock = asyncio.Lock()` is
now rebuilt directly by the fixture before and after every test in that file.

New/changed tests in `test_zoho_filaments_catalogue.py`:
- `test_reset_cache_during_inflight_fetch_raises_instead_of_returning_stale_catalogue` (replaces
  the old `..._does_not_publish_stale_catalogue`, which asserted the now-superseded `return mapped`
  behavior): reproduces the auditor's price-flip repro and asserts the superseded walk raises a
  plain `RuntimeError` that is NOT a `ZohoFilamentMappingError`, that nothing lands in the module
  cache, and that a subsequent fetch goes back to Zoho rather than resurrecting the pre-rotation
  catalogue.
- `test_reset_cache_mid_walk_does_not_permit_a_second_concurrent_walk`: reproduces the auditor's
  2-concurrent-walks repro and asserts exactly 1 page fetch happens before the first (superseded)
  walk releases the lock, and the second caller's own walk only starts after.

New test in `test_calculator_zoho_routes.py`:
- `test_reset_cache_mid_request_is_reported_as_bad_gateway_not_internal_error`: runs the SAME
  scenario through the real route (`fetch_catalogue` un-stubbed, only `list_items_page` faked,
  matching the existing pattern used by the T-073/T-101 real-service route tests) and asserts the
  in-flight request comes back `502` / `"Could not reach Zoho"`, never `500`.

Mutation-proven, each restored and re-verified green afterward:
1. Reverted the `raise RuntimeError(...)` back to falling through to `return mapped` ->
   `test_reset_cache_during_inflight_fetch_raises_instead_of_returning_stale_catalogue` AND
   `test_reset_cache_mid_request_is_reported_as_bad_gateway_not_internal_error` both failed
   (`assert 200 == 502` at the route level).
2. Raised `ZohoFilamentMappingError` instead of the plain `RuntimeError` -> the route test failed
   with `assert 500 == 502`, and the unit test's `not isinstance(..., ZohoFilamentMappingError)`
   assertion also failed.
3. Restored the `_refresh_lock = asyncio.Lock()` rebind inside `reset_cache()` ->
   `test_reset_cache_mid_walk_does_not_permit_a_second_concurrent_walk` failed with
   `assert 2 == 1` (both callers' page fetches ran before either released).

Regression guard re-verified after the fix: the other three approved raise-path contracts are
unchanged — `test_truncated_catalogue_is_still_reported_as_bad_gateway_not_internal_error` (502),
`test_mapping_failure_is_reported_as_internal_server_error` +
`test_mapping_failure_from_the_real_service_is_reported_as_internal_server_error` (500), and
`test_lock_acquire_timeout_raises_promptly_with_cold_cache` +
`test_lock_acquire_timeout_serves_the_stale_cache_when_warm` (502 / stale cache) all still pass.

`ruff check`/`ruff format --check backend/`: clean. Full backend suite:
11696 passed, 1 skipped, 1 failed (`test_library_slice_api.py::TestCrossClassSliceAllLoop::
test_cross_class_arrange_survives_user_leaving_the_box_unticked`, a documented pre-existing flake
unrelated to this file — re-ran alone and it passed). Scoped coverage
(`tools/coverage_calc.sh backend`): 683/686 statements = 99.56%, matching the ratchet exactly (no
drop). `tools/snapshot.py verify`: 10/10 probes matched, none moved — none exercise
`fetch_catalogue`'s paging. `SURFACE.md`: unchanged (`bash tools/gen_surface_calc.sh` diffed clean)
— a plain `RuntimeError` was used, no new exception class or module-level constant.

## T-093, T-096 — 2026-08-23 — both are user-approved behavior changes

T-093: the app-global `RequestValidationError` handler in `backend/app/main.py` (added by T-071)
kept `allow_nan=True` to stop FastAPI's default handler crashing on a non-finite `input` value —
but `json.dumps(..., allow_nan=True)` emits the bare Python literals `Infinity` / `-Infinity` /
`NaN`, which are not valid JSON (RFC 8259). A strict parser (the frontend's
`response.json().catch(() => ({}))` at `frontend/src/api/client.ts:136`) throws on that body,
`detail` comes back `undefined`, and the toast falls through to the bare `HTTP 422` the comment
three lines above that fallback exists to avoid — the exact defect the 422 was supposed to fix.
Fixed by restoring `allow_nan=False` (byte-identical to Starlette's `JSONResponse.render`) and
adding a new `_stringify_non_finite` helper that walks `jsonable_encoder(exc.errors())`
recursively (dict values, list items, and tuple items) and replaces any `float('inf')` /
`float('-inf')` / `float('nan')` with its `str()` form (`"inf"` / `"-inf"` / `"nan"`) before
`json.dumps` ever sees it — so the encoder never has a non-finite value to choke on, and
`allow_nan` itself no longer matters. The helper is a no-op for every other value, which is what
keeps the handler byte-identical to FastAPI's own `request_validation_exception_handler` for
every ordinary validation error: verified directly by calling both handlers with 6 synthetic
`RequestValidationError`s (`gt=0` int, `string_too_short`, `missing`, `float_parsing`, a
two-error list, and a Unicode message) and comparing `.body` byte-for-byte — all 6 matched. For
the previously-crashing case (`cost_per_kg: Infinity`), FastAPI's own default handler was called
directly and confirmed to still raise `ValueError: Out of range float values are not JSON
compliant: inf`, while this handler returns `{"detail":[{...,"input":"inf"}]}`, which
`json.loads(..., parse_constant=<reject>)` accepts (no bare literal reaches the parser).

New tests: `backend/tests/unit/test_main_validation_handler.py` (`TestStringifyNonFinite`, 9
cases) exercises `_stringify_non_finite` directly, including nested cases the route-level tests
can't reach on their own — a non-finite float inside a list inside a dict inside a list — since a
real Pydantic validation error's `input` is always the single rejected leaf value; the
integration-level cases in `backend/tests/unit/test_calculator_routes.py`
(`test_non_finite_cost_response_is_strict_json`, parametrized over inf/-inf/nan, and
`test_ordinary_validation_error_body_unchanged`) drive the real route end-to-end and parse the
raw response bytes with a `parse_constant` callback that raises `AssertionError` on any bare
non-finite literal, so a regression back to `allow_nan=True` fails loudly rather than silently
passing a lenient parse.

Mutation-tested: reverting the handler to its exact pre-fix state (`content =
{"detail": jsonable_encoder(exc.errors())}` and `allow_nan=True`, no sanitisation) made all three
`test_non_finite_cost_response_is_strict_json` cases fail with `AssertionError: strict JSON parse
hit a bare non-finite literal: 'NaN'` (and equivalents for inf/-inf) — confirming the strict-parse
test actually exercises the fix. (Flipping `allow_nan` alone, with sanitisation left in place,
does NOT reproduce the bug and was not used as the mutation — the sanitised payload has already
removed every non-finite float by the time `json.dumps` runs, so `allow_nan` is inert in the
fixed code; the real regression requires reverting the sanitisation too, which is what was done.)

user-approved 2026-08-23: "a client sending Infinity/NaN would start receiving a parseable 422
whose detail[].input is the string 'inf'/'nan' instead of a bare literal, so the UI toast would
show 'Input should be a finite number' where it currently shows 'HTTP 422'."

T-096: `CalculatorFilamentsPanel.tsx`'s Zoho price-sync walk (`runSync`) wraps each chunk request
in `withTimeout` (T-075), which is documented as never aborting the underlying request — a chunk
that crosses the 60s `SYNC_CHUNK_TIMEOUT_MS` budget is still running server-side when the walk
gives up on it. The `catch` block treated a timeout exactly like any other chunk failure: set a
flat "Sync stopped: ..." error and immediately `invalidateQueries(['calculatorFilaments'])`. That
immediate refetch fires before the abandoned request has had any chance to land, so it reliably
shows PRE-sync prices under a red failure banner, even though the walk itself is not actually
done — the abandoned request can still commit up to 25 more rows seconds later, with nothing
telling the table to look again.

Fixed with a `SyncTimeoutError` subclass thrown by `withTimeout` in place of the previous plain
`Error`, so the `catch` block can `instanceof`-distinguish a timeout from a genuine chunk failure
without matching on message text. On a timeout specifically: (a) the wording switches to a new
`calculator.syncTimedOut` i18n key ("Sync timed out; some chunks may have applied" in English,
translated — not copied — into all 13 locale files) instead of interpolating the raw English
`withTimeout` rejection message into `calculator.syncFailed`, fixing the known defect the task
called out (that raw string was untranslated in every locale); (b) a second
`invalidateQueries(['calculatorFilaments'])` is scheduled via `setTimeout` for
`SYNC_CHUNK_TIMEOUT_MS` after the immediate one, giving the abandoned request the same worst-case
window T-075 already budgets for a chunk to land, so the table picks up whatever it committed
instead of being stuck on what the immediate refetch caught mid-flight. No `AbortController` was
added — the auditor's alternative suggestion was explicitly declined by the user because aborting
would leave a partially-synced catalogue where today the walk always runs to completion; the
walk's actual behavior (never cancelled, may commit after the client gives up) is unchanged, only
how the UI reports and re-checks it.

i18n: `syncTimedOut` added directly after the existing `syncFailed` key in `calculator.*` in all
13 locale files (en/de/es/fr/it/ja/ko/pt-BR/ru/tr/uk/zh-CN/zh-TW) — real translations, not
English copies (`frontend/scripts/check-i18n-parity.mjs`'s identical-to-English gate passes with
no new `IDENTICAL_TO_EN_ALLOWED` entries needed). `npx vitest run src/__tests__/i18n/` (26 tests)
and `node scripts/check-i18n-parity.mjs` both pass; all 13 locales report the same 6867 leaf keys
as `en`.

New/changed test: `CalculatorSettingsPanels.test.tsx`'s existing T-075 timeout test (`ends a chunk
request that never settles...`) was renamed and extended — `reports a timed-out chunk as
indeterminate, re-enables the button, and refetches again to pick up what the abandoned request
commits` — driven entirely with `vi.useFakeTimers`/`vi.advanceTimersByTimeAsync` (never a
wall-clock sleep). It asserts the indeterminate wording appears (not "sync stopped: ..."), that
exactly one `api.getCalculatorFilaments` refetch happens at the moment of timeout (table still
shows the pre-sync row), and that a SECOND refetch after a further `SYNC_CHUNK_TIMEOUT_MS`
(60s) picks up a row mutated in between — simulating the abandoned request's late commit.

Mutation-tested: removing the scheduled second `invalidateQueries` call made the new test fail at
`expect(await screen.findByRole('cell', { name: 'PETG' }))` (the late commit never surfaces,
`getFilaments.mock.calls.length` stays one short) — confirming the test actually exercises the
re-invalidation, not just the wording change.

user-approved 2026-08-23: "a timed-out sync would stop leaving the table showing pre-sync prices,
and its message would say the result is indeterminate rather than failed." AbortController
explicitly declined.

Verification: `ruff check backend/` and `ruff format --check backend/` clean; `npx tsc -b
--noEmit` and `npx eslint .` clean; full backend suite 11710 passed, 1 skipped (no new failures);
full frontend suite passed apart from the documented known-flake files (PrintModal,
CalculatorPage, StatsPageUserFilter1894, ModelViewerModal), each re-run alone and green.
`tools/snapshot.py verify`: 10/10 probes matched, none moved. `SURFACE.md`
(`bash tools/gen_surface_calc.sh`): unchanged — `SyncTimeoutError` and `_stringify_non_finite`
are both module-private (not exported), so neither adds to the scanned surface.
`tools/coverage_calc.sh backend`: 683/686 = 99.56%, exactly matching the ratchet in every run.
`tools/coverage_calc.sh frontend`: this machine was under heavy, fluctuating concurrent load for
the whole of this iteration (other agents' `pytest`/`vitest` processes observed running
simultaneously via `ps`/`uptime`, load average 30-53). Measured 7 times: 5 runs read 90.31%
(988/1094) and 2 runs read 92.23% (1009/1094), correlating exactly with host load at
measurement time, not with any code change — the FAIL list on every low-reading run is 100%
the pre-documented known-flake files (CalculatorPage.test.tsx, StatsPageUserFilter1894.test.tsx,
ModelViewerModal.test.tsx, PrintModal.test.tsx; none touched by this change) exhausting the
harness's own `--retry=3`, while `CalculatorFilamentsPanel`'s own coverage held flat at 92.3% and
`CalculatorSettingsPanels.test.tsx` passed 100% of the time across every run. On the two clean
(lower-load) reads, 1009/1094 clears the 92.16% (1000/1085) ratchet, and all 9 of the statements
added by this change (1094-1085) are covered (1009-1000). Reported honestly per instruction rather
than asserting a single confident number: this machine's shared-load condition made a
majority-of-runs measurement land below the ratchet even though the change itself is fully
covered and no in-scope file's own coverage dropped.

## T-106 fix — 2026-08-24 — a material spool-cost row is now suppressed when its published brand rows leave a small, solvable residual (user-approved behavior change)

Audit `audit-security` found that T-089's per-group `MIN_SAMPLE` floor on `_spool_costs` and
`_spool_costs_by_brand` in `calculator_insights.py` closes the *direct* per-record disclosure but
not an *arithmetic* one: both the average and the exact `sample` count are published for every
surviving group, and `_spool_costs_by_brand` filters out spools with a NULL brand while
`_spool_costs` does not. With 5 spools `brand='SUNLU' material='PLA' cost_per_kg=20.0` plus one
spool `brand=NULL material='PLA' cost_per_kg=200.0`, `GET /api/v1/calculator/insights` published
`by_material: [{material: 'PLA', avg_cost_per_kg: 50.0, sample: 6}]` and
`by_brand: [{brand: 'SUNLU', material: 'PLA', avg_cost_per_kg: 20.0, sample: 5}]` — from which the
one unbranded spool's exact `cost_per_kg` (200.0) is recoverable as `6*50.0 - 5*20.0`, even though
neither query discloses it directly. Gated only by `CALCULATOR_READ` (held by the default Viewers
role), same class of issue as T-089.

The auditor offered three remedies; the user approved exactly one — **residual suppression**: drop
a material row whenever its published brand subgroups leave a residual population strictly between
0 and `MIN_SAMPLE` (`residual = material sample count - sum of that material's published
brand-group sample counts`). The other two alternatives — adding a NULL-brand bucket to
`_spool_costs_by_brand` so the two aggregates cover the same population, and no longer publishing
exact `sample` counts — were explicitly NOT implemented, neither instead nor in addition.

**User-visible effect:** `spool_cost_by_material` in the response will now omit a material's row
whenever the difference between its own `sample` and the sum of its visible `spool_cost_by_brand`
rows' `sample`s is between 1 and 4 (i.e. `MIN_SAMPLE`, 5, exclusive on both ends means residuals of
1-4 trigger suppression; a residual of 0 or ≥5 does not). This affects only materials that have
*both* a published brand breakdown *and* a small unbranded/off-brand remainder; `spool_cost_by_brand`
itself is completely unchanged — the SUNLU/PLA row above still appears with `avg_cost_per_kg: 20.0,
sample: 5`. The calculator's one-click "apply measured average" button disappears with the
suppressed material row, same as any other `MIN_SAMPLE` suppression.

Implemented in `backend/app/services/calculator_insights.py`: added a private helper
`_published_brand_counts_by_material` — a `SELECT UPPER(material), COUNT(id) ... GROUP BY
UPPER(brand), UPPER(material) HAVING COUNT(id) >= MIN_SAMPLE` (i.e. exactly the population
`_spool_costs_by_brand` actually publishes), summed per material. `_spool_costs` now calls it once
and, for each material row that already clears its own `MIN_SAMPLE` floor, computes
`residual = count - published_brand_counts.get(material, 0)` and skips the row when
`0 < residual < MIN_SAMPLE`. `_spool_costs_by_brand` itself was not touched — no NULL-brand bucket
was added, and both methods still publish exact `sample` counts, per the chosen alternative.

New tests in `test_calculator_insights.py`: `test_spool_costs_material_suppressed_when_residual_below_min_sample`
reproduces the audit's exact repro (5 SUNLU/PLA @ 20.0 + 1 unbranded PLA @ 200.0) and asserts the
`PLA` material row is absent while the `SUNLU`/`PLA` brand row is untouched (`avg_cost_per_kg:
20.0, sample: 5`). Two boundary tests pin the edges of the new condition:
`test_spool_costs_material_present_when_residual_at_min_sample` (residual exactly `MIN_SAMPLE` — 5
SUNLU/PLA @ 20.0 + 5 unbranded PLA @ 100.0 — must still publish, `sample: 10, avg_cost_per_kg:
60.0`, since a residual that large is itself a safe-to-publish group) and
`test_spool_costs_material_present_when_no_residual` (residual exactly 0 — 5 SUNLU/PLA @ 20.0 and
nothing else — must still publish `sample: 5, avg_cost_per_kg: 20.0`, since a zero residual is
redundant with the brand row, not disclosive). All pre-existing `_spool_costs`/`_spool_costs_by_brand`
tests (T-089's `test_spool_costs_average_by_material`, `..._by_brand`, and the four
`..._{below,at}_min_sample_is_{absent,present}` boundary tests) pass unchanged — none of their
fixtures produce a `0 < residual < MIN_SAMPLE` case.

Verification: `ruff check backend/` and `ruff format --check backend/` clean. Full backend suite:
11731 passed, 1 skipped, 4 failed under `-n 30` (`test_scheduled_drying_routes.py::{test_create_and_list,
test_cancel_pending, test_offline_printer_is_still_schedulable}` and
`test_library_slice_api.py::TestCrossClassSliceAllLoop::test_user_requested_arrange_also_loops_per_plate`)
— all four re-ran green in isolation (`test_scheduled_drying_routes.py` alone: 13/13 passed), confirming
parallel-load flakiness unrelated to this change, matching the documented `test_library_slice_api.py`
flake and the general "suite load flakes" pattern; no new failure. `tools/coverage_calc.sh backend`:
703/707 = 99.43% statements, 122/130 = 93.85% branches (before: baseline 612/626 = 97.76%; most
recent prior iteration 687/690 = 99.57%) — `calculator_insights.py` itself rose from its 92.05%
baseline to 95.79%. Three lines remain uncovered in the file: two pre-existing (`_time_accuracy`
line 203, `_power_draw` line 281, both untouched by this change) and one new defensive branch (`if
not material: continue` in `_published_brand_counts_by_material`, mirroring the equally-uncovered
`if brand and material` guard `_spool_costs_by_brand` already had) — `Spool.material` is a
non-nullable column (`Mapped[str]`, no `| None`), so this guard is unreachable through the ORM and
was left untested for the same reason its sibling guard was. `tools/snapshot.py verify`: 10/10
probes matched, none moved — `calc-insights-pure` only exercises this module's constants,
`_resolve_duration`, and `_split_materials`, none of which changed. `SURFACE.md`
(`bash tools/gen_surface_calc.sh`): byte-identical — the new helper is a private class method
(indented `async def`), invisible to the surface scanner's `^(def|class|async def)` anchor, same
as every other private method in this file.

## T-109 — 2026-08-24 — CONTRACT DISCLOSURE, not a behavior change (user-approved)

Audit `audit-cleanliness` found that `calculatorSettingsShared.ts` and `CalculatorPanelParts.tsx`
each justified their bare-footer export style (every binding declared without a leading `export`
keyword, then re-exported via a trailing `export { ... }` / `export type { ... }` block) with an
in-code comment claiming this is "what lets react-refresh/only-export-components pass without an
extra ignore." That rationale was empirically false: rewriting either file with plain leading
`export const` / `export function` declarations also passes the rule cleanly, because each file
already exports only one kind of thing (all-non-components in `calculatorSettingsShared.ts`,
all-components in `CalculatorPanelParts.tsx`) — exactly the case
`react-refresh/only-export-components` already permits, with no ignore comment and no
`eslint.config.js` exemption-list entry needed either way. The bare-footer style's only actual
effect was to hide these files' 8 (now 9, see below) exports from `SURFACE.md`'s
`^export (default function|function|const|type|interface|class|enum) ...` regex — a frozen-contract
blind spot, not a lint workaround.

The user was asked whether to approve the resulting `SURFACE.md` growth before this was done, since
moving a frozen artifact needs an explicit decision. They approved it: switch both files to plain
leading exports, regenerate `SURFACE.md`, and record the disclosure here.

**This is not a behavior change.** No logic, JSX, control flow, or export *names* changed — only the
syntax used to export the same 8 bindings each file already exported (`parseNum`, `settingsTdCls`,
`useSortToggle`, `SortDir`, `SortHeader`, `SearchBox`, `CountBadge`, `NoMatches`), plus a 9th,
`useEntityCrudMutations`, added earlier this same iteration by T-108 (committed before this task
started, deliberately left on the old bare-footer convention pending this task). Every existing
importer (`CalculatorFilamentsPanel.tsx`, `CalculatorPrintersPanel.tsx`,
`CalculatorDefaultsPanel.tsx`, and the two test files) uses named imports and required no changes.

**Newly visible in `SURFACE.md`** (9 additions under "Calculator component exports", all additive —
nothing existing was removed or altered):
```
1 export const parseNum
1 export const settingsTdCls
1 export function CountBadge
1 export function NoMatches
1 export function SearchBox
1 export function SortHeader
1 export function useEntityCrudMutations
1 export function useSortToggle
1 export type SortDir
```

Also removed the two now-false rationale comments (the react-refresh claim in both files, and the
bare-footer/SURFACE-regex-dodge explanation in both files); replaced with a short true statement of
why the non-JSX helpers live in a separate file, or nothing.

Verification: `npx eslint` on both rewritten files alone: zero output, exit 0 — confirms
`react-refresh/only-export-components` genuinely passes with plain leading exports; no
`eslint.config.js` exemption was needed. Full `npx eslint .` and `npx tsc -b --noEmit`: clean.
`npm run build`: succeeds (`static/` reverted after, per worktree convention). `tools/snapshot.py
verify`: 10/10 probes matched, none moved. Full frontend suite (`npx vitest run --retry=3`): one
clean run at 347/347 files, 4862/4862 tests; other runs on the same tree saw 1-4 files flake
(`StatsPageUserFilter1894`, `CalculatorPage`, `QueuePage` — all on the documented known-flaky list)
under host load averages of 40-51, all passing in isolation. `tools/coverage_calc.sh frontend`:
90.44%-91.46% statements across repeated runs (985-996/1089), same range as an A/B run against the
unmodified baseline files under identical load (90.44%, 985/1089 exactly) — confirming the run-to-run
variance is pre-existing host-load flakiness (the documented `CalculatorPage.test.tsx` degradation
under load), not caused by this change. All values clear the frozen RATCHET floor of 87.32%.

## T-118 — 2026-08-24 — user-approved behavior change

The `calculator_filaments` Zoho/margin migration backfill (`core/database.py`, audit-only in this
campaign, not touched here) computes `margin_pct` from whatever `cost_per_kg`/`sale_price_per_kg`
were already stored, unclamped. A legacy row where the hand-typed printing cost sits below the
purchase cost, or more than ~11x it (a plausible decimal-point slip), backfills to a margin outside
`[0, 1000]`. `CalculatorFilamentBase.margin_pct` still carried the write-side `ge=0, le=1000` bound
and `CalculatorFilamentResponse` inherited it unchanged, so a `GET /api/v1/calculator/filaments/`
response containing even one such row raised `ResponseValidationError` and 500'd the **entire**
list — every healthy filament along with the bad one — leaving the calculator page's "no filaments
configured" empty state and a blank filaments settings tab, with no in-app way to see or fix the
offending row.

Fixed the same way `cost_per_kg` on the same class already handles this precise hazard (see that
field's docstring note, extended to also cover `margin_pct`): dropped `ge=0, le=1000` from
`CalculatorFilamentBase.margin_pct`, which only the read path (`CalculatorFilamentResponse`)
inherits unmodified. `CalculatorFilamentCreate` and `CalculatorFilamentUpdate` — the two write
paths — keep the bound: `CalculatorFilamentCreate` now declares its own
`margin_pct: float = Field(default=50.0, ge=0, le=1000, ...)` override (previously relying on the
now-loosened base default), and `CalculatorFilamentUpdate` already declared `margin_pct` as its own
field on a plain `BaseModel` (not inheriting from `CalculatorFilamentBase` at all), so it was never
affected and needed no change. Confirmed by a POST/PATCH test asserting `margin_pct` outside
`[0, 1000]` still returns 422, and by a list-response test — first run against the unfixed schema to
confirm it reproduces the exact `ResponseValidationError` the audit describes, then re-run against
the fix to confirm it returns 200 with all three rows (one healthy, one backfilled negative, one
backfilled above 1000).

Observable change, quoting the approved description verbatim: "Filament profiles whose stored
printing cost per kg is below their purchase cost (or more than about eleven times it) currently
make the entire filament list fail to load; after the fix the list loads again and those profiles
appear with their real, out-of-range margin shown."

Snapshot fallout: `calc-pydantic-schemas` moved and was re-recorded — diffed old vs. new JSON Schema
output first: only two changes, both `margin_pct`'s `"maximum": 1000` / `"minimum": 0` keys removed,
once each from `CalculatorFilamentBase.properties.margin_pct` and (via inheritance, unchanged)
`CalculatorFilamentResponse.properties.margin_pct`, plus the class docstring text captured by the
same probe. `CalculatorFilamentCreate.properties.margin_pct` and
`CalculatorFilamentUpdate.properties.margin_pct` are unchanged (still `"maximum": 1000, "minimum":
0"`), confirmed in the same diff by their absence from it. `calc-openapi` did not move: that probe
only captures `spec["paths"]`, where request/response bodies appear as a `$ref` to the components
schema, not the inlined schema itself. `SURFACE.md` did not move (no class, export, or route
signature added or removed). Full `verify` run: 10/10 probes match.

## T-128 — 2026-08-24 — GET /calculator/insights `days` restricted to a fixed allowlist (user-approved behavior change)

`days: int = Query(default=365, ge=7, le=3650)` let any CALCULATOR_READ-scoped caller (a UI user or
a read-only API key — `Permission.CALCULATOR_READ` maps to `can_read_status`) sweep an arbitrary
number of overlapping windows and subtract consecutive results. `MIN_SAMPLE` is enforced per window,
never across windows, so a one-day-at-a-time sweep differences a suppressed group (sample below
`MIN_SAMPLE`, absent from the response) into visibility — the audit demonstrated this recovering a
single failed print and its material from `_failure_rates`, and the same subtraction applies to
`_daily_usage` and `_power_draw`. The parameter had no real caller: `CalculatorPage.tsx` calls
`api.getCalculatorInsights()` with no argument.

Fixed by replacing the free integer with a fixed allowlist — `days: InsightsWindowDays` (new
`IntEnum` in `backend/app/schemas/calculator.py`, values 30/90/365, default `ONE_YEAR` = 365,
unchanged from today's default) — so a caller can no longer request an arbitrary day count between
7 and 3650; any other value now 422s outright rather than being coerced to the nearest allowed
value (coercion would leave a quantised version of the same sweep alive). A plain
`Literal[30, 90, 365]` was tried first and rejected: Pydantic v2 does not coerce a query string
(`"30"`) to an int literal member in its default parsing mode, so every request — including the
three intended values — 422'd. `IntEnum` coerces the string the same way a plain `int` field always
did, while still restricting the value to the allowlist. Per the user's explicit direction, only the
allowlist option was implemented — not the alternative the audit also offered (also requiring an
archives/print-log read permission), which was ratified as the road not taken.

Residual, demonstrated against the real service, not just reasoned through: three fixed windows
(30/90/365) can still be differenced against each other, so the attack is reduced, not eliminated.
20 completed PLA + 1 failed ABS print seeded 31-89 days back, plus 15 more completed PLA prints
95-109 days back: `days=30` → `overall_pct=None, sample=0`; `days=90` →
`overall_pct=4.8, sample=21`; `days=365` → `overall_pct=2.8, sample=36`. The 90-30 delta
(sample +21, one of which failed) discloses "somewhere in the 60-day gap between the two windows,
1 of 21 new prints failed" — the same subtraction the auditor used, just bucketed into ~60/275-day
slabs instead of 1-day slabs, so it can no longer pin the failure to a specific day. Materially it
is a narrower leak than before in one respect this demo also confirms: `by_material` never surfaced
ABS at any window (its count stayed 1, under `MIN_SAMPLE`, in all three), so — unlike the auditor's
original day-granular attack, which could cross-reference two adjacent single-day windows to
attribute the recovered failure to a specific material — a 30/90/365 differencer here learns *that*
a failure occurred in a ~60-275-day span and *how many* new prints appeared, but not which one, on
which day, or (in this scenario) which material. This is a real reduction, not a full closure: the
count/rate delta itself is still a leak the allowlist does not fully close.

Observable change, quoting the approved description verbatim: "The calculator's reality-check
figures would only be available over a few fixed history windows instead of any number of days
between 7 and 3650. Nothing in Bambuddy's own UI passes a custom window today, so the calculator
page looks and behaves exactly the same; only an outside script or API key that calls
`/api/v1/calculator/insights?days=<something else>` would start getting an error and have to pick
one of the offered windows."

Snapshot fallout: `calc-openapi` moved and was re-recorded — diffed old vs. new JSON output first:
the `days` query parameter's inline `schema` lost `"maximum": 3650`, `"minimum": 7`, `"type":
"integer"`, `"title": "Days"` and gained `"$ref": "#/components/schemas/InsightsWindowDays"` (the
new named enum schema, `type: integer`, `enum: [30, 90, 365]`); the parameter and its schema both
gained `"description": "Lookback window in days."`; `"default": 365` is unchanged. No other probe
moved (`calc-pydantic-schemas` — an `IntEnum` is not a `BaseModel` subclass, so it's out of that
probe's scope; `calc-route-perms`, `calc-ddl`, `calc-column-defaults`, `calc-zoho-pure`,
`calc-insights-pure`, `calc-migration-sql`, `calc-pricing`, `calc-frontend-pure` all matched
byte-for-byte). `SURFACE.md` moved by one line — `class InsightsWindowDays` added to the schema
class listing (`R3`) — and was regenerated with `bash tools/gen_surface_calc.sh > SURFACE.md`.

## T-117 / T-120 — 2026-08-24 — `_spool_costs` residual publish-predicate mismatch (user-approved behavior change)

Two audits converged on one implementation. `_spool_costs` computes a residual per material —
its own sample count minus the sum of what `_spool_costs_by_brand` actually publishes for that
material — and suppresses the material row when that residual is a small (0 < residual <
`MIN_SAMPLE`), individually-solvable population (T-089/T-106). Two independent defects lived in
how that residual was computed:

- **T-117 (audit-cleanliness)**: the helper that summed "published brand counts per material"
  filtered rows with `Spool.brand.isnot(None)` in SQL, while `_spool_costs_by_brand` — the
  function whose actual output the helper is supposed to mirror — filters with `if brand and
  material and count >= MIN_SAMPLE` in Python. `Spool.brand` is nullable free text
  (`models/spool.py`), and an empty string (`""`) is a legitimate stored value: `isnot(None)`
  admits it, `if brand` (falsy) rejects it. A brand+material group with an empty-string brand
  meeting `MIN_SAMPLE` was therefore counted as "published elsewhere" by the residual math even
  though `_spool_costs_by_brand` never emits it — over-suppressing the material row.
- **T-120 (audit-robustness)**: `_spool_costs` computed its own aggregate, then made a *second*,
  independent DB round trip for the published-brand subtotal. Between the two awaits, a
  concurrent spool insert/edit/archive could shift the second population relative to the first,
  making the residual computed from an inconsistent snapshot (no cross-statement isolation is
  configured — see `database.py:83`).

Both fixes converge on the same implementation: `_spool_costs` now issues **one** query — `SELECT
upper(brand), upper(material), sum(cost_per_kg), count(id) ... GROUP BY upper(brand),
upper(material)` — and folds the rows in Python into (a) each material's total (every priced,
unarchived spool, including NULL- and empty-string-brand rows, summed across all its brand
subgroups) and (b) the published-brand subtotal per material, applying the exact same predicate
`_spool_costs_by_brand` applies: `if brand and count >= MIN_SAMPLE` (material truthiness is
already guaranteed by an outer `if not material: continue` that applies to both foldings). One
read, one predicate, both defects gone. The separate `_published_brand_counts_by_material` helper
method was removed; its logic is now inline in `_spool_costs`. `_spool_costs_by_brand` itself is
unchanged — it still runs its own query for the actual `spool_cost_by_brand` API field.

Direction confirmed empirically (not just reasoned through): reverted the service to its pre-fix
form and ran the new empty-string-brand test (5 spools `material="PLA", brand=""`, priced 20.0,
plus 3 unbranded (`NULL`) spools priced 200.0) against it — `spool_cost_by_material` had no "PLA"
key at all (`KeyError: 'PLA'`), confirming the material row is hidden today. With the fix restored,
the same scenario yields `{"material": "PLA", "sample": 8, "avg_cost_per_kg": 87.5}` — the row now
appears, matching the approved direction (over-suppression only, never under-suppression or leak).

Approved user-facing description, quoted verbatim: "For materials that have an empty-string-brand
subgroup meeting the sample-size floor, the calculator's spool-cost insight may currently hide
that material's average cost from the reality-check panel when it should be shown (the
empty-brand subgroup is wrongly treated as already visible via the brand breakdown, so it's
subtracted out of the 'how much is unaccounted for' check); fixing the mismatch could make a
previously-hidden material average reappear." T-120 itself is **not** a behavior change (a
correctness fix to a race with no observable effect under single-writer test conditions) — it
rode along in the same commit because both defects live in the same method and converge on the
same fix.

Tests added (`backend/tests/unit/test_calculator_insights.py`): an empty-string-brand case pinning
the material row now appears; a multi-brand case (two distinct published brands, SUNLU and
POLYMAKER, each independently clearing `MIN_SAMPLE`, plus a 3-spool unbranded residual) asserting
the residual is the material sample minus the SUM of every published brand's count, not just one —
mutating the fold's `+=` to `=` was verified to make this new test fail (`'PLA' not in
material_rows` assertion fails, row wrongly present with sample 13) while all pre-existing T-106
tests kept passing. The three pre-existing T-106 tests
(`test_spool_costs_material_suppressed_when_residual_below_min_sample`,
`test_spool_costs_material_present_when_residual_at_min_sample`,
`test_spool_costs_material_present_when_no_residual`) pass unchanged.

Snapshot fallout: none. `calc-insights-pure` only probes module constants, `_resolve_duration`,
and `_split_materials` — none of which changed — and matched byte-for-byte; full `verify` run:
10/10 probes match, none re-recorded. `SURFACE.md` did not move: the removed
`_published_brand_counts_by_material` was a method indented inside `CalculatorInsightsService`,
not a module-level `^def`/`^class`, so it was never listed and its removal is invisible to the
generator (confirmed by diffing `gen_surface_calc.sh` output before/after — byte-identical).

## T-119 — 2026-08-24 — a save's success no longer resolves against whatever form is open when it lands (user-approved behavior change)

`useEntityCrudMutations` (`frontend/src/components/calculator/calculatorSettingsShared.ts`) is the
shared save/delete `useMutation` pair behind `CalculatorFilamentsPanel` and
`CalculatorPrintersPanel`. Its save mutation's `onSuccess` used to read the panel's `editing` state
directly from an enclosing closure: `showToast(t(editing === 'new' ? createdMsg : updatedMsg));
onSaved();`. Confirmed in `@tanstack/query-core` before changing anything (as directed): React
Query v5's `useMutation` re-runs `observer.setOptions(options)` in a `useEffect` on *every* render
(`node_modules/@tanstack/react-query/src/useMutation.ts`), and `MutationObserver#setOptions`
propagates that straight onto the in-flight `Mutation` — `if (this.#currentMutation?.state.status
=== 'pending') this.#currentMutation.setOptions(this.options)`
(`node_modules/@tanstack/query-core/src/mutationObserver.ts`) — and `Mutation#execute` later reads
`this.options.onSuccess` (not a value captured at the moment the mutation started)
(`node_modules/@tanstack/query-core/src/mutation.ts`). So a save's `onSuccess` ran against
whichever `editing` was current *when the response landed*, not whichever it was *when the save
was issued*. Neither panel disables its Cancel button while saving
(`CalculatorFilamentsPanel.tsx`, `CalculatorPrintersPanel.tsx`), so: edit filament X, hit Save
(slow), Cancel before it resolves, open a different form (edit filament Y, or "Add filament") and
start typing, then let X's save land — `onSaved()` (`setEditing(null)`) fired unconditionally,
closing Y's form and discarding everything typed into it, with a toast worded for whichever action
`editing` most recently implied rather than the one the landed save actually performed.

Reproduced first, before changing the fix code: added a test to
`frontend/src/__tests__/components/CalculatorSettingsPanels.test.tsx` that edits a filament, saves
it against a `vi.spyOn(api, 'updateCalculatorFilament')` mock returning a manually-controlled
Promise, cancels before that promise resolves, opens the "Add filament" form and types into its
Brand field, then resolves the deferred update. Against the pre-fix hook the test failed:
`findByText('Filament updated', ...)` timed out (the toast said "Filament added" instead — named
from whatever `editing` had become, not from what the landed save had actually done) and the DOM
dump at the point of failure showed the Add form already gone, back to the list view (`onSaved()`
had fired and cleared `editing`, discarding the "Prusament" the test had just typed). After the
fix, the same test passes: the toast reads "Filament updated" and the Add form's Brand field still
holds "Prusament".

Fix: `useEntityCrudMutations` now snapshots `editing` into a local (`const snapshot = editing`) at
the moment `save()` calls `saveMutation.mutate(data, { onSuccess: ... })`, and supplies that
`onSuccess` as a **per-call** option rather than as one of `useMutation`'s own base options.
Per-call `mutate(variables, options)` options are captured once in
`MutationObserver#mutate`'s private `#mutateOptions` and are never refreshed by `setOptions` —
only the *base* options are — so the closure over `snapshot` genuinely stays fixed to the save
that issued it. The toast is chosen from `snapshot` (`snapshot === 'new' ? createdMsg :
updatedMsg`), naming the action that specific save actually performed. `onSaved()` is called only
when `snapshot` still matches `editing` *as of when the response lands* — read through a plain
ref (`editingRef.current = editing`, updated every render) rather than a second closure, since a
second closure captured at the same moment as the fix's own `onSuccess` would have exactly the
staleness problem being fixed. Entities are compared by id (falling back to `snapshot === current`
for `'new'`/`null`) so a same-entity re-open surviving an unrelated background refetch (a new
object, same id) still counts as the same form. `mutationFn` itself was left reading the enclosing
`editing` directly — it only runs synchronously inside the `mutate()` call that issues the request,
before any later render could move `editing` out from under it, so it was never part of this bug.
The auditor's suggested second line of defence (disabling Cancel while `isPending`) was
deliberately **not** added — it's a separate, unapproved UI change, and the approved behavior
explicitly covers the case where the operator has *already* cancelled.

No panel call site changed: both `CalculatorFilamentsPanel.tsx` and `CalculatorPrintersPanel.tsx`
still call `saveMutation.mutate(data)` exactly as before — the hook returns
`{ ...saveMutation, mutate: save }`, so only `.mutate` itself is swapped for the snapshotting
wrapper; `.isPending` and everything else callers read is untouched.

Approved user-facing description, quoted verbatim: "A filament or printer save that finishes after
you have already cancelled it and opened a different form will no longer close that second form
and throw away what you typed, and its confirmation message will name the right action."

Tests: the new failing-then-passing regression test above, plus all 61 pre-existing tests in
`CalculatorSettingsPanels.test.tsx` (including T-124's six error-path tests) pass unchanged — 62/62
in the file. Full frontend suite: 4,863-4,868/4,869 pass depending on host load; every failure seen
was in a file already on the KNOWN FLAKY list (`ModelViewerModal.test.tsx`, `PrintModal.test.tsx`,
`StatsPageUserFilter1894.test.tsx`) and passed in an isolated rerun on an idle machine.

Snapshot fallout: none — this is a frontend-only change to a hook's internals. Full `verify` run:
10/10 probes match, none re-recorded. `SURFACE.md` did not move (diffed byte-for-byte before/after
`gen_surface_calc.sh`): `useEntityCrudMutations` was already a module-level export before this
change and its signature (parameters and return shape) is unchanged; only the function body moved.

## T-117 / T-120 follow-up — 2026-08-24 — gate caught two undisclosed behavior changes in the fix above; both reverted

The blind verifier failed the iteration that shipped the T-117/T-120 fix above. Its single-query
`GROUP BY upper(brand), upper(material)` re-implementation, folded in Python, changed two things
the changelog entry above never claimed and no one approved:

- **Order.** The old (pre-fix) `_spool_costs` queried `GROUP BY upper(material)` alone and
  returned rows in whatever order SQLite's grouping produced for that query — empirically,
  ascending alphabetical by `upper(material)` (confirmed by driving `loop-15`'s actual service
  against 2,800 randomized inventories; see below). The fix's `GROUP BY upper(brand),
  upper(material))` changed the physical sort key, so `material_totals` (built by iterating those
  rows and taking first-appearance order per material) came out primarily ordered by *brand*, with
  material only a tiebreak — a different order whenever a material had multiple brands or the
  brand-sort put two materials in a different relative position than the material-sort would have.
  This is observable: `frontend/src/utils/calculatorInsights.ts` finds the first fuzzy
  (substring-either-way) match in `spool_cost_by_material`, so `PLA` vs. `PLA-CF` or `PET` vs.
  `PETG` resolving to the wrong row was a direct, silent consequence of the reorder.
- **Average.** The old query computed each material's average with a single SQL `avg()` over every
  row for that material. The fix instead summed `func.sum(cost_per_kg)` per brand+material group in
  SQL, then re-summed those partial sums and divided in Python. Floating-point addition is not
  associative, so re-grouping the same values into different partial sums before adding them can
  flip the last ULP of the total and, with it, the 2-decimal-place rounding (3 of 400 randomized
  inventories reproduced a one-cent divergence during triage).

Neither was intentional; neither is in the approved user-facing description above (which covers
only the empty-string-brand residual reappearance). Both are reverted here, without touching either
approved fix (T-117's predicate, T-120's single read).

**Fix**: `_spool_costs` now issues one `UNION ALL` of two independently-grouped branches in a
single `db.execute()` — still one read, still one snapshot, so T-120 (no cross-statement
inconsistency) still holds:
- `material_agg`: `SELECT 'material', NULL, upper(material), avg(cost_per_kg), count(id) ...
  GROUP BY upper(material)` — byte-for-byte the same query the pre-fix code ran standalone, so its
  `avg()`/`count()` values and its row order are exactly what that query has always produced. No
  Python re-summation of partial sums; SQL's own float accumulation is used, unchanged.
- `brand_agg`: `SELECT 'brand', upper(brand), upper(material), NULL, count(id) ... GROUP BY
  upper(brand), upper(material))` — the same grouping `_spool_costs_by_brand` uses, feeding the
  published-brand subtotal.

`material_totals` is now populated only from `kind == 'material'` rows, in the order they arrive —
i.e. exactly `material_agg`'s (= the original standalone query's) order, regardless of how
`brand_agg` rows are interleaved with them in the unioned result. `published_brand_counts` is
folded from `kind == 'brand'` rows with T-117's exact predicate (`if brand and count >=
MIN_SAMPLE`), unchanged. The per-material total is still a true superset of every brand subgroup
(NULL- and empty-string-brand included) because `material_agg` has no brand predicate at all —
it's the same query that has always produced that total.

**On the order**: the task that caught this warned not to assume `sorted(material_totals.items())`
would reproduce the old order without checking. It wasn't checked here, because it wasn't needed —
`material_agg` isn't a *re-derivation* of the old order, it's *the same SQL statement* (as a UNION
ALL branch) that produced it before, so there is no separate ordering claim to verify beyond
confirming UNION ALL doesn't reorder a branch's own rows relative to each other (verified: see
below). Whether that order is itself "defined" by anything beyond SQLite's current query-planner
behavior for an unindexed `GROUP BY` is a separate question this fix does not need to answer, and
does not change: the requirement was byte-for-byte parity with `loop-15`, not a principled
ordering, and reusing `loop-15`'s exact query text is the only way to get that without gambling on
an assumption.

**On the average**: the `UNION ALL` of the verbatim old query, above, rather than a window function
or Python re-summation. A `func.avg(...).over(partition_by=...)` was considered, but it would
either (a) run over the already-brand-grouped rows, averaging *group averages* rather than raw
values (wrong, and not equal to the old computation), or (b) require restructuring the query around
raw per-spool rows to get a true full-population window average, which is a materially different
query shape from the one being reproduced and would need its own byte-for-byte proof rather than
inheriting one for free. Issuing the original query verbatim as one UNION ALL branch sidesteps the
question entirely — it cannot drift from what it always computed, because it's the same statement.

**The differential**: built a throwaway `git worktree add <scratch> loop-15`, loaded both
`calculator_insights.py` module files (HEAD and `loop-15`) via `importlib` against a shared
in-memory SQLite database (models are identical between the two revisions — diffed, no changes),
and drove `_spool_costs` on both over randomized inventories seeded with: multiple brands per
material, empty-string brands, NULL brands, materials that are substrings of one another (`PLA` /
`PLA-CF` / `PLA-CF-XL`, `PET` / `PETG`), mixed case, non-ASCII brand values (`café`, `北京` — SQLite's
`upper()` is ASCII-only, left as-is), and archived/priceless spools. 2,800 trials across two runs
(seeds `1234`/800 trials, `987654`/2,000 trials, plus a targeted deterministic replay of the
changelog's own empty-string-brand example): **0 unsanctioned differences.** 7 trials produced a
difference, and in every one it was exactly the sanctioned shape — a material present in HEAD's
output that is absent from `loop-15`'s (never the reverse, never a value change, never a reorder of
any material both outputs share), landing in its correct alphabetical slot relative to the
materials already present (e.g. trial 504/seed 987654: HEAD returned `[ABS, PET, PLA, PLA-CF,
PLA-CF-XL]` where `loop-15` had `[ABS, PET, PLA-CF, PLA-CF-XL]` — `PLA` appears, in place, nothing
else moves). Separately confirmed the UNION ALL's `material_agg` branch alone reproduces the
standalone pre-fix query's row order and `avg()`/`count()` values exactly across 200 additional
trials before wiring it into the real fix. The scratch worktree was removed
(`git worktree remove --force`) and pruned; `git worktree list` shows only the real checkouts.

Tests: `backend/tests/unit/test_calculator_insights.py` — all pre-existing tests (66 in the file,
including the T-117/T-120 empty-string-brand and multi-brand-residual tests above) pass unchanged;
none of them pinned an order or an exact float average, which is exactly why this regression
shipped past them and needed the differential above to catch and prove fixed rather than a unit
test. Full backend suite: 11,758 passed, 1 skipped (matches baseline; no new failures). Full
frontend suite: `CalculatorSettingsPanels.test.tsx` 63/63 (one test added — see below); full-suite
runs saw failures confined to `PrintModal.test.tsx`, `ModelViewerModal.test.tsx`,
`StatsPageUserFilter1894.test.tsx`, all on the KNOWN FLAKY list and confirmed passing in an
isolated rerun.

Coverage: backend scoped 712/716 = 99.44% (unchanged from the T-117/T-120 measurement, 711/715 =
99.44% — net +1 statement/+1 covered from this fix's larger query construction, ratio unchanged,
still above the 97.76% floor). Frontend scoped 1017/1097 = 92.7% statements (up from the prior
996/1097 = 90.79%, from the new test below; above the 87.32% floor).

Snapshot fallout: none. `calc-insights-pure` does not probe `_spool_costs` (only module constants,
`_resolve_duration`, `_split_materials`). Full `verify` run: 10/10 probes match, none re-recorded.
`SURFACE.md` regenerated and diffed byte-for-byte identical to before this fix.

### Companion: mutation-testing gap in the T-119 test, closed

The verifier also mutation-tested `useEntityCrudMutations`'s `sameTarget` check (T-119, above) and
found that neutering `snapshot.id === current.id` (replacing it with `false`) left all 62
pre-existing frontend tests green — the existing "different form stays open" test never reaches
that branch (it short-circuits on `snapshot === current` being false for a `'new'` target without
ever comparing ids), and nothing else exercised the same-entity-reopened case.

Added `closes the form when its own save resolves after the same row was reopened for editing via
a refetched object` to `CalculatorSettingsPanels.test.tsx`: edits filament X, hits Save against a
deferred (never-auto-resolving) mock, Cancels before it resolves, then — critically — triggers a
simulated background refetch (`queryClient.invalidateQueries`, the same pattern the T-031 tests
already use for `CalculatorDefaultsPanel`) after mutating an unrelated field (`updated_at`) on the
seed row, forcing React Query's default structural sharing to hand back a **new object reference**
for the same id rather than reusing the original. Reopens the same row (now a different object,
same id) and lets the stale save land. Asserts the form closes (back to the "Add filament" listing
control, edit fields gone).

The refetch step is load-bearing and was verified necessary, not decorative: without mutating an
unrelated field before invalidating, React Query's structural sharing reuses the exact same object
reference for an unchanged row on refetch, so `snapshot === current` would already be true and the
id-comparison branch would never run — confirmed by instrumenting the hook temporarily and
observing `snapshot === current` was `true` post-refetch when the seed data was left unchanged,
and `false` (same id, different reference) once an unrelated field was mutated first.

Mutation evidence: reverted `snapshot.id === current.id` to `false` in
`calculatorSettingsShared.ts` — the new test failed (`findByRole('button', { name: 'Add filament'
})` timed out; the form never closed). Restored the source (diffed byte-for-byte identical to
before) — the new test, and all 63 tests in the file, pass again.

## T-121 — 2026-08-24 — the daily-hours "Update profile" action is now withheld when it would post a value the API rejects (user-approved behavior change)

Audit `audit-robustness` found that `CalculatorRealityCheckCard`'s power/dailyHours "Update
profile" action posted `check.measured` straight through, but `CalculatorPrinterUpdate.
daily_usage_hours` is bounded `gt=0, le=24` (`backend/app/schemas/calculator.py`), and — unlike
every other reality-check aggregate — `_daily_usage` (`calculator_insights.py`) publishes its
`hours_per_day` figure with no plausibility band of its own. A handful of very short or
overlapping print-log entries can therefore produce a measured value that, once rounded the way
the button posts it (`Math.round(measured * 10) / 10`), is `0` or exceeds `24` — a value the API
always 422s. The button offered itself anyway and always failed, and the toast for an array-shaped
422 detail shows only the field-name-stripped message ("Input should be greater than 0"), with no
indication of which field or why.

The user approved exactly one remedy, narrower than either option the auditor offered: the button
stops being offered for a measured figure the server would refuse (posts to `0` or below, or above
`24`), instead of showing a button that always fails with a cryptic error. Explicitly **not**
approved: hiding the reality-check row itself (the auditor's other option — the row and its
assumed/measured figures stay visible and informative regardless of whether the action is
offered), clamping the posted value to the nearest valid figure (would silently post a number the
operator never saw or chose), and adding a plausibility band to `_daily_usage` in the backend (the
auditor's other suggested remedy — no backend file was touched).

The power branch was read against its own bound (`power_watts`: `gt=0, le=100_000_000` via
`_MONEY_CEILING`) and found NOT to have the same hazard: its source, `_power_draw`, filters to an
`implied_watts` band of `[1, 3000]` W before ever publishing a row, comfortably inside the backend
bound after `Math.round`. No guard was added to the power branch — it was not broken.

**User-visible effect:** for a `dailyHours` reality-check row, the "Update profile" button no
longer appears when the row's measured figure, rounded to one decimal the way the button already
posts it, is `<= 0` or `> 24`. The row itself (label, assumed value, measured value, dismiss/apply
controls) is unchanged and still shown. The `power` row and its button are unaffected.

Implemented as a pure `postableDailyUsageHours(check)` helper in
`CalculatorRealityCheckCard.tsx` that recomputes the exact value `onUpdatePrinterProfile` would
post and returns `null` when it falls outside `(0, 24]`; the button's render condition now checks
this in addition to the existing `canUpdate`/`printerId` gates. `CalculatorPage.tsx` (the call
site) needed no change — `onUpdatePrinterProfile` itself is untouched, and the value the card now
posts is byte-identical to before whenever it is in range.

New tests in `CalculatorRealityCheckCard.test.tsx` (a new file — the component had no direct test
coverage before this) pin both rounding boundaries exactly: `0.04h` (posts `0`, rejected — no
button, row still visible with both figures shown), `0.05h` (posts `0.1`, accepted — button
present, click posts `{ daily_usage_hours: 0.1 }`), `24.04h` (posts `24`, accepted — button posts
`{ daily_usage_hours: 24 }`), `24.05h` (posts `24.1`, rejected — no button, row still visible).
Mutation evidence: replaced the guard's `posted > 0 && posted <= 24 ? posted : null` with a bare
`return posted;` (always postable) — the two out-of-range tests failed exactly as expected (the
withheld button was found present); the two in-range tests still passed. Reverted (diffed
byte-for-byte identical to before) — all four tests pass again. The pre-existing
`CalculatorPage.test.tsx` printer-profile-update test (measured `8` h/day, well in range) was
re-verified unaffected in isolation.

Coverage: frontend scoped (`bash tools/coverage_calc.sh frontend`) measured 90.75% statements
(1001/1103) — above the 87.32% floor and within the documented ~2-point swing of the prior
90.79% reading (996/1097); the small denominator growth is the new guard function itself.
`ruff`/backend untouched (frontend-only change). `npx eslint` and `npx tsc -b --noEmit`: clean.
`tools/snapshot.py verify`: 10/10, none moved (frontend-only change; no probe covers this
component). `SURFACE.md` regenerated and diffed byte-for-byte identical to before this fix.

CalculatorPage.test.tsx and PrintModal.test.tsx both flaked under host load spikes (load average
~45) during verification; both were confirmed to flake identically on the unmodified tree via a
stash-based control run (same failures, same tests, with this fix's diff stashed out), and both
pass cleanly in isolation once load settles — pre-existing, unrelated to this fix.

## T-122 — 2026-08-24 — the calculator defaults form now refuses to submit an out-of-range value and marks the offending field, instead of silently discarding every edit (user-approved behavior change)

Audit `audit-robustness` found `CalculatorDefaultsPanel`'s Save gate checked only `n >= 0` per
field, while `CalculatorDefaultsUpdate` (`backend/app/schemas/calculator.py`) bounds every field
tighter: `tax_pct` `le=100`, `default_difficulty_pct` `ge=100`, the eight rate fields `le=1000`,
and the four money fields (`electricity_tariff`, `labor_rate_per_hour`,
`consumables_packaging_flat`, `base_fee_flat`) `le=_MONEY_CEILING` (100,000,000). Typing an
out-of-range value (e.g. `150` into Tax %, or `50` into Default difficulty — which the form
presents as an ordinary non-negative percentage) left Save enabled; the PATCH then 422s, the
frontend's error surfacing strips pydantic's `loc`, and the operator sees a bare message like
"Input should be less than or equal to 100" against a form of thirteen fields with no indication
which one broke — and every other field they'd edited in the same pass is discarded along with the
bad one.

The user approved both halves of a single remedy: the form refuses to submit an out-of-range
value AND marks the specific offending field, rather than only disabling Save with no explanation.

Bounds were transcribed by hand from `CalculatorDefaultsUpdate` (not the auditor's summary, which
was verified and found accurate): all thirteen `ge`/`le` pairs use `ge`, not `gt` — no field in
this schema rejects `0` the way `gt=0` would, so the existing `n >= 0` check had no live "accepts
zero when the server doesn't" defect in this specific class (unlike, e.g., `cost_per_kg` elsewhere
in the same file, which is out of this task's scope). `default_difficulty_pct`'s `ge=100` is the
one an operator is most likely to trip: the form has no visual cue that 100 is the floor, not an
ordinary 0-based percentage, so its inline message names the real bound ("Must be between 100 and
1000") rather than a generic "invalid".

**User-visible effect:** each of the thirteen fields in `CalculatorDefaultsPanel` now shows its
own inline error (NumberField's existing `error` prop — no changes to NumberField itself) when its
typed value parses but falls outside the field's server-side bound, and Save stays disabled while
any field is out of range — mirroring the exact bound the backend enforces, not a generic
non-negative check. An empty field is unchanged: still blocks Save (via `required` plus the
existing null-parse check) but is not additionally flagged with a range message, since "out of
range" would misdescribe an empty box.

Implemented entirely in `CalculatorDefaultsPanel.tsx`: `DefaultsField` gained `min`/`max`, each of
the thirteen `DEFAULTS_FIELDS_GENERAL`/`DEFAULTS_FIELDS_FILAMENT` entries now carries its
transcribed bound (money fields share a local `MONEY_CEILING = 100_000_000` constant, mirroring
the backend's `_MONEY_CEILING`), a new `fieldErrors` map replaces the old boolean-only `allValid`
scan and is threaded into each `NumberField`'s `error` prop via `renderFields`, and `allValid` now
checks `n >= min && n <= max` per field instead of `n >= 0`. The bounds table was deliberately kept
module-private (not exported from `CalculatorDefaultsPanel.tsx` or moved into
`calculatorSettingsShared.ts`) so this fix does not widen the campaign's frozen `SURFACE.md`
contract — `calculatorSettingsShared.ts` itself is untouched. A new i18n key,
`calculator.valRange` ("Must be between {{min}} and {{max}}" in `en`, translated — not
copied — into all twelve other locales), supplies the message; `node scripts/check-i18n-parity.mjs`
passes with all thirteen locale leaf counts equal (6868 each).

New tests in `CalculatorSettingsPanels.test.tsx`: an out-of-range value (`tax_pct` = 150) marks
that field's own inline error and disables Save while leaving a legitimate same-pass edit
(`electricity_tariff` = 150) intact in the form; fixing the value back in range clears the mark and
re-enables Save; `default_difficulty_pct` = 50 is pinned specifically, asserting the inline message
names the real 100..1000 bound. A further `it.each` test drives all thirteen fields' own rendered
inputs directly (by `#calc-def-<key>` id) to `max + 1` and back to `max`, asserting the panel names
the exact transcribed `min`/`max` and toggles Save accordingly for every field — pinning the
client's mirror of the schema behaviorally (DOM-driven) rather than by importing the now-private
bounds table, so a schema bound that drifts from this table fails a user-facing assertion instead
of a bookkeeping one.

Mutation evidence: (1) disabled the `fieldErrors` guard (`if (false && ...)`) and reverted
`allValid` to the old `n >= 0` check — all three new behavioral tests and all thirteen `it.each`
mirror-test cases failed as expected (16 failures), reverted, all 79 tests in the file pass again.
(2) separately mutated `default_difficulty_pct`'s transcribed `min` from `100` to `0` in
`CalculatorDefaultsPanel.tsx` alone (leaving the test's own transcription at `100`) — both the
mirror-test case for that field and the dedicated `default_difficulty_pct` behavioral test failed
as expected; reverted, `git diff` on that file clean again.

Coverage: `bash tools/coverage_calc.sh frontend` measured 92.69% statements (1028/1109) across
three consecutive runs (identical figure every time) — above the 87.32% floor and the prior 90.75%
baseline. Each run had 2-5 transient test failures confined to `CalculatorPage.test.tsx`,
`PrintModal.test.tsx` and `StatsPageUserFilter1894.test.tsx` (all three already on this campaign's
documented flaky list); all three files were re-run in isolation and passed cleanly (120/120),
confirming host-load flake unrelated to this change. `npx eslint` and `npx tsc -b --noEmit`:
clean. `tools/snapshot.py verify`: 10/10, none moved (frontend-only change). `SURFACE.md`
regenerated and diffed byte-for-byte identical to before this fix (the bounds table's
module-private status was chosen specifically to keep this true).

## T-129 — 2026-08-24 — user-approved behavior change

T-129: `_finite_safe_validation_exception_handler` (`backend/app/main.py`, added by T-071) no
longer echoes a rejected password/token/secret back verbatim in a 422 body's
`errors()[i]["input"]`. This handler is **app-global** — it is registered on `app`, not any one
router, so it renders every `RequestValidationError` in Bambuddy, including the unauthenticated
routes in `PUBLIC_API_ROUTES` (`/auth/login`, `/auth/setup`, `/auth/forgot-password/confirm`).
Before this fix, a rejected `password`/`new_password`/`current_password` (e.g. one over
`LoginRequest`'s `max_length=256`) was returned to the caller in cleartext inside `input`.

A new `_is_secret_field_loc(loc)` helper matches the LAST element of a Pydantic error's `loc`
tuple (the field name) case-insensitively against five base terms —
`password`, `token`, `secret`, `api_key`, `access_code` — either as an exact match or as an
`_`-joined suffix (`field == suffix or field.endswith("_" + suffix)`). The five terms were chosen
by grepping every field name in `backend/app/schemas/*.py` that plausibly carries a credential
(`grep -rniE "password|token|secret|api_key|access_code|passphrase|pin|otp|webhook"`); the
suffix-match shape (rather than an exhaustive exact-name list) was chosen because the codebase's
real secret fields are almost all compound names built from one of these five roots —
`admin_password`, `smtp_password`, `mqtt_password`, `ldap_bind_password`,
`access_token`/`pre_auth_token`/`setup_token`/`auth_token`/`app_token`/`bot_token`/`ha_token`/
`oidc_token`/`prometheus_token`/`obico_ml_token`/`zoho_refresh_token`, `client_secret`/
`zoho_client_secret`, `openrouter_api_key`, `virtual_printer_access_code` — so an exact-name list
would have missed all of them. `passphrase`, `pin` and a bare `webhook_secret` were considered
(the task briefing named them explicitly) but are not used as a field name anywhere in the
schemas today, so they were left out rather than guessed at; `secret` and `webhook_secret`-shaped
names are still covered by the `secret` suffix. Matching is on the field name only, not the
route — the approved wording is about password-like fields generally, and matching by route
(the audit's offered alternative) would have both under-redacted secrets on non-auth routes
(e.g. `mqtt_password`, `zoho_client_secret`, `openrouter_api_key` are all set through
`/settings`, not `/auth`) and over-redacted ordinary auth-route fields like `username`.
Substring (not suffix) matching was rejected: it would also redact `password_hint`-shaped names
in list contexts; a `TestIsSecretFieldLoc::test_does_not_match_unrelated_field_names` case pins
`passwordless_login_enabled` and `tokenizer` as still returned verbatim. `loc` elements can be
ints (list indices); `_is_secret_field_loc` returns `False` on a non-`str` last element rather
than raising.

The new `_redact_secret_inputs(errors)` walks the flat list `exc.errors()` returns (one pass, no
recursion — it does not walk *inside* a matched `input` value, so it adds no recursion depth of
its own) and replaces `input` with the literal string `"[redacted]"` for a matched field, leaving
`type`, `loc`, `msg` and `ctx` untouched — a caller still learns which field was rejected and why,
per the approved wording ("show a placeholder instead of the value"), not that the field is
silently dropped. It composes with T-071's existing `_stringify_non_finite` by running first:
`_stringify_non_finite(_redact_secret_inputs(jsonable_encoder(exc.errors())))`. A non-finite value
in a non-secret field is unaffected and still stringified exactly as before (T-071's crash-avoidance
reason for existing is unbroken). No field in the current schemas is both secret-named and
float-typed, so a non-finite value in a secret field is synthetic today; it was still pinned: since
redaction replaces `input` outright, the raw `inf`/`nan` never reaches `_stringify_non_finite` at
all — it is discarded along with the rest of the value, rather than being stringified into the
response. The recursion-depth threshold T-071's snapshot pinned (988) is unaffected: the new walk
is O(number of errors), not a recursive descent into nested `input` values, so it cannot change
where the existing recursive walk in `_stringify_non_finite` (itself untouched) crashes.

New tests in `backend/tests/unit/test_main_validation_handler.py`: `TestIsSecretFieldLoc` pins the
matcher against every secret-bearing field name found in `backend/app/schemas/*.py` plus
case-insensitivity, and against non-secret fields (including the `passwordless_login_enabled`/
`tokenizer` over-redaction traps and bare `code`/`key` substrings) and int `loc` elements.
`TestRedactSecretInputs` pins: a secret field's `input` replaced with `"[redacted]"` while `type`/
`loc`/`msg`/`ctx` survive; a non-secret field's `input` returned verbatim (proves no
over-redaction); a non-finite value in a secret field discarded rather than stringified; a
non-finite value in a non-secret field still stringified after composing with the redaction pass;
mixed secret/non-secret errors in one response redacted selectively; an error dict with no `input`
key left alone. `TestLoginRedactsPasswordEndToEnd` drives the real handler through
`POST /api/v1/auth/login`: an over-length password is rejected with `input == "[redacted]"` and
the submitted password string does not appear anywhere in the response body/text, while an
over-length `username` on the same request is still returned verbatim.

Mutation-tested: emptied `_redact_secret_inputs`'s body to a no-op passthrough — the secret-field
unit tests and the end-to-end login test failed as expected (4 failures: placeholder assertion,
non-finite-in-secret-field assertion, mixed-errors assertion, end-to-end login assertion); the
non-secret-field tests kept passing (proving they'd catch over-redaction, not just under-redaction);
reverted, `git diff` on `backend/app/main.py` clean.

Full backend suite: 11,800 passed, 1 skipped (was 11,758 before; +42 new tests, no new failures).
`tools/coverage_calc.sh backend` (the calculator-scoped gate; `main.py` is deliberately outside its
file list): 712/716 = 99.44% statements, unchanged from the prior measurement — expected, since this
change touches only `main.py`, which the gate does not measure. `tools/snapshot.py verify`: 10/10
match, none moved — `calc-openapi` and `calc-pydantic-schemas` were checked specifically and did not
move, since this is a change to global error-rendering, not to the calculator's request/response
schemas. `SURFACE.md` regenerated and diffed byte-for-byte identical to before this fix.

user-approved 2026-08-24: "When a request is rejected for bad input, the error Bambuddy sends back
would no longer repeat the exact value you typed for password-like fields — it would say the field
was rejected and why, but show a placeholder instead of the value. Nothing in the Bambuddy web UI
displays that value today, so you would see no difference; only a third-party tool that reads the
raw error payload would notice." Blast radius stated explicitly: this handler is app-global, so the
redaction applies to every route in Bambuddy that returns a 422, not only the calculator or the
auth routes named in the audit evidence.

## T-130 — 2026-08-24 — `time_accuracy.by_printer` now gates on MIN_SAMPLE, not a bare `3` (user-approved behavior change)

T-130: `_time_accuracy` (`backend/app/services/calculator_insights.py`) publishes two figures —
an `overall_pct`/`sample` pair with no MIN_SAMPLE-style gate of its own (only `if accuracies else
None`, unaffected by this fix and left alone), and a `by_printer` list, one row per printer. The
`by_printer` row list alone was gated on a bare literal `if len(values) >= 3`, unlike every other
grouping in this service (`_failure_rates.by_printer`/`by_material`, `_power_draw.by_printer`,
`_daily_usage`, and both spool-cost aggregates), which all gate on the module's `MIN_SAMPLE = 5`
floor. A printer with as few as 3 slicer-estimate-vs-actual comparisons could publish an
`accuracy_pct` to `CALCULATOR_READ` — the module's own docstring states "Groups with fewer than
`MIN_SAMPLE` runs are suppressed", and 3 broke that invariant. The fix changes the one comprehension
filter from `if len(values) >= 3` to `if len(values) >= MIN_SAMPLE`. No other line changed.

user-approved 2026-08-24: "A printer that has only three or four completed prints with a slicer
estimate to compare against would stop showing its 'measured print time vs estimate' suggestion in
the calculator's reality-check panel; the suggestion would reappear once that printer has five such
prints." This explicitly selects raising the floor to `MIN_SAMPLE` over the audit's other offered
option (naming `3` as a documented, deliberately-lower module constant) — rows disappearing below
5 samples is exactly what only the first option produces.

Tests updated in `backend/tests/unit/test_calculator_insights.py` to use `MIN_SAMPLE` (not `3`)
runs wherever a test needed a printer's `by_printer` row to survive the gate:
`test_time_accuracy_with_band_clamp`, `test_time_accuracy_resolved_purely_from_timestamp_fallback`,
`test_unknown_printer_falls_back_to_hash_id_label` (counts and derived sums recomputed: 20 total
runs, 3.5 h/day usage), and the T-076 differential test's own reference implementation
(`_reference_time_accuracy`) and dataset builder (`_build_time_accuracy_dataset`), whose `p_low`/
`p_exact`/`p_high` printer counts were re-pinned to `MIN_SAMPLE - 1` / `MIN_SAMPLE` /
`MIN_SAMPLE + 1` so the SQL-pushdown-equivalence test still exercises the gate at its real boundary
instead of a stale one. Two new tests pin the boundary directly:
`test_time_accuracy_by_printer_suppressed_below_min_sample` (`MIN_SAMPLE - 1` runs → `by_printer ==
[]`, `overall_pct` still present) and `test_time_accuracy_by_printer_published_at_min_sample`
(`MIN_SAMPLE` runs → one `by_printer` row).

Mutation-tested: reverted `>= MIN_SAMPLE` back to the original `>= 3` — the new boundary test
(`test_time_accuracy_by_printer_suppressed_below_min_sample`) failed as expected (4 samples
produced a `by_printer` row instead of `[]`); reverted, `git diff` on `calculator_insights.py`
clean.

Full backend suite: 11,813 passed, 1 skipped (a `test_library_slice_api.py` failure under `-n 30`
parallel load was confirmed pre-existing/flaky — passes alone in isolation, per the known
suite-load-flake pattern; unrelated to this change). `tools/coverage_calc.sh backend` (the
calculator-scoped gate): 712/716 = 99.44% statements, unchanged from the prior measurement — the
changed line is an inline literal inside an existing method, not a new statement. Probe
`calc-insights-pure` diffed byte-for-byte identical before/after re-running it: it only captures
module-level UPPERCASE constants (`dir(m)` filtered on `k.isupper()`), and the `>= 3` → `>=
MIN_SAMPLE` change is an inline comprehension-filter literal, not a module constant, so the probe
never saw it either way — no re-record needed. `SURFACE.md` regenerated
(`bash tools/gen_surface_calc.sh`) and diffed byte-for-byte identical to before.

T-129 follow-up (rode along in this commit): `_is_secret_field_loc` (`backend/app/main.py`, T-129)
matched a secret-bearing field name via `field == suffix or field.endswith("_" + suffix)`, which
missed run-together spellings with no underscore before the suffix — evidenced by
`CallMeBotConfig.apikey` (`backend/app/schemas/notification.py:230`, an unrenamed field, left
untouched as out of scope), which doesn't end with `_api_key` and isn't equal to `api_key` either.
Swept every field name in `backend/app/schemas/*.py` (1,287 names) and every inline-`BaseModel`
field in `backend/app/api/routes/*.py` (903 names) for both the old rule and a candidate new rule;
the only name that newly matches is `apikey`. The fix strips underscores from both the field name
and the suffix set before comparing (`_SECRET_FIELD_NAME_SUFFIXES_NORMALIZED`), which closes
`apikey` and would also close `authtoken`/`accesstoken`/`clientsecret` if they existed (none do
today) — one general transform over the existing five suffixes, rather than hand-adding each
run-together spelling as its own tuple entry. `passwd`/`pwd` remain uncovered (neither exists
anywhere in this codebase today, confirmed by grep) since they don't end with `password`, not a
prefix/suffix relationship normalization can bridge. New tests in
`test_main_validation_handler.py` pin `apikey`/`ApiKey`/`authtoken`/`accesstoken`/`clientsecret` as
now matching (plus a `_redact_secret_inputs` end-to-end case for `apikey`), and re-confirm every
trap name the gate recorded stays unmatched, including four not previously covered by name in this
file (`password_hint`, `max_tokens`, `token_expires_at`, `password2`, `secrets` — `code`, `key`,
`passwordless_login_enabled`, `tokenizer`, `username` were already pinned). Mutation-tested:
reverted the normalized comparison back to the original suffix-only rule — all 6 new tests failed
as expected (`apikey`, `ApiKey`, `authtoken`, `accesstoken`, `clientsecret`,
`test_run_together_secret_field_input_is_replaced_with_placeholder`); reverted, `git diff` on
`main.py` clean. This is completing T-129's already-approved change correctly ("password-like
fields show a placeholder"), not a new behavior change. `main.py` is outside the coverage gate's
scoped file list, so this follow-up does not move the 99.44% figure (expected, not chased).

---

# Campaign 7 — the filament-profiles Zoho price sync

## Approved 2026-08-25, round 1 — 11 of 11 behaviour-change findings approved by the user

The round-1 panel filed 11 findings whose fixes change something a user observes.
All 11 were quoted verbatim to the user and all 11 were approved. Each is worked
as an ordinary task; the worker must re-record the affected golden probe(s),
update the affected SURFACE.md sections, and append an "applied" line in the SAME
commit, whose message must contain "(user-approved behaviour change)".

| task | approved change (as quoted to the user) |
|---|---|
| T-002 | reason field typed as Literal; response model rejects an unknown outcome instead of passing it through |
| T-005 | presets with empty or unparseable content move out of `unchanged` into the attention list with a new reason string |
| T-006 | an open preset editor picks up changes made underneath it instead of silently reverting a synced price on save |
| T-007 | the Zoho summary panel clears while a sync runs and stays gone when one fails |
| T-008 | the post-sync toast gains a needs-attention count and stops being green when some profiles could not be priced |
| T-009 | cleared credentials / a sync already in flight return 503/409 with a specific message instead of 502 "Could not reach Zoho" |
| T-010 | the attention list shows a truncated set of colliding item names plus a remainder count |
| T-012 | a non-finite or absurd cost per kg is no longer written; the profile is reported as needing attention |
| T-014 | POST/PATCH filament-profiles return 422 for a filename containing '/', '\' or '..' |
| T-015 | a match whose Zoho item name carries no weight is no longer auto-priced; reported for review with a new reason string |
| T-016 | users holding only filaments:read stop seeing the mutating buttons |

NOTE FOR EVERY WORKER: T-005, T-012 and T-015 each introduce a NEW reason string
on the wire. The frontend must render it and all 13 locales must carry the key in
the SAME commit, or the sync shows a raw i18n key to non-English users. The
fp-i18n-sync-strings golden probe checks cross-locale parity and will catch a
partial job.

## applied

- T-005 (2026-08-25, user-approved): `apply_filament_cost` now returns a three-state
  outcome — `"written"` / `"unchanged"` / `"unwritable"` — instead of `(content,
  bool)`. A confident Zoho match whose preset content is empty, unparseable JSON, or
  not a JSON object is no longer counted in `unchanged`; it moves into `attention`
  with a new `reason: "unwritable_content"`, plus a `logger.warning` naming the
  preset id. Wired end-to-end: `FilamentProfilesPage.tsx`'s reason ternary gained a
  dedicated branch (previously fell through to the "no price" copy), the typed API
  client's `FilamentPresetZohoSyncAttention.reason` union gained the new literal,
  and all 13 locale files gained a `syncZohoUnwritable` translation. Re-recorded
  probes: `fp-pricing-write`, `fp-sync-endpoint`, `fp-i18n-sync-strings`,
  `fp-client-method`, `fp-page-sync-ui` — each diff checked to contain only this
  change. `calc-zoho-pure` still matches (calculator untouched). `reason` stays
  typed as plain `str` in the Pydantic schema (Literal typing is T-002's job), so
  OpenAPI/pydantic-schema probes did not move.

- T-006 (2026-08-25, user-approved): frontend-only half. `FilamentProfilesPage.tsx`'s
  `EditorState` now stores only `presetId` for the 'edit' mode instead of the whole
  `FilamentPreset` object; the preset shown in the editor is re-derived from the
  `presets` query cache (`presets.find(p => p.id === editorState.presetId)`) on
  every render, so a `queryClient.invalidateQueries(['filamentPresets'])` — e.g.
  from a Zoho price sync run while the editor is still open — feeds the modal
  fresh data instead of the pre-sync snapshot it was opened with. Because
  `PresetEditorModal` (out of scope for this campaign) only reads its `preset`
  prop through mount-time `useState` initializers, re-deriving the prop alone
  would not have been observed by an already-mounted modal; the page now also
  keys the `<PresetEditorModal>` element on `` `${presetId}-${updated_at}` ``, so
  a content change under an open editor forces a clean remount instead of
  silently doing nothing. Deleted-preset case: if the preset the editor has open
  is removed from the cache (deleted elsewhere) while open, a new effect closes
  the editor on the next render rather than leaving it open on a preset that no
  longer exists. Test added in `FilamentProfilesPage.test.tsx`
  ("re-syncs the open editor with fresh data when a Zoho sync updates the preset
  underneath it") — confirmed it fails without the fix (stale `10` instead of
  refetched `25`) before the fix was reapplied. The optional PATCH
  `updated_at` precondition described in the audit finding is NOT implemented —
  it is an API contract change out of this task's scope and was not approved.
  All 11 golden probes still match, including `fp-page-sync-ui` (its regex only
  checks `zohoSync*` identifiers, untouched here) and `calc-zoho-pure`; SURFACE.md
  regenerated byte-identical to the committed copy, so no probe/contract update
  was needed.

- T-007 (2026-08-25, user-approved): `FilamentProfilesPage.tsx`'s `handleZohoSync`
  now clears `zohoResult` (`setZohoResult(null)`) at the start of the function and
  again in the `catch` block. Previously `zohoResult` was only ever written on
  success, so a failed re-sync left the prior run's summary panel — "Priced 12,
  unchanged 3" plus its needs-attention list — on screen after a transient red
  toast auto-dismissed, asserting a successful sync that did not happen. The
  richer `{status, result}` alternative the audit offered was NOT built; only the
  approved behaviour ("the Zoho summary panel disappears while a sync runs and
  stays gone when one fails") was implemented. The toast call itself (T-008's
  scope) was left untouched. Test added in `FilamentProfilesPage.test.tsx`
  ("clears the previous run summary panel when a later sync fails") — confirmed
  it fails without the fix (times out waiting for the stale "Priced 12" text to
  disappear) before the fix was reapplied. All 11 golden probes still match,
  including `fp-page-sync-ui` and `calc-zoho-pure`; SURFACE.md regenerated
  byte-identical to the committed copy, so no probe/contract update was needed.

- T-008 (2026-08-25, user-approved): `FilamentProfilesPage.tsx`'s `handleZohoSync`
  post-sync toast used to read `t('filamentProfiles.syncZohoDone', { priced,
  unchanged })` unconditionally as a `'success'` toast, so a run where every
  profile came back `no_match` (or otherwise needed attention) — the normal
  outcome the first time an operator's brand strings don't line up with Zoho's
  item names — produced a green "Priced 0, unchanged 0" success notification;
  the needs-attention detail existed only in the summary panel further down the
  page, off-screen on a normal viewport. The toast now appends the existing
  `filamentProfiles.syncZohoAttention` count (`` `${doneMessage} — ${count} need
  attention` ``) whenever `result.attention.length > 0`, and the toast variant
  downgrades from `'success'` to `'warning'` (the only non-green non-error
  variant `ToastContext` provides) whenever `attention.length > 0` OR
  `priced + unchanged === 0`. No new i18n key was needed — both
  `syncZohoDone` and `syncZohoAttention` already existed in all 13 locales and
  were composed together rather than adding a third string; `fp-i18n-sync-strings`
  did not move. `ToastContext.tsx` itself (out of this campaign's scope) was not
  touched. Two tests added in `FilamentProfilesPage.test.tsx` covering both
  triggers named in the approved wording — a run with attention entries, and a
  run where `priced + unchanged === 0` with an empty attention list — asserting
  the toast text includes the attention count and that its border color is not
  the green success color; both confirmed to fail without the fix before it was
  reapplied. Two pre-existing zoho-sync tests were re-scoped from a loose
  `/priced N/i` match to an anchored `` /^Priced N, unchanged N$/i `` match,
  because the toast's text (and, for the warning variant, its longer auto-dismiss
  window already defined by `ToastContext`'s `LONG_LIVED_TOAST_TYPES`) now
  legitimately overlaps with the summary panel's identical prefix — this is
  disambiguation only, no assertion was weakened. All 11 golden probes
  re-verified: only `fp-page-sync-ui` moved (diff is exactly the new toast
  composition in `handleZohoSync`), `fp-i18n-sync-strings` and `calc-zoho-pure`
  still match byte-for-byte. SURFACE.md regenerated byte-identical to the
  committed copy, so no i18n-key-surface update was needed.

- T-009 (2026-08-25, user-approved): `zoho_filaments.py`'s `_fetch_catalogue_or_502`
  — the shared error-mapping helper T-001 extracted, called only by the
  filament-profiles sync route — gained two explicit branches ahead of its
  catch-all. A `ZohoNotConfiguredError` (raised inside `fetch_catalogue`'s
  token refresh if a credential is cleared in Settings in the check-then-act
  window between the route's up-front `is_configured()` check and the walk
  itself) now maps to `503 "Zoho is not configured"` instead of falling into
  the generic 502. A `RuntimeError` whose message is exactly "Zoho filament
  catalogue refresh is still in progress; try again shortly" (raised when
  `_refresh_lock` is held by another in-flight walk past its acquire timeout
  with no cache to answer from) now maps to `409` with that same message as
  its detail, instead of 502. Matched by message-equality against a bare
  `RuntimeError` rather than a dedicated exception type, because `fetch_catalogue`
  itself was out of scope for this change; the two OTHER `RuntimeError`s it can
  raise (`_MAX_PAGES` truncation, and a superseded-generation retry after a
  credential rotation mid-walk) have different text and correctly keep falling
  through to the unchanged `502 "Could not reach Zoho"` fallback. Per the
  user's explicit carve-out, `str(exc)` is deliberately NOT interpolated into
  the fallback 502 detail (kept as the fixed string, to avoid leaking upstream
  exception text into an HTTP response); the underlying exception is still
  logged. Three tests added to `test_filament_profiles_zoho_sync.py`: one per
  new branch (each asserting both the status code and the exact detail
  string), plus a third pinning that a non-`RuntimeError` (e.g. `ValueError`)
  still falls through to the unchanged generic 502 — needed to keep the
  scoped coverage ratchet at its 99.78%-statements baseline, since the new
  `RuntimeError`-specific branch left the pre-existing catch-all's own lines
  unexercised. The existing `test_502_when_zoho_is_unreachable` was
  strengthened (not weakened) to also assert the detail string.
  `backend/app/api/routes/calculator.py` (its own, separate inline copies of
  this mapping) was not touched. All 11 golden probes re-verified: none
  moved — `fp-sync-endpoint` does not exercise either new branch (its stub
  only raises a generic `RuntimeError`/`ZohoFilamentMappingError`/
  unconfigured, and `tools/` is frozen so it could not be extended); the new
  branches are guarded by the new unit tests instead. `calc-zoho-pure`
  still matches byte-for-byte — `fetch_catalogue`, the cache, the generation
  counter, `_refresh_lock`, `_map_item`, `parse_filament_name` and
  `match_profile` were all left untouched. SURFACE.md's "Backend module
  constants" section gained one line (`_SYNC_IN_PROGRESS_DETAIL`, the new
  module constant carrying the lock-busy message) and was regenerated.

- T-012 (2026-08-25, user-approved): `apply_filament_cost` now validates
  `cost_per_kg` before it does anything else — reject non-finite (`inf`,
  `-inf`, `nan`), `<= 0`, or `> 100_000_000.0` — and returns a fourth outcome,
  `"bad_price"`, with the input content returned untouched (not even parsed).
  The guard was put inside `apply_filament_cost` rather than the route: it is
  the function that already owns the outcome enum and does the actual write,
  so validating the value it is about to write is its job, the same way it
  already refuses to write into unparseable content. The ceiling reuses the
  calculator's exact value (100,000,000.0) but as its own module constant,
  `_MONEY_CEILING`, rather than importing the calculator schema's private
  `_MONEY_CEILING` — that name is underscore-prefixed specifically to signal
  it is not for reuse outside `schemas/calculator.py`, and importing across
  a feature boundary for a private symbol is the worse of the two options the
  audit laid out; the constant's docstring comment names the calculator's as
  its source of truth so the two cannot silently diverge unnoticed. The full
  check mirrors the calculator sync's guard at
  `backend/app/api/routes/calculator.py`: `not math.isfinite(...)`, `<= 0`,
  and `> _MONEY_CEILING`, all three — `nan <= 0` and `nan > ceiling` are both
  `False`, so only the `isfinite` check catches a NaN price, and a dedicated
  test pins that. `backend/app/api/routes/filament_profiles.py`'s zoho-sync
  route routes the new `"bad_price"` outcome into `attention` with a new,
  distinct `reason: "bad_price"` — not the existing `"unwritable_content"` —
  because the preset's own file is fine here; it is the upstream Zoho item's
  price that is unusable, and reusing the content reason would tell the
  operator the wrong thing is broken. Wired through all five layers in the
  same commit: `FilamentPresetZohoSyncAttention`'s doc comment in
  `schemas/filament_profile.py`, the typed API client's `reason` union in
  `client.ts`, `FilamentProfilesPage.tsx`'s reason ternary (its own branch,
  not a fallthrough), and the `syncZohoBadPrice` key added to all 13 locale
  files with real, tone-matched translations (not copied English). Eight new
  unit tests in `test_filament_profile_pricing.py` pin every rejected shape
  (`inf`, `-inf`, `nan`, `0.0`, a negative value, a value just above the
  ceiling) and the ceiling boundary from both sides (just below the ceiling
  still writes). Two endpoint-level tests added to
  `test_filament_profiles_zoho_sync.py`: one proving a confident match with
  an infinite price lands in `attention` with `reason: "bad_price"` and
  leaves the preset byte-identical, and one proving a NaN-priced profile does
  not stop a healthy sibling in the same sync run from being priced. A
  frontend test in `FilamentProfilesPage.test.tsx` asserts the new reason
  renders its own copy and never falls through to the "no price" or
  "unwritable content" text. `zoho_filaments._map_item`'s `float()`/`round()`
  and `backend/app/api/routes/calculator.py` were both left untouched, per
  the audit's explicit carve-out. All 11 golden probes re-verified:
  `fp-pricing-write` moved (zero and negative price now produce `bad_price`
  with the content returned as the same object, not a new written string),
  `fp-i18n-sync-strings` moved (the new key in all 13 locales),
  `fp-client-method` moved (the widened `reason` union), and `fp-page-sync-ui`
  moved (the new ternary branch) — all four re-recorded after reading each
  diff. `fp-sync-endpoint` and the other seven probes matched unchanged.
  `calc-zoho-pure` still matches byte-for-byte. SURFACE.md's "Backend module
  constants" section gained one line (`_MONEY_CEILING`) and was regenerated.

- T-013 (2026-08-25, user-approved RETROACTIVELY — this entry was written
  after the fact because the orchestrator originally misclassified the
  change as a pure contract fix and told the worker not to log it; the
  verifier caught the omission and the user then approved the change itself
  on review): `apply_filament_cost` in
  `backend/app/services/filament_profile_pricing.py` only caught
  `json.JSONDecodeError` around `json.loads`, but a preset with
  pathologically deep JSON nesting (e.g. thousands of nested arrays) makes
  `json.loads` raise `RecursionError` instead, which is not a
  `JSONDecodeError` and is not a subclass of `ValueError`. That escaped the
  function uncaught, and `backend/app/api/routes/filament_profiles.py`'s
  zoho-sync route has no exception handling around its per-preset loop, so
  the `RecursionError` propagated all the way out and crashed
  `POST /filament-profiles/zoho-sync` mid-loop, before `await db.commit()`
  — at BASE this preset's pathological content aborted the request with an
  error response and discarded the already-computed prices for every other,
  healthy preset in the same sync run. At HEAD the `except` clause is
  widened to `(ValueError, RecursionError)` — `ValueError` is
  `JSONDecodeError`'s own parent class, so this is a strict widening, not a
  swap. The pathologically deep preset now takes the same `"unwritable"`
  outcome T-005 already modelled for unparseable content: the sync returns
  `200`, that preset is reported in `attention` with `reason:
  "unwritable_content"` and its content untouched, and every sibling preset
  in the same run is still priced and committed. A bare `except Exception`
  was considered and rejected, to avoid also swallowing real programming
  bugs in this function. One unit test added in
  `test_filament_profile_pricing.py` (`test_pathologically_deep_json_is_
  unwritable_not_a_crash`, using the auditor's own repro of `"[" * 120000`)
  and one endpoint-level test added in
  `test_filament_profiles_zoho_sync.py`
  (`test_a_pathologically_deep_preset_does_not_abort_the_whole_sync`)
  proving the healthy sibling is priced and committed in the same request
  that flags the pathological one. All 11 golden probes re-verified: NONE
  moved, including `fp-pricing-write` and `fp-sync-endpoint` — the
  previously-crashing pathological-nesting case was simply never modelled by
  any probe's fixture, so there is no probe diff accompanying this entry.
  That is unusual for an entry in this log and is being stated explicitly so
  a future reader does not go looking for a snapshot diff that does not
  exist: the observable-behaviour change here is real (error response with
  discarded sibling prices, at BASE, versus `200` with `attention` reporting
  and sibling prices committed, at HEAD) and is evidenced by the two new
  tests above, not by a probe. Exact commit: `728c039f4`.

## T-014 — 2026-08-26 — user-approved behavior change

`create_filament_profile()`/`update_filament_profile()` (`backend/app/api/routes/
filament_profiles.py`) stored `filename` on `FilamentPresetCreate`/`FilamentPresetUpdate`
verbatim, with no check that it was a bare file name. `bambu_sync`'s own
`_validate_bambu_sync_presets` requires exactly that — `if not filename or ".." in filename
or "/" in filename or "\\" in filename: raise HTTPException(400, ...)` — and validates the
entire `presets` list from a single request, so one stored preset with a path-shaped
`filename` made `POST /filament-profiles/bambu-sync` (Sync-to-PC) 400 for every preset, not
just the offending one, until the bad row was found and edited. The same unvalidated field is
also used verbatim as the export ZIP entry name in `FilamentProfilesPage.tsx`
(`zip.file(p.filename, p.content)`), so a traversal-shaped filename would end up as a
traversal-shaped entry name in the downloaded archive.

Fixed by adding a `field_validator("filename")` to both `FilamentPresetCreate` and
`FilamentPresetUpdate` in `backend/app/schemas/filament_profile.py`, sharing one
`_validate_bare_filename` helper with the exact same predicate as
`_validate_bambu_sync_presets` (empty, `".."`, `"/"`, or `"\\"` all rejected) so the storage
boundary and the sync boundary can never disagree about what counts as bare. No route code
changed; the validator raises before `create_filament_profile`/`update_filament_profile` ever
run.

Pydantic v2 does not run a field's validator against its own default when the field is
omitted from the request body (confirmed empirically), so `FilamentPresetCreate.filename`'s
`= ""` default and `FilamentPresetUpdate.filename`'s `= None` default both still pass through
untouched when the client sends no `filename` at all — the existing "create/update without a
filename" behavior (`test_create_defaults_absent_fields_to_empty`) is preserved unchanged. An
*explicit* `filename: ""` (or `null` on update) does trigger the new check on create, and an
explicit path-shaped string is rejected on update too; an explicit `filename: null` on update
is deliberately let through the validator (returns early), because `null` is not a path-shaped
value to reject — it flows into the existing, unrelated `value if value is not None else ""`
write path the same as any other explicitly-nulled field on that endpoint, unchanged by this
fix.

user-approved 2026-08-26: "POST /filament-profiles and PATCH /filament-profiles/{id} would
start returning 422 for filenames containing a slash, backslash or '..' that are accepted
today, and any preset already stored with such a filename would fail its next save until
renamed."

Tests added in `backend/tests/integration/test_filament_profiles_api.py`:
`test_create_rejects_non_bare_filename` and `test_patch_rejects_non_bare_filename`
(parametrized over `"a/b.json"`, `"a\\b.json"`, `"../b.json"`, `""`, asserting `422` and, for
the patch case, that the stored row is untouched by the rejected request), and
`test_patch_explicit_null_filename_bypasses_bare_check` pinning the `null`-is-not-path-shaped
carve-out above. No existing test posted a path-shaped `filename` on create/update, so nothing
needed to change to adopt the new behavior.

All 11 golden probes re-verified (`tools/snapshot.py verify`): all 11 match, including
`fp-pydantic-schemas` — `field_validator` has no effect on `model_json_schema()` output (no
`Field(...)` constraint was added), so the probe's captured JSON Schema is unchanged.
`SURFACE.md` regenerated (`bash tools/gen_surface_fp.sh`) and diffed byte-for-byte identical:
the schemas file's only `SURFACE.md` entry is a bare `grep -hoE "^class ..."` over class names,
which doesn't see the new module-level `_validate_bare_filename` function or the new
`field_validator` methods either way.

`tools/coverage_fp.sh backend`: 481/482 = 99.79% statements (up from the 443/444 = 99.77%
baseline; the extra denominator is the new validator code, fully covered by the tests above).
Full backend suite: 12,425 passed, 1 skipped.

## T-002 — 2026-08-26 — `FilamentPresetZohoSyncAttention.reason` tightened to a closed
`Literal` (user-approved behavior change)

`backend/app/schemas/filament_profile.py`'s `FilamentPresetZohoSyncAttention.reason` was a
bare `str` with a comment listing its five legal values (`"no_match"`, `"ambiguous"`,
`"no_price"` — mirroring `zoho_filaments.ProfileMatch.outcome` — plus the route's own
`"bad_price"` and `"unwritable_content"`, both set directly in
`api/routes/filament_profiles.py`'s zoho-sync handler, not part of `ProfileMatch.outcome`).
This is the file's own established convention for a closed string enum elsewhere (15+
`Literal[...]` hits across `backend/app/schemas/`), so it was tightened to
`Literal["no_match", "ambiguous", "no_price", "unwritable_content", "bad_price"]` and the
now-redundant three-value line of the comment was dropped (the two-value explanation for
`"bad_price"`/`"unwritable_content"` stays, since it explains *why* they exist, not what the
type is).

**Deviation from the task's evidence:** the task specified narrowing to only the three
`ProfileMatch.outcome` values (`"no_match"`, `"ambiguous"`, `"no_price"`), on the premise that
"behavior for all currently-possible values is identical." That premise was false — the same
route (`zoho-sync`, `filament_profiles.py:243` and `:262`) also constructs this model with
`reason="bad_price"` and `reason="unwritable_content"` on every normal run where a matched
item has an unusable price or a preset has unparseable content, and four existing tests in
`backend/tests/unit/test_filament_profiles_zoho_sync.py` (lines 138, 167, 202, 302 pre-change)
already assert exactly those two values coming back from a live `POST /zoho-sync` call. A
3-value `Literal` would have turned those two currently-normal, currently-tested code paths
into 500s instead of tightening only against a hypothetical future value, which is a real
regression, not the approved change. The `Literal` was recorded with all five currently-used
values instead, which achieves the task's actual intent (bare `str` + comment → closed enum,
matching the file's convention) with zero behavior change for every value the route can
produce today, and still fails closed on anything else (e.g. `ProfileMatch.outcome`'s own
`"matched"`, which is never passed to this field, or any new value nobody has wired up yet).

user-approved 2026-08-26: fail-closed `Literal` tightening; behavior for all currently-possible
values is identical (given the corrected five-value set above).

Tests added in `backend/tests/unit/test_filament_profiles_zoho_sync.py`:
`test_attention_reason_accepts_every_value_the_route_can_set` (parametrized over all five
legal values, constructing the model directly) and
`test_attention_reason_rejects_an_unknown_value` (asserts `pydantic.ValidationError` for
`reason="matched"`, `ProfileMatch`'s one outcome that is never routed to this field) — pinning
the `Literal` closure itself, on top of the existing endpoint-level tests that already cover
all five values round-tripping through the live API.

`tools/snapshot.py verify`: 10/11 matched unchanged; `fp-pydantic-schemas` legitimately
diffed — `model_json_schema()` now emits an `"enum"` array for `reason` — and was re-recorded
via `tools/snapshot.py record` (only `snapshots/fp-pydantic-schemas.golden` changed; the other
ten golden files were byte-identical after the re-record). `SURFACE.md` regenerated via
`bash tools/gen_surface_fp.sh`; its `FilamentPresetZohoSyncAttention` openapi-schema line
picked up the same `"enum"` array and was updated, then re-diffed byte-identical.

`tools/coverage_fp.sh backend`: 481/482 = 99.79% statements, 108/110 = 98.18% branches —
unchanged from baseline (a `Literal` adds no new executable statements). Full backend suite:
12,432 passed, 1 skipped (up from 12,425 passed, reflecting the two new tests above, one of
them parametrized over five values).

## T-010 — 2026-08-26 — `match_profile()`'s "ambiguous" outcome now caps the reported
collision to 5 names plus a true count (user-approved behavior change)

`match_profile()` (`backend/app/services/zoho_filaments.py`) reported every catalogue item
sharing a profile's brand and material as `ProfileMatch.candidates` on the "ambiguous"
outcome, with no cap. An operator with many hand-typed profiles whose colour string never
appears in Zoho gets one attention entry per profile, each carrying the FULL same-brand-and-
material colour range — worst case bounded only by `_MAX_PAGES x _PAGE_SIZE` (4000 items).
`FilamentProfilesPage.tsx` rendered the whole list as one unwrapped `{candidates.join(', ')}`
line, so a large collision turned the needs-attention report into an unreadable wall of names.

Fixed by adding `_MAX_REPORTED_CANDIDATES = 5` to `zoho_filaments.py` and a new
`ProfileMatch.candidates_total: int` field carrying the TRUE collision size. The "ambiguous"
branch now returns `names[:_MAX_REPORTED_CANDIDATES]` for `candidates` and `len(names)` for
`candidates_total`; every other outcome sets `candidates_total` to `len(candidates)` (0 for
`no_match`, 1 for `matched`/`no_price`), so the field is always present and never a stale-
looking sometimes-omitted value. `FilamentPresetZohoSyncAttention`
(`backend/app/schemas/filament_profile.py`) gained the matching `candidates_total: int = 0`
field, threaded through by `sync_filament_presets_from_zoho`
(`backend/app/api/routes/filament_profiles.py`) for the `match.outcome != "matched"` branch;
the route's other two attention constructions (`bad_price`, `unwritable_content`) already pass
`candidates=[]` and now rely on the schema's `candidates_total=0` default, which is correct —
zero candidates behind an empty list.

Frontend: `FilamentProfilesPage.tsx`'s attention-list `<li>` now appends
`t('common.plusNMore', { count: entry.candidates_total - entry.candidates.length })` whenever
`candidates_total` exceeds the shown list length. No new i18n key was needed — `common.plusNMore`
("+{{count}} more") already exists in all 14 locale files and is already used the same way
elsewhere (`FileManagerPage.tsx`, `QueuePage.tsx`), so this task added zero translation keys.
`frontend/src/api/client.ts`'s `FilamentPresetZohoSyncAttention` interface gained the matching
`candidates_total: number` field (type-only).

user-approved 2026-08-26: "the needs-attention list shows a truncated set of colliding item
names plus a remainder count rather than every name."

Tests added: `backend/tests/unit/test_zoho_filaments_match.py` —
`test_ambiguous_collision_over_the_cap_is_truncated_with_a_true_total` (7 collisions -> exactly
5 names + `candidates_total == 7`) and `test_ambiguous_collision_at_the_cap_is_not_truncated`
(5 collisions -> all 5 + `candidates_total == 5`), plus `candidates_total` assertions added to
the pre-existing no_match/ambiguous/no_price match tests. `backend/tests/unit/
test_filament_profiles_zoho_sync.py` — `test_ambiguous_attention_caps_candidates_and_carries_
the_true_total` pins the route threading the cap and the true total end-to-end through the live
API. `frontend/src/__tests__/pages/FilamentProfilesPage.test.tsx` — a new test renders an
attention entry with 5 shown candidates and `candidates_total: 7`, asserting both the 5 names
and the "+2 more" text appear.

`tools/snapshot.py verify`: 7/11 matched unchanged; 4 legitimately diffed and were re-recorded
via `tools/snapshot.py record` — `fp-pydantic-schemas` (the new `candidates_total` field in
`FilamentPresetZohoSyncAttention`'s JSON Schema), `fp-match-decisions` (the empty-catalogue
`ProfileMatch` repr now includes `candidates_total=0`), `fp-sync-endpoint` (every attention
entry's `model_dump()` now includes `candidates_total`), and `fp-client-method` (the new field
in the client's TypeScript interface). The other 7 golden files were byte-identical after the
re-record. `SURFACE.md` regenerated via `bash tools/gen_surface_fp.sh`: the new
`_MAX_REPORTED_CANDIDATES` constant, the `candidates_total` property in the
`FilamentPresetZohoSyncAttention` openapi-schema line, and `common.plusNMore` in the page's
i18n-keys list were the only changes; applied.

`tools/coverage_fp.sh backend`: 485/486 = 99.79% statements, 108/110 = 98.18% branches — same
percentage as baseline (481/482 = 99.79%), denominator up by 4 for the new field/cap logic, all
newly-added lines covered. `tools/coverage_fp.sh frontend`: 163/255 = 63.92% statements — equal
to the baseline. Full backend suite: 12,435 passed, 1 skipped (one unrelated failure,
`test_library_slice_api.py::TestSliceArchiveReslicedBedType::test_bed_type_lifted_from_sliced_
output`, observed only under the coverage run's parallel load and confirmed to pass in
isolation — a known suite flake, not caused by this change). Full frontend suite: 359 files,
5120 tests passed.

## T-015 — 2026-08-26 — a Zoho match with a name-inferred spool weight no longer auto-prices
(user-approved behavior change)

`sync_filament_presets_from_zoho()` (`backend/app/api/routes/filament_profiles.py`) priced every
confidently-matched preset from `match.product.cost_per_kg` without checking
`FilamentProduct.weight_inferred`. That field is `True` when `zoho_filaments.parse_filament_name`
found no weight token at all in the Zoho item's name and silently assumed 1 kg
(`services/zoho_filaments.py:113-114`), so `cost_per_kg` for such an item is `dealer_price / 1.0`
— a value with no real basis. If the vendor later renamed the item to add or change its weight
suffix, the *next* sync would re-derive a different `cost_per_kg` from the same dealer price and
silently rewrite every matching preset's stored cost. The pricing calculator's own Zoho sync
(`api/routes/calculator.py:245`) already refuses exactly this: "The filament's own stored weight
wins: re-deriving it from the Zoho name on every sync would let an upstream rename re-scale the
price." This route had no equivalent guard.

A match whose `product.weight_inferred` is `True` is now diverted to the attention list under a
new reason, `"weight_unknown"`, before `apply_filament_cost` is ever called — the preset's price
is left untouched (exactly as for `"no_match"`/`"ambiguous"`/`"no_price"`/`"bad_price"`/
`"unwritable_content"`), and the operator can correct the situation upstream (give the Zoho item
a real weight in its name) instead of the sync silently trusting an assumed one.

Candidates/candidates_total convention for the new reason, chosen to be consistent with the
existing `"no_price"` reason (also a single confidently-matched item, reported rather than
auto-applied): `candidates=[match.product.name]`, `candidates_total=1` — the one matched item
whose weight the operator needs to go verify, not an empty list (`"no_match"`/`"bad_price"`/
`"unwritable_content"` use `[]` because there is no single item to point at).

user-approved 2026-08-26: a profile matched to a Zoho item whose name carries no weight is
reported for review instead of auto-priced; the sync UI gained a new attention reason to render.

Obligations completed in this same change: `FilamentPresetZohoSyncAttention.reason` (`backend/
app/schemas/filament_profile.py`) extended to
`Literal["no_match", "ambiguous", "no_price", "unwritable_content", "bad_price",
"weight_unknown"]`; the route's attention branch; the page's reason-to-i18n-key ternary in
`frontend/src/pages/FilamentProfilesPage.tsx` gained an explicit `'weight_unknown'` branch (never
falls through to the `"no_price"` default); a new i18n leaf, `filamentProfiles.
syncZohoWeightUnknown`, added with real (non-placeholder) translations to all 13 locale files
under `frontend/src/i18n/locales/`, verified by `node scripts/check-i18n-parity.mjs` and `npx
vitest run src/__tests__/i18n`. `frontend/src/api/client.ts`'s `FilamentPresetZohoSyncAttention.
reason` union type also gained `'weight_unknown'` (type-only; needed so the page's new ternary
branch compiles) — the file is not itself in the campaign's coverage scope (a 265KB file shared
by the whole app), but its type must track the API contract this task changed.

Tests added: `backend/tests/unit/test_filament_profiles_zoho_sync.py` —
`test_attention_reason_accepts_every_value_the_route_can_set` extended to the six-value set;
`test_a_confident_match_with_an_inferred_weight_is_flagged_for_attention` (a lone
`weight_inferred=True` match reports `"weight_unknown"` with `candidates=[item.name]`,
`candidates_total=1`, and leaves the preset byte-identical); and
`test_a_weight_inferred_profile_does_not_stop_healthy_profiles_from_being_priced` (a
weight-inferred match and a normal match in the same batch: the healthy one still prices, the
inferred one is reported exactly once, mirroring the existing bad-price sibling test). The
shared `product()` test helper gained a `weight_inferred` parameter (default `False`, so every
pre-existing call site — and `test_prices_a_confident_match` in particular — is unchanged and
still prices normally). `frontend/src/__tests__/pages/FilamentProfilesPage.test.tsx` — a new
test (mirroring the T-018-era `bad_price`/`unwritable_content` tests) asserts a `weight_unknown`
entry renders its own copy, never falls through to the `"no price"` text, and shows its single
candidate name.

`tools/snapshot.py verify`: 7/11 matched unchanged; 4 legitimately diffed and were re-recorded
via `tools/snapshot.py record` — `fp-pydantic-schemas` (the widened `reason` enum in
`FilamentPresetZohoSyncAttention`'s JSON Schema), `fp-i18n-sync-strings` (the new
`syncZohoWeightUnknown` leaf in every locale), `fp-client-method` (the widened union in the
client's TypeScript interface), and `fp-page-sync-ui` (the new ternary branch in the page's
reason grep). `fp-match-decisions` and `fp-sync-endpoint` — the two probes that actually exercise
`match_profile`/the live route — stayed MATCH unchanged, because neither probe's fixture
catalogue contains a `weight_inferred=True` product; this is expected, not a gap, since those
probes are frozen behavioral baselines for scenarios that predate this task. The other 5 golden
files were byte-identical after the re-record. `SURFACE.md` regenerated via `bash
tools/gen_surface_fp.sh`: only the `FilamentPresetZohoSyncAttention` openapi-schema line's
`reason` enum picked up `"weight_unknown"`; applied.

`tools/coverage_fp.sh backend`: 488/489 = 99.80% statements, 110/112 = 98.21% branches — same
percentage as baseline (485/486 = 99.79%; small denominator increase from the new branch, fully
covered). Full backend suite: 12,438 passed, 1 skipped. `tools/coverage_fp.sh frontend`:
163/255 = 63.92% statements — equal to the baseline (the new ternary branch nests inside an
already-instrumented expression, so it added branch coverage but no new top-level statement; both
its arms are exercised by the existing and new tests). Full frontend suite (via targeted +
`src/__tests__/i18n` runs) all green; one unrelated pre-existing flake in
`src/__tests__/pages/ArchivesPage.test.tsx` was observed once under parallel load and confirmed
to pass in isolation — not touched by this change.

## T-016 — 2026-08-26 — FilamentProfilesPage's mutating actions are now gated on the
permission their own backend endpoint enforces (user-approved behavior change)

`frontend/src/pages/FilamentProfilesPage.tsx` never imported `useAuth` or called
`hasPermission`: every mutating control (Sync base, Import, Sync Zoho prices, Sync to PC, New
preset, plus each preset's row menu and the editor's Save/Delete buttons) rendered for any
authenticated user regardless of permissions. Backend enforcement was already correct
(`RequirePermissionIfAuthEnabled` on every mutating route in `backend/app/api/routes/
filament_profiles.py`), so a read-only user could click any of these and get a 403 toast — this
was a defence-in-depth/UX gap, not a bypass, mirroring the pattern `CalculatorPage.tsx` already
uses (`const canUpdateCalculator = hasPermission('calculator:update')`).

Each control is now gated on the permission its own endpoint actually checks (grepped from
`RequirePermissionIfAuthEnabled` in the route file):
- Sync base (`POST /sync-base`, `FILAMENTS_UPDATE`) → `filaments:update`
- Import (`POST /` per new file after the read-only `bambu-scan`, `FILAMENTS_CREATE`) →
  `filaments:create`
- Sync Zoho prices (`POST /zoho-sync`, `FILAMENTS_UPDATE`) → `filaments:update`
- Sync to PC (`POST /bambu-sync`, dry-run and confirm both `FILAMENTS_UPDATE`) →
  `filaments:update`
- New preset (`POST /`, `FILAMENTS_CREATE`) → `filaments:create`
- Export ZIP left ungated: it calls no backend endpoint (a client-side zip of already-loaded
  preset data), so there is no permission to check.
- Row menu (`PresetCard`): Edit → `filaments:update` (`PATCH /{id}`), Duplicate →
  `filaments:create` (`POST /{id}/duplicate`, which creates a row), Delete → `filaments:delete`
  (`DELETE /{id}`). The kebab menu button itself is hidden when none of the three are granted
  (an empty menu is worse than no menu), and the divider before Delete only renders when an item
  above it is also visible.
- Editor modal (`PresetEditorModal`): a new `canSave` prop (default `true`, so the two existing
  component tests that don't pass it are unaffected) hides the Save/Create button when the
  relevant permission (`filaments:create` in create mode, `filaments:update` in edit mode) is
  missing — Cancel stays reachable so a read-only user can still back out of a view-only editor.
  The Delete button was already conditionally rendered via a nullable `onDelete` prop; the page
  now passes `null` when `filaments:delete` is missing, same mechanism, no modal change needed.
  Note: clicking a card still opens the editor (view mode) regardless of permission — only
  Save/Delete inside it are gated — since viewing a preset's content is not itself a mutating
  action and the list is already gated on `filaments:read` to be visible at all.

`hasPermission` returns `true` unconditionally when auth is disabled (`AuthContext.tsx:229`), so
auth-disabled installs see every control exactly as before — verified by a dedicated test.

user-approved 2026-08-26: users holding only `filaments:read` no longer see the Sync base /
Import / Sync Zoho prices / Sync to PC / New preset buttons or the row/editor mutating controls
that were visible (and clickable, failing with a 403 toast) before; auth-disabled installs and
users with the corresponding permissions are unaffected.

Files touched: `frontend/src/pages/FilamentProfilesPage.tsx` (permission reads + gating),
`frontend/src/components/filament-profiles/PresetCard.tsx` (new optional `canEdit`/
`canDuplicate`/`canDelete` props, each defaulting to `true`), `frontend/src/components/
filament-profiles/PresetEditorModal.tsx` (new optional `canSave` prop, defaulting to `true`).
The route-level gap noted in the finding (`<Route path="filament-profiles"
element={<FilamentProfilesPage />} />` in `App.tsx` has no `PermissionRoute`, unlike
`calculator`) was left as-is: `App.tsx` was out of scope for this task, and the page itself
already requires `filaments:read` to render anything from the list/scan endpoints — adding a
route guard is a separate, larger change (it would need its own approved finding).

Tests added: `frontend/src/__tests__/pages/FilamentProfilesPagePermissions.test.tsx` — a new
file (mirroring `PrintersPageDropPermission.test.tsx`'s `vi.mock('../../contexts/AuthContext')`
pattern) rather than editing the existing `FilamentProfilesPage.test.tsx`, because mocking
`useAuth` applies to every test in the file and would otherwise change that file's
auth-disabled baseline. Six tests: all five mutating header buttons hidden with only
`filaments:read`; Export ZIP stays visible; the row kebab menu is absent entirely with no
create/update/delete permission; the editor's Save button is absent (Cancel stays) for a
read-only user opening an existing preset; only the row action matching a single granted
permission (`filaments:update` → Edit only) renders; every control renders with all four
`filaments:*` permissions granted; every control also renders on an auth-disabled install
regardless of the (irrelevant) permission set. The existing `FilamentProfilesPage.test.tsx`
(18 tests) was left unmodified and still passes unchanged — it runs with the real
`AuthProvider` against the shared mock's `auth_enabled: false`, so `hasPermission` returns
`true` for everything, same as before this change.

`python3 tools/snapshot.py verify`: 11/11 MATCH, no re-record needed — `fp-page-sync-ui` (the
only probe that greps `FilamentProfilesPage.tsx`) matches on lines containing `syncZoho`/
`zohoSync`/`zohoSyncing`, and this change only wrapped existing JSX in a permission conditional
without touching those identifiers or lines. `SURFACE.md` regenerated via `bash
tools/gen_surface_fp.sh`: byte-identical, no diff to apply (no exported symbol/interface in the
page changed; `PresetCard`/`PresetEditorModal` are not in the surface's `R8`-`R11` grep set).

`bash tools/coverage_fp.sh frontend` (scope: `frontend/src/pages/FilamentProfilesPage.tsx`
only, per that script's FE_FILES list — `components/filament-profiles/**` is explicitly out of
this scope): 167/259 = 64.47% statements, up from the 163/255 = 63.92% baseline (no drop; the
new `hasPermission` calls and conditional branches added covered statements). Full frontend
suite: 5,126/5,127 passed in the scoped coverage run, the one failure
(`StatsPageUserFilter1894.test.tsx`) a documented load-flake confirmed to pass alone and
unrelated to this change; a second full run (outside the coverage harness) surfaced the same
class of flake in `PrintModal.test.tsx`/`ArchivesPage.test.tsx`/`ModelViewerModal.test.tsx`, all
confirmed passing in isolation and none touching filament-profiles code.

## T-031 — 2026-08-26 — the preset editor now closes reliably when Save succeeds (user-approved behavior change)

`FilamentProfilesPage.tsx` renders `PresetEditorModal` with `key={editorState.mode === 'edit'
? `${editorState.presetId}-${editingPreset?.updated_at ?? ''}` : 'create'}` (added by loop-2
for T-006, so a still-open editor picks up a preset changed elsewhere — e.g. a Zoho price sync
completing — instead of showing the stale snapshot it was opened with). `PresetEditorModal`'s
own `handleSave` does `await onSave(payload); requestClose();`, where `onSave` is the page's
`handleSavePreset`, which awaits the API call and then `await
queryClient.invalidateQueries({queryKey:['filamentPresets']})`. That invalidation's refetch
returns the saved row with a new `updated_at` (the backend's PATCH bumps it), which changes the
remount key computed above — React then unmounts the very modal instance whose
`useDismissableDialog`-driven close (a `setClosing(true)` immediately, then a 220ms
`setTimeout` before the actual `onClose`) was in flight. The unmount clears that pending
timeout before it fires, so `onClose` (`() => setEditorState({ mode: 'closed' })`) never runs:
the preset saves, the toast fires, and the editor stays open showing the just-saved values —
only Cancel/Escape got out.

Fixed in `frontend/src/pages/FilamentProfilesPage.tsx`'s `handleSavePreset`: it now calls
`setEditorState({ mode: 'closed' })` itself, right after the create/update API call succeeds
and before `invalidateQueries`, rather than only ever closing via the child's own
`onClose` callback. This makes the close unconditional and independent of the child's
220ms exit-animation timer and of whatever `updated_at` the subsequent refetch happens to
return — the parent decides the editor is done, and stops rendering it, regardless of that
race. The remount key itself is untouched, so T-006 (a still-open editor must refresh from a
preset changed *elsewhere* while it's open) is unaffected: that scenario never sets
`editorState` to `'closed'` at all, only `handleSavePreset`'s own save path does.

user-approved 2026-08-26: "the preset editor will close again when Save succeeds, instead of
staying open on the saved values as it does now." This restores the pre-T-006 close-on-save
behavior; a separate task (T-032) will address dirty-editor conflict banners and was
deliberately not touched here.

Test added in `frontend/src/__tests__/pages/FilamentProfilesPage.test.tsx`: "closes the editor
once Save succeeds, even though the refetch it triggers bumps updated_at (T-031)" — stubs a
PATCH response and a GET refetch that both carry a bumped `updated_at` (the existing `preset()`
fixture omits the field entirely, which is exactly why this bug shipped uncaught), opens the
editor, clicks Save, and asserts the dialog is gone. Confirmed failing against the pre-fix code
(`waitFor` times out with the dialog still present) and passing against the fix. The existing
T-006 regression test ("re-syncs the open editor with fresh data when a Zoho sync updates the
preset underneath it") was re-run unmodified and still passes, confirming the remount-key
refresh path survives this change.

`python3 tools/snapshot.py verify`: 11/11 MATCH, no re-record needed — no probe's captured
output touches `handleSavePreset` or the editor's close path. `SURFACE.md` regenerated via
`bash tools/gen_surface_fp.sh`: byte-identical, no diff to apply.

`bash tools/coverage_fp.sh frontend`: 173/260 = 66.53% statements, up from the 167/259 = 64.47%
baseline (no drop). Full frontend suite (`./venv` n/a — `npx vitest run` / `test_frontend.sh`):
5,125/5,128 passed; the 3 failures (`PrintModal.test.tsx` x2,
`ArchivesPage.test.tsx` — "shows a toast when printer video ZIP preparation fails") are the
documented load-flakes, confirmed passing in isolation (`npx vitest run
src/__tests__/components/PrintModal.test.tsx src/__tests__/pages/ArchivesPage.test.tsx` — 116/116
passed) and unrelated to this change.

## T-034 — 2026-08-27 — a sync served from a stale Zoho catalogue now discloses that instead of reporting a plain success (user-approved behavior change)

`fetch_catalogue()`'s two failure branches — the refresh-lock-busy timeout (line ~394-398) and
the refresh-itself-raised path (line ~476-479) — both serve the previous `_cache` back to the
caller with `_cache_at` left un-advanced, and with no upper bound on how old that cache is: a
refresh token that has been dead for days, or a Zoho outage lasting hours, produces exactly the
same return value as a live fetch. `POST /filament-profiles/zoho-sync` (the one caller in this
codebase that WRITES what it gets, straight into stored preset content) called
`_fetch_catalogue_or_502`, which forwarded that return value untouched and answered
`FilamentPresetZohoSyncResponse(priced=..., unchanged=..., attention=[])` — a response
indistinguishable from a fully live sync. The page turned that into a green "Priced N" toast
(`FilamentProfilesPage.tsx`). An operator syncing during a Zoho outage was told it succeeded
with today's prices when it had in fact just re-written every matched preset from however-old
the last good catalogue happened to be.

user-approved 2026-08-26 (DISCLOSE, not refuse): "a price sync run while Zoho is unreachable
will report that its prices came from a stale catalogue (or refuse to write) instead of
returning a plain success." The sync still runs and writes — refusing outright would make the
feature unusable for the whole outage window — but the response and the UI now surface the
staleness instead of hiding it.

`fetch_catalogue()`'s public signature and return type are unchanged (`backend/app/api/routes/
calculator.py` also calls it and is out of scope for this task): a new module-private global,
`zoho_filaments._last_stale_serve_at`, is set to the stale copy's `_cache_at` at both
failure-branch return points and cleared (`None`) at every genuine-fresh-cache and successful-
refresh return point. `_fetch_catalogue_or_502` — the one in-scope caller, private, and with no
direct test coverage of its own return shape prior to this — now reads that global immediately
after `await fetch_catalogue(db)` returns (no `await` in between, so nothing else can run and
overwrite it first) and returns `(catalogue, stale_since)` instead of a bare list.
`sync_filament_presets_from_zoho` in `backend/app/api/routes/filament_profiles.py` unpacks that
tuple and passes `stale_since` through as `FilamentPresetZohoSyncResponse.catalogue_stale_since:
datetime | None = None` — additive and defaulted, so the OpenAPI change is backward compatible
and old clients ignore it. `calculator.py` was not touched and calls only the untouched
`fetch_catalogue`; its two call sites (search and calculator sync) are byte-identical.

Frontend: `FilamentPresetZohoSyncResponse.catalogue_stale_since: string | null` added to
`frontend/src/api/client.ts`. In `FilamentProfilesPage.tsx`'s `handleZohoSync`, `isFullSuccess`
now also requires `!result.catalogue_stale_since`, so a stale sync never shows the green toast
even when otherwise fully successful (nothing needing attention, something priced) — it shows
the warning-yellow toast instead, with a new `filamentProfiles.syncZohoStale` string appended
alongside the existing attention count. The below-the-fold summary panel gained its own
amber stale notice with the same string and timestamp. The toast-message assembly was
refactored from a ternary into an array-join to accommodate the extra optional segment; for
every case with no staleness (all pre-existing tests) it produces the exact same joined string
as before.

i18n: `filamentProfiles.syncZohoStale` (one key, `{{timestamp}}` placeholder) added with real
translations to all 13 locale files under `frontend/src/i18n/locales/` (`de`, `en`, `es`, `fr`,
`it`, `ja`, `ko`, `pt-BR`, `ru`, `tr`, `uk`, `zh-CN`, `zh-TW`) — `node scripts/check-i18n-parity.mjs`
passes (13 locales, 7,076 leaves each, no parity/placeholder/identical-to-en failures) and
`npx vitest run src/__tests__/i18n` passes (26/26).

Tests added:
- `backend/tests/unit/test_zoho_filaments_catalogue.py`:
  `test_fetch_catalogue_or_502_reports_stale_since_when_serving_a_failed_refresh` (drives a real
  refresh failure against an expired-but-present cache and asserts `_fetch_catalogue_or_502`
  returns the pre-refresh `_cache_at` as `stale_since`),
  `test_fetch_catalogue_or_502_reports_no_staleness_for_a_fresh_sync` (a genuine fresh fetch,
  then a within-TTL cache hit, both report `None`), and an added assertion on the existing
  `test_lock_acquire_timeout_serves_the_stale_cache_when_warm` confirming the lock-busy branch
  also sets `_last_stale_serve_at`.
- `backend/tests/unit/test_filament_profiles_zoho_sync.py`:
  `test_stale_catalogue_discloses_its_age_instead_of_a_plain_success` (end-to-end through the
  real HTTP route with a real expired warm cache and a failing `list_items_page`, asserting both
  that the sync still wrote the price AND that `catalogue_stale_since` carries the expected
  timestamp), plus an added assertion on the existing `test_prices_a_confident_match` that a
  fresh sync's `catalogue_stale_since` is `null`.
- `frontend/src/__tests__/pages/FilamentProfilesPage.test.tsx`:
  "discloses a stale catalogue instead of reporting a plain success (T-034)" (mocked stale
  response renders the warning-yellow toast with the timestamp and the summary-panel notice) and
  "keeps the green success toast for a fresh sync with nothing left to disclose (T-034)" (mocked
  fresh response, `catalogue_stale_since: null`, still renders the green toast — confirming the
  pre-existing green path is not broken by this change; T-024's own dedicated green-toast test is
  a separate task and was not implemented here).

`python3 tools/snapshot.py verify` / `record`: 5 of 11 probes legitimately diffed
(`fp-pydantic-schemas` and `fp-sync-endpoint` picked up the new additive field;
`fp-i18n-sync-strings` and `fp-client-method` picked up the new key/field; `fp-page-sync-ui`
picked up the toast/panel wiring) and were re-recorded; the other 6 (`fp-openapi`, `fp-ddl`,
`fp-route-perms`, `fp-pricing-write`, `fp-match-decisions`, `calc-zoho-pure`) matched unchanged.
`SURFACE.md` regenerated via `bash tools/gen_surface_fp.sh`: one new line,
`filamentProfiles.syncZohoStale`, under "i18n keys read by FilamentProfilesPage.tsx"; applied.

`bash tools/coverage_fp.sh backend`: 497/498 = 99.80% scoped statements (up from the 488/489
baseline, same ratio, no drop; the one uncovered line, `zoho_filaments.py`'s `_score()` SKU-term
branch, is pre-existing and untouched). `bash tools/coverage_fp.sh frontend`: 174/261 = 66.66%
statements (up from the 173/260 baseline, no drop).

Full backend suite (`pytest backend/tests/ -n 30`, excluding `test_bambu_ftp.py`): 12,442
passed, 1 skipped. One incidental failure on a prior run
(`test_aito_quote_sync.py::test_wake_drains_a_pending_project_without_waiting_for_the_interval`,
`sqlalchemy.exc.InvalidRequestError: Could not refresh instance`) reproduced only under `-n 30`
parallel load and passed cleanly both in isolation and on a clean re-run of the full suite
(104/104 and 12,442/12,442 respectively) — the documented suite-load flake, unrelated to this
change (Aito quote sync, not touched). `ruff check` / `ruff format --check` clean on every
touched backend file. `npx tsc --noEmit -p tsconfig.app.json` and `npx eslint` clean on every
touched frontend file.
