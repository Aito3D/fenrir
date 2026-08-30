from datetime import datetime
from enum import IntEnum

from pydantic import BaseModel, ConfigDict, Field, model_validator

# Applied to every schema that accepts a user-supplied money/rate float: without
# it, ``float("inf")`` satisfies every ``gt``/``ge`` bound (inf > 0 is True) and
# is stored as-is, then serialized back as JSON ``null`` for a field the
# response model declares non-optional. NaN is already rejected by those same
# bounds (nan > 0 is False), but this makes the rejection explicit rather than
# incidental.
_FINITE_ONLY = ConfigDict(allow_inf_nan=False)

# A generous but finite ceiling on unbounded money/rate fields. ``gt=0`` alone
# does not stop overflow: a finite-but-astronomical input (e.g. 1e308) can
# still overflow to inf downstream (see derive_sale_price), so these fields
# also need an upper bound, not just a lower one.
_MONEY_CEILING = 100_000_000.0


class CalculatorFilamentBase(BaseModel):
    """Base schema for calculator filaments.

    ``sale_price_per_kg`` is deliberately absent: it is derived server-side from
    ``cost_per_kg`` and ``margin_pct`` and only ever appears in responses.

    Deliberately NOT given ``_FINITE_ONLY``/a ceiling on ``cost_per_kg``, and
    deliberately NOT given the ``ge=0, le=1000`` bounds on ``margin_pct``
    either: this class is also the parent of ``CalculatorFilamentResponse``,
    which reads back whatever is already in the database. Tightening either
    field here would turn a pre-existing out-of-range row (e.g. a hand-typed
    ``sale_price_per_kg`` below ``cost_per_kg``, backfilled to a negative
    margin, or one more than ~11x cost, backfilled above 1000) into a 500 for
    the ENTIRE list on every ``GET`` instead of the real, if unusual, value it
    renders today; the write-side schemas below carry the new constraints
    instead, so only new writes are rejected.
    """

    brand: str = Field(default="", max_length=100, description="Filament brand (optional)")
    material: str = Field(..., min_length=1, max_length=100, description="Filament material, e.g. PLA or PETG-CF")
    cost_per_kg: float = Field(..., gt=0, description="Purchase cost per kg (app currency)")
    margin_pct: float = Field(default=50.0, description="Margin over cost, percent")
    difficulty_pct: float = Field(
        default=100.0, ge=100, le=1000, description="Difficulty multiplier for this filament (100 = no surcharge)"
    )
    zoho_item_id: str | None = Field(default=None, max_length=50, description="Linked Zoho item id")
    zoho_item_name: str | None = Field(default=None, max_length=255, description="Linked Zoho item name")
    zoho_sku: str | None = Field(default=None, max_length=100, description="Linked Zoho item SKU")
    spool_weight_kg: float | None = Field(
        default=None, gt=0, le=100, description="Spool weight used to derive cost per kg from the dealer price"
    )


class CalculatorFilamentCreate(CalculatorFilamentBase):
    """Schema for creating a calculator filament."""

    model_config = _FINITE_ONLY

    cost_per_kg: float = Field(..., gt=0, le=_MONEY_CEILING, description="Purchase cost per kg (app currency)")
    margin_pct: float = Field(default=50.0, ge=0, le=1000, description="Margin over cost, percent")
    spool_weight_kg: float | None = Field(
        default=None,
        ge=0.001,
        le=100,
        description="Spool weight used to derive cost per kg from the dealer price",
    )


class CalculatorFilamentUpdate(BaseModel):
    """Schema for updating a calculator filament (all fields optional).

    The Zoho fields and ``spool_weight_kg`` accept an explicit ``null`` — that
    is how the UI unlinks a filament from its Zoho product.

    ``zoho_synced_at`` is deliberately NOT writable here: only a sync that
    actually applied a dealer price may stamp it. The patch route clears it by
    itself whenever ``zoho_item_id`` changes, so no caller has to remember to.
    """

    model_config = _FINITE_ONLY

    brand: str | None = Field(default=None, max_length=100)
    material: str | None = Field(default=None, min_length=1, max_length=100)
    cost_per_kg: float | None = Field(default=None, gt=0, le=_MONEY_CEILING)
    margin_pct: float | None = Field(default=None, ge=0, le=1000)
    difficulty_pct: float | None = Field(default=None, ge=100, le=1000)
    zoho_item_id: str | None = Field(default=None, max_length=50)
    zoho_item_name: str | None = Field(default=None, max_length=255)
    zoho_sku: str | None = Field(default=None, max_length=100)
    spool_weight_kg: float | None = Field(default=None, ge=0.001, le=100)


class CalculatorFilamentResponse(CalculatorFilamentBase):
    """Response schema for calculator filaments."""

    id: int
    name: str  # derived display label: "<brand> <material>"
    sale_price_per_kg: float  # derived: cost_per_kg * (1 + margin_pct / 100)
    zoho_synced_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CalculatorPrinterBase(BaseModel):
    """Base schema for calculator printers.

    Deliberately NOT given ``_FINITE_ONLY``/ceilings on its money fields: see
    the equivalent note on ``CalculatorFilamentBase`` — this class also backs
    ``CalculatorPrinterResponse``, and tightening it here would turn a
    pre-existing out-of-range row into a 500 on every ``GET``.
    """

    name: str = Field(..., min_length=1, max_length=100, description="Printer name")
    purchase_price: float = Field(..., gt=0, description="Purchase price (app currency)")
    lifetime_years: float = Field(..., gt=0, description="Expected lifetime in years")
    daily_usage_hours: float = Field(..., gt=0, le=24, description="Average daily usage in hours")
    power_watts: float = Field(..., gt=0, description="Power draw in watts")
    repair_rate_pct: float = Field(
        ..., ge=0, le=100, description="Expected repair cost over lifetime as % of purchase price"
    )


class CalculatorPrinterCreate(CalculatorPrinterBase):
    """Schema for creating a calculator printer."""

    model_config = _FINITE_ONLY

    purchase_price: float = Field(..., gt=0, le=_MONEY_CEILING, description="Purchase price (app currency)")
    power_watts: float = Field(..., gt=0, le=_MONEY_CEILING, description="Power draw in watts")


class CalculatorPrinterUpdate(BaseModel):
    """Schema for updating a calculator printer (all fields optional)."""

    model_config = _FINITE_ONLY

    name: str | None = Field(default=None, min_length=1, max_length=100)
    purchase_price: float | None = Field(default=None, gt=0, le=_MONEY_CEILING)
    lifetime_years: float | None = Field(default=None, gt=0)
    daily_usage_hours: float | None = Field(default=None, gt=0, le=24)
    power_watts: float | None = Field(default=None, gt=0, le=_MONEY_CEILING)
    repair_rate_pct: float | None = Field(default=None, ge=0, le=100)


class CalculatorPrinterResponse(CalculatorPrinterBase):
    """Response schema for calculator printers.

    Derived per-hour values (lifetime hours, depreciation, repairs) are
    computed client-side by the pricing engine (frontend ``utils/pricing.ts``)
    — the single source of truth for calculator math.
    """

    id: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CalculatorDefaultsUpdate(BaseModel):
    """Schema for updating calculator defaults (all fields optional)."""

    model_config = _FINITE_ONLY

    electricity_tariff: float | None = Field(default=None, ge=0, le=_MONEY_CEILING)
    labor_rate_per_hour: float | None = Field(default=None, ge=0, le=_MONEY_CEILING)
    consumables_packaging_flat: float | None = Field(default=None, ge=0, le=_MONEY_CEILING)
    failure_rate_pct: float | None = Field(default=None, ge=0, le=1000)
    prototype_rate_pct: float | None = Field(default=None, ge=0, le=1000)
    ads_rate_pct: float | None = Field(default=None, ge=0, le=1000)
    filament_markup_pct: float | None = Field(default=None, ge=0, le=1000)
    global_markup_pct: float | None = Field(default=None, ge=0, le=1000)
    tax_pct: float | None = Field(default=None, ge=0, le=100)
    default_difficulty_pct: float | None = Field(default=None, ge=100, le=1000)
    default_margin_over_cost_pct: float | None = Field(default=None, ge=0, le=1000)
    stuff_markup_pct: float | None = Field(default=None, ge=0, le=1000)
    base_fee_flat: float | None = Field(default=None, ge=0, le=_MONEY_CEILING)
    margin_min_mult: float | None = Field(default=None, ge=1, le=100)
    margin_max_mult: float | None = Field(default=None, ge=1, le=100)
    margin_k: float | None = Field(default=None, gt=0, le=_MONEY_CEILING)
    qty_min_factor: float | None = Field(default=None, gt=0, le=1)
    qty_k: float | None = Field(default=None, gt=0, le=1_000_000)
    min_task_price: float | None = Field(default=None, ge=0, le=_MONEY_CEILING)

    @model_validator(mode="after")
    def _margin_pair_ordered(self) -> "CalculatorDefaultsUpdate":
        if (
            self.margin_min_mult is not None
            and self.margin_max_mult is not None
            and self.margin_max_mult < self.margin_min_mult
        ):
            raise ValueError("margin_max_mult must be >= margin_min_mult")
        return self


class CalculatorDefaultsResponse(BaseModel):
    """Response schema for calculator defaults."""

    id: int
    electricity_tariff: float
    labor_rate_per_hour: float
    consumables_packaging_flat: float
    failure_rate_pct: float
    prototype_rate_pct: float
    ads_rate_pct: float
    filament_markup_pct: float
    global_markup_pct: float
    tax_pct: float
    default_difficulty_pct: float
    default_margin_over_cost_pct: float
    stuff_markup_pct: float
    base_fee_flat: float
    margin_min_mult: float
    margin_max_mult: float
    margin_k: float
    qty_min_factor: float
    qty_k: float
    min_task_price: float
    updated_at: datetime

    model_config = {"from_attributes": True}


# --- Insights (measured "reality check" figures) ---


class InsightsWindowDays(IntEnum):
    """Allowed lookback windows for GET /calculator/insights (T-128).

    Fixed to a handful of values, not an arbitrary ``int`` range, so a
    per-day sweep can't difference consecutive windows to recover
    individual print-log rows that ``MIN_SAMPLE`` suppresses within any
    single window. ``IntEnum`` (not ``Literal[30, 90, 365]``) so a query
    string like ``"30"`` still coerces the same way a plain ``int`` field
    always did.
    """

    THIRTY = 30
    NINETY = 90
    ONE_YEAR = 365


class FailureRateEntry(BaseModel):
    """Measured failure rate for one printer or one material.

    ``rate_pct`` is ``None`` when a cross-window subtraction against the next
    narrower offered window (T-027) would recover fewer than ``MIN_SAMPLE``
    individual print-log rows for this group — ``sample`` is still reported.
    """

    printer_id: int | None = None
    printer_name: str | None = None
    material: str | None = None
    rate_pct: float | None = None
    sample: int


class FailureInsights(BaseModel):
    overall_pct: float | None
    sample: int
    by_printer: list[FailureRateEntry]
    by_material: list[FailureRateEntry]


class TimeAccuracyEntry(BaseModel):
    """Measured slicer-estimate accuracy for one printer.

    ``accuracy_pct`` is ``None`` under the same T-027 cross-window guard as
    ``FailureRateEntry.rate_pct`` — ``sample`` is still reported.
    """

    printer_id: int
    printer_name: str
    accuracy_pct: float | None = None
    sample: int


class TimeAccuracyInsights(BaseModel):
    overall_pct: float | None
    sample: int
    by_printer: list[TimeAccuracyEntry]


class SpoolCostEntry(BaseModel):
    material: str
    avg_cost_per_kg: float
    sample: int


class SpoolCostBrandEntry(BaseModel):
    brand: str
    material: str
    avg_cost_per_kg: float
    sample: int


class PowerDrawEntry(BaseModel):
    """Energy-weighted average watts measured for one printer."""

    printer_id: int
    printer_name: str
    avg_watts: float
    sample: int


class DailyUsageEntry(BaseModel):
    """Measured usage-hours/day for one printer over the observed window."""

    printer_id: int
    printer_name: str
    hours_per_day: float
    observed_days: int
    sample: int


class CalculatorInsightsResponse(BaseModel):
    """Measured values the calculator can offer in place of its assumptions."""

    window_days: int
    failure: FailureInsights
    energy_cost_per_kwh: float
    spool_cost_by_material: list[SpoolCostEntry]
    spool_cost_by_brand: list[SpoolCostBrandEntry]
    time_accuracy: TimeAccuracyInsights
    power_by_printer: list[PowerDrawEntry]
    usage_by_printer: list[DailyUsageEntry]


class ZohoFilamentProduct(BaseModel):
    """A Zoho filament item offered in the add-filament search."""

    item_id: str
    name: str
    sku: str
    brand: str
    material: str
    colour: str
    spool_weight_kg: float
    weight_inferred: bool = Field(description="True when the item name carried no weight and 1 kg was assumed")
    dealer_price: float
    cost_per_kg: float
    has_price: bool = Field(description="False when the Zoho dealer price is 0; cost must not be filled from it")

    model_config = {"from_attributes": True}


class CalculatorFilamentSyncRequest(BaseModel):
    """One chunk of the Zoho price sync.

    Keyset paging by id, not offset: an offset would silently skip a row
    when a linked filament is deleted mid-run (the chunk boundary shifts
    under the caller), and would still report success.
    """

    after_id: int = Field(
        default=0, ge=0, description="Sync filaments with id greater than this; 0 starts from the beginning"
    )
    limit: int = Field(default=25, ge=1, le=200, description="Chunk size")


class CalculatorFilamentSyncResponse(BaseModel):
    """Outcome of one sync chunk. The five outcome counts sum to ``processed``."""

    processed: int = Field(description="Filaments examined in this chunk")
    total: int = Field(description="Linked filaments overall, for progress display")
    updated: int = Field(description="Cost per kg changed")
    unchanged: int = Field(description="Zoho price matched the stored cost")
    skipped_no_price: int = Field(description="Zoho dealer price was 0; nothing written")
    missing: int = Field(description="Linked item no longer in the Zoho catalogue; link and price kept")
    unpriced: int = Field(
        description=(
            "Filament has no stored spool weight and the Zoho item name carries none either "
            "(product.weight_inferred); dividing by the assumed 1 kg default was refused, so price kept"
        )
    )
    next_after_id: int | None = Field(
        default=None, description="Pass as after_id for the next chunk; null when finished"
    )
