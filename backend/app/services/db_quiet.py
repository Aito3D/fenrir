"""Best-effort session rollback for error paths that must not raise."""

import logging

from sqlalchemy.ext.asyncio import AsyncSession


async def rollback_quietly(db: AsyncSession, log: logging.Logger, level: int, msg: str, *args: object) -> None:
    """Roll ``db`` back; if that fails too, log ``msg % args`` at ``level`` on ``log``
    with the traceback (attributed to the caller) instead of raising."""
    try:
        await db.rollback()
    except Exception:
        log.log(level, msg, *args, exc_info=True, stacklevel=2)
