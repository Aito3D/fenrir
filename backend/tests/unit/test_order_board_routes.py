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
NEW_ROUTES = [
    ("post", f"{BASE}/orders/so1/prep-sheet", None, False),
    ("post", f"{BASE}/orders/so1/prep-sheet?picklist_id=pl1", None, False),
    ("get", f"{BASE}/orders/so1/picklist", None, False),
    ("post", f"{BASE}/orders/so1/picklists", PICK, True),
    ("get", f"{BASE}/orders/so1/picklists/pl1", None, False),
    ("post", f"{BASE}/orders/so1/packages", PARCEL, True),
    ("get", f"{BASE}/orders/so1/packages/p1/handover", None, False),
    ("post", f"{BASE}/orders/so1/packages/p1/handover", HAND, True),
    ("post", f"{BASE}/orders/so1/invoice", INVOICE, True),
    ("get", f"{BASE}/invoices/inv1/pdf", None, False),
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
        assert r.status_code == 404, f"{method.upper()} {url}: {r.status_code}"


@pytest.mark.asyncio
async def test_prep_sheet_is_a_pdf_and_stamps_with_the_username(async_client, tokens, monkeypatch):
    from backend.app.services import order_board_actions as actions

    seen = {}

    async def fake_stamp(db, salesorder_id, by):
        seen.update(id=salesorder_id, by=by)
        return {"number": "SO-1", "lines": [], "customer": "X"}

    monkeypatch.setattr(actions, "stamp_print", fake_stamp)
    monkeypatch.setattr("backend.app.api.routes.order_board.render_prep_sheet", lambda row, **kw: b"%PDF-fake")
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

    async def fake_stamp(db, salesorder_id, by):
        return {"number": "SO-1", "customer": "X", "lines": [], "printed": None}

    monkeypatch.setattr(actions, "stamp_print", fake_stamp)
    r = await async_client.post(f"{BASE}/orders/so1/prep-sheet", headers=tokens["read"])
    assert r.status_code == 200 and r.content.startswith(b"%PDF-")


@pytest.mark.asyncio
async def test_create_parcel_returns_the_board_and_the_number(async_client, tokens, monkeypatch):
    from backend.app.services import order_board_actions as actions

    seen = {}

    async def fake(db, salesorder_id, picklist_id, quantities):
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

    async def fake_create(db, salesorder_id, quantities):
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

    async def fake_stamp(db, salesorder_id, by):
        return {"number": "SO-1", "lines": [], "customer": "X"}

    async def fake_content(db, salesorder_id, picklist_id):
        return {"id": picklist_id, "number": "PL-00013", "status": "yet_to_start", "lines": PICK["lines"]}

    def fake_render(row, **kw):
        seen.update(kw)
        return b"%PDF-fake"

    monkeypatch.setattr(actions, "stamp_print", fake_stamp)
    monkeypatch.setattr(actions, "picklist_content", fake_content)
    monkeypatch.setattr("backend.app.api.routes.order_board.render_prep_sheet", fake_render)
    r = await async_client.post(f"{BASE}/orders/so1/prep-sheet?picklist_id=pl1", headers=tokens["read"])
    assert r.status_code == 200
    assert (seen["quantities"], seen["picklist_number"]) == ({"l1": 2}, "PL-00013")


@pytest.mark.asyncio
async def test_handover_and_invoice_return_board_and_outcome(async_client, tokens, monkeypatch):
    from backend.app.services import order_board_actions as actions

    calls = []

    async def fake_hand(db, so, pkg, *, mode, apply_credit):
        calls.append(("hand", so, pkg, mode, apply_credit))
        return {"invoice": "created"}

    async def fake_inv(db, so, *, apply_credit):
        calls.append(("inv", so, apply_credit))
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
    r = await async_client.get(f"{BASE}/orders/so1/packages/p1/handover", headers=tokens["read"])
    assert r.json() == {"package": "p1"}
    assert calls == [("hand", "so1", "p1", "pickup", False), ("inv", "so1", True)]


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
            "stamp_print",
            "create_picklist",
            "picklist_preview",
            "picklist_content",
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
            ("get", "orders/so1/packages/p1/handover", None),
            ("post", "orders/so1/prep-sheet", None),
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
