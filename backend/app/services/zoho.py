"""Zoho Books integration: OAuth refresh-token flow + contact search proxy.

Credentials live in the settings key-value table (never in env/code). The
access token is cached in memory and refreshed ~5 minutes before expiry;
a 401 from the Books API invalidates the cache and retries exactly once.
"""

import asyncio
import re
import time

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

_EXPIRY_MARGIN_SECONDS = 300
_REQUIRED_KEYS = ("zoho_client_id", "zoho_client_secret", "zoho_refresh_token", "zoho_organization_id")
DEFAULT_CONTACT_ID_FALLBACK = "66407000001237340"
DEFAULT_CONTACT_NAME_FALLBACK = "Client de passage"


class ZohoNotConfiguredError(Exception):
    """Raised when required Zoho settings are missing."""


class ZohoUpstreamError(Exception):
    """Raised when Zoho returns an error or is unreachable."""


class ZohoRequestRejected(ZohoUpstreamError):
    """Zoho rejected the payload (HTTP 400). The message is user-actionable."""


def _title_case_segments(value: str) -> str:
    """Capitalize every space- or hyphen-separated segment: 'jean-pierre' -> 'Jean-Pierre'."""
    result = []
    for index, part in enumerate(re.split(r"([ \-]+)", value.strip())):
        result.append(part if index % 2 else part[:1].upper() + part[1:].lower())
    return "".join(result)


def normalize_display_name(first_name: str, last_name: str) -> str:
    """House convention for person contacts: 'Jean-Pierre DUPONT'."""
    return f"{_title_case_segments(first_name)} {last_name.strip().upper()}".strip()


def _map_contact(contact: dict) -> dict:
    """Zoho contact -> the flat shape the Aito client picker consumes."""
    return {
        "id": contact.get("contact_id", ""),
        "name": contact.get("contact_name", ""),
        "company_name": contact.get("company_name", ""),
        # "business" | "individual". Aito stores this as a boolean at attach
        # time so the detail panel can say "Company name" instead of "Client
        # name" — it cannot be inferred from company_name, which is empty on
        # some business contacts in the live directory.
        "customer_sub_type": contact.get("customer_sub_type", ""),
        "phone": contact.get("phone", ""),
        "mobile": contact.get("mobile", ""),
        "email": contact.get("email", ""),
    }


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
            key: (await get_setting(db, key) or "") for key in (*_REQUIRED_KEYS, "zoho_base_url", "zoho_accounts_url")
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
                raise ZohoUpstreamError(payload.get("error") or f"Token refresh failed (HTTP {response.status_code})")
            self._access_token = token
            self._expires_at = time.monotonic() + int(payload.get("expires_in", 3600)) - _EXPIRY_MARGIN_SECONDS
            return token

    async def _request(
        self,
        db: AsyncSession,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        json: dict | None = None,
    ) -> dict:
        """One Books API call: token, org scoping, 401-retry-once, error mapping.

        ``path`` is relative to ``/books/v3`` (e.g. ``"/contacts/z1"``).
        """
        config = await self._load_config(db)
        request_params = {"organization_id": config["zoho_organization_id"], **(params or {})}
        for attempt in (1, 2):
            token = await self.get_access_token(db)
            try:
                async with self._client() as client:
                    response = await client.request(
                        method,
                        f"{config['zoho_base_url']}/books/v3{path}",
                        params=request_params,
                        json=json,
                        headers={"Authorization": f"Zoho-oauthtoken {token}"},
                    )
            except httpx.HTTPError as e:
                raise ZohoUpstreamError(f"Zoho Books unreachable: {e.__class__.__name__}") from e
            if response.status_code == 401 and attempt == 1:
                self.invalidate_token()  # token revoked/expired early — refresh once
                continue
            try:
                payload = response.json() if response.content else {}
            except ValueError as e:
                raise ZohoUpstreamError(f"Zoho returned a non-JSON response (HTTP {response.status_code})") from e
            if response.status_code == 400:
                raise ZohoRequestRejected(payload.get("message") or "Zoho rejected the request")
            if response.status_code >= 400:
                raise ZohoUpstreamError(f"Zoho Books error (HTTP {response.status_code})")
            return payload
        raise ZohoUpstreamError("Zoho Books rejected the refreshed token")  # unreachable guard

    async def search_contacts(self, db: AsyncSession, query: str) -> list[dict]:
        payload = await self._request(db, "GET", "/contacts", params={"search_text": query})
        return [_map_contact(c) for c in payload.get("contacts", [])]

    async def create_contact(
        self,
        db: AsyncSession,
        *,
        company_name: str,
        first_name: str,
        last_name: str,
        email: str,
        phone: str,
    ) -> dict:
        """Create a Books customer. Currency/language are omitted so the org
        defaults apply. Phone lands on the primary contact person's ``mobile``
        because the contact-level fields are read-only mirrors of it."""
        company = company_name.strip()
        if company:
            contact_name, sub_type = company, "business"
            person_first, person_last = "", ""
        else:
            contact_name = normalize_display_name(first_name, last_name)
            sub_type = "individual"
            person_first = _title_case_segments(first_name)
            person_last = last_name.strip().upper()

        payload: dict = {
            "contact_name": contact_name,
            "contact_type": "customer",
            "customer_sub_type": sub_type,
        }
        if company:
            payload["company_name"] = company

        person = {}
        if person_first:
            person["first_name"] = person_first
        if person_last:
            person["last_name"] = person_last
        if email.strip():
            person["email"] = email.strip()
        if phone.strip():
            person["mobile"] = phone.strip()
        if person:
            payload["contact_persons"] = [{**person, "is_primary_contact": True}]

        body = await self._request(db, "POST", "/contacts", json=payload)
        return _map_contact(body.get("contact", {}))

    async def update_contact_person(
        self,
        db: AsyncSession,
        contact_id: str,
        *,
        email: str | None,
        phone: str | None,
        phone_field: str,
    ) -> None:
        """Write email/phone to the contact's primary person.

        The contact-level ``email``/``phone``/``mobile`` fields are read-only
        mirrors of the primary contact person, so writes must target the person.
        A contact with no persons at all gets one created.
        """
        contact = (await self._request(db, "GET", f"/contacts/{contact_id}")).get("contact", {})
        persons = contact.get("contact_persons") or []
        primary = next((p for p in persons if p.get("is_primary_contact")), persons[0] if persons else None)

        fields: dict = {}
        if email is not None:
            fields["email"] = email
        if phone is not None:
            fields[phone_field] = phone
        if not fields:
            return

        if primary:
            await self._request(db, "PUT", f"/contacts/contactpersons/{primary['contact_person_id']}", json=fields)
        else:
            await self._request(
                db,
                "POST",
                "/contacts/contactpersons",
                json={
                    "contact_id": contact_id,
                    "first_name": contact.get("first_name", ""),
                    "last_name": contact.get("last_name", ""),
                    "is_primary_contact": True,
                    **fields,
                },
            )

    async def get_default_contact(self, db: AsyncSession) -> tuple[str, str]:
        """The contact preselected in the Aito modal. Read from settings, never
        from Zoho — the modal must open even when Books is unreachable."""
        from backend.app.api.routes.settings import get_setting

        contact_id = await get_setting(db, "zoho_default_contact_id")
        name = await get_setting(db, "zoho_default_contact_name")
        return (contact_id or DEFAULT_CONTACT_ID_FALLBACK, name or DEFAULT_CONTACT_NAME_FALLBACK)


zoho_service = ZohoService()
