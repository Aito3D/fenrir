from datetime import datetime, timezone

from backend.app.services.revenue.dates import (
    add_days,
    all_days,
    days_between,
    days_in_month,
    is_valid_day,
    iso_week,
    org_today,
)


def test_is_valid_day_accepts_yyyy_mm_dd_that_round_trips_and_rejects_everything_else():
    assert is_valid_day("2026-10-15") is True
    assert is_valid_day("2024-02-29") is True
    assert is_valid_day("2026-02-30") is False
    assert is_valid_day("2026-1-5") is False
    assert is_valid_day("15/10/2026") is False
    assert is_valid_day("") is False


def test_add_days_crosses_months_years_and_leap_days():
    assert add_days("2026-10-15", 1) == "2026-10-16"
    assert add_days("2026-01-01", -1) == "2025-12-31"
    assert add_days("2024-02-28", 1) == "2024-02-29"
    assert add_days("2026-10-15", -7) == "2026-10-08"


def test_all_days_is_inclusive_and_empty_when_from_after_to():
    assert all_days("2026-10-30", "2026-11-02") == ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]
    assert all_days("2026-10-02", "2026-10-01") == []
    assert len(all_days("2024-01-01", "2026-10-15")) == 1019


def test_iso_week_follows_iso_8601_across_year_ends():
    assert iso_week("2026-10-15") == (2026, 42)
    assert iso_week("2024-01-01") == (2024, 1)
    assert iso_week("2024-12-30") == (2025, 1)
    assert iso_week("2027-01-01") == (2026, 53)
    assert iso_week("2025-12-28") == (2025, 52)


def test_days_in_month_handles_leap_years():
    assert days_in_month(2024, 2) == 29
    assert days_in_month(2026, 2) == 28
    assert days_in_month(2026, 12) == 31


def test_days_between_counts_inclusive_days():
    assert days_between("2024-01-01", "2026-10-15") == 1019
    assert days_between("2026-10-15", "2026-10-15") == 1


def test_days_between_is_0_when_from_after_to_or_either_day_is_invalid():
    assert days_between("2026-10-16", "2026-10-15") == 0
    assert days_between("nope", "2026-10-15") == 0
    assert days_between("2026-10-15", "nope") == 0
    assert days_between("", "") == 0


def test_days_between_equals_all_days_length_over_month_and_year_boundaries():
    ranges = [
        ("2026-01-31", "2026-02-01"),
        ("2024-02-28", "2024-03-01"),
        ("2025-02-28", "2025-03-01"),
        ("2025-12-31", "2026-01-01"),
        ("2023-12-25", "2026-01-05"),
        ("2026-10-15", "2026-10-15"),
        ("2026-10-15", "2026-10-14"),
        ("2000-02-29", "2100-03-01"),
        ("2026-03-01", "2026-03-31"),
        ("2026-02-30", "2026-03-05"),
        ("bad", "2026-03-05"),
        ("2026-03-05", "bad"),
    ]
    for from_, to in ranges:
        assert days_between(from_, to) == len(all_days(from_, to))


def test_org_today_is_the_tahiti_day_utc_minus_10():
    assert org_today(datetime(2026, 11, 18, 9, 59, tzinfo=timezone.utc)) == "2026-11-17"
    assert org_today(datetime(2026, 11, 18, 10, 0, tzinfo=timezone.utc)) == "2026-11-18"
