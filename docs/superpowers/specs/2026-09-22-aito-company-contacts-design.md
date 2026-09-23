# Aito: contact persons in the drawer and on the card

> **Scope change, same day:** first built for company clients only; approved
> later on 2026-09-22 to cover **every Zoho client** (individuals too). The
> sections below read "company" where the original design said so; the
> "Individuals" section at the end states what differs for a person client.
> The walk-in default client stays excluded.

**Date:** 2026-09-22
**Status:** approved; extended to individuals (2026-09-22)

## Problem

When the chosen Zoho client is a company, the new-project drawer still shows
the social-network chooser and a single phone/email pair mirrored from the
account's primary contact person. A company has several people (Zoho Books
"contact persons") and the operator has no way to say *who* at the company a
job is for, nor to add a new person without leaving for Zoho. Once the drawer
closes the card only remembers a phone and an email; the person's name is
gone, and the quote/invoice email pickers guess.

## What is being built

For **company** clients only (Zoho `customer_sub_type == "business"`, already
mapped to `ClientDraft.isCompany` and the `client_is_company` column):

1. The social-network chooser is replaced by a **contact list** of the
   account's Zoho contact persons, with a radio selection.
2. An inline **Add contact** form (first name, last name, phone, email) that
   creates the person in Zoho Books and selects it.
3. A collapsed **escape hatch** ("Use a different phone / email for this
   card") that reveals today's phone and email inputs for a card-only
   override.
4. The chosen person is **stored on the card** (Zoho contact person id +
   display name), shown on the kanban card and in the detail masthead.
5. The detail panel's **contact sheet** gets the same list and add form for
   company cards; phone/email edits write to the *selected* person in Zoho.
6. The **quote and invoice email pickers** pre-select the card's person.

The walk-in default client is unchanged. Individuals: see the closing section.

## Decisions taken

| Question | Decision |
|---|---|
| Layout | Option C of the brainstorm: radio list replaces phone/email; collapsed escape hatch for a card-only override. Chip row (B) and no-override list (A) rejected |
| Add form | Inline expansion under the list (A). Popover (B) rejected: new pattern, clips in the drawer, invites accidental dismissal of a Zoho write |
| What the card stores | The person too (B): two card-only columns. Phone/email-only snapshot (A) rejected because it throws the name away |
| Default selection | The person used on the client's **latest past card**, if still in the list; else Zoho's primary; else the first row |
| Escape-hatch values | **Card only.** Zoho untouched; the card keeps its person id and name |
| Contact sheet | **Switch person + edit.** Edits target the selected person, not the primary |
| Email pickers | Pre-select the card's person when present among recipients; else today's default |
| API shape | Dedicated `persons` routes under the Zoho router (approach 1). Widening the contact-detail route rejected (shared mapper, stricter permission); a local cache table rejected (nothing in the integration caches Zoho) |

## Data

### New columns on `aito_projects` (additive migration)

| Column | Type | Notes |
|---|---|---|
| `client_contact_person_id` | `String(50)`, nullable | Zoho `contact_person_id`. Card-only; never a foreign key |
| `client_contact_name` | `String(200)`, nullable | Display name snapshot ("Vaekehu Varney"); survives Zoho renames |

Both are added to the event-diff field whitelist in
`backend/app/models/aito_project.py` next to the existing seven client
fields, to `_project_response`, to `AitoProjectResponse`, and to the client
field whitelist of `PATCH /{project_id}`.

Existing company cards keep `NULL` in both. No backfill.

### Contact person shape (backend `_map_contact_person`, TS `ZohoContactPerson`)

```
{
  contact_person_id: str,
  first_name: str,
  last_name: str,
  name: str,          # normalize_display_name(first, last)
  email: str,
  phone: str,
  mobile: str,
  is_primary: bool,
}
```

The UI shows `mobile`, else `phone`, as "the number". This mirrors the
existing rule that client creation writes the phone into the person's
`mobile`.

### Payload changes

- `AitoProjectCreate`: `client_contact_person_id: str | None` (max 50),
  `client_contact_name: str | None` (max 200). Both optional; both ignored
  when `client_is_company` is not true (cleared to `None`).
- `AitoProjectUpdate`: same two fields, same whitelist rule.
- `AitoClientEdit`: same two fields. When present on a company card the
  route targets that person for the coordinates write (see "Contact sheet").
- `AitoClientHistoryResponse`: `latest_contact_person_id: str | None`, the
  value on the newest card in the history, beside `latest_social`.

Reachability is **unchanged**: the create route still requires a phone, an
email or a social handle. Selecting a person copies its phone/email into the
draft, so the existing checks in the drawer, `NewContactForm`, the contact
sheet and the server keep working without touching the person fields.

## API

Both routes live in `backend/app/api/routes/zoho.py` and are gated like the
search route (`AITO_CREATE`), because the drawer is the first consumer and
create-only users must be able to pick a person. Both return 409 when Zoho
is not configured and 502 on upstream failure, like the sibling routes.

### `GET /zoho/contacts/{contact_id}/persons` → `list[ZohoContactPerson]`

One Books call, `GET /contacts/{id}`, reading the `contact_persons` array
the response already carries. Service method `list_contact_persons(db,
contact_id)`. The default walk-in contact returns `[]` without a Zoho call
(it is never a company).

### `POST /zoho/contacts/{contact_id}/persons` → `ZohoContactPerson` (201)

Body `ZohoContactPersonCreate`:

| Field | Rule |
|---|---|
| `first_name` | required, 1–100, title-cased server side with `_title_case_segments` |
| `last_name` | optional, ≤100, upper-cased with `toLocaleUpperCase('fr')` semantics server side (`.upper()`) |
| `email` | optional, `_check_email` |
| `phone` | optional, `_check_phone` (`^\+\d{1,4}-\d{4,14}$`) |
| model validator | at least one of `email`, `phone` non-empty → else 422 "phone or email required" |

Service method `create_contact_person(db, contact_id, *, first_name,
last_name, email, phone)`:

1. `GET /contacts/{id}` to learn whether any person exists.
2. `POST /contacts/contactpersons` with `{contact_id, first_name,
   last_name, email, mobile: phone, is_primary_contact: <no persons yet>}`.
   This is the fallback arm that already exists inside
   `update_contact_person`; it is extracted into this method and
   `update_contact_person` calls it.
3. Returns the created person mapped through `_map_contact_person`.

`ZohoRequestRejected` → 409 with Zoho's message (same as `POST /contacts`).
Refuses the default walk-in contact with 400 (same as `PATCH /contacts/{id}`).

### `update_contact_person` gains `contact_person_id: str | None = None`

When given, the `PUT /contacts/contactpersons/{id}` targets that id instead
of the primary. When the id is not found among the account's persons the
service raises `ZohoNotFound`, which the client-edit route maps to 409
"contact person no longer exists" so the sheet can refetch.

### `PUT /aito/{project_id}/client` on a company card

Order stays Zoho-first: company name → person coordinates (now targeted at
`client_contact_person_id` when the payload carries one) → card update →
fan-out → version claim.

**Fan-out rule change:** phone/email propagate only to sibling active cards
of the same client whose `client_contact_person_id` equals the edited
card's (both `NULL` counts as equal). A change of person on one card never
fans out.

### `GET /aito/clients/{client_id}/history`

Adds `latest_contact_person_id` from the newest card. No new query.

## Frontend

### Shared component `ContactPersonPicker`

`frontend/src/components/aito/ContactPersonPicker.tsx`, used by the drawer
and the contact sheet. Props: `contactId`, `value` (person id or null),
`onSelect(person)`, `variant: 'drawer' | 'sheet'`. It owns the persons
query (`['zoho-contact-persons', contactId]`), the inline add form, and the
loading/failure states. It never touches phone/email inputs; the parent
copies coordinates on `onSelect`.

Rows: radio, display name, muted `mobile || phone` and email, a "primary"
tag. A person with neither coordinate still renders; the parent's
reachability logic reports "missing".

**Add form** (expands in place of the "＋ Add contact" row): first name,
last name, phone (`PhoneInput` with the country-code control), email. Save
disabled until first name and (phone or email) are present, with the hint
"A phone number or an email is needed to reach them." Name casing
normalises on blur as in `ClientEditor` (title-case first, upper last).
Save → `POST …/persons`; on success the person is appended to the query
cache, selected, and the form collapses. On failure the form stays open with
the server message; a 409 from Zoho shows Zoho's text verbatim.

**States:** skeleton rows while fetching; on query error the component
renders nothing and reports `onUnavailable()` so the parent falls back to
the plain phone/email inputs (Zoho hiccup never blocks creation).

### Drawer (`ClientSection` / `NewProjectDrawer`)

- When `draft.isCompany`, `SocialInput` is replaced by the picker. Phone and
  email rows move under a collapsed disclosure "Use a different phone /
  email for this card ▸". Expanding shows the existing inputs and revert
  arrows; the revert target is the selected person's values.
- `onSelect` sets `countryCode`/`nationalNumber`/`email` from the person,
  resets `touched`/`blurred`, and sets `original` to the person's values.
  Re-selecting while the disclosure is open re-prefills unless a field is
  `touched`.
- Default selection, applied once per client selection: history's
  `latest_contact_person_id` if present in the list → `is_primary` → first
  row. Empty list: nothing selected, add row only, plain inputs stay
  available through the disclosure.
- `ClientDraft` gains `contactPersonId: string | null` and
  `contactName: string`. Create payload carries both.
- The checklist's "Client account" line appends the person name when set
  ("Client account — SNP · Vaekehu Varney").

### Card and masthead

- `KanbanCard`: company card with `client_contact_name` shows one muted
  line with the name under the title. Nothing else moves.
- `ProjectDetailPanel` masthead: the name becomes a peer stat on the same
  row as phone and email. The masthead never grows a row (standing rule).

### Contact sheet (`ClientEditor`, company branch)

Company-name field → picker (`variant="sheet"`, compact rows) → phone and
email inputs prefilled from the selected person. Picking another person
re-prefills unless a field is edited. Save body: `company_name`,
`client_contact_person_id`, `client_contact_name`, `phone`, `email`,
`phone_field`, `expected_version`. Source badge stays "Zoho Books"; the
fan-out note reads "Phone and email also update sibling cards for this
person."

### Email pickers

Where `AitoQuoteEmailRecipient[]` is rendered (quote and invoice send
dialogs), the default recipient becomes the one whose `contact_person_id`
equals the card's `client_contact_person_id`, when present; otherwise the
existing default.

## i18n

New keys under `aito:` (all 14 locales, real translations, parity script):
`contactsLabel`, `contactsHint`, `contactPrimary`, `contactAdd`,
`contactAddTitle`, `contactSaveToZoho`, `contactNeedsPhoneOrEmail`,
`contactAddFailed`, `contactsUnavailable`, `contactOverrideToggle`,
`contactOverrideHint`, `clientEditFanOutPerson`, `contactGone`.

## Testing

**Backend** (pytest, `httpx.MockTransport` on `zoho_service.transport`, the
`_recording_books` pattern from `test_aito_client_edit.py`):

- `list_contact_persons` maps the array; walk-in contact short-circuits.
- `create_contact_person`: POST body, `is_primary_contact` true only when
  the account has no persons, `mobile` carries the phone, 409 on
  `ZohoRequestRejected`, 502 upstream, 400 on the walk-in contact, 422 on
  missing first name and on neither phone nor email, permission
  `AITO_CREATE` (static permission test).
- `update_contact_person` with an explicit id targets that id; unknown id
  raises `ZohoNotFound`.
- Project create/update/response round-trip the two fields; cleared when
  not a company.
- Client edit on a company card writes to the selected person; fan-out
  reaches only same-person siblings; a person switch does not fan out.
- History returns `latest_contact_person_id`.
- Migration test adds the two columns (drop-list convention).

**Frontend** (Vitest + MSW, `openClientSection` helper, `acme` company
fixture):

- Company draft swaps `SocialInput` for the picker; individual keeps it.
- Default selection order (history → primary → first).
- Selecting copies phone/email; checklist "reachable" reflects it; a person
  with no coordinates gives "missing".
- Disclosure override wins in the create payload; revert restores the
  person's values.
- Add form: disabled until valid, success appends and selects, failure
  keeps the form with the message.
- Persons query failure falls back to plain inputs.
- Create payload carries `client_contact_person_id` and `client_contact_name`.
- `ClientEditor` company branch: switch re-prefills, edited field is kept,
  PUT body assertion.
- Email picker default by person id.
- `KanbanCard` and masthead render the name; masthead stays one row.

## Delivery

- Branch `aito-company-contacts` in `.claude/worktrees/aito-company-contacts`,
  cut from local `main` at `1cc3b2169`.
- TDD per task; static bundle rebuilt at the end (`add -f`); all suites from
  the project root.

## Out of scope

- Editing or deleting existing contact persons.
- Changing which person is primary in Zoho.
- Backfilling persons onto existing company cards.
- Contact persons for the walk-in default client.

## Individuals (extension of 2026-09-22)

Every Books contact carries `contact_persons`; an individual's own name is
its **primary** person. So a person client gets the same picker, add form,
stored person, masthead stat and email-picker default as a company, with
these differences:

| Area | Company | Individual |
|---|---|---|
| Drawer | picker replaces the social chooser | picker sits under the name; the **social chooser stays** (it is a real channel for individuals) |
| Phone/email | behind the "use a different phone / email" disclosure | same |
| Card line / masthead stat | always when a person is set | only when the person's name **differs from the client name** — a client who is their own contact gains no extra line |
| Contact sheet | company name → picker → phone/email | first/last name → picker → phone/email |
| Client edit write | company name to the contact, coordinates to the picked person | **first/last name to Books' primary person** (that is the client), coordinates to the picked person; two person writes when they differ, name first |
| Create/PATCH | the person is kept | the person is kept — the "cleared when not a company" rule is gone |

Fan-out per person, history's `latest_contact_person_id` and the persons
routes already work for any card; the walk-in client still answers `[]`
and refuses creation.
