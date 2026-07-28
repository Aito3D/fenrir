# Aito New-Client Form: Required Phone, Empty Company Field — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the phone number required when creating a new Zoho contact from the Aito modal, and start the company-name field empty instead of seeding it from the client search.

**Architecture:** The requirement lives in `NewContactForm` alone — the shared `validatePhone` must keep treating empty as valid, because `ClientSection` uses it to edit an existing client whose phone may legitimately be blank. The submit gating moves from raw validity to visible errors (with the action still gated on raw validity behind a force-blur), which closes a finding parked during the client-input plan. Starting the company field empty makes `initialQuery` dead, so the whole prop thread is removed across four components.

**Tech Stack:** React 19 + TanStack Query + Tailwind 4, Vitest + Testing Library + MSW.

**Spec:** `docs/superpowers/specs/2026-07-27-aito-new-client-required-phone-design.md`

## Codebase baseline

Verified against `01feae8e0` (2026-07-27).

| Fact | Detail |
|---|---|
| `NewContactForm` gating | `canSubmit = hasName && !phoneError && !emailError` — **raw** validity |
| `NewContactForm` submit | Force-blurs, then `if (!canSubmit) return` — reads a `canSubmit` computed before the force-blur |
| `PhoneInput` props | `{ countryCode, nationalNumber, onChange, onBlur?, invalid?, id?, disabled? }`; `onChange` carries a second `changed: 'countryCode' \| 'nationalNumber'` argument |
| `maskVisibleErrors(errors, blurred)` | Already exported from `utils/clientDraft.ts` and already used by this form |
| `initialQuery` thread | `ClientCombobox` → `ClientSection` → `NewProjectModal` (`creatingClient: string \| null`) → `NewContactForm` |

## Global Constraints

- TypeScript strict, no unused locals/parameters, ES2022. Path alias `@/` → `frontend/src/`.
- All commands run **from the project root**.
- New user-facing strings need a key in **all 12** locale files under `frontend/src/i18n/locales/` (`en, de, es, fr, it, ja, ko, pt-BR, ru, tr, zh-CN, zh-TW`), genuinely translated. `frontend/src/__tests__/i18n/locales.test.ts` enforces exact `en` parity against `de, fr, it, ja, pt-BR, zh-CN` and fails on extras as well as omissions. `frontend/scripts/check-i18n-parity.mjs` additionally fails when a non-English value is byte-identical to English.
- **`validatePhone` in `frontend/src/utils/clientDraft.ts` must not change.** `ClientSection` depends on empty staying valid so an existing client's phone can be cleared.
- **Working tree:** `static/index.html` (build output) and the untracked `frontend/src/__tests__/components/ViewTransitionWiring.test.tsx` belong to the repo owner. Stage by explicit path; never `git add -A`, `git add .` or `git add frontend/src`.
- Known frontend flakes that pass on isolated re-run: `PrintModal.test.tsx`, and `AitoPage.test.tsx` on `scrollIntoView`.
- Commit after every task. Do not push.

---

## The invalidated-test inventory

**The spec says three existing tests change. It is twelve.** Counted by hand against the files at `01feae8e0`; the count is split across the two tasks below so neither implementer discovers it mid-flight.

`frontend/src/__tests__/components/NewContactForm.test.tsx` — **all 8** tests pass `initialQuery`, so all 8 render calls change. Four need more than that:

| Line | Test | Why it needs more |
|---|---|---|
| 19 | `seeds the company field from the search query` | The behaviour it asserts is being removed — rewrite |
| 69 | `shows the Zoho duplicate message inline` | Took its name from `initialQuery`, and clicks Create with no phone — blocked once phone is required |
| 86 | `shows an email error only after the field is left, and disables submit` | Took its name from `initialQuery`; **and** line 91's `toBeDisabled()` inverts under visible-error gating |
| 102 | `rejects a too-short phone number and never calls the API` | Took its name from `initialQuery` |

`frontend/src/__tests__/components/NewProjectModal.test.tsx` — 3 tests type `'zzz'` into the combobox and expect it in the company field (lines 158, 169–171, 187–189).

`frontend/src/__tests__/components/ClientCombobox.test.tsx` — 1 test asserts `onCreateNew` was called with `'zzz'` (line 65).

---

## File Structure

**Modify:**

| File | Task | Change |
|---|---|---|
| `frontend/src/components/aito/NewContactForm.tsx` | 1, 2 | Drop `initialQuery`; required-phone check, gating, label asterisk |
| `frontend/src/components/aito/NewProjectModal.tsx` | 1 | `creatingClient` becomes `boolean` |
| `frontend/src/components/aito/ClientSection.tsx` | 1 | `onCreateNew: () => void` |
| `frontend/src/components/aito/ClientCombobox.tsx` | 1 | Footer calls `onCreateNew()` |
| `frontend/src/components/aito/PhoneInput.tsx` | 2 | `required?: boolean` → `aria-required` |
| `frontend/src/i18n/locales/*.ts` (12) | 2 | Add `aito.phoneRequired` |
| `frontend/src/__tests__/components/NewContactForm.test.tsx` | 1, 2 | See inventory |
| `frontend/src/__tests__/components/NewProjectModal.test.tsx` | 1 | 3 tests |
| `frontend/src/__tests__/components/ClientCombobox.test.tsx` | 1 | 1 test |

---

### Task 1: Start the company field empty and remove the `initialQuery` thread

Doing this **first** is deliberate: it repairs the four `NewContactForm` tests that were taking their client name from `initialQuery`, so Task 2 only has to deal with the phone consequences.

**Files:**
- Modify: `frontend/src/components/aito/NewContactForm.tsx`, `NewProjectModal.tsx`, `ClientSection.tsx`, `ClientCombobox.tsx`
- Test: `frontend/src/__tests__/components/NewContactForm.test.tsx`, `NewProjectModal.test.tsx`, `ClientCombobox.test.tsx`

**Interfaces:**
- Produces: `NewContactFormProps` loses `initialQuery`; `ClientComboboxProps.onCreateNew` and `ClientSectionProps.onCreateNew` become `() => void`.

- [ ] **Step 1: Flip the three tests that assert the seeding**

`NewContactForm.test.tsx` line 19 — replace the whole test:

```tsx
  it('starts with an empty company field', () => {
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByLabelText(/company name/i)).toHaveValue('');
  });
```

`ClientCombobox.test.tsx` line 65:

```tsx
    expect(onCreateNew).toHaveBeenCalledWith();
```

`NewProjectModal.test.tsx` line 158:

```tsx
    expect(screen.getByLabelText(/company name/i)).toHaveValue('');
```

- [ ] **Step 2: Repair the two sub-step tests that appended to the seed**

`NewProjectModal.test.tsx`, in both `Escape from the create-client sub-step steps back instead of closing the modal` and `a backdrop click from the create-client sub-step steps back instead of closing the modal`: the company field starts empty now, so typing `' Corp'` yields `' Corp'`, not `'zzz Corp'`. Change each pair of lines to type a whole name and assert it:

```tsx
    await user.type(screen.getByLabelText(/company name/i), 'ACME Corp');
    expect(screen.getByLabelText(/company name/i)).toHaveValue('ACME Corp');
```

Their point is that typed input survives Escape / a backdrop click, which is preserved.

- [ ] **Step 3: Remove the prop from the remaining five render calls**

In `NewContactForm.test.tsx`, delete `initialQuery="…"` from the render calls on lines 26, 38, 55, 76, 88 and 105. For the three that were relying on `initialQuery="ACME SARL"` to satisfy `hasName` — lines 76 (`shows the Zoho duplicate message inline`), 88 (`shows an email error…`) and 105 (`rejects a too-short phone number…`) — add this as the first interaction so they still have a client name:

```tsx
    await user.type(screen.getByLabelText(/company name/i), 'ACME SARL');
```

`shows the Zoho duplicate message inline` has no `user` yet — add `const user = userEvent.setup();` before the render.

- [ ] **Step 4: Run to verify they fail**

Run: `cd frontend && npx vitest run src/__tests__/components/NewContactForm.test.tsx src/__tests__/components/NewProjectModal.test.tsx src/__tests__/components/ClientCombobox.test.tsx && cd ..`
Expected: FAIL — the component still seeds from `initialQuery`, which is still a required prop.

- [ ] **Step 5: Drop the prop from `NewContactForm`**

```tsx
export interface NewContactFormProps {
  onCancel: () => void;
  onCreated: (contact: ZohoContact) => void;
}

export function NewContactForm({ onCancel, onCreated }: NewContactFormProps) {
  const { t } = useTranslation();
  const [companyName, setCompanyName] = useState('');
```

- [ ] **Step 6: Collapse `creatingClient` to a boolean**

In `NewProjectModal.tsx`:

```tsx
  // Was `string | null`, doing double duty as "which view is showing" and "the
  // seed for the company field". The company field starts empty now, so this is
  // only ever the former.
  const [creatingClient, setCreatingClient] = useState(false);
```

and update its four other uses:

```tsx
    if (creatingClient) setCreatingClient(false);
    else onClose();
```
```tsx
            {creatingClient ? t('aito.newClientTitle') : t('aito.modalTitle')}
```
```tsx
        {creatingClient ? (
          <NewContactForm onCancel={() => setCreatingClient(false)} onCreated={onClientCreated} />
        ) : (
```
```tsx
                  onCreateNew={() => setCreatingClient(true)}
```

`onClientCreated` still calls `setCreatingClient(false)` — change its `null` to `false`.

- [ ] **Step 7: Narrow the two callback types**

`ClientSection.tsx`: `onCreateNew: () => void;` in `ClientSectionProps`.
`ClientCombobox.tsx`: `onCreateNew: () => void;` in `ClientComboboxProps`, and the footer button becomes:

```tsx
                onClick={() => {
                  onCreateNew();
                  stopEditing();
                }}
```

- [ ] **Step 8: Run the tests**

Run: `cd frontend && npx vitest run src/__tests__/components/NewContactForm.test.tsx src/__tests__/components/NewProjectModal.test.tsx src/__tests__/components/ClientCombobox.test.tsx && cd ..`
Expected: PASS

- [ ] **Step 9: Full frontend verification**

Run: `cd frontend && npx tsc --noEmit && npm run build && cd .. && ./test_frontend.sh`
Expected: PASS. `tsc` is the real check that no `initialQuery` reference survives.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/aito/NewContactForm.tsx frontend/src/components/aito/NewProjectModal.tsx frontend/src/components/aito/ClientSection.tsx frontend/src/components/aito/ClientCombobox.tsx frontend/src/__tests__/components/NewContactForm.test.tsx frontend/src/__tests__/components/NewProjectModal.test.tsx frontend/src/__tests__/components/ClientCombobox.test.tsx
git commit -m "feat(aito): start the new-client company field empty"
```

---

### Task 2: Require the phone number

**Files:**
- Modify: `frontend/src/components/aito/NewContactForm.tsx`, `frontend/src/components/aito/PhoneInput.tsx`, all 12 `frontend/src/i18n/locales/*.ts`
- Test: `frontend/src/__tests__/components/NewContactForm.test.tsx`

**Interfaces:**
- Consumes: `validatePhone`, `validateEmail`, `maskVisibleErrors` from `utils/clientDraft.ts` — **all unchanged**.
- Produces: `PhoneInputProps` gains `required?: boolean`; i18n key `aito.phoneRequired`.

- [ ] **Step 1: Add the i18n key**

In all 12 locale files, inside the `aito` block next to the other validation messages.
English: `phoneRequired: 'Phone number is required.',`
French: `phoneRequired: 'Le numéro de téléphone est obligatoire.',`
Translate genuinely for `de, es, it, ja, ko, pt-BR, ru, tr, zh-CN, zh-TW`.

- [ ] **Step 2: Write the failing tests**

In `NewContactForm.test.tsx`, add three tests and amend one.

Add:

```tsx
  it('blocks submission with an empty phone and reveals the requirement on submit', async () => {
    let called = false;
    server.use(
      http.post('/api/v1/zoho/contacts', () => {
        called = true;
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/company name/i), 'ACME SARL');

    // A name alone used to be enough; the phone is required now.
    await user.click(screen.getByRole('button', { name: /create client/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/required/i);
    expect(called).toBe(false);
  });

  it('accepts the submission once a valid phone is supplied', async () => {
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<NewContactForm onCancel={vi.fn()} onCreated={onCreated} />);
    await user.type(screen.getByLabelText(/company name/i), 'ACME SARL');
    await user.click(screen.getByRole('button', { name: /create client/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/required/i);

    await user.type(screen.getByLabelText(/^phone/i), '87123456');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /create client/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it('reports the length error, not the required error, for a short phone', async () => {
    const user = userEvent.setup();
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/company name/i), 'ACME SARL');
    await user.type(screen.getByLabelText(/^phone/i), '12');
    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent(/4 and 14 digits/i);
    expect(screen.getByRole('alert')).not.toHaveTextContent(/required/i);
  });

  it('marks the phone field as required', () => {
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByLabelText(/^phone/i)).toHaveAttribute('aria-required', 'true');
  });
```

Amend `shows an email error only after the field is left, and disables submit`. Under visible-error gating an unblurred invalid email no longer disables the button, and the phone is now empty, so the trailing `toBeEnabled()` no longer holds either. Rename it and fix both assertions:

```tsx
  it('shows an email error only after the field is left', async () => {
    const user = userEvent.setup();
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/company name/i), 'ACME SARL');
    await user.type(screen.getByLabelText(/^email/i), 'nope');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent(/valid email/i);
    expect(screen.getByRole('button', { name: /create client/i })).toBeDisabled();

    await user.clear(screen.getByLabelText(/^email/i));
    await user.type(screen.getByLabelText(/^email/i), 'hi@acme.pf');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
```

The button-disabled assertion moves to *after* the blur, where a visible error genuinely does disable it — which is the property worth pinning.

- [ ] **Step 3: Run to verify they fail**

Run: `cd frontend && npx vitest run src/__tests__/components/NewContactForm.test.tsx && cd ..`
Expected: FAIL — no `aria-required`, and an empty phone currently submits.

- [ ] **Step 4: Add `required` to `PhoneInput`**

```tsx
  invalid?: boolean;
  /** Sets aria-required on the national-number input. The country code always
   *  has a value, so the requirement only concerns the number. */
  required?: boolean;
  id?: string;
```

destructure it, and on the `<input>`:

```tsx
        aria-invalid={invalid ? true : undefined}
        aria-required={required ? true : undefined}
```

- [ ] **Step 5: Require the phone in `NewContactForm`**

Replace the error/gating block:

```tsx
  // Required here, but NOT in the shared validator: ClientSection uses
  // validatePhone to edit an existing client, where an empty value is valid and
  // clearing a number is a supported edit.
  const phoneError = nationalNumber.trim()
    ? validatePhone({ countryCode, nationalNumber })
    : 'aito.phoneRequired';
  const emailError = validateEmail(email);
  const visibleErrors = maskVisibleErrors({ phone: phoneError, email: emailError }, blurred);
  // The button gates on what the user can SEE, the submit handler on what is
  // actually true — so a disabled button always has a message beside it, and an
  // untouched empty phone reveals its message on the first press instead of
  // disabling the button with no explanation.
  const canSubmit = hasName && !visibleErrors.phone && !visibleErrors.email;
```

and the submit handler:

```tsx
      onSubmit={(e) => {
        e.preventDefault();
        // Reveal anything the user never triggered by blurring. `canSubmit` was
        // computed before this call, so the guard below re-checks the raw
        // errors rather than re-reading it.
        setBlurred({ phone: true, email: true });
        if (!hasName || phoneError || emailError) return;
        setError(null);
        createMutation.mutate();
      }}
```

- [ ] **Step 6: Mark the field required in the UI**

```tsx
          <label htmlFor="aito-new-phone" className={labelCls}>
            {t('aito.clientPhone')} <span className="text-status-error">*</span>
          </label>
          <PhoneInput
            id="aito-new-phone"
            required
            countryCode={countryCode}
```

The `*` is decorative for sighted users; `aria-required` from Step 4 is what assistive technology reads, so the span needs no `aria-hidden` gymnastics — but do **not** move the asterisk into the translated string, or 12 locales have to carry punctuation.

- [ ] **Step 7: Run the tests**

Run: `cd frontend && npx vitest run src/__tests__/components/NewContactForm.test.tsx && cd ..`
Expected: PASS — 11 tests.

- [ ] **Step 8: Prove the new tests can fail**

Temporarily change the Step 5 error to `const phoneError = validatePhone({ countryCode, nationalNumber });` (dropping the required branch) and re-run. `blocks submission with an empty phone…` and `accepts the submission once a valid phone is supplied` must both FAIL. Restore, confirm `git diff` shows the file back as intended, and re-run to green. Report the observed output of both runs — this codebase has produced tests that passed against broken code, so a test demonstrated to fail is worth more than one that merely passes.

- [ ] **Step 9: Full frontend verification**

Run: `cd frontend && npx tsc --noEmit && npm run build && cd .. && ./test_frontend.sh`
Expected: PASS, including i18n parity.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/aito/NewContactForm.tsx frontend/src/components/aito/PhoneInput.tsx frontend/src/__tests__/components/NewContactForm.test.tsx frontend/src/i18n/locales
git commit -m "feat(aito): require a phone number when creating a client"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Required phone check composed on the shared validator | 2 |
| Visible-error gating + force-blur (closes the parked finding) | 2 |
| Asterisk + `aria-required` | 2 |
| API stays permissive | neither — deliberately no change |
| Empty company field | 1 |
| `initialQuery` thread removed | 1 |
| `aito.phoneRequired` × 12 | 2 |

**Correction to the spec:** its Testing section names three invalidated tests. The real figure is twelve, enumerated in the inventory above. The spec is otherwise accurate.

**Type consistency:** `phoneError` is `string | null` — an i18n key or null — matching what `maskVisibleErrors` and `FieldError` already consume. `PhoneInputProps.required` is `boolean | undefined`, and `aria-required={required ? true : undefined}` mirrors the existing `aria-invalid` treatment on the same element.

**Deliberately out of scope:** `POST /zoho/contacts` still accepts a contact with no phone; the reasoning is in the spec.
