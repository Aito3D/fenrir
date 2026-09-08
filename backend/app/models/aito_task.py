from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class AitoTask(Base):
    """One task of an Aito project, with four optional services.

    The services are a fixed, known set, so they are columns rather than an EAV
    child table. A NULL cost means the service is disabled; 0 stays meaningful
    as "free".

    ``impression_printer_id`` and ``impression_filament_id`` are deliberately
    NOT foreign keys: deleting a filament from the calculator must not cascade
    into a historical quote. ``impression_cost`` is already frozen, so a
    dangling reference costs only the ability to re-edit that line.
    """

    __tablename__ = "aito_tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(Integer, index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # The legacy task-level description column still exists in the DB; its data was
    # copied onto the first enabled service by _migrate_aito_task_descriptions and it
    # is no longer mapped.
    scan_cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    modelisation_cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    usinage_cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Per-service quantity and percent discount, mirroring the impression pair
    # below. NULL quantity reads as 1 and NULL discount as none — so rows
    # predating this migration need no backfill. `<service>_cost` stays the
    # PRE-discount total (unit x quantity); the discount is applied by readers
    # (aito_board_rules.net_cost), never baked in, so the two never
    # double-count.
    scan_quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    modelisation_quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    usinage_quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    scan_discount_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    modelisation_discount_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    usinage_discount_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    impression_printer_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    impression_filament_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    impression_weight_g: Mapped[float | None] = mapped_column(Float, nullable=True)
    impression_time_min: Mapped[int | None] = mapped_column(Integer, nullable=True)
    impression_quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    impression_color: Mapped[str | None] = mapped_column(String(100), nullable=True)
    impression_cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Percent (Books item-level "10.00%" lines), NOT baked into
    # impression_cost — that stays the pre-discount rate x quantity, so the
    # two never double-count. None = no discount.
    impression_discount_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Optional free text per service ("subtask"), emitted on the quote as an
    # `Info:` row on that service's line. Replaces the task-level description:
    # the title lives only in the quote's header, prose lives on the service
    # it describes. NULL (never "") means no Info row at all.
    scan_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    modelisation_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    impression_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    usinage_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # One flag per service, mirroring the four cost columns above. A step
    # exists when its cost is not NULL; ticking it is what advances the
    # project's board column (see services/aito_board_rules.py). NOT NULL with
    # a server default so rows predating this migration read False, not None.
    scan_done: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    modelisation_done: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    impression_done: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    usinage_done: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
