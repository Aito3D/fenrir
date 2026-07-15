"""Tests for local_day_bounds — client-local calendar days → naive-UTC window.

The stats timeframe filter defines "today" as the client's local calendar
day (#stats-timezone). tz_offset_minutes is minutes east of UTC, as sent by
the frontend via -new Date().getTimezoneOffset().
"""

from datetime import date, datetime

from backend.app.utils.dates import local_day_bounds


class TestLocalDayBounds:
    def test_utc_offset_zero_matches_utc_day(self):
        dt_from, dt_to = local_day_bounds(date(2026, 7, 14), date(2026, 7, 14), 0)
        assert dt_from == datetime(2026, 7, 14, 0, 0, 0)
        assert dt_to == datetime(2026, 7, 14, 23, 59, 59, 999999)

    def test_negative_offset_shifts_window_forward(self):
        # UTC-10 (e.g. Hawaii): local Jul 14 spans Jul 14 10:00 UTC → Jul 15 09:59 UTC.
        dt_from, dt_to = local_day_bounds(date(2026, 7, 14), date(2026, 7, 14), -600)
        assert dt_from == datetime(2026, 7, 14, 10, 0, 0)
        assert dt_to == datetime(2026, 7, 15, 9, 59, 59, 999999)

    def test_positive_offset_shifts_window_backward(self):
        # UTC+2: local Jul 14 spans Jul 13 22:00 UTC → Jul 14 21:59 UTC.
        dt_from, dt_to = local_day_bounds(date(2026, 7, 14), date(2026, 7, 14), 120)
        assert dt_from == datetime(2026, 7, 13, 22, 0, 0)
        assert dt_to == datetime(2026, 7, 14, 21, 59, 59, 999999)

    def test_results_are_naive(self):
        # created_at is stored as a naive UTC string in SQLite; an aware
        # non-UTC datetime would serialize with an offset suffix and break
        # string-ordered comparisons.
        dt_from, dt_to = local_day_bounds(date(2026, 7, 14), date(2026, 7, 14), -600)
        assert dt_from.tzinfo is None
        assert dt_to.tzinfo is None

    def test_none_dates_pass_through(self):
        assert local_day_bounds(None, None, -600) == (None, None)
        dt_from, dt_to = local_day_bounds(date(2026, 7, 14), None, -600)
        assert dt_from is not None
        assert dt_to is None
