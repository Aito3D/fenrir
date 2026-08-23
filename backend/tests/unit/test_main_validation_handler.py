"""T-093: the RequestValidationError handler must emit strict JSON.

FastAPI's default handler crashes when a validation error's ``input`` is a
non-finite float (T-071), because Starlette's ``JSONResponse`` renders with
``allow_nan=False``. The fix (``allow_nan=True``) stopped the crash but
started emitting the Python-only ``Infinity``/``-Infinity``/``NaN``
literals, which are not valid JSON (RFC 8259) and break strict parsers such
as the frontend's ``response.json()``.

These tests exercise ``_stringify_non_finite`` directly, including the case
the integration-level calculator tests can't reach: a non-finite float
nested arbitrarily deep inside a list/dict ``input`` value.
"""

import math

from backend.app.main import _stringify_non_finite


class TestStringifyNonFinite:
    def test_finite_float_is_untouched(self):
        assert _stringify_non_finite(3731.0) == 3731.0

    def test_int_str_bool_none_are_untouched(self):
        assert _stringify_non_finite(5) == 5
        assert _stringify_non_finite("cost_per_kg") == "cost_per_kg"
        assert _stringify_non_finite(True) is True
        assert _stringify_non_finite(None) is None

    def test_top_level_infinity_becomes_string(self):
        assert _stringify_non_finite(float("inf")) == "inf"
        assert _stringify_non_finite(float("-inf")) == "-inf"
        assert _stringify_non_finite(float("nan")) == "nan"

    def test_non_finite_nested_in_dict(self):
        result = _stringify_non_finite({"cost_per_kg": float("inf"), "brand": "SUNLU"})
        assert result == {"cost_per_kg": "inf", "brand": "SUNLU"}

    def test_non_finite_nested_in_list(self):
        result = _stringify_non_finite([1.0, float("inf"), 3.0])
        assert result == [1.0, "inf", 3.0]

    def test_non_finite_nested_arbitrarily_deep(self):
        """A list inside a dict inside a list — the shape a composite
        validator's rejected ``input`` could plausibly take."""
        payload = {
            "items": [
                {"cost_per_kg": 10.0, "tags": ["a", float("-inf"), "b"]},
                {"cost_per_kg": float("nan"), "tags": []},
            ]
        }
        result = _stringify_non_finite(payload)
        assert result == {
            "items": [
                {"cost_per_kg": 10.0, "tags": ["a", "-inf", "b"]},
                {"cost_per_kg": "nan", "tags": []},
            ]
        }

    def test_tuple_recurses_and_preserves_type(self):
        result = _stringify_non_finite((1.0, float("inf")))
        assert result == (1.0, "inf")
        assert isinstance(result, tuple)

    def test_stringified_values_are_the_expected_python_str_form(self):
        # These are the exact strings json.dumps(allow_nan=False) will quote.
        assert str(float("inf")) == "inf"
        assert str(float("-inf")) == "-inf"
        assert str(float("nan")) == "nan"
        for value in (float("inf"), float("-inf"), float("nan")):
            stringified = _stringify_non_finite(value)
            assert stringified == str(value)

    def test_math_isnan_isinf_agree_with_stringify_decision(self):
        # Sanity check the predicate itself, not just the observable output.
        assert math.isinf(float("inf"))
        assert math.isnan(float("nan"))
        assert not math.isinf(1.0)
        assert not math.isnan(1.0)
