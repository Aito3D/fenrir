"""Project URL validation on ProjectCreate / ProjectUpdate (#1155): blank clears,
http(s) is trimmed and kept, anything else is rejected."""

import pytest
from pydantic import ValidationError

from backend.app.schemas.project import ProjectCreate, ProjectUpdate


@pytest.mark.parametrize("blank", ["", "   ", "\t\n "])
def test_blank_url_becomes_none(blank):
    assert ProjectCreate(name="P", url=blank).url is None
    assert ProjectUpdate(url=blank).url is None


def test_http_urls_are_trimmed_and_kept_case_intact():
    assert ProjectCreate(name="P", url="  https://MakerWorld.com/m/1  ").url == "https://MakerWorld.com/m/1"
    assert ProjectUpdate(url="HTTP://example.com").url == "HTTP://example.com"
    assert ProjectUpdate(url=None).url is None


@pytest.mark.parametrize("bad", ["javascript:alert(1)", " ftp://x", "example.com"])
def test_non_http_urls_are_rejected(bad):
    with pytest.raises(ValidationError, match="url must start with http:// or https://"):
        ProjectUpdate(url=bad)
