"""Pins the client contact fields of the client-bearing Aito schemas.

AitoProjectCreate, AitoClientTransfer and AitoProjectUpdate share the same
optional client_email/client_phone checks; AitoClientEdit has a non-optional
variant on email/phone. These tests freeze the accept/reject outcomes, the
exact error shape, and the field + JSON-schema order of every one of them, so
moving the validators into a shared mixin cannot change any of it.
"""

import hashlib
import json

import pytest
from pydantic import ValidationError

from backend.app.schemas.aito import (
    AitoClientEdit,
    AitoClientTransfer,
    AitoProjectCreate,
    AitoProjectUpdate,
    is_plausible_phone,
)

_REQUIRED = {
    AitoProjectCreate: {"description": "d", "client_id": "c1", "client_name": "Client"},
    AitoClientTransfer: {"client_id": "c1", "client_name": "Client"},
    AitoProjectUpdate: {},
}
_OPTIONAL_MODELS = list(_REQUIRED)

_EMAIL_OK = [
    (None, None),
    ("", ""),
    ("   ", ""),
    ("a@b.co", "a@b.co"),
    ("  a@b.co  ", "a@b.co"),
    ("x" * 190 + "@b.co", "x" * 190 + "@b.co"),
]
_EMAIL_BAD = ["x", "a@b", "a@b.c", "a b@c.de", " no-at.example.com "]

_PHONE_OK = [
    (None, None),
    ("", ""),
    ("   ", ""),
    ("+689 87 00 00 02", "+689 87 00 00 02"),
    (" 0687654321 ", "0687654321"),
    ("(689) 87.00/00-02", "(689) 87.00/00-02"),
]
_PHONE_BAD = ["abc", "12345", "+689-87a000002", "#123456"]


def _model_id(model):
    return model.__name__


@pytest.mark.parametrize("model", _OPTIONAL_MODELS, ids=_model_id)
@pytest.mark.parametrize(("value", "expected"), _EMAIL_OK)
def test_optional_client_email_accepts(model, value, expected):
    assert model(**_REQUIRED[model], client_email=value).client_email == expected


@pytest.mark.parametrize("model", _OPTIONAL_MODELS, ids=_model_id)
@pytest.mark.parametrize("value", _EMAIL_BAD)
def test_optional_client_email_rejects(model, value):
    with pytest.raises(ValidationError) as exc:
        model(**_REQUIRED[model], client_email=value)
    errors = exc.value.errors(include_url=False)
    assert [(e["type"], e["loc"], e["msg"]) for e in errors] == [
        ("value_error", ("client_email",), "Value error, Enter a valid email address")
    ]


@pytest.mark.parametrize("model", _OPTIONAL_MODELS, ids=_model_id)
@pytest.mark.parametrize(("value", "expected"), _PHONE_OK)
def test_optional_client_phone_accepts(model, value, expected):
    assert model(**_REQUIRED[model], client_phone=value).client_phone == expected


@pytest.mark.parametrize("model", _OPTIONAL_MODELS, ids=_model_id)
@pytest.mark.parametrize("value", _PHONE_BAD)
def test_optional_client_phone_rejects(model, value):
    with pytest.raises(ValidationError) as exc:
        model(**_REQUIRED[model], client_phone=value)
    errors = exc.value.errors(include_url=False)
    assert [(e["type"], e["loc"], e["msg"]) for e in errors] == [
        ("value_error", ("client_phone",), "Value error, Enter a valid phone number")
    ]


@pytest.mark.parametrize("model", _OPTIONAL_MODELS, ids=_model_id)
def test_optional_client_contact_over_cap_is_a_length_error(model):
    with pytest.raises(ValidationError) as exc:
        model(**_REQUIRED[model], client_phone="1" * 51, client_email="x" * 196 + "@b.co")
    errors = exc.value.errors(include_url=False)
    assert [(e["type"], e["loc"], e["msg"]) for e in errors] == [
        ("string_too_long", ("client_phone",), "String should have at most 50 characters"),
        ("string_too_long", ("client_email",), "String should have at most 200 characters"),
    ]


@pytest.mark.parametrize("model", _OPTIONAL_MODELS, ids=_model_id)
def test_optional_client_contact_both_invalid_reports_phone_then_email(model):
    with pytest.raises(ValidationError) as exc:
        model(**_REQUIRED[model], client_phone="abc", client_email="x")
    assert [e["loc"] for e in exc.value.errors(include_url=False)] == [("client_phone",), ("client_email",)]


@pytest.mark.parametrize("model", _OPTIONAL_MODELS, ids=_model_id)
@pytest.mark.parametrize("field", ["client_email", "client_phone"])
def test_optional_client_contact_rejects_non_string(model, field):
    with pytest.raises(ValidationError) as exc:
        model(**_REQUIRED[model], **{field: 42})
    errors = exc.value.errors(include_url=False)
    assert [(e["type"], e["loc"]) for e in errors] == [("string_type", (field,))]


@pytest.mark.parametrize(("value", "expected"), [(v, e) for v, e in _EMAIL_OK if v is not None])
def test_client_edit_email_accepts(value, expected):
    assert AitoClientEdit(email=value).email == expected


@pytest.mark.parametrize("value", _EMAIL_BAD)
def test_client_edit_email_rejects(value):
    with pytest.raises(ValidationError) as exc:
        AitoClientEdit(email=value)
    errors = exc.value.errors(include_url=False)
    assert [(e["type"], e["loc"], e["msg"]) for e in errors] == [
        ("value_error", ("email",), "Value error, Enter a valid email address")
    ]


@pytest.mark.parametrize(("value", "expected"), [(v, e) for v, e in _PHONE_OK if v is not None])
def test_client_edit_phone_accepts(value, expected):
    assert AitoClientEdit(phone=value).phone == expected


@pytest.mark.parametrize("value", _PHONE_BAD)
def test_client_edit_phone_rejects(value):
    with pytest.raises(ValidationError) as exc:
        AitoClientEdit(phone=value)
    errors = exc.value.errors(include_url=False)
    assert [(e["type"], e["loc"], e["msg"]) for e in errors] == [
        ("value_error", ("phone",), "Value error, Enter a valid phone number")
    ]


def test_client_edit_null_email_and_phone_are_type_errors():
    with pytest.raises(ValidationError) as exc:
        AitoClientEdit(email=None, phone=None)
    errors = exc.value.errors(include_url=False)
    assert [(e["type"], e["loc"]) for e in errors] == [("string_type", ("email",)), ("string_type", ("phone",))]


_SOCIAL = ["client_social_network", "client_social_handle"]
_SHIPPING = [
    "shipping_island",
    "shipping_first_name",
    "shipping_last_name",
    "shipping_phone",
    "shipping_price",
]
_CLIENT = [
    "client_id",
    "client_name",
    "client_phone",
    "client_email",
    "client_is_company",
    "client_contact_person_id",
]

_FIELD_ORDER = {
    AitoProjectCreate: _SOCIAL
    + _SHIPPING
    + ["description"]
    + _CLIENT
    + [
        "client_contact_name",
        "quote_id",
        "quote_number",
        "quote_date",
        "quote_total",
        "quote_url",
        "quote_salesperson",
        "due_date",
        "quote_status",
        "regenerate_description",
        "tasks",
    ],
    AitoClientTransfer: _CLIENT,
    # T-154: no client_id/client_name — ownership moves through transfer-client.
    AitoProjectUpdate: _SOCIAL
    + _SHIPPING
    + ["description"]
    + [f for f in _CLIENT if f not in ("client_id", "client_name")]
    + ["client_contact_name", "shipping_lta", "expected_version"],
    AitoClientEdit: _SOCIAL
    + [
        "company_name",
        "first_name",
        "last_name",
        "email",
        "phone",
        "phone_field",
        "expected_version",
        "client_contact_person_id",
        "client_contact_name",
    ],
}

# sha256 of json.dumps(Model.model_json_schema()) — key order included, so a
# reordered property, a changed cap or a new description all change the hash.
_SCHEMA_SHA256 = {
    AitoProjectCreate: "91e4d68599ffe724fcc1ce41652013cb4b33125c7197cbf729b882d90f7d8d0f",
    AitoClientTransfer: "617ea1452080ca6ff6ec41043506990d57a4f0848ebfb591712317dcaccfb366",
    AitoProjectUpdate: "b068b6760da4381ebbbccd6ec60960b2fc914680d35ac24e82d2b9e4ac688ece",
    AitoClientEdit: "f40a0c00a70ea75f79109794c93b2eb3889c0373d6d73f03468fabc8d7d7ba8b",
}


@pytest.mark.parametrize("model", list(_FIELD_ORDER), ids=_model_id)
def test_model_field_order_is_pinned(model):
    assert list(model.model_fields) == _FIELD_ORDER[model]


@pytest.mark.parametrize("model", list(_SCHEMA_SHA256), ids=_model_id)
def test_model_json_schema_is_pinned(model):
    schema = model.model_json_schema()
    assert list(schema["properties"]) == _FIELD_ORDER[model]
    assert hashlib.sha256(json.dumps(schema).encode()).hexdigest() == _SCHEMA_SHA256[model]


@pytest.mark.parametrize(
    ("value", "expected"),
    [("", True), ("   ", True), ("+689 87 00 00 02", True), ("12345", False), ("abcdef", False)],
)
def test_is_plausible_phone_mirrors_the_phone_check(value, expected):
    # Blank is plausible here: the predicate leaves blanks to its caller,
    # while _check_phone short-circuits them before ever calling it.
    assert is_plausible_phone(value) is expected


@pytest.mark.parametrize("url", ["http://books.zoho.com/x", "javascript:alert(1)", "/relative"])
def test_project_create_quote_url_must_be_https(url):
    with pytest.raises(ValidationError) as exc:
        AitoProjectCreate(**_REQUIRED[AitoProjectCreate], quote_url=url)
    errors = exc.value.errors(include_url=False)
    assert [(e["type"], e["loc"], e["msg"]) for e in errors] == [
        ("value_error", ("quote_url",), "Value error, quote_url must use the https scheme")
    ]
