# Aito — the Pause flag

**Date:** 2026-08-07
**Status:** design approved, pending spec review
**Builds on:** `2026-08-06-aito-sav-flag-design.md`

## Problem

A project stalls because the workshop is waiting on the client — a dimension to
confirm, a colour to pick, a go-ahead. Nothing is wrong with it and nobody is
late; there is simply nothing to do until the client answers.

Today the board cannot say that. The card sits in its column looking exactly
like the ones that *are* actionable, and every pass down the column costs
someone the same rediscovery: *ah yes, that one, we're waiting on them.*

So this is a third value of the existing flag. But it is not a third **peer**.
Urgent and SAV both mean *look at this*; Pause means the opposite. Treating it
as a peer would sort the one card you cannot act on above the ones you can, and
give it the same breathing halo the board uses to demand attention. The whole
design below follows from taking that inversion seriously.

## Decisions taken

| Question | Decision |
|---|---|
| Exclusivity | **Mutually exclusive** with Urgent and SAV — still one `flag` column, one value |
| Board order | **Sinks to the bottom** of its column, mirroring Urgent floating to the top |
| Card treatment | **Receded to 60 % opacity + a static tinted edge.** No halo, no pulse |
| Colour | **teal-400 `#2dd4bf`** tone, **teal-500 `#14b8a6`** edge |
| Glyph | lucide **`Pause`** |
| Storage | **no migration** — see below |

Chosen from a rendered comparison of six treatments (watermark at 30 % opacity,
watermark receded, diagonal watermark, pulsing edge, receded + edge, receded
alone, receded + corner glyph) against seven hues.

## Data model — nothing to migrate

`flag` is already `Mapped[str | None] = mapped_column(String(16), nullable=True)`.
`'pause'` is five characters. **There is no ALTER, no backfill, and no
migration of any kind** — the change is a `Literal` widening in Python and a
union widening in TypeScript.

This is the single-column decision from the SAV spec paying off exactly as it
was meant to. Two booleans would have needed a third, plus a fresh round of
"forbid the illegal combinations" logic in the route, the optimistic transform
and now *three* comparators.

## API

The route does not change shape. Only the type widens:

```python
AitoFlag = Literal["urgent", "sav", "pause"]     # schemas/aito.py:300
```

`PATCH /aito/{id}/flag` keeps everything it earned, for the reasons already
recorded in its docstring — it stays its own route, still does **not** call
`_mark_pending_if_ours` (Zoho has no field for any of the three), still reuses
`Permission.AITO_UPDATE`, and stays idempotent so a double-tap writes no event.

The two event maps at `routes/aito.py:86-87` are plain dicts keyed by the flag
string, so each gains one entry. No branching is added anywhere in the route
body: the existing clear-then-set sequence already handles a switch between
*any* two values, because it was written against `previous` and `payload.flag`
rather than against the two names that happened to exist.

## History

Two new kinds, following the four-kinds precedent rather than collapsing to a
parameterised one:

```python
"project.pause.set": "story",
"project.pause.cleared": "story",
```

The reasoning from the SAV spec carries over unchanged: `eventKinds.ts` maps
kind straight to an i18n label with no payload-aware renderer, so a
`project.flag.changed` carrying `{from, to}` would need a new rendering path
that six existing kinds do not need.

Switching Urgent → Pause therefore writes two rows, `project.urgent.cleared`
then `project.pause.set`. Two things changed; two rows is the honest record.

## Board ordering — the one substantive change

Every ordering rule today asks a **binary** question: "flagged at all?" Three
tiers cannot be expressed that way, so each site becomes a rank:

| Rank | Flag |
|---|---|
| 0 | `urgent`, `sav` |
| 1 | `null` |
| 2 | `pause` |

`position` still breaks every tie, exactly as now.

Three call sites must agree, and **each gets its rank from one named helper**
rather than open-coding the comparison. Three hand-rolled comparators is
precisely how the "flag says one thing here and another there" class of bug the
single-column design eliminated would return in a new form.

- **`utils/aitoBoard.ts:39`** — `Number(!!b.flag) - Number(!!a.flag)` becomes
  `flagRank(a.flag) - flagRank(b.flag)`, exported from the same module.
  Note the operand order flips: the old form was descending (`b - a`, truthy
  first), the rank form is ascending (`a - b`, rank 0 first). Getting this
  backwards inverts the entire board, so it is called out here rather than left
  to be noticed in review.
- **`routes/aito.py:571`** — `AitoProject.flag.is_(None)` becomes a SQLAlchemy
  `case()` returning the same three ranks, held in a module-level constant
  beside the event maps.
- **`routes/aito.py:1340`** — `key=lambda row: row.flag is None` becomes
  `key=lambda row: _flag_rank(row.flag)`. Python's sort is stable and the
  existing code already depends on that (the list arrives in `position` order),
  so relative order within each rank is preserved for free.

### The drag consequence, stated honestly

The comment at `routes/aito.py:1331` already records that a flagged card cannot
be dragged below a normal one — it snaps back on the next fetch, and that was
accepted deliberately rather than "fixed" by rewriting `position` on flag.

The symmetric consequence now exists: **a paused card cannot be dragged above a
normal one.** Same cause, same trade, same reason not to fix it. That comment is
updated to describe the three-tier behaviour rather than the two-tier one.

## Card treatment

`CardView`'s `FLAG_HALO_CLS` gains a third entry — and is renamed
**`FLAG_CARD_CLS`**, because "halo" stops being true the moment one of the three
values has no halo.

```ts
const FLAG_CARD_CLS: Record<AitoFlag, string> = {
  urgent: 'animate-flag-halo flag-urgent',
  sav:    'animate-flag-halo flag-sav',
  pause:  'opacity-60 hover:opacity-100 transition-opacity flag-pause-edge',
};
```

```css
/* Pause is the one flag that does NOT ask for attention, so it gets the
   inverse of the halo: the card recedes and keeps only a quiet edge. There is
   no keyframe here and none is wanted — a pulse is a call to action, and this
   card is precisely the one nobody can act on. */
.flag-pause-edge { border-color: #14b8a6; }   /* teal-500 */
```

**Why this needs none of the halo's cascade machinery.** The halo rules carry
two hard-won notes: unlayered-beats-Tailwind-layers, and
`.animate-flag-halo.animate-flag-halo` doubled to outweigh the later
`.card-shadow`. Only the **first** applies here. This rule is unlayered, so it
beats the card's `hover:border-bambu-green/40` with no specificity padding —
do not add any. The second does not apply at all, because `.card-shadow` sets
`box-shadow` and this sets `border-color`; they never collide. For the same
reason there is **no `prefers-reduced-motion` block**: there is no motion to
reduce.

**Opacity restores on hover.** A receded card is still a card someone will want
to read, and 60 % opacity on the text is a real cost when they deliberately
point at it. `hover:opacity-100` is a small addition beyond a literal reading of
the chosen treatment and is flagged here as such — it is easy to drop if it is
not wanted.

**Teal against the accent green.** `--color-bambu-green` is `var(--accent)`,
which the user can change. Default `#00ae42` reads clearly against `#14b8a6`,
but a user who picks a teal accent collapses that distance. This is the same
class of risk the SAV spec accepted for rose-against-destructive-red, and it
takes the same mitigation: the tones never share a strip. Teal is written as a
**literal hex, never a token**, so it does not follow the accent — identical
fixed-semantics reasoning to amber and rose.

The `sr-only` flag text and its `data-testid="aito-card-flag"` stay and pick up
the pause label. A border colour and an opacity are both unannounced, so
dropping it would make the flag purely visual.

## The control — a third segment

`FlagControl` gains `pause` in `TONE`, `CONTAINER_TONE` and `ORDER`, carrying
lucide's `Pause` glyph. The control uses **teal-400** throughout — text
`text-teal-400`, hold bar `bg-teal-400/25`, focus ring `ring-teal-400/40`, and
the set-state container `border-teal-400/30 bg-teal-400/[0.14]` — matching how
the amber and rose entries are built. Teal-500 appears only on the card edge,
keeping the "border a step deeper than the tone" rule both existing flags follow.

One thing is **not** done mechanically. The component currently holds five
`kind === 'urgent' ? … : …` ternaries covering label, hint and glyph. At two
flags that reads fine; at three each becomes a nested chain evaluated in a JSX
attribute, and every one of them is a place to put the wrong string against the
wrong flag. They collapse into a single record beside the existing `TONE`:

```ts
const COPY: Record<AitoFlag, { label: string; clear: string; hold: string; holdClear: string }> = { … };
const GLYPH: Record<AitoFlag, LucideIcon> = { urgent: AlertTriangle, sav: RotateCcw, pause: Pause };
```

This is the pattern the file already uses twice, it keeps every string
greppable, and it makes a future fourth flag a compile error rather than a
silently-missing label.

The divider rule `kind === 'sav' && open` becomes index-based — "every segment
after the first, while open" — since `sav` is no longer the last segment.

Everything else about the control is untouched and must stay untouched: the
symmetric 0.5 s holds, the plain-click open, `pressEffect="none"`,
`radiusClassName="rounded-none"`, `hintPlacement="bottom"`, the
`suppressNextRootFocusRef` dance in `choose()`, and the `restFocused` handling.
Those each solve a specific problem documented in place.

**Width.** Three open segments plus the container is meaningfully wider than
two. The wrapping `flex-shrink-0` span is what stops a long client or island
label squeezing the control, and it stays. The open width must be checked
against the panel header row at the narrow breakpoints during implementation —
this is the one part of the change that cannot be verified by reading.

## Optimistic mutation

`useFlagMutation` needs **no change at all**: it is already typed
`AitoFlag | null` and already only sets the field without reordering, because
`buildBoard` sorts on every render. Widening the union widens the hook for free.

`aitoOptimistic.ts` also needs no change — a fresh placeholder gets `flag: null`,
which is still correct.

## i18n

Seven new keys under `aito.`: `pause`, `markPause`, `clearPause`,
`holdToMarkPause`, `holdToClearPause`, and under `aito.history.`
`projectPauseSet` / `projectPauseCleared`.

All thirteen locale files must gain every key — `locales.test.ts` asserts exact
key-set equality in both directions.

**Each locale gets a real translation, not thirteen copies of "Pause".**
`check-i18n-parity.mjs` rejects any non-English leaf identical to English unless
allowlisted, so copies would fail the gate and need thirteen allowlist entries
to paper over. The label term per locale:

| en | fr | de | es | it | pt-BR | ru |
|---|---|---|---|---|---|---|
| Paused | En pause | Pausiert | En pausa | In pausa | Pausado | Приостановлен |

| tr | uk | ja | ko | zh-CN | zh-TW |
|---|---|---|---|---|---|
| Duraklatıldı | Призупинено | 一時停止 | 일시 중지 | 已暂停 | 已暫停 |

## Test sweep

**Landmine, unchanged from the SAV work:** `tsconfig.app.json` excludes
`src/__tests__`, so neither `tsc --noEmit` nor `npm run build` type-checks test
files. Widening a union produces **no compiler error in fixtures**. Sweep by
field name: `grep -rn "flag" frontend/src/__tests__`.

Frontend:
- `FlagControl.test.tsx` — the third segment renders, holds to set, holds to
  clear, switches directly from another flag, and `aria-pressed` tracks it.
- `aitoBoard.test.ts` — **a paused card sorts below unflagged ones** while an
  urgent card still sorts above them, in the same column. This is the test that
  would have caught the `a - b` / `b - a` inversion noted above.
- `AitoCardView.test.tsx` — a paused card carries the edge class and not
  `animate-flag-halo`; the `sr-only` label names the pause flag.
- Fixture updates wherever a `flag` value is asserted.

Backend, `test_aito_routes.py`:
- setting and clearing `pause` writes exactly one event each;
- switching `urgent` → `pause` writes two, cleared before set;
- re-sending `pause` on a paused row writes none;
- the existing "sync state survives a flag change" assertion is extended to
  `pause` rather than duplicated;
- `list_projects` returns urgent, then unflagged, then paused, within a column.

**Do not touch** `models/project.py`, `routes/projects.py`, `ProjectsPage`,
`ProjectDetailPage` or `AddNotificationModal`. Their `urgent` is a *priority*
enum on the unrelated Projects feature.

## Out of scope

- Filtering or searching the board by flag.
- Any Zoho representation of any flag.
- Flagging from the board card — the panel stays the only place.
- Auto-clearing the pause when the client replies. Nothing in the system knows
  that happened, and the model comment is explicit that a flag set by hand is
  cleared by hand.

## Verification

From the project root: `cd frontend && npm run build`, then `./test_frontend.sh`
and `./test_backend.sh`. The i18n parity gate is a **frontend** script and runs
from `frontend/`: `npm run check:i18n`.
