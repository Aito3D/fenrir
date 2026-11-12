"""The notification inbox: which Aito events become rows, for whom, and the
per-user WebSocket nudge after commit.

``aito_events.record()`` calls ``fan_out`` in the caller's session, so a
rolled-back event takes its notifications with it. ``fan_out`` only notes the
recipients on ``db.info["inbox_users"]``; whoever commits calls
``broadcast_pending`` afterwards, so nobody is told about a row that never
landed. A rollback forgets the noted recipients along with the rows (see
``_forget_pending_on_rollback``).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import delete, event, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from backend.app.core.websocket import ws_manager
from backend.app.models.aito_project import AitoProject
from backend.app.models.notification_inbox import AitoWatch, Notification, UserInboxPreference
from backend.app.models.user import User

if TYPE_CHECKING:
    from backend.app.models.aito_event import AitoEvent

logger = logging.getLogger(__name__)

RETENTION_DAYS = 30
_READ_PERMISSION = "aito:read"
_PENDING_KEY = "inbox_users"


@event.listens_for(Session, "after_rollback")
def _forget_pending_on_rollback(session: Session) -> None:
    """Drop the noted recipients when their rows roll back.

    One listener covers every commit site, including a commit that fails and
    is rolled back by its caller: otherwise the ids would survive on
    ``session.info`` until the next drain on that session (a long-lived sync
    loop session, say) and push a nudge about a row that never landed.
    ``after_rollback`` also fires for a savepoint, which is still the current
    transaction when it does: that one is skipped, because rows fanned out
    before the savepoint survive it. An id whose row was inside the savepoint
    stays, which costs one spurious refetch and nothing else.
    """
    if session.in_nested_transaction():
        return
    session.info.pop(_PENDING_KEY, None)


@dataclass(frozen=True)
class InboxKind:
    family: str
    default_on: bool
    events: tuple[str, ...]  # Aito event kinds that produce it
    available: bool = True  # shown as selectable in Settings
    sound_default: bool = True  # rings by default when the kind is on by default


# Title keys are resolved by the FRONTEND (`inbox.kind.*`); the row stores the
# kind and a body built from the card so the inbox reads without a join.
KINDS: dict[str, InboxKind] = {
    "aito.quote_viewed": InboxKind("aito", True, ("quote.viewed",), available=True),
    "aito.quote_accepted": InboxKind("aito", True, ("quote.accepted",), available=True),
    "aito.quote_declined": InboxKind("aito", True, ("quote.declined",), available=True),
    "aito.paid": InboxKind(
        "aito", True, ("payment_link.paid", "payment.terminal.paid", "payment.manual.recorded"), available=True
    ),
    "aito.overdue": InboxKind("aito", False, ("project.due.overdue",), available=True),
    # Print jobs (main.py calls notify_print beside its provider notifications).
    "printer.job_sent": InboxKind("printer", False, ()),
    "printer.finished": InboxKind("printer", False, ()),
    "printer.failed": InboxKind("printer", False, ()),
    "hours.readings_due": InboxKind("printer", True, (), available=True, sound_default=False),
    # Order Board events (order_board_events.record fans these out, not fan_out).
    "orders.ready": InboxKind("orders", True, ("order.ready",)),
    "orders.new": InboxKind("orders", True, ("order.received",), sound_default=False),
}
DEFAULT_KINDS: list[str] = [k for k, v in KINDS.items() if v.default_on]
SOUND_DEFAULT_KINDS: list[str] = [k for k, v in KINDS.items() if v.default_on and v.sound_default]
_BY_EVENT: dict[str, str] = {event: kind for kind, spec in KINDS.items() for event in spec.events}


def inbox_kind_for(event_kind: str) -> str | None:
    return _BY_EVENT.get(event_kind)


def _body_for(project: AitoProject) -> str:
    parts = [project.client_name or "—", f"#{project.id}"]
    if project.quote_number:
        parts.append(project.quote_number)
    first_line = next(iter((project.description or "").splitlines()), "").strip()
    if first_line:
        parts.append(first_line[:120])
    return " · ".join(parts)[:500]


async def preferences_for(db: AsyncSession, user_id: int) -> UserInboxPreference:
    """The user's stored preferences, or an unsaved row holding the defaults."""
    row = (
        await db.execute(select(UserInboxPreference).where(UserInboxPreference.user_id == user_id))
    ).scalar_one_or_none()
    if row is None:
        row = UserInboxPreference(
            user_id=user_id,
            kinds_json=list(DEFAULT_KINDS),
            sound_kinds_json=list(SOUND_DEFAULT_KINDS),
            auto_watch=True,
        )
    return row


def effective_watch_kinds(watch: AitoWatch, prefs: UserInboxPreference) -> list[str]:
    """The Aito kinds a watch actually delivers: the user's enabled ``aito.*``
    kinds for an auto-watch (no stored list), else its own list within them."""
    enabled = [k for k in (prefs.kinds_json or []) if k.startswith("aito.")]
    if watch.kinds_json is None:
        return enabled
    return [k for k in watch.kinds_json if k in enabled]


async def fan_out(db: AsyncSession, event: AitoEvent, project: AitoProject | None = None) -> list[int]:
    """One Notification per watcher who wants this event's inbox kind.

    Called by ``aito_events.record()`` in the same session as the event and
    never commits. A user event skips the watcher who performed it. Returns
    the recipients' user ids.
    """
    kind = inbox_kind_for(event.kind)
    if kind is None:
        return []
    watches = list((await db.execute(select(AitoWatch).where(AitoWatch.project_id == event.project_id))).scalars())
    # Old history is not news: importing a quote auto-watches it, and the
    # first comment mirror then records the quote's PAST Books events with
    # their past occurred_at. Nothing that happened before the watch existed
    # becomes a row.
    watches = [w for w in watches if w.created_at is None or event.occurred_at >= w.created_at]
    # An explicit watch must list the kind; an auto-watch (no list) follows
    # Settings, which the preference check below applies to every watch.
    watches = [w for w in watches if w.kinds_json is None or kind in w.kinds_json]
    if not watches:
        return []
    if project is None:
        project = await db.get(AitoProject, event.project_id)
        if project is None:
            return []

    recipients: list[int] = []
    for watch in watches:
        prefs = await preferences_for(db, watch.user_id)
        if kind not in (prefs.kinds_json or []):
            continue
        user = await db.get(User, watch.user_id)
        if user is None or not user.is_active or not user.has_permission(_READ_PERMISSION):
            continue
        if event.actor_class == "user" and event.actor_name == user.username:
            continue  # nobody needs telling about what they just did themselves
        db.add(
            Notification(
                user_id=watch.user_id,
                kind=kind,
                family=KINDS[kind].family,
                title=kind,
                body=_body_for(project),
                target_type="aito_project",
                target_id=project.id,
            )
        )
        recipients.append(watch.user_id)
    if recipients:
        db.info.setdefault(_PENDING_KEY, set()).update(recipients)
    return recipients


# Print outcomes that reach the bell. A stopped or cancelled print is somebody's own doing: no row.
_PRINT_KINDS = {"started": "printer.job_sent", "completed": "printer.finished", "failed": "printer.failed"}


async def notify_print(
    db: AsyncSession, printer_id: int, printer_name: str, status: str, data: dict, sender_id: int | None = None
) -> list[int]:
    """One row per active printer reader who enabled the kind and may see this printer.

    Commits and pushes itself, and never raises: the provider notification
    sent beside it must not depend on the bell. ``sender_id`` (the user who
    sent the job) is skipped, as an Aito actor is.
    """
    kind = _PRINT_KINDS.get(status)
    if kind is None:
        return []
    from backend.app.core.printer_scope import resolve_user_printer_scope  # imports models.group

    body = f"{printer_name} · {data.get('subtask_name') or data.get('filename') or '—'}"[:500]
    recipients: list[int] = []
    try:
        async with db.begin_nested():
            for user in (await db.execute(select(User).where(User.is_active.is_(True)))).scalars():
                if user.id == sender_id or not user.has_permission("printers:read"):
                    continue
                if kind not in ((await preferences_for(db, user.id)).kinds_json or []):
                    continue
                if not (await resolve_user_printer_scope(db, user)).allows(printer_id):
                    continue
                db.add(
                    Notification(
                        user_id=user.id,
                        kind=kind,
                        family="printer",
                        title=kind,
                        body=body,
                        target_type="printer",
                        target_id=printer_id,
                    )
                )
                recipients.append(user.id)
        if recipients:
            db.info.setdefault(_PENDING_KEY, set()).update(recipients)
            await db.commit()
            await broadcast_pending(db)
    except Exception:
        logger.warning("inbox %s failed for printer %s", kind, printer_id, exc_info=True)
        return []
    return recipients


async def broadcast_pending(db: AsyncSession) -> None:
    """After the caller's commit: nudge each recipient's own sockets.

    Drains ``db.info["inbox_users"]``, so a second call is a no-op. A failed
    push is logged and dropped — the rows are committed, and the bell
    refetches on its next poll or reconnect.
    """
    users: set[int] = db.info.pop(_PENDING_KEY, set())
    for user_id in sorted(users):
        try:
            await ws_manager.broadcast_to_user(user_id, {"type": "inbox_changed", "user_ids": [user_id]})
        except Exception:
            logger.warning("inbox_changed push failed for user %s", user_id, exc_info=True)


async def auto_watch(db: AsyncSession, project_id: int, user_id: int | None) -> None:
    """Watch a card its creator just made, following their Settings.

    No-op without a user (auth disabled), when the user turned auto-watch
    off, or when they already watch the card. Never commits.
    """
    if user_id is None:
        return
    prefs = await preferences_for(db, user_id)
    if not prefs.auto_watch:
        return
    existing = (
        await db.execute(select(AitoWatch).where(AitoWatch.user_id == user_id, AitoWatch.project_id == project_id))
    ).scalar_one_or_none()
    if existing is not None:
        return
    # No kind list: an auto-watch follows the user's Settings, so a kind they
    # enable later reaches the cards they already watch.
    db.add(AitoWatch(user_id=user_id, project_id=project_id, kinds_json=None))
    await db.flush()


async def purge_old(db: AsyncSession, now: datetime) -> int:
    """Delete rows older than RETENTION_DAYS. Never commits."""
    result = await db.execute(
        delete(Notification).where(Notification.created_at < now - timedelta(days=RETENTION_DAYS))
    )
    return result.rowcount or 0
