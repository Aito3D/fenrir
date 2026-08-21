from datetime import datetime

from sqlalchemy import DateTime, Float, String, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class CalculatorFilament(Base):
    """Filament entry for the pricing calculator."""

    __tablename__ = "calculator_filaments"

    id: Mapped[int] = mapped_column(primary_key=True)
    # Display name derived server-side from brand + material; kept as a stored
    # column for ordering and for consumers that only need a label.
    name: Mapped[str] = mapped_column(String(100))
    brand: Mapped[str] = mapped_column(String(100), default="")
    material: Mapped[str] = mapped_column(String(100), default="")
    cost_per_kg: Mapped[float] = mapped_column(Float)
    # Derived output, never user input: always cost_per_kg * (1 + margin_pct/100).
    # Kept as a stored column because pricing.ts, archives and quotes all read it.
    sale_price_per_kg: Mapped[float] = mapped_column(Float)
    margin_pct: Mapped[float] = mapped_column(Float, default=50.0)
    difficulty_pct: Mapped[float] = mapped_column(Float, default=100.0)  # e.g. 150 = 1.5× for abrasive filaments
    # Zoho link. NULL zoho_item_id means a hand-entered filament that sync skips.
    zoho_item_id: Mapped[str | None] = mapped_column(String(50), nullable=True)
    # Denormalized so the panel can name the linked product without a Zoho call.
    zoho_item_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    zoho_sku: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # Divisor used to turn the per-spool dealer price into a per-kg cost. Stored
    # so a re-sync reproduces the same arithmetic even if the Zoho name changes.
    spool_weight_kg: Mapped[float | None] = mapped_column(Float, nullable=True)
    zoho_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class CalculatorPrinter(Base):
    """Printer entry for the pricing calculator."""

    __tablename__ = "calculator_printers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    purchase_price: Mapped[float] = mapped_column(Float)
    lifetime_years: Mapped[float] = mapped_column(Float)
    daily_usage_hours: Mapped[float] = mapped_column(Float)
    power_watts: Mapped[float] = mapped_column(Float)
    repair_rate_pct: Mapped[float] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class CalculatorDefaults(Base):
    """Global default parameters for the pricing calculator (single row)."""

    __tablename__ = "calculator_defaults"

    id: Mapped[int] = mapped_column(primary_key=True)
    electricity_tariff: Mapped[float] = mapped_column(Float, default=120.0)  # app currency/kWh
    labor_rate_per_hour: Mapped[float] = mapped_column(Float, default=3000.0)
    consumables_packaging_flat: Mapped[float] = mapped_column(Float, default=30.0)
    failure_rate_pct: Mapped[float] = mapped_column(Float, default=30.0)
    prototype_rate_pct: Mapped[float] = mapped_column(Float, default=30.0)
    ads_rate_pct: Mapped[float] = mapped_column(Float, default=5.0)
    filament_markup_pct: Mapped[float] = mapped_column(Float, default=5.0)
    global_markup_pct: Mapped[float] = mapped_column(Float, default=50.0)
    tax_pct: Mapped[float] = mapped_column(Float, default=13.0)  # TGC
    default_difficulty_pct: Mapped[float] = mapped_column(Float, default=100.0)  # prefill for new filaments
    default_margin_over_cost_pct: Mapped[float] = mapped_column(Float, default=50.0)  # prefill for new filaments
    stuff_markup_pct: Mapped[float] = mapped_column(Float, default=20.0)
    # One-time per-job base fee (quotation time, order handling) — a flat
    # amount added to every job's costs, amortized across the quantity.
    base_fee_flat: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
