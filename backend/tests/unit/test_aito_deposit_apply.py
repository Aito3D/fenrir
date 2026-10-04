"""Operator-driven deposit → invoice application (the invoice row's button)."""

import pytest
from sqlalchemy import select

from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.services.aito_search import document_numbers_of
from backend.app.services.zoho import ZohoAmbiguous, ZohoRateLimited, ZohoUnreachable, ZohoUpstreamError, zoho_service


async def _project(db, **fields) -> AitoProject:
    base = {
        "description": "x",
        "board_column": "finish",
        "position": 0,
        "status": "active",
        "client_id": "z1",
        "quote_id": "EST1",
        "quote_number": "DEV26-1",
        "quote_invoiced": True,
    }
    base.update(fields)
    row = AitoProject(**base)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


def _invoice(balance: float) -> dict:
    return {
        "id": "INV1",
        "number": "FA-1",
        "date": "2026-10-01",
        "due_date": "2026-10-31",
        "total": 14000.0,
        "balance": balance,
        "currency_code": "XPF",
        "status": "draft" if balance else "paid",
    }


class _Books:
    def __init__(self, monkeypatch, *, balance=14000.0, payments=None, linked=("RET1",), fresh_balance=7000.0):
        self.applied: list[tuple[str, list[dict]]] = []

        async def get_estimate(db, estimate_id):
            return {
                "estimate_id": "EST1",
                "customer_id": "z1",
                "retainerinvoices": [
                    {"retainerinvoice_id": r, "retainerinvoice_number": f"RET-{r}", "status": "paid", "total": 7000.0}
                    for r in linked
                ],
            }

        async def list_customer_payments(db, customer_id):
            return list(
                payments
                if payments is not None
                else [
                    {
                        "payment_id": "P1",
                        "payment_number": "1",
                        "retainerinvoice_id": "RET1",
                        "amount": 7000.0,
                        "unused_amount": 7000.0,
                        "date": "2026-09-01",
                    }
                ]
            )

        async def list_customer_retainers(db, customer_id):
            return [
                {"retainerinvoice_id": "RET1", "retainerinvoice_number": "RET-RET1", "reference_number": ""},
                {"retainerinvoice_id": "RET9", "retainerinvoice_number": "RET-RET9", "reference_number": ""},
            ]

        async def list_project_invoices(db, estimate_id, customer_id):
            return [_invoice(balance)]

        async def apply_invoice_credits(db, invoice_id, invoice_payments):
            self.applied.append((invoice_id, invoice_payments))

        async def get_invoice(db, invoice_id):
            return _invoice(fresh_balance)

        async def books_invoice_url(db, invoice_id):
            return "https://books/INV1"

        for name, fn in {
            "get_estimate": get_estimate,
            "list_customer_payments": list_customer_payments,
            "list_customer_retainers": list_customer_retainers,
            "list_project_invoices": list_project_invoices,
            "apply_invoice_credits": apply_invoice_credits,
            "get_invoice": get_invoice,
            "books_invoice_url": books_invoice_url,
        }.items():
            monkeypatch.setattr(zoho_service, name, fn)


@pytest.mark.asyncio
async def test_lists_the_quotes_own_deposits_and_the_open_invoice(async_client, db_session, monkeypatch):
    p = await _project(db_session)
    _Books(
        monkeypatch,
        payments=[
            {
                "payment_id": "P1",
                "payment_number": "1",
                "retainerinvoice_id": "RET1",
                "amount": 7000.0,
                "unused_amount": 7000.0,
                "date": "2026-09-01",
            },
            {
                "payment_id": "P9",
                "payment_number": "9",
                "retainerinvoice_id": "RET9",
                "amount": 500.0,
                "unused_amount": 500.0,
                "date": "2026-08-01",
            },
        ],
    )
    r = await async_client.get(f"/api/v1/aito/{p.id}/invoice-deposits")
    assert r.status_code == 200
    body = r.json()
    assert body["invoice"] == {"id": "INV1", "number": "FA-1", "balance": 14000.0, "currency_code": "XPF"}
    assert [d["id"] for d in body["deposits"]] == ["RET1"]  # RET9 is another job's
    assert body["deposits"][0]["applicable"] == 7000.0


@pytest.mark.asyncio
async def test_uninvoiced_card_has_nothing(async_client, db_session, monkeypatch):
    p = await _project(db_session, quote_invoiced=False)
    r = await async_client.get(f"/api/v1/aito/{p.id}/invoice-deposits")
    assert r.json() == {"invoice": None, "deposits": []}


@pytest.mark.asyncio
async def test_applies_the_chosen_amount_and_records_it(async_client, db_session, monkeypatch):
    p = await _project(db_session)
    books = _Books(monkeypatch)
    r = await async_client.post(
        f"/api/v1/aito/{p.id}/invoice-deposits/apply",
        json={"invoice_id": "INV1", "retainer_id": "RET1", "amount": 5000},
    )
    assert r.status_code == 200, r.text
    assert books.applied == [("INV1", [{"payment_id": "P1", "amount_applied": 5000.0}])]
    assert r.json()["balance"] == 7000.0
    events = (
        (
            await db_session.execute(
                select(AitoEvent).where(AitoEvent.project_id == p.id, AitoEvent.kind == "invoice.deposit_applied")
            )
        )
        .scalars()
        .all()
    )
    assert events[0].detail == {
        "retainer_number": "RET-RET1",
        "invoice_number": "FA-1",
        "amount": 5000.0,
        "source": "manual",
    }
    await db_session.refresh(p)
    assert p.invoice_balance == 7000.0
    assert document_numbers_of(p) == ["FA-1"]


@pytest.mark.asyncio
async def test_amount_above_what_books_now_allows_is_refused(async_client, db_session, monkeypatch):
    p = await _project(db_session)
    books = _Books(monkeypatch, balance=3000.0)  # invoice shrank since the modal opened
    r = await async_client.post(
        f"/api/v1/aito/{p.id}/invoice-deposits/apply",
        json={"invoice_id": "INV1", "retainer_id": "RET1", "amount": 5000},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "amount_too_high"
    assert books.applied == []


@pytest.mark.asyncio
async def test_retainer_of_another_job_is_404(async_client, db_session, monkeypatch):
    p = await _project(db_session)
    books = _Books(
        monkeypatch,
        payments=[
            {
                "payment_id": "P1",
                "payment_number": "1",
                "retainerinvoice_id": "RET1",
                "amount": 7000.0,
                "unused_amount": 7000.0,
                "date": "2026-09-01",
            },
            {
                "payment_id": "P9",
                "payment_number": "9",
                "retainerinvoice_id": "RET9",
                "amount": 500.0,
                "unused_amount": 500.0,
                "date": "2026-08-01",
            },
        ],
    )
    r = await async_client.post(
        f"/api/v1/aito/{p.id}/invoice-deposits/apply",
        json={"invoice_id": "INV1", "retainer_id": "RET9", "amount": 100},
    )
    assert r.status_code == 404
    assert books.applied == []


@pytest.mark.asyncio
async def test_stale_invoice_id_is_404(async_client, db_session, monkeypatch):
    p = await _project(db_session)
    _Books(monkeypatch)
    r = await async_client.post(
        f"/api/v1/aito/{p.id}/invoice-deposits/apply",
        json={"invoice_id": "INV-OLD", "retainer_id": "RET1", "amount": 100},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_zero_amount_is_422(async_client, db_session, monkeypatch):
    p = await _project(db_session)
    r = await async_client.post(
        f"/api/v1/aito/{p.id}/invoice-deposits/apply",
        json={"invoice_id": "INV1", "retainer_id": "RET1", "amount": 0},
    )
    assert r.status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize("exc", [ZohoUpstreamError("boom"), ZohoRateLimited("slow down")])
async def test_reread_failure_after_apply_still_succeeds_and_keeps_the_event(
    async_client, db_session, monkeypatch, exc
):
    p = await _project(db_session)
    pid = p.id
    books = _Books(monkeypatch)

    async def failing(db, invoice_id):
        raise exc

    monkeypatch.setattr(zoho_service, "get_invoice", failing)
    monkeypatch.setattr(zoho_service, "books_invoice_url", failing)
    r = await async_client.post(
        f"/api/v1/aito/{p.id}/invoice-deposits/apply",
        json={"invoice_id": "INV1", "retainer_id": "RET1", "amount": 5000},
    )
    assert r.status_code == 200, r.text
    assert books.applied == [("INV1", [{"payment_id": "P1", "amount_applied": 5000.0}])]
    assert r.json()["balance"] == 9000.0
    assert r.json()["url"] == ""
    db_session.expire_all()
    events = (
        (
            await db_session.execute(
                select(AitoEvent).where(AitoEvent.project_id == pid, AitoEvent.kind == "invoice.deposit_applied")
            )
        )
        .scalars()
        .all()
    )
    assert len(events) == 1
    await db_session.refresh(p)
    assert p.invoice_balance == 9000.0


@pytest.mark.asyncio
async def test_failure_in_apply_is_502_and_records_nothing(async_client, db_session, monkeypatch):
    p = await _project(db_session)
    _Books(monkeypatch)

    async def failing(db, invoice_id, invoice_payments):
        raise ZohoUpstreamError("boom")

    monkeypatch.setattr(zoho_service, "apply_invoice_credits", failing)
    r = await async_client.post(
        f"/api/v1/aito/{p.id}/invoice-deposits/apply",
        json={"invoice_id": "INV1", "retainer_id": "RET1", "amount": 5000},
    )
    assert r.status_code == 502
    db_session.expire_all()
    events = (
        (await db_session.execute(select(AitoEvent).where(AitoEvent.kind == "invoice.deposit_applied"))).scalars().all()
    )
    assert events == []


@pytest.mark.asyncio
@pytest.mark.parametrize("exc", [ZohoUnreachable("read timeout"), ZohoAmbiguous("HTTP 504")])
async def test_unknown_outcome_records_the_event_and_says_check_first(async_client, db_session, monkeypatch, exc):
    """A timeout or gateway 5xx can land after Books applied the deposit: the
    attempt is on record and the operator is told to look before retrying."""
    p = await _project(db_session)
    pid = p.id
    _Books(monkeypatch)

    async def unknown(db, invoice_id, invoice_payments):
        raise exc

    monkeypatch.setattr(zoho_service, "apply_invoice_credits", unknown)
    r = await async_client.post(
        f"/api/v1/aito/{pid}/invoice-deposits/apply",
        json={"invoice_id": "INV1", "retainer_id": "RET1", "amount": 5000},
    )
    assert r.status_code == 502
    assert r.json()["detail"] == {
        "code": "outcome_unknown",
        "message": "The deposit may have been applied; check the invoice before retrying.",
    }
    db_session.expire_all()
    events = (
        (
            await db_session.execute(
                select(AitoEvent).where(AitoEvent.project_id == pid, AitoEvent.kind == "invoice.deposit_applied")
            )
        )
        .scalars()
        .all()
    )
    assert len(events) == 1
    assert events[0].detail["outcome"] == "unknown"
    assert events[0].detail["amount"] == 5000.0


@pytest.mark.asyncio
async def test_rate_limited_apply_is_429_and_arms_the_throttle(async_client, db_session, monkeypatch):
    from backend.app.services import aito_quote_sync

    p = await _project(db_session)
    _Books(monkeypatch)
    armed: list = []
    monkeypatch.setattr(aito_quote_sync, "_arm_rate_limit_throttle", lambda e: armed.append(e))

    async def limited(db, invoice_id, invoice_payments):
        raise ZohoRateLimited("slow down", retry_after=30.0, code=429)

    monkeypatch.setattr(zoho_service, "apply_invoice_credits", limited)
    r = await async_client.post(
        f"/api/v1/aito/{p.id}/invoice-deposits/apply",
        json={"invoice_id": "INV1", "retainer_id": "RET1", "amount": 5000},
    )
    assert r.status_code == 429
    assert len(armed) == 1


@pytest.mark.asyncio
async def test_rate_limited_deposit_lookup_is_429_and_arms_the_throttle(async_client, db_session, monkeypatch):
    from backend.app.services import aito_quote_sync

    p = await _project(db_session)
    _Books(monkeypatch)
    armed: list = []
    monkeypatch.setattr(aito_quote_sync, "_arm_rate_limit_throttle", lambda e: armed.append(e))

    async def limited(db, estimate_id, customer_id):
        raise ZohoRateLimited("slow down", retry_after=30.0, code=429)

    monkeypatch.setattr(zoho_service, "list_project_invoices", limited)
    r = await async_client.get(f"/api/v1/aito/{p.id}/invoice-deposits")
    assert r.status_code == 429
    assert len(armed) == 1


@pytest.mark.asyncio
async def test_sub_cent_amount_is_422(async_client, db_session, monkeypatch):
    p = await _project(db_session)
    books = _Books(monkeypatch)
    r = await async_client.post(
        f"/api/v1/aito/{p.id}/invoice-deposits/apply",
        json={"invoice_id": "INV1", "retainer_id": "RET1", "amount": 0.004},
    )
    assert r.status_code == 422
    assert books.applied == []


@pytest.mark.asyncio
async def test_nothing_left_to_apply_is_409_without_a_books_call(async_client, db_session, monkeypatch):
    p = await _project(db_session)
    books = _Books(monkeypatch, balance=0.004)  # a sub-cent residue: nothing Books can take
    r = await async_client.post(
        f"/api/v1/aito/{p.id}/invoice-deposits/apply",
        json={"invoice_id": "INV1", "retainer_id": "RET1", "amount": 0.01},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "amount_too_high"
    assert r.json()["detail"]["cap"] == 0.0
    assert books.applied == []


@pytest.mark.asyncio
async def test_event_records_the_sum_actually_sent(async_client, db_session, monkeypatch):
    """Two advance payments behind one retainer: the event's amount is what
    went to Books, summed and rounded to the cent."""
    p = await _project(db_session)
    pid = p.id
    books = _Books(
        monkeypatch,
        payments=[
            {
                "payment_id": "P1",
                "payment_number": "1",
                "retainerinvoice_id": "RET1",
                "amount": 100.1,
                "unused_amount": 100.1,
                "date": "2026-09-01",
            },
            {
                "payment_id": "P2",
                "payment_number": "2",
                "retainerinvoice_id": "RET1",
                "amount": 200.2,
                "unused_amount": 200.2,
                "date": "2026-09-02",
            },
        ],
    )
    r = await async_client.post(
        f"/api/v1/aito/{pid}/invoice-deposits/apply",
        json={"invoice_id": "INV1", "retainer_id": "RET1", "amount": 300.3},
    )
    assert r.status_code == 200, r.text
    sent = sum(p_["amount_applied"] for _, ps in books.applied for p_ in ps)
    db_session.expire_all()
    events = (
        (
            await db_session.execute(
                select(AitoEvent).where(AitoEvent.project_id == pid, AitoEvent.kind == "invoice.deposit_applied")
            )
        )
        .scalars()
        .all()
    )
    assert events[0].detail["amount"] == round(sent, 2) == 300.3


@pytest.mark.asyncio
async def test_apply_broadcasts_the_board_change(async_client, db_session, monkeypatch):
    p = await _project(db_session)
    _Books(monkeypatch)
    seen: list = []

    async def fake_broadcast(action, project_id, actor):
        seen.append((action, project_id))

    monkeypatch.setattr("backend.app.api.routes.aito._broadcast_changed", fake_broadcast)
    r = await async_client.post(
        f"/api/v1/aito/{p.id}/invoice-deposits/apply",
        json={"invoice_id": "INV1", "retainer_id": "RET1", "amount": 5000},
    )
    assert r.status_code == 200
    assert seen == [("invoice", p.id)]
