"""The Order Board payment routes: which document the buttons charge, the amount cap, permissions, Heimdall
refusals and the events they write. The ledger services (Task 8) and Zoho are stubbed here."""

from datetime import datetime

import pytest
from sqlalchemy import select

from backend.app.api.routes import aito as aito_routes, order_board as routes
from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.models.aito_terminal_payment import AitoTerminalPayment
from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.models.order_board_event import OrderBoardEvent
from backend.app.services import order_board_sync
from backend.app.services.aito_terminal_payments import TerminalInProgress
from backend.app.services.heimdall import (
    HeimdallConflict,
    HeimdallNotConfigured,
    HeimdallUnreachable,
    LinkView,
    heimdall_service,
)
from backend.app.services.zoho import zoho_service
from backend.tests.unit.test_order_board_routes import tokens  # noqa: F401

BASE = "/api/v1/order-board/orders/so1"
NOW = datetime(2026, 11, 11, 1, 0, 0)
INVOICE_OLD = {"invoice_id": "inv-1", "invoice_number": "FA-1", "date": "2026-10-01", "balance": 5000, "status": "sent"}
INVOICE_NEW = {
    "invoice_id": "inv-2",
    "invoice_number": "FA-2",
    "date": "2026-11-01",
    "balance": 12000,
    "status": "sent",
}
RETAINER = {"id": "ret-1", "number": "RET-1", "date": "2026-10-20", "balance": 8000, "status": "sent", "unused": 0}


@pytest.fixture(autouse=True)
def _fresh_rate_limit():
    aito_routes._ai_rate_limit_calls.clear()
    yield
    aito_routes._ai_rate_limit_calls.clear()


@pytest.fixture
def order(db_session, monkeypatch):
    """Store a sales order with `detail` and put it on the board with `left` to pay."""

    async def make(detail: dict, left: float = 15000):
        db_session.add(
            OrderBoardDoc(kind="salesorder", zoho_id="so1", header={}, detail={"customer_id": "c1", **detail})
        )
        await db_session.commit()

        async def board_row(db, salesorder_id):
            return {"id": "so1", "payment": {"left": left}} if salesorder_id == "so1" else None

        monkeypatch.setattr(order_board_sync, "find_board_row", board_row)

    return make


@pytest.fixture
def live_invoice(monkeypatch):
    """Books' live re-read of an invoice: the stored balance unless a test overrides it."""
    balances = {"inv-1": 5000, "inv-2": 12000}

    async def raw(db, invoice_id):
        return {"invoice_number": invoice_id.upper(), "customer_id": "c1", "balance": balances[invoice_id]}

    monkeypatch.setattr(zoho_service, "get_invoice_raw", raw)
    return balances


@pytest.fixture
def terminal(monkeypatch, db_session):
    """`start_order_terminal_payment` stubbed: stores an open row, or raises `terminal.error`."""

    class Terminal:
        error: Exception | None = None
        calls: list[tuple[str, int]] = []

    async def start(db, salesorder_id, *, document, amount, actor_name, now):
        Terminal.calls.append((document.id, amount))
        if Terminal.error is not None:
            raise Terminal.error
        row = AitoTerminalPayment(
            project_id=0,
            salesorder_id=salesorder_id,
            document_kind=document.kind,
            document_id=document.id,
            document_number=document.number,
            idempotency_key=f"order-tpe:{salesorder_id}:{len(Terminal.calls)}",
            heimdall_id=f"h-{len(Terminal.calls)}",
            amount=amount,
            status="processing",
            created_at=now,
        )
        db.add(row)
        await db.commit()
        return row

    monkeypatch.setattr(routes, "start_order_terminal_payment", start)
    return Terminal


async def _events(db, kind):
    q = select(OrderBoardEvent).where(OrderBoardEvent.kind == kind)
    return list((await db.execute(q)).scalars())


# --- the target ----------------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_target_prefers_invoice_with_balance(async_client, tokens, order):  # noqa: F811
    void = {**INVOICE_NEW, "invoice_id": "inv-3", "date": "2026-11-05", "status": "void"}
    paid = {**INVOICE_NEW, "invoice_id": "inv-4", "date": "2026-11-06", "balance": 0}
    await order({"invoices": [INVOICE_OLD, INVOICE_NEW, void, paid], "estimate_id": "est-1", "_retainers": [RETAINER]})
    r = await async_client.get(f"{BASE}/payment-target", headers=tokens["both"])
    assert r.status_code == 200
    assert r.json() == {
        "kind": "invoice",
        "document_id": "inv-2",
        "number": "FA-2",
        "max_amount": 12000,
        "left": 15000,
        "link": None,
    }


@pytest.mark.asyncio
async def test_target_retainer_when_no_invoice_and_quote(async_client, tokens, order):  # noqa: F811
    spent = {**RETAINER, "id": "ret-0", "date": "2026-10-25", "balance": 0}
    await order({"invoices": [], "estimate_id": "est-1", "_retainers": [RETAINER, spent]})
    body = (await async_client.get(f"{BASE}/payment-target", headers=tokens["both"])).json()
    assert (body["kind"], body["document_id"], body["number"], body["max_amount"]) == (
        "retainer",
        "ret-1",
        "RET-1",
        8000,
    )


@pytest.mark.asyncio
async def test_target_null_without_invoice_or_quote(async_client, tokens, order):  # noqa: F811
    # A retainer without a quote id is not this order's to charge.
    await order({"invoices": [{**INVOICE_OLD, "status": "draft"}], "_retainers": [RETAINER]})
    body = (await async_client.get(f"{BASE}/payment-target", headers=tokens["both"])).json()
    assert body["kind"] is None and body["max_amount"] is None
    r = await async_client.post(f"{BASE}/terminal-payment", json={"amount": 100}, headers=tokens["both"])
    assert r.status_code == 409 and r.json()["detail"]["code"] == "no_document"


@pytest.mark.asyncio
async def test_target_shows_the_current_link(async_client, tokens, order, db_session):  # noqa: F811
    await order({"invoices": [INVOICE_NEW]})
    db_session.add(
        AitoPaymentLink(
            project_id=0,
            salesorder_id="so1",
            idempotency_key="order:so1:1",
            heimdall_id="h-9",
            reference="FA-2",
            document_kind="invoice",
            document_number="FA-2",
            amount=7000,
            expires_on="2026-12-11",
            url="https://pay.example/x",
            status="pending",
            created_at=NOW,
        )
    )
    await db_session.commit()
    link = (await async_client.get(f"{BASE}/payment-target", headers=tokens["both"])).json()["link"]
    assert (link["amount"], link["document_number"], link["url"], link["minted"]) == (
        7000,
        "FA-2",
        "https://pay.example/x",
        True,
    )


# --- amounts and permissions --------------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["terminal-payment", "payment-link"])
async def test_amount_over_balance_422(async_client, tokens, order, live_invoice, terminal, path):  # noqa: F811
    await order({"invoices": [INVOICE_NEW]})
    live_invoice["inv-2"] = 9000  # paid down in Books since the board last read it: the live balance caps
    r = await async_client.post(f"{BASE}/{path}", json={"amount": 9001}, headers=tokens["both"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "amount_above_balance"
    for bad in (0, -5, 10.5, "abc"):
        r = await async_client.post(f"{BASE}/{path}", json={"amount": bad}, headers=tokens["both"])
        assert r.status_code == 422, bad
    assert terminal.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "payment-target"),
        ("post", "payment-link"),
        ("post", "terminal-payment"),
        ("get", "terminal-payment"),
        ("post", "payment-link/cancel"),
    ],
)
async def test_link_and_terminal_need_orders_update(async_client, tokens, method, path):  # noqa: F811
    kwargs = {"json": {"amount": 100}} if method == "post" else {}
    r = await getattr(async_client, method)(f"{BASE}/{path}", headers=tokens["read"], **kwargs)
    assert r.status_code == 403


# --- terminal -----------------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_terminal_start_charges_the_target_and_records_started(
    async_client,
    tokens,  # noqa: F811
    order,
    live_invoice,
    terminal,
    db_session,
):
    await order({"invoices": [INVOICE_OLD, INVOICE_NEW]})
    r = await async_client.post(f"{BASE}/terminal-payment", json={"amount": 12000}, headers=tokens["both"])
    assert r.status_code == 201
    assert (r.json()["document_number"], r.json()["amount"], r.json()["status"]) == ("INV-2", 12000, "processing")
    assert terminal.calls == [("inv-2", 12000)]
    [event] = await _events(db_session, "terminal.started")
    assert event.actor_name == "orders-both" and event.detail == {"amount": 12000, "document": "INV-2"}


@pytest.mark.asyncio
async def test_terminal_retainer_row_reads_back(async_client, tokens, order, terminal, db_session, monkeypatch):  # noqa: F811
    await order({"invoices": [], "estimate_id": "est-1", "_retainers": [RETAINER]})
    monkeypatch.setattr(zoho_service, "get_retainer_raw", _live_retainer(8000))
    r = await async_client.post(f"{BASE}/terminal-payment", json={"amount": 8000}, headers=tokens["both"])
    assert r.status_code == 201 and r.json()["document_kind"] == "retainer"

    async def no_refresh(db, row, *, now, force=False):
        return row

    monkeypatch.setattr(routes, "refresh_terminal_payment", no_refresh)
    got = await async_client.get(f"{BASE}/terminal-payment", headers=tokens["both"])
    assert got.status_code == 200 and got.json()["id"] == r.json()["id"]


def _live_retainer(balance):
    async def raw(db, retainer_id):
        return {"retainerinvoice_number": "RET-1", "customer_id": "c1", "balance": balance, "status": "sent"}

    return raw


@pytest.mark.asyncio
async def test_retainer_charge_capped_at_the_live_balance(async_client, tokens, order, terminal, monkeypatch):  # noqa: F811
    await order({"invoices": [], "estimate_id": "est-1", "_retainers": [RETAINER]})  # stored balance 8000
    monkeypatch.setattr(zoho_service, "get_retainer_raw", _live_retainer(2000))
    r = await async_client.post(f"{BASE}/terminal-payment", json={"amount": 2001}, headers=tokens["both"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "amount_above_balance"
    monkeypatch.setattr(zoho_service, "get_retainer_raw", _live_retainer(0))
    r = await async_client.post(f"{BASE}/terminal-payment", json={"amount": 100}, headers=tokens["both"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "document_mismatch"
    assert terminal.calls == []


@pytest.mark.asyncio
async def test_a_failing_started_log_still_returns_the_started_charge(
    async_client,
    tokens,  # noqa: F811
    order,
    live_invoice,
    terminal,
    monkeypatch,
):
    await order({"invoices": [INVOICE_NEW]})

    async def boom(*args, **kwargs):
        raise RuntimeError("history write failed")

    monkeypatch.setattr(routes, "_log", boom)
    r = await async_client.post(f"{BASE}/terminal-payment", json={"amount": 12000}, headers=tokens["both"])
    assert r.status_code == 201 and r.json()["status"] == "processing"
    assert terminal.calls == [("inv-2", 12000)]


@pytest.mark.asyncio
async def test_terminal_get_is_null_without_a_charge(async_client, tokens):  # noqa: F811
    r = await async_client.get(f"{BASE}/terminal-payment", headers=tokens["both"])
    assert r.status_code == 200 and r.json() is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (TerminalInProgress("busy"), 409, "terminal_in_progress"),
        (HeimdallNotConfigured("no url"), 502, "not_configured"),
        (HeimdallConflict("busy", "terminal_busy"), 409, "terminal_busy"),
        (HeimdallUnreachable("timeout"), 502, "upstream"),
    ],
)
async def test_terminal_refusals_write_no_event(
    async_client,
    tokens,  # noqa: F811
    order,
    live_invoice,
    terminal,
    db_session,
    error,
    status,
    code,
):
    await order({"invoices": [INVOICE_NEW]})
    terminal.error = error
    r = await async_client.post(f"{BASE}/terminal-payment", json={"amount": 100}, headers=tokens["both"])
    assert r.status_code == status and r.json()["detail"]["code"] == code
    assert await _events(db_session, "terminal.started") == []


# --- link ---------------------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_link_replay_answers_the_old_document_and_amount(
    async_client,
    tokens,  # noqa: F811
    order,
    live_invoice,
    db_session,
    monkeypatch,
):
    """A stranded reservation is replayed as it was: the answer carries its document and amount, not the request's."""
    await order({"invoices": [INVOICE_NEW]})
    seen = {}

    async def create(db, salesorder_id, *, document, amount, actor_name, now):
        seen.update(document=document.id, amount=amount)
        row = AitoPaymentLink(
            project_id=0,
            salesorder_id=salesorder_id,
            idempotency_key="order:so1:1",
            heimdall_id="h-1",
            reference="FA-OLD",
            document_kind="invoice",
            document_number="FA-OLD",
            amount=3000,
            expires_on="2026-12-11",
            url="https://pay.example/old",
            status="pending",
            created_at=now,
        )
        db.add(row)
        await db.commit()
        return row

    monkeypatch.setattr(routes, "create_order_invoice_link", create)
    r = await async_client.post(f"{BASE}/payment-link", json={"amount": 12000}, headers=tokens["both"])
    assert r.status_code == 200
    assert seen == {"document": "inv-2", "amount": 12000}
    assert (r.json()["document_number"], r.json()["amount"], r.json()["url"]) == (
        "FA-OLD",
        3000,
        "https://pay.example/old",
    )
    # A minted open link is refused before Heimdall is asked again.
    again = await async_client.post(f"{BASE}/payment-link", json={"amount": 100}, headers=tokens["both"])
    assert again.status_code == 409 and again.json()["detail"]["code"] == "link_exists"


# --- the order's left to pay caps every charge --------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["terminal-payment", "payment-link"])
async def test_amount_over_the_orders_left_422(async_client, tokens, order, live_invoice, terminal, path):  # noqa: F811
    """An invoice raised for the whole order without drawing the paid deposit: its balance is above what is left."""
    await order({"invoices": [INVOICE_NEW], "estimate_id": "est-1"}, left=7000)
    target = (await async_client.get(f"{BASE}/payment-target", headers=tokens["both"])).json()
    assert (target["max_amount"], target["left"]) == (12000, 7000)  # the dialogs prefill min(balance, left)
    r = await async_client.post(f"{BASE}/{path}", json={"amount": 7001}, headers=tokens["both"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "amount_above_left"
    assert terminal.calls == []


@pytest.mark.asyncio
async def test_the_orders_left_is_chargeable(async_client, tokens, order, live_invoice, terminal):  # noqa: F811
    await order({"invoices": [INVOICE_NEW]}, left=7000)
    r = await async_client.post(f"{BASE}/terminal-payment", json={"amount": 7000}, headers=tokens["both"])
    assert r.status_code == 201 and terminal.calls == [("inv-2", 7000)]


# --- cancelling the order's link ----------------------------------------------------------------------------


def _pending_link(**over) -> AitoPaymentLink:
    base = {
        "project_id": 0,
        "salesorder_id": "so1",
        "idempotency_key": "order:so1:1",
        "heimdall_id": "h-9",
        "reference": "FA-2",
        "document_kind": "invoice",
        "document_number": "FA-2",
        "amount": 7000,
        "expires_on": "2026-12-11",
        "url": "https://pay.example/x",
        "status": "pending",
        "created_at": NOW,
    }
    base.update(over)
    return AitoPaymentLink(**base)


def _link_view(status: str) -> LinkView:
    return LinkView(
        id="h-9",
        status=status,
        amount=7000,
        currency="XPF",
        reference="FA-2",
        url="https://pay.example/x",
        expires_at=None,
    )


@pytest.fixture
def heimdall_cancel(monkeypatch):
    """Heimdall's link cancel stubbed: answers `cancelled`, or raises `Cancel.error`."""

    class Cancel:
        error: Exception | None = None
        calls: list[str] = []

    async def cancel(db, payment_id):
        Cancel.calls.append(payment_id)
        if Cancel.error is not None:
            raise Cancel.error
        return _link_view("cancelled")

    monkeypatch.setattr(heimdall_service, "cancel_link", cancel)
    Cancel.calls = []
    return Cancel


@pytest.mark.asyncio
async def test_cancel_the_orders_link(async_client, tokens, db_session, heimdall_cancel):  # noqa: F811
    db_session.add(_pending_link())
    await db_session.commit()
    r = await async_client.post(f"{BASE}/payment-link/cancel", headers=tokens["both"])
    assert r.status_code == 200 and r.json()["state"] == "cancelled"
    assert heimdall_cancel.calls == ["h-9"]
    [event] = await _events(db_session, "payment_link.cancelled")
    assert (event.actor_class, event.actor_name) == ("user", "orders-both")
    assert {k: event.detail[k] for k in ("amount", "document", "reason")} == {
        "amount": 7000,
        "document": "FA-2",
        "reason": "operator",
    }
    again = await async_client.post(f"{BASE}/payment-link/cancel", headers=tokens["both"])
    assert again.status_code == 409 and again.json()["detail"]["code"] == "not_cancellable"


@pytest.mark.asyncio
async def test_cancel_without_a_link_404_and_unminted_409(async_client, tokens, db_session, heimdall_cancel):  # noqa: F811
    assert (await async_client.post(f"{BASE}/payment-link/cancel", headers=tokens["both"])).status_code == 404
    db_session.add(_pending_link(heimdall_id=None))
    await db_session.commit()
    r = await async_client.post(f"{BASE}/payment-link/cancel", headers=tokens["both"])
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_cancellable"
    assert heimdall_cancel.calls == []


@pytest.mark.asyncio
async def test_cancel_finds_the_link_paid(async_client, tokens, db_session, heimdall_cancel, monkeypatch):  # noqa: F811
    db_session.add(_pending_link())
    await db_session.commit()
    heimdall_cancel.error = HeimdallConflict("settled", "conflict")

    async def get_payment(db, payment_id):
        return _link_view("paid")

    async def no_refresh(db, salesorder_id):
        return None

    monkeypatch.setattr(heimdall_service, "get_payment", get_payment)
    monkeypatch.setattr(order_board_sync, "refresh_order", no_refresh)
    r = await async_client.post(f"{BASE}/payment-link/cancel", headers=tokens["both"])
    assert r.status_code == 409 and r.json()["detail"]["code"] == "link_paid"
    assert [e.detail for e in await _events(db_session, "payment.received")] == [{"amount": 7000, "method": "link"}]
    assert await _events(db_session, "payment_link.cancelled") == []


@pytest.mark.asyncio
async def test_cancel_heimdall_down_keeps_the_link(async_client, tokens, db_session, heimdall_cancel):  # noqa: F811
    db_session.add(_pending_link())
    await db_session.commit()
    heimdall_cancel.error = HeimdallUnreachable("timeout")
    r = await async_client.post(f"{BASE}/payment-link/cancel", headers=tokens["both"])
    assert r.status_code == 502 and r.json()["detail"]["code"] == "upstream"
    assert (await db_session.execute(select(AitoPaymentLink))).scalar_one().status == "pending"
    assert await _events(db_session, "payment_link.cancelled") == []


@pytest.mark.asyncio
async def test_terminal_refused_while_a_link_is_open(
    async_client,
    tokens,  # noqa: F811
    order,
    live_invoice,
    terminal,
    db_session,
    heimdall_cancel,
):
    await order({"invoices": [INVOICE_NEW]})
    db_session.add(_pending_link())
    await db_session.commit()
    r = await async_client.post(f"{BASE}/terminal-payment", json={"amount": 7000}, headers=tokens["both"])
    assert r.status_code == 409 and r.json()["detail"]["code"] == "link_open"
    assert (terminal.calls, heimdall_cancel.calls) == ([], [])
    r = await async_client.post(
        f"{BASE}/terminal-payment", json={"amount": 7000, "cancel_link": True}, headers=tokens["both"]
    )
    assert r.status_code == 201 and terminal.calls == [("inv-2", 7000)]
    assert heimdall_cancel.calls == ["h-9"]
    link = (await db_session.execute(select(AitoPaymentLink))).scalar_one()
    await db_session.refresh(link)
    assert link.status == "cancelled"
    assert len(await _events(db_session, "payment_link.cancelled")) == 1


@pytest.mark.asyncio
async def test_terminal_not_started_when_the_link_cancel_fails(
    async_client,
    tokens,  # noqa: F811
    order,
    live_invoice,
    terminal,
    db_session,
    heimdall_cancel,
):
    await order({"invoices": [INVOICE_NEW]})
    db_session.add(_pending_link())
    await db_session.commit()
    heimdall_cancel.error = HeimdallUnreachable("timeout")
    r = await async_client.post(
        f"{BASE}/terminal-payment", json={"amount": 7000, "cancel_link": True}, headers=tokens["both"]
    )
    assert r.status_code == 502 and terminal.calls == []


# --- the SMS carries the link -------------------------------------------------------------------------------


@pytest.fixture
async def admin(db_session):
    from backend.app.core.auth import create_access_token, get_password_hash
    from backend.app.models.settings import Settings
    from backend.app.models.user import User

    db_session.add(Settings(key="auth_enabled", value="true"))
    db_session.add(
        User(username="pay-admin", password_hash=get_password_hash("password"), is_active=True, role="admin")
    )
    await db_session.commit()
    return {"Authorization": f"Bearer {create_access_token(data={'sub': 'pay-admin'})}"}


@pytest.mark.asyncio
async def test_sms_with_the_link_records_payment_link_sent(admin, async_client, db_session, monkeypatch):
    link = AitoPaymentLink(
        project_id=0,
        salesorder_id="so1",
        idempotency_key="order:so1:1",
        heimdall_id="h-1",
        reference="FA-2",
        document_kind="invoice",
        document_number="FA-2",
        amount=7000,
        expires_on="2026-12-11",
        url="https://pay.example/x",
        status="pending",
        created_at=NOW,
    )
    other = AitoPaymentLink(
        project_id=0,
        salesorder_id="so2",
        idempotency_key="order:so2:1",
        heimdall_id="h-2",
        reference="FA-9",
        document_kind="invoice",
        document_number="FA-9",
        amount=1,
        expires_on="2026-12-11",
        url="https://pay.example/y",
        status="pending",
        created_at=NOW,
    )
    db_session.add_all([link, other])
    await db_session.commit()

    async def stamp(db, salesorder_id, by):
        return {"id": salesorder_id}

    monkeypatch.setattr(routes.order_board_actions, "stamp_contact", stamp)
    sms = f"{BASE}/sms"
    assert (await async_client.post(sms, headers=admin)).status_code == 200  # no body: an SMS without the link
    assert (await async_client.post(sms, json={"payment_link_id": other.id}, headers=admin)).status_code == 200
    assert await _events(db_session, "payment_link.sent") == []
    assert (await async_client.post(sms, json={"payment_link_id": link.id}, headers=admin)).status_code == 200
    [event] = await _events(db_session, "payment_link.sent")
    assert event.detail == {"amount": 7000, "document": "FA-2"} and event.actor_name == "pay-admin"


# --- the order's quote: paid like Aito's, Heimdall books a new retainer on it --------------------------------


def _live_estimate(status="accepted", customer="c1"):
    async def get(db, estimate_id):
        return {"estimate_id": estimate_id, "estimate_number": "DEV-1", "status": status, "customer_id": customer}

    return get


@pytest.mark.asyncio
async def test_target_quote_when_nothing_else_is_open(async_client, tokens, order):  # noqa: F811
    spent = {**RETAINER, "balance": 0}
    await order(
        {"invoices": [], "estimate_id": "est-1", "estimate_number": "DEV-1", "_retainers": [spent]}, left=9874.6
    )
    body = (await async_client.get(f"{BASE}/payment-target", headers=tokens["both"])).json()
    assert (body["kind"], body["document_id"], body["number"], body["max_amount"]) == ("quote", "est-1", "DEV-1", 9875)


@pytest.mark.asyncio
async def test_no_quote_target_once_nothing_is_left(async_client, tokens, order):  # noqa: F811
    await order({"invoices": [], "estimate_id": "est-1"}, left=0)
    body = (await async_client.get(f"{BASE}/payment-target", headers=tokens["both"])).json()
    assert body["kind"] is None


@pytest.mark.asyncio
async def test_terminal_on_the_quote(async_client, tokens, order, terminal, monkeypatch):  # noqa: F811
    await order({"invoices": [], "estimate_id": "est-1"}, left=9000)
    monkeypatch.setattr(zoho_service, "get_estimate", _live_estimate())
    r = await async_client.post(f"{BASE}/terminal-payment", json={"amount": 9001}, headers=tokens["both"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "amount_above_left"
    r = await async_client.post(f"{BASE}/terminal-payment", json={"amount": 9000}, headers=tokens["both"])
    assert r.status_code == 201
    assert (r.json()["document_kind"], r.json()["document_number"]) == ("quote", "DEV-1")
    assert terminal.calls == [("est-1", 9000)]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "customer"), [("invoiced", "c1"), ("declined", "c1"), ("void", "c1"), ("accepted", "c2")]
)
async def test_a_closed_or_foreign_quote_takes_no_payment(
    async_client,
    tokens,  # noqa: F811
    order,
    terminal,
    monkeypatch,
    status,
    customer,
):
    await order({"invoices": [], "estimate_id": "est-1"}, left=9000)
    monkeypatch.setattr(zoho_service, "get_estimate", _live_estimate(status, customer))
    r = await async_client.post(f"{BASE}/terminal-payment", json={"amount": 100}, headers=tokens["both"])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "document_mismatch"
    assert terminal.calls == []


@pytest.mark.asyncio
async def test_a_quote_link_goes_out_under_the_quote_number(async_client, tokens, order, db_session, monkeypatch):  # noqa: F811
    """Heimdall resolves a link's reference to its document: the quote number, as Aito's quote links send."""
    await order({"invoices": [], "estimate_id": "est-1"}, left=9000)
    monkeypatch.setattr(zoho_service, "get_estimate", _live_estimate())
    sent = {}

    async def create_link(db, *, idempotency_key, reference, amount, expires_in_days):
        sent.update(reference=reference, amount=amount)
        return LinkView(
            id="h-q",
            status="pending",
            amount=amount,
            currency="XPF",
            reference=reference,
            url="https://pay.example/q",
            expires_at=None,
        )

    monkeypatch.setattr(heimdall_service, "create_link", create_link)
    r = await async_client.post(f"{BASE}/payment-link", json={"amount": 9000}, headers=tokens["both"])
    assert r.status_code == 200 and r.json()["url"] == "https://pay.example/q"
    assert sent == {"reference": "DEV-1", "amount": 9000}
    row = (await db_session.execute(select(AitoPaymentLink).where(AitoPaymentLink.salesorder_id == "so1"))).scalar_one()
    assert (row.document_kind, row.document_number, row.project_id) == ("quote", "DEV-1", 0)
