"""Tests for POST /api/v1/filament-profiles/zoho-sync."""

import json

import pytest

from backend.app.models.filament_profile import FilamentPreset
from backend.app.services import zoho_filaments
from backend.app.services.zoho_filaments import FilamentProduct

ENDPOINT = "/api/v1/filament-profiles/zoho-sync"


def _catalogue(items):
    async def fetch(_db):
        return items

    return fetch


def _configured(monkeypatch, value):
    from backend.app.services.zoho import zoho_service

    async def is_configured(_db):
        return value

    monkeypatch.setattr(zoho_service, "is_configured", is_configured)


def product(brand="Polymaker", material="PETG", colour="Electric Blue", price=19.9, has_price=True):
    return FilamentProduct(
        item_id=f"{brand}-{material}-{colour}",
        name=f"{brand} - {material} - {colour} - 1.75mm - 1kg",
        sku="SKU",
        brand=brand,
        material=material,
        colour=colour,
        spool_weight_kg=1.0,
        weight_inferred=False,
        dealer_price=price,
        cost_per_kg=price,
        has_price=has_price,
    )


async def make_preset(db_session, name="P", brand="Polymaker", material="PETG", colour="Electric Blue", content=None):
    preset = FilamentPreset(
        name=name,
        brand=brand,
        material=material,
        color=colour,
        color_hex="#3E8CE4",
        filename=f"{name}.json",
        content=content if content is not None else json.dumps({"name": name}, indent=4),
    )
    db_session.add(preset)
    await db_session.commit()
    await db_session.refresh(preset)
    return preset


@pytest.mark.asyncio
async def test_prices_a_confident_match(async_client, db_session, monkeypatch):
    preset = await make_preset(db_session)
    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", _catalogue([product()]))
    _configured(monkeypatch, True)

    response = await async_client.post(ENDPOINT)

    assert response.status_code == 200
    body = response.json()
    assert body["priced"] == 1
    assert body["unchanged"] == 0
    assert body["attention"] == []

    await db_session.refresh(preset)
    assert json.loads(preset.content)["filament_cost"] == ["19.90"]


@pytest.mark.asyncio
async def test_counts_an_already_correct_price_as_unchanged(async_client, db_session, monkeypatch):
    await make_preset(db_session, content=json.dumps({"filament_cost": ["19.90"]}, indent=4))
    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", _catalogue([product()]))
    _configured(monkeypatch, True)

    body = (await async_client.post(ENDPOINT)).json()
    assert body["priced"] == 0
    assert body["unchanged"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("catalogue", "reason"),
    [
        ([product(brand="eSUN")], "no_match"),
        ([product(colour="Red"), product(colour="Green")], "ambiguous"),
        ([product(price=0.0, has_price=False)], "no_price"),
    ],
)
async def test_unresolved_profiles_are_reported_and_left_untouched(
    async_client, db_session, monkeypatch, catalogue, reason
):
    original = json.dumps({"name": "P"}, indent=4)
    preset = await make_preset(db_session, content=original)
    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", _catalogue(catalogue))
    _configured(monkeypatch, True)

    body = (await async_client.post(ENDPOINT)).json()

    assert body["priced"] == 0
    assert body["unchanged"] == 0
    assert len(body["attention"]) == 1
    assert body["attention"][0]["reason"] == reason
    assert body["attention"][0]["name"] == "P"

    await db_session.refresh(preset)
    assert preset.content == original  # byte-identical


@pytest.mark.asyncio
async def test_503_when_zoho_is_not_configured(async_client, db_session, monkeypatch):
    await make_preset(db_session)
    _configured(monkeypatch, False)
    assert (await async_client.post(ENDPOINT)).status_code == 503


@pytest.mark.asyncio
async def test_500_when_the_catalogue_cannot_be_mapped(async_client, db_session, monkeypatch):
    await make_preset(db_session)
    _configured(monkeypatch, True)

    async def boom(_db):
        raise zoho_filaments.ZohoFilamentMappingError("bad shape")

    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", boom)
    assert (await async_client.post(ENDPOINT)).status_code == 500


@pytest.mark.asyncio
async def test_502_when_zoho_is_unreachable(async_client, db_session, monkeypatch):
    await make_preset(db_session)
    _configured(monkeypatch, True)

    async def boom(_db):
        raise RuntimeError("connection reset")

    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", boom)
    assert (await async_client.post(ENDPOINT)).status_code == 502
