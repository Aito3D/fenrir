"""Calendar arithmetic on yyyy-MM-dd org days; pure dates, no timezone except org_today."""

import re
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from backend.app.services.revenue.config import ORG_TIME_ZONE

_DAY_RE = re.compile(r"\d{4}-\d{2}-\d{2}", re.ASCII)


def _parse(day: str) -> date | None:
    if not _DAY_RE.fullmatch(day):
        return None
    try:
        return date.fromisoformat(day)
    except ValueError:
        return None


def _parse_or_raise(day: str) -> date:
    d = _parse(day)
    if d is None:
        raise ValueError(f"invalid day: {day!r}")
    return d


def org_today(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).astimezone(ZoneInfo(ORG_TIME_ZONE)).date().isoformat()


def day_to_utc(day: str) -> int:
    d = _parse_or_raise(day)
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp() * 1000)


def utc_to_day(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).date().isoformat()


def is_valid_day(s: str) -> bool:
    return _parse(s) is not None


def add_days(day: str, n: int) -> str:
    return (_parse_or_raise(day) + timedelta(days=n)).isoformat()


def days_between(from_: str, to: str) -> int:
    a, b = _parse(from_), _parse(to)
    if a is None or b is None:
        return 0
    return max((b - a).days + 1, 0)


def all_days(from_: str, to: str) -> list[str]:
    a = _parse(from_)
    return [(a + timedelta(days=i)).isoformat() for i in range(days_between(from_, to))] if a else []


def days_in_month(year: int, month: int) -> int:
    return (date(year + month // 12, month % 12 + 1, 1) - timedelta(days=1)).day


def iso_week(day: str) -> tuple[int, int]:
    year, week, _ = _parse_or_raise(day).isocalendar()
    return year, week


def iso_week1_monday(year: int) -> int:
    jan4 = date(year, 1, 4)
    monday = jan4 - timedelta(days=jan4.weekday())
    return day_to_utc(monday.isoformat())
