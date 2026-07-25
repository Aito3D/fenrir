# Aito × Zoho Books Client Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Aito Kanban board to the backend DB and attach a required Zoho Books client to every new project, searchable live from the create modal, with a Zoho credentials tab in Settings.

**Architecture:** New `aito_projects` table (soft delete, autoincrement id = visible project number, client snapshot columns). New `services/zoho.py` does the OAuth refresh-token dance server-side and proxies Books contact search; credentials live in the existing `settings` key-value table and never reach the browser. Frontend swaps localStorage for React Query with optimistic drag moves.

**Tech Stack:** FastAPI + SQLAlchemy (async, SQLite), httpx (Zoho calls, `httpx.MockTransport` in tests), React 19 + TanStack Query + dnd-kit, Vitest + msw, i18n across 12 locales.

**Spec:** `docs/superpowers/specs/2026-07-25-aito-zoho-client-design.md`

## Global Constraints

- Python 3.10+ (no `datetime.UTC`), Ruff line length 120, double quotes.
- Run Python via `./venv/bin/python3` from project root. Frontend commands from `frontend/`.
- Zoho credential VALUES are never committed — not in code, tests, fixtures, or this plan. Tests use obviously fake values. Real values are seeded locally by the operator (Task 12).
- Secrets `zoho_client_secret` / `zoho_refresh_token` are never returned by any API response (blank like `ldap_bind_password`).
- New i18n strings must exist in ALL 12 locale files with native translations; `npm run check:i18n` is the gate (it also rejects untranslated English copies).
- Board columns are exactly: `devis`, `model`, `print`, `finish`.
- Soft delete only: `DELETE /aito/{id}` sets `status='deleted'`; no row is ever removed.
- Existing dnd-kit interaction + motion classes on AitoPage stay as-is.

---

### Task 1: Aito permissions

**Files:**
- Modify: `backend/app/core/permissions.py` (Permission enum, PERMISSION_CATEGORIES, DEFAULT_GROUPS Operators list)
- Modify: `backend/app/core/auth.py` (`_APIKEY_SCOPE_BY_PERMISSION`, `_APIKEY_DENIED_PERMISSIONS`)

**Interfaces:**
- Produces: `Permission.AITO_READ = "aito:read"`, `Permission.AITO_CREATE = "aito:create"`, `Permission.AITO_UPDATE = "aito:update"`, `Permission.AITO_DELETE = "aito:delete"` — used by Tasks 3, 6.

- [ ] **Step 1: Add the enum values.** In `backend/app/core/permissions.py`, after the Calculator block in `class Permission`:

```python
    # Aito production board
    AITO_READ = "aito:read"
    AITO_CREATE = "aito:create"  # create projects + search Zoho contacts
    AITO_UPDATE = "aito:update"  # move cards between columns
    AITO_DELETE = "aito:delete"  # soft-delete cards
```

- [ ] **Step 2: Add category + default group.** In `PERMISSION_CATEGORIES`, next to the `"Calculator"` entry:

```python
    "Aito": [
        Permission.AITO_READ,
        Permission.AITO_CREATE,
        Permission.AITO_UPDATE,
        Permission.AITO_DELETE,
    ],
```

In `DEFAULT_GROUPS["Operators"]["permissions"]`, after the Projects block:

```python
            # Aito production board - full access
            Permission.AITO_READ.value,
            Permission.AITO_CREATE.value,
            Permission.AITO_UPDATE.value,
            Permission.AITO_DELETE.value,
```

- [ ] **Step 3: API-key classification** (repo gotcha: every new permission must land in exactly one of the two structures in `backend/app/core/auth.py`). Add to `_APIKEY_SCOPE_BY_PERMISSION` next to `Permission.CALCULATOR_READ`:

```python
    Permission.AITO_READ: "can_read_status",
```

Add to `_APIKEY_DENIED_PERMISSIONS` next to `Permission.CALCULATOR_UPDATE` (board mutation via API key is admin-surface, same trust dimension):

```python
        # Aito board mutation — UI workflow, not an API-key surface.
        Permission.AITO_CREATE,
        Permission.AITO_UPDATE,
        Permission.AITO_DELETE,
```

- [ ] **Step 4: Run the permission/auth test files** to catch classification drift:

Run: `./venv/bin/python3 -m pytest backend/tests/ -k "permission or apikey or api_key" -q`
Expected: PASS (existing drift tests accept the new classification)

- [ ] **Step 5: Commit**

```bash
git add backend/app/core/permissions.py backend/app/core/auth.py
git commit -m "feat(aito): add aito:* permissions with API-key classification"
```

---

### Task 2: AitoProject model + registration

**Files:**
- Create: `backend/app/models/aito_project.py`
- Modify: `backend/app/models/__init__.py`, `backend/app/core/database.py` (init_db import list, ~line 255), `backend/tests/conftest.py` (model import list, ~line 158) — the three model import lists (repo gotcha)
- Test: `backend/tests/unit/test_aito_project_model.py`

**Interfaces:**
- Produces: `AitoProject` with attributes `id, description, board_column, position, status, client_id, client_name, client_phone, created_at, updated_at`. NOTE: the DB/model attribute is `board_column` (avoids the reserved-word footgun); the API field is `column` (mapped in Task 3).

- [ ] **Step 1: Write the failing test** — `backend/tests/unit/test_aito_project_model.py`:

```python
"""AitoProject model: defaults, soft-delete status, autoincrement ids."""

import pytest
from sqlalchemy import select

from backend.app.models.aito_project import AitoProject


@pytest.mark.asyncio
async def test_aito_project_defaults(db_session):
    p = AitoProject(description="Boîtier PETG", board_column="devis", position=0)
    db_session.add(p)
    await db_session.commit()
    await db_session.refresh(p)

    assert p.id is not None
    assert p.status == "active"
    assert p.client_id is None
    assert p.created_at is not None
    assert p.updated_at is not None


@pytest.mark.asyncio
async def test_aito_project_ids_increment(db_session):
    a = AitoProject(description="a", board_column="devis", position=0)
    b = AitoProject(description="b", board_column="print", position=0,
                    client_id="123", client_name="ACME", client_phone="+33 6 00 00 00 00")
    db_session.add_all([a, b])
    await db_session.commit()
    ids = (await db_session.execute(select(AitoProject.id).order_by(AitoProject.id))).scalars().all()
    assert ids[1] > ids[0]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_project_model.py -v`
Expected: FAIL with `ModuleNotFoundError: backend.app.models.aito_project`

- [ ] **Step 3: Create the model** — `backend/app/models/aito_project.py`:

```python
from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class AitoProject(Base):
    """Aito production-board project (quote -> model -> print -> finish).

    Soft-delete only: ``status`` flips to 'deleted', rows are never removed,
    so the autoincrement ``id`` doubles as a stable visible project number.
    Client fields are a snapshot taken at attach time (Zoho outages never
    affect board rendering); legacy cards migrated from localStorage have
    NULL client fields.
    """

    __tablename__ = "aito_projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    description: Mapped[str] = mapped_column(Text)
    board_column: Mapped[str] = mapped_column(String(20), index=True)  # devis|model|print|finish
    position: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)  # active|deleted
    client_id: Mapped[str | None] = mapped_column(String(50), nullable=True)
    client_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    client_phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
```

- [ ] **Step 4: Register in the three import lists** (alphabetical position in each):
  - `backend/app/models/__init__.py`: `from backend.app.models.aito_project import AitoProject`
  - `backend/app/core/database.py` in `init_db()`'s `from backend.app.models import (...)` block: add `aito_project,`
  - `backend/tests/conftest.py` model import block: add `aito_project,  # noqa: F401` matching neighbors' style

- [ ] **Step 5: Run test to verify it passes**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_project_model.py -v`
Expected: 2 PASS

- [ ] **Step 6: Commit**

```bash
git add backend/app/models/aito_project.py backend/app/models/__init__.py backend/app/core/database.py backend/tests/conftest.py backend/tests/unit/test_aito_project_model.py
git commit -m "feat(aito): AitoProject model with soft delete + client snapshot"
```

---

### Task 3: Aito schemas + routes (CRUD, move, import, soft delete)

**Files:**
- Create: `backend/app/schemas/aito.py`
- Create: `backend/app/api/routes/aito.py`
- Modify: `backend/app/main.py` (import + `include_router` next to `calculator`)
- Test: `backend/tests/unit/test_aito_routes.py`

**Interfaces:**
- Consumes: `AitoProject` (Task 2, attr `board_column`), `Permission.AITO_*` (Task 1).
- Produces HTTP API used by Task 7's frontend client:
  - `GET  /api/v1/aito/` → `list[AitoProjectResponse]` (active only, ordered column+position)
  - `POST /api/v1/aito/` body `{description, client_id, client_name, client_phone?}` → 201 `AitoProjectResponse` (new card at position 0 of `devis`)
  - `POST /api/v1/aito/import` body `{projects: [{description, column, position}]}` → 409 unless zero rows exist
  - `PATCH /api/v1/aito/{id}/move` body `{column, position}` → reindexed board
  - `DELETE /api/v1/aito/{id}` → 204, sets status='deleted'
  - `AitoProjectResponse = {id, description, column, position, status, client_id, client_name, client_phone, created_at, updated_at}`

- [ ] **Step 1: Write the failing tests** — `backend/tests/unit/test_aito_routes.py`:

```python
"""Aito board routes: required client, move reindexing, soft delete, one-shot import."""

import pytest
from sqlalchemy import select

from backend.app.models.aito_project import AitoProject


async def _create(client, **overrides):
    payload = {"description": "Support GoPro", "client_id": "z1",
               "client_name": "ACME", "client_phone": "+33 6 12 34 56 78"}
    payload.update(overrides)
    return await client.post("/api/v1/aito/", json=payload)


@pytest.mark.asyncio
async def test_create_requires_client(async_client):
    r = await _create(async_client, client_id=None, client_name=None)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_create_and_list(async_client):
    r = await _create(async_client)
    assert r.status_code == 201
    body = r.json()
    assert body["column"] == "devis" and body["position"] == 0
    assert body["client_name"] == "ACME"

    r2 = await async_client.get("/api/v1/aito/")
    assert [p["id"] for p in r2.json()] == [body["id"]]


@pytest.mark.asyncio
async def test_move_reindexes_both_columns(async_client):
    a = (await _create(async_client, description="a")).json()
    b = (await _create(async_client, description="b")).json()  # devis order: b(0), a(1)
    r = await async_client.patch(f"/api/v1/aito/{a['id']}/move", json={"column": "print", "position": 0})
    assert r.status_code == 200
    board = (await async_client.get("/api/v1/aito/")).json()
    by_id = {p["id"]: p for p in board}
    assert by_id[a["id"]]["column"] == "print" and by_id[a["id"]]["position"] == 0
    assert by_id[b["id"]]["column"] == "devis" and by_id[b["id"]]["position"] == 0


@pytest.mark.asyncio
async def test_move_rejects_bad_column(async_client):
    a = (await _create(async_client)).json()
    r = await async_client.patch(f"/api/v1/aito/{a['id']}/move", json={"column": "nope", "position": 0})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_soft_delete_hides_but_keeps_row(async_client, db_session):
    a = (await _create(async_client)).json()
    r = await async_client.delete(f"/api/v1/aito/{a['id']}")
    assert r.status_code == 204
    assert (await async_client.get("/api/v1/aito/")).json() == []
    row = (await db_session.execute(select(AitoProject).where(AitoProject.id == a["id"]))).scalar_one()
    assert row.status == "deleted"


@pytest.mark.asyncio
async def test_import_only_on_empty_board(async_client):
    payload = {"projects": [{"description": "legacy", "column": "print", "position": 0}]}
    r = await async_client.post("/api/v1/aito/import", json=payload)
    assert r.status_code == 201
    assert (await async_client.get("/api/v1/aito/")).json()[0]["client_id"] is None
    # second fire must 409 — board is no longer empty (soft-deleted rows count)
    assert (await async_client.post("/api/v1/aito/import", json=payload)).status_code == 409
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_routes.py -v`
Expected: FAIL, 404s (router not registered)

- [ ] **Step 3: Create schemas** — `backend/app/schemas/aito.py`:

```python
"""Pydantic DTOs for the Aito production board."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

AitoColumn = Literal["devis", "model", "print", "finish"]


class AitoProjectCreate(BaseModel):
    description: str = Field(min_length=1)
    client_id: str = Field(min_length=1)
    client_name: str = Field(min_length=1)
    client_phone: str | None = None


class AitoProjectImportItem(BaseModel):
    description: str = Field(min_length=1)
    column: AitoColumn
    position: int = Field(ge=0)


class AitoProjectImport(BaseModel):
    projects: list[AitoProjectImportItem]


class AitoProjectMove(BaseModel):
    column: AitoColumn
    position: int = Field(ge=0)


class AitoProjectResponse(BaseModel):
    id: int
    description: str
    column: AitoColumn
    position: int
    status: str
    client_id: str | None
    client_name: str | None
    client_phone: str | None
    created_at: datetime
    updated_at: datetime
```

- [ ] **Step 4: Create routes** — `backend/app/api/routes/aito.py`:

```python
"""Aito production board: DB-backed Kanban with soft delete."""

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.aito_project import AitoProject
from backend.app.models.user import User
from backend.app.schemas.aito import (
    AitoProjectCreate,
    AitoProjectImport,
    AitoProjectMove,
    AitoProjectResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/aito", tags=["aito"])


def _to_response(p: AitoProject) -> AitoProjectResponse:
    return AitoProjectResponse(
        id=p.id, description=p.description, column=p.board_column, position=p.position,
        status=p.status, client_id=p.client_id, client_name=p.client_name,
        client_phone=p.client_phone, created_at=p.created_at, updated_at=p.updated_at,
    )


async def _active_in_column(db: AsyncSession, column: str, exclude_id: int | None = None) -> list[AitoProject]:
    stmt = (
        select(AitoProject)
        .where(AitoProject.status == "active", AitoProject.board_column == column)
        .order_by(AitoProject.position, AitoProject.id)
    )
    rows = list((await db.execute(stmt)).scalars().all())
    return [r for r in rows if r.id != exclude_id]


@router.get("/", response_model=list[AitoProjectResponse])
async def list_projects(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_READ),
):
    stmt = (
        select(AitoProject)
        .where(AitoProject.status == "active")
        .order_by(AitoProject.board_column, AitoProject.position, AitoProject.id)
    )
    return [_to_response(p) for p in (await db.execute(stmt)).scalars().all()]


@router.post("/", response_model=AitoProjectResponse, status_code=201)
async def create_project(
    payload: AitoProjectCreate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE),
):
    # New cards land on top of the quote column: shift existing cards down.
    for row in await _active_in_column(db, "devis"):
        row.position += 1
    project = AitoProject(
        description=payload.description.strip(), board_column="devis", position=0,
        client_id=payload.client_id, client_name=payload.client_name,
        client_phone=payload.client_phone,
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return _to_response(project)


@router.post("/import", response_model=list[AitoProjectResponse], status_code=201)
async def import_legacy_projects(
    payload: AitoProjectImport,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE),
):
    """One-time localStorage migration. Guard counts ALL rows (incl. soft-deleted)
    so a double-fire can never duplicate the board."""
    total = await db.scalar(select(func.count(AitoProject.id)))
    if total:
        raise HTTPException(status_code=409, detail="Aito board is not empty")
    created = []
    for item in payload.projects:
        p = AitoProject(description=item.description, board_column=item.column, position=item.position)
        db.add(p)
        created.append(p)
    await db.commit()
    for p in created:
        await db.refresh(p)
    return [_to_response(p) for p in created]


@router.patch("/{project_id}/move", response_model=AitoProjectResponse)
async def move_project(
    project_id: int,
    payload: AitoProjectMove,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    project = (
        await db.execute(
            select(AitoProject).where(AitoProject.id == project_id, AitoProject.status == "active")
        )
    ).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    source_column = project.board_column
    destination = await _active_in_column(db, payload.column, exclude_id=project.id)
    insert_at = min(payload.position, len(destination))
    destination.insert(insert_at, project)
    project.board_column = payload.column
    for i, row in enumerate(destination):
        row.position = i
    if source_column != payload.column:
        for i, row in enumerate(await _active_in_column(db, source_column, exclude_id=project.id)):
            row.position = i
    await db.commit()
    await db.refresh(project)
    return _to_response(project)


@router.delete("/{project_id}", status_code=204)
async def delete_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_DELETE),
):
    """Soft delete: the row is kept forever, only hidden from the board."""
    project = (
        await db.execute(
            select(AitoProject).where(AitoProject.id == project_id, AitoProject.status == "active")
        )
    ).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    project.status = "deleted"
    await db.commit()
```

- [ ] **Step 5: Register the router.** In `backend/app/main.py`: add `aito` to the existing `from backend.app.api.routes import (...)` block, and next to `app.include_router(calculator.router, ...)`:

```python
app.include_router(aito.router, prefix=app_settings.api_prefix)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_routes.py -v`
Expected: 6 PASS

- [ ] **Step 7: Lint + commit**

```bash
ruff check backend/ && ruff format backend/app/api/routes/aito.py backend/app/schemas/aito.py
git add backend/app/schemas/aito.py backend/app/api/routes/aito.py backend/app/main.py backend/tests/unit/test_aito_routes.py
git commit -m "feat(aito): board CRUD routes with move reindexing, soft delete, legacy import"
```

---

### Task 4: Zoho settings fields (backend)

**Files:**
- Modify: `backend/app/schemas/settings.py` (`AppSettings` + `AppSettingsUpdate`)
- Modify: `backend/app/api/routes/settings.py` (`_build_settings_response`, `_SENSITIVE_FIELDS_FOR_API_KEY`)
- Test: `backend/tests/unit/test_zoho_settings.py`

**Interfaces:**
- Produces settings keys read by Task 5: `zoho_client_id`, `zoho_client_secret`, `zoho_refresh_token`, `zoho_organization_id`, `zoho_base_url` (default `https://www.zohoapis.eu`), `zoho_accounts_url` (default `https://accounts.zoho.eu`).

- [ ] **Step 1: Write the failing test** — `backend/tests/unit/test_zoho_settings.py`:

```python
"""Zoho credentials in settings: persisted, but secrets never returned."""

import pytest


@pytest.mark.asyncio
async def test_zoho_secrets_never_returned(async_client):
    r = await async_client.put("/api/v1/settings/", json={
        "zoho_client_id": "1000.FAKECLIENTID",
        "zoho_client_secret": "fake-secret",
        "zoho_refresh_token": "1000.fake.refresh",
        "zoho_organization_id": "12345",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["zoho_client_id"] == "1000.FAKECLIENTID"
    assert body["zoho_organization_id"] == "12345"
    assert body["zoho_client_secret"] == ""
    assert body["zoho_refresh_token"] == ""

    body2 = (await async_client.get("/api/v1/settings/")).json()
    assert body2["zoho_client_secret"] == ""
    assert body2["zoho_refresh_token"] == ""
    assert body2["zoho_base_url"] == "https://www.zohoapis.eu"
    assert body2["zoho_accounts_url"] == "https://accounts.zoho.eu"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_zoho_settings.py -v`
Expected: FAIL (unknown fields dropped / KeyError on zoho_client_id)

- [ ] **Step 3: Add schema fields.** In `backend/app/schemas/settings.py` — in `AppSettings` (defaults matter: they seed `DEFAULT_SETTINGS`):

```python
    # Zoho Books integration (Aito board client search)
    zoho_client_id: str = Field(default="", description="Zoho OAuth client id")
    zoho_client_secret: str = Field(default="", description="Zoho OAuth client secret (write-only)")
    zoho_refresh_token: str = Field(default="", description="Zoho OAuth refresh token (write-only)")
    zoho_organization_id: str = Field(default="", description="Zoho Books organization id")
    zoho_base_url: str = Field(default="https://www.zohoapis.eu", description="Zoho API base URL")
    zoho_accounts_url: str = Field(default="https://accounts.zoho.eu", description="Zoho accounts (OAuth) URL")
```

And in `AppSettingsUpdate` (all optional, matching its style):

```python
    zoho_client_id: str | None = None
    zoho_client_secret: str | None = None
    zoho_refresh_token: str | None = None
    zoho_organization_id: str | None = None
    zoho_base_url: str | None = None
    zoho_accounts_url: str | None = None
```

- [ ] **Step 4: Blank secrets in every response.** In `backend/app/api/routes/settings.py`, in `_build_settings_response`, right after the `ldap_bind_password` blanking line:

```python
    # Zoho secrets are write-only — never returned to any caller.
    settings_dict["zoho_client_secret"] = ""
    settings_dict["zoho_refresh_token"] = ""
```

Also add `"zoho_client_secret", "zoho_refresh_token",` to `_SENSITIVE_FIELDS_FOR_API_KEY` (belt-and-suspenders, consistent with neighbors).

- [ ] **Step 5: Run test to verify it passes**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_zoho_settings.py -v`
Expected: PASS. Also run `./venv/bin/python3 -m pytest backend/tests/ -k settings -q` — expected PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add backend/app/schemas/settings.py backend/app/api/routes/settings.py backend/tests/unit/test_zoho_settings.py
git commit -m "feat(zoho): credential settings keys, secrets write-only"
```

---

### Task 5: Zoho service (token manager + contact search)

**Files:**
- Create: `backend/app/services/zoho.py`
- Test: `backend/tests/unit/services/test_zoho_service.py`

**Interfaces:**
- Consumes: `get_setting(db, key)` from `backend.app.api.routes.settings` (import from there, matching how other services read settings — verify at implementation time and use the same import the `github_backup` service uses if different).
- Produces (used by Task 6):
  - `zoho_service: ZohoService` module singleton
  - `await zoho_service.is_configured(db) -> bool`
  - `await zoho_service.get_access_token(db) -> str` (raises `ZohoNotConfiguredError` / `ZohoUpstreamError`)
  - `await zoho_service.search_contacts(db, query: str) -> list[dict]` with dict keys `id, name, company_name, phone, mobile, email`
  - `zoho_service.transport: httpx.AsyncBaseTransport | None` — test seam
  - Exceptions: `ZohoNotConfiguredError(Exception)`, `ZohoUpstreamError(Exception)` (message = safe upstream detail)

- [ ] **Step 1: Write the failing tests** — `backend/tests/unit/services/test_zoho_service.py`:

```python
"""Zoho service: config gating, token refresh + caching + 401 retry, contact mapping."""

import httpx
import pytest

from backend.app.services.zoho import ZohoNotConfiguredError, ZohoUpstreamError, zoho_service


@pytest.fixture(autouse=True)
def reset_service():
    zoho_service.invalidate_token()
    zoho_service.transport = None
    yield
    zoho_service.invalidate_token()
    zoho_service.transport = None


async def _configure(async_client):
    await async_client.put("/api/v1/settings/", json={
        "zoho_client_id": "1000.FAKE", "zoho_client_secret": "fake-secret",
        "zoho_refresh_token": "1000.fake.refresh", "zoho_organization_id": "999",
    })


def _transport(handler):
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_not_configured_raises(db_session):
    with pytest.raises(ZohoNotConfiguredError):
        await zoho_service.get_access_token(db_session)


@pytest.mark.asyncio
async def test_token_fetched_then_cached(async_client, db_session):
    await _configure(async_client)
    calls = {"token": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        assert "/oauth/v2/token" in str(request.url)
        calls["token"] += 1
        return httpx.Response(200, json={"access_token": "at-1", "expires_in": 3600})

    zoho_service.transport = _transport(handler)
    assert await zoho_service.get_access_token(db_session) == "at-1"
    assert await zoho_service.get_access_token(db_session) == "at-1"
    assert calls["token"] == 1  # cached, not re-fetched


@pytest.mark.asyncio
async def test_token_error_maps_to_upstream_error(async_client, db_session):
    await _configure(async_client)
    zoho_service.transport = _transport(
        lambda request: httpx.Response(200, json={"error": "invalid_code"})
    )
    with pytest.raises(ZohoUpstreamError):
        await zoho_service.get_access_token(db_session)


@pytest.mark.asyncio
async def test_search_contacts_maps_fields_and_retries_401_once(async_client, db_session):
    await _configure(async_client)
    calls = {"token": 0, "search": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            calls["token"] += 1
            return httpx.Response(200, json={"access_token": f"at-{calls['token']}", "expires_in": 3600})
        calls["search"] += 1
        assert request.url.params["organization_id"] == "999"
        assert request.url.params["search_text"] == "acm"
        if calls["search"] == 1:
            return httpx.Response(401, json={"code": 57, "message": "expired"})
        return httpx.Response(200, json={"contacts": [{
            "contact_id": "z1", "contact_name": "ACME SARL", "company_name": "ACME",
            "phone": "", "mobile": "+33 6 12 34 56 78", "email": "hi@acme.fr",
        }]})

    zoho_service.transport = _transport(handler)
    contacts = await zoho_service.search_contacts(db_session, "acm")
    assert calls["token"] == 2  # initial + refresh after 401
    assert contacts == [{"id": "z1", "name": "ACME SARL", "company_name": "ACME",
                         "phone": "", "mobile": "+33 6 12 34 56 78", "email": "hi@acme.fr"}]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/services/test_zoho_service.py -v`
Expected: FAIL with `ModuleNotFoundError: backend.app.services.zoho`

- [ ] **Step 3: Implement the service** — `backend/app/services/zoho.py`:

```python
"""Zoho Books integration: OAuth refresh-token flow + contact search proxy.

Credentials live in the settings key-value table (never in env/code). The
access token is cached in memory and refreshed ~5 minutes before expiry;
a 401 from the Books API invalidates the cache and retries exactly once.
"""

import logging
import time

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

_EXPIRY_MARGIN_SECONDS = 300
_REQUIRED_KEYS = ("zoho_client_id", "zoho_client_secret", "zoho_refresh_token", "zoho_organization_id")


class ZohoNotConfiguredError(Exception):
    """Raised when required Zoho settings are missing."""


class ZohoUpstreamError(Exception):
    """Raised when Zoho returns an error or is unreachable."""


class ZohoService:
    def __init__(self) -> None:
        self._access_token: str | None = None
        self._expires_at: float = 0.0
        # Test seam: httpx.MockTransport in unit tests, None (real network) in prod.
        self.transport: httpx.AsyncBaseTransport | None = None

    def invalidate_token(self) -> None:
        self._access_token = None
        self._expires_at = 0.0

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=10.0, transport=self.transport)

    async def _load_config(self, db: AsyncSession) -> dict[str, str]:
        from backend.app.api.routes.settings import get_setting

        config = {
            key: (await get_setting(db, key) or "")
            for key in (*_REQUIRED_KEYS, "zoho_base_url", "zoho_accounts_url")
        }
        config["zoho_base_url"] = config["zoho_base_url"] or "https://www.zohoapis.eu"
        config["zoho_accounts_url"] = config["zoho_accounts_url"] or "https://accounts.zoho.eu"
        if any(not config[key] for key in _REQUIRED_KEYS):
            raise ZohoNotConfiguredError("Zoho credentials are not configured")
        return config

    async def is_configured(self, db: AsyncSession) -> bool:
        try:
            await self._load_config(db)
            return True
        except ZohoNotConfiguredError:
            return False

    async def get_access_token(self, db: AsyncSession) -> str:
        if self._access_token and time.monotonic() < self._expires_at:
            return self._access_token
        config = await self._load_config(db)
        try:
            async with self._client() as client:
                response = await client.post(
                    f"{config['zoho_accounts_url']}/oauth/v2/token",
                    data={
                        "grant_type": "refresh_token",
                        "client_id": config["zoho_client_id"],
                        "client_secret": config["zoho_client_secret"],
                        "refresh_token": config["zoho_refresh_token"],
                    },
                )
        except httpx.HTTPError as e:
            raise ZohoUpstreamError(f"Zoho accounts unreachable: {e.__class__.__name__}") from e
        payload = response.json() if response.content else {}
        token = payload.get("access_token")
        if response.status_code != 200 or not token:
            raise ZohoUpstreamError(payload.get("error") or f"Token refresh failed (HTTP {response.status_code})")
        self._access_token = token
        self._expires_at = time.monotonic() + int(payload.get("expires_in", 3600)) - _EXPIRY_MARGIN_SECONDS
        return token

    async def search_contacts(self, db: AsyncSession, query: str) -> list[dict]:
        config = await self._load_config(db)
        for attempt in (1, 2):
            token = await self.get_access_token(db)
            try:
                async with self._client() as client:
                    response = await client.get(
                        f"{config['zoho_base_url']}/books/v3/contacts",
                        params={"organization_id": config["zoho_organization_id"], "search_text": query},
                        headers={"Authorization": f"Zoho-oauthtoken {token}"},
                    )
            except httpx.HTTPError as e:
                raise ZohoUpstreamError(f"Zoho Books unreachable: {e.__class__.__name__}") from e
            if response.status_code == 401 and attempt == 1:
                self.invalidate_token()  # token revoked/expired early — refresh once
                continue
            if response.status_code != 200:
                raise ZohoUpstreamError(f"Zoho Books error (HTTP {response.status_code})")
            contacts = response.json().get("contacts", [])
            return [
                {
                    "id": c.get("contact_id", ""),
                    "name": c.get("contact_name", ""),
                    "company_name": c.get("company_name", ""),
                    "phone": c.get("phone", ""),
                    "mobile": c.get("mobile", ""),
                    "email": c.get("email", ""),
                }
                for c in contacts
            ]
        raise ZohoUpstreamError("Zoho Books rejected the refreshed token")  # unreachable guard


zoho_service = ZohoService()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/services/test_zoho_service.py -v`
Expected: 4 PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/zoho.py backend/tests/unit/services/test_zoho_service.py
git commit -m "feat(zoho): service with cached token refresh and Books contact search"
```

---

### Task 6: Zoho routes (status + contact search proxy)

**Files:**
- Create: `backend/app/api/routes/zoho.py`
- Modify: `backend/app/main.py` (import + include_router)
- Test: `backend/tests/unit/test_zoho_routes.py`

**Interfaces:**
- Consumes: `zoho_service`, `ZohoNotConfiguredError`, `ZohoUpstreamError` (Task 5); `require_any_permission_if_auth_enabled` from `backend.app.core.auth`.
- Produces HTTP API used by Tasks 7/9/10:
  - `GET /api/v1/zoho/status` → `{"configured": bool, "reachable": bool}` (any of `aito:create` | `settings:read`)
  - `GET /api/v1/zoho/contacts?q=<min 2 chars>` → `list[ZohoContact]`; 409 not configured; 502 upstream failure (`aito:create`)

- [ ] **Step 1: Write the failing tests** — `backend/tests/unit/test_zoho_routes.py`:

```python
"""Zoho proxy routes: status flags and contact search error mapping."""

import httpx
import pytest

from backend.app.services.zoho import zoho_service


@pytest.fixture(autouse=True)
def reset_service():
    zoho_service.invalidate_token()
    zoho_service.transport = None
    yield
    zoho_service.invalidate_token()
    zoho_service.transport = None


async def _configure(async_client):
    await async_client.put("/api/v1/settings/", json={
        "zoho_client_id": "1000.FAKE", "zoho_client_secret": "fake-secret",
        "zoho_refresh_token": "1000.fake.refresh", "zoho_organization_id": "999",
    })


@pytest.mark.asyncio
async def test_status_unconfigured(async_client):
    r = await async_client.get("/api/v1/zoho/status")
    assert r.status_code == 200
    assert r.json() == {"configured": False, "reachable": False}


@pytest.mark.asyncio
async def test_status_configured_reachable(async_client):
    await _configure(async_client)
    zoho_service.transport = httpx.MockTransport(
        lambda request: httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
    )
    assert (await async_client.get("/api/v1/zoho/status")).json() == {"configured": True, "reachable": True}


@pytest.mark.asyncio
async def test_contacts_409_when_unconfigured(async_client):
    assert (await async_client.get("/api/v1/zoho/contacts?q=ac")).status_code == 409


@pytest.mark.asyncio
async def test_contacts_min_query_length(async_client):
    await _configure(async_client)
    assert (await async_client.get("/api/v1/zoho/contacts?q=a")).status_code == 422


@pytest.mark.asyncio
async def test_contacts_search_and_upstream_error(async_client):
    await _configure(async_client)

    def ok_handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return httpx.Response(200, json={"contacts": [
            {"contact_id": "z1", "contact_name": "ACME", "company_name": "", "phone": "01",
             "mobile": "", "email": ""}]})

    zoho_service.transport = httpx.MockTransport(ok_handler)
    r = await async_client.get("/api/v1/zoho/contacts?q=acm")
    assert r.status_code == 200
    assert r.json()[0] == {"id": "z1", "name": "ACME", "company_name": "", "phone": "01",
                           "mobile": "", "email": ""}

    zoho_service.invalidate_token()
    zoho_service.transport = httpx.MockTransport(lambda request: httpx.Response(500))
    assert (await async_client.get("/api/v1/zoho/contacts?q=acm")).status_code == 502
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_zoho_routes.py -v`
Expected: FAIL, 404s

- [ ] **Step 3: Create the routes** — `backend/app/api/routes/zoho.py`:

```python
"""Zoho Books proxy: connection status + contact search for the Aito board."""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled, require_any_permission_if_auth_enabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.user import User
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoUpstreamError, zoho_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/zoho", tags=["zoho"])


class ZohoStatus(BaseModel):
    configured: bool
    reachable: bool


class ZohoContact(BaseModel):
    id: str
    name: str
    company_name: str
    phone: str
    mobile: str
    email: str


@router.get("/status", response_model=ZohoStatus)
async def zoho_status(
    db: AsyncSession = Depends(get_db),
    # Any-of: the Aito create modal (aito:create) AND the settings Test button
    # (settings:read) both need this endpoint.
    _: User | None = Depends(
        require_any_permission_if_auth_enabled(Permission.AITO_CREATE, Permission.SETTINGS_READ)
    ),
):
    if not await zoho_service.is_configured(db):
        return ZohoStatus(configured=False, reachable=False)
    try:
        await zoho_service.get_access_token(db)
        return ZohoStatus(configured=True, reachable=True)
    except ZohoUpstreamError as e:
        logger.warning("Zoho unreachable: %s", e)
        return ZohoStatus(configured=True, reachable=False)


@router.get("/contacts", response_model=list[ZohoContact])
async def search_contacts(
    q: str = Query(min_length=2, max_length=100),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE),
):
    try:
        return await zoho_service.search_contacts(db, q)
    except ZohoNotConfiguredError:
        raise HTTPException(status_code=409, detail="Zoho is not configured") from None
    except ZohoUpstreamError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
```

NOTE: if `require_any_permission_if_auth_enabled(...)` in this codebase already returns a `Depends`-wrapped dependency (check its definition at `backend/app/core/auth.py:1637`), drop the extra `Depends(...)` wrapper and match the existing call sites (`grep -rn "require_any_permission_if_auth_enabled" backend/app/api/routes/` for a usage example).

- [ ] **Step 4: Register the router** in `backend/app/main.py` (import + include next to `aito`):

```python
app.include_router(zoho.router, prefix=app_settings.api_prefix)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_zoho_routes.py -v`
Expected: 5 PASS. Then full backend sanity: `./test_backend.sh` from project root — expected PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/routes/zoho.py backend/app/main.py backend/tests/unit/test_zoho_routes.py
git commit -m "feat(zoho): status + contact search proxy routes"
```

---

### Task 7: Frontend API client + permission plumbing

**Files:**
- Modify: `frontend/src/api/client.ts` (types + `aitoApi`/`zohoApi`-style methods on the `api` object, following its existing `request<T>` pattern; `Permission` union at line ~3410; `AppSettings`/`AppSettingsUpdate` interfaces)
- Modify: `frontend/src/components/Layout.tsx` (`navPermissions` map)

**Interfaces:**
- Consumes: HTTP APIs from Tasks 3/6.
- Produces (used by Tasks 8/9/10):

```ts
export type AitoColumnId = 'devis' | 'model' | 'print' | 'finish';
export interface AitoProject {
  id: number; description: string; column: AitoColumnId; position: number;
  status: string; client_id: string | null; client_name: string | null;
  client_phone: string | null; created_at: string; updated_at: string;
}
export interface ZohoContact { id: string; name: string; company_name: string; phone: string; mobile: string; email: string; }
export interface ZohoStatus { configured: boolean; reachable: boolean; }
// methods on `api`:
//   getAitoProjects(): Promise<AitoProject[]>
//   createAitoProject(data: {description: string; client_id: string; client_name: string; client_phone?: string | null}): Promise<AitoProject>
//   importAitoProjects(data: {projects: {description: string; column: AitoColumnId; position: number}[]}): Promise<AitoProject[]>
//   moveAitoProject(id: number, data: {column: AitoColumnId; position: number}): Promise<AitoProject>
//   deleteAitoProject(id: number): Promise<void>
//   getZohoStatus(): Promise<ZohoStatus>
//   searchZohoContacts(q: string): Promise<ZohoContact[]>
```

- [ ] **Step 1: Add types + methods** to `frontend/src/api/client.ts`. Place the interfaces near the other domain types; add the methods on the `api` object next to the calculator methods, matching the surrounding style exactly (e.g. `getAitoProjects: () => request<AitoProject[]>('/aito/'),` and `searchZohoContacts: (q: string) => request<ZohoContact[]>(`/zoho/contacts?q=${encodeURIComponent(q)}`),` — DELETE and POST calls copy the option shape of neighboring methods).

- [ ] **Step 2: Extend the `Permission` union** (line ~3445, next to calculator):

```ts
  | 'aito:read' | 'aito:create' | 'aito:update' | 'aito:delete'
```

- [ ] **Step 3: Add the Zoho settings fields** to the `AppSettings` and `AppSettingsUpdate` TS interfaces in `client.ts` (find `interface AppSettings`): `zoho_client_id: string; zoho_client_secret: string; zoho_refresh_token: string; zoho_organization_id: string; zoho_base_url: string; zoho_accounts_url: string;` (optional `?` variants in the update type, matching neighbors).

- [ ] **Step 4: Gate the nav item.** In `frontend/src/components/Layout.tsx`, add to the `navPermissions` record:

```ts
      aito: 'aito:read',
```

- [ ] **Step 5: Verify compile**

Run: `cd frontend && npx tsc -b --clean >/dev/null 2>&1; npm run build`
Expected: build succeeds

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/components/Layout.tsx
git commit -m "feat(aito): API client methods, aito permissions, nav gating"
```

---

### Task 8: AitoPage on React Query (board, optimistic move, soft delete, card client display, localStorage migration)

**Files:**
- Modify: `frontend/src/pages/AitoPage.tsx`
- Test: `frontend/src/__tests__/pages/AitoPage.test.tsx`

**Interfaces:**
- Consumes: `api.getAitoProjects/moveAitoProject/deleteAitoProject/importAitoProjects`, `AitoProject`, `AitoColumnId` (Task 7).
- Produces: exports `AitoPage` (unchanged export name); keeps `STORAGE_KEY = 'aito-board-v1'` for the one-time migration; modal integration point for Task 9 stays `NewProjectModal` in the same file.

**Implementation notes (structure of the rewrite):**
- Replace `loadBoard`/save-effect with `useQuery({ queryKey: ['aito-projects'], queryFn: api.getAitoProjects })`.
- Keep a local `board: Board` state (same `Record<ColumnId, AitoProject[]>` shape) for dnd-kit's live drag-over moves; sync it from query data with `useEffect` grouping by `column`, sorting by `position` (skip syncing while `activeId` is non-null so a drag in progress is never clobbered by a refetch).
- `handleDragEnd`: after the local arrayMove, fire `moveMutation.mutate({id, column, position})`; `onError: invalidate ['aito-projects'] + showToast(t('aito.moveFailed'), 'error')`; `onSettled: invalidate`.
- Delete: `useMutation(api.deleteAitoProject)`, invalidate on settle; ConfirmModal message key switches to the soft-delete wording (`aito.deleteMessage` copy updated in Task 11).
- Migration effect: when the query has loaded AND returned `[]` AND `localStorage.getItem('aito-board-v1')` parses to ≥1 card, map each stored card (in column order devis/model/print/finish, preserving array order as `position`) to `{description, column, position}`, call `api.importAitoProjects`, then `localStorage.removeItem('aito-board-v1')` and invalidate. Wrap in try/catch; on failure keep the localStorage key (retry next visit).
- Card (`CardView`): add a header row `<span>#{project.id}</span>` (small, `text-bambu-gray`, `tabular-nums`) + when `client_name` is set, client name in `text-sm font-medium text-white` with `client_phone` underneath as `<a href={`tel:${project.client_phone}`} onPointerDown={e => e.stopPropagation()}>` in `text-xs text-bambu-gray hover:text-bambu-green`; description below; footer keeps date (add `title` tooltip including `t('aito.updated', {date: ...})`) + delete button.
- Creation mutation moves here too: `useMutation(api.createAitoProject)` — passed into `NewProjectModal` (Task 9 changes its signature to `onCreate(description, client)`).

- [ ] **Step 1: Write the failing tests** — `frontend/src/__tests__/pages/AitoPage.test.tsx` (copy msw `server.use` + render setup from `frontend/src/__tests__/pages/CalculatorPage.test.tsx`, using the repo's shared `render`/`server` test utils):

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { AitoPage } from '../../pages/AitoPage';

const project = {
  id: 12, description: 'Support GoPro', column: 'devis', position: 0, status: 'active',
  client_id: 'z1', client_name: 'ACME SARL', client_phone: '+33 6 12 34 56 78',
  created_at: '2026-07-01T10:00:00Z', updated_at: '2026-07-02T10:00:00Z',
};

beforeEach(() => {
  server.use(
    http.get('/api/v1/aito/', () => HttpResponse.json([project])),
    http.get('/api/v1/zoho/status', () => HttpResponse.json({ configured: true, reachable: true })),
  );
});

describe('AitoPage (backend board)', () => {
  it('renders project number, client name and tel: phone link', async () => {
    render(<AitoPage />);
    expect(await screen.findByText('#12')).toBeInTheDocument();
    expect(screen.getByText('ACME SARL')).toBeInTheDocument();
    const tel = screen.getByRole('link', { name: '+33 6 12 34 56 78' });
    expect(tel).toHaveAttribute('href', 'tel:+33 6 12 34 56 78');
  });

  it('renders clientless legacy cards without a client line', async () => {
    server.use(http.get('/api/v1/aito/', () =>
      HttpResponse.json([{ ...project, client_id: null, client_name: null, client_phone: null }])));
    render(<AitoPage />);
    expect(await screen.findByText('#12')).toBeInTheDocument();
    expect(screen.queryByText('ACME SARL')).not.toBeInTheDocument();
  });

  it('migrates localStorage cards once when backend board is empty', async () => {
    const imported = vi.fn();
    server.use(
      http.get('/api/v1/aito/', () => HttpResponse.json([])),
      http.post('/api/v1/aito/import', async ({ request }) => {
        imported(await request.json());
        return HttpResponse.json([], { status: 201 });
      }),
    );
    localStorage.setItem('aito-board-v1', JSON.stringify({
      devis: [{ id: 'x', description: 'legacy card', createdAt: '2026-07-01T00:00:00Z' }],
      model: [], print: [], finish: [],
    }));
    render(<AitoPage />);
    await waitFor(() => expect(imported).toHaveBeenCalledWith({
      projects: [{ description: 'legacy card', column: 'devis', position: 0 }],
    }));
    expect(localStorage.getItem('aito-board-v1')).toBeNull();
  });
});
```

Note: the repo's test utils mock `localStorage` via `vi.mocked(localStorage.*)` in some suites — if `localStorage.setItem` is a spy in the shared setup, follow `SettingsPage.test.tsx`'s `mockImplementation` pattern for `getItem` instead of real storage, and assert `localStorage.removeItem` was called with `'aito-board-v1'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/__tests__/pages/AitoPage.test.tsx`
Expected: FAIL (page still reads localStorage; no `#12`)

- [ ] **Step 3: Rewrite AitoPage** per the implementation notes above. Delete `loadBoard`, the save `useEffect`, and `crypto.randomUUID()` usage; project identity now comes from the backend.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/__tests__/pages/AitoPage.test.tsx`
Expected: 3 PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/AitoPage.tsx frontend/src/__tests__/pages/AitoPage.test.tsx
git commit -m "feat(aito): DB-backed board with optimistic moves, #id + client on cards, one-time migration"
```

---

### Task 9: Client combobox in the create modal

**Files:**
- Create: `frontend/src/components/aito/ClientCombobox.tsx`
- Modify: `frontend/src/pages/AitoPage.tsx` (`NewProjectModal`)
- Test: `frontend/src/__tests__/components/ClientCombobox.test.tsx`

**Interfaces:**
- Consumes: `api.searchZohoContacts`, `api.getZohoStatus`, `ZohoContact` (Task 7).
- Produces:

```tsx
export interface SelectedClient { id: string; name: string; phone: string | null; }
export function ClientCombobox({ value, onChange }: {
  value: SelectedClient | null;
  onChange: (client: SelectedClient | null) => void;
}): JSX.Element
```

**Behavior (all states):**
- Fetch `['zoho-status']` once (staleTime 60s). `configured === false` → render a notice box (`aito.zohoNotConfigured`) with a `<Link to="/settings?tab=zoho">` (`aito.zohoConfigureLink`); no input.
- Input styled with `inputCls`; label `aito.client` via `labelCls`. Debounce 300ms (setTimeout in `useEffect` keyed on the raw input), search fires only for trimmed length ≥ 2, via `useQuery({ queryKey: ['zoho-contacts', debounced], enabled: debounced.length >= 2 && !value })`.
- Dropdown: absolute-positioned listbox under the input (`role="listbox"`, options `role="option"` with `aria-selected`), each row shows name (white), company + phone (`text-xs text-bambu-gray`); `isFetching` → spinner row (`Loader2` + `aito.searching`); success + empty → `aito.noResults` row; query error → `aito.zohoUnreachable` row in `text-status-error`.
- Keyboard: ↑/↓ move `highlightedIndex`, Enter selects highlighted, Escape closes the dropdown (and only the dropdown — stopPropagation so the modal stays open).
- Selecting calls `onChange({ id, name, phone: contact.mobile || contact.phone || null })` and clears the input; the selected state renders a chip (name + phone, `bg-bambu-dark border border-bambu-green/40 rounded-lg`) with an × button that calls `onChange(null)`.
- Entrance/exit: dropdown uses `animate-slide-up` (150–200ms, consistent with the app's motion budget); no new keyframes needed.

**Modal integration (`NewProjectModal` in AitoPage.tsx):**
- New props: `onCreate(description: string, client: SelectedClient) => void`.
- State: `const [client, setClient] = useState<SelectedClient | null>(null);` — `<ClientCombobox value={client} onChange={setClient} />` rendered ABOVE the description field.
- `canSubmit = description.trim().length > 0 && client !== null`.
- Modal Escape handler must not close the modal while the combobox dropdown is open (the combobox stops propagation — verify manually).

- [ ] **Step 1: Write the failing tests** — `frontend/src/__tests__/components/ClientCombobox.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ClientCombobox } from '../../components/aito/ClientCombobox';

const contacts = [
  { id: 'z1', name: 'ACME SARL', company_name: 'ACME', phone: '', mobile: '+33 6 12 34 56 78', email: '' },
  { id: 'z2', name: 'Acmé Industrie', company_name: '', phone: '01 23 45 67 89', mobile: '', email: '' },
];

beforeEach(() => {
  server.use(
    http.get('/api/v1/zoho/status', () => HttpResponse.json({ configured: true, reachable: true })),
    http.get('/api/v1/zoho/contacts', ({ request }) => {
      const q = new URL(request.url).searchParams.get('q') ?? '';
      return HttpResponse.json(contacts.filter(c => c.name.toLowerCase().includes(q.toLowerCase())));
    }),
  );
});

describe('ClientCombobox', () => {
  it('searches after 2+ chars and selects a client with phone fallback', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ClientCombobox value={null} onChange={onChange} />);
    await user.type(screen.getByRole('textbox'), 'acm');
    const option = await screen.findByText('ACME SARL');
    await user.click(option);
    expect(onChange).toHaveBeenCalledWith({ id: 'z1', name: 'ACME SARL', phone: '+33 6 12 34 56 78' });
  });

  it('shows a chip with an unselect button when a client is chosen', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ClientCombobox value={{ id: 'z1', name: 'ACME SARL', phone: '+33 6 12 34 56 78' }} onChange={onChange} />);
    expect(screen.getByText('ACME SARL')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /remove|retirer|clear/i }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('renders a settings link instead of the input when Zoho is not configured', async () => {
    server.use(http.get('/api/v1/zoho/status', () => HttpResponse.json({ configured: false, reachable: false })));
    render(<ClientCombobox value={null} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(screen.getByRole('link')).toHaveAttribute('href', '/settings?tab=zoho');
  });
});
```

(The clear button's accessible name comes from `aria-label={t('aito.clearClient')}` — make the EN string "Remove client" so the regex matches.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/__tests__/components/ClientCombobox.test.tsx`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement `ClientCombobox.tsx` + modal integration** per the behavior list above. The create flow in AitoPage becomes `createMutation.mutate({ description, client_id: client.id, client_name: client.name, client_phone: client.phone })`, closing the modal + invalidating on success, `showToast(message, 'error')` on failure.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/__tests__/components/ClientCombobox.test.tsx src/__tests__/pages/AitoPage.test.tsx`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/aito/ClientCombobox.tsx frontend/src/pages/AitoPage.tsx frontend/src/__tests__/components/ClientCombobox.test.tsx
git commit -m "feat(aito): required Zoho client combobox in create modal"
```

---

### Task 10: Zoho settings tab

**Files:**
- Create: `frontend/src/components/ZohoSettings.tsx`
- Modify: `frontend/src/pages/SettingsPage.tsx` (add `'zoho'` to `validTabs` at line ~55, tab button in the tab bar, panel render, `registerSettingsSearch` entry)

**Interfaces:**
- Consumes: `api.getSettings`, `api.updateSettings`, `api.getZohoStatus` (Task 7).

**Behavior:**
- One Card (`id="card-zoho"`): six labelled inputs. `zoho_client_id`, `zoho_organization_id`, `zoho_base_url`, `zoho_accounts_url` are text inputs pre-filled from `getSettings`. `zoho_client_secret` and `zoho_refresh_token` are `type="password"` inputs that are ALWAYS empty on load with placeholder `••••••••` when `getZohoStatus().configured` is true (the API never returns them).
- Save button: builds the update payload from non-empty/changed fields ONLY — empty secret fields are omitted so saved secrets are never wiped. On success: toast `settings.saved` (reuse existing key if present, else `zoho.saved`), invalidate `['settings']` and `['zoho-status']`.
- Test connection button: calls `api.getZohoStatus()` fresh (bypass cache via `queryClient.fetchQuery` with `staleTime: 0`), then renders an inline status line — green `zoho.testOk` when `{configured: true, reachable: true}`, `text-status-error` `zoho.testUnreachable` when configured but unreachable, `zoho.testNotConfigured` otherwise.
- `registerSettingsSearch({ labelKey: 'zoho.title', tab: 'zoho', keywords: 'zoho books client crm contacts api oauth aito', anchor: 'card-zoho' })`.
- Tab is only reachable with `settings:read` (whole page already gated); Save requires `settings:update` (disable button like other panels do — copy the pattern from an existing settings panel).

- [ ] **Step 1: Implement the component + tab wiring** (follow `GitHubBackupSettings.tsx` for the form/save/toast shape and `SettingsPage.tsx`'s existing tab-button markup).

- [ ] **Step 2: Verify build + existing settings tests**

Run: `cd frontend && npm run build && npx vitest run src/__tests__/pages/SettingsPage.test.tsx`
Expected: build OK, SettingsPage tests PASS (tab lists in tests are not exhaustive; if one asserts the full tab set, add `'zoho'` there too)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/ZohoSettings.tsx frontend/src/pages/SettingsPage.tsx
git commit -m "feat(zoho): settings tab with write-only secrets and connection test"
```

---

### Task 11: i18n — all 12 locales

**Files:**
- Modify: all 12 files in `frontend/src/i18n/locales/` (en, de, es, fr, it, ja, ko, pt-BR, ru, tr, zh-CN, zh-TW)

**Keys (EN reference values — every key must exist in all 12 files with a native translation; the parity script rejects English copies in non-EN locales):**

Under the existing `aito` section:
```
client: 'Client'                       ← in the FR file: 'Client' is a legitimate FR word; if the
                                          parity gate flags it, add it to FR_COGNATES in
                                          frontend/scripts/check-i18n-parity.mjs
clientPlaceholder: 'Search a Zoho client…'
searching: 'Searching…'
noResults: 'No matching client'
clearClient: 'Remove client'
zohoNotConfigured: 'Zoho is not configured — client search is unavailable.'
zohoConfigureLink: 'Configure Zoho in Settings'
zohoUnreachable: 'Zoho is unreachable. Try again.'
moveFailed: 'Could not move the project — board reloaded.'
createFailed: 'Could not create the project.'
updated: 'Updated {{date}}'
```
Update the existing `aito.deleteMessage` in all 12 locales to the soft-delete wording — EN: `'Remove this project from the board? It stays stored and can be restored by an administrator.'` FR: `'Retirer ce projet du tableau ? Il reste enregistré et peut être restauré par un administrateur.'`

New top-level `zoho` section:
```
title: 'Zoho'
subtitle: 'Connect Zoho Books to search clients from the Aito board'
clientId: 'Client ID'
clientSecret: 'Client secret'
refreshToken: 'Refresh token'
organizationId: 'Organization ID'
baseUrl: 'API base URL'
accountsUrl: 'Accounts (OAuth) URL'
secretSaved: 'A value is saved. Leave empty to keep it.'
save: 'Save'
saved: 'Zoho settings saved'
test: 'Test connection'
testOk: 'Connected to Zoho'
testUnreachable: 'Zoho is unreachable — check the credentials.'
testNotConfigured: 'Not configured yet'
```
Plus `settings.tabZoho: 'Zoho'` if the tab bar uses per-tab label keys (check how the existing tabs get their labels and follow that pattern; 'Zoho' is a brand name — already allow-listed via the `Aito`-style brand regex? No: add `Zoho` to the brand-name regex alternation in `frontend/scripts/check-i18n-parity.mjs` line ~128, next to `Aito`).

FR translations (the primary user locale — exact strings): client: 'Client', clientPlaceholder: 'Rechercher un client Zoho…', searching: 'Recherche…', noResults: 'Aucun client correspondant', clearClient: 'Retirer le client', zohoNotConfigured: 'Zoho n\'est pas configuré — la recherche de clients est indisponible.', zohoConfigureLink: 'Configurer Zoho dans les réglages', zohoUnreachable: 'Zoho est injoignable. Réessayez.', moveFailed: 'Impossible de déplacer le projet — tableau rechargé.', createFailed: 'Impossible de créer le projet.', updated: 'Modifié le {{date}}'. zoho section FR: subtitle: 'Connectez Zoho Books pour rechercher des clients depuis le tableau Aito', clientSecret: 'Secret client', refreshToken: 'Jeton de rafraîchissement', organizationId: 'ID d\'organisation', baseUrl: 'URL de base de l\'API', accountsUrl: 'URL des comptes (OAuth)', secretSaved: 'Une valeur est enregistrée. Laisser vide pour la conserver.', saved: 'Réglages Zoho enregistrés', test: 'Tester la connexion', testOk: 'Connecté à Zoho', testUnreachable: 'Zoho est injoignable — vérifiez les identifiants.', testNotConfigured: 'Pas encore configuré'.

The remaining 10 locales (de, es, it, ja, ko, pt-BR, ru, tr, zh-CN, zh-TW) get native-quality translations of the same keys — same approach as the existing `aito` section (a Python injection script in the scratchpad is the proven method; reuse that pattern). The parity gate is the arbiter.

- [ ] **Step 1: Add the keys to all 12 locales** (script or manual edits).

- [ ] **Step 2: Run the gate**

Run: `cd frontend && npm run check:i18n`
Expected: `✓ All locales in parity with en` — fix any identical-to-en leaks by improving the translation (or adding genuine cognates like FR 'Client' to the cognate sets).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/i18n/locales/ frontend/scripts/check-i18n-parity.mjs
git commit -m "feat(aito,zoho): i18n for client search + Zoho settings across 12 locales"
```

---

### Task 12: Seed credentials locally + end-to-end verification

**Files:** none committed (local DB only)

- [ ] **Step 1: Seed the real credentials into the live dev DB** (`bambuddy.db` at repo root). Values come from the operator out-of-band — NEVER from this file. Either paste them into the Zoho settings tab in the UI (preferred — exercises the real save path), or insert via sqlite3 `INSERT INTO settings (key, value) VALUES ('zoho_client_id', '<value>') ON CONFLICT(key) DO UPDATE SET value=excluded.value;` for each of the six keys.

- [ ] **Step 2: Live smoke test** against the running dev backend:

Run: `curl -s http://localhost:8000/api/v1/zoho/status` → expected `{"configured":true,"reachable":true}`
Run: `curl -s 'http://localhost:8000/api/v1/zoho/contacts?q=<a real client prefix>'` → expected JSON array with real contacts

- [ ] **Step 3: Full suites** from project root:

```bash
cd frontend && npm run build && cd ..
./test_frontend.sh
./test_backend.sh
```
Expected: all PASS

- [ ] **Step 4: Manual UI walkthrough** at `http://localhost:5173/aito`: create a project with a real client, verify #id + name + tel: link on the card, drag it across all four columns, delete it, confirm the row still exists: `sqlite3 bambuddy.db "SELECT id, status FROM aito_projects ORDER BY id DESC LIMIT 3;"`

- [ ] **Step 5: Remind the operator** (paultheis) to rotate the Zoho client secret + refresh token in the Zoho API console, since they were pasted into a chat conversation.

- [ ] **Step 6: Final commit** (any straggler fixes)

```bash
git add -A && git status  # review: NO credential values may appear in the diff
git commit -m "feat(aito): Zoho Books client attribution — final polish"
```
