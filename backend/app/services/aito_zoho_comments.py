"""Books' own quote history, folded into ours.

Two rules keep this honest.

CLASSIFICATION IS BEST-EFFORT AND LOSSLESS. A small pattern table promotes the
four entries that matter to story depth; anything unrecognised is stored as a
zoho.comment carrying Books' text verbatim. Books can add statuses and these
patterns are language-dependent -- the live probe against the production
organisation (Task 7 Step 1) showed its Books account writes history in
French, not English, so the table below matches both. Classification is tried
in two tiers, in order:

  1. ``operation_type``. Investigated first because a stable machine value
     would survive both a reworded sentence and a change of display language.
     It does not pan out: the live data only ever carries "Added" or
     "Updated" -- Books' own "accepted" comment and a mundane "quote updated"
     comment share the identical (operation_type, transaction_type) pair, so
     there is nothing here granular enough to tell them apart. No tier is
     implemented for it; this paragraph is the record of having checked.
  2. The regex table below, tried against ``description``. This is the tier
     that actually classifies today.

Anything neither tier recognises falls to ``zoho.comment`` -- the regex tier
exists because we cannot prove Books sends a comment for every status this
mapper cares about in a form the table anticipates, and the verbatim tier
exists because Books can add statuses we have never seen.

ECHO SUPPRESSION. When we push a status to Books, Books writes its own comment
for that change, which this would otherwise import as a second event. So a
comment whose mapped kind already has an event within ECHO_WINDOW of it is
skipped -- the same idea quote_synced_at already applies to the estimate itself.
"""

import logging
import re
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.services.aito_events import record

logger = logging.getLogger(__name__)

# How close a comment must be to one of our own events of the same kind before
# it is treated as Books echoing us rather than as news. Ten minutes is far
# wider than the round trip and far narrower than any real second decision.
ECHO_WINDOW = timedelta(minutes=10)

# How long the mirror may go without pulling, even when Books says the estimate
# has not changed. Every event that matters moves last_modified_time and trips
# the watermark immediately; this only catches a human typing a comment in
# Books, which can wait. Kept high deliberately: at a 300s poll this is ~6 extra
# calls/day/project against a quota of 1,000-10,000/day for the whole org.
COMMENT_REFRESH_INTERVAL = timedelta(hours=4)

# Books returns comment timestamps in the organisation's local time, not UTC,
# while every other datetime written into aito_events is UTC. The live probe
# in Task 7 Step 1 confirmed this organisation is UTC-10 (French Polynesia,
# matching its XPF currency) by cross-referencing several comments' relative
# "date_description" fields against wall-clock UTC at request time. That is a
# property of this one organisation's account settings, not of Books' API, so
# it is read from the settings table (see ``_load_config`` in zoho.py for the
# same pattern) rather than assumed -- a different organisation could be on a
# different clock. This default only applies when nothing is configured.
# Getting this wrong does not fail loudly: it silently misreports by ten hours
# the exact fact this feature exists to establish -- when the client actually
# opened the quote.
DEFAULT_COMMENT_UTC_OFFSET_HOURS = -10
COMMENT_UTC_OFFSET_SETTING_KEY = "zoho_comment_utc_offset_hours"

# description -> (kind, actor_class). Ordered: the first match wins.
#
# Each pattern is a closed set of inflected forms, not an open stem, on
# purpose: a real Books workflow comment in this organisation reads "La mise
# à jour du champ set expiration est exécutée..." (a field literally named
# "set expiration" being updated), which an open `expir` stem would wrongly
# fire quote.expired on. Bounding every alternative with \b on both ends
# keeps "expiration" (the field name) from being mistaken for "expiré"/
# "expired" (the quote's actual state), and the same discipline is applied
# to the other four kinds even though only this one collision has been
# observed in production data.
_PATTERNS: tuple[tuple[re.Pattern, str, str], ...] = (
    (re.compile(r"\bviewed\b|\bconsulté\b|\bconsultée\b", re.I), "quote.viewed", "client"),
    (
        re.compile(r"\baccepted\b|\baccepté\b|\bacceptée\b|\bacceptés\b|\bacceptées\b", re.I),
        "quote.accepted",
        "client",
    ),
    (
        re.compile(
            r"\bdeclined\b|\brejected\b|\brefusé\b|\brefusée\b|\bdécliné\b|\bdéclinée\b",
            re.I,
        ),
        "quote.declined",
        "client",
    ),
    (
        re.compile(r"\bexpired\b|\bexpiré\b|\bexpirée\b|\bexpirés\b|\bexpirées\b", re.I),
        "quote.expired",
        "client",
    ),
    (
        re.compile(
            r"\bto Sent\b|\bhas been sent\b|\bemailed\b|\benvoyé\b|\benvoyée\b|\benvoyés\b|\benvoyées\b",
            re.I,
        ),
        "quote.sent",
        # 'system', not 'client': a client never sends a quote. Every path that
        # produces this Books comment is ours -- the user's Mark-as-sent,
        # advance_estimate_status's draft->sent hop, and the trash/restore
        # reconciler -- so attributing it to the client would be exactly the
        # false claim map_comment's own zoho.comment fallback below already
        # refuses to make ("claiming the client did it is the kind of wrong
        # an accountability timeline must not be"). viewed/accepted/declined/
        # expired stay 'client' because only the client can do those; only we
        # can send.
        "system",
    ),
)


def map_comment(comment: dict) -> dict:
    """One Books comment as the arguments for an event.

    Never returns None. An unrecognised comment is still history.
    """
    text = (comment.get("description") or "").strip()
    for pattern, kind, actor_class in _PATTERNS:
        if pattern.search(text):
            return {"kind": kind, "actor_class": actor_class, "detail": {"text": text}}
    return {
        "kind": "zoho.comment",
        # 'system' rather than 'client': we do not know who wrote it, and
        # claiming the client did is the kind of wrong an accountability
        # timeline must not be.
        "actor_class": "system",
        "detail": {"text": text},
    }


async def _comment_utc_offset_hours(db: AsyncSession) -> float:
    """The organisation's UTC offset (hours to ADD to UTC to get local time),
    e.g. -10 for French Polynesia. Read from settings, defaulting to the
    offset the live probe confirmed for this deployment's Books account."""
    from backend.app.api.routes.settings import get_setting

    raw = await get_setting(db, COMMENT_UTC_OFFSET_SETTING_KEY)
    if not raw:
        return DEFAULT_COMMENT_UTC_OFFSET_HOURS
    try:
        return float(raw)
    except ValueError:
        logger.warning("Unparseable %s=%r; falling back to default", COMMENT_UTC_OFFSET_SETTING_KEY, raw)
        return DEFAULT_COMMENT_UTC_OFFSET_HOURS


def _comment_timestamp(comment: dict, utc_offset_hours: float = DEFAULT_COMMENT_UTC_OFFSET_HOURS) -> datetime:
    """Books' local date+time, converted to a naive UTC datetime matching the
    rest of the table.

    ``utc_offset_hours`` is local minus UTC (e.g. -10), so UTC = local - offset.
    """
    raw = f"{comment.get('date', '')} {comment.get('time', '')}".strip()
    local = None
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %I:%M %p", "%Y-%m-%d"):
        try:
            local = datetime.strptime(raw, fmt)
            break
        except ValueError:
            continue
    if local is None:
        logger.warning("Unparseable Zoho comment timestamp %r; falling back to now", raw)
        return datetime.utcnow()
    return local - timedelta(hours=utc_offset_hours)


async def _is_our_echo(db: AsyncSession, project_id: int, kind: str, when: datetime) -> bool:
    existing = (
        await db.execute(
            select(AitoEvent.id).where(
                AitoEvent.project_id == project_id,
                AitoEvent.kind == kind,
                AitoEvent.zoho_comment_id.is_(None),  # ours, not a previous mirror
                AitoEvent.occurred_at >= when - ECHO_WINDOW,
                AitoEvent.occurred_at <= when + ECHO_WINDOW,
            )
        )
    ).first()
    return existing is not None


async def mirror_comments(db: AsyncSession, project: AitoProject, comments: list[dict]) -> int:
    """Write any comment we have not already seen. Returns how many were new."""
    written = 0
    utc_offset_hours = await _comment_utc_offset_hours(db)

    # One IN(...) query for the whole batch instead of one SELECT per comment.
    # Safe because zoho_comment_id is UNIQUE (models/aito_event.py) -- a row
    # already in the DB for one of these ids can only be an exact match -- and
    # because `seen` is grown below as each comment is written, so a repeat of
    # the same comment_id later in *this* batch (e.g. Books listing it twice)
    # is still caught exactly as it was when this was a query per comment.
    incoming_ids = {str(comment["comment_id"]) for comment in comments if comment.get("comment_id")}
    seen: set[str] = set()
    if incoming_ids:
        rows = await db.execute(select(AitoEvent.zoho_comment_id).where(AitoEvent.zoho_comment_id.in_(incoming_ids)))
        seen = {row[0] for row in rows}

    for comment in comments:
        comment_id = comment.get("comment_id")
        if not comment_id:
            continue
        comment_id = str(comment_id)
        if comment_id in seen:
            continue

        mapped = map_comment(comment)
        when = _comment_timestamp(comment, utc_offset_hours)
        if await _is_our_echo(db, project.id, mapped["kind"], when):
            continue

        await record(
            db,
            project.id,
            mapped["kind"],
            actor_class=mapped["actor_class"],
            actor_name=comment.get("commented_by") or project.client_name,
            subject_type="project",
            subject_id=project.id,
            detail=mapped["detail"],
            occurred_at=when,
            zoho_comment_id=comment_id,
        )
        written += 1
        seen.add(comment_id)
    return written


def should_pull_comments(project: AitoProject, estimate: dict, now: datetime) -> bool:
    """Whether this poll should spend a call on the comments endpoint.

    Books allows 1,000-10,000 requests/day for the whole organisation, and the
    poller already spends one estimate call per active quoted project per tick.
    An unconditional second call would roughly double that.
    """
    remote = estimate.get("last_modified_time")
    if remote and remote != project.zoho_comments_watermark:
        return True
    if project.zoho_comments_checked_at is None:
        return True
    return now - project.zoho_comments_checked_at >= COMMENT_REFRESH_INTERVAL
