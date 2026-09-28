"""The shared watermark helpers both Books polls call (aito_invoice_poll,
aito_contact_poll). The polls' own suites pin the end-to-end behaviour; this
pins the helper's edges directly."""

from datetime import datetime, timedelta, timezone

from backend.app.api.routes.settings import get_setting, set_setting
from backend.app.services import aito_contact_poll, aito_invoice_poll
from backend.app.services.aito_poll_watermark import (
    advance_watermark,
    format_books_time,
    parse_books_time,
    read_since,
)
from backend.app.services.zoho import ModifiedSinceRows

SETTING = "aito_test_poll_since"


def test_books_time_round_trip_and_the_polls_keep_their_names():
    moment = datetime(2026, 9, 22, 10, 0, 5, tzinfo=timezone(timedelta(hours=-10)))
    assert format_books_time(moment) == "2026-09-22T20:00:05+0000"
    assert parse_books_time("2026-09-22T20:00:05+0000") == moment
    assert parse_books_time("not a time") is None
    assert parse_books_time(None) is None
    for module in (aito_invoice_poll, aito_contact_poll):
        assert module._format_books_time is format_books_time
        assert module._parse_books_time is parse_books_time


async def test_read_since_keeps_a_valid_watermark_and_backfills_otherwise(db_session):
    await set_setting(db_session, SETTING, "2026-09-22T00:00:00+0000")
    assert await read_since(db_session, SETTING, 90) == "2026-09-22T00:00:00+0000"
    await set_setting(db_session, SETTING, "garbage")
    since = parse_books_time(await read_since(db_session, SETTING, 90))
    days = (datetime.now(timezone.utc) - since).days
    assert 89 <= days <= 90


async def test_advance_watermark_rewinds_clamps_and_skips_an_empty_pass(db_session):
    since = "2026-09-22T00:00:00+0000"
    base = parse_books_time(since)
    await set_setting(db_session, SETTING, since)

    # Nothing timestamped: the stored watermark stays.
    await advance_watermark(
        db_session, SETTING, since, [], None, None, overlap_seconds=300, truncated_overlap_seconds=1
    )
    assert await get_setting(db_session, SETTING) == since

    # The oldest failure holds the watermark back; the overlap rewinds it.
    newest, failure = base + timedelta(hours=2), base + timedelta(hours=1)
    await advance_watermark(
        db_session, SETTING, since, [], newest, failure, overlap_seconds=300, truncated_overlap_seconds=1
    )
    assert await get_setting(db_session, SETTING) == format_books_time(failure - timedelta(seconds=300))

    # A truncated pass resumes one second back.
    rows = ModifiedSinceRows()
    rows.truncated = True
    await advance_watermark(
        db_session, SETTING, since, rows, newest, None, overlap_seconds=300, truncated_overlap_seconds=1
    )
    assert await get_setting(db_session, SETTING) == format_books_time(newest - timedelta(seconds=1))

    # Never before where the pass started.
    await advance_watermark(
        db_session,
        SETTING,
        since,
        [],
        base + timedelta(seconds=10),
        None,
        overlap_seconds=300,
        truncated_overlap_seconds=1,
    )
    assert await get_setting(db_session, SETTING) == since
