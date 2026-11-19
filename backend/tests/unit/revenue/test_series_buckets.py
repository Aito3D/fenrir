from backend.app.services.revenue.series import (
    RANGE_PRESETS,
    bucket_key_for,
    bucket_label,
    bucket_range,
    clamp_range,
    default_range,
    is_bucket_key,
    range_preset,
    series_line_range,
    shift_bucket_year,
    snap_to_bucket_end,
)


def test_keys_a_day_per_granularity():
    assert bucket_key_for("2026-10-15", "day") == "2026-10-15"
    assert bucket_key_for("2026-10-15", "week") == "2026-W42"
    assert bucket_key_for("2026-10-15", "month") == "2026-10"
    assert bucket_key_for("2026-10-15", "year") == "2026"
    assert bucket_key_for("2024-12-30", "week") == "2025-W01"


def test_ranges_are_the_full_calendar_bucket():
    assert bucket_range("2026-W42", "week") == ("2026-10-12", "2026-10-18")
    assert bucket_range("2025-W01", "week") == ("2024-12-30", "2025-01-05")
    assert bucket_range("2024-02", "month") == ("2024-02-01", "2024-02-29")
    assert bucket_range("2026", "year") == ("2026-01-01", "2026-12-31")
    assert bucket_range("2026-10-15", "day") == ("2026-10-15", "2026-10-15")


def test_labels_in_french():
    assert bucket_label("2026-10", "month") == "oct. 2026"
    assert bucket_label("2026", "year") == "2026"
    assert bucket_label("2026-10-15", "day") == "15 oct. 2026"
    assert bucket_label("2026-W42", "week") == "S42 · 12–18 oct. 2026"
    assert bucket_label("2025-W01", "week") == "S01 · 30 déc. 2024–5 janv. 2025"


def test_shifts_a_bucket_by_a_year_refusing_a_week_53_that_does_not_exist_and_clamping_29_feb():
    assert shift_bucket_year("2026-10", "month", -1) == "2025-10"
    assert shift_bucket_year("2026", "year", -1) == "2025"
    assert shift_bucket_year("2026-W42", "week", -1) == "2025-W42"
    assert shift_bucket_year("2026-W53", "week", -1) is None
    assert shift_bucket_year("2024-02-29", "day", -1) == "2023-02-28"


def test_presets():
    assert RANGE_PRESETS == ("this-year", "last-12-months", "all")
    assert range_preset("this-year", "2026-10-15", "2024-01-01") == ("2026-01-01", "2026-10-15")
    assert range_preset("last-12-months", "2026-10-15", "2024-01-01") == ("2025-10-16", "2026-10-15")
    assert range_preset("all", "2026-10-15", "2024-01-01") == ("2024-01-01", "2026-10-15")


def test_clamp_range_keeps_dates_inside_history_start_today_and_orders_them():
    assert clamp_range("2023-05-01", "2027-01-01", "2024-01-01", "2026-10-15") == ("2024-01-01", "2026-10-15")
    assert clamp_range("2026-10-10", "2026-10-01", "2024-01-01", "2026-10-15") == ("2026-10-01", "2026-10-10")


def test_default_range_60_days_for_day_26_weeks_for_week_all_for_month_and_year():
    assert default_range("day", "2026-10-15", "2024-01-01") == ("2026-08-17", "2026-10-15")
    assert default_range("week", "2026-10-15", "2024-01-01") == ("2026-04-20", "2026-10-15")
    assert default_range("month", "2026-10-15", "2024-01-01") == ("2024-01-01", "2026-10-15")


def test_series_line_range_starts_one_year_before_the_first_buckets_start_clamped_at_history_start():
    assert series_line_range("month", "2026-09-15", "2026-10-15", "2024-01-01") == ("2025-09-01", "2026-10-15")
    assert series_line_range("week", "2024-01-03", "2024-01-20", "2024-01-01") == ("2024-01-01", "2024-01-20")


def test_labels_a_week_spanning_two_months_in_one_year_and_a_week_inside_one_month():
    assert bucket_label("2026-W41", "week") == "S41 · 5–11 oct. 2026"
    assert bucket_label("2026-W40", "week") == "S40 · 28 sept.–4 oct. 2026"


def test_clamp_range_clamps_a_from_past_today_and_a_to_before_history_start():
    assert clamp_range("2027-01-01", "2027-02-01", "2024-01-01", "2026-10-15") == ("2026-10-15", "2026-10-15")
    assert clamp_range("2023-01-01", "2023-06-01", "2024-01-01", "2026-10-15") == ("2024-01-01", "2024-01-01")


def test_series_line_range_falls_back_to_366_days_before_a_week_whose_year_ago_does_not_exist():
    assert series_line_range("week", "2026-12-30", "2027-01-03", "2024-01-01") == ("2025-12-27", "2027-01-03")


def test_french_month_abbreviations():
    labels = [bucket_label(f"2026-{m:02d}", "month") for m in range(1, 13)]
    assert [x.split(" ")[0] for x in labels] == [
        "janv.",
        "févr.",
        "mars",
        "avr.",
        "mai",
        "juin",
        "juil.",
        "août",
        "sept.",
        "oct.",
        "nov.",
        "déc.",
    ]


def test_is_bucket_key():
    assert is_bucket_key("2026-10-15", "day") and not is_bucket_key("2026-02-30", "day")
    assert is_bucket_key("2026-W42", "week") and not is_bucket_key("2026-10", "week")
    assert is_bucket_key("2026-10", "month") and not is_bucket_key("2026", "month")
    assert is_bucket_key("2026", "year") and not is_bucket_key("26", "year")


def test_snap_to_bucket_end_stops_at_today():
    assert snap_to_bucket_end("2026-09-10", "month", "2026-10-15") == "2026-09-30"
    assert snap_to_bucket_end("2026-10-10", "month", "2026-10-15") == "2026-10-15"
    assert snap_to_bucket_end("2026-10-14", "week", "2026-10-15") == "2026-10-15"
