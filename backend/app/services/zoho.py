"""Zoho Books integration: OAuth refresh-token flow + contact search proxy.

Credentials live in the settings key-value table (never in env/code). The
access token is cached in memory and refreshed ~5 minutes before expiry;
a 401 from the Books API invalidates the cache and retries exactly once.
"""

import asyncio
import json
import logging
import re
import time
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote as urlquote, urlparse

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services.aito_quote_export import Catalogue
from backend.app.services.aito_shipping import SERVICE_LABELS, ShippingItem, merge_shipping_catalogue

logger = logging.getLogger(__name__)


def _seg(value: str) -> str:
    """Escape one path segment before it is interpolated into a Books URL.

    ``quote_id`` reaches us as free text on the create payload, and httpx
    normalises dot segments when it builds the request — so an id of
    ``../../../crm/v2/Leads`` escapes the ``/books/v3`` prefix entirely and
    reaches an arbitrary Zoho endpoint carrying the org's OAuth token. Escaping
    with ``safe=""`` keeps ``/`` and ``.`` inside the segment where they belong.

    The schema also constrains ``quote_id``; this is the backstop for every
    other id (contacts, contact persons) and for whatever the next caller
    forgets to validate."""
    return urlquote(value, safe="")


_EXPIRY_MARGIN_SECONDS = 300
_REQUIRED_KEYS = ("zoho_client_id", "zoho_client_secret", "zoho_refresh_token", "zoho_organization_id")
DEFAULT_CONTACT_ID_FALLBACK = "66407000001237340"
DEFAULT_CONTACT_NAME_FALLBACK = "Client de passage"

# One refresh a day. The ids barely ever move and the rates move rarely; the
# point of the cache is that opening the create drawer costs nothing.
_SHIPPING_CACHE_TTL = timedelta(hours=24)

# T-011: how long a failed shipping-catalogue refresh is remembered so a
# Books outage does not cost one more /items request per deferring project on
# every sync tick — mirrors zoho_filaments._FAIL_COOLDOWN (same 30s window,
# same "process-local timestamp, cleared on the next success" shape), scaled
# down to this module's much simpler single-item-list refresh: no lock, no
# generation counter, and no negative-cache exception replay, because
# get_shipping_catalogue never raises in the first place — a failed refresh
# here already falls through to serving whatever is cached (see its
# docstring), so short-circuiting the network call is all this needs to add.
# Deliberately process-local rather than a persisted setting: it must not
# appear in a settings export/snapshot, and a process restart should clear it
# immediately rather than have a stale memo outlive the failure it recorded.
_SHIPPING_FAIL_COOLDOWN = timedelta(seconds=30)
_shipping_fail_at: datetime | None = None

# Statuses Books will only accept once the estimate has left draft. Its
# lifecycle is draft -> sent -> accepted/declined and it enforces that: POSTing
# /status/accepted to a draft estimate returns 400. Confirmed against the live
# org, not inferred — see
# docs/superpowers/specs/2026-07-29-aito-accept-gate-design.md.
_STATUSES_NEEDING_SENT = frozenset({"accepted", "declined"})


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


class ZohoRateLimited(ZohoUpstreamError):
    """Zoho Books is throttling us (HTTP 429).

    A subclass of ZohoUpstreamError so every existing handler that only knows
    the base class — every route in api/routes/zoho.py and api/routes/aito.py,
    the generic ``except (ZohoNotConfiguredError, ZohoUpstreamError)`` sites,
    the docstring/comment example in this module — still catches it and
    behaves exactly as before (a 502 to the browser, etc). ``sync_project``
    (aito_quote_sync.py) catches it by name first instead: unlike an outage,
    retrying the identical request will simply work once the window clears,
    so a 429 must not spend a slot of the sync worker's failure budget the
    way a generic ZohoUpstreamError does — see that handler for the deferral.

    ``retry_after`` is the ``Retry-After`` header, in seconds, when Books
    sends one and it parses; otherwise None. Not currently acted on beyond
    being available to a caller that wants it — the sync worker's own
    response is "stop attempting the rest of this tick", not a timed wait.
    """

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


def _parse_retry_after(value: str | None) -> float | None:
    """``Retry-After`` per RFC 9110: either a whole number of seconds, or an
    HTTP-date. Returns seconds either way (the date form as seconds from
    now, floored at 0), or None if the header is missing or neither form
    parses — callers must treat that the same as "no hint", never raise.
    """
    if not value:
        return None
    value = value.strip()
    try:
        return float(value)
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max((when - datetime.now(timezone.utc)).total_seconds(), 0.0)


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
        # Mirrors of the primary contact person, so the panel's client editor
        # can prefill first/last name from the record Books actually holds
        # rather than guess a split from the card's display-name snapshot.
        "first_name": contact.get("first_name", ""),
        "last_name": contact.get("last_name", ""),
    }


def _map_email_recipient(contact: dict) -> dict:
    """One entry of a Books estimate-email ``to_contacts`` list.

    ``name`` goes through ``normalize_display_name`` so a contact person
    reads the same here as in the Aito client picker. Books splits the name
    into first/last and some rows carry only one of the two, which that
    helper already tolerates.
    """
    return {
        "email": contact.get("email", ""),
        "name": normalize_display_name(contact.get("first_name", ""), contact.get("last_name", "")),
        "contact_person_id": contact.get("contact_person_id", ""),
    }


def _map_contact_person(person: dict) -> dict:
    """One Books ``contact_persons`` row -> the shape the Aito contact picker
    lists. ``name`` is house-cased like every other person name in Aito;
    the raw first/last are kept so a sheet can prefill an edit form. Every
    string is ``""`` rather than None: Books omits empty fields."""
    first = person.get("first_name") or ""
    last = person.get("last_name") or ""
    return {
        "contact_person_id": person.get("contact_person_id") or "",
        "first_name": first,
        "last_name": last,
        "name": normalize_display_name(first, last),
        "email": person.get("email") or "",
        "phone": person.get("phone") or "",
        "mobile": person.get("mobile") or "",
        "is_primary": bool(person.get("is_primary_contact")),
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


def _map_invoice(invoice: dict) -> dict:
    """Zoho invoice -> the flat row the Aito Invoice card renders.

    Deliberately the same shape as ``_map_estimate_summary`` above plus the
    two fields only an invoice has: ``balance`` (what is still owed, which is
    what separates a part-paid invoice from a paid one) and ``due_date``.
    """
    return {
        "id": invoice.get("invoice_id", ""),
        "number": invoice.get("invoice_number", ""),
        "date": invoice.get("date", ""),
        "due_date": invoice.get("due_date", ""),
        "total": float(invoice.get("total") or 0),
        "balance": float(invoice.get("balance") or 0),
        "currency_code": invoice.get("currency_code", ""),
        "status": invoice.get("status", ""),
    }


# How many pages of invoices one ``list_invoices_modified_since`` pass will
# walk. 200 rows a page, so 10 pages is ~2000 invoices — comfortably more than
# the backfill window the poll opens with (a 90-day window read ~4 pages on
# the live org) and a hard ceiling on a watermark that has somehow gone stale
# enough to select the org's whole history.
_MAX_INVOICE_PAGES = 10


def _map_invoice_change(invoice: dict) -> dict:
    """Zoho invoice list row -> the shape the invoice poll attributes and caches.

    ``_map_invoice`` above plus the three fields that make an unattributed row
    usable: ``reference_number`` (how an invoice names its project),
    ``customer_id`` (so a match can be sanity-checked against the card's own
    client) and ``last_modified_time`` (the poll's watermark). Kept as its own
    mapper rather than widening ``_map_invoice``, which feeds the Invoice card
    and should keep rendering exactly what it renders.
    """
    return {
        **_map_invoice(invoice),
        "reference_number": invoice.get("reference_number", ""),
        "customer_id": invoice.get("customer_id", ""),
        "last_modified_time": invoice.get("last_modified_time", ""),
    }


def _map_invoice_history(invoice: dict) -> dict:
    """Zoho invoice list row -> what the client rating scores.

    Its own mapper, like ``_map_invoice_change``: the rating needs the two
    dates that say WHEN an invoice was paid (``last_payment_date``, with
    ``last_modified_time`` as the fallback the probe of 2026-09-22 settled
    on), and nothing the Invoice card renders should grow a field for it.
    Numbers are coerced so one sloppy row cannot poison a customer's score.
    """

    def _num(value) -> float:
        try:
            return float(value or 0)
        except (TypeError, ValueError):
            return 0.0

    return {
        "number": invoice.get("invoice_number", ""),
        "date": invoice.get("date", ""),
        "due_date": invoice.get("due_date", ""),
        "status": invoice.get("status", ""),
        "balance": _num(invoice.get("balance")),
        "total": _num(invoice.get("total")),
        "last_payment_date": invoice.get("last_payment_date", "") or "",
        "last_modified_time": invoice.get("last_modified_time", "") or "",
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

    async def _send(
        self,
        db: AsyncSession,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        json: dict | None = None,
    ) -> httpx.Response:
        """One Books API call: token, org scoping, 401-retry-once.

        Returns the raw response and interprets nothing. Split out of
        ``_request`` so a binary endpoint (``get_estimate_pdf``) can share the
        token handling without inheriting the JSON parse that would choke on
        a PDF body. ``path`` is relative to ``/books/v3``.
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
            return response
        raise ZohoUpstreamError("Zoho Books rejected the refreshed token")  # unreachable guard

    def _raise_for_status(self, response: httpx.Response, payload: dict) -> None:
        """Books' error mapping, shared by the JSON and binary paths.

        Error responses are JSON even when the success response is a PDF, so
        both callers can supply a parsed payload for the message.
        """
        if response.status_code == 404:
            raise ZohoNotFound(payload.get("message") or "Not found in Zoho Books")
        if response.status_code == 400:
            raise ZohoRequestRejected(payload.get("message") or "Zoho rejected the request")
        if response.status_code == 429:
            raise ZohoRateLimited(
                f"Zoho Books error (HTTP {response.status_code})",
                retry_after=_parse_retry_after(response.headers.get("Retry-After")),
            )
        if response.status_code >= 400:
            raise ZohoUpstreamError(f"Zoho Books error (HTTP {response.status_code})")

    async def _request(
        self,
        db: AsyncSession,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        json: dict | None = None,
    ) -> dict:
        """One Books API call returning parsed JSON.

        ``path`` is relative to ``/books/v3`` (e.g. ``"/contacts/z1"``).
        """
        response = await self._send(db, method, path, params=params, json=json)
        try:
            payload = response.json() if response.content else {}
        except ValueError as e:
            raise ZohoUpstreamError(f"Zoho returned a non-JSON response (HTTP {response.status_code})") from e
        self._raise_for_status(response, payload)
        return payload

    async def get_estimate_pdf(self, db: AsyncSession, estimate_id: str) -> bytes:
        """The estimate rendered as a PDF, for printing.

        Deliberately not routed through ``_request``: that parses every
        response as JSON, which is correct for every other endpoint here and
        fatal for a PDF body. Error responses ARE still JSON, so the failure
        path parses and the success path does not.
        """
        response = await self._send(db, "GET", f"/estimates/{_seg(estimate_id)}", params={"accept": "pdf"})
        if response.status_code >= 400:
            try:
                payload = response.json() if response.content else {}
            except ValueError:
                payload = {}
            self._raise_for_status(response, payload)
        if not response.content.startswith(b"%PDF-"):
            # A 200 that is not a PDF means Books answered with something else
            # entirely (an HTML login page on a bad token, or a JSON error it
            # forgot to give a 4xx). Streaming that to the browser as a PDF
            # produces a blank print dialog and no clue why.
            raise ZohoUpstreamError("Zoho Books did not return a PDF")
        return response.content

    async def get_estimate_email_content(self, db: AsyncSession, estimate_id: str) -> dict:
        """The estimate's default email, as Books would send it right now.

        Books nests this under ``data`` rather than a named key. ``to_contacts``
        is the client's contact persons WITH their addresses — the only
        authoritative answer to "who may receive this quote", which is why the
        send path re-reads it rather than trusting what a caller echoes back.

        Recipients with no address are dropped: Books includes contact persons
        who have none, and offering one is offering a send that must fail.
        """
        data = (await self._request(db, "GET", f"/estimates/{_seg(estimate_id)}/email")).get("data", {})
        return {
            "subject": data.get("subject", ""),
            "body": data.get("body", ""),
            "recipients": [_map_email_recipient(c) for c in (data.get("to_contacts") or []) if c.get("email")],
        }

    async def email_estimate(self, db: AsyncSession, estimate_id: str, *, to_mail_ids: list[str]) -> None:
        """Email the estimate through Books, on the org's default template.

        ``subject`` and ``body`` are deliberately absent from the body: Books
        renders its own default estimate template when they are omitted, and
        that is the one carrying the org's branding. Echoing back the HTML
        ``get_estimate_email_content`` returned would round-trip the template
        through this app for no gain and give us a way to corrupt it.

        Books marks the estimate ``sent`` as a side effect. Callers must NOT
        follow this with ``set_estimate_status`` or ``advance_estimate_status``.
        """
        await self._request(db, "POST", f"/estimates/{_seg(estimate_id)}/email", json={"to_mail_ids": to_mail_ids})

    async def search_contacts(self, db: AsyncSession, query: str) -> list[dict]:
        payload = await self._request(db, "GET", "/contacts", params={"search_text": query})
        # Books' /contacts search matches vendors as well as customers, but an
        # estimate can only be issued to a customer — and a vendor sharing a
        # customer's name shows up as a phantom duplicate in the picker.
        contacts = [c for c in payload.get("contacts", []) if c.get("contact_type", "customer") == "customer"]
        return [_map_contact(c) for c in contacts]

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
        return (await self._request(db, "GET", f"/estimates/{_seg(estimate_id)}")).get("estimate", {})

    async def list_estimate_comments(self, db: AsyncSession, estimate_id: str) -> list[dict]:
        """The estimate's comments AND its system history.

        This is where Books records "viewed by the customer" and "accepted",
        with the timestamp of when it actually happened rather than when we
        next polled. That difference is the whole reason the timeline mirrors
        this instead of inferring status changes from the estimate itself.
        """
        payload = await self._request(db, "GET", f"/estimates/{_seg(estimate_id)}/comments")
        return payload.get("comments") or []

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
        ``customer_id`` of its own each refuse adoption too — without both
        sides present there is nothing to verify — but raise their own
        message naming which side was missing, rather than reusing the
        genuine-mismatch text: "belongs to a different customer" is false and
        misleading when there was no customer to compare against at all, and
        sends whoever reads ``quote_sync_error`` hunting for a mismatched
        estimate that does not exist.

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
        estimate_customer_id = estimate.get("customer_id")
        if not customer_id:
            raise ZohoAmbiguousReferenceError(
                f"An estimate with reference_number {reference_number!r} exists in Zoho, but this project has "
                "no linked Zoho customer to verify it against"
            )
        if not estimate_customer_id:
            raise ZohoAmbiguousReferenceError(
                f"An estimate with reference_number {reference_number!r} exists in Zoho, but Zoho did not "
                "return a customer_id for it, so ownership could not be verified"
            )
        if estimate_customer_id != customer_id:
            raise ZohoAmbiguousReferenceError(
                f"An estimate with reference_number {reference_number!r} exists in Zoho but belongs to a "
                "different customer"
            )
        return estimate

    async def create_estimate(self, db: AsyncSession, payload: dict) -> dict:
        """Create a draft estimate. Template, salesperson, terms, expiry and
        numbering are left to the org defaults; notes are the one field a
        caller may set (the tracking link) — this app sends only what it
        owns."""
        return (await self._request(db, "POST", "/estimates", json=payload)).get("estimate", {})

    async def update_estimate_lines(
        self, db: AsyncSession, estimate_id: str, line_items: list[dict], notes: str | None = None
    ) -> dict:
        """Replace the line items and nothing else.

        A partial PUT: Books preserves customer_id, notes, terms,
        reference_number, template and salesperson when they are absent from
        the body. Verified against the live org — do not "helpfully" resend
        them, that is how a hand-edited note gets clobbered.
        """
        body: dict = {"line_items": line_items}
        if notes is not None:
            # Customer notes print on the estimate PDF Books emails — the
            # tracking link's only way into the quote. Omitted (not '') when
            # unset so a partial PUT keeps whatever someone typed in Books.
            body["notes"] = notes
        return (await self._request(db, "PUT", f"/estimates/{_seg(estimate_id)}", json=body)).get("estimate", {})

    async def update_estimate_notes(self, db: AsyncSession, estimate_id: str, notes: str) -> dict:
        """Customer notes and nothing else — the same partial PUT contract as
        update_estimate_lines, for the create path, which must read Books'
        default notes back before it can append the tracking block."""
        return (await self._request(db, "PUT", f"/estimates/{_seg(estimate_id)}", json={"notes": notes})).get(
            "estimate", {}
        )

    async def update_estimate_fields(self, db: AsyncSession, estimate_id: str, fields: dict) -> dict:
        """PUT a partial estimate body (e.g. {"expiry_date": ...}). Books
        merges partial PUTs, the same way update_estimate_notes relies on."""
        return (await self._request(db, "PUT", f"/estimates/{_seg(estimate_id)}", json=fields)).get("estimate", {})

    async def set_estimate_status(self, db: AsyncSession, estimate_id: str, status: str) -> None:
        """`sent`, `accepted` or `declined`. There is no `draft`: Books offers
        no way back, so declining an estimate is one-way through the API."""
        await self._request(db, "POST", f"/estimates/{_seg(estimate_id)}/status/{_seg(status)}")

    async def advance_estimate_status(
        self, db: AsyncSession, estimate_id: str, target: str, *, current: str | None = None
    ) -> None:
        """Set an estimate's status, marking it sent first when Books demands it.

        ``current`` is the status the caller already holds AUTHORITATIVELY — an
        estimate dict it just fetched. Omit it and this reads the estimate
        itself; never pass the local ``quote_status`` snapshot, which the model
        documents as going stale (accepting a quote in Zoho does not update the
        card — see AitoProject.quote_status).

        Only an explicit "draft" triggers the extra call. An estimate whose
        status Books omits is not evidence of anything, so this fails OPEN and
        attempts the target exactly as it did before the guard existed.

        Marking sent does not email the client — Books emails through a
        separate endpoint. It is the same act our own "Mark as sent" performs,
        which is why chaining through it is invisible to the client.
        """
        if target in _STATUSES_NEEDING_SENT:
            if current is None:
                current = (await self.get_estimate(db, estimate_id)).get("status") or ""
            if current == "draft":
                await self.set_estimate_status(db, estimate_id, "sent")
        await self.set_estimate_status(db, estimate_id, target)

    async def get_catalogue(self, db: AsyncSession) -> Catalogue:
        """The AITO 3D item ids and the services tax, from settings.

        Defaults are the live org's real ids, so a fresh install works without
        configuration; overriding them in settings covers a catalogue change
        without a redeploy.
        """
        from backend.app.api.routes.settings import get_setting

        async def value(key: str, fallback: str) -> str:
            return (await get_setting(db, key)) or fallback

        # get_catalogue sits on the sync worker's hot path, including
        # _create_quote's fast path, which must make ZERO Zoho calls when a
        # project has no priced service. Ownership (Catalogue.item_ids() ->
        # is_foreign) only needs ids already learned, never a fresh rate, so
        # a cache read here is correct — refresh=False is deliberate, not a
        # placeholder for a warm-up this call never performs.
        #
        # This is also the ONLY route the sync worker has to the shipping
        # catalogue, and it never warms it: the cache is warmed exclusively
        # by the drawer's GET /aito/shipping/services endpoint. In practice
        # that is fine — a shipping-carrying project implies the drawer was
        # used to attach it, so the cache is warm by construction, and it
        # stays warm because the settings row is durable and
        # merge_shipping_catalogue never forgets an id once learned.
        #
        # But a project that gains shipping WITHOUT going through the drawer
        # (e.g. a direct DB write, or a future entry point) has no
        # self-healing route back to a warm cache — nothing here will ever
        # fetch it. The sync task must detect an unresolved service itself
        # (Catalogue.shipping_item_id raising KeyError) and warm the cache
        # then, rather than assume this call already did.
        shipping = await self.get_shipping_catalogue(db, refresh=False)
        return Catalogue(
            scan_item_id=await value("zoho_item_scan_id", "66407000006501192"),
            modelisation_item_id=await value("zoho_item_modelisation_id", "66407000006485001"),
            impression_item_id=await value("zoho_item_impression_id", "66407000006485012"),
            usinage_item_id=await value("zoho_item_usinage_id", "66407000006884825"),
            tax_id=await value("zoho_service_tax_id", "66407000009281008"),
            maindoeuvre_item_id=await value("zoho_item_maindoeuvre_id", "66407000001604625"),
            shipping={service: item.item_id for service, item in shipping.items()},
        )

    async def list_items(self, db: AsyncSession, search_text: str) -> list[dict]:
        """Books items matching a free-text search. Used to resolve the
        shipping catalogue by name; nothing else needs the item list."""
        body = await self._request(db, "GET", "/items", params={"search_text": search_text})
        return body.get("items") or []

    async def list_items_page(
        self, db: AsyncSession, *, category: str, page: int, per_page: int
    ) -> tuple[list[dict], bool]:
        """One page of Books items filtered by the ``cf_nature_du_produit``
        custom field, plus a flag saying whether more pages follow.

        Zoho accepts the custom field as a server-side query parameter, so the
        whole filament catalogue arrives in two requests instead of scanning
        every item in the org.
        """
        body = await self._request(
            db,
            "GET",
            "/items",
            params={"cf_nature_du_produit": category, "page": page, "per_page": per_page},
        )
        return body.get("items") or [], bool((body.get("page_context") or {}).get("has_more_page"))

    async def get_shipping_catalogue(self, db: AsyncSession, *, refresh: bool = True) -> dict[str, ShippingItem]:
        """The 5 "Livraison Avion" items, resolved from Books and cached.

        Refreshed only when the cache is missing or more than
        ``_SHIPPING_CACHE_TTL`` old, so opening the create drawer never costs a
        Zoho call and the whole feature costs at most one request a day.

        ``refresh=False`` means "answer from cache only, never touch the
        network" — for callers that need OWNERSHIP (an id already learned is
        still owned, cold cache or not), not an up-to-date rate. The default
        stays ``True`` so the drawer's own endpoint keeps refreshing without
        passing anything.

        A failed refresh is NOT an error: the previous cache is returned
        unchanged. Ids are never forgotten — see
        ``aito_shipping.merge_shipping_catalogue`` for why that rule is
        load-bearing rather than merely tidy. An empty dict means either Books
        has never been reachable, or a refresh DID succeed but none of the
        items it returned matched a known service name (e.g. the catalogue
        was respelled) — callers must treat either case as "cannot push",
        never as "no shipping services exist".

        T-011: a failed refresh is also remembered for
        ``_SHIPPING_FAIL_COOLDOWN``, so a caller arriving while Books is
        still down is answered from whatever is cached without repeating
        the ``/items`` request — this call has no reason to distinguish "no
        one has asked yet" from "someone already asked and it failed a
        moment ago". This applies uniformly to every ``refresh=True``
        caller, drawer-driven or not; there is no bypass, mirroring
        ``zoho_filaments.fetch_catalogue``.
        """
        global _shipping_fail_at

        from backend.app.api.routes.settings import get_setting, set_setting

        raw = await get_setting(db, "zoho_shipping_catalogue")
        try:
            cached = json.loads(raw) if raw else {}
        except ValueError:
            cached = {}
        if not isinstance(cached, dict):
            # Valid JSON but the wrong shape ("null", "[]", ...) — treat like
            # no cache rather than raising on the .items() below.
            cached = {}

        checked_at = await get_setting(db, "zoho_shipping_catalogue_at")
        fresh = False
        if checked_at:
            try:
                age = datetime.now(timezone.utc).replace(tzinfo=None) - datetime.fromisoformat(checked_at)
                fresh = age < _SHIPPING_CACHE_TTL
            except (TypeError, ValueError):
                # TypeError: fromisoformat parsed a tz-aware datetime (an
                # offset-bearing string) and subtracting it from the naive
                # `now` above raises TypeError, not ValueError.
                fresh = False

        if refresh and not fresh:
            now = datetime.now(timezone.utc)
            if _shipping_fail_at is not None and now - _shipping_fail_at < _SHIPPING_FAIL_COOLDOWN:
                # T-011: a refresh failed recently — short-circuit exactly as
                # a failed refresh would (serve whatever is cached, log
                # nothing new) instead of repeating an /items request that is
                # very likely to fail again the same way.
                pass
            else:
                try:
                    items = await self.list_items(db, "Livraison Avion")
                except (ZohoNotConfiguredError, ZohoUpstreamError) as e:
                    # Deliberately swallowed: a stale catalogue still bills
                    # correctly, and the drawer must open with Books unreachable.
                    logger.warning("Aito shipping catalogue refresh failed: %s", e)
                    _shipping_fail_at = now
                else:
                    _shipping_fail_at = None
                    cached = merge_shipping_catalogue(cached, items)
                    await set_setting(db, "zoho_shipping_catalogue", json.dumps(cached))
                    await set_setting(
                        db,
                        "zoho_shipping_catalogue_at",
                        datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
                    )
                    # Deliberately no commit here: this getter is called from
                    # request handlers and the sync worker, neither of which is
                    # commit-neutral (create_project commits its whole unit of
                    # work exactly once; run_sync_once commits once per project).
                    # A commit hidden in here would persist a half-built caller
                    # transaction. The caller's own commit (or get_db's
                    # end-of-request commit) carries these two set_setting calls
                    # along with it; if the caller instead rolls back, the cache
                    # write is discarded and the next call just re-fetches from
                    # Zoho — benign, at worst one extra API call.

        return {
            service: ShippingItem(
                item_id=entry["item_id"],
                name=entry.get("name") or SERVICE_LABELS.get(service, ""),
                rate=entry.get("rate"),
            )
            for service, entry in cached.items()
            if isinstance(entry, dict) and entry.get("item_id")
        }

    async def get_contact(self, db: AsyncSession, contact_id: str) -> dict:
        return _map_contact((await self._request(db, "GET", f"/contacts/{_seg(contact_id)}")).get("contact", {}))

    async def _contact_persons_raw(self, db: AsyncSession, contact_id: str) -> list[dict]:
        """The contact's ``contact_persons`` array as Books sends it. One GET
        — the same read ``get_contact`` makes, whose mapper drops this array."""
        contact = (await self._request(db, "GET", f"/contacts/{_seg(contact_id)}")).get("contact", {})
        return list(contact.get("contact_persons") or [])

    async def list_contact_persons(self, db: AsyncSession, contact_id: str) -> list[dict]:
        return [_map_contact_person(p) for p in await self._contact_persons_raw(db, contact_id)]

    async def create_contact_person(
        self,
        db: AsyncSession,
        contact_id: str,
        *,
        first_name: str,
        last_name: str,
        email: str,
        phone: str,
    ) -> dict:
        """Add a person to an existing Books customer. The number lands in
        ``mobile`` like ``create_contact`` does; the new person is primary
        only when the account had none, so adding a colleague never demotes
        the person Books already mirrors at contact level."""
        existing = await self._contact_persons_raw(db, contact_id)
        payload: dict = {
            "contact_id": contact_id,
            "first_name": first_name,
            "last_name": last_name,
            "is_primary_contact": not existing,
        }
        if email.strip():
            payload["email"] = email.strip()
        if phone.strip():
            payload["mobile"] = phone.strip()
        body = await self._request(db, "POST", "/contacts/contactpersons", json=payload)
        return _map_contact_person(body.get("contact_person") or {})

    async def _books_app_base(self, db: AsyncSession) -> str:
        """`https://books.<region>/app/<org>` for this org, no fragment.

        The API host is not the app host, so the region is taken from the
        accounts URL: accounts.zoho.eu -> books.zoho.eu, and
        accounts.zoho.com.au -> books.zoho.com.au.

        Split out of ``books_app_url`` so the invoice link can reuse the
        region derivation without copying it — the two differ only in the
        fragment, and a second hand-written copy of this is a second place
        for a new Zoho region to be wrong.
        """
        config = await self._load_config(db)
        host = urlparse(config["zoho_accounts_url"]).hostname or "accounts.zoho.eu"
        suffix = host[len("accounts.") :] if host.startswith("accounts.") else host
        return f"https://books.{suffix}/app/{config['zoho_organization_id']}"

    async def books_app_url(self, db: AsyncSession, estimate_id: str) -> str:
        """Deep link to an estimate in the Books web app.

        The fragment is `#/quotes/`, not `#/estimates/`: the REST API still
        calls these estimates (every endpoint in this service does), but the
        Books web app routes them under quotes, and an `#/estimates/` link
        does not resolve. The two names are the same object.
        """
        return f"{await self._books_app_base(db)}#/quotes/{estimate_id}"

    async def books_invoice_url(self, db: AsyncSession, invoice_id: str) -> str:
        """Deep link to an invoice in the Books web app.

        Unlike ``books_app_url`` above, the REST name and the app route agree
        here — both are `invoices`, so no renaming is needed.
        """
        return f"{await self._books_app_base(db)}#/invoices/{invoice_id}"

    async def list_project_invoices(self, db: AsyncSession, estimate_id: str, customer_id: str) -> list[dict]:
        """Every invoice Books has raised from this estimate, newest first.

        A list, not one invoice: Books allows an estimate to be invoiced in
        parts, and collapsing that to a single row in here would hide from
        the caller that there was ever a choice to make. The Aito card shows
        the newest and reports the count.

        ``estimate_id`` MUST be non-empty and is refused when it is not. This
        is not defensive habit: Books treats `estimate_id=` (empty) as "no
        filter" and answers with the org's ENTIRE invoice list, so passing a
        project's unset ``quote_id`` straight through would render a stranger's
        invoice — with their name, total and number — on this project's card.
        Verified against the live org; the empty query returned 200 unrelated
        invoices.

        Survivors are further required to belong to ``customer_id``, mirroring
        ``find_estimate_by_reference`` above: Books resolved the join itself
        here, so a mismatch should be impossible — which is exactly why one
        occurring is worth a warning rather than a silent render. Invoices
        that fail the check are dropped, not raised on: this feeds a read-only
        card, and hiding a suspect row degrades better than 502-ing a panel
        whose every other card is fine.

        Returns [] when there is no invoice — the common case for a quoted
        project, not an error.
        """
        if not estimate_id:
            return []
        payload = await self._request(db, "GET", "/invoices", params={"estimate_id": estimate_id})
        invoices = payload.get("invoices") or []
        if customer_id:
            kept = [i for i in invoices if not i.get("customer_id") or i.get("customer_id") == customer_id]
            if len(kept) != len(invoices):
                logger.warning(
                    "Zoho returned %d invoice(s) for estimate %s belonging to another customer; dropped",
                    len(invoices) - len(kept),
                    estimate_id,
                )
            invoices = kept
        # Newest first. Books' `date` is ISO `YYYY-MM-DD`, so a string sort is
        # a date sort; a missing date sorts last rather than crashing the sort.
        invoices.sort(key=lambda i: i.get("date") or "", reverse=True)
        return [_map_invoice(i) for i in invoices]

    async def list_invoices_modified_since(self, db: AsyncSession, since: str) -> list[dict]:
        """Every invoice in the org touched since ``since``, newest first.

        The one read that is NOT keyed on a project. ``list_project_invoices``
        above answers "what has Books raised from THIS estimate", which is a
        per-project pull: it costs one call per card, it only runs for cards
        already known to be invoiced, and — because the whole surface keys off
        ``estimate_id=`` — it is structurally blind to an invoice raised in
        Books without converting the estimate. This answers the other
        question, "what changed in Books", for one call per pass regardless of
        how many cards the board holds.

        ``since`` must be Books' own timestamp spelling, offset included:
        `2026-09-20T10:00:00+0000` is accepted and `...Z` is refused with a
        400 (verified against the live org), so callers must not hand this a
        bare ISO string from ``datetime.isoformat()``.

        Rows keep ``reference_number`` and ``customer_id``, which
        ``_map_invoice`` drops — they are what attributes an invoice to a
        project without a second call each. They do NOT carry ``estimate_id``:
        Books omits it from list rows (it reads ``None`` on every row,
        including invoices that are demonstrably linked), so a caller that
        needs the link must read the invoice itself — see ``get_invoice_raw``.

        Paginated because the caller's first pass is a backfill over months,
        not a five-minute window. Capped at ``_MAX_INVOICE_PAGES``: a
        watermark that somehow ends up at the epoch must cost a bounded
        number of calls, not walk the org's entire invoice history.
        """
        rows: list[dict] = []
        for page in range(1, _MAX_INVOICE_PAGES + 1):
            payload = await self._request(
                db,
                "GET",
                "/invoices",
                params={
                    "last_modified_time": since,
                    "sort_column": "last_modified_time",
                    "sort_order": "D",
                    "per_page": "200",
                    "page": str(page),
                },
            )
            rows.extend(_map_invoice_change(i) for i in payload.get("invoices") or [])
            if not (payload.get("page_context") or {}).get("has_more_page"):
                break
        return rows

    async def get_invoice_raw(self, db: AsyncSession, invoice_id: str) -> dict:
        """One invoice as Books states it, unmapped.

        Separate from ``get_invoice`` because ``_map_invoice`` exists to feed
        the Invoice card and deliberately keeps only what that card renders —
        which excludes ``estimate_id``, the single field the invoice poll
        reads this for. Widening ``_map_invoice`` instead would put a field on
        every invoice response in the app to serve one caller.
        """
        return (await self._request(db, "GET", f"/invoices/{_seg(invoice_id)}")).get("invoice", {})

    async def link_invoice_to_estimate(self, db: AsyncSession, invoice_id: str, estimate_id: str) -> None:
        """Attach an already-raised invoice to the estimate it was billed from.

        Same field as the create, ``invoiced_estimate_id``, and the same
        effect: Books fills the invoice's ``estimate_id``, moves the estimate
        to status ``invoiced`` and lists the invoice in its ``invoice_ids``.
        Nothing else on the invoice moves — verified on FA-26-4331, which was
        paid in full when it was linked and stayed paid in full.

        Exists because the link is the only thing that makes an invoice
        visible to this app (see ``list_project_invoices``), so a create that
        comes back unlinked needs a way to be repaired rather than a warning
        in a log nobody reads.
        """
        await self._request(db, "PUT", f"/invoices/{_seg(invoice_id)}", json={"invoiced_estimate_id": estimate_id})

    async def get_invoice(self, db: AsyncSession, invoice_id: str) -> dict:
        """One invoice by id, in the flat shape the Invoice card renders.

        Reads the invoice ITSELF rather than looking for it in
        ``list_project_invoices``: the estimate filter answers with what Books
        has linked to the quote, and a caller that already holds an invoice id
        wants that invoice's own figures — after a payment lands, say, when
        the create response it is holding still says draft.
        """
        invoice = (await self._request(db, "GET", f"/invoices/{_seg(invoice_id)}")).get("invoice", {})
        return _map_invoice(invoice) if invoice else {}

    async def get_invoice_pdf(self, db: AsyncSession, invoice_id: str) -> bytes:
        """The invoice rendered as a PDF, for printing.

        Same shape and same reasoning as ``get_estimate_pdf`` above: not
        routed through ``_request`` because that parses every response as
        JSON, and a 200 that is not a PDF is treated as an upstream failure
        rather than streamed to the browser as a blank print dialog.
        """
        response = await self._send(db, "GET", f"/invoices/{_seg(invoice_id)}", params={"accept": "pdf"})
        if response.status_code >= 400:
            try:
                payload = response.json() if response.content else {}
            except ValueError:
                payload = {}
            self._raise_for_status(response, payload)
        if not response.content.startswith(b"%PDF-"):
            raise ZohoUpstreamError("Zoho Books did not return a PDF")
        return response.content

    async def get_invoice_email_content(self, db: AsyncSession, invoice_id: str) -> dict:
        """The invoice's default email, as Books would send it right now.

        The estimate twin of this (``get_estimate_email_content``) explains
        the shape; Books nests both under ``data`` and names the recipient
        list ``to_contacts`` on both. Kept as a separate method rather than
        one parameterised by document type: the two are different REST
        resources, and a shared helper taking a path fragment would read as
        if the endpoints were interchangeable when only their payload is.

        Recipients with no address are dropped, for the same reason as on the
        estimate side: offering one is offering a send that must fail.
        """
        data = (await self._request(db, "GET", f"/invoices/{_seg(invoice_id)}/email")).get("data", {})
        return {
            "subject": data.get("subject", ""),
            "body": data.get("body", ""),
            "recipients": [_map_email_recipient(c) for c in (data.get("to_contacts") or []) if c.get("email")],
        }

    async def email_invoice(self, db: AsyncSession, invoice_id: str, *, to_mail_ids: list[str]) -> None:
        """Email the invoice through Books, on the org's default template.

        ``subject`` and ``body`` are omitted for the reason spelled out on
        ``email_estimate``: Books renders its own default template only when
        they are absent, and that is the one carrying the org's branding.

        Books marks the invoice ``sent`` as a side effect, which is why the
        Aito route re-reads the invoice afterwards rather than pushing a
        status of its own.
        """
        await self._request(db, "POST", f"/invoices/{_seg(invoice_id)}/email", json={"to_mail_ids": to_mail_ids})

    async def create_invoice(self, db: AsyncSession, payload: dict) -> dict:
        """Raise an invoice. Returns Books' own copy, ids and totals included.

        There is no conversion endpoint to use instead — Zoho's KB states
        plainly that an estimate cannot be converted to an invoice through
        the API — so the caller builds the body and passes ``estimate_id`` to
        link the two. See ``aito_invoice_create`` for what goes in it.

        Created as a DRAFT: no ``status`` is sent and Books' default for a
        new invoice is draft, which is what the Aito button promises. Nothing
        here emails anything.
        """
        return (await self._request(db, "POST", "/invoices", json=payload)).get("invoice", {})

    async def list_customer_payments(self, db: AsyncSession, customer_id: str) -> list[dict]:
        """Every payment Books holds for this customer, with what is unspent.

        This is where a customer's deposits actually live: a retainer's
        payment is booked as an advance with an ``unused_amount`` that drops
        the moment it is applied to any invoice, and a row carries the
        ``retainerinvoice_id`` it came from (empty for a plain advance). One
        call answers "what does this customer still have on account" for
        every deposit at once — linked to a quote or raised by hand — where
        the estimate's own ``retainerinvoices`` list only knows the ones
        raised from it, and keeps calling them paid after they are spent.

        ``customer_id`` MUST be non-empty, for the same reason as
        ``list_project_invoices``: Books reads an empty filter as no filter
        and answers with the org's entire payment list.

        First page only. Books pages at 200 rows and a single customer with
        more payments than that is not a case this shop has.
        """
        if not customer_id:
            return []
        payload = await self._request(db, "GET", "/customerpayments", params={"customer_id": customer_id})
        return list(payload.get("customerpayments") or [])

    async def list_customer_retainers(self, db: AsyncSession, customer_id: str) -> list[dict]:
        """The customer's retainer invoices, summarised (id, number, status,
        total). Read once at invoice time to put a RET number beside each
        payment the dialog lists — a payment row knows its retainer only by
        id. Same empty-filter refusal as ``list_customer_payments``.
        """
        if not customer_id:
            return []
        payload = await self._request(db, "GET", "/retainerinvoices", params={"customer_id": customer_id})
        return list(payload.get("retainerinvoices") or [])

    async def create_retainer_invoice(
        self, db: AsyncSession, *, customer_id: str, reference_number: str, description: str, amount: int, today: str
    ) -> dict:
        """Raise a retainer (deposit) invoice for a customer — the same body
        Heimdall sends when it books a quote deposit, so the invoice sweep's
        reference match (`reference_number` = the quote number) works for a
        deposit taken by hand exactly as for one taken on the terminal."""
        payload = {
            "customer_id": customer_id,
            "reference_number": reference_number,
            "date": today,
            "line_items": [{"description": description, "rate": int(amount), "quantity": 1}],
        }
        return (await self._request(db, "POST", "/retainerinvoices", json=payload)).get("retainerinvoice", {})

    async def record_customer_payment(
        self,
        db: AsyncSession,
        *,
        customer_id: str,
        payment_mode: str,
        amount: int,
        reference_number: str,
        description: str,
        today: str,
        invoice_id: str | None = None,
        retainerinvoice_id: str | None = None,
    ) -> dict:
        """One customer payment, applied to exactly one target: an invoice
        (`invoices[{invoice_id, amount_applied}]`) or a retainer invoice
        (top-level `retainerinvoice_id`, per Zoho's v3 docs — there is no
        separate retainer-payment endpoint). No `account_id`: Books files
        it under its default undeposited-funds account. An empty
        `reference_number` is omitted rather than sent blank."""
        if (invoice_id is None) == (retainerinvoice_id is None):
            raise ValueError("record_customer_payment needs exactly one of invoice_id / retainerinvoice_id")
        payload: dict = {
            "customer_id": customer_id,
            "payment_mode": payment_mode,
            "amount": int(amount),
            "date": today,
            "description": description,
        }
        if reference_number:
            payload["reference_number"] = reference_number
        if invoice_id is not None:
            payload["invoices"] = [{"invoice_id": invoice_id, "amount_applied": int(amount)}]
        else:
            payload["retainerinvoice_id"] = retainerinvoice_id
        return (await self._request(db, "POST", "/customerpayments", json=payload)).get("payment", {})

    async def list_customer_invoices(self, db: AsyncSession, customer_id: str) -> list[dict]:
        """Every invoice Books holds for this customer, newest first (pinned
        below), mapped by ``_map_invoice_history``.

        The client rating's one read: a customer's whole billing history in
        one paginated call, including bills raised by hand in Books that no
        estimate-keyed read can see. Paged like ``list_invoices_modified_since``
        and capped by ``_MAX_INVOICE_PAGES`` — a customer with more than 2000
        invoices is not a case this shop has, and the cap bounds a runaway.
        The sort is pinned explicitly (``date`` descending) rather than left
        to Books' default — the read-only probe of 2026-09-22 found it
        newest-first already, but pinning it means the page cap can only
        ever truncate the OLDEST rows, never the most recent ones.

        ``customer_id`` MUST be non-empty, for the same reason as
        ``list_customer_payments``: Books reads an empty filter as no filter
        and would answer with the org's entire invoice list. An id longer
        than the column's ``String(50)`` cannot be a real Zoho id (they run
        ~17 digits) and is refused the same way.
        """
        if not customer_id or len(customer_id) > 50:
            return []
        rows: list[dict] = []
        for page in range(1, _MAX_INVOICE_PAGES + 1):
            payload = await self._request(
                db,
                "GET",
                "/invoices",
                params={
                    "customer_id": customer_id,
                    "per_page": "200",
                    "page": str(page),
                    "sort_column": "date",
                    "sort_order": "D",
                },
            )
            rows.extend(_map_invoice_history(i) for i in payload.get("invoices") or [])
            if not (payload.get("page_context") or {}).get("has_more_page"):
                break
        return rows

    async def get_retainer_invoice(self, db: AsyncSession, retainer_invoice_id: str) -> dict:
        """One retainer invoice in full — specifically its ``payments``.

        The estimate's own ``retainerinvoices`` summary carries the number,
        status and total but no payment ids, and it is the payment id that
        applying a deposit to an invoice actually needs.
        """
        return (await self._request(db, "GET", f"/retainerinvoices/{_seg(retainer_invoice_id)}")).get(
            "retainerinvoice", {}
        )

    async def apply_invoice_credits(self, db: AsyncSession, invoice_id: str, invoice_payments: list[dict]) -> None:
        """Point existing customer payments at an invoice.

        This is how a paid retainer becomes a payment on the bill: Books
        books a retainer's payment as a customer ADVANCE with an
        ``unused_amount``, and applying it is adding the invoice to that
        payment rather than recording a new one. Each entry is
        ``{"payment_id": ..., "amount_applied": ...}``; Books rejects a total
        that exceeds the invoice balance, so the caller caps it.

        The endpoint is named for credit notes, which share it — the invoice
        that results shows the money under ``payment_made``, not
        ``credits_applied`` (verified on FA-26-4100).
        """
        await self._request(
            db, "POST", f"/invoices/{_seg(invoice_id)}/credits", json={"invoice_payments": invoice_payments}
        )

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
        because the contact-level fields are read-only mirrors of it.

        For a company the name parts are the CONTACT PERSON — whoever walked
        in for it — and land on that same primary row, so the account is born
        with a named primary instead of the nameless one Books would otherwise
        keep. Both parts are optional there (a first name alone is enough,
        matching the picker's add form); for an individual they are the
        client's own name."""
        company = company_name.strip()
        if company:
            contact_name, sub_type = company, "business"
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
        first_name: str | None = None,
        last_name: str | None = None,
        contact_person_id: str | None = None,
    ) -> None:
        """Write email/phone to a contact person and, for a person contact,
        the name to its primary person.

        The contact-level ``email``/``phone``/``mobile``/``first_name``/
        ``last_name`` fields are read-only mirrors of the primary contact
        person, so writes must target a person. A contact with no persons
        at all gets one created. A ``contact_person_id`` targets that person
        for the coordinates instead of the primary and raises ``ZohoNotFound``
        when the account no longer has it. The name never follows the target:
        an individual's name IS its primary person in Books, so a card that
        picked another person (a spouse, a colleague) still renames the
        client, not that person — one read, then one write per person
        touched.
        """
        contact = (await self._request(db, "GET", f"/contacts/{_seg(contact_id)}")).get("contact", {})
        persons = contact.get("contact_persons") or []
        primary = next((p for p in persons if p.get("is_primary_contact")), persons[0] if persons else None)
        if contact_person_id is not None:
            target = next((p for p in persons if p.get("contact_person_id") == contact_person_id), None)
            if target is None:
                raise ZohoNotFound(f"Contact person {contact_person_id} not found on contact {contact_id}")
        else:
            target = primary

        name_fields: dict = {}
        if first_name is not None:
            name_fields["first_name"] = first_name
        if last_name is not None:
            name_fields["last_name"] = last_name
        coord_fields: dict = {}
        if email is not None:
            coord_fields["email"] = email
        if phone is not None:
            coord_fields[phone_field] = phone
        fields = {**name_fields, **coord_fields}
        if not fields:
            return

        if primary and target is not primary:
            # Name first, mirroring update_contact: a refused rename leaves
            # the picked person's coordinates untouched.
            if name_fields:
                await self._request(
                    db, "PUT", f"/contacts/contactpersons/{_seg(primary['contact_person_id'])}", json=name_fields
                )
            if coord_fields:
                await self._request(
                    db, "PUT", f"/contacts/contactpersons/{_seg(target['contact_person_id'])}", json=coord_fields
                )
        elif primary:
            await self._request(
                db, "PUT", f"/contacts/contactpersons/{_seg(primary['contact_person_id'])}", json=fields
            )
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

    async def update_contact(
        self,
        db: AsyncSession,
        contact_id: str,
        *,
        company_name: str | None,
        first_name: str | None,
        last_name: str | None,
        email: str,
        phone: str,
        phone_field: str,
        contact_person_id: str | None = None,
    ) -> str:
        """Rename a Books customer and rewrite its primary person's coordinates.

        ``company_name`` set means a business contact: the contact name IS the
        company and the person keeps its own name. Otherwise ``first_name``/
        ``last_name`` name a person contact and land on both the contact
        (house-cased display name) and its primary person. Returns the display
        name Books was given, which is what the Aito card snapshots.

        Two Books calls plus the person read: the contact-level name is a
        contact write, the coordinates are a person write (see
        ``update_contact_person``). The name goes first so a rejected rename
        (duplicate name is Books' usual complaint) leaves the coordinates
        untouched too.
        """
        company = (company_name or "").strip()
        if company:
            display_name = company
            payload: dict = {"contact_name": company, "company_name": company}
            person_first = person_last = None
        else:
            display_name = normalize_display_name(first_name or "", last_name or "")
            payload = {"contact_name": display_name}
            person_first = _title_case_segments(first_name or "")
            person_last = (last_name or "").strip().upper()
        await self._request(db, "PUT", f"/contacts/{_seg(contact_id)}", json=payload)
        await self.update_contact_person(
            db,
            contact_id,
            email=email.strip(),
            phone=phone.strip(),
            phone_field=phone_field,
            first_name=person_first,
            last_name=person_last,
            contact_person_id=contact_person_id,
        )
        return display_name

    async def get_default_contact(self, db: AsyncSession) -> tuple[str, str]:
        """The contact preselected in the Aito modal. Read from settings, never
        from Zoho — the modal must open even when Books is unreachable."""
        from backend.app.api.routes.settings import get_setting

        contact_id = await get_setting(db, "zoho_default_contact_id")
        name = await get_setting(db, "zoho_default_contact_name")
        return (contact_id or DEFAULT_CONTACT_ID_FALLBACK, name or DEFAULT_CONTACT_NAME_FALLBACK)


zoho_service = ZohoService()
