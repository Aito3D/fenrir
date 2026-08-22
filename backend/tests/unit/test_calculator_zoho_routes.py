"""Tests for the calculator's Zoho filament search endpoint."""

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
