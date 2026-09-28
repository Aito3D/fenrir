"""The Books-timestamp dialect and the watermark both "what changed in Books
since I last looked?" polls share (aito_invoice_poll, aito_contact_poll).

Each poll keeps its own setting name and constants (BACKFILL_DAYS,
OVERLAP_SECONDS, TRUNCATED_OVERLAP_SECONDS) and passes them in; the
reasoning behind each value is documented next to it in the poll module.
"""

from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession

# Books' own spelling: offset as ±HHMM, never 'Z'. `...Z` is rejected outright
# with "Invalid value passed for last_modified_time" (verified live), so this
# is not interchangeable with datetime.isoformat().
BOOKS_TIME = "%Y-%m-%dT%H:%M:%S%z"


def format_books_time(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime(BOOKS_TIME)


def parse_books_time(value: str | None) -> datetime | None:
    """Books' timestamp, or None when it is absent or unparseable.

    Never raises: this feeds the watermark, and a single row with a mangled
    timestamp must cost that row's contribution to the watermark, not the
    pass.
    """
    try:
        return datetime.strptime((value or "").strip(), BOOKS_TIME)
    except ValueError:
        return None


async def read_since(db: AsyncSession, setting: str, backfill_days: int) -> str:
    """The stored watermark, or — when there is none, or one written by
    something that did not speak Books' dialect — the start of the backfill
    window rather than "now", so the first pass catches up on what is already
    there."""
    from backend.app.api.routes.settings import get_setting

    stored = (await get_setting(db, setting) or "").strip()
    if parse_books_time(stored) is not None:
        return stored
    return format_books_time(datetime.now(timezone.utc) - timedelta(days=backfill_days))


async def advance_watermark(
    db: AsyncSession,
    setting: str,
    since: str,
    rows: list[dict],
    newest: datetime | None,
    oldest_failure: datetime | None,
    *,
    overlap_seconds: int,
    truncated_overlap_seconds: int,
) -> None:
    """Persist where the next pass resumes; a pass that saw no timestamped
    row leaves the watermark (and the session) untouched.

    The watermark never passes the oldest row this pass could not finish, or
    its retry would never be offered.
    """
    from backend.app.api.routes.settings import set_setting

    watermark = min(x for x in (newest, oldest_failure) if x is not None) if (newest or oldest_failure) else None
    if watermark is not None:
        # Rows arrive oldest first, so on a pass the page cap cut short
        # ``newest`` is the last row read and everything after it is still
        # unread: resume right there rather than skip it.
        rewind = truncated_overlap_seconds if getattr(rows, "truncated", False) else overlap_seconds
        resume = watermark - timedelta(seconds=rewind)
        # Never rewind to before where this pass started: everything from
        # ``since`` on was just read, so going further back only re-reads
        # rows already seen — and after a window walked in capped passes,
        # the overlap would reach back into it and start the walk over.
        started = parse_books_time(since)
        if started is not None and resume < started:
            resume = started
        await set_setting(db, setting, format_books_time(resume))
        await db.commit()
