"""POST /aito/{id}/invoice — raising the bill for a finished job.

The guards carry most of the weight here. Everything this endpoint does is
irreversible from inside this app: a second call raises a second real
invoice, and applying a deposit twice spends money the client only paid
once. So the tests below are mostly about the calls that must NOT happen.
"""

import pytest
from sqlalchemy import select

from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.services.aito_invoice_create import build_line_items
from backend.app.services.zoho import ZohoUpstreamError, zoho_service

ESTIMATE = {
    "estimate_id": "EST-9",
    "estimate_number": "DEV26-2493",
    "customer_id": "z1",
    "currency_code": "XPF",
    "currency_id": "cur-1",
    "is_inclusive_tax": True,
    "discount_type": "item_level",
    "is_discount_before_tax": True,
    "total": 2500.0,
    "line_items": [
        {
            "line_item_id": "li-1",
            "item_id": "it-mod",
            "name": 'Modelisation3D - Prestation "AITO 3D"',
            "description": "Info: Bague",
            "rate": 1000,
            "quantity": 1,
            "unit": "Projet",
            "discount": 0,
            "tax_id": "tax-1",
            "tax_percentage": 13,
            "item_order": 1,
            "header_name": "",
            "item_total": 885,
        },
        {
            "line_item_id": "li-2",
            "item_id": "it-imp",
            "name": 'Impression3D - Prestation "AITO 3D"',
            "description": "Poids: 10gr",
            "rate": 1500,
            "quantity": 1,
            "unit": "Projet",
            "discount": "10.00%",
            "tax_id": "tax-1",
            "item_order": 2,
            "header_name": "Bague entretoise",
        },
    ],
    "retainerinvoices": [
        {"retainerinvoice_id": "ret-1", "retainerinvoice_number": "RET-00269", "status": "paid", "total": 1000.0}
    ],
}

RETAINER = {
    "retainerinvoice_id": "ret-1",
    "retainerinvoice_number": "RET-00269",
    "status": "paid",
    "total": 1000.0,
    "payments": [{"payment_id": "pay-1", "amount": 1000.0, "unused_payment_amount": 1000.0}],
}

CREATED = {
    "invoice_id": "inv-1",
    "invoice_number": "FA-26-4100",
    "date": "2026-09-12",
    "due_date": "2026-09-12",
    "total": 2500.0,
    "balance": 2500.0,
    "currency_code": "XPF",
    "status": "draft",
}

LISTED = {
    "invoice_id": "inv-1",
    "invoice_number": "FA-26-4100",
    "date": "2026-09-12",
    "due_date": "2026-09-12",
    "total": 2500.0,
    "balance": 1500.0,
    "currency_code": "XPF",
    "status": "draft",
    "customer_id": "z1",
}


@pytest.fixture
def books(monkeypatch):
    """A Books that answers every call this feature makes, and logs them all.

    Patched on the zoho_service INSTANCE (so the fakes take no ``self``),
    matching test_aito_invoice.py — safe only because conftest's
    ``reset_zoho_singleton_shadows`` strips the shadow afterwards.
    """
    state = {
        "calls": [],
        "estimate": dict(ESTIMATE),
        "retainer": dict(RETAINER),
        "created": dict(CREATED),
        "listed": [],  # what GET /invoices answers; empty = not yet invoiced
        "fail": None,  # a path prefix that should raise instead
    }

    async def request(db, method, path, *, params=None, json=None):
        state["calls"].append({"method": method, "path": path, "params": params or {}, "json": json})
        if state["fail"] and path.startswith(state["fail"]):
            raise ZohoUpstreamError("Zoho is down")
        if path == "/invoices" and method == "GET":
            return {"invoices": [dict(i) for i in state["listed"]]}
        if path == "/invoices" and method == "POST":
            state["listed"] = [dict(LISTED)]
            return {"invoice": dict(state["created"])}
        if path.startswith("/estimates/"):
            return {"estimate": dict(state["estimate"])}
        if path.startswith("/retainerinvoices/"):
            return {"retainerinvoice": dict(state["retainer"])}
        return {}

    async def base(db):
        return "https://books.zoho.eu/app/org1"

    monkeypatch.setattr(zoho_service, "_request", request)
    monkeypatch.setattr(zoho_service, "_books_app_base", base)
    return state


def _paths(state, method=None):
    return [c["path"] for c in state["calls"] if method is None or c["method"] == method]


async def _project(db_session, **overrides) -> int:
    fields = {"description": "Bague", "board_column": "finish", "quote_id": "EST-9", "client_id": "z1"}
    fields.update(overrides)
    project = AitoProject(**fields)
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)
    return project.id


# --- line items ---------------------------------------------------------------


def test_line_items_drop_books_own_read_only_fields():
    """Echoing `line_item_id` into an invoice create binds the new line to the
    ESTIMATE's row; `item_total` and `tax_percentage` are derived. None of the
    three may travel."""
    lines = build_line_items(ESTIMATE["line_items"])

    assert all("line_item_id" not in line for line in lines)
    assert all("item_total" not in line for line in lines)
    assert all("tax_percentage" not in line for line in lines)
    assert lines[0]["item_id"] == "it-mod"
    assert lines[0]["rate"] == 1000
    assert lines[0]["tax_id"] == "tax-1"


def test_line_items_omit_empty_headers_and_zero_discounts():
    """Books echoes `header_name: ""` and `discount: 0` on every ordinary
    line. Sending those back puts an empty header and a pointless discount
    column on the invoice PDF."""
    lines = build_line_items(ESTIMATE["line_items"])

    assert "header_name" not in lines[0]
    assert "discount" not in lines[0]
    assert lines[1]["header_name"] == "Bague entretoise"
    # Verbatim, not re-derived: a bare number would be read as an amount.
    assert lines[1]["discount"] == "10.00%"


# --- guards -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_project_outside_finish_is_never_invoiced(async_client, db_session, books):
    project_id = await _project(db_session, board_column="print")

    response = await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    assert response.status_code == 409
    assert books["calls"] == []


@pytest.mark.asyncio
async def test_a_project_with_no_quote_is_never_invoiced(async_client, db_session, books):
    project_id = await _project(db_session, quote_id=None)

    response = await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    assert response.status_code == 409
    assert books["calls"] == []


@pytest.mark.asyncio
async def test_a_quote_still_syncing_is_never_invoiced(async_client, db_session, books):
    """Billing now would issue a document for the lines as they were BEFORE
    the pending edit lands, and no later sync can correct an issued invoice."""
    project_id = await _project(db_session, quote_sync_state="pending")

    response = await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    assert response.status_code == 409
    assert books["calls"] == []


@pytest.mark.asyncio
async def test_an_already_invoiced_project_is_refused_before_anything_is_created(async_client, db_session, books):
    """The double-click / two-operators case. Nothing about it is malformed,
    so the only thing standing between it and a second real invoice is this
    check happening BEFORE the create."""
    books["listed"] = [dict(LISTED)]
    project_id = await _project(db_session)

    response = await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    assert response.status_code == 409
    assert "POST" not in [c["method"] for c in books["calls"]]


@pytest.mark.asyncio
async def test_a_deleted_project_is_a_404(async_client, db_session, books):
    project_id = await _project(db_session, status="deleted")

    assert (await async_client.post(f"/api/v1/aito/{project_id}/invoice")).status_code == 404


# --- the happy path -----------------------------------------------------------


@pytest.mark.asyncio
async def test_the_invoice_is_linked_to_the_estimate_and_carries_its_lines(async_client, db_session, books):
    """`estimate_id` is the whole visibility story: `list_project_invoices`
    filters GET /invoices by it and by nothing else, so an invoice raised
    without it exists in Books and is invisible to every Aito surface."""
    project_id = await _project(db_session)

    response = await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    assert response.status_code == 200
    posted = next(c["json"] for c in books["calls"] if c["method"] == "POST" and c["path"] == "/invoices")
    assert posted["estimate_id"] == "EST-9"
    assert posted["customer_id"] == "z1"
    assert len(posted["line_items"]) == 2
    # The fields that decide the total travel; the estimate's wording does not.
    assert posted["is_inclusive_tax"] is True
    assert posted["currency_id"] == "cur-1"
    assert "notes" not in posted and "terms" not in posted and "template_id" not in posted


@pytest.mark.asyncio
async def test_a_paid_retainer_is_applied_as_payment(async_client, db_session, books):
    project_id = await _project(db_session)

    body = (await async_client.post(f"/api/v1/aito/{project_id}/invoice")).json()

    credits = next(c for c in books["calls"] if c["path"] == "/invoices/inv-1/credits")
    assert credits["json"] == {"invoice_payments": [{"payment_id": "pay-1", "amount_applied": 1000.0}]}
    assert body["retainers"] == [{"number": "RET-00269", "total": 1000.0, "applied": 1000.0}]


@pytest.mark.asyncio
async def test_the_application_is_capped_at_the_invoice_balance(async_client, db_session, books):
    """A deposit larger than the final bill is real — a job that shrank after
    the deposit was taken. Books rejects an over-application outright."""
    books["retainer"] = {
        **RETAINER,
        "total": 9000.0,
        "payments": [{"payment_id": "pay-1", "unused_payment_amount": 9000.0}],
    }
    project_id = await _project(db_session)

    body = (await async_client.post(f"/api/v1/aito/{project_id}/invoice")).json()

    credits = next(c for c in books["calls"] if c["path"] == "/invoices/inv-1/credits")
    assert credits["json"]["invoice_payments"][0]["amount_applied"] == 2500.0
    assert body["retainers"][0]["applied"] == 2500.0


@pytest.mark.asyncio
async def test_two_deposits_are_shared_out_first_come_first_served(async_client, db_session, books, monkeypatch):
    """Two deposits that together exceed a job that shrank. The second may
    only take what the first left, and the preview must show the SAME split
    the create performs — not each deposit's raw unused amount under a
    balance that had already netted them off."""
    books["estimate"] = {
        **ESTIMATE,
        "retainerinvoices": [
            {"retainerinvoice_id": "ret-1", "retainerinvoice_number": "RET-1", "status": "paid", "total": 2000.0},
            {"retainerinvoice_id": "ret-2", "retainerinvoice_number": "RET-2", "status": "paid", "total": 2000.0},
        ],
    }

    async def request(db, method, path, *, params=None, json=None):
        books["calls"].append({"method": method, "path": path, "params": params or {}, "json": json})
        if path == "/invoices" and method == "GET":
            return {"invoices": [dict(i) for i in books["listed"]]}
        if path == "/invoices" and method == "POST":
            books["listed"] = [dict(LISTED)]
            return {"invoice": dict(CREATED)}
        if path.startswith("/estimates/"):
            return {"estimate": dict(books["estimate"])}
        if path == "/retainerinvoices/ret-1":
            return {
                "retainerinvoice": {
                    "retainerinvoice_number": "RET-1",
                    "status": "paid",
                    "total": 2000.0,
                    "payments": [{"payment_id": "pay-1", "unused_payment_amount": 2000.0}],
                }
            }
        if path == "/retainerinvoices/ret-2":
            return {
                "retainerinvoice": {
                    "retainerinvoice_number": "RET-2",
                    "status": "paid",
                    "total": 2000.0,
                    "payments": [{"payment_id": "pay-2", "unused_payment_amount": 2000.0}],
                }
            }
        return {}

    monkeypatch.setattr(zoho_service, "_request", request)
    project_id = await _project(db_session)

    preview = (await async_client.get(f"/api/v1/aito/{project_id}/invoice-preview")).json()
    assert [r["applicable"] for r in preview["retainers"]] == [2000.0, 500.0]
    assert preview["projected_balance"] == 0.0

    body = (await async_client.post(f"/api/v1/aito/{project_id}/invoice")).json()
    assert [r["applied"] for r in body["retainers"]] == [2000.0, 500.0]


@pytest.mark.asyncio
async def test_an_unpaid_retainer_is_reported_and_the_invoice_still_lands(async_client, db_session, books):
    """The operator's stated rule: apply what is paid, report the rest. A
    retainer missing from the report entirely would read as "there was no
    deposit", which is what makes someone bill it twice."""
    books["retainer"] = {**RETAINER, "status": "sent", "payments": []}
    project_id = await _project(db_session)

    response = await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    assert response.status_code == 200
    assert response.json()["retainers"] == [{"number": "RET-00269", "total": 1000.0, "applied": 0.0}]
    assert "/invoices/inv-1/credits" not in _paths(books)


@pytest.mark.asyncio
async def test_a_retainer_already_drawn_is_not_spent_twice(async_client, db_session, books):
    """A retainer consumed by an earlier invoice still reads `status: paid`
    with a full total. Only its UNUSED amount is money."""
    books["retainer"] = {**RETAINER, "payments": [{"payment_id": "pay-1", "unused_payment_amount": 0}]}
    project_id = await _project(db_session)

    body = (await async_client.post(f"/api/v1/aito/{project_id}/invoice")).json()

    assert "/invoices/inv-1/credits" not in _paths(books)
    assert body["retainers"][0]["applied"] == 0.0


@pytest.mark.asyncio
async def test_the_creation_is_recorded_on_the_timeline(async_client, db_session, books):
    project_id = await _project(db_session)

    await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    kinds = (await db_session.execute(select(AitoEvent.kind, AitoEvent.detail))).all()
    created = [row for row in kinds if row[0] == "invoice.created"]
    assert len(created) == 1
    assert created[0][1]["invoice_number"] == "FA-26-4100"
    assert created[0][1]["retainers_applied"] == 1000.0


@pytest.mark.asyncio
async def test_the_project_is_marked_invoiced_at_once(async_client, db_session, books):
    """The hourly sweep would set this eventually, but the button's own
    visibility rule and the Invoice card's fetch gate both read it NOW —
    without this the panel keeps offering to bill a job it just billed, and
    reopening it hides the card for a real invoice."""
    project_id = await _project(db_session)

    await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    board = (await async_client.get("/api/v1/aito/")).json()
    assert [p["quote_invoiced"] for p in board if p["id"] == project_id] == [True]


@pytest.mark.asyncio
async def test_the_response_carries_the_balance_after_the_deposit_landed(async_client, db_session, books):
    """The create response still says 2500 owed; only the re-read knows the
    retainer has been applied. The card must show the re-read."""
    project_id = await _project(db_session)

    body = (await async_client.post(f"/api/v1/aito/{project_id}/invoice")).json()

    assert body["balance"] == 1500.0
    assert body["number"] == "FA-26-4100"
    assert body["url"].endswith("/invoices/inv-1")


# --- failure ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_zoho_being_down_creates_nothing_and_records_nothing(async_client, db_session, books):
    books["fail"] = "/estimates/"
    project_id = await _project(db_session)

    response = await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    assert response.status_code == 502
    assert "POST" not in [c["method"] for c in books["calls"]]
    assert (await db_session.execute(select(AitoEvent.kind))).scalars().all() == []


@pytest.mark.asyncio
async def test_a_failed_retainer_application_still_returns_the_real_invoice(async_client, db_session, books):
    """Once the invoice exists, a 500 would invite a retry that raises a
    SECOND one. So the deposit failing is reported, not raised."""
    books["fail"] = "/invoices/inv-1/credits"
    project_id = await _project(db_session)

    response = await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    assert response.status_code == 200
    assert response.json()["retainers"] == [{"number": "RET-00269", "total": 1000.0, "applied": 0.0}]


# --- preview ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_preview_says_what_will_be_applied_without_creating_anything(async_client, db_session, books):
    project_id = await _project(db_session)

    body = (await async_client.get(f"/api/v1/aito/{project_id}/invoice-preview")).json()

    assert body["quote_number"] == "DEV26-2493"
    assert body["total"] == 2500.0
    assert body["line_count"] == 2
    assert body["retainers"] == [
        {"id": "ret-1", "number": "RET-00269", "status": "paid", "total": 1000.0, "applicable": 1000.0}
    ]
    assert body["projected_balance"] == 1500.0
    assert "POST" not in [c["method"] for c in books["calls"]]


@pytest.mark.asyncio
async def test_the_preview_refuses_where_the_create_would(async_client, db_session, books):
    """A dialog that opens on a project the create will refuse makes the
    operator read a full confirmation and then be told no."""
    project_id = await _project(db_session, board_column="print")

    assert (await async_client.get(f"/api/v1/aito/{project_id}/invoice-preview")).status_code == 409
