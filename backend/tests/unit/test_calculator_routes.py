"""Tests for the pricing calculator API routes."""

import json

import pytest


async def _post_non_standard_json(async_client, url, payload):
    """POST a body containing a bare ``Infinity``/``-Infinity``/``NaN`` literal.

    ``httpx``'s own ``json=`` kwarg refuses to serialize those (it calls
    ``json.dumps(..., allow_nan=False)``), but Python's ``json.dumps`` with its
    OWN default (``allow_nan=True``) happily emits the bare literal — which is
    exactly what "any Python API client" producing this payload looks like, per
    the audit evidence. Building the body by hand and posting it as raw content
    reproduces that real-world request.
    """
    body = json.dumps(payload)
    return await async_client.post(url, content=body, headers={"Content-Type": "application/json"})


async def _patch_non_standard_json(async_client, url, payload):
    body = json.dumps(payload)
    return await async_client.patch(url, content=body, headers={"Content-Type": "application/json"})


FILAMENT_PAYLOAD = {
    "brand": "SUNLU",
    "material": "PA6-CF",
    "cost_per_kg": 3731.0,
    "margin_pct": 50.0,
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
        assert created["sale_price_per_kg"] == 5596.5
        assert created["difficulty_pct"] == 150.0

        resp = await async_client.get("/api/v1/calculator/filaments/")
        assert len(resp.json()) == 1

    @pytest.mark.asyncio
    async def test_create_rejects_negative_cost(self, async_client):
        resp = await async_client.post("/api/v1/calculator/filaments/", json={**FILAMENT_PAYLOAD, "cost_per_kg": -5})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_create_rejects_negative_margin(self, async_client):
        """T-118: the write side must keep the ``ge=0`` bound even though the
        read side (``CalculatorFilamentBase``/``Response``) had to drop it to
        tolerate legacy rows backfilled outside [0, 1000]."""
        resp = await async_client.post("/api/v1/calculator/filaments/", json={**FILAMENT_PAYLOAD, "margin_pct": -0.01})
        assert resp.status_code == 422
        assert (await async_client.get("/api/v1/calculator/filaments/")).json() == []

    @pytest.mark.asyncio
    async def test_create_rejects_margin_above_1000(self, async_client):
        resp = await async_client.post(
            "/api/v1/calculator/filaments/", json={**FILAMENT_PAYLOAD, "margin_pct": 1000.01}
        )
        assert resp.status_code == 422
        assert (await async_client.get("/api/v1/calculator/filaments/")).json() == []

    @pytest.mark.asyncio
    async def test_update_rejects_negative_margin(self, async_client):
        created = (await async_client.post("/api/v1/calculator/filaments/", json=FILAMENT_PAYLOAD)).json()
        resp = await async_client.patch(f"/api/v1/calculator/filaments/{created['id']}", json={"margin_pct": -0.01})
        assert resp.status_code == 422
        row = (await async_client.get("/api/v1/calculator/filaments/")).json()[0]
        assert row["margin_pct"] == 50.0  # unchanged

    @pytest.mark.asyncio
    async def test_update_rejects_margin_above_1000(self, async_client):
        created = (await async_client.post("/api/v1/calculator/filaments/", json=FILAMENT_PAYLOAD)).json()
        resp = await async_client.patch(f"/api/v1/calculator/filaments/{created['id']}", json={"margin_pct": 1000.01})
        assert resp.status_code == 422
        row = (await async_client.get("/api/v1/calculator/filaments/")).json()[0]
        assert row["margin_pct"] == 50.0  # unchanged

    @pytest.mark.asyncio
    async def test_list_survives_a_legacy_row_with_an_out_of_range_margin(self, async_client, db_session):
        """T-118: a row backfilled with a margin outside [0, 1000] (e.g. a
        printing cost typed below the purchase cost, or a decimal-point slip)
        must not 500 the whole list. Inserted directly through the ORM,
        bypassing the write-side schema, the way a real pre-existing database
        row would already be sitting there before this fix.
        """
        from backend.app.models.calculator import CalculatorFilament

        healthy = CalculatorFilament(
            name="Healthy PLA",
            brand="",
            material="Healthy",
            cost_per_kg=25.0,
            sale_price_per_kg=37.5,
            margin_pct=50.0,
            difficulty_pct=100.0,
        )
        legacy_negative = CalculatorFilament(
            name="Legacy Cheap PLA",
            brand="",
            material="Legacy Cheap",
            cost_per_kg=25.0,
            sale_price_per_kg=20.0,
            margin_pct=-20.0,  # sale below cost
            difficulty_pct=100.0,
        )
        legacy_high = CalculatorFilament(
            name="Legacy Typo PETG",
            brand="",
            material="Legacy Typo",
            cost_per_kg=2.5,
            sale_price_per_kg=55.0,
            margin_pct=2100.0,  # decimal-point slip on cost
            difficulty_pct=100.0,
        )
        db_session.add_all([healthy, legacy_negative, legacy_high])
        await db_session.commit()

        resp = await async_client.get("/api/v1/calculator/filaments/")

        assert resp.status_code == 200
        margins = {row["material"]: row["margin_pct"] for row in resp.json()}
        assert margins == {
            "Healthy": 50.0,
            "Legacy Cheap": -20.0,
            "Legacy Typo": 2100.0,
        }

    @pytest.mark.asyncio
    async def test_create_rejects_infinite_cost(self, async_client):
        """``float("inf") > 0`` is True, so ``gt=0`` alone lets it through.

        Without the fix this used to return 200 with the row stored as inf
        and every later read serializing it back as ``null`` — silently
        breaking every downstream cost computation with no error anywhere.
        """
        resp = await _post_non_standard_json(
            async_client, "/api/v1/calculator/filaments/", {**FILAMENT_PAYLOAD, "cost_per_kg": float("inf")}
        )
        assert resp.status_code == 422
        assert (await async_client.get("/api/v1/calculator/filaments/")).json() == []

    @pytest.mark.asyncio
    async def test_create_rejects_negative_infinite_cost(self, async_client):
        resp = await _post_non_standard_json(
            async_client, "/api/v1/calculator/filaments/", {**FILAMENT_PAYLOAD, "cost_per_kg": float("-inf")}
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_create_rejects_nan_cost(self, async_client):
        resp = await _post_non_standard_json(
            async_client, "/api/v1/calculator/filaments/", {**FILAMENT_PAYLOAD, "cost_per_kg": float("nan")}
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("value", "expected_input"),
        [
            (float("inf"), "inf"),
            (float("-inf"), "-inf"),
            (float("nan"), "nan"),
        ],
    )
    async def test_non_finite_cost_response_is_strict_json(self, async_client, value, expected_input):
        """T-093: the 422 body for a non-finite value must be RFC 8259 JSON.

        Python's own ``json.dumps`` default (``allow_nan=True``) happily
        emits the bare ``Infinity``/``-Infinity``/``NaN`` literals, which are
        not valid JSON and make a strict parser (e.g. the frontend's
        ``response.json()``) throw. ``parse_constant`` is how ``json.loads``
        lets us reject those literals the way a strict RFC 8259 parser would;
        if the body still contains one, this raises before the assertions
        below ever run.
        """
        resp = await _post_non_standard_json(
            async_client, "/api/v1/calculator/filaments/", {**FILAMENT_PAYLOAD, "cost_per_kg": value}
        )
        assert resp.status_code == 422

        def _reject_non_finite_literal(token):
            raise AssertionError(f"strict JSON parse hit a bare non-finite literal: {token!r}")

        parsed = json.loads(resp.content, parse_constant=_reject_non_finite_literal)
        [error] = [e for e in parsed["detail"] if e["loc"][-1] == "cost_per_kg"]
        assert error["input"] == expected_input

    @pytest.mark.asyncio
    async def test_ordinary_validation_error_body_unchanged(self, async_client):
        """An everyday validation failure keeps the framework's exact shape."""
        resp = await async_client.post("/api/v1/calculator/filaments/", json={**FILAMENT_PAYLOAD, "cost_per_kg": -5})
        assert resp.status_code == 422
        assert resp.headers["content-type"] == "application/json"
        body = resp.json()
        [error] = [e for e in body["detail"] if e["loc"][-1] == "cost_per_kg"]
        assert error["input"] == -5
        assert error["type"] == "greater_than"
        # Compact, framework-standard separators — no re-encoding artifacts.
        assert b", " not in resp.content
        assert b": " not in resp.content

    @pytest.mark.asyncio
    async def test_create_rejects_cost_above_ceiling(self, async_client):
        """A finite-but-astronomical cost must not slip through either.

        ``derive_sale_price`` multiplies this by ``1 + margin_pct / 100``, so
        an unbounded finite value can still overflow to inf downstream even
        though ``allow_inf_nan=False`` alone would accept it.
        """
        resp = await async_client.post("/api/v1/calculator/filaments/", json={**FILAMENT_PAYLOAD, "cost_per_kg": 1e308})
        assert resp.status_code == 422
        assert (await async_client.get("/api/v1/calculator/filaments/")).json() == []

    @pytest.mark.asyncio
    async def test_create_rejects_cost_just_above_the_ceiling(self, async_client):
        """T-113: 1e308 alone can't distinguish _MONEY_CEILING's actual value
        (100_000_000.0) from any other large-but-finite ceiling — pin the
        boundary itself instead."""
        resp = await async_client.post(
            "/api/v1/calculator/filaments/", json={**FILAMENT_PAYLOAD, "cost_per_kg": 100_000_001.0}
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_create_accepts_cost_just_below_the_ceiling(self, async_client):
        resp = await async_client.post(
            "/api/v1/calculator/filaments/", json={**FILAMENT_PAYLOAD, "cost_per_kg": 99_999_999.0}
        )
        assert resp.status_code == 200
        assert resp.json()["cost_per_kg"] == 99_999_999.0

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
        # sale_price_per_kg is server-derived and no longer patchable directly;
        # exercise a field that is still a plain settable column.
        created = (await async_client.post("/api/v1/calculator/filaments/", json=FILAMENT_PAYLOAD)).json()
        resp = await async_client.patch(f"/api/v1/calculator/filaments/{created['id']}", json={"difficulty_pct": 200.0})
        assert resp.status_code == 200
        updated = resp.json()
        assert updated["difficulty_pct"] == 200.0
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
    async def test_update_rejects_infinite_cost(self, async_client):
        created = (await async_client.post("/api/v1/calculator/filaments/", json=FILAMENT_PAYLOAD)).json()
        resp = await _patch_non_standard_json(
            async_client, f"/api/v1/calculator/filaments/{created['id']}", {"cost_per_kg": float("inf")}
        )
        assert resp.status_code == 422
        # And the row is untouched, not silently poisoned.
        row = (await async_client.get("/api/v1/calculator/filaments/")).json()[0]
        assert row["cost_per_kg"] == 3731.0

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

    @pytest.mark.asyncio
    async def test_sale_price_is_derived_from_margin(self, async_client):
        resp = await async_client.post(
            "/api/v1/calculator/filaments/",
            json={"brand": "SUNLU", "material": "PETG", "cost_per_kg": 1000.0, "margin_pct": 75.0},
        )
        assert resp.status_code == 200
        assert resp.json()["sale_price_per_kg"] == 1750.0
        assert resp.json()["margin_pct"] == 75.0

    @pytest.mark.asyncio
    async def test_client_supplied_sale_price_is_ignored(self, async_client):
        """Printing cost is server-derived; a stale client value must not win."""
        resp = await async_client.post(
            "/api/v1/calculator/filaments/",
            json={
                "brand": "SUNLU",
                "material": "PETG",
                "cost_per_kg": 1000.0,
                "margin_pct": 50.0,
                "sale_price_per_kg": 99999.0,
            },
        )
        assert resp.status_code == 200
        assert resp.json()["sale_price_per_kg"] == 1500.0

    @pytest.mark.asyncio
    async def test_patching_cost_recomputes_sale_price(self, async_client):
        created = (
            await async_client.post(
                "/api/v1/calculator/filaments/",
                json={"brand": "SUNLU", "material": "PETG", "cost_per_kg": 1000.0, "margin_pct": 50.0},
            )
        ).json()
        resp = await async_client.patch(f"/api/v1/calculator/filaments/{created['id']}", json={"cost_per_kg": 2000.0})
        assert resp.status_code == 200
        assert resp.json()["sale_price_per_kg"] == 3000.0

    @pytest.mark.asyncio
    async def test_patching_margin_recomputes_sale_price(self, async_client):
        created = (
            await async_client.post(
                "/api/v1/calculator/filaments/",
                json={"brand": "SUNLU", "material": "PETG", "cost_per_kg": 1000.0, "margin_pct": 50.0},
            )
        ).json()
        resp = await async_client.patch(f"/api/v1/calculator/filaments/{created['id']}", json={"margin_pct": 0.0})
        assert resp.status_code == 200
        assert resp.json()["sale_price_per_kg"] == 1000.0
        assert resp.json()["margin_pct"] == 0.0

    @pytest.mark.asyncio
    async def test_zoho_link_round_trips(self, async_client):
        resp = await async_client.post(
            "/api/v1/calculator/filaments/",
            json={
                "brand": "Bambu Lab",
                "material": "ABS-GF",
                "cost_per_kg": 1866.0,
                "margin_pct": 25.0,
                "zoho_item_id": "66407000008022673",
                "zoho_item_name": "Bambu Lab - ABS-GF - Bleu (Blue) - 1.75mm - 1kg",
                "zoho_sku": "B50-B0-1.75-1000-SPL",
                "spool_weight_kg": 1.0,
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["zoho_item_id"] == "66407000008022673"
        assert body["zoho_item_name"] == "Bambu Lab - ABS-GF - Bleu (Blue) - 1.75mm - 1kg"
        assert body["zoho_sku"] == "B50-B0-1.75-1000-SPL"
        assert body["spool_weight_kg"] == 1.0
        assert body["sale_price_per_kg"] == 2332.5

    @pytest.mark.asyncio
    async def test_unlinking_clears_every_zoho_column(self, async_client):
        created = (
            await async_client.post(
                "/api/v1/calculator/filaments/",
                json={
                    "brand": "Bambu Lab",
                    "material": "ABS-GF",
                    "cost_per_kg": 1866.0,
                    "margin_pct": 25.0,
                    "zoho_item_id": "66407000008022673",
                    "zoho_item_name": "Bambu Lab - ABS-GF - Bleu (Blue) - 1.75mm - 1kg",
                    "zoho_sku": "B50-B0-1.75-1000-SPL",
                    "spool_weight_kg": 1.0,
                },
            )
        ).json()
        resp = await async_client.patch(
            f"/api/v1/calculator/filaments/{created['id']}",
            json={
                "zoho_item_id": None,
                "zoho_item_name": None,
                "zoho_sku": None,
                "spool_weight_kg": None,
            },
        )
        assert resp.status_code == 200
        assert resp.json()["zoho_item_id"] is None
        assert resp.json()["zoho_sku"] is None

    @pytest.mark.asyncio
    async def test_zero_spool_weight_is_rejected(self, async_client):
        """The UI must not be able to submit it; the API is the backstop."""
        resp = await async_client.post(
            "/api/v1/calculator/filaments/",
            json={**FILAMENT_PAYLOAD, "zoho_item_id": "1", "spool_weight_kg": 0},
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_create_rejects_denormal_spool_weight(self, async_client):
        """T-090: ``gt=0`` alone let a sub-gram denormal through.

        ``1e-307`` is greater than 0 but divides an ordinary dealer price into
        an astronomical (eventually overflowing) cost per kg downstream in the
        Zoho sync, so the create route must reject it outright rather than
        relying on the sync loop to catch the fallout later.
        """
        resp = await async_client.post(
            "/api/v1/calculator/filaments/",
            json={**FILAMENT_PAYLOAD, "zoho_item_id": "1", "spool_weight_kg": 1e-307},
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_update_rejects_denormal_spool_weight(self, async_client):
        create_resp = await async_client.post("/api/v1/calculator/filaments/", json=FILAMENT_PAYLOAD)
        filament_id = create_resp.json()["id"]
        resp = await async_client.patch(
            f"/api/v1/calculator/filaments/{filament_id}",
            json={"spool_weight_kg": 1e-307},
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_seeded_example_filament_satisfies_the_derived_sale_invariant(self, async_client):
        """A fresh install must not ship a row that already breaks the invariant.

        The seed writes ``sale_price_per_kg`` directly (it builds the ORM object
        rather than going through the create route), so nothing else enforces
        ``sale == round(cost * (1 + margin/100), 2)`` for it. 3731 at the
        default 50% margin is 5596.5, not the 5597 that was originally typed.
        """
        from backend.app.api.routes.calculator import derive_sale_price
        from backend.app.core.database import seed_calculator_defaults

        await seed_calculator_defaults()

        rows = (await async_client.get("/api/v1/calculator/filaments/")).json()
        assert rows, "the seed should have created the example filament"
        for row in rows:
            assert row["sale_price_per_kg"] == derive_sale_price(row["cost_per_kg"], row["margin_pct"])


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
    async def test_create_rejects_infinite_purchase_price(self, async_client):
        resp = await _post_non_standard_json(
            async_client, "/api/v1/calculator/printers/", {**PRINTER_PAYLOAD, "purchase_price": float("inf")}
        )
        assert resp.status_code == 422
        assert (await async_client.get("/api/v1/calculator/printers/")).json() == []

    @pytest.mark.asyncio
    async def test_create_rejects_infinite_power_watts(self, async_client):
        resp = await _post_non_standard_json(
            async_client, "/api/v1/calculator/printers/", {**PRINTER_PAYLOAD, "power_watts": float("inf")}
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_create_rejects_purchase_price_above_ceiling(self, async_client):
        resp = await async_client.post(
            "/api/v1/calculator/printers/", json={**PRINTER_PAYLOAD, "purchase_price": 1e308}
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_create_rejects_purchase_price_just_above_the_ceiling(self, async_client):
        """T-113: pins _MONEY_CEILING's actual value; 1e308 alone rejects any
        large-but-finite ceiling and can't distinguish it from a much looser one."""
        resp = await async_client.post(
            "/api/v1/calculator/printers/", json={**PRINTER_PAYLOAD, "purchase_price": 100_000_001.0}
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_create_accepts_purchase_price_just_below_the_ceiling(self, async_client):
        resp = await async_client.post(
            "/api/v1/calculator/printers/", json={**PRINTER_PAYLOAD, "purchase_price": 99_999_999.0}
        )
        assert resp.status_code == 200
        assert resp.json()["purchase_price"] == 99_999_999.0

    @pytest.mark.asyncio
    async def test_update_rejects_infinite_purchase_price(self, async_client):
        created = (await async_client.post("/api/v1/calculator/printers/", json=PRINTER_PAYLOAD)).json()
        resp = await _patch_non_standard_json(
            async_client, f"/api/v1/calculator/printers/{created['id']}", {"purchase_price": float("inf")}
        )
        assert resp.status_code == 422
        row = (await async_client.get("/api/v1/calculator/printers/")).json()[0]
        assert row["purchase_price"] == 347000.0

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
        assert defaults["margin_min_mult"] == 1.15
        assert defaults["margin_max_mult"] == 1.6
        assert defaults["margin_k"] == 33.0
        assert defaults["qty_min_factor"] == 0.4
        assert defaults["qty_k"] == 5.0
        assert defaults["min_task_price"] == 12.0

    @pytest.mark.asyncio
    async def test_patch_curve_fields_round_trip(self, async_client):
        payload = {
            "margin_min_mult": 1.2,
            "margin_max_mult": 1.8,
            "margin_k": 4000.0,
            "qty_min_factor": 0.5,
            "qty_k": 8.0,
            "min_task_price": 1400.0,
        }
        resp = await async_client.patch("/api/v1/calculator/defaults", json=payload)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        for key, value in payload.items():
            assert body[key] == value
        resp = await async_client.get("/api/v1/calculator/defaults")
        assert resp.json()["margin_k"] == 4000.0

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("field", "value"),
        [
            ("margin_min_mult", 0.99),
            ("margin_max_mult", 0.99),
            ("margin_min_mult", 101),
            ("margin_k", 0),
            ("margin_k", -1),
            ("qty_min_factor", 0),
            ("qty_min_factor", 1.01),
            ("qty_k", 0),
            ("min_task_price", -1),
        ],
    )
    async def test_patch_rejects_out_of_range_curve_values(self, async_client, field, value):
        resp = await async_client.patch("/api/v1/calculator/defaults", json={field: value})
        assert resp.status_code == 422, resp.text

    @pytest.mark.asyncio
    async def test_patch_rejects_inverted_pair_sent_together(self, async_client):
        resp = await async_client.patch(
            "/api/v1/calculator/defaults", json={"margin_min_mult": 1.5, "margin_max_mult": 1.2}
        )
        assert resp.status_code == 422
        assert "margin_max_mult" in resp.text

    @pytest.mark.asyncio
    async def test_patch_rejects_inverted_pair_against_stored_row(self, async_client):
        # Stored: min 1.15 / max 1.6. Raising min above the stored max alone must fail.
        resp = await async_client.patch("/api/v1/calculator/defaults", json={"margin_min_mult": 1.7})
        assert resp.status_code == 422
        # And lowering max below the stored min alone must fail.
        resp = await async_client.patch("/api/v1/calculator/defaults", json={"margin_max_mult": 1.1})
        assert resp.status_code == 422
        # Equal is allowed (a flat margin).
        resp = await async_client.patch("/api/v1/calculator/defaults", json={"margin_max_mult": 1.15})
        assert resp.status_code == 200, resp.text
        # Nothing was persisted by the rejected calls.
        body = (await async_client.get("/api/v1/calculator/defaults")).json()
        assert body["margin_min_mult"] == 1.15
        assert body["margin_max_mult"] == 1.15

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

    @pytest.mark.asyncio
    async def test_patch_rejects_infinite_electricity_tariff(self, async_client):
        resp = await _patch_non_standard_json(
            async_client, "/api/v1/calculator/defaults", {"electricity_tariff": float("inf")}
        )
        assert resp.status_code == 422
        assert (await async_client.get("/api/v1/calculator/defaults")).json()["electricity_tariff"] == 120.0

    @pytest.mark.asyncio
    async def test_patch_rejects_electricity_tariff_above_ceiling(self, async_client):
        resp = await async_client.patch("/api/v1/calculator/defaults", json={"electricity_tariff": 1e308})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_patch_rejects_electricity_tariff_just_above_the_ceiling(self, async_client):
        """T-113: pins _MONEY_CEILING's actual value (100_000_000.0) rather
        than merely confirming SOME finite ceiling exists."""
        resp = await async_client.patch("/api/v1/calculator/defaults", json={"electricity_tariff": 100_000_001.0})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_patch_accepts_electricity_tariff_just_below_the_ceiling(self, async_client):
        resp = await async_client.patch("/api/v1/calculator/defaults", json={"electricity_tariff": 99_999_999.0})
        assert resp.status_code == 200
        assert resp.json()["electricity_tariff"] == 99_999_999.0

    @pytest.mark.asyncio
    async def test_patch_rejects_infinite_labor_rate(self, async_client):
        resp = await _patch_non_standard_json(
            async_client, "/api/v1/calculator/defaults", {"labor_rate_per_hour": float("inf")}
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_patch_rejects_infinite_consumables_packaging_flat(self, async_client):
        resp = await _patch_non_standard_json(
            async_client, "/api/v1/calculator/defaults", {"consumables_packaging_flat": float("inf")}
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_patch_rejects_infinite_base_fee_flat(self, async_client):
        resp = await _patch_non_standard_json(
            async_client, "/api/v1/calculator/defaults", {"base_fee_flat": float("inf")}
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_get_recovers_from_concurrent_first_insert_race(self, async_client, db_session):
        """Exercise ``_get_or_create_defaults``'s loser-of-the-race branch.

        Simulates two concurrent first requests: a "winner" row for id=1 is
        already committed in the database (as if another request's insert won
        the race), but this request's own initial lookup is intercepted to
        look empty -- forcing it down the create branch just like it would be
        if the row genuinely did not exist yet when that lookup ran. Its
        subsequent INSERT then hits the REAL primary-key constraint (no
        mocking of the commit/IntegrityError itself), and the handler must
        catch it, roll back, and re-read -- returning the winner's actual row
        (recognizable by its distinctive tax_pct) rather than raising or
        fabricating a fresh empty-defaults row.
        """
        from unittest.mock import patch

        from sqlalchemy.ext.asyncio import AsyncSession

        from backend.app.models.calculator import CalculatorDefaults

        # The "other" concurrent request's winning row -- a value no fresh
        # CalculatorDefaults() would ever produce (default tax_pct is 13.0),
        # so a distinct value in the response proves we got THIS row back.
        db_session.add(CalculatorDefaults(id=1, tax_pct=17.75))
        await db_session.commit()

        real_execute = AsyncSession.execute
        state = {"intercepted": False}

        async def flaky_execute(self, statement, *args, **kwargs):
            sql = str(statement).lower()
            if not state["intercepted"] and "calculator_defaults" in sql and "insert" not in sql:
                state["intercepted"] = True

                class _EmptyResult:
                    def scalar_one_or_none(self_inner):
                        return None

                return _EmptyResult()
            return await real_execute(self, statement, *args, **kwargs)

        with patch.object(AsyncSession, "execute", flaky_execute):
            resp = await async_client.get("/api/v1/calculator/defaults")

        assert state["intercepted"], "the initial lookup was never reached -- test setup is stale"
        assert resp.status_code == 200
        body = resp.json()
        assert body["id"] == 1
        assert body["tax_pct"] == 17.75
