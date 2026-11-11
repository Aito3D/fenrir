"""Recording what happened to an order. Explicit ``record`` calls, like aito_events."""

import logging
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.order_board_event import OrderBoardEvent
from backend.app.services.aito_events import utc_now_naive

logger = logging.getLogger(__name__)

# kind -> depth. The only definition of the ladder; add a kind here or reads never return it.
KINDS: dict[str, str] = {
    **dict.fromkeys(
        (
            "order.received",
            "order.ready",
            "package.created",
            "handover.delivered",
            "handover.shipped",
            "invoice.created",
            "payment.received",
            "order.cancelled",
            "order.finished",
            "note.added",
        ),
        "story",
    ),
    **dict.fromkeys(
        (
            "picklist.created",
            "order.edited",
            "package.edited",
            "invoice.emailed",
            "sms.sent",
            "payment_link.sent",
            "terminal.started",
        ),
        "detail",
    ),
    **dict.fromkeys(("prep.printed", "tracking.viewed", "zoho.edited"), "trace"),
}

_DEPTH_ORDER: tuple[str, ...] = ("story", "detail", "trace")
_DEPTH_ALIASES = {"story": 1, "detail": 2, "everything": 3}


def kinds_for_depth(depth: str) -> list[str]:
    """Every kind visible at ``depth``, cumulatively."""
    allowed = set(_DEPTH_ORDER[: _DEPTH_ALIASES.get(depth, _DEPTH_ALIASES["detail"])])
    return [kind for kind, level in KINDS.items() if level in allowed]


async def record(
    db: AsyncSession,
    salesorder_id: str,
    kind: str,
    *,
    actor_class: str,
    actor_name: str | None = None,
    changes: list[dict] | None = None,
    detail: dict | None = None,
    note: str | None = None,
    occurred_at: datetime | None = None,
) -> OrderBoardEvent | None:
    """Add one event to ``db`` and flush; the caller commits."""
    if kind not in KINDS:
        logger.error("order event kind %r is not registered; dropped", kind)
        return None
    event = OrderBoardEvent(
        salesorder_id=salesorder_id,
        occurred_at=occurred_at or utc_now_naive(),
        kind=kind,
        actor_class=actor_class,
        actor_name=actor_name,
        changes=changes or None,
        detail=detail,
        note=note,
    )
    db.add(event)
    await db.flush()
    return event
