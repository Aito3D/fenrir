# Aito: a social-network handle as a third contact channel

**Date:** 2026-08-05
**Status:** approved

## Problem

Creating an Aito project requires the client to be reachable: a phone number or
an email address. Some clients have neither. They are reached on Messenger or
Instagram, and today that means either inventing a placeholder email or not
using the board.

Add an optional social-network handle that satisfies the same reachability rule.
Exactly one of phone, email or social handle is required; more than one is
allowed but never demanded.

## Data model

Two nullable columns on `aito_projects`, alongside the existing `client_phone`
and `client_email`:

| column | type | notes |
| --- | --- | --- |
| `client_social_network` | `VARCHAR(20)` | one of `messenger`, `instagram`, `whatsapp`, `tiktok` |
| `client_social_handle` | `VARCHAR(100)` | free text, trimmed, non-empty |

Added by two `ALTER TABLE` statements in `run_migrations()`
(`backend/app/core/database.py`) — the additive pattern this project uses
instead of a migration framework.

### Card-only, deliberately

The handle is **not** written to Zoho. Zoho Books contacts have no native field
for it, and the alternatives (custom fields, notes free-text) each add a Zoho
setup step and a new failure mode to contact creation for data the board is the
only consumer of.

The consequence is explicit and accepted: the handle belongs to the project, not
to the contact. Selecting the same client for a second project starts with an
empty social field. If prefill turns out to matter, the fix is a Zoho custom
field later, not a different shape now.

### Pairing invariant

Network and handle are set together or not at all:

- handle blank (or whitespace) → both stored as `NULL`, whatever the network says
- handle present, network absent → `422`
- network not in the enum → `422`

Enforced once, in a `model_validator` shared by `AitoProjectCreate` and
`AitoProjectUpdate`, so no caller can produce a half-set pair.

On PATCH the pair is atomic: send both keys or neither. `AitoProjectUpdate` uses
`exclude_unset`, so a body carrying only `client_social_network` is a
network-without-handle and is rejected as such — there is no "change the network,
keep the handle" partial update. The panel's edit always submits both.

### Validation

Non-empty after trimming. Nothing else — no per-network pattern, no URL
extraction. A WhatsApp "handle" is a phone number and an Instagram one is not;
one lenient rule beats four that drift from platforms we do not control.

This choice has a visible consequence, honoured in §Display: because a pasted
profile URL or a display name with spaces is a legal value, no deep link is
generated from it.

## The reachability rule

"Phone or email" is currently enforced in three independent places. Each gains
one term, and the wording of each stays what it already is:

1. `backend/app/api/routes/aito.py:595` — the authority. Becomes
   `client_phone or client_email or client_social_handle`, still skipped when
   `quote_id` is set (a quote import carries its own client).
2. `NewProjectDrawer.clientReachable` — gates Create, and drives the Client
   section's amber hint and its `done` tick.
3. `NewContactForm.reachable` — gates the "+ New contact" sub-form. Without
   this, a walk-in whose only contact is an Instagram still could not be
   created, which is the gap the feature exists to close.

Both frontend gates keep the existing discipline: gate on what the user can
currently *see*, never on raw validity, so a disabled button always has a
message beside it explaining itself.

## Frontend

### Draft

`ClientDraft` (`frontend/src/utils/clientDraft.ts`) gains:

```ts
socialNetwork: SocialNetwork | null;
socialHandle: string;
```

It gets no `original`, `touched` or `blurred` entries. Those three exist solely
to keep an untouched contact from being rewritten in Zoho on save; a field that
never syncs needs none of them. It therefore also gets no revert button — there
is no stored value to revert to.

`draftFromContact` and `defaultClientDraft` initialise it to `(null, '')`.

### `SocialInput`

A new `frontend/src/components/aito/SocialInput.tsx`:

- a segmented row of four pills (icon + label), one per network
- picking one reveals the handle input beneath it with `animate-rise`, the same
  idiom the shipping block uses
- picking the selected pill again clears network and handle together
- no handle input on screen until a network is chosen

One component, two consumers: `ClientSection` (existing contact, placed below
email and above the shipping divider) and `NewContactForm`.

### Handing the value back from `NewContactForm`

`NewContactForm` writes a real Zoho contact on submit, and the handle cannot go
with it. So `onCreated` widens from `(contact)` to `(contact, social)`, and
`NewProjectDrawer.onClientCreated` seeds the returning draft with the handle the
user typed. Without this the field would silently empty itself the moment the
contact was created — the one path where the handle is most likely to be the
*only* contact detail.

### Create payload

`AitoPage.createProject` sends `client_social_network` / `client_social_handle`,
and `placeholderProject` carries them too, so the optimistic card shows the
handle before the server answers.

## Display and editing

The detail panel header's contact row gains a third `CopyableValue`: the network
icon, the network name as its label, the handle as its value. Plain copyable
text, no link — see §Validation.

`client_phone` and `client_email` are read-only in this panel today; there is no
client-edit affordance at all. The social handle gets one anyway: a pencil that
opens the same `SocialInput` inline and PATCHes on save, following
`ShippingCard`'s pattern — its own `useOptimisticBoardMutation` with a new
`applyClientSocial` transform in `utils/aitoOptimistic.ts`.

This leaves the panel asymmetric (social editable, phone and email not).
Accepted knowingly: the alternative is either widening scope to client contact
editing in general, or shipping a field whose typo can never be corrected.

`aito.py:1395`'s key list for `exclude_unset` PATCH handling gains both new keys.

## Testing

Backend:

- `test_aito_project_model.py` — the two columns
- a new migration test, modelled on `test_aito_shipping_migration.py` — the
  `ALTER TABLE` runs on an old database and is idempotent
- `test_aito_routes.py` — create succeeds with only a social handle; fails with
  none of the three; `422` on handle-without-network; blank handle nulls both;
  PATCH round-trips and clears

Frontend:

- new `SocialInput.test.tsx` — reveal, clear-on-reselect, keyboard reachability
- `clientDraft.test.ts` — the new draft fields and their defaults
- `ClientSection.test.tsx`, `NewContactForm.test.tsx` — the field renders, and
  the sub-form's submit gate opens on a handle alone
- `NewProjectDrawer.test.tsx` — Create enabled by a handle alone; the payload
  carries both keys
- `ProjectDetailPanel.test.tsx` — display and the inline edit

## i18n

New keys go into all 13 locales with real translations. The i18n gate rejects
English placeholders in non-English files, so a stub would fail the suite.

Keys needed: the section label, the four network names, the handle field label
and placeholder, and the panel's edit affordance labels.

## Out of scope

- Writing the handle to Zoho (custom fields or notes)
- Prefilling the handle when an existing contact is reselected
- Editing `client_phone` / `client_email` from the detail panel
- Deep links to profiles
- Networks beyond the four
- Search or filter by handle on the board
