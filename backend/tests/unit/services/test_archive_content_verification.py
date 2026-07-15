"""Tests for the content-verification helpers used by the print_start callback.

Covers the #2104 fix: FTP filename search alone can land on a months-old
same-name file elsewhere on the printer's storage (a stale copy at ``/``
while the fresh slicer upload sits in ``/cache``, served case-insensitively
by Bambu's FTP). The downloaded candidate is now judged before acceptance:

- ``verify_3mf_candidate`` — md5 from the intercepted ``project_file``
  command when available (authoritative), otherwise a lax plate-prediction
  vs printer-remaining-time plausibility check. Touchscreen reprints produce
  no command, so the fallback must never false-reject: only gross mismatches
  (>2x AND >15 min apart) are rejected.
- ``peek_plate_prediction_in_3mf`` — cheap slice_info-only read, mirroring
  ``peek_plate_index_in_3mf`` (#1204).
- ``compute_file_md5`` — digest compared against the slicer's payload md5.
"""

import hashlib
import zipfile

import pytest

from backend.app.services.archive import (
    compute_file_md5,
    peek_plate_prediction_in_3mf,
    verify_3mf_candidate,
)


def _make_3mf(tmp_path, plates: list[dict], name: str = "test.3mf"):
    """Build a minimal 3MF whose slice_info holds one <plate> per dict.

    Each dict may carry ``index`` and/or ``prediction`` metadata values.
    """
    path = tmp_path / name
    plate_xml = ""
    for plate in plates:
        metas = "".join(f'<metadata key="{k}" value="{v}" />' for k, v in plate.items())
        plate_xml += f"<plate>{metas}</plate>"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("Metadata/slice_info.config", f"<config>{plate_xml}</config>")
    return path


class TestPeekPlatePredictionIn3mf:
    def test_single_plate_returns_prediction_without_index(self, tmp_path):
        path = _make_3mf(tmp_path, [{"index": 1, "prediction": 1421}])
        assert peek_plate_prediction_in_3mf(path) == 1421

    def test_plate_index_selects_matching_plate(self, tmp_path):
        path = _make_3mf(
            tmp_path,
            [{"index": 1, "prediction": 100}, {"index": 6, "prediction": 15852}],
        )
        assert peek_plate_prediction_in_3mf(path, plate_index=6) == 15852

    def test_multi_plate_without_index_returns_none(self, tmp_path):
        # A whole-file sum wouldn't be comparable to one plate's remaining time.
        path = _make_3mf(
            tmp_path,
            [{"index": 1, "prediction": 100}, {"index": 2, "prediction": 200}],
        )
        assert peek_plate_prediction_in_3mf(path) is None

    def test_missing_prediction_returns_none(self, tmp_path):
        path = _make_3mf(tmp_path, [{"index": 1}])
        assert peek_plate_prediction_in_3mf(path) is None

    def test_unmatched_plate_index_returns_none(self, tmp_path):
        path = _make_3mf(tmp_path, [{"index": 1, "prediction": 100}])
        assert peek_plate_prediction_in_3mf(path, plate_index=3) is None

    def test_non_zip_returns_none(self, tmp_path):
        path = tmp_path / "bad.3mf"
        path.write_bytes(b"not a zip")
        assert peek_plate_prediction_in_3mf(path) is None

    def test_missing_slice_info_returns_none(self, tmp_path):
        path = tmp_path / "noslice.3mf"
        with zipfile.ZipFile(path, "w") as zf:
            zf.writestr("3D/3dmodel.model", "<model/>")
        assert peek_plate_prediction_in_3mf(path) is None


class TestComputeFileMd5:
    def test_matches_hashlib(self, tmp_path):
        path = tmp_path / "file.bin"
        path.write_bytes(b"bambuddy" * 5000)
        assert compute_file_md5(path) == hashlib.md5(b"bambuddy" * 5000, usedforsecurity=False).hexdigest()


class TestVerify3mfCandidate:
    def test_md5_match_is_verified(self, tmp_path):
        path = _make_3mf(tmp_path, [{"index": 1, "prediction": 1421}])
        verdict, _ = verify_3mf_candidate(path, compute_file_md5(path), 1, None)
        assert verdict == "verified"

    def test_md5_match_is_case_insensitive(self, tmp_path):
        # Real payloads carry uppercase digests: "md5": "0879D528EC95...".
        path = _make_3mf(tmp_path, [{"index": 1, "prediction": 1421}])
        verdict, _ = verify_3mf_candidate(path, compute_file_md5(path).upper(), 1, None)
        assert verdict == "verified"

    def test_md5_mismatch_is_rejected_even_when_prediction_agrees(self, tmp_path):
        # md5 is authoritative — a same-name file whose duration happens to
        # be plausible must still be rejected when the command's md5 differs.
        path = _make_3mf(tmp_path, [{"index": 1, "prediction": 1421}])
        verdict, detail = verify_3mf_candidate(path, "0" * 32, 1, 1421)
        assert verdict == "rejected"
        assert "md5 mismatch" in detail

    def test_prediction_close_to_remaining_is_verified(self, tmp_path):
        path = _make_3mf(tmp_path, [{"index": 6, "prediction": 1421}])
        verdict, _ = verify_3mf_candidate(path, None, 6, 1500)
        assert verdict == "verified"

    def test_gross_prediction_mismatch_is_rejected(self, tmp_path):
        # The #2104 shape: stale May file predicts ~24 min while the printer
        # reports a multi-hour job.
        path = _make_3mf(tmp_path, [{"index": 6, "prediction": 1421}])
        verdict, _ = verify_3mf_candidate(path, None, 6, 4 * 3600)
        assert verdict == "rejected"

    def test_moderate_mismatch_is_not_rejected(self, tmp_path):
        # Printer remaining time can include calibration/prep overhead a
        # slicer prediction lacks — a false reject would discard the CORRECT
        # file, so <2x differences must pass.
        path = _make_3mf(tmp_path, [{"index": 1, "prediction": 1800}])
        verdict, _ = verify_3mf_candidate(path, None, 1, 3200)
        assert verdict == "verified"

    def test_large_ratio_but_small_absolute_diff_is_not_rejected(self, tmp_path):
        # 5 min vs 12 min is >2x but under the 15-minute absolute floor.
        path = _make_3mf(tmp_path, [{"index": 1, "prediction": 300}])
        verdict, _ = verify_3mf_candidate(path, None, 1, 720)
        assert verdict == "verified"

    def test_no_md5_and_no_remaining_time_is_unverified(self, tmp_path):
        path = _make_3mf(tmp_path, [{"index": 1, "prediction": 1421}])
        verdict, _ = verify_3mf_candidate(path, None, 1, None)
        assert verdict == "unverified"

    def test_no_md5_and_no_prediction_is_unverified(self, tmp_path):
        path = _make_3mf(tmp_path, [{"index": 1}])
        verdict, _ = verify_3mf_candidate(path, None, 1, 1500)
        assert verdict == "unverified"

    def test_empty_md5_falls_through_to_prediction(self, tmp_path):
        # Bambuddy's own dispatch sends "md5": "" — must not be treated as a
        # comparable digest.
        path = _make_3mf(tmp_path, [{"index": 1, "prediction": 1421}])
        verdict, _ = verify_3mf_candidate(path, None, 1, 1421)
        assert verdict == "verified"


class TestRequestTopicMd5Capture:
    """The md5 travels the same request-topic capture path as ams_mapping."""

    @pytest.fixture
    def mqtt_client(self):
        from backend.app.services.bambu_mqtt import BambuMQTTClient

        return BambuMQTTClient(
            ip_address="192.168.1.100",
            serial_number="TESTMD5",
            access_code="12345678",
        )

    def test_initializes_to_none(self, mqtt_client):
        assert mqtt_client._captured_print_md5 is None

    def test_project_file_md5_is_captured_lowercased(self, mqtt_client):
        mqtt_client._handle_request_message(
            {
                "print": {
                    "command": "project_file",
                    "md5": "0879D528EC9574D889A6707F52239808",
                    "url": "brtc://emmc/H2C_plate_6.gcode.3mf",
                }
            }
        )
        assert mqtt_client._captured_print_md5 == "0879d528ec9574d889a6707f52239808"

    def test_empty_md5_is_not_captured(self, mqtt_client):
        # Bambuddy's own print command deliberately sends "md5": "".
        mqtt_client._handle_request_message({"print": {"command": "project_file", "md5": ""}})
        assert mqtt_client._captured_print_md5 is None

    def test_non_project_file_command_is_ignored(self, mqtt_client):
        mqtt_client._handle_request_message({"print": {"command": "pause", "md5": "a" * 32}})
        assert mqtt_client._captured_print_md5 is None
