"""Permission matrix for the project file, search/tags/AI and Aito project-link routes.

Auth is on. Every route is driven from one table of (method, path, request kwargs, required
permission groups). A group is a tuple of alternatives: holding any one of them satisfies it.
For each route and each group the matrix asserts 403 for a caller who holds everything else
(plus unrelated project/Aito/library permissions) but nothing from that group, 403 for a caller
with no permission at all, and a control: a caller with every group satisfied gets past auth
(any status except 401/403/5xx; ids are nonexistent so 404 is typical, 409 for unconfigured AI).
"""

import pytest
from httpx import AsyncClient

from backend.app.core.auth import create_access_token, get_password_hash
from backend.app.core.config import settings as app_settings
from backend.app.core.permissions import Permission as P
from backend.app.models.group import Group
from backend.app.models.settings import Settings
from backend.app.models.user import User
from backend.app.services import project_storage

# Held by the "wrong" callers on top of the satisfied groups, minus the group under test, so a
# route gated by the wrong one of these (DELETE vs UPDATE, READ vs UPDATE...) is caught.
_NOISE = (
    P.PROJECTS_READ,
    P.PROJECTS_CREATE,
    P.PROJECTS_UPDATE,
    P.PROJECTS_DELETE,
    P.AITO_READ,
    P.AITO_UPDATE,
    P.LIBRARY_READ_ALL,
    P.LIBRARY_READ_OWN,
    P.LIBRARY_UPDATE_ALL,
    P.LIBRARY_UPDATE_OWN,
)

_FILE = {"files": ("part.3mf", b"not-a-real-3mf", "application/octet-stream")}
_ROUTES = [
    # project_files.py: router
    ("GET", "/projects/987654/tree", {}, [(P.PROJECTS_READ,)]),
    ("GET", "/projects/987654/orders", {}, [(P.PROJECTS_READ,), (P.AITO_READ,)]),
    ("POST", "/projects/987654/items", {"json": {"section": "impression", "name": "x"}}, [(P.PROJECTS_UPDATE,)]),
    ("PATCH", "/projects/items/987654", {"json": {"name": "y"}}, [(P.PROJECTS_UPDATE,)]),
    ("DELETE", "/projects/items/987654", {}, [(P.PROJECTS_DELETE,)]),
    ("POST", "/projects/items/987654/fork", {"json": {"revision_id": 1, "name": "z"}}, [(P.PROJECTS_UPDATE,)]),
    ("DELETE", "/projects/revisions/987654/files/1", {}, [(P.PROJECTS_UPDATE,)]),
    ("PATCH", "/projects/revisions/987654", {"json": {"note": "n"}}, [(P.PROJECTS_UPDATE,)]),
    ("DELETE", "/projects/revisions/987654", {}, [(P.PROJECTS_DELETE,)]),
    ("GET", "/projects/revisions/987654/download", {}, [(P.PROJECTS_READ,)]),
    (
        "POST",
        "/projects/987654/import-library-files",
        {"json": {"file_ids": [1]}},
        [(P.LIBRARY_UPDATE_ALL, P.LIBRARY_UPDATE_OWN), (P.PROJECTS_UPDATE,)],
    ),
    (
        "POST",
        "/projects/revisions/987654/reslice",
        {"json": {"file_id": 1, "pipeline_id": 1}},
        [(P.PROJECTS_UPDATE,), (P.LIBRARY_UPLOAD,), (P.PIPELINES_READ,)],
    ),
    ("POST", "/projects/legacy-migration/start", {}, [(P.SETTINGS_UPDATE,), (P.PROJECTS_UPDATE,)]),
    ("GET", "/projects/legacy-migration/status", {}, [(P.SETTINGS_UPDATE,), (P.PROJECTS_UPDATE,)]),
    # project_files.py: upload_router (authorised before the multipart body is read)
    ("POST", "/projects/items/987654/revisions", {"files": _FILE}, [(P.PROJECTS_UPDATE,)]),
    ("POST", "/projects/revisions/987654/files", {"files": _FILE}, [(P.PROJECTS_UPDATE,)]),
    # project_files.py: library_router
    (
        "GET",
        "/library/files/987654/project-suggestions",
        {},
        [(P.LIBRARY_READ_ALL, P.LIBRARY_READ_OWN), (P.PROJECTS_READ,)],
    ),
    # projects_pdm.py
    ("GET", "/projects/search", {"params": {"q": "x"}}, [(P.PROJECTS_READ,)]),
    ("GET", "/projects/tags", {}, [(P.PROJECTS_READ,)]),
    (
        "POST",
        "/projects/ai/reformulate",
        {"json": {"text": "bonjour", "field": "title"}},
        [(P.PROJECTS_CREATE, P.PROJECTS_UPDATE)],
    ),
    ("POST", "/projects/ai/suggest-tags", {"json": {"title": "Support"}}, [(P.PROJECTS_CREATE, P.PROJECTS_UPDATE)]),
    # aito_project_links.py: router + drop_router
    ("GET", "/aito/project-codes", {}, [(P.AITO_READ,), (P.PROJECTS_READ,)]),
    ("GET", "/aito/tasks/987654/project-suggestions", {}, [(P.AITO_READ,), (P.PROJECTS_READ,)]),
    ("PUT", "/aito/tasks/987654/project", {"json": {"project_id": None}}, [(P.AITO_UPDATE,), (P.PROJECTS_READ,)]),
    ("POST", "/aito/tasks/987654/project", {"json": {"name": "p"}}, [(P.AITO_UPDATE,), (P.PROJECTS_CREATE,)]),
    ("PUT", "/aito/tasks/987654/deliveries", {"json": {"revision_ids": []}}, [(P.AITO_UPDATE,), (P.PROJECTS_READ,)]),
    ("POST", "/aito/tasks/987654/files", {"files": _FILE}, [(P.AITO_UPDATE,), (P.PROJECTS_UPDATE,)]),
    ("GET", "/aito/987654/project-links", {}, [(P.AITO_READ,), (P.PROJECTS_READ,)]),
]


def _cases():
    for method, path, kwargs, groups in _ROUTES:
        for index, group in enumerate(groups):
            held = {g[0] for i, g in enumerate(groups) if i != index}
            noise = held | {p for p in _NOISE if p not in group}
            yield pytest.param(method, path, kwargs, noise, id=f"{method} {path} without {group[0].value}")
            yield pytest.param(method, path, kwargs, set(), id=f"{method} {path} nobody ({group[0].value})")


@pytest.fixture(autouse=True)
def roots(tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setattr(project_storage, "projects_root", lambda: projects)
    monkeypatch.setattr(app_settings, "base_dir", tmp_path)
    (tmp_path / "library").mkdir()


@pytest.fixture
async def headers_for(db_session):
    """Auth on; ``headers_for(perms)`` is a bearer header for a user whose one group holds exactly ``perms``."""
    db_session.add(Settings(key="auth_enabled", value="true"))
    made: list[int] = []

    async def make(permissions) -> dict[str, str]:
        n = len(made)
        made.append(n)
        group = Group(name=f"perm-matrix-{n}", permissions=sorted(p.value for p in permissions), is_system=False)
        db_session.add(group)
        await db_session.flush()
        user = User(username=f"perm-matrix-{n}", password_hash=get_password_hash("password"), is_active=True)
        user.groups.append(group)
        db_session.add(user)
        await db_session.commit()
        return {"Authorization": f"Bearer {create_access_token(data={'sub': user.username})}"}

    return make


def _send(client: AsyncClient, method: str, path: str, kwargs: dict, headers: dict):
    return client.request(method, f"/api/v1{path}", headers=headers, **kwargs)


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize(("method", "path", "kwargs", "permissions"), list(_cases()))
async def test_route_refuses_a_caller_missing_a_required_permission(
    async_client: AsyncClient, headers_for, method, path, kwargs, permissions
):
    response = await _send(async_client, method, path, kwargs, await headers_for(permissions))
    assert response.status_code == 403, response.text


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize(
    ("method", "path", "kwargs", "groups"),
    [pytest.param(m, p, k, g, id=f"{m} {p}") for m, p, k, g in _ROUTES],
)
async def test_route_lets_a_fully_permitted_caller_through(
    async_client: AsyncClient, headers_for, method, path, kwargs, groups
):
    response = await _send(async_client, method, path, kwargs, await headers_for({g[0] for g in groups}))
    assert response.status_code not in (401, 403) and response.status_code < 500, response.text


# API-key callers (T-208). Keys are legacy ownerless rows (user_id NULL), so the scope flags alone
# decide; every flag is set explicitly, so a changed column default cannot widen a profile.
_KEY_FLAGS = (
    "can_queue",
    "can_control_printer",
    "can_read_status",
    "can_manage_library",
    "can_manage_inventory",
    "can_manage_maintenance",
    "can_manage_archives",
    "can_manage_projects",
    "can_access_cloud",
    "can_update_energy_cost",
    "can_send_notifications",
)
_KEY_PROFILES = {
    "no scope": (),
    "can_read_status": ("can_read_status",),
    "can_manage_projects": ("can_manage_projects",),
    "can_read_status+can_manage_projects": ("can_read_status", "can_manage_projects"),
    "every scope": _KEY_FLAGS,
}
_READ = frozenset({"can_read_status", "can_read_status+can_manage_projects", "every scope"})
_MANAGE = frozenset({"can_manage_projects", "can_read_status+can_manage_projects", "every scope"})
_EVERY = frozenset({"every scope"})
_NO_KEY = frozenset()

# "METHOD path" -> (status a key that gets past auth receives, the profiles that get past auth).
# Every other profile gets 403. aito:read / aito:update and settings:update are API-key-denied, so
# the orders, legacy-migration and Aito link routes refuse every key, even one with every scope.
_KEY_MATRIX = {
    "GET /projects/987654/tree": (404, _READ),
    "GET /projects/987654/orders": (None, _NO_KEY),
    "POST /projects/987654/items": (404, _MANAGE),
    "PATCH /projects/items/987654": (404, _MANAGE),
    "DELETE /projects/items/987654": (404, _MANAGE),
    "POST /projects/items/987654/fork": (404, _MANAGE),
    "DELETE /projects/revisions/987654/files/1": (404, _MANAGE),
    "PATCH /projects/revisions/987654": (404, _MANAGE),
    "DELETE /projects/revisions/987654": (404, _MANAGE),
    "GET /projects/revisions/987654/download": (404, _READ),
    "POST /projects/987654/import-library-files": (404, _EVERY),
    "POST /projects/revisions/987654/reslice": (404, _EVERY),
    "POST /projects/legacy-migration/start": (None, _NO_KEY),
    "GET /projects/legacy-migration/status": (None, _NO_KEY),
    "POST /projects/items/987654/revisions": (404, _MANAGE),
    "POST /projects/revisions/987654/files": (404, _MANAGE),
    "GET /library/files/987654/project-suggestions": (404, _READ),
    "GET /projects/search": (200, _READ),
    "GET /projects/tags": (200, _READ),
    "POST /projects/ai/reformulate": (409, _MANAGE),
    "POST /projects/ai/suggest-tags": (409, _MANAGE),
    "GET /aito/project-codes": (None, _NO_KEY),
    "GET /aito/tasks/987654/project-suggestions": (None, _NO_KEY),
    "PUT /aito/tasks/987654/project": (None, _NO_KEY),
    "POST /aito/tasks/987654/project": (None, _NO_KEY),
    "PUT /aito/tasks/987654/deliveries": (None, _NO_KEY),
    "POST /aito/tasks/987654/files": (None, _NO_KEY),
    "GET /aito/987654/project-links": (None, _NO_KEY),
}


def _key_cases():
    for method, path, kwargs, _groups in _ROUTES:
        passing_status, passing = _KEY_MATRIX[f"{method} {path}"]
        for profile in _KEY_PROFILES:
            expected = passing_status if profile in passing else 403
            yield pytest.param(method, path, kwargs, profile, expected, id=f"{method} {path} key {profile}")


@pytest.fixture
async def key_for(db_session):
    """Auth on; ``key_for(profile)`` is an X-API-Key header for an ownerless key holding exactly that profile."""
    from backend.app.core.auth import generate_api_key
    from backend.app.models.api_key import APIKey

    db_session.add(Settings(key="auth_enabled", value="true"))

    async def make(profile: str) -> dict[str, str]:
        full_key, key_hash, key_prefix = generate_api_key()
        flags = {flag: flag in _KEY_PROFILES[profile] for flag in _KEY_FLAGS}
        db_session.add(
            APIKey(name=f"key-matrix-{profile}", key_hash=key_hash, key_prefix=key_prefix, enabled=True, **flags)
        )
        await db_session.commit()
        return {"X-API-Key": full_key}

    return make


def test_key_matrix_classifies_every_route():
    assert set(_KEY_MATRIX) == {f"{m} {p}" for m, p, _k, _g in _ROUTES}


def test_key_flags_cover_every_api_key_scope_column():
    from backend.app.models.api_key import APIKey

    assert set(_KEY_FLAGS) == {c.name for c in APIKey.__table__.columns if c.name.startswith("can_")}


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize(("method", "path", "kwargs", "profile", "expected"), list(_key_cases()))
async def test_route_answers_an_api_key_per_its_scopes(
    async_client: AsyncClient, key_for, method, path, kwargs, profile, expected
):
    response = await _send(async_client, method, path, kwargs, await key_for(profile))
    assert response.status_code == expected, response.text
    if expected == 403:
        assert "API key" in response.json()["detail"]
