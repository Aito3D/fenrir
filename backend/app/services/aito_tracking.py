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

# Crockford's base32: digits and capitals minus I, L, O and U, so no symbol
# looks like another when read off a quote PDF or typed from a phone. Six of
# them is 30 bits — a billion codes — which the owner chose over the earlier
# 43-character token on purpose (2026-09-08): the page shows a job's stage,
# parts and pickup island, nothing secret, and a code a client can copy by
# hand or scan from a small QR was worth more than an unguessable one. The
# public route's rate limits (routes/aito.py, per IP and global) are the
# compensating control; tokens also die 30 days after the job is done.
TOKEN_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
TOKEN_LENGTH = 6
# Links minted before the short codes are 43 urlsafe characters and keep
# working as sent: anything this long is looked up verbatim.
LEGACY_TOKEN_MIN_LENGTH = 20
_TOKEN_ALIASES = str.maketrans({"I": "1", "L": "1", "O": "0"})
TRACKING_TTL_AFTER_DONE = timedelta(days=30)
# A card still waiting for its go-ahead (Devis / Waiting) goes dark after
# this much silence. Every quoted card is minted a code — the sync prints it
# on the estimate — and with only Done expiring, abandoned quotes kept live
# codes forever and the guessable space slowly filled with them. Any
# activity on the card (an edit, a status from Books) restarts the clock.
TRACKING_TTL_DORMANT = timedelta(days=180)
DORMANT_COLUMNS = frozenset({"devis", "waiting"})
# A quote settled the other way has no story for the page to tell. The rules
# park a declined quote in Done, which the page would otherwise read as
# "collected" — on the link printed on the very quote the client declined.
CLOSED_QUOTE_STATUSES = frozenset({"declined", "expired"})
NOTES_PREFIX = "Lien de suivi de votre projet : "
NOTES_CODE_PREFIX = "Code de suivi : "
# Wordings this app wrote before 2026-09-08. Stripped on merge, so a card
# re-synced after the change carries one tracking block, not two.
_LEGACY_NOTES_PREFIXES = ("Suivez votre commande : ",)
SMS_PREFIX = "\n\nSuivi : "


def mint_token() -> str:
    return "".join(secrets.choice(TOKEN_ALPHABET) for _ in range(TOKEN_LENGTH))


def normalize_token(raw: str) -> str | None:
    """What a typed or pasted code means, or None when it cannot be a code.

    Case is folded, spaces and hyphens dropped, and the letters Crockford
    leaves out are read as the digits they resemble (I and L as 1, O as 0),
    so `k7f3-xq9w`, `K7F3XQ9W` and `K7F3XQ9W ` all name the same card and
    a client never loses to their own handwriting. A legacy long token
    passes through untouched."""
    if len(raw) >= LEGACY_TOKEN_MIN_LENGTH:
        return raw
    code = "".join(ch for ch in raw.upper().translate(_TOKEN_ALIASES) if ch.isalnum())
    if len(code) != TOKEN_LENGTH or any(ch not in TOKEN_ALPHABET for ch in code):
        return None
    return code


async def mint_unique_token(db: AsyncSession) -> str:
    """A fresh code no active-or-trashed card holds. A billion codes against
    a few hundred cards makes a clash a once-a-decade event, but the column
    is unique-indexed and a clash there would be a 500 on a Copy click."""
    for _ in range(10):
        token = mint_token()
        taken = (await db.execute(select(AitoProject.id).where(AitoProject.tracking_token == token))).first()
        if taken is None:
            return token
    raise RuntimeError("could not mint a unique tracking token")  # pragma: no cover — 32^6 space


async def external_url(db: AsyncSession) -> str:
    """The configured public origin, or '' — never a guess."""
    from backend.app.api.routes.settings import get_setting

    return (await get_setting(db, "external_url") or "").strip().rstrip("/")


def tracking_url_for(base: str, token: str | None) -> str | None:
    """`/t/`, not `/track/`: the link goes on quote PDFs and into QR codes,
    where every character costs. The page still answers at `/track/` for
    links already sent (App.tsx keeps that route as an alias)."""
    if not base or not token:
        return None
    return f"{base}/t/{token}"


def tracking_notes(url: str, token: str) -> str:
    """The customer notes printed on the Zoho estimate, in French: the link,
    and — for a short code — the code on its own line, because a client
    reading the PDF on paper types it into /t rather than clicking. A legacy
    long token is a link only; nobody is typing 43 characters."""
    text = f"{NOTES_PREFIX}{url}"
    if len(token) == TOKEN_LENGTH:
        text += f"\n{NOTES_CODE_PREFIX}{token}"
    return text


def with_tracking_notes(existing: str | None, url: str, token: str) -> str:
    """The estimate's customer notes with this card's tracking block under
    them. Books fills the notes from the org default on create — the
    "Signature du client (précédée de la mention « Bon pour accord »)" line
    printed beside the totals — and an operator may have typed more in
    Books; both are kept. Only lines this app wrote (any wording it has
    ever used) are dropped before the current block is appended, so the
    result is the same whether the card is synced once or fifty times, or
    its link was regenerated in between."""
    prefixes = (NOTES_PREFIX, NOTES_CODE_PREFIX, *_LEGACY_NOTES_PREFIXES)
    kept = [line for line in (existing or "").splitlines() if not line.startswith(prefixes)]
    head = "\n".join(kept).rstrip()
    block = tracking_notes(url, token)
    return f"{head}\n\n{block}" if head else block


async def ensure_tracking_token(db: AsyncSession, project: AitoProject) -> str:
    """The card's token, minting one if it has none. Flushes, never commits:
    the caller's transaction owns that.

    The mint is a conditional `UPDATE ... WHERE tracking_token IS NULL`, not a
    check-then-act on the in-memory attribute: two concurrent mints for the
    same card (routes/aito.py's tracking-link and pickup-message paths both
    call this) would otherwise race, with the slower one silently overwriting
    a token that may already have been handed out. Here only one UPDATE can
    match the NULL guard, so the loser re-reads the row and returns the
    winner's token instead of replacing it. The candidate itself comes
    from mint_unique_token, so it is also fresh against every other card
    (the column is unique-indexed)."""
    if project.tracking_token:
        return project.tracking_token
    new_token = await mint_unique_token(db)
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


def is_expired(column: str, finished_at: datetime | None, last_active: datetime, now: datetime) -> bool:
    """Done: 30 days after the move into Done — or, for a card that got
    there without a stage.changed event (imported straight into Done, or
    older than the event log), after its last activity, so no card is
    without a clock. Devis / Waiting: TRACKING_TTL_DORMANT of silence."""
    if column == "done":
        return (finished_at or last_active) + TRACKING_TTL_AFTER_DONE < now
    if column in DORMANT_COLUMNS:
        return last_active + TRACKING_TTL_DORMANT < now
    return False


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
    """None for unknown, trashed, closed (declined / expired quote) and
    expired alike — the caller turns them all into the same 404, so a
    guesser learns nothing. Otherwise the project id rides along with the
    payload so the route can log the view without a second lookup."""
    code = normalize_token(token)
    if code is None:
        return None
    project = (
        await db.execute(select(AitoProject).where(AitoProject.tracking_token == code, AitoProject.status == "active"))
    ).scalar_one_or_none()
    if project is None or project.quote_status in CLOSED_QUOTE_STATUSES:
        return None
    finished_at = await done_at(db, project.id) if project.board_column == "done" else None
    last_active = await last_activity(db, project)
    if is_expired(project.board_column, finished_at, last_active, now):
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
            lta=project.shipping_lta,
        )
    updated_at = last_active.replace(microsecond=0)
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
