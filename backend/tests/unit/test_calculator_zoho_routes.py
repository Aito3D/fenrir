"""Tests for the calculator's Zoho filament search endpoint."""

import logging
from unittest.mock import patch

import pytest

from backend.app.services import zoho_filaments
from backend.app.services.zoho import zoho_service
from backend.app.services.zoho_filaments import FilamentProduct

CATALOGUE = [
    FilamentProduct(
        item_id="66407000008022673",
        name="Bambu Lab - ABS-GF - Bleu (Blue) - 1.75mm - 1kg",
        sku="B50-B0-1.75-1000-SPL",
        brand="Bambu Lab",
        material="ABS-GF",
        colour="Bleu (Blue)",
        spool_weight_kg=1.0,
        weight_inferred=False,
        dealer_price=1866.0,
        cost_per_kg=1866.0,
        has_price=True,
    ),
    FilamentProduct(
        item_id="66407000008023724",
        name="Bambu Lab - ABS-GF - Blanc (White) - 1.75mm - 1kg",
        sku="B50-W0-1.75-1000-SPL",
        brand="Bambu Lab",
        material="ABS-GF",
        colour="Blanc (White)",
        spool_weight_kg=1.0,
        weight_inferred=False,
        dealer_price=0.0,
        cost_per_kg=0.0,
        has_price=False,
    ),
]


@pytest.fixture
def zoho_ready(monkeypatch):
    async def configured(db):
        return True

    async def catalogue(db, *, refresh=True):
        return CATALOGUE

    monkeypatch.setattr(zoho_service, "is_configured", configured)
    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", catalogue)


@pytest.mark.asyncio
async def test_search_returns_mapped_products(async_client, zoho_ready):
    resp = await async_client.get("/api/v1/calculator/zoho-filaments", params={"q": "abs-gf bleu"})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["item_id"] == "66407000008022673"
    assert body[0]["brand"] == "Bambu Lab"
    assert body[0]["material"] == "ABS-GF"
    assert body[0]["colour"] == "Bleu (Blue)"
    assert body[0]["cost_per_kg"] == 1866.0
    assert body[0]["has_price"] is True
    assert body[0]["spool_weight_kg"] == 1.0
    assert body[0]["weight_inferred"] is False


@pytest.mark.asyncio
async def test_zero_priced_products_are_returned_but_flagged(async_client, zoho_ready):
    """They stay searchable so a product can be linked before Zoho is filled in."""
    resp = await async_client.get("/api/v1/calculator/zoho-filaments", params={"q": "blanc"})
    assert resp.status_code == 200
    assert resp.json()[0]["has_price"] is False
    assert resp.json()[0]["cost_per_kg"] == 0.0


@pytest.mark.asyncio
async def test_search_is_unavailable_when_zoho_is_not_configured(async_client, monkeypatch):
    async def unconfigured(db):
        return False

    monkeypatch.setattr(zoho_service, "is_configured", unconfigured)
    resp = await async_client.get("/api/v1/calculator/zoho-filaments", params={"q": "pla"})
    assert resp.status_code == 503


@pytest.mark.asyncio
async def test_upstream_failure_is_reported_as_bad_gateway(async_client, monkeypatch):
    async def configured(db):
        return True

    async def boom(db, *, refresh=True):
        raise RuntimeError("zoho down")

    monkeypatch.setattr(zoho_service, "is_configured", configured)
    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", boom)
    resp = await async_client.get("/api/v1/calculator/zoho-filaments", params={"q": "pla"})
    assert resp.status_code == 502


# --- T-074: distinguish an unreachable Zoho from a mapping bug ---------------


@pytest.mark.asyncio
async def test_upstream_failure_logs_a_stack_trace(async_client, monkeypatch, caplog):
    """The 502 path must log with exc_info=True — a one-line warning with no
    stack is the only trace an operator gets otherwise."""

    async def configured(db):
        return True

    async def boom(db, *, refresh=True):
        raise RuntimeError("zoho down")

    monkeypatch.setattr(zoho_service, "is_configured", configured)
    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", boom)

    with caplog.at_level(logging.WARNING, logger="backend.app.api.routes.calculator"):
        resp = await async_client.get("/api/v1/calculator/zoho-filaments", params={"q": "pla"})

    assert resp.status_code == 502
    assert resp.json()["detail"] == "Could not reach Zoho"
    records = [r for r in caplog.records if r.name == "backend.app.api.routes.calculator"]
    assert records, "expected the route to log the failure"
    assert records[-1].exc_info is not None


@pytest.mark.asyncio
async def test_mapping_failure_is_reported_as_internal_server_error(async_client, monkeypatch, caplog):
    """A ZohoFilamentMappingError (a programming/mapping bug, not an
    unreachable Zoho) must surface as a 500 with a detail distinct from the
    "Could not reach Zoho" 502 — folding it into the latter tells the
    operator the network is down when Zoho is actually fine."""

    async def configured(db):
        return True

    async def boom(db, *, refresh=True):
        raise zoho_filaments.ZohoFilamentMappingError("none of the 3 active items could be mapped")

    monkeypatch.setattr(zoho_service, "is_configured", configured)
    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", boom)

    with caplog.at_level(logging.ERROR, logger="backend.app.api.routes.calculator"):
        resp = await async_client.get("/api/v1/calculator/zoho-filaments", params={"q": "pla"})

    assert resp.status_code == 500
    assert resp.json()["detail"] != "Could not reach Zoho"
    records = [r for r in caplog.records if r.name == "backend.app.api.routes.calculator"]
    assert records, "expected the route to log the failure"
    assert records[-1].exc_info is not None


@pytest.mark.asyncio
async def test_truncated_catalogue_is_still_reported_as_bad_gateway_not_internal_error(async_client, monkeypatch):
    """T-073's approved contract: a catalogue truncated at _MAX_PAGES must
    keep returning 502, never get folded into T-074's new 500 branch. Runs
    through the REAL fetch_catalogue (not a route-level stub) so this proves
    the actual exception _MAX_PAGES raises today is still routed to 502."""

    async def configured(db):
        return True

    async def always_more_page(db, *, category, page, per_page):
        item = {
            "item_id": f"item-{page}",
            "name": "Bambu Lab - PLA - X - 1.75mm - 1kg",
            "sku": "SKU",
            "brand": "Bambu Lab",
            "status": "active",
            "cf_nature_du_produit": "Filaments",
            "cf_prix_dealer_usd_unformatted": 100.0,
        }
        return [item], True  # never signals has_more=False

    monkeypatch.setattr(zoho_service, "is_configured", configured)
    monkeypatch.setattr(zoho_service, "list_items_page", always_more_page)
    monkeypatch.setattr(zoho_filaments, "_MAX_PAGES", 1)
    zoho_filaments.reset_cache()
    try:
        resp = await async_client.get("/api/v1/calculator/zoho-filaments", params={"q": "pla"})
        assert resp.status_code == 502
        assert resp.json()["detail"] == "Could not reach Zoho"
    finally:
        zoho_filaments.reset_cache()


@pytest.mark.asyncio
async def test_mapping_failure_from_the_real_service_is_reported_as_internal_server_error(async_client, monkeypatch):
    """T-101: the 500-vs-502 split above (test_mapping_failure_is_reported_as_
    internal_server_error) only proves the route trusts whatever exception
    type it's handed — it stubs fetch_catalogue itself, so it would pass just
    as well if the real service never raised ZohoFilamentMappingError at all.
    This stubs only list_items_page (the real fetch_catalogue does the actual
    mapping and decides what to raise), the same way the truncation test
    above proves the 502 direction through the real service."""

    async def configured(db):
        return True

    async def all_malformed_page(db, *, category, page, per_page):
        item = {
            "item_id": "item-1",
            "name": "Bambu Lab - PLA - X - 1.75mm - 1kg",
            "sku": "SKU",
            "brand": "Bambu Lab",
            "status": "active",
            "cf_nature_du_produit": "Filaments",
            "cf_prix_dealer_usd_unformatted": "not-a-number",  # forces _map_item to raise
        }
        return [item], False

    monkeypatch.setattr(zoho_service, "is_configured", configured)
    monkeypatch.setattr(zoho_service, "list_items_page", all_malformed_page)
    zoho_filaments.reset_cache()
    try:
        resp = await async_client.get("/api/v1/calculator/zoho-filaments", params={"q": "pla"})
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Zoho filament catalogue could not be mapped"
    finally:
        zoho_filaments.reset_cache()


class TestZohoFilamentSearchRequiresCalculatorUpdate:
    """T-068: this endpoint returns Zoho's confidential dealer pricing, so it must
    require calculator:update (the same permission every other mutation on this
    router uses), not calculator:read — the default Viewers role only holds the
    latter and must not be able to enumerate the supplier catalogue.
    """

    @pytest.fixture
    async def calculator_read_only_setup(self):
        """Create a user with calculator:read but NOT calculator:update, return JWT."""
        from backend.app.core.auth import create_access_token, get_password_hash
        from backend.app.core.database import async_session
        from backend.app.models.group import Group
        from backend.app.models.user import User

        async with async_session() as db:
            group = Group(name="CalcReadOnly", permissions=["calculator:read"])
            db.add(group)
            user = User(
                username="calcreaduser",
                password_hash=get_password_hash("testpass123"),
                role="user",
            )
            db.add(user)
            await db.commit()
            await db.refresh(group)
            await db.refresh(user)

            from sqlalchemy import text

            await db.execute(
                text("INSERT INTO user_groups (user_id, group_id) VALUES (:uid, :gid)"),
                {"uid": user.id, "gid": group.id},
            )
            await db.commit()

        return create_access_token(data={"sub": "calcreaduser"})

    @pytest.fixture
    async def calculator_update_setup(self):
        """Create a user with calculator:update, return JWT."""
        from backend.app.core.auth import create_access_token, get_password_hash
        from backend.app.core.database import async_session
        from backend.app.models.group import Group
        from backend.app.models.user import User

        async with async_session() as db:
            group = Group(name="CalcUpdate", permissions=["calculator:update"])
            db.add(group)
            user = User(
                username="calcupdateuser",
                password_hash=get_password_hash("testpass123"),
                role="user",
            )
            db.add(user)
            await db.commit()
            await db.refresh(group)
            await db.refresh(user)

            from sqlalchemy import text

            await db.execute(
                text("INSERT INTO user_groups (user_id, group_id) VALUES (:uid, :gid)"),
                {"uid": user.id, "gid": group.id},
            )
            await db.commit()

        return create_access_token(data={"sub": "calcupdateuser"})

    @pytest.mark.asyncio
    async def test_calculator_read_only_caller_gets_403(self, async_client, zoho_ready, calculator_read_only_setup):
        with patch("backend.app.core.auth.is_auth_enabled", return_value=True):
            resp = await async_client.get(
                "/api/v1/calculator/zoho-filaments",
                params={"q": "pla"},
                headers={"Authorization": f"Bearer {calculator_read_only_setup}"},
            )
        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_calculator_update_caller_gets_200(self, async_client, zoho_ready, calculator_update_setup):
        with patch("backend.app.core.auth.is_auth_enabled", return_value=True):
            resp = await async_client.get(
                "/api/v1/calculator/zoho-filaments",
                params={"q": "pla"},
                headers={"Authorization": f"Bearer {calculator_update_setup}"},
            )
        assert resp.status_code == 200
