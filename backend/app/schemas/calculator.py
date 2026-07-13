from datetime import datetime

from pydantic import BaseModel, Field


class CalculatorFilamentBase(BaseModel):
    """Base schema for calculator filaments."""

    brand: str = Field(default="", max_length=100, description="Filament brand (optional)")
    material: str = Field(..., min_length=1, max_length=100, description="Filament material, e.g. PLA or PETG-CF")
    cost_per_kg: float = Field(..., gt=0, description="Purchase cost per kg (app currency)")
    sale_price_per_kg: float = Field(..., gt=0, description="Sale price per kg charged for material (app currency)")
    difficulty_pct: float = Field(
        default=100.0, ge=100, le=1000, description="Difficulty multiplier for this filament (100 = no surcharge)"
    )


class CalculatorFilamentCreate(CalculatorFilamentBase):
    """Schema for creating a calculator filament."""

    pass


class CalculatorFilamentUpdate(BaseModel):
    """Schema for updating a calculator filament (all fields optional)."""

    brand: str | None = Field(default=None, max_length=100)
    material: str | None = Field(default=None, min_length=1, max_length=100)
    cost_per_kg: float | None = Field(default=None, gt=0)
    sale_price_per_kg: float | None = Field(default=None, gt=0)
    difficulty_pct: float | None = Field(default=None, ge=100, le=1000)


class CalculatorFilamentResponse(CalculatorFilamentBase):
    """Response schema for calculator filaments."""

    id: int
    name: str  # derived display label: "<brand> <material>"
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CalculatorPrinterBase(BaseModel):
    """Base schema for calculator printers."""

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

    pass


class CalculatorPrinterUpdate(BaseModel):
    """Schema for updating a calculator printer (all fields optional)."""

    name: str | None = Field(default=None, min_length=1, max_length=100)
    purchase_price: float | None = Field(default=None, gt=0)
    lifetime_years: float | None = Field(default=None, gt=0)
    daily_usage_hours: float | None = Field(default=None, gt=0, le=24)
    power_watts: float | None = Field(default=None, gt=0)
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

    electricity_tariff: float | None = Field(default=None, ge=0)
    labor_rate_per_hour: float | None = Field(default=None, ge=0)
    consumables_packaging_flat: float | None = Field(default=None, ge=0)
    failure_rate_pct: float | None = Field(default=None, ge=0, le=1000)
    prototype_rate_pct: float | None = Field(default=None, ge=0, le=1000)
    ads_rate_pct: float | None = Field(default=None, ge=0, le=1000)
    filament_markup_pct: float | None = Field(default=None, ge=0, le=1000)
    global_markup_pct: float | None = Field(default=None, ge=0, le=1000)
    tax_pct: float | None = Field(default=None, ge=0, le=100)
    default_difficulty_pct: float | None = Field(default=None, ge=100, le=1000)
    default_margin_over_cost_pct: float | None = Field(default=None, ge=0, le=1000)
    stuff_markup_pct: float | None = Field(default=None, ge=0, le=1000)


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
    updated_at: datetime

    model_config = {"from_attributes": True}
