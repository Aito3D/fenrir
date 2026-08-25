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

T-129: this handler is app-global, so it also renders 422s for the
unauthenticated auth routes (login/setup/password-reset). Without redaction
it echoed a rejected password/token/secret back verbatim in ``input``. The
``TestRedactSecretInputs``/``TestIsSecretFieldLoc`` classes below pin the
redaction helpers directly; ``TestLoginRedactsPasswordEndToEnd`` pins the
same behaviour through the real ``/api/v1/auth/login`` route.
"""

import math

import pytest

from backend.app.main import _is_secret_field_loc, _redact_secret_inputs, _stringify_non_finite


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


class TestIsSecretFieldLoc:
    @pytest.mark.parametrize(
        "field",
        [
            "password",
            "current_password",
            "new_password",
            "admin_password",
            "smtp_password",
            "mqtt_password",
            "ldap_bind_password",
            "token",
            "access_token",
            "pre_auth_token",
            "setup_token",
            "auth_token",
            "zoho_refresh_token",
            "secret",
            "client_secret",
            "zoho_client_secret",
            "api_key",
            "openrouter_api_key",
            "access_code",
            "virtual_printer_access_code",
            # Case-insensitivity.
            "Password",
            "NEW_PASSWORD",
        ],
    )
    def test_matches_known_secret_field_names(self, field):
        assert _is_secret_field_loc(("body", field)) is True

    @pytest.mark.parametrize(
        "field",
        [
            "cost_per_kg",
            "username",
            "brand",
            "material",
            "margin_pct",
            "email",
            # Substrings of a secret suffix must NOT match on their own.
            "code",
            "key",
            # A field name that merely contains a secret word without the
            # ``_``-joined suffix shape must not match — over-redaction of a
            # clearly non-secret field is exactly what the substring warning
            # in the task was about.
            "passwordless_login_enabled",
            "tokenizer",
        ],
    )
    def test_does_not_match_unrelated_field_names(self, field):
        assert _is_secret_field_loc(("body", field)) is False

    def test_int_loc_element_does_not_match_or_crash(self):
        """``loc`` elements can be ints (list indices) — must not raise."""
        assert _is_secret_field_loc(("body", "items", 0, "password")) is True
        assert _is_secret_field_loc(("body", "items", 0)) is False

    def test_empty_loc_does_not_match(self):
        assert _is_secret_field_loc(()) is False


class TestRedactSecretInputs:
    def test_secret_field_input_is_replaced_with_placeholder(self):
        errors = [
            {
                "type": "string_too_long",
                "loc": ("body", "password"),
                "msg": "String should have at most 256 characters",
                "input": "S3cretPassword!S3cretPassword!",
                "ctx": {"max_length": 256},
            }
        ]
        [result] = _redact_secret_inputs(errors)
        assert result["input"] == "[redacted]"
        # Everything else survives byte-for-byte: a caller still learns
        # which field failed and why.
        assert result["type"] == "string_too_long"
        assert result["loc"] == ("body", "password")
        assert result["msg"] == "String should have at most 256 characters"
        assert result["ctx"] == {"max_length": 256}

    def test_non_secret_field_input_is_returned_verbatim(self):
        """Proves the redaction does not over-redact."""
        errors = [
            {
                "type": "greater_than",
                "loc": ("body", "cost_per_kg"),
                "msg": "Input should be greater than 0",
                "input": -5,
                "ctx": {"gt": 0},
            }
        ]
        [result] = _redact_secret_inputs(errors)
        assert result["input"] == -5

    def test_non_finite_value_in_secret_field_is_replaced_not_stringified(self):
        """A secret field never has a float type in this codebase today, but
        the composition must still be well-defined: redaction wins, so the
        raw ``inf`` never survives to be stringified — it is dropped along
        with the rest of the value."""
        errors = [{"type": "value_error", "loc": ("body", "token"), "msg": "bad", "input": float("inf")}]
        redacted = _redact_secret_inputs(errors)
        stringified = _stringify_non_finite(redacted)
        assert stringified[0]["input"] == "[redacted]"

    def test_non_finite_value_in_non_secret_field_still_stringified_after_redaction_pass(self):
        """T-071's fix must still work when composed after redaction."""
        errors = [{"type": "value_error", "loc": ("body", "cost_per_kg"), "msg": "bad", "input": float("inf")}]
        redacted = _redact_secret_inputs(errors)
        stringified = _stringify_non_finite(redacted)
        assert stringified[0]["input"] == "inf"

    def test_multiple_errors_only_secret_ones_redacted(self):
        errors = [
            {"type": "value_error", "loc": ("body", "password"), "msg": "bad", "input": "hunter2"},
            {"type": "value_error", "loc": ("body", "username"), "msg": "bad", "input": "a" * 200},
        ]
        pw_error, user_error = _redact_secret_inputs(errors)
        assert pw_error["input"] == "[redacted]"
        assert user_error["input"] == "a" * 200

    def test_error_without_input_key_is_left_alone(self):
        errors = [{"type": "missing", "loc": ("body", "password"), "msg": "Field required"}]
        [result] = _redact_secret_inputs(errors)
        assert "input" not in result


class TestLoginRedactsPasswordEndToEnd:
    """T-129, through the real handler + route (not just the helpers)."""

    @pytest.mark.asyncio
    async def test_long_password_rejected_with_placeholder_input(self, async_client):
        long_password = "S3cretPassword!" * 30  # well past LoginRequest's max_length=256
        resp = await async_client.post(
            "/api/v1/auth/login",
            json={"username": "someone", "password": long_password},
        )
        assert resp.status_code == 422
        body = resp.json()
        [error] = [e for e in body["detail"] if e["loc"][-1] == "password"]
        assert error["input"] == "[redacted]"
        assert long_password not in resp.text
        assert error["type"] == "string_too_long"
        assert error["msg"]

    @pytest.mark.asyncio
    async def test_long_username_rejected_verbatim(self, async_client):
        """Same route, a non-secret field — proves the fix is scoped."""
        long_username = "u" * 200  # LoginRequest caps username at max_length=150
        resp = await async_client.post(
            "/api/v1/auth/login",
            json={"username": long_username, "password": "irrelevant"},
        )
        assert resp.status_code == 422
        body = resp.json()
        [error] = [e for e in body["detail"] if e["loc"][-1] == "username"]
        assert error["input"] == long_username
