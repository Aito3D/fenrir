"""Creating, editing, declining and reopening a product quote from the Order Board. Zoho is a fake throughout."""

from datetime import date, timedelta

import pytest

from backend.app.services import order_board_actions as actions, order_board_sync as sync
from backend.app.services.order_board_actions import create as create_module
from backend.app.services.zoho import zoho_service
from backend.tests.unit.test_order_board_actions import events_of
from backend.tests.unit.test_order_board_quote_sync import quote
from backend.tests.unit.test_order_board_sync import (  # noqa: F401
    no_back_off_left_over,
    pings,
    zoho,
)

ITEMS = {
    "A": {"item_id": "A", "name": "PLA", "rate": 120, "product_type": "goods"},
    "B": {"item_id": "B", "name": "PETG", "rate": 3000, "product_type": "goods"},
    "S": {"item_id": "S", "name": "Main d'oeuvre", "rate": 5000, "product_type": "service"},
}
TODAY = date.today()


@pytest.fixture(autouse=True)
def no_ref_left_over():
    create_module._created.clear()
    create_module._ref_locks.clear()
    yield
    create_module._created.clear()
    create_module._ref_locks.clear()


@pytest.fixture
def books(zoho, monkeypatch):  # noqa: F811
    """The estimate writes on the fake: each one recorded in ``sent`` and applied to the estimate get_estimate returns."""
    zoho.sent = []

    async def list_items_by_ids(db, item_ids):
        return [ITEMS[i] for i in item_ids if i in ITEMS]

    async def create_estimate(db, payload):
        zoho.sent.append(("create", payload))
        estimate = {**quote(9, status="draft"), "line_items": payload["line_items"]}
        zoho.estimates["e9"] = estimate
        return estimate

    async def update_estimate_lines(
        db, estimate_id, line_items, notes=None, *, customer_id=None, contact_person_id=None
    ):
        zoho.sent.append(("lines", estimate_id, line_items, customer_id))
        zoho.estimates[estimate_id] = {**zoho.estimates[estimate_id], "line_items": line_items, "total": 1.0}
        return zoho.estimates[estimate_id]

    async def update_estimate_fields(db, estimate_id, fields):
        zoho.sent.append(("fields", estimate_id, fields))
        zoho.estimates[estimate_id] = {**zoho.estimates[estimate_id], **fields}
        return zoho.estimates[estimate_id]

    async def set_estimate_status(db, estimate_id, status):
        zoho.sent.append(("status", estimate_id, status))
        zoho.estimates[estimate_id] = {**zoho.estimates[estimate_id], "status": status}

    async def list_contact_persons(db, contact_id):
        return []

    for fn in (
        list_items_by_ids,
        create_estimate,
        update_estimate_lines,
        update_estimate_fields,
        set_estimate_status,
        list_contact_persons,
    ):
        monkeypatch.setattr(zoho_service, fn.__name__, fn)
    return zoho


async def _stored(db, books, estimate: dict, *, fresh: dict | None = None) -> None:
    """``estimate`` as the stored copy; Books holds ``fresh`` (the same by default)."""
    await sync.store_quote(db, estimate)
    await db.commit()
    books.estimates[estimate["estimate_id"]] = fresh or estimate


def _with_line(n: int, **line) -> dict:
    q = quote(n)
    q["line_items"] = [{"line_item_id": f"ql{n}", "item_id": "A", "quantity": 1, "rate": 120, **line}]
    return q


@pytest.mark.asyncio
async def test_create_quote_sends_inclusive_item_level_payload_and_stores_it(db_session, books, pings):
    lines = [{"item_id": "A", "quantity": 2}, {"item_id": "B", "quantity": 1, "discount": "10%"}]
    assert await actions.create_quote(db_session, "c1", lines, "ref-1", by="ana") == "e9"
    assert books.sent == [
        (
            "create",
            {
                "customer_id": "c1",
                "date": TODAY.isoformat(),
                "is_inclusive_tax": True,
                "discount_type": "item_level",
                "is_discount_before_tax": True,
                "line_items": [
                    {"item_id": "A", "quantity": 2, "rate": 120.0},
                    {"item_id": "B", "quantity": 1, "rate": 3000.0, "discount": "10%"},
                ],
            },
        )
    ]
    assert (await sync.find_quote(db_session, "e9")).detail["status"] == "draft"
    assert [(e.kind, e.actor_name) for e in await events_of(db_session, "e9")] == [("quote.created", "ana")]
    assert pings[-1]["quotes"] is True


@pytest.mark.asyncio
async def test_same_client_ref_returns_the_first_quote(db_session, books):
    lines = [{"item_id": "A", "quantity": 1}]
    assert await actions.create_quote(db_session, "c1", lines, "ref-1", by=None) == "e9"
    assert await actions.create_quote(db_session, "c1", lines, "ref-1", by=None) == "e9"
    assert len(books.sent) == 1


@pytest.mark.asyncio
async def test_create_refuses_a_service_item(db_session, books):
    with pytest.raises(actions.OrderActionRefused, match="unknown_item"):
        await actions.create_quote(db_session, "c1", [{"item_id": "S", "quantity": 1}], "ref-1", by=None)
    assert books.sent == []


@pytest.mark.asyncio
async def test_edit_keeps_books_price_and_name_on_kept_lines(db_session, books, pings):
    await _stored(db_session, books, _with_line(1, rate=99.5, name="Bobine sur mesure", tax_id="t1", unit="pcs"))
    await actions.edit_quote(
        db_session, "e1", "c1", [{"line_id": "ql1", "item_id": "A", "quantity": 3, "discount": "5%"}], by="ana"
    )
    assert books.sent == [
        (
            "lines",
            "e1",
            [
                {
                    "line_item_id": "ql1",
                    "item_id": "A",
                    "name": "Bobine sur mesure",
                    "rate": 99.5,
                    "tax_id": "t1",
                    "unit": "pcs",
                    "quantity": 3,
                    "discount": "5%",
                }
            ],
            None,  # same customer: not resent
        )
    ]
    assert (await sync.find_quote(db_session, "e1")).detail["total"] == 1.0  # re-read and stored
    assert [e.kind for e in await events_of(db_session, "e1")] == ["quote.edited"]
    assert pings[-1]["quotes"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize(("asked", "sent"), [({}, 0), ({"discount": "5%"}, "5%")])
async def test_edit_kept_line_always_states_its_discount(db_session, books, asked, sent):
    await _stored(db_session, books, _with_line(1, discount="10%"))
    await actions.edit_quote(
        db_session, "e1", "c1", [{"line_id": "ql1", "item_id": "A", "quantity": 1, **asked}], by=None
    )
    assert books.sent[0][2][0]["discount"] == sent


@pytest.mark.asyncio
async def test_edit_new_line_takes_the_item_rate(db_session, books):
    await _stored(db_session, books, _with_line(1, rate=99.5))
    lines = [{"line_id": "ql1", "item_id": "A", "quantity": 1}, {"item_id": "B", "quantity": 2}]
    await actions.edit_quote(db_session, "e1", "c2", lines, by=None)
    [(_, _, sent_lines, customer_id)] = books.sent
    assert sent_lines[1] == {"item_id": "B", "quantity": 2, "rate": 3000.0}
    assert customer_id == "c2"


@pytest.fixture
def books_http(books, monkeypatch):
    """The real update_estimate_lines and list_contact_persons over a fake ``_request``: the bodies Books would get."""
    books.requests = []
    books.persons = {"c2": [{"contact_person_id": "p1"}, {"contact_person_id": "p2", "is_primary_contact": True}]}
    real = type(zoho_service)

    async def request(db, method, path, **kw):
        books.requests.append((method, path, kw.get("json")))
        if method == "GET":
            return {"contact": {"contact_persons": books.persons.get(path.rsplit("/", 1)[-1], [])}}
        return {"estimate": books.estimates[path.rsplit("/", 1)[-1]]}

    monkeypatch.setattr(zoho_service, "_request", request)
    for name in ("update_estimate_lines", "list_contact_persons"):
        monkeypatch.setattr(zoho_service, name, getattr(real, name).__get__(zoho_service))
    return books


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("persons", "contact_persons"), [(None, ["p2"]), ([], None), ([{"contact_person_id": "p1"}], ["p1"])]
)
async def test_edit_to_another_customer_moves_the_contact_person(db_session, books_http, persons, contact_persons):
    if persons is not None:
        books_http.persons["c2"] = persons
    await _stored(db_session, books_http, _with_line(1))
    await actions.edit_quote(db_session, "e1", "c2", [{"line_id": "ql1", "item_id": "A", "quantity": 1}], by=None)
    [put] = [r for r in books_http.requests if r[0] == "PUT"]
    assert put[2]["customer_id"] == "c2"
    assert put[2].get("contact_persons") == contact_persons


@pytest.mark.asyncio
async def test_edit_for_the_same_customer_reads_no_contact(db_session, books_http):
    await _stored(db_session, books_http, _with_line(1))
    await actions.edit_quote(db_session, "e1", "c1", [{"line_id": "ql1", "item_id": "A", "quantity": 1}], by=None)
    [(method, _, body)] = books_http.requests
    assert method == "PUT" and "contact_persons" not in body and "customer_id" not in body


@pytest.mark.asyncio
async def test_edit_kept_line_naming_another_item_is_refused(db_session, books):
    await _stored(db_session, books, _with_line(1))
    with pytest.raises(actions.OrderActionRefused, match="unknown_line"):
        await actions.edit_quote(db_session, "e1", "c1", [{"line_id": "ql1", "item_id": "B", "quantity": 1}], by=None)
    assert books.sent == []


@pytest.mark.asyncio
async def test_edit_refused_on_a_tax_exclusive_quote(db_session, books):
    await _stored(db_session, books, {**_with_line(1), "is_inclusive_tax": False})
    with pytest.raises(actions.OrderActionRefused, match="quote_not_editable"):
        await actions.edit_quote(db_session, "e1", "c1", [{"line_id": "ql1", "item_id": "A", "quantity": 1}], by=None)
    assert books.sent == []


@pytest.mark.asyncio
async def test_edit_unknown_line_is_refused(db_session, books):
    await _stored(db_session, books, _with_line(1))
    with pytest.raises(actions.OrderActionRefused, match="unknown_line"):
        await actions.edit_quote(db_session, "e1", "c1", [{"line_id": "nope", "item_id": "A", "quantity": 1}], by=None)
    assert books.sent == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("entry", "reason"),
    [
        ({"line_id": "ql1", "item_id": "A", "quantity": 0.0001}, "bad_quantity"),
        ({"line_id": "ql1", "item_id": "A", "quantity": 1, "discount": "abc"}, "bad_discount"),
        ({"line_id": "ql1", "item_id": "A", "quantity": 1, "discount": "121"}, "bad_discount"),  # over the line total
    ],
)
async def test_edit_kept_line_follows_the_create_rules(db_session, books, entry, reason):
    await _stored(db_session, books, _with_line(1))
    with pytest.raises(actions.OrderActionRefused, match=reason):
        await actions.edit_quote(db_session, "e1", "c1", [entry], by=None)
    assert books.sent == []


@pytest.mark.asyncio
async def test_edit_refused_on_free_text_line(db_session, books):
    await _stored(db_session, books, _with_line(1, item_id=""))
    with pytest.raises(actions.OrderActionRefused, match="quote_not_editable"):
        await actions.edit_quote(db_session, "e1", "c1", [{"line_id": "ql1", "item_id": "A", "quantity": 1}], by=None)
    assert books.sent == []


@pytest.mark.asyncio
async def test_edit_expired_redates_with_the_quotes_own_validity(db_session, books):
    await _stored(db_session, books, {**_with_line(1), "date": "2026-10-01", "expiry_date": "2026-10-31"})
    await actions.edit_quote(db_session, "e1", "c1", [{"line_id": "ql1", "item_id": "A", "quantity": 1}], by=None)
    assert books.sent[1] == (
        "fields",
        "e1",
        {"date": TODAY.isoformat(), "expiry_date": (TODAY + timedelta(days=30)).isoformat()},
    )


@pytest.mark.asyncio
async def test_edit_expired_redates_defaults_to_16_days(db_session, books):
    await _stored(db_session, books, {**_with_line(1), "date": "2026-10-31", "expiry_date": "2026-10-01"})
    await actions.edit_quote(db_session, "e1", "c1", [{"line_id": "ql1", "item_id": "A", "quantity": 1}], by=None)
    assert books.sent[1][2]["expiry_date"] == (TODAY + timedelta(days=16)).isoformat()


@pytest.mark.asyncio
async def test_edit_of_a_live_quote_keeps_its_dates(db_session, books):
    await _stored(db_session, books, _with_line(1))
    await actions.edit_quote(db_session, "e1", "c1", [{"line_id": "ql1", "item_id": "A", "quantity": 2}], by=None)
    assert [call[0] for call in books.sent] == ["lines"]


@pytest.mark.asyncio
@pytest.mark.parametrize("write", ["edit", "decline", "reopen"])
async def test_write_refused_when_books_says_converted(db_session, books, write):
    stored = _with_line(1, status="declined")
    converted = {**stored, "salesorders": [{"salesorder_id": "so1", "salesorder_order_status": "open"}]}
    await _stored(db_session, books, stored, fresh=converted)
    with pytest.raises(actions.OrderActionRefused, match="quote_converted"):
        await _write(db_session, write, "e1")
    assert books.sent == []


@pytest.mark.asyncio
@pytest.mark.parametrize("write", ["edit", "decline", "reopen"])
async def test_write_on_unstored_quote_is_404_and_sends_nothing(db_session, books, write):
    books.estimates["e1"] = _with_line(1, status="declined")  # in Books, but not in the local copy (Aito, dropped)
    with pytest.raises(actions.QuoteNotStored):
        await _write(db_session, write, "e1")
    assert (books.sent, books.calls["estimate"]) == ([], 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("write", ["edit", "decline", "reopen"])
async def test_write_on_a_quote_deleted_in_books_is_404_and_drops_it(db_session, books, pings, monkeypatch, write):
    from backend.app.services.zoho import ZohoNotFound

    await _stored(db_session, books, _with_line(1, status="declined"))

    async def gone(db, estimate_id):
        raise ZohoNotFound("gone")

    monkeypatch.setattr(zoho_service, "get_estimate", gone)
    with pytest.raises(actions.QuoteNotStored):
        await _write(db_session, write, "e1")
    assert books.sent == []
    assert await sync.find_quote(db_session, "e1") is None
    assert pings[-1]["quotes"] is True


@pytest.mark.asyncio
async def test_edit_refused_on_a_quote_with_a_draft_order(db_session, books):
    draft = [{"salesorder_id": "so7", "salesorder_order_status": "draft"}]
    await _stored(db_session, books, {**_with_line(1, status="accepted"), "salesorders": draft})
    with pytest.raises(actions.OrderActionRefused, match="quote_not_editable"):
        await actions.edit_quote(db_session, "e1", "c1", [{"line_id": "ql1", "item_id": "A", "quantity": 1}], by=None)
    assert books.sent == []


async def _write(db, write: str, estimate_id: str) -> None:
    if write == "edit":
        await actions.edit_quote(db, estimate_id, "c1", [{"line_id": "ql1", "item_id": "A", "quantity": 1}], by=None)
    elif write == "decline":
        await actions.decline_quote(db, estimate_id, by=None)
    else:
        await actions.reopen_quote(db, estimate_id, by=None)


@pytest.mark.asyncio
async def test_decline_from_draft_marks_sent_first(db_session, books, pings):
    await _stored(db_session, books, {**_with_line(1), "status": "draft"})
    await actions.decline_quote(db_session, "e1", by="ana")
    assert books.sent == [("status", "e1", "sent"), ("status", "e1", "declined")]
    assert (await sync.find_quote(db_session, "e1")).detail["status"] == "declined"
    assert [e.kind for e in await events_of(db_session, "e1")] == ["quote.declined"]
    assert pings[-1]["quotes"] is True


@pytest.mark.asyncio
async def test_reopen_only_from_declined(db_session, books):
    await _stored(db_session, books, {**_with_line(1), "status": "declined"}, fresh={**_with_line(1), "status": "sent"})
    with pytest.raises(actions.OrderActionRefused, match="not_declined"):  # the fresh status decides
        await actions.reopen_quote(db_session, "e1", by=None)
    assert books.sent == []
    books.estimates["e1"]["status"] = "declined"
    await actions.reopen_quote(db_session, "e1", by="ana")
    assert books.sent == [("status", "e1", "sent")]
    assert (await sync.find_quote(db_session, "e1")).detail["status"] == "sent"
    assert [e.kind for e in await events_of(db_session, "e1")] == ["quote.reopened"]
