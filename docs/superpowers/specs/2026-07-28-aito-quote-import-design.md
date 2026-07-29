# Aito: import a Zoho quote as a project

**Date:** 2026-07-28
**Status:** approved, ready for an implementation plan

## Goal

Turn a Zoho Books quote (estimate) into an Aito board project in one step. An
**Import** button next to *New Project* opens a modal with a quote search
dropdown; picking a quote shows what it will become; confirming creates the
project with its tasks, its client, and a permanent link back to the quote.

## What the live data actually looks like

Established by probing the shop's live Zoho Books org, not assumed.

- **`sku` is a clean service discriminator.** The AITO 3D catalogue is
  `P3DSCAN` (Scan3D), `P3DMOD` (Modelisation3D), `P3DIMP` (Impression3D),
  `U3DIMP` (Usinage), plus `U3DIMP-VENTE`, `L3DIMP` (laser — no Aito
  equivalent) and the legacy generic `P3D2024`.
- **Line descriptions are label-prefixed** by the catalogue item's template:
  `Info:` / `*Fichier non cédé*` for scan and modelisation; `Projet:`,
  `Matériau:`, `Poids:`, `Temps:`, `Couleur:` for impression and usinage;
  `Dimensions:` for laser.
- **The `[TAG]` markers are unfilled placeholders**, not data. `DEV26-2467`
  (the sample quote) is a template with `[TITLE]`, `[MATERIAL]`, `[WEIGHT]`,
  `[TIME]`, `[COLOR]` left in place.
- **Real quotes are messy.** Observed: `Poids: "30gr" | "2g" | "210 gr"`,
  `Temps: "2h" | "26min" | "13h"`, blank values, extra free-text rows,
  `Matériau: "TPU 95 A --- 1.5mm"`, a modelisation line at `quantity: 1.5`,
  and two `P3DIMP` lines in one quote.
- **Search works.** `GET /estimates?search_text=` matches both the estimate
  number (`2467`) and the customer name (`Theis`), so one endpoint serves the
  dropdown.
- **Money.** Quotes here are `is_inclusive_tax: true`, so the TTC line total is
  `rate × quantity` and `item_total` is the pre-tax figure. Verified:
  `800 × 3 = 2400` TTC, `item_total 2124` at 13 % VAT. Aito tasks store TTC
  (`ImpressionFields` reports `total_ttc_qty`), so the two line up.
- **Plenty of quotes are pure retail** (filament spools, life jackets) with no
  AITO service line at all.

## Decisions

| Question | Decision |
|---|---|
| Line item → task | Group consecutive rising services into one task |
| Task title | Impression's `Projet:` wins; fallback chain below |
| Print detail | Weight / time / colour / quantity imported; printer and filament left empty |
| Cost | The quoted TTC amount, frozen |
| Project description | Pre-filled from task titles, editable in the preview |
| Quote on the card | Number chip in the footer; linked row in the detail panel |
| Re-import | Warn, still allow |
| SKU recognition | Prefix map in code; unrecognised lines skipped and listed |
| Where parsing runs | Backend, behind a preview endpoint |

## Data model

Additive `ALTER TABLE` statements in `run_migrations()`
(`backend/app/core/database.py`), matching the house pattern. `aito_projects`
gains five nullable columns — manually created projects leave them `NULL`.

| column | type | purpose |
|---|---|---|
| `quote_id` | `String(50)`, indexed | the link; what the duplicate check queries |
| `quote_number` | `String(50)` | the `DEV26-2462` chip |
| `quote_date` | `String(10)` | `2026-07-28`, for the detail-panel row |
| `quote_total` | `Float` | the **quote's** total, which can exceed the project total when lines were skipped — the gap is worth showing |
| `quote_url` | `String(300)` | Zoho Books deep link, snapshotted like the client fields so the panel needs neither a Zoho call nor a Zoho permission to render |

`AitoProjectCreate` and `AitoProjectResponse` gain the same five as
optional/nullable. `POST /aito/` is otherwise unchanged: imports go through the
existing creation path, so position shifting and the `devis` landing column
come for free.

## Backend

### Endpoints

Both live in `backend/app/api/routes/zoho.py` under `Permission.AITO_CREATE`,
alongside the existing contact search.

```
GET /api/v1/zoho/estimates?q=<optional, default "", max 100 chars>
    q empty      -> 25 most recent, sort_column=date sort_order=D
                    (the dropdown's opening state)
    q non-empty  -> search_text=<q>, per_page=25
    -> [{ id, number, customer_name, date, total, currency_code, status }]

GET /api/v1/zoho/estimates/{estimate_id}/preview
    -> { quote:  { id, number, date, status, total, currency_code, url },
         client: { id, name, phone, email, is_company },
         suggested_description: str,
         tasks:  [AitoTaskCreate, ...],
         skipped_lines: [{ sku, name, amount }],
         existing_project_id: int | null }
```

The preview costs two Zoho calls: `GET /estimates/{id}` and
`GET /contacts/{customer_id}` for the phone / email / `customer_sub_type`
snapshot the board already stores for manually created cards.

`existing_project_id` is the id of the most recent **active** project whose
`quote_id` matches. Soft-deleted projects (`status = 'deleted'`) are ignored:
importing a quote whose card was thrown away is not a duplicate.

`ZohoService` gains `search_estimates()` and `get_estimate()`, both routed
through the existing `_request()` helper so they inherit token refresh,
401-retry-once and error mapping. The Zoho Books app URL is derived from the
configured `zoho_accounts_url` region
(`accounts.zoho.eu` -> `https://books.zoho.eu/app/{org_id}#/estimates/{id}`).

### The parser

A new I/O-free module `backend/app/services/aito_quote_import.py` exposing one
function, `build_preview(estimate, contact, books_app_url) -> QuotePreview`.
No DB, no HTTP — the whole regex surface is testable from fixtures.

**1 · Classify.** `sku.strip().upper()` prefix-matched, first hit wins:

```
P3DSCAN -> scan          P3DIMP  -> impression
P3DMOD  -> modelisation  U3DIMP  -> usinage   (catches U3DIMP-VENTE)
```

Everything else — `L3DIMP`, `P3D2024`, retail SKUs, blank SKUs — goes to
`skipped_lines`. If no line is recognised, `tasks` is empty and the modal
disables Import.

**2 · Group.** Walk recognised lines in `item_order`. Rank `scan=0`,
`modelisation=1`, `impression=2`, `usinage=3`. A line joins the current group
only if its rank is **strictly greater** than every rank already in that group;
otherwise it opens a new group.

```
DEV26-2461  scan, model, impression        -> 1 task, 3 services
DEV26-2462  model, impression, impression  -> 2 tasks
DEV26-2448  model, usinage-VENTE           -> 1 task, 2 services
DEV26-2467  scan, model, impression, usinage -> 1 task, 4 services
```

The `DEV26-2467` outcome was confirmed explicitly: a quote that walks
scan -> model -> impression -> usinage describes one physical job passing through
four stations, and an Aito task is built to carry several services.

**3 · Money.** Per recognised line, the TTC amount is
`rate × quantity` when the estimate is `is_inclusive_tax`, otherwise
`item_total + Σ line_item_taxes[].tax_amount`. Rounded to the estimate's
`price_precision`. It is written to `scan_cost` / `modelisation_cost` /
`usinage_cost` / `impression_cost` according to the line's service. A repeated
service cannot collide, because a repeat opens a new group.

**4 · Read the description.** Each line's text splits on newlines. A row
matching `^(Info|Projet|Usinage|Matériau|Materiau|Poids|Temps|Couleur|Dimensions)\s*:\s*(.*)$`
— case- and accent-insensitive — is a labelled value; anything else is free
text and is always preserved. Two things are dropped: the `*Fichier non cédé*`
boilerplate, and the unfilled placeholders `[TITLE] [MATERIAL] [WEIGHT] [TIME]
[COLOR]`, which count as empty.

> **Governing safety rule:** any labelled value that fails to parse is left
> verbatim in the task description. Nothing the quote said may vanish because a
> regex did not match.

**5 · Title.** The impression line's `Projet:` if non-empty; else the first
non-empty `Info:` / `Projet:` / `Usinage:` in canonical service order; else
empty. Truncated to 200 characters at a word boundary (the column limit) — and
when truncated, the full line is also kept in the description.

**6 · Task description**, assembled in canonical service order:

- `Scan3D: …`, `Modelisation3D: …`, `Usinage: …` for the titles that did not
  win the task title
- `Matériau:` and `Dimensions:` values, verbatim
- every free-text row, verbatim

Blank and duplicate rows collapse. Those four service names are the shop's own
and are identical in all twelve locales (see `components/aito/services.ts`), so
this string carries no translation burden.

**7 · Impression fields.**

| field | source | rule |
|---|---|---|
| `impression_quantity` | line `quantity` | rounded, minimum 1 |
| `impression_weight_g` | `Poids:` | `210 gr` -> 210, `2g` -> 2, `1,5 kg` -> 1500; bare number = grams |
| `impression_time_min` | `Temps:` | `13h` -> 780, `26min` -> 26, `2h30` -> 150, `1j 4h` -> 1680; bare number = minutes |
| `impression_color` | `Couleur:` | verbatim, truncated to 100 |
| `impression_printer_id`, `impression_filament_id` | — | always `NULL` |
| `Matériau:` | — | never parsed into a field; goes to the description |

Printer and filament stay empty because the quote does not name them, and the
inventory is brand-prefixed (`SUNLU PETG`, `Polymaker PETG`), so `Matériau: PETG`
is genuinely ambiguous. Leaving them empty is safe: `ImpressionFields` gates its
recompute on `hasEdited`, so a frozen `impression_cost` survives untouched until
the user edits a print input.

**8 · Suggested description** = the task titles, one per line, empties skipped;
falls back to the quote number when nothing parsed.

## Frontend

### Entry point

`AitoPage` header gains a third button between *Trash* and *New Project*:
**Import**, secondary variant, `FileInput` icon. Always visible; the
not-configured case is handled inside the modal, matching the create modal.

### `ImportQuoteModal.tsx`

Same chrome as `NewProjectModal` (backdrop, `animate-modal-in`, Escape and
backdrop dismiss) at `max-w-3xl` — it is a preview, not an editor.

```
+- Import a quote ------------------------------------+
|  > Search a quote...                        [ v ]   |
|    DEV26-2466 . Herald FABRE  . 28 Jul . 10 250 sent|
|    DEV26-2465 . Raiatea YC    . 28 Jul . 256 496    |
|-----------------------------------------------------|
|  DEV26-2462 . Christabellle BUTCHER    draft     ^  |
|  28 Jul 2026 . 5 600 XPF                            |
|                                                     |
|  !  Already imported as project #42                 |
|                                                     |
|  Description                                        |
|  +-----------------------------------------------+  |
|  | Helice grise                                  |  |
|  | helice                                        |  |
|  +-----------------------------------------------+  |
|                                                     |
|  Task 1   Helice grise                              |
|           [Modelisation3D] 3 000 [Impression3D] 2 400|
|           PETG . 2 g . 26 min . Gris metallique     |
|  Task 2   helice                                    |
|           [Impression3D] 200                        |
|                                                     |
|  -- not imported: L3DIMP Decoupe Laser  8 000       |
|     project 5 600 . quote 13 600                    |
|                         [Cancel]  [Import again]    |
+-----------------------------------------------------+
```

The quote header, description and task rows above are `DEV26-2462`'s real data.
The duplicate banner and the skipped-line block are illustrative — that quote
has neither an earlier import nor a laser line — and are shown here only to
place them in the layout.

- A new `QuoteCombobox`, modelled on the existing `ClientCombobox` (debounced
  input, keyboard navigation, listbox a11y), opening on the 25 most recent
  quotes so a quote just written needs no typing.
- Task rows reuse `ServiceBadges` and `Money`, and are read-only.
- The description textarea is pre-filled with `suggested_description` and is
  the one editable field.
- Import is disabled when `tasks` is empty or the description is blank.
- A currency warning appears when the quote's `currency_code` differs from the
  app's configured currency, rather than silently relabelling the money.
- Confirming posts through the existing `api.createAitoProject` with the five
  quote fields appended, invalidates `['aito-projects']`, closes and toasts.

### `api/client.ts`

Adds `searchZohoEstimates(q)` and `getZohoQuotePreview(id)`, plus the five new
optional fields on the `AitoProjectCreate` and `AitoProject` types.

### `CardView`

The footer gains a quiet `DEV26-2462` chip to the left of the delete control,
rendered only when `quote_number` is set. A plain `<span>`, not a link — the
card body is a `<button>` and the footer already carries hold-to-delete.

### `ProjectDetailPanel`

Two changes:

1. **Right-align the values.** Each `<dl>` row gains `justify-between` and each
   `<dd>` gains `text-right`, turning the metadata block into a spec sheet —
   label flush left, value flush right. The Stage row's colour dot stays inside
   its `<dd>`, so it travels right with its label text rather than stranding
   mid-row.
2. **A Quote row**, rendered only for imported projects: the number, an
   external link to Zoho Books (`target="_blank" rel="noopener noreferrer"`),
   the quote date and the quote total.

```
Client name:                        ANEOCORP
Phone:                              89536600
---------------------------------------------
Quote:                 DEV26-2462 ^ . 5 600 XPF
Created:               7/26/2026, 1:55:04 AM
Last activity:         7/28/2026, 10:33:08 AM
Stage:                         * 3D Model
```

### i18n

New `aito.*` keys with real translations across all twelve locales — the i18n
gate rejects English placeholders.

## Error handling

| case | behaviour |
|---|---|
| Zoho not configured (409) | modal renders the not-configured state; Import disabled |
| Zoho unreachable (502) | inline error and Retry inside the modal; the board is untouched |
| estimate fetched but contact fetch fails | degrade, do not fail — fall back to `customer_id` / `customer_name` from the estimate, phone and email `NULL` |
| create `POST` fails | toast, modal stays open with the preview and the edited description intact |
| any Zoho write | none — import is read-only against Books |

## Testing

- `backend/tests/unit/services/test_aito_quote_import.py`, against fixtures
  captured from six real quotes: `2467` (all placeholders), `2461` (three
  services, one task), `2462` (two tasks), `2466` (messy free text, empty
  values, quantity 2), `2448` (`U3DIMP-VENTE`), `2463` (pure retail, no tasks).
  Covers grouping boundaries, inclusive and exclusive TTC, `210 gr` / `2g` /
  `1,5 kg`, `13h` / `26min` / `2h30`, placeholder stripping, unparseable-value
  preservation, and the title fallback chain.
- Route tests for both endpoints through the existing `zoho_service.transport`
  `httpx.MockTransport` seam: 200, 409 not configured, 502 unreachable, and the
  contact-fetch degradation.
- `ImportQuoteModal.test.tsx`: dropdown search, preview rendering, duplicate
  warning, disabled-when-no-lines, description editing, submitted payload shape.
- Small assertions on `CardView` (the chip) and `ProjectDetailPanel` (the quote
  row and the right alignment).

**Privacy:** the captured fixtures carry real customer names, phone numbers and
email addresses. They are anonymised before committing — identical structure and
formatting quirks, invented people.

## Out of scope

- Writing anything back to Zoho. Import is read-only; the existing contact
  patch-on-create behaviour is untouched.
- Re-syncing a project when its quote changes in Zoho. The import is a snapshot,
  exactly like the client fields.
- Mapping `L3DIMP` (laser) or `P3D2024` (legacy generic) onto an Aito service.
  They are listed as skipped; adding a service is a separate piece of work.
- Auto-selecting a printer or filament from `Matériau:`.
