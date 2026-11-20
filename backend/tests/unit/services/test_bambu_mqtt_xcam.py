"""Tests for BambuMQTTClient xcam options, calibration and cfg-bitmask parsing."""

import json
from unittest.mock import MagicMock, patch

import pytest

from backend.app.services.bambu_mqtt import BambuMQTTClient


@pytest.fixture
def client():
    c = BambuMQTTClient(ip_address="192.168.1.100", serial_number="TEST123", access_code="12345678")
    c._client = MagicMock()
    c.state.connected = True
    return c


def _published(c):
    return json.loads(c._client.publish.call_args[0][1])


def _cfg(spag, pile, clump, air):
    """Each arg is (sens_bits, enabled)."""
    cfg = 0
    for start, (sens, en) in zip((5, 8, 11, 14), (spag, pile, clump, air), strict=True):
        cfg |= sens << start | int(en) << (start + 2)
    return cfg


class TestSetXcamOption:
    def test_disconnected_returns_false(self, client):
        client.state.connected = False
        assert client.set_xcam_option("spaghetti_detector", True) is False
        client._client.publish.assert_not_called()

    def test_spaghetti_payload_and_linked_sensitivity(self, client):
        with patch("backend.app.services.bambu_mqtt.time.time", return_value=100.0):
            assert client.set_xcam_option("spaghetti_detector", True, print_halt=False, sensitivity="high") is True
        assert _published(client) == {
            "xcam": {
                "command": "xcam_control_set",
                "sequence_id": "1",
                "module_name": "spaghetti_detector",
                "control": True,
                "enable": True,
                "print_halt": True,
                "halt_print_sensitivity": "high",
            }
        }
        po = client.state.print_options
        assert po.spaghetti_detector is True
        assert po.print_halt is False
        assert po.halt_print_sensitivity == "high"
        assert po.pileup_sensitivity == "high"
        assert set(client._xcam_hold_start) == {"spaghetti_detector", "halt_print_sensitivity", "pileup_sensitivity"}

    def test_never_halt_omits_sensitivity(self, client):
        client.set_xcam_option("spaghetti_detector", False, sensitivity="never_halt")
        xcam = _published(client)["xcam"]
        assert "halt_print_sensitivity" not in xcam
        assert xcam["print_halt"] is True
        assert "halt_print_sensitivity" not in client._xcam_hold_start

    def test_clump_detector_sets_state_and_hold(self, client):
        client.set_xcam_option("clump_detector", True, sensitivity="low")
        xcam = _published(client)["xcam"]
        assert xcam["module_name"] == "clump_detector"
        assert xcam["halt_print_sensitivity"] == "low"
        po = client.state.print_options
        assert po.nozzle_clumping_detector is True
        assert po.nozzle_clumping_sensitivity == "low"
        assert "nozzle_clumping_sensitivity" in client._xcam_hold_start

    def test_auto_recovery_routes_to_print_option(self, client):
        assert client.set_xcam_option("auto_recovery_step_loss", True) is True
        assert _published(client) == {"print": {"command": "print_option", "sequence_id": "1", "auto_recovery": True}}
        assert client.state.print_options.auto_recovery_step_loss is True
        assert "print_option_auto_recovery" in client._xcam_hold_start


class TestStartCalibration:
    @pytest.mark.parametrize(
        ("flag", "option"),
        [
            ("bed_leveling", 2),
            ("vibration", 4),
            ("motor_noise", 8),
            ("nozzle_offset", 16),
            ("high_temp_heatbed", 32),
        ],
    )
    def test_each_flag_bit(self, client, flag, option):
        assert client.start_calibration(**{flag: True}) is True
        assert _published(client) == {"print": {"command": "calibration", "sequence_id": "1", "option": option}}

    def test_flags_combine(self, client):
        client.start_calibration(bed_leveling=True, high_temp_heatbed=True)
        assert _published(client)["print"]["option"] == 34

    def test_no_flags_returns_false(self, client):
        assert client.start_calibration() is False
        client._client.publish.assert_not_called()

    def test_disconnected_returns_false(self, client):
        client.state.connected = False
        assert client.start_calibration(vibration=True) is False


class TestXcamCfgParsing:
    def test_decodes_each_detector(self, client):
        cfg = _cfg((2, True), (1, True), (0, False), (3, True))
        client._parse_xcam_data({"cfg": cfg})
        po = client.state.print_options
        assert (po.spaghetti_detector, po.halt_print_sensitivity) == (True, "high")
        assert (po.pileup_detector, po.pileup_sensitivity) == (True, "medium")
        assert (po.nozzle_clumping_detector, po.nozzle_clumping_sensitivity) == (False, "low")
        # unknown sens bits (3) fall back to medium
        assert (po.airprint_detector, po.airprint_sensitivity) == (True, "medium")

    def test_non_dict_ignored(self, client):
        client._parse_xcam_data(None)

    def test_hold_window_ignores_then_accepts(self, client):
        client.state.print_options.spaghetti_detector = False
        client.state.print_options.halt_print_sensitivity = "medium"
        client._xcam_hold_start["spaghetti_detector"] = 100.0
        client._xcam_hold_start["halt_print_sensitivity"] = 100.0
        cfg = _cfg((2, True), (0, False), (0, False), (0, False))

        with patch("backend.app.services.bambu_mqtt.time.time", return_value=101.0):
            client._parse_xcam_data({"cfg": cfg})
        po = client.state.print_options
        assert po.spaghetti_detector is False
        assert po.halt_print_sensitivity == "medium"
        assert "spaghetti_detector" in client._xcam_hold_start

        with patch("backend.app.services.bambu_mqtt.time.time", return_value=100.0 + client._xcam_hold_time + 0.5):
            client._parse_xcam_data({"cfg": cfg})
        assert po.spaghetti_detector is True
        assert po.halt_print_sensitivity == "high"
        assert "spaghetti_detector" not in client._xcam_hold_start
        assert "halt_print_sensitivity" not in client._xcam_hold_start

    def test_sensitivity_holds_for_pileup_clump_airprint(self, client):
        for key in ("pileup_sensitivity", "nozzle_clumping_sensitivity", "airprint_sensitivity"):
            client._xcam_hold_start[key] = 100.0
        cfg = _cfg((0, False), (2, False), (2, False), (2, False))
        po = client.state.print_options

        with patch("backend.app.services.bambu_mqtt.time.time", return_value=101.0):
            client._parse_xcam_data({"cfg": cfg})
        assert (po.pileup_sensitivity, po.nozzle_clumping_sensitivity, po.airprint_sensitivity) == (
            "medium",
            "medium",
            "medium",
        )

        with patch("backend.app.services.bambu_mqtt.time.time", return_value=200.0):
            client._parse_xcam_data({"cfg": cfg})
        assert (po.pileup_sensitivity, po.nozzle_clumping_sensitivity, po.airprint_sensitivity) == ("high",) * 3
        assert not client._xcam_hold_start
