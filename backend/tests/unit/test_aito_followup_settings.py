"""The two follow-up thresholds: integers with defaults, bounded, read back as ints."""

import pytest


@pytest.mark.asyncio
async def test_defaults(async_client):
    body = (await async_client.get("/api/v1/settings/")).json()
    assert body["aito_followup_quote_days"] == 5
    assert body["aito_followup_pickup_days"] == 7


@pytest.mark.asyncio
async def test_round_trip_reads_back_as_integers(async_client):
    r = await async_client.put(
        "/api/v1/settings/", json={"aito_followup_quote_days": 3, "aito_followup_pickup_days": 10}
    )
    assert r.status_code == 200, r.text
    body = (await async_client.get("/api/v1/settings/")).json()
    assert body["aito_followup_quote_days"] == 3 and isinstance(body["aito_followup_quote_days"], int)
    assert body["aito_followup_pickup_days"] == 10 and isinstance(body["aito_followup_pickup_days"], int)


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["aito_followup_quote_days", "aito_followup_pickup_days"])
@pytest.mark.parametrize("value", [0, 366, -1])
async def test_out_of_range_is_rejected(async_client, field, value):
    r = await async_client.put("/api/v1/settings/", json={field: value})
    assert r.status_code == 422, r.text
