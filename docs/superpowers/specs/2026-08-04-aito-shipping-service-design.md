# Aito — Shipping service (Livraison Avion)

**Date:** 2026-08-04
**Status:** design approved, pending spec review

## Problem

Projects shipped to an outer island of French Polynesia carry an air-freight
cost that today is added to the Zoho quote by hand, after the fact. Nothing on
the board says a project has to be flown anywhere, so the operator who finishes
the job has no way of knowing a parcel is owed to Rangiroa rather than to the
counter.

This adds shipping as a first-class, optional attribute of an Aito project: set
in the new-project drawer, priced from the Zoho catalogue, written onto the
quote as its own line, and surfaced on the board and in the detail panel.

Shipping is rare — roughly 5% of projects — and every design decision below
prefers "invisible when absent" over "prominent when present".

## Scope

In scope:

- A shipping block in the new-project drawer's Client section.
- An island → service lookup covering the 5 Zoho "Livraison Avion" services.
- Dynamic resolution of those 5 Zoho items (id + rate), cached.
- A shipping line on the exported quote, and its round trip back on import.
- Add / edit / remove from the project detail panel.
- A plane icon in place of the check on a shipped project's Done button.
- A destination pill and a shipping card in the detail panel.

Out of scope:

- Any change to the board's rule engine, columns, or stages. Shipping is not
  work and creates no new column, no new stage, and no new tickable step.
- Tracking numbers, carrier integration, label printing.
- Multiple shipments per project.

## Decisions taken during brainstorming

| Question | Decision |
| --- | --- |
| Where do the 5 Zoho item ids and prices come from? | Resolved from Zoho by name, cached in the settings table, refreshed at most daily. Not hardcoded, not a call per drawer open. |
| Who owns the island list? | Drafted here from the Air Tahiti scheduled network; corrected by the user at the spec-review gate. |
| Editable after creation? | Yes — add, edit and remove from the detail panel. |
| Where does the form live in the drawer? | Inside the Client section, under the contact fields (option 2). Shipping is a 5% case; a peer-level step would over-weight it. |
| Is the price editable? | Yes — pre-filled with the Zoho rate, with a reset back to it. Air freight is billed by weight, so the base rate is a starting point. |
| Are the fields optional? | No. Once a shipping block exists, all four fields are required. |
| How does the panel display it? | Header `✈ <island>` pill plus a shipping card (option B), with an enlarged plane glyph. |

---

## Data model

Six additive columns on `aito_projects`, via `run_migrations()` in
`backend/app/core/database.py` — the same ALTER TABLE pattern every other Aito
column uses. Not a side table: shipping is one-to-zero-or-one with a project,
and a table would buy a join for nothing.

```
shipping_island        VARCHAR(50)  NULL   -- canonical island key, e.g. "rangiroa"
shipping_service       VARCHAR(20)  NULL   -- societe|tuamotu|marquises|australes|gambier
shipping_first_name    VARCHAR(100) NULL
shipping_last_name     VARCHAR(100) NULL
shipping_phone         VARCHAR(50)  NULL   -- house format, +CC-XXXXXXXX
shipping_price         FLOAT        NULL   -- frozen at attach, XPF
```

`shipping_island IS NULL` **is** the definition of "no shipping". One field
decides it, so no half-existing state is representable. Every read site tests
that field and nothing else.

The island **key** is stored, not the display label, so correcting a spelling
in the lookup table never orphans an existing project.

`shipping_service` is stored rather than re-derived on read, for the same
reason the client fields are snapshotted: a project must keep rendering — and
keep billing — the service it was quoted at, even if the lookup table later
moves that island into a different group.

`shipping_price` is frozen at attach time, exactly like task costs. The Zoho
rate is a default, not a live figure: the quote bills what the operator was
shown.

### Schema surface

- `AitoProjectCreate` gains the four *input* fields: `shipping_island`,
  `shipping_first_name`, `shipping_last_name`, `shipping_phone`, plus an
  optional `shipping_price` override. It does **not** accept
  `shipping_service` — see "Server derives the service" below.
- `AitoProjectUpdate` gains the same five, plus the ability to clear shipping
  by sending `shipping_island: null`.
- `AitoProjectResponse` returns all six stored fields plus a derived
  `shipping_service_name` (the Zoho item's display name, from the cached
  catalogue) so the board list does not force the frontend to join every card
  against the services endpoint. It is `null` when the catalogue has never
  resolved; the panel then falls back to the service key's own label.

### Server derives the service

The client sends an island; the server looks up the service. The service key is
never accepted from the request. An island absent from the table is a 422.

---

## Zoho catalogue resolution

New `zoho_service.get_shipping_catalogue(db)` returning
`dict[service_key, ShippingItem(item_id, name, rate)]`.

Resolution is `GET /items?search_text=Livraison Avion`, with the returned items
mapped onto the 5 service keys by name match. The result is cached in the
settings table as two rows:

```
zoho_shipping_catalogue      JSON  {"tuamotu": {"item_id": "...", "name": "Livraison Avion Tuamotu", "rate": 3200}, ...}
zoho_shipping_catalogue_at   ISO-8601 timestamp of the last successful resolve
```

Refreshed only when the row is missing or `zoho_shipping_catalogue_at` is more
than 24 hours old — so at most one Zoho call a day, and opening the drawer
never costs one.

Two invariants make this safe. Both exist because of the duplication footgun
already documented on `aito_quote_export.is_foreign`:

1. **Item ids never expire; only rates do.** Once an id is learned it stays in
   the cached row even if a later refresh fails or returns fewer items. A
   refresh merges rates onto known ids and never deletes an id.

   Rationale: `Catalogue.item_ids()` grows to include the 5 shipping ids, and
   that set is what tells `is_foreign()` a line is ours. If an id were ever
   forgotten, the shipping line we wrote on the previous push would classify as
   *foreign* — preserved by `line_item_id` **and** re-emitted fresh from the
   project — duplicating itself a little more on every single sync. This is
   the exact failure mode the item-id check in `is_foreign` was added to
   prevent for the four service items.

2. **Unknown catalogue means no push.** A project carrying shipping whose
   service cannot be resolved leaves `quote_sync_state` at `pending` and
   retries, rather than writing a quote missing its shipping line. A silent
   quote is recoverable; a wrong one that was sent to a client is not.

### `Catalogue` changes

`aito_quote_export.Catalogue` gains a `shipping: dict[str, str]` field mapping
service key → item id.

- `Catalogue.item_ids()` returns the four service ids **plus** every shipping
  id, so ownership checks see them.
- `Catalogue.shipping_item_id(service)` resolves one, raising if absent (which
  is what triggers invariant 2 above).

`zoho.get_catalogue()` populates it from the cached shipping row.

---

## Island → service lookup

Canonical location: `backend/app/services/aito_shipping.py`. One source of
truth in Python, reaching the frontend over the wire — there is deliberately
**no mirrored TypeScript copy**, unlike `aitoBoardRules.ts`. The drawer does
resolve an island to its service locally, for the instant feedback under the
combobox, but it does so against the table it *fetched* from
`/aito/shipping/services`, not against a second hardcoded copy. Nothing can
drift, because there is only ever one table.

```python
ISLANDS: tuple[tuple[str, str, str], ...] = (
    # (key, display label, service key)
    ("moorea", "Moorea", "societe"),
    ...
)
```

Helpers: `service_for_island(key)`, `island_label(key)`, `grouped_islands()`.

### The table

**Livraison Avion Société** (5)
Moorea · Huahine · Raiatea · Bora Bora · Maupiti

**Livraison Avion Australes** (4)
Rurutu · Tubuai · Rimatara · Raivavae

**Livraison Avion Gambier** (1)
Mangareva (Rikitea)

**Livraison Avion Marquises** (4)
Nuku Hiva · Hiva Oa · Ua Pou · Ua Huka

**Livraison Avion Tuamotu** (31)
Ahe · Anaa · Apataki · Aratika · Arutua · Faaite · Fakahina · Fakarava ·
Fangatau · Hao · Hikueru · Katiu · Kauehi · Kaukura · Makemo · Manihi ·
Mataiva · Napuka · Niau · Nukutavake · Puka Puka · Rangiroa · Raroia · Reao ·
Takapoto · Takaroa · Takume · Tatakoto · Tikehau · Tureia · Vahitahi

**45 islands total.**

### Judgement calls in the draft table

> **These four are the reviewer's to overrule.**

- **Tahiti is excluded.** It is the shop's own island; air freight to it is not
  a thing.
- **Moorea is included**, though it is a ferry away, because Air Tahiti does
  serve it.
- **Islands without an airstrip are excluded**: Taha'a (served via Raiatea),
  Fatu Hiva and Tahuata (boat from Hiva Oa), Rapa (ship only), Maiao. If the
  shop does ship to these by routing through a neighbouring airport, they
  should be added pointing at the same service.
- **Scheduled Air Tahiti service only.** The charter-only Tuamotu atolls
  (Marokau, Nengonengo, Hereheretue, Manuhangi, Anuanuraro, Rekareka, Tepoto)
  and Tetiaroa's private strip are excluded.

Island and archipelago names are proper nouns and are **not** translated; they
are identical in all 13 locales. Only the field labels around them are i18n
keys.

---

## API

### `GET /api/v1/aito/shipping/services` — `AITO_READ`

The drawer's single source for the picker. Returns the 5 services, each with
its islands and its cached Zoho rate:

```json
{
  "services": [
    {
      "key": "tuamotu",
      "name": "Livraison Avion Tuamotu",
      "rate": 3200,
      "islands": [{"key": "rangiroa", "label": "Rangiroa"}, ...]
    }
  ],
  "catalogue_resolved": true
}
```

`catalogue_resolved` is `false` when Zoho has never been reachable at all; an
individual service's `rate` is `null` when that one item was not matched, which
can happen independently of the others. The island list is served regardless —
it is static app data and needs no network.

**Shipping is still addable with no rate.** The price field then starts empty
and the operator types it; a rate of `null` makes the price field required
input rather than a pre-filled default. Only the *push* is blocked when the
service's `item_id` is unknown (see invariant 2 above) — never the data entry.

Frontend caches this with React Query at a long `staleTime`, so it costs one
request per session.

### `POST /api/v1/aito/` — `AITO_CREATE`

Accepts the shipping input fields. Validation:

- All four of island / first name / last name / phone present, or all absent.
- Island must exist in `ISLANDS` (422 otherwise).
- Phone must parse to the house `+CC-XXXXXXXX` format.
- `shipping_price` defaults to the cached rate when omitted; a supplied value
  must be `>= 0`.

On success `shipping_service` is derived and stored, and the project is marked
`pending` for the sync worker exactly as today.

### `PATCH /api/v1/aito/{id}` — `AITO_UPDATE`

Same validation. Sending `shipping_island: null` clears all six fields.
Any change to a shipping field re-marks the quote `pending` through the
existing `_mark_pending_if_ours` guard, so an `unmanaged` project is never
touched.

---

## Quote export

A single shipping line, appended **after** all task lines and **before** the
preserved foreign lines, in `build_line_items`:

```python
{
  "item_id": catalogue.shipping_item_id(project.shipping_service),
  "tax_id": catalogue.tax_id,
  "unit": "Projet",
  "rate": project.shipping_price,
  "quantity": 1,
  "description": "Nom: Jean-Pierre DUPONT\nTéléphone: +689-89645864\nÎle: Rangiroa",
}
```

No `header_name`: the line belongs to no task, and a header would group it
under whichever task title happened to precede it.

The description uses the exporter's existing `Label: valeur` row convention, so
`parse_description` reads it back with no new parser.

`build_line_items` currently takes only `(tasks, existing_line_items,
catalogue)`. It gains an optional `shipping: ExportShipping | None` parameter —
a frozen dataclass mirroring `ExportTask`, so the module stays pure and
I/O-free. `load_export_tasks`'s caller in `aito_quote_sync` builds it from the
project row.

## Quote import — mandatory round trip

Because the 5 shipping item ids are now in `Catalogue.item_ids()`,
`is_foreign()` stops treating a shipping line as foreign, which means it is no
longer preserved by `line_item_id`. If the importer did not read it back, the
sequence *import a quote that has shipping → push it again* would **silently
delete the shipping line**. So:

- `aito_quote_import` gains three `LABEL_DISPLAY` entries: `nom`, `telephone`,
  `ile`.
- A line whose `item_id` is one of the 5 shipping ids is parsed into shipping
  fields rather than into a task: island key by reverse lookup on the `Île:`
  label, service from the item id, name and phone from their labels, price from
  the line rate.
- **An unrecognised island label leaves the project without shipping.** If the
  `Île:` value does not reverse-lookup to a known island key, the importer
  leaves all six columns NULL rather than guessing.

That last case would delete the line on the next push, so `build_line_items`
carries one narrow extra rule:

> **An existing shipping-item line that the project does not describe is echoed
> back by `line_item_id`, not dropped.**

That is: when `shipping_island IS NULL` but the quote already carries a line
whose `item_id` is one of the 5 shipping ids, that line is preserved exactly
like a foreign one. `is_foreign()` keeps its simple id-based meaning (ours ⇒
not foreign) and is not weakened; the preservation is an explicit second pass
in the builder.

This rule also covers the case nobody imported at all: a shipping line typed by
hand directly in Books, on a project the app has no shipping data for, now
survives our pushes instead of vanishing.

Conversely, when the project **does** carry shipping, its line is rebuilt from
project data and any pre-existing shipping line is dropped — one project, one
shipping line, no accumulation.
- A round-trip test pins export → import → export producing identical lines.

---

## Frontend

### Drawer — `ClientSection`

Below the phone/email row, separated by a hairline:

- **Collapsed:** a dashed `✈ Ajouter une expédition` button (sky accent).
- **Expanded:** a bordered sky-tinted block containing
  - a searchable **island combobox**, options grouped by archipelago, same
    keyboard/filter behaviour as `ClientCombobox`;
  - the **resolved service + price**, appearing the moment an island is chosen:
    service name, an editable price input seeded from the Zoho rate, a
    "modifié" marker and a `↺` reset once touched;
  - **Prénom / Nom** and a **Téléphone** field using the existing
    `PhoneInput`;
  - a `Retirer l'expédition` action returning to the button.

**Pre-fill.** The client display name follows the house convention
`Jean-Pierre DUPONT` (`formatDisplayName`: title-cased first, upper-cased
last), so the split reads it backwards — the trailing all-caps run is the last
name, the remainder is the first. A **company** contact has no person to split,
so both name fields start empty and the operator types the recipient, which is
the correct behaviour for a business anyway. Phone pre-fills from the client
draft's `countryCode` / `nationalNumber`.

Pre-filled values are a starting point, not a binding: editing them never
writes back to the Zoho contact.

### Shipping draft state

A new `frontend/src/utils/shippingDraft.ts`, mirroring `clientDraft.ts`:

```ts
export interface ShippingDraft {
  island: string;          // '' until chosen
  service: string;         // derived client-side for display only
  firstName: string;
  lastName: string;
  countryCode: string;
  nationalNumber: string;
  price: number | null;    // null = use the service rate
  priceEdited: boolean;
  blurred: { island: boolean; firstName: boolean; lastName: boolean; phone: boolean };
}
```

with `visibleShippingDraftErrors(draft)` following the same
validity-vs-visibility split `maskVisibleErrors` establishes: a field only
reports its error once left, and clicking Create reveals everything.

### Persistence

`PersistedDraft` gains an optional `shipping: ShippingDraft | null`. Old
localStorage blobs simply lack the key and read as `undefined` → treated as
`null`, so **no storage version bump** is needed.

### Rail receipt

A `✈ Rangiroa · 3 200` row between the task rows and the client row, inside the
project total. The total shown before Create therefore matches the quote.

### "Before you create" checklist

One extra `Line`, rendered **only when a shipping block exists** — 95% of
projects see no new row:

| state | condition | text |
| --- | --- | --- |
| `ok` | all four fields present and valid | `✈ Rangiroa · Jean-Pierre DUPONT` |
| `miss` | revealed, something missing/invalid | names the first offender: `Expédition : île manquante` / `nom du destinataire` / `téléphone invalide` |
| `wait` | not revealed yet | `Expédition en cours de saisie` |

`canCreate` gains `shippingValid` — computed from **visible** errors, not raw
validity, so a click on Create is what reveals why it is disabled. This matches
the drawer's stated rule: errors are revealed, never thrown.

The Client section's own ✓ keeps meaning exactly what it means today (client
reachable and valid) and is **not** widened to cover shipping; its hint line
gains a `· ✈ Rangiroa` suffix when shipping exists.

### Board card — Done button

In `BoardColumn.SortableCard`, the Finish-column `HoldButton` swaps `Check` for
`Plane` when `project.shipping_island !== null`. Same hold gesture, same
`move_lock === null` gate, same green and same invoiced glow. The glyph is
enlarged from `w-3.5 h-3.5` to `w-[1.15rem] h-[1.15rem]` — a plane at check
size reads as a smudge.

`ProjectDoneAction` (panel footer) takes the identical swap, so the two
surfaces offering one transition never disagree.

### Detail panel

**Header pill.** Beside the quote-status pill: `✈ Rangiroa`, sky-toned to stay
distinct from the green work colour. Rendered only when shipping exists. This
is what makes shipping unmissable the moment the panel opens, before any
scrolling.

**Shipping card.** A `PanelCard` in the left column, below Quote, with a sky
border and an enlarged plane in its heading:

```
✈ EXPÉDITION
Île            Rangiroa
Destinataire   Jean-Pierre DUPONT
Téléphone      +689-89645864       (CopyableValue)
Service        Livraison Avion Tuamotu
Tarif          3 200 XPF
                          [ Modifier ]  [ Retirer ]
```

`Modifier` opens the same four fields inline; `Retirer` is a `HoldButton`
(destructive, and it changes the quote). Both write through `PATCH
/aito/{id}`.

A project **without** shipping gets **no card** — that would put an empty
heading on 95% of projects, which is the noise this panel's omission rules
exist to avoid. Instead a single discreet `✈ Ajouter une expédition` text
button sits at the foot of the left column, below the last card, matching the
weight of the other secondary actions there. Clicking it opens the same inline
four-field form, and on save the full card takes its place.

### i18n

New keys under `aito.shipping*` in all 13 locales. Island and archipelago names
are proper nouns and stay untranslated. The parity gate
(`frontend/scripts/check-i18n-parity.mjs`) rejects English placeholders, so
every locale needs a real translation.

---

## Testing

**Backend**

- `aito_shipping`: every island resolves to a service; no duplicate keys;
  `grouped_islands` returns all 5 groups.
- Catalogue caching: resolves once and reuses within 24h; refreshes after;
  **a refresh that drops an item never forgets its id**; an unresolvable
  catalogue leaves the project `pending` and pushes nothing.
- `build_line_items`: shipping line emitted after tasks and before foreign
  lines, with no header; absent when the project has no shipping;
  `is_foreign` returns `False` for a shipping item id; an existing shipping
  line is **echoed by `line_item_id`** when the project has no shipping, and
  **replaced** when it does — never accumulated.
- Import: a shipping line parses back into the shipping fields; an unknown
  island label leaves the columns NULL and the line survives the next push.
- Round trip: export → import → export is byte-identical.
- Routes: create/patch validation (all-or-nothing, unknown island 422, phone
  format, price `>= 0`), clearing via `shipping_island: null`, service derived
  server-side and not accepted from the payload.

**Frontend**

- `shippingDraft`: validation and the visible-vs-raw error split.
- Drawer: the button reveals the block; picking an island resolves service and
  price; the price reset restores the Zoho rate; the name split handles a
  person and leaves a company blank; removing returns to the button.
- Checklist: the line is absent without shipping, and cycles
  `wait → miss → ok`; Create is blocked while shipping is incomplete and the
  click reveals the reason.
- Rail receipt includes the shipping row in the total.
- `Plane` replaces `Check` on both the board card and the panel footer exactly
  when `shipping_island !== null`.
- Panel: pill and card render when shipping exists; the add button renders when
  it does not.

**Gates**

`./test_frontend.sh`, `./test_backend.sh`, `cd frontend && npm run build`, and
the i18n parity check.

---

## Risks

| Risk | Mitigation |
| --- | --- |
| Shipping line duplicating on every sync | Item ids are never forgotten once learned; `item_ids()` includes them. Pinned by test. |
| Shipping silently deleted from an imported quote | Import parses the line back; unmatched islands fall back to foreign-line preservation. Pinned by a round-trip test. |
| Zoho item names change and the name match fails | The cached ids survive (invariant 1), so pushes keep working; only new rates stop arriving. Surfaced by `catalogue_resolved: false` in the API. |
| Island list is wrong for the shop's real routes | The table is one editable tuple in one file, and the reviewer corrects it at the spec gate. |
| The drawer grows too tall with shipping open | It is a 5% case, the Client section already scrolls, and the block is collapsed by default. |
