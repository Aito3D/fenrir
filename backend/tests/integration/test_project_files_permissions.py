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

from backend.app.core.config import settings as app_settings
from backend.app.core.permissions import Permission as P
from backend.app.models.settings import Settings
from backend.app.services import project_storage
from backend.tests.project_fixtures import add_user_with_group, bearer_headers

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
        user = await add_user_with_group(
            db_session,
            username=f"perm-matrix-{n}",
            group_name=f"perm-matrix-{n}",
            permissions=sorted(p.value for p in permissions),
        )
        await db_session.commit()
        return bearer_headers(user)

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
    "POST /projects/revisions/987654/files": (400, _MANAGE),  # refused for every revision: one .3mf each
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


# Route completeness (T-209): every route under the swept prefixes is either driven by _ROUTES above
# or listed here with the reason it is not. A new PDM route, or a moved one, fails the sweep until
# it is classified, so it cannot ship without its permission, API-key and anonymous cases.
_SWEPT_PREFIXES = (
    "/api/v1/projects",
    "/api/v1/aito/tasks",
    "/api/v1/aito/project-codes",
    "/api/v1/library/files/{file_id}/project-suggestions",
)
_SWEPT_SUFFIXES = ("/project-links",)
_UPSTREAM_PROJECTS = "upstream routes/projects.py (Bambuddy projects), outside the PDM matrix"
_NOT_IN_MATRIX = {
    "PATCH /api/v1/aito/tasks/{task_id}": "Aito board task route (aito.py), covered by test_aito_permissions.py",
    "DELETE /api/v1/aito/tasks/{task_id}": "Aito board task route (aito.py), covered by test_aito_permissions.py",
    **dict.fromkeys(
        (
            "GET /api/v1/projects",
            "GET /api/v1/projects/",
            "POST /api/v1/projects/",
            "GET /api/v1/projects/templates",
            "POST /api/v1/projects/from-template/{template_id}",
            "GET /api/v1/projects/{project_id}",
            "PATCH /api/v1/projects/{project_id}",
            "DELETE /api/v1/projects/{project_id}",
            "GET /api/v1/projects/{project_id}/archives",
            "GET /api/v1/projects/{project_id}/queue",
            "GET /api/v1/projects/{project_id}/file-progress",
            "POST /api/v1/projects/{project_id}/add-archives",
            "POST /api/v1/projects/{project_id}/add-queue",
            "POST /api/v1/projects/{project_id}/remove-archives",
            "POST /api/v1/projects/{project_id}/attachments",
            "GET /api/v1/projects/{project_id}/attachments/{filename}",
            "DELETE /api/v1/projects/{project_id}/attachments/{filename}",
            "POST /api/v1/projects/{project_id}/cover-image",
            "GET /api/v1/projects/{project_id}/cover-image",
            "DELETE /api/v1/projects/{project_id}/cover-image",
            "GET /api/v1/projects/{project_id}/bom",
            "POST /api/v1/projects/{project_id}/bom",
            "PATCH /api/v1/projects/{project_id}/bom/{item_id}",
            "DELETE /api/v1/projects/{project_id}/bom/{item_id}",
            "POST /api/v1/projects/{project_id}/create-template",
            "GET /api/v1/projects/{project_id}/timeline",
            "GET /api/v1/projects/{project_id}/export",
            "POST /api/v1/projects/import",
            "POST /api/v1/projects/import/file",
        ),
        _UPSTREAM_PROJECTS,
    ),
}


def _api_routes():
    from fastapi.routing import APIRoute

    from backend.app.main import app

    return [route for route in app.routes if isinstance(route, APIRoute)]


def _swept_routes() -> set[str]:
    return {
        f"{method} {route.path}"
        for route in _api_routes()
        if route.path.startswith(_SWEPT_PREFIXES) or route.path.endswith(_SWEPT_SUFFIXES)
        for method in route.methods
    }


def _dispatched_route(method: str, path: str) -> str:
    """``METHOD template`` of the route Starlette serves ``method path`` from (first match wins)."""
    for route in _api_routes():
        if method in route.methods and route.path_regex.match(f"/api/v1{path}"):
            return f"{method} {route.path}"
    raise AssertionError(f"no route serves {method} {path}")


def test_permission_matrix_covers_every_swept_route():
    driven = {_dispatched_route(m, p) for m, p, _k, _g in _ROUTES}
    assert len(driven) == len(_ROUTES), "two _ROUTES entries hit the same route"
    assert not driven & set(_NOT_IN_MATRIX), "a route is both driven and allow-listed"
    swept = _swept_routes()
    assert swept - driven - set(_NOT_IN_MATRIX) == set(), "unclassified route: add it to _ROUTES or _NOT_IN_MATRIX"
    assert set(_NOT_IN_MATRIX) - swept == set(), "stale _NOT_IN_MATRIX entry: the route is gone"
    assert driven <= swept


def test_matrix_drives_every_route_of_the_pdm_routers():
    """Whatever their path, the routes of the PDM modules are all driven (none allow-listed)."""
    pdm_modules = {
        "backend.app.api.routes.project_files",
        "backend.app.api.routes.projects_pdm",
        "backend.app.api.routes.aito_project_links",
    }
    pdm = {
        f"{method} {route.path}"
        for route in _api_routes()
        if route.endpoint.__module__ in pdm_modules
        for method in route.methods
    }
    assert pdm == {_dispatched_route(m, p) for m, p, _k, _g in _ROUTES}


@pytest.fixture
async def auth_on(db_session):
    db_session.add(Settings(key="auth_enabled", value="true"))
    await db_session.commit()


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize(
    ("method", "path", "kwargs"),
    [pytest.param(m, p, k, id=f"{m} {p}") for m, p, k, _g in _ROUTES],
)
async def test_route_refuses_an_anonymous_caller(async_client: AsyncClient, auth_on, method, path, kwargs):
    """No Authorization and no X-API-Key header, auth on: 401 on every route (pinned)."""
    response = await _send(async_client, method, path, kwargs, {})
    assert response.status_code == 401, response.text
    assert response.json()["detail"] == "Authentication required"
