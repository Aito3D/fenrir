"""PATCH /notifications/{id} validates and normalises the time fields like create does."""

import pytest
from httpx import AsyncClient
from pydantic import ValidationError

from backend.app.schemas.notification import NotificationProviderUpdate

_FIELDS = ("quiet_hours_start", "quiet_hours_end", "daily_digest_time")


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize("field", _FIELDS)
async def test_patch_normalises_time(async_client: AsyncClient, notification_provider_factory, db_session, field):
    provider = await notification_provider_factory()

    response = await async_client.patch(f"/api/v1/notifications/{provider.id}", json={field: "8:00"})

    assert response.status_code == 200, response.text
    assert response.json()[field] == "08:00"
    # the response model re-normalises, so assert on the stored row too
    await db_session.refresh(provider)
    assert getattr(provider, field) == "08:00"


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize("bad", ["25:99", "abc", "12", "1:2:3"])
async def test_patch_malformed_time_is_422_and_row_unchanged(
    async_client: AsyncClient, notification_provider_factory, bad
):
    provider = await notification_provider_factory(daily_digest_time="07:30")

    response = await async_client.patch(f"/api/v1/notifications/{provider.id}", json={"daily_digest_time": bad})

    assert response.status_code == 422
    assert (await async_client.get(f"/api/v1/notifications/{provider.id}")).json()["daily_digest_time"] == "07:30"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_patch_null_time_clears_it(async_client: AsyncClient, notification_provider_factory):
    provider = await notification_provider_factory(daily_digest_time="07:30")

    response = await async_client.patch(f"/api/v1/notifications/{provider.id}", json={"daily_digest_time": None})

    assert response.status_code == 200, response.text
    assert response.json()["daily_digest_time"] is None


def test_update_schema_validates_times():
    assert NotificationProviderUpdate(quiet_hours_start="8:05").quiet_hours_start == "08:05"
    assert NotificationProviderUpdate().quiet_hours_start is None
    with pytest.raises(ValidationError):
        NotificationProviderUpdate(quiet_hours_end="24:00")
