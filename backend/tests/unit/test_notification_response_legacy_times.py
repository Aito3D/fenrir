"""NotificationProviderResponse reads an unparsable stored time as null; Create still rejects it."""

from datetime import datetime

import pytest
from pydantic import ValidationError

from backend.app.schemas.notification import NotificationProviderCreate, NotificationProviderResponse

_NOW = datetime(2026, 1, 1)


def _row(**times):
    return {
        "id": 1,
        "name": "p",
        "provider_type": "ntfy",
        "config": {},
        "created_at": _NOW,
        "updated_at": _NOW,
        **times,
    }


@pytest.mark.parametrize(
    ("stored", "expected"),
    [("", None), ("abc", None), ("25:00", None), ("8:00", "08:00"), ("22:30", "22:30"), (None, None)],
)
def test_response_time_fields(stored, expected):
    r = NotificationProviderResponse.model_validate(
        _row(quiet_hours_start=stored, quiet_hours_end=stored, daily_digest_time=stored)
    )
    assert (r.quiet_hours_start, r.quiet_hours_end, r.daily_digest_time) == (expected,) * 3


def test_create_still_rejects_malformed_time():
    with pytest.raises(ValidationError):
        NotificationProviderCreate(name="p", provider_type="ntfy", config={}, quiet_hours_start="abc")
