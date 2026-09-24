"""Heimdall + payment-link settings: defaults, write-only token, int round trips, URL guard."""

import pytest


@pytest.mark.asyncio
async def test_defaults(async_client):
    body = (await async_client.get("/api/v1/settings/")).json()
    assert body["heimdall_base_url"] == ""
    assert body["heimdall_api_token"] == ""
    assert body["aito_deposit_pct"] == 0
    assert body["aito_quote_validity_days"] == 15
    assert body["aito_followup_link_days"] == 3


@pytest.mark.asyncio
async def test_token_is_write_only(async_client):
    r = await async_client.put(
        "/api/v1/settings/",
        json={"heimdall_api_token": "hmd_live.84f32b71ac095ed2.s3cret", "heimdall_base_url": "http://10.0.0.5:8081"},
    )
    assert r.status_code == 200, r.text
    body = (await async_client.get("/api/v1/settings/")).json()
    assert body["heimdall_api_token"] == ""  # scrubbed on every GET
    assert body["heimdall_base_url"] == "http://10.0.0.5:8081"


@pytest.mark.asyncio
async def test_integers_round_trip_as_integers(async_client):
    r = await async_client.put(
        "/api/v1/settings/",
        json={"aito_deposit_pct": 30, "aito_quote_validity_days": 20, "aito_followup_link_days": 5},
    )
    assert r.status_code == 200, r.text
    body = (await async_client.get("/api/v1/settings/")).json()
    assert body["aito_deposit_pct"] == 30 and isinstance(body["aito_deposit_pct"], int)
    assert body["aito_quote_validity_days"] == 20 and isinstance(body["aito_quote_validity_days"], int)
    assert body["aito_followup_link_days"] == 5 and isinstance(body["aito_followup_link_days"], int)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("aito_deposit_pct", -1),
        ("aito_deposit_pct", 101),
        ("aito_quote_validity_days", 0),
        ("aito_quote_validity_days", 366),
        ("aito_followup_link_days", 0),
    ],
)
async def test_out_of_range_is_rejected(async_client, field, value):
    r = await async_client.put("/api/v1/settings/", json={field: value})
    assert r.status_code == 422, r.text


@pytest.mark.asyncio
async def test_base_url_is_guarded_like_every_lan_service_url(async_client):
    r = await async_client.put("/api/v1/settings/", json={"heimdall_base_url": "http://169.254.169.254/"})
    assert r.status_code == 422, r.text
    r = await async_client.put("/api/v1/settings/", json={"heimdall_base_url": "gopher://pos.local"})
    assert r.status_code == 422, r.text


@pytest.mark.asyncio
async def test_payment_modes_default_to_zoho_stock_names_and_round_trip(async_client):
    r = await async_client.get("/api/v1/settings/")
    body = r.json()
    assert (
        body["aito_payment_mode_card"],
        body["aito_payment_mode_cheque"],
        body["aito_payment_mode_cash"],
    ) == (
        "creditcard",
        "check",
        "cash",
    )
    r = await async_client.put("/api/v1/settings/", json={"aito_payment_mode_cash": "Espèces"})
    assert r.status_code == 200, r.text
    assert (await async_client.get("/api/v1/settings/")).json()["aito_payment_mode_cash"] == "Espèces"
