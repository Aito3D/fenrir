from typing import Literal

from pydantic import BaseModel, Field, field_validator


class HeimdallTestRequest(BaseModel):
    """Optional overrides so the Settings button can try a credential that is
    typed but not yet saved. Empty strings mean "use what is saved"."""

    base_url: str | None = Field(default=None, max_length=300)
    token: str | None = Field(default=None, max_length=300)

    @field_validator("base_url")
    @classmethod
    def _guard(cls, v: str | None) -> str | None:
        if v is None or not v.strip():
            return None
        from backend.app.api.routes._url_safety import assert_safe_lan_service_url

        assert_safe_lan_service_url(v.strip(), label="Heimdall URL")
        return v.strip()

    @field_validator("token")
    @classmethod
    def _blank_is_none(cls, v: str | None) -> str | None:
        return v.strip() if v and v.strip() else None


class HeimdallStatus(BaseModel):
    configured: bool
    reachable: bool | None
    error: Literal["unauthorized", "forbidden", "unreachable"] | None
