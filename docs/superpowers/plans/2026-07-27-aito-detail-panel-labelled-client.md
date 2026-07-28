# Aito Detail Panel: Labelled Client Fields — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Label the client fields in the Aito project detail panel — `Client name:`, `Phone:`, `Email:` — and say `Company name:` instead of `Client name:` when the attached client is a company.

**Architecture:** A project cannot currently tell whether its client is a company: the contact mapping drops `customer_sub_type`, and `company_name` is empty on some business contacts so it cannot be inferred. So the type is surfaced through the Zoho mapping (Task 1), stored as a boolean on the project at attach time (Task 2), and consumed by a relaid-out panel (Task 3). The snapshot principle is preserved throughout — the panel renders correctly with Zoho unreachable.

**Tech Stack:** FastAPI + SQLAlchemy + Pydantic, pytest with `httpx.MockTransport`; React 19 + Tailwind 4, Vitest + Testing Library + MSW.

**Spec:** `docs/superpowers/specs/2026-07-27-aito-detail-panel-labelled-client-design.md`

## Codebase baseline

Verified against `bf68e5d13` (2026-07-27).

| Fact | Detail |
|---|---|
| `_map_contact` | Returns `{id, name, company_name, phone, mobile, email}` — drops `customer_sub_type` |
| `ZohoContact` | Same six fields in the route model and in TypeScript |
| `ZohoContact` TS fixtures | **6 test files** construct one; a new required field breaks all six at `tsc` |
| `aito_projects` | `client_id`, `client_name`, `client_phone`, `client_email` — no type flag |
| `update_project` loop | `for key in ("client_id", "client_name", "client_phone", "client_email")` |
| `ProjectDetailPanel` | Client name is the `<h2>` **and** the dialog's `aria-label`; phone/email are unlabelled links in the header |
| Panel test coverage | **None.** No assertion anywhere targets the panel's client name, phone or email, and there is no `ProjectDetailPanel` test file |

## Global Constraints

- Python line length 120; Ruff `E, W, F, I, B, C4, UP, ARG, SIM`; double quotes; Python 3.10 target.
- Use `./venv/bin/python3` for Python. `ruff` is on PATH.
- TypeScript strict, no unused locals/parameters, ES2022.
- All commands run **from the project root**.
- New user-facing strings need a key in **all 12** locale files under `frontend/src/i18n/locales/`, genuinely translated. `frontend/src/__tests__/i18n/locales.test.ts` enforces `en` parity against `de, fr, it, ja, pt-BR, zh-CN` and fails on extras as well as omissions. `frontend/scripts/check-i18n-parity.mjs` additionally fails when a non-English value is byte-identical to English.
- Schema changes are additive `ALTER TABLE` statements inside `run_migrations()` in `backend/app/core/database.py`, wrapped in `_safe_execute`. No migration framework.
- **Known pre-existing failures, not yours:** a repo-wide `ruff format --check` fails on 6 unrelated files (`camera.py`, `library.py`, `test_camera_api.py`, `test_library_file_history_api.py`, `test_aito_project_model.py`, `test_camera_chamber_stream.py`) — do not reformat them. Verify the backend with `./venv/bin/python3 -m pytest backend/tests/unit/ -q && ruff check backend/`.
- Known frontend flakes that pass on isolated re-run: `PrintModal.test.tsx`, and `AitoPage.test.tsx` on `scrollIntoView`.
- **Working tree:** `static/index.html` (build output) and the untracked `frontend/src/__tests__/components/ViewTransitionWiring.test.tsx` belong to the repo owner. Stage by explicit path; never `git add -A`, `git add .` or `git add frontend/src`.
- Commit after every task. Do not push.

---

## File Structure

| File | Task | Change |
|---|---|---|
| `backend/app/services/zoho.py` | 1 | `_map_contact` carries `customer_sub_type` |
| `backend/app/api/routes/zoho.py` | 1 | `ZohoContact.customer_sub_type` |
| `frontend/src/api/client.ts` | 1, 2 | `ZohoContact.customer_sub_type`; `AitoProject.client_is_company` + create/update payloads |
| 6 frontend test files | 1 | Fixture updates (`tsc` enumerates them) |
| `backend/app/models/aito_project.py` | 2 | `client_is_company` column |
| `backend/app/core/database.py` | 2 | `ALTER TABLE` |
| `backend/app/schemas/aito.py` | 2 | Create / Update / Response |
| `backend/app/api/routes/aito.py` | 2 | `_to_response`, `create_project`, `update_project` loop |
| `frontend/src/utils/clientDraft.ts` | 3 | `ClientDraft.isCompany` |
| `frontend/src/pages/AitoPage.tsx` | 3 | Send the flag on create |
| `frontend/src/components/aito/ProjectDetailPanel.tsx` | 3 | Relayout; existing metadata `<dl>` restyled to match |
| `frontend/src/i18n/locales/*.ts` (12) | 3 | 5 keys |
| `frontend/src/__tests__/components/ProjectDetailPanel.test.tsx` | 3 | **New file** — this area has no coverage today |
| `frontend/src/__tests__/pages/AitoPage.test.tsx` | 3 | 5 assertions the colon breaks |

---

### Task 1: Surface `customer_sub_type` through the contact mapping

**Files:**
- Modify: `backend/app/services/zoho.py`, `backend/app/api/routes/zoho.py`, `frontend/src/api/client.ts`, and the 6 frontend test files listed in Step 5
- Test: `backend/tests/unit/services/test_zoho_service.py`, `backend/tests/unit/test_zoho_routes.py`

**Interfaces:**
- Produces: `_map_contact` returns a `customer_sub_type` key; `ZohoContact` gains `customer_sub_type: str` (Pydantic) / `customer_sub_type: string` (TS).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/unit/services/test_zoho_service.py`:

```python
@pytest.mark.asyncio
async def test_search_contacts_carries_customer_sub_type(async_client, db_session):
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return httpx.Response(200, json={"contacts": [
            {"contact_id": "b1", "contact_name": "ACME SARL", "customer_sub_type": "business"},
            {"contact_id": "i1", "contact_name": "Paul THEIS", "customer_sub_type": "individual"},
            {"contact_id": "u1", "contact_name": "Legacy"},
        ]})

    zoho_service.transport = _transport(handler)
    results = await zoho_service.search_contacts(db_session, "a")
    assert [c["customer_sub_type"] for c in results] == ["business", "individual", ""]


@pytest.mark.asyncio
async def test_create_contact_response_carries_customer_sub_type(async_client, db_session):
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return httpx.Response(201, json={"contact": {
            "contact_id": "n1", "contact_name": "ACME SARL", "customer_sub_type": "business",
        }})

    zoho_service.transport = _transport(handler)
    result = await zoho_service.create_contact(
        db_session, company_name="ACME SARL", first_name="", last_name="", email="", phone=""
    )
    assert result["customer_sub_type"] == "business"
```

The third fixture in the first test — a contact with the key absent — is the one that matters: Zoho omits fields it has no value for, and `""` must be the result rather than a `KeyError` or `None`.

- [ ] **Step 2: Run to verify they fail**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/services/test_zoho_service.py -v -k customer_sub_type`
Expected: FAIL — `KeyError: 'customer_sub_type'`

- [ ] **Step 3: Extend the mapper and the route model**

In `backend/app/services/zoho.py`, add to `_map_contact`'s returned dict, after `"company_name"`:

```python
        # "business" | "individual". Aito stores this as a boolean at attach
        # time so the detail panel can say "Company name" instead of "Client
        # name" — it cannot be inferred from company_name, which is empty on
        # some business contacts in the live directory.
        "customer_sub_type": contact.get("customer_sub_type", ""),
```

In `backend/app/api/routes/zoho.py`:

```python
class ZohoContact(BaseModel):
    id: str
    name: str
    company_name: str
    customer_sub_type: str
    phone: str
    mobile: str
    email: str
```

- [ ] **Step 4: Run the backend tests**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/services/test_zoho_service.py backend/tests/unit/test_zoho_routes.py -v`
Expected: PASS

- [ ] **Step 5: Update the TypeScript type and every fixture**

In `frontend/src/api/client.ts`:

```ts
export interface ZohoContact {
  id: string;
  name: string;
  company_name: string;
  /** "business" | "individual" from Zoho; "" when the field was absent. */
  customer_sub_type: string;
  phone: string;
  mobile: string;
  email: string;
}
```

Making it **required** rather than optional is deliberate: the backend always sends it, so an optional field would understate the contract — and `tsc` then enumerates every fixture that needs updating instead of letting one drift.

Add `customer_sub_type` to the `ZohoContact` fixtures in these six files. Use `'business'` where the fixture's name reads like a company (`ACME SARL`, `Acmé Industrie`) and `'individual'` otherwise, so Task 3's tests have realistic data to build on:

- `frontend/src/__tests__/utils/clientDraft.test.ts` (the `base` fixture)
- `frontend/src/__tests__/components/ClientCombobox.test.tsx` (two contacts)
- `frontend/src/__tests__/components/NewContactForm.test.tsx` (the `created` fixture)
- `frontend/src/__tests__/components/ClientSection.test.tsx` (the `acme` fixture)
- `frontend/src/__tests__/components/NewProjectModal.test.tsx` (the `bad1` fixture)
- `frontend/src/__tests__/pages/AitoPageClientSync.test.tsx`

- [ ] **Step 6: Verify**

Run: `cd frontend && npx tsc --noEmit && npm run build && cd .. && ./test_frontend.sh`
Expected: PASS. `tsc` is what proves no fixture was missed.

- [ ] **Step 7: Commit**

```bash
git add backend/app/services/zoho.py backend/app/api/routes/zoho.py backend/tests/unit/services/test_zoho_service.py frontend/src/api/client.ts frontend/src/__tests__
git commit -m "feat(zoho): carry customer_sub_type through the contact mapping"
```

---

### Task 2: Store `client_is_company` on the project

**Files:**
- Modify: `backend/app/models/aito_project.py`, `backend/app/core/database.py`, `backend/app/schemas/aito.py`, `backend/app/api/routes/aito.py`, `frontend/src/api/client.ts`
- Test: `backend/tests/unit/test_aito_routes.py`

**Interfaces:**
- Produces: `AitoProject.client_is_company: bool | None` on the model and all three DTOs; TS `AitoProject.client_is_company: boolean | null` and `AitoProjectUpdate.client_is_company?: boolean | null`; `api.createAitoProject` accepts `client_is_company?: boolean | null`.

> **This is the field-threading task, and it has a known failure mode.** The equivalent `client_email` work had to reach six places, and the `update_project` snapshot loop was the one nearly missed — omitting it means the detail panel silently drops the flag on every card edit. All six are enumerated below.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/unit/test_aito_routes.py`:

```python
@pytest.mark.asyncio
async def test_create_project_persists_client_is_company(async_client):
    r = await _create(async_client, client_is_company=True)
    assert r.status_code == 201
    assert r.json()["client_is_company"] is True
    listed = (await async_client.get("/api/v1/aito/")).json()
    assert listed[0]["client_is_company"] is True


@pytest.mark.asyncio
async def test_create_project_defaults_client_is_company_to_null(async_client):
    """Legacy rows and callers that omit the flag are indistinguishable from
    'not a company' at render time, but stay distinguishable in the data."""
    r = await _create(async_client)
    assert r.json()["client_is_company"] is None


@pytest.mark.asyncio
async def test_update_project_writes_and_clears_client_is_company(async_client):
    project_id = (await _create(async_client)).json()["id"]

    r = await async_client.patch(f"/api/v1/aito/{project_id}", json={"client_is_company": True})
    assert r.json()["client_is_company"] is True

    r = await async_client.patch(f"/api/v1/aito/{project_id}", json={"client_is_company": None})
    assert r.json()["client_is_company"] is None

    r = await async_client.patch(f"/api/v1/aito/{project_id}", json={"description": "Autre pièce"})
    assert r.json()["client_is_company"] is None
```

The third assertion in the last test is the one that catches a missing entry in the `update_project` loop.

- [ ] **Step 2: Run to verify they fail**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_routes.py -v -k client_is_company`
Expected: FAIL — `KeyError: 'client_is_company'`

- [ ] **Step 3: Add the column**

In `backend/app/models/aito_project.py`, after `client_email`:

```python
    client_is_company: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
```

Add `Boolean` to the `sqlalchemy` import on that file's import line.

- [ ] **Step 4: Add the migration**

At the end of `run_migrations()` in `backend/app/core/database.py`:

```python
    # Migration: Aito cards record whether the attached client is a company, so
    # the detail panel can label the name "Company name" rather than "Client
    # name". Nullable on purpose — a legacy row that predates the flag stays
    # distinguishable from one deliberately marked "not a company", though both
    # render the same label.
    await _safe_execute(conn, "ALTER TABLE aito_projects ADD COLUMN client_is_company BOOLEAN")
```

- [ ] **Step 5: Thread it through all six places**

`backend/app/schemas/aito.py` — add to `AitoProjectCreate` **and** `AitoProjectUpdate`, after `client_email` in each:

```python
    client_is_company: bool | None = None
```

and to `AitoProjectResponse`:

```python
    client_is_company: bool | None
```

`backend/app/api/routes/aito.py` — in `_to_response`:

```python
        client_is_company=p.client_is_company,
```

in `create_project`:

```python
        client_is_company=payload.client_is_company,
```

and widen the `update_project` snapshot loop:

```python
    for key in ("client_id", "client_name", "client_phone", "client_email", "client_is_company"):
        if key in fields:
            setattr(project, key, fields[key])
```

The merged-snapshot guard above that loop is unchanged — the flag is optional and ties to no other field.

- [ ] **Step 6: Run the backend tests**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/ -q && ruff check backend/`
Expected: PASS

- [ ] **Step 7: Update the TypeScript types**

In `frontend/src/api/client.ts`, add to `AitoProject` after `client_email`:

```ts
  client_is_company: boolean | null;
```

to `AitoProjectUpdate`:

```ts
  client_is_company?: boolean | null;
```

and to `createAitoProject`'s parameter type:

```ts
    client_is_company?: boolean | null;
```

- [ ] **Step 8: Verify and commit**

Run: `cd frontend && npx tsc --noEmit && cd ..`

```bash
git add backend/app/models/aito_project.py backend/app/core/database.py backend/app/schemas/aito.py backend/app/api/routes/aito.py backend/tests/unit/test_aito_routes.py frontend/src/api/client.ts
git commit -m "feat(aito): record whether a project's client is a company"
```

---

### Task 3: Relay out the panel with labelled fields

**Files:**
- Modify: `frontend/src/utils/clientDraft.ts`, `frontend/src/pages/AitoPage.tsx`, `frontend/src/components/aito/ProjectDetailPanel.tsx`, all 12 `frontend/src/i18n/locales/*.ts`
- Test: `frontend/src/__tests__/utils/clientDraft.test.ts`; **create** `frontend/src/__tests__/components/ProjectDetailPanel.test.tsx`

**Interfaces:**
- Consumes: `ZohoContact.customer_sub_type` (Task 1), `AitoProject.client_is_company` (Task 2).
- Produces: `ClientDraft.isCompany: boolean`.

> **This area has no test coverage today.** No assertion anywhere targets the panel's client name, phone or email, and there is no `ProjectDetailPanel` test file. Nothing will break as you restructure — which also means a green suite proves nothing about this panel. The new test file is first coverage, not a retarget.

- [ ] **Step 1: Add the i18n keys**

Five keys in all 12 locale files, inside the `aito` block. English:

```ts
    clientNameLabel: 'Client name',
    companyNameLabel: 'Company name',
    phoneLabel: 'Phone',
    emailLabel: 'Email',
    projectRef: 'Project #{{id}}',
```

French:

```ts
    clientNameLabel: 'Nom du client',
    companyNameLabel: 'Nom de la société',
    phoneLabel: 'Téléphone',
    emailLabel: 'E-mail',
    projectRef: 'Projet n°{{id}}',
```

Translate genuinely for `de, es, it, ja, ko, pt-BR, ru, tr, zh-CN, zh-TW`. **The trailing colon is markup, not translation** — it is rendered by the component, so no locale string carries punctuation. Keep `{{id}}` intact and positioned for the target language.

- [ ] **Step 2: Write the failing `clientDraft` tests**

Append to `frontend/src/__tests__/utils/clientDraft.test.ts`, inside the `draftFromContact` describe:

```ts
  it.each([
    ['business', true],
    ['individual', false],
    ['', false],
    ['something-else', false],
  ])('maps customer_sub_type %s to isCompany %s', (subType, expected) => {
    expect(draftFromContact({ ...base, customer_sub_type: subType }, 'default-id').isCompany).toBe(expected);
  });
```

and inside the `defaultClientDraft` describe, extend the existing exact-object assertion with `isCompany: false`.

- [ ] **Step 3: Write the failing panel tests**

Create `frontend/src/__tests__/components/ProjectDetailPanel.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { ProjectDetailPanel } from '../../components/aito/ProjectDetailPanel';
import type { AitoProject } from '../../api/client';

const project: AitoProject = {
  id: 12,
  description: 'Support de caméra',
  column: 'devis',
  position: 0,
  status: 'active',
  client_id: 'z1',
  client_name: 'ACME SARL',
  client_phone: '+689-87123456',
  client_email: 'hi@acme.pf',
  client_is_company: true,
  created_at: '2026-07-27T00:00:00',
  updated_at: '2026-07-27T00:00:00',
};

const show = (overrides: Partial<AitoProject> = {}) =>
  render(<ProjectDetailPanel project={{ ...project, ...overrides }} onClose={vi.fn()} />);

describe('ProjectDetailPanel client fields', () => {
  it('titles the panel with the project reference, not the client', () => {
    show();
    expect(screen.getByRole('heading')).toHaveTextContent(/Project #12|Projet n°12/);
  });

  it('still names the dialog after the client for assistive technology', () => {
    show();
    expect(screen.getByRole('dialog')).toHaveAccessibleName('ACME SARL');
  });

  it('labels a company client as Company name', () => {
    show();
    expect(screen.getByText(/company name/i)).toBeInTheDocument();
    expect(screen.queryByText(/^client name/i)).not.toBeInTheDocument();
  });

  it('labels a person client as Client name', () => {
    show({ client_is_company: false, client_name: 'Paul THEIS' });
    expect(screen.getByText(/client name/i)).toBeInTheDocument();
    expect(screen.queryByText(/company name/i)).not.toBeInTheDocument();
  });

  it('labels a legacy card with a null flag as Client name', () => {
    show({ client_is_company: null });
    expect(screen.getByText(/client name/i)).toBeInTheDocument();
  });

  it('labels the phone and email, and keeps their links', () => {
    show();
    expect(screen.getByText(/phone/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '+689-87123456' })).toHaveAttribute(
      'href',
      'tel:+689-87123456',
    );
    expect(screen.getByRole('link', { name: 'hi@acme.pf' })).toHaveAttribute(
      'href',
      'mailto:hi@acme.pf',
    );
  });

  it('omits a field entirely when it has no value', () => {
    show({ client_email: null });
    expect(screen.queryByText(/email/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `cd frontend && npx vitest run src/__tests__/components/ProjectDetailPanel.test.tsx src/__tests__/utils/clientDraft.test.ts && cd ..`
Expected: FAIL — no labels exist, and `isCompany` is not on the draft.

- [ ] **Step 5: Add `isCompany` to the draft**

In `frontend/src/utils/clientDraft.ts`, add to the `ClientDraft` interface after `isDefault`:

```ts
  /** Zoho's customer_sub_type was "business". Drives the detail panel's
   *  "Company name" vs "Client name" label. */
  isCompany: boolean;
```

in `draftFromContact`, after `isDefault`:

```ts
    isCompany: contact.customer_sub_type === 'business',
```

and in `defaultClientDraft` — the walk-in contact is `individual`:

```ts
    isCompany: false,
```

- [ ] **Step 6: Send the flag on create**

In `frontend/src/pages/AitoPage.tsx`, in `createMutation`'s `mutationFn`, after `client_email`:

```tsx
        client_is_company: draft.isCompany,
```

- [ ] **Step 7: Relay out the panel as one labelled list**

The panel **already has** a `<dl>` for Created / Last activity / Stage, using a
different convention: label left, value **right-aligned**, no colon. Rather than
add a second, differently-styled list a few pixels away, the client rows join it
and the whole list adopts `Label: value`, left-aligned.

First, the header loses the client block and becomes the project reference. The
dialog's `aria-label` stays the client name, so the panel still announces who it
is about:

```tsx
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-start justify-between gap-3 flex-shrink-0">
          <h2 className="text-lg font-semibold text-white truncate min-w-0">
            {t('aito.projectRef', { id: project.id })}
          </h2>
```

(the close button that follows is unchanged.)

Then replace the whole existing `<dl>` with the unified one. A row is a
`<div>` wrapping one `<dt>`/`<dd>` pair — valid HTML, and what lets each row be
a flex line:

```tsx
          {/* One description list for the whole record. <dt>/<dd> gives
              assistive technology the label-to-value association for free; the
              colon is markup, so no locale string carries punctuation. Client
              rows with no value are omitted entirely — an empty "Email:" is
              noise, not information. The mid-list border separates the client
              group from the project metadata. */}
          <dl className="border-t border-bambu-dark-tertiary pt-4 space-y-2 text-sm">
            <div className="flex items-baseline gap-2">
              <dt className="text-bambu-gray flex-shrink-0">
                {project.client_is_company ? t('aito.companyNameLabel') : t('aito.clientNameLabel')}:
              </dt>
              <dd className={`min-w-0 truncate ${project.client_name ? 'text-white' : 'text-bambu-gray'}`}>
                {project.client_name ?? t('aito.noClient')}
              </dd>
            </div>
            {project.client_phone && (
              <div className="flex items-baseline gap-2">
                <dt className="text-bambu-gray flex-shrink-0">{t('aito.phoneLabel')}:</dt>
                <dd className="min-w-0 truncate">
                  <a href={`tel:${project.client_phone}`} className="text-white hover:text-bambu-green">
                    {project.client_phone}
                  </a>
                </dd>
              </div>
            )}
            {project.client_email && (
              <div className="flex items-baseline gap-2">
                <dt className="text-bambu-gray flex-shrink-0">{t('aito.emailLabel')}:</dt>
                <dd className="min-w-0 truncate">
                  <a href={`mailto:${project.client_email}`} className="text-white hover:text-bambu-green">
                    {project.client_email}
                  </a>
                </dd>
              </div>
            )}

            <div className="flex items-baseline gap-2 border-t border-bambu-dark-tertiary pt-2 mt-2">
              <dt className="text-bambu-gray flex-shrink-0">{t('aito.createdLabel')}:</dt>
              <dd className="text-white min-w-0">{created ? created.toLocaleString(i18n.language) : '—'}</dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="text-bambu-gray flex-shrink-0">{t('aito.lastActivity')}:</dt>
              <dd className="text-white min-w-0">{updated ? updated.toLocaleString(i18n.language) : '—'}</dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="text-bambu-gray flex-shrink-0">{t('aito.stage')}:</dt>
              <dd className="text-white flex items-center gap-2">
                {column && <span className={`w-2 h-2 rounded-full ${column.dot}`} />}
                {column ? t(column.labelKey) : project.column}
              </dd>
            </div>
          </dl>
```

Each row keeps `<dt>` and `<dd>` as siblings inside its `<div>`, which matters:
an existing test reaches the value via `getByText('Last activity').nextElementSibling`.

- [ ] **Step 7a: Fix the five assertions the colon breaks**

`getByText` matches normalised text exactly, so `getByText('Created')` no longer
matches a `<dt>` whose textContent is now `Created:`. Five assertions in
`frontend/src/__tests__/pages/AitoPage.test.tsx` are affected — they were found
by grep, not estimated:

| Line | Change |
|---|---|
| 166 | `getByText('Created')` → `getByText('Created:')` |
| 167 | `getByText('Last activity')` → `getByText('Last activity:')` |
| 168 | `getByText('Stage')` → `getByText('Stage:')` |
| 287 | `getByText('Last activity')` → `getByText('Last activity:')` |
| 304 | `getByText('Last activity')` → `getByText('Last activity:')` |

Lines 287 and 304 then walk `.nextElementSibling` to read the `<dd>`; that still
works because the markup keeps `<dt>` and `<dd>` as siblings. Do **not** loosen
these to regexes — the exact string is what would catch an accidental label
change.

- [ ] **Step 8: Run the tests**

Run: `cd frontend && npx vitest run src/__tests__/components/ProjectDetailPanel.test.tsx src/__tests__/utils/clientDraft.test.ts && cd ..`
Expected: PASS

- [ ] **Step 9: Prove the label test can fail**

Temporarily hard-code the label to `t('aito.clientNameLabel')` regardless of the flag and re-run. `labels a company client as Company name` must FAIL. Restore, confirm with `git diff` that the file is back as intended, and re-run to green. Report the observed output of both runs — this codebase has produced several tests that passed against broken code.

- [ ] **Step 10: Full verification**

Run: `cd frontend && npx tsc --noEmit && npm run build && cd .. && ./test_frontend.sh`
Expected: PASS, including i18n parity.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/utils/clientDraft.ts frontend/src/pages/AitoPage.tsx frontend/src/components/aito/ProjectDetailPanel.tsx frontend/src/i18n/locales frontend/src/__tests__/components/ProjectDetailPanel.test.tsx frontend/src/__tests__/utils/clientDraft.test.ts
git commit -m "feat(aito): label the detail panel's client fields"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| `customer_sub_type` through the mapping | 1 |
| `client_is_company` column + six-place threading | 2 |
| `ClientDraft.isCompany`, create path | 3 |
| Panel relayout, unified `<dl>`, omit-empty rows | 3 |
| Dialog `aria-label` keeps the client name | 3 |
| Legacy null flag renders `Client name:` | 3 |
| 5 i18n keys × 12 | 3 |
| No backfill | none — deliberately not done |

**Type consistency:** `customer_sub_type` is `str` in Pydantic and required `string` in TS; `client_is_company` is `bool | None` in Pydantic and `boolean | null` in TS, `boolean` (never null) on `ClientDraft` since the draft always knows.

**Deliberately out of scope:** project tasks and their four services (sub-project 2, own spec); editing the client from the panel; backfilling the flag for existing projects.
