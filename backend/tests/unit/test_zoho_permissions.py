"""T-021: real-JWT 403 sweep over every permission-gated route in
backend/app/api/routes/zoho.py.

Every one of these routes writes or reads client PII in Zoho Books (create a
contact, patch one, add/list contact persons, read a contact by id) or is the
create-flow's own search/preview surface. Before this file, nothing proved
the `RequirePermissionIfAuthEnabled` / `RequireAnyPermissionIfAuthEnabled`
dependency each one declares actually rejects an unauthorized caller — see
test_aito_permissions.py's docstring for why an override of `current_user`
(the technique used elsewhere in this suite) proves nothing about the REAL
dependency: it replaces the very callable that would enforce the gate.

Reuses `aito_tokens` from test_aito_permissions.py rather than duplicating
it: same two real, persisted principals (no aito permission at all; only the
sibling `aito:read`), same auth-enabled `Settings` row, same real JWT over
`Authorization`.
"""

import pytest

from backend.app.main import app
from backend.app.services.zoho import zoho_service
from backend.tests.unit.test_aito_permissions import aito_tokens  # noqa: F401

# A contact id that can never exist in a freshly-seeded test database.
# Irrelevant here anyway: the permission dependency runs before any of these
# handlers ever reads it — see
# test_permission_gate_rejects_a_nonexistent_id_and_an_invalid_body_before_either_is_reached
# in test_aito_permissions.py, which pins that ordering for the same
# RequirePermissionIfAuthEnabled mechanism these routes share.
_MISSING_CONTACT_ID = "zzz-missing-contact"


def _is_permission_gate(dep_call) -> bool:
    """True for a callable produced by `require_permission_if_auth_enabled`
    or `require_any_permission_if_auth_enabled` — matched by `__qualname__`
    rather than by the dependency parameter's NAME, because zoho.py declares
    every one of these as `_: User | None = ...` (unlike aito.py's
    `current_user`), so name-based matching would silently see nothing."""
    qualname = getattr(dep_call, "__qualname__", "")
    return qualname.startswith("require_permission_if_auth_enabled.") or qualname.startswith(
        "require_any_permission_if_auth_enabled."
    )


# Every @router.* in backend/app/api/routes/zoho.py — 9 in total, confirmed
# by `grep -n '^@router\|RequirePermissionIfAuthEnabled' backend/app/api/routes/zoho.py`.
# (route_name, method, url, json_body). None of these are gated on AITO_READ
# alone (they are all AITO_CREATE, AITO_UPDATE, or the any-of status route),
# so both `aito_tokens` below must be refused on every single one.
ZOHO_ROUTES = [
    ("zoho_status", "get", "/api/v1/zoho/status", None),
    ("search_contacts", "get", "/api/v1/zoho/contacts?q=ab", None),
    ("get_contact", "get", f"/api/v1/zoho/contacts/{_MISSING_CONTACT_ID}", None),
    ("create_contact", "post", "/api/v1/zoho/contacts", {"company_name": "Acme"}),
    ("patch_contact", "patch", f"/api/v1/zoho/contacts/{_MISSING_CONTACT_ID}", {}),
    ("list_contact_persons", "get", f"/api/v1/zoho/contacts/{_MISSING_CONTACT_ID}/persons", None),
    (
        "create_contact_person",
        "post",
        f"/api/v1/zoho/contacts/{_MISSING_CONTACT_ID}/persons",
        {"first_name": "A", "phone": "+689-87654321"},
    ),
    ("search_estimates", "get", "/api/v1/zoho/estimates", None),
    ("preview_estimate", "get", f"/api/v1/zoho/estimates/{_MISSING_CONTACT_ID}/preview", None),
]

assert len(ZOHO_ROUTES) == 9, "ZOHO_ROUTES must cover exactly the 9 gated routes zoho.py declares"


@pytest.mark.asyncio
async def test_every_zoho_route_declares_a_permission_gate():
    """A NEW route added to zoho.py without RequirePermissionIfAuthEnabled or
    RequireAnyPermissionIfAuthEnabled fails HERE, rather than silently
    escaping the sweep below (which only iterates ZOHO_ROUTES by hand)."""
    zoho_routes = [r for r in app.routes if getattr(r, "path", "").startswith("/api/v1/zoho/")]
    assert len(zoho_routes) == 9, "zoho.py grew or shrank a route — update ZOHO_ROUTES + this count together"
    ungated = [r.name for r in zoho_routes if not any(_is_permission_gate(d.call) for d in r.dependant.dependencies)]
    assert ungated == [], f"these zoho.py routes declare no permission gate: {ungated}"


@pytest.fixture
def no_zoho_egress(monkeypatch):
    """Blocks every outbound Zoho HTTP call at the single choke point every
    `zoho_service` method funnels through (`_client`, shared by `_send`'s
    Books calls and `get_access_token`'s own OAuth call) — proves a refused
    request never reaches Zoho, regardless of which method the handler would
    have called had the gate let it through."""
    calls: list[str] = []

    def blocked():
        calls.append("client")
        raise AssertionError("a refused zoho.py request reached Zoho")

    monkeypatch.setattr(zoho_service, "_client", blocked)
    return calls


@pytest.mark.asyncio
@pytest.mark.parametrize("route_name,method,url,body", ZOHO_ROUTES, ids=[r[0] for r in ZOHO_ROUTES])
@pytest.mark.parametrize("token_key", ["none", "read_only"])
async def test_zoho_route_rejects_a_caller_with_no_aito_permission(
    async_client, aito_tokens, no_zoho_egress, token_key, route_name, method, url, body
):
    """A caller holding no aito permission at all, or only the sibling read
    permission (`aito:read`), must be refused by every one of the 9
    permission-gated routes in zoho.py — and never reach Zoho doing it."""
    kwargs = {"headers": {"Authorization": f"Bearer {aito_tokens[token_key]}"}}
    if body is not None:
        kwargs["json"] = body
    r = await getattr(async_client, method)(url, **kwargs)
    assert r.status_code == 403, f"{route_name} ({method.upper()} {url}) as {token_key}: got {r.status_code}"
    assert "Missing required permissions" in r.json()["detail"]
    assert no_zoho_egress == [], f"{route_name} reached Zoho despite the 403"
