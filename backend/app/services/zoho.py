"""Zoho Books integration: OAuth refresh-token flow + contact search proxy.

Credentials live in the settings key-value table (never in env/code). The
access token is cached in memory and refreshed ~5 minutes before expiry;
a 401 from the Books API invalidates the cache and retries exactly once.
"""

import asyncio
import time

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

_EXPIRY_MARGIN_SECONDS = 300
_REQUIRED_KEYS = ("zoho_client_id", "zoho_client_secret", "zoho_refresh_token", "zoho_organization_id")


class ZohoNotConfiguredError(Exception):
    """Raised when required Zoho settings are missing."""


class ZohoUpstreamError(Exception):
    """Raised when Zoho returns an error or is unreachable."""


class ZohoService:
    def __init__(self) -> None:
        self._access_token: str | None = None
        self._expires_at: float = 0.0
        self._refresh_lock = asyncio.Lock()
        # Test seam: httpx.MockTransport in unit tests, None (real network) in prod.
        self.transport: httpx.AsyncBaseTransport | None = None

    def invalidate_token(self) -> None:
        self._access_token = None
        self._expires_at = 0.0

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=10.0, transport=self.transport)

    async def _load_config(self, db: AsyncSession) -> dict[str, str]:
        from backend.app.api.routes.settings import get_setting

        config = {
            key: (await get_setting(db, key) or "")
            for key in (*_REQUIRED_KEYS, "zoho_base_url", "zoho_accounts_url")
        }
        config["zoho_base_url"] = config["zoho_base_url"] or "https://www.zohoapis.eu"
        config["zoho_accounts_url"] = config["zoho_accounts_url"] or "https://accounts.zoho.eu"
        if any(not config[key] for key in _REQUIRED_KEYS):
            raise ZohoNotConfiguredError("Zoho credentials are not configured")
        return config

    async def is_configured(self, db: AsyncSession) -> bool:
        try:
            await self._load_config(db)
            return True
        except ZohoNotConfiguredError:
            return False

    async def get_access_token(self, db: AsyncSession) -> str:
        if self._access_token and time.monotonic() < self._expires_at:
            return self._access_token
        async with self._refresh_lock:
            # Double-checked: another waiter may have refreshed while we queued for the lock.
            if self._access_token and time.monotonic() < self._expires_at:
                return self._access_token
            config = await self._load_config(db)
            try:
                async with self._client() as client:
                    response = await client.post(
                        f"{config['zoho_accounts_url']}/oauth/v2/token",
                        data={
                            "grant_type": "refresh_token",
                            "client_id": config["zoho_client_id"],
                            "client_secret": config["zoho_client_secret"],
                            "refresh_token": config["zoho_refresh_token"],
                        },
                    )
            except httpx.HTTPError as e:
                raise ZohoUpstreamError(f"Zoho accounts unreachable: {e.__class__.__name__}") from e
            try:
                payload = response.json() if response.content else {}
            except ValueError as e:
                raise ZohoUpstreamError(f"Zoho returned a non-JSON response (HTTP {response.status_code})") from e
            token = payload.get("access_token")
            if response.status_code != 200 or not token:
                raise ZohoUpstreamError(
                    payload.get("error") or f"Token refresh failed (HTTP {response.status_code})"
                )
            self._access_token = token
            self._expires_at = time.monotonic() + int(payload.get("expires_in", 3600)) - _EXPIRY_MARGIN_SECONDS
            return token

    async def search_contacts(self, db: AsyncSession, query: str) -> list[dict]:
        config = await self._load_config(db)
        for attempt in (1, 2):
            token = await self.get_access_token(db)
            try:
                async with self._client() as client:
                    response = await client.get(
                        f"{config['zoho_base_url']}/books/v3/contacts",
                        params={"organization_id": config["zoho_organization_id"], "search_text": query},
                        headers={"Authorization": f"Zoho-oauthtoken {token}"},
                    )
            except httpx.HTTPError as e:
                raise ZohoUpstreamError(f"Zoho Books unreachable: {e.__class__.__name__}") from e
            if response.status_code == 401 and attempt == 1:
                self.invalidate_token()  # token revoked/expired early — refresh once
                continue
            if response.status_code != 200:
                raise ZohoUpstreamError(f"Zoho Books error (HTTP {response.status_code})")
            try:
                contacts = response.json().get("contacts", [])
            except ValueError as e:
                raise ZohoUpstreamError(f"Zoho returned a non-JSON response (HTTP {response.status_code})") from e
            return [
                {
                    "id": c.get("contact_id", ""),
                    "name": c.get("contact_name", ""),
                    "company_name": c.get("company_name", ""),
                    "phone": c.get("phone", ""),
                    "mobile": c.get("mobile", ""),
                    "email": c.get("email", ""),
                }
                for c in contacts
            ]
        raise ZohoUpstreamError("Zoho Books rejected the refreshed token")  # unreachable guard


zoho_service = ZohoService()
