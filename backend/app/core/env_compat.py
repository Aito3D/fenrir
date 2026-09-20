"""Reads env vars under their current ``FENRIR_`` names, honouring the old ones.

The app was renamed from Bambuddy to Fenrir and its operator-facing environment
variables moved with it. An install whose compose file, Helm values or systemd
unit still spells them ``BAMBUDDY_*`` must not silently lose its configuration,
so every read goes through here: the current name wins, the legacy name is the
fallback.

Blank counts as unset, matching the convention the rest of the config follows --
``FENRIR_OIDC_CLIENT_SECRET=`` in a compose file is a forgotten value, not an
intentional empty one, so it falls through to ``BAMBUDDY_OIDC_CLIENT_SECRET``
rather than shadowing it.
"""

from __future__ import annotations

import os

CURRENT_PREFIX = "FENRIR_"
LEGACY_PREFIX = "BAMBUDDY_"


def legacy_name(key: str) -> str | None:
    """The pre-rename spelling of ``key``, or None when it has no legacy form."""
    if key.startswith(CURRENT_PREFIX):
        return LEGACY_PREFIX + key[len(CURRENT_PREFIX) :]
    return None


def env_get(key: str, default: str | None = None) -> str | None:
    """``os.environ.get`` that falls back to the pre-rename variable name."""
    value = os.environ.get(key)
    if value is not None and value.strip() != "":
        return value
    legacy = legacy_name(key)
    if legacy is not None:
        legacy_value = os.environ.get(legacy)
        if legacy_value is not None and legacy_value.strip() != "":
            return legacy_value
    # Preserve a deliberately-blank current value over the default: callers that
    # care about the difference between blank and absent (library roots, compose
    # dir) already strip, and those that do not treat both as falsy anyway.
    return value if value is not None else default


def both_names(key: str) -> tuple[str, ...]:
    """``key`` plus its legacy spelling -- for messages that name the variable."""
    legacy = legacy_name(key)
    return (key,) if legacy is None else (key, legacy)
