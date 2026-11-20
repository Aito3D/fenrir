"""Spool catalog, colour catalog, SKU settings and shopping-list routes (T-708).

Covers the destructive and CRUD routes that had no test: permission denial for a
read-only user, reset re-seeding defaults, bulk-delete touching listed ids only,
the FilamentColors sync stream (HTTP stubbed) and the shopping-list round trip.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.core.catalog_defaults import DEFAULT_COLOR_CATALOG, DEFAULT_SPOOL_CATALOG
from backend.app.models.color_catalog import ColorCatalogEntry
from backend.app.models.spool_catalog import SpoolCatalogEntry

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

BASE = "/api/v1/inventory"


async def _login(client: AsyncClient, username: str, password: str) -> dict[str, str]:
    login = await client.post("/api/v1/auth/login", json={"username": username, "password": password})
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


async def _admin_and_reader(client: AsyncClient) -> tuple[dict[str, str], dict[str, str]]:
    await client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": "invadmin", "admin_password": "AdminPass1!"},
    )
    admin = await _login(client, "invadmin", "AdminPass1!")
    group = await client.post(
        "/api/v1/groups/", headers=admin, json={"name": "invread", "permissions": ["inventory:read"]}
    )
    await client.post(
        "/api/v1/users/",
        headers=admin,
        json={"username": "invreader", "password": "UserPass1!", "group_ids": [group.json()["id"]]},
    )
    return admin, await _login(client, "invreader", "UserPass1!")


async def test_write_routes_denied_for_read_only_user(async_client: AsyncClient):
    _, reader = await _admin_and_reader(async_client)
    calls = [
        ("post", "/catalog", {"name": "x", "weight": 100}),
        ("put", "/catalog/1", {"name": "x", "weight": 100}),
        ("delete", "/catalog/1", None),
        ("post", "/catalog/bulk-delete", {"ids": [1]}),
        ("post", "/catalog/reset", None),
        ("post", "/colors/bulk-delete", {"ids": [1]}),
        ("post", "/colors/reset", None),
        ("post", "/colors/sync", None),
        ("post", "/sku-settings", {"material": "PLA"}),
        ("post", "/shopping-list", {"material": "PLA"}),
        ("patch", "/shopping-list/1/status", {"status": "purchased"}),
        ("delete", "/shopping-list/1", None),
        ("delete", "/shopping-list", None),
    ]
    for method, path, body in calls:
        kwargs = {"headers": reader}
        if body is not None:
            kwargs["json"] = body
        response = await async_client.request(method.upper(), BASE + path, **kwargs)
        assert response.status_code == 403, (method, path, response.text)
    # A reader may still read.
    assert (await async_client.get(f"{BASE}/catalog", headers=reader)).status_code == 200


async def test_spool_catalog_crud_and_bulk_delete(async_client: AsyncClient):
    ids = []
    for name in ("A spool", "B spool", "C spool"):
        r = await async_client.post(f"{BASE}/catalog", json={"name": name, "weight": 250})
        assert r.status_code == 200, r.text
        assert r.json()["is_default"] is False
        ids.append(r.json()["id"])

    upd = await async_client.put(f"{BASE}/catalog/{ids[0]}", json={"name": "A renamed", "weight": 300})
    assert (upd.json()["name"], upd.json()["weight"]) == ("A renamed", 300)
    assert (await async_client.put(f"{BASE}/catalog/999999", json={"name": "n", "weight": 1})).status_code == 404

    assert (await async_client.delete(f"{BASE}/catalog/{ids[1]}")).json() == {"status": "deleted"}
    assert (await async_client.delete(f"{BASE}/catalog/{ids[1]}")).status_code == 404

    assert (await async_client.post(f"{BASE}/catalog/bulk-delete", json={"ids": []})).json() == {"deleted": 0}
    other = await async_client.post(f"{BASE}/catalog", json={"name": "Keep", "weight": 1})
    resp = await async_client.post(f"{BASE}/catalog/bulk-delete", json={"ids": [ids[0], ids[2], 999999]})
    assert resp.json() == {"deleted": 2}
    names = [e["name"] for e in (await async_client.get(f"{BASE}/catalog")).json()]
    assert "Keep" in names and "A renamed" not in names and "C spool" not in names
    assert other.json()["id"] not in (ids[0], ids[2])


async def test_spool_catalog_reset_reseeds_defaults(async_client: AsyncClient, db_session):
    await async_client.post(f"{BASE}/catalog", json={"name": "Custom only", "weight": 42})
    assert (await async_client.post(f"{BASE}/catalog/reset")).json() == {"status": "reset"}
    rows = (await db_session.execute(select(SpoolCatalogEntry))).scalars().all()
    assert len(rows) == len(DEFAULT_SPOOL_CATALOG)
    assert all(r.is_default for r in rows)
    assert "Custom only" not in {r.name for r in rows}


async def test_color_catalog_delete_bulk_and_reset(async_client: AsyncClient, db_session):
    ids = []
    for i in range(3):
        r = await async_client.post(
            f"{BASE}/colors",
            json={"manufacturer": "Cust", "color_name": f"C{i}", "hex_color": "#00000" + str(i), "material": "PLA"},
        )
        assert r.status_code == 200, r.text
        ids.append(r.json()["id"])

    assert (await async_client.delete(f"{BASE}/colors/{ids[0]}")).json() == {"status": "deleted"}
    assert (await async_client.delete(f"{BASE}/colors/{ids[0]}")).status_code == 404
    assert (
        await async_client.put(
            f"{BASE}/colors/999999",
            json={"manufacturer": "m", "color_name": "c", "hex_color": "#000000", "material": "PLA"},
        )
    ).status_code == 404

    assert (await async_client.post(f"{BASE}/colors/bulk-delete", json={"ids": []})).json() == {"deleted": 0}
    assert (await async_client.post(f"{BASE}/colors/bulk-delete", json={"ids": [ids[1], 999999]})).json() == {
        "deleted": 1
    }
    left = (await db_session.execute(select(ColorCatalogEntry.id).where(ColorCatalogEntry.id.in_(ids)))).scalars()
    assert list(left) == [ids[2]]

    assert (await async_client.post(f"{BASE}/colors/reset")).json() == {"status": "reset"}
    db_session.expire_all()
    rows = (await db_session.execute(select(ColorCatalogEntry))).scalars().all()
    assert len(rows) == len(DEFAULT_COLOR_CATALOG)
    assert all(r.is_default for r in rows)
    assert all(r.manufacturer != "Cust" for r in rows)


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


def _fake_httpx(pages=None, error=None):
    class FakeClient:
        def __init__(self, *a, **kw):
            self.calls = 0

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, params=None):
            if error:
                raise error
            self.calls += 1
            return _FakeResponse(pages[params["page"] - 1])

    return SimpleNamespace(AsyncClient=FakeClient, HTTPError=httpx.HTTPError)


def _events(text: str) -> list[dict]:
    return [json.loads(line[6:]) for line in text.splitlines() if line.startswith("data: ")]


async def test_sync_from_filamentcolors_adds_and_skips(async_client: AsyncClient, monkeypatch):
    swatch = {
        "manufacturer": {"name": "SyncCo"},
        "filament_type": {"name": "PLA"},
        "color_name": "Sync Red",
        "hex_color": "ff0000",
    }
    pages = [
        {"count": 3, "next": "p2", "results": [swatch, {"manufacturer": None, "color_name": "x", "hex_color": "1"}]},
        {"count": 3, "next": None, "results": [swatch]},
    ]
    monkeypatch.setattr("backend.app.api.routes.inventory.httpx", _fake_httpx(pages))
    response = await async_client.post(f"{BASE}/colors/sync")
    events = _events(response.text)
    assert events[-1] == {"type": "complete", "added": 1, "skipped": 2, "total_fetched": 3, "total_available": 3}
    colors = (await async_client.get(f"{BASE}/colors")).json()
    assert [c["hex_color"] for c in colors if c["manufacturer"] == "SyncCo"] == ["#FF0000"]


async def test_sync_from_filamentcolors_reports_errors(async_client: AsyncClient, monkeypatch):
    monkeypatch.setattr("backend.app.api.routes.inventory.httpx", _fake_httpx(error=httpx.ConnectError("down")))
    events = _events((await async_client.post(f"{BASE}/colors/sync")).text)
    assert events[-1]["type"] == "error" and "down" in events[-1]["error"]

    monkeypatch.setattr("backend.app.api.routes.inventory.httpx", _fake_httpx(error=ValueError("boom")))
    events = _events((await async_client.post(f"{BASE}/colors/sync")).text)
    assert events[-1] == {"type": "error", "error": "Unexpected error during sync"}


async def test_sku_settings_upsert_updates_same_sku(async_client: AsyncClient):
    body = {"material": "PLA", "subtype": "Basic", "brand": "Bambu", "color_name": "Red", "lead_time_days": 3}
    first = await async_client.post(f"{BASE}/sku-settings", json=body)
    assert first.status_code == 200, first.text
    second = await async_client.post(f"{BASE}/sku-settings", json={**body, "lead_time_days": 9, "alerts_snoozed": True})
    assert second.json()["id"] == first.json()["id"]
    assert (second.json()["lead_time_days"], second.json()["alerts_snoozed"]) == (9, True)
    assert len((await async_client.get(f"{BASE}/sku-settings")).json()) == 1


async def test_shopping_list_round_trip(async_client: AsyncClient):
    a = (await async_client.post(f"{BASE}/shopping-list", json={"material": "PLA", "quantity_spools": 2})).json()
    b = (await async_client.post(f"{BASE}/shopping-list", json={"material": "PETG", "note": "n"})).json()
    assert (a["status"], a["purchased_at"], a["quantity_spools"]) == ("pending", None, 2)

    bad = await async_client.patch(f"{BASE}/shopping-list/{a['id']}/status", json={"status": "nope"})
    assert bad.status_code == 400
    missing = await async_client.patch(f"{BASE}/shopping-list/999999/status", json={"status": "received"})
    assert missing.status_code == 404

    bought = await async_client.patch(f"{BASE}/shopping-list/{a['id']}/status", json={"status": "purchased"})
    stamp = bought.json()["purchased_at"]
    assert bought.json()["status"] == "purchased" and stamp
    received = await async_client.patch(f"{BASE}/shopping-list/{a['id']}/status", json={"status": "received"})
    assert received.json()["purchased_at"] == stamp  # first purchase time is kept
    back = await async_client.patch(f"{BASE}/shopping-list/{a['id']}/status", json={"status": "pending"})
    assert back.json()["purchased_at"] is None

    assert len((await async_client.get(f"{BASE}/shopping-list")).json()) == 2
    assert (await async_client.delete(f"{BASE}/shopping-list/{b['id']}")).json() == {"status": "deleted"}
    assert (await async_client.delete(f"{BASE}/shopping-list/{b['id']}")).status_code == 404
    assert (await async_client.delete(f"{BASE}/shopping-list")).json() == {"deleted": 1}
    assert (await async_client.get(f"{BASE}/shopping-list")).json() == []
