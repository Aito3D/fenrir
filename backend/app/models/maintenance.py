"""Maintenance tracking models."""

from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.core.database import Base


class MaintenanceType(Base):
    """Defines a type of maintenance task with default interval."""

    __tablename__ = "maintenance_types"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str | None] = mapped_column(Text)
    default_interval_hours: Mapped[float] = mapped_column(Float, default=100.0)
    # Interval type: "hours" (print hours) or "days" (calendar days)
    interval_type: Mapped[str] = mapped_column(String(20), default="hours")
    icon: Mapped[str | None] = mapped_column(String(50))  # Icon name for UI
    wiki_url: Mapped[str | None] = mapped_column(String(500))  # Documentation link
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)  # Pre-defined vs custom
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)  # Hidden/removed type
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    # Relationships
    printer_maintenance: Mapped[list["PrinterMaintenance"]] = relationship(
        back_populates="maintenance_type", cascade="all, delete-orphan"
    )


class PrinterMaintenance(Base):
    """Tracks maintenance status for a specific printer."""

    __tablename__ = "printer_maintenance"

    id: Mapped[int] = mapped_column(primary_key=True)
    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"))
    maintenance_type_id: Mapped[int] = mapped_column(ForeignKey("maintenance_types.id", ondelete="CASCADE"))

    # Custom interval for this printer (overrides default if set)
    custom_interval_hours: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Custom interval type for this printer (overrides default if set)
    custom_interval_type: Mapped[str | None] = mapped_column(String(20), nullable=True)

    # Tracking
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_performed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_performed_hours: Mapped[float] = mapped_column(Float, default=0.0)  # Hours at last reset

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    # Relationships
    printer: Mapped["Printer"] = relationship(back_populates="maintenance_items")
    maintenance_type: Mapped["MaintenanceType"] = relationship(back_populates="printer_maintenance")
    history: Mapped[list["MaintenanceHistory"]] = relationship(
        back_populates="printer_maintenance", cascade="all, delete-orphan"
    )


class MaintenanceHistory(Base):
    """Log of maintenance actions performed."""

    __tablename__ = "maintenance_history"

    id: Mapped[int] = mapped_column(primary_key=True)
    printer_maintenance_id: Mapped[int] = mapped_column(ForeignKey("printer_maintenance.id", ondelete="CASCADE"))
    performed_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    hours_at_maintenance: Mapped[float] = mapped_column(Float, default=0.0)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Relationships
    printer_maintenance: Mapped["PrinterMaintenance"] = relationship(back_populates="history")


class HourMachine(Base):
    """A machine whose lifetime hours are tracked on the Maintenance → Hours tab.

    Linked to its printer while that printer exists in Fenrir. Retired machines
    (sold, or deleted from Fenrir) keep their history with ``printer_id`` NULL.
    No ORM relationship to readings on purpose: SQLite does not enforce the FK
    cascade, so deletes remove readings explicitly.
    """

    __tablename__ = "hour_machines"

    id: Mapped[int] = mapped_column(primary_key=True)
    printer_id: Mapped[int | None] = mapped_column(
        ForeignKey("printers.id", ondelete="SET NULL"), nullable=True, unique=True
    )
    name: Mapped[str] = mapped_column(String(100))
    model: Mapped[str | None] = mapped_column(String(50), nullable=True)
    # Linked printer's serial: SQLite can reuse a deleted printer's id, and a
    # mismatch retires this row instead of attaching its history to a new printer.
    serial_number: Mapped[str | None] = mapped_column(String(50), nullable=True)
    retired: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class HourReading(Base):
    """One lifetime-hours value for a machine on a date: typed (manual) or Fenrir's counter (auto)."""

    __tablename__ = "hour_readings"
    __table_args__ = (UniqueConstraint("machine_id", "reading_date", "source", name="uq_hour_reading"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    machine_id: Mapped[int] = mapped_column(ForeignKey("hour_machines.id", ondelete="CASCADE"), index=True)
    reading_date: Mapped[date] = mapped_column(Date)
    hours: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String(10))  # "manual" | "auto"
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


# Import at end to avoid circular imports
from backend.app.models.printer import Printer  # noqa: E402
