"""Heimdall /api/v1 machine client (../heimdall/docs/API.md).

Heimdall is the shop's POS bridge; its /api/v1 surface mints and manages OSB
payment links. This module is the only thing in Bambuddy that talks to it:
five calls, one signing recipe, and an exception per outcome the reconciler
(services/aito_payment_links.py) branches on.

Authentication is a per-request HMAC signature, not a static header a proxy
could replay: a credential is ``hmd_live.<key_id>.<secret>`` (dot-separated).
Only the key id is ever put on the wire, in ``X-Heimdall-Key-Id`` — the
secret's only job is to key the HMAC-SHA256 signature, and no
``Authorization`` header is sent or read.

Settings are read on every call, like services/zoho.py — a token rotated
under Settings takes effect on the next request, no restart.
"""

import hashlib
import hmac
import json
import logging
import secrets
import time
from dataclasses import dataclass

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

_TIMEOUT_SECONDS = 10.0


class HeimdallNotConfigured(Exception):
    """No base URL or token in Settings — the whole feature is off."""


class HeimdallUpstreamError(Exception):
    """Heimdall answered with an error, or could not be reached."""


class HeimdallAuthError(HeimdallUpstreamError):
    """401 (bad key id / bad signature) or 403 (missing scope)."""

    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


class HeimdallNotFound(HeimdallUpstreamError):
    """404 — no such payment or link."""


class HeimdallConflict(HeimdallUpstreamError):
    """409 — the link's state moved under us, or the idempotency key was
    reused with a different body. ``code`` is Heimdall's error code."""

    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


class HeimdallRateLimited(HeimdallUpstreamError):
    """429 — ``retry_after`` is the Retry-After header in seconds, if parseable."""

    def __init__(self, message: str, retry_after: float | None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


@dataclass(frozen=True)
class LinkView:
    """The slice of Heimdall's PublicPayment the ledger stores."""

    id: str
    status: str
    amount: int
    currency: str
    reference: str
    url: str | None
    expires_at: str | None


def parse_credential(token: str) -> tuple[str, str]:
    """Split ``hmd_live.<key_id>.<secret>`` into ``(key_id, secret)``.

    The key id is the 16 public hex characters between the first and second
    dot; the secret is everything after the second dot (base64url, may
    contain ``_``/``-``) and is never sent over the wire — it only keys the
    HMAC. Lengths are not validated here (Heimdall does); only the shape
    (three non-empty dot-separated parts, an ``hmd_`` prefix) is checked.
    """
    parts = token.split(".")
    if len(parts) != 3 or not all(parts) or not parts[0].startswith("hmd_"):
        raise HeimdallNotConfigured("Heimdall token is not an hmd_live.<id>.<secret> credential")
    return parts[1], parts[2]


def sign(
    method: str, path: str, body: bytes, secret: str, timestamp: int, nonce: str, idempotency_key: str = ""
) -> str:
    """``sha256=<hex>`` over the SIX canonical lines
    ``METHOD\\npath\\ntimestamp\\nnonce\\nsha256hex(body)\\nidempotency_key``.

    ``body`` must be the exact bytes put on the wire — hashing a
    re-serialised object is the signature bypass the contract warns about.
    ``idempotency_key`` is the ``Idempotency-Key`` header value exactly as
    sent, and the empty string (a present, empty sixth line — never an
    omitted one) when the request carries no such header. Heimdall binds it
    so the header cannot be swapped after signing; a five-line signer gets
    ``401 Invalid request signature`` on every call (heimdall/docs/API.md,
    "Signing", upgrade note).
    """
    body_hash = hashlib.sha256(body).hexdigest()
    canonical = "\n".join([method.upper(), path, str(timestamp), nonce, body_hash, idempotency_key])
    return "sha256=" + hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()


def _to_view(data: dict) -> LinkView:
    try:
        link = data.get("link") or {}
        return LinkView(
            id=str(data["id"]),
            status=str(data["status"]),
            amount=int(data["amount"]),
            currency=str(data.get("currency") or "XPF"),
            reference=str(data.get("reference") or ""),
            url=link.get("url"),
            expires_at=link.get("expires_at"),
        )
    except (KeyError, TypeError, ValueError) as e:
        raise HeimdallUpstreamError(f"Heimdall returned an unexpected payment shape: {e}") from e


def _parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None


class HeimdallService:
    def __init__(self) -> None:
        # Test seam: an httpx.MockTransport replaces the network.
        self._transport: httpx.AsyncBaseTransport | None = None

    async def _load_config(self, db: AsyncSession) -> tuple[str, str]:
        from backend.app.api.routes.settings import get_setting

        base_url = (await get_setting(db, "heimdall_base_url") or "").strip().rstrip("/")
        token = (await get_setting(db, "heimdall_api_token") or "").strip()
        if not base_url or not token:
            raise HeimdallNotConfigured("Heimdall is not configured (see Settings)")
        return base_url, token

    async def is_configured(self, db: AsyncSession) -> bool:
        try:
            await self._load_config(db)
            return True
        except HeimdallNotConfigured:
            return False

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=_TIMEOUT_SECONDS, transport=self._transport)

    async def _request(
        self,
        db: AsyncSession,
        method: str,
        path: str,
        *,
        json_body: dict | None = None,
        idempotency_key: str | None = None,
        base_url: str | None = None,
        token: str | None = None,
    ) -> dict:
        """One signed call, parsed. ``path`` is absolute (``/api/v1/...``)."""
        if base_url is None or token is None:
            cfg_url, cfg_token = await self._load_config(db)
            base_url = base_url or cfg_url
            token = token or cfg_token
        base_url = base_url.rstrip("/")
        key_id, secret = parse_credential(token)
        # Serialised ONCE; these exact bytes are both hashed and sent.
        body = b"" if json_body is None else json.dumps(json_body, separators=(",", ":")).encode("utf-8")
        timestamp = int(time.time())
        nonce = secrets.token_hex(16)
        headers = {
            "X-Heimdall-Key-Id": key_id,
            "X-Heimdall-Timestamp": str(timestamp),
            "X-Heimdall-Nonce": nonce,
            "X-Heimdall-Signature": sign(method, path, body, secret, timestamp, nonce, idempotency_key or ""),
        }
        if json_body is not None:
            headers["Content-Type"] = "application/json"
        if idempotency_key is not None:
            headers["Idempotency-Key"] = idempotency_key
        try:
            async with self._client() as client:
                response = await client.request(method, f"{base_url}{path}", content=body, headers=headers)
        except httpx.HTTPError as e:
            raise HeimdallUpstreamError(f"Heimdall unreachable: {e}") from e
        try:
            payload = response.json() if response.content else {}
        except ValueError as e:
            raise HeimdallUpstreamError(f"Heimdall returned a non-JSON response (HTTP {response.status_code})") from e
        if response.status_code >= 400:
            error = payload.get("error") if isinstance(payload, dict) else None
            code = str((error or {}).get("code") or "")
            message = f"Heimdall HTTP {response.status_code} {code}: {(error or {}).get('message') or ''}".strip()
            if response.status_code in (401, 403):
                raise HeimdallAuthError(message, response.status_code)
            if response.status_code == 404:
                raise HeimdallNotFound(message)
            if response.status_code == 409:
                raise HeimdallConflict(message, code)
            if response.status_code == 429:
                raise HeimdallRateLimited(message, _parse_retry_after(response.headers.get("Retry-After")))
            raise HeimdallUpstreamError(message)
        if not isinstance(payload, dict):
            raise HeimdallUpstreamError("Heimdall returned a non-object JSON body")
        return payload

    async def ping(self, db: AsyncSession, *, base_url: str | None = None, token: str | None = None) -> None:
        """Credential check. Overrides let the Settings test button try a
        key id/secret pair that is typed but not yet saved."""
        await self._request(db, "GET", "/api/v1/ping", base_url=base_url, token=token)

    async def create_link(
        self, db: AsyncSession, *, idempotency_key: str, reference: str, amount: int, expires_in_days: int
    ) -> LinkView:
        payload = {
            "method": "link",
            "amount": int(amount),
            "currency": "XPF",
            "reference": reference,
            "expires_in_days": int(expires_in_days),
        }
        return _to_view(
            await self._request(db, "POST", "/api/v1/payments", json_body=payload, idempotency_key=idempotency_key)
        )

    async def patch_link(
        self, db: AsyncSession, heimdall_id: str, *, amount: int | None = None, expires_in_days: int | None = None
    ) -> LinkView:
        payload: dict = {}
        if amount is not None:
            payload["amount"] = int(amount)
        if expires_in_days is not None:
            payload["expires_in_days"] = int(expires_in_days)
        return _to_view(await self._request(db, "PATCH", f"/api/v1/payments/{heimdall_id}", json_body=payload))

    async def cancel_link(self, db: AsyncSession, heimdall_id: str) -> LinkView:
        return _to_view(await self._request(db, "POST", f"/api/v1/payments/{heimdall_id}/cancel"))

    async def get_payment(self, db: AsyncSession, heimdall_id: str) -> LinkView:
        return _to_view(await self._request(db, "GET", f"/api/v1/payments/{heimdall_id}"))


heimdall_service = HeimdallService()
