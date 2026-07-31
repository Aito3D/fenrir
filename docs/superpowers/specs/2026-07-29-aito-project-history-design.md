# Aito project history — design

**Date:** 2026-07-29
**Status:** approved, ready for implementation planning

A per-project activity timeline in the expanded project card, mirroring Zoho
Books' own quote history alongside every action taken in Bambuddy. Plus three
smaller changes to the quote surfaces that were specified in the same session.

---

## 1. Purpose

The timeline serves four jobs at once, all four confirmed as in scope:

1. **Client accountability** — when was the quote sent, when did they open it,
   when did they accept, and what did it say at each point.
2. **Internal audit** — who changed what, with before → after values.
3. **Project narrative** — a readable story of the job, with elapsed time
   between stages, for a project not touched in three weeks.
4. **Sync debugging** — making the opaque `quote_sync_state` machine legible.

These are not four features. They are four *zoom levels* on one event stream,
which is why the UI control is a depth ladder rather than a set of source
filters.

---

## 2. Data model

### 2.1 New table: `aito_events`

```python
class AitoEvent(Base):
    __tablename__ = "aito_events"

    id: int                              # PK, also the pagination cursor
    project_id: int                      # indexed; NO foreign key
    occurred_at: datetime                # indexed; when it HAPPENED (UTC)
    occurred_until: datetime | None      # end of a coalescing window; NULL = instantaneous
    kind: str(40)                        # 'task.updated', 'quote.viewed', 'sync.failed', …
    actor_class: str(10)                 # 'user' | 'client' | 'system'
    actor_name: str(100) | None          # snapshotted username, or the Zoho contact's name
    subject_type: str(20) | None         # 'project' | 'task'
    subject_id: int | None
    subject_label: str(200) | None       # the task's title AS IT WAS
    changes: JSON | None                 # [{"field": …, "from": …, "to": …}]
    detail: JSON | None                  # kind-specific extras
    note: Text | None                    # user-authored note body
    zoho_comment_id: str(50) | None      # UNIQUE index — the mirror's idempotency key
    created_at: datetime                 # server_default=now()
```

Index on `(project_id, occurred_at DESC)` for the read path, and a unique index
on `zoho_comment_id` (partial / nullable-tolerant — SQLite permits multiple
NULLs in a UNIQUE column, which is exactly what non-mirrored events need).

**No foreign key on `project_id`.** Projects soft-delete and their events must
outlive a trashing, exactly as `created_by` is a snapshot rather than a
reference elsewhere in this model.

**`subject_label` is a snapshot.** "Paul edited *Socle*" must remain true after
the task is renamed to *Socle v2* or deleted outright. This follows the
established convention in `AitoProject` (`client_name`, `quote_total`,
`created_by` are all snapshots for the same reason).

**Depth is deliberately NOT a column.** It is derived from `kind` through a
registry dict in `services/aito_events.py`, and the API translates a requested
depth into a `kind IN (...)` filter. Storing depth per row would freeze every
historical event at the classification it had on the day it was written: the
moment `task.added` is promoted from Detail to Story, every existing row would
need a data migration. Depth is a presentation judgment; presentation judgments
do not belong in rows.

**`actor_class` IS a column**, because it states a fact about the event (who
caused it), not a judgment about how to display it.

### 2.2 New columns on `aito_projects`

```python
zoho_comments_watermark: str(30) | None   # estimate.last_modified_time at last comment pull
zoho_comments_checked_at: datetime | None # when we last pulled comments
```

Both nullable, added via additive `ALTER TABLE` in
`core/database.py:run_migrations()` per this project's convention.

### 2.3 Kind registry and the depth ladder

| depth | kinds | typical actor_class |
|---|---|---|
| **story** | `project.created`, `quote.created`, `quote.sent`, `quote.viewed`, `quote.accepted`, `quote.declined`, `quote.expired`, `stage.changed`, `project.trashed`, `project.restored` | user, client |
| **detail** | `task.added`, `task.updated`, `task.removed`, `task.step.ticked`, `task.step.unticked`, `project.updated`, `note.added`, `zoho.comment` | user, client |
| **trace** | `sync.queued`, `sync.pushed`, `sync.failed`, `sync.locked`, `sync.conflict`, `sync.status_rejected`, `poll.reconciled` | system |

The ladder is **cumulative**: Story returns story kinds; Detail returns story +
detail; Everything returns all three. A client's `quote.accepted` is therefore
visible at every level and is never something the user must dig for — which is
what the accountability job requires.

**Story earns the elapsed-time gutter.** Because Story rows are sparse and
ordered, `ActivityRail` computes the gap between consecutive Story events and
renders "1 day after sending", "3 days in Model". This renders at Story depth
only; at Detail and Everything the rows are too dense for it to mean anything.

---

## 3. Capture

### 3.1 The recorder

One service, `backend/app/services/aito_events.py`:

```python
async def record(
    db, project_id, kind, *,
    actor_class, actor_name=None,
    subject_type=None, subject_id=None, subject_label=None,
    changes=None, detail=None, note=None, occurred_at=None,
    zoho_comment_id=None,
) -> AitoEvent | None
```

Every capture site calls this explicitly. **Not** via SQLAlchemy `before_update`
hooks: the ORM layer cannot see who the actor is, and the same models are
written by both HTTP routes (`actor_class='user'`) and the background worker
(`actor_class='system'`), so a hook would have to reconstruct that from ambient
state. Ten explicit, greppable call sites beat one clever hook.

`record()` returns `None` when it decides there is nothing to record (an empty
diff), so callers must not assume a row was written.

### 3.2 Capture sites

**`api/routes/aito.py`**

| function | kind(s) |
|---|---|
| `create_project` | `project.created` (`detail.imported_from` set when created from a quote) |
| `update_project` | `project.updated` with field diffs |
| `move_project` | `stage.changed` |
| `add_task` | `task.added` |
| `update_task` | `task.updated` with field diffs, **plus** `task.step.ticked` / `task.step.unticked` split out from the four `*_done` flags |
| `delete_task` | `task.removed` |
| `set_quote_status` | `quote.sent` / `quote.accepted` / `quote.declined` |
| `delete_project` | `project.trashed` |
| `restore_project` | `project.restored` |

Actor is `current_user.username` where the route already has it, else `None`
(auth disabled or API-key request) — the same rule `created_by` follows today.

**`services/aito_board_rules.py` / `_apply_rules`** — when the derived column
changes, emit `stage.changed` with `actor_class='user'`, the *ticking user's*
name, and `detail={"cause": "rule"}`. It is automatic machinery, but a person
caused it, and the timeline should say who.

**`api/routes/aito.py:_mark_pending` / `_mark_pending_if_ours`** —
`sync.queued`, `actor_class='system'`. Emitted at the point the outbox state
flips to `pending`, which is what makes a later `sync.pushed` legible as the
completion of a specific request.

**`services/aito_quote_sync.py`** — `quote.created` from `_create_quote`;
`sync.pushed` / `sync.failed` (with HTTP status and `quote_sync_failures`) /
`sync.locked`; `sync.conflict` and `sync.status_rejected` from
`_reconcile_status`, recording the blocks that today live only in
`quote_status_block`; and `poll.reconciled` when a sweep finds the remote status
unchanged.

`sync.conflict` is a real gain: the reconciler's conflicts are currently
*current-state* fields that the next write overwrites. As events they become
history, so a card that conflicted three times last week can say so.

**`_reconcile_status` does NOT emit `quote.*` events.** See §4.3 — the Zoho
mirror owns those.

`poll.reconciled` is high-frequency by nature (one per project per sweep) and is
the main reason `trace` is a separate depth rather than folded into `detail`.

### 3.3 Diffs

A helper reads the fields named in the incoming patch **before** applying it and
returns only genuinely changed fields. **A PATCH that changes nothing writes no
event** — `TaskEditor` fires on row blur, so tabbing through a task without
editing it must stay silent.

### 3.4 Coalescing

For `task.updated` and `project.updated` **only**, `record()` looks for a prior
event with the same `(project_id, kind, subject_id, actor_name)` whose window
ended less than **5 minutes** ago, and folds into it:

- `occurred_until` extends to now.
- The changes lists merge. A field appearing twice keeps the **earliest `from`
  and the latest `to`**.
- If a merged field's `from` equals its `to`, **the field is dropped** —
  editing 4200 → 5600 → 4200 correctly records that nothing happened.
- If dropping leaves the event with no changes at all, **the event row is
  deleted**.

Ticks (`task.step.ticked` / `unticked`) are never coalesced: each is a discrete
decision and the thing an audit is most likely to be asked about.

### 3.5 Backfill

A one-time migration inserts one `project.created` event per existing project
from its `created_at` / `created_by`, so no card opens onto an empty rail.
Everything else starts from now — **except the Zoho side, which backfills itself
completely on the first poll**, because Books has kept those comments all along.

---

## 4. The Zoho mirror

### 4.1 Fetch policy

In `sync_project`, after the existing estimate fetch, pull
`GET /estimates/{id}/comments` **only when** the estimate's `last_modified_time`
differs from `zoho_comments_watermark`, **or** `zoho_comments_checked_at` is
more than **4 hours** ago.

Every event that matters (viewed, accepted, declined, sent) changes the
estimate's `last_modified_time` and trips the watermark immediately. The 4-hour
floor exists only to catch a human typing a comment in Books, which can wait.

Cost, at the new 300 s poll interval: 288 estimate calls/day/project plus ~6
comment calls/day/project — under 2% overhead.

### 4.2 Mapping

Each Books comment becomes one event, deduped on `zoho_comment_id`, so
re-pulling is idempotent.

Classification is **best-effort and lossless**. A small pattern table promotes
the high-value entries (`viewed`, `accepted`, `declined`, `sent`) to Story depth
with `actor_class='client'`. Anything unrecognised is stored as `zoho.comment`
at Detail depth with Books' own `description` as its display text. **No entry is
ever dropped for being unclassifiable** — Books can add statuses, and the
pattern table is English-dependent, so it must degrade rather than fail.

### 4.3 Duplication and echo suppression

Two independent paths can describe the same real-world fact, and without a rule
the timeline shows each client action twice.

**Rule 1 — the mirror owns `quote.*`, the reconciler owns `sync.*`.** Client-side
status changes (`quote.viewed`, `quote.accepted`, `quote.declined`,
`quote.expired`) are emitted **only** by the comment mirror, never by
`_reconcile_status`. The mirror carries Books' own timestamp — when the client
actually opened the quote — whereas the reconciler knows only when it happened
to poll. Same fact, better data, one source.

*Conditional fallback:* if step-one verification (§4.4) finds the comments
endpoint unusable against this org, `_reconcile_status` emits the `quote.*`
events instead and the mirror is dropped. That is a decision for implementation
once the endpoint is probed, not a runtime toggle.

**Rule 2 — suppress our own echo.** When *we* push a status to Books
(`set_quote_status` → `quote.sent`), Books records its own comment for that
change, which the mirror would then import as a duplicate. So the mirror skips
any comment whose mapped kind already has an event within **10 minutes** of the
comment's timestamp. This is the same echo-suppression concept the existing sync
already applies via `quote_synced_at`.

Dedup is therefore two-layered: `zoho_comment_id` makes re-pulling idempotent,
and the kind + time-window check makes cross-path duplication impossible.

### 4.4 Two risks, stated rather than discovered

- **The comments endpoint shape is unverified against this org.** The official
  Zoho Books estimates documentation confirms `GET /estimates/{estimate_id}/comments`
  ("List estimate comments & history") exists, but does not publish its response
  schema. **Probing the live org and recording the actual field names is step
  one of implementation**, not an assumption inside it.
- **Comment timestamps are organisation-local**, while every other datetime in
  this table is UTC. The mapper converts using the org's timezone. Getting this
  wrong silently shifts client-view times by hours — precisely the fact the
  accountability job rests on.

### 4.5 Poll interval

`_DEFAULT_INTERVAL_SECONDS` in `services/aito_quote_sync.py` changes from `60`
to `300`.

Rationale: Zoho Books permits 100 requests/minute per organisation and
1,000–10,000 per day depending on plan. At 60 s the poller spent 1,440
calls/day *per active quoted project*, exhausting a Standard plan's daily quota
at roughly 1.5 concurrent quotes. At 300 s it spends 288/day/project — about 7
concurrent quotes on Standard, 17 on Professional.

The 10 s floor in `sync_interval_seconds` stays as the foot-gun guard.

**`_DEFAULT_INTERVAL_SECONDS` is only the default.** If `aito_quote_poll_seconds`
is already present in the live `settings` table it wins, so implementation must
check that row and update it too.

---

## 5. API

| method | path | permission | notes |
|---|---|---|---|
| `GET` | `/api/v1/aito/{project_id}/events` | `AITO_READ` | `?depth=story\|detail\|everything&before=<id>&limit=50` → `{events, has_more}` |

`limit` defaults to 50 and is capped at 200. `depth` defaults to `detail`.
`before` is an `aito_events.id`; results are ordered `occurred_at DESC, id DESC`
so the cursor is stable when several events share a timestamp.
| `POST` | `/api/v1/aito/{project_id}/events` | `AITO_UPDATE` | body `{note: str}` only |
| `GET` | `/api/v1/aito/{project_id}/quote.pdf` | `AITO_READ` | streams `application/pdf` |

`POST` accepts **only** a note body; the handler hardcodes `kind='note.added'`
and `actor_class='user'`, so no client can forge an event kind. Notes are local
only — they are never pushed to Zoho.

Mutation routes keep their existing API-key classification; the two new read
routes follow `AITO_READ`'s existing classification and no new `Permission`
member is required.

---

## 6. Frontend

### 6.1 Panel layout

`ProjectDetailPanel` grows from `max-w-7xl` (1280 px) to `max-w-[100rem]`
(1600 px) and from two columns to three:

```
lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_minmax(0,26rem)]
```

Approximate result: details 300 px, tasks ~750 px, activity 416 px. The task
editor therefore gains room versus today (~700 px) rather than losing it — the
width comes from the panel, not from the working surface. Below `lg` the three
stack: details, tasks, then history full-width.

### 6.2 New components

`components/aito/history/` (a subdirectory — `components/aito/` is already 24
files flat):

- **`ActivityRail.tsx`** — header with event count, the depth segmented control,
  the note composer, the list, and load-more.
- **`EventItem.tsx`** — one entry.
- **`eventKinds.ts`** — kind → dot class + i18n key. The **backend registry
  remains the authority for depth filtering**; this map is presentation only.
- **`hooks/useProjectEvents.ts`** — React Query infinite query keyed
  `['aito-events', projectId, depth]`.

### 6.3 Entry anatomy

- **Dot colour** = `actor_class`: green `user`, amber `client`, grey `system`,
  red for `sync.failed` / `sync.conflict` / `sync.status_rejected`.
- **Bold actor name**, then the localised sentence for the kind.
- **`▸ n changes`** when `changes` holds more than one field; expands to the
  full before → after list.
- **Second line** shows the single most important diff inline.
- **Timestamp** is a range when `occurred_until` is set, with relative age.
- At Story depth only, the elapsed-time gutter between consecutive events.

### 6.4 Behaviour

Depth persists per user in `localStorage` under `aito.history.depth`. Every
mutation that already invalidates `['aito-projects']` also invalidates
`['aito-events', projectId]`.

### 6.5 i18n

The largest hidden cost in this spec: ~25 event kinds each need a real French
sentence, plus a field-name map (`impression_cost` → *coût d'impression*) for
the diff lines. The i18n gate rejects English placeholders, so none of these can
be stubbed. Keys must be literal `t('...')` calls — dynamic keys are invisible
to the gate, so kind → key uses explicit maps, following the existing
`SYNC_LABEL_KEY` / `BLOCK_MESSAGE_KEY` precedent in `ProjectDetailPanel`.

---

## 7. Quote surface changes

### 7.1 Print button on the Quote line

**Remove** `quoteDetail` (`ProjectDetailPanel.tsx:70–76`, rendered at `:304`) —
the quote date and total no longer render. **Add** a `Printer` icon button
beside the quote number, next to the existing `ExternalLink`.

**`ZohoService` refactor.** `_request` hardcodes `response.json()`
(`services/zoho.py:216`), so a PDF response would raise
`ZohoUpstreamError("non-JSON response")`. Split it:

- `_send()` — token, org scoping, 401-retry-once; returns the raw
  `httpx.Response`.
- `_request()` — unchanged public behaviour, now JSON parsing and error mapping
  layered on `_send`.
- `get_estimate_pdf()` — returns `bytes`, maps errors from status codes. Zoho's
  *error* responses are still JSON, so error mapping is shared.

**Endpoint — VERIFIED against the live org on 2026-07-29.** The official
estimates documentation confirms only the bulk operations `GET /estimates/pdf`
and `GET /estimates/print`, and does not document `?accept=pdf` on a single
estimate. A probe against the real EU organisation found **both work**:

- `GET /estimates/{id}?accept=pdf` — HTTP 200, `application/pdf`, 141750 bytes,
  valid `%PDF-` header. **Chosen**, because it names one estimate rather than a
  list and so cannot silently return the wrong document.
- `GET /estimates/print?estimate_ids={id}` — HTTP 200, `application/pdf`,
  142052 bytes. Works; kept as the documented fallback.

**Frontend print sequence.** The API client sends a Bearer token in an
`Authorization` header (`api/client.ts:125`), and **neither `<iframe src>` nor
`<a href>` can carry a header** — pointing an iframe at the endpoint would 401.
So:

1. `fetch()` the endpoint with the auth header → `blob()`
2. `URL.createObjectURL(blob)` → hidden `<iframe>`
3. on `load` → `iframe.contentWindow.print()`
4. revoke the object URL on `afterprint`, **not immediately** — revoking early
   cancels the print job

**Fallback is mandatory, not optional.** Iframe PDF printing is unreliable
across browsers (Safari has historically refused it). If `print()` throws or the
iframe has not loaded within 3 s, `window.open(blobUrl)` and toast "opened in a
new tab, press ⌘P". The button shows a spinner while fetching, since this is a
live Zoho round-trip.

The button does not render when the project has no `quote_id`.

### 7.2 Accept / Decline hidden in the Quote column

`aito_board_rules.evaluate` derives the column entirely from `quote_status`:
anything not accepted, declined or away lands in `devis`. So "the card is in the
Quote column" is **exactly** "`quote_status` is null or draft" — the complement
of the existing `canMarkSent` rule. `QuoteStatusActions` therefore becomes one
action set per column:

| column | quote_status | actions |
|---|---|---|
| **devis** | null, draft | **Mark sent** only |
| **waiting** | sent, viewed, expired | Accept · Decline |
| **done** | declined | Accept only |
| — | accepted | nothing |

**Accepted consequence:** a quote must now be marked sent before it can be
accepted — two holds where there was one. A client accepting in person costs the
extra step. This was raised and confirmed as intended: you cannot accept what
was never sent.

The component's docstring must be rewritten — its current action table is now
wrong in the `null, draft` row.

### 7.3 Mark-as-sent on the card

A new `onMarkSent?: () => void` prop on `CardView`, mirroring `onDelete` exactly,
so the `DragOverlay` clone omits it as it already omits delete. The mutation
lives in the board, not the presentational card, per the existing convention.

Icon-only `HoldButton` with the `Send` icon, `durationMs={500}`, amber — the
same colour and duration as the panel's button, so the gesture is identical on
both surfaces. It sits in the card footer, left of `DeleteHoldButton`, and
renders only when `project.column === 'devis'`.

**It does not hide behind hover.** `DeleteHoldButton` uses
`opacity-0 group-hover:opacity-100` because destructive actions should be hard
to hit by accident. Marking sent is the *primary* action of the Quote column —
the entire point is clearing that column without opening anything, and an
invisible button does not do that.

The mutation currently inside `QuoteStatusActions` (cache update, success toast,
`zoho_synced` warning, error toast) is extracted into a
`useQuoteStatusMutation(project)` hook that both surfaces call, so the behaviour
is not duplicated.

**Known edge case, accepted:** a hand-made card whose quote the worker has not
created yet (`quote_sync_state === 'pending'`, no `quote_number`) will still
offer Mark sent. This matches the panel's existing behaviour exactly; keeping
the two surfaces consistent is worth more than special-casing the few seconds
after creation.

---

## 8. Testing

**Backend unit — `tests/unit/services/test_aito_events.py`**
- coalescing inside and outside the 5-minute window
- merged field keeps earliest `from`, latest `to`
- `from == to` after merge drops the field
- dropping the last field deletes the event row
- ticks are never coalesced
- depth filtering returns cumulative sets
- `zoho_comment_id` dedup (re-pulling the same comment is a no-op)
- actor attribution: user, `None` (auth off / API key), system, client

**Backend unit — Zoho comment mapper**
- classified statuses map to Story kinds with `actor_class='client'`
- unrecognised descriptions become `zoho.comment` at Detail, text preserved
- org-local → UTC timezone conversion

**Backend unit — `get_estimate_pdf`**
- `httpx.MockTransport` returning PDF bytes; asserts no JSON parse
- error responses still map through the shared error mapping

**Backend integration — `tests/unit/api/test_aito_events_routes.py`**
- each mutation route writes the expected event(s)
- **a no-op PATCH writes none**
- `POST /events` cannot set `kind`
- permissions: `AITO_READ` for GET, `AITO_UPDATE` for POST

**Frontend**
- `ActivityRail.test.tsx` — depth switching, note submit, load-more, empty state
- `EventItem.test.tsx` — diff rendering, coalesced expansion, time range
- `QuoteStatusActions.test.tsx` — the new action table, all five statuses
- `AitoCardView.test.tsx` (existing) — mark-sent visible only in `devis`, hold
  gesture fires, absent from the drag overlay
- print — fetch mocked to a blob; asserts the new-tab fallback fires when
  `print()` throws

---

## 9. Registration checklist

Per the project's known gotchas:

- `AitoEvent` must be added to **all three** model import lists.
- No new `Permission` member — `AITO_READ` and `AITO_UPDATE` already exist and
  are already classified for API-key access.
- `run_migrations()` gains the `aito_events` table plus the two new
  `aito_projects` columns, additive `ALTER TABLE` only.
- i18n gate: every new key needs a real French string, added as literal `t()`
  calls via explicit maps.
- Sidebar tests hardcode nav ids — unaffected, no new page.

---

## 10. Sequencing

Sections 1–6 (the history) and section 7 (the quote surfaces) are independent:
they touch overlapping files but share no data or logic. Section 7 is small and
self-contained, section 1–6 is not. They should therefore become **two
implementation plans**, with section 7 first — it is quick, independently
valuable, and its `ProjectDetailPanel` edits land before the history's larger
restructuring of the same component, avoiding a conflict between them.

The one ordering constraint inside section 7: the `_DEFAULT_INTERVAL_SECONDS`
change (§4.5) belongs with the *first* plan regardless of which it is, because
the current 60 s interval is actively burning the org's Zoho quota.

## 11. Explicitly out of scope

- A board-wide activity feed across all projects. This is per-project only.
- Pushing notes to Zoho Books as comments (local notes only, confirmed).
- A drag-to-resize activity rail (fixed 26rem; can be added later without
  changing the three-column structure).
- Event retention or pruning. Events are small; revisit if a project's history
  becomes large enough to matter.
- Making the print button also mark the quote as sent.
