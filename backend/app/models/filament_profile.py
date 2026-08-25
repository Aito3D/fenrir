"""Models for user filament presets and the Bambu Studio base preset index."""

from datetime import datetime

from sqlalchemy import DateTime, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class FilamentPreset(Base):
    """A user-authored filament slicer preset, storing the full slicer JSON blob."""

    __tablename__ = "filament_presets"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String, default="", nullable=False)
    brand: Mapped[str] = mapped_column(String, default="", nullable=False)
    material: Mapped[str] = mapped_column(String, default="", nullable=False)
    color: Mapped[str] = mapped_column(String, default="", nullable=False)
    color_hex: Mapped[str] = mapped_column(String, default="", nullable=False)
    filename: Mapped[str] = mapped_column(String, default="", nullable=False)
    content: Mapped[str] = mapped_column(Text, default="", nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class BaseFilamentPreset(Base):
    """Index entry for a Bambu Studio bundled base filament preset."""

    __tablename__ = "filament_base_presets"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String, default="", nullable=False)
    inherits: Mapped[str] = mapped_column(String, default="", nullable=False)
    brand: Mapped[str] = mapped_column(String, default="", nullable=False)
    material: Mapped[str] = mapped_column(String, default="", nullable=False)
    color: Mapped[str] = mapped_column(String, default="", nullable=False)
    color_hex: Mapped[str] = mapped_column(String, default="", nullable=False)
    filename: Mapped[str] = mapped_column(String, default="", nullable=False, index=True)
