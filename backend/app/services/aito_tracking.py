"""Public tracking links for Aito cards.

One random token per card, minted the first time a link is needed and
replaced by Regenerate. Links are built ONLY from the `external_url`
setting: with it empty there is no link anywhere, which keeps a single
source of truth instead of guessing an origin per caller. Spec:
docs/superpowers/specs/2026-09-06-aito-tracking-page-design.md
"""

import json
import secrets
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.aito_tracking_view import AitoTrackingView
from backend.app.schemas.aito import AitoTrackingResponse, AitoTrackingShipping, AitoTrackingTask
from backend.app.services.aito_shipping import SERVICE_LABELS

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
    the caller's transaction owns that.

    The mint is a conditional `UPDATE ... WHERE tracking_token IS NULL`, not a
    check-then-act on the in-memory attribute: two concurrent mints for the
    same card (routes/aito.py's tracking-link and pickup-message paths both
    call this) would otherwise race, with the slower one silently overwriting
    a token that may already have been handed out. Here only one UPDATE can
    match the NULL guard, so the loser re-reads the row and returns the
    winner's token instead of replacing it."""
    if project.tracking_token:
        return project.tracking_token
    new_token = mint_token()
    result = await db.execute(
        update(AitoProject)
        .where(AitoProject.id == project.id, AitoProject.tracking_token.is_(None))
        .values(tracking_token=new_token)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount:
        won_token = new_token
    else:
        won_token = (
            await db.execute(select(AitoProject.tracking_token).where(AitoProject.id == project.id))
        ).scalar_one()
    set_committed_value(project, "tracking_token", won_token)
    await db.flush()
    return won_token


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


TASK_FALLBACK = "Pièce {n}"
# invoice_status (services/aito_invoice_sweep.py vocabulary) → the page's three states.
_INVOICE_STATE = {
    "paid": "paid",
    "overdue": "overdue",
    "sent": "unpaid",
    "unpaid": "unpaid",
    "partially_paid": "unpaid",
}


def invoice_state(status: str | None) -> str | None:
    return _INVOICE_STATE.get(status or "")


# (cost column, quantity column) per service — the quantity of a service
# only counts when that service is priced (a non-null cost).
_SERVICE_COUNTS = (
    ("scan_cost", "scan_quantity"),
    ("modelisation_cost", "modelisation_quantity"),
    ("usinage_cost", "usinage_quantity"),
    ("impression_cost", "impression_quantity"),
)


def task_quantity(task: AitoTask) -> int | None:
    """One number only when it is unambiguous: every priced service on the
    task has the same count and it is > 1. Otherwise None — never a guess."""
    counts = {(getattr(task, qty) or 1) for cost, qty in _SERVICE_COUNTS if getattr(task, cost) is not None}
    if len(counts) != 1:
        return None
    (count,) = counts
    return count if count > 1 else None


async def last_activity(db: AsyncSession, project: AitoProject) -> datetime:
    """The card's latest event moment, or its row timestamp for a card that
    has no events — the honest "Mis à jour" value. Coalesced to
    `occurred_until` first: a repeated-edit session that got folded into one
    event (services/aito_events.py) reports the window's END, not when it
    started."""
    latest = (
        await db.execute(
            select(func.max(func.coalesce(AitoEvent.occurred_until, AitoEvent.occurred_at))).where(
                AitoEvent.project_id == project.id
            )
        )
    ).scalar_one()
    return latest or project.updated_at


VIEW_DEDUP_WINDOW = timedelta(minutes=5)


async def log_view(db: AsyncSession, project_id: int, now: datetime) -> None:
    """One row per open, deduped within `VIEW_DEDUP_WINDOW`: a repeat open of
    the same project (a refresh, a link-scanner refetch) that lands inside
    the window writes nothing. The route wraps this in a try/except: the log
    must never break the page it measures."""
    recent = (
        await db.execute(
            select(AitoTrackingView.id)
            .where(
                AitoTrackingView.project_id == project_id,
                AitoTrackingView.viewed_at > now - VIEW_DEDUP_WINDOW,
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if recent is not None:
        return
    db.add(AitoTrackingView(project_id=project_id, viewed_at=now))
    await db.commit()


async def purge_tracking_views(db: AsyncSession, older_than: timedelta = timedelta(days=400)) -> int:
    """Retention for the view log: the Stats pipeline widget only ever reads
    a recent window (services/aito_tracking.py's callers), so rows past
    `older_than` have no reader left and would just grow the table forever.
    Returns the number of rows removed."""
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - older_than
    result = await db.execute(delete(AitoTrackingView).where(AitoTrackingView.viewed_at < cutoff))
    await db.commit()
    return result.rowcount or 0


async def compute_tracking(
    db: AsyncSession, token: str, shipping_names: dict[str, str], island_labels: dict[str, str], now: datetime
) -> tuple[int, AitoTrackingResponse] | None:
    """None for unknown, trashed and expired alike — the caller turns all
    three into the same 404, so a guesser learns nothing. Otherwise the
    project id rides along with the payload so the route can log the view
    without a second lookup."""
    project = (
        await db.execute(select(AitoProject).where(AitoProject.tracking_token == token, AitoProject.status == "active"))
    ).scalar_one_or_none()
    if project is None:
        return None
    finished_at = await done_at(db, project.id) if project.board_column == "done" else None
    if is_expired(project.board_column, finished_at, now):
        return None
    tasks = (
        (
            await db.execute(
                select(AitoTask).where(AitoTask.project_id == project.id).order_by(AitoTask.position, AitoTask.id)
            )
        )
        .scalars()
        .all()
    )
    titles = [
        AitoTrackingTask(title=(t.title or "").strip() or TASK_FALLBACK.format(n=i + 1), quantity=task_quantity(t))
        for i, t in enumerate(tasks)
    ]
    shipping = None
    if project.shipping_island:
        service = project.shipping_service or ""
        # `_shipping_names` is a cache-only read (routes/aito.py) and can be
        # cold — fall back to our own static labels before the raw key, so a
        # cold cache never leaks an internal service key to the client.
        shipping = AitoTrackingShipping(
            island=island_labels.get(project.shipping_island, project.shipping_island),
            service=shipping_names.get(service, SERVICE_LABELS.get(service, service)),
        )
    updated_at = (await last_activity(db, project)).replace(microsecond=0)
    data = AitoTrackingResponse(
        column=project.board_column,
        tasks=titles,
        due_date=date.fromisoformat(project.due_date) if project.due_date else None,
        shipping=shipping,
        done_at=finished_at.replace(microsecond=0) if finished_at else None,
        invoice=invoice_state(project.invoice_status),
        reference=project.quote_number or None,
        updated_at=updated_at,
    )
    return project.id, data
