"""Tell every connected client that the print queue or the pending-upload
review list changed.

The sidebar badges (pending queue count, uploads awaiting review) used to
poll every 5 s on every page because nothing announced these changes. The
write routes call these after their commit; the scheduler's own
``queue_item_*`` events cover status transitions it makes. The frontend
invalidates its cached counts on the message and keeps a 60 s poll only as
a fallback for a missed socket.

Fire-and-forget: a socket that cannot be written must never fail the
request that changed the queue.
"""

from __future__ import annotations

import logging

from backend.app.core.websocket import ws_manager

logger = logging.getLogger(__name__)

QUEUE_CHANGED = {"type": "queue_changed"}
PENDING_UPLOADS_CHANGED = {"type": "pending_uploads_changed"}


async def _broadcast(message: dict[str, str]) -> None:
    try:
        await ws_manager.broadcast(dict(message))
    except Exception as e:  # pragma: no cover - defensive; sockets fail in many ways
        logger.debug("Queue change broadcast failed (%s): %s", message.get("type"), e)


async def notify_queue_changed() -> None:
    """A queue item or batch was added, edited, moved, started, stopped or removed."""
    await _broadcast(QUEUE_CHANGED)


async def notify_pending_uploads_changed() -> None:
    """A virtual-printer upload arrived, was archived or was discarded."""
    await _broadcast(PENDING_UPLOADS_CHANGED)
