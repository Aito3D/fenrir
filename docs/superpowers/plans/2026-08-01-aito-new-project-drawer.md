# Aito New-Project Workbench Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Aito `NewProjectModal` with a guided, work-first, full-height drawer: chip-based task editing, an OpenRouter-generated French project summary, blur-revealed creation rules, a locally persisted draft, and an upgraded shared `HoldButton` hold choreography.

**Architecture:** Frontend-heavy React work (new `NewProjectDrawer` + small leaf components + a rework of the shared `TaskStepFields`), plus a thin backend slice: two new settings keys, one OpenRouter service module, one `POST /aito/summarize` route, one validation rule on project create, and server-side contact-name normalization. Spec: `docs/superpowers/specs/2026-08-01-aito-new-project-drawer-design.md`. Interactive reference prototype: `.superpowers/brainstorm/82134-1785628005/content/hybrid-drawer-v10.html`.

**Tech Stack:** React 19 + TypeScript (Vite, Tailwind 4, TanStack Query, react-i18next, Vitest), FastAPI + SQLAlchemy async + httpx (pytest).

## Global Constraints

- Python 3.10 floor — no `datetime.UTC`, no 3.11+ syntax. Line length 120, Ruff rules E,W,F,I,B,C4,UP,ARG,SIM. Double quotes.
- All Python commands via `./venv/bin/python3`; ruff is system-wide (`ruff check backend/`, `ruff format backend/`). Run everything from the project root.
- Frontend: `npm run build` (from `frontend/`) catches module-resolution errors `npx tsc --noEmit` does not. `frontend/tsconfig.app.json` excludes `src/__tests__` — after changing a shared interface, grep test files by hand.
- i18n: `frontend/scripts/check-i18n-parity.mjs` (runs inside `npm run test:run`) requires every new leaf key in **en, de, fr, it, ja, pt-BR, zh-CN, zh-TW** with REAL translations (identical-to-English values fail the gate). Locale files are plain `key: 'value'` maps — no spread/shorthand.
- Tailwind: never build class names by string interpolation — every class a complete literal. Never stack two utilities that set the same CSS property on one element.
- FastAPI route ordering: any new literal path under `/aito` (e.g. `/summarize`) must be registered BEFORE the `/{project_id}` routes in `backend/app/api/routes/aito.py` (same class of bug as the energy-history route noted in project memory).
- New backend behavior must not break `backend/tests/unit/test_aito_routes.py`'s golden fixture; regenerate deliberately with `REGENERATE_GOLDEN=1` and read the diff before committing.
- **Spec deviation (approved direction, confirm in review):** server-side create validation enforces ONLY client reachability, and only for manual creates (`quote_id is None`). The ≥1-task and every-task-priced invariants stay UI-enforced: the same POST endpoint is the seeding path for legacy imports and for dozens of board-rules tests that intentionally create task-less projects.
- Commit after every task. Frontend suites: `./test_frontend.sh` from root; backend: `./test_backend.sh` from root; single files as shown per task.

## File Structure

**Backend**
- Modify `backend/app/schemas/settings.py` — `openrouter_api_key`, `openrouter_model` on `AppSettings` + `AppSettingsUpdate`.
- Modify `backend/app/api/routes/settings.py` — write-only scrub + API-key sensitivity for the new key.
- Create `backend/app/services/openrouter.py` — `summarize_tasks(db, tasks)` + error types.
- Modify `backend/app/schemas/aito.py` — `AitoSummarizeRequest/Response`.
- Modify `backend/app/api/routes/aito.py` — `POST /aito/summarize`; reachability rule in `create_project`.
- Modify `backend/app/api/routes/zoho.py` — name normalization on `ZohoContactCreate`.
- Create `backend/tests/unit/test_openrouter_service.py`, `backend/tests/unit/test_aito_summarize_route.py`; modify `backend/tests/unit/test_aito_routes.py` (+ regenerate `backend/tests/fixtures/aito_board_payload.json`).

**Frontend**
- Modify `frontend/src/api/client.ts` — `summarizeAitoProject`, settings type fields.
- Modify `frontend/src/components/aito/HoldButton.tsx` — glow / inflate / stay-and-fade / bounce.
- Modify `frontend/src/index.css` — `hold-bounce` keyframes.
- Modify `frontend/src/components/aito/TaskStepFields.tsx` — chip-based services.
- Create `frontend/src/utils/aitoSummary.ts` — `tasksSignature`, `buildFallbackSummary`.
- Create `frontend/src/hooks/useNewProjectDraft.ts` — localStorage persistence.
- Create `frontend/src/components/aito/AiSummaryPanel.tsx` — ✦ panel state machine.
- Create `frontend/src/components/aito/CreateChecklist.tsx` — "Before you create".
- Create `frontend/src/components/aito/NewProjectDrawer.tsx` — the drawer; DELETE `NewProjectModal.tsx`.
- Modify `frontend/src/pages/AitoPage.tsx` — swap-in, walk-in sync skip, draft clear.
- Create `frontend/src/components/AiSettings.tsx`; modify `frontend/src/pages/SettingsPage.tsx` (zoho tab).
- Modify all 8 gate locales in `frontend/src/i18n/locales/`.
- Tests: create `frontend/src/__tests__/components/NewProjectDrawer.test.tsx`, `AiSummaryPanel.test.tsx`, `CreateChecklist.test.tsx`, `useNewProjectDraft.test.ts`; modify `HoldButton` tests (create if absent), `TaskEditor.test.tsx`, `ProjectDetailPanel.test.tsx`, `AitoPageClientSync.test.tsx`; DELETE `NewProjectModal.test.tsx`.

---

### Task 1: OpenRouter settings keys (backend)

**Files:**
- Modify: `backend/app/schemas/settings.py` (Zoho block ends ~line 474; `AppSettingsUpdate` fields ~line 634)
- Modify: `backend/app/api/routes/settings.py` (`_SENSITIVE_FIELDS_FOR_API_KEY` ~line 29; write-only scrub ~line 174)
- Test: `backend/tests/unit/test_openrouter_settings.py` (create)

**Interfaces:**
- Produces: settings keys `openrouter_api_key` (str, default `""`, write-only) and `openrouter_model` (str, default `"mistralai/mistral-small"`), readable via `get_setting(db, "openrouter_api_key")`.

- [ ] **Step 1: Write the failing test**

Look at an existing settings route test for the fixture names (grep `async_client` under `backend/tests/unit/`); the project-wide `async_client` httpx fixture and DB session fixture apply. Create `backend/tests/unit/test_openrouter_settings.py`:

```python
"""OpenRouter settings keys: defaults, write-only API key, API-key scrubbing."""

import pytest


@pytest.mark.anyio
async def test_openrouter_defaults(async_client):
    r = await async_client.get("/api/v1/settings/")
    assert r.status_code == 200
    body = r.json()
    assert body["openrouter_model"] == "mistralai/mistral-small"
    # Write-only: never echoed, even when unset.
    assert body["openrouter_api_key"] == ""


@pytest.mark.anyio
async def test_openrouter_key_write_only(async_client):
    r = await async_client.put(
        "/api/v1/settings/",
        json={"openrouter_api_key": "sk-or-secret", "openrouter_model": "google/gemini-2.5-flash-lite"},
    )
    assert r.status_code == 200
    r = await async_client.get("/api/v1/settings/")
    assert r.json()["openrouter_api_key"] == ""  # scrubbed on every GET
    assert r.json()["openrouter_model"] == "google/gemini-2.5-flash-lite"
```

Match the surrounding tests' auth setup exactly (copy how a neighbouring settings test authenticates or disables auth); if the suite marks anyio differently (e.g. `pytest.mark.asyncio` or a global fixture), copy that convention instead of `pytest.mark.anyio`.

- [ ] **Step 2: Run test to verify it fails**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_openrouter_settings.py -v`
Expected: FAIL — `openrouter_model` missing from response (KeyError / assertion).

- [ ] **Step 3: Implement**

In `backend/app/schemas/settings.py`, directly under the Zoho block (after `zoho_default_contact_name`, ~line 474) add to `AppSettings`:

```python
    # OpenRouter — Aito project-summary generation
    openrouter_api_key: str = Field(default="", description="OpenRouter API key (write-only)")
    openrouter_model: str = Field(
        default="mistralai/mistral-small",
        description="OpenRouter model id used to generate French project summaries",
    )
```

In `AppSettingsUpdate` (next to `zoho_client_id: str | None = None`, ~line 634) add:

```python
    openrouter_api_key: str | None = None
    openrouter_model: str | None = None
```

In `backend/app/api/routes/settings.py`:
- Append `"openrouter_api_key",` to `_SENSITIVE_FIELDS_FOR_API_KEY` (~line 29).
- At the write-only scrub site (~line 174, where `settings_dict["zoho_client_secret"] = ""` and `settings_dict["zoho_refresh_token"] = ""` are set) add on the next line:

```python
    settings_dict["openrouter_api_key"] = ""
```

Check whether `zoho_client_secret` appears anywhere ELSE in `routes/settings.py` (grep the file); mirror `openrouter_api_key` at every such site (e.g. skip-empty-on-PUT logic if one exists) so the two secrets behave identically.

- [ ] **Step 4: Run test to verify it passes**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_openrouter_settings.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Lint and commit**

```bash
ruff check backend/ && ruff format backend/
git add backend/app/schemas/settings.py backend/app/api/routes/settings.py backend/tests/unit/test_openrouter_settings.py
git commit -m "feat(aito): openrouter_api_key (write-only) and openrouter_model settings"
```

---

### Task 2: OpenRouter service module (backend)

**Files:**
- Create: `backend/app/services/openrouter.py`
- Test: `backend/tests/unit/test_openrouter_service.py` (create)

**Interfaces:**
- Consumes: `get_setting(db, key)` from `backend.app.api.routes.settings` (import lazily inside the function — the zoho service does the same, see `backend/app/services/zoho.py:137`).
- Produces:
  - `class OpenRouterNotConfiguredError(Exception)`
  - `class OpenRouterUpstreamError(Exception)`
  - `async def summarize_tasks(db: AsyncSession, tasks: list[dict]) -> tuple[str, str]` — returns `(summary, model_id)`; `tasks` dicts are `AitoTaskCreate.model_dump()` shapes.

- [ ] **Step 1: Write the failing test**

```python
"""OpenRouter summary service: prompt assembly, config gating, upstream errors."""

import httpx
import pytest

from backend.app.services import openrouter
from backend.app.services.openrouter import (
    OpenRouterNotConfiguredError,
    OpenRouterUpstreamError,
    _task_lines,
    summarize_tasks,
)

TASKS = [
    {
        "title": "Capot moteur",
        "description": "fissuré",
        "scan_cost": None,
        "modelisation_cost": None,
        "usinage_cost": None,
        "impression_cost": 120.0,
        "impression_weight_g": 86.0,
        "impression_time_min": 260,
        "impression_quantity": 1,
        "impression_color": "noir",
        "impression_printer_id": 1,
        "impression_filament_id": 2,
        "scan_done": False,
        "modelisation_done": False,
        "impression_done": False,
        "usinage_done": False,
    },
    {"title": "Support antenne", "modelisation_cost": 60.0},
]


def test_task_lines_names_enabled_services_only():
    lines = _task_lines(TASKS)
    assert "Capot moteur" in lines[0]
    assert "impression 3D" in lines[0]
    assert "scan" not in lines[0].lower()
    assert "modélisation 3D" in lines[1]


@pytest.mark.anyio
async def test_summarize_raises_when_unconfigured(db_session):
    with pytest.raises(OpenRouterNotConfiguredError):
        await summarize_tasks(db_session, TASKS)


class _FakeResponse:
    status_code = 200

    def json(self):
        return {"choices": [{"message": {"content": "  Résumé du projet.  "}}]}


class _FakeClient:
    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, json=None):
        _FakeClient.last_json = json
        return _FakeResponse()


@pytest.mark.anyio
async def test_summarize_happy_path(db_session, monkeypatch):
    from backend.app.api.routes.settings import set_setting

    await set_setting(db_session, "openrouter_api_key", "sk-or-test")
    await db_session.commit()
    monkeypatch.setattr(openrouter.httpx, "AsyncClient", _FakeClient)
    summary, model = await summarize_tasks(db_session, TASKS)
    assert summary == "Résumé du projet."
    assert model == "mistralai/mistral-small"
    assert _FakeClient.last_json["model"] == "mistralai/mistral-small"
    # French system prompt rides along
    assert "français" in _FakeClient.last_json["messages"][0]["content"].lower()


class _ErrorResponse:
    status_code = 500
    text = "boom"

    def json(self):
        return {}


@pytest.mark.anyio
async def test_summarize_upstream_error(db_session, monkeypatch):
    from backend.app.api.routes.settings import set_setting

    await set_setting(db_session, "openrouter_api_key", "sk-or-test")
    await db_session.commit()

    class _FailingClient(_FakeClient):
        async def post(self, url, headers=None, json=None):
            return _ErrorResponse()

    monkeypatch.setattr(openrouter.httpx, "AsyncClient", _FailingClient)
    with pytest.raises(OpenRouterUpstreamError):
        await summarize_tasks(db_session, TASKS)
```

Adjust the DB-session fixture name to what the suite provides (grep an existing service test, e.g. under `backend/tests/unit/services/`, for its session fixture) and the async marker convention, as in Task 1.

- [ ] **Step 2: Run test to verify it fails**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_openrouter_service.py -v`
Expected: FAIL — `ModuleNotFoundError: backend.app.services.openrouter`.

- [ ] **Step 3: Implement `backend/app/services/openrouter.py`**

```python
"""OpenRouter chat-completion client for the Aito project summary.

One job: turn a project's task drafts into a short factual French summary.
Configuration lives in the settings table (`openrouter_api_key` is write-only,
`openrouter_model` defaults to mistral-small — cheap and strong in French).
"""

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "mistralai/mistral-small"
TIMEOUT_S = 8.0

# Wire-field -> French service name, in the board's canonical order. Keys match
# AitoTaskCreate; a service is enabled when its cost is not None (0 = free but
# real — same None-vs-0 rule as everywhere else on the board).
_SERVICE_FIELDS = (
    ("scan_cost", "scan 3D"),
    ("modelisation_cost", "modélisation 3D"),
    ("impression_cost", "impression 3D"),
    ("usinage_cost", "usinage"),
)

_SYSTEM_PROMPT = (
    "Tu rédiges des résumés de projets pour un atelier de fabrication 3D en français. "
    "À partir de la liste des tâches, écris 1 à 2 phrases courtes et factuelles décrivant "
    "le travail à réaliser. Pas de prix, pas de formule de politesse, pas de liste à puces : "
    "uniquement le résumé."
)


class OpenRouterNotConfiguredError(Exception):
    """No API key in settings."""


class OpenRouterUpstreamError(Exception):
    """OpenRouter reachable but the call failed."""


def _task_lines(tasks: list[dict]) -> list[str]:
    """One human-readable line per task: title, enabled services, print params."""
    lines: list[str] = []
    for index, task in enumerate(tasks):
        title = (task.get("title") or "").strip() or f"Tâche {index + 1}"
        services = [name for field, name in _SERVICE_FIELDS if task.get(field) is not None]
        parts = [f"{title}: {', '.join(services) if services else 'aucun service'}"]
        if task.get("impression_cost") is not None:
            details = []
            if task.get("impression_color"):
                details.append(str(task["impression_color"]))
            if task.get("impression_weight_g") is not None:
                details.append(f"{task['impression_weight_g']:g} g")
            if task.get("impression_quantity") not in (None, 1):
                details.append(f"x{task['impression_quantity']}")
            if details:
                parts.append(f"({', '.join(details)})")
        description = (task.get("description") or "").strip()
        if description:
            parts.append(f"— {description}")
        lines.append(" ".join(parts))
    return lines


async def summarize_tasks(db: AsyncSession, tasks: list[dict]) -> tuple[str, str]:
    """Returns (summary, model). Raises the two module errors; never returns ""."""
    # Lazy import: settings helpers live in the routes module (house style —
    # see services/zoho.py doing exactly this).
    from backend.app.api.routes.settings import get_setting

    api_key = (await get_setting(db, "openrouter_api_key") or "").strip()
    if not api_key:
        raise OpenRouterNotConfiguredError()
    model = (await get_setting(db, "openrouter_model") or "").strip() or DEFAULT_MODEL

    payload = {
        "model": model,
        "max_tokens": 200,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": "\n".join(_task_lines(tasks))},
        ],
    }
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            response = await client.post(
                OPENROUTER_URL,
                headers={"Authorization": f"Bearer {api_key}"},
                json=payload,
            )
    except httpx.HTTPError as e:
        raise OpenRouterUpstreamError(f"OpenRouter request failed: {e}") from e
    if response.status_code != 200:
        raise OpenRouterUpstreamError(f"OpenRouter returned {response.status_code}")
    try:
        summary = response.json()["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError, ValueError) as e:
        raise OpenRouterUpstreamError("OpenRouter returned an unexpected payload") from e
    if not summary:
        raise OpenRouterUpstreamError("OpenRouter returned an empty summary")
    return summary, model
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_openrouter_service.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint and commit**

```bash
ruff check backend/ && ruff format backend/
git add backend/app/services/openrouter.py backend/tests/unit/test_openrouter_service.py
git commit -m "feat(aito): OpenRouter summary service (mistral-small default, French prompt)"
```

---

### Task 3: `POST /aito/summarize` route (backend)

**Files:**
- Modify: `backend/app/schemas/aito.py` (append near the bottom)
- Modify: `backend/app/api/routes/aito.py` (insert AFTER `create_project`, ~line 453, BEFORE the first `/{project_id}` route at ~455 — route-order constraint)
- Test: `backend/tests/unit/test_aito_summarize_route.py` (create)

**Interfaces:**
- Consumes: `summarize_tasks`, `OpenRouterNotConfiguredError`, `OpenRouterUpstreamError` (Task 2).
- Produces: `POST /api/v1/aito/summarize` — body `{"tasks": [AitoTaskCreate, …]}` (min 1) → `200 {"summary": str, "model": str}` | `409` unconfigured | `502` upstream. Frontend contract for Task 7's `api.summarizeAitoProject`.

- [ ] **Step 1: Write the failing test**

```python
"""POST /aito/summarize: happy path, unconfigured 409, upstream 502."""

import pytest

from backend.app.services import openrouter as openrouter_service


@pytest.mark.anyio
async def test_summarize_unconfigured_409(async_client):
    r = await async_client.post(
        "/api/v1/aito/summarize",
        json={"tasks": [{"title": "Capot", "impression_cost": 120}]},
    )
    assert r.status_code == 409


@pytest.mark.anyio
async def test_summarize_happy(async_client, monkeypatch):
    async def fake(db, tasks):
        assert tasks[0]["title"] == "Capot"
        return "Impression 3D du capot.", "mistralai/mistral-small"

    # Patch the name the ROUTE looks up (import site), not the service module's.
    from backend.app.api.routes import aito as aito_routes

    monkeypatch.setattr(aito_routes, "summarize_tasks", fake)
    r = await async_client.post(
        "/api/v1/aito/summarize",
        json={"tasks": [{"title": "Capot", "impression_cost": 120}]},
    )
    assert r.status_code == 200
    assert r.json() == {"summary": "Impression 3D du capot.", "model": "mistralai/mistral-small"}


@pytest.mark.anyio
async def test_summarize_upstream_502(async_client, monkeypatch):
    async def fake(db, tasks):
        raise openrouter_service.OpenRouterUpstreamError("boom")

    from backend.app.api.routes import aito as aito_routes

    monkeypatch.setattr(aito_routes, "summarize_tasks", fake)
    r = await async_client.post(
        "/api/v1/aito/summarize",
        json={"tasks": [{"title": "Capot", "impression_cost": 120}]},
    )
    assert r.status_code == 502


@pytest.mark.anyio
async def test_summarize_requires_a_task(async_client):
    r = await async_client.post("/api/v1/aito/summarize", json={"tasks": []})
    assert r.status_code == 422
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_summarize_route.py -v`
Expected: FAIL — 404 (route absent).

- [ ] **Step 3: Implement**

`backend/app/schemas/aito.py`, append:

```python
class AitoSummarizeRequest(BaseModel):
    """Task drafts to summarize — the create-drawer sends its local drafts, so
    these are AitoTaskCreate shapes, not persisted rows."""

    tasks: list[AitoTaskCreate] = Field(min_length=1)


class AitoSummarizeResponse(BaseModel):
    summary: str
    model: str
```

`backend/app/api/routes/aito.py`:
- Extend the `backend.app.schemas.aito` import block with `AitoSummarizeRequest, AitoSummarizeResponse` (keep alphabetical order).
- Add `from backend.app.services.openrouter import OpenRouterNotConfiguredError, OpenRouterUpstreamError, summarize_tasks` to the imports.
- Insert directly after `create_project` (after line ~452, before `list_tasks`):

```python
@router.post("/summarize", response_model=AitoSummarizeResponse)
async def summarize_project(
    payload: AitoSummarizeRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE),
):
    """French project summary for the create drawer. Registered before the
    /{project_id} routes on purpose — a literal segment after a parametric
    route would 422 instead of matching."""
    try:
        summary, model = await summarize_tasks(db, [t.model_dump() for t in payload.tasks])
    except OpenRouterNotConfiguredError:
        raise HTTPException(status_code=409, detail="OpenRouter is not configured") from None
    except OpenRouterUpstreamError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return AitoSummarizeResponse(summary=summary, model=model)
```

- [ ] **Step 4: Run tests**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_summarize_route.py backend/tests/unit/test_aito_routes.py -v`
Expected: new tests PASS; existing aito route tests still PASS (route ordering intact).

- [ ] **Step 5: Lint and commit**

```bash
ruff check backend/ && ruff format backend/
git add backend/app/schemas/aito.py backend/app/api/routes/aito.py backend/tests/unit/test_aito_summarize_route.py
git commit -m "feat(aito): POST /aito/summarize route"
```

---

### Task 4: Create-route reachability rule + contact-name normalization (backend)

**Files:**
- Modify: `backend/app/api/routes/aito.py` (`create_project`, ~line 377)
- Modify: `backend/app/api/routes/zoho.py` (`ZohoContactCreate`, ~line 119)
- Modify: `backend/tests/unit/test_aito_routes.py` (seed payloads)
- Modify: `backend/tests/fixtures/aito_board_payload.json` (regenerated)

**Interfaces:**
- Produces: `POST /api/v1/aito/` returns `400` when `quote_id is None` and both `client_phone`/`client_email` are blank. `ZohoContactCreate` normalizes `first_name` to Title-Case segments and `last_name` to uppercase before any consumer sees them.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/unit/test_aito_routes.py` (reuse its `_create` helper — note `_create` already sends a phone, so existing calls stay valid):

```python
@pytest.mark.anyio
async def test_create_requires_phone_or_email(async_client):
    r = await _create(async_client, client_phone=None, client_email=None)
    assert r.status_code == 400
    assert "phone or an email" in r.json()["detail"]


@pytest.mark.anyio
async def test_create_email_only_is_reachable(async_client):
    r = await _create(async_client, client_phone=None, client_email="a@b.pf")
    assert r.status_code == 201


@pytest.mark.anyio
async def test_import_shape_bypasses_reachability(async_client):
    # A quote-import create carries quote_id; Zoho contacts may lack both
    # channels and importing an existing quote must never be blocked.
    r = await _create(
        async_client, client_phone=None, client_email=None, quote_id="q-1", quote_number="EST-1", quote_status="draft"
    )
    assert r.status_code == 201
```

And a normalization test in the file that already tests `POST /zoho/contacts` (grep `contacts` under `backend/tests/unit/`; if none tests the create path, add to `test_aito_routes.py`):

```python
@pytest.mark.anyio
async def test_contact_create_normalizes_names(async_client, monkeypatch):
    captured = {}

    async def fake_create_contact(db, company_name, first_name, last_name, email, phone):
        captured.update(first_name=first_name, last_name=last_name)
        return {"id": "c1", "name": f"{first_name} {last_name}", "phone": phone, "email": email, "is_company": False}

    monkeypatch.setattr(zoho_service, "create_contact", fake_create_contact)
    r = await async_client.post(
        "/api/v1/zoho/contacts",
        json={"first_name": "jean-pierre", "last_name": "dupont", "phone": "+689 87 12 34 56"},
    )
    assert r.status_code == 201
    assert captured["first_name"] == "Jean-Pierre"
    assert captured["last_name"] == "DUPONT"
```

Match `fake_create_contact`'s return shape to what `zoho_service.create_contact` really returns (open `backend/app/services/zoho.py` and copy the ZohoContact fields).

- [ ] **Step 2: Run to verify failures**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_routes.py -v -k "reachab or reachability or phone_or_email or normalizes or bypasses"`
Expected: the new tests FAIL (create currently 201s without contact; names pass through unmodified).

- [ ] **Step 3: Implement**

In `create_project` (`routes/aito.py`), immediately after `await _reject_duplicate_quote(db, payload.quote_id)`:

```python
    if payload.quote_id is None and not (
        (payload.client_phone or "").strip() or (payload.client_email or "").strip()
    ):
        # Every hand-created project must be reachable — walk-in included, whose
        # coordinates live on the project row rather than in Zoho. Imports are
        # exempt: an existing Zoho quote's contact may carry neither channel.
        raise HTTPException(status_code=400, detail="Client must have a phone or an email")
```

In `routes/zoho.py`, add a module-level helper above `ZohoContactCreate` and a normalizing validator inside it (it already has a `@model_validator(mode="after")` named `check_name` — add a separate one BEFORE it in source order):

```python
def _title_case_segments(value: str) -> str:
    """'jean-pierre  le roux' -> 'Jean-Pierre Le Roux' — mirrors
    frontend/src/utils/clientDraft.ts:titleCaseSegments (split on spaces and
    hyphens, capitalize each segment, keep the separators)."""
    import re

    parts = re.split(r"([ -]+)", value.strip())
    return "".join(p if i % 2 else p[:1].upper() + p[1:].lower() for i, p in enumerate(parts))
```

```python
    @model_validator(mode="after")
    def normalize_person_name(self):
        """House convention 'Jean-Pierre DUPONT', enforced server-side so no
        caller can bypass what the drawer's form promises."""
        self.first_name = _title_case_segments(self.first_name)
        self.last_name = self.last_name.strip().upper()
        return self
```

- [ ] **Step 4: Repair existing seeds and regenerate the golden fixture**

Grep `test_aito_routes.py` for every `client.post("/api/v1/aito/"` (and any other test file posting that path: `grep -rn '"/api/v1/aito/"' backend/tests/`). For each payload with `quote_id` absent AND no `client_phone`/`client_email`, add `"client_phone": "+689 87 00 00 01"` (vary the last digits per seed so the golden diff stays readable). Then:

```bash
REGENERATE_GOLDEN=1 ./venv/bin/python3 -m pytest backend/tests/unit/test_aito_routes.py -v
git diff backend/tests/fixtures/aito_board_payload.json
```

Read the diff: ONLY `client_phone` values may change. Anything else changing means a seed was altered beyond adding a phone — fix before proceeding.

- [ ] **Step 5: Run the full backend aito surface**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/ -v -k aito`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
ruff check backend/ && ruff format backend/
git add backend/app/api/routes/aito.py backend/app/api/routes/zoho.py backend/tests/unit/test_aito_routes.py backend/tests/fixtures/aito_board_payload.json
git commit -m "feat(aito): phone-or-email required on manual create; server-side contact name normalization"
```

---

### Task 5: API client additions (frontend)

**Files:**
- Modify: `frontend/src/api/client.ts`

**Interfaces:**
- Consumes: Task 3's route.
- Produces:
  - `interface AitoSummarizeResponse { summary: string; model: string }`
  - `api.summarizeAitoProject(tasks: AitoTaskCreate[]): Promise<AitoSummarizeResponse>`
  - `AppSettings`/`AppSettingsUpdate` types gain `openrouter_api_key: string` / `openrouter_model: string` (optional in the update type), matching however `zoho_client_id` is declared there.

- [ ] **Step 1: Implement (no isolated unit test — the typed client is exercised by every consumer test)**

In `frontend/src/api/client.ts`: locate `createAitoProject` (grep) and add beside it, following the file's existing fetch-wrapper idiom exactly (same helper the sibling aito calls use):

```typescript
export interface AitoSummarizeResponse {
  summary: string;
  model: string;
}
```

```typescript
  summarizeAitoProject: (tasks: AitoTaskCreate[]): Promise<AitoSummarizeResponse> =>
    request(`/aito/summarize`, { method: 'POST', body: JSON.stringify({ tasks }) }),
```

(Adapt `request(...)` to the file's real helper name/signature — copy the neighbouring `createAitoProject` line's shape verbatim.) Then grep `zoho_client_id` in the same file and add `openrouter_api_key` / `openrouter_model` wherever the settings types declare the zoho fields, with the same optionality.

- [ ] **Step 2: Verify compile**

Run: `cd frontend && npx tsc -b --noEmit 2>/dev/null || npm run build; cd ..`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/client.ts
git commit -m "feat(aito): summarizeAitoProject API client + openrouter settings types"
```

---

### Task 6: HoldButton choreography (frontend, shared)

**Files:**
- Modify: `frontend/src/components/aito/HoldButton.tsx`
- Modify: `frontend/src/index.css`
- Test: `frontend/src/__tests__/components/HoldButton.test.tsx` (extend; create if absent — check first)

**Interfaces:**
- Produces (behavioral, no API change — every existing caller upgrades for free):
  - While holding: wrapper div scales to `1.08` over the full hold duration; progress stroke/bar glows (`drop-shadow` in `currentColor`).
  - On completion: progress stays at 100% and fades out (no rewind) while the wrapper plays `animate-hold-bounce`; `onHold` still fires immediately at completion.
  - Early release: unchanged (instant rewind + tap hint logic).
  - `motion-reduce`: no inflate, no bounce; progress behavior unchanged.

- [ ] **Step 1: Write the failing test**

If `HoldButton.test.tsx` exists, extend it; otherwise create with this shape (fake timers drive the hold):

```tsx
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, act } from '@testing-library/react';
import { HoldButton } from '../../components/aito/HoldButton';

function renderPerimeter(onHold = vi.fn()) {
  render(
    <HoldButton onHold={onHold} durationMs={500} label="reset" hint="hold" progress="perimeter">
      x
    </HoldButton>,
  );
  return onHold;
}

describe('HoldButton completion choreography', () => {
  it('inflates the wrapper while holding', () => {
    vi.useFakeTimers();
    renderPerimeter();
    const button = screen.getByRole('button', { name: 'reset' });
    fireEvent.pointerDown(button);
    expect(button.parentElement!.className).toContain('scale-[1.08]');
    fireEvent.pointerUp(button);
    expect(button.parentElement!.className).not.toContain('scale-[1.08]');
    vi.useRealTimers();
  });

  it('on completion keeps progress full, fades it, bounces, and fires onHold', () => {
    vi.useFakeTimers();
    const onHold = renderPerimeter();
    const button = screen.getByRole('button', { name: 'reset' });
    fireEvent.pointerDown(button);
    act(() => vi.advanceTimersByTime(500));
    expect(onHold).toHaveBeenCalledOnce();
    const path = screen.getByTestId('hold-progress-perimeter').querySelector('path')!;
    expect(path.getAttribute('stroke-dashoffset')).toBe('0'); // stays full, no rewind
    expect(path.className.baseVal).toContain('transition-[stroke-opacity]');
    expect(button.parentElement!.className).toContain('animate-hold-bounce');
    act(() => vi.advanceTimersByTime(700)); // choreography window ends
    expect(button.parentElement!.className).not.toContain('animate-hold-bounce');
    vi.useRealTimers();
  });
});
```

Note: the perimeter SVG only renders once the button has a measured box; in jsdom `offsetWidth` is 0 but the `box` state is still set — if the SVG is absent, mock `offsetWidth`/`offsetHeight` on `HTMLElement.prototype` in the test (`Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 40 })`, same for height) before rendering.

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/__tests__/components/HoldButton.test.tsx; cd ..`
Expected: FAIL — no `scale-[1.08]`, no `animate-hold-bounce`, dashoffset rewound.

- [ ] **Step 3: Implement**

`frontend/src/index.css` — add near the existing keyframe definitions (grep `@keyframes` to find the block):

```css
/* HoldButton completion: a damped spring — each swing loses roughly half its
   amplitude, peaks softened by the ease-in-out between keyframes. */
@keyframes hold-bounce {
  0% { transform: scale(1.08); }
  15% { transform: scale(0.94); }
  32% { transform: scale(1.04); }
  50% { transform: scale(0.985); }
  68% { transform: scale(1.006); }
  84% { transform: scale(0.998); }
  100% { transform: scale(1); }
}
.animate-hold-bounce {
  animation: hold-bounce 0.65s ease-in-out;
}
@media (prefers-reduced-motion: reduce) {
  .animate-hold-bounce {
    animation: none;
  }
}
```

`HoldButton.tsx`:

1. New state + cleanup beside `holding`:

```tsx
  const [completed, setCompleted] = useState(false);
  const completeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

Clear `completeTimerRef` in the existing unmount effect.

2. In `startHold`'s timeout callback, replace `setHolding(false); onHold();` with:

```tsx
      setHolding(false);
      setCompleted(true);
      if (completeTimerRef.current) clearTimeout(completeTimerRef.current);
      completeTimerRef.current = setTimeout(() => setCompleted(false), 700);
      onHold();
```

3. Wrapper div (`<div className="relative">`) becomes the inflate/bounce stage — transform lives here so it cannot fight the button's own `transition-[color,…]` utility:

```tsx
    <div
      className={`relative motion-safe:transition-transform motion-safe:ease-linear ${
        holding ? 'scale-[1.08]' : ''
      } ${completed ? 'animate-hold-bounce' : ''}`}
      style={{ transitionDuration: holding ? `${durationMs}ms` : '150ms' }}
    >
```

4. Perimeter `<path>`: keep progress full through the completion window and fade instead of rewinding; add the glow while active:

```tsx
            strokeDashoffset={holding || completed ? 0 : 1}
            strokeOpacity={holding ? 1 : 0}
            style={holding || completed ? { filter: 'drop-shadow(0 0 3px currentColor)' } : undefined}
            className={
              holding
                ? PERIMETER_DURATION_CLS[durationMs]
                : completed
                  ? 'transition-[stroke-opacity] duration-500 ease-out'
                  : 'transition-none'
            }
```

5. Same treatment for the other two variants so every HoldButton in the app shares the choreography:
   - ring `<circle>`: `strokeDashoffset={holding || completed ? 0 : HOLD_CIRCUMFERENCE}`, add `strokeOpacity={holding ? 1 : completed ? 0 : 1}` with the same conditional `transition-[stroke-opacity] duration-500 ease-out` class when `completed`, and the same conditional glow `style`.
   - bar `<span>`: `holding || completed ? 'scale-x-100' : 'scale-x-0'`; when `completed`, add `opacity-0 transition-opacity duration-500 ease-out` (keep `transition-none` for the rest state); glow via the same `style` conditional.
   Keep each element's class string assembled from complete literals (no interpolation).

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/__tests__/components/HoldButton.test.tsx && npx vitest run src/__tests__/components 2>&1 | tail -5; cd ..`
Expected: new tests PASS; existing consumers (DeleteHoldButton, QuoteStatusActions, board/grid actions tests) still PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/aito/HoldButton.tsx frontend/src/index.css frontend/src/__tests__/components/HoldButton.test.tsx
git commit -m "feat(aito): HoldButton glow, inflate, stay-and-fade progress, damped bounce"
```

---

### Task 7: i18n keys — all 8 gate locales

**Files:**
- Modify: `frontend/src/i18n/locales/en.ts`, `fr.ts`, `de.ts`, `it.ts`, `ja.ts`, `pt-BR.ts`, `zh-CN.ts`, `zh-TW.ts`

**Interfaces:**
- Produces: every key below, consumed verbatim by Tasks 8–13. Keys live inside the existing `aito: { … }` object (and `settings: { … }` for the last four).

- [ ] **Step 1: Add the keys**

Add to EVERY one of the 8 files, translated as follows (en / fr shown in full; the six other locales use the table's row for that locale — these are real translations, required by the parity gate). Alphabetize within each file only if the file already does; otherwise append as a labelled block.

`en.ts` — inside `aito:`:

```typescript
    workSection: 'The work',
    clientSectionTitle: 'Client',
    workHintNone: 'no tasks yet',
    workHintProgress: '{{done}} of {{total}} complete',
    addService: 'Add {{service}}',
    removeServiceChip: 'Remove {{service}}',
    taskNeedsSubTask: 'add a sub-task',
    railSummary: 'Summary',
    summaryTitle: 'Project summary',
    summaryWaiting: 'Generated when you reach the client step.',
    summaryGeneratedBy: 'Generated by {{model}} — click to edit',
    summaryEdited: 'Edited by hand — no longer auto-regenerated',
    summaryFallback: 'AI unavailable — write the description yourself',
    regenerate: 'Regenerate',
    beforeCreate: 'Before you create',
    ruleTasksOk_one: '{{count}} task — at least one required',
    ruleTasksOk_other: '{{count}} tasks — at least one required',
    ruleNeedTask: 'A project needs at least one task — add one',
    ruleSubTasksOk: 'Every task has a priced sub-task',
    ruleSubTaskMissing: '"{{name}}" needs at least one priced sub-task',
    ruleSubTasksPending: 'Each task needs at least one priced sub-task',
    ruleClientAccount: 'Client account — {{name}}',
    ruleClientReachable: 'Client reachable — {{contact}}',
    ruleClientContact: 'Client needs a phone or an email',
    warnNoEmail: "No email — the quote can't be emailed",
    warnNoPhone: 'No phone — remember to ask for it',
    holdToReset: 'Hold to reset the draft',
    resetDraft: 'Reset draft',
```

`en.ts` — inside `settings:`:

```typescript
    openrouterTitle: 'AI summary (OpenRouter)',
    openrouterApiKey: 'OpenRouter API key',
    openrouterApiKeyHint: 'Write-only — leave blank to keep the current key',
    openrouterModel: 'Model',
    openrouterModelHint: 'OpenRouter model id used for project summaries (French)',
```

`fr.ts` — `aito:`:

```typescript
    workSection: 'Le travail',
    clientSectionTitle: 'Client',
    workHintNone: 'aucune tâche',
    workHintProgress: '{{done}} sur {{total}} complètes',
    addService: 'Ajouter {{service}}',
    removeServiceChip: 'Retirer {{service}}',
    taskNeedsSubTask: 'ajouter une sous-tâche',
    railSummary: 'Récapitulatif',
    summaryTitle: 'Résumé du projet',
    summaryWaiting: "Généré quand vous passez à l'étape client.",
    summaryGeneratedBy: 'Généré par {{model}} — cliquez pour modifier',
    summaryEdited: 'Modifié à la main — plus de régénération automatique',
    summaryFallback: 'IA indisponible — rédigez la description vous-même',
    regenerate: 'Régénérer',
    beforeCreate: 'Avant de créer',
    ruleTasksOk_one: '{{count}} tâche — au moins une requise',
    ruleTasksOk_other: '{{count}} tâches — au moins une requise',
    ruleNeedTask: 'Un projet doit avoir au moins une tâche — ajoutez-en une',
    ruleSubTasksOk: 'Chaque tâche a une sous-tâche chiffrée',
    ruleSubTaskMissing: '« {{name}} » doit avoir au moins une sous-tâche chiffrée',
    ruleSubTasksPending: 'Chaque tâche doit avoir au moins une sous-tâche chiffrée',
    ruleClientAccount: 'Compte client — {{name}}',
    ruleClientReachable: 'Client joignable — {{contact}}',
    ruleClientContact: 'Le client doit avoir un téléphone ou un email',
    warnNoEmail: "Pas d'email — le devis ne pourra pas être envoyé par mail",
    warnNoPhone: 'Pas de téléphone — pensez à le demander',
    holdToReset: 'Maintenir pour réinitialiser le brouillon',
    resetDraft: 'Réinitialiser le brouillon',
```

`fr.ts` — `settings:`:

```typescript
    openrouterTitle: 'Résumé IA (OpenRouter)',
    openrouterApiKey: 'Clé API OpenRouter',
    openrouterApiKeyHint: 'Écriture seule — laisser vide pour conserver la clé actuelle',
    openrouterModel: 'Modèle',
    openrouterModelHint: 'Identifiant du modèle OpenRouter pour les résumés de projet (français)',
```

`de.ts`: workSection `'Die Arbeit'`; clientSectionTitle `'Kunde'`; workHintNone `'noch keine Aufgaben'`; workHintProgress `'{{done}} von {{total}} vollständig'`; addService `'{{service}} hinzufügen'`; removeServiceChip `'{{service}} entfernen'`; taskNeedsSubTask `'Teilaufgabe hinzufügen'`; railSummary `'Übersicht'`; summaryTitle `'Projektzusammenfassung'`; summaryWaiting `'Wird beim Kundenschritt erzeugt.'`; summaryGeneratedBy `'Erzeugt von {{model}} — zum Bearbeiten klicken'`; summaryEdited `'Von Hand bearbeitet — keine automatische Neuerzeugung mehr'`; summaryFallback `'KI nicht verfügbar — Beschreibung selbst schreiben'`; regenerate `'Neu erzeugen'`; beforeCreate `'Vor dem Erstellen'`; ruleTasksOk_one `'{{count}} Aufgabe — mindestens eine erforderlich'`; ruleTasksOk_other `'{{count}} Aufgaben — mindestens eine erforderlich'`; ruleNeedTask `'Ein Projekt braucht mindestens eine Aufgabe — eine hinzufügen'`; ruleSubTasksOk `'Jede Aufgabe hat eine bepreiste Teilaufgabe'`; ruleSubTaskMissing `'„{{name}}“ braucht mindestens eine bepreiste Teilaufgabe'`; ruleSubTasksPending `'Jede Aufgabe braucht mindestens eine bepreiste Teilaufgabe'`; ruleClientAccount `'Kundenkonto — {{name}}'`; ruleClientReachable `'Kunde erreichbar — {{contact}}'`; ruleClientContact `'Der Kunde braucht Telefon oder E-Mail'`; warnNoEmail `'Keine E-Mail — das Angebot kann nicht gemailt werden'`; warnNoPhone `'Keine Telefonnummer — daran denken, sie zu erfragen'`; holdToReset `'Halten, um den Entwurf zurückzusetzen'`; resetDraft `'Entwurf zurücksetzen'`; settings: openrouterTitle `'KI-Zusammenfassung (OpenRouter)'`; openrouterApiKey `'OpenRouter-API-Schlüssel'`; openrouterApiKeyHint `'Nur Schreiben — leer lassen, um den aktuellen Schlüssel zu behalten'`; openrouterModel `'Modell'`; openrouterModelHint `'OpenRouter-Modell-ID für Projektzusammenfassungen (Französisch)'`.

`it.ts`: `'Il lavoro'`; `'Cliente'`; `'nessuna attività'`; `'{{done}} di {{total}} complete'`; `'Aggiungi {{service}}'`; `'Rimuovi {{service}}'`; `'aggiungi una sotto-attività'`; `'Riepilogo'`; `'Riassunto del progetto'`; `'Generato quando passi al cliente.'`; `'Generato da {{model}} — clicca per modificare'`; `'Modificato a mano — niente più rigenerazione automatica'`; `'IA non disponibile — scrivi tu la descrizione'`; `'Rigenera'`; `'Prima di creare'`; `'{{count}} attività — almeno una richiesta'` (both `_one` and `_other`); `'Un progetto richiede almeno una attività — aggiungine una'`; `'Ogni attività ha una sotto-attività quotata'`; `'"{{name}}" richiede almeno una sotto-attività quotata'`; `'Ogni attività richiede almeno una sotto-attività quotata'`; `'Account cliente — {{name}}'`; `'Cliente raggiungibile — {{contact}}'`; `'Il cliente deve avere telefono o email'`; `'Nessuna email — il preventivo non potrà essere inviato via mail'`; `'Nessun telefono — ricordati di chiederlo'`; `'Tieni premuto per azzerare la bozza'`; `'Azzera bozza'`; settings: `'Riassunto IA (OpenRouter)'`; `'Chiave API OpenRouter'`; `'Sola scrittura — lascia vuoto per mantenere la chiave attuale'`; `'Modello'`; `'ID modello OpenRouter per i riassunti di progetto (francese)'`.

`ja.ts`: `'作業内容'`; `'顧客'`; `'タスクなし'`; `'{{total}}件中{{done}}件完了'`; `'{{service}}を追加'`; `'{{service}}を削除'`; `'サブタスクを追加'`; `'概要'`; `'プロジェクト要約'`; `'顧客ステップに進むと生成されます。'`; `'{{model}}が生成 — クリックで編集'`; `'手動編集済み — 自動再生成は停止'`; `'AIを利用できません — 説明を手動で入力してください'`; `'再生成'`; `'作成前の確認'`; ruleTasksOk_one `'タスク{{count}}件 — 最低1件必要'`; ruleTasksOk_other `'タスク{{count}}件 — 最低1件必要'`; `'プロジェクトには最低1件のタスクが必要です — 追加してください'`; `'すべてのタスクに価格付きサブタスクがあります'`; `'「{{name}}」には価格付きサブタスクが最低1件必要です'`; `'各タスクには価格付きサブタスクが最低1件必要です'`; `'顧客アカウント — {{name}}'`; `'連絡可能 — {{contact}}'`; `'顧客に電話またはメールが必要です'`; `'メールなし — 見積をメール送信できません'`; `'電話なし — 忘れずに確認してください'`; `'長押しで下書きをリセット'`; `'下書きをリセット'`; settings: `'AI要約（OpenRouter）'`; `'OpenRouter APIキー'`; `'書き込み専用 — 空欄で現在のキーを維持'`; `'モデル'`; `'プロジェクト要約に使うOpenRouterモデルID（フランス語）'`.

`pt-BR.ts`: `'O trabalho'`; `'Cliente'`; `'nenhuma tarefa'`; `'{{done}} de {{total}} completas'`; `'Adicionar {{service}}'`; `'Remover {{service}}'`; `'adicionar uma subtarefa'`; `'Resumo'`; `'Resumo do projeto'`; `'Gerado quando você chega à etapa do cliente.'`; `'Gerado por {{model}} — clique para editar'`; `'Editado à mão — sem regeneração automática'`; `'IA indisponível — escreva a descrição você mesmo'`; `'Regenerar'`; `'Antes de criar'`; `'{{count}} tarefa — pelo menos uma obrigatória'` / `'{{count}} tarefas — pelo menos uma obrigatória'`; `'Um projeto precisa de pelo menos uma tarefa — adicione uma'`; `'Toda tarefa tem uma subtarefa precificada'`; `'"{{name}}" precisa de pelo menos uma subtarefa precificada'`; `'Cada tarefa precisa de pelo menos uma subtarefa precificada'`; `'Conta do cliente — {{name}}'`; `'Cliente contactável — {{contact}}'`; `'O cliente precisa de telefone ou e-mail'`; `'Sem e-mail — o orçamento não poderá ser enviado por e-mail'`; `'Sem telefone — lembre-se de pedir'`; `'Segure para redefinir o rascunho'`; `'Redefinir rascunho'`; settings: `'Resumo de IA (OpenRouter)'`; `'Chave de API OpenRouter'`; `'Somente escrita — deixe em branco para manter a chave atual'`; `'Modelo'`; `'ID do modelo OpenRouter para resumos de projeto (francês)'`.

`zh-CN.ts`: `'工作内容'`; `'客户'`; `'暂无任务'`; `'已完成 {{done}}/{{total}}'`; `'添加{{service}}'`; `'移除{{service}}'`; `'添加子任务'`; `'摘要'`; `'项目摘要'`; `'进入客户步骤时自动生成。'`; `'由 {{model}} 生成 — 点击编辑'`; `'已手动编辑 — 不再自动重新生成'`; `'AI 不可用 — 请自行填写描述'`; `'重新生成'`; `'创建前检查'`; ruleTasksOk_one `'{{count}} 个任务 — 至少需要一个'`; ruleTasksOk_other `'{{count}} 个任务 — 至少需要一个'`; `'项目至少需要一个任务 — 请添加'`; `'每个任务都有已定价的子任务'`; `'“{{name}}”至少需要一个已定价的子任务'`; `'每个任务至少需要一个已定价的子任务'`; `'客户账户 — {{name}}'`; `'客户可联系 — {{contact}}'`; `'客户需要电话或邮箱'`; `'没有邮箱 — 报价单无法通过邮件发送'`; `'没有电话 — 记得询问'`; `'长按以重置草稿'`; `'重置草稿'`; settings: `'AI 摘要（OpenRouter）'`; `'OpenRouter API 密钥'`; `'只写 — 留空以保留当前密钥'`; `'模型'`; `'用于项目摘要的 OpenRouter 模型 ID（法语）'`.

`zh-TW.ts`: `'工作內容'`; `'客戶'`; `'尚無任務'`; `'已完成 {{done}}/{{total}}'`; `'新增{{service}}'`; `'移除{{service}}'`; `'新增子任務'`; `'摘要'`; `'專案摘要'`; `'進入客戶步驟時自動產生。'`; `'由 {{model}} 產生 — 點擊編輯'`; `'已手動編輯 — 不再自動重新產生'`; `'AI 無法使用 — 請自行填寫描述'`; `'重新產生'`; `'建立前檢查'`; ruleTasksOk_one `'{{count}} 個任務 — 至少需要一個'`; ruleTasksOk_other `'{{count}} 個任務 — 至少需要一個'`; `'專案至少需要一個任務 — 請新增'`; `'每個任務都有已定價的子任務'`; `'「{{name}}」至少需要一個已定價的子任務'`; `'每個任務至少需要一個已定價的子任務'`; `'客戶帳戶 — {{name}}'`; `'客戶可聯繫 — {{contact}}'`; `'客戶需要電話或電子郵件'`; `'沒有電子郵件 — 報價單無法以郵件寄送'`; `'沒有電話 — 記得詢問'`; `'長按以重設草稿'`; `'重設草稿'`; settings: `'AI 摘要（OpenRouter）'`; `'OpenRouter API 金鑰'`; `'唯寫 — 留空以保留目前金鑰'`; `'模型'`; `'用於專案摘要的 OpenRouter 模型 ID（法語）'`.

Keys identical across locales by nature (`clientSectionTitle: 'Client'` in en/fr) may trip the identical-to-en check — if the gate flags one, add it to `IDENTICAL_TO_EN_ALLOWED` in `frontend/scripts/check-i18n-parity.mjs` with a one-line justification comment (it is the real French word).

- [ ] **Step 2: Run the parity gate**

Run: `cd frontend && npm run check:i18n; cd ..`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/i18n/locales/ frontend/scripts/check-i18n-parity.mjs
git commit -m "feat(aito): i18n keys for the new-project drawer (8 locales)"
```

---

### Task 8: Chip-based `TaskStepFields` (frontend, shared)

**Files:**
- Modify: `frontend/src/components/aito/TaskStepFields.tsx`
- Modify: `frontend/src/__tests__/components/TaskEditor.test.tsx`, `frontend/src/__tests__/components/ProjectDetailPanel.test.tsx` (whatever asserts the four always-present fieldsets)

**Interfaces:**
- Consumes: `TaskDraft` (unchanged), existing i18n service-name keys `aito.serviceScan3D`, `aito.serviceModelisation3D`, `aito.serviceImpression3D`, `aito.serviceUsinage`; new keys `aito.addService`, `aito.removeServiceChip` (Task 7).
- Produces: same component signature `TaskStepFields({ task, onChange, disabled })`. New DOM contract: a chip row (`role="button"` chips labelled `Add <service>` when off); an enabled service renders its price input; a chip toggled off calls `onChange` with that cost set to `null`. Null-vs-0 semantics untouched: cost stays `null` until the user types.

- [ ] **Step 1: Write the failing test**

Add to `TaskEditor.test.tsx` (which mounts rows through `TaskEditor`, exercising `TaskStepFields` in edit mode; follow the file's existing render/helpers):

```tsx
it('starts with chips only and reveals a price input when a service chip is enabled', async () => {
  // renderEditor: this file's existing helper that mounts TaskEditor with one
  // empty draft task in edit mode — reuse it.
  renderEditor([emptyTaskDraft()]);
  // No cost inputs while every service is disabled:
  expect(screen.queryByLabelText(/Scan 3D.*cost/i)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Add Scan 3D' }));
  const input = screen.getByLabelText(/Scan 3D.*cost/i);
  expect(input).toHaveValue(null); // enabling does NOT invent a price
});

it('disabling a chip clears the cost to null', async () => {
  const task = { ...emptyTaskDraft(), scanCost: 45 };
  const onChange = renderEditorAndCaptureOnChange([task]);
  await userEvent.click(screen.getByRole('button', { name: 'Remove Scan 3D' }));
  expect(lastChangedTask(onChange).scanCost).toBeNull();
});
```

Adapt helper names to what the test file actually provides (read it first); the assertions are the contract. The existing aria-label on `CostInput` is `` `${label} ${t('aito.serviceCost')}` `` — keep it so the `/cost/i` queries work.

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/__tests__/components/TaskEditor.test.tsx; cd ..`
Expected: new tests FAIL (all four fieldsets currently always render).

- [ ] **Step 3: Implement**

Rework `TaskStepFields.tsx`. Keep: the title input, description textarea, `CostInput`, `ImpressionFields` wiring, the task-total footer, the `<fieldset disabled={disabled}>` wrapper. Replace the four `StepBlock`s with:

```tsx
type ServiceId = 'scan' | 'modelisation' | 'impression' | 'usinage';

const SERVICE_DEFS: { id: ServiceId; labelKey: string; costKey: 'scanCost' | 'modelisationCost' | 'usinageCost' | 'impressionCost' }[] = [
  { id: 'scan', labelKey: 'aito.serviceScan3D', costKey: 'scanCost' },
  { id: 'modelisation', labelKey: 'aito.serviceModelisation3D', costKey: 'modelisationCost' },
  { id: 'impression', labelKey: 'aito.serviceImpression3D', costKey: 'impressionCost' },
  { id: 'usinage', labelKey: 'aito.serviceUsinage', costKey: 'usinageCost' },
];
```

Component state: chips reflect UI presence, seeded from the draft so persisted/priced services open enabled:

```tsx
  const [enabled, setEnabled] = useState<Set<ServiceId>>(
    () => new Set(SERVICE_DEFS.filter((s) => task[s.costKey] !== null).map((s) => s.id)),
  );

  const toggleService = (svc: (typeof SERVICE_DEFS)[number]) => {
    setEnabled((current) => {
      const next = new Set(current);
      if (next.delete(svc.id)) {
        // Chip off = the service stops existing: null, never 0.
        onChange({ ...task, [svc.costKey]: null });
      } else {
        next.add(svc.id);
      }
      return next;
    });
  };
```

Chip row (complete literal classes; green solid when on, dashed ghost when off — visual reference `hybrid-drawer-v10.html`):

```tsx
      <div className="flex flex-wrap gap-2">
        {SERVICE_DEFS.map((svc) => {
          const on = enabled.has(svc.id);
          const label = t(svc.labelKey);
          return (
            <button
              key={svc.id}
              type="button"
              aria-pressed={on}
              aria-label={t(on ? 'aito.removeServiceChip' : 'aito.addService', { service: label })}
              onClick={() => toggleService(svc)}
              className={
                on
                  ? `inline-flex items-center gap-1.5 rounded-full border border-bambu-green/60 bg-bambu-green/10 px-3 py-1.5 text-xs font-semibold text-bambu-green-light transition-colors ${focusRingCls}`
                  : `inline-flex items-center gap-1.5 rounded-full border border-dashed border-bambu-dark-tertiary px-3 py-1.5 text-xs font-semibold text-bambu-gray transition-colors hover:border-bambu-green/50 hover:text-bambu-green-light ${focusRingCls}`
              }
            >
              {!on && <Plus className="w-3 h-3" />}
              {label}
            </button>
          );
        })}
      </div>
```

(Import `Plus` from `lucide-react` and `focusRingCls` from `../formStyles`.)

Below the chip row, render ONLY enabled services, each as the existing `StepBlock` (keep `StepBlock`, drop its `dim` state — a rendered block is always "present"): scan/modelisation/usinage blocks contain just their `CostInput` (`autoFocus` when the chip was enabled this render — track with a `justEnabledRef` set inside `toggleService` and cleared after use); the impression block keeps its `CostInput` + `ImpressionFields` exactly as today. `hasPricedService`/validation still key off cost-null — a chip on with an empty input is deliberately still "unpriced".

- [ ] **Step 4: Run and repair the shared surface**

Run: `cd frontend && npx vitest run src/__tests__/components/TaskEditor.test.tsx src/__tests__/components/ProjectDetailPanel.test.tsx src/__tests__/components/NewProjectModal.test.tsx; cd ..`
Fix fallout mechanically: any old test asserting a disabled/dimmed fieldset for an absent service now asserts the chip instead (`getByRole('button', { name: 'Add Modélisation 3D' })`). Do not weaken assertions about null-vs-0.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/aito/TaskStepFields.tsx frontend/src/__tests__/components/
git commit -m "feat(aito): chip-based progressive service editing in TaskStepFields"
```

---

### Task 9: Summary utils + draft persistence hook (frontend)

**Files:**
- Create: `frontend/src/utils/aitoSummary.ts`
- Create: `frontend/src/hooks/useNewProjectDraft.ts`
- Test: `frontend/src/__tests__/utils/aitoSummary.test.ts`, `frontend/src/__tests__/hooks/useNewProjectDraft.test.ts` (create; put them wherever sibling util/hook tests live — check `frontend/src/__tests__/` layout first and follow it)

**Interfaces:**
- Consumes: `TaskDraft`, `hasPricedService` from `utils/taskDraft`; `ClientDraft` from `utils/clientDraft`.
- Produces:
  - `tasksSignature(tasks: TaskDraft[]): string` — stable fingerprint of titles + enabled services + impression params; the drawer regenerates when it changes.
  - `buildFallbackSummary(tasks: TaskDraft[], serviceLabel: (id: string) => string): string` — enumeration fallback, never empty for ≥1 task.
  - `useNewProjectDraft()` hook returning `{ initial: PersistedDraft | null, save(draft: PersistedDraft): void, clear(): void }` with `interface PersistedDraft { tasks: TaskDraft[]; client: ClientDraft | null; summaryText: string; summaryEdited: boolean; summarySignature: string }`, storage key `aito.newProjectDraft.v1`, `save` debounced 400 ms.
  - Module-level `clearNewProjectDraft(): void` (same key; used by `AitoPage` on create success).

- [ ] **Step 1: Write the failing tests**

`aitoSummary.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildFallbackSummary, tasksSignature } from '../../utils/aitoSummary';
import { emptyTaskDraft } from '../../utils/taskDraft';

const label = (id: string) => ({ scan: 'Scan 3D', modelisation: 'Modélisation 3D', impression: 'Impression 3D', usinage: 'Usinage' })[id] ?? id;

describe('tasksSignature', () => {
  it('changes when a service is priced and when a title changes, ignores uid', () => {
    const a = { ...emptyTaskDraft(), title: 'Capot' };
    const sig1 = tasksSignature([a]);
    expect(tasksSignature([{ ...a, uid: 'other' }])).toBe(sig1);
    expect(tasksSignature([{ ...a, scanCost: 45 }])).not.toBe(sig1);
    expect(tasksSignature([{ ...a, title: 'Capot moteur' }])).not.toBe(sig1);
  });
});

describe('buildFallbackSummary', () => {
  it('enumerates titles with their services', () => {
    const t = { ...emptyTaskDraft(), title: 'Capot', impressionCost: 120 };
    expect(buildFallbackSummary([t], label)).toBe('Capot — Impression 3D');
  });
  it('falls back to a numbered task name for a blank title', () => {
    const t = { ...emptyTaskDraft(), scanCost: 0 };
    expect(buildFallbackSummary([t], label)).toBe('Tâche 1 — Scan 3D');
  });
});
```

`useNewProjectDraft.test.ts` (renderHook + fake timers for the debounce):

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { clearNewProjectDraft, useNewProjectDraft } from '../../hooks/useNewProjectDraft';
import { emptyTaskDraft } from '../../utils/taskDraft';

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe('useNewProjectDraft', () => {
  it('round-trips a draft through localStorage', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNewProjectDraft());
    expect(result.current.initial).toBeNull();
    const draft = {
      tasks: [{ ...emptyTaskDraft(), title: 'Capot' }],
      client: null,
      summaryText: 'Résumé.',
      summaryEdited: true,
      summarySignature: 'sig',
    };
    act(() => result.current.save(draft));
    act(() => void vi.advanceTimersByTime(500));
    const { result: second } = renderHook(() => useNewProjectDraft());
    expect(second.current.initial?.tasks[0].title).toBe('Capot');
    expect(second.current.initial?.summaryEdited).toBe(true);
  });

  it('clear() and clearNewProjectDraft() both wipe the key', () => {
    localStorage.setItem('aito.newProjectDraft.v1', '{"broken"');
    clearNewProjectDraft();
    expect(localStorage.getItem('aito.newProjectDraft.v1')).toBeNull();
  });

  it('a corrupt payload reads as no draft', () => {
    localStorage.setItem('aito.newProjectDraft.v1', 'not json');
    const { result } = renderHook(() => useNewProjectDraft());
    expect(result.current.initial).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd frontend && npx vitest run src/__tests__/utils/aitoSummary.test.ts src/__tests__/hooks/useNewProjectDraft.test.ts; cd ..` — FAIL (modules missing).

- [ ] **Step 3: Implement**

`frontend/src/utils/aitoSummary.ts`:

```typescript
import type { TaskDraft } from './taskDraft';

const SERVICE_IDS = ['scan', 'modelisation', 'impression', 'usinage'] as const;

function enabledServices(task: TaskDraft): string[] {
  return [
    task.scanCost !== null ? 'scan' : null,
    task.modelisationCost !== null ? 'modelisation' : null,
    task.impressionCost !== null ? 'impression' : null,
    task.usinageCost !== null ? 'usinage' : null,
  ].filter((s): s is (typeof SERVICE_IDS)[number] => s !== null);
}

/** Stable fingerprint of what the AI summary describes: titles, descriptions,
 *  enabled services, and the visible impression parameters. Deliberately
 *  excludes uid/id (identity, not content) and prices (the summary never
 *  mentions money). */
export function tasksSignature(tasks: TaskDraft[]): string {
  return JSON.stringify(
    tasks.map((t) => [
      t.title.trim(),
      t.description.trim(),
      enabledServices(t),
      t.impressionCost !== null
        ? [t.impression.color, t.impression.weightG, t.impression.timeMin, t.impression.quantity]
        : null,
    ]),
  );
}

/** Manual-mode seed when OpenRouter is unavailable: "title — Service, Service"
 *  per task, joined with "; ". Never empty for a non-empty task list. */
export function buildFallbackSummary(tasks: TaskDraft[], serviceLabel: (id: string) => string): string {
  return tasks
    .map((t, index) => {
      const name = t.title.trim() || `Tâche ${index + 1}`;
      const services = enabledServices(t).map(serviceLabel);
      return services.length ? `${name} — ${services.join(', ')}` : name;
    })
    .join(' ; ');
}
```

`frontend/src/hooks/useNewProjectDraft.ts`:

```typescript
import { useEffect, useRef, useState } from 'react';
import type { ClientDraft } from '../utils/clientDraft';
import type { TaskDraft } from '../utils/taskDraft';

const STORAGE_KEY = 'aito.newProjectDraft.v1';
const SAVE_DEBOUNCE_MS = 400;

export interface PersistedDraft {
  tasks: TaskDraft[];
  client: ClientDraft | null;
  summaryText: string;
  summaryEdited: boolean;
  summarySignature: string;
}

export function clearNewProjectDraft(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, quota) — persistence is best-effort.
  }
}

function readDraft(): PersistedDraft | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedDraft;
    if (!Array.isArray(parsed.tasks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Best-effort local persistence for the new-project drawer. `initial` is read
 *  once on mount; `save` debounces writes; `clear` wipes synchronously (reset
 *  and successful create). */
export function useNewProjectDraft() {
  const [initial] = useState<PersistedDraft | null>(readDraft);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const save = (draft: PersistedDraft) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
      } catch {
        // Best-effort only.
      }
    }, SAVE_DEBOUNCE_MS);
  };

  const clear = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    clearNewProjectDraft();
  };

  return { initial, save, clear };
}
```

- [ ] **Step 4: Run tests** — same command as Step 2 — PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/aitoSummary.ts frontend/src/hooks/useNewProjectDraft.ts frontend/src/__tests__/
git commit -m "feat(aito): summary signature/fallback utils and persistent draft hook"
```

---

### Task 10: `AiSummaryPanel` component (frontend)

**Files:**
- Create: `frontend/src/components/aito/AiSummaryPanel.tsx`
- Test: `frontend/src/__tests__/components/AiSummaryPanel.test.tsx`

**Interfaces:**
- Consumes: `api.summarizeAitoProject` (Task 5), `taskDraftToTaskCreate` from `utils/taskDraft`, i18n keys (Task 7).
- Produces:

```tsx
export interface AiSummaryPanelProps {
  tasks: TaskDraft[];
  /** Current text + edited latch live in the DRAWER (they persist with the draft). */
  value: string;
  edited: boolean;
  onChange: (text: string, edited: boolean) => void;
  /** Bumped by the drawer each time the Client section opens with a stale signature. */
  generateNonce: number;
}
```

State machine: `idle` (value empty, nonce 0) → `generating` (mutation pending, shimmer) → `generated` (footer shows model) | `fallback` (mutation 409/error: seeds `buildFallbackSummary` if value empty, shows `aito.summaryFallback`). A textarea edit calls `onChange(text, true)`; while `edited`, `generateNonce` bumps are ignored; the ↻ button always regenerates and clears the latch via `onChange(summary, false)`.

- [ ] **Step 1: Write the failing test**

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AiSummaryPanel } from '../../components/aito/AiSummaryPanel';
import { emptyTaskDraft } from '../../utils/taskDraft';
import { api } from '../../api/client';

// Wrap in the same QueryClientProvider + i18n harness the sibling component
// tests use (copy the wrapper from NewProjectModal.test.tsx before deleting it).

vi.mock('../../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../api/client')>();
  return { ...mod, api: { ...mod.api, summarizeAitoProject: vi.fn() } };
});

const tasks = [{ ...emptyTaskDraft(), title: 'Capot', impressionCost: 120 }];

describe('AiSummaryPanel', () => {
  beforeEach(() => vi.mocked(api.summarizeAitoProject).mockReset());

  it('waits idle until the nonce bumps, then shows the generated summary', async () => {
    vi.mocked(api.summarizeAitoProject).mockResolvedValue({ summary: 'Résumé.', model: 'mistralai/mistral-small' });
    const onChange = vi.fn();
    const { rerender } = renderPanel({ tasks, value: '', edited: false, onChange, generateNonce: 0 });
    expect(screen.getByText(/Generated when you reach the client step/)).toBeInTheDocument();
    expect(api.summarizeAitoProject).not.toHaveBeenCalled();
    rerender(panelEl({ tasks, value: '', edited: false, onChange, generateNonce: 1 }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('Résumé.', false));
  });

  it('does not regenerate while edited, but the regenerate button does', async () => {
    vi.mocked(api.summarizeAitoProject).mockResolvedValue({ summary: 'Neuf.', model: 'm' });
    const onChange = vi.fn();
    const { rerender } = renderPanel({ tasks, value: 'À moi.', edited: true, onChange, generateNonce: 1 });
    rerender(panelEl({ tasks, value: 'À moi.', edited: true, onChange, generateNonce: 2 }));
    expect(api.summarizeAitoProject).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Regenerate/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('Neuf.', false));
  });

  it('falls back to an editable enumeration when the API fails', async () => {
    vi.mocked(api.summarizeAitoProject).mockRejectedValue(new Error('409'));
    const onChange = vi.fn();
    renderPanel({ tasks, value: '', edited: false, onChange, generateNonce: 1 });
    await waitFor(() => expect(screen.getByText(/AI unavailable/)).toBeInTheDocument());
    // Seeded with the fallback enumeration so create never ships empty:
    expect(onChange).toHaveBeenCalledWith(expect.stringContaining('Capot'), false);
  });
});
```

(`renderPanel`/`panelEl` are tiny local helpers wrapping the shared providers — write them in the test file.)

- [ ] **Step 2: Run to verify failure** — module missing.

- [ ] **Step 3: Implement `AiSummaryPanel.tsx`**

```tsx
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { RefreshCw, Sparkles } from 'lucide-react';
import { api } from '../../api/client';
import { buildFallbackSummary } from '../../utils/aitoSummary';
import { taskDraftToTaskCreate } from '../../utils/taskDraft';
import type { TaskDraft } from '../../utils/taskDraft';
import { focusRingCls } from '../formStyles';

/* Props: see the plan's interface block (Task 10). */
export function AiSummaryPanel({ tasks, value, edited, onChange, generateNonce }: AiSummaryPanelProps) {
  const { t } = useTranslation();
  const lastNonceRef = useRef(0);

  const mutation = useMutation({
    mutationFn: () => api.summarizeAitoProject(tasks.map(taskDraftToTaskCreate)),
    onSuccess: (data) => onChange(data.summary, false),
    onError: () => {
      if (!value.trim()) {
        const label = (id: string) =>
          t(
            { scan: 'aito.serviceScan3D', modelisation: 'aito.serviceModelisation3D', impression: 'aito.serviceImpression3D', usinage: 'aito.serviceUsinage' }[id] ?? id,
          );
        onChange(buildFallbackSummary(tasks, label), false);
      }
    },
  });

  // The drawer bumps generateNonce when the Client step opens with a stale
  // signature. Hand-edits latch generation off; ↻ below is the only override.
  useEffect(() => {
    if (generateNonce === 0 || generateNonce === lastNonceRef.current) return;
    lastNonceRef.current = generateNonce;
    if (edited) return;
    mutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generateNonce]);

  const idle = generateNonce === 0 && !value && !mutation.isPending;
  const failed = mutation.isError;

  return (
    <div
      className={`rounded-[.6rem] border p-3 ${
        idle ? 'border-dashed border-violet-400/25' : 'border-violet-400/35 bg-violet-400/[0.05]'
      }`}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 text-violet-300" aria-hidden="true" />
        <span className="text-[11px] font-bold uppercase tracking-wider text-violet-300">{t('aito.summaryTitle')}</span>
        {!idle && (
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className={`ml-auto inline-flex items-center gap-1 rounded-md border border-bambu-dark-tertiary px-2 py-0.5 text-xs text-bambu-gray transition-colors hover:text-violet-300 disabled:opacity-40 ${focusRingCls}`}
          >
            <RefreshCw className="h-3 w-3" />
            {t('aito.regenerate')}
          </button>
        )}
      </div>
      {idle ? (
        <p className="text-xs italic text-bambu-gray">{t('aito.summaryWaiting')}</p>
      ) : mutation.isPending ? (
        <div data-testid="ai-summary-shimmer" className="h-10 animate-pulse rounded-md bg-violet-400/15" />
      ) : (
        <>
          <textarea
            aria-label={t('aito.summaryTitle')}
            value={value}
            onChange={(e) => onChange(e.target.value, true)}
            rows={3}
            className="w-full resize-none rounded-md bg-transparent p-1 text-sm text-bambu-gray-light outline-none focus:bg-white/[0.04] focus:text-white"
          />
          <p className={`mt-1 text-[11px] ${edited ? 'text-amber-400' : 'text-bambu-gray'}`}>
            {failed
              ? t('aito.summaryFallback')
              : edited
                ? t('aito.summaryEdited')
                : t('aito.summaryGeneratedBy', { model: mutation.data?.model ?? '' })}
          </p>
        </>
      )}
    </div>
  );
}
```

Export `AiSummaryPanelProps` as in the interface block. Adjust the mutation-error path if the api helper throws typed errors (match how sibling components detect a 409 vs network error — grep `status === 409` in `frontend/src`; if the client exposes status, treat 409 and any failure identically here: both mean fallback).

- [ ] **Step 4: Run tests** — PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/aito/AiSummaryPanel.tsx frontend/src/__tests__/components/AiSummaryPanel.test.tsx
git commit -m "feat(aito): AI summary panel with edit latch and offline fallback"
```

---

### Task 11: `CreateChecklist` component (frontend)

**Files:**
- Create: `frontend/src/components/aito/CreateChecklist.tsx`
- Test: `frontend/src/__tests__/components/CreateChecklist.test.tsx`

**Interfaces:**
- Consumes: i18n keys (Task 7).
- Produces:

```tsx
export type ChecklistState = 'ok' | 'miss' | 'wait';
export interface CreateChecklistProps {
  taskCount: number;
  /** Name of the first unpriced task whose card the user has LEFT (blur-revealed), or null. */
  revealedUnpricedName: string | null;
  /** True when at least one unpriced task exists (drives ok vs wait/miss). */
  hasUnpriced: boolean;
  summaryState: 'waiting' | 'generating' | 'ready';
  clientAccountName: string;
  clientReachable: boolean;
  /** Contact channel shown when reachable (phone or email). */
  clientContact: string;
  /** True once the client fields have been blurred (or a submit attempt happened). */
  clientRevealed: boolean;
}
```

Pure presentational: five lines (task count / sub-tasks / summary / client account / client reachable), each `ok` (green ✓), `miss` (amber, only when revealed), or `wait` (neutral gray).

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CreateChecklist } from '../../components/aito/CreateChecklist';

const base = {
  taskCount: 2,
  revealedUnpricedName: null,
  hasUnpriced: false,
  summaryState: 'ready' as const,
  clientAccountName: 'Client de passage',
  clientReachable: false,
  clientContact: '',
  clientRevealed: false,
};

describe('CreateChecklist', () => {
  it('names a blur-revealed unpriced task', () => {
    render(<CreateChecklist {...base} hasUnpriced revealedUnpricedName="Support antenne" />);
    expect(screen.getByText('"Support antenne" needs at least one priced sub-task')).toBeInTheDocument();
  });

  it('keeps the sub-task line neutral before blur', () => {
    render(<CreateChecklist {...base} hasUnpriced />);
    const line = screen.getByText('Each task needs at least one priced sub-task');
    expect(line.closest('[data-state]')).toHaveAttribute('data-state', 'wait');
  });

  it('client line stays neutral until revealed, then goes miss', () => {
    const { rerender } = render(<CreateChecklist {...base} />);
    expect(screen.getByText('Client needs a phone or an email').closest('[data-state]')).toHaveAttribute('data-state', 'wait');
    rerender(<CreateChecklist {...base} clientRevealed />);
    expect(screen.getByText('Client needs a phone or an email').closest('[data-state]')).toHaveAttribute('data-state', 'miss');
  });

  it('zero tasks is structural — miss without any reveal', () => {
    render(<CreateChecklist {...base} taskCount={0} />);
    expect(screen.getByText('A project needs at least one task — add one').closest('[data-state]')).toHaveAttribute('data-state', 'miss');
  });
});
```

(Wrap with the shared i18n test harness as in Task 10.)

- [ ] **Step 2: Run to verify failure** — module missing.

- [ ] **Step 3: Implement**

```tsx
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';

/* Props/types: see the plan's interface block (Task 11). */

function Line({ state, text }: { state: ChecklistState; text: string }) {
  return (
    <div
      data-state={state}
      className={`flex items-center gap-2 text-xs ${
        state === 'ok' ? 'text-bambu-gray opacity-70' : state === 'miss' ? 'text-amber-400' : 'text-bambu-gray'
      }`}
    >
      <span
        className={`flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded border ${
          state === 'ok'
            ? 'border-bambu-green bg-bambu-green text-white'
            : state === 'miss'
              ? 'border-amber-400'
              : 'border-bambu-dark-tertiary'
        }`}
      >
        {state === 'ok' && <Check className="h-2.5 w-2.5" />}
      </span>
      <span>{text}</span>
    </div>
  );
}

export function CreateChecklist(props: CreateChecklistProps) {
  const { t } = useTranslation();
  const {
    taskCount, revealedUnpricedName, hasUnpriced, summaryState,
    clientAccountName, clientReachable, clientContact, clientRevealed,
  } = props;

  const subTask: { state: ChecklistState; text: string } =
    taskCount === 0
      ? { state: 'wait', text: t('aito.ruleSubTasksPending') }
      : !hasUnpriced
        ? { state: 'ok', text: t('aito.ruleSubTasksOk') }
        : revealedUnpricedName !== null
          ? { state: 'miss', text: t('aito.ruleSubTaskMissing', { name: revealedUnpricedName }) }
          : { state: 'wait', text: t('aito.ruleSubTasksPending') };

  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-bold uppercase tracking-wider text-bambu-gray">{t('aito.beforeCreate')}</div>
      <Line
        state={taskCount === 0 ? 'miss' : 'ok'}
        text={taskCount === 0 ? t('aito.ruleNeedTask') : t('aito.ruleTasksOk', { count: taskCount })}
      />
      <Line state={subTask.state} text={subTask.text} />
      <Line
        state={summaryState === 'ready' ? 'ok' : 'wait'}
        text={summaryState === 'ready' ? t('aito.summaryTitle') : t('aito.summaryWaiting')}
      />
      <Line state="ok" text={t('aito.ruleClientAccount', { name: clientAccountName })} />
      <Line
        state={clientReachable ? 'ok' : clientRevealed ? 'miss' : 'wait'}
        text={clientReachable ? t('aito.ruleClientReachable', { contact: clientContact }) : t('aito.ruleClientContact')}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run tests** — PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/aito/CreateChecklist.tsx frontend/src/__tests__/components/CreateChecklist.test.tsx
git commit -m "feat(aito): before-you-create checklist with blur-gated reveal states"
```

---

### Task 12: `NewProjectDrawer` (frontend, assembly)

**Files:**
- Create: `frontend/src/components/aito/NewProjectDrawer.tsx`
- Delete: `frontend/src/components/aito/NewProjectModal.tsx`
- Test: create `frontend/src/__tests__/components/NewProjectDrawer.test.tsx`; delete `NewProjectModal.test.tsx` (port its provider wrapper + Zoho-status mocks first — Task 10/11 tests reuse them)

**Interfaces:**
- Consumes: `ClientSection`, `NewContactForm`, `TaskEditor`, `AiSummaryPanel`, `CreateChecklist`, `HoldButton`, `useNewProjectDraft`, `tasksSignature`, `projectTotal`, `projectHasPricedService`, `hasPricedService`, `emptyTaskDraft`, `defaultClientDraft`, `draftFromContact`, `visibleClientDraftErrors`, `formatPhone`, `Money`, i18n keys.
- Produces: `export function NewProjectDrawer({ onClose, onCreate }: NewProjectDrawerProps)` with the SAME props contract as the old modal — `onCreate(description: string, draft: ClientDraft, tasks: TaskDraft[])` — so `AitoPage`'s mutation wiring survives (Task 13 only swaps the component and adds two behaviors).

Layout (reference `hybrid-drawer-v10.html`): backdrop `fixed inset-0 z-50 bg-black/60` (mousedown on backdrop closes — draft persists, so closing is safe); panel `fixed inset-y-0 right-0 z-50 flex w-full max-w-[1100px] flex-col border-l border-bambu-dark-tertiary bg-bambu-dark-secondary` — before writing, open `ProjectDetailPanel.tsx`, copy its root positioning/animation classes so the two drawers slide identically, and reuse its Escape-key pattern. Header: title + ✕ only. Body: `grid grid-cols-[minmax(0,1fr)_288px]`; left column scrolls with the two sections; right rail (darker: `bg-bambu-dark`) holds receipt → `AiSummaryPanel` → `CreateChecklist` → actions row.

Behavior contract (each is a test below):
1. Sections "1 The work" / "2 Client" are collapsible; work starts open, client closed. Headers show number-or-✓ + hint (`workHintNone` / `workHintProgress` / client contact).
2. Opening the Client section bumps `generateNonce` IF `tasksSignature(tasks) !== summarySignature` (then stores the new signature). Hand-edited summary (edited latch) never auto-regenerates.
3. Blur reveal: a `focusout` handler on each task card wrapper (compare `relatedTarget` containment, same idiom as `TaskRow`'s `onBlur`) adds that task's `rowKey` to a `revealedTaskKeys` set; `revealedUnpricedName` = first task that is both revealed and unpriced. Client fields blurred → `clientRevealed`.
4. `canCreate = tasks.length > 0 && projectHasPricedService(tasks) && clientReachable && clientValid && configured` where `clientReachable = formatPhone(draft) !== '' || draft.email.trim() !== ''`, `clientValid` from `visibleClientDraftErrors` (same as the old modal), `configured` from the zoho-status query (copy the old modal's query + seeding effect for the default contact verbatim).
5. Clicking a disabled Create reveals everything (all task keys + clientRevealed + blurred phone/email like the old modal's `submit`).
6. Create: `onCreate(summaryText.trim() || buildFallbackSummary(tasks, label), draft, tasks)` — description can never be empty.
7. Soft warnings under the client fields: phone-only → `aito.warnNoEmail`; email-only → `aito.warnNoPhone` (amber `<p>`, non-blocking).
8. Persistence: on mount, hydrate `tasks`/`draft`/summary state from `useNewProjectDraft().initial` (fall back to `[emptyTaskDraft()]` / default-contact seeding); every state change calls `save(...)`; the reset button calls `clear()` then resets state in place.
9. Reset: `HoldButton` `progress="perimeter"`, `durationMs={500}`, square (`w-9 justify-center`), red idle-ghost styling, `RotateCcw` icon, labels `aito.resetDraft`/`aito.holdToReset`; Create button `flex-1` beside it. No Cancel button anywhere.
10. Receipt rows: one per task (name or `aito.taskFallbackName`, `Money` total or amber "—"), client row, `aito.projectTotal` with `projectTotal(tasks)`.
11. "Change client" opens `NewContactForm` inline (a `creatingClient` boolean renders it in place of `ClientSection` INSIDE the client section body; `onCreated` → `draftFromContact`, back to `ClientSection`). Escape closes the sub-form first, then the drawer — port the old modal's `dismiss` logic.

- [ ] **Step 1: Write the failing tests**

Port the provider wrapper and `api` mocks from `NewProjectModal.test.tsx` into the new file, then cover the contract (representative set — write all of these):

```tsx
it('renders work-first sections and no Cancel button', ...);          // headers "The work" then "Client"; no button named Cancel
it('create disabled until priced task AND reachable client', ...);    // toggle chip + price → still disabled; type phone → enabled
it('checklist names an unpriced task only after leaving its card', ...); // focus into card, blur out → miss line appears
it('opening Client triggers exactly one summarize call per signature', ...); // spy summarizeAitoProject; open/close/open → 1 call; change a task, reopen → 2nd call
it('hand-edited summary survives reopening Client', ...);             // edit textarea; reopen → no new call, text intact
it('phone-only shows the missing-email warning', ...);
it('clicking disabled Create reveals all pending errors', ...);
it('draft round-trips through localStorage across unmount/remount', ...); // advance debounce timers, remount, assert restored title
it('submits the summary text as the description', ...);               // onCreate spy receives the edited summary
```

- [ ] **Step 2: Run to verify failure** — component missing.

- [ ] **Step 3: Implement `NewProjectDrawer.tsx`**

Assemble per the contract. Skeleton of the state core (the JSX follows the layout above; every list/label from i18n keys in Task 7):

```tsx
export interface NewProjectDrawerProps {
  onClose: () => void;
  onCreate: (description: string, draft: ClientDraft, tasks: TaskDraft[]) => void;
}

export function NewProjectDrawer({ onClose, onCreate }: NewProjectDrawerProps) {
  const { t } = useTranslation();
  const persistence = useNewProjectDraft();
  const [tasks, setTasks] = useState<TaskDraft[]>(() => persistence.initial?.tasks ?? [emptyTaskDraft()]);
  const [draft, setDraft] = useState<ClientDraft | null>(() => persistence.initial?.client ?? null);
  const [summaryText, setSummaryText] = useState(() => persistence.initial?.summaryText ?? '');
  const [summaryEdited, setSummaryEdited] = useState(() => persistence.initial?.summaryEdited ?? false);
  const summarySignatureRef = useRef(persistence.initial?.summarySignature ?? '');
  const [generateNonce, setGenerateNonce] = useState(0);
  const [openSections, setOpenSections] = useState<Set<'work' | 'client'>>(() => new Set(['work']));
  const [revealedTaskKeys, setRevealedTaskKeys] = useState<Set<string>>(new Set());
  const [clientRevealed, setClientRevealed] = useState(false);
  const [creatingClient, setCreatingClient] = useState(false);
  // zoho-status query + default-contact seeding + Escape handling: ported
  // verbatim from NewProjectModal (see its lines 39–73 before deleting it).

  const openClient = () => {
    setOpenSections((current) => {
      const next = new Set(current);
      if (next.delete('client')) return next;
      next.add('client');
      const signature = tasksSignature(tasks);
      if (!summaryEdited && signature !== summarySignatureRef.current) {
        summarySignatureRef.current = signature;
        setGenerateNonce((n) => n + 1);
      }
      return next;
    });
  };

  // Persist on every meaningful change.
  useEffect(() => {
    persistence.save({
      tasks, client: draft, summaryText, summaryEdited, summarySignature: summarySignatureRef.current,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, draft, summaryText, summaryEdited]);

  const resetDraft = () => {
    persistence.clear();
    setTasks([emptyTaskDraft()]);
    setDraft(null); // re-seeded by the default-contact effect
    setSummaryText('');
    setSummaryEdited(false);
    summarySignatureRef.current = '';
    setGenerateNonce(0);
    setRevealedTaskKeys(new Set());
    setClientRevealed(false);
  };
  …
}
```

Reuse `TaskEditor` for the task list (it already carries chips via Task 8, `minRows={0}` now — zero tasks is a visible checklist error instead of a hard floor; pass `canTick={false}` as before). Wrap each row for blur tracking by passing `onRowBlur={(task) => setRevealedTaskKeys(prev => new Set(prev).add(task.id !== null ? `persisted:${task.id}` : `draft:${task.uid}`))}` — `TaskEditor` already forwards `onRowBlur` per row; the key format mirrors `TaskEditor.rowKey`.

Then delete `NewProjectModal.tsx` and its test file.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/__tests__/components/NewProjectDrawer.test.tsx && npm run build; cd ..`
Expected: PASS + clean build (build also proves no dangling `NewProjectModal` imports).

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src/components/aito/ frontend/src/__tests__/components/
git commit -m "feat(aito): NewProjectDrawer replaces NewProjectModal"
```

---

### Task 13: `AitoPage` wiring (frontend)

**Files:**
- Modify: `frontend/src/pages/AitoPage.tsx` (import ~line 13, `createMutation` ~lines 210–239, render site ~line 551, `syncClientToZoho` ~lines 195–208)
- Modify: `frontend/src/__tests__/pages/AitoPageClientSync.test.tsx`

**Interfaces:**
- Consumes: `NewProjectDrawer` (Task 12), `clearNewProjectDraft` (Task 9).
- Produces: the page renders the drawer; on create success the local draft is wiped; the Zoho write-back is skipped for the walk-in default contact.

- [ ] **Step 1: Write the failing test**

In `AitoPageClientSync.test.tsx` (it already mocks the api and drives `createProject` — follow its harness):

```tsx
it('does not PATCH the walk-in default contact after create', async () => {
  // Arrange a create whose draft.id === the default contact id (the harness
  // already knows the default id from its zoho-status mock).
  // Act: run the create mutation to success.
  // Assert: api.patchZohoContact (or whatever the file's existing sync spy is)
  // was NOT called, and no warning toast fired.
});

it('clears the persisted drawer draft on create success', async () => {
  localStorage.setItem('aito.newProjectDraft.v1', '{"tasks":[]}');
  // Act: create to success.
  expect(localStorage.getItem('aito.newProjectDraft.v1')).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

In `AitoPage.tsx`:
- Swap the import and render: `NewProjectModal` → `NewProjectDrawer` (`{showModal && <NewProjectDrawer onClose={() => setShowModal(false)} onCreate={createProject} />}`).
- In `syncClientToZoho`, bail out for the walk-in bucket before any PATCH (the backend rejects it anyway — see `routes/zoho.py:196-199` — but a silent skip beats a warning toast on every counter sale). The default id is already available where the old modal read it (`zoho-status` query); read it the same way here:

```tsx
    if (draft.id === defaultContactId) return; // walk-in bucket: coordinates live on the project row
```
- In `createMutation.onSuccess`, add `clearNewProjectDraft();` (import from `../hooks/useNewProjectDraft`).

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/__tests__/pages/AitoPageClientSync.test.tsx && npm run build; cd ..`
Expected: PASS + clean build.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/AitoPage.tsx frontend/src/__tests__/pages/AitoPageClientSync.test.tsx
git commit -m "feat(aito): wire NewProjectDrawer into AitoPage, skip walk-in Zoho sync, clear draft on create"
```

---

### Task 14: OpenRouter settings card (frontend)

**Files:**
- Create: `frontend/src/components/AiSettings.tsx`
- Modify: `frontend/src/pages/SettingsPage.tsx` (render in the `zoho` tab below `ZohoSettings`; add a `registerSettingsSearch` entry near line ~62)

**Interfaces:**
- Consumes: `api.getSettings` / `api.updateSettings` (same pair `ZohoSettings.tsx` uses — copy its query/mutation/toast pattern), settings keys from Task 1/5, i18n `settings.openrouter*` keys (Task 7).
- Produces: a card with two fields — API key (`type="password"`, placeholder from `settings.openrouterApiKeyHint`, NOT prefilled from GET since the key is scrubbed; empty value is omitted from the PUT payload so an untouched field never wipes the stored key) and model (text input, defaulting to the fetched `openrouter_model`).

- [ ] **Step 1: Implement (pattern-copy task — the save path is covered by ZohoSettings' existing test approach; add one if that file has one)**

Build `AiSettings.tsx` by copying `ZohoSettings.tsx`'s skeleton (same Card wrapper, `useQuery(['settings'])`, `useMutation(api.updateSettings)`, saved-toast). Fields:

```tsx
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  // Seed model from settings once loaded; never seed apiKey (write-only).
  …
  const save = () =>
    saveMutation.mutate({
      openrouter_model: model.trim() || 'mistralai/mistral-small',
      ...(apiKey.trim() ? { openrouter_api_key: apiKey.trim() } : {}),
    });
```

In `SettingsPage.tsx`: render `<AiSettings />` directly under `<ZohoSettings />` in the zoho tab and register search:

```tsx
registerSettingsSearch({ labelKey: 'settings.openrouterTitle', tab: 'zoho', keywords: 'openrouter ai summary model api key aito', anchor: 'card-openrouter' });
```

(Give the card `id="card-openrouter"` — match how sibling cards carry their anchor.)

- [ ] **Step 2: Verify**

Run: `cd frontend && npm run build && npx vitest run src/__tests__ 2>&1 | tail -5; cd ..`
Expected: build clean; no test regressions (SettingsPage snapshot/search tests may need the new entry — fix as flagged).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/AiSettings.tsx frontend/src/pages/SettingsPage.tsx
git commit -m "feat(settings): OpenRouter API key and model card"
```

---

### Task 15: Full verification sweep

**Files:** none new.

- [ ] **Step 1: Frontend suite** — `cd frontend && npm run build && cd .. && ./test_frontend.sh` — all green (tsc, ESLint, Vitest incl. i18n parity).
- [ ] **Step 2: Backend suite** — `./test_backend.sh` — all green.
- [ ] **Step 3: Grep sweeps** — `grep -rn "NewProjectModal" frontend/src` → no hits; `grep -rn "aito.modalTitle" frontend/src` → still used by the drawer title or retired consistently (if retired, keys may stay in locales — do NOT delete keys, the parity gate only checks parity).
- [ ] **Step 4: Manual smoke (dev runtime)** — backend hot-reloads per project memory; open the Aito page: create a project end-to-end (chips → price → Client step → summary generates → phone → Create), close mid-draft and reopen (restored), hold-reset (ring from top-centre, glow, inflate, stay-and-fade, bounce), mark-as-sent / done on a card show the same choreography.
- [ ] **Step 5: Commit any straggler fixes** — `git add -A && git commit -m "test(aito): drawer verification sweep fixes"` (only if changes exist).

---

## Plan Self-Review (completed)

- **Spec coverage:** Surface/flow → T12; chips → T8; AI summary → T2/T3/T5/T10 (trigger in T12); client rules → T4 (server) + T12 (UI, soft warnings); validation/guidance → T11/T12; persistence/reset → T9/T12; HoldButton choreography incl. mark-as-sent/done → T6; settings → T1/T14; i18n → T7; tests woven per task. Spec's "each task ≥1 sub-task server-side" narrowed per Global Constraints deviation note.
- **Type consistency:** `summarize_tasks(db, tasks) -> tuple[str, str]` used identically in T2/T3; `PersistedDraft`/`clearNewProjectDraft` names match T9/T12/T13; `AiSummaryPanelProps.generateNonce` matches T12's usage; checklist prop names match T11/T12; i18n keys in components exist in T7's list.
- **Placeholders:** none — every step carries code or an exact grep/copy instruction anchored to a real file.
