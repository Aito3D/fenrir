"""Filament profile trees (brand + material, root > machine > nozzle > colour); one preset per leaf."""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class FilamentTree(Base):
    __tablename__ = "filament_trees"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String, default="", nullable=False)
    brand: Mapped[str] = mapped_column(String, default="", nullable=False)
    material: Mapped[str] = mapped_column(String, default="", nullable=False)
    base_family: Mapped[str] = mapped_column(String, default="", nullable=False)
    # The original `inherits`, used when no Bambu base preset matches.
    fallback_inherits: Mapped[str] = mapped_column(String, default="", nullable=False)
    version: Mapped[str] = mapped_column(String, default="2.4.0.8", nullable=False)
    own_values: Mapped[str] = mapped_column(Text, default="{}", nullable=False)  # JSON object
    source_machine: Mapped[str] = mapped_column(String, default="", nullable=False)
    source_nozzle: Mapped[str] = mapped_column(String, default="", nullable=False)
    source_color_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    skip_02: Mapped[bool | None] = mapped_column(nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class FilamentTreeColor(Base):
    __tablename__ = "filament_tree_colors"

    id: Mapped[int] = mapped_column(primary_key=True)
    tree_id: Mapped[int] = mapped_column(ForeignKey("filament_trees.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String, default="", nullable=False)
    hex: Mapped[str] = mapped_column(String, default="", nullable=False)
    sort: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class FilamentTreeOverride(Base):
    """Values set at one node: nozzle "" = machine level, color_id 0 = not colour level."""

    __tablename__ = "filament_tree_overrides"
    __table_args__ = (UniqueConstraint("tree_id", "machine", "nozzle", "color_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    tree_id: Mapped[int] = mapped_column(ForeignKey("filament_trees.id", ondelete="CASCADE"), nullable=False)
    machine: Mapped[str] = mapped_column(String, default="", nullable=False)
    nozzle: Mapped[str] = mapped_column(String, default="", nullable=False)
    color_id: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    values: Mapped[str] = mapped_column(Text, default="{}", nullable=False)  # JSON object

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class FilamentTreeLeaf(Base):
    """Links a tree leaf to the generated filament_presets row."""

    __tablename__ = "filament_tree_leaves"
    __table_args__ = (UniqueConstraint("tree_id", "machine", "nozzle", "color_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    tree_id: Mapped[int] = mapped_column(ForeignKey("filament_trees.id", ondelete="CASCADE"), nullable=False)
    machine: Mapped[str] = mapped_column(String, default="", nullable=False)
    nozzle: Mapped[str] = mapped_column(String, default="", nullable=False)
    color_id: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    preset_id: Mapped[int] = mapped_column(
        ForeignKey("filament_presets.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    baseline_content: Mapped[str | None] = mapped_column(Text, nullable=True)  # what Orca holds, set by SYNC
    exported_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # last Export for Orca
    # the generated preset changed since the last export (exported_at stays: SYNC reads it for "missing")
    export_pending: Mapped[bool] = mapped_column(default=True, server_default="1", nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class FilamentTreeChange(Base):
    """One value change at one node (history + revert); old/new are JSON, NULL = no own value."""

    __tablename__ = "filament_tree_changes"

    id: Mapped[int] = mapped_column(primary_key=True)
    tree_id: Mapped[int] = mapped_column(
        ForeignKey("filament_trees.id", ondelete="CASCADE"), nullable=False, index=True
    )
    machine: Mapped[str] = mapped_column(String, default="", nullable=False)
    nozzle: Mapped[str] = mapped_column(String, default="", nullable=False)
    color_id: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    key: Mapped[str] = mapped_column(String, nullable=False)
    old_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    new_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    actor: Mapped[str] = mapped_column(String, default="", nullable=False)  # username; "" = sync / auth disabled

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class FilamentTreeSnapshot(Base):
    __tablename__ = "filament_tree_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String, default="migration", nullable=False)
    payload: Mapped[str] = mapped_column(Text, default="", nullable=False)  # JSON

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
