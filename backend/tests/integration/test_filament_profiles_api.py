"""Integration tests for /api/v1/filament-profiles CRUD."""

import pytest
from httpx import AsyncClient


def preset_payload(**kw):
    base = {
        "name": "SUNLU PETG - Magenta",
        "brand": "SUNLU",
        "material": "PETG",
        "color": "Magenta",
        "color_hex": "#ff00ff",
        "filename": "SUNLU PETG - Magenta.json",
        "content": "{}",
    }
    base.update(kw)
    return base


class TestFilamentProfilesCrud:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_create_and_list_sorted(self, async_client: AsyncClient):
        await async_client.post("/api/v1/filament-profiles", json=preset_payload(name="Zeta"))
        await async_client.post("/api/v1/filament-profiles", json=preset_payload(name="Alpha"))
        r = await async_client.get("/api/v1/filament-profiles")
        assert r.status_code == 200
        names = [p["name"] for p in r.json()]
        assert names == sorted(names) and "Alpha" in names

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_create_defaults_absent_fields_to_empty(self, async_client: AsyncClient):
        r = await async_client.post("/api/v1/filament-profiles", json={"name": "Only Name"})
        assert r.status_code == 200
        body = r.json()
        assert body["brand"] == "" and body["content"] == "" and body["id"] > 0
        assert body["created_at"] is not None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_patch_is_partial_and_touches_updated_at(self, async_client: AsyncClient):
        created = (await async_client.post("/api/v1/filament-profiles", json=preset_payload())).json()
        r = await async_client.patch(f"/api/v1/filament-profiles/{created['id']}", json={"brand": "eSUN"})
        assert r.status_code == 200
        body = r.json()
        assert body["brand"] == "eSUN" and body["name"] == created["name"]
        assert body["updated_at"] >= created["updated_at"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_patch_missing_404(self, async_client: AsyncClient):
        assert (await async_client.patch("/api/v1/filament-profiles/99999", json={"name": "x"})).status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_delete_idempotent(self, async_client: AsyncClient):
        created = (await async_client.post("/api/v1/filament-profiles", json=preset_payload())).json()
        assert (await async_client.delete(f"/api/v1/filament-profiles/{created['id']}")).json() == {"success": True}
        assert (await async_client.delete(f"/api/v1/filament-profiles/{created['id']}")).json() == {"success": True}

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_duplicate_appends_copie(self, async_client: AsyncClient):
        created = (await async_client.post("/api/v1/filament-profiles", json=preset_payload())).json()
        r = await async_client.post(f"/api/v1/filament-profiles/{created['id']}/duplicate")
        assert r.status_code == 200
        dup = r.json()
        assert dup["name"] == created["name"] + " (copie)" and dup["id"] != created["id"]
        assert dup["content"] == created["content"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_duplicate_missing_404(self, async_client: AsyncClient):
        assert (await async_client.post("/api/v1/filament-profiles/99999/duplicate")).status_code == 404
