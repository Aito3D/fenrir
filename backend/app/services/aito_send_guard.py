"""The in-memory duplicate-send guard shared by the pickup SMS, the quote and
invoice emails (routes/aito.py) and the manual payments
(aito_manual_payments.py): a key -> time.monotonic() map with a fixed window.

Only the mechanics live here — prune, check, arm, release. Each call site
still decides which outcomes keep an armed key and which release it, and
still reads the clock through its own module's `time` name (the tests rebind
that name to a fake clock), passing the reading in as `now`.
"""

from __future__ import annotations

from collections.abc import Hashable


class DuplicateSendGuard:
    """Single-process module state: no lock, because the call sites never
    await between `is_recent` and `arm`."""

    def __init__(self, window_s: float) -> None:
        self.window_s = window_s
        # Exposed as-is: the call sites alias it under their historical names
        # (`_recent_sms`, `_recent_emails`, `_recent`), which tests read.
        self.entries: dict[Hashable, float] = {}

    def is_recent(self, key: Hashable, now: float) -> bool:
        """Prune every entry past the window, then report whether `key` is
        still armed. Pruned on every call: the keys carry caller-supplied
        parts, so an unevicted dict would only ever grow. An entry past the
        window is already ignored by the check, so the prune changes nothing
        a caller can observe."""
        for stale in [k for k, at in self.entries.items() if now - at >= self.window_s]:
            del self.entries[stale]
        return key in self.entries

    def arm(self, key: Hashable, now: float) -> None:
        self.entries[key] = now

    def release(self, key: Hashable) -> None:
        self.entries.pop(key, None)

    def clear(self) -> None:
        self.entries.clear()
