"""Recording what happened to an order. Explicit ``record`` calls, like aito_events."""

import logging
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.notification_inbox import Notification, OrderWatch, UserInboxPreference
from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.models.order_board_event import OrderBoardEvent
from backend.app.models.user import User
from backend.app.services import inbox
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
            "payment_link.cancelled",
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
    alert: bool = True,
) -> OrderBoardEvent | None:
    """Add one event to ``db`` and flush; the caller commits, then calls ``inbox.broadcast_pending``.

    ``alert=False`` keeps an event that maps to a bell kind out of the bell (old history the sync reads for the
    first time)."""
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
    if alert:
        await _alert(db, event)
    return event


async def _alert(db: AsyncSession, event: OrderBoardEvent) -> None:
    """One bell row per active order reader who wants the event's kind or watches the order, the actor excepted.
    In its own savepoint: a failure here drops the rows and keeps the event."""
    kind = inbox.inbox_kind_for(event.kind)
    if kind is None or inbox.KINDS[kind].family != "orders":
        return
    try:
        async with db.begin_nested():
            doc = (
                await db.execute(
                    select(OrderBoardDoc).where(
                        OrderBoardDoc.kind == "salesorder", OrderBoardDoc.zoho_id == event.salesorder_id
                    )
                )
            ).scalar_one_or_none()
            order = (doc.detail or doc.header or {}) if doc else {}
            body = f"{order.get('salesorder_number') or '—'} · {order.get('customer_name') or '—'}"
            # A watcher gets this order's rows even for a kind they switched off; nothing else about recipients changes.
            watchers = set(
                (
                    await db.execute(select(OrderWatch.user_id).where(OrderWatch.salesorder_id == event.salesorder_id))
                ).scalars()
            )
            recipients: list[int] = []
            for user in (await db.execute(select(User).where(User.is_active.is_(True)))).scalars():
                if not user.has_permission("orders:read"):
                    continue
                if event.actor_class == "user" and event.actor_name == user.username:
                    continue
                if user.id not in watchers and kind not in (
                    (await inbox.preferences_for(db, user.id)).kinds_json or []
                ):
                    continue
                db.add(
                    Notification(
                        user_id=user.id,
                        kind=kind,
                        family="orders",
                        title=kind,
                        body=body[:500],
                        target_type="order",
                        target_ref=event.salesorder_id,
                    )
                )
                recipients.append(user.id)
        if recipients:
            db.info.setdefault(inbox._PENDING_KEY, set()).update(recipients)
    except Exception:
        logger.warning("Order board: bell alert %s failed for %s", kind, event.salesorder_id, exc_info=True)


_ALERT_BACKFILL_KEY = "orders_inbox_kinds_backfilled"


async def backfill_alert_kinds(db: AsyncSession) -> int:
    """Once: add the on-by-default order kinds to inbox preferences saved before they existed (as
    printer_hours.backfill_reminder_kind did for its kind)."""
    from backend.app.api.routes.settings import get_setting, set_setting  # the route module imports services

    if await get_setting(db, _ALERT_BACKFILL_KEY) == "1":
        return 0
    new = [k for k, spec in inbox.KINDS.items() if spec.family == "orders" and spec.default_on]
    count = 0
    for pref in (await db.execute(select(UserInboxPreference))).scalars():
        missing = [k for k in new if k not in (pref.kinds_json or [])]
        if missing:
            pref.kinds_json = [*(pref.kinds_json or []), *missing]  # new list: JSON column change tracking
            sound = [k for k in missing if inbox.KINDS[k].sound_default and k not in (pref.sound_kinds_json or [])]
            if sound and pref.sound_kinds_json:  # an empty list is the bell's sound switched off: keep it silent
                pref.sound_kinds_json = [*(pref.sound_kinds_json or []), *sound]
            count += 1
    await set_setting(db, _ALERT_BACKFILL_KEY, "1")
    await db.commit()
    return count
