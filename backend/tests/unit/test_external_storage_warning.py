"""The printer card says when its jobs cannot reach the card (2026-10-03).

H2C05, H2S03 and X2D01 kept their sent files on eMMC only, and every Bambu
Studio print on them archived as a bare name until the option was switched on
at the printer. H2C04 and X2D01 have no card in the slot at all, which makes the
option a no-op. Neither state was visible anywhere but the connection
diagnostic, which nobody runs until something is already wrong.
"""

from types import SimpleNamespace

import pytest

from backend.app.services.print_storage import external_storage_warning

pytestmark = pytest.mark.unit


def _state(**overrides):
    values = {
        "connected": True,
        "store_to_sdcard": True,
        "home_flag_reported": True,
        "sdcard": True,
        "sdcard_reported": True,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class TestExternalStorageWarning:
    def test_all_good(self):
        assert external_storage_warning(_state(), "H2C") is None

    def test_the_option_is_off(self):
        assert external_storage_warning(_state(store_to_sdcard=False), "H2C") == "store_off"

    def test_the_slot_is_empty(self):
        """H2C04 / X2D01: option on, nothing to store on."""
        assert external_storage_warning(_state(sdcard=False), "X2D") == "no_media"

    def test_an_empty_slot_outranks_the_option(self):
        """Inserting a card is the step to take first; switching the option on
        alone would change nothing."""
        assert external_storage_warning(_state(sdcard=False, store_to_sdcard=False), "H2S") == "no_media"

    def test_a_printer_that_never_mentions_its_card_is_not_flagged(self):
        """`sdcard` defaults to False; the default is not an empty slot."""
        assert external_storage_warning(_state(sdcard=False, sdcard_reported=False), "H2C") is None

    def test_no_home_flag_yet_is_not_an_option_that_is_off(self):
        """`store_to_sdcard` defaults to False until the first full status."""
        assert external_storage_warning(_state(store_to_sdcard=False, home_flag_reported=False), "H2C") is None

    def test_a_disconnected_printer_says_nothing(self):
        assert external_storage_warning(_state(connected=False, store_to_sdcard=False), "H2C") is None

    def test_no_state_says_nothing(self):
        assert external_storage_warning(None, "H2C") is None

    @pytest.mark.parametrize("model", ["A1", "A1 Mini", "N2S"])
    def test_a_model_without_a_slot_is_never_flagged(self, model):
        assert external_storage_warning(_state(store_to_sdcard=False, sdcard=False), model) is None

    def test_a_model_without_the_toggle_is_never_told_to_flip_it(self):
        """P1S: the option cannot be switched on (#2524), so the warning would
        be permanent and unactionable."""
        assert external_storage_warning(_state(store_to_sdcard=False), "P1S") is None

    def test_a_model_without_the_toggle_still_hears_about_an_empty_slot(self):
        assert external_storage_warning(_state(sdcard=False), "P1S") == "no_media"


class TestHomeFlagReported:
    def _client(self):
        from backend.app.services.bambu_mqtt import BambuMQTTClient

        return BambuMQTTClient(ip_address="192.168.1.100", serial_number="TEST", access_code="12345678", model="H2C")

    def test_starts_unreported(self):
        assert self._client().state.home_flag_reported is False

    def test_set_once_the_printer_sends_it(self):
        client = self._client()
        client._update_state({"home_flag": 0xC0675C98})
        assert client.state.home_flag_reported is True
        assert client.state.store_to_sdcard is True


class TestStatusBroadcast:
    def test_the_websocket_payload_carries_the_warning(self):
        """The card updates live from printer_status pushes, not only on load."""
        from backend.app.services.bambu_mqtt import PrinterState
        from backend.app.services.printer_manager import printer_state_to_dict

        state = PrinterState()
        state.connected = True
        state.sdcard = False
        state.sdcard_reported = True

        assert printer_state_to_dict(state, 1, "X2D")["external_storage_warning"] == "no_media"
