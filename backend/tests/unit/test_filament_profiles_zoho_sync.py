"""Tests for POST /api/v1/filament-profiles/zoho-sync."""

import asyncio
import json

import pytest
from pydantic import ValidationError

from backend.app.models.filament_profile import FilamentPreset
from backend.app.schemas.filament_profile import FilamentPresetZohoSyncAttention
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


def product(
    brand="Polymaker", material="PETG", colour="Electric Blue", price=19.9, has_price=True, weight_inferred=False
):
    name = f"{brand} - {material} - {colour} - 1.75mm - 1kg"
    if weight_inferred:
        # No weight segment at all, mirroring parse_filament_name's own trigger
        # for weight_inferred=True: the name simply carries no weight token.
        name = f"{brand} - {material} - {colour} - 1.75mm"
    return FilamentProduct(
        item_id=f"{brand}-{material}-{colour}",
        name=name,
        sku="SKU",
        brand=brand,
        material=material,
        colour=colour,
        spool_weight_kg=1.0,
        weight_inferred=weight_inferred,
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
    # T-034: a genuinely fresh sync must report no staleness at all — this is
    # the byte-identical-behaviour half of the fix.
    assert body["catalogue_stale_since"] is None

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
async def test_sole_candidate_with_a_different_colour_is_left_unpriced(async_client, db_session, monkeypatch):
    # T-025 (user-approved 2026-08-26): a lone catalogue candidate whose
    # colour disagrees with the profile's must not be auto-priced — dealer
    # price varies by colour within a brand and material. It must instead
    # land in the attention list (reusing the "ambiguous" reason) and the
    # preset's content must stay byte-identical, exactly like any other
    # unresolved profile.
    original = json.dumps({"name": "P"}, indent=4)
    preset = await make_preset(db_session, colour="Electric Blue", content=original)
    mismatched = product(colour="Red")
    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", _catalogue([mismatched]))
    _configured(monkeypatch, True)

    body = (await async_client.post(ENDPOINT)).json()

    assert body["priced"] == 0
    assert body["unchanged"] == 0
    assert len(body["attention"]) == 1
    assert body["attention"][0]["id"] == preset.id
    assert body["attention"][0]["reason"] == "ambiguous"
    assert body["attention"][0]["candidates"] == [mismatched.name]
    assert body["attention"][0]["candidates_total"] == 1

    await db_session.refresh(preset)
    assert preset.content == original  # byte-identical: never written


@pytest.mark.asyncio
async def test_ambiguous_attention_caps_candidates_and_carries_the_true_total(async_client, db_session, monkeypatch):
    # T-010: the route must thread match_profile's cap-and-total through the
    # response, not just the (already-capped) name list.
    catalogue = [product(colour=f"Colour {i}") for i in range(7)]
    original = json.dumps({"name": "P"}, indent=4)
    await make_preset(db_session, content=original)
    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", _catalogue(catalogue))
    _configured(monkeypatch, True)

    body = (await async_client.post(ENDPOINT)).json()

    assert len(body["attention"]) == 1
    entry = body["attention"][0]
    assert entry["reason"] == "ambiguous"
    assert len(entry["candidates"]) == 5
    assert entry["candidates_total"] == 7


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
async def test_a_confident_match_with_an_inferred_weight_is_flagged_for_attention(
    async_client, db_session, monkeypatch
):
    # The item matches uniquely and has a usable price, but that price was
    # derived from a 1 kg default because the Zoho item name carried no
    # weight at all (FilamentProduct.weight_inferred). Writing it would let a
    # later rename of that same item (e.g. adding a real "- 500g" suffix)
    # silently re-scale the preset's stored price — the calculator's own sync
    # refuses to do this for the same reason. Must be reported for review,
    # not auto-priced, and the preset must be left byte-identical.
    original = json.dumps({"name": "P"}, indent=4)
    preset = await make_preset(db_session, content=original)
    inferred = product(weight_inferred=True)
    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", _catalogue([inferred]))
    _configured(monkeypatch, True)

    body = (await async_client.post(ENDPOINT)).json()

    assert body["priced"] == 0
    assert body["unchanged"] == 0
    assert len(body["attention"]) == 1
    assert body["attention"][0]["reason"] == "weight_unknown"
    assert body["attention"][0]["id"] == preset.id
    assert body["attention"][0]["name"] == "P"
    assert body["attention"][0]["candidates"] == [inferred.name]
    assert body["attention"][0]["candidates_total"] == 1

    await db_session.refresh(preset)
    assert preset.content == original  # byte-identical: never written


@pytest.mark.asyncio
async def test_a_weight_inferred_profile_does_not_stop_healthy_profiles_from_being_priced(
    async_client, db_session, monkeypatch
):
    healthy = await make_preset(db_session, name="Healthy", brand="Polymaker", material="PETG", colour="Red")
    unknown_weight = await make_preset(db_session, name="UnknownWeight", brand="eSUN", material="PLA", colour="Black")
    monkeypatch.setattr(
        zoho_filaments,
        "fetch_catalogue",
        _catalogue(
            [
                product(brand="Polymaker", material="PETG", colour="Red", price=19.9),
                product(brand="eSUN", material="PLA", colour="Black", price=15.0, weight_inferred=True),
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
    assert body["attention"][0]["id"] == unknown_weight.id
    assert body["attention"][0]["reason"] == "weight_unknown"

    await db_session.refresh(healthy)
    assert json.loads(healthy.content)["filament_cost"] == ["19.90"]


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
async def test_a_mixed_batch_produces_disjoint_per_preset_outcomes(async_client, db_session, monkeypatch):
    # One call, four presets in four different match states against the same
    # catalogue: a fresh confident match (priced), an already-priced confident
    # match (unchanged), an ambiguous match (attention), and a no-match
    # (attention). Guards against a bug that double-counts one preset's
    # outcome, or attributes it to the wrong id — every test above exercises
    # exactly one preset per call, so a leak or double-count across `presets`
    # in the loop would not be caught.
    fresh = await make_preset(db_session, name="Fresh", brand="Polymaker", material="PETG", colour="Electric Blue")
    already_priced_content = json.dumps({"filament_cost": ["19.90"]}, indent=4)
    already_priced = await make_preset(
        db_session,
        name="AlreadyPriced",
        brand="Polymaker",
        material="PLA",
        colour="Black",
        content=already_priced_content,
    )
    ambiguous_original = json.dumps({"name": "Ambiguous"}, indent=4)
    ambiguous = await make_preset(
        db_session, name="Ambiguous", brand="eSUN", material="PLA", colour="Red", content=ambiguous_original
    )
    no_match_original = json.dumps({"name": "NoMatch"}, indent=4)
    no_match = await make_preset(
        db_session, name="NoMatch", brand="Prusament", material="ABS", colour="Orange", content=no_match_original
    )

    monkeypatch.setattr(
        zoho_filaments,
        "fetch_catalogue",
        _catalogue(
            [
                product(brand="Polymaker", material="PETG", colour="Electric Blue", price=19.9),
                product(brand="Polymaker", material="PLA", colour="Black", price=19.9),
                product(brand="eSUN", material="PLA", colour="Red", price=10.0),
                product(brand="eSUN", material="PLA", colour="Red", price=12.0),
            ]
        ),
    )
    _configured(monkeypatch, True)

    response = await async_client.post(ENDPOINT)

    assert response.status_code == 200
    body = response.json()
    assert body["priced"] == 1
    assert body["unchanged"] == 1
    assert len(body["attention"]) == 2
    # Total accounted-for presets equals the batch size — no double-count and
    # no dropped preset.
    assert body["priced"] + body["unchanged"] + len(body["attention"]) == 4

    attention_by_id = {entry["id"]: entry for entry in body["attention"]}
    assert set(attention_by_id) == {ambiguous.id, no_match.id}
    assert attention_by_id[ambiguous.id]["reason"] == "ambiguous"
    assert attention_by_id[ambiguous.id]["name"] == "Ambiguous"
    assert attention_by_id[no_match.id]["reason"] == "no_match"
    assert attention_by_id[no_match.id]["name"] == "NoMatch"

    await db_session.refresh(fresh)
    assert json.loads(fresh.content)["filament_cost"] == ["19.90"]

    await db_session.refresh(already_priced)
    assert already_priced.content == already_priced_content  # unchanged: byte-identical

    await db_session.refresh(ambiguous)
    assert ambiguous.content == ambiguous_original  # never touched

    await db_session.refresh(no_match)
    assert no_match.content == no_match_original  # never touched


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
    response = await async_client.post(ENDPOINT)
    assert response.status_code == 503
    assert response.json()["detail"] == "Zoho is not configured"


@pytest.mark.asyncio
async def test_500_when_the_catalogue_cannot_be_mapped(async_client, db_session, monkeypatch):
    await make_preset(db_session)
    _configured(monkeypatch, True)

    async def boom(_db):
        raise zoho_filaments.ZohoFilamentMappingError("bad shape")

    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", boom)
    response = await async_client.post(ENDPOINT)
    assert response.status_code == 500
    assert response.json()["detail"] == "Zoho filament catalogue could not be mapped"


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
        raise RuntimeError(zoho_filaments._SYNC_IN_PROGRESS_DETAIL)

    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", boom)
    response = await async_client.post(ENDPOINT)
    assert response.status_code == 409
    assert response.json()["detail"] == zoho_filaments._SYNC_IN_PROGRESS_DETAIL


@pytest.mark.asyncio
async def test_409_end_to_end_when_the_real_lock_is_busy(async_client, db_session, monkeypatch):
    """Unlike test_409_when_a_sync_is_already_in_progress above (which
    monkeypatches fetch_catalogue to raise a copy of the message), this drives
    the real lock-timeout throw site inside fetch_catalogue through the actual
    /zoho-sync route. It is the one test exercising the throw site and the 409
    classifier together, so the two copies of _SYNC_IN_PROGRESS_DETAIL cannot
    silently drift apart with every other test still green."""
    _configured(monkeypatch, True)
    monkeypatch.setattr(zoho_filaments, "_LOCK_ACQUIRE_TIMEOUT", 0.02)
    zoho_filaments.reset_cache()

    from backend.app.services.zoho import zoho_service

    gate = asyncio.Event()
    entered = asyncio.Event()

    async def stuck_page(_db, **_kwargs):
        entered.set()
        await gate.wait()  # the leader is parked here for the whole test
        return [], False

    monkeypatch.setattr(zoho_service, "list_items_page", stuck_page)

    leader = asyncio.create_task(zoho_filaments.fetch_catalogue(db_session))
    await entered.wait()  # the leader now holds the module's refresh lock

    try:
        response = await async_client.post(ENDPOINT)
        assert response.status_code == 409
        assert response.json()["detail"] == zoho_filaments._SYNC_IN_PROGRESS_DETAIL
    finally:
        gate.set()
        await leader  # let the leader finish so no task is left pending
        zoho_filaments.reset_cache()


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


@pytest.mark.asyncio
async def test_stale_catalogue_discloses_its_age_instead_of_a_plain_success(async_client, db_session, monkeypatch):
    """T-034: fetch_catalogue's failure branch serves the previous cache with
    no upper bound on its age, and used to leave the sync response
    indistinguishable from a live one — an operator syncing during a Zoho
    outage was told it succeeded with today's prices. The sync must still run
    and write (refusing outright would make the feature unusable during an
    outage), but the response must now carry when that catalogue actually
    came from."""
    from datetime import datetime, timedelta, timezone

    from backend.app.services.zoho import zoho_service

    preset = await make_preset(db_session)
    _configured(monkeypatch, True)

    # A real warm cache, deliberately past its TTL, so the route's call goes
    # through fetch_catalogue's genuine refresh-then-fall-back-to-stale path
    # rather than the plain `_catalogue([...])` fake other tests here use.
    zoho_filaments.reset_cache()
    zoho_filaments._cache = [product()]
    expired_at = datetime.now(timezone.utc) - zoho_filaments._CACHE_TTL - timedelta(seconds=1)
    zoho_filaments._cache_at = expired_at

    async def boom(_db, **kwargs):
        raise RuntimeError("zoho unreachable")

    monkeypatch.setattr(zoho_service, "list_items_page", boom)
    try:
        response = await async_client.post(ENDPOINT)

        assert response.status_code == 200
        body = response.json()
        assert body["priced"] == 1  # the sync still ran and wrote, per the approved design
        assert body["catalogue_stale_since"] is not None
        assert body["catalogue_stale_since"].startswith(expired_at.isoformat()[:19])

        await db_session.refresh(preset)
        assert json.loads(preset.content)["filament_cost"] == ["19.90"]
    finally:
        zoho_filaments.reset_cache()


@pytest.mark.parametrize(
    "reason", ["no_match", "ambiguous", "no_price", "unwritable_content", "bad_price", "weight_unknown"]
)
def test_attention_reason_accepts_every_value_the_route_can_set(reason):
    # Pins FilamentPresetZohoSyncAttention.reason as a closed Literal, not a bare str:
    # every value the route actually assigns (match_profile's three outcomes plus the
    # route's own "bad_price"/"unwritable_content"/"weight_unknown") must still
    # construct cleanly.
    FilamentPresetZohoSyncAttention(id=1, name="P", reason=reason)


def test_attention_reason_rejects_an_unknown_value():
    # A reason outside the five above is a bug, not a new legitimate value — the closed
    # Literal must fail closed (ValidationError) instead of silently accepting any string.
    with pytest.raises(ValidationError):
        FilamentPresetZohoSyncAttention(id=1, name="P", reason="matched")
