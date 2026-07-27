# Aito New-Project Modal — Client Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the client half of the Aito "New project" modal so it opens with a default client preselected, exposes editable phone/email that write back to Zoho Books on submit, and can create a brand-new Zoho contact without leaving the modal.

**Architecture:** Three independent backend endpoints (`GET /zoho/status` extended, `POST /zoho/contacts`, `PATCH /zoho/contacts/{id}`) proxy Zoho Books; the frontend orchestrates them so a Zoho failure never blocks project creation. The client input decomposes out of `AitoPage.tsx` into seven focused components plus two pure helper modules. Phone handling is a country-code picker plus a national number, normalized to `+CC-XXXXXXXX`, synced only when the user actually edited the field. Email and phone are format-checked on both sides, with a one-line inline error that appears on blur and then updates live.

**Tech Stack:** FastAPI + SQLAlchemy + Pydantic (backend), pytest with `httpx.MockTransport`; React 19 + TanStack Query + Tailwind 4 (frontend), Vitest + Testing Library + MSW.

**Spec:** `docs/superpowers/specs/2026-07-26-aito-client-input-design.md`

## Global Constraints

- Python line length 120; Ruff rules `E, W, F, I, B, C4, UP, ARG, SIM`; double quotes; target Python 3.10 (no `datetime.UTC`).
- Use `./venv/bin/python3` for every Python command. `ruff` is on PATH.
- TypeScript strict mode, no unused locals or parameters, ES2022, `@/` → `frontend/src/`.
- All test scripts run **from the project root**: `./test_frontend.sh`, `./test_backend.sh`.
- `cd frontend && npm run build` catches import/resolution errors that `tsc --noEmit` does not — run it before declaring frontend work done.
- Database schema changes are additive `ALTER TABLE` statements inside `run_migrations()` in `backend/app/core/database.py`, wrapped in `_safe_execute` for idempotency. There is no migration framework.
- Every new user-facing string needs a key in **all 12 locale files** under `frontend/src/i18n/locales/`: `en, de, es, fr, it, ja, ko, pt-BR, ru, tr, zh-CN, zh-TW`. `frontend/src/__tests__/i18n/locales.test.ts` enforces exact key parity between `en` and `de, fr, it, ja, pt-BR, zh-CN`. English text left in a non-English locale is not acceptable.
- The default Zoho contact is **`66407000001237340` / `Client de passage`**. It is a shared walk-in record with live transaction history — it must never receive a phone or email write.
- Both new Zoho endpoints reuse `Permission.AITO_CREATE`. Do **not** introduce a new permission.
- Phone house format for values this feature writes: `+CC-XXXXXXXX` — country code, a single hyphen, then digits with all separators stripped and **leading zeros preserved**.
- Validation rules, identical on both sides: email `/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/`, country code `/^\+\d{1,4}$/`, national number 4–14 digits. **Empty always passes** — both fields are optional. Errors surface as one inline line under the field, visible only after the field has been blurred once, then live.
- Commit after every task.

---

## Codebase baseline

This plan was verified against `f7ef73cb2` (2026-07-26). Since it was first
written, the board card components were extracted out of `AitoPage.tsx`, pure
board helpers moved to `utils/aitoBoard.ts`, a `PATCH /aito/{id}` content-edit
endpoint landed, and a card-to-panel view-transition hook was added. What that
means for the tasks below:

| Area | Status |
|---|---|
| `backend/app/services/zoho.py`, `routes/zoho.py`, `schemas/settings.py` | Untouched — Tasks 1–4 apply as written |
| `PATCH /aito/{id}` + `AitoProjectUpdate` | **New.** Task 5 threads `client_email` through it |
| `AitoPage.tsx` | 580 lines; `NewProjectModal`, `createMutation` and `createProject` are structurally unchanged |
| `SelectedClient` | Still referenced only by `ClientCombobox.tsx` and `AitoPage.tsx` — Task 9 can delete it |
| `AitoPage.test.tsx` | Has no new-project-modal coverage, so Task 12's extraction breaks nothing there |
| `aito.*` i18n block | Gained `noClient`; no collision with the 22 keys in Task 6 |
| `SearchableSelect`, `formStyles`, `Button`, test `render` wrapper | Unchanged |
| `useCardMorph` / view transitions | Independent of everything here |

## File Structure

**Backend — create:** none.

**Backend — modify:**

| File | Change |
|---|---|
| `backend/app/services/zoho.py` | `_request()` helper, `get_default_contact`, `create_contact`, `update_contact_person`, `normalize_display_name`, `ZohoRequestRejected` |
| `backend/app/api/routes/zoho.py` | `ZohoStatus` gains two fields; new `POST /contacts` and `PATCH /contacts/{id}` |
| `backend/app/schemas/settings.py` | Two `zoho_default_contact_*` fields on `AppSettings` and `AppSettingsUpdate` |
| `backend/app/models/aito_project.py` | `client_email` column |
| `backend/app/schemas/aito.py` | `client_email` on create + response DTOs |
| `backend/app/api/routes/aito.py` | `client_email` in `_to_response` and `create_project` |
| `backend/app/core/database.py` | One `ALTER TABLE` in `run_migrations()` |
| `backend/tests/unit/services/test_zoho_service.py` | New service tests |
| `backend/tests/unit/test_zoho_routes.py` | New route tests; **update `test_status_unconfigured`** |
| `backend/tests/unit/test_aito_routes.py` | `client_email` persistence |

**Frontend — create:**

| File | Responsibility |
|---|---|
| `frontend/src/utils/countryCodes.ts` | `CountryCode[]` + `DEFAULT_COUNTRY_CODE` |
| `frontend/src/utils/clientDraft.ts` | `ClientDraft` type + pure helpers (parse/format phone, name casing, validators, draft builders) |
| `frontend/src/components/aito/PhoneInput.tsx` | Country-code select + national number input |
| `frontend/src/components/aito/NewContactForm.tsx` | Create-contact sub-step |
| `frontend/src/components/aito/FieldError.tsx` | One-line inline validation error under a field |
| `frontend/src/components/aito/ClientSection.tsx` | Owns one `ClientDraft`; client + phone + email rows and resets |
| `frontend/src/components/aito/NewProjectModal.tsx` | Two-view modal shell + submit orchestration (moved out of `AitoPage.tsx`) |
| `frontend/src/__tests__/utils/clientDraft.test.ts` | Pure-helper tests |
| `frontend/src/__tests__/components/ClientSection.test.tsx` | Client section behaviour |
| `frontend/src/__tests__/components/NewContactForm.test.tsx` | Create sub-step behaviour |

**Frontend — modify:**

| File | Change |
|---|---|
| `frontend/src/components/aito/ClientCombobox.tsx` | Rewritten as an editable combobox with a create footer |
| `frontend/src/pages/AitoPage.tsx` | Remove `NewProjectModal`; new mutation variables + Zoho sync on success |
| `frontend/src/api/client.ts` | `ZohoStatus` fields, `AitoProject.client_email`, `createZohoContact`, `updateZohoContact` |
| `frontend/src/components/ZohoSettings.tsx` | Two default-contact fields |
| `frontend/src/i18n/locales/*.ts` (12 files) | New keys |
| `frontend/src/__tests__/components/ClientCombobox.test.tsx` | Rewritten for the new props |

---

### Task 1: Extract `ZohoService._request()`

`search_contacts` hand-rolls token acquisition, the 401-retry-once loop, non-JSON handling and error mapping. Three callers will need all of it. This task is a pure refactor — the existing tests must stay green without modification.

**Files:**
- Modify: `backend/app/services/zoho.py`
- Test: `backend/tests/unit/services/test_zoho_service.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class ZohoRequestRejected(ZohoUpstreamError)` — raised on HTTP 400; `str(e)` is Zoho's own user-facing message.
  - `async ZohoService._request(self, db: AsyncSession, method: str, path: str, *, params: dict | None = None, json: dict | None = None) -> dict` — `path` is relative to `/books/v3` (e.g. `"/contacts"`); `organization_id` is injected automatically; returns the parsed JSON body.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/unit/services/test_zoho_service.py`:

```python
@pytest.mark.asyncio
async def test_request_injects_org_and_retries_401_once(async_client, db_session):
    await _configure(async_client)
    calls = {"token": 0, "api": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            calls["token"] += 1
            return httpx.Response(200, json={"access_token": f"at-{calls['token']}", "expires_in": 3600})
        calls["api"] += 1
        assert request.url.path == "/books/v3/contacts/z1"
        assert request.url.params["organization_id"] == "999"
        assert request.headers["Authorization"] == f"Zoho-oauthtoken at-{calls['token']}"
        if calls["api"] == 1:
            return httpx.Response(401, json={"code": 57, "message": "expired"})
        return httpx.Response(200, json={"contact": {"contact_id": "z1"}})

    zoho_service.transport = _transport(handler)
    body = await zoho_service._request(db_session, "GET", "/contacts/z1")
    assert body["contact"]["contact_id"] == "z1"
    assert calls["api"] == 2
    assert calls["token"] == 2


@pytest.mark.asyncio
async def test_request_400_raises_rejected_with_zoho_message(async_client, db_session):
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return httpx.Response(400, json={"code": 1002, "message": "Contact name already exists."})

    zoho_service.transport = _transport(handler)
    with pytest.raises(ZohoRequestRejected) as exc:
        await zoho_service._request(db_session, "POST", "/contacts", json={"contact_name": "ACME"})
    assert "already exists" in str(exc.value)


@pytest.mark.asyncio
async def test_request_500_raises_upstream_error(async_client, db_session):
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return httpx.Response(500, text="boom")

    zoho_service.transport = _transport(handler)
    with pytest.raises(ZohoUpstreamError):
        await zoho_service._request(db_session, "GET", "/contacts")
```

Add `ZohoRequestRejected` to the import at the top of the file:

```python
from backend.app.services.zoho import (
    ZohoNotConfiguredError,
    ZohoRequestRejected,
    ZohoUpstreamError,
    zoho_service,
)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/services/test_zoho_service.py -v`
Expected: FAIL — `ImportError: cannot import name 'ZohoRequestRejected'`

- [ ] **Step 3: Add the exception and the `_request` helper**

In `backend/app/services/zoho.py`, after `ZohoUpstreamError`:

```python
class ZohoRequestRejected(ZohoUpstreamError):
    """Zoho rejected the payload (HTTP 400). The message is user-actionable."""
```

Then add the method to `ZohoService`, above `search_contacts`:

```python
    async def _request(
        self,
        db: AsyncSession,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        json: dict | None = None,
    ) -> dict:
        """One Books API call: token, org scoping, 401-retry-once, error mapping.

        ``path`` is relative to ``/books/v3`` (e.g. ``"/contacts/z1"``).
        """
        config = await self._load_config(db)
        request_params = {"organization_id": config["zoho_organization_id"], **(params or {})}
        for attempt in (1, 2):
            token = await self.get_access_token(db)
            try:
                async with self._client() as client:
                    response = await client.request(
                        method,
                        f"{config['zoho_base_url']}/books/v3{path}",
                        params=request_params,
                        json=json,
                        headers={"Authorization": f"Zoho-oauthtoken {token}"},
                    )
            except httpx.HTTPError as e:
                raise ZohoUpstreamError(f"Zoho Books unreachable: {e.__class__.__name__}") from e
            if response.status_code == 401 and attempt == 1:
                self.invalidate_token()  # token revoked/expired early — refresh once
                continue
            try:
                payload = response.json() if response.content else {}
            except ValueError as e:
                raise ZohoUpstreamError(f"Zoho returned a non-JSON response (HTTP {response.status_code})") from e
            if response.status_code == 400:
                raise ZohoRequestRejected(payload.get("message") or "Zoho rejected the request")
            if response.status_code >= 400:
                raise ZohoUpstreamError(f"Zoho Books error (HTTP {response.status_code})")
            return payload
        raise ZohoUpstreamError("Zoho Books rejected the refreshed token")  # unreachable guard
```

- [ ] **Step 4: Rewrite `search_contacts` on top of `_request`**

Replace the whole body of `search_contacts` with:

```python
    async def search_contacts(self, db: AsyncSession, query: str) -> list[dict]:
        payload = await self._request(db, "GET", "/contacts", params={"search_text": query})
        return [_map_contact(c) for c in payload.get("contacts", [])]
```

And add a module-level mapper above the class (it will be reused by `create_contact`):

```python
def _map_contact(contact: dict) -> dict:
    """Zoho contact -> the flat shape the Aito client picker consumes."""
    return {
        "id": contact.get("contact_id", ""),
        "name": contact.get("contact_name", ""),
        "company_name": contact.get("company_name", ""),
        "phone": contact.get("phone", ""),
        "mobile": contact.get("mobile", ""),
        "email": contact.get("email", ""),
    }
```

- [ ] **Step 5: Run the full Zoho test suite**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/services/test_zoho_service.py backend/tests/unit/test_zoho_routes.py -v`
Expected: PASS — including the pre-existing `test_search_contacts_maps_fields_and_retries_401_once`, unmodified.

- [ ] **Step 6: Lint and commit**

```bash
ruff check backend/ && ruff format --check backend/
git add backend/app/services/zoho.py backend/tests/unit/services/test_zoho_service.py
git commit -m "refactor(zoho): extract shared _request helper with 401 retry and 400 mapping"
```

---

### Task 2: Default contact — settings, status endpoint, settings UI

**Files:**
- Modify: `backend/app/services/zoho.py`, `backend/app/api/routes/zoho.py`, `backend/app/schemas/settings.py`
- Modify: `frontend/src/api/client.ts`, `frontend/src/components/ZohoSettings.tsx`, all 12 files in `frontend/src/i18n/locales/`
- Test: `backend/tests/unit/test_zoho_routes.py`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `DEFAULT_CONTACT_ID_FALLBACK = "66407000001237340"` and `DEFAULT_CONTACT_NAME_FALLBACK = "Client de passage"` in `backend/app/services/zoho.py`.
  - `async ZohoService.get_default_contact(self, db: AsyncSession) -> tuple[str, str]` → `(id, name)`.
  - TS `ZohoStatus` gains `default_contact_id: string` and `default_contact_name: string`.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/unit/test_zoho_routes.py`, **replace** the existing `test_status_unconfigured` (its exact-dict assertion is now wrong) and add two more:

```python
@pytest.mark.asyncio
async def test_status_unconfigured_still_returns_default_contact(async_client):
    r = await async_client.get("/api/v1/zoho/status")
    assert r.status_code == 200
    assert r.json() == {
        "configured": False,
        "reachable": False,
        "default_contact_id": "66407000001237340",
        "default_contact_name": "Client de passage",
    }


@pytest.mark.asyncio
async def test_status_uses_configured_default_contact(async_client):
    await async_client.put(
        "/api/v1/settings/",
        json={"zoho_default_contact_id": "abc123", "zoho_default_contact_name": "Walk-in"},
    )
    body = (await async_client.get("/api/v1/zoho/status")).json()
    assert body["default_contact_id"] == "abc123"
    assert body["default_contact_name"] == "Walk-in"
```

Also update the existing `test_status_configured_reachable` — its exact-dict assertion needs the two new keys:

```python
@pytest.mark.asyncio
async def test_status_configured_reachable(async_client):
    await _configure(async_client)
    zoho_service.transport = httpx.MockTransport(
        lambda request: httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
    )
    assert (await async_client.get("/api/v1/zoho/status")).json() == {
        "configured": True,
        "reachable": True,
        "default_contact_id": "66407000001237340",
        "default_contact_name": "Client de passage",
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_zoho_routes.py -v -k status`
Expected: FAIL — responses lack `default_contact_id`.

- [ ] **Step 3: Add the settings fields**

In `backend/app/schemas/settings.py`, after the `zoho_accounts_url` line in `AppSettings` (around line 468):

```python
    zoho_default_contact_id: str = Field(
        default="66407000001237340", description="Zoho contact used as the default Aito client"
    )
    zoho_default_contact_name: str = Field(
        default="Client de passage", description="Display name of the default Aito client"
    )
```

And after `zoho_accounts_url` in `AppSettingsUpdate` (around line 633):

```python
    zoho_default_contact_id: str | None = None
    zoho_default_contact_name: str | None = None
```

- [ ] **Step 4: Add the service accessor**

In `backend/app/services/zoho.py`, at module level next to `_REQUIRED_KEYS`:

```python
DEFAULT_CONTACT_ID_FALLBACK = "66407000001237340"
DEFAULT_CONTACT_NAME_FALLBACK = "Client de passage"
```

And on `ZohoService`:

```python
    async def get_default_contact(self, db: AsyncSession) -> tuple[str, str]:
        """The contact preselected in the Aito modal. Read from settings, never
        from Zoho — the modal must open even when Books is unreachable."""
        from backend.app.api.routes.settings import get_setting

        contact_id = await get_setting(db, "zoho_default_contact_id")
        name = await get_setting(db, "zoho_default_contact_name")
        return (contact_id or DEFAULT_CONTACT_ID_FALLBACK, name or DEFAULT_CONTACT_NAME_FALLBACK)
```

- [ ] **Step 5: Extend the status route**

In `backend/app/api/routes/zoho.py`, change `ZohoStatus` and the route body:

```python
class ZohoStatus(BaseModel):
    configured: bool
    reachable: bool
    default_contact_id: str
    default_contact_name: str
```

```python
@router.get("/status", response_model=ZohoStatus)
async def zoho_status(
    db: AsyncSession = Depends(get_db),
    # Any-of: the Aito create modal (aito:create) AND the settings Test button
    # (settings:read) both need this endpoint.
    _: User | None = RequireAnyPermissionIfAuthEnabled(Permission.AITO_CREATE, Permission.SETTINGS_READ),
):
    default_id, default_name = await zoho_service.get_default_contact(db)
    if not await zoho_service.is_configured(db):
        return ZohoStatus(
            configured=False, reachable=False,
            default_contact_id=default_id, default_contact_name=default_name,
        )
    try:
        await zoho_service.get_access_token(db)
        reachable = True
        configured = True
    except ZohoNotConfiguredError:
        # Settings were cleared between the is_configured() check above and here.
        configured, reachable = False, False
    except ZohoUpstreamError as e:
        logger.warning("Zoho unreachable: %s", e)
        configured, reachable = True, False
    return ZohoStatus(
        configured=configured, reachable=reachable,
        default_contact_id=default_id, default_contact_name=default_name,
    )
```

- [ ] **Step 6: Run the backend tests**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_zoho_routes.py backend/tests/unit/test_zoho_settings.py -v`
Expected: PASS

- [ ] **Step 7: Update the TypeScript type**

In `frontend/src/api/client.ts`, extend `ZohoStatus` (around line 3442):

```ts
export interface ZohoStatus {
  configured: boolean;
  reachable: boolean;
  default_contact_id: string;
  default_contact_name: string;
}
```

And add the two settings keys to the `AppSettings` interface, after `zoho_accounts_url` (around line 1337):

```ts
  zoho_default_contact_id: string;
  zoho_default_contact_name: string;
```

- [ ] **Step 8: Add the i18n keys for the settings UI**

Add to the `zoho` block of **all 12** locale files. English:

```ts
    defaultContactId: 'Default client ID',
    defaultContactName: 'Default client name',
    defaultContactHint: 'Preselected in the Aito new-project modal. Phone and email are never written to this contact.',
```

French:

```ts
    defaultContactId: 'ID du client par défaut',
    defaultContactName: 'Nom du client par défaut',
    defaultContactHint: 'Présélectionné dans la fenêtre de nouveau projet Aito. Le téléphone et l’e-mail ne sont jamais écrits sur ce contact.',
```

Translate the same three strings into `de, es, it, ja, ko, pt-BR, ru, tr, zh-CN, zh-TW`. Do not leave English text in a non-English file.

- [ ] **Step 9: Add the two inputs to `ZohoSettings.tsx`**

Follow the existing `organizationId` field exactly (state hook, `useEffect` hydration, dirty check in the save payload, `<label className="block text-sm text-bambu-gray mb-1">`, `className={inputCls}`). Add:

```tsx
const [defaultContactId, setDefaultContactId] = useState('');
const [defaultContactName, setDefaultContactName] = useState('');
```

hydrate in the existing `useEffect`:

```tsx
setDefaultContactId(settings.zoho_default_contact_id ?? '');
setDefaultContactName(settings.zoho_default_contact_name ?? '');
```

add to the save payload alongside the other dirty checks:

```tsx
if (defaultContactId !== (settings?.zoho_default_contact_id ?? '')) payload.zoho_default_contact_id = defaultContactId;
if (defaultContactName !== (settings?.zoho_default_contact_name ?? '')) payload.zoho_default_contact_name = defaultContactName;
```

and render two text inputs labelled `t('zoho.defaultContactId')` / `t('zoho.defaultContactName')` after the organization-id field, followed by a `<p className="text-sm text-bambu-gray">{t('zoho.defaultContactHint')}</p>`.

- [ ] **Step 10: Run the frontend suite**

Run: `./test_frontend.sh`
Expected: PASS, including `i18n/locales.test.ts`.

- [ ] **Step 11: Commit**

```bash
git add backend/app frontend/src backend/tests
git commit -m "feat(zoho): configurable default Aito contact surfaced on /zoho/status"
```

---

### Task 3: `POST /zoho/contacts`

Creates a Zoho contact. The display name is **derived server-side** from the parts, never trusted from the client.

**Files:**
- Modify: `backend/app/services/zoho.py`, `backend/app/api/routes/zoho.py`, `frontend/src/api/client.ts`
- Test: `backend/tests/unit/services/test_zoho_service.py`, `backend/tests/unit/test_zoho_routes.py`

**Interfaces:**
- Consumes: `ZohoService._request`, `ZohoRequestRejected`, `_map_contact` (Task 1).
- Produces:
  - `def normalize_display_name(first_name: str, last_name: str) -> str` in `backend/app/services/zoho.py`.
  - `async ZohoService.create_contact(self, db, *, company_name: str, first_name: str, last_name: str, email: str, phone: str) -> dict` → the `_map_contact` shape.
  - TS `api.createZohoContact(data) => Promise<ZohoContact>`.

- [ ] **Step 1: Write the failing service tests**

Append to `backend/tests/unit/services/test_zoho_service.py`:

```python
def test_normalize_display_name_title_cases_and_uppercases():
    from backend.app.services.zoho import normalize_display_name

    assert normalize_display_name("jean-pierre", "de la tour") == "Jean-Pierre DE LA TOUR"
    assert normalize_display_name("élodie", "teïva-marü") == "Élodie TEÏVA-MARÜ"
    assert normalize_display_name("MARIE anne", "Dupont") == "Marie Anne DUPONT"
    assert normalize_display_name("  paul  ", " theis ") == "Paul THEIS"


@pytest.mark.asyncio
async def test_create_contact_person_path(async_client, db_session):
    await _configure(async_client)
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        seen["body"] = __import__("json").loads(request.content)
        return httpx.Response(201, json={"contact": {
            "contact_id": "new1", "contact_name": "Jean-Pierre DUPONT",
            "company_name": "", "phone": "", "mobile": "+689-87123456", "email": "jp@example.pf",
        }})

    zoho_service.transport = _transport(handler)
    result = await zoho_service.create_contact(
        db_session, company_name="", first_name="jean-pierre", last_name="dupont",
        email="jp@example.pf", phone="+689-87123456",
    )
    assert result == {
        "id": "new1", "name": "Jean-Pierre DUPONT", "company_name": "",
        "phone": "", "mobile": "+689-87123456", "email": "jp@example.pf",
    }
    assert seen["body"]["contact_name"] == "Jean-Pierre DUPONT"
    assert seen["body"]["contact_type"] == "customer"
    assert seen["body"]["customer_sub_type"] == "individual"
    assert "company_name" not in seen["body"]
    assert seen["body"]["contact_persons"] == [{
        "first_name": "Jean-Pierre", "last_name": "DUPONT",
        "email": "jp@example.pf", "mobile": "+689-87123456", "is_primary_contact": True,
    }]


@pytest.mark.asyncio
async def test_create_contact_company_path_without_person(async_client, db_session):
    await _configure(async_client)
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        seen["body"] = __import__("json").loads(request.content)
        return httpx.Response(201, json={"contact": {"contact_id": "c1", "contact_name": "ACME SARL"}})

    zoho_service.transport = _transport(handler)
    await zoho_service.create_contact(
        db_session, company_name="ACME SARL", first_name="", last_name="", email="", phone=""
    )
    assert seen["body"]["contact_name"] == "ACME SARL"
    assert seen["body"]["company_name"] == "ACME SARL"
    assert seen["body"]["customer_sub_type"] == "business"
    assert "contact_persons" not in seen["body"]  # nothing to put in it
```

- [ ] **Step 2: Run to verify failure**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/services/test_zoho_service.py -v -k "normalize or create_contact"`
Expected: FAIL — `cannot import name 'normalize_display_name'`

- [ ] **Step 3: Implement the name helper and `create_contact`**

Add at module level in `backend/app/services/zoho.py`:

```python
def _title_case_segments(value: str) -> str:
    """Capitalize every space- or hyphen-separated segment: 'jean-pierre' -> 'Jean-Pierre'."""
    result = []
    for index, part in enumerate(re.split(r"([ \-]+)", value.strip())):
        result.append(part if index % 2 else part[:1].upper() + part[1:].lower())
    return "".join(result)


def normalize_display_name(first_name: str, last_name: str) -> str:
    """House convention for person contacts: 'Jean-Pierre DUPONT'."""
    return f"{_title_case_segments(first_name)} {last_name.strip().upper()}".strip()
```

Add `import re` to the imports.

Then on `ZohoService`:

```python
    async def create_contact(
        self,
        db: AsyncSession,
        *,
        company_name: str,
        first_name: str,
        last_name: str,
        email: str,
        phone: str,
    ) -> dict:
        """Create a Books customer. Currency/language are omitted so the org
        defaults apply. Phone lands on the primary contact person's ``mobile``
        because the contact-level fields are read-only mirrors of it."""
        company = company_name.strip()
        if company:
            contact_name, sub_type = company, "business"
            person_first, person_last = "", ""
        else:
            contact_name = normalize_display_name(first_name, last_name)
            sub_type = "individual"
            person_first = _title_case_segments(first_name)
            person_last = last_name.strip().upper()

        payload: dict = {
            "contact_name": contact_name,
            "contact_type": "customer",
            "customer_sub_type": sub_type,
        }
        if company:
            payload["company_name"] = company

        person = {}
        if person_first:
            person["first_name"] = person_first
        if person_last:
            person["last_name"] = person_last
        if email.strip():
            person["email"] = email.strip()
        if phone.strip():
            person["mobile"] = phone.strip()
        if person:
            payload["contact_persons"] = [{**person, "is_primary_contact": True}]

        body = await self._request(db, "POST", "/contacts", json=payload)
        return _map_contact(body.get("contact", {}))
```

- [ ] **Step 4: Run the service tests**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/services/test_zoho_service.py -v`
Expected: PASS

- [ ] **Step 5: Write the failing route tests**

Append to `backend/tests/unit/test_zoho_routes.py`:

```python
def _token_then(handler):
    def wrapped(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return handler(request)

    return httpx.MockTransport(wrapped)


@pytest.mark.asyncio
async def test_create_contact_returns_mapped_contact(async_client):
    await _configure(async_client)
    zoho_service.transport = _token_then(
        lambda request: httpx.Response(201, json={"contact": {
            "contact_id": "n1", "contact_name": "ACME SARL", "company_name": "ACME SARL",
            "phone": "", "mobile": "", "email": "",
        }})
    )
    r = await async_client.post("/api/v1/zoho/contacts", json={"company_name": "ACME SARL"})
    assert r.status_code == 201
    assert r.json()["id"] == "n1"
    assert r.json()["name"] == "ACME SARL"


@pytest.mark.asyncio
async def test_create_contact_requires_a_name(async_client):
    await _configure(async_client)
    r = await async_client.post("/api/v1/zoho/contacts", json={"first_name": "Paul"})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_create_contact_rejects_malformed_email(async_client):
    await _configure(async_client)
    r = await async_client.post(
        "/api/v1/zoho/contacts", json={"company_name": "ACME SARL", "email": "nope"}
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_create_contact_rejects_malformed_phone(async_client):
    await _configure(async_client)
    r = await async_client.post(
        "/api/v1/zoho/contacts", json={"company_name": "ACME SARL", "phone": "87123456"}
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_create_contact_accepts_house_format_phone(async_client):
    await _configure(async_client)
    zoho_service.transport = _token_then(
        lambda request: httpx.Response(201, json={"contact": {"contact_id": "n2", "contact_name": "ACME SARL"}})
    )
    r = await async_client.post(
        "/api/v1/zoho/contacts", json={"company_name": "ACME SARL", "phone": "+689-87123456"}
    )
    assert r.status_code == 201


@pytest.mark.asyncio
async def test_create_contact_duplicate_maps_to_409_with_message(async_client):
    await _configure(async_client)
    zoho_service.transport = _token_then(
        lambda request: httpx.Response(400, json={"code": 1002, "message": "Contact name already exists."})
    )
    r = await async_client.post("/api/v1/zoho/contacts", json={"company_name": "ACME SARL"})
    assert r.status_code == 409
    assert "already exists" in r.json()["detail"]


@pytest.mark.asyncio
async def test_create_contact_upstream_error_maps_to_502(async_client):
    await _configure(async_client)
    zoho_service.transport = _token_then(lambda request: httpx.Response(500, text="boom"))
    assert (await async_client.post("/api/v1/zoho/contacts", json={"company_name": "X"})).status_code == 502
```

- [ ] **Step 6: Run to verify failure**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_zoho_routes.py -v -k create_contact`
Expected: FAIL — 405 Method Not Allowed.

- [ ] **Step 7: Add the route**

In `backend/app/api/routes/zoho.py`, add the import of `ZohoRequestRejected` to the existing service import, then:

```python
# Mirrors the frontend rules in utils/clientDraft.ts. These endpoints are
# reachable independently of the modal, so the client checks cannot be the only
# gate. Both fields are optional — only a non-empty malformed value is rejected.
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")
_PHONE_RE = re.compile(r"^\+\d{1,4}-\d{4,14}$")


def _check_email(value: str) -> str:
    if value.strip() and not _EMAIL_RE.match(value.strip()):
        raise ValueError("Enter a valid email address")
    return value


def _check_phone(value: str) -> str:
    if value.strip() and not _PHONE_RE.match(value.strip()):
        raise ValueError("Phone must look like +689-87123456")
    return value


class ZohoContactCreate(BaseModel):
    """Either ``company_name`` or both name parts must be present — the display
    name is derived from them server-side, never taken from the client."""

    company_name: str = Field(default="", max_length=200)
    first_name: str = Field(default="", max_length=100)
    last_name: str = Field(default="", max_length=100)
    email: str = Field(default="", max_length=200)
    phone: str = Field(default="", max_length=50)

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        return _check_email(value)

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, value: str) -> str:
        return _check_phone(value)

    @model_validator(mode="after")
    def check_name(self):
        if not self.company_name.strip() and not (self.first_name.strip() and self.last_name.strip()):
            raise ValueError("Provide a company name, or both a first and last name")
        return self


@router.post("/contacts", response_model=ZohoContact, status_code=201)
async def create_contact(
    payload: ZohoContactCreate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE),
):
    try:
        return await zoho_service.create_contact(
            db,
            company_name=payload.company_name,
            first_name=payload.first_name,
            last_name=payload.last_name,
            email=payload.email,
            phone=payload.phone,
        )
    except ZohoNotConfiguredError:
        raise HTTPException(status_code=409, detail="Zoho is not configured") from None
    except ZohoRequestRejected as e:
        # Zoho's own validation message (duplicate name, bad email, …) — actionable inline.
        raise HTTPException(status_code=409, detail=str(e)) from e
    except ZohoUpstreamError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
```

Add `import re` at the top of the file, and widen the pydantic import to
`from pydantic import BaseModel, Field, field_validator, model_validator`.

- [ ] **Step 8: Run the backend tests**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_zoho_routes.py -v`
Expected: PASS

- [ ] **Step 9: Add the API client method**

In `frontend/src/api/client.ts`, after `searchZohoContacts`:

```ts
  createZohoContact: (data: {
    company_name?: string;
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
  }) =>
    request<ZohoContact>('/zoho/contacts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
```

- [ ] **Step 10: Lint and commit**

```bash
ruff check backend/ && ruff format --check backend/ && cd frontend && npx tsc --noEmit && cd ..
git add backend frontend/src/api/client.ts
git commit -m "feat(zoho): POST /zoho/contacts with server-side display-name casing"
```

---

### Task 4: `PATCH /zoho/contacts/{id}`

Writes phone/email through the **primary contact person**, and refuses the default contact outright.

**Files:**
- Modify: `backend/app/services/zoho.py`, `backend/app/api/routes/zoho.py`, `frontend/src/api/client.ts`
- Test: `backend/tests/unit/services/test_zoho_service.py`, `backend/tests/unit/test_zoho_routes.py`

**Interfaces:**
- Consumes: `ZohoService._request` (Task 1), `ZohoService.get_default_contact` (Task 2).
- Produces:
  - `async ZohoService.update_contact_person(self, db, contact_id: str, *, email: str | None, phone: str | None, phone_field: str) -> None`
  - TS `api.updateZohoContact(id, data) => Promise<void>`.

- [ ] **Step 1: Write the failing service tests**

Append to `backend/tests/unit/services/test_zoho_service.py`:

```python
@pytest.mark.asyncio
async def test_update_contact_person_puts_to_existing_primary(async_client, db_session):
    await _configure(async_client)
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        if request.method == "GET":
            return httpx.Response(200, json={"contact": {
                "contact_id": "z1", "first_name": "Michael", "last_name": "Girard",
                "contact_persons": [
                    {"contact_person_id": "cp0", "is_primary_contact": False},
                    {"contact_person_id": "cp1", "is_primary_contact": True},
                ],
            }})
        seen["method"] = request.method
        seen["path"] = request.url.path
        seen["body"] = __import__("json").loads(request.content)
        return httpx.Response(200, json={"contact_person": {}})

    zoho_service.transport = _transport(handler)
    await zoho_service.update_contact_person(
        db_session, "z1", email="new@example.pf", phone="+689-87123456", phone_field="mobile"
    )
    assert seen["method"] == "PUT"
    assert seen["path"] == "/books/v3/contacts/contactpersons/cp1"
    assert seen["body"] == {"email": "new@example.pf", "mobile": "+689-87123456"}


@pytest.mark.asyncio
async def test_update_contact_person_creates_one_when_none_exists(async_client, db_session):
    await _configure(async_client)
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        if request.method == "GET":
            return httpx.Response(200, json={"contact": {
                "contact_id": "z9", "first_name": "", "last_name": "", "contact_persons": [],
            }})
        seen["method"] = request.method
        seen["path"] = request.url.path
        seen["body"] = __import__("json").loads(request.content)
        return httpx.Response(201, json={"contact_person": {}})

    zoho_service.transport = _transport(handler)
    await zoho_service.update_contact_person(
        db_session, "z9", email=None, phone="+689-40123456", phone_field="phone"
    )
    assert seen["method"] == "POST"
    assert seen["path"] == "/books/v3/contacts/contactpersons"
    assert seen["body"] == {
        "contact_id": "z9", "first_name": "", "last_name": "",
        "is_primary_contact": True, "phone": "+689-40123456",
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/services/test_zoho_service.py -v -k update_contact_person`
Expected: FAIL — `'ZohoService' object has no attribute 'update_contact_person'`

- [ ] **Step 3: Implement `update_contact_person`**

On `ZohoService`:

```python
    async def update_contact_person(
        self,
        db: AsyncSession,
        contact_id: str,
        *,
        email: str | None,
        phone: str | None,
        phone_field: str,
    ) -> None:
        """Write email/phone to the contact's primary person.

        The contact-level ``email``/``phone``/``mobile`` fields are read-only
        mirrors of the primary contact person, so writes must target the person.
        A contact with no persons at all gets one created.
        """
        contact = (await self._request(db, "GET", f"/contacts/{contact_id}")).get("contact", {})
        persons = contact.get("contact_persons") or []
        primary = next((p for p in persons if p.get("is_primary_contact")), persons[0] if persons else None)

        fields: dict = {}
        if email is not None:
            fields["email"] = email
        if phone is not None:
            fields[phone_field] = phone
        if not fields:
            return

        if primary:
            await self._request(
                db, "PUT", f"/contacts/contactpersons/{primary['contact_person_id']}", json=fields
            )
        else:
            await self._request(
                db,
                "POST",
                "/contacts/contactpersons",
                json={
                    "contact_id": contact_id,
                    "first_name": contact.get("first_name", ""),
                    "last_name": contact.get("last_name", ""),
                    "is_primary_contact": True,
                    **fields,
                },
            )
```

- [ ] **Step 4: Run the service tests**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/services/test_zoho_service.py -v`
Expected: PASS

- [ ] **Step 5: Write the failing route tests**

Append to `backend/tests/unit/test_zoho_routes.py`:

```python
@pytest.mark.asyncio
async def test_patch_contact_refuses_the_default_contact(async_client):
    await _configure(async_client)
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})

    zoho_service.transport = httpx.MockTransport(handler)
    r = await async_client.patch(
        "/api/v1/zoho/contacts/66407000001237340",
        json={"phone": "+689-87123456", "phone_field": "mobile"},
    )
    assert r.status_code == 400
    assert calls["n"] == 0  # never reaches Zoho


@pytest.mark.asyncio
async def test_patch_contact_updates_primary_person(async_client):
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json={"contact": {
                "contact_id": "z1", "first_name": "M", "last_name": "G",
                "contact_persons": [{"contact_person_id": "cp1", "is_primary_contact": True}],
            }})
        return httpx.Response(200, json={"contact_person": {}})

    zoho_service.transport = _token_then(handler)
    r = await async_client.patch(
        "/api/v1/zoho/contacts/z1", json={"email": "x@y.pf", "phone_field": "mobile"}
    )
    assert r.status_code == 204


@pytest.mark.asyncio
async def test_patch_contact_rejects_malformed_values(async_client):
    await _configure(async_client)
    assert (await async_client.patch("/api/v1/zoho/contacts/z1", json={"email": "nope"})).status_code == 422
    assert (
        await async_client.patch("/api/v1/zoho/contacts/z1", json={"phone": "87123456"})
    ).status_code == 422


@pytest.mark.asyncio
async def test_patch_contact_accepts_empty_string_to_clear(async_client):
    await _configure(async_client)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json={"contact": {
                "contact_id": "z1", "first_name": "M", "last_name": "G",
                "contact_persons": [{"contact_person_id": "cp1", "is_primary_contact": True}],
            }})
        return httpx.Response(200, json={"contact_person": {}})

    zoho_service.transport = _token_then(handler)
    r = await async_client.patch("/api/v1/zoho/contacts/z1", json={"phone": "", "phone_field": "mobile"})
    assert r.status_code == 204


@pytest.mark.asyncio
async def test_patch_contact_upstream_error_maps_to_502(async_client):
    await _configure(async_client)
    zoho_service.transport = _token_then(lambda request: httpx.Response(500, text="boom"))
    r = await async_client.patch("/api/v1/zoho/contacts/z1", json={"email": "x@y.pf"})
    assert r.status_code == 502
```

- [ ] **Step 6: Run to verify failure**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_zoho_routes.py -v -k patch_contact`
Expected: FAIL — 405 Method Not Allowed.

- [ ] **Step 7: Add the route**

In `backend/app/api/routes/zoho.py`:

```python
class ZohoContactPatch(BaseModel):
    """Only the keys present are written. An empty string clears the value, so it
    passes validation; a non-empty malformed value does not."""

    email: str | None = Field(default=None, max_length=200)
    phone: str | None = Field(default=None, max_length=50)
    phone_field: Literal["phone", "mobile"] = "mobile"

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str | None) -> str | None:
        return value if value is None else _check_email(value)

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, value: str | None) -> str | None:
        return value if value is None else _check_phone(value)


@router.patch("/contacts/{contact_id}", status_code=204)
async def patch_contact(
    contact_id: str,
    payload: ZohoContactPatch,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE),
):
    default_id, _name = await zoho_service.get_default_contact(db)
    if contact_id == default_id:
        # The walk-in bucket is shared by every passing customer and carries live
        # transaction history — it must never take one customer's details.
        raise HTTPException(status_code=400, detail="The default client cannot be modified")
    try:
        await zoho_service.update_contact_person(
            db, contact_id, email=payload.email, phone=payload.phone, phone_field=payload.phone_field
        )
    except ZohoNotConfiguredError:
        raise HTTPException(status_code=409, detail="Zoho is not configured") from None
    except ZohoUpstreamError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
```

Add `from typing import Literal` at the top of the file.

- [ ] **Step 8: Run the backend suite**

Run: `./test_backend.sh`
Expected: PASS

- [ ] **Step 9: Add the API client method**

In `frontend/src/api/client.ts`, after `createZohoContact`:

```ts
  updateZohoContact: (
    id: string,
    data: { email?: string; phone?: string; phone_field?: 'phone' | 'mobile' },
  ) =>
    request<void>(`/zoho/contacts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
```

- [ ] **Step 10: Commit**

```bash
git add backend frontend/src/api/client.ts
git commit -m "feat(zoho): PATCH /zoho/contacts writes through the primary contact person"
```

---

### Task 5: `client_email` on Aito projects

**Files:**
- Modify: `backend/app/models/aito_project.py`, `backend/app/schemas/aito.py`, `backend/app/api/routes/aito.py`, `backend/app/core/database.py`, `frontend/src/api/client.ts`
- Test: `backend/tests/unit/test_aito_routes.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `AitoProjectCreate.client_email: str | None`, `AitoProjectUpdate.client_email: str | None`, `AitoProjectResponse.client_email: str | None`, TS `AitoProject.client_email: string | null`, TS `AitoProjectUpdate.client_email?: string | null`, and `api.createAitoProject` accepts `client_email?: string | null`.

> **`PATCH /aito/{id}` landed after this plan was written** (`34f4c4ac7`), and it
> writes the client snapshot from the card detail panel. `client_email` has to be
> threaded through it too, or the panel will silently drop the email on every edit.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/unit/test_aito_routes.py` (match the file's existing fixture style):

```python
@pytest.mark.asyncio
async def test_create_project_persists_client_email(async_client):
    r = await async_client.post(
        "/api/v1/aito/",
        json={
            "description": "Support de caméra",
            "client_id": "z1",
            "client_name": "ACME SARL",
            "client_phone": "+689-87123456",
            "client_email": "hi@acme.pf",
        },
    )
    assert r.status_code == 201
    assert r.json()["client_email"] == "hi@acme.pf"
    listed = (await async_client.get("/api/v1/aito/")).json()
    assert listed[0]["client_email"] == "hi@acme.pf"


@pytest.mark.asyncio
async def test_update_project_writes_and_clears_client_email(async_client):
    project_id = (await _create(async_client)).json()["id"]

    r = await async_client.patch(f"/api/v1/aito/{project_id}", json={"client_email": "hi@acme.pf"})
    assert r.status_code == 200
    assert r.json()["client_email"] == "hi@acme.pf"

    # Explicit null clears it; an omitted key leaves it alone (existing semantics).
    r = await async_client.patch(f"/api/v1/aito/{project_id}", json={"client_email": None})
    assert r.json()["client_email"] is None

    r = await async_client.patch(f"/api/v1/aito/{project_id}", json={"description": "Autre pièce"})
    assert r.json()["client_email"] is None
```

`_create` is the helper already at the top of that file; it posts a valid project
and returns the response.

- [ ] **Step 2: Run to verify failure**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_routes.py -v -k client_email`
Expected: FAIL — `KeyError: 'client_email'`

- [ ] **Step 3: Add the column**

In `backend/app/models/aito_project.py`, after `client_phone`:

```python
    client_email: Mapped[str | None] = mapped_column(String(200), nullable=True)
```

- [ ] **Step 4: Add the migration**

At the end of `run_migrations()` in `backend/app/core/database.py`, after the calculator-filaments block:

```python
    # Migration: Aito cards snapshot the client's email alongside the phone so
    # the walk-in customer's details survive on the card even when they are
    # deliberately not written back to Zoho.
    await _safe_execute(conn, "ALTER TABLE aito_projects ADD COLUMN client_email VARCHAR(200)")
```

- [ ] **Step 5: Thread it through the schemas and route**

`backend/app/schemas/aito.py` — add to `AitoProjectCreate` **and** to
`AitoProjectUpdate`, after `client_phone` in each:

```python
    client_email: str | None = None
```

and to `AitoProjectResponse` after `client_phone`:

```python
    client_email: str | None
```

`backend/app/api/routes/aito.py` — in `_to_response`, after `client_phone=p.client_phone,`:

```python
        client_email=p.client_email,
```

in `create_project`, after `client_phone=payload.client_phone,`:

```python
        client_email=payload.client_email,
```

and in `update_project`, widen the snapshot loop:

```python
    for key in ("client_id", "client_name", "client_phone", "client_email"):
        if key in fields:
            setattr(project, key, fields[key])
```

The merged-snapshot guard above that loop is unchanged — `client_email` is
optional, so there is no consistency rule tying it to `client_id`.

- [ ] **Step 6: Run the backend tests**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_routes.py -v`
Expected: PASS

- [ ] **Step 7: Update the TypeScript types**

In `frontend/src/api/client.ts`, add to `AitoProject` after `client_phone`:

```ts
  client_email: string | null;
```

and to the `AitoProjectUpdate` interface after `client_phone`:

```ts
  client_email?: string | null;
```

and widen `createAitoProject`:

```ts
  createAitoProject: (data: {
    description: string;
    client_id: string;
    client_name: string;
    client_phone?: string | null;
    client_email?: string | null;
  }) =>
    request<AitoProject>('/aito/', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
```

- [ ] **Step 8: Lint and commit**

```bash
ruff check backend/ && ruff format --check backend/ && cd frontend && npx tsc --noEmit && cd ..
git add backend frontend/src/api/client.ts
git commit -m "feat(aito): store the client email snapshot on project cards"
```

---

### Task 6: i18n keys for the client input

Added up front so later component tasks can reference keys without breaking the locale-parity test mid-stream.

**Files:**
- Modify: all 12 files in `frontend/src/i18n/locales/`
- Test: `frontend/src/__tests__/i18n/locales.test.ts` (existing, no changes)

**Interfaces:**
- Consumes: nothing.
- Produces: the 22 `aito.*` keys listed below, available to Tasks 8–12.

- [ ] **Step 1: Add the English keys**

In `frontend/src/i18n/locales/en.ts`, inside the `aito` block, after `zohoUnreachable`:

```ts
    resetToDefaultClient: 'Reset to the default client',
    clientPhone: 'Phone',
    clientEmail: 'Email',
    countryCode: 'Country code',
    phonePlaceholder: '87123456',
    emailPlaceholder: 'client@example.com',
    revertPhone: 'Revert phone',
    revertEmail: 'Revert email',
    createClient: 'Create new client',
    newClientTitle: 'New client',
    companyName: 'Company name',
    firstName: 'First name',
    lastName: 'Last name',
    displayNamePreview: 'Saved as: {{name}}',
    createClientSubmit: 'Create client',
    back: 'Back',
    clientNameRequired: 'Enter a company name, or a first and last name.',
    clientCreateFailed: 'Could not create the client. Please try again.',
    clientSyncFailed: 'Project created — could not update the client in Zoho.',
    invalidEmail: 'Enter a valid email address.',
    invalidPhone: 'Enter between 4 and 14 digits.',
    invalidCountryCode: 'Enter a country code such as +689.',
```

- [ ] **Step 2: Add the French keys**

In `frontend/src/i18n/locales/fr.ts`, same position in the `aito` block:

```ts
    resetToDefaultClient: 'Rétablir le client par défaut',
    clientPhone: 'Téléphone',
    clientEmail: 'E-mail',
    countryCode: 'Indicatif',
    phonePlaceholder: '87123456',
    emailPlaceholder: 'client@exemple.com',
    revertPhone: 'Rétablir le téléphone',
    revertEmail: 'Rétablir l’e-mail',
    createClient: 'Créer un client',
    newClientTitle: 'Nouveau client',
    companyName: 'Nom de la société',
    firstName: 'Prénom',
    lastName: 'Nom',
    displayNamePreview: 'Enregistré sous : {{name}}',
    createClientSubmit: 'Créer le client',
    back: 'Retour',
    clientNameRequired: 'Saisissez un nom de société, ou un prénom et un nom.',
    clientCreateFailed: 'Impossible de créer le client. Veuillez réessayer.',
    clientSyncFailed: 'Projet créé — impossible de mettre à jour le client dans Zoho.',
    invalidEmail: 'Saisissez une adresse e-mail valide.',
    invalidPhone: 'Saisissez entre 4 et 14 chiffres.',
    invalidCountryCode: 'Saisissez un indicatif, par exemple +689.',
```

- [ ] **Step 3: Translate into the remaining 10 locales**

Add the same 22 keys, in the same position inside each `aito` block, to `de.ts, es.ts, it.ts, ja.ts, ko.ts, pt-BR.ts, ru.ts, tr.ts, zh-CN.ts, zh-TW.ts`. Translate every value into that language — English text left in a non-English file is a defect, even in the five locales the parity test does not gate. Keep `{{name}}` intact in `displayNamePreview` and leave `phonePlaceholder` as the literal `87123456` everywhere.

- [ ] **Step 4: Run the parity test**

Run: `cd frontend && npx vitest run src/__tests__/i18n/locales.test.ts && cd ..`
Expected: PASS — all three assertions for each of the six gated locales.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/i18n/locales
git commit -m "i18n(aito): keys for the client input, phone/email rows, validation and create-client form"
```

---

### Task 7: Pure helpers — `countryCodes.ts` and `clientDraft.ts`

Everything with real logic lives here so it can be tested without rendering anything.

**Files:**
- Create: `frontend/src/utils/countryCodes.ts`, `frontend/src/utils/clientDraft.ts`
- Test: `frontend/src/__tests__/utils/clientDraft.test.ts`

**Interfaces:**
- Consumes: `ZohoContact` from `frontend/src/api/client.ts`.
- Produces:

```ts
// countryCodes.ts
export interface CountryCode { code: string; iso: string; name: string }
export const COUNTRY_CODES: CountryCode[];
export const DEFAULT_COUNTRY_CODE = '+689';

// clientDraft.ts
export interface ParsedPhone { countryCode: string; nationalNumber: string }
export interface ClientDraft {
  id: string;
  name: string;
  isDefault: boolean;
  countryCode: string;
  nationalNumber: string;
  email: string;
  touched: { phone: boolean; email: boolean };
  blurred: { phone: boolean; email: boolean };
  original: { phone: string; email: string; phoneField: 'phone' | 'mobile' };
}
export interface ClientDraftErrors { phone: string | null; email: string | null }
export function parsePhone(raw: string, defaultCode?: string): ParsedPhone;
export function formatPhone(phone: ParsedPhone): string;
export function titleCaseSegments(value: string): string;
export function formatDisplayName(firstName: string, lastName: string): string;
export function validateEmail(value: string): string | null;   // i18n key or null
export function validatePhone(phone: ParsedPhone): string | null;
export function clientDraftErrors(draft: ClientDraft): ClientDraftErrors;
export function draftFromContact(contact: ZohoContact, defaultContactId: string): ClientDraft;
export function defaultClientDraft(id: string, name: string): ClientDraft;
```

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/__tests__/utils/clientDraft.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  parsePhone,
  formatPhone,
  titleCaseSegments,
  formatDisplayName,
  validateEmail,
  validatePhone,
  clientDraftErrors,
  draftFromContact,
  defaultClientDraft,
} from '../../utils/clientDraft';
import { COUNTRY_CODES, DEFAULT_COUNTRY_CODE } from '../../utils/countryCodes';

describe('countryCodes', () => {
  it('has unique dial codes and covers the codes present in the org data', () => {
    const codes = COUNTRY_CODES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of ['+689', '+687', '+33', '+47', '+1', '+64', '+61']) {
      expect(codes).toContain(code);
    }
    expect(COUNTRY_CODES.length).toBeGreaterThanOrEqual(200);
    expect(DEFAULT_COUNTRY_CODE).toBe('+689');
  });
});

describe('parsePhone', () => {
  it.each([
    ['+689-87296912', '+689', '87296912'],
    ['+33-0179753070', '+33', '0179753070'],
    ['+47-92296862', '+47', '92296862'],
    ['+3312345678', '+33', '12345678'],
    ['00.687.76.31.68', '+687', '763168'],
    ['40 54 43 09', '+689', '40544309'],
    ['87.30.73.53', '+689', '87307353'],
    ['89645864', '+689', '89645864'],
    ['0688727786', '+689', '0688727786'],
    ['', '+689', ''],
    ['   ', '+689', ''],
  ])('parses %s', (raw, countryCode, nationalNumber) => {
    expect(parsePhone(raw)).toEqual({ countryCode, nationalNumber });
  });

  it('honours an explicit default code', () => {
    expect(parsePhone('12345678', '+33')).toEqual({ countryCode: '+33', nationalNumber: '12345678' });
  });
});

describe('formatPhone', () => {
  it('joins with a single hyphen and preserves leading zeros', () => {
    expect(formatPhone({ countryCode: '+33', nationalNumber: '0179753070' })).toBe('+33-0179753070');
  });

  it('returns an empty string when there is no number', () => {
    expect(formatPhone({ countryCode: '+689', nationalNumber: '' })).toBe('');
  });

  it('round-trips a house-format number', () => {
    expect(formatPhone(parsePhone('+689-87296912'))).toBe('+689-87296912');
  });
});

describe('titleCaseSegments', () => {
  it.each([
    ['jean-pierre', 'Jean-Pierre'],
    ['MARIE anne', 'Marie Anne'],
    ['élodie', 'Élodie'],
    ['  paul  ', 'Paul'],
    ['', ''],
  ])('%s -> %s', (input, expected) => {
    expect(titleCaseSegments(input)).toBe(expected);
  });
});

describe('formatDisplayName', () => {
  it.each([
    ['jean-pierre', 'de la tour', 'Jean-Pierre DE LA TOUR'],
    ['élodie', 'teïva-marü', 'Élodie TEÏVA-MARÜ'],
    ['MARIE anne', 'Dupont', 'Marie Anne DUPONT'],
    ['paul', '', 'Paul'],
    ['', 'dupont', 'DUPONT'],
  ])('(%s, %s) -> %s', (first, last, expected) => {
    expect(formatDisplayName(first, last)).toBe(expected);
  });
});

describe('validateEmail', () => {
  it.each(['', '   ', 'a@b.pf', 'client@example.com', 'first.last+tag@sub.domain.co'])(
    'accepts %s',
    (value) => {
      expect(validateEmail(value)).toBeNull();
    },
  );

  it.each(['a', 'a@', '@b.pf', 'a@b', 'a b@c.pf', 'a@b.p'])('rejects %s', (value) => {
    expect(validateEmail(value)).toBe('aito.invalidEmail');
  });
});

describe('validatePhone', () => {
  it('accepts an empty number regardless of the code', () => {
    expect(validatePhone({ countryCode: '+689', nationalNumber: '' })).toBeNull();
  });

  it.each(['1234', '763138', '89645864', '01234567890123'])('accepts %s digits', (national) => {
    expect(validatePhone({ countryCode: '+689', nationalNumber: national })).toBeNull();
  });

  it.each(['123', '012345678901234'])('rejects %s', (national) => {
    expect(validatePhone({ countryCode: '+689', nationalNumber: national })).toBe('aito.invalidPhone');
  });

  it('rejects a malformed country code', () => {
    expect(validatePhone({ countryCode: '689', nationalNumber: '87123456' })).toBe(
      'aito.invalidCountryCode',
    );
    expect(validatePhone({ countryCode: '+', nationalNumber: '87123456' })).toBe(
      'aito.invalidCountryCode',
    );
  });

  it('does not flag the country code when the number is empty', () => {
    expect(validatePhone({ countryCode: '689', nationalNumber: '' })).toBeNull();
  });
});

describe('clientDraftErrors', () => {
  const bad = {
    ...defaultClientDraft('d1', 'Client de passage'),
    email: 'nope',
    nationalNumber: '12',
  };

  it('reports nothing while the fields are unblurred', () => {
    expect(clientDraftErrors(bad)).toEqual({ phone: null, email: null });
  });

  it('reports both once blurred', () => {
    expect(clientDraftErrors({ ...bad, blurred: { phone: true, email: true } })).toEqual({
      phone: 'aito.invalidPhone',
      email: 'aito.invalidEmail',
    });
  });

  it('reports only the blurred field', () => {
    expect(clientDraftErrors({ ...bad, blurred: { phone: false, email: true } })).toEqual({
      phone: null,
      email: 'aito.invalidEmail',
    });
  });
});

describe('draftFromContact', () => {
  const base = { id: 'z1', name: 'ACME SARL', company_name: 'ACME', phone: '', mobile: '', email: '' };

  it('prefers mobile and records it as the write target', () => {
    const draft = draftFromContact({ ...base, mobile: '89645864', phone: '40864225' }, 'default-id');
    expect(draft.countryCode).toBe('+689');
    expect(draft.nationalNumber).toBe('89645864');
    expect(draft.original).toEqual({ phone: '89645864', email: '', phoneField: 'mobile' });
    expect(draft.touched).toEqual({ phone: false, email: false });
    expect(draft.blurred).toEqual({ phone: false, email: false });
    expect(draft.isDefault).toBe(false);
  });

  it('falls back to phone and records phone as the write target', () => {
    const draft = draftFromContact({ ...base, phone: '+689-40864225' }, 'default-id');
    expect(draft.nationalNumber).toBe('40864225');
    expect(draft.original.phoneField).toBe('phone');
  });

  it('targets mobile when the contact has neither', () => {
    expect(draftFromContact(base, 'default-id').original.phoneField).toBe('mobile');
  });

  it('flags the default contact', () => {
    expect(draftFromContact({ ...base, id: 'default-id' }, 'default-id').isDefault).toBe(true);
  });
});

describe('defaultClientDraft', () => {
  it('is empty, untouched and flagged as default', () => {
    expect(defaultClientDraft('d1', 'Client de passage')).toEqual({
      id: 'd1',
      name: 'Client de passage',
      isDefault: true,
      countryCode: '+689',
      nationalNumber: '',
      email: '',
      touched: { phone: false, email: false },
      blurred: { phone: false, email: false },
      original: { phone: '', email: '', phoneField: 'mobile' },
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/__tests__/utils/clientDraft.test.ts && cd ..`
Expected: FAIL — cannot resolve `../../utils/clientDraft`.

- [ ] **Step 3: Create `countryCodes.ts`**

```ts
// International dialling codes for the Aito client phone input. Sorted by
// country name so the searchable dropdown reads alphabetically; `code` is
// unique so longest-prefix parsing is deterministic.

export interface CountryCode {
  code: string;
  iso: string;
  name: string;
}

export const DEFAULT_COUNTRY_CODE = '+689';

export const COUNTRY_CODES: CountryCode[] = [
  { code: '+93', iso: 'AF', name: 'Afghanistan' },
  { code: '+27', iso: 'ZA', name: 'South Africa' },
  { code: '+355', iso: 'AL', name: 'Albania' },
  // … continues for every ISO 3166-1 country
  { code: '+33', iso: 'FR', name: 'France' },
  { code: '+687', iso: 'NC', name: 'New Caledonia' },
  { code: '+64', iso: 'NZ', name: 'New Zealand' },
  { code: '+47', iso: 'NO', name: 'Norway' },
  { code: '+689', iso: 'PF', name: 'French Polynesia' },
  { code: '+61', iso: 'AU', name: 'Australia' },
  { code: '+1', iso: 'US', name: 'United States' },
  { code: '+681', iso: 'WF', name: 'Wallis and Futuna' },
];
```

Populate the full ISO 3166-1 list — every country with its E.164 dialling code, English name, and two-letter ISO code — sorted by `name`. The seven entries called out in the test (`+689 +687 +33 +47 +1 +64 +61`) must be present, `code` values must be unique (where several countries share a code, e.g. NANP `+1`, keep exactly one entry), and the array must hold at least 200 entries. The test in Step 1 gates all of this.

- [ ] **Step 4: Create `clientDraft.ts`**

```ts
import type { ZohoContact } from '../api/client';
import { COUNTRY_CODES, DEFAULT_COUNTRY_CODE } from './countryCodes';

export interface ParsedPhone {
  countryCode: string;
  nationalNumber: string;
}

/** The client half of the Aito new-project form, as one value.
 *
 *  `touched` tracks user intent, not a value diff: a contact stored as a bare
 *  `89645864` renders as `[+689][89645864]`, which re-formats to a different
 *  string than Zoho holds. Keying "dirty" off the value would rewrite hundreds
 *  of untouched contacts as a side effect of creating a card. */
export interface ClientDraft {
  id: string;
  name: string;
  /** The shared walk-in contact — its phone/email are card-only, never synced. */
  isDefault: boolean;
  countryCode: string;
  nationalNumber: string;
  email: string;
  touched: { phone: boolean; email: boolean };
  /** Has the field been left once? Gates error *visibility* only — reusing
   *  `touched` would flash the error from the first keystroke. */
  blurred: { phone: boolean; email: boolean };
  original: { phone: string; email: string; phoneField: 'phone' | 'mobile' };
}

export interface ClientDraftErrors {
  phone: string | null;
  email: string | null;
}

const digitsOnly = (value: string) => value.replace(/\D/g, '');

// Longest first, so '+689' wins over '+6' and '+33' over '+3'.
const CODES_BY_LENGTH = [...COUNTRY_CODES]
  .map((c) => c.code)
  .sort((a, b) => b.length - a.length);

/** Split a stored Zoho phone string into a dialling code and a national number.
 *  Zoho stores the whole thing as free text — `mobile_country_code` is unused —
 *  so the prefix has to be recovered from the string itself. */
export function parsePhone(raw: string, defaultCode: string = DEFAULT_COUNTRY_CODE): ParsedPhone {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { countryCode: defaultCode, nationalNumber: '' };

  let rest: string | null = null;
  if (trimmed.startsWith('+')) rest = trimmed.slice(1);
  else if (trimmed.startsWith('00')) rest = trimmed.slice(2);

  if (rest === null) return { countryCode: defaultCode, nationalNumber: digitsOnly(trimmed) };

  const hyphen = rest.indexOf('-');
  if (hyphen > 0) {
    return {
      countryCode: `+${digitsOnly(rest.slice(0, hyphen))}`,
      nationalNumber: digitsOnly(rest.slice(hyphen + 1)),
    };
  }

  const digits = digitsOnly(rest);
  const match = CODES_BY_LENGTH.find((code) => digits.startsWith(code.slice(1)));
  if (!match) return { countryCode: defaultCode, nationalNumber: digits };
  return { countryCode: match, nationalNumber: digits.slice(match.length - 1) };
}

/** House format: `+CC-XXXXXXXX`. Leading zeros are kept — `+33-0179753070`
 *  is a real, correct value in the directory. */
export function formatPhone(phone: ParsedPhone): string {
  const national = digitsOnly(phone.nationalNumber);
  return national ? `${phone.countryCode}-${national}` : '';
}

/** Capitalize every space- or hyphen-separated segment: 'jean-pierre' -> 'Jean-Pierre'. */
export function titleCaseSegments(value: string): string {
  return value
    .trim()
    .split(/([ -]+)/)
    .map((part, index) =>
      index % 2
        ? part
        : part.slice(0, 1).toLocaleUpperCase('fr') + part.slice(1).toLocaleLowerCase('fr'),
    )
    .join('');
}

/** House convention for person contacts: 'Jean-Pierre DUPONT'. */
export function formatDisplayName(firstName: string, lastName: string): string {
  return `${titleCaseSegments(firstName)} ${lastName.trim().toLocaleUpperCase('fr')}`.trim();
}

// Shape check only. A stricter pattern rejects real addresses; the authority on
// deliverability is Zoho, not this regex.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const COUNTRY_CODE_RE = /^\+\d{1,4}$/;
const MIN_NATIONAL_DIGITS = 4;
const MAX_NATIONAL_DIGITS = 14; // E.164 caps a full number at 15; the code takes 1-4

/** Both fields are optional, so empty always passes. Returns an i18n key rather
 *  than a rendered string so this stays pure and testable without i18n. */
export function validateEmail(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return EMAIL_RE.test(trimmed) ? null : 'aito.invalidEmail';
}

export function validatePhone(phone: ParsedPhone): string | null {
  const national = digitsOnly(phone.nationalNumber);
  // No number means no phone at all — an odd leftover country code is harmless.
  if (!national) return null;
  if (!COUNTRY_CODE_RE.test(phone.countryCode)) return 'aito.invalidCountryCode';
  if (national.length < MIN_NATIONAL_DIGITS || national.length > MAX_NATIONAL_DIGITS) {
    return 'aito.invalidPhone';
  }
  return null;
}

/** Single source of truth for what the form shows and whether it may submit.
 *  A field that has never been blurred reports no error, so opening a contact
 *  whose stored value is already malformed stays quiet. */
export function clientDraftErrors(draft: ClientDraft): ClientDraftErrors {
  return {
    phone: draft.blurred.phone
      ? validatePhone({ countryCode: draft.countryCode, nationalNumber: draft.nationalNumber })
      : null,
    email: draft.blurred.email ? validateEmail(draft.email) : null,
  };
}

export function draftFromContact(contact: ZohoContact, defaultContactId: string): ClientDraft {
  const phoneField: 'phone' | 'mobile' = contact.mobile ? 'mobile' : contact.phone ? 'phone' : 'mobile';
  const raw = contact.mobile || contact.phone || '';
  const parsed = parsePhone(raw);
  return {
    id: contact.id,
    name: contact.name,
    isDefault: contact.id === defaultContactId,
    countryCode: parsed.countryCode,
    nationalNumber: parsed.nationalNumber,
    email: contact.email ?? '',
    touched: { phone: false, email: false },
    blurred: { phone: false, email: false },
    original: { phone: raw, email: contact.email ?? '', phoneField },
  };
}

/** The default client is known from settings alone — id and name, nothing else. */
export function defaultClientDraft(id: string, name: string): ClientDraft {
  return {
    id,
    name,
    isDefault: true,
    countryCode: DEFAULT_COUNTRY_CODE,
    nationalNumber: '',
    email: '',
    touched: { phone: false, email: false },
    blurred: { phone: false, email: false },
    original: { phone: '', email: '', phoneField: 'mobile' },
  };
}
```

- [ ] **Step 4a: Verify the tricky parse cases by hand before running**

`'00.687.76.31.68'` → starts with `00` → `rest = '.687.76.31.68'` → no hyphen → `digits = '687763168'` → longest match `'+687'` → `nationalNumber = digits.slice(3) = '763168'`. ✓
`'+3312345678'` → `rest = '3312345678'` → no hyphen → no `'+331'` entry, `'+33'` matches → `nationalNumber = '12345678'`. ✓
`'0688727786'` → starts with `0` but not `00` → default branch → `{'+689', '0688727786'}`. A French mobile written locally lands under `+689`; since the field stays untouched, it is never written back.

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npx vitest run src/__tests__/utils/clientDraft.test.ts && cd ..`
Expected: PASS — all cases.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/utils frontend/src/__tests__/utils
git commit -m "feat(aito): pure helpers for client drafts, phone parsing and name casing"
```

---

### Task 8: `PhoneInput` and `FieldError` components

**Files:**
- Create: `frontend/src/components/aito/PhoneInput.tsx`, `frontend/src/components/aito/FieldError.tsx`
- Test: covered by `ClientSection.test.tsx` in Task 11 and `NewContactForm.test.tsx` in Task 10.

**Interfaces:**
- Consumes: `SearchableSelect` from `frontend/src/components/SearchableSelect.tsx`, `COUNTRY_CODES` (Task 7), i18n keys `aito.countryCode` / `aito.phonePlaceholder` (Task 6).
- Produces:

```ts
export interface PhoneInputProps {
  countryCode: string;
  nationalNumber: string;
  onChange: (next: { countryCode: string; nationalNumber: string }) => void;
  /** Fired when the national-number input loses focus — the owner flips `blurred`. */
  onBlur?: () => void;
  /** Paints the red border. The error text itself is rendered by the owner. */
  invalid?: boolean;
  id?: string;
  disabled?: boolean;
}
export function PhoneInput(props: PhoneInputProps): JSX.Element;

export interface FieldErrorProps { messageKey: string | null }
export function FieldError(props: FieldErrorProps): JSX.Element | null;
```

- [ ] **Step 1: Create `FieldError.tsx`**

```tsx
import { useTranslation } from 'react-i18next';

export interface FieldErrorProps {
  /** An i18n key from the pure validators, or null when the field is fine. */
  messageKey: string | null;
}

/** One line of inline validation feedback under a form field. Renders nothing
 *  when there is no error, so callers can drop it in unconditionally. */
export function FieldError({ messageKey }: FieldErrorProps) {
  const { t } = useTranslation();
  if (!messageKey) return null;
  return (
    <p role="alert" className="mt-1 text-xs text-status-error">
      {t(messageKey)}
    </p>
  );
}
```

- [ ] **Step 2: Create `PhoneInput.tsx`**

```tsx
import { useTranslation } from 'react-i18next';
import { SearchableSelect } from '../SearchableSelect';
import { COUNTRY_CODES } from '../../utils/countryCodes';
import { inputCls, inputErrorCls } from '../formStyles';

export interface PhoneInputProps {
  countryCode: string;
  nationalNumber: string;
  onChange: (next: { countryCode: string; nationalNumber: string }) => void;
  onBlur?: () => void;
  invalid?: boolean;
  id?: string;
  disabled?: boolean;
}

const options = COUNTRY_CODES.map((c) => ({ value: c.code, label: `${c.code} ${c.name}` }));

/** Dialling-code picker + national number. Zoho stores the whole thing as one
 *  free-text string, so this pair is only a UI split; `formatPhone` rejoins it
 *  as `+CC-XXXXXXXX`. Digits are stripped of separators on blur so the user
 *  sees exactly what will be stored. `allowCustom` lets an unlisted code
 *  through rather than blocking an unusual number. */
export function PhoneInput({
  countryCode,
  nationalNumber,
  onChange,
  onBlur,
  invalid,
  id,
  disabled,
}: PhoneInputProps) {
  const { t } = useTranslation();

  return (
    <div className="flex gap-2">
      <div className="w-36 flex-shrink-0">
        {/* SearchableSelect renders its own role="combobox" input, so it needs a
            real label of its own — otherwise it is a second, unnamed combobox
            sitting next to the client search. `id` lands on the inner input. */}
        <label htmlFor={`${id ?? 'aito-phone'}-country`} className="sr-only">
          {t('aito.countryCode')}
        </label>
        <SearchableSelect
          id={`${id ?? 'aito-phone'}-country`}
          value={countryCode}
          onChange={(next) => onChange({ countryCode: next, nationalNumber })}
          options={options}
          allowCustom
          disabled={disabled}
        />
      </div>
      <input
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete="off"
        disabled={disabled}
        value={nationalNumber}
        onChange={(e) => onChange({ countryCode, nationalNumber: e.target.value })}
        onBlur={(e) => {
          onChange({ countryCode, nationalNumber: e.target.value.replace(/\D/g, '') });
          onBlur?.();
        }}
        placeholder={t('aito.phonePlaceholder')}
        aria-invalid={invalid ? true : undefined}
        className={invalid ? inputErrorCls : inputCls}
      />
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit && cd ..`
Expected: no errors.

> **For the test authors in Tasks 10–12:** anywhere a `PhoneInput` and the
> `ClientCombobox` are on screen together there are **two** `role="combobox"`
> elements. Always qualify: `getByRole('combobox', { name: /client/i })` for the
> client search, `getByLabelText(/country code/i)` for the dialling code, and
> `getByLabelText(/^phone/i)` for the national-number field.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/aito/PhoneInput.tsx frontend/src/components/aito/FieldError.tsx
git commit -m "feat(aito): country-code phone input and inline field error"
```

---

### Task 9: Rewrite `ClientCombobox` as an editable combobox

The current component hides the input once a value is set. With a client always selected, the search box would never be reachable.

**Files:**
- Modify: `frontend/src/components/aito/ClientCombobox.tsx`
- Modify: `frontend/src/__tests__/components/ClientCombobox.test.tsx` (rewritten — the old props are gone)

**Interfaces:**
- Consumes: `api.searchZohoContacts`, `ZohoContact`, i18n keys `aito.createClient` / `aito.resetToDefaultClient` (Task 6).
- Produces:

```ts
export interface ClientComboboxProps {
  clientName: string;
  onSelect: (contact: ZohoContact) => void;
  onCreateNew: (initialQuery: string) => void;
  onReset: () => void;
  showReset: boolean;
}
export function ClientCombobox(props: ClientComboboxProps): JSX.Element;
```

The Zoho-not-configured branch moves **out** of this component into `ClientSection` (Task 11) — it has to hide the phone and email rows too, which this component does not own. `SelectedClient` is deleted; `ClientDraft` replaces it.

- [ ] **Step 1: Rewrite the test file**

Replace the whole contents of `frontend/src/__tests__/components/ClientCombobox.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ClientCombobox } from '../../components/aito/ClientCombobox';

const contacts = [
  { id: 'z1', name: 'ACME SARL', company_name: 'ACME', phone: '', mobile: '89645864', email: 'hi@acme.pf' },
  { id: 'z2', name: 'Acmé Industrie', company_name: '', phone: '40864225', mobile: '', email: '' },
];

beforeEach(() => {
  server.use(
    http.get('/api/v1/zoho/contacts', ({ request }) => {
      const q = new URL(request.url).searchParams.get('q') ?? '';
      return HttpResponse.json(contacts.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())));
    }),
  );
});

const props = {
  clientName: 'Client de passage',
  onSelect: vi.fn(),
  onCreateNew: vi.fn(),
  onReset: vi.fn(),
  showReset: false,
};

describe('ClientCombobox', () => {
  it('shows the current client name in the input', () => {
    render(<ClientCombobox {...props} />);
    expect(screen.getByRole('combobox')).toHaveValue('Client de passage');
  });

  it('searches on typing and reports the picked contact', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ClientCombobox {...props} onSelect={onSelect} />);
    await user.clear(screen.getByRole('combobox'));
    await user.type(screen.getByRole('combobox'), 'acm');
    await user.click(await screen.findByText('ACME SARL'));
    expect(onSelect).toHaveBeenCalledWith(contacts[0]);
  });

  it('reverts the text to the current client when blurred without picking', async () => {
    const user = userEvent.setup();
    render(<ClientCombobox {...props} />);
    const input = screen.getByRole('combobox');
    await user.clear(input);
    await user.type(input, 'nonsense');
    await user.tab();
    expect(input).toHaveValue('Client de passage');
  });

  it('offers the create footer even when there are no results', async () => {
    const onCreateNew = vi.fn();
    const user = userEvent.setup();
    render(<ClientCombobox {...props} onCreateNew={onCreateNew} />);
    const input = screen.getByRole('combobox');
    await user.clear(input);
    await user.type(input, 'zzz');
    await user.click(await screen.findByRole('button', { name: /create new client/i }));
    expect(onCreateNew).toHaveBeenCalledWith('zzz');
  });

  it('hides the reset control unless showReset is set', async () => {
    const onReset = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<ClientCombobox {...props} />);
    expect(screen.getByRole('button', { name: /default client/i })).toHaveClass('opacity-0');
    rerender(<ClientCombobox {...props} showReset onReset={onReset} />);
    await user.click(screen.getByRole('button', { name: /default client/i }));
    expect(onReset).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/__tests__/components/ClientCombobox.test.tsx && cd ..`
Expected: FAIL — the component still takes `value`/`onChange`.

- [ ] **Step 3: Rewrite the component**

Replace the whole contents of `frontend/src/components/aito/ClientCombobox.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Plus, RotateCcw } from 'lucide-react';
import { api } from '../../api/client';
import type { ZohoContact } from '../../api/client';
import { focusRingCls, inputCls, labelCls } from '../formStyles';

export interface ClientComboboxProps {
  clientName: string;
  onSelect: (contact: ZohoContact) => void;
  onCreateNew: (initialQuery: string) => void;
  onReset: () => void;
  showReset: boolean;
}

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

/** Editable combobox over the Zoho Books contact directory. The input always
 *  shows the currently attached client; typing turns it into a search query and
 *  blurring without a pick puts the name back. A client is always attached (the
 *  default walk-in contact if nothing else), so there is no "empty" state and no
 *  chip to clear — the reset control returns to the default instead. */
export function ClientCombobox({ clientName, onSelect, onCreateNew, onReset, showReset }: ClientComboboxProps) {
  const { t } = useTranslation();
  const [rawQuery, setRawQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const blurTimer = useRef<number | undefined>(undefined);

  // Debounce keystrokes — one request per pause, not per character.
  useEffect(() => {
    const trimmed = rawQuery.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setDebouncedQuery('');
      return;
    }
    const id = setTimeout(() => setDebouncedQuery(trimmed), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [rawQuery]);

  useEffect(() => setHighlightedIndex(-1), [debouncedQuery]);
  useEffect(() => () => window.clearTimeout(blurTimer.current), []);

  const contactsQuery = useQuery({
    queryKey: ['zoho-contacts', debouncedQuery],
    queryFn: () => api.searchZohoContacts(debouncedQuery),
    enabled: editing && debouncedQuery.length >= MIN_QUERY_LENGTH,
  });

  const results = contactsQuery.data ?? [];
  const open = editing && rawQuery.trim().length >= MIN_QUERY_LENGTH;

  const stopEditing = () => {
    setEditing(false);
    setRawQuery('');
    setDebouncedQuery('');
  };

  const pick = (contact: ZohoContact) => {
    onSelect(contact);
    stopEditing();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (results.length) setHighlightedIndex((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length) setHighlightedIndex((i) => (i <= 0 ? results.length - 1 : i - 1));
    } else if (e.key === 'Enter') {
      if (highlightedIndex >= 0 && results[highlightedIndex]) {
        e.preventDefault();
        pick(results[highlightedIndex]);
      }
    } else if (e.key === 'Escape') {
      // Close the dropdown only — the modal's own Escape handler would
      // otherwise close the whole modal.
      e.stopPropagation();
      stopEditing();
    }
  };

  return (
    <div>
      <label htmlFor="aito-client-search" className={labelCls}>
        {t('aito.client')}
      </label>
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <input
            id="aito-client-search"
            role="combobox"
            type="text"
            autoComplete="off"
            aria-expanded={open}
            aria-autocomplete="list"
            value={editing ? rawQuery : clientName}
            onFocus={(e) => {
              setEditing(true);
              setRawQuery(clientName);
              e.target.select();
            }}
            onChange={(e) => setRawQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            // Deferred so a click on an option lands before the list unmounts.
            onBlur={() => {
              blurTimer.current = window.setTimeout(stopEditing, 150);
            }}
            placeholder={t('aito.clientPlaceholder')}
            className={inputCls}
          />
          {open && (
            <div
              role="listbox"
              onMouseDown={(e) => e.preventDefault()}
              className="absolute z-50 left-0 right-0 mt-1 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-lg max-h-64 overflow-y-auto animate-slide-up"
            >
              {contactsQuery.isFetching && (
                <div className="flex items-center gap-2 px-3 py-2 text-sm text-bambu-gray">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('aito.searching')}
                </div>
              )}
              {!contactsQuery.isFetching && contactsQuery.isError && (
                <div className="px-3 py-2 text-sm text-status-error">{t('aito.zohoUnreachable')}</div>
              )}
              {!contactsQuery.isFetching && !contactsQuery.isError && results.length === 0 && (
                <div className="px-3 py-2 text-sm text-bambu-gray">{t('aito.noResults')}</div>
              )}
              {!contactsQuery.isFetching &&
                !contactsQuery.isError &&
                results.map((contact, index) => (
                  <button
                    key={contact.id}
                    type="button"
                    role="option"
                    aria-selected={index === highlightedIndex}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => pick(contact)}
                    className={`w-full px-3 py-2 text-left transition-colors ${
                      index === highlightedIndex ? 'bg-bambu-dark-tertiary' : 'hover:bg-bambu-dark-tertiary'
                    }`}
                  >
                    <p className="text-sm text-white truncate">{contact.name}</p>
                    {(contact.company_name || contact.phone || contact.mobile) && (
                      <p className="text-xs text-bambu-gray truncate">
                        {[contact.company_name, contact.mobile || contact.phone].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </button>
                ))}
              <button
                type="button"
                onClick={() => {
                  onCreateNew(rawQuery.trim());
                  stopEditing();
                }}
                className={`w-full px-3 py-2 text-left text-sm text-bambu-green border-t border-bambu-dark-tertiary hover:bg-bambu-dark-tertiary transition-colors flex items-center gap-2 ${focusRingCls}`}
              >
                <Plus className="w-4 h-4" />
                {t('aito.createClient')}
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label={t('aito.resetToDefaultClient')}
          title={t('aito.resetToDefaultClient')}
          onClick={onReset}
          // Space is reserved at all times so revealing the control never
          // shifts the row.
          className={`p-2 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-opacity ${focusRingCls} ${
            showReset ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/__tests__/components/ClientCombobox.test.tsx && cd ..`
Expected: PASS — five tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/aito/ClientCombobox.tsx frontend/src/__tests__/components/ClientCombobox.test.tsx
git commit -m "feat(aito): editable client combobox with a create-client footer"
```

---

### Task 10: `NewContactForm` — the create sub-step

**Files:**
- Create: `frontend/src/components/aito/NewContactForm.tsx`
- Test: `frontend/src/__tests__/components/NewContactForm.test.tsx`

**Interfaces:**
- Consumes: `PhoneInput` (Task 8), `formatDisplayName`, `formatPhone`, `DEFAULT_COUNTRY_CODE` (Task 7), `api.createZohoContact` (Task 3), i18n keys from Task 6.
- Produces:

```ts
export interface NewContactFormProps {
  initialQuery: string;
  onCancel: () => void;
  onCreated: (contact: ZohoContact) => void;
}
export function NewContactForm(props: NewContactFormProps): JSX.Element;
```

`initialQuery` seeds the company-name field so typing a name and clicking "Create new client" does not lose it.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/components/NewContactForm.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { NewContactForm } from '../../components/aito/NewContactForm';

const created = {
  id: 'n1', name: 'Jean-Pierre DUPONT', company_name: '',
  phone: '', mobile: '+689-87123456', email: '',
};

beforeEach(() => {
  server.use(http.post('/api/v1/zoho/contacts', () => HttpResponse.json(created, { status: 201 })));
});

describe('NewContactForm', () => {
  it('seeds the company field from the search query', () => {
    render(<NewContactForm initialQuery="ACME SARL" onCancel={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByLabelText(/company name/i)).toHaveValue('ACME SARL');
  });

  it('disables the name fields while a company name is present, and vice versa', async () => {
    const user = userEvent.setup();
    render(<NewContactForm initialQuery="" onCancel={vi.fn()} onCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/company name/i), 'ACME');
    expect(screen.getByLabelText(/first name/i)).toBeDisabled();
    expect(screen.getByLabelText(/last name/i)).toBeDisabled();

    await user.clear(screen.getByLabelText(/company name/i));
    await user.type(screen.getByLabelText(/first name/i), 'Paul');
    expect(screen.getByLabelText(/company name/i)).toBeDisabled();
  });

  it('previews the enforced display name on blur', async () => {
    const user = userEvent.setup();
    render(<NewContactForm initialQuery="" onCancel={vi.fn()} onCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/first name/i), 'jean-pierre');
    await user.type(screen.getByLabelText(/last name/i), 'dupont');
    await user.tab();
    expect(await screen.findByText(/Jean-Pierre DUPONT/)).toBeInTheDocument();
  });

  it('submits the parts and reports the created contact', async () => {
    const onCreated = vi.fn();
    let body: unknown;
    server.use(
      http.post('/api/v1/zoho/contacts', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    render(<NewContactForm initialQuery="" onCancel={vi.fn()} onCreated={onCreated} />);
    await user.type(screen.getByLabelText(/first name/i), 'jean-pierre');
    await user.type(screen.getByLabelText(/last name/i), 'dupont');
    await user.type(screen.getByLabelText(/^phone/i), '87123456');
    await user.click(screen.getByRole('button', { name: /create client/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(body).toMatchObject({
      first_name: 'Jean-Pierre',
      last_name: 'DUPONT',
      phone: '+689-87123456',
      company_name: '',
    });
  });

  it('shows the Zoho duplicate message inline', async () => {
    server.use(
      http.post('/api/v1/zoho/contacts', () =>
        HttpResponse.json({ detail: 'Contact name already exists.' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    render(<NewContactForm initialQuery="ACME SARL" onCancel={vi.fn()} onCreated={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /create client/i }));
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
  });

  it('blocks submission until a name is present', () => {
    render(<NewContactForm initialQuery="" onCancel={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByRole('button', { name: /create client/i })).toBeDisabled();
  });

  it('shows an email error only after the field is left, and disables submit', async () => {
    const user = userEvent.setup();
    render(<NewContactForm initialQuery="ACME SARL" onCancel={vi.fn()} onCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/^email/i), 'nope');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create client/i })).toBeDisabled();

    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent(/valid email/i);

    await user.clear(screen.getByLabelText(/^email/i));
    await user.type(screen.getByLabelText(/^email/i), 'hi@acme.pf');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create client/i })).toBeEnabled();
  });

  it('rejects a too-short phone number and never calls the API', async () => {
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<NewContactForm initialQuery="ACME SARL" onCancel={vi.fn()} onCreated={onCreated} />);
    await user.type(screen.getByLabelText(/^phone/i), '12');
    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent(/4 and 14 digits/i);
    expect(screen.getByRole('button', { name: /create client/i })).toBeDisabled();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/__tests__/components/NewContactForm.test.tsx && cd ..`
Expected: FAIL — cannot resolve `../../components/aito/NewContactForm`.

- [ ] **Step 3: Create the component**

```tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, Plus } from 'lucide-react';
import { api } from '../../api/client';
import type { ZohoContact } from '../../api/client';
import { Button } from '../Button';
import { PhoneInput } from './PhoneInput';
import { FieldError } from './FieldError';
import { inputCls, inputErrorCls, labelCls } from '../formStyles';
import {
  DEFAULT_COUNTRY_CODE,
  formatDisplayName,
  formatPhone,
  titleCaseSegments,
  validateEmail,
  validatePhone,
} from '../../utils/clientDraft';

export interface NewContactFormProps {
  initialQuery: string;
  onCancel: () => void;
  onCreated: (contact: ZohoContact) => void;
}

/** Create-contact sub-step of the Aito new-project modal.
 *
 *  Company and person are mutually exclusive: filling one disables the other,
 *  which is what makes the display name unambiguous. Casing is normalized on
 *  blur rather than per keystroke — per-keystroke fights hyphenated names like
 *  "Jean-Pierre" while they are still being typed — and re-applied server-side.
 *  This writes to Zoho immediately on submit because the real contact_id is
 *  needed before the contact can be attached to a project. */
export function NewContactForm({ initialQuery, onCancel, onCreated }: NewContactFormProps) {
  const { t } = useTranslation();
  const [companyName, setCompanyName] = useState(initialQuery);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [countryCode, setCountryCode] = useState(DEFAULT_COUNTRY_CODE);
  const [nationalNumber, setNationalNumber] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [blurred, setBlurred] = useState({ phone: false, email: false });

  const hasCompany = companyName.trim().length > 0;
  const hasPerson = firstName.trim().length > 0 || lastName.trim().length > 0;
  const hasName = hasCompany || (firstName.trim().length > 0 && lastName.trim().length > 0);
  const preview = hasCompany ? companyName.trim() : formatDisplayName(firstName, lastName);

  // Same two-stage rule as ClientSection: the message only becomes visible once
  // the field has been left, but validity always gates the submit.
  const phoneError = validatePhone({ countryCode, nationalNumber });
  const emailError = validateEmail(email);
  const visibleErrors = {
    phone: blurred.phone ? phoneError : null,
    email: blurred.email ? emailError : null,
  };
  const canSubmit = hasName && !phoneError && !emailError;

  const createMutation = useMutation({
    mutationFn: () =>
      api.createZohoContact({
        company_name: hasCompany ? companyName.trim() : '',
        first_name: hasCompany ? '' : titleCaseSegments(firstName),
        last_name: hasCompany ? '' : lastName.trim().toLocaleUpperCase('fr'),
        email: email.trim(),
        phone: formatPhone({ countryCode, nationalNumber }),
      }),
    onSuccess: onCreated,
    onError: (e: Error) => setError(e.message || t('aito.clientCreateFailed')),
  });

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        // Reveal any error the user never triggered by blurring, so a disabled
        // button is always explained by a message on screen.
        setBlurred({ phone: true, email: true });
        if (!canSubmit) return;
        setError(null);
        createMutation.mutate();
      }}
      className="flex flex-col flex-1 min-h-0"
    >
      <div className="p-4 overflow-y-auto flex-1 space-y-4">
        <div>
          <label htmlFor="aito-company" className={labelCls}>
            {t('aito.companyName')}
          </label>
          <input
            id="aito-company"
            type="text"
            autoComplete="off"
            value={companyName}
            disabled={hasPerson}
            onChange={(e) => setCompanyName(e.target.value)}
            className={`${inputCls} disabled:opacity-40`}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="aito-first-name" className={labelCls}>
              {t('aito.firstName')}
            </label>
            <input
              id="aito-first-name"
              type="text"
              autoComplete="off"
              value={firstName}
              disabled={hasCompany}
              onChange={(e) => setFirstName(e.target.value)}
              onBlur={(e) => setFirstName(titleCaseSegments(e.target.value))}
              className={`${inputCls} disabled:opacity-40`}
            />
          </div>
          <div>
            <label htmlFor="aito-last-name" className={labelCls}>
              {t('aito.lastName')}
            </label>
            <input
              id="aito-last-name"
              type="text"
              autoComplete="off"
              value={lastName}
              disabled={hasCompany}
              onChange={(e) => setLastName(e.target.value)}
              onBlur={(e) => setLastName(e.target.value.trim().toLocaleUpperCase('fr'))}
              className={`${inputCls} disabled:opacity-40`}
            />
          </div>
        </div>

        <p className="text-xs text-bambu-gray">
          {preview ? t('aito.displayNamePreview', { name: preview }) : t('aito.clientNameRequired')}
        </p>

        <div>
          <label htmlFor="aito-new-phone" className={labelCls}>
            {t('aito.clientPhone')}
          </label>
          <PhoneInput
            id="aito-new-phone"
            countryCode={countryCode}
            nationalNumber={nationalNumber}
            invalid={visibleErrors.phone !== null}
            onBlur={() => setBlurred((b) => ({ ...b, phone: true }))}
            onChange={(next) => {
              setCountryCode(next.countryCode);
              setNationalNumber(next.nationalNumber);
            }}
          />
          <FieldError messageKey={visibleErrors.phone} />
        </div>

        <div>
          <label htmlFor="aito-new-email" className={labelCls}>
            {t('aito.clientEmail')}
          </label>
          <input
            id="aito-new-email"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setBlurred((b) => ({ ...b, email: true }))}
            placeholder={t('aito.emailPlaceholder')}
            aria-invalid={visibleErrors.email !== null ? true : undefined}
            className={visibleErrors.email !== null ? inputErrorCls : inputCls}
          />
          <FieldError messageKey={visibleErrors.email} />
        </div>

        {error && <p className="text-sm text-status-error">{error}</p>}
      </div>

      <div className="p-4 border-t border-bambu-dark-tertiary flex justify-between gap-2 flex-shrink-0">
        <Button type="button" variant="secondary" onClick={onCancel}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          {t('aito.back')}
        </Button>
        <Button type="submit" disabled={!canSubmit || createMutation.isPending}>
          <Plus className="w-4 h-4 mr-2" />
          {t('aito.createClientSubmit')}
        </Button>
      </div>
    </form>
  );
}
```

Re-export `DEFAULT_COUNTRY_CODE` from `clientDraft.ts` so this import resolves — add to the bottom of `frontend/src/utils/clientDraft.ts`:

```ts
export { DEFAULT_COUNTRY_CODE } from './countryCodes';
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/__tests__/components/NewContactForm.test.tsx && cd ..`
Expected: PASS — eight tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/aito/NewContactForm.tsx frontend/src/utils/clientDraft.ts frontend/src/__tests__/components/NewContactForm.test.tsx
git commit -m "feat(aito): in-modal create-client form with enforced display-name casing"
```

---

### Task 11: `ClientSection` — draft owner

**Files:**
- Create: `frontend/src/components/aito/ClientSection.tsx`
- Test: `frontend/src/__tests__/components/ClientSection.test.tsx`

**Interfaces:**
- Consumes: `ClientCombobox` (Task 9), `PhoneInput` (Task 8), `ClientDraft` / `draftFromContact` / `defaultClientDraft` (Task 7), `api.getZohoStatus` (Task 2).
- Produces:

```ts
export interface ClientSectionProps {
  value: ClientDraft;
  onChange: (next: ClientDraft) => void;
  onCreateNew: (initialQuery: string) => void;
  defaultContactId: string;
  defaultContactName: string;
}
export function ClientSection(props: ClientSectionProps): JSX.Element;
```

The Zoho-not-configured notice lives here (it must hide the phone and email rows too, not just the search box).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/components/ClientSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ClientSection } from '../../components/aito/ClientSection';
import { defaultClientDraft, draftFromContact } from '../../utils/clientDraft';

const DEFAULT_ID = '66407000001237340';
const DEFAULT_NAME = 'Client de passage';

const acme = {
  id: 'z1', name: 'ACME SARL', company_name: 'ACME',
  phone: '', mobile: '89645864', email: 'hi@acme.pf',
};

beforeEach(() => {
  server.use(
    http.get('/api/v1/zoho/status', () =>
      HttpResponse.json({
        configured: true, reachable: true,
        default_contact_id: DEFAULT_ID, default_contact_name: DEFAULT_NAME,
      }),
    ),
    http.get('/api/v1/zoho/contacts', () => HttpResponse.json([acme])),
  );
});

const renderSection = (value = defaultClientDraft(DEFAULT_ID, DEFAULT_NAME), onChange = vi.fn()) => {
  render(
    <ClientSection
      value={value}
      onChange={onChange}
      onCreateNew={vi.fn()}
      defaultContactId={DEFAULT_ID}
      defaultContactName={DEFAULT_NAME}
    />,
  );
  return onChange;
};

describe('ClientSection', () => {
  it('shows the default client with empty phone and email', () => {
    renderSection();
    expect(screen.getByRole('combobox', { name: /client/i })).toHaveValue(DEFAULT_NAME);
    expect(screen.getByLabelText(/^phone/i)).toHaveValue('');
    expect(screen.getByLabelText(/^email/i)).toHaveValue('');
  });

  it('does not mark an untouched parsed phone as dirty', () => {
    renderSection(draftFromContact(acme, DEFAULT_ID));
    expect(screen.getByLabelText(/^phone/i)).toHaveValue('89645864');
    expect(screen.getByRole('button', { name: /revert phone/i })).toHaveClass('opacity-0');
  });

  it('marks the phone touched once edited and reverts on the reset control', async () => {
    let draft = draftFromContact(acme, DEFAULT_ID);
    const onChange = vi.fn((next) => {
      draft = next;
    });
    const user = userEvent.setup();
    const { rerender } = render(
      <ClientSection
        value={draft}
        onChange={onChange}
        onCreateNew={vi.fn()}
        defaultContactId={DEFAULT_ID}
        defaultContactName={DEFAULT_NAME}
      />,
    );
    await user.type(screen.getByLabelText(/^phone/i), '9');
    expect(onChange).toHaveBeenCalled();
    expect(draft.touched.phone).toBe(true);

    rerender(
      <ClientSection
        value={draft}
        onChange={onChange}
        onCreateNew={vi.fn()}
        defaultContactId={DEFAULT_ID}
        defaultContactName={DEFAULT_NAME}
      />,
    );
    await user.click(screen.getByRole('button', { name: /revert phone/i }));
    expect(draft.touched.phone).toBe(false);
    expect(draft.blurred.phone).toBe(false);
    expect(draft.nationalNumber).toBe('89645864');
  });

  it('stays quiet while an email is being typed, then errors on blur', async () => {
    // ClientSection is controlled, so the test plays the parent: every onChange
    // is fed straight back in as the new value.
    let draft = defaultClientDraft(DEFAULT_ID, DEFAULT_NAME);
    const section = (value: typeof draft) => (
      <ClientSection
        value={value}
        onChange={(next) => {
          draft = next;
          rerender(section(next));
        }}
        onCreateNew={vi.fn()}
        defaultContactId={DEFAULT_ID}
        defaultContactName={DEFAULT_NAME}
      />
    );
    const user = userEvent.setup();
    const { rerender } = render(section(draft));

    await user.type(screen.getByLabelText(/^email/i), 'cli');
    expect(draft.email).toBe('cli');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent(/valid email/i);
    expect(screen.getByLabelText(/^email/i)).toHaveAttribute('aria-invalid', 'true');
  });

  it('clears the email error live once the value becomes valid', () => {
    const draft = {
      ...defaultClientDraft(DEFAULT_ID, DEFAULT_NAME),
      email: 'client@example.pf',
      touched: { phone: false, email: true },
      blurred: { phone: false, email: true },
    };
    renderSection(draft);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('errors on a too-short phone number once blurred', () => {
    const draft = {
      ...defaultClientDraft(DEFAULT_ID, DEFAULT_NAME),
      nationalNumber: '12',
      touched: { phone: true, email: false },
      blurred: { phone: true, email: false },
    };
    renderSection(draft);
    expect(screen.getByRole('alert')).toHaveTextContent(/4 and 14 digits/i);
  });

  it('resets the whole draft to the default client', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderSection(draftFromContact(acme, DEFAULT_ID), onChange);
    await user.click(screen.getByRole('button', { name: /default client/i }));
    expect(onChange).toHaveBeenCalledWith(defaultClientDraft(DEFAULT_ID, DEFAULT_NAME));
  });

  it('replaces the whole block with a settings link when Zoho is not configured', async () => {
    server.use(
      http.get('/api/v1/zoho/status', () =>
        HttpResponse.json({
          configured: false, reachable: false,
          default_contact_id: DEFAULT_ID, default_contact_name: DEFAULT_NAME,
        }),
      ),
    );
    renderSection();
    await waitFor(() => expect(screen.queryByLabelText(/^phone/i)).not.toBeInTheDocument());
    expect(screen.getByRole('link')).toHaveAttribute('href', '/settings?tab=zoho');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/__tests__/components/ClientSection.test.tsx && cd ..`
Expected: FAIL — cannot resolve `../../components/aito/ClientSection`.

- [ ] **Step 3: Create the component**

```tsx
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { RotateCcw } from 'lucide-react';
import { api } from '../../api/client';
import type { ZohoContact } from '../../api/client';
import { ClientCombobox } from './ClientCombobox';
import { PhoneInput } from './PhoneInput';
import { FieldError } from './FieldError';
import { clientDraftErrors, defaultClientDraft, draftFromContact, parsePhone } from '../../utils/clientDraft';
import type { ClientDraft } from '../../utils/clientDraft';
import { focusRingCls, inputCls, inputErrorCls, labelCls } from '../formStyles';

export interface ClientSectionProps {
  value: ClientDraft;
  onChange: (next: ClientDraft) => void;
  onCreateNew: (initialQuery: string) => void;
  defaultContactId: string;
  defaultContactName: string;
}

/** The client half of the Aito new-project form: who the client is, plus the
 *  phone and email that will be written back to Zoho.
 *
 *  Reset visibility keys off `touched`, never a value diff — a contact stored
 *  as a bare `89645864` re-formats to `+689-89645864`, so a value test would
 *  light up controls on fields nobody edited. */
export function ClientSection({
  value,
  onChange,
  onCreateNew,
  defaultContactId,
  defaultContactName,
}: ClientSectionProps) {
  const { t } = useTranslation();
  const statusQuery = useQuery({ queryKey: ['zoho-status'], queryFn: api.getZohoStatus, staleTime: 60_000 });

  if (statusQuery.data?.configured === false) {
    return (
      <div>
        <label className={labelCls}>{t('aito.client')}</label>
        <div className="p-3 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-sm text-bambu-gray">
          {t('aito.zohoNotConfigured')}{' '}
          <Link to="/settings?tab=zoho" className="text-bambu-green hover:underline">
            {t('aito.zohoConfigureLink')}
          </Link>
        </div>
      </div>
    );
  }

  const selectContact = (contact: ZohoContact) => onChange(draftFromContact(contact, defaultContactId));

  // Reverting returns the field to its quiet initial state: the stored value
  // back, and both flags cleared so any error message disappears with it.
  const revertPhone = () => {
    const parsed = parsePhone(value.original.phone);
    onChange({
      ...value,
      countryCode: parsed.countryCode,
      nationalNumber: parsed.nationalNumber,
      touched: { ...value.touched, phone: false },
      blurred: { ...value.blurred, phone: false },
    });
  };

  const revertEmail = () =>
    onChange({
      ...value,
      email: value.original.email,
      touched: { ...value.touched, email: false },
      blurred: { ...value.blurred, email: false },
    });

  const errors = clientDraftErrors(value);

  const resetButtonCls = (visible: boolean) =>
    `p-2 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-opacity ${focusRingCls} ${
      visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
    }`;

  return (
    <div className="space-y-3">
      <ClientCombobox
        clientName={value.name}
        onSelect={selectContact}
        onCreateNew={onCreateNew}
        onReset={() => onChange(defaultClientDraft(defaultContactId, defaultContactName))}
        showReset={value.id !== defaultContactId}
      />

      <div>
        <label htmlFor="aito-client-phone" className={labelCls}>
          {t('aito.clientPhone')}
        </label>
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <PhoneInput
              id="aito-client-phone"
              countryCode={value.countryCode}
              nationalNumber={value.nationalNumber}
              invalid={errors.phone !== null}
              onBlur={() => onChange({ ...value, blurred: { ...value.blurred, phone: true } })}
              onChange={(next) =>
                onChange({
                  ...value,
                  countryCode: next.countryCode,
                  nationalNumber: next.nationalNumber,
                  touched: { ...value.touched, phone: true },
                })
              }
            />
          </div>
          <button
            type="button"
            aria-label={t('aito.revertPhone')}
            title={t('aito.revertPhone')}
            onClick={revertPhone}
            className={resetButtonCls(value.touched.phone)}
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
        <FieldError messageKey={errors.phone} />
      </div>

      <div>
        <label htmlFor="aito-client-email" className={labelCls}>
          {t('aito.clientEmail')}
        </label>
        <div className="flex items-center gap-2">
          <input
            id="aito-client-email"
            type="email"
            autoComplete="off"
            value={value.email}
            onChange={(e) => onChange({ ...value, email: e.target.value, touched: { ...value.touched, email: true } })}
            onBlur={() => onChange({ ...value, blurred: { ...value.blurred, email: true } })}
            placeholder={t('aito.emailPlaceholder')}
            aria-invalid={errors.email !== null ? true : undefined}
            className={errors.email !== null ? inputErrorCls : inputCls}
          />
          <button
            type="button"
            aria-label={t('aito.revertEmail')}
            title={t('aito.revertEmail')}
            onClick={revertEmail}
            className={resetButtonCls(value.touched.email)}
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
        <FieldError messageKey={errors.email} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/__tests__/components/ClientSection.test.tsx && cd ..`
Expected: PASS — eight tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/aito/ClientSection.tsx frontend/src/__tests__/components/ClientSection.test.tsx
git commit -m "feat(aito): client section with editable phone/email and intent-based resets"
```

---

### Task 12: Extract `NewProjectModal` and wire the submit flow

> **Locate by symbol, not line number.** `AitoPage.tsx` is being actively refactored on this branch (the board card components were extracted after this plan was written). Find `NewProjectModal`, `createMutation` and `createProject` by name.

**Files:**
- Create: `frontend/src/components/aito/NewProjectModal.tsx`
- Modify: `frontend/src/pages/AitoPage.tsx` (delete the inline `NewProjectModal`, update the create mutation and `createProject`)
- Modify: `frontend/src/__tests__/pages/AitoPage.test.tsx` if it asserts on the old modal markup

**Interfaces:**
- Consumes: `ClientSection` (Task 11), `NewContactForm` (Task 10), `ClientDraft` / `defaultClientDraft` / `draftFromContact` / `formatPhone` (Task 7), `api.getZohoStatus` (Task 2), `api.updateZohoContact` (Task 4), `api.createAitoProject` with `client_email` (Task 5).
- Produces:

```ts
export interface NewProjectModalProps {
  onClose: () => void;
  onCreate: (description: string, draft: ClientDraft) => void;
}
export function NewProjectModal(props: NewProjectModalProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/components/NewProjectModal.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { NewProjectModal } from '../../components/aito/NewProjectModal';

const DEFAULT_ID = '66407000001237340';

beforeEach(() => {
  server.use(
    http.get('/api/v1/zoho/status', () =>
      HttpResponse.json({
        configured: true, reachable: true,
        default_contact_id: DEFAULT_ID, default_contact_name: 'Client de passage',
      }),
    ),
    http.get('/api/v1/zoho/contacts', () => HttpResponse.json([])),
  );
});

describe('NewProjectModal', () => {
  it('opens with the default client preselected and submits it', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(<NewProjectModal onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /client/i })).toHaveValue('Client de passage'),
    );
    await user.type(screen.getByLabelText(/product description/i), 'Support de caméra');
    await user.click(screen.getByRole('button', { name: /create project/i }));
    expect(onCreate).toHaveBeenCalledWith(
      'Support de caméra',
      expect.objectContaining({ id: DEFAULT_ID, isDefault: true }),
    );
  });

  it('blocks submit on a malformed email and reveals the error', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(<NewProjectModal onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /client/i })).toHaveValue('Client de passage'),
    );
    await user.type(screen.getByLabelText(/product description/i), 'Support de caméra');
    await user.type(screen.getByLabelText(/^email/i), 'nope');
    // Never blurred, so no message yet — but the button is already disabled.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create project/i })).toBeDisabled();

    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent(/valid email/i);
    expect(onCreate).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText(/^email/i));
    await user.click(screen.getByRole('button', { name: /create project/i }));
    expect(onCreate).toHaveBeenCalled();
  });

  it('switches to the create-client sub-step and back', async () => {
    const user = userEvent.setup();
    render(<NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />);
    const combobox = await screen.findByRole('combobox', { name: /client/i });
    await user.clear(combobox);
    await user.type(combobox, 'zzz');
    await user.click(await screen.findByRole('button', { name: /create new client/i }));
    expect(screen.getByLabelText(/company name/i)).toHaveValue('zzz');
    await user.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByLabelText(/product description/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/__tests__/components/NewProjectModal.test.tsx && cd ..`
Expected: FAIL — cannot resolve `../../components/aito/NewProjectModal`.

- [ ] **Step 3: Create the modal**

```tsx
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { api } from '../../api/client';
import type { ZohoContact } from '../../api/client';
import { Button } from '../Button';
import { ClientSection } from './ClientSection';
import { NewContactForm } from './NewContactForm';
import { clientDraftErrors, defaultClientDraft, draftFromContact } from '../../utils/clientDraft';
import type { ClientDraft } from '../../utils/clientDraft';
import { inputCls, labelCls } from '../formStyles';

export interface NewProjectModalProps {
  onClose: () => void;
  onCreate: (description: string, draft: ClientDraft) => void;
}

/** Two-view modal: the project form, and a create-client sub-step that slides
 *  over it. A client is always attached — the default walk-in contact until the
 *  user picks another — so creation is never blocked on choosing one. */
export function NewProjectModal({ onClose, onCreate }: NewProjectModalProps) {
  const { t } = useTranslation();
  const [description, setDescription] = useState('');
  const [draft, setDraft] = useState<ClientDraft | null>(null);
  const [creatingClient, setCreatingClient] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const statusQuery = useQuery({ queryKey: ['zoho-status'], queryFn: api.getZohoStatus, staleTime: 60_000 });
  const defaultId = statusQuery.data?.default_contact_id ?? '';
  const defaultName = statusQuery.data?.default_contact_name ?? '';

  // Seed the draft once the default contact is known.
  useEffect(() => {
    if (!draft && defaultId) setDraft(defaultClientDraft(defaultId, defaultName));
  }, [draft, defaultId, defaultName]);

  useEffect(() => {
    textareaRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // `clientDraftErrors` only reports blurred fields, so this is what the user can
  // currently see. Validity for gating is computed against a fully-blurred copy,
  // which is also what `submit` reveals — a disabled button is therefore always
  // accompanied by a visible message.
  const clientValid =
    draft === null ||
    Object.values(clientDraftErrors({ ...draft, blurred: { phone: true, email: true } })).every(
      (e) => e === null,
    );
  const canSubmit = description.trim().length > 0 && draft !== null && clientValid;

  const submit = () => {
    if (!draft) return;
    // Reveal errors the user never triggered by leaving a field.
    setDraft({ ...draft, blurred: { phone: true, email: true } });
    if (description.trim().length === 0 || !clientValid) return;
    onCreate(description.trim(), draft);
  };

  const onClientCreated = (contact: ZohoContact) => {
    setDraft(draftFromContact(contact, defaultId));
    setCreatingClient(null);
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 animate-overlay-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-bambu-dark-secondary rounded-xl w-full max-w-md border border-bambu-dark-tertiary flex flex-col max-h-[calc(100vh-2rem)] animate-modal-in">
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-center justify-between flex-shrink-0">
          <h2 className="text-lg font-semibold text-white">
            {creatingClient === null ? t('aito.modalTitle') : t('aito.newClientTitle')}
          </h2>
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={onClose}
            className="p-1 -m-1 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {creatingClient !== null ? (
          <NewContactForm
            initialQuery={creatingClient}
            onCancel={() => setCreatingClient(null)}
            onCreated={onClientCreated}
          />
        ) : (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="flex flex-col flex-1 min-h-0"
          >
            <div className="p-4 overflow-y-auto flex-1 space-y-4">
              {draft && (
                <ClientSection
                  value={draft}
                  onChange={setDraft}
                  onCreateNew={setCreatingClient}
                  defaultContactId={defaultId}
                  defaultContactName={defaultName}
                />
              )}
              <div>
                <label htmlFor="aito-description" className={labelCls}>
                  {t('aito.productDescription')}
                </label>
                <textarea
                  id="aito-description"
                  ref={textareaRef}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
                  }}
                  placeholder={t('aito.descriptionPlaceholder')}
                  rows={4}
                  required
                  className={`${inputCls} resize-none`}
                />
              </div>
            </div>

            <div className="p-4 border-t border-bambu-dark-tertiary flex justify-end gap-2 flex-shrink-0">
              <Button type="button" variant="secondary" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                <Plus className="w-4 h-4 mr-2" />
                {t('aito.create')}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the modal tests**

Run: `cd frontend && npx vitest run src/__tests__/components/NewProjectModal.test.tsx && cd ..`
Expected: PASS — three tests.

- [ ] **Step 5: Rewire `AitoPage.tsx`**

Delete the inline `NewProjectModal` function and replace the `ClientCombobox` import with:

```tsx
import { NewProjectModal } from '../components/aito/NewProjectModal';
import { formatPhone } from '../utils/clientDraft';
import type { ClientDraft } from '../utils/clientDraft';
```

**Also delete this import line** — `inputCls` and `labelCls` are used *only* inside
the modal being removed, so leaving it trips `noUnusedLocals`:

```tsx
import { inputCls, labelCls } from '../components/formStyles';
```

`useRef`, `X` and `Plus` stay — the trash modal and the page header still use them.

Replace `createMutation` with:

```tsx
  const createMutation = useMutation({
    mutationFn: ({ description, draft }: { description: string; draft: ClientDraft }) =>
      api.createAitoProject({
        description,
        client_id: draft.id,
        client_name: draft.name,
        client_phone: formatPhone(draft) || null,
        client_email: draft.email.trim() || null,
      }),
    onSuccess: (_data, { draft }) => {
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      setShowModal(false);
      void syncClientToZoho(draft);
    },
    onError: () => {
      showToast(t('aito.createFailed'), 'error');
    },
  });
```

Add above it:

```tsx
  /** Push edited contact details back to Zoho after the card exists.
   *
   *  Deliberately not awaited by the create mutation: the board is the job and
   *  a Zoho outage must not cost the user their card. The default walk-in
   *  contact is skipped entirely — it is shared by every passing customer and
   *  carries live transaction history. Fields the user never edited are skipped
   *  too, so creating a project never silently reformats a stored number. */
  const syncClientToZoho = async (draft: ClientDraft) => {
    if (draft.isDefault) return;
    if (!draft.touched.phone && !draft.touched.email) return;
    try {
      await api.updateZohoContact(draft.id, {
        ...(draft.touched.phone
          ? { phone: formatPhone(draft), phone_field: draft.original.phoneField }
          : {}),
        ...(draft.touched.email ? { email: draft.email.trim() } : {}),
      });
    } catch {
      showToast(t('aito.clientSyncFailed'), 'warning');
    }
  };
```

Replace `createProject` with:

```tsx
  const createProject = (description: string, draft: ClientDraft) => {
    createMutation.mutate({ description, draft });
  };
```

- [ ] **Step 6: Full frontend verification**

Run: `cd frontend && npm run build && cd .. && ./test_frontend.sh`
Expected: build succeeds; TypeScript check, ESLint and every Vitest suite pass.

`AitoPage.test.tsx` covers the card face, the load-failed state, the localStorage
migration, hold-to-delete and the trash view — it never opens the new-project
modal, so the extraction needs no changes there. The modal's coverage lives in the
new `NewProjectModal.test.tsx` from Step 1.

- [ ] **Step 7: Full backend verification**

Run: `./test_backend.sh`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add frontend/src
git commit -m "feat(aito): default client, editable contact details and Zoho write-back on submit"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| `_request` refactor | 1 |
| `GET /zoho/status` + default contact settings | 2 |
| `POST /zoho/contacts` + server-side casing | 3 |
| `PATCH /zoho/contacts/{id}` + default-contact guard | 4 |
| `client_email` column and DTOs | 5 |
| i18n, 12 locales | 6 (+ the 3 `zoho.*` keys in 2) |
| `countryCodes.ts`, `clientDraft.ts`, phone parse/format, name casing | 7 |
| `PhoneInput`, `FieldError` | 8 |
| Email/phone validation, inline errors, submit blocking | 3, 4 (server), 7 (validators), 10–12 (UI) |
| Editable combobox + create footer | 9 |
| Create sub-step, mutually exclusive name paths, preview | 10 |
| `ClientSection`, reset controls, not-configured branch | 11 |
| Modal extraction, submit order, sync-failure toast | 12 |

**Type consistency checked:** `ClientDraft` is defined once in Task 7 and consumed unchanged in 11 and 12. `phoneField` is `'phone' | 'mobile'` in the TS draft, the `ZohoContactPatch` Pydantic `Literal`, and the `update_contact_person` argument. `formatPhone` accepts `{countryCode, nationalNumber}`, which `ClientDraft` structurally satisfies — that is why `formatPhone(draft)` type-checks in Task 12.

**Known follow-ups (deliberately out of scope):** the card face and detail panel do not display `client_email` yet — that belongs to `2026-07-26-aito-card-morph-and-drag-design.md`.
