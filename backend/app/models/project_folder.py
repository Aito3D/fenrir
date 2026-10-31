"""Project folders: the shelves of the Projects catalog (design 2026-10-31).

A folder has a name and an optional parent, to any depth (``Car › Wheel cap``); a
project sits in one folder or in none (``Project.folder_id``). Folders are not
sub-projects: ``Project.parent_id`` ties a master project to its parts, a folder
only groups projects for browsing. Deleting a folder moves its projects and
sub-folders up to its parent (``project_catalog.delete_folder``); the database
``CASCADE`` on ``parent_id`` is only the backstop for a raw delete.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class ProjectFolder(Base):
    __tablename__ = "project_folders"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("project_folders.id", ondelete="CASCADE"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
