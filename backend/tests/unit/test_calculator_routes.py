"""Tests for the pricing calculator API routes."""

import pytest

FILAMENT_PAYLOAD = {
    "brand": "SUNLU",
    "material": "PA6-CF",
    "cost_per_kg": 3731.0,
    "sale_price_per_kg": 5597.0,
    "difficulty_pct": 150.0,
}
PRINTER_PAYLOAD = {
    "name": "H2S",
    "purchase_price": 347000.0,
    "lifetime_years": 2.0,
    "daily_usage_hours": 5.0,
    "power_watts": 400.0,
    "repair_rate_pct": 30.0,
}


class TestCalculatorFilaments:
    @pytest.mark.asyncio
    async def test_list_empty(self, async_client):
        resp = await async_client.get("/api/v1/calculator/filaments/")
        assert resp.status_code == 200
        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_create_and_list(self, async_client):
        resp = await async_client.post("/api/v1/calculator/filaments/", json=FILAMENT_PAYLOAD)
        assert resp.status_code == 200
        created = resp.json()
        assert created["brand"] == "SUNLU"
        assert created["material"] == "PA6-CF"
        assert created["name"] == "SUNLU PA6-CF"  # derived display label
        assert created["cost_per_kg"] == 3731.0
        assert created["sale_price_per_kg"] == 5597.0
        assert created["difficulty_pct"] == 150.0

        resp = await async_client.get("/api/v1/calculator/filaments/")
        assert len(resp.json()) == 1

    @pytest.mark.asyncio
    async def test_create_rejects_negative_cost(self, async_client):
        resp = await async_client.post("/api/v1/calculator/filaments/", json={**FILAMENT_PAYLOAD, "cost_per_kg": -5})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_create_rejects_empty_material(self, async_client):
        resp = await async_client.post("/api/v1/calculator/filaments/", json={**FILAMENT_PAYLOAD, "material": ""})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_create_allows_empty_brand(self, async_client):
        resp = await async_client.post("/api/v1/calculator/filaments/", json={**FILAMENT_PAYLOAD, "brand": ""})
        assert resp.status_code == 200
        assert resp.json()["name"] == "PA6-CF"  # label falls back to material alone

    @pytest.mark.asyncio
    async def test_create_rejects_difficulty_below_100(self, async_client):
        resp = await async_client.post("/api/v1/calculator/filaments/", json={**FILAMENT_PAYLOAD, "difficulty_pct": 50})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_create_defaults_difficulty_to_100(self, async_client):
        payload = {key: value for key, value in FILAMENT_PAYLOAD.items() if key != "difficulty_pct"}
        resp = await async_client.post("/api/v1/calculator/filaments/", json=payload)
        assert resp.status_code == 200
        assert resp.json()["difficulty_pct"] == 100.0

    @pytest.mark.asyncio
    async def test_update(self, async_client):
        created = (await async_client.post("/api/v1/calculator/filaments/", json=FILAMENT_PAYLOAD)).json()
        resp = await async_client.patch(
            f"/api/v1/calculator/filaments/{created['id']}", json={"sale_price_per_kg": 6000.0}
        )
        assert resp.status_code == 200
        updated = resp.json()
        assert updated["sale_price_per_kg"] == 6000.0
        assert updated["cost_per_kg"] == 3731.0  # unchanged

    @pytest.mark.asyncio
    async def test_update_brand_or_material_recomputes_name(self, async_client):
        created = (await async_client.post("/api/v1/calculator/filaments/", json=FILAMENT_PAYLOAD)).json()
        resp = await async_client.patch(f"/api/v1/calculator/filaments/{created['id']}", json={"material": "PLA"})
        assert resp.status_code == 200
        assert resp.json()["name"] == "SUNLU PLA"

    @pytest.mark.asyncio
    async def test_update_ignores_explicit_nulls(self, async_client):
        # No column is nullable: an explicit JSON null must be treated as
        # "leave unchanged", not crash the name derivation with a 500.
        created = (await async_client.post("/api/v1/calculator/filaments/", json=FILAMENT_PAYLOAD)).json()
        resp = await async_client.patch(
            f"/api/v1/calculator/filaments/{created['id']}", json={"brand": None, "cost_per_kg": None}
        )
        assert resp.status_code == 200
        updated = resp.json()
        assert updated["brand"] == "SUNLU"
        assert updated["cost_per_kg"] == 3731.0
        assert updated["name"] == "SUNLU PA6-CF"

    @pytest.mark.asyncio
    async def test_update_missing_returns_404(self, async_client):
        resp = await async_client.patch("/api/v1/calculator/filaments/9999", json={"material": "X"})
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_delete(self, async_client):
        created = (await async_client.post("/api/v1/calculator/filaments/", json=FILAMENT_PAYLOAD)).json()
        resp = await async_client.delete(f"/api/v1/calculator/filaments/{created['id']}")
        assert resp.status_code == 200
        resp = await async_client.get("/api/v1/calculator/filaments/")
        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_delete_missing_returns_404(self, async_client):
        resp = await async_client.delete("/api/v1/calculator/filaments/9999")
        assert resp.status_code == 404


class TestCalculatorPrinters:
    @pytest.mark.asyncio
    async def test_create_returns_raw_fields(self, async_client):
        # Derived per-hour values are intentionally NOT returned — the
        # frontend pricing engine is the single source of that math.
        resp = await async_client.post("/api/v1/calculator/printers/", json=PRINTER_PAYLOAD)
        assert resp.status_code == 200
        printer = resp.json()
        assert printer["purchase_price"] == 347000.0
        assert printer["lifetime_years"] == 2.0
        assert printer["daily_usage_hours"] == 5.0
        assert "lifetime_hours" not in printer
        assert "depreciation_per_hour" not in printer

    @pytest.mark.asyncio
    async def test_create_rejects_invalid_values(self, async_client):
        for bad in (
            {"lifetime_years": 0},
            {"daily_usage_hours": 25},
            {"power_watts": -1},
            {"repair_rate_pct": 150},
        ):
            resp = await async_client.post("/api/v1/calculator/printers/", json={**PRINTER_PAYLOAD, **bad})
            assert resp.status_code == 422, bad

    @pytest.mark.asyncio
    async def test_update(self, async_client):
        created = (await async_client.post("/api/v1/calculator/printers/", json=PRINTER_PAYLOAD)).json()
        resp = await async_client.patch(f"/api/v1/calculator/printers/{created['id']}", json={"lifetime_years": 4.0})
        assert resp.status_code == 200
        assert resp.json()["lifetime_years"] == 4.0
        assert resp.json()["purchase_price"] == 347000.0  # unchanged

    @pytest.mark.asyncio
    async def test_update_ignores_explicit_nulls(self, async_client):
        created = (await async_client.post("/api/v1/calculator/printers/", json=PRINTER_PAYLOAD)).json()
        resp = await async_client.patch(f"/api/v1/calculator/printers/{created['id']}", json={"name": None})
        assert resp.status_code == 200
        assert resp.json()["name"] == "H2S"

    @pytest.mark.asyncio
    async def test_delete(self, async_client):
        created = (await async_client.post("/api/v1/calculator/printers/", json=PRINTER_PAYLOAD)).json()
        resp = await async_client.delete(f"/api/v1/calculator/printers/{created['id']}")
        assert resp.status_code == 200
        resp = await async_client.get("/api/v1/calculator/printers/")
        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_missing_returns_404(self, async_client):
        assert (await async_client.patch("/api/v1/calculator/printers/9999", json={})).status_code == 404
        assert (await async_client.delete("/api/v1/calculator/printers/9999")).status_code == 404


class TestCalculatorDefaults:
    @pytest.mark.asyncio
    async def test_get_creates_row_with_documented_defaults(self, async_client):
        resp = await async_client.get("/api/v1/calculator/defaults")
        assert resp.status_code == 200
        defaults = resp.json()
        assert defaults["electricity_tariff"] == 120.0
        assert defaults["labor_rate_per_hour"] == 3000.0
        assert defaults["consumables_packaging_flat"] == 30.0
        assert defaults["failure_rate_pct"] == 30.0
        assert defaults["prototype_rate_pct"] == 30.0
        assert defaults["ads_rate_pct"] == 5.0
        assert defaults["filament_markup_pct"] == 5.0
        assert defaults["global_markup_pct"] == 50.0
        assert defaults["tax_pct"] == 13.0
        assert defaults["default_difficulty_pct"] == 100.0
        assert defaults["default_margin_over_cost_pct"] == 50.0
        assert defaults["stuff_markup_pct"] == 20.0

    @pytest.mark.asyncio
    async def test_patch_roundtrip(self, async_client):
        resp = await async_client.patch("/api/v1/calculator/defaults", json={"tax_pct": 11.0})
        assert resp.status_code == 200
        assert resp.json()["tax_pct"] == 11.0
        # Other fields untouched
        assert resp.json()["electricity_tariff"] == 120.0

        resp = await async_client.get("/api/v1/calculator/defaults")
        assert resp.json()["tax_pct"] == 11.0

    @pytest.mark.asyncio
    async def test_patch_rejects_negative(self, async_client):
        resp = await async_client.patch("/api/v1/calculator/defaults", json={"electricity_tariff": -1})
        assert resp.status_code == 422
