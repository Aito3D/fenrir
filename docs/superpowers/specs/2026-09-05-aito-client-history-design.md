# Aito repeat-client recall — design

Date: 2026-09-05. Status: approved in chat, awaiting written review.

Fifth of six features from the 2026-09-03 brainstorm (after due date + rush,
the follow-ups strip, the print backlog badge and the pipeline widget).
When a Zoho client is picked in the new-project drawer, show their past cards
and let the operator reuse one card's tasks. Regular customers reorder the
same parts.

## Goal

1. One read-only endpoint, `GET /api/v1/aito/clients/{client_id}/history`,
   returning a client's most recent cards with their tasks.
2. A `ClientHistory` block in the drawer's Client section listing those
   cards, each with a Reuse button that appends the card's tasks to the draft
   as fresh, unticked rows.
3. A silent prefill of the social handle from the client's latest card,
   because Zoho does not store it and the operator otherwise retypes it on
   every job.

## Non-goals

- No new permission, setting, column, migration or write path.
- No duplicate-project endpoint: reuse is assembled client-side from the
  existing task-draft converter.
- Summary text, due date and shipping are never copied. Only tasks.
- No history on the board itself or in the detail panel.

## 1. Endpoint

`GET /api/v1/aito/clients/{client_id}/history?limit=5`

- Gated on `Permission.AITO_READ`. Declared in `routes/aito.py` BEFORE the
  `/{project_id}` routes (after `get_aito_stats`), or `clients` is parsed as
  an id.
- `limit` is a `Query` int, `ge=1, le=20`, default 5.
- `client_id` is the Zoho contact id string as stored in
  `aito_projects.client_id`. An unknown id returns an empty list, not a 404:
  the drawer asks for every non-default contact and most have no history.
- The default walk-in contact (`zoho_service.get_default_contact(db)[0]`)
  returns an empty response WITHOUT querying: its cards belong to everyone.
- Implemented in `services/aito_client_history.py`, one entry point
  `compute_client_history(db, client_id, limit) -> AitoClientHistoryResponse`,
  so the route stays a thin shell like `get_aito_stats`.

### Response

```
{
  "cards": [
    {
      "id": 42,
      "created_at": "2026-08-12T09:14:00",
      "column": "done",
      "total": 18500.0,               // TaskSummary.total of the card's tasks
      "tasks": [ AitoTaskResponse, … ] // in `position` order
    }, …
  ],
  "latest_social": { "network": "instagram", "handle": "moana.t" } | null
}
```

### Rules

- **Cards**: active projects (`status == 'active'`) with `client_id` equal
  to the path id, ordered `created_at DESC, id DESC`, first `limit` rows.
  Done cards are included (they are the history); trashed cards are not.
- **Tasks**: fetched for exactly those cards with the existing
  `_tasks_by_project` helper, in `position` order, serialised with the
  existing task response model. `total` is `summarise(tasks).total`, the
  same number the board card shows.
- **latest_social**: the `(client_social_network, client_social_handle)`
  pair of the newest ACTIVE card of this client that has both set. It is
  taken from the same ordered scan, not limited by `limit`: a regular whose
  last five cards were all phone-only still gets the handle from the sixth.
  The scan is one extra query restricted to rows where both columns are
  non-null, `LIMIT 1`. `null` when no card has a pair.

### Cost

Three small queries: the ordered card rows, their tasks, and the one-row
social lookup. All sit on `aito_projects.client_id`, which SQLite scans in
milliseconds at the board sizes in question (hundreds of cards). No cache.

## 2. Drawer — `components/aito/ClientHistory.tsx`

Mounted by `ClientSection` directly under the `ClientCombobox`, above the
phone row. Props: `clientId: string`, `isDefault: boolean`,
`onReuse: (tasks: AitoTask[]) => void`.

- Fetches `api.getAitoClientHistory(clientId)` under
  `queryKey: ['aito-client-history', clientId]`, `enabled: !isDefault &&
  clientId !== ''`, `staleTime: 60_000`. Because it keys on the ATTACHED
  client rather than on the pick event, a client restored from the persisted
  draft after a reload gets its history too.
- Renders nothing while loading, nothing when `cards` is empty, and nothing
  on error. Nothing here gates Create, so an error line would be noise; the
  block is a convenience, and silence in all three states keeps the section's
  layout stable.
- With rows: a header line `t('aito.pastCards', { count })` in `labelCls`,
  then one row per card, a `<ul>` of at most `limit` items:
  - creation date via `formatDate(created_at, { year: 'numeric', month:
    'short', day: 'numeric' })` (no time),
  - the stage label from `ALL_COLUMNS` (so Done reads "Done", not a raw id),
  - the total via `formatMoney(total, currency)`,
  - the task titles joined with ` · ` on one `truncate` line; an untitled
    task reads `t('aito.taskFallbackName', { n })` with its 1-based position,
  - a `Reuse` button (`aito.reuseTasks`, `focusRingCls`, `type="button"`)
    calling `onReuse(card.tasks)`. Disabled when the card has no tasks.
- `data-testid="client-history"` on the root, `data-testid="client-history-row"`
  on each row.

## 3. Reuse

`NewProjectDrawer` owns the handler and passes it down through
`ClientSection` (new prop `onReuseTasks`).

- Each `AitoTask` goes through `taskDraftFromAitoTask`, then
  `freshenTaskDraft` (new, in `utils/taskDraft.ts`): `id: null`, `uid:
  makeDraftUid()`, `done: { scan: false, modelisation: false, impression:
  false, usinage: false }`. Every other field — titles, descriptions, service
  costs, quantities, discounts, printer, filament, weight, time, colour,
  rush — is kept as quoted. The operator sees rush in the row and can untick
  it.
- Append rule: `tasks = [...tasks.filter((t) => !isBlankTaskDraft(t)),
  ...fresh]`. `isBlankTaskDraft` (new, in `utils/taskDraft.ts`) is true when
  the draft equals `emptyTaskDraft()` on every field except `uid` and `id`:
  empty title and four descriptions, all four costs `null`, `impression`
  with null printer/filament/weight/time, quantity 1, empty colour, rush
  false, no discounts, quantities 1. So the untouched first row a new draft
  opens with is replaced, and anything the operator typed is kept above the
  reused rows.
- The appended rows' keys are added to `revealedTaskKeys`, so a reused task
  that arrived unpriced (a card whose only service was later disabled) names
  itself immediately rather than waiting to be blurred.
- The Client section is open when Reuse is pressed, so the task signature
  changes without the section-open trigger. Reuse therefore applies the same
  rule `openClient` does: if `!summaryEdited` and the new `tasksSignature`
  differs from `summarySignatureRef.current`, store it and bump
  `generateNonce`. A hand-edited summary is never overwritten.
- A success toast: `showToast(t('aito.tasksReused', { count }), 'success')`
  via the existing `useToast`.
- The draft persistence hook picks the new rows up automatically: it mirrors
  `tasks` on every change already.

## 4. Handle prefill

In `NewProjectDrawer`, an effect watching `historyQuery.data?.latest_social`
and `draft`:

- Applies only when `draft` is non-null, `!draft.isDefault`,
  `latest_social` is non-null, `draft.socialNetwork === null` and
  `draft.socialHandle === ''`.
- Applies at most once per client id: a ref `socialPrefilledForRef` holds
  the last client id the prefill ran for; it is compared before applying and
  set after. Clearing the handle by hand therefore does not refill it, while
  picking a different client applies that client's pair.
- Sets `socialNetwork` and `socialHandle` on the draft. The social pair is
  card-only and never written to Zoho, so nothing in `touched`/`original`
  changes.
- The history query lives in `ClientHistory`, but the drawer needs the same
  data for this effect. Rather than lift the fetch, the drawer runs the same
  `useQuery` with the identical key and options; React Query dedupes, the
  precedent being the Zoho status query both the drawer and `ClientSection`
  already run.

## 5. API client

`frontend/src/api/client.ts`: `AitoClientHistoryCard { id; created_at;
column: AitoColumnId; total; tasks: AitoTask[] }`,
`AitoClientHistory { cards: AitoClientHistoryCard[]; latest_social: {
network: string; handle: string } | null }` (`network` stays a plain string
on the wire type; the prefill effect narrows it with `isSocialNetwork` from
`utils/clientDraft.ts` and skips a pair it does not recognise),
`getAitoClientHistory: (clientId: string, limit = 5) =>
request<AitoClientHistory>(`/aito/clients/${encodeURIComponent(clientId)}/history?limit=${limit}`)`.

Default msw handler in `src/__tests__/mocks/handlers.ts`:
`GET /api/v1/aito/clients/:clientId/history` → `{ cards: [], latest_social: null }`.

## 6. i18n

`aito.pastCards_one` / `aito.pastCards_other` (`{{count}}`),
`aito.reuseTasks`, `aito.tasksReused_one` / `aito.tasksReused_other`
(`{{count}}`), in all 13 locales (`frontend/src/i18n/locales/*.ts`), no
EN-identical values outside `en.ts`.

## 7. Testing

Backend (`tests/unit/test_aito_client_history.py`, seeded through the API
and direct ORM writes):
- newest first, `id DESC` tiebreak on equal `created_at`;
- `limit` honoured, 422 outside 1..20;
- trashed cards excluded, another client's cards excluded, Done included;
- unknown id → empty `cards`, `latest_social` null, status 200;
- the default contact id → empty response (assert no project query ran, by
  seeding a card under that id and checking it is not returned);
- `total` matches `summarise(...).total`; tasks in `position` order;
- `latest_social` comes from the newest card WITH a pair even when a newer
  card has none, and from beyond `limit`; null when no card has a pair;
- permission is `aito:read` (static-closure test alongside the existing
  `_declared_permissions` cases; the dependency parameter is named
  `current_user`).

Frontend:
- `ClientHistory.test.tsx`: rows from a fixture (date, stage label, money,
  titles with fallback names); absent on empty, on error and for the default
  contact (no request made); Reuse calls `onReuse` with the card's tasks;
  Reuse disabled on a card with no tasks.
- `NewProjectDrawer.test.tsx` (existing file, new cases): Reuse appends after
  a typed row; replaces a blank first row; reused drafts have `id === null`
  and no done ticks and fresh uids; the summary nonce bumps when the summary
  is unedited and not when edited; the handle prefills once from
  `latest_social`, never overwrites a typed handle, and refills for a
  different client.
- `taskDraft.test.ts`: `isBlankTaskDraft` true for `emptyTaskDraft()`, false
  for a title, a cost of 0, a weight, or a colour; `freshenTaskDraft` clears
  id, done ticks and issues a new uid while keeping prices.

## Open decisions, resolved

| Question | Decision |
|---|---|
| Recall view | Last 5 cards, compact rows, Done included, trash excluded |
| Reuse scope | Tasks with prices and print parameters; done ticks cleared; summary/due date/shipping untouched |
| Existing tasks | Append below; a blank untouched row is replaced |
| Handle recall | Prefill when empty, once per client id; default contact never |
| Where history comes from | Dedicated endpoint, not a client-side filter of the board list (the board response carries no task titles or prices) |
| Loading/empty/error | All silent; nothing here gates Create |
