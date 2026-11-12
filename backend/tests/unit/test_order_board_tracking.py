"""The customer's tracking page of an order: the derivation, the code, the public route, the link in the SMS."""

from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import select

from backend.app.api.routes import aito as aito_routes
from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.models.order_board_event import OrderBoardEvent
from backend.app.models.settings import Settings
from backend.app.services import aito_tracking, order_board_sms, order_board_tracking as tracking
from backend.app.services.order_board import compute_board, order_row
from backend.app.services.order_board_events import record
from backend.tests.unit.test_order_board_routes import tokens  # noqa: F401
from backend.tests.unit.test_order_board_sms import _GSM
from backend.tests.unit.test_order_board_sync import (  # noqa: F401
    _synced,
    file_sessions,
    no_back_off_left_over,
    order,
    zoho,
)

TODAY = date(2026, 11, 12)
BASE = "/api/v1/order-board"


def _line(n, qty=1, *, packed=0, shipped=0, cancelled=0, item="A", **extra):
    return {
        "line_item_id": f"l{n}",
        "item_id": item,
        "name": f"Thing {n}",
        "quantity": qty,
        "quantity_packed": packed,
        "quantity_shipped": shipped,
        "quantity_cancelled": cancelled,
        "quantity_invoiced": 0,
        "rate": 999,
        **extra,
    }


def _row(*lines, stock=None, **extra):
    doc = {"salesorder_id": "so1", "salesorder_number": "SO-1", "date": "2026-11-01", "line_items": list(lines)}
    items = {item: {"stock_on_hand": units} for item, units in (stock or {"A": 100}).items()}
    rows = compute_board([doc], [], items, TODAY)
    row = rows[0] if rows else order_row(doc, {}, TODAY)
    return {**row, **extra}


def _statuses(result):
    return [(entry["name"], entry["quantity"], entry["status"]) for entry in result["lines"]]


# --- derivation ------------------------------------------------------------------------------------------------


def test_an_untouched_order_is_received_and_everything_is_to_prepare():
    result = tracking.derive_tracking(_row(_line(1), _line(2, 2)))
    assert (result["state"], result["stage"]) == ("received", "received")
    assert _statuses(result) == [("Thing 1", 1, "to_prepare"), ("Thing 2", 2, "to_prepare")]
    assert result["counts"] == {"open": 2, "ready": 0, "waiting": 0}


@pytest.mark.parametrize("started", [{"prep": {"at": "x", "by": "p"}}, {"picklists": [{"id": "p1"}]}, {"picked": 1}])
def test_a_started_order_is_in_preparation_and_short_lines_wait_for_stock(started):
    result = tracking.derive_tracking(_row(_line(1), _line(2, item="B"), stock={"A": 5, "B": 0}, **started))
    assert (result["state"], result["stage"]) == ("preparing", "preparing")
    assert _statuses(result) == [("Thing 1", 1, "preparing"), ("Thing 2", 1, "waiting")]
    assert result["counts"] == {"open": 2, "ready": 0, "waiting": 1}


def test_a_short_line_waits_even_before_the_order_is_started():
    result = tracking.derive_tracking(_row(_line(1, item="B"), stock={"B": 0}))
    assert result["state"] == "received" and _statuses(result) == [("Thing 1", 1, "waiting")]


def test_packed_lines_are_ready_and_come_first():
    result = tracking.derive_tracking(_row(_line(1, item="B"), _line(2, packed=1), _line(3, packed=1), stock={"B": 0}))
    assert (result["state"], result["stage"]) == ("partly_ready", "ready")
    assert [s for _, _, s in _statuses(result)] == ["ready", "ready", "waiting"]
    assert result["counts"] == {"open": 3, "ready": 2, "waiting": 1}


def test_everything_packed_is_ready():
    result = tracking.derive_tracking(_row(_line(1, packed=1), _line(2, 3, packed=3)))
    assert (result["state"], result["stage"]) == ("ready", "ready")


def test_a_line_is_split_by_where_its_units_stand():
    # 6 ordered: 1 handed over, 2 in a parcel, 1 on the shelf, 2 short (Books still counts boxed units in stock).
    result = tracking.derive_tracking(_row(_line(1, 6, packed=3, shipped=1, item="B"), stock={"B": 3}), ["2026-11-10"])
    assert _statuses(result) == [
        ("Thing 1", 2, "ready"),
        ("Thing 1", 1, "preparing"),
        ("Thing 1", 2, "waiting"),
        ("Thing 1", 1, "handed_over"),
    ]
    assert result["state"] == "partly_ready" and result["counts"] == {"open": 3, "ready": 1, "waiting": 1}
    assert [entry["handed_on"] for entry in result["lines"]] == [None, None, None, "2026-11-10"]


def test_fractional_quantities_are_kept():
    result = tracking.derive_tracking(_row(_line(1, 2.5, packed=2.5)))
    assert _statuses(result) == [("Thing 1", 2.5, "ready")]


def test_a_fully_shipped_order_is_handed_over_and_the_day_is_only_shown_when_it_is_certain():
    row = _row(_line(1, shipped=1), _line(2, 2, shipped=2))
    one_day = tracking.derive_tracking(row, ["2026-11-12", "2026-11-12"])
    assert (one_day["state"], one_day["stage"]) == ("handed_over", "handed_over")
    assert {entry["handed_on"] for entry in one_day["lines"]} == {"2026-11-12"}
    assert one_day["counts"] == {"open": 0, "ready": 0, "waiting": 0}
    for days in ([], ["2026-10-02", "2026-11-12"]):
        assert {entry["handed_on"] for entry in tracking.derive_tracking(row, days)["lines"]} == {None}


def test_a_partly_handed_over_order_with_the_rest_on_the_shelf_is_in_preparation():
    result = tracking.derive_tracking(_row(_line(1, shipped=1), _line(2)))
    assert result["state"] == "preparing"
    assert _statuses(result) == [("Thing 2", 1, "preparing"), ("Thing 1", 1, "handed_over")]


def test_service_and_cancelled_lines_are_left_out():
    result = tracking.derive_tracking(
        _row(
            _line(1),
            _line(2, item=None),
            _line(3, product_type="service"),
            _line(4, cancelled=1),
            _line(5, 3, cancelled=1),
        )
    )
    assert _statuses(result) == [("Thing 1", 1, "to_prepare"), ("Thing 5", 2, "to_prepare")]


def test_an_order_without_goods_has_no_page():
    assert tracking.derive_tracking(_row(_line(1, item=None), _line(2, cancelled=1))) is None


def test_expiry_is_thirty_days_after_the_hand_over():
    done = datetime(2026, 10, 1)
    assert not tracking.is_expired(done, done + timedelta(days=30))
    assert tracking.is_expired(done, done + timedelta(days=30, seconds=1))
    assert tracking.is_expired(None, done)


# --- the code --------------------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_one_code_per_order_from_the_aito_alphabet(db_session):
    first = await tracking.ensure_token(db_session, "so1")
    assert await tracking.ensure_token(db_session, "so1") == first
    assert await tracking.ensure_token(db_session, "so2") != first
    assert len(first) == aito_tracking.TOKEN_LENGTH and set(first) <= set(aito_tracking.TOKEN_ALPHABET)


@pytest.mark.asyncio
async def test_the_shared_mint_never_reuses_an_order_code(db_session, monkeypatch):
    db_session.add(OrderBoardDoc(kind="track", zoho_id="so1", header={"token": "K7F3XQ"}))
    await db_session.commit()
    codes = iter(["K7F3XQ", "ZZZZZZ"])
    monkeypatch.setattr(aito_tracking, "mint_token", lambda: next(codes))
    assert await aito_tracking.mint_unique_token(db_session) == "ZZZZZZ"


@pytest.mark.asyncio
async def test_no_link_and_no_code_without_the_external_url(db_session):
    assert await tracking.tracking_url(db_session, "so1") is None
    assert (await db_session.execute(select(OrderBoardDoc).where(OrderBoardDoc.kind == "track"))).first() is None
    db_session.add(Settings(key="external_url", value="https://suivi.example/"))
    await db_session.commit()
    code = await tracking.ensure_token(db_session, "so1")
    assert await tracking.tracking_url(db_session, "so1") == f"https://suivi.example/t/o/{code}"


# --- the public route ------------------------------------------------------------------------------------------

KEYS = {"reference", "date", "state", "stage", "lines", "counts", "pickup", "payment", "pay_url", "updated_at"}


async def _open(client, code):
    return await client.get(f"{BASE}/track/{code}")


@pytest.mark.asyncio
async def test_payload_is_only_what_the_page_shows_and_costs_no_zoho_call(async_client, db_session, zoho, tokens):  # noqa: F811
    doc = order(1, qty=2, packed=1)
    doc.update(reference_number="1079", contact_person_details=[{"first_name": "Marie", "mobile": "87000000"}])
    await _synced(db_session, zoho, doc)
    code = await tracking.ensure_token(db_session, "so1")
    calls = sum(zoho.calls.values())
    r = await _open(async_client, code.lower())  # no credentials, auth enabled; the code is normalised
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    body = r.json()
    assert set(body) == KEYS
    assert (body["reference"], body["date"], body["state"], body["stage"]) == (
        "#1079",
        doc["date"],
        "partly_ready",
        "ready",
    )
    assert body["lines"] == [
        {"name": "Thing", "quantity": 1, "status": "ready", "handed_on": None},
        {"name": "Thing", "quantity": 1, "status": "preparing", "handed_on": None},
    ]
    assert body["counts"] == {"open": 2, "ready": 1, "waiting": 0}
    assert body["payment"] == {"currency": "XPF", "total": 1000, "paid": 0, "left": 1000}
    assert body["pickup"] is True and body["pay_url"] is None
    assert datetime.fromisoformat(body["updated_at"]).tzinfo is None  # naive UTC, as the Aito page's
    for leak in ("so1", "SO-00001", "Customer", "Marie", "87000000", "SKU", "c1", "l1", "stock"):
        assert leak not in r.text
    assert sum(zoho.calls.values()) == calls


@pytest.mark.asyncio
async def test_without_a_shopify_number_the_reference_is_the_order_number(async_client, db_session, zoho):  # noqa: F811
    await _synced(db_session, zoho, order(1))
    body = (await _open(async_client, await tracking.ensure_token(db_session, "so1"))).json()
    assert body["reference"] == "SO-00001" and body["state"] == "received"


@pytest.mark.asyncio
async def test_every_failure_is_the_same_404(async_client, db_session, zoho):  # noqa: F811
    old = order(2, shipped=1, age=60)
    old["packages"] = [{"package_id": "p", "status": "delivered", "shipment_date": old["date"]}]
    await _synced(db_session, zoho, order(1, status="void"), old, order(3, item=""))
    codes = [await tracking.ensure_token(db_session, f"so{n}") for n in (1, 2, 3)]
    db_session.add(OrderBoardDoc(kind="track", zoho_id="gone", header={"token": "K7F3XQ"}))
    await db_session.commit()
    answers = [await _open(async_client, c) for c in [*codes, "K7F3XQ", "ZZZZZZ", "nope", "x" * 43]]
    assert {(r.status_code, r.text, r.headers["cache-control"]) for r in answers} == {
        (404, '{"detail":"Lien introuvable"}', "no-store")
    }


@pytest.mark.asyncio
async def test_a_handed_over_order_keeps_its_page_for_thirty_days(async_client, db_session, zoho):  # noqa: F811
    done = order(1, shipped=1, age=40, paid_status="paid", invoiced_status="invoiced")
    done["invoices"] = [{"invoice_id": "i1", "status": "paid", "total": 1000.0, "balance": 0}]
    handed = (date.today() - timedelta(days=29)).isoformat()
    done["packages"] = [{"package_id": "p", "status": "delivered", "shipment_date": handed}]
    await _synced(db_session, zoho, done)
    code = await tracking.ensure_token(db_session, "so1")
    body = (await _open(async_client, code)).json()
    assert (body["state"], body["stage"]) == ("handed_over", "handed_over")
    assert body["lines"][0]["handed_on"] == done["packages"][0]["shipment_date"]
    assert body["payment"] == {"currency": "XPF", "total": 1000, "paid": 1000, "left": 0}

    stored = (await db_session.execute(select(OrderBoardDoc).where(OrderBoardDoc.kind == "salesorder"))).scalar_one()
    packages = [{**done["packages"][0], "shipment_date": (date.today() - timedelta(days=32)).isoformat()}]
    stored.detail = {**stored.detail, "packages": packages}
    await db_session.commit()
    assert (await _open(async_client, code)).status_code == 404


@pytest.mark.asyncio
async def test_without_a_books_date_the_hand_over_event_dates_the_line_and_the_expiry(async_client, db_session, zoho):  # noqa: F811
    await _synced(db_session, zoho, order(1, shipped=1))
    code = await tracking.ensure_token(db_session, "so1")
    at = datetime.utcnow().replace(microsecond=0) - timedelta(days=2)
    await record(db_session, "so1", "handover.delivered", actor_class="user", occurred_at=at)
    await db_session.commit()
    assert (await _open(async_client, code)).json()["lines"][0]["handed_on"] == at.isoformat()
    for event in (await db_session.execute(select(OrderBoardEvent))).scalars():
        event.occurred_at = datetime.utcnow() - timedelta(days=31)
    await db_session.commit()
    assert (await _open(async_client, code)).status_code == 404


def _link(**over):
    values = {
        "project_id": 0,
        "salesorder_id": "so1",
        "idempotency_key": "order:so1:1",
        "heimdall_id": "hd-secret",
        "reference": "SO-00001-ref",
        "url": "https://pay.example/p/abc",
        "amount": 1000,
        "currency": "XPF",
        "status": "pending",
        "expires_on": "2999-01-01",
        "document_kind": "invoice",
    }
    return AitoPaymentLink(**{**values, **over})


@pytest.mark.asyncio
async def test_the_pay_url_is_there_only_while_the_link_is_open(async_client, db_session, zoho):  # noqa: F811
    await _synced(db_session, zoho, order(1))
    code = await tracking.ensure_token(db_session, "so1")
    link = _link()
    db_session.add(link)
    await db_session.commit()
    r = await _open(async_client, code)
    assert r.json()["pay_url"] == "https://pay.example/p/abc" and "hd-secret" not in r.text
    for change in ({"status": "paid"}, {"status": "cancelled"}, {"expires_on": "2020-01-01"}, {"heimdall_id": None}):
        for field, value in {"status": "pending", "expires_on": "2999-01-01", "heimdall_id": "hd", **change}.items():
            setattr(link, field, value)
        await db_session.commit()
        assert (await _open(async_client, code)).json()["pay_url"] is None, change


@pytest.mark.asyncio
async def test_each_open_is_logged_once_within_the_window(async_client, db_session, zoho):  # noqa: F811
    await _synced(db_session, zoho, order(1))
    code = await tracking.ensure_token(db_session, "so1")

    async def views():
        rows = await db_session.execute(select(OrderBoardEvent).where(OrderBoardEvent.kind == "tracking.viewed"))
        return rows.scalars().all()

    first = await _open(async_client, code)
    await _open(async_client, code)
    logged = await views()
    assert len(logged) == 1 and (logged[0].salesorder_id, logged[0].actor_class) == ("so1", "client")
    # A view is not a change to the order: "updated" does not move.
    assert (await _open(async_client, code)).json()["updated_at"] == first.json()["updated_at"]
    await tracking.log_view(db_session, "so1", logged[0].occurred_at + timedelta(minutes=5, seconds=1))
    assert len(await views()) == 2
    await _open(async_client, "ZZZZZZ")
    assert len(await views()) == 2


@pytest.mark.asyncio
async def test_a_failing_view_log_never_breaks_the_page(async_client, db_session, zoho, monkeypatch, caplog):  # noqa: F811
    await _synced(db_session, zoho, order(1))

    async def boom(*_):
        raise RuntimeError("db is busy")

    monkeypatch.setattr(tracking, "log_view", boom)
    assert (await _open(async_client, await tracking.ensure_token(db_session, "so1"))).status_code == 200
    assert "tracking view log failed" in caplog.text
    caplog.clear()


@pytest.mark.asyncio
async def test_misses_are_throttled_with_the_aito_page_and_hits_are_free(async_client, db_session, zoho, monkeypatch):  # noqa: F811
    await _synced(db_session, zoho, order(1))
    code = await tracking.ensure_token(db_session, "so1")
    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_MISSES_PER_IP", 3)
    for _ in range(5):
        assert (await _open(async_client, code)).status_code == 200
    assert (await async_client.get("/api/v1/aito/track/ZZZZZZ")).status_code == 404  # the same budget
    assert [(await _open(async_client, "ZZZZZZ")).status_code for _ in range(3)] == [404, 404, 429]
    blocked = await _open(async_client, code)
    assert blocked.status_code == 429 and blocked.headers["retry-after"] == "60"
    assert blocked.headers["cache-control"] == "no-store"


# --- the operator's side ---------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_link_route_mints_once_and_needs_orders_update(async_client, db_session, zoho, tokens):  # noqa: F811
    await _synced(db_session, zoho, order(1))
    path = f"{BASE}/orders/so1/tracking-link"
    assert (await async_client.get(path)).status_code == 401
    assert (await async_client.get(path, headers=tokens["read"])).status_code == 403
    assert (await async_client.get(path, headers=tokens["both"])).json() == {"tracking_url": None}
    db_session.add(Settings(key="external_url", value="https://suivi.example"))
    await db_session.commit()
    url = (await async_client.get(path, headers=tokens["both"])).json()["tracking_url"]
    assert url == (await async_client.get(path, headers=tokens["both"])).json()["tracking_url"]
    assert url == f"https://suivi.example/t/o/{await tracking.ensure_token(db_session, 'so1')}"
    assert (await _open(async_client, url.rsplit("/", 1)[1])).status_code == 200
    unknown = await async_client.get(f"{BASE}/orders/nope/tracking-link", headers=tokens["both"])
    assert unknown.status_code == 404


@pytest.mark.asyncio
async def test_the_sms_draft_carries_the_link_only_when_the_external_url_is_set(db_session, zoho):  # noqa: F811
    await _synced(db_session, zoho, order(1, packed=1))
    assert "Suivi" not in (await order_board_sms.draft(db_session, "so1"))["message"]
    db_session.add(Settings(key="external_url", value="https://suivi.example"))
    await db_session.commit()
    message = (await order_board_sms.draft(db_session, "so1"))["message"]
    code = await tracking.ensure_token(db_session, "so1")
    assert message.endswith(f"\nSuivi de ta commande : https://suivi.example/t/o/{code}\nAito3D")
    assert set(message) <= _GSM, set(message) - _GSM


def test_the_tracking_link_comes_after_the_payment_link():
    row = {"number": "SO-1", "lines": [], "ready_ratio": 1, "facts": {}, "payment": {"left": 0}, "currency": "XPF"}
    message = order_board_sms.compose(row, {}, "https://pay.example/p", "https://suivi.example/t/o/K7F3XQ")["message"]
    assert message.endswith(
        "\nLien de paiement : https://pay.example/p\nSuivi de ta commande : https://suivi.example/t/o/K7F3XQ\nAito3D"
    )
    assert set(message) <= _GSM
