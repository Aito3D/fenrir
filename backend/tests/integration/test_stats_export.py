"""Tests for the /archives/stats/export date-range support (#stats-timeframe)."""

from datetime import datetime, timezone

import pytest
from httpx import AsyncClient


class TestStatsExportDateRange:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_export_respects_date_range(self, async_client: AsyncClient, archive_factory, printer_factory):
        """date_from/date_to bound the export window instead of the days default."""
        printer = await printer_factory()
        await archive_factory(
            printer.id,
            print_name="In Window",
            status="failed",
            failure_reason="spaghetti",
            created_at=datetime(2024, 6, 10, 12, 0, 0, tzinfo=timezone.utc),
        )
        await archive_factory(
            printer.id,
            print_name="Out Of Window",
            status="failed",
            failure_reason="adhesion",
            created_at=datetime(2024, 3, 1, 12, 0, 0, tzinfo=timezone.utc),
        )

        response = await async_client.get(
            "/api/v1/archives/stats/export?format=csv&date_from=2024-06-01&date_to=2024-06-30"
        )
        assert response.status_code == 200
        csv_text = response.content.decode("utf-8")
        assert "spaghetti" in csv_text
        assert "adhesion" not in csv_text
        assert "Total Prints,1" in csv_text.replace('"', "")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_export_date_range_respects_client_timezone(
        self, async_client: AsyncClient, archive_factory, printer_factory
    ):
        """tz_offset_minutes shifts the local-day window like /archives/stats."""
        printer = await printer_factory()
        # Jun 15 01:00 UTC == Jun 14 15:00 for a UTC-10 client
        await archive_factory(
            printer.id,
            status="failed",
            failure_reason="spaghetti",
            created_at=datetime(2024, 6, 15, 1, 0, 0, tzinfo=timezone.utc),
        )

        with_offset = await async_client.get(
            "/api/v1/archives/stats/export?format=csv&date_from=2024-06-14&date_to=2024-06-14&tz_offset_minutes=-600"
        )
        assert with_offset.status_code == 200
        assert "Total Prints,1" in with_offset.content.decode("utf-8").replace('"', "")

        without_offset = await async_client.get(
            "/api/v1/archives/stats/export?format=csv&date_from=2024-06-14&date_to=2024-06-14"
        )
        assert without_offset.status_code == 200
        assert "Total Prints,0" in without_offset.content.decode("utf-8").replace('"', "")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_export_days_fallback_still_works(self, async_client: AsyncClient, archive_factory, printer_factory):
        """Without dates the export keeps its rolling-days behaviour."""
        printer = await printer_factory()
        await archive_factory(printer.id, status="failed", failure_reason="spaghetti")

        response = await async_client.get("/api/v1/archives/stats/export?format=csv&days=30")
        assert response.status_code == 200
        csv_text = response.content.decode("utf-8").replace('"', "")
        assert "Total Prints,1" in csv_text
        assert "Period (days),30" in csv_text
