"""``gcode_snippets`` validation on the settings write path (#1516).

The field carries per-printer-model start/end G-code that the auto-print
pipeline injects verbatim (see ``app/models/virtual_printer.py`` and
``app/core/database.py``), so the shape has to be pinned: a bare JSON object
keyed by printer model. ``AppSettingsUpdate`` is the only place this is
enforced — ``AppSettings`` (the GET response model) has no validator for it,
by the same "don't 500 the whole settings page over one bad row" reasoning
documented next to ``validate_docker_compose_dir``.
"""

import pytest
from pydantic import ValidationError

from backend.app.schemas.settings import AppSettings, AppSettingsUpdate


class TestGcodeSnippetsValidation:
    def test_none_is_untouched(self):
        """None means "not part of this PATCH"."""
        assert AppSettingsUpdate().gcode_snippets is None

    def test_empty_string_passes_through(self):
        assert AppSettingsUpdate(gcode_snippets="").gcode_snippets == ""

    def test_invalid_json_is_rejected(self):
        with pytest.raises(ValidationError, match="gcode_snippets must be valid JSON or empty"):
            AppSettingsUpdate(gcode_snippets="{not json")

    def test_json_list_is_rejected(self):
        """A JSON array parses fine but isn't keyed by model, so it is refused."""
        with pytest.raises(ValidationError, match="gcode_snippets must be a JSON object keyed by printer model"):
            AppSettingsUpdate(gcode_snippets='["start_gcode", "end_gcode"]')

    def test_json_scalar_is_rejected(self):
        with pytest.raises(ValidationError, match="gcode_snippets must be a JSON object keyed by printer model"):
            AppSettingsUpdate(gcode_snippets='"just a string"')

    def test_valid_dict_passes_through_unchanged(self):
        """The validator does not re-serialize or normalize: the original
        string survives byte-for-byte, whitespace and all."""
        raw = '{"X1C": {"start_gcode": "G28", "end_gcode": "G1 Z10"}}'
        assert AppSettingsUpdate(gcode_snippets=raw).gcode_snippets == raw

    def test_valid_dict_with_incidental_whitespace_is_not_reformatted(self):
        raw = '{ "A1"  :  { "start_gcode" : "" } }'
        assert AppSettingsUpdate(gcode_snippets=raw).gcode_snippets == raw

    def test_empty_dict_is_valid(self):
        assert AppSettingsUpdate(gcode_snippets="{}").gcode_snippets == "{}"


class TestGcodeSnippetsNotValidatedOnResponseModel:
    """``AppSettings`` (the GET/read model) carries the same field but no
    validator, so a malformed row already on disk can still be read back
    instead of 500ing the settings page."""

    def test_read_model_accepts_arbitrary_non_json_string(self):
        assert AppSettings(gcode_snippets="{not json").gcode_snippets == "{not json"

    def test_read_model_accepts_a_json_list(self):
        assert AppSettings(gcode_snippets="[1, 2, 3]").gcode_snippets == "[1, 2, 3]"

    def test_read_model_default_is_empty_string(self):
        assert AppSettings().gcode_snippets == ""
