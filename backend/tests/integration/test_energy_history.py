"""Tests for GET /smart-plugs/energy/history (snapshot-based time series)."""

from datetime import datetime

import pytest
from httpx import AsyncClient

from backend.app.models.smart_plug import SmartPlug
from backend.app.models.smart_plug_energy_snapshot import SmartPlugEnergySnapshot


async def _make_plug(db_session, name="Test Plug", printer_id=None) -> SmartPlug:
    plug = SmartPlug(name=name, plug_type="tasmota", ip_address="192.168.1.50", printer_id=printer_id)
    db_session.add(plug)
    await db_session.commit()
    await db_session.refresh(plug)
    return plug


async def _snapshot(db_session, plug_id: int, recorded_at: datetime, kwh: float) -> None:
    db_session.add(SmartPlugEnergySnapshot(plug_id=plug_id, recorded_at=recorded_at, lifetime_kwh=kwh))
    await db_session.commit()


class TestEnergyHistory:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_route_not_shadowed_by_plug_id(self, async_client: AsyncClient):
        """/energy/history must resolve before /{plug_id} (no 422)."""
        response = await async_client.get("/api/v1/smart-plugs/energy/history?bucket=day")
        assert response.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_no_plugs_returns_zeros(self, async_client: AsyncClient):
        response = await async_client.get("/api/v1/smart-plugs/energy/history?date_from=2024-06-01&date_to=2024-06-02")
        assert response.status_code == 200
        data = response.json()
        assert data["total_kwh"] == 0
        assert data["plugs"] == []
        assert data["warming_up"] is False
        # Zero-filled combined series covers the whole window
        assert [b["period"] for b in data["buckets"]] == ["2024-06-01", "2024-06-02"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_daily_buckets_from_hourly_snapshots(self, async_client: AsyncClient, db_session):
        plug = await _make_plug(db_session)
        # Baseline before window, then 0.5 kWh on day 1 and 0.3 kWh on day 2
        await _snapshot(db_session, plug.id, datetime(2024, 5, 31, 23, 0), 100.0)
        await _snapshot(db_session, plug.id, datetime(2024, 6, 1, 6, 0), 100.2)
        await _snapshot(db_session, plug.id, datetime(2024, 6, 1, 12, 0), 100.5)
        await _snapshot(db_session, plug.id, datetime(2024, 6, 2, 12, 0), 100.8)

        response = await async_client.get("/api/v1/smart-plugs/energy/history?date_from=2024-06-01&date_to=2024-06-02")
        assert response.status_code == 200
        data = response.json()
        assert data["warming_up"] is False
        assert data["total_kwh"] == pytest.approx(0.8)
        by_period = {b["period"]: b["kwh"] for b in data["buckets"]}
        assert by_period["2024-06-01"] == pytest.approx(0.5)
        assert by_period["2024-06-02"] == pytest.approx(0.3)
        assert data["plugs"][0]["plug_name"] == "Test Plug"
        assert data["plugs"][0]["total_kwh"] == pytest.approx(0.8)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_counter_reset_is_clamped(self, async_client: AsyncClient, db_session):
        plug = await _make_plug(db_session)
        await _snapshot(db_session, plug.id, datetime(2024, 5, 31, 23, 0), 100.0)
        await _snapshot(db_session, plug.id, datetime(2024, 6, 1, 6, 0), 100.4)
        # Counter reset (plug re-flashed): lifetime drops to 0, then grows
        await _snapshot(db_session, plug.id, datetime(2024, 6, 1, 12, 0), 0.0)
        await _snapshot(db_session, plug.id, datetime(2024, 6, 1, 18, 0), 0.2)

        response = await async_client.get("/api/v1/smart-plugs/energy/history?date_from=2024-06-01&date_to=2024-06-01")
        data = response.json()
        # 0.4 before reset + 0 (clamped) + 0.2 after reset
        assert data["total_kwh"] == pytest.approx(0.6)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_plug_without_baseline_sets_warming_up(self, async_client: AsyncClient, db_session):
        plug = await _make_plug(db_session)
        # First snapshot mid-window: no baseline, first pair delta only
        await _snapshot(db_session, plug.id, datetime(2024, 6, 1, 12, 0), 50.0)
        await _snapshot(db_session, plug.id, datetime(2024, 6, 1, 13, 0), 50.3)

        response = await async_client.get("/api/v1/smart-plugs/energy/history?date_from=2024-06-01&date_to=2024-06-01")
        data = response.json()
        assert data["warming_up"] is True
        assert data["total_kwh"] == pytest.approx(0.3)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_tz_offset_shifts_bucket_assignment(self, async_client: AsyncClient, db_session):
        plug = await _make_plug(db_session)
        # 01:00 UTC on Jun 15 == 15:00 Jun 14 for a UTC-10 client
        await _snapshot(db_session, plug.id, datetime(2024, 6, 15, 0, 0), 10.0)
        await _snapshot(db_session, plug.id, datetime(2024, 6, 15, 1, 0), 10.5)

        response = await async_client.get(
            "/api/v1/smart-plugs/energy/history?date_from=2024-06-14&date_to=2024-06-14&tz_offset_minutes=-600"
        )
        data = response.json()
        by_period = {b["period"]: b["kwh"] for b in data["buckets"]}
        assert by_period["2024-06-14"] == pytest.approx(0.5)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_hour_buckets(self, async_client: AsyncClient, db_session):
        plug = await _make_plug(db_session)
        await _snapshot(db_session, plug.id, datetime(2024, 6, 1, 5, 0), 1.0)
        await _snapshot(db_session, plug.id, datetime(2024, 6, 1, 6, 0), 1.2)

        response = await async_client.get(
            "/api/v1/smart-plugs/energy/history?date_from=2024-06-01&date_to=2024-06-01&bucket=hour"
        )
        data = response.json()
        assert data["bucket"] == "hour"
        by_period = {b["period"]: b["kwh"] for b in data["buckets"]}
        assert len(by_period) == 24
        assert by_period["2024-06-01T06:00"] == pytest.approx(0.2)
