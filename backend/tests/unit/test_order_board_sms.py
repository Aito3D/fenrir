"""The order pickup SMS: the template, the contacted stamp, and the admin-only routes."""

import pytest

from backend.app.services import order_board_actions as actions, order_board_sync as sync
from backend.app.services.order_board_sms import compose
from backend.tests.unit.test_order_board_sync import (  # noqa: F401
    _synced,
    file_sessions,
    no_back_off_left_over,
    order,
    zoho,
)

# GSM 03.38 basic set (one unit each) and extension (two units): staying inside it keeps 160 chars = 1 SMS.
_GSM = set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿")
_GSM |= set("abcdefghijklmnopqrstuvwxyzäöñüà^{}\\[~]|€")
NATURES = {"fil": "Filaments", "p2s": "3D Printers", "ams": "3D Printer Accessories"}


def _line(item_id, name="x", qty=1, state="ready"):
    return {"item_id": item_id, "name": name, "quantity": qty, "cancelled": 0, "state": state}


def _row(*lines, ready=1.0, shopify="1106", left=0.0):
    return {
        "number": "SO-00264",
        "lines": list(lines),
        "ready_ratio": ready,
        "facts": {"shopify_order": shopify},
        "payment": {"left": left},
        "currency": "XPF",
    }


def test_filaments_only_paid_with_shopify_number():
    out = compose(_row(_line("fil"), _line("fil")), NATURES)
    assert out["kind"] == "filaments"
    assert out["message"] == (
        "Ia Ora na, tes filaments de la commande #1106 sont disponibles. "
        "Tu peux venir les récupérer à notre boutique à Arue.\nAito3D"
    )


def test_printer_and_filaments_name_the_printer_and_say_what_is_due():
    out = compose(_row(_line("p2s", "Bambu Lab - P2S Combo"), _line("fil"), shopify="", left=98745), NATURES)
    assert out["kind"] == "printer_filaments"
    assert out["message"] == (
        "Ia Ora na, ton imprimante Bambu Lab P2S Combo et tes filaments de la commande SO-00264 sont disponibles. "
        "Tu peux venir les récupérer à notre boutique à Arue. Reste à régler : 98 745 FCFP.\nAito3D"
    )


def test_printer_alone():
    out = compose(_row(_line("p2s", "Bambu Lab - X2D Combo")), NATURES)
    assert out["kind"] == "printer"
    assert "ton imprimante Bambu Lab X2D Combo de la commande #1106 est disponible. Tu peux venir la" in out["message"]


@pytest.mark.parametrize(
    "lines",
    [
        [_line("fil"), _line("ams")],  # an accessory makes it "ta commande"
        [_line("p2s"), _line("p2s")],  # two printers
        [_line("p2s", qty=2)],
        [_line("unknown")],
    ],
)
def test_anything_else_is_ta_commande(lines):
    out = compose(_row(*lines), NATURES)
    assert out["kind"] == "other"
    assert "ta commande #1106 est disponible. Tu peux venir la récupérer" in out["message"]


def test_services_and_cancelled_lines_do_not_change_the_wording():
    cancelled = {**_line("ams"), "cancelled": 1}
    out = compose(_row(_line("fil"), _line(None, "Main d'oeuvre", state="service"), cancelled), NATURES)
    assert out["kind"] == "filaments"


def test_a_partly_ready_order_says_part_of_it_is_there():
    out = compose(_row(_line("fil"), ready=0.95), NATURES)
    assert out["partial"] is True
    assert out["message"].startswith(
        "Ia Ora na, une partie de ta commande #1106 est disponible, le reste arrive prochainement."
    )


@pytest.mark.parametrize("left", [0, 3050, 1234567])
def test_every_variant_stays_in_the_sms_alphabet(left):
    for lines, ready in (
        ([_line("fil")], 1),
        ([_line("p2s", "Bambu Lab - P2S Combo"), _line("fil")], 1),
        ([_line("ams")], 0.5),
    ):
        message = compose(_row(*lines, ready=ready, left=left), NATURES)["message"]
        assert set(message) <= _GSM, set(message) - _GSM


# --- contacted stamp -------------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_contact_stamp_is_on_the_row_and_the_first_one_is_kept(db_session, zoho):  # noqa: F811
    await _synced(db_session, zoho, order(1))
    first = (await actions.stamp_contact(db_session, "so1", "paul"))["contacted"]
    assert first["by"] == "paul"
    again = (await actions.stamp_contact(db_session, "so1", "other"))["contacted"]
    assert again == first
    await sync.run_pass(db_session)
    assert (await sync.read_board(db_session))["rows"][0]["contacted"] == first


@pytest.mark.asyncio
async def test_contact_stamp_row_carries_the_sms_as_last_event(db_session, zoho):  # noqa: F811
    await _synced(db_session, zoho, order(1))
    row = await actions.stamp_contact(db_session, "so1", "paul")
    assert row["last_event"]["kind"] == "sms.sent" and row["last_event"]["actor_name"] == "paul"


@pytest.mark.asyncio
async def test_contact_stamp_on_an_order_off_the_board_is_refused(db_session, zoho):  # noqa: F811
    await _synced(db_session, zoho, order(1))
    with pytest.raises(actions.OrderNotOnBoard):
        await actions.stamp_contact(db_session, "nope", "paul")


# --- routes ----------------------------------------------------------------------------------------------------


@pytest.fixture
async def admin_and_operator(db_session):
    from backend.app.core.auth import create_access_token, get_password_hash
    from backend.app.core.permissions import Permission
    from backend.app.models.group import Group
    from backend.app.models.settings import Settings
    from backend.app.models.user import User

    db_session.add(Settings(key="auth_enabled", value="true"))
    operators = Group(name="sms-orders-op", permissions=[Permission.ORDERS_READ.value, Permission.ORDERS_UPDATE.value])
    operator = User(username="sms-op", password_hash=get_password_hash("password"), is_active=True)
    operator.groups.append(operators)
    admin = User(username="sms-admin", password_hash=get_password_hash("password"), is_active=True, role="admin")
    db_session.add_all([operators, operator, admin])
    await db_session.commit()
    return {
        who: {"Authorization": f"Bearer {create_access_token(data={'sub': who})}"} for who in ("sms-op", "sms-admin")
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(("method", "path"), [("get", "sms-draft"), ("post", "sms")])
async def test_routes_are_admin_only(async_client, admin_and_operator, method, path):
    url = f"/api/v1/order-board/orders/so1/{path}"
    assert (await getattr(async_client, method)(url, headers=admin_and_operator["sms-op"])).status_code == 403
    # An admin gets through to the order lookup: nothing is stored, so the order is unknown.
    assert (await getattr(async_client, method)(url, headers=admin_and_operator["sms-admin"])).status_code == 404


@pytest.mark.asyncio
async def test_record_route_stamps_with_the_username(async_client, admin_and_operator, monkeypatch):
    seen = {}

    async def fake(db, salesorder_id, by):
        seen.update(id=salesorder_id, by=by)
        return {"id": salesorder_id, "contacted": {"at": "t", "by": by}}

    monkeypatch.setattr(actions, "stamp_contact", fake)
    r = await async_client.post("/api/v1/order-board/orders/so1/sms", headers=admin_and_operator["sms-admin"])
    assert r.status_code == 200
    assert seen == {"id": "so1", "by": "sms-admin"}
    assert r.json()["contacted"]["by"] == "sms-admin"
