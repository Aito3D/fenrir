"""The notification inbox: which Aito events become rows, for whom, and the
per-user WebSocket nudge after commit.

``aito_events.record()`` calls ``fan_out`` in the caller's session, so a
rolled-back event takes its notifications with it. ``fan_out`` only notes the
recipients on ``db.info["inbox_users"]``; whoever commits calls
``broadcast_pending`` afterwards, so nobody is told about a row that never
landed.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

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


@dataclass(frozen=True)
class InboxKind:
    family: str
    default_on: bool
    events: tuple[str, ...]  # Aito event kinds that produce it


# Title keys are resolved by the FRONTEND (`inbox.kind.*`); the row stores the
# kind and a body built from the card so the inbox reads without a join.
KINDS: dict[str, InboxKind] = {
    "aito.quote_viewed": InboxKind("aito", True, ("quote.viewed",)),
    "aito.quote_accepted": InboxKind("aito", True, ("quote.accepted",)),
    "aito.quote_declined": InboxKind("aito", True, ("quote.declined",)),
    "aito.paid": InboxKind("aito", True, ("payment_link.paid", "payment.terminal.paid", "payment.manual.recorded")),
    "aito.overdue": InboxKind("aito", False, ("project.due.overdue",)),
    "printer.job_sent": InboxKind("printer", False, ()),
    "printer.finished": InboxKind("printer", False, ()),
    "printer.failed": InboxKind("printer", False, ()),
}
DEFAULT_KINDS: list[str] = [k for k, v in KINDS.items() if v.default_on]
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
            sound_kinds_json=list(DEFAULT_KINDS),
            auto_watch=True,
        )
    return row


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
    watches = [w for w in watches if kind in (w.kinds_json or [])]
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
    """Watch a card its creator just made, with their enabled Aito kinds.

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
    kinds = [k for k in (prefs.kinds_json or []) if k.startswith("aito.")]
    db.add(AitoWatch(user_id=user_id, project_id=project_id, kinds_json=kinds))
    await db.flush()


async def purge_old(db: AsyncSession, now: datetime) -> int:
    """Delete rows older than RETENTION_DAYS. Never commits."""
    result = await db.execute(
        delete(Notification).where(Notification.created_at < now - timedelta(days=RETENTION_DAYS))
    )
    return result.rowcount or 0
