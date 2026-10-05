"""T-030: end-to-end negative-permission sweep for every Aito write route.

The two existing 403 tests in test_aito_routes.py
(test_create_with_a_decided_status_and_only_aito_create_is_403,
test_add_task_with_a_ticked_step_and_only_aito_create_is_403) both exercise a
SECONDARY, handler-BODY permission check. Their `_create_as`/`_add_task_as`
helpers override the route's `current_user` dependency wholesale with a plain
`User` object built from an arbitrary permission list — but
`RequirePermissionIfAuthEnabled`'s own enforcement (the `has_all_permissions`
check and its 403) lives INSIDE the callable being replaced, so overriding it
that way skips the primary gate entirely and only ever reaches whatever
extra check the handler body itself performs on `current_user`. It proves
nothing about whether an unauthorized caller is rejected by the gate that is
actually declared on all 21 write routes — a scratch run against every route
in this file, done via that same override technique with `permissions=[]`,
returned 404s and 422s instead of a single 403, which is what motivated this
file to hit the REAL dependency instead.

Every case below turns auth on via a `Settings` row, persists a genuine
user/group, and sends a genuine JWT over `Authorization` — the same technique
`test_printer_sensor_history.py`'s `TestDeleteOldHistoryRoleEnforcement` uses.
`require_permission_if_auth_enabled` (and its any-of sibling,
`require_any_permission_if_auth_enabled`, used only by `/proofread`) resolve
as FastAPI sub-dependencies BEFORE the path id is looked up or the body is
validated — pinned by
`test_permission_gate_rejects_a_nonexistent_id_and_an_invalid_body_before_either_is_reached`
below — so every case can target a project/task id that does not exist,
without seeding any real board state.
"""

import pytest

from backend.app.core.permissions import Permission
from backend.app.main import app

# An id that can never exist in a freshly-seeded test database. The gate
# fires before the handler ever looks the id up (see the ordering test
# below), so no fixture needs to create a real project or task for any of
# the cases in WRITE_ROUTES.
_MISSING_ID = 999_999_999


@pytest.fixture
async def aito_tokens(db_session):
    """Two real, persisted principals under auth-enabled: one holding NO aito
    permission at all, one holding only `aito:read` — the sibling read
    permission every write route's gate must still refuse. Neither may reach
    any of the 21 write routes below."""
    from backend.app.core.auth import create_access_token, get_password_hash
    from backend.app.models.group import Group
    from backend.app.models.settings import Settings
    from backend.app.models.user import User

    db_session.add(Settings(key="auth_enabled", value="true"))

    no_perm_group = Group(name="t030-no-aito", permissions=[], is_system=False)
    read_only_group = Group(name="t030-aito-read-only", permissions=[Permission.AITO_READ.value], is_system=False)
    db_session.add_all([no_perm_group, read_only_group])
    await db_session.flush()

    password_hash = get_password_hash("password")
    no_perm_user = User(username="t030-no-perm", password_hash=password_hash, is_active=True)
    no_perm_user.groups.append(no_perm_group)
    read_only_user = User(username="t030-read-only", password_hash=password_hash, is_active=True)
    read_only_user.groups.append(read_only_group)
    db_session.add_all([no_perm_user, read_only_user])
    await db_session.commit()

    return {
        "none": create_access_token(data={"sub": no_perm_user.username}),
        "read_only": create_access_token(data={"sub": read_only_user.username}),
    }


# Every RequirePermissionIfAuthEnabled(Permission.AITO_CREATE / AITO_UPDATE /
# AITO_DELETE) route in backend/app/api/routes/aito.py, plus /proofread
# (require_any_permission_if_auth_enabled(AITO_CREATE, AITO_UPDATE)) — 25 in
# total, confirmed by `grep -c` against the file. (route_name, method, url,
# json_body). `route_name` is the FastAPI route name (the handler's function
# name), used only in assertion failure messages here — unlike
# test_aito_routes.py's per-route helpers, nothing is overridden by name.
WRITE_ROUTES = [
    ("create_project", "post", "/api/v1/aito/", {"description": "x", "client_id": "c1", "client_name": "C"}),
    ("summarize_project", "post", "/api/v1/aito/summarize", {"tasks": [{"title": "t"}]}),
    ("proofread_field", "post", "/api/v1/aito/proofread", {"text": "bonjour"}),
    ("add_note", "post", f"/api/v1/aito/{_MISSING_ID}/events", {"note": "hello"}),
    ("send_invoice_email", "post", f"/api/v1/aito/{_MISSING_ID}/invoice-email", {"to": "a@b.pf"}),
    (
        "send_retainer_email",
        "post",
        f"/api/v1/aito/{_MISSING_ID}/retainer-email",
        {"to": "a@b.pf", "retainer_id": "RET-1"},
    ),
    ("create_invoice", "post", f"/api/v1/aito/{_MISSING_ID}/invoice", None),
    ("send_quote_email", "post", f"/api/v1/aito/{_MISSING_ID}/quote-email", {"to": "a@b.pf"}),
    ("add_task", "post", f"/api/v1/aito/{_MISSING_ID}/tasks", {}),
    ("update_task", "patch", f"/api/v1/aito/tasks/{_MISSING_ID}", {}),
    ("delete_task", "delete", f"/api/v1/aito/tasks/{_MISSING_ID}", None),
    ("reorder_tasks", "patch", f"/api/v1/aito/{_MISSING_ID}/tasks/reorder", {"task_ids": [1]}),
    ("import_legacy_projects", "post", "/api/v1/aito/import", {"projects": []}),
    ("move_project", "patch", f"/api/v1/aito/{_MISSING_ID}/move", {"column": "devis", "position": 0}),
    ("update_project", "patch", f"/api/v1/aito/{_MISSING_ID}", {}),
    ("edit_project_client", "put", f"/api/v1/aito/{_MISSING_ID}/client", {"first_name": "A", "last_name": "B"}),
    ("set_project_flag", "patch", f"/api/v1/aito/{_MISSING_ID}/flag", {"flag": "urgent"}),
    ("set_project_contacted", "patch", f"/api/v1/aito/{_MISSING_ID}/contacted", {"contacted": True}),
    ("generate_pickup_message", "post", f"/api/v1/aito/{_MISSING_ID}/pickup-message", None),
    ("send_pickup_sms", "post", f"/api/v1/aito/{_MISSING_ID}/pickup-sms", {"message": "hello"}),
    ("sync_project_now", "post", f"/api/v1/aito/{_MISSING_ID}/sync", None),
    ("set_quote_status", "post", f"/api/v1/aito/{_MISSING_ID}/quote-status", {"status": "sent"}),
    ("restore_project", "post", f"/api/v1/aito/{_MISSING_ID}/restore", None),
    ("delete_project", "delete", f"/api/v1/aito/{_MISSING_ID}", None),
    ("merge_project", "post", f"/api/v1/aito/{_MISSING_ID}/merge", {"source_project_id": 1}),
    (
        "transfer_tasks",
        "post",
        f"/api/v1/aito/{_MISSING_ID}/tasks/transfer",
        {"task_ids": [1], "target_project_id": None},
    ),
    ("transfer_client", "put", f"/api/v1/aito/{_MISSING_ID}/transfer-client", {"client_id": "z9", "client_name": "X"}),
    ("get_tracking_link", "get", f"/api/v1/aito/{_MISSING_ID}/tracking-link", None),
    ("regenerate_tracking_token", "post", f"/api/v1/aito/{_MISSING_ID}/tracking-token", None),
    ("set_watch", "put", f"/api/v1/aito/{_MISSING_ID}/watch", {"kinds": []}),
    ("refresh_payment_link", "post", f"/api/v1/aito/{_MISSING_ID}/payment-link/refresh", None),
    (
        "start_terminal_payment",
        "post",
        f"/api/v1/aito/{_MISSING_ID}/terminal-payment",
        {"document_kind": "invoice", "document_id": "x", "amount": 1},
    ),
    (
        "record_manual_payment_route",
        "post",
        f"/api/v1/aito/{_MISSING_ID}/manual-payment",
        {"document_kind": "invoice", "document_id": "x", "mode": "cash", "amount": 1},
    ),
    (
        "create_invoice_payment_link",
        "post",
        f"/api/v1/aito/{_MISSING_ID}/payment-link",
        {"document_id": "x", "amount": 1},
    ),
    ("cancel_invoice_payment_link", "post", f"/api/v1/aito/{_MISSING_ID}/payment-link/1/cancel", None),
    (
        "apply_invoice_deposit",
        "post",
        f"/api/v1/aito/{_MISSING_ID}/invoice-deposits/apply",
        {"invoice_id": "i", "retainer_id": "r", "amount": 1},
    ),
    ("force_sync_project", "post", f"/api/v1/aito/{_MISSING_ID}/force-sync", None),
    # T-037: found by the dynamic sweep below — gated with AITO_UPDATE like
    # every other mutation here, but never hand-added to this list.
    ("set_project_due_date", "patch", f"/api/v1/aito/{_MISSING_ID}/due-date", {"due_date": "2026-01-01"}),
    # Projects-PDM phase 3: task <-> project links.
    ("put_task_project", "put", f"/api/v1/aito/tasks/{_MISSING_ID}/project", {"project_id": None}),
    ("post_task_project", "post", f"/api/v1/aito/tasks/{_MISSING_ID}/project", {"name": "X"}),
    ("put_task_deliveries", "put", f"/api/v1/aito/tasks/{_MISSING_ID}/deliveries", {"revision_ids": []}),
]

assert len(WRITE_ROUTES) == 41, (
    "WRITE_ROUTES must cover exactly the 41 gated write routes aito.py and aito_payments.py declare"
)


# --------------------------------------------- T-037: dynamic app.routes sweep


def _is_permission_gate(dep_call) -> bool:
    """True for a callable produced by `require_permission_if_auth_enabled` or
    `require_any_permission_if_auth_enabled` — matched by `__qualname__`,
    mirroring test_zoho_permissions.py's identically-named helper (not
    imported from there: that file imports `aito_tokens` FROM this one, and
    importing back would just be a needless coupling for one tiny helper)."""
    qualname = getattr(dep_call, "__qualname__", "")
    return qualname.startswith("require_permission_if_auth_enabled.") or qualname.startswith(
        "require_any_permission_if_auth_enabled."
    )


# The public tracking route is unauthenticated BY DESIGN — the token itself
# is the credential (see its docstring in aito.py: "No auth: the token IS
# the credential"), and the auth middleware exempts this prefix. It is the
# only route in either file with no permission dependency at all, so it is
# excluded here explicitly rather than silently swallowed by a loose filter.
_PUBLIC_ROUTE_NAMES = {"get_tracking"}

# Genuine reads: gated with AITO_READ (never CREATE/UPDATE/DELETE or the
# any-of route), so they are not part of the hand-maintained WRITE_ROUTES
# sweep above — that list exists to prove a *mutation* is refused, and these
# already get 200-path coverage elsewhere (e.g. the board-listing tests).
# `get_tracking_link` is deliberately NOT here even though it is a GET: it
# mints a token as a side effect and is gated with AITO_UPDATE, which is
# exactly why it already sits in WRITE_ROUTES above.
_READ_ONLY_ROUTE_NAMES = {
    "list_projects",
    "list_trash",
    "get_aito_stats",
    "get_client_history",
    "get_client_rating",
    "list_shipping_services",
    "list_tasks",
    "list_events",
    "get_invoice",
    "get_invoice_preview",
    "get_invoice_pdf",
    "get_invoice_email",
    "get_retainer_email",
    "get_retainers",
    "get_invoice_deposits",
    "get_retainer_pdf",
    "get_quote_pdf",
    "get_quote_email",
    "get_terminal_payment",
    "get_watch",
    "get_project_codes",
    "get_project_links",
    "get_project_suggestions",
}


def _aito_routes():
    return [r for r in app.routes if getattr(r, "path", "").startswith("/api/v1/aito/")]


def test_every_aito_route_declares_a_permission_gate_or_is_the_public_tracking_route():
    """A NEW route added to aito.py or aito_payments.py without
    RequirePermissionIfAuthEnabled / require_any_permission_if_auth_enabled
    fails HERE, instead of silently escaping both this sweep and the
    hand-maintained WRITE_ROUTES parametrization below (T-037)."""
    aito_routes = _aito_routes()
    assert len(aito_routes) == 65, (
        "aito.py + aito_payments.py grew or shrank a route — update this count, "
        "WRITE_ROUTES, and _READ_ONLY_ROUTE_NAMES/_PUBLIC_ROUTE_NAMES together"
    )
    ungated = [
        r.name
        for r in aito_routes
        if r.name not in _PUBLIC_ROUTE_NAMES and not any(_is_permission_gate(d.call) for d in r.dependant.dependencies)
    ]
    assert ungated == [], f"these aito routes declare no permission gate: {ungated}"

    # Pin the other side of the exclusion too: if get_tracking ever grows a
    # gate, the exclusion above would start silently hiding that it is no
    # longer the sole ungated route — this fails loudly instead.
    public_routes = [r for r in aito_routes if r.name in _PUBLIC_ROUTE_NAMES]
    assert len(public_routes) == 1
    assert not any(_is_permission_gate(d.call) for d in public_routes[0].dependant.dependencies)


def test_every_gated_mutation_route_is_covered_by_write_routes():
    """Ties the hand-maintained WRITE_ROUTES list to the dynamic enumeration:
    every route that is neither the public tracking route nor a known
    read-only GET must appear in WRITE_ROUTES, so the `len(WRITE_ROUTES) ==
    31` count above is a derived fact, not a hand-typed one someone forgot
    to update (T-037)."""
    aito_routes = _aito_routes()
    excluded = _PUBLIC_ROUTE_NAMES | _READ_ONLY_ROUTE_NAMES
    dynamic_mutation_names = {r.name for r in aito_routes if r.name not in excluded}
    write_route_names = {r[0] for r in WRITE_ROUTES}

    missing = dynamic_mutation_names - write_route_names
    assert missing == set(), f"these gated mutation routes are missing from WRITE_ROUTES: {missing}"

    extra = write_route_names - dynamic_mutation_names
    assert extra == set(), f"WRITE_ROUTES lists routes no longer found (or now read-only/public): {extra}"

    assert len(WRITE_ROUTES) == len(dynamic_mutation_names)


@pytest.mark.asyncio
async def test_permission_gate_rejects_a_nonexistent_id_and_an_invalid_body_before_either_is_reached(
    async_client, aito_tokens
):
    """Pins the ordering the rest of this file's fixture strategy relies on:
    `update_project` targets an id that cannot exist, with a body missing
    every field `AitoNoteCreate`-shaped routes require — and still gets 403,
    not 404 (id looked up in the handler body) or 422 (body failed schema
    validation). The permission dependency runs first regardless."""
    r = await async_client.patch(
        f"/api/v1/aito/{_MISSING_ID}",
        json={},
        headers={"Authorization": f"Bearer {aito_tokens['none']}"},
    )
    assert r.status_code == 403

    # A body that would 422 on its own schema (add_note's `note` is
    # required, min_length=1) still 403s first.
    r = await async_client.post(
        f"/api/v1/aito/{_MISSING_ID}/events",
        json={},
        headers={"Authorization": f"Bearer {aito_tokens['none']}"},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
@pytest.mark.parametrize("route_name,method,url,body", WRITE_ROUTES, ids=[r[0] for r in WRITE_ROUTES])
@pytest.mark.parametrize("token_key", ["none", "read_only"])
async def test_write_route_rejects_a_caller_with_no_aito_permission(
    async_client, aito_tokens, token_key, route_name, method, url, body
):
    """A caller holding no aito permission at all, or only the sibling read
    permission (`aito:read`), must be refused by every one of the 21 write
    routes gated with RequirePermissionIfAuthEnabled(AITO_CREATE / AITO_UPDATE
    / AITO_DELETE) or require_any_permission_if_auth_enabled(AITO_CREATE,
    AITO_UPDATE)."""
    kwargs = {"headers": {"Authorization": f"Bearer {aito_tokens[token_key]}"}}
    if body is not None:
        kwargs["json"] = body
    r = await getattr(async_client, method)(url, **kwargs)
    assert r.status_code == 403, f"{route_name} ({method.upper()} {url}) as {token_key}: got {r.status_code}"
    assert "Missing required permissions" in r.json()["detail"]


# ------------------------------------------------------ no outbound calls


@pytest.mark.asyncio
async def test_send_quote_email_makes_no_outbound_call_when_rejected(async_client, aito_tokens, monkeypatch):
    from backend.app.services.zoho import zoho_service

    calls = []
    monkeypatch.setattr(zoho_service, "get_estimate_email_content", lambda *a, **k: calls.append("content"))
    monkeypatch.setattr(zoho_service, "email_estimate", lambda *a, **k: calls.append("email_estimate"))

    r = await async_client.post(
        f"/api/v1/aito/{_MISSING_ID}/quote-email",
        json={"to": "a@b.pf"},
        headers={"Authorization": f"Bearer {aito_tokens['none']}"},
    )
    assert r.status_code == 403
    assert calls == []


@pytest.mark.asyncio
async def test_send_invoice_email_makes_no_outbound_call_when_rejected(async_client, aito_tokens, monkeypatch):
    from backend.app.services.zoho import zoho_service

    calls = []
    monkeypatch.setattr(zoho_service, "list_project_invoices", lambda *a, **k: calls.append("list_invoices"))
    monkeypatch.setattr(zoho_service, "get_invoice_email_content", lambda *a, **k: calls.append("content"))
    monkeypatch.setattr(zoho_service, "email_invoice", lambda *a, **k: calls.append("email_invoice"))

    r = await async_client.post(
        f"/api/v1/aito/{_MISSING_ID}/invoice-email",
        json={"to": "a@b.pf"},
        headers={"Authorization": f"Bearer {aito_tokens['none']}"},
    )
    assert r.status_code == 403
    assert calls == []


@pytest.mark.asyncio
async def test_send_pickup_sms_makes_no_outbound_call_when_rejected(async_client, aito_tokens, monkeypatch):
    from backend.app.api.routes import aito as aito_routes

    calls = []

    async def fake_send_sms(*a, **k):
        calls.append("send_sms_notification")

    monkeypatch.setattr(aito_routes, "send_sms_notification", fake_send_sms)

    r = await async_client.post(
        f"/api/v1/aito/{_MISSING_ID}/pickup-sms",
        json={"message": "hello"},
        headers={"Authorization": f"Bearer {aito_tokens['none']}"},
    )
    assert r.status_code == 403
    assert calls == []


@pytest.mark.asyncio
async def test_generate_pickup_message_makes_no_outbound_call_when_rejected(async_client, aito_tokens, monkeypatch):
    from backend.app.api.routes import aito as aito_routes

    calls = []

    async def fake_pickup_message(*a, **k):
        calls.append("pickup_message")
        return "draft", "model"

    monkeypatch.setattr(aito_routes, "pickup_message", fake_pickup_message)

    r = await async_client.post(
        f"/api/v1/aito/{_MISSING_ID}/pickup-message",
        headers={"Authorization": f"Bearer {aito_tokens['none']}"},
    )
    assert r.status_code == 403
    assert calls == []


@pytest.mark.asyncio
async def test_summarize_project_makes_no_outbound_call_when_rejected(async_client, aito_tokens, monkeypatch):
    from backend.app.api.routes import aito as aito_routes

    calls = []

    async def fake_summarize_tasks(*a, **k):
        calls.append("summarize_tasks")
        return "summary", "model"

    monkeypatch.setattr(aito_routes, "summarize_tasks", fake_summarize_tasks)

    r = await async_client.post(
        "/api/v1/aito/summarize",
        json={"tasks": [{"title": "t"}]},
        headers={"Authorization": f"Bearer {aito_tokens['none']}"},
    )
    assert r.status_code == 403
    assert calls == []


@pytest.mark.asyncio
async def test_proofread_field_makes_no_outbound_call_when_rejected(async_client, aito_tokens, monkeypatch):
    from backend.app.api.routes import aito as aito_routes

    calls = []

    async def fake_proofread_text(*a, **k):
        calls.append("proofread_text")
        return "corrected", "model"

    monkeypatch.setattr(aito_routes, "proofread_text", fake_proofread_text)

    r = await async_client.post(
        "/api/v1/aito/proofread",
        json={"text": "bonjour"},
        headers={"Authorization": f"Bearer {aito_tokens['none']}"},
    )
    assert r.status_code == 403
    assert calls == []


# --------------------------------------------- T-024: AITO_READ is user-token only


@pytest.fixture
async def t024_read_status_api_key(async_client, db_session):
    """A real, persisted API key with `can_read_status=True` — the flag every
    other read permission maps to (PRINTERS_READ, SETTINGS_READ, ...). Also
    turns auth on, same as `aito_tokens` above."""
    from backend.app.core.auth import generate_api_key
    from backend.app.models.api_key import APIKey
    from backend.app.models.settings import Settings

    db_session.add(Settings(key="auth_enabled", value="true"))

    full_key, key_hash, key_prefix = generate_api_key()
    db_session.add(
        APIKey(
            name="t024-read-status",
            key_hash=key_hash,
            key_prefix=key_prefix,
            can_read_status=True,
            enabled=True,
        )
    )
    await db_session.commit()
    return full_key


@pytest.mark.asyncio
async def test_read_status_api_key_cannot_list_the_board(async_client, t024_read_status_api_key):
    """T-024: an API key holding only `can_read_status` (the flag it used to
    map to) must now be refused GET /api/v1/aito/ — the board carries client
    PII and quote totals, so it is no longer on the default API-key scope."""
    r = await async_client.get("/api/v1/aito/", headers={"X-API-Key": t024_read_status_api_key})
    assert r.status_code == 403
    assert "administrative operations" in r.json()["detail"]


@pytest.mark.asyncio
async def test_read_status_api_key_cannot_read_project_events(async_client, t024_read_status_api_key):
    """T-024, second Aito read route: /{project_id}/events is refused the
    same way — the permission gate runs before the (nonexistent) id is
    looked up, per
    test_permission_gate_rejects_a_nonexistent_id_and_an_invalid_body_before_either_is_reached
    above, so a missing id still proves the 403 comes from the gate."""
    r = await async_client.get(f"/api/v1/aito/{_MISSING_ID}/events", headers={"X-API-Key": t024_read_status_api_key})
    assert r.status_code == 403
    assert "administrative operations" in r.json()["detail"]


@pytest.mark.asyncio
async def test_aito_read_user_token_can_still_list_the_board(async_client, aito_tokens):
    """T-024 is scoped to the API-key allowlist only — a genuine user token
    holding `aito:read` is unaffected and still gets 200."""
    r = await async_client.get("/api/v1/aito/", headers={"Authorization": f"Bearer {aito_tokens['read_only']}"})
    assert r.status_code == 200
    assert r.json() == []
