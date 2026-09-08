"""A write schema has exactly two honest answers to any input: a validated
model, or ValidationError. Anything else — a TypeError from a validator, an
AttributeError on a None, a regex blowing up — reaches the route layer as a
500 instead of the documented 422.

These properties feed the schemas adversarial text and numbers (control
characters, unicode, very long strings, empty segments, inf/nan, huge and
negative magnitudes) rather than plausible payloads, because the plausible
ones are already covered by the route tests.

Only the models a route actually accepts as a request body are covered here
(see `grep -n ": Calculator" backend/app/api/routes/calculator.py`):
CalculatorFilamentCreate, CalculatorFilamentUpdate,
CalculatorFilamentSyncRequest, CalculatorPrinterCreate,
CalculatorPrinterUpdate, CalculatorDefaultsUpdate. The `*Base` classes
(CalculatorFilamentBase, CalculatorPrinterBase) and every `*Response` model
are deliberately excluded: a route never builds those from untrusted input —
they are either abstract parents of response models, or response models
themselves, populated from the database/ORM, not from a request body — so
they are not attack surface for this property.
"""

from hypothesis import given, strategies as st
from pydantic import ValidationError

from backend.app.schemas.calculator import (
    CalculatorDefaultsUpdate,
    CalculatorFilamentCreate,
    CalculatorFilamentSyncRequest,
    CalculatorFilamentUpdate,
    CalculatorPrinterCreate,
    CalculatorPrinterUpdate,
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

# For the two int fields on CalculatorFilamentSyncRequest: neither is
# Optional, so both always get a value from the strategy, but the value can
# still be the wrong type/shape entirely (a string, a float, an out-of-range
# magnitude) to make sure Pydantic's own coercion never crashes instead of
# rejecting.
DIRTY_INT = st.one_of(
    st.integers(min_value=-(10**9), max_value=10**9),
    st.floats(allow_nan=True, allow_infinity=True),
    st.sampled_from(["", "abc", "1e5", "-1", "99999999999999999999", None, "\x00"]),
)


def _accepts_or_rejects(model, payload: dict) -> None:
    """The only two acceptable outcomes."""
    try:
        model(**payload)
    except ValidationError:
        pass


@given(
    brand=NASTY,
    material=NASTY,
    cost_per_kg=MONEY,
    margin_pct=MONEY,
    difficulty_pct=MONEY,
    zoho_item_id=st.one_of(st.none(), NASTY),
    zoho_item_name=st.one_of(st.none(), NASTY),
    zoho_sku=st.one_of(st.none(), NASTY),
    spool_weight_kg=MONEY,
)
def test_filament_create_never_raises_anything_but_validation_error(
    brand, material, cost_per_kg, margin_pct, difficulty_pct, zoho_item_id, zoho_item_name, zoho_sku, spool_weight_kg
):
    _accepts_or_rejects(
        CalculatorFilamentCreate,
        {
            "brand": brand,
            "material": material,
            "cost_per_kg": cost_per_kg,
            "margin_pct": margin_pct,
            "difficulty_pct": difficulty_pct,
            "zoho_item_id": zoho_item_id,
            "zoho_item_name": zoho_item_name,
            "zoho_sku": zoho_sku,
            "spool_weight_kg": spool_weight_kg,
        },
    )


@given(
    brand=st.one_of(st.none(), NASTY),
    material=st.one_of(st.none(), NASTY),
    cost_per_kg=MONEY,
    margin_pct=MONEY,
    difficulty_pct=MONEY,
    zoho_item_id=st.one_of(st.none(), NASTY),
    spool_weight_kg=MONEY,
)
def test_filament_update_never_raises_anything_but_validation_error(
    brand, material, cost_per_kg, margin_pct, difficulty_pct, zoho_item_id, spool_weight_kg
):
    _accepts_or_rejects(
        CalculatorFilamentUpdate,
        {
            "brand": brand,
            "material": material,
            "cost_per_kg": cost_per_kg,
            "margin_pct": margin_pct,
            "difficulty_pct": difficulty_pct,
            "zoho_item_id": zoho_item_id,
            "spool_weight_kg": spool_weight_kg,
        },
    )


@given(after_id=DIRTY_INT, limit=DIRTY_INT)
def test_filament_sync_request_never_raises_anything_but_validation_error(after_id, limit):
    _accepts_or_rejects(CalculatorFilamentSyncRequest, {"after_id": after_id, "limit": limit})


@given(
    name=NASTY,
    purchase_price=MONEY,
    lifetime_years=MONEY,
    daily_usage_hours=MONEY,
    power_watts=MONEY,
    repair_rate_pct=MONEY,
)
def test_printer_create_never_raises_anything_but_validation_error(
    name, purchase_price, lifetime_years, daily_usage_hours, power_watts, repair_rate_pct
):
    _accepts_or_rejects(
        CalculatorPrinterCreate,
        {
            "name": name,
            "purchase_price": purchase_price,
            "lifetime_years": lifetime_years,
            "daily_usage_hours": daily_usage_hours,
            "power_watts": power_watts,
            "repair_rate_pct": repair_rate_pct,
        },
    )


@given(
    name=st.one_of(st.none(), NASTY),
    purchase_price=MONEY,
    lifetime_years=MONEY,
    daily_usage_hours=MONEY,
    power_watts=MONEY,
    repair_rate_pct=MONEY,
)
def test_printer_update_never_raises_anything_but_validation_error(
    name, purchase_price, lifetime_years, daily_usage_hours, power_watts, repair_rate_pct
):
    _accepts_or_rejects(
        CalculatorPrinterUpdate,
        {
            "name": name,
            "purchase_price": purchase_price,
            "lifetime_years": lifetime_years,
            "daily_usage_hours": daily_usage_hours,
            "power_watts": power_watts,
            "repair_rate_pct": repair_rate_pct,
        },
    )


@given(
    electricity_tariff=MONEY,
    labor_rate_per_hour=MONEY,
    failure_rate_pct=MONEY,
    tax_pct=MONEY,
    margin_min_mult=MONEY,
    margin_max_mult=MONEY,
    margin_k=MONEY,
    qty_min_factor=MONEY,
    qty_k=MONEY,
    min_task_price=MONEY,
    rush_pct=MONEY,
)
def test_defaults_update_never_raises_anything_but_validation_error(
    electricity_tariff,
    labor_rate_per_hour,
    failure_rate_pct,
    tax_pct,
    margin_min_mult,
    margin_max_mult,
    margin_k,
    qty_min_factor,
    qty_k,
    min_task_price,
    rush_pct,
):
    """Covers a representative subset of CalculatorDefaultsUpdate's ~18
    optional float fields, including the two (`margin_min_mult`,
    `margin_max_mult`) the `_margin_pair_ordered` model_validator compares
    against each other — the one piece of cross-field logic on this model
    that could plausibly raise something other than ValueError/ValidationError
    if it mishandled a non-comparable value (e.g. NaN)."""
    _accepts_or_rejects(
        CalculatorDefaultsUpdate,
        {
            "electricity_tariff": electricity_tariff,
            "labor_rate_per_hour": labor_rate_per_hour,
            "failure_rate_pct": failure_rate_pct,
            "tax_pct": tax_pct,
            "margin_min_mult": margin_min_mult,
            "margin_max_mult": margin_max_mult,
            "margin_k": margin_k,
            "qty_min_factor": qty_min_factor,
            "qty_k": qty_k,
            "min_task_price": min_task_price,
            "rush_pct": rush_pct,
        },
    )
