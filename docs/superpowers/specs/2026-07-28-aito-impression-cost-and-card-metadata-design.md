# Aito: Impression3D cost input, service names, card metadata

Date: 2026-07-28
Status: approved by user (brainstorming session)

## Goal

Five changes to the Aito board, gathered in one session:

1. Impression3D gets a **Cost input** the user can type into, which the
   calculator parameters fill in when they can price the job. An imported
   quote's cost then shows up in that input instead of being invisible.
2. The import modal's **preview skeleton is removed**.
3. The four service names become **real translations** — Scan, Modeling,
   Printing, Machining — instead of the shop's French-flavoured literals
   repeated in all twelve locales.
4. The detail panel gains a **label on the description**, a **Seller** row
   taken from the quote, and a **Created by** row naming the webapp user.
5. Imported line costs must account for the **remise** (discount). This one is
   blocked on a fixture — see "Deferred" at the end.

Items 1–4 ship together and do not depend on item 5.

## Findings that shaped the design

### The imported cost already exists; nothing shows it

`_build_task` in `backend/app/services/aito_quote_import.py` already writes the
quote line's amount into `impression_cost`, and `taskTotal` already counts it.
But `TaskRow` renders no input for that field — the other three services each
get a `CostInput`, Impression3D gets only the calculator parameters. So an
imported cost is stored, summed into the totals, and never displayed anywhere
it can be read or corrected.

The fix is therefore a **display and edit** change: no new column, no new
draft field and no schema change for the cost itself. (Section 4 does add columns,
but for the seller and the creator, not for this.)

### The existing `hasEdited` scheme breaks under a visible input

`ImpressionFields` reports its recomputed total through a `useEffect` gated on
a `hasEdited` flag, and `TaskRow` wraps the callback in an equality guard to
stop the render loop that follows (the callback identity is fresh every
render, so the effect re-fires on every render, not only when the total moves).

With a visible Cost input this scheme is actively wrong:

1. User edits a print parameter → `hasEdited` becomes true.
2. User types a manual cost into the Cost input → `impressionCost` = 50.
3. `TaskRow` re-renders → fresh callback identity → the effect fires again →
   reports the *computed* total (142.50) → the equality guard sees 50 ≠ 142.50
   and lets it through → the manual entry is stomped.

`hasEdited` cannot fix this: it means "edited at some point during this mount",
not "edited since the last report".

**The report moves into `handleChange`.** When a print parameter changes,
`ImpressionFields` prices the *next* draft directly and reports it, then and
only then. This is both correct and smaller: the effect, the `hasEdited` flag,
and `TaskRow`'s equality guard all go away.

### The calculator must not clear an imported cost

An imported task carries a cost but has `impression_printer_id` and
`impression_filament_id` set to `NULL` — the quote names a material in prose,
not a calculator filament id. `computeImpressionCost` returns `null` for an
incomplete parameter set.

So a naive "report whatever the computation returns" would mean: open an
imported task, adjust the colour, and the 142.50 from the quote is silently
replaced by `null` — which does not merely blank the field, it **disables the
service** (`null` = disabled, per `enabledServices`), dropping the badge and
the amount from the project total.

**Rule: the calculator writes into Cost only when it produces a number.** A
`null` result leaves the existing cost untouched. Clearing a cost is done by
emptying the input, which is the same gesture the other three services use.

### The Cost input must survive an unconfigured calculator

`ImpressionFields` returns early with "No printers configured in the calculator
yet" when `printers` or `filaments` is empty. A shop that imports quotes but
has not set up the calculator would then have no way to see or edit an imported
Impression3D cost.

The Cost input therefore lives in `TaskRow`, outside that early return.

### Fixtures cannot answer the discount question

All six captured estimates in `backend/tests/fixtures/zoho_estimates/` are
hand-trimmed to eleven keys (`sub_total` is absent, which no real Zoho response
omits) and every one has `discount: null` on every line and at the estimate
level. There is no ground truth for which discount fields this organisation
returns, nor for whether an inclusive-tax line's `discount_amount` is expressed
TTC or HT. Coding it from the API docs alone would be a guess that produces
plausible-looking wrong money.

## Decisions

| Decision | Choice |
|---|---|
| Impression3D cost | One input in the section header, bound to `task.impressionCost` |
| Calculator interaction | Editing a parameter overwrites Cost — but only when it prices |
| Cost reporting | Synchronous, from `handleChange`; the effect and `hasEdited` are deleted |
| Import modal empty state | Keep `h-[42rem]`, centred spinner while fetching, blank while idle |
| Service names | Real translations in 12 locales, same i18n keys, frontend only |
| `Usinage` in English | "Machining" |
| Backend `SERVICE_LABEL` | Unchanged — it is preserved quote wording, not UI chrome |
| Seller | Frozen import snapshot, detail panel only, under the Quote row |
| Created by | Username snapshot on the project row, next to Created |
| Metadata order | Created / Created by / Last activity / Stage stay last in the left column |
| Discount | Deferred until a full untrimmed fixture with a remise exists |

## Design

### 1. Impression3D cost input

`TaskRow` renders the Printing section header as a row: the label on the left,
a `CostInput` on the right, sized to about `w-32` so it reads as a field rather
than filling the width.

```
Printing                                    Cost [ 142.50 ]
Printer  [X1C   ]  Material [PLA Black]     ┌ Filament      12.40
Weight   [ 210 g]  Time     [13h 00m ]      │ Depreciation   8.10
Colour   [ Noir ]  Qty      [ 1      ]      └ Total TTC    142.50  → writes Cost
```

The existing `CostInput` component is reused unchanged, so the null-vs-zero
rule (empty means disabled, `0` means free) is identical across all four
services by construction.

`ImpressionFields` changes shape:

- `handleChange(next)` calls `onChange(next)`, then resolves the printer and
  filament for `next`, computes the price, and calls
  `onCostChange(total_ttc_qty)` — **only if** `defaults` has resolved, the
  reference queries are not loading, and the computation returned non-null.
- The `useEffect`, the `hasEdited` state, and the `referenceDataLoading` gate
  inside the effect are removed. `referenceDataLoading` is still read, now as a
  guard inside `handleChange`.
- `onCostChange`'s contract changes from "the recomputed total, or null" to
  "a total the calculator was able to produce". The prop doc says so.

`TaskRow`'s `handleImpressionCostChange` loop guard is removed — with no
effect, there is no loop. The docstring paragraph explaining that collapsing a
row unmounts the body to reset `hasEdited` is now describing something that
does not exist and is rewritten.

The cost breakdown panel inside `ImpressionFields` is unchanged. When a manual
cost differs from the breakdown's Total TTC, both are shown; the breakdown is
informational and the input is the field of record.

### 2. Import modal

`PreviewSkeleton` and its call site are deleted. The dialog keeps
`h-[42rem] max-h-[calc(100vh-2rem)]` — that height exists so the quote
combobox has room to open below the input and so picking a quote fills space
rather than growing the dialog under the cursor.

In its place, while `previewQuery.isFetching` and no preview is available yet,
a centred `Loader2` spinner sits in the empty area — `animate-spin
text-bambu-gray`, the same treatment `SaveIndicator` in `ProjectDetailPanel`
already uses for an in-flight write. While idle the area is blank. No new i18n
key.

### 3. Service names

The four keys keep their names — `aito.serviceScan3D`,
`aito.serviceModelisation3D`, `aito.serviceImpression3D`, `aito.serviceUsinage`
— so every call site follows automatically: `ServiceBadges` (board card and
collapsed task row), the import modal's badges, and the Printing section label
in `TaskRow`. Only the twelve locale files change.

| Locale | Scan | Modeling | Printing | Machining |
|---|---|---|---|---|
| en | Scan | Modeling | Printing | Machining |
| fr | Scan | Modélisation | Impression | Usinage |
| de | Scan | Modellierung | Druck | Fräsen |
| es | Escaneo | Modelado | Impresión | Mecanizado |
| it | Scansione | Modellazione | Stampa | Lavorazione |
| pt-BR | Digitalização | Modelagem | Impressão | Usinagem |
| ru | Сканирование | Моделирование | Печать | Обработка |
| tr | Tarama | Modelleme | Baskı | İşleme |
| ja | スキャン | モデリング | プリント | 機械加工 |
| ko | 스캔 | 모델링 | 프린팅 | 가공 |
| zh-CN | 扫描 | 建模 | 打印 | 加工 |
| zh-TW | 掃描 | 建模 | 列印 | 加工 |

The comment in `frontend/src/components/aito/services.ts` claiming these names
"are identical in all twelve locales, so the keys carry no translation burden"
is now false and is rewritten. The matching comment in
`backend/app/services/aito_quote_import.py` above `SERVICE_LABEL` stays true —
that map writes `Impression3D: <value>` into an imported task's description as
**preserved quote wording**, and it is deliberately not renamed. Renaming it
would make old imports and new imports read differently for no gain.

Frontend tests query these labels by text (`getByLabelText('Scan3D')`,
`getByText('Usinage')`) in `TaskEditor.test.tsx` and
`ProjectDetailPanel.test.tsx` and are updated to the new strings.

### 4. Detail panel

**Description label.** The project description at the top of the left column
gets a label above it, reusing `aito.productDescription` ("Product
description") — the name `NewProjectModal` already gives the same field, so the
create surface and the edit surface agree. It is a plain `labelCls` paragraph,
not a `<dt>`: the description sits above the `<dl>`, and the editable
`<p role="button">` / `<textarea>` swap is not a `<dd>`.

**Seller.** New nullable column `aito_projects.quote_salesperson
VARCHAR(200)`, populated at import from the estimate's `salesperson_name`.

- `build_preview` adds `salesperson` to its `quote` dict.
- `ZohoQuoteInfo` (`backend/app/api/routes/zoho.py`, the quote half of
  `ZohoQuotePreview`) and the matching TS type in `api/client.ts` gain the
  field.
- `AitoProjectCreate` gains `quote_salesperson: str | None = Field(default=None,
  max_length=200)`; `AitoPage`'s import handler passes it through alongside the
  other `quote_*` fields.
- `AitoProjectResponse` returns it.
- The panel renders a `Seller:` row directly under the `Quote:` row, inside the
  same bordered group, omitted entirely when null — the same rule the phone and
  email rows already follow.

Frozen snapshot: never edited, never backfilled. Blank on hand-made cards and
on projects imported before this ships, because backfilling would mean
re-querying Zoho for every historical project.

**Created by.** New nullable column `aito_projects.created_by VARCHAR(100)`.

`create_project` already receives `User | None` from
`RequirePermissionIfAuthEnabled` and discards it as `_`; it is renamed to
`current_user` and its `username` is stored. `None` when auth is disabled.

A username **snapshot**, not a foreign key — consistent with how
`client_name` and `quote_total` are stored, and it survives the user being
deleted or renamed, which is the point of recording who created a record.

The panel renders `Created by:` immediately after `Created:`, showing `—` when
null (matching how `Created` and `Last activity` already render `—`).

**Order.** Created / Created by / Last activity / Stage remain the last rows of
the left column's `<dl>`, below the quote group.

Both columns are additive `ALTER TABLE` statements appended to the Aito block
in `run_migrations()` (`backend/app/core/database.py`, near line 3885),
following `_safe_execute`.

Two new i18n keys in all twelve locales: `aito.sellerLabel`,
`aito.createdByLabel`.

## Testing

**Frontend**

- Typing in the Impression3D Cost input emits `impressionCost`; clearing it
  emits `null`, not `0` — mirroring the existing Scan3D test.
- Editing a print parameter with a resolvable printer/filament/weight/time
  overwrites the Cost input with the computed total.
- Editing a print parameter on a task whose parameters do **not** price
  (imported: cost set, printer and filament null) leaves the cost untouched.
  This is the regression the "only when it produces a number" rule exists for.
- Typing a manual cost after editing a parameter is not stomped on the next
  render — the bug the old effect had.
- The import modal renders no skeleton and shows a spinner while fetching.
- The detail panel renders Seller and Created by, and omits Seller when null.

**Backend**

- `build_preview` surfaces `salesperson` from `salesperson_name`, and `None`
  when the estimate has none.
- `create_project` stores the authenticated username, and `None` when auth is
  disabled.

## Deferred: the remise

`_line_amount` computes `rate × quantity` for a tax-inclusive quote, which
ignores any line discount outright. The tax-exclusive branch uses `item_total`,
which may already be net of it — unverified.

**Blocked on:** a full, untrimmed `GET /estimates/{id}` response body (the
`estimate` object) saved into `backend/tests/fixtures/zoho_estimates/`, for a
quote carrying a remise. One with a line-level remise; a second with a
whole-quote (entity-level) remise if the shop uses those.

The fields that decide the implementation are `line_items[].discount`,
`line_items[].discount_amount`, `line_items[].item_total`, and the estimate's
`discount`, `discount_type`, `is_discount_before_tax` and `is_inclusive_tax`.
Once the fixture exists, the fix lands with a regression test asserting the
exact per-line total against the quote's own arithmetic.

Until then, the import modal's existing `Project X · quote Y` footer is what
surfaces a mismatch to the user.
