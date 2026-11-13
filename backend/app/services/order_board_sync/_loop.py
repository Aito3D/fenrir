"""The background loop that runs a pass when allowed, and its start."""

import asyncio
import logging
import time

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import async_session
from backend.app.core.tasks import spawn_background_task
from backend.app.services import order_board_events
from backend.app.services.order_board_sync import _common
from backend.app.services.order_board_sync._common import (
    DAILY_BUDGET_FLOOR,
    PENDING_PAUSE_SECONDS,
    _pending_count,
    load_settings,
)
from backend.app.services.order_board_sync._pass import run_pass
from backend.app.services.zoho import zoho_service

logger = logging.getLogger(__name__)


async def _iteration(db: AsyncSession) -> float:
    """One loop turn: a pass when allowed. Returns the seconds until the next."""
    settings = await load_settings(db)
    if not (settings.sync_enabled and await zoho_service.is_configured(db)):
        # Look again soon: Zoho may be connected from another settings card.
        return float(PENDING_PAUSE_SECONDS)
    remaining = zoho_service.daily_remaining
    if remaining is not None and remaining < DAILY_BUDGET_FLOOR:
        return settings.sync_minutes * 60.0
    await run_pass(db)
    return float(PENDING_PAUSE_SECONDS) if await _pending_count(db) else settings.sync_minutes * 60.0


async def run_loop() -> None:
    """Run passes forever. Cancellation is the only way out.

    Every iteration takes its own session and swallows its own errors: one bad
    pass must not end syncing until the next restart. The sleep between turns
    ends early when settings are saved.
    """
    _common._wake = asyncio.Event()
    try:
        async with async_session() as db:
            await order_board_events.backfill_alert_kinds(db)
    except Exception:
        logger.warning("Order board: inbox kind backfill failed", exc_info=True)
    while True:
        delay = float(PENDING_PAUSE_SECONDS)
        try:
            async with async_session() as db:
                delay = await _iteration(db)
        except Exception:
            logger.exception("Order board sync loop iteration failed")
        try:
            await asyncio.wait_for(
                _common._wake.wait(), timeout=max(delay, _common._rate_limited_until - time.monotonic())
            )
        except TimeoutError:
            pass
        _common._wake.clear()


def start_order_board_sync() -> None:
    spawn_background_task(run_loop(), name="order-board-sync")
