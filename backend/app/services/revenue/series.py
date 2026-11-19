"""The revenue dashboard's read model: bucket keys, ranges and French labels (the series builder follows)."""

import re
from typing import Literal, get_args

from backend.app.services.revenue.dates import (
    add_days,
    days_in_month,
    is_valid_day,
    iso_week,
    iso_week1_monday,
    utc_to_day,
)

Granularity = Literal["day", "week", "month", "year"]
RangePresetId = Literal["this-year", "last-12-months", "all"]
RANGE_PRESETS: tuple[str, ...] = get_args(RangePresetId)

_DAY_MS = 86_400_000
# Hard-coded to equal Intl.DateTimeFormat("fr-FR", {month: "short"}); no locale dependency.
_FR_MONTHS = ("janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc.")


def _parse_week_key(key: str) -> tuple[int, int]:
    y, w = key.split("-W")
    return int(y), int(w)


def bucket_key_for(day: str, g: Granularity) -> str:
    if g == "day":
        return day
    if g == "week":
        year, week = iso_week(day)
        return f"{year}-W{week:02d}"
    return day[:7] if g == "month" else day[:4]


def bucket_range(key: str, g: Granularity) -> tuple[str, str]:
    if g == "day":
        return key, key
    if g == "week":
        year, week = _parse_week_key(key)
        start = iso_week1_monday(year) + (week - 1) * 7 * _DAY_MS
        return utc_to_day(start), utc_to_day(start + 6 * _DAY_MS)
    if g == "month":
        y, m = (int(p) for p in key.split("-"))
        return f"{key}-01", f"{key}-{days_in_month(y, m):02d}"
    return f"{key}-01-01", f"{key}-12-31"


def _fmt_day(day: str, *, year: bool = True) -> str:
    y, m, d = day.split("-")
    return f"{int(d)} {_FR_MONTHS[int(m) - 1]}" + (f" {y}" if year else "")


def bucket_label(key: str, g: Granularity) -> str:
    start, end = bucket_range(key, g)
    if g == "day":
        return _fmt_day(key)
    if g == "week":
        _, week = _parse_week_key(key)
        if start[:7] == end[:7]:
            left = str(int(start[8:]))
        else:
            left = _fmt_day(start, year=start[:4] != end[:4])
        return f"S{week:02d} · {left}–{_fmt_day(end)}"
    if g == "month":
        return f"{_FR_MONTHS[int(start[5:7]) - 1]} {start[:4]}"
    return key


def shift_bucket_year(key: str, g: Granularity, delta: int) -> str | None:
    """The same bucket `delta` years away, or None when it does not exist (ISO week 53)."""
    if g == "day":
        y, m, d = (int(p) for p in key.split("-"))
        year = y + delta
        return f"{year}-{m:02d}-{min(d, days_in_month(year, m)):02d}"
    if g == "week":
        year, week = _parse_week_key(key)
        target = year + delta
        # A year has 53 ISO weeks when 28 December falls in week 53.
        return None if week > iso_week(f"{target}-12-28")[1] else f"{target}-W{week:02d}"
    if g == "month":
        y, m = key.split("-")
        return f"{int(y) + delta}-{m}"
    return str(int(key) + delta)


def is_bucket_key(key: str, g: Granularity) -> bool:
    if g == "day":
        return is_valid_day(key)
    pattern = {"week": r"\d{4}-W\d{2}", "month": r"\d{4}-\d{2}", "year": r"\d{4}"}[g]
    return re.fullmatch(pattern, key) is not None


def clamp_range(from_: str, to: str, history_start: str, today: str) -> tuple[str, str]:
    a = history_start if from_ < history_start else today if from_ > today else from_
    b = today if to > today else history_start if to < history_start else to
    return (b, a) if a > b else (a, b)


def range_preset(id: RangePresetId, today: str, history_start: str) -> tuple[str, str]:
    if id == "this-year":
        return clamp_range(f"{today[:4]}-01-01", today, history_start, today)
    if id == "last-12-months":
        year, m, d = int(today[:4]) - 1, int(today[5:7]), int(today[8:])
        back = f"{year}-{m:02d}-{min(d, days_in_month(year, m)):02d}"
        return clamp_range(add_days(back, 1), today, history_start, today)
    return history_start, today


def default_range(g: Granularity, today: str, history_start: str) -> tuple[str, str]:
    if g == "day":
        return clamp_range(add_days(today, -59), today, history_start, today)
    if g == "week":
        monday = bucket_range(bucket_key_for(today, "week"), "week")[0]
        return clamp_range(add_days(monday, -25 * 7), today, history_start, today)
    return range_preset("all", today, history_start)


def snap_to_bucket_end(to: str, g: Granularity, today: str) -> str:
    """The route's effective `to`: the end of the bucket holding it, never past today."""
    end = bucket_range(bucket_key_for(to, g), g)[1]
    return min(end, today)


def series_line_range(g: Granularity, from_: str, to: str, history_start: str) -> tuple[str, str]:
    """The lines the series must read: the first bucket's whole start, one year back for year-ago."""
    first_start = bucket_range(bucket_key_for(from_, g), g)[0]
    back = shift_bucket_year(bucket_key_for(first_start, g), g, -1)
    start = bucket_range(back, g)[0] if back else add_days(first_start, -366)
    return max(start, history_start), to
