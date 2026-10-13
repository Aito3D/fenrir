"""Reading the one figure the card caches from a Books invoice that the
balance alone does not give: its total (2026-10-13, for the tracking page's
"already paid" share). Every writer of ``invoice_balance`` sets it from the
same invoice dict, so the two always describe the same invoice."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def invoice_total_of(invoice: Mapping[str, Any]) -> float | None:
    """The invoice's ``total``, or None when Books left it out or sent
    something that is not a number — the page then shows no amounts rather
    than a wrong share."""
    raw = invoice.get("total")
    if raw is None or isinstance(raw, bool):
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None
