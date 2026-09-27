"""T-061: an imported quote's figures come from Zoho Books, not the browser.

``create_project`` used to store the posted quote_number/quote_total/
quote_status/quote_date/quote_url verbatim, and the import wake minted a
Heimdall payment link from them — so an aito:create principal could forge the
amount and reference of a link whose payment accepts the quote. The create now
re-reads the estimate (``_with_books_quote_snapshot``) and takes those fields,
and the customer id, from Books; a Books it cannot read refuses the import.

Every test here opts out of the conftest pass-through that stands in for an
agreeing Books everywhere else."""

import asyncio
from datetime import date

import pytest

from backend.app.models.aito_project import AitoProject
from backend.app.services import aito_payment_links as links_svc, aito_quote_sync
from backend.app.services.zoho import (
    ZohoNotConfiguredError,
    ZohoNotFound,
    ZohoRateLimited,
    ZohoService,
    ZohoUpstreamError,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.real_books_quote_snapshot]

BOOKS_URL = "https://books.zoho.eu/app/999#/quotes/E1"
BOOKS_ESTIMATE = {
    "estimate_id": "E1",
    "estimate_number": "DEV26-0042",
    "date": "2026-09-20",
    "status": "sent",
    "total": 18000,
    "customer_id": "z1",
    "customer_name": "ACME",
    "line_items": [],
}


@pytest.fixture
def books(monkeypatch):
    """A Books that knows one estimate. ``calls`` records every read."""
    state = {"estimate": dict(BOOKS_ESTIMATE), "error": None, "calls": []}

    async def get_estimate(self, db, estimate_id):
        state["calls"].append(("get_estimate", estimate_id))
        if state["error"] is not None:
            raise state["error"]
        return dict(state["estimate"])

    async def books_app_url(self, db, estimate_id):
        state["calls"].append(("books_app_url", estimate_id))
        return f"https://books.zoho.eu/app/999#/quotes/{estimate_id}"

    monkeypatch.setattr(ZohoService, "get_estimate", get_estimate)
    monkeypatch.setattr(ZohoService, "books_app_url", books_app_url)
    return state


@pytest.fixture
def wake():
    aito_quote_sync._wake = asyncio.Event()
    aito_quote_sync._debounce_deadline = None
    return aito_quote_sync._wake


def _import_body(**overrides):
    body = {
        "description": "Tapis souple X4 bloc",
        "client_id": "z1",
        "client_name": "ACME",
        "quote_id": "E1",
        "quote_number": "DEV26-0042",
        "quote_date": "2026-09-20",
        "quote_total": 18000.0,
        "quote_url": BOOKS_URL,
        "quote_status": "sent",
    }
    body.update(overrides)
    return body


async def _board(async_client):
    return (await async_client.get("/api/v1/aito/")).json()


async def test_a_forged_snapshot_is_replaced_by_books_figures(async_client, db_session, books, wake):
    r = await async_client.post(
        "/api/v1/aito/",
        json=_import_body(
            client_id="z-someone-else",
            quote_number="FORGED-1",
            quote_total=1.0,
            quote_date="2020-01-01",
            quote_url="https://evil.example/pay",
            quote_status="draft",
        ),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["quote_number"] == "DEV26-0042"
    assert body["quote_total"] == 18000.0
    assert body["quote_date"] == "2026-09-20"
    assert body["quote_url"] == BOOKS_URL
    assert body["quote_status"] == "sent"
    assert body["client_id"] == "z1"
    # The operator's own fields are untouched.
    assert body["description"] == "Tapis souple X4 bloc"
    assert body["client_name"] == "ACME"
    assert wake.is_set()

    # The payment link the wake would mint is Books' reference and amount.
    project = await db_session.get(AitoProject, body["id"])
    wanted = links_svc.wanted_link(project, pct=50, validity_days=30, today=date(2026, 9, 26))
    assert wanted is not None
    assert wanted.reference == "DEV26-0042"
    assert wanted.amount == links_svc.required_amount(18000.0, 50)


async def test_an_honest_import_stores_what_it_posted_after_one_estimate_read(async_client, books, wake):
    r = await async_client.post("/api/v1/aito/", json=_import_body())
    assert r.status_code == 201, r.text
    body = r.json()
    assert (body["quote_number"], body["quote_total"], body["quote_date"], body["quote_url"], body["quote_status"]) == (
        "DEV26-0042",
        18000.0,
        "2026-09-20",
        BOOKS_URL,
        "sent",
    )
    assert body["client_id"] == "z1"
    assert [c for c in books["calls"] if c[0] == "get_estimate"] == [("get_estimate", "E1")]
    assert wake.is_set()


async def test_a_hand_made_card_never_reads_books(async_client, books):
    r = await async_client.post(
        "/api/v1/aito/",
        json={"description": "Support", "client_id": "z1", "client_name": "ACME", "client_phone": "+689 87 00 00 01"},
    )
    assert r.status_code == 201, r.text
    assert books["calls"] == []


@pytest.mark.parametrize(
    ("error", "status"),
    [
        (ZohoUpstreamError("Books is down"), 502),
        (ZohoRateLimited("slow down"), 502),
        (ZohoNotFound("no such estimate"), 404),
        (ZohoNotConfiguredError("missing settings"), 503),
    ],
)
async def test_an_unreadable_quote_refuses_the_import(async_client, books, wake, error, status):
    books["error"] = error
    r = await async_client.post("/api/v1/aito/", json=_import_body())
    assert r.status_code == status
    assert await _board(async_client) == []
    assert not wake.is_set()


async def test_books_status_drives_the_decided_status_permission_gate(async_client, books):
    """A create-only caller posting 'sent' for a quote Books says is accepted
    is refused like one posting 'accepted' — the gate reads Books' status."""
    from backend.app.main import app
    from backend.app.models.group import Group
    from backend.app.models.user import User

    books["estimate"]["status"] = "accepted"
    route = next(r for r in app.routes if getattr(r, "name", "") == "create_project")
    dep = next(d.call for d in route.dependant.dependencies if d.name == "current_user")
    app.dependency_overrides[dep] = lambda: User(
        id=1, username="paul", groups=[Group(name="t", permissions=["aito:create"])]
    )
    try:
        r = await async_client.post("/api/v1/aito/", json=_import_body(quote_status="sent"))
    finally:
        app.dependency_overrides.pop(dep, None)
    assert r.status_code == 403
    assert await _board(async_client) == []


async def test_an_unknown_books_status_degrades_like_a_posted_one(async_client, books):
    books["estimate"]["status"] = "invoiced"
    r = await async_client.post("/api/v1/aito/", json=_import_body())
    assert r.status_code == 201, r.text
    assert r.json()["quote_status"] is None


async def test_an_estimate_without_a_customer_keeps_the_posted_client(async_client, books):
    books["estimate"]["customer_id"] = ""
    r = await async_client.post("/api/v1/aito/", json=_import_body(client_id="z7"))
    assert r.status_code == 201, r.text
    assert r.json()["client_id"] == "z7"


async def test_books_figures_that_fail_the_schema_are_a_422_and_store_nothing(async_client, books):
    books["estimate"]["estimate_number"] = "X" * 51
    r = await async_client.post("/api/v1/aito/", json=_import_body())
    assert r.status_code == 422
    assert await _board(async_client) == []


@pytest.mark.parametrize(
    "error",
    [ZohoUpstreamError("Books is down"), ZohoNotConfiguredError("missing settings"), None],
)
async def test_a_duplicate_import_is_a_409_before_any_books_call(async_client, db_session, books, wake, error):
    """T-070: the already-has-a-card check keys on quote_id (never overwritten
    by Books), so it runs before the re-read — a duplicate import is a 409 with
    Books down, unconfigured, or up, and Books is never asked."""
    db_session.add(AitoProject(description="Existing", client_name="ACME", quote_id="E1", board_column="devis"))
    await db_session.commit()
    books["error"] = error
    r = await async_client.post("/api/v1/aito/", json=_import_body())
    assert r.status_code == 409, r.text
    assert "already" in r.json()["detail"]
    assert books["calls"] == []
    assert [p["description"] for p in await _board(async_client)] == ["Existing"]
    assert not wake.is_set()
