"""The notification inbox: the signed-in user's own rows and preferences.

Gated on authentication only — every row belongs to the caller, so there is
no permission to check beyond "who are you". With auth disabled (or an API
key, which carries no user) there is nobody to have an inbox: reads answer
empty or with the defaults, writes are no-ops.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import require_auth_if_enabled
from backend.app.core.database import get_db
from backend.app.models.notification_inbox import Notification, UserInboxPreference
from backend.app.models.user import User
from backend.app.schemas.inbox import (
    InboxItem,
    InboxKindInfo,
    InboxPage,
    InboxPreferences,
    InboxPreferencesUpdate,
)
from backend.app.services.aito_events import utc_now_naive
from backend.app.services.inbox import DEFAULT_KINDS, KINDS, preferences_for

router = APIRouter(prefix="/inbox", tags=["inbox"])


def _available() -> list[InboxKindInfo]:
    return [
        InboxKindInfo(kind=kind, family=spec.family, default_on=spec.default_on, available=bool(spec.events))
        for kind, spec in KINDS.items()
    ]


def _preferences(row: UserInboxPreference) -> InboxPreferences:
    return InboxPreferences(
        kinds=list(row.kinds_json or []),
        sound_kinds=list(row.sound_kinds_json or []),
        auto_watch=row.auto_watch,
        available=_available(),
    )


@router.get("", response_model=InboxPage)
async def list_inbox(
    limit: int = Query(50, ge=1, le=200),
    before: int | None = Query(None, ge=1),
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(require_auth_if_enabled),
):
    """Newest first; ``before`` pages back by id."""
    if current_user is None:
        return InboxPage(items=[], unread=0)
    stmt = select(Notification).where(Notification.user_id == current_user.id)
    if before is not None:
        stmt = stmt.where(Notification.id < before)
    rows = (await db.execute(stmt.order_by(Notification.id.desc()).limit(limit))).scalars().all()
    unread = await db.scalar(
        select(func.count())
        .select_from(Notification)
        .where(Notification.user_id == current_user.id, Notification.read_at.is_(None))
    )
    return InboxPage(items=[InboxItem.model_validate(r) for r in rows], unread=unread or 0)


@router.post("/read-all", status_code=204)
async def read_all(
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(require_auth_if_enabled),
):
    if current_user is not None:
        await db.execute(
            update(Notification)
            .where(Notification.user_id == current_user.id, Notification.read_at.is_(None))
            .values(read_at=utc_now_naive())
        )
        await db.commit()
    return Response(status_code=204)


@router.get("/preferences", response_model=InboxPreferences)
async def get_preferences(
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(require_auth_if_enabled),
):
    """The stored row, or the defaults when the user never saved one."""
    if current_user is None:
        return InboxPreferences(
            kinds=list(DEFAULT_KINDS), sound_kinds=list(DEFAULT_KINDS), auto_watch=True, available=_available()
        )
    return _preferences(await preferences_for(db, current_user.id))


@router.put("/preferences", response_model=InboxPreferences)
async def put_preferences(
    payload: InboxPreferencesUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(require_auth_if_enabled),
):
    """Replace the user's preferences. ``kinds`` must be known kinds and
    ``sound_kinds`` a subset of them (a kind that never arrives cannot ring)."""
    kinds = list(dict.fromkeys(payload.kinds))
    sound_kinds = list(dict.fromkeys(payload.sound_kinds))
    unknown = [k for k in kinds if k not in KINDS]
    if unknown:
        raise HTTPException(status_code=422, detail=f"unknown kinds: {unknown}")
    silent = [k for k in sound_kinds if k not in kinds]
    if silent:
        raise HTTPException(status_code=422, detail=f"sound kinds must be enabled kinds: {silent}")
    if current_user is None:
        return Response(status_code=204)

    row = await preferences_for(db, current_user.id)
    row.kinds_json = kinds
    row.sound_kinds_json = sound_kinds
    row.auto_watch = payload.auto_watch
    db.add(row)  # a no-op for a stored row; inserts the defaults placeholder
    await db.commit()
    return _preferences(row)


@router.post("/{notification_id}/read", status_code=204)
async def mark_read(
    notification_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(require_auth_if_enabled),
):
    """Mark one of the caller's own rows read. Someone else's row is a 404,
    the same answer as a row that does not exist. Idempotent: the first read
    time stands."""
    if current_user is None:
        return Response(status_code=204)
    row = (
        await db.execute(
            select(Notification).where(Notification.id == notification_id, Notification.user_id == current_user.id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Notification not found")
    if row.read_at is None:
        row.read_at = utc_now_naive()
        await db.commit()
    return Response(status_code=204)
