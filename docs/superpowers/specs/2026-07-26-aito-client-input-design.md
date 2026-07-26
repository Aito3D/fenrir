# Aito new-project modal — client input design

Date: 2026-07-26
Status: approved by user (brainstorming session)

## Goal

Rework the client half of the Aito "New project" modal so a project can always be
created without leaving the modal, and so client contact details captured during
that flow flow back into Zoho Books.

Four capabilities:

1. **Client de passage is preselected** on open, with a reset control that returns
   to it.
2. **Phone and email are shown and editable** for the selected client, each with
   its own revert control.
3. **Edited phone/email are written back to Zoho** when the project is submitted.
4. **A client that does not exist can be created** from the bottom of the search
   dropdown, with an enforced display-name convention.

This spec covers only the client input. The product description field, the board,
the card face and the detail panel are unchanged and out of scope.

## Findings from the live Zoho org

These were probed read-only against the production org and drive several
decisions below.

### Contact-level `email` / `phone` / `mobile` are mirrors, not storage

They reflect the **primary contact person**. Verified on contact `3D Technologies`:

```
top level:  email m.girard@sysnux.pf   mobile 89645864   primary_contact_id 66407000000464581
contact_persons[0]: { contact_person_id: 66407000000464581, is_primary_contact: true,
                      first_name Michael, last_name Girard, email …, mobile 89645864 }
```

Writing a phone or email therefore means updating the primary contact person, or
creating one when the contact has none.

### `Client de passage` is a shared record that must never be written to

Contact `66407000001237340`: `contact_persons: []`, `primary_contact_id: ""`, empty
email/phone, `has_transaction: true`, and 151 010 XPF of unused receivable credits.
Every walk-in quote reuses it. Writing one customer's phone onto it would pollute a
record shared by all future walk-ins.

### Org defaults, taken from the default contact and a 1000-contact sample

| Field | Value | Handling |
|---|---|---|
| `contact_type` | `customer` | Sent explicitly |
| `customer_sub_type` | `individual` / `business` | Derived from which name path was used |
| `language_code` | `fr` | Omitted — org default applies |
| `currency_code` | `XPF` | Omitted — org default applies |
| `payment_terms` | `0` ("A la commande") | Omitted — org default applies |
| `contact_name` | required | The only genuinely mandatory create field |

### Phone formats are a free-text string, with no house convention today

`mobile_country_code` is empty and unused even on contacts that display a prefix —
the `+689-` is inside the string itself. Across all 1000 contacts:

| Shape | `phone` | `mobile` | Examples |
|---|---:|---:|---|
| `+CC-XXXXXXXX` | 266 | 28 | `+689-87296912`, `+47-92296862`, `+33-0179753070` |
| bare 8 digits | 135 | 201 | `89645864`, `40864225` |
| spaced / dotted | 17 | 42 | `40 54 43 09`, `87.30.73.53` |
| other | 1 | 5 | `00.687.76.31.68`, `0688727786` |

`+CC-XXXXXXXX` is the largest single shape and becomes the house format for values
this feature writes. Existing bare numbers are left alone (see the reformat policy
below). Not every number is `+689` — French, Norwegian and New Caledonian numbers
are present — so the country code is a selection, never an assumption.

### The uppercase-surname convention is new

Existing person contacts are stored title-cased (`contact_name: "Adrien Delpia"`),
not `Adrien DELPIA`. The rule below applies to contacts this feature creates;
search results will show a mix of both conventions. That is expected.

## Decisions made

| Decision | Choice |
|---|---|
| Modal shape | One form, one submit — not a client-then-project wizard |
| Create-client surface | A sub-step inside the same modal, not a second modal |
| When client edits reach Zoho | On project submit only. Never on blur — Cancel must mean cancel |
| Create-client write timing | Immediately on its own submit — the real `contact_id` is needed before attaching |
| Zoho failure vs. project | Project creation wins; a failed sync is a warning toast, not a blocked card |
| Orchestration | Frontend calls independent backend endpoints; the aito route stays free of Zoho coupling |
| Phone/email on `Client de passage` | Editable, saved to the card, **never synced to Zoho** |
| Phone fields | One "Phone" input; reads `mobile \|\| phone`, writes back to whichever it came from |
| Phone entry | Country-code picker (default `+689`) + national number, normalized to `+CC-XXXXXXXX` on blur |
| Reformat policy | Sync only fields the user actually edited — never rewrite an untouched contact |
| Name casing | Title-case every space/hyphen segment of the first name; full uppercase surname |
| Casing timing | Normalized on blur with a live preview line — not per keystroke |
| Duplicate names | No pre-check; Zoho's own rejection is surfaced inline |
| Default client config | Two settings rows (`id` + `name`) with built-in fallbacks; no live fetch |
| Combobox behaviour | Editable combobox showing the current client; typing searches |

## Frontend

### File layout

`NewProjectModal` currently lives inside `AitoPage.tsx` (796 lines) and the client
block is about to triple in size. It moves out, and the client input decomposes:

| File | Responsibility |
|---|---|
| `components/aito/NewProjectModal.tsx` | Two-view shell (main form ⇄ new-contact sub-step) and submit orchestration |
| `components/aito/ClientSection.tsx` | The client + phone + email trio and their reset controls; owns one `ClientDraft` |
| `components/aito/ClientCombobox.tsx` | Rewritten: editable combobox, search, dropdown, "+ Create new client" footer |
| `components/aito/PhoneInput.tsx` | `SearchableSelect` (country code) + national-number input |
| `components/aito/NewContactForm.tsx` | The create sub-step |
| `lib/clientDraft.ts` | Pure helpers: `formatDisplayName`, `parsePhone`, `formatPhone` |
| `lib/countryCodes.ts` | `{ code, iso, name }[]`, ≈240 entries |

`AitoPage.tsx` keeps the board, the mutations and the trash modal.

### State

One object, so "dirty" is unambiguous:

```ts
interface ClientDraft {
  id: string;
  name: string;
  isDefault: boolean;                          // id === default contact → never sync
  countryCode: string;                         // '+689'
  nationalNumber: string;                      // '87296912'
  email: string;
  touched: { phone: boolean; email: boolean }; // user intent, not value diff
  original: {
    phone: string;                             // raw Zoho string, for revert
    email: string;
    phoneField: 'phone' | 'mobile';            // where the write goes back to
  };
}
```

`original.phoneField` is `mobile` when the contact's `mobile` is set, otherwise
`phone` when that is set, otherwise `mobile` (the default target for a contact with
neither).

Selecting a contact from the dropdown populates the draft directly from the search
result — the search endpoint already returns `phone`, `mobile` and `email`, so no
extra fetch is needed.

### Combobox behaviour

One input that always shows the current client's name:

```
Client   [ Client de passage      ▾] [↺]
Phone    [ +689 ▾ ] [             ] [↺]
Email    [                        ] [↺]
```

- Focus selects the text; typing replaces it with a search query and opens the
  dropdown (300 ms debounce, ≥2 chars — the existing behaviour).
- Blur without selecting reverts the text to the current client's name.
- Escape closes the dropdown only, and stops propagation so the modal stays open
  (existing behaviour, preserved).
- Arrow keys move the highlight, Enter selects.
- The dropdown's last row is a persistent **"+ Create new client"** footer, present
  whether or not there are results.
- When Zoho is not configured, the existing not-configured notice with the settings
  link replaces the whole client block, unchanged.

### Reset controls

Three, one per row. Each occupies reserved space at all times and fades in/out via
`opacity` + `pointer-events` when there is something to reset — no layout shift, no
permanently dead control. Each carries an `aria-label`.

| Control | Resets to | Visible when |
|---|---|---|
| Client ↺ | the default contact — reloads the whole draft, so phone and email clear and both `touched` flags reset | `id !== defaultContactId` |
| Phone ↺ | `parsePhone(original.phone)`, and clears `touched.phone` | `touched.phone` |
| Email ↺ | `original.email`, and clears `touched.email` | `touched.email` |

Visibility keys off `touched`, **not** a value diff. A contact stored as bare
`89645864` displays as `[+689][89645864]`, which re-formats to a different string
than the original — a value-diff test would light up the ↺ on a field the user
never touched.

Clearing the field entirely is a legitimate edit: it sets `touched`, and on submit
the `PATCH` sends an empty string, which clears the value in Zoho. The ↺ is the way
back.

### Phone parsing and formatting

`parsePhone(raw, defaultCode)`:

| Input | Output |
|---|---|
| `+689-87296912` | `{ cc: '+689', national: '87296912' }` |
| `+3312345678` | longest-prefix match against the code list |
| `00.687.76.31.68` | `{ cc: '+687', national: '763168' }` — leading `00` reads as `+` |
| `40 54 43 09` | `{ cc: '+689', national: '40544309' }` — default code, separators stripped |
| `` (empty) | `{ cc: '+689', national: '' }` |

`formatPhone({cc, national})` → `` `${cc}-${national}` ``, separators stripped,
**leading zeros preserved** (`+33-0179753070` exists in the org data and is
correct). An empty `national` formats to the empty string, not a bare `+689-`.

Normalization runs on blur so the user sees exactly what will be stored. The
country picker is `SearchableSelect` with `allowCustom: true`, so an unlisted code
can still be typed.

`touched.phone` flips only on a real user edit. Parsing a bare stored number for
display does **not** mark it dirty — creating a project must never mutate a client
record as a side effect.

### Display-name rule (create sub-step)

Company name and First/Last are mutually exclusive: filling one disables the other,
and clearing it re-enables the other. Only the resulting display name is required.

| Path | Display name | `customer_sub_type` |
|---|---|---|
| Company name filled | the company name verbatim | `business` |
| First + Last filled | `<First> <LAST>` | `individual` |

Casing, applied on blur and re-applied server-side:

- **First name** — title-case every segment split on spaces and hyphens.
- **Last name** — full uppercase via `toLocaleUpperCase('fr')` so accents fold
  correctly.

| Typed | Preview |
|---|---|
| `jean-pierre` / `de la tour` | `Jean-Pierre DE LA TOUR` |
| `élodie` / `teïva-marü` | `Élodie TEÏVA-MARÜ` |
| `MARIE anne` / `Dupont` | `Marie Anne DUPONT` |

A live preview line under the fields shows the resulting display name, so the rule
is visible rather than surprising.

Phone and email are optional in this form and use the same `PhoneInput`.

### Submit flow

```
main submit
  1. POST /aito/  { description, client_id, client_name, client_phone, client_email }
       success → close modal, board updates via the existing invalidation path
       failure → existing "could not create the project" toast, modal stays open

  2. if (!isDefault && (touched.phone || touched.email))
       PATCH /zoho/contacts/{id}
         ok   → silent
         fail → warning toast: "Project created — couldn't update client in Zoho"
```

Step 2 runs after step 1 resolves and does not block the modal from closing. If it
fails, the card keeps the value the user typed and Zoho does not — an acceptable,
self-healing divergence.

The create-client sub-step submits independently: `POST /zoho/contacts` → on
success the new contact becomes the selection with its phone/email as the baseline
(`touched` reset to false) and the view returns to the main form. Errors, including
Zoho's duplicate-name rejection, render inline in the sub-step.

## Backend

### `GET /zoho/status` — extended

The modal already calls this endpoint, so the default contact rides along rather
than costing a second round trip:

```json
{ "configured": true, "reachable": true,
  "default_contact_id": "66407000001237340",
  "default_contact_name": "Client de passage" }
```

Read from settings with the values above as built-in fallbacks. No Zoho call is
made to resolve them.

### `POST /zoho/contacts` — create

Request: `{ display_name, company_name?, first_name?, last_name?, email?, phone? }`.
Response: the same `ZohoContact` shape as search, so it is a drop-in for the
combobox.

Zoho payload:

```jsonc
{
  "contact_name": "<display name>",
  "contact_type": "customer",
  "customer_sub_type": "business" | "individual",
  "company_name": "…",                 // omitted on the person path
  "contact_persons": [{                // omitted entirely when there is nothing to put in it
    "first_name": "…", "last_name": "…",
    "email": "…", "mobile": "+689-…",
    "is_primary_contact": true
  }]
}
```

Currency and language are omitted so the org defaults apply. Display-name casing is
re-applied server-side rather than trusted from the client.

Errors: a duplicate `contact_name` maps to **409** carrying Zoho's own message;
other upstream failures map to 502; not-configured maps to 409 with the existing
"Zoho is not configured" detail.

### `PATCH /zoho/contacts/{contact_id}` — sync phone/email

Request: `{ email?, phone?, phone_field: 'phone' | 'mobile' }`. Only the keys
present are written.

1. **Guard:** if `contact_id` equals the configured default contact id, return
   **400** immediately. Server-side, so a frontend bug can never write to the
   walk-in record.
2. `GET /contacts/{contact_id}`, take the person with `is_primary_contact: true`
   (fallback: the first person).
3. Person exists → `PUT /books/v3/contacts/contactpersons/{cpid}` with the changed
   fields.
4. No person exists → `POST /books/v3/contacts/contactpersons` with `contact_id`,
   `is_primary_contact: true`, the contact's own `first_name`/`last_name` copied
   across (or blank), and the new values.

### `ZohoService` refactor

`search_contacts` hand-rolls token acquisition, the 401-retry-once loop, non-JSON
handling and error mapping. Create and patch need all of it. Extract
`ZohoService._request(db, method, path, *, params=None, json=None)` carrying that
logic once, and reduce `search_contacts` to a call plus its field mapping.

### Permissions

Both new endpoints reuse `Permission.AITO_CREATE`. No new permission is
introduced, so no API-key classification change is needed.

## Data model

- `aito_projects.client_email` — new nullable `String(200)`, added by an additive
  `ALTER TABLE` in `run_migrations()`, and threaded through `AitoProject`,
  `AitoProjectCreate`, `AitoProjectResponse` and `_to_response`.
- Storage only in this round. Surfacing the email on the card face or in the detail
  panel belongs to the card/detail-panel design and is deliberately not done here.
- Two new settings rows, editable in the existing Zoho settings tab, with the
  fallbacks listed under `GET /zoho/status`:
  - `zoho_default_contact_id`
  - `zoho_default_contact_name`

## Error handling summary

| Condition | Behaviour |
|---|---|
| Zoho not configured | Existing notice + settings link replaces the client block; project creation stays blocked |
| Search request fails | Existing inline "could not reach Zoho" row in the dropdown |
| `POST /aito/` fails | Existing toast; modal stays open with all input intact |
| `PATCH /zoho/contacts` fails | Warning toast; the card is already created and keeps the typed values |
| `POST /zoho/contacts` duplicate name | 409 → inline error on the display-name field; sub-step stays open |
| `POST /zoho/contacts` upstream error | 502 → inline error banner in the sub-step |

## Testing

**`lib/clientDraft.ts` (vitest, pure):**
- Every casing row in the display-name table, plus empty and single-segment inputs.
- Every `parsePhone` row, plus `formatPhone` round-trips and the empty-national case.

**Backend (`httpx.MockTransport`, the existing test seam):**
- `POST /zoho/contacts` payload shape for the company path and the person path.
- `contact_persons` omitted when there is no name-part, email or phone.
- Duplicate name → 409 carrying Zoho's message.
- 401 → single retry after refresh, then success.
- `PATCH` with an existing primary person → `PUT contactpersons/{id}`.
- `PATCH` with `contact_persons: []` → `POST contactpersons` with
  `is_primary_contact: true`.
- `PATCH` against the default contact id → 400, and no upstream request is made.
- `GET /zoho/status` returns settings values, and the fallbacks when unset.
- `POST /aito/` persists and returns `client_email`.

**Component (vitest + testing-library):**
- Default client is preselected on open and the client ↺ is hidden.
- Typing opens the dropdown and searches; selecting populates phone and email.
- Client ↺ restores the default and clears the phone/email rows.
- Per-field ↺ reverts to the original value and clears `touched`.
- A contact stored as a bare `89645864` shows no phone ↺ until the field is edited.
- Clearing an existing phone and submitting sends `PATCH` with an empty string.
- Submitting with an untouched phone sends no `PATCH`.
- Submitting with the default client selected sends no `PATCH`, even when the
  phone field has a value.
- The create sub-step disables First/Last when a company name is present and vice
  versa, and shows the correct display-name preview.

## i18n

Roughly 15 new keys under `aito.*` (reset labels, phone/email labels and
placeholders, the create-client footer and sub-step fields, the sync-failure
toast, duplicate-name error). The project has 12 locales and the i18n gate rejects
English placeholders, so every key needs a real translation in all 12 files.
