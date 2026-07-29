"""Zoho Books integration: OAuth refresh-token flow + contact search proxy.

Credentials live in the settings key-value table (never in env/code). The
access token is cached in memory and refreshed ~5 minutes before expiry;
a 401 from the Books API invalidates the cache and retries exactly once.
"""

import asyncio
import re
import time
from urllib.parse import urlparse

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services.aito_quote_export import Catalogue

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


class ZohoNotFound(ZohoUpstreamError):
    """The document does not exist (HTTP 404).

    A subclass of ZohoUpstreamError so every existing handler still catches it;
    callers that care — the sync worker, which must tell "the quote was deleted
    in Books" from "Books is down" — catch this first.
    """


class ZohoAmbiguousReferenceError(ZohoUpstreamError):
    """``find_estimate_by_reference`` found more than one plausible match, or
    the lone survivor belongs to a customer other than the one asked for.

    Books does not enforce ``reference_number`` uniqueness, and its list
    filter is not guaranteed to be an exact match — so a caller that trusted
    ``estimates[0]`` without verifying it could silently adopt an arbitrary
    LIVE customer's estimate, which the next sync tick would then overwrite
    with this project's own line items. A subclass of ZohoUpstreamError so it
    is still caught by any handler that only knows the base class, but the
    sync worker catches it by name first to fail closed — record the
    ambiguity and stop, never guess.
    """


def _normalize_reference_number(value: str | None) -> str:
    """Collapse incidental whitespace/case differences for reference-number comparison.

    Books may echo a reference number back trimmed, padded, or case-changed; comparing
    raw strings would then miss our own estimate and let a duplicate get POSTed. This
    only normalizes whitespace and case — it does not do substring or prefix matching,
    so 'AITO-7' and 'AITO-70' still compare unequal.
    """
    return (value or "").strip().casefold()


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


def _map_estimate_summary(estimate: dict) -> dict:
    """Zoho estimate -> the flat row the Aito quote picker lists."""
    return {
        "id": estimate.get("estimate_id", ""),
        "number": estimate.get("estimate_number", ""),
        "customer_name": estimate.get("customer_name", ""),
        "date": estimate.get("date", ""),
        "total": float(estimate.get("total") or 0),
        "currency_code": estimate.get("currency_code", ""),
        "status": estimate.get("status", ""),
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
            if response.status_code == 404:
                raise ZohoNotFound(payload.get("message") or "Not found in Zoho Books")
            if response.status_code == 400:
                raise ZohoRequestRejected(payload.get("message") or "Zoho rejected the request")
            if response.status_code >= 400:
                raise ZohoUpstreamError(f"Zoho Books error (HTTP {response.status_code})")
            return payload
        raise ZohoUpstreamError("Zoho Books rejected the refreshed token")  # unreachable guard

    async def search_contacts(self, db: AsyncSession, query: str) -> list[dict]:
        payload = await self._request(db, "GET", "/contacts", params={"search_text": query})
        return [_map_contact(c) for c in payload.get("contacts", [])]

    async def search_estimates(self, db: AsyncSession, query: str) -> list[dict]:
        """Quotes for the Aito import picker.

        An empty query lists the most recent quotes, so the dropdown is useful
        before the user types anything — a quote just written is at the top.
        """
        params: dict = {"per_page": 25}
        if query:
            params["search_text"] = query
        else:
            params.update({"sort_column": "date", "sort_order": "D"})
        payload = await self._request(db, "GET", "/estimates", params=params)
        return [_map_estimate_summary(e) for e in payload.get("estimates", [])]

    async def get_estimate(self, db: AsyncSession, estimate_id: str) -> dict:
        """The full estimate, line items included."""
        return (await self._request(db, "GET", f"/estimates/{estimate_id}")).get("estimate", {})

    async def find_estimate_by_reference(
        self, db: AsyncSession, reference_number: str, customer_id: str
    ) -> dict | None:
        """The estimate carrying this exact ``reference_number`` AND
        belonging to ``customer_id``, if Books has exactly one.

        Used to make quote creation idempotent: before POSTing a new estimate
        with ``reference_number = f"AITO-{project.id}"``, the caller checks
        whether one already exists (e.g. because a previous tick's POST
        succeeded but the commit that would have recorded its id failed) and
        adopts it instead of creating a duplicate.

        Books' ``reference_number`` query param is not documented as an exact
        match (and Books does not enforce the field's uniqueness at all), so
        the raw response is filtered client-side to a normalized exact-string
        match (whitespace-trimmed, casefolded — see ``_normalize_reference_number``)
        before anything from it is trusted — a contains-style match returning
        "AITO-70" for a query of "AITO-7" must not be adopted as AITO-7's
        quote, and normalizing case/whitespace does not change that: the two
        still compare unequal. The survivor is further required to belong to
        ``customer_id``: an estimate under our reference number that belongs
        to someone else's customer is a coincidence or corruption, never ours
        to touch. A falsy ``customer_id`` (nothing to verify against — e.g. a
        project whose ``client_id`` is unset) or a survivor with no
        ``customer_id`` of its own is treated the same as a mismatch: without
        both sides present there is nothing to verify, so adoption is refused
        rather than silently skipping the check.

        Returns None when nothing survives — the expected, common case, not
        an error. Raises ``ZohoAmbiguousReferenceError`` when more than one
        estimate survives the exact-match filter, or when the lone survivor's
        customer does not match (or cannot be verified): silently resolving
        either case by picking ``estimates[0]`` (the bug this replaces) risks
        adopting an arbitrary live customer's estimate and then overwriting
        it with this project's line items on the very next push.
        """
        payload = await self._request(db, "GET", "/estimates", params={"reference_number": reference_number})
        wanted = _normalize_reference_number(reference_number)
        matches = [
            e
            for e in (payload.get("estimates") or [])
            if _normalize_reference_number(e.get("reference_number")) == wanted
        ]
        if not matches:
            return None
        if len(matches) > 1:
            raise ZohoAmbiguousReferenceError(
                f"{len(matches)} Zoho estimates share reference_number {reference_number!r}; "
                "refusing to guess which one is ours"
            )
        estimate = matches[0]
        if not customer_id or not estimate.get("customer_id") or estimate.get("customer_id") != customer_id:
            raise ZohoAmbiguousReferenceError(
                f"An estimate with reference_number {reference_number!r} exists in Zoho but belongs to a "
                "different customer"
            )
        return estimate

    async def create_estimate(self, db: AsyncSession, payload: dict) -> dict:
        """Create a draft estimate. Template, salesperson, notes, terms, expiry
        and numbering are all left to the org defaults — this app sends only
        what it owns."""
        return (await self._request(db, "POST", "/estimates", json=payload)).get("estimate", {})

    async def update_estimate_lines(self, db: AsyncSession, estimate_id: str, line_items: list[dict]) -> dict:
        """Replace the line items and nothing else.

        A partial PUT: Books preserves customer_id, notes, terms,
        reference_number, template and salesperson when they are absent from
        the body. Verified against the live org — do not "helpfully" resend
        them, that is how a hand-edited note gets clobbered.
        """
        body = {"line_items": line_items}
        return (await self._request(db, "PUT", f"/estimates/{estimate_id}", json=body)).get("estimate", {})

    async def set_estimate_status(self, db: AsyncSession, estimate_id: str, status: str) -> None:
        """`sent`, `accepted` or `declined`. There is no `draft`: Books offers
        no way back, so declining an estimate is one-way through the API."""
        await self._request(db, "POST", f"/estimates/{estimate_id}/status/{status}")

    async def get_catalogue(self, db: AsyncSession) -> Catalogue:
        """The AITO 3D item ids and the services tax, from settings.

        Defaults are the live org's real ids, so a fresh install works without
        configuration; overriding them in settings covers a catalogue change
        without a redeploy.
        """
        from backend.app.api.routes.settings import get_setting

        async def value(key: str, fallback: str) -> str:
            return (await get_setting(db, key)) or fallback

        return Catalogue(
            scan_item_id=await value("zoho_item_scan_id", "66407000006501192"),
            modelisation_item_id=await value("zoho_item_modelisation_id", "66407000006485001"),
            impression_item_id=await value("zoho_item_impression_id", "66407000006485012"),
            usinage_item_id=await value("zoho_item_usinage_id", "66407000006884825"),
            tax_id=await value("zoho_service_tax_id", "66407000009281008"),
        )

    async def get_contact(self, db: AsyncSession, contact_id: str) -> dict:
        return _map_contact((await self._request(db, "GET", f"/contacts/{contact_id}")).get("contact", {}))

    async def books_app_url(self, db: AsyncSession, estimate_id: str) -> str:
        """Deep link into the Books web app for this org's region.

        The API host is not the app host, so the region is taken from the
        accounts URL: accounts.zoho.eu -> books.zoho.eu, and
        accounts.zoho.com.au -> books.zoho.com.au.
        """
        config = await self._load_config(db)
        host = urlparse(config["zoho_accounts_url"]).hostname or "accounts.zoho.eu"
        suffix = host[len("accounts.") :] if host.startswith("accounts.") else host
        return f"https://books.{suffix}/app/{config['zoho_organization_id']}#/estimates/{estimate_id}"

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
        contact = _map_contact(body.get("contact", {}))
        # Books is expected to echo `customer_sub_type` back, but the value we
        # just sent is already known and authoritative — don't let a response
        # that omits (or disagrees with) it silently downgrade a company to
        # `isCompany: false` in the UI.
        contact["customer_sub_type"] = sub_type
        return contact

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
