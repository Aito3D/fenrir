# Aito Card Age From Quote Acceptance — Design

Date: 2026-08-02
Status: approved

## Problem

The board card's elapsed-time label and its aging heat ramp (see
`2026-08-01-aito-card-aging-heat-ramp-design.md`) both measure from
`project.created_at`. For a project whose quote has been **accepted**, the
clock that matters is "how long since the client said go" — production time —
not "how long since the quote was drafted". A job that sat three weeks in
`devis` waiting on the client looks three weeks late the moment work starts.

## Decision

When `quote_status === 'accepted'`, the card's elapsed label **and** its heat
ramp measure from a new `quote_accepted_at` timestamp; otherwise from
`created_at` exactly as today. Label and color always share one reference date
so they can never disagree.

Deliberate consequence (user-approved): hitting **Accept** on an old quote
visibly cools the card — a 20-day amber card returns to calm gray, because the
ramp starts measuring production time from the go-ahead.

## Data model

New nullable column on `aito_projects`:

```
quote_accepted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
```

UTC, like every other datetime on the row. Additive `ALTER TABLE` in
`backend/app/core/database.py:run_migrations()`, following the existing
column-existence-guard pattern.

### Stamping rule

Stamp `quote_accepted_at = utcnow()` on a **transition into `accepted` from
any other status** — and only at sites where the acceptance is *news*:

| Writer | Stamps? | Why |
|---|---|---|
| `set_quote_status` (routes/aito.py) — human clicks Accept in the panel | yes | The acceptance decision itself. |
| `reconcile_quote_status` undecided-adopt (aito_quote_sync.py:493) | yes | The client accepted in Books; polling just noticed. |
| `_update_quote` locked-quote adoptions (aito_quote_sync.py:563, 593) | yes | Same news, learned via an invoiced/tax-locked estimate. |
| Restore-from-trash (`restore_target`, aito_quote_sync.py:551) | **no** | Returns the pre-trash state; the job was accepted long ago and the old stamp survives. |
| Trash-decline (aito_quote_sync.py:542) | no | Not an acceptance. |
| Import / create (routes/aito.py:410) | no | A quote imported already-accepted has no known acceptance moment; NULL falls back to `created_at` ≈ import time, which is the honest answer. |

A small helper (e.g. `adopt_quote_status(project, new_status)`) owns the
transition check so the stamping sites cannot drift; the restore and trash
sites keep their direct assignments, each with a comment saying why they
bypass it. Re-acceptance after a decline **overwrites** — the latest go-ahead
wins. Leaving `accepted` (decline, conflict repair) keeps the value; it is
simply ignored while the status is not `accepted`, and still there if the
status comes back via restore.

### Backfill

One-time, in the same migration guard that adds the column (so it runs exactly
once, when the column is created):

```sql
UPDATE aito_projects SET quote_accepted_at = (
  SELECT MAX(occurred_at) FROM aito_events
  WHERE aito_events.project_id = aito_projects.id
    AND aito_events.kind = 'quote.accepted'
) WHERE quote_status = 'accepted';
```

`quote.accepted` events exist for panel acceptances and for client acceptances
mirrored from Zoho comments (with Books' own timestamp). Accepted projects
with no such event keep NULL and fall back to `created_at` — today's behavior.

## API

Expose `quote_accepted_at: datetime | None` in the Aito project response
schema; add the matching optional field to `AitoProject` in
`frontend/src/api/client.ts`. Not writable through the update endpoint — only
the stamping sites above may set it.

## Frontend

`CardView.tsx` (~lines 177–179) computes one reference date:

```ts
const accepted = project.quote_status === 'accepted' ? parseUTCDate(project.quote_accepted_at) : null;
const ageRef = accepted ?? created;
```

`ageRef` feeds both `formatElapsedTime` and `agingTextCls`. `aitoAging.ts` is
untouched — it already takes an arbitrary `Date`. The card's `title` tooltip
(full created/updated dates) is untouched. Scope is the board card only: the
detail panel, DoneGrid and TrashGrid never showed the ramp and do not change.

## Testing

Backend (pytest):
- Panel Accept stamps `quote_accepted_at`; Accept when already accepted does not move it.
- Decline then re-accept overwrites with the newer time.
- Decline alone preserves the existing stamp.
- Reconciler adopting Books' `accepted` stamps; adopting `viewed`/`expired` does not.
- Restore-from-trash of a previously-accepted project restores `accepted` without restamping.
- Migration backfills from the latest `quote.accepted` event and leaves eventless projects NULL.

Frontend (Vitest):
- Accepted card with `quote_accepted_at` ages (label + ramp class) from that date, not `created_at`.
- Accepted card with NULL `quote_accepted_at` falls back to `created_at`.
- Non-accepted card unchanged.
