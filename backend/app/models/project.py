from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, event, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.core.database import Base


class Project(Base):
    """Project to group related prints (e.g., 'Voron Build' with multiple parts)."""

    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    # Projects as a PDM (spec §1.1). ``code`` is the permanent, visible
    # identifier (P-0042); nullable only because SQLite cannot add a NOT NULL
    # column to existing rows — the startup migration fills every row and the
    # before_insert listener below fills every new one. ``storage_dir`` is the
    # folder name under the projects space, fixed at creation.
    code: Mapped[str | None] = mapped_column(String(16), nullable=True, unique=True, index=True)
    storage_dir: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Phase 5: set once the project's legacy printing files (linked File Manager
    # files) were moved into its tree; NULL = still a migration candidate.
    legacy_migrated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    color: Mapped[str | None] = mapped_column(String(20), nullable=True)  # Hex color for UI
    status: Mapped[str] = mapped_column(String(20), default="active")  # active, completed, archived

    # External link rendered as a clickable icon next to the project name (#1155).
    url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    # Filename of the cover photo inside the project's attachments dir; serves as
    # the card's hero image when set (#1155). The file lives alongside other
    # attachments but is tracked here separately so users can manage one without
    # the other.
    cover_image_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    target_count: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )  # Optional target number of prints (plates)
    target_parts_count: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )  # Optional target number of parts/objects
    # Optional copies-per-file target (#1897): every printable file in the
    # project's linked folders should be printed this many times ("sets").
    target_sets: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Phase 2: Rich text notes (HTML from WYSIWYG editor)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Phase 3: File attachments stored as JSON array
    # Format: [{"filename": "x.stl", "original_name": "part.stl", "size": 1234, "uploaded_at": "..."}]
    attachments: Mapped[list | None] = mapped_column(JSON, nullable=True)

    # Phase 4: Tags (comma-separated)
    tags: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Phase 5: Due dates and priority
    due_date: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    priority: Mapped[str] = mapped_column(String(20), default="normal")  # low, normal, high, urgent

    # Phase 6: Budget tracking
    budget: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Phase 8: Templates
    is_template: Mapped[bool] = mapped_column(Boolean, default=False)
    template_source_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Phase 10: Sub-projects (hierarchical)
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"), nullable=True)

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    # Relationships
    archives: Mapped[list["PrintArchive"]] = relationship(back_populates="project")
    queue_items: Mapped[list["PrintQueueItem"]] = relationship(back_populates="project")
    children: Mapped[list["Project"]] = relationship(
        "Project",
        back_populates="parent",
        foreign_keys="Project.parent_id",
    )
    parent: Mapped["Project | None"] = relationship(
        "Project",
        back_populates="children",
        remote_side="Project.id",
        foreign_keys="Project.parent_id",
    )
    bom_items: Mapped[list["ProjectBOMItem"]] = relationship(back_populates="project", cascade="all, delete-orphan")


from backend.app.models.archive import PrintArchive  # noqa: E402
from backend.app.models.print_queue import PrintQueueItem  # noqa: E402
from backend.app.models.project_bom import ProjectBOMItem  # noqa: E402


@event.listens_for(Project, "before_insert")
def _assign_project_code(_mapper, connection, target: Project) -> None:
    """Every new project gets its code and folder name, whatever route created it."""
    from backend.app.services.project_codes import allocate_code_number, format_project_code
    from backend.app.services.project_storage import storage_dir_name

    if not target.code:
        target.code = format_project_code(allocate_code_number(connection))
    if not target.storage_dir:
        target.storage_dir = storage_dir_name(target.code, target.name)
