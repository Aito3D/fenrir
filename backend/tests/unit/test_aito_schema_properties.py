"""A write schema has exactly two honest answers to any input: a validated
model, or ValidationError. Anything else — a TypeError from a validator, an
AttributeError on a None, a regex blowing up — reaches the route layer as a
500 instead of the documented 422.

These properties feed the schemas adversarial text (control characters,
unicode, very long strings, empty segments) rather than plausible payloads,
because the plausible ones are already covered by the route tests.
"""

from hypothesis import given, strategies as st
from pydantic import ValidationError

from backend.app.schemas.aito import (
    AitoProjectCreate,
    AitoProjectUpdate,
    AitoShippingInput,
    AitoTaskCreate,
)

# Deliberately nasty: NUL and control bytes, RTL marks, combining accents,
# very long runs. `st.text()` alone rarely produces these.
NASTY = st.one_of(
    st.text(max_size=80),
    st.text(alphabet=st.characters(codec="utf-8"), max_size=80),
    st.sampled_from(["", " ", "\x00", "\n\r\t", "‮", "é" * 20, "x" * 5000]),
)

MONEY = st.one_of(
    st.none(),
    st.floats(allow_nan=True, allow_infinity=True),
    st.integers(min_value=-(10**9), max_value=10**9),
)


def _accepts_or_rejects(model, payload: dict) -> None:
    """The only two acceptable outcomes."""
    try:
        model(**payload)
    except ValidationError:
        pass


@given(
    description=NASTY,
    client_id=NASTY,
    client_name=NASTY,
    client_phone=st.one_of(st.none(), NASTY),
    client_email=st.one_of(st.none(), NASTY),
)
def test_project_create_never_raises_anything_but_validation_error(
    description, client_id, client_name, client_phone, client_email
):
    _accepts_or_rejects(
        AitoProjectCreate,
        {
            "description": description,
            "client_id": client_id,
            "client_name": client_name,
            "client_phone": client_phone,
            "client_email": client_email,
        },
    )


@given(
    client_email=st.one_of(st.none(), NASTY),
    description=st.one_of(st.none(), NASTY),
    expected_version=st.one_of(st.none(), st.integers()),
    shipping_lta=st.one_of(st.none(), NASTY),
)
def test_project_update_never_raises_anything_but_validation_error(
    client_email, description, expected_version, shipping_lta
):
    _accepts_or_rejects(
        AitoProjectUpdate,
        {
            "client_email": client_email,
            "description": description,
            "expected_version": expected_version,
            "shipping_lta": shipping_lta,
        },
    )


@given(
    shipping_island=st.one_of(st.none(), NASTY),
    shipping_first_name=st.one_of(st.none(), NASTY),
    shipping_last_name=st.one_of(st.none(), NASTY),
    shipping_phone=st.one_of(st.none(), NASTY),
    shipping_price=MONEY,
)
def test_shipping_input_never_raises_anything_but_validation_error(
    shipping_island, shipping_first_name, shipping_last_name, shipping_phone, shipping_price
):
    _accepts_or_rejects(
        AitoShippingInput,
        {
            "shipping_island": shipping_island,
            "shipping_first_name": shipping_first_name,
            "shipping_last_name": shipping_last_name,
            "shipping_phone": shipping_phone,
            "shipping_price": shipping_price,
        },
    )


@given(title=st.one_of(st.none(), NASTY), scan_cost=MONEY, impression_cost=MONEY)
def test_task_create_never_raises_anything_but_validation_error(title, scan_cost, impression_cost):
    _accepts_or_rejects(
        AitoTaskCreate,
        {"title": title, "scan_cost": scan_cost, "impression_cost": impression_cost},
    )


@given(value=NASTY)
def test_a_validated_quote_id_is_always_url_path_safe(value: str):
    """quote_id is interpolated into a Books URL path, so anything that
    validates must carry no separator. See AitoProjectCreate.quote_id.

    Checked against AitoProjectCreate, not AitoProjectUpdate: quote_id is
    immutable after creation (set only by the create/import flow) and is not
    a field AitoProjectUpdate declares at all — AitoProjectUpdate inherits
    AitoShippingInput's ``extra="ignore"`` config, so
    ``AitoProjectUpdate(quote_id=value)`` silently drops the kwarg instead of
    validating it, which is a property-wrote-the-wrong-model bug, not a
    schema bug — the earlier version of this file's AitoProjectUpdate
    property asserted exactly that no-op by generating a quote_id kwarg,
    which is why this test targets AitoProjectCreate instead.
    """
    try:
        model = AitoProjectCreate(description="d", client_id="c", client_name="n", quote_id=value)
    except ValidationError:
        return
    if model.quote_id is not None:
        assert "/" not in model.quote_id
        assert ".." not in model.quote_id
