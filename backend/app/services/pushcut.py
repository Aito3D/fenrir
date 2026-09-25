"""Pushcut relay for the Aito pickup SMS.

The app never sends the SMS itself — it posts a notification to Pushcut, and
the user's iPhone shortcut ("[Aito3D]") does the sending once they accept the
notification. The shortcut's contract is fixed: it parses `input` as a JSON
dictionary and reads exactly two keys, `phone` and `text`, so that payload
shape is load-bearing. `title` and `text` only dress the notification on the
lock screen — `text` carries the full message so the user can read what they
are about to send before tapping accept.

The webhook URL embeds its secret token, so it is stored write-only in the
settings table (`pushcut_sms_url`), same as the OpenRouter and Zoho secrets.
"""

import json

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

TIMEOUT_S = 8.0


class PushcutNotConfiguredError(Exception):
    """No Pushcut URL in settings."""


class PushcutUpstreamError(Exception):
    """Pushcut reachable but the call failed."""


class PushcutUnreachable(PushcutUpstreamError):
    """The POST never got an answer: DNS, connect refused, read timeout,
    broken pipe. Unlike the plain non-2xx case this says NOTHING about what
    Pushcut did — a read timeout on a POST Pushcut did receive is exactly the
    case where the notification is already on the phone, so a caller must not
    report it as a clean failure and invite a second real SMS. Mirrors
    services/heimdall.py's HeimdallUnreachable, and is a SUBCLASS of
    PushcutUpstreamError so every existing `except PushcutUpstreamError`
    still catches it."""


async def send_sms_notification(db: AsyncSession, *, phone: str, text: str, title: str) -> None:
    """Post one SMS notification to the configured Pushcut webhook.

    Every failure mode raises one of the module errors: no URL is
    PushcutNotConfiguredError, a transport failure is PushcutUnreachable
    (the ambiguous one — see its docstring), and a non-2xx answer is the
    plain PushcutUpstreamError, which is a clean refusal Pushcut answered.
    """
    # Lazy import for the same house-style reason services/openrouter.py gives:
    # the settings helpers live in the routes module.
    from backend.app.api.routes.settings import get_setting

    url = (await get_setting(db, "pushcut_sms_url") or "").strip()
    if not url:
        raise PushcutNotConfiguredError()
    payload = {
        "title": title,
        "text": text,
        # ensure_ascii=False: the shortcut's Get-dictionary step parses JSON
        # either way, but the accented French survives human eyes better when
        # debugging the notification on the phone.
        "input": json.dumps({"phone": phone, "text": text}, ensure_ascii=False),
    }
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            response = await client.post(url, json=payload)
    except httpx.HTTPError as e:
        raise PushcutUnreachable(f"Pushcut request failed: {e}") from e
    if response.status_code >= 300:
        raise PushcutUpstreamError(f"Pushcut returned {response.status_code}")
