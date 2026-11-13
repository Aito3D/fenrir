"""The Order Board API: who may call what, and what the settings route accepts."""

import pytest

from backend.app.core.permissions import Permission
from backend.app.services import order_board_sync


@pytest.fixture
async def tokens(db_session):
    """Three persisted principals under auth-enabled: no orders permission,
    orders:read only, and both."""
    from backend.app.core.auth import create_access_token, get_password_hash
    from backend.app.models.group import Group
    from backend.app.models.settings import Settings
    from backend.app.models.user import User

    db_session.add(Settings(key="auth_enabled", value="true"))
    password_hash = get_password_hash("password")
    principals = {
        "none": [],
        "read": [Permission.ORDERS_READ.value],
        "both": [Permission.ORDERS_READ.value, Permission.ORDERS_UPDATE.value],
    }
    for name, perms in principals.items():
        group = Group(name=f"orders-{name}", permissions=perms, is_system=False)
        user = User(username=f"orders-{name}", password_hash=password_hash, is_active=True)
        user.groups.append(group)
        db_session.add_all([group, user])
    await db_session.commit()
    # Minted AFTER the commit: a token issued before its user's
    # password_changed_at is rejected as stale (401), and that stamp is set
    # when the row is saved. Minting first failed whenever a second ticked
    # over in between, which a loaded full-suite run made likely.
    return {
        name: {"Authorization": f"Bearer {create_access_token(data={'sub': f'orders-{name}'})}"} for name in principals
    }


SETTINGS = {"sync_enabled": True, "sync_minutes": 15, "max_age_days": 365, "core_brands": ["eSUN"]}


@pytest.mark.asyncio
async def test_read_needs_orders_read(async_client, tokens):
    assert (await async_client.get("/api/v1/order-board", headers=tokens["none"])).status_code == 403
    r = await async_client.get("/api/v1/order-board", headers=tokens["read"])
    assert r.status_code == 200
    assert set(r.json()) == {"rows", "computed_at", "stock_loaded_at", "sync"}
    assert set(r.json()["sync"]) == {
        "enabled",
        "configured",
        "running",
        "pending",
        "last_error",
        "last_error_at",
        "last_success_at",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "url", "body"),
    [
        ("post", "/api/v1/order-board/refresh", None),
        ("get", "/api/v1/order-board/settings", None),
        ("put", "/api/v1/order-board/settings", SETTINGS),
    ],
)
async def test_refresh_and_settings_need_orders_update(async_client, tokens, method, url, body):
    kwargs = {"json": body} if body else {}
    for who in ("none", "read"):
        r = await getattr(async_client, method)(url, headers=tokens[who], **kwargs)
        assert r.status_code == 403, f"{method.upper()} {url} as {who}: {r.status_code}"


@pytest.mark.asyncio
async def test_refresh_runs_one_pass_and_returns_the_board(async_client, tokens, monkeypatch):
    calls = []

    async def fake_pass(db):
        calls.append(db)
        return True

    monkeypatch.setattr(order_board_sync, "run_pass", fake_pass)
    r = await async_client.post("/api/v1/order-board/refresh", headers=tokens["both"])
    assert r.status_code == 200
    assert len(calls) == 1
    assert r.json()["rows"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "patch",
    [
        {"sync_minutes": 7},
        {"max_age_days": -1},
        {"max_age_days": 3651},
        {"core_brands": [" eSUN ", ""]},
        {"core_brands": ["x" * 61]},
        {"core_brands": [f"brand {n}" for n in range(31)]},
    ],
)
async def test_put_settings_rejects_bad_values(async_client, tokens, patch):
    r = await async_client.put("/api/v1/order-board/settings", headers=tokens["both"], json={**SETTINGS, **patch})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_put_settings_cleans_persists_and_returns_the_values(async_client, tokens):
    body = {"sync_enabled": False, "sync_minutes": 60, "max_age_days": 0, "core_brands": [" eSUN ", "esun", "Marlow"]}
    r = await async_client.put("/api/v1/order-board/settings", headers=tokens["both"], json=body)
    assert r.status_code == 200
    expected = {"sync_enabled": False, "sync_minutes": 60, "max_age_days": 0, "core_brands": ["eSUN", "Marlow"]}
    assert r.json() == expected
    assert (await async_client.get("/api/v1/order-board/settings", headers=tokens["both"])).json() == expected


@pytest.mark.asyncio
async def test_settings_defaults(async_client, tokens):
    r = await async_client.get("/api/v1/order-board/settings", headers=tokens["both"])
    assert r.json() == {
        "sync_enabled": True,
        "sync_minutes": 15,
        "max_age_days": 365,
        "core_brands": ["Bambu Lab", "eSUN", "SUNLU", "Polymaker", "Inslogic", "Magigoo"],
    }


@pytest.mark.asyncio
async def test_finished_routes_need_orders_read(async_client, tokens):
    for url in ("/api/v1/order-board/finished", "/api/v1/order-board/finished/so1"):
        assert (await async_client.get(url, headers=tokens["none"])).status_code == 403
    r = await async_client.get("/api/v1/order-board/finished", headers=tokens["read"])
    assert r.status_code == 200 and r.json() == {"rows": []}
    # Allowed through, then unknown: 404, not 403.
    assert (await async_client.get("/api/v1/order-board/finished/so1", headers=tokens["read"])).status_code == 404


@pytest.mark.asyncio
async def test_finished_detail_maps_busy_to_503_and_unknown_to_404(async_client, tokens, monkeypatch):
    from backend.app.services.zoho import ZohoNotConfiguredError, ZohoUpstreamError

    url = "/api/v1/order-board/finished/so1"
    outcomes = {
        order_board_sync.OrderNotFinished: (404, None),
        order_board_sync.ZohoBusy: (503, "Zoho is busy, try again shortly."),
        ZohoNotConfiguredError: (503, "Zoho Books is not connected."),
        ZohoUpstreamError: (502, None),
    }
    for exc, (status, detail) in outcomes.items():

        async def fake(db, salesorder_id, exc=exc):
            raise exc("x")

        monkeypatch.setattr(order_board_sync, "read_finished_order", fake)
        r = await async_client.get(url, headers=tokens["read"])
        assert r.status_code == status, exc
        if detail:
            assert r.json()["detail"] == detail

    async def fine(db, salesorder_id):
        return {"id": salesorder_id}

    monkeypatch.setattr(order_board_sync, "read_finished_order", fine)
    assert (await async_client.get(url, headers=tokens["read"])).json() == {"id": "so1"}


BASE = "/api/v1/order-board"
PICK = {"lines": [{"line_id": "l1", "quantity": 2}]}
PARCEL = {**PICK, "picklist_id": "pl1"}
HAND = {"mode": "pickup", "apply_credit": False}
INVOICE = {"apply_credit": True}
LINES = {"version": "v1", "lines": [{"line_id": "l1", "quantity": 3}]}
PARCEL_EDIT = {"version": "v1", "was": [{"line_id": "l1", "quantity": 2}], "lines": [{"line_id": "l1", "quantity": 1}]}
NEW_ROUTES = [
    ("post", f"{BASE}/orders/so1/prep-sheet", None, False),
    ("post", f"{BASE}/orders/so1/prep-sheet?picklist_id=pl1", None, False),
    ("get", f"{BASE}/orders/so1/picklist", None, False),
    ("post", f"{BASE}/orders/so1/picklists", PICK, True),
    ("get", f"{BASE}/orders/so1/picklists/pl1", None, False),
    ("post", f"{BASE}/orders/so1/packages", PARCEL, True),
    ("get", f"{BASE}/orders/so1/packages/p1/handover", None, False),
    ("post", f"{BASE}/orders/so1/packages/p1/handover", HAND, True),
    ("get", f"{BASE}/orders/so1/invoice", None, False),
    ("post", f"{BASE}/orders/so1/invoice", INVOICE, True),
    ("post", f"{BASE}/orders/so1/cancel", None, True),
    ("get", f"{BASE}/items?q=pla", None, False),
    ("put", f"{BASE}/orders/so1/lines", LINES, True),
    ("get", f"{BASE}/orders/so1/packages/p1", None, False),
    ("put", f"{BASE}/orders/so1/packages/p1", PARCEL_EDIT, True),
    ("get", f"{BASE}/invoices/inv1/pdf", None, False),
    ("get", f"{BASE}/invoices/inv1/email", None, False),
    ("post", f"{BASE}/invoices/inv1/email", {"to": "a@b.pf"}, True),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(("method", "url", "body", "writes"), NEW_ROUTES)
async def test_new_routes_need_their_permission(async_client, tokens, method, url, body, writes):
    kwargs = {"json": body} if body else {}
    denied = ("none", "read") if writes else ("none",)
    for who in denied:
        r = await getattr(async_client, method)(url, headers=tokens[who], **kwargs)
        assert r.status_code == 403, f"{method.upper()} {url} as {who}: {r.status_code}"
    if not writes:  # allowed through for orders:read: nothing is stored, so the order or invoice is unknown
        r = await getattr(async_client, method)(url, headers=tokens["read"], **kwargs)
        expected = 503 if "/items" in url else 404  # item search names no order: it reaches Books, unconfigured here
        assert r.status_code == expected, f"{method.upper()} {url}: {r.status_code}"


@pytest.mark.asyncio
async def test_prep_sheet_is_a_pdf_and_stamps_with_the_username(async_client, tokens, monkeypatch):
    from backend.app.services import order_board_actions as actions

    seen = {}

    async def fake_stamp(db, salesorder_id, by, picklist=None):
        seen.update(id=salesorder_id, by=by)
        return {"number": "SO-1", "lines": [], "customer": "X"}

    monkeypatch.setattr(actions, "stamp_print", fake_stamp)
    monkeypatch.setattr("backend.app.api.routes.order_board.board.render_prep_sheet", lambda row, **kw: b"%PDF-fake")
    r = await async_client.post(f"{BASE}/orders/so1/prep-sheet", headers=tokens["read"])
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert r.content.startswith(b"%PDF-")
    assert (
        r.headers["content-disposition"].startswith("inline;")
        and "bon-de-preparation.pdf" in r.headers["content-disposition"]
    )
    assert r.headers["cache-control"] == "no-store"
    assert seen == {"id": "so1", "by": "orders-read"}


@pytest.mark.asyncio
async def test_prep_sheet_renders_a_real_pdf(async_client, tokens, monkeypatch):
    from backend.app.services import order_board_actions as actions

    async def fake_stamp(db, salesorder_id, by, picklist=None):
        return {"number": "SO-1", "customer": "X", "lines": [], "printed": None}

    monkeypatch.setattr(actions, "stamp_print", fake_stamp)
    r = await async_client.post(f"{BASE}/orders/so1/prep-sheet", headers=tokens["read"])
    assert r.status_code == 200 and r.content.startswith(b"%PDF-")


@pytest.mark.asyncio
async def test_create_parcel_returns_the_board_and_the_number(async_client, tokens, monkeypatch):
    from backend.app.services import order_board_actions as actions

    seen = {}

    async def fake(db, salesorder_id, picklist_id, quantities, by=None):
        seen["q"] = (picklist_id, quantities)
        return "PKG-7"

    monkeypatch.setattr(actions, "create_parcel", fake)
    r = await async_client.post(f"{BASE}/orders/so1/packages", headers=tokens["both"], json=PARCEL)
    assert r.status_code == 200
    assert r.json()["package_number"] == "PKG-7"
    assert "rows" in r.json()["board"]
    assert seen["q"] == ("pl1", {"l1": 2})


@pytest.mark.asyncio
async def test_picklist_routes_pass_the_choice_through(async_client, tokens, monkeypatch):
    from backend.app.services import order_board_actions as actions

    seen = {}

    async def fake_create(db, salesorder_id, quantities, by=None):
        seen["q"] = quantities
        return {"id": "pl1", "number": "PL-00013"}

    async def fake_preview(db, salesorder_id):
        return {"lines": [{"line_id": "l1", "quantity": 3}]}

    async def fake_content(db, salesorder_id, picklist_id):
        return {"id": picklist_id, "number": "PL-00013", "status": "yet_to_start", "lines": PICK["lines"]}

    monkeypatch.setattr(actions, "create_picklist", fake_create)
    monkeypatch.setattr(actions, "picklist_preview", fake_preview)
    monkeypatch.setattr(actions, "picklist_content", fake_content)
    r = await async_client.post(f"{BASE}/orders/so1/picklists", headers=tokens["both"], json=PICK)
    assert r.status_code == 200
    assert r.json()["picklist"] == {"id": "pl1", "number": "PL-00013"} and "rows" in r.json()["board"]
    assert seen["q"] == {"l1": 2}
    r = await async_client.get(f"{BASE}/orders/so1/picklist", headers=tokens["read"])
    assert r.json() == {"lines": [{"line_id": "l1", "quantity": 3}]}
    r = await async_client.get(f"{BASE}/orders/so1/picklists/pl1", headers=tokens["read"])
    assert r.json()["number"] == "PL-00013"


@pytest.mark.asyncio
async def test_prep_sheet_of_a_picklist_prints_its_units_and_number(async_client, tokens, monkeypatch):
    from backend.app.services import order_board_actions as actions

    seen = {}

    async def fake_stamp(db, salesorder_id, by, picklist=None):
        return {"number": "SO-1", "lines": [], "customer": "X"}

    async def fake_content(db, salesorder_id, picklist_id):
        return {"id": picklist_id, "number": "PL-00013", "status": "yet_to_start", "lines": PICK["lines"]}

    def fake_render(row, **kw):
        seen.update(kw)
        return b"%PDF-fake"

    monkeypatch.setattr(actions, "stamp_print", fake_stamp)
    monkeypatch.setattr(actions, "picklist_content", fake_content)
    monkeypatch.setattr("backend.app.api.routes.order_board.board.render_prep_sheet", fake_render)
    r = await async_client.post(f"{BASE}/orders/so1/prep-sheet?picklist_id=pl1", headers=tokens["read"])
    assert r.status_code == 200
    assert (seen["quantities"], seen["picklist_number"]) == ({"l1": 2}, "PL-00013")


@pytest.mark.asyncio
async def test_handover_and_invoice_return_board_and_outcome(async_client, tokens, monkeypatch):
    from backend.app.services import order_board_actions as actions

    calls = []

    async def fake_hand(db, so, pkg, *, mode, apply_credit, by=None):
        calls.append(("hand", so, pkg, mode, apply_credit))
        return {"invoice": "created"}

    async def fake_inv(db, so, *, apply_credit, scope, by=None):
        calls.append(("inv", so, apply_credit, scope))
        return {"invoice": "none"}

    async def fake_preview(db, so, pkg):
        return {"package": pkg}

    monkeypatch.setattr(actions, "hand_over", fake_hand)
    monkeypatch.setattr(actions, "invoice_shipped", fake_inv)
    monkeypatch.setattr(actions, "handover_preview", fake_preview)
    h = tokens["both"]
    r = await async_client.post(f"{BASE}/orders/so1/packages/p1/handover", headers=h, json=HAND)
    assert r.json()["outcome"] == {"invoice": "created"} and "rows" in r.json()["board"]
    r = await async_client.post(f"{BASE}/orders/so1/invoice", headers=h, json=INVOICE)
    assert r.json()["outcome"] == {"invoice": "none"} and "rows" in r.json()["board"]
    r = await async_client.post(f"{BASE}/orders/so1/invoice", headers=h, json={**INVOICE, "scope": "packed"})
    r = await async_client.get(f"{BASE}/orders/so1/packages/p1/handover", headers=tokens["read"])
    assert r.json() == {"package": "p1"}
    assert calls == [
        ("hand", "so1", "p1", "pickup", False),
        ("inv", "so1", True, "shipped"),
        ("inv", "so1", True, "packed"),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("url", "body"),
    [
        ("orders/so1/packages", PICK),  # no picklist: a parcel is always made from one
        ("orders/so1/packages", {"picklist_id": "", **PICK}),
        ("orders/so1/picklists", {"lines": []}),
        ("orders/so1/picklists", {"lines": [{"line_id": "l1", "quantity": 0}]}),
        ("orders/so1/picklists", {"lines": [{"line_id": "l1", "quantity": -1}]}),
        ("orders/so1/picklists", {"lines": [{"line_id": "l1", "quantity": 1}, {"line_id": "l1", "quantity": 2}]}),
        ("orders/so1/picklists", {"lines": [{"line_id": "l1", "quantity": 1}] * 201}),
        ("orders/so1/picklists", {"lines": [{"line_id": "l1", "quantity": "inf"}]}),
        ("orders/so1/picklists", {"lines": [{"line_id": "l1", "quantity": "nan"}]}),
        ("orders/so1/packages/p1/handover", {"mode": "teleport", "apply_credit": False}),
        ("orders/so1/packages/p1/handover", {"mode": "pickup"}),
        ("orders/so1/invoice", {}),
        ("orders/so1/invoice", {"apply_credit": True, "scope": "everything"}),
    ],
)
async def test_bodies_are_validated(async_client, tokens, url, body):
    r = await async_client.post(f"{BASE}/{url}", headers=tokens["both"], json=body)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_action_errors_map_to_statuses(async_client, tokens, monkeypatch):
    from backend.app.services import order_board_actions as actions
    from backend.app.services.zoho import ZohoNotConfiguredError, ZohoRequestRejected, ZohoUpstreamError

    cases = [
        (actions.OrderNotOnBoard("x"), 404, None),
        (order_board_sync.OrderNotStored("x"), 404, None),
        (actions.OrderActionRefused("too_many"), 400, "too_many"),
        (actions.OrderActionRefused("version"), 400, "version"),
        (actions.OrderActionRefused("package_changed"), 400, "package_changed"),
        (actions.OrderBusy("x"), 409, None),
        (order_board_sync.ZohoBusy("x"), 503, "Zoho is busy, try again shortly."),
        (ZohoNotConfiguredError("x"), 503, None),
        (ZohoRequestRejected("Books says no"), 502, "Books says no"),
        (ZohoUpstreamError("boom"), 502, "boom"),
    ]
    for exc, status, detail in cases:

        async def boom(*a, exc=exc, **k):
            raise exc

        for name in (
            "create_parcel",
            "hand_over",
            "invoice_shipped",
            "handover_preview",
            "invoice_preview",
            "stamp_print",
            "create_picklist",
            "picklist_preview",
            "picklist_content",
            "cancel_order",
            "search_items",
            "edit_lines",
            "package_content",
            "edit_parcel",
        ):
            monkeypatch.setattr(actions, name, boom)
        calls = [
            ("post", "orders/so1/picklists", PICK),
            ("get", "orders/so1/picklist", None),
            ("get", "orders/so1/picklists/pl1", None),
            ("post", "orders/so1/prep-sheet?picklist_id=pl1", None),
            ("post", "orders/so1/packages", PARCEL),
            ("post", "orders/so1/packages/p1/handover", HAND),
            ("post", "orders/so1/invoice", INVOICE),
            ("post", "orders/so1/cancel", None),
            ("get", "orders/so1/packages/p1/handover", None),
            ("get", "orders/so1/invoice", None),
            ("post", "orders/so1/prep-sheet", None),
            ("get", "items?q=pla", None),
            ("put", "orders/so1/lines", LINES),
            ("get", "orders/so1/packages/p1", None),
            ("put", "orders/so1/packages/p1", PARCEL_EDIT),
        ]
        for method, url, body in calls:
            kwargs = {"json": body} if body else {}
            r = await getattr(async_client, method)(f"{BASE}/{url}", headers=tokens["both"], **kwargs)
            assert r.status_code == status, (type(exc).__name__, url, r.status_code)
            if detail:
                assert r.json()["detail"] == detail


@pytest.mark.asyncio
async def test_invoice_pdf_only_for_an_invoice_of_a_stored_order(async_client, tokens, db_session, monkeypatch):
    from backend.app.models.order_board_doc import OrderBoardDoc
    from backend.app.services.zoho import zoho_service

    fetched = []

    async def fake_pdf(db, invoice_id):
        fetched.append(invoice_id)
        return b"%PDF-inv"

    monkeypatch.setattr(zoho_service, "get_invoice_pdf", fake_pdf)
    db_session.add(
        OrderBoardDoc(kind="salesorder", zoho_id="so1", header={}, detail={"invoices": [{"invoice_id": "inv1"}]})
    )
    db_session.add(OrderBoardDoc(kind="salesorder", zoho_id="so2", header={}, detail=None))
    await db_session.commit()
    r = await async_client.get(f"{BASE}/invoices/other/pdf", headers=tokens["read"])
    assert r.status_code == 404 and fetched == []
    r = await async_client.get(f"{BASE}/invoices/inv1/pdf", headers=tokens["read"])
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    assert r.content.startswith(b"%PDF-") and fetched == ["inv1"]
    assert r.headers["content-disposition"].startswith("inline;") and "facture.pdf" in r.headers["content-disposition"]
    assert r.headers["cache-control"] == "no-store"


@pytest.mark.asyncio
async def test_invoice_pdf_errors_map_to_statuses(async_client, tokens, db_session, monkeypatch):
    from backend.app.models.order_board_doc import OrderBoardDoc
    from backend.app.services.zoho import (
        ZohoNotConfiguredError,
        ZohoRateLimited,
        ZohoRequestRejected,
        ZohoUpstreamError,
        zoho_service,
    )

    db_session.add(
        OrderBoardDoc(kind="salesorder", zoho_id="so1", header={}, detail={"invoices": [{"invoice_id": "inv1"}]})
    )
    await db_session.commit()
    cases = [
        (order_board_sync.ZohoBusy("x"), 503, "Zoho is busy, try again shortly."),
        (ZohoNotConfiguredError("x"), 503, "Zoho Books is not connected."),
        (ZohoRequestRejected("Books says no"), 502, "Books says no"),
        (ZohoUpstreamError("x" * 500), 502, "x" * 300),
        (ZohoRateLimited("slow down"), 502, "slow down"),
    ]
    for exc, status, detail in cases:

        async def boom(db, invoice_id, exc=exc):
            raise exc

        monkeypatch.setattr(zoho_service, "get_invoice_pdf", boom)
        r = await async_client.get(f"{BASE}/invoices/inv1/pdf", headers=tokens["read"])
        assert (r.status_code, r.json()["detail"]) == (status, detail), type(exc).__name__


@pytest.mark.asyncio
async def test_a_rate_limited_write_is_a_502_with_the_reason(async_client, tokens, monkeypatch):
    from backend.app.services import order_board_actions as actions
    from backend.app.services.zoho import ZohoRateLimited

    async def boom(*a, **k):
        raise ZohoRateLimited("slow down")

    monkeypatch.setattr(actions, "create_parcel", boom)
    r = await async_client.post(f"{BASE}/orders/so1/packages", headers=tokens["both"], json=PARCEL)
    assert (r.status_code, r.json()["detail"]) == (502, "slow down")


@pytest.mark.asyncio
async def test_a_books_failure_is_logged_without_its_message(async_client, tokens, monkeypatch, caplog):
    import logging

    from backend.app.services import order_board_actions as actions
    from backend.app.services.zoho import ZohoRequestRejected

    async def hand_over(*a, **k):
        raise ZohoRequestRejected("Customer Jane Doe has no item Widget")

    monkeypatch.setattr(actions, "hand_over", hand_over)
    with caplog.at_level(logging.WARNING):
        r = await async_client.post(f"{BASE}/orders/so1/packages/p1/handover", headers=tokens["both"], json=HAND)
    assert (r.status_code, r.json()["detail"]) == (502, "Customer Jane Doe has no item Widget")
    assert "Jane" not in caplog.text
    assert "step=hand_over" in caplog.text and "ZohoRequestRejected" in caplog.text


@pytest.mark.asyncio
async def test_cancel_returns_the_board(async_client, tokens, monkeypatch):
    from backend.app.services import order_board_actions as actions

    calls = []

    async def fake_cancel(db, so, by=None):
        calls.append(so)

    monkeypatch.setattr(actions, "cancel_order", fake_cancel)
    r = await async_client.post(f"{BASE}/orders/so1/cancel", headers=tokens["both"])
    assert r.status_code == 200 and "rows" in r.json()["board"] and calls == ["so1"]


@pytest.fixture
def invoice_mail(monkeypatch):
    """A fake Books for the invoice email: what it offers, what it was asked to send, and the re-read."""
    from backend.app.api.routes import aito as aito_routes
    from backend.app.services.zoho import zoho_service

    aito_routes._reset_recent_emails()
    aito_routes._ai_rate_limit_calls.clear()
    book = {"sent": [], "refreshed": [], "error": None}

    async def content(db, invoice_id):
        return {
            "subject": "Facture FA-1",
            "body": "<p>Bonjour</p>",
            "recipients": [
                {"email": "compta@client.pf", "name": "Compta", "contact_person_id": "cp1"},
                {"email": "Moana@client.pf", "name": "Moana", "contact_person_id": "cp2"},
            ],
        }

    async def send(db, invoice_id, *, to_mail_ids):
        if book["error"]:
            raise book["error"]
        book["sent"].append((invoice_id, to_mail_ids))

    async def refresh(db, salesorder_id):
        book["refreshed"].append(salesorder_id)

    monkeypatch.setattr(zoho_service, "get_invoice_email_content", content)
    monkeypatch.setattr(zoho_service, "email_invoice", send)
    monkeypatch.setattr(order_board_sync, "refresh_order", refresh)
    yield book
    aito_routes._reset_recent_emails()
    aito_routes._ai_rate_limit_calls.clear()


async def _store_invoiced_order(db_session, contact_email="moana@client.pf"):
    from backend.app.models.order_board_doc import OrderBoardDoc

    detail = {
        "salesorder_number": "SO-1",
        "invoices": [{"invoice_id": "inv1", "invoice_number": "FA-1"}],
        "contact_person_details": [{"first_name": "Moana", "email": contact_email}],
    }
    db_session.add(OrderBoardDoc(kind="salesorder", zoho_id="so1", header={}, detail=detail))
    await db_session.commit()


@pytest.mark.asyncio
async def test_invoice_email_preview_preselects_the_order_contact(async_client, tokens, db_session, invoice_mail):
    await _store_invoiced_order(db_session)
    r = await async_client.get(f"{BASE}/invoices/other/email", headers=tokens["read"])
    assert r.status_code == 404
    r = await async_client.get(f"{BASE}/invoices/inv1/email", headers=tokens["read"])
    assert r.status_code == 200
    body = r.json()
    assert body["subject"] == "Facture FA-1" and body["body"] == "<p>Bonjour</p>"
    assert [x["email"] for x in body["recipients"]] == ["compta@client.pf", "Moana@client.pf"]
    # The order's contact, in the casing Books offers it: the select binds to the option values.
    assert body["default_email"] == "Moana@client.pf"
    assert (body["invoice_id"], body["invoice_number"]) == ("inv1", "FA-1")


@pytest.mark.asyncio
async def test_invoice_email_preview_falls_back_to_the_first_address(async_client, tokens, db_session, invoice_mail):
    await _store_invoiced_order(db_session, contact_email="")
    r = await async_client.get(f"{BASE}/invoices/inv1/email", headers=tokens["read"])
    assert r.json()["default_email"] == "compta@client.pf"


@pytest.mark.asyncio
async def test_send_invoice_email_goes_to_an_offered_address_once(async_client, tokens, db_session, invoice_mail):
    await _store_invoiced_order(db_session)
    url, h = f"{BASE}/invoices/inv1/email", tokens["both"]
    # Not an address Books offers for this invoice: refused before anything is sent (no open relay).
    r = await async_client.post(url, headers=h, json={"to": "someone@else.pf"})
    assert r.status_code == 422 and invoice_mail["sent"] == []
    r = await async_client.post(url, headers=h, json={"to": " moana@client.pf "})
    assert r.status_code == 200 and "rows" in r.json()["board"]
    assert invoice_mail["sent"] == [("inv1", ["moana@client.pf"])]
    assert invoice_mail["refreshed"] == ["so1"]  # Books marks a draft invoice sent
    # A second tap inside the minute mails nobody.
    r = await async_client.post(url, headers=h, json={"to": "Moana@client.pf"})
    assert r.status_code == 409 and len(invoice_mail["sent"]) == 1
    # Another address of the same invoice is a different send.
    r = await async_client.post(url, headers=h, json={"to": "compta@client.pf"})
    assert r.status_code == 200 and len(invoice_mail["sent"]) == 2


@pytest.mark.asyncio
async def test_a_refused_invoice_email_can_be_retried_but_a_lost_answer_cannot(
    async_client, tokens, db_session, invoice_mail
):
    from backend.app.services.zoho import ZohoRequestRejected, ZohoUnreachable

    await _store_invoiced_order(db_session)
    url, h, mail = f"{BASE}/invoices/inv1/email", tokens["both"], {"to": "moana@client.pf"}
    invoice_mail["error"] = ZohoRequestRejected("Books says no")
    r = await async_client.post(url, headers=h, json=mail)
    assert (r.status_code, r.json()["detail"]) == (502, "Books says no")
    assert invoice_mail["refreshed"] == []
    invoice_mail["error"] = None
    r = await async_client.post(url, headers=h, json=mail)  # a clean refusal released the guard
    assert r.status_code == 200 and len(invoice_mail["sent"]) == 1

    invoice_mail["error"] = ZohoUnreachable("timeout")
    r = await async_client.post(url, headers=h, json={"to": "compta@client.pf"})
    assert r.status_code == 502
    invoice_mail["error"] = None
    r = await async_client.post(url, headers=h, json={"to": "compta@client.pf"})  # Books may have sent it
    assert r.status_code == 409 and len(invoice_mail["sent"]) == 1


@pytest.mark.asyncio
async def test_invoice_email_waits_for_a_write_on_the_same_order(async_client, tokens, db_session, invoice_mail):
    from backend.app.services import order_board_actions as actions

    await _store_invoiced_order(db_session)
    with actions.writing("so1"):
        r = await async_client.post(
            f"{BASE}/invoices/inv1/email", headers=tokens["both"], json={"to": "moana@client.pf"}
        )
    assert r.status_code == 409 and invoice_mail["sent"] == []
    r = await async_client.post(f"{BASE}/invoices/inv1/email", headers=tokens["both"], json={"to": "moana@client.pf"})
    assert r.status_code == 200  # the busy refusal released the guard


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "url", "body"),
    [
        ("put", "orders/so1/lines", {"version": "v", "lines": [{"line_id": "l1", "item_id": "B", "quantity": 1}]}),
        ("put", "orders/so1/lines", {"version": "v", "lines": [{"quantity": 1}]}),
        ("put", "orders/so1/lines", {"version": "v", "lines": [{"line_id": "l1", "quantity": 1}] * 2}),
        ("put", "orders/so1/lines", {"version": "v", "lines": []}),
        ("put", "orders/so1/lines", {"version": "v", "lines": [{"line_id": "l1", "quantity": 0}]}),
        ("put", "orders/so1/packages/p1", {"version": "v", "was": [], "lines": []}),
        (
            "put",
            "orders/so1/packages/p1",
            {"version": "v", "was": PICK["lines"], "lines": [{"line_id": "l1", "quantity": -1}]},
        ),
        (
            "put",
            "orders/so1/packages/p1",
            {
                "version": "v",
                "was": [{"line_id": "l1", "quantity": 1}] * 2,
                "lines": [{"line_id": "l1", "quantity": 1}],
            },
        ),
        (
            "put",
            "orders/so1/packages/p1",
            {
                "version": "v",
                "was": [{"line_id": "l1", "quantity": 1}],
                "lines": [{"line_id": "l1", "quantity": 2}] * 2,
            },
        ),
        ("get", "items?q=p", None),
    ],
)
async def test_edit_bodies_are_validated(async_client, tokens, method, url, body):
    kwargs = {"json": body} if body else {}
    r = await getattr(async_client, method)(f"{BASE}/{url}", headers=tokens["both"], **kwargs)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_edit_routes_pass_the_choice_through(async_client, tokens, monkeypatch):
    from backend.app.services import order_board_actions as actions

    seen = {}

    async def fake_edit(db, salesorder_id, version, lines, by=None):
        seen.update(v=version, lines=lines)
        return {"number": "SO-1"}

    async def fake_parcel(db, salesorder_id, package_id, version, was, lines, by=None):
        seen.update(p=package_id, was=was, plines=lines)
        return {"number": "SO-1"}

    monkeypatch.setattr(actions, "edit_lines", fake_edit)
    monkeypatch.setattr(actions, "edit_parcel", fake_parcel)
    body = {"version": "v1", "lines": [{"line_id": "l1", "quantity": 3}, {"item_id": "B", "quantity": 1}]}
    r = await async_client.put(f"{BASE}/orders/so1/lines", json=body, headers=tokens["both"])
    assert r.status_code == 200 and "board" in r.json() and r.json()["row"] == {"number": "SO-1"}
    assert seen["lines"] == [{"line_id": "l1", "quantity": 3}, {"item_id": "B", "quantity": 1}]
    body = {"version": "v1", "was": [{"line_id": "l1", "quantity": 2}], "lines": []}
    r = await async_client.put(f"{BASE}/orders/so1/packages/p1", json=body, headers=tokens["both"])
    assert r.status_code == 200 and seen["was"] == {"l1": 2} and seen["plines"] == {}


@pytest.mark.asyncio
async def test_edit_that_takes_the_order_off_the_board_still_answers_200(async_client, tokens, monkeypatch):
    from backend.app.services import order_board_actions as actions

    async def gone(*a, **k):
        return {}

    monkeypatch.setattr(actions, "edit_lines", gone)
    r = await async_client.put(f"{BASE}/orders/so1/lines", json=LINES, headers=tokens["both"])
    assert r.status_code == 200 and r.json()["row"] is None and "board" in r.json()
