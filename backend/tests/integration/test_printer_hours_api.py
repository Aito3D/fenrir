"""Integration tests for /api/v1/maintenance/hours (Maintenance → Hours tab)."""

from datetime import date, timedelta

import pytest
from httpx import AsyncClient

from backend.app.models.maintenance import HourMachine

BASE = "/api/v1/maintenance/hours"


async def _machine_for(async_client: AsyncClient, name: str) -> dict:
    data = (await async_client.get(BASE)).json()
    return next(m for m in data["machines"] if m["name"] == name)


@pytest.mark.asyncio
@pytest.mark.integration
class TestHoursRead:
    async def test_overview_lists_printers_with_live_counter(self, async_client: AsyncClient, printer_factory):
        await printer_factory(name="X1C04", model="X1C", runtime_seconds=3600 * 124, print_hours_offset=10.0)
        response = await async_client.get(BASE)
        assert response.status_code == 200
        data = response.json()
        assert data["today"] == date.today().isoformat()
        [m] = data["machines"]
        assert (m["name"], m["model"], m["retired"], m["current_hours"]) == ("X1C04", "X1C", False, 134.0)
        assert data["readings"] == []


@pytest.mark.asyncio
@pytest.mark.integration
class TestHoursSave:
    async def test_backdated_reading_is_stored_without_recalibrating(
        self, async_client: AsyncClient, printer_factory, db_session
    ):
        p = await printer_factory(name="X1C05", runtime_seconds=3600 * 100)
        m = await _machine_for(async_client, "X1C05")
        response = await async_client.post(
            f"{BASE}/readings",
            json={"reading_date": "2026-04-25", "entries": [{"machine_id": m["id"], "hours": 3336}]},
        )
        assert response.status_code == 200
        readings = response.json()["readings"]
        assert [(r["reading_date"], r["hours"], r["source"]) for r in readings] == [("2026-04-25", 3336.0, "manual")]
        await db_session.refresh(p)
        assert p.print_hours_offset == 0.0

    async def test_today_reading_recalibrates_and_rewrites_auto(
        self, async_client: AsyncClient, printer_factory, db_session
    ):
        p = await printer_factory(name="X1C06", runtime_seconds=3600 * 100)
        m = await _machine_for(async_client, "X1C06")
        today = date.today().isoformat()
        response = await async_client.post(
            f"{BASE}/readings", json={"reading_date": today, "entries": [{"machine_id": m["id"], "hours": 2629}]}
        )
        assert response.status_code == 200
        data = response.json()
        assert sorted((r["source"], r["hours"]) for r in data["readings"]) == [("auto", 2629.0), ("manual", 2629.0)]
        assert next(x for x in data["machines"] if x["id"] == m["id"])["current_hours"] == 2629.0
        await db_session.refresh(p)
        assert p.print_hours_offset == pytest.approx(2529.0)

    async def test_resave_replaces_and_null_deletes(self, async_client: AsyncClient, printer_factory):
        await printer_factory(name="X1C07")
        m = await _machine_for(async_client, "X1C07")
        body = {"reading_date": "2026-01-01", "entries": [{"machine_id": m["id"], "hours": 1629}]}
        await async_client.post(f"{BASE}/readings", json=body)
        body["entries"][0]["hours"] = 1630
        data = (await async_client.post(f"{BASE}/readings", json=body)).json()
        assert [r["hours"] for r in data["readings"]] == [1630.0]
        body["entries"][0]["hours"] = None
        data = (await async_client.post(f"{BASE}/readings", json=body)).json()
        assert data["readings"] == []

    @pytest.mark.parametrize(
        ("reading_date", "hours", "detail"),
        [
            ((date.today() + timedelta(days=1)).isoformat(), 10, "future"),
            ("2026-01-01", -1, None),
        ],
    )
    async def test_rejects_future_dates_and_negative_hours(
        self, async_client: AsyncClient, printer_factory, reading_date, hours, detail
    ):
        await printer_factory(name="X1C08")
        m = await _machine_for(async_client, "X1C08")
        response = await async_client.post(
            f"{BASE}/readings",
            json={"reading_date": reading_date, "entries": [{"machine_id": m["id"], "hours": hours}]},
        )
        assert response.status_code == 422
        if detail:
            assert detail in response.json()["detail"]

    async def test_rejects_retired_unknown_and_duplicate_machines(self, async_client: AsyncClient, db_session):
        retired = HourMachine(name="X1C01", model="X1C", retired=True)
        db_session.add(retired)
        await db_session.commit()
        for entries in (
            [{"machine_id": retired.id, "hours": 1}],
            [{"machine_id": 99999, "hours": 1}],
        ):
            response = await async_client.post(
                f"{BASE}/readings", json={"reading_date": "2026-01-01", "entries": entries}
            )
            assert response.status_code == 422
        response = await async_client.post(
            f"{BASE}/readings",
            json={"reading_date": "2026-01-01", "entries": [{"machine_id": retired.id, "hours": 1}] * 2},
        )
        assert response.status_code == 422


@pytest.mark.asyncio
@pytest.mark.integration
class TestHoursDelete:
    async def test_delete_date_removes_manual_only(self, async_client: AsyncClient, printer_factory):
        await printer_factory(name="X1C09")
        m = await _machine_for(async_client, "X1C09")
        today = date.today().isoformat()
        await async_client.post(
            f"{BASE}/readings", json={"reading_date": today, "entries": [{"machine_id": m["id"], "hours": 5}]}
        )
        response = await async_client.delete(f"{BASE}/readings", params={"reading_date": today})
        assert response.status_code == 200
        assert [r["source"] for r in response.json()["readings"]] == ["auto"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_hours_routes_require_auth_when_enabled(async_client: AsyncClient):
    setup = await async_client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": "hoursadmin", "admin_password": "TestPass1!"},
    )
    assert setup.status_code == 200
    assert (await async_client.get(BASE)).status_code == 401
    body = {"reading_date": "2026-01-01", "entries": [{"machine_id": 1, "hours": 1}]}
    assert (await async_client.post(f"{BASE}/readings", json=body)).status_code == 401
