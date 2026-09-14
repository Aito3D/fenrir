"""Integration tests for Settings API endpoints.

Tests the full request/response cycle for /api/v1/settings/ endpoints.
"""

import logging
import os

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession


class TestSettingsAPI:
    """Integration tests for /api/v1/settings/ endpoints."""

    # ========================================================================
    # Get settings
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_settings(self, async_client: AsyncClient):
        """Verify settings can be retrieved."""
        response = await async_client.get("/api/v1/settings/")

        assert response.status_code == 200
        result = response.json()
        # Check for actual settings fields
        assert "auto_archive" in result
        assert "currency" in result
        assert "date_format" in result

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_settings_has_defaults(self, async_client: AsyncClient):
        """Verify default settings values are returned."""
        response = await async_client.get("/api/v1/settings/")

        assert response.status_code == 200
        result = response.json()
        # Verify some default values
        assert isinstance(result["auto_archive"], bool)
        assert isinstance(result["currency"], str)

    # ========================================================================
    # Update settings
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_auto_archive(self, async_client: AsyncClient):
        """Verify auto_archive can be updated."""
        # First get current value
        response = await async_client.get("/api/v1/settings/")
        original = response.json()["auto_archive"]

        # Update to opposite value
        new_value = not original
        response = await async_client.put("/api/v1/settings/", json={"auto_archive": new_value})

        assert response.status_code == 200
        assert response.json()["auto_archive"] == new_value

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_currency(self, async_client: AsyncClient):
        """Verify currency can be updated."""
        response = await async_client.put("/api/v1/settings/", json={"currency": "EUR"})

        assert response.status_code == 200
        assert response.json()["currency"] == "EUR"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_date_format(self, async_client: AsyncClient):
        """Verify date format can be updated."""
        response = await async_client.put("/api/v1/settings/", json={"date_format": "eu"})

        assert response.status_code == 200
        assert response.json()["date_format"] == "eu"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_time_format(self, async_client: AsyncClient):
        """Verify time format can be updated."""
        response = await async_client.put("/api/v1/settings/", json={"time_format": "24h"})

        assert response.status_code == 200
        assert response.json()["time_format"] == "24h"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_filament_cost(self, async_client: AsyncClient):
        """Verify default filament cost can be updated."""
        response = await async_client.put("/api/v1/settings/", json={"default_filament_cost": 30.0})

        assert response.status_code == 200
        assert response.json()["default_filament_cost"] == 30.0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_energy_cost(self, async_client: AsyncClient):
        """Verify energy cost can be updated."""
        response = await async_client.put("/api/v1/settings/", json={"energy_cost_per_kwh": 0.20})

        assert response.status_code == 200
        assert response.json()["energy_cost_per_kwh"] == 0.20

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_multiple_settings(self, async_client: AsyncClient):
        """Verify multiple settings can be updated at once."""
        response = await async_client.put(
            "/api/v1/settings/",
            json={
                "currency": "GBP",
                "date_format": "iso",
                "time_format": "12h",
                "save_thumbnails": False,
            },
        )

        assert response.status_code == 200
        result = response.json()
        assert result["currency"] == "GBP"
        assert result["date_format"] == "iso"
        assert result["time_format"] == "12h"
        assert result["save_thumbnails"] is False

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_spoolman_settings(self, async_client: AsyncClient):
        """Verify Spoolman settings can be updated."""
        response = await async_client.put(
            "/api/v1/settings/",
            json={
                "spoolman_enabled": True,
                "spoolman_url": "http://localhost:7912",
                "spoolman_sync_mode": "manual",
            },
        )

        assert response.status_code == 200
        result = response.json()
        assert result["spoolman_enabled"] is True
        assert result["spoolman_url"] == "http://localhost:7912"
        assert result["spoolman_sync_mode"] == "manual"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_ams_thresholds(self, async_client: AsyncClient):
        """Verify AMS threshold settings can be updated."""
        response = await async_client.put(
            "/api/v1/settings/",
            json={
                "ams_humidity_good": 35,
                "ams_humidity_fair": 55,
                "ams_temp_good": 25.0,
                "ams_temp_fair": 32.0,
            },
        )

        assert response.status_code == 200
        result = response.json()
        assert result["ams_humidity_good"] == 35
        assert result["ams_humidity_fair"] == 55
        assert result["ams_temp_good"] == 25.0
        assert result["ams_temp_fair"] == 32.0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_low_stock_threshold(self, async_client: AsyncClient):
        """Verify low stock threshold setting can be updated."""
        # Get default value
        response = await async_client.get("/api/v1/settings/")
        assert response.status_code == 200
        assert response.json()["low_stock_threshold"] == 20.0

        # Update to custom value
        response = await async_client.put("/api/v1/settings/", json={"low_stock_threshold": 15.5})

        assert response.status_code == 200
        result = response.json()
        assert result["low_stock_threshold"] == 15.5

        # Verify persistence
        response = await async_client.get("/api/v1/settings/")
        assert response.status_code == 200
        assert response.json()["low_stock_threshold"] == 15.5

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_notification_language(self, async_client: AsyncClient):
        """Verify notification language can be updated."""
        response = await async_client.put("/api/v1/settings/", json={"notification_language": "de"})

        assert response.status_code == 200
        assert response.json()["notification_language"] == "de"

    # ========================================================================
    # Settings persistence tests
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_theme_settings(self, async_client: AsyncClient):
        """Verify theme settings can be updated."""
        response = await async_client.put(
            "/api/v1/settings/",
            json={
                "dark_style": "glow",
                "dark_background": "forest",
                "dark_accent": "teal",
                "light_style": "vibrant",
                "light_background": "warm",
                "light_accent": "blue",
            },
        )

        assert response.status_code == 200
        result = response.json()
        assert result["dark_style"] == "glow"
        assert result["dark_background"] == "forest"
        assert result["dark_accent"] == "teal"
        assert result["light_style"] == "vibrant"
        assert result["light_background"] == "warm"
        assert result["light_accent"] == "blue"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_settings_persist_after_update(self, async_client: AsyncClient):
        """CRITICAL: Verify settings changes persist across requests."""
        # Update settings
        await async_client.put("/api/v1/settings/", json={"currency": "JPY", "check_updates": False})

        # Verify persistence in new request
        response = await async_client.get("/api/v1/settings/")
        result = response.json()
        assert result["currency"] == "JPY"
        assert result["check_updates"] is False

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_check_printer_firmware(self, async_client: AsyncClient):
        """Verify check_printer_firmware can be updated."""
        # Default should be True
        response = await async_client.get("/api/v1/settings/")
        assert response.json()["check_printer_firmware"] is True

        # Update to False
        response = await async_client.put("/api/v1/settings/", json={"check_printer_firmware": False})
        assert response.status_code == 200
        assert response.json()["check_printer_firmware"] is False

        # Verify persistence
        response = await async_client.get("/api/v1/settings/")
        assert response.json()["check_printer_firmware"] is False

        # Update back to True
        response = await async_client.put("/api/v1/settings/", json={"check_printer_firmware": True})
        assert response.status_code == 200
        assert response.json()["check_printer_firmware"] is True

    # ========================================================================
    # MQTT settings tests
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_mqtt_settings(self, async_client: AsyncClient):
        """Verify MQTT settings can be updated."""
        response = await async_client.put(
            "/api/v1/settings/",
            json={
                "mqtt_enabled": True,
                "mqtt_broker": "mqtt.example.com",
                "mqtt_port": 8883,
                "mqtt_username": "testuser",
                "mqtt_password": "testpass",
                "mqtt_topic_prefix": "myprefix",
                "mqtt_use_tls": True,
            },
        )

        assert response.status_code == 200
        result = response.json()
        assert result["mqtt_enabled"] is True
        assert result["mqtt_broker"] == "mqtt.example.com"
        assert result["mqtt_port"] == 8883
        assert result["mqtt_username"] == "testuser"
        assert result["mqtt_password"] == "testpass"
        assert result["mqtt_topic_prefix"] == "myprefix"
        assert result["mqtt_use_tls"] is True

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_mqtt_settings_logs_reconfigure_failure(self, async_client: AsyncClient, monkeypatch, caplog):
        """A broken MQTT reconfiguration must not fail the request, but must be logged (#T-202)."""
        from backend.app.services.mqtt_relay import mqtt_relay

        async def boom(self, settings):
            raise RuntimeError("broker unreachable")

        monkeypatch.setattr(type(mqtt_relay), "configure", boom)

        with caplog.at_level(logging.WARNING, logger="backend.app.api.routes.settings"):
            response = await async_client.put(
                "/api/v1/settings/",
                json={
                    "mqtt_enabled": True,
                    "mqtt_broker": "mqtt.example.com",
                    "mqtt_port": 8883,
                    "mqtt_username": "testuser",
                    "mqtt_password": "testpass",
                    "mqtt_topic_prefix": "myprefix",
                    "mqtt_use_tls": True,
                },
            )

        assert response.status_code == 200
        result = response.json()
        assert result["mqtt_broker"] == "mqtt.example.com"
        assert result["mqtt_port"] == 8883
        assert "MQTT relay reconfiguration failed" in caplog.text

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_mqtt_status_endpoint(self, async_client: AsyncClient):
        """Verify MQTT status endpoint returns expected fields."""
        response = await async_client.get("/api/v1/settings/mqtt/status")

        assert response.status_code == 200
        result = response.json()
        assert "enabled" in result
        assert "connected" in result
        assert "broker" in result
        assert "port" in result
        assert "topic_prefix" in result

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_mqtt_defaults(self, async_client: AsyncClient):
        """Verify MQTT has correct default values."""
        # Reset MQTT settings to defaults
        await async_client.put(
            "/api/v1/settings/",
            json={
                "mqtt_enabled": False,
                "mqtt_broker": "",
                "mqtt_port": 1883,
                "mqtt_username": "",
                "mqtt_password": "",
                "mqtt_topic_prefix": "bambuddy",
                "mqtt_use_tls": False,
            },
        )

        response = await async_client.get("/api/v1/settings/")
        result = response.json()

        assert result["mqtt_enabled"] is False
        assert result["mqtt_port"] == 1883
        assert result["mqtt_topic_prefix"] == "bambuddy"
        assert result["mqtt_use_tls"] is False

    # ========================================================================
    # Camera settings tests
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_camera_view_mode(self, async_client: AsyncClient):
        """Verify camera view mode can be updated."""
        response = await async_client.put("/api/v1/settings/", json={"camera_view_mode": "embedded"})

        assert response.status_code == 200
        assert response.json()["camera_view_mode"] == "embedded"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_view_mode_persists(self, async_client: AsyncClient):
        """CRITICAL: Verify camera view mode persists after update."""
        # Update to embedded
        await async_client.put("/api/v1/settings/", json={"camera_view_mode": "embedded"})

        # Verify persistence in new request
        response = await async_client.get("/api/v1/settings/")
        assert response.json()["camera_view_mode"] == "embedded"

        # Update back to window
        await async_client.put("/api/v1/settings/", json={"camera_view_mode": "window"})

        # Verify persistence
        response = await async_client.get("/api/v1/settings/")
        assert response.json()["camera_view_mode"] == "window"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_view_mode_default(self, async_client: AsyncClient):
        """Verify camera view mode has correct default value."""
        # Reset by requesting settings (default should be 'window')
        response = await async_client.get("/api/v1/settings/")
        result = response.json()

        assert "camera_view_mode" in result
        # Default is 'window' as defined in schema
        assert result["camera_view_mode"] in ["window", "embedded"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_camera_quality(self, async_client: AsyncClient):
        """Verify camera quality can be updated."""
        response = await async_client.put("/api/v1/settings/", json={"camera_quality": "low"})

        assert response.status_code == 200
        assert response.json()["camera_quality"] == "low"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_quality_persists(self, async_client: AsyncClient):
        """CRITICAL: Verify camera quality persists after update."""
        await async_client.put("/api/v1/settings/", json={"camera_quality": "high"})

        response = await async_client.get("/api/v1/settings/")
        assert response.json()["camera_quality"] == "high"

        await async_client.put("/api/v1/settings/", json={"camera_quality": "medium"})

        response = await async_client.get("/api/v1/settings/")
        assert response.json()["camera_quality"] == "medium"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_quality_default(self, async_client: AsyncClient):
        """Verify camera quality has correct default value."""
        response = await async_client.get("/api/v1/settings/")
        result = response.json()

        assert "camera_quality" in result
        assert result["camera_quality"] in ["auto", "low", "medium", "high"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_quality_auto_can_be_set(self, async_client: AsyncClient):
        """Verify camera quality can be set to 'auto'."""
        response = await async_client.put("/api/v1/settings/", json={"camera_quality": "auto"})

        assert response.status_code == 200
        assert response.json()["camera_quality"] == "auto"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_quality_auto_persists(self, async_client: AsyncClient):
        """Verify 'auto' camera quality persists after update."""
        await async_client.put("/api/v1/settings/", json={"camera_quality": "auto"})

        response = await async_client.get("/api/v1/settings/")
        assert response.json()["camera_quality"] == "auto"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_gpu_accel_setting(self, async_client: AsyncClient):
        """Verify camera_gpu_accel can be toggled on and off."""
        # Default should be True
        response = await async_client.get("/api/v1/settings/")
        assert response.json()["camera_gpu_accel"] is True

        # Disable
        response = await async_client.put("/api/v1/settings/", json={"camera_gpu_accel": False})
        assert response.status_code == 200
        assert response.json()["camera_gpu_accel"] is False

        # Verify persistence
        response = await async_client.get("/api/v1/settings/")
        assert response.json()["camera_gpu_accel"] is False

        # Re-enable
        response = await async_client.put("/api/v1/settings/", json={"camera_gpu_accel": True})
        assert response.status_code == 200
        assert response.json()["camera_gpu_accel"] is True

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_check_ffmpeg_gpu_fields(self, async_client: AsyncClient):
        """Verify check-ffmpeg response includes GPU fields."""
        response = await async_client.get("/api/v1/settings/check-ffmpeg")
        assert response.status_code == 200
        result = response.json()

        assert "installed" in result
        assert "gpu_available" in result
        assert "gpu_backends" in result
        assert isinstance(result["gpu_available"], bool)
        assert isinstance(result["gpu_backends"], list)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_check_ffmpeg_auto_resolved_quality(self, async_client: AsyncClient):
        """Verify check-ffmpeg response includes auto_resolved_quality field."""
        response = await async_client.get("/api/v1/settings/check-ffmpeg")
        assert response.status_code == 200
        result = response.json()

        assert "auto_resolved_quality" in result
        assert result["auto_resolved_quality"] in ["low", "medium", "high"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_quality_change_stops_active_streams(self, async_client: AsyncClient, monkeypatch):
        """A camera_keys change must stop active camera streams via the shared hub (#T-241)."""
        from backend.app.api.routes.camera import _hub

        calls = {"count": 0}

        async def fake_stop_all(self):
            calls["count"] += 1
            return 2

        monkeypatch.setattr(type(_hub), "stop_all", fake_stop_all)

        response = await async_client.put("/api/v1/settings/", json={"camera_quality": "high"})

        assert response.status_code == 200
        assert response.json()["camera_quality"] == "high"
        assert calls["count"] == 1

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_stream_stop_failure_logged_and_swallowed(
        self, async_client: AsyncClient, monkeypatch, caplog
    ):
        """A broken camera stream stop must not fail the request, but must be logged (#T-241)."""
        from backend.app.api.routes.camera import _hub

        async def boom(self):
            raise RuntimeError("ffmpeg pipe broken")

        monkeypatch.setattr(type(_hub), "stop_all", boom)

        with caplog.at_level(logging.WARNING, logger="backend.app.api.routes.settings"):
            response = await async_client.put("/api/v1/settings/", json={"camera_quality": "medium"})

        assert response.status_code == 200
        assert response.json()["camera_quality"] == "medium"
        assert "Camera engine reconfiguration failed" in caplog.text

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_engine_switch_to_go2rtc_starts_service(self, async_client: AsyncClient, monkeypatch):
        """Switching camera_engine to 'go2rtc' while stopped must start the go2rtc service (#T-241)."""
        from backend.app.services.go2rtc import go2rtc_service

        calls = {"start": 0, "stop": 0}

        async def fake_start(self):
            calls["start"] += 1

        async def fake_stop(self):
            calls["stop"] += 1

        monkeypatch.setattr(type(go2rtc_service), "running", property(lambda self: False))
        monkeypatch.setattr(type(go2rtc_service), "start", fake_start)
        monkeypatch.setattr(type(go2rtc_service), "stop", fake_stop)

        response = await async_client.put("/api/v1/settings/", json={"camera_engine": "go2rtc"})

        assert response.status_code == 200
        assert response.json()["camera_engine"] == "go2rtc"
        assert calls["start"] == 1
        assert calls["stop"] == 0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_engine_switch_to_go2rtc_noop_when_already_running(
        self, async_client: AsyncClient, monkeypatch
    ):
        """Switching camera_engine to 'go2rtc' while already running must not restart it (#T-241)."""
        from backend.app.services.go2rtc import go2rtc_service

        calls = {"start": 0}

        async def fake_start(self):
            calls["start"] += 1

        monkeypatch.setattr(type(go2rtc_service), "running", property(lambda self: True))
        monkeypatch.setattr(type(go2rtc_service), "start", fake_start)

        response = await async_client.put("/api/v1/settings/", json={"camera_engine": "go2rtc"})

        assert response.status_code == 200
        assert calls["start"] == 0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_engine_switch_away_from_go2rtc_stops_service(self, async_client: AsyncClient, monkeypatch):
        """Switching camera_engine away from 'go2rtc' while running must stop the go2rtc service (#T-241)."""
        from backend.app.services.go2rtc import go2rtc_service

        calls = {"stop": 0}

        async def fake_stop(self):
            calls["stop"] += 1

        monkeypatch.setattr(type(go2rtc_service), "running", property(lambda self: True))
        monkeypatch.setattr(type(go2rtc_service), "stop", fake_stop)

        response = await async_client.put("/api/v1/settings/", json={"camera_engine": "ffmpeg"})

        assert response.status_code == 200
        assert response.json()["camera_engine"] == "ffmpeg"
        assert calls["stop"] == 1

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_engine_switch_away_from_go2rtc_noop_when_already_stopped(
        self, async_client: AsyncClient, monkeypatch
    ):
        """Switching camera_engine away from 'go2rtc' while already stopped must not call stop() (#T-241)."""
        from backend.app.services.go2rtc import go2rtc_service

        calls = {"stop": 0}

        async def fake_stop(self):
            calls["stop"] += 1

        monkeypatch.setattr(type(go2rtc_service), "running", property(lambda self: False))
        monkeypatch.setattr(type(go2rtc_service), "stop", fake_stop)

        response = await async_client.put("/api/v1/settings/", json={"camera_engine": "ffmpeg"})

        assert response.status_code == 200
        assert calls["stop"] == 0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_engine_go2rtc_management_failure_logged_and_swallowed(
        self, async_client: AsyncClient, monkeypatch, caplog
    ):
        """A broken go2rtc start/stop must not fail the request, but must be logged (#T-241)."""
        from backend.app.services.go2rtc import go2rtc_service

        async def boom(self):
            raise RuntimeError("go2rtc binary not found")

        monkeypatch.setattr(type(go2rtc_service), "running", property(lambda self: False))
        monkeypatch.setattr(type(go2rtc_service), "start", boom)

        with caplog.at_level(logging.WARNING, logger="backend.app.api.routes.settings"):
            response = await async_client.put("/api/v1/settings/", json={"camera_engine": "go2rtc"})

        assert response.status_code == 200
        assert response.json()["camera_engine"] == "go2rtc"
        assert "go2rtc management failed" in caplog.text

    # ========================================================================
    # Per-printer mapping settings tests
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_per_printer_mapping_expanded(self, async_client: AsyncClient):
        """Verify per_printer_mapping_expanded can be updated."""
        response = await async_client.put("/api/v1/settings/", json={"per_printer_mapping_expanded": True})

        assert response.status_code == 200
        assert response.json()["per_printer_mapping_expanded"] is True

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_per_printer_mapping_expanded_persists(self, async_client: AsyncClient):
        """CRITICAL: Verify per_printer_mapping_expanded persists after update."""
        # Update to True
        await async_client.put("/api/v1/settings/", json={"per_printer_mapping_expanded": True})

        # Verify persistence in new request
        response = await async_client.get("/api/v1/settings/")
        assert response.json()["per_printer_mapping_expanded"] is True

        # Update back to False
        await async_client.put("/api/v1/settings/", json={"per_printer_mapping_expanded": False})

        # Verify persistence
        response = await async_client.get("/api/v1/settings/")
        assert response.json()["per_printer_mapping_expanded"] is False

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_per_printer_mapping_expanded_default(self, async_client: AsyncClient):
        """Verify per_printer_mapping_expanded has correct default value."""
        response = await async_client.get("/api/v1/settings/")
        result = response.json()

        assert "per_printer_mapping_expanded" in result
        # Default is False as defined in schema
        assert isinstance(result["per_printer_mapping_expanded"], bool)

    # ========================================================================
    # Stagger settings tests
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_stagger_settings_defaults(self, async_client: AsyncClient):
        """Verify stagger settings have correct defaults."""
        response = await async_client.get("/api/v1/settings/")
        result = response.json()

        assert result["stagger_group_size"] == 2
        assert result["stagger_interval_minutes"] == 5

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_stagger_settings(self, async_client: AsyncClient):
        """Verify stagger settings can be updated."""
        response = await async_client.put(
            "/api/v1/settings/",
            json={"stagger_group_size": 3, "stagger_interval_minutes": 10},
        )

        assert response.status_code == 200
        result = response.json()
        assert result["stagger_group_size"] == 3
        assert result["stagger_interval_minutes"] == 10

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_stagger_settings_persist(self, async_client: AsyncClient):
        """Verify stagger settings persist after update."""
        await async_client.put(
            "/api/v1/settings/",
            json={"stagger_group_size": 4, "stagger_interval_minutes": 15},
        )

        response = await async_client.get("/api/v1/settings/")
        result = response.json()
        assert result["stagger_group_size"] == 4
        assert result["stagger_interval_minutes"] == 15

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_stagger_settings_validation(self, async_client: AsyncClient):
        """Verify stagger settings reject out-of-range values."""
        response = await async_client.put("/api/v1/settings/", json={"stagger_group_size": 0})
        assert response.status_code == 422

        response = await async_client.put("/api/v1/settings/", json={"stagger_group_size": 51})
        assert response.status_code == 422

        response = await async_client.put("/api/v1/settings/", json={"stagger_interval_minutes": 0})
        assert response.status_code == 422

        response = await async_client.put("/api/v1/settings/", json={"stagger_interval_minutes": 61})
        assert response.status_code == 422

    # ========================================================================
    # Default print options tests
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_default_print_options_defaults(self, async_client: AsyncClient):
        """Verify default print options have correct defaults."""
        response = await async_client.get("/api/v1/settings/")
        result = response.json()

        # bed_levelling / flow_cali are tri-state, defaulting to "auto".
        assert result["default_bed_levelling"] == "auto"
        assert result["default_flow_cali"] == "auto"
        assert result["default_vibration_cali"] is True
        assert result["default_layer_inspect"] is False
        assert result["default_timelapse"] is False

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_default_print_options(self, async_client: AsyncClient):
        """Verify default print options can be updated (tri-state + booleans)."""
        response = await async_client.put(
            "/api/v1/settings/",
            json={
                "default_bed_levelling": "off",
                "default_flow_cali": "on",
                "default_vibration_cali": False,
                "default_layer_inspect": True,
                "default_timelapse": True,
            },
        )

        assert response.status_code == 200
        result = response.json()
        assert result["default_bed_levelling"] == "off"
        assert result["default_flow_cali"] == "on"
        assert result["default_vibration_cali"] is False
        assert result["default_layer_inspect"] is True
        assert result["default_timelapse"] is True

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_default_print_options_legacy_bool_coerced(self, async_client: AsyncClient):
        """Old clients sending booleans for the tri-state options still work.

        The TriState validator maps true->"on", false->"off" on input so a
        pre-upgrade frontend never writes an invalid value.
        """
        response = await async_client.put(
            "/api/v1/settings/",
            json={"default_bed_levelling": False, "default_flow_cali": True},
        )
        assert response.status_code == 200
        result = response.json()
        assert result["default_bed_levelling"] == "off"
        assert result["default_flow_cali"] == "on"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_default_print_options_persist(self, async_client: AsyncClient):
        """CRITICAL: Verify default print options persist after update."""
        await async_client.put(
            "/api/v1/settings/",
            json={
                "default_bed_levelling": "on",
                "default_timelapse": True,
            },
        )

        response = await async_client.get("/api/v1/settings/")
        result = response.json()
        assert result["default_bed_levelling"] == "on"
        assert result["default_timelapse"] is True

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_default_print_options_partial_update(self, async_client: AsyncClient):
        """Verify partial updates don't affect other default print options."""
        # Set all to non-default
        await async_client.put(
            "/api/v1/settings/",
            json={
                "default_bed_levelling": "off",
                "default_flow_cali": "on",
            },
        )

        # Update only one
        response = await async_client.put(
            "/api/v1/settings/",
            json={"default_bed_levelling": "auto"},
        )

        assert response.status_code == 200
        result = response.json()
        assert result["default_bed_levelling"] == "auto"
        assert result["default_flow_cali"] == "on"  # Should remain from previous update

    # ========================================================================
    # Home Assistant environment variable tests
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_ha_settings_default_no_env_vars(self, async_client: AsyncClient):
        """Verify HA settings work without environment variables (default behavior)."""
        # Ensure no env vars are set
        os.environ.pop("HA_URL", None)
        os.environ.pop("HA_TOKEN", None)

        response = await async_client.get("/api/v1/settings/")
        result = response.json()

        assert response.status_code == 200
        assert "ha_enabled" in result
        assert "ha_url" in result
        assert "ha_token" in result
        assert "ha_url_from_env" in result
        assert "ha_token_from_env" in result
        assert "ha_env_managed" in result

        # Default values without env vars
        assert result["ha_url_from_env"] is False
        assert result["ha_token_from_env"] is False
        assert result["ha_env_managed"] is False

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_ha_settings_with_both_env_vars(self, async_client: AsyncClient):
        """Verify HA settings are overridden when both env vars are set."""
        # Set environment variables
        os.environ["HA_URL"] = "http://supervisor/core"
        os.environ["HA_TOKEN"] = "test-token-12345"

        try:
            response = await async_client.get("/api/v1/settings/")
            result = response.json()

            assert response.status_code == 200

            # Verify env var values are used
            assert result["ha_url"] == "http://supervisor/core"
            assert result["ha_token"] == "test-token-12345"

            # Verify metadata fields
            assert result["ha_url_from_env"] is True
            assert result["ha_token_from_env"] is True
            assert result["ha_env_managed"] is True

            # Verify auto-enable behavior
            assert result["ha_enabled"] is True

        finally:
            # Clean up
            os.environ.pop("HA_URL", None)
            os.environ.pop("HA_TOKEN", None)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_ha_settings_with_only_url_env_var(self, async_client: AsyncClient):
        """Verify partial configuration when only HA_URL is set."""
        # Set only URL env var
        os.environ["HA_URL"] = "http://supervisor/core"
        os.environ.pop("HA_TOKEN", None)

        try:
            response = await async_client.get("/api/v1/settings/")
            result = response.json()

            assert response.status_code == 200

            # Verify URL is from env, token is from database
            assert result["ha_url"] == "http://supervisor/core"
            assert result["ha_url_from_env"] is True
            assert result["ha_token_from_env"] is False
            assert result["ha_env_managed"] is False

            # No auto-enable with partial config
            assert result["ha_enabled"] is False  # Database default

        finally:
            os.environ.pop("HA_URL", None)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_ha_settings_with_only_token_env_var(self, async_client: AsyncClient):
        """Verify partial configuration when only HA_TOKEN is set."""
        # Set only token env var
        os.environ.pop("HA_URL", None)
        os.environ["HA_TOKEN"] = "test-token-12345"

        try:
            response = await async_client.get("/api/v1/settings/")
            result = response.json()

            assert response.status_code == 200

            # Verify token is from env, URL is from database
            assert result["ha_token"] == "test-token-12345"
            assert result["ha_url_from_env"] is False
            assert result["ha_token_from_env"] is True
            assert result["ha_env_managed"] is False

            # No auto-enable with partial config
            assert result["ha_enabled"] is False  # Database default

        finally:
            os.environ.pop("HA_TOKEN", None)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_ha_settings_env_vars_override_database(self, async_client: AsyncClient):
        """Verify environment variables take precedence over database values."""
        # First, set database values
        await async_client.put(
            "/api/v1/settings/",
            json={
                "ha_enabled": True,
                "ha_url": "http://database-url:8123",
                "ha_token": "database-token",
            },
        )

        # Verify database values are set
        response = await async_client.get("/api/v1/settings/")
        result = response.json()
        assert result["ha_url"] == "http://database-url:8123"
        assert result["ha_token"] == "database-token"

        # Now set environment variables
        os.environ["HA_URL"] = "http://env-url/core"
        os.environ["HA_TOKEN"] = "env-token-xyz"

        try:
            response = await async_client.get("/api/v1/settings/")
            result = response.json()

            # Verify env vars override database
            assert result["ha_url"] == "http://env-url/core"
            assert result["ha_token"] == "env-token-xyz"
            assert result["ha_url_from_env"] is True
            assert result["ha_token_from_env"] is True
            assert result["ha_env_managed"] is True
            assert result["ha_enabled"] is True

        finally:
            os.environ.pop("HA_URL", None)
            os.environ.pop("HA_TOKEN", None)

        # Verify database values are still there after removing env vars
        response = await async_client.get("/api/v1/settings/")
        result = response.json()
        assert result["ha_url"] == "http://database-url:8123"
        assert result["ha_token"] == "database-token"
        assert result["ha_url_from_env"] is False
        assert result["ha_token_from_env"] is False

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_ha_settings_database_updates_accepted_but_ignored(self, async_client: AsyncClient):
        """Verify database updates are accepted but have no effect when env vars are set."""
        # Set environment variables
        os.environ["HA_URL"] = "http://supervisor/core"
        os.environ["HA_TOKEN"] = "env-token"

        try:
            # Attempt to update via API
            response = await async_client.put(
                "/api/v1/settings/",
                json={
                    "ha_url": "http://different-url:8123",
                    "ha_token": "different-token",
                },
            )

            # Update should succeed
            assert response.status_code == 200

            # But values should still be from env vars
            result = response.json()
            assert result["ha_url"] == "http://supervisor/core"
            assert result["ha_token"] == "env-token"
            assert result["ha_url_from_env"] is True
            assert result["ha_token_from_env"] is True

        finally:
            os.environ.pop("HA_URL", None)
            os.environ.pop("HA_TOKEN", None)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_ha_settings_empty_env_vars_treated_as_not_set(self, async_client: AsyncClient):
        """Verify empty environment variables are treated as not set."""
        # Set empty env vars
        os.environ["HA_URL"] = ""
        os.environ["HA_TOKEN"] = ""

        try:
            response = await async_client.get("/api/v1/settings/")
            result = response.json()

            # Empty env vars should be treated as not set
            assert result["ha_url_from_env"] is False
            assert result["ha_token_from_env"] is False
            assert result["ha_env_managed"] is False

        finally:
            os.environ.pop("HA_URL", None)
            os.environ.pop("HA_TOKEN", None)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_ha_settings_can_be_updated_normally_without_env_vars(self, async_client: AsyncClient):
        """Verify HA settings can be updated normally when env vars are not set."""
        # Ensure no env vars
        os.environ.pop("HA_URL", None)
        os.environ.pop("HA_TOKEN", None)

        # Update HA settings
        response = await async_client.put(
            "/api/v1/settings/",
            json={
                "ha_enabled": True,
                "ha_url": "http://192.168.1.100:8123",
                "ha_token": "my-long-lived-token",
            },
        )

        assert response.status_code == 200
        result = response.json()
        assert result["ha_enabled"] is True
        assert result["ha_url"] == "http://192.168.1.100:8123"
        assert result["ha_token"] == "my-long-lived-token"
        assert result["ha_url_from_env"] is False
        assert result["ha_token_from_env"] is False
        assert result["ha_env_managed"] is False

        # Verify persistence
        response = await async_client.get("/api/v1/settings/")
        result = response.json()
        assert result["ha_enabled"] is True
        assert result["ha_url"] == "http://192.168.1.100:8123"
        assert result["ha_token"] == "my-long-lived-token"


class TestOpenInSlicerOverride:
    """Per #1329, the desktop 'Open in Slicer' target can diverge from the API
    sidecar slicer. The new `open_in_slicer` setting is None by default (frontend
    inherits from `preferred_slicer`); setting it to 'orcaslicer' or 'bambu_studio'
    overrides only the desktop URI handoff, not the in-app SliceModal."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_open_in_slicer_default_is_null(self, async_client: AsyncClient):
        response = await async_client.get("/api/v1/settings/")
        assert response.status_code == 200
        # Default null so existing installs behave identically — the frontend
        # then falls back to preferred_slicer.
        assert response.json()["open_in_slicer"] is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_open_in_slicer_override_persists(self, async_client: AsyncClient):
        # Set preferred_slicer=bambu_studio (API sidecar) but
        # open_in_slicer=orcaslicer (desktop). Exactly the reporter's case:
        # slice via Bambu Studio sidecar, open files locally in OrcaSlicer.
        response = await async_client.put(
            "/api/v1/settings/",
            json={"preferred_slicer": "bambu_studio", "open_in_slicer": "orcaslicer"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["preferred_slicer"] == "bambu_studio"
        assert body["open_in_slicer"] == "orcaslicer"

        # Persisted across a fresh GET.
        get_resp = await async_client.get("/api/v1/settings/")
        assert get_resp.json()["preferred_slicer"] == "bambu_studio"
        assert get_resp.json()["open_in_slicer"] == "orcaslicer"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_open_in_slicer_can_be_cleared_to_null(self, async_client: AsyncClient):
        # Reset path: user picks an override, then later goes back to "Same as
        # API slicer". The literal string "None" the PUT path writes for a
        # None value must be normalized back to a real null on GET — otherwise
        # the frontend can't distinguish "explicit override absent" from
        # "explicit override set to a bogus value".
        await async_client.put(
            "/api/v1/settings/",
            json={"open_in_slicer": "orcaslicer"},
        )
        response = await async_client.put(
            "/api/v1/settings/",
            json={"open_in_slicer": None},
        )
        assert response.status_code == 200
        assert response.json()["open_in_slicer"] is None

        # And a fresh GET also sees it as null, not the literal string "None".
        get_resp = await async_client.get("/api/v1/settings/")
        assert get_resp.json()["open_in_slicer"] is None


class TestSimplifiedBackupRestore:
    """Integration tests for the simplified backup/restore endpoints (ZIP-based).

    Note: Tests that require actual file operations (backup creation) are skipped
    because the test suite uses an in-memory database. These tests focus on
    validation and error handling which don't require file I/O.
    """

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_restore_requires_zip_file(self, async_client: AsyncClient):
        """Verify restore rejects non-ZIP files."""
        files = {"file": ("backup.txt", b"not a zip file", "text/plain")}
        response = await async_client.post("/api/v1/settings/restore", files=files)

        assert response.status_code == 400
        assert "zip" in response.json()["detail"].lower()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_restore_requires_database_in_zip(self, async_client: AsyncClient):
        """Verify restore rejects ZIP without database file."""
        import io
        import zipfile

        # Create a ZIP without bambuddy.db
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("dummy.txt", "dummy content")
        zip_buffer.seek(0)

        files = {"file": ("backup.zip", zip_buffer.read(), "application/zip")}
        response = await async_client.post("/api/v1/settings/restore", files=files)

        assert response.status_code == 400
        assert "missing bambuddy.db" in response.json()["detail"].lower()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_restore_invalid_zip(self, async_client: AsyncClient):
        """Verify restore rejects corrupted ZIP files."""
        files = {"file": ("backup.zip", b"not valid zip content", "application/zip")}
        response = await async_client.post("/api/v1/settings/restore", files=files)

        assert response.status_code == 400
        assert "not a valid zip" in response.json()["detail"].lower()


async def _setup_auth_and_login(client: AsyncClient, username: str, password: str) -> str:
    """Enable auth, create the first (admin) user, and return their access token.

    Mirrors ``_setup_and_login`` in ``test_security.py``: POST /auth/setup with
    ``auth_enabled=True`` creates the first local admin, then /auth/login
    returns a JWT. Duplicated locally rather than imported so this file's
    auth-enabled tests don't couple to test_security.py's internals.
    """
    resp = await client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": username, "admin_password": password},
    )
    assert resp.status_code == 200, resp.text
    resp = await client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


class TestDisableLocalLoginLockoutGuard:
    """The PUT /settings/ handler refuses to disable local login (#1589) when
    doing so would lock every admin out of the install. Two independent
    refusal branches, plus the success path once both are satisfied.

    Note: the caller-link check (``if current_user is not None``) only runs
    when there IS an authenticated caller. With auth disabled (the default
    test client), ``current_user`` is always ``None``, so only the
    "no OIDC provider enabled" branch is reachable — the caller-link branch
    requires auth to be enabled and an authenticated request.
    """

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_disable_local_login_rejected_without_enabled_oidc_provider(self, async_client: AsyncClient):
        """No enabled OIDCProvider exists at all -> 400, regardless of auth state."""
        response = await async_client.put("/api/v1/settings/", json={"local_login_enabled": False})

        assert response.status_code == 400
        assert "no oidc provider is enabled" in response.json()["detail"].lower()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_disable_local_login_rejected_without_caller_oidc_link(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        """An enabled OIDCProvider exists, but the authenticated caller has no
        UserOIDCLink of their own -> 400 (they would lock themselves out)."""
        from sqlalchemy import select

        from backend.app.models.oidc_provider import OIDCProvider
        from backend.app.models.user import User

        token = await _setup_auth_and_login(async_client, "lockout_no_link_admin", "LockoutPw1!")

        provider = OIDCProvider(
            name="LockoutGuardProvider",
            issuer_url="https://lockout-guard.example.com",
            client_id="lockout-client",
            client_secret="lockout-secret",
            is_enabled=True,
        )
        db_session.add(provider)
        await db_session.commit()

        # Sanity check the admin user exists and truly has no OIDC link.
        result = await db_session.execute(select(User).where(User.username == "lockout_no_link_admin"))
        assert result.scalar_one_or_none() is not None

        response = await async_client.put(
            "/api/v1/settings/",
            json={"local_login_enabled": False},
            headers={"Authorization": f"Bearer {token}"},
        )

        assert response.status_code == 400
        assert "no oidc link" in response.json()["detail"].lower()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_disable_local_login_succeeds_when_caller_is_linked(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        """An enabled OIDCProvider exists AND the authenticated caller has a
        UserOIDCLink to it -> the update succeeds."""
        from sqlalchemy import select

        from backend.app.models.oidc_provider import OIDCProvider, UserOIDCLink
        from backend.app.models.user import User

        token = await _setup_auth_and_login(async_client, "lockout_linked_admin", "LockoutPw1!")

        provider = OIDCProvider(
            name="LockoutGuardLinkedProvider",
            issuer_url="https://lockout-guard-linked.example.com",
            client_id="lockout-linked-client",
            client_secret="lockout-linked-secret",
            is_enabled=True,
        )
        db_session.add(provider)
        await db_session.flush()

        result = await db_session.execute(select(User).where(User.username == "lockout_linked_admin"))
        admin = result.scalar_one()

        db_session.add(
            UserOIDCLink(
                user_id=admin.id,
                provider_id=provider.id,
                provider_user_id="lockout-linked-sub",
                provider_email="lockout_linked_admin@example.com",
            )
        )
        await db_session.commit()

        response = await async_client.put(
            "/api/v1/settings/",
            json={"local_login_enabled": False},
            headers={"Authorization": f"Bearer {token}"},
        )

        assert response.status_code == 200
        assert response.json()["local_login_enabled"] is False


class TestResetSettings:
    """POST /settings/reset (T-239): wipes every ``Settings`` row and returns
    ``DEFAULT_SETTINGS``.

    This characterizes the handler exactly as it exists today, including its
    known breadth: it deletes every row in the table, not just the ones a
    particular subsystem owns (e.g. ``auth_enabled`` gets wiped too). That is
    a separately tracked concern — these tests pin current behavior, they do
    not fix it.
    """

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_reset_returns_defaults_and_empties_table(self, async_client: AsyncClient, db_session: AsyncSession):
        """Seed several settings rows via the normal update path, POST
        /reset, and verify: 200 with the DEFAULT_SETTINGS body, the Settings
        table is empty afterward, and a subsequent GET reflects the reset
        (returns defaults again)."""
        from sqlalchemy import func, select

        from backend.app.api.routes.settings import DEFAULT_SETTINGS
        from backend.app.models.settings import Settings

        seed_response = await async_client.put(
            "/api/v1/settings/",
            json={"currency": "GBP", "date_format": "iso", "time_format": "12h"},
        )
        assert seed_response.status_code == 200
        assert seed_response.json()["currency"] == "GBP"

        count_before = (await db_session.execute(select(func.count()).select_from(Settings))).scalar_one()
        assert count_before > 0, "seeding via PUT /settings/ must have written at least one row"

        response = await async_client.post("/api/v1/settings/reset")

        assert response.status_code == 200
        assert response.json() == DEFAULT_SETTINGS.model_dump(mode="json")

        count_after = (await db_session.execute(select(func.count()).select_from(Settings))).scalar_one()
        assert count_after == 0, "reset must delete every row in the Settings table"

        get_response = await async_client.get("/api/v1/settings/")
        assert get_response.status_code == 200
        assert get_response.json()["currency"] == DEFAULT_SETTINGS.currency
        assert get_response.json()["date_format"] == DEFAULT_SETTINGS.date_format

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_reset_denied_for_caller_without_settings_update(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        """A caller in the Viewers group (SETTINGS_READ but not
        SETTINGS_UPDATE) must get 403, and the table must be left untouched."""
        from sqlalchemy import func, insert, select

        from backend.app.core.auth import get_password_hash
        from backend.app.models.group import Group, user_groups
        from backend.app.models.settings import Settings
        from backend.app.models.user import User

        # Bootstrap auth (also seeds the default groups, e.g. Viewers).
        token = await _setup_auth_and_login(async_client, "reset_denied_admin", "ResetDeniedPw1!")

        viewer = User(
            username="reset_denied_viewer",
            email="reset_denied_viewer@example.com",
            password_hash=get_password_hash("ResetDeniedViewer1!"),
            role="user",
            is_active=True,
        )
        db_session.add(viewer)
        await db_session.flush()

        viewers_group = (await db_session.execute(select(Group).where(Group.name == "Viewers"))).scalar_one_or_none()
        assert viewers_group is not None, "Viewers group must be seeded by setup"

        await db_session.execute(insert(user_groups).values(user_id=viewer.id, group_id=viewers_group.id))
        await db_session.commit()

        login = await async_client.post(
            "/api/v1/auth/login",
            json={"username": "reset_denied_viewer", "password": "ResetDeniedViewer1!"},
        )
        assert login.status_code == 200, login.text
        viewer_token = login.json()["access_token"]

        count_before = (await db_session.execute(select(func.count()).select_from(Settings))).scalar_one()

        response = await async_client.post(
            "/api/v1/settings/reset",
            headers={"Authorization": f"Bearer {viewer_token}"},
        )

        assert response.status_code == 403

        count_after = (await db_session.execute(select(func.count()).select_from(Settings))).scalar_one()
        assert count_after == count_before, "a denied reset must not delete any settings rows"

        # The admin token confirms SETTINGS_UPDATE really would have been
        # accepted, isolating the 403 above to the permission check.
        allowed_response = await async_client.post(
            "/api/v1/settings/reset",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert allowed_response.status_code == 200
