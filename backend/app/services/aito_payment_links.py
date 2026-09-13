# backend/app/services/aito_payment_links.py
"""Payment links for Aito quotes, minted through Heimdall.

Spec: docs/superpowers/specs/2026-09-12-aito-heimdall-payment-links-design.md.
This module starts with the money rule; the reconcile loop follows.
"""

import logging
import math

from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


async def deposit_pct(db: AsyncSession) -> int:
    """`aito_deposit_pct`: 0 = the link asks for the full total."""
    from backend.app.api.routes.settings import get_setting

    raw = await get_setting(db, "aito_deposit_pct")
    try:
        return max(0, min(100, int(raw))) if raw else 0
    except ValueError:
        return 0


def required_amount(quote_total: float | None, pct: int) -> int | None:
    """What the client must pay online for the quote to count as accepted —
    the ONE function the link amount, the retainer rule and the panel
    warning all read. Integer XPF: the full total rounded, or the deposit
    share rounded UP so a deposit is never a franc short. None when there
    is nothing to pay (no total yet, or a zero total)."""
    if quote_total is None or quote_total <= 0:
        return None
    if pct <= 0:
        return int(round(quote_total))
    return int(math.ceil(quote_total * pct / 100))
