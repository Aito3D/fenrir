"""A card's Books tax: the rate list, the price rescale, the customer account default, and the quote push."""

import pytest
from sqlalchemy import select

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.services import aito_tax
from backend.app.services.aito_quote_export import Catalogue
from backend.app.services.aito_quote_sync import _with_card_tax
from backend.app.services.zoho import zoho_service

TAXES = [
    {"tax_id": "T0", "tax_name": "Franchise", "tax_percentage": 0, "status": "Active"},
    {"tax_id": "T13", "tax_name": "TVA collectée sur Services", "tax_percentage": 13, "status": "Active"},
    {"tax_id": "T1", "tax_name": "TVA collectée 1%", "tax_percentage": 1, "status": "Active"},
    {"tax_id": "D13", "tax_name": "TVA  déductible sur services", "tax_percentage": 13, "status": "Active"},
    {"tax_id": "OLD", "tax_name": "Ancienne", "tax_percentage": 10, "status": "Inactive"},
]
CATALOGUE = Catalogue(
    scan_item_id="S", modelisation_item_id="M", impression_item_id="I", usinage_item_id="U", tax_id="T13",
    maindoeuvre_item_id="L",
)  # fmt: skip


@pytest.fixture
def books(monkeypatch):
    async def list_taxes(db):
        return TAXES

    async def get_catalogue(db):
        return CATALOGUE

    monkeypatch.setattr(zoho_service, "list_taxes", list_taxes)
    monkeypatch.setattr(zoho_service, "get_catalogue", get_catalogue)


async def _card(async_client, db_session, *, client_id="c1", costs=((5000, 4500),), shipping=None, **body):
    r = await async_client.post(
        "/api/v1/aito/",
        json={
            "description": "Support DJI",
            "client_id": client_id,
            "client_name": "COJ",
            "client_phone": "+689-87123456",
            **body,
        },
    )
    assert r.status_code in (200, 201), r.text
    project_id = r.json()["id"]
    for modelisation, impression in costs:
        db_session.add(
            AitoTask(project_id=project_id, title="t", modelisation_cost=modelisation, impression_cost=impression)
        )
    if shipping is not None:
        project = await db_session.get(AitoProject, project_id)
        project.shipping_price = shipping
    await db_session.commit()
    return project_id


async def _costs(db_session, project_id):
    db_session.expire_all()
    rows = (await db_session.execute(select(AitoTask).where(AitoTask.project_id == project_id))).scalars().all()
    return [(t.modelisation_cost, t.impression_cost) for t in rows]


def test_rescale_keeps_the_price_before_tax():
    assert aito_tax.rescale(5000, 13, 0) == 4425  # 4424.78 before tax
    assert aito_tax.rescale(5000, 13, 1) == 4469
    assert aito_tax.rescale(4425, 0, 13) == 5000
    assert aito_tax.rescale(None, 13, 0) is None


@pytest.mark.asyncio
async def test_sales_taxes_drop_purchase_and_inactive_taxes_and_put_the_default_first(books, db_session):
    default_id, taxes = await aito_tax.sales_taxes(db_session)
    assert default_id == "T13"
    assert [t["tax_id"] for t in taxes] == ["T13", "T1", "T0"]
    assert taxes[0] == {"tax_id": "T13", "name": "TVA collectée sur Services", "pct": 13.0}


@pytest.mark.asyncio
async def test_list_taxes_route_names_the_customer_default(async_client, books, db_session):
    await aito_tax.remember_for_customer(db_session, "c1", {"tax_id": "T0", "pct": 0.0})
    await db_session.commit()
    body = (await async_client.get("/api/v1/aito/taxes?client_id=c1")).json()
    assert body["default_tax_id"] == "T13"
    assert [t["tax_id"] for t in body["taxes"]] == ["T13", "T1", "T0"]
    assert body["customer_tax_id"] == "T0"
    assert (await async_client.get("/api/v1/aito/taxes")).json()["customer_tax_id"] is None


@pytest.mark.asyncio
async def test_tax_free_keeping_the_price_before_tax_rescales_every_price_and_queues_the_push(
    async_client, books, db_session
):
    project_id = await _card(async_client, db_session, costs=((5000, 4500),), shipping=3200)
    version = (await async_client.get("/api/v1/aito/")).json()[0]["version"]
    r = await async_client.put(f"/api/v1/aito/{project_id}/tax", json={"tax_id": "T0", "expected_version": version})
    assert r.status_code == 200, r.text
    assert (r.json()["tax_id"], r.json()["tax_pct"]) == ("T0", 0.0)
    assert r.json()["version"] == version + 1
    assert await _costs(db_session, project_id) == [(4425.0, 3982.0)]
    project = await db_session.get(AitoProject, project_id)
    assert (project.shipping_price, project.quote_sync_state) == (2832.0, "pending")

    # Back to the default: the override clears and the prices come back.
    r = await async_client.put(f"/api/v1/aito/{project_id}/tax", json={"tax_id": "T13"})
    assert (r.json()["tax_id"], r.json()["tax_pct"]) == (None, None)
    assert await _costs(db_session, project_id) == [(5000.0, 4500.0)]


@pytest.mark.asyncio
async def test_keeping_what_the_client_pays_moves_no_price(async_client, books, db_session):
    project_id = await _card(async_client, db_session)
    r = await async_client.put(f"/api/v1/aito/{project_id}/tax", json={"tax_id": "T1", "keep_price_before_tax": False})
    assert r.json()["tax_id"] == "T1"
    assert await _costs(db_session, project_id) == [(5000.0, 4500.0)]
    # From 1% to tax-free, the old rate is the card's own, not the default's.
    await async_client.put(f"/api/v1/aito/{project_id}/tax", json={"tax_id": "T0"})
    assert await _costs(db_session, project_id) == [(4950.0, 4455.0)]


@pytest.mark.asyncio
async def test_unknown_tax_invoiced_card_and_stale_version_are_refused(async_client, books, db_session):
    project_id = await _card(async_client, db_session)
    for tax_id in ("D13", "OLD", "nope"):
        r = await async_client.put(f"/api/v1/aito/{project_id}/tax", json={"tax_id": tax_id})
        assert r.status_code == 422, tax_id
    r = await async_client.put(f"/api/v1/aito/{project_id}/tax", json={"tax_id": "T0", "expected_version": 99})
    assert r.status_code == 409
    project = await db_session.get(AitoProject, project_id)
    project.quote_invoiced = True
    await db_session.commit()
    r = await async_client.put(f"/api/v1/aito/{project_id}/tax", json={"tax_id": "T0"})
    assert r.status_code == 409
    assert await _costs(db_session, project_id) == [(5000.0, 4500.0)]


@pytest.mark.asyncio
async def test_remembered_tax_starts_the_customers_next_new_card_but_not_an_import(async_client, books, db_session):
    first = await _card(async_client, db_session)
    await async_client.put(f"/api/v1/aito/{first}/tax", json={"tax_id": "T0", "remember": True})
    second = (
        await async_client.post(
            "/api/v1/aito/",
            json={"description": "x", "client_id": "c1", "client_name": "COJ", "client_phone": "+689-87123456"},
        )
    ).json()
    assert (second["tax_id"], second["tax_pct"]) == ("T0", 0.0)
    other = (
        await async_client.post(
            "/api/v1/aito/",
            json={"description": "x", "client_id": "c2", "client_name": "B", "client_phone": "+689-87123456"},
        )
    ).json()
    assert other["tax_id"] is None
    # Choosing the default again with remember forgets the customer's default.
    await async_client.put(f"/api/v1/aito/{second['id']}/tax", json={"tax_id": "T13", "remember": True})
    assert await aito_tax.customer_defaults(db_session) == {}


def test_the_push_puts_the_cards_tax_on_every_line():
    assert _with_card_tax(CATALOGUE, AitoProject(tax_id="T0")).tax_id == "T0"
    assert _with_card_tax(CATALOGUE, AitoProject()).tax_id == "T13"
