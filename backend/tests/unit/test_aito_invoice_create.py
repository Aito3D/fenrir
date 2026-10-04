"""POST /aito/{id}/invoice — raising the bill for a finished job.

The guards carry most of the weight here. Everything this endpoint does is
irreversible from inside this app: a second call raises a second real
invoice, and applying a deposit twice spends money the client only paid
once. So the tests below are mostly about the calls that must NOT happen.
"""

import asyncio

import pytest
from sqlalchemy import select

from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.services.aito_invoice_create import build_line_items
from backend.app.services.zoho import ZohoRateLimited, ZohoUpstreamError, zoho_service

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

# What `GET /customerpayments?customer_id=z1` answers: the customer's
# advances, each with what is still unspent. A retainer's payment carries
# the retainer's id; a plain advance carries none. This — not the estimate's
# own retainer list — is where the deposits to apply come from, because a
# retainer raised by hand in Books references no estimate at all.
PAYMENTS = [
    {
        "payment_id": "pay-1",
        "payment_number": "4579",
        "amount": 1000.0,
        "unused_amount": 1000.0,
        "retainerinvoice_id": "ret-1",
        "date": "2026-09-10",
    }
]

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

# What `GET /invoices/inv-1` answers once the deposit has been applied: the
# state CREATED predates. Books recomputes both figures when a payment lands,
# and the card is supposed to show these, not the ones it was handed at
# creation time.
DETAIL = {
    "invoice_id": "inv-1",
    "invoice_number": "FA-26-4100",
    "date": "2026-09-12",
    "due_date": "2026-09-12",
    "total": 2500.0,
    "balance": 1500.0,
    "currency_code": "XPF",
    "status": "partially_paid",
    "estimate_id": "EST-9",
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
        "payments": [dict(p) for p in PAYMENTS],
        "created": dict(CREATED),
        "detail": dict(DETAIL),  # what GET /invoices/{id} answers
        "listed": [],  # what GET /invoices answers; empty = not yet invoiced
        # Books silently drops an unknown estimate field on create (it did,
        # on FA-26-4331). Flip this to model a create whose link did not
        # stick: the invoice exists, the estimate filter never finds it.
        "link_sticks": True,
        "fail": None,  # a path prefix that should raise instead
    }

    async def request(db, method, path, *, params=None, json=None):
        state["calls"].append({"method": method, "path": path, "params": params or {}, "json": json})
        if state["fail"] and path.startswith(state["fail"]):
            raise ZohoUpstreamError("Zoho is down")
        if path == "/invoices" and method == "GET":
            return {"invoices": [dict(i) for i in state["listed"]]}
        if path == "/invoices" and method == "POST":
            created = dict(state["created"])
            if state["link_sticks"]:
                state["listed"] = [dict(LISTED)]
                # Books echoes the link it made — the signal the route reads
                # to decide whether the invoice needs repairing.
                created["estimate_id"] = "EST-9"
            return {"invoice": created}
        if path.startswith("/invoices/") and method == "PUT":
            linked = (json or {}).get("invoiced_estimate_id") or ""
            state["detail"] = {**state["detail"], "estimate_id": linked}
            if linked:
                state["listed"] = [dict(LISTED)]
            return {"invoice": dict(state["detail"])}
        if path.startswith("/invoices/") and path.endswith("/credits") and method == "POST":
            # Books spends the advance: its unused amount drops by what was
            # applied, which is what the customer's credit is re-read from.
            for entry in (json or {}).get("invoice_payments") or []:
                for payment in state["payments"]:
                    if payment["payment_id"] == entry["payment_id"]:
                        payment["unused_amount"] = payment["unused_amount"] - entry["amount_applied"]
            return {}
        if path.startswith("/invoices/") and method == "GET":
            return {"invoice": dict(state["detail"])}
        if path.startswith("/estimates/"):
            return {"estimate": dict(state["estimate"])}
        if path == "/customerpayments":
            return {"customerpayments": [dict(p) for p in state["payments"]]}
        if path == "/retainerinvoices":
            # The customer's retainers, summarised: how a payment's
            # `retainerinvoice_id` becomes the RET number the dialog shows.
            summary = {
                k: state["retainer"][k] for k in ("retainerinvoice_id", "retainerinvoice_number", "status", "total")
            }
            return {"retainerinvoices": [summary]}
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


# --- T-041: the local flag, and one create at a time ---------------------------


@pytest.mark.asyncio
async def test_a_card_already_flagged_invoiced_is_refused_without_asking_books(async_client, db_session, books):
    """`quote_invoiced` is what the button hides on and what the create
    itself writes the moment Books confirms. The server used to ignore it
    entirely and go ask Books, so the refusal cost a round trip it did not
    need — and rested on an invoice list that is empty whenever the estimate
    link did not stick."""
    project_id = await _project(db_session, quote_invoiced=True)

    response = await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    assert response.status_code == 409
    assert response.json()["detail"] == "This project already has an invoice in Zoho"
    assert books["calls"] == []


@pytest.mark.asyncio
async def test_the_preview_refuses_an_already_invoiced_card_too(async_client, db_session, books):
    """The flag check lives in the shared guard, not in the create alone: the
    dialog must not open on a card the create will refuse — the same rule
    that already applies to Finish, the quote id and a pending sync."""
    project_id = await _project(db_session, quote_invoiced=True)

    response = await async_client.get(f"/api/v1/aito/{project_id}/invoice-preview")

    assert response.status_code == 409
    assert books["calls"] == []


@pytest.mark.asyncio
async def test_an_invoice_whose_estimate_link_did_not_stick_still_blocks_a_second_one(async_client, db_session, books):
    """Production, FA-26-4331: Books raised the invoice and linked it to
    nothing, and the repair PUT can fail too. The estimate filter the
    duplicate guard reads then stays EMPTY, so before T-041 a second click
    billed the client again. The local flag is the guard that does not
    depend on the link."""
    books["link_sticks"] = False
    books["fail"] = "/invoices/inv-1"  # the repair PUT (and the re-read) fail
    project_id = await _project(db_session)

    first = await async_client.post(f"/api/v1/aito/{project_id}/invoice")
    assert first.status_code == 200, first.text
    assert books["listed"] == []  # nothing links the invoice to the quote

    second = await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    assert second.status_code == 409
    assert second.json()["detail"] == "This project already has an invoice in Zoho"
    assert len([c for c in books["calls"] if c["method"] == "POST" and c["path"] == "/invoices"]) == 1


@pytest.mark.asyncio
async def test_two_concurrent_creates_raise_exactly_one_invoice(async_client, db_session, books, monkeypatch):
    """Two operators on the same card, or one retry after a client-side
    timeout on a request that routinely runs 10s+. Both passed the Books
    duplicate read — it is a check-then-act with three more round trips
    inside the window — and both created a REAL invoice.

    Serialised now: the second waits, then re-reads the flag the first
    committed and answers the same 409 a sequential double-click gets."""
    original = zoho_service._request

    async def slow_create(db, method, path, *, params=None, json=None):
        if method == "POST" and path == "/invoices":
            # Long enough for the waiter to have reached (and passed) the
            # duplicate read if nothing were holding it back.
            await asyncio.sleep(0.05)
        return await original(db, method, path, params=params, json=json)

    monkeypatch.setattr(zoho_service, "_request", slow_create)
    project_id = await _project(db_session)
    url = f"/api/v1/aito/{project_id}/invoice"

    first, second = await asyncio.gather(async_client.post(url), async_client.post(url))

    assert sorted([first.status_code, second.status_code]) == [200, 409]
    assert len([c for c in books["calls"] if c["method"] == "POST" and c["path"] == "/invoices"]) == 1
    db_session.expire_all()
    project = await db_session.get(AitoProject, project_id)
    assert project.quote_invoiced is True


@pytest.mark.asyncio
async def test_an_edit_landing_while_the_create_waits_for_the_lock_is_refused(
    async_client, db_session, books, monkeypatch
):
    """T-100 (user-approved 2026-10-03): the push guard runs BEFORE the lock,
    and the lock waits out any other invoice in progress (10s+ of Books
    calls). An edit committed in that wait puts the card back to 'pending'
    with Books still holding the old lines; the create re-reads the card
    under the lock and now answers the sync-pending 503 instead of billing
    the pre-edit lines. Nothing reaches Books."""
    from sqlalchemy import update

    from backend.app.api.routes import aito as aito_routes

    project_id = await _project(db_session)
    # A fresh lock, bound to this test's event loop: the module's own one may
    # already be bound to an earlier test's loop by a contended acquire.
    lock = asyncio.Lock()
    monkeypatch.setattr(aito_routes, "_invoice_lock", lock)
    await lock.acquire()
    try:
        request = asyncio.ensure_future(async_client.post(f"/api/v1/aito/{project_id}/invoice"))
        for _ in range(500):
            if getattr(lock, "_waiters", None):
                break
            await asyncio.sleep(0.01)
        assert getattr(lock, "_waiters", None), "the create never reached the lock"
        await db_session.execute(
            update(AitoProject).where(AitoProject.id == project_id).values(quote_sync_state="pending")
        )
        await db_session.commit()
    finally:
        lock.release()
    response = await request

    assert response.status_code == 503, response.text
    assert response.json()["detail"]["code"] == "sync_pending"
    assert books["calls"] == []
    db_session.expire_all()
    project = await db_session.get(AitoProject, project_id)
    assert project.quote_invoiced is False


@pytest.mark.asyncio
async def test_a_deleted_project_is_a_404(async_client, db_session, books):
    project_id = await _project(db_session, status="deleted")

    assert (await async_client.post(f"/api/v1/aito/{project_id}/invoice")).status_code == 404


# --- the happy path -----------------------------------------------------------


@pytest.mark.asyncio
async def test_the_invoice_is_linked_to_the_estimate_and_carries_its_lines(async_client, db_session, books):
    """The link is the whole visibility story: `list_project_invoices` filters
    GET /invoices by the estimate and by nothing else, so an invoice raised
    without it exists in Books and is invisible to every Aito surface.

    And the field name is load-bearing. `invoiced_estimate_id` is the only
    estimate field in Books' create-an-invoice schema; `estimate_id` is a
    response/filter field, and a create body carrying it is accepted with a
    200 and the link silently dropped — which is exactly how FA-26-4331 was
    raised orphaned in production."""
    project_id = await _project(db_session)

    response = await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    assert response.status_code == 200
    posted = next(c["json"] for c in books["calls"] if c["method"] == "POST" and c["path"] == "/invoices")
    assert posted["invoiced_estimate_id"] == "EST-9"
    assert "estimate_id" not in posted
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
    books["payments"] = [{**PAYMENTS[0], "amount": 9000.0, "unused_amount": 9000.0}]
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
        if path == "/customerpayments":
            # Oldest first, as Books lists them: the split spends pay-1 first.
            return {
                "customerpayments": [
                    {"payment_id": "pay-1", "amount": 2000.0, "unused_amount": 2000.0, "retainerinvoice_id": "ret-1"},
                    {"payment_id": "pay-2", "amount": 2000.0, "unused_amount": 2000.0, "retainerinvoice_id": "ret-2"},
                ]
            }
        if path == "/retainerinvoices":
            return {
                "retainerinvoices": [
                    {
                        "retainerinvoice_id": "ret-1",
                        "retainerinvoice_number": "RET-1",
                        "status": "paid",
                        "total": 2000.0,
                    },
                    {
                        "retainerinvoice_id": "ret-2",
                        "retainerinvoice_number": "RET-2",
                        "status": "paid",
                        "total": 2000.0,
                    },
                ]
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
    books["estimate"] = {
        **ESTIMATE,
        "retainerinvoices": [
            {"retainerinvoice_id": "ret-1", "retainerinvoice_number": "RET-00269", "status": "sent", "total": 1000.0}
        ],
    }
    books["payments"] = []  # nothing received, so nothing on account
    project_id = await _project(db_session)

    response = await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    assert response.status_code == 200
    assert response.json()["retainers"] == [{"number": "RET-00269", "total": 1000.0, "applied": 0.0}]
    assert "/invoices/inv-1/credits" not in _paths(books)


@pytest.mark.asyncio
async def test_a_retainer_already_drawn_is_not_spent_twice(async_client, db_session, books):
    """A retainer consumed by an earlier invoice still reads `status: paid`
    with a full total. Only its UNUSED amount is money."""
    books["payments"] = [{**PAYMENTS[0], "unused_amount": 0.0, "invoice_numbers": "FA-26-3999"}]
    project_id = await _project(db_session)

    body = (await async_client.post(f"/api/v1/aito/{project_id}/invoice")).json()

    assert "/invoices/inv-1/credits" not in _paths(books)
    assert body["retainers"] == [{"number": "RET-00269", "total": 1000.0, "applied": 0.0}]


@pytest.mark.asyncio
async def test_a_deposit_raised_by_hand_with_no_quote_link_is_applied_too(async_client, db_session, books):
    """A retainer invoice is a CUSTOMER document in Books; one raised by hand
    references no estimate, so it never appears in the estimate's own
    retainer list. The customer's payments are where every deposit shows,
    linked or not — and an unlinked one is named by its payment number,
    since it has no RET number to show."""
    books["payments"] = [
        dict(PAYMENTS[0]),
        {
            "payment_id": "pay-2",
            "payment_number": "4580",
            "amount": 500.0,
            "unused_amount": 500.0,
            "retainerinvoice_id": "",
            "date": "2026-09-12",
        },
    ]
    project_id = await _project(db_session)

    preview = (await async_client.get(f"/api/v1/aito/{project_id}/invoice-preview")).json()
    body = (await async_client.post(f"/api/v1/aito/{project_id}/invoice")).json()

    assert [(r["number"], r["applicable"]) for r in preview["retainers"]] == [("RET-00269", 1000.0), ("#4580", 500.0)]
    credits = [c["json"]["invoice_payments"] for c in books["calls"] if c["path"] == "/invoices/inv-1/credits"]
    assert credits == [
        [{"payment_id": "pay-1", "amount_applied": 1000.0}],
        [{"payment_id": "pay-2", "amount_applied": 500.0}],
    ]
    assert body["retainers"] == [
        {"number": "RET-00269", "total": 1000.0, "applied": 1000.0},
        {"number": "#4580", "total": 500.0, "applied": 500.0},
    ]


@pytest.mark.asyncio
async def test_no_retainer_detail_is_read_any_more(async_client, db_session, books):
    """The payments list carries the unused amounts itself; the per-retainer
    detail read that used to fetch them is one Books call per deposit that
    no longer needs spending."""
    project_id = await _project(db_session)

    await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    assert not [p for p in _paths(books) if p.startswith("/retainerinvoices/")]
    assert "/customerpayments" in _paths(books)


@pytest.mark.asyncio
async def test_the_deposit_available_is_refreshed_the_moment_it_is_spent(async_client, db_session, books):
    """The panel's "deposit available" must not keep showing money that this
    very invoice just consumed until the sweep's next tick."""
    project_id = await _project(db_session, customer_credit_total=1000.0)

    await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    db_session.expire_all()
    project = await db_session.get(AitoProject, project_id)
    assert project.customer_credit_total == 0.0


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
    """The create response still says 2500 owed and "draft"; only the re-read
    knows the retainer has been applied. The card must show the re-read."""
    project_id = await _project(db_session)

    body = (await async_client.post(f"/api/v1/aito/{project_id}/invoice")).json()

    assert body["balance"] == 1500.0
    assert body["status"] == "partially_paid"
    assert body["number"] == "FA-26-4100"
    assert body["url"].endswith("/invoices/inv-1")


@pytest.mark.asyncio
async def test_the_card_shows_books_figures_even_when_the_estimate_link_fails(async_client, db_session, books):
    """Production, FA-26-4331: the invoice was raised, the deposit was applied
    in full, and Books linked it to nothing. The re-read used to go looking
    through the estimate filter, find nothing, and fall back to the create
    response — so the card reported a DRAFT owing the full total for an
    invoice Books itself called paid and settled.

    Reading the invoice by its own id is what makes the figures right whether
    or not the link stuck. The missing link is still a real defect — it is
    what the warning log is for — but it must not also corrupt the money on
    screen."""
    books["link_sticks"] = False
    books["detail"] = {**books["detail"], "balance": 0.0, "status": "paid", "estimate_id": ""}
    project_id = await _project(db_session)

    body = (await async_client.post(f"/api/v1/aito/{project_id}/invoice")).json()

    assert (body["balance"], body["status"]) == (0.0, "paid")
    assert body["total"] == 2500.0
    # Still one invoice on the card, not zero: the count degrades to the
    # invoice in hand rather than reporting an invoice that does not exist.
    assert body["invoice_count"] == 1


@pytest.mark.asyncio
async def test_an_unlinked_invoice_is_repaired_rather_than_left_orphaned(async_client, db_session, books):
    """An invoice Books did not link is invisible to `list_project_invoices`,
    and that list IS the duplicate-invoice guard — so an orphan is not a
    cosmetic problem, it is the gap a double-click bills a client twice
    through. One PUT puts the link back."""
    books["link_sticks"] = False
    project_id = await _project(db_session)

    await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    put = next(c for c in books["calls"] if c["method"] == "PUT" and c["path"] == "/invoices/inv-1")
    assert put["json"] == {"invoiced_estimate_id": "EST-9"}
    # And the repair took: the estimate filter now finds the invoice, which
    # is what the card, the guard and the balance sweep all read.
    assert [i["invoice_id"] for i in books["listed"]] == ["inv-1"]


@pytest.mark.asyncio
async def test_a_linked_invoice_is_not_touched_again(async_client, db_session, books):
    """The repair fires on a missing link, not on every create: a PUT against
    a fresh invoice is a write nobody asked for."""
    project_id = await _project(db_session)

    await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    assert [c["path"] for c in books["calls"] if c["method"] == "PUT"] == []


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


def _fail_second_customerpayments_read(books, error):
    """The plan reads `/customerpayments` once to work out what to apply;
    the post-create refresh reads it again to report what is left. Only the
    SECOND read is the one under test — the first must still succeed, or the
    invoice would never be created at all."""
    calls = {"customerpayments": 0}
    real = books["calls"]

    async def request(db, method, path, *, params=None, json=None):
        if path == "/customerpayments":
            calls["customerpayments"] += 1
            if calls["customerpayments"] >= 2:
                real.append({"method": method, "path": path, "params": params or {}, "json": json})
                raise error
        return await books["_original_request"](db, method, path, params=params, json=json)

    return request


@pytest.mark.asyncio
async def test_a_rate_limited_credit_refresh_still_returns_the_real_invoice(
    async_client, db_session, books, monkeypatch, caplog
):
    """Books answering 429 on the post-create `/customerpayments` re-read —
    plausibly BECAUSE that call landed right after the three spent creating
    the invoice and applying its retainers — must not turn an invoice that
    already exists in Books into a 500. The stored "deposit available"
    figure is left exactly as it was; the hourly sweep corrects it."""
    project_id = await _project(db_session, customer_credit_total=1000.0)
    books["_original_request"] = zoho_service._request
    monkeypatch.setattr(
        zoho_service,
        "_request",
        _fail_second_customerpayments_read(books, ZohoRateLimited("Zoho Books error (HTTP 429)")),
    )

    with caplog.at_level("WARNING"):
        response = await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    assert response.status_code == 200
    body = response.json()
    assert body["number"] == "FA-26-4100"
    assert body["id"] == "inv-1"
    assert "could not refresh customer" in caplog.text

    kinds = (await db_session.execute(select(AitoEvent.kind))).scalars().all()
    assert kinds.count("invoice.created") == 1

    db_session.expire_all()
    project = await db_session.get(AitoProject, project_id)
    assert project.quote_invoiced is True
    # Unchanged: the stale pre-invoice figure, not the fresh one the failed
    # read would have supplied.
    assert project.customer_credit_total == 1000.0


@pytest.mark.asyncio
async def test_a_5xx_credit_refresh_still_returns_the_real_invoice(
    async_client, db_session, books, monkeypatch, caplog
):
    """Same contract as the 429 case for a plain Books outage on the same
    read — the invoice above is already real either way. A non-429
    `ZohoUpstreamError` never actually reaches this route: `read_customer_credit`
    already swallows it and returns None with its own warning (that is the
    pre-existing best-effort contract this fix does not change); this test
    guards that path stays working alongside the new 429 one."""
    project_id = await _project(db_session, customer_credit_total=1000.0)
    books["_original_request"] = zoho_service._request
    monkeypatch.setattr(
        zoho_service,
        "_request",
        _fail_second_customerpayments_read(books, ZohoUpstreamError("Zoho Books error (HTTP 500)")),
    )

    with caplog.at_level("WARNING"):
        response = await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    assert response.status_code == 200
    body = response.json()
    assert body["number"] == "FA-26-4100"
    assert body["id"] == "inv-1"
    assert "could not read customer" in caplog.text

    kinds = (await db_session.execute(select(AitoEvent.kind))).scalars().all()
    assert kinds.count("invoice.created") == 1

    db_session.expire_all()
    project = await db_session.get(AitoProject, project_id)
    assert project.quote_invoiced is True
    assert project.customer_credit_total == 1000.0


@pytest.mark.asyncio
async def test_a_db_failure_after_the_real_invoice_still_returns_it(
    async_client, db_session, books, monkeypatch, caplog
):
    """The invoice IS raised in Books before local `record(...)`+`commit()`
    run; a failure there must not 500 past it — a retry would raise a
    SECOND real invoice. The route must still answer with the invoice Books
    actually created, log what happened, and leave the app able to keep
    working afterward.

    The failure is a GENUINE flush failure (a NOT NULL violation), not a
    monkeypatched `commit()` — mirroring test_aito_manual_payments.py's
    test_a_db_failure_after_the_books_write_keeps_the_guard_and_names_the_payment.
    Only a real one puts the session into the state the route's `rollback()`
    call is there to recover from."""

    async def bad_record(db, project_id, kind, **kw):
        db.add(AitoEvent(project_id=project_id, kind=None, actor_class="user"))  # kind is NOT NULL
        await db.flush()

    monkeypatch.setattr("backend.app.api.routes.aito.record", bad_record)
    project_id = await _project(db_session)

    with caplog.at_level("ERROR"):
        response = await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    assert response.status_code == 200
    body = response.json()
    assert body["number"] == "FA-26-4100"
    assert body["id"] == "inv-1"
    assert "WAS RAISED in Books" in caplog.text
    assert "FA-26-4100" in caplog.text

    # The write that failed was rolled back, so no timeline entry landed and
    # the local flag never flipped — Books has a real invoice this app does
    # not (yet) know about locally.
    assert (await db_session.execute(select(AitoEvent.kind))).scalars().all() == []
    board = (await async_client.get("/api/v1/aito/")).json()
    assert [p["quote_invoiced"] for p in board if p["id"] == project_id] == [False]

    # The session (and the app around it) recovered rather than staying
    # poisoned: a follow-up request works normally, and the duplicate guard
    # — which reads Books' own invoice list, not the local flag that never
    # got a chance to commit — still refuses a second invoice.
    second = await async_client.post(f"/api/v1/aito/{project_id}/invoice")
    assert second.status_code == 409


@pytest.mark.asyncio
async def test_a_failed_rollback_after_a_db_failure_still_returns_the_real_invoice(db_session, books, monkeypatch):
    """Belt and braces on the case above: if the rollback the route falls
    back to ALSO fails (e.g. the connection is already gone), that must not
    turn a real invoice into a 500 either — the `except Exception: pass`
    wrapped around it exists for exactly this.

    Called directly against `db_session`, bypassing the HTTP round trip
    (same technique as test_aito_active_quote_index_migration.py's direct
    `db=..., current_user=None` calls): the test client's dependency
    override commits on the way out, and a session left aborted by two
    failed writes in a row would fail THAT commit too — a property of the
    test harness's simplified `get_db`, not of this route, and not what
    this test is about."""
    from backend.app.api.routes import aito as aito_routes

    async def bad_record(db, project_id, kind, **kw):
        db.add(AitoEvent(project_id=project_id, kind=None, actor_class="user"))  # kind is NOT NULL
        await db.flush()

    async def broken_rollback():
        raise RuntimeError("connection already closed")

    project_id = await _project(db_session)
    monkeypatch.setattr("backend.app.api.routes.aito.record", bad_record)
    monkeypatch.setattr(db_session, "rollback", broken_rollback)

    body = await aito_routes.create_invoice(project_id=project_id, db=db_session, current_user=None)

    assert body.number == "FA-26-4100"
    assert body.id == "inv-1"


@pytest.mark.asyncio
async def test_a_failed_invoice_count_after_the_create_still_returns_the_created_invoice(
    async_client, db_session, books, monkeypatch, caplog
):
    """The count-only `list_project_invoices` read rides its own try: when it
    fails after the create, the card keeps Books' figures for the invoice
    itself, the count degrades to 1, and the "not listed under estimate"
    warning is logged (an empty list cannot contain the new invoice)."""
    real = zoho_service.list_project_invoices
    seen = {"n": 0}

    async def flaky(db, estimate_id, customer_id):
        seen["n"] += 1
        if seen["n"] > 1:  # the first call is the duplicate-invoice guard
            raise ZohoUpstreamError("Zoho is down")
        return await real(db, estimate_id, customer_id)

    monkeypatch.setattr(zoho_service, "list_project_invoices", flaky)
    project_id = await _project(db_session)

    with caplog.at_level("WARNING"):
        response = await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    assert seen["n"] > 1
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "inv-1"
    assert body["number"] == "FA-26-4100"
    assert body["invoice_count"] == 1
    assert "is not listed under estimate" in caplog.text
    assert "FA-26-4100" in caplog.text


@pytest.mark.asyncio
async def test_a_failed_re_read_after_the_create_falls_back_to_the_create_response(
    async_client, db_session, books, monkeypatch, caplog
):
    async def down(db, invoice_id):
        raise ZohoUpstreamError("Zoho is down")

    monkeypatch.setattr(zoho_service, "get_invoice", down)
    project_id = await _project(db_session)

    with caplog.at_level("WARNING"):
        response = await async_client.post(f"/api/v1/aito/{project_id}/invoice")

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "inv-1"
    assert body["number"] == "FA-26-4100"
    assert body["total"] == 2500.0
    assert "invoice re-read failed" in caplog.text


@pytest.mark.asyncio
async def test_a_failed_rollback_after_a_failed_re_read_still_returns_the_created_invoice(
    db_session, books, monkeypatch
):
    from backend.app.api.routes import aito as aito_routes

    async def broken_get_invoice(db, invoice_id):
        raise ZohoUpstreamError("Zoho is down")

    async def broken_rollback():
        raise RuntimeError("connection already closed")

    project_id = await _project(db_session)
    monkeypatch.setattr(zoho_service, "get_invoice", broken_get_invoice)
    monkeypatch.setattr(db_session, "rollback", broken_rollback)

    body = await aito_routes.create_invoice(project_id=project_id, db=db_session, current_user=None)

    assert body.number == "FA-26-4100"
    assert body.id == "inv-1"


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
