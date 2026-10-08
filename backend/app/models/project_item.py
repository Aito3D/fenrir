from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base

# Same keys as the Aito services, plus docs (spec §1.3). Order is display order.
SECTIONS: tuple[str, ...] = ("scan", "modelisation", "impression", "usinage", "docs")
# En cours / Validé / Obsolète (spec §1.4). Several revisions may be valide at
# once — a rework for one client never retires what another client received.
REVISION_STATUSES: tuple[str, ...] = ("wip", "valide", "obsolete")


class ProjectItem(Base):
    """One logical part or document inside a project section ("Support", "Mesh brut").

    ``last_revision_number`` is a high-water mark, not a count: numbers are
    never reused, so deleting R3 and uploading again gives R4.
    """

    __tablename__ = "project_items"
    __table_args__ = (UniqueConstraint("project_id", "section", "name_key", name="uq_project_items_section_name"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    section: Mapped[str] = mapped_column(String(16))
    name: Mapped[str] = mapped_column(String(255))
    name_key: Mapped[str] = mapped_column(String(255))
    last_revision_number: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    forked_from_revision_id: Mapped[int | None] = mapped_column(
        ForeignKey("project_revisions.id", ondelete="SET NULL", use_alter=True, name="fk_project_items_forked_from"),
        nullable=True,
    )
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class ProjectRevision(Base):
    """R{number} of an item: 1..n files (``library_files.revision_id``), a status,
    a note and an optional "dérivé de" link to any revision of the same project.

    The ``config_*`` / ``slicer_*`` / ``print_profile`` fields hold the slicer
    settings read from the first 3MF that landed in the revision (spec §5.1);
    written once, never updated.
    """

    __tablename__ = "project_revisions"
    __table_args__ = (UniqueConstraint("item_id", "number", name="uq_project_revisions_item_number"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("project_items.id", ondelete="CASCADE"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="wip", server_default="wip", index=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    derived_from_id: Mapped[int | None] = mapped_column(
        ForeignKey("project_revisions.id", ondelete="SET NULL"), nullable=True, index=True
    )
    config_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    config_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    slicer_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    slicer_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    print_profile: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Set when the revision came from a Re-trancher (spec §12.1); the name is
    # copied so it survives the pipeline's deletion. No FK: the ALTER migration
    # adds none, and fresh and migrated databases must match.
    pipeline_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    pipeline_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    status_changed_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    status_changed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
