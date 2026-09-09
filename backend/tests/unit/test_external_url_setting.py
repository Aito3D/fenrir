"""``external_url`` validation on save.

The setting is the base of every link Bambuddy hands out — notification
images, OIDC redirects and, for the fork, the tracking link printed on every
Zoho estimate. A value without a scheme ("aito.pf") produced links like
``aito.pf/t/K7F3XQ`` on every quote until someone noticed; a value with a
query string produced ``…?x=1/t/K7F3XQ``. Reject the shapes that cannot be
a base, keep the ones that can, and never touch an empty value — empty is
the documented "not configured" state.
"""

import pytest
from pydantic import ValidationError

from backend.app.schemas.settings import AppSettingsUpdate


@pytest.mark.parametrize(
    ("value", "stored"),
    [
        ("https://aito.pf", "https://aito.pf"),
        ("https://aito.pf/", "https://aito.pf"),  # the trailing slash is dropped once, here
        ("http://192.168.1.10:8000", "http://192.168.1.10:8000"),
        ("https://home.example/bambuddy/", "https://home.example/bambuddy"),  # a sub-path is a valid base
        (" https://aito.pf ", "https://aito.pf"),
        ("", ""),
        ("   ", ""),
    ],
)
def test_accepts_absolute_http_bases(value: str, stored: str):
    assert AppSettingsUpdate(external_url=value).external_url == stored


def test_none_is_left_alone():
    assert AppSettingsUpdate(external_url=None).external_url is None


@pytest.mark.parametrize(
    "value",
    [
        "aito.pf",  # no scheme: the link would be a relative path on the quote PDF
        "localhost:8000",  # urlparse reads this as scheme "localhost"
        "ftp://aito.pf",
        "javascript:alert(1)",
        "https://",  # scheme, no host
        "https://aito.pf/?utm=1",  # a query string cannot be a base
        "https://aito.pf/#top",
        "https://aito.pf/t/K7F3XQ ok",  # whitespace inside
    ],
)
def test_rejects_what_cannot_be_a_link_base(value: str):
    with pytest.raises(ValidationError, match="External URL"):
        AppSettingsUpdate(external_url=value)


@pytest.mark.asyncio
async def test_route_refuses_a_bad_value_and_keeps_the_old_one(async_client):
    r = await async_client.put("/api/v1/settings/", json={"external_url": "https://aito.pf/"})
    assert r.status_code == 200, r.text
    assert r.json()["external_url"] == "https://aito.pf"
    r = await async_client.put("/api/v1/settings/", json={"external_url": "aito.pf"})
    assert r.status_code == 422
    assert (await async_client.get("/api/v1/settings/")).json()["external_url"] == "https://aito.pf"
