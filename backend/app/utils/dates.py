"""Date-range helpers shared by stats/list endpoints."""

from datetime import date, datetime, time, timedelta, timezone, tzinfo

from backend.app.utils.local_time import day_zone


def local_day_bounds(
    date_from: date | None,
    date_to: date | None,
    tz_offset_minutes: int = 0,
) -> tuple[datetime | None, datetime | None]:
    """Convert inclusive local calendar dates to a naive-UTC datetime window.

    tz_offset_minutes is minutes east of UTC as reported by the client
    (JS: -new Date().getTimezoneOffset()), so a caller in UTC-10 sends -600.

    Returns naive UTC datetimes: created_at columns are stored as naive UTC
    strings in SQLite, and an aware non-UTC datetime would serialize with an
    offset suffix that breaks string ordering in comparisons.
    """
    tz = timezone(timedelta(minutes=tz_offset_minutes))
    dt_from = (
        datetime.combine(date_from, time.min, tzinfo=tz).astimezone(timezone.utc).replace(tzinfo=None)
        if date_from
        else None
    )
    dt_to = (
        datetime.combine(date_to, time.max, tzinfo=tz).astimezone(timezone.utc).replace(tzinfo=None)
        if date_to
        else None
    )
    return dt_from, dt_to


def request_day_zone(tz: str | None, tz_offset_minutes: int | None = None) -> tzinfo:
    """The zone a request's calendar dates are in.

    The IANA ``tz`` when sent (it knows DST); else the fixed UTC offset older
    clients send as ``tz_offset_minutes``; else the server's own zone.
    """
    if not tz and tz_offset_minutes is not None:
        return timezone(timedelta(minutes=tz_offset_minutes))
    return day_zone(tz)
