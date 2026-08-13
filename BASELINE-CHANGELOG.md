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
