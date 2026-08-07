# Aito — one flag control for Urgent and SAV

**Date:** 2026-08-06
**Status:** design approved, pending spec review
**Supersedes the control described in:** `2026-08-04-aito-urgent-flag-design.md`

## Problem

A project that comes back from the client — SAV, *service après-vente* — needs
the same "look at this one" treatment the Urgent flag already gives. It is not
urgent; it is *returned*. Today the board can say one of those two things and
only one.

The two are mutually exclusive by nature: a card is late, or it is back, never
both. So this is not a second flag beside the first. It is one flag with three
states, and the UI has to be one object with three states to match.

## Decisions taken

| Question | Decision |
|---|---|
| Board weight | SAV and Urgent are **peers** — same halo, same sort priority, same class of signal |
| Interaction | **Segmented pill** — a resting chip that opens into two choices on hover/focus/tap |
| SAV colour | **rose-400 `#fb7185`** (border rose-500 `#f43f5e`) |
| SAV glyph | lucide **`RotateCcw`** — the job came back |
| Storage | **one nullable column**, not two booleans |

Rose was chosen over fuchsia knowing it sits nearer the destructive red. The
mitigation is positional, and it holds: destructive red lives on the panel's
**footer bar** (Supprimer) and on the quote's Refuser action. The flag lives in
the **header pill row**. The two never share a strip, and inside the header row
rose's only neighbours are green (quote), sky (destination) and amber (the
other flag) — all far away in hue.

## Data model

Add one column, do not add a second boolean:

```sql
ALTER TABLE aito_projects ADD COLUMN flag VARCHAR(16);       -- nullable
UPDATE aito_projects SET flag = 'urgent' WHERE urgent = 1;   -- backfill
```

`flag` is `'urgent'`, `'sav'`, or `NULL`. Two booleans would make "both at
once" a *writable* state, which would then have to be forbidden by hand in the
route, in the optimistic transform, and in both sort comparators — four places
to get the same invariant wrong. One column makes the illegal state impossible
to express, and every sort stays a single comparison.

Both statements go in `database.py:run_migrations()` beside the 2026-08-04
`urgent` migration, following the file's existing additive-ALTER convention and
its `is_sqlite()` dialect split where needed.

**The old `urgent` column is left in the table and goes dead.** Dropping
columns is not this file's pattern. The `urgent` attribute is removed from the
`AitoProject` model so nothing can read or write it by accident — inserts still
succeed because the column keeps its `NOT NULL DEFAULT 0`. A comment at the
migration site records that the column is dead and that `flag` replaced it, so
the next person does not revive it.

## API

`PATCH /aito/{id}/urgent` becomes `PATCH /aito/{id}/flag`.

```python
AitoFlag = Literal["urgent", "sav"]

class AitoFlagUpdate(BaseModel):
    flag: AitoFlag | None          # None clears
```

`AitoProjectResponse.urgent: bool` becomes `flag: AitoFlag | None`.

Everything the urgent route earned stays, for the same reasons documented in
its docstring — carry that reasoning over rather than rewriting it:

- It stays **its own route**, and still does **not** call `_mark_pending_if_ours`.
  Zoho has no field for either flag, so a push would carry nothing, would churn
  `quote_sync_state` on locked quotes, and would fill the timeline with
  `sync.queued` noise from a purely local toggle. The existing test asserting
  the sync state survives must be kept and retargeted.
- It reuses `Permission.AITO_UPDATE`. A new permission would need adding to the
  API-key classification lists and the role defaults, and "may edit an Aito
  card" is exactly the right authority.
- It stays **idempotent**: re-sending the value the row already holds is a 200
  with no event, so a double-tap does not spam the timeline.

## History

Four kinds, not one parameterised kind:

```python
"project.urgent.set": "story",      # unchanged — historical rows reference it
"project.urgent.cleared": "story",  # unchanged
"project.sav.set": "story",         # new
"project.sav.cleared": "story",     # new
```

`record()` does take a `detail` dict, so a single `project.flag.changed`
carrying `{from, to}` was possible. Four kinds win because `eventKinds.ts` maps
kind straight to an i18n label with no payload-aware renderer, and because the
two urgent kinds already exist in `KINDS` and in every locale.

Switching directly from Urgent to SAV therefore writes **two** rows —
`project.urgent.cleared` then `project.sav.set`. Two things did change, so two
rows is the honest record, and it needs no new rendering path.

## Board behaviour

Peers, so every ordering rule tests "flagged at all", never "which flag":

- `utils/aitoBoard.ts` — `Number(b.urgent) - Number(a.urgent)` becomes
  `Number(!!b.flag) - Number(!!a.flag)`, `position` still breaking ties.
- `routes/aito.py:list_projects` — `AitoProject.urgent.desc()` becomes
  `AitoProject.flag.is_(None)` ascending (nulls last).
- `routes/aito.py` reorder — `key=lambda row: not row.urgent` becomes
  `key=lambda row: row.flag is None`.

The existing comment about flagged cards snapping back above normal ones stays
true and stays where it is.

## Card halo

Today `.animate-urgent-halo` hard-codes amber. It becomes one hue-parameterised
animation plus two tone classes, so there is one keyframe block to maintain
rather than two that must be kept in step:

```css
@keyframes flag-halo {
  0%   { box-shadow: 0 0 0 0   rgb(var(--flag-halo) / .26), 0 0 9px -3px rgb(var(--flag-halo) / .42), var(--card-shadow); }
  70%  { box-shadow: 0 0 0 4px rgb(var(--flag-halo) / 0),   0 0 9px -3px rgb(var(--flag-halo) / .42), var(--card-shadow); }
  100% { box-shadow: 0 0 0 0   rgb(var(--flag-halo) / 0),   0 0 9px -3px rgb(var(--flag-halo) / .42), var(--card-shadow); }
}
.animate-flag-halo { border-color: var(--flag-border); animation: flag-halo 3.4s ease-in-out infinite; }
.flag-urgent { --flag-halo: 251 191 36;  --flag-border: var(--status-warning); }  /* amber-400 / amber-500 */
.flag-sav    { --flag-halo: 251 113 133; --flag-border: #f43f5e; }                /* rose-400 / rose-500  */
```

The border is a step deeper than the halo in both tones, preserving the reason
the amber pair was chosen: the card's own edge must still read as an edge
against its own glow. Urgent keeps `var(--status-warning)` rather than a literal
hex, because that token is the app's fixed semantic amber and must not shift
when the user changes accent colour. Rose has no such token and is written
literally, for the same fixed-semantic reason — it must not follow the accent
either.

**Both halves of the existing cascade note carry over verbatim and the rewrite
is wrong without them:**

1. These rules are **unlayered**, which outranks every Tailwind utility layer
   regardless of specificity. That is how one class beats the card's
   `hover:border-bambu-green/40` with no specificity padding — do not add any.
2. An unlayered rule still loses to a **later** unlayered rule in the same
   file, and `.card-shadow` sits further down on the same element. The running
   animation escapes that because animations outrank normal declarations; the
   reduced-motion fallback is a plain declaration and does not, so it keeps the
   doubled-class form `.animate-flag-halo.animate-flag-halo`.

The reduced-motion fallback keeps the signal as a static glow, parameterised
the same way.

`CardView` picks the class from a **static lookup**, not an interpolated class
name — these are hand-written CSS classes so interpolation would work, but a
`Record<AitoFlag, string>` keeps them greppable and makes an unhandled flag a
compile error.

## The control — `FlagControl`

Replaces `UrgentButton.tsx`. Panel header only, never the board card: flagging
is a deliberate act that belongs where the project is open in front of you.

**Resting, unflagged.** One ghost chip, `Marquer`, with a `Flag` glyph — the
same `.4rem` outline and 11px semibold as its pill neighbours, no colour it has
not earned.

**Open.** On hover, focus, or tap of the resting chip, the container widens and
two segments slide in: `⚠ Urgent │ ↺ SAV`, a hairline between them. The border
belongs to the **container**, not the segments, so it reads as one object
opening rather than two buttons appearing.

**Set.** Hold either segment 0.5s. The container collapses onto that segment
alone, now filled in its tone. At that point it *is* the status pill — same
construction as the destination pill beside it — and the control that sets it
is the same object, which is the whole reason the flag lives in this row.

**Clear / switch.** Opening a set control shows both segments with the live one
tinted. Holding the live one clears it; holding the other switches directly, no
clear-then-set.

### Why a hold, and why only for the destructive half

Symmetric 0.5s holds to set *and* clear, for the reason the urgent button
already documents: a flagged job is exactly the thing that must not be
un-flagged by a stray click, and a gesture deliberate in one direction and
casual in the other invites precisely that.

**Opening is not one of those gestures.** In the mockup the resting chip also
required a hold to expand; that is wrong and does not ship. Expanding reveals a
choice and changes nothing, so the resting chip is a plain `<button>` with a
click handler.

### Reusing `HoldButton`

The segments are `HoldButton`s with `progress="bar"` — the bar variant exists
precisely because the ring's `viewBox="0 0 24 24"` lands as a small circle
floating over a wide label. Each supplies its own padding, border-width and
colours **in full**, as every caller must: the base sets none of them, because
same-specificity Tailwind utilities resolve by compiled stylesheet order rather
than call site. Radius goes through `radiusClassName`, and segments pass
`rounded-none` — the container owns the corners.

`HoldButton` needs **one new prop**: an opt-out for the outer `scale-[1.08]`
press affordance. Scaling one segment inside a shared bordered container with
`overflow-hidden` clips and reads as broken. Add `pressEffect?: 'scale' | 'none'`
defaulting to `'scale'`, so no existing caller changes. The bar fill already
carries progress on its own.

### Motion

The open/close is a `max-width` + `opacity` + `padding` transition at
**260ms `cubic-bezier(.22, 1, .36, 1)`** — the same decelerating curve family
the panel already uses, chosen so the pill settles rather than snapping. Under
`motion-reduce` the transition is dropped and the segments simply appear; the
control must stay fully usable with no animation at all.

A short bump on commit (`scale` 1 → 1.09 → 1, 340ms) confirms the change landed,
matching the existing `animate-hold-bounce`.

### Keyboard, touch, assistive tech

- Each segment is a real `<button>`, reached with Tab, held with Enter/Space —
  `HoldButton` already does this.
- **Focus opens the control exactly as hover does**, so nothing is
  mouse-only. `focusout` collapses it only when `relatedTarget` is outside the
  container.
- Touch has no hover, so: tapping the resting chip opens; a document-level
  outside `pointerdown` collapses; a successful set collapses.
- `aria-pressed` on each segment reflects the live flag.
- The card's `sr-only` flag text stays and names the actual flag — the halo is
  a box-shadow and a border colour, neither of which is announced, so dropping
  it would make the flag purely visual rather than merely non-textual.
- `hintPlacement="bottom"` stays: the panel root is `overflow-hidden` and this
  sits on the header's first row, so an upward hint is clipped away entirely.
- The wrapping `flex-shrink-0` span stays. `HoldButton`'s outer div — not its
  button — is what lands in the flex row, so the class cannot go through
  `className`, and without it a long client or island label squeezes the
  control out of shape.

## Optimistic mutation

`useUrgentMutation` becomes `useFlagMutation`, keeping its shape:

- The transform **only sets the field, never reorders** — `buildBoard` sorts
  flagged-first on every render, so setting the field is enough to move the
  card, and duplicating the comparator here would be a second place to get it
  wrong.
- `onSuccess` still writes the **server's row** over the prediction: it carries
  the real `updated_at` and recomputed derived fields.
- Still invalidates `['aito-events', id]`.
- `aitoOptimistic.ts` — a fresh placeholder gets `flag: null`; the existing
  comment about a flag being a workshop signal applies unchanged.

## i18n

New keys under `aito.`: `sav`, `markSav`, `clearSav`, `holdToMarkSav`,
`holdToClearSav`, `markFlag` (the resting chip), and history labels
`projectSavSet` / `projectSavCleared`. `urgentFailed` becomes `flagFailed`
("Impossible de modifier le marqueur") since one control now owns both.

**The label is translated per locale, not left as "SAV" everywhere.** English
gets `'Returned'`, French `'SAV'`, and each other locale its own term. This is
not only correct, it is required: `check-i18n-parity.mjs` rejects any
non-English leaf identical to English unless allowlisted, so thirteen copies of
`'SAV'` would fail the gate and need thirteen allowlist entries to paper over.

All thirteen locale files must gain every new key — `locales.test.ts` asserts
exact key-set equality in both directions.

## Test sweep

**Landmine, from the shipping-service work:** `tsconfig.app.json` excludes
`src/__tests__`, so neither `tsc --noEmit` nor `npm run build` type-checks test
files. Renaming `urgent` on the shared interface produces **no compiler error in
fixtures**. Sweep by **field name**: `grep -rn "urgent" frontend/src/__tests__`.

Frontend: `UrgentButton.test.tsx` → `FlagControl.test.tsx`; plus fixture and
assertion updates in `AitoCardView`, `aitoBoard`, `aitoOptimistic`, `aitoSearch`,
`AitoDetailPanelOptimistic`, `ProjectDetailPanel`, `AitoPage`,
`AitoBoardCardActions`, `AitoBoardColumnDrag`, `AitoDoneGrid`, `AitoTrashGrid`.

The card's `data-testid="aito-card-urgent"` becomes `aito-card-flag` — a testid
asserting "urgent" on a returned card is a lie.

Backend: `test_aito_routes.py` — retarget the urgent route tests, keep the
sync-state-survives assertion, and add coverage for the switch writing two
events and for the idempotent no-op writing none.

**Do not touch** `models/project.py`, `routes/projects.py`, `ProjectsPage`,
`ProjectDetailPage` or `AddNotificationModal`. Their `urgent` is a *priority*
enum value on the unrelated Projects feature.

## Out of scope

- Filtering or searching the board by flag.
- Any Zoho representation of either flag.
- Flagging from the board card. The panel stays the only place.

## Verification

`cd frontend && npm run build`, then `./test_frontend.sh`, `./test_backend.sh`,
and `npm run check:i18n`, all from the project root.
