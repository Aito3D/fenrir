# Aito new-client form: required phone, empty company field

Date: 2026-07-27
Status: approved by user (brainstorming session)

## Goal

Two changes to the create-client sub-step of the Aito "New project" modal:

1. The phone number becomes **required** — a new Zoho contact cannot be created
   without one.
2. The company-name field starts **empty** instead of being pre-filled with
   whatever the user had typed into the client search.

## Consequences that are not obvious from the request

### `validatePhone` is shared and must not change

`ClientSection` uses the same validator to edit an **existing** client's phone,
where an empty value must stay valid: a client legitimately has no number, and
clearing one is an explicitly supported edit that writes an empty string to
Zoho. Making `validatePhone` reject empty would break that path.

The requirement therefore lives in `NewContactForm`, composed on top of the
shared validator rather than replacing it.

### Requiring the phone exposes a parked finding

`NewContactForm` currently gates its submit on **raw** validity, so an empty
phone would disable "Create client" from the moment the form opens — with no
message on screen, because nothing has been blurred yet. That is the finding
parked during the client-input plan ("`NewContactForm` disables its submit on an
invisible error"); requiring the phone turns it from an edge case into the
default first impression.

This design closes it rather than working around it.

## Decisions made

| Decision | Choice |
|---|---|
| Where "required" lives | `NewContactForm` only — the shared `validatePhone` is untouched |
| Submit gating | Button gates on **visible** errors; the action gates on **real** validity; submit force-blurs so the two reconcile |
| Requirement affordance | Visual `*` in the label **and** `aria-required` on the input |
| Server-side enforcement | **No** — the API stays permissive |
| `initialQuery` | Removed entirely rather than left as an ignored prop |

## 1. Required phone

### The check

```tsx
const phoneError = nationalNumber.trim()
  ? validatePhone({ countryCode, nationalNumber })
  : 'aito.phoneRequired';
```

Empty is now an error in this form; every other rule (4–14 digits, country-code
shape) still comes from the shared validator.

### The gating

Follows the pattern already established in `NewProjectModal`:

```tsx
const canSubmit = hasName && !visibleErrors.phone && !visibleErrors.email;

const submit = () => {
  setBlurred({ phone: true, email: true });
  if (!hasName || phoneError || emailError) return;   // real validity
  createMutation.mutate();
};
```

The button gates on **visible** errors, the action on **real** validity, and the
force-blur reconciles them. `canSubmit` computed during a render cannot see the
`setBlurred` that just fired, which is exactly why the guard re-checks the raw
errors rather than re-reading `canSubmit`.

Resulting behaviour:

| State | Button | Explanation on screen |
|---|---|---|
| Just opened, nothing typed | disabled | The existing preview line: "Enter a company name, or a first and last name" |
| Name typed, phone empty and untouched | enabled | — |
| …then Create pressed | blocked | `aito.phoneRequired` appears under the phone field |
| Name typed, phone blurred and invalid | disabled | The error is already visible |

No disabled state in this form is left unexplained.

### The affordance

The phone label renders a visual asterisk, and `PhoneInput` gains
`required?: boolean` which sets `aria-required` on the national-number input.
The asterisk alone is invisible to screen readers, so both are needed.

`aria-required` goes on the number input, not the country-code picker — the code
defaults to `+689` and is never empty.

### Why the API stays permissive

`POST /zoho/contacts` is **not** changed to reject a missing phone:

- Phone is optional in Zoho Books itself; the endpoint mirrors that contract.
- `PATCH /zoho/contacts/{id}` explicitly supports clearing a phone to an empty
  string. A `POST` that refused one would be asymmetric with its sibling.
- This form is the endpoint's only caller, so the UI rule is fully enforced in
  practice.

This is a deliberate, reversible choice: if the requirement should hold at the
boundary too, it is a `model_validator` on `ZohoContactCreate` and a test.

## 2. Empty company field

`initialQuery` currently threads from `ClientCombobox` → `ClientSection` →
`NewProjectModal` → `NewContactForm`, where it seeds the company-name field.
With the field starting empty it is dead, so the thread is removed rather than
left as an ignored parameter — `noUnusedLocals` would flag it, and a prop that
is passed but deliberately ignored is worse than no prop.

| File | Change |
|---|---|
| `NewContactForm` | `initialQuery` prop dropped; `useState('')` |
| `NewProjectModal` | `creatingClient` becomes `boolean` (was `string \| null`) |
| `ClientSection` | `onCreateNew: () => void` |
| `ClientCombobox` | the create footer calls `onCreateNew()` with no argument |

`creatingClient` was doing double duty as "which view is showing" and "the seed
value". With the seed gone it is just a boolean, which is what it always meant
semantically.

The person path (first/last name) was never seeded and is unaffected.

## Baseline

Verified against `fd1e95e63`. `PhoneInput`'s current props are
`{ countryCode, nationalNumber, onChange, onBlur?, invalid?, id?, disabled? }`,
where `onChange` already carries a second `changed: 'countryCode' |
'nationalNumber'` argument added during the card work — `required?: boolean`
slots in alongside without disturbing it. `maskVisibleErrors(errors, blurred)`
is already exported from `utils/clientDraft.ts` and already used by this form.

## Testing

**Correction made while planning: twelve existing tests are affected, not three.**
All eight tests in `NewContactForm.test.tsx` pass `initialQuery`, and four of
them need more than a prop removal — three took their client name from the seed,
and one asserts a button-disabled state that inverts under visible-error gating.
The plan carries the full enumeration.

**The three that assert the seeding directly must be flipped, not deleted:**

- `NewContactForm.test.tsx` — "seeds the company field from the search query"
  becomes "starts with an empty company field".
- `ClientCombobox.test.tsx` — the create-footer test asserts `onCreateNew` was
  called with no arguments instead of with `'zzz'`.
- `NewProjectModal.test.tsx` — the sub-step test asserts the company field is
  empty instead of `'zzz'`.

**New coverage in `NewContactForm.test.tsx`:**

- With a name filled and the phone left empty, pressing "Create client" does not
  call the API and reveals `aito.phoneRequired` under the phone field.
- Typing a valid number clears the message and lets the submit through.
- A phone that is present but too short still reports the length error, not the
  required error — the two must not collapse into one message.

Both new assertions must be **demonstrated to fail** before the fix. This
codebase has already produced tests that passed against broken code; a test
shown to fail is worth more than one that merely passes.

## i18n

One new key, `aito.phoneRequired`, in all 12 locale files, genuinely translated.
English: `Phone number is required.`
