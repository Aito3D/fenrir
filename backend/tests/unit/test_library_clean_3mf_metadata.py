"""Tests for ``_clean_3mf_metadata`` (T-159).

Previously this was a byte-for-byte identical nested ``clean_metadata``
closure copy-pasted into three route handlers (``upload_file``,
``extract_zip_file``, ``scan_external_folder``); it's now the single
module-level helper all three call, alongside the two callers
(``save_3mf_bytes_to_library`` and the makerworld route) that already used
it. It strips the raw ``bytes`` thumbnail payload embedded by
``ThreeMFParser`` (``_thumbnail_data``/``_thumbnail_ext``) plus any other
non-JSON-serializable bytes, recursively, so the result is always safe to
store as ``file_metadata``.
"""

from backend.app.api.routes.library import _clean_3mf_metadata


def test_strips_thumbnail_keys_and_keeps_siblings():
    raw = {
        "_thumbnail_data": b"\x89PNG...",
        "_thumbnail_ext": ".png",
        "print_time_seconds": 100,
        "filament_used_grams": 12.5,
    }
    assert _clean_3mf_metadata(raw) == {"print_time_seconds": 100, "filament_used_grams": 12.5}


def test_no_thumbnail_present_passes_other_fields_through():
    raw = {"print_time_seconds": 42, "nozzle_diameter": 0.4}
    assert _clean_3mf_metadata(raw) == {"print_time_seconds": 42, "nozzle_diameter": 0.4}


def test_metadata_absent_returns_none():
    assert _clean_3mf_metadata(None) is None


def test_strips_nested_bytes_in_dicts_and_lists():
    raw = {
        "plates": [
            {"name": "plate_1", "preview": b"raw-bytes"},
            {"name": "plate_2"},
        ],
        "raw_blob": b"top-level-bytes",
    }
    assert _clean_3mf_metadata(raw) == {
        "plates": [{"name": "plate_1"}, {"name": "plate_2"}],
    }


def test_bare_bytes_value_becomes_none():
    assert _clean_3mf_metadata(b"just bytes") is None


def test_does_not_mutate_input():
    original = {"_thumbnail_data": b"x", "print_time_seconds": 1}
    cleaned = _clean_3mf_metadata(original)
    assert original == {"_thumbnail_data": b"x", "print_time_seconds": 1}  # untouched
    assert cleaned == {"print_time_seconds": 1}
