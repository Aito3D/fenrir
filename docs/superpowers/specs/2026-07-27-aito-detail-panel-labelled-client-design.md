# Aito detail panel: labelled client fields

Date: 2026-07-27
Status: approved by user (brainstorming session)

## Scope

This is **sub-project 1 of 2**. The user's request covered both this and a much
larger feature — project tasks with four optional services (Scan3D,
Modelisation3D, Impression3D, Usinage), including a nested form in the create
modal and an Impression3D cost that reuses the calculator engine. That second
piece needs its own spec and is deliberately **not** designed here; it is
roughly five times this size and would bury these decisions.

## Goal

In the project detail panel, label the client fields — `Client name:`,
`Phone:`, `Email:` — and say `Company name:` instead of `Client name:` when the
attached client is a company.

## Findings that shaped the design

### The Zoho question is already answered

The user asked whether `company_name` is sent when creating a client. It is:
`ZohoService.create_contact` sets `payload["company_name"]` whenever the company
path is taken, alongside `customer_sub_type: "business"` (vs `"individual"` for
the person path). No change needed.

### "Is this client a company?" is not currently knowable

A project stores only `client_id`, `client_name`, `client_phone` and
`client_email`. Nothing records the client's type.

The contact search response cannot supply it either: `_map_contact` maps only
`{id, name, company_name, phone, mobile, email}` and drops `customer_sub_type`.

**Nor can it be inferred from `company_name`.** The live directory contains
business-type contacts whose company field is empty — `Adrien Delpia` is
`customer_sub_type: "business"` with `company_name: ""` — so "non-empty company
means company" gives the wrong answer for real records.

The type therefore has to be surfaced from Zoho and stored on the project.

## Decisions made

| Decision | Choice |
|---|---|
| What to store | A `client_is_company` **boolean**, not the company-name string |
| Where it comes from | `customer_sub_type === "business"`, surfaced through `_map_contact` |
| When it is captured | At attach time, like the other client fields |
| Panel layout | Client fields become a labelled list in the body; the title becomes `Project #<id>` |
| Legacy cards | Default to `Client name:`; **no** network backfill |
| Markup | `<dl>` / `<dt>` / `<dd>` |

### Why a boolean rather than the company name

In this directory, business contacts have `contact_name == company_name`
(`3D Technologies`), and the ones that differ have an empty company field
(`Adrien Delpia`). The string therefore carries nothing `client_name` does not
already, while `customer_sub_type` is the reliable signal. One boolean is the
whole requirement.

### Why no backfill

Backfilling the flag for existing projects would mean a Zoho lookup per distinct
client, inside a startup migration. A slow or unreachable Zoho would then turn
into a failed boot — the exact coupling the rest of this feature has worked to
remove. Existing cards show the neutral `Client name:` until their client is
re-attached.

## Backend

### Contact mapping

`_map_contact` in `backend/app/services/zoho.py` gains `customer_sub_type`, so
both `search_contacts` and `create_contact` return it. `ZohoContact` in
`backend/app/api/routes/zoho.py` gains the matching field.

Zoho returns `"business"` or `"individual"`; treat anything else, or a missing
value, as not-a-company.

### Project column

`aito_projects.client_is_company` — new nullable `Boolean`, added by an additive
`ALTER TABLE` in `run_migrations()`, wrapped in `_safe_execute`.

Nullable rather than `DEFAULT false` so an un-backfilled legacy row is
distinguishable from one deliberately marked "not a company". Both render the
same label; the distinction costs nothing and keeps the door open.

### Threading

The field must reach **all six** places the equivalent `client_email` work
taught us to check, or it will be silently dropped on one path:

1. `AitoProject` model
2. `AitoProjectCreate`
3. `AitoProjectUpdate`
4. `AitoProjectResponse`
5. `_to_response`
6. `create_project`, **and** the `update_project` snapshot loop

That loop currently reads
`for key in ("client_id", "client_name", "client_phone", "client_email")` and
must gain `client_is_company`, or editing a card from the detail panel drops the
flag. The merged-snapshot guard above it is unchanged — the flag is optional and
ties to nothing.

## Frontend

### Types and draft

- `ZohoContact` gains `customer_sub_type: string`.
- `ClientDraft` gains `isCompany: boolean`.
- `draftFromContact` sets it from `contact.customer_sub_type === 'business'`.
- `defaultClientDraft` sets it `false` — the walk-in contact `Client de passage`
  is `customer_sub_type: "individual"`, so it correctly reads `Client name:`.
- `AitoPage`'s create mutation sends `client_is_company: draft.isCompany`.

A contact created through `NewContactForm`'s company path comes back from
`POST /zoho/contacts` with `customer_sub_type: "business"`, so it flows through
`draftFromContact` on the same path as a searched contact. No special case.

### Panel layout

```
┌─────────────────────────────┐
│ Project #12               ✕ │
├─────────────────────────────┤
│ Company name: ACME SARL     │
│ Phone:        +689-87123456 │
│ Email:        hi@acme.pf    │
│                             │
│ Support de caméra…          │
└─────────────────────────────┘
```

- The `<h2>` title becomes `t('aito.projectRef', { id: project.id })`.
- The client block moves out of the header into the body as a `<dl>`, with each
  field a `<dt>`/`<dd>` pair. That is the honest markup for a labelled field
  list and gives assistive technology the label-to-value association without
  extra ARIA.
- Phone and email keep their `tel:` and `mailto:` links inside their `<dd>`.
- A field with no value is **omitted entirely**, label included — an empty
  `Email:` row is noise, not information.
- The name row is always present: `Company name:` when `client_is_company`,
  `Client name:` otherwise, falling back to the existing `aito.noClient` text
  for legacy clientless cards.

### Accessibility

The dialog's `aria-label` keeps using `client_name`, not the new title, so the
panel still announces *who* it is about rather than "Project 12".

## Testing

**Backend:**
- `_map_contact` carries `customer_sub_type` through `search_contacts` and
  through `create_contact`'s response.
- `POST /aito/` persists and returns `client_is_company`.
- `PATCH /aito/{id}` writes it, clears it on an explicit null, and leaves it
  alone when the key is omitted — the three-way behaviour `client_email`
  established.

**Frontend:**
- `draftFromContact` sets `isCompany` true for `"business"`, false for
  `"individual"`, and false for an unexpected or missing value.
- `defaultClientDraft` sets it false.
- The panel renders `Company name:` when the flag is set and `Client name:`
  when it is false **or null** (the legacy case).
- A project with no email renders no `Email:` row at all.
- The panel title is the project reference, and the dialog's accessible name is
  still the client name.

**Existing-test impact: none — and that is itself the finding.** Counted against
the file rather than estimated, because the last three plans each undercounted
this. Every panel assertion in `AitoPage.test.tsx` targets the description
(`Support GoPro`), `Created`, `Last activity`, `Stage` or `Quote`; the four
`findByRole('dialog')` lookups pass no name filter. **No test anywhere asserts
the panel's client name, phone or email**, and there is no
`ProjectDetailPanel` test file.

So nothing needs retargeting — but the client block is being restructured with
zero coverage protecting it today. The tests listed above are therefore new
coverage for an area that had none, not replacements. The plan should treat
"add" rather than "retarget" as the instruction, and should not assume a green
suite means the panel still renders the client correctly.

## i18n

Five new keys in all 12 locale files, genuinely translated:

| Key | English |
|---|---|
| `aito.clientNameLabel` | `Client name` |
| `aito.companyNameLabel` | `Company name` |
| `aito.phoneLabel` | `Phone` |
| `aito.emailLabel` | `Email` |
| `aito.projectRef` | `Project #{{id}}` |

The trailing colon is markup, not translation — several locales space or style
it differently, and baking it into the string would force twelve translators to
carry punctuation.

## Out of scope

- Project tasks and their four services — sub-project 2, own spec.
- Editing the client from the detail panel; it remains read-only there.
- Backfilling `client_is_company` for existing projects.
