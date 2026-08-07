# Aito Multi-User Sync — Design

**Date:** 2026-08-07
**Status:** Approved approach (Option B, two phases); spec pending user review
**Branch:** `worktree-aito-multiuser-sync` (worktree from `origin/main`)

## Problem

The Aito Kanban board is used by several operators at the same time. Today:

- The board query (`['aito-projects']`) never refetches on its own — the only
  polling runs while a quote sync is pending (`useQuotePendingPoll`). Another
  operator's change is invisible until a window refocus or navigation.
- `POST /{id}/quote-status` applies any transition blindly: two operators can
  both Accept (double Zoho push, duplicate timeline events), or one can
  Decline a quote someone else just Accepted without ever learning about it.
- `PATCH /{id}` field edits are last-write-wins with no conflict detection —
  a slower save silently overwrites a colleague's changes.

Three distinct problem classes: **freshness**, **duplicate actions**,
**concurrent edits**.

## Decisions already made (with the user)

1. **Approach:** Option B — WebSocket events + server-side guards, then a
   presence layer. Delivered in two phases. CRDT/sync-engine approaches
   (Yjs, ElectricSQL, Liveblocks…) were rejected: the server is not a dumb
   store (rules engine, Zoho sync, server-authored timeline), so a replicated
   client document would create a second source of truth.
2. **Duplicate quote actions:** *hybrid* — repeating the same transition is
   an idempotent no-op (200 with current state, no second Zoho push, no
   duplicate event); a *conflicting* transition is a 409 with a clear
   message, and the client refreshes to show the real state.
   **Refined 2026-08-07 (user decision):** the 409 is *asymmetric* —
   `declined → accepted` stays ALLOWED because the panel deliberately offers
   Accept on a declined card to reopen it ("latest go-ahead wins", see
   QuoteStatusActions.tsx). 409 fires only on transitions a fresh UI never
   offers, which therefore can only come from a stale view: changing an
   *accepted* quote to anything else, and `declined → sent`.
3. **Presence lock style:** *soft lock* — banner + avatar badge, never
   read-only. The Phase-1 version check is the actual collision guard.

## Phase 1 — Events, idempotency, versioning

### 1a. Server → client change events (freshness)

Every Aito mutation endpoint broadcasts one message through the existing
`ws_manager` (`backend/app/core/websocket.py`) after its commit:

```json
{ "type": "aito_changed", "project_id": 123, "action": "move", "actor": "Paul" }
```

- One message type for the whole board. The client's response is always the
  same (invalidate the board query), so per-action message shapes are YAGNI.
  `action`/`actor` ride along for logging and for Phase 2 toasts.
- Broadcast to **all** connections (`ws_manager.broadcast`) — the board is a
  shared surface, not per-user data. The WS layer already authenticates at
  connect time.
- Endpoints covered: create, import, move, patch, flag, quote-status,
  quote-email (send), task create/patch/delete, delete, restore, events
  (comment added), and the background quote-sync loop
  (`aito_quote_sync`) when it mutates a project.
- Broadcast failures never fail the request (same best-effort stance as the
  Zoho push in `set_quote_status`).

**Frontend:** `useWebSocket.ts` gains an `aito_changed` case. It must respect
the board's existing write arbitration (`useBoardSync`):

- If `pendingWrites > 0`, **drop the event** — the arbitration's rule "the
  last write to settle always invalidates" already guarantees a refetch that
  postdates our own in-flight write.
- Otherwise invalidate `['aito-projects']` (and `['aito-trash']` for
  delete/restore actions). Debounced a few hundred ms so a burst (import of
  several quotes) coalesces into one refetch.
- No echo-suppression client id: the mutating client's own event either gets
  dropped by the rule above or costs one redundant GET. Not worth plumbing a
  client id through every mutation.

Degradation: WS down → behavior is exactly today's (stale until refocus).
No new failure mode.

### 1b. Idempotent quote transitions (duplicate actions)

`set_quote_status` (aito.py:1515) checks the current status before applying:

- **Same status requested** (`payload.status == project.quote_status`) →
  return 200 with the current project state. No `adopt_quote_status`, no
  rules re-run, no timeline event, no Zoho push.
- **Conflicting transition** — the quote already carries a different
  *terminal* decision (accepted ↔ declined) → 409 with a body naming the
  existing status. Non-conflicting progressions (draft → sent → accepted)
  stay allowed as today.
- Frontend: on 409, roll back the optimistic write, invalidate, and show a
  toast: *"This quote was already {accepted/declined} by someone else."*
  (new i18n keys in all locales — see the i18n gate).

### 1c. Optimistic concurrency on field edits (concurrent edits)

- New column `version INTEGER NOT NULL DEFAULT 0` on `aito_projects`
  (additive ALTER TABLE in `run_migrations()`), bumped by the server on
  every mutating endpoint. Explicit bump in each route (not SQLAlchemy
  `version_id_col` — the routes mutate rows directly and the mapper-level
  counter would be easy to bypass; an explicit `project.version += 1` in the
  shared response/commit path is auditable).
- `version` is included in `AitoProjectResponse`; the client stores it with
  the row it renders.
- **Guarded endpoints:** `PATCH /{project_id}` (field edits) and
  `PATCH /tasks/{task_id}` carry the version the client last saw
  (request body field `expected_version`). Mismatch → 409; the client
  refetches and shows *"This project was updated by someone else — please
  check and retry."* The user's typed values stay in the form so nothing is
  lost.
- **Unguarded (by design):** `move` (already guarded by the rules engine and
  position renumbering is order-tolerant), `flag` (toggle, last-write-wins
  is correct), `quote-status` (guarded by 1b), delete/restore (idempotent
  already), event/comment creation (append-only).
- Tasks: `expected_version` checks the *project's* version (tasks are part
  of the card the operator is looking at), and any task write bumps it.

## Phase 2 — Presence (soft)

Built entirely on the same WebSocket; no new transport.

- **Client → server:** when `ProjectDetailPanel` opens/closes,
  the client sends `{ "type": "aito_presence", "project_id": 123 | null }`
  over the existing socket (the WS route already has a receive loop).
- **Server:** `ws_manager` keeps `websocket.state`-level presence (which
  project each connection is viewing, plus the principal's display name
  stamped at connect; auth-disabled connections show as "Operator").
  On any presence change or disconnect, broadcast the full presence map:
  `{ "type": "aito_presence_state", "viewers": {"123": ["Paul"], …} }`.
  Full-state broadcasts (not deltas) make disconnect cleanup and reconnect
  trivially correct.
- **Frontend:** a small `useAitoPresence` hook stores the map.
  - Card badge: avatar initial(s) on cards someone else is viewing.
  - Panel banner: *"Paul is currently viewing this project"* when opening a
    card someone else has open. Editing stays enabled (soft lock); the
    Phase-1 version check catches real collisions.
  - Own presence is filtered out client-side (by user; auth-disabled mode
    shows all viewers, which is acceptable single-user behavior).
- Optional (nice-to-have, end of phase): action toasts from
  `aito_changed`'s `actor`/`action` fields — *"Marie moved a card to
  Print"*. Only if time allows; not part of the acceptance criteria.

## Error handling summary

| Failure | Behavior |
|---|---|
| WS disconnected | Board behaves as today (stale until refocus); reconnect logic already exists in `useWebSocket` |
| Broadcast raises | Logged, request still succeeds |
| 409 on quote-status | Toast naming the existing decision; invalidate + rollback optimistic write |
| 409 on PATCH (version) | Toast; refetch; form keeps the user's values |
| Presence map stale (crashed browser) | Connection drop removes it from `active_connections` → next full-state broadcast is clean |

## Testing

- **Backend (pytest):** idempotent quote-status (same-status no-op emits no
  event/Zoho call; conflict 409s), version bump on every mutating route,
  `expected_version` mismatch 409, broadcast called after commit (spy on
  `ws_manager`), presence state add/move/clear on disconnect.
- **Frontend (Vitest):** `aito_changed` handler invalidates when idle and
  drops when `pendingWrites > 0`; 409 toast paths; presence hook renders
  badges/banner from a fed map.
- Known gotchas honored: instance-level monkeypatching for singletons,
  fixtures swept by field name, i18n gate needs all locales, sidebar tests
  hardcode nav IDs (untouched here).

## Out of scope

- Offline support, field-level merge, CRDTs.
- Hard locking of any kind.
- Per-user filtered broadcasts of board data.
- Presence anywhere but the Aito board.
