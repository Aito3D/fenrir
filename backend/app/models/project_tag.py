from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class ProjectTag(Base):
    """A project carries a tag from the global ``library_tags`` catalogue (spec §1.2).

    Sharing the catalogue is the point: one "drone" tag works on files and on
    projects. ``ondelete`` is declared for PostgreSQL; SQLite runs without
    foreign-key enforcement here, so project and tag deletes remove these rows
    explicitly (``delete_project``, ``library_tags.delete_tag``).
    """

    __tablename__ = "project_tags"

    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    tag_id: Mapped[int] = mapped_column(ForeignKey("library_tags.id", ondelete="CASCADE"), primary_key=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
