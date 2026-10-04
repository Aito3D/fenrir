"""The timelapse scan's clock strategies (1-4), pinned on their own.

Moved out of scan_timelapse unchanged; these cover what the route tests did
not: which strategy wins and the thresholds each one uses.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from backend.app.api.routes.archives import _match_timelapse_by_clock, _timelapse_choices

NOW = datetime.now(timezone.utc)


def _archive(started=None, completed=None, created=None):
    return SimpleNamespace(started_at=started, completed_at=completed, created_at=created)


def test_the_print_name_in_the_filename_wins():
    files = [{"name": "video_2026.mp4"}, {"name": "Benchy_plate_1.mp4"}]
    assert _match_timelapse_by_clock(_archive(), "benchy", files)["name"] == "Benchy_plate_1.mp4"


def test_mtime_within_two_hours_of_the_end():
    end = NOW - timedelta(days=2)
    files = [
        {"name": "a.mp4", "mtime": end - timedelta(hours=5)},
        {"name": "b.mp4", "mtime": end + timedelta(minutes=10)},
    ]
    assert _match_timelapse_by_clock(_archive(completed=end), "x", files)["name"] == "b.mp4"


def test_mtime_further_than_two_hours_is_no_match():
    end = NOW - timedelta(days=2)
    files = [{"name": "a.mp4", "mtime": end - timedelta(hours=3)}, {"name": "b.mp4", "mtime": end - timedelta(hours=4)}]
    assert _match_timelapse_by_clock(_archive(completed=end), "x", files) is None


def test_a_single_video_after_a_recent_completion():
    files = [{"name": "only.mp4"}]
    assert _match_timelapse_by_clock(_archive(completed=NOW - timedelta(minutes=20)), "x", files)["name"] == "only.mp4"
    assert _match_timelapse_by_clock(_archive(completed=NOW - timedelta(hours=2)), "x", files) is None


def test_a_naive_completion_time_is_read_as_utc():
    naive = (NOW - timedelta(minutes=5)).replace(tzinfo=None)
    assert _match_timelapse_by_clock(_archive(completed=naive), "x", [{"name": "only.mp4"}])["name"] == "only.mp4"


def test_choices_are_newest_first_with_iso_mtimes():
    choices = _timelapse_choices(
        [
            {"name": "old.mp4", "path": "/t/old.mp4", "size": 1, "mtime": NOW - timedelta(days=1)},
            {"name": "new.mp4", "path": "/t/new.mp4", "size": 2, "mtime": NOW},
            {"name": "none.mp4", "path": "/t/none.mp4", "size": 3},
        ]
    )
    assert [c["name"] for c in choices] == ["new.mp4", "old.mp4", "none.mp4"]
    assert choices[0]["mtime"] == NOW.isoformat()
