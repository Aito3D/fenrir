"""Public tracking links for Aito cards.

One random token per card, minted the first time a link is needed and
replaced by Regenerate. Links are built ONLY from the `external_url`
setting: with it empty there is no link anywhere, which keeps a single
source of truth instead of guessing an origin per caller. Spec:
docs/superpowers/specs/2026-09-06-aito-tracking-page-design.md
"""

import json
import secrets
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject

TOKEN_BYTES = 32
TRACKING_TTL_AFTER_DONE = timedelta(days=30)
NOTES_PREFIX = "Suivez votre commande : "
SMS_PREFIX = "\n\nSuivi : "


def mint_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


async def external_url(db: AsyncSession) -> str:
    """The configured public origin, or '' — never a guess."""
    from backend.app.api.routes.settings import get_setting

    return (await get_setting(db, "external_url") or "").strip().rstrip("/")


def tracking_url_for(base: str, token: str | None) -> str | None:
    if not base or not token:
        return None
    return f"{base}/track/{token}"


async def ensure_tracking_token(db: AsyncSession, project: AitoProject) -> str:
    """The card's token, minting one if it has none. Flushes, never commits:
    the caller's transaction owns that."""
    if not project.tracking_token:
        project.tracking_token = mint_token()
        await db.flush()
    return project.tracking_token


async def tracking_url(db: AsyncSession, project: AitoProject) -> str | None:
    """Read-only: None until both the setting and the token exist."""
    return tracking_url_for(await external_url(db), project.tracking_token)


async def build_tracking_url(db: AsyncSession, project: AitoProject) -> str | None:
    """The write path: mints the token, then builds. None only while
    `external_url` is empty — the token is kept so the link appears the
    moment the setting is filled."""
    token = await ensure_tracking_token(db, project)
    return tracking_url_for(await external_url(db), token)


async def done_at(db: AsyncSession, project_id: int) -> datetime | None:
    """`occurred_at` of the latest move INTO done, from the event log."""
    stmt = (
        select(AitoEvent.occurred_at, AitoEvent.changes)
        .where(AitoEvent.project_id == project_id, AitoEvent.kind == "stage.changed")
        .order_by(AitoEvent.occurred_at.desc(), AitoEvent.id.desc())
    )
    for at, changes in (await db.execute(stmt)).all():
        if isinstance(changes, str):
            changes = json.loads(changes)
        for change in changes or []:
            if change.get("field") == "column" and change.get("to") == "done":
                return at
    return None


def is_expired(column: str, finished_at: datetime | None, now: datetime) -> bool:
    return column == "done" and finished_at is not None and finished_at + TRACKING_TTL_AFTER_DONE < now
