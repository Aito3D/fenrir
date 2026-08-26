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
@pytest.mark.parametrize("content", ["", "{not json", "[1, 2]"])
async def test_a_confident_match_with_unwritable_content_is_flagged_for_attention(
    async_client, db_session, monkeypatch, content
):
    # A confident match (unique, priced item) whose preset content is empty,
    # unparseable, or not a JSON object has nowhere to write the price. This
    # must not be counted as "unchanged" — that means the price was already
    # correct, and here it is unknown whether it is correct at all.
    preset = await make_preset(db_session, content=content)
    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", _catalogue([product()]))
    _configured(monkeypatch, True)

    body = (await async_client.post(ENDPOINT)).json()

    assert body["priced"] == 0
    assert body["unchanged"] == 0
    assert len(body["attention"]) == 1
    assert body["attention"][0]["reason"] == "unwritable_content"
    assert body["attention"][0]["id"] == preset.id
    assert body["attention"][0]["name"] == "P"
    assert body["attention"][0]["candidates"] == []

    await db_session.refresh(preset)
    assert preset.content == content  # byte-identical: never written


@pytest.mark.asyncio
async def test_a_confident_match_with_a_bad_price_is_flagged_for_attention(async_client, db_session, monkeypatch):
    # The item matches uniquely and the preset's content is perfectly fine —
    # but the catalogue price itself is non-finite (a sub-denormal weight
    # parsed out of a Zoho item name can divide a normal dealer price into
    # inf; has_price only checks that dealer > 0, which inf passes). This
    # must be reported under its own reason, not "unwritable_content" — the
    # preset's file is not the problem, the upstream price is — and the
    # preset must be left byte-identical, exactly like any other unresolved
    # profile.
    original = json.dumps({"name": "P"}, indent=4)
    preset = await make_preset(db_session, content=original)
    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", _catalogue([product(price=float("inf"))]))
    _configured(monkeypatch, True)

    body = (await async_client.post(ENDPOINT)).json()

    assert body["priced"] == 0
    assert body["unchanged"] == 0
    assert len(body["attention"]) == 1
    assert body["attention"][0]["reason"] == "bad_price"
    assert body["attention"][0]["id"] == preset.id
    assert body["attention"][0]["name"] == "P"
    assert body["attention"][0]["candidates"] == []

    await db_session.refresh(preset)
    assert preset.content == original  # byte-identical: never written


@pytest.mark.asyncio
async def test_a_bad_priced_profile_does_not_stop_healthy_profiles_from_being_priced(
    async_client, db_session, monkeypatch
):
    healthy = await make_preset(db_session, name="Healthy", brand="Polymaker", material="PETG", colour="Red")
    bad_priced = await make_preset(db_session, name="BadPriced", brand="eSUN", material="PLA", colour="Black")
    monkeypatch.setattr(
        zoho_filaments,
        "fetch_catalogue",
        _catalogue(
            [
                product(brand="Polymaker", material="PETG", colour="Red", price=19.9),
                product(brand="eSUN", material="PLA", colour="Black", price=float("nan")),
            ]
        ),
    )
    _configured(monkeypatch, True)

    response = await async_client.post(ENDPOINT)

    assert response.status_code == 200
    body = response.json()
    assert body["priced"] == 1
    assert body["unchanged"] == 0
    assert len(body["attention"]) == 1
    assert body["attention"][0]["id"] == bad_priced.id
    assert body["attention"][0]["reason"] == "bad_price"

    await db_session.refresh(healthy)
    assert json.loads(healthy.content)["filament_cost"] == ["19.90"]


@pytest.mark.asyncio
async def test_a_pathologically_deep_preset_does_not_abort_the_whole_sync(async_client, db_session, monkeypatch):
    # The real bug: one preset whose content is JSON so deeply nested that
    # json.loads blows the recursion limit used to raise RecursionError out
    # of apply_filament_cost and crash the loop before `await db.commit()`,
    # discarding the prices already computed for every other preset in the
    # same request. It must instead be reported like any other unwritable
    # preset while its healthy siblings are still priced in the same run.
    healthy = await make_preset(db_session, name="Healthy")
    pathological = await make_preset(db_session, name="Pathological", content="[" * 120000)
    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", _catalogue([product()]))
    _configured(monkeypatch, True)

    response = await async_client.post(ENDPOINT)

    assert response.status_code == 200
    body = response.json()
    assert body["priced"] == 1
    assert body["unchanged"] == 0
    assert len(body["attention"]) == 1
    assert body["attention"][0]["id"] == pathological.id
    assert body["attention"][0]["reason"] == "unwritable_content"

    await db_session.refresh(healthy)
    assert json.loads(healthy.content)["filament_cost"] == ["19.90"]

    await db_session.refresh(pathological)
    assert pathological.content == "[" * 120000  # never touched


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
    response = await async_client.post(ENDPOINT)
    assert response.status_code == 502
    assert response.json()["detail"] == "Could not reach Zoho"


@pytest.mark.asyncio
async def test_503_when_credentials_are_cleared_between_the_check_and_the_token_refresh(
    async_client, db_session, monkeypatch
):
    # is_configured() passes (the route's up-front check), but fetch_catalogue
    # itself hits ZohoNotConfiguredError — the check-then-act window where a
    # credential is cleared in Settings after the check but before the token
    # refresh inside the walk.
    await make_preset(db_session)
    _configured(monkeypatch, True)

    from backend.app.services.zoho import ZohoNotConfiguredError

    async def boom(_db):
        raise ZohoNotConfiguredError("Zoho credentials are not configured")

    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", boom)
    response = await async_client.post(ENDPOINT)
    assert response.status_code == 503
    assert response.json()["detail"] == "Zoho is not configured"


@pytest.mark.asyncio
async def test_409_when_a_sync_is_already_in_progress(async_client, db_session, monkeypatch):
    await make_preset(db_session)
    _configured(monkeypatch, True)

    async def boom(_db):
        raise RuntimeError("Zoho filament catalogue refresh is still in progress; try again shortly")

    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", boom)
    response = await async_client.post(ENDPOINT)
    assert response.status_code == 409
    assert response.json()["detail"] == "Zoho filament catalogue refresh is still in progress; try again shortly"


@pytest.mark.asyncio
async def test_502_for_a_non_runtime_error_fallback(async_client, db_session, monkeypatch):
    # Anything that isn't a ZohoFilamentMappingError, a ZohoNotConfiguredError,
    # or the lock-busy RuntimeError still falls through to the generic 502 —
    # e.g. an httpx/SQLAlchemy failure surfacing as some other exception type.
    await make_preset(db_session)
    _configured(monkeypatch, True)

    async def boom(_db):
        raise ValueError("unexpected shape")

    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", boom)
    response = await async_client.post(ENDPOINT)
    assert response.status_code == 502
    assert response.json()["detail"] == "Could not reach Zoho"
