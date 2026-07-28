# Aito: task summary on the card, and a wide two-column layout

Date: 2026-07-28
Status: approved by user (brainstorming session)

## Goal

Two changes to the Aito board, from one request:

1. **Show a project's tasks on its board card** — as aggregated service badges,
   a task count and a total, not as task rows.
2. **Use the width of the screen** — the create modal and the detail panel are
   both `max-w-md` (448px) and far too tall. Both go to `max-w-5xl` with a
   two-column body, and the Impression3D block inside each task splits so its
   cost breakdown sits beside its inputs rather than below them.

## Findings that shaped the design

### The services are already laid out horizontally

`TaskRow` renders Scan3D / Modelisation3D / Usinage in
`grid-cols-1 sm:grid-cols-3` and `ImpressionFields` renders its six inputs in
`grid-cols-1 sm:grid-cols-2`. Tailwind's `sm:` is a **viewport** query, not a
container query, so on any desktop viewport those grids are already active —
inside a 448px modal. Three number inputs share ~130px each; the printer and
material `SearchableSelect`s share ~200px each.

So there is no stacked-layout problem to fix. The layout is horizontal and
starved. **Width is the entire remedy**, and the grids need only their column
counts revisited once there is room.

### The height comes from the breakdown, not the inputs

Per task, the vertical bands are: title, description (2 rows), one row of three
cost inputs, three rows of Impression3D inputs, the **eight-line** cost
breakdown, and the task total. The breakdown is the single largest block and
grows with nothing — it is eight fixed `justify-between` rows.

Stacked under a 620px column it costs eight lines of height. Placed beside the
inputs it costs none, because the inputs are already three rows tall. That is
the largest height win available without hiding information.

### `GET /aito/` deliberately excludes tasks

`list_projects` returns projects only. That was a deliberate call when tasks
were added: it is the hottest request on the page, refetched on every WebSocket
invalidation, and shipping every task row of every card would be wasteful.

Putting task information on the card revisits that decision, but not that
reasoning. The card needs **four small aggregate values**, not task rows, and
they can be produced by one grouped query.

### A PATCH response replaces the cached card

`ProjectDetailPanel` writes the update response straight into the board cache:

```ts
queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
  prev?.map((p) => (p.id === updatedProject.id ? updatedProject : p)) ?? prev,
);
```

It **replaces** the row, so any response that omits the new aggregate fields
silently blanks the card's badges until the next fetch. Every endpoint that
returns an `AitoProjectResponse` must therefore carry the summary — not just
`GET /aito/`. This drives the "required parameter" decision below.

## Part 1 — Task summary on the card

### Response shape

`AitoProjectResponse` gains three fields:

| Field | Type | Meaning |
|---|---|---|
| `task_count` | `int` | Number of tasks on the project |
| `tasks_total` | `float` | Sum of every task's four costs |
| `task_services` | `list[str]` | Which services any task enables |

Named `tasks_total`, not `task_total`, because the frontend already has
`taskTotal` for a *single* task's total. Two names one letter apart for
different scopes is a bug waiting to be written.

`task_services` values are drawn from the fixed set
`scan`, `modelisation`, `impression`, `usinage`, and are always emitted in
**that canonical order** regardless of task insertion order, so the badge row is
stable across refetches.

### The aggregate query

One helper, `_task_summaries(db, project_ids) -> dict[int, _TaskSummary]`,
issues a single grouped query:

```python
select(
    AitoTask.project_id,
    func.count().label("count"),
    func.sum(
        func.coalesce(AitoTask.scan_cost, 0.0)
        + func.coalesce(AitoTask.modelisation_cost, 0.0)
        + func.coalesce(AitoTask.usinage_cost, 0.0)
        + func.coalesce(AitoTask.impression_cost, 0.0)
    ).label("total"),
    func.max(case((AitoTask.scan_cost.isnot(None), 1), else_=0)).label("scan"),
    # ... the same MAX(CASE ...) for modelisation, impression, usinage
)
.where(AitoTask.project_id.in_(project_ids))
.group_by(AitoTask.project_id)
```

Projects with no tasks are absent from the result and default to
`count=0, total=0.0, services=()`.

**`IS NOT NULL`, not `> 0`** — this is the whole `null` = disabled / `0` = free
invariant the task feature is built on. A service priced at zero is enabled and
must show its badge. A `> 0` test would silently drop it.

### Threading it through

`_to_response(p, summary)` takes the summary as a **required** second
parameter. Required, not defaulted, because of the `setQueryData` hazard above:
a default would let a new endpoint quietly return zeros and blank a card's
badges, and nothing would fail. Required makes every one of the seven call
sites state its intent.

- `list_projects`, `list_trash` — one `_task_summaries` call for the whole page.
- `create_project` — after the commit that writes the tasks, so a project
  created with three tasks renders them immediately.
- `update_project`, `move_project`, `restore_project` — one call for that
  single project. It is one indexed lookup on a mutation path.
- `delete_project` returns 204 and never builds a response, so it is untouched.
- `import_projects` — the imported projects are task-free by construction, so
  it passes the empty summary explicitly.

### Keeping the card fresh

Three paths change a project's totals, and each needs a different answer:

| Change | Mechanism |
|---|---|
| Add / remove a task | Already invalidates `['aito-tasks', id]`; **also invalidate `['aito-projects']`** |
| Edit a task field | Deferred to panel close (below) |
| Edit the description | Nothing to do — the PATCH response now carries the summary |

Task-field edits PATCH per keystroke and must **not** invalidate the board — a
board refetch per keystroke is indefensible. Instead `ProjectDetailPanel` sets a
`tasksDirty` ref in `updateTaskMutation.onSuccess` and invalidates
`['aito-projects']` on unmount **only if that ref is set**. A panel opened and
closed without edits costs no extra fetch; one where a cost changed refreshes
the card at exactly the moment the user looks back at it.

### The card

The summary row goes **inside the existing body button**, below the description,
so the whole content area remains one target that opens the panel. It renders
nothing at all — no empty row, no zero — when `task_count === 0`, so today's
task-free cards are pixel-identical.

```
┌─────────────────────────────┐
│ ACME SARL                ⠿ │
├─────────────────────────────┤
│ Support de caméra pour      │
│ drone, 2 pièces             │
│                             │
│ [Modelisation3D]            │
│ [Impression3D]              │
│ 2 tasks         20 200 XPF  │
├─────────────────────────────┤
│ 3h                        🗑 │
└─────────────────────────────┘
```

Badges reuse the **existing** `aito.serviceScan3D` / `serviceModelisation3D` /
`serviceImpression3D` / `serviceUsinage` keys. Those are the shop's service
names and are byte-identical in all twelve locale files today, so no
abbreviation and no new translation surface is needed. At `text-[10px]` in a
`flex-wrap` row, a card using all four wraps to two lines on the narrowest
column — acceptable, and honest about the names rather than inventing "Modél".

The total uses the same `Money` component and `settings.currency` the task
editor uses, so the card and the panel cannot disagree about formatting.

### The drift risk, stated plainly

`SUM(COALESCE(...))` in SQL duplicates `taskTotal` in
`frontend/src/utils/taskDraft.ts`. If the definition of a task's total ever
changes, the card and the panel disagree and nothing fails.

There is no cheap automated guard: the two live in different languages and the
aggregate is not reachable from a JS test. So this is handled by **cross-
referencing comments in both places** plus a backend test that pins the exact
four columns summed. That test catches an accidental change to the existing
expression; it does **not** catch someone adding a fifth service column and
forgetting the aggregate. That gap is real and is accepted, not papered over.

## Part 2 — The wide layout

### Both surfaces

`max-w-md` → `max-w-5xl` (1024px) on `NewProjectModal` and
`ProjectDetailPanel`. `max-h-[calc(100vh-2rem)]` is unchanged — the goal is to
fill the height less often, not to allow more of it.

The panel matches the modal at `max-w-5xl` rather than sitting narrower. The
consequence is a more dramatic card→panel morph: the shared
`view-transition-name` now interpolates from a ~300px card to a 1024px panel.
The browser handles the geometry, but the animation reads differently and wants
an eyeball — jsdom cannot test View Transitions.

### The body becomes two columns

```
┌────────────────────────────────────────────────────────────┐
│ New Project                                             ✕ │
├──────────────────────┬────────────────────────────────────┤
│ Client   [ACME    ▾] │ Tasks               Total  20 200  │
│ Phone    [+689-87…]  │ ┌─ Boîtier ──────────────────────┐ │
│ Email    [hi@acme…]  │ │ Scan [  ] Modél [4000] Usin [] │ │
│                      │ │ Impression3D                   │ │
│ Description          │ │ [X1C  ▾][PLA ▾]  Filament  620 │ │
│ [                  ] │ │ [120g ][4h30m]   Amort.    180 │ │
│ [                  ] │ │ [Noir ][  2   ]  Energy     40 │ │
│                      │ │                  …             │ │
│                      │ │                  Total   9 500 │ │
│                      │ └────────────────────────────────┘ │
└──────────────────────┴────────────────────────────────────┘
```

- Grid: `lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]`. Left column ~320px
  (client block + description), right column takes the rest (~656px).
- **Below `lg:` it collapses to one column.** At phone width a two-column form
  is unusable, and the current single-column layout is already correct there.
- **One scroll container, not two.** The body keeps its single
  `overflow-y-auto`; the grid lives inside it. Independent per-column scrolling
  means two scrollbars, nested scroll containers, and focus-scroll surprises
  when tabbing between columns — real cost, and the left column is short enough
  that there is nothing to gain.

For the panel the left column carries the labelled client `<dl>` and the
description; the project metadata rows (Created / Last activity / Stage) stay
with it, keeping the existing single-`<dl>` structure intact.

### Inside a task

Two changes, both enabled by the ~620px the right column now has:

**Impression3D splits.** `ImpressionFields` becomes
`lg:grid-cols-2` at its top level: inputs on the left (staying
`sm:grid-cols-2` within their half), the cost breakdown on the right. The
breakdown's eight lines now overlap the inputs' three rows instead of adding to
them. Below `lg:` it stacks exactly as today.

**Nothing else changes.** The three flat-service inputs keep
`sm:grid-cols-3` — they were never the problem, they were merely starved, and
620px gives each ~200px instead of ~130px.

### What is deliberately not done

- No container queries. Tailwind 4 supports them, but the surfaces have exactly
  two states (wide desktop, narrow everything-else) and viewport queries express
  that with no new machinery.
- No collapsible cost breakdown. It would shorten the task further, but hiding
  the quote's arithmetic behind a disclosure is a product decision, not a layout
  one, and was not asked for.

## Testing

**Backend**

- `GET /aito/` returns `task_count`, `tasks_total` and `task_services` for a
  project with tasks, and `0 / 0.0 / []` for one without.
- **A task with `scan_cost=0` and the other three `NULL`** yields
  `tasks_total=0.0` and `task_services=["scan"]`. This is the `null` vs `0`
  invariant; the test must be shown to fail if the aggregate uses `> 0`.
- `task_services` comes back in canonical order when the enabling tasks were
  inserted in a different order.
- `tasks_total` is the exact sum of the four cost columns for a task with a
  distinct non-zero value in each — the pin against silent drift.
- `_task_summaries` returns entries for several project ids from **one** call,
  and returns `{}` for an empty id list without touching the database.
- `PATCH /aito/{id}` (description-only) returns the project's real summary, not
  zeros — the `setQueryData` hazard, tested directly.
- `POST /aito/` with two tasks returns `task_count=2` in the creation response.

**Frontend**

- `CardView` renders a badge per entry in `task_services`, the count, and the
  formatted total.
- `CardView` with `task_count: 0` renders **no** summary row — asserted by
  absence of the count text, not by a snapshot.
- The panel invalidates `['aito-projects']` when a task is added and when one is
  removed.
- The panel invalidates `['aito-projects']` on close **after** a task-field
  edit, and does **not** invalidate on close when no task was edited. Both
  directions, or the `tasksDirty` guard is untested.

**Not tested, and why:** the layout itself. jsdom computes no CSS grid, so any
assertion would be a class-name string match — it would pass with a broken
layout and fail on a harmless refactor. The two-column layout, the wrapped badge
row and the card→panel morph are verified by eye.

**Existing-test impact**, counted against the files rather than estimated:

- Four typed `AitoProject` fixtures gain the three fields —
  `__tests__/utils/aitoBoard.test.ts:12` (a factory, one edit),
  `__tests__/components/ProjectDetailPanel.test.tsx:10`,
  `__tests__/components/AitoCardView.test.tsx:8`,
  `__tests__/components/AitoBoardColumnDrag.test.tsx:67`.
- MSW handlers returning project JSON are untyped and will not fail the
  compiler, but they must be updated anyway: a handler omitting the fields
  renders cards in a state the server can no longer produce, which makes those
  tests quietly stop covering the real shape.

## i18n

One new key in all twelve locale files, genuinely translated, using i18next's
plural suffixes (`aito.taskCount_one` / `aito.taskCount_other`, and whatever
plural categories each locale actually needs):

| Key | English |
|---|---|
| `aito.taskCount` | `{{count}} task` / `{{count}} tasks` |

Nothing else is new. The four service names reuse the existing
`aito.serviceScan3D` family, and the task editor's "Project total" heading in
the wide layout is the existing `aito.projectTotal`.

## Out of scope

- Rendering task rows themselves on the card.
- Debouncing the task-field PATCH (a known backlog item, unchanged here).
- Any change to `frontend/src/utils/pricing.ts`.
- Collapsing or restyling the cost breakdown's content.
