"""Notes pinned on a revision's part in the part viewer (2026-10-31).

A pin is a short text at a point of the model, in printer millimetres (X right, Y back, Z up),
saved with the revision so whoever opens the part next sees it where it was left. Deleting the
revision drops its pins (``CASCADE``).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class ProjectRevisionPin(Base):
    __tablename__ = "project_revision_pins"

    id: Mapped[int] = mapped_column(primary_key=True)
    revision_id: Mapped[int] = mapped_column(ForeignKey("project_revisions.id", ondelete="CASCADE"), index=True)
    x: Mapped[float] = mapped_column(Float)
    y: Mapped[float] = mapped_column(Float)
    z: Mapped[float] = mapped_column(Float)
    text: Mapped[str] = mapped_column(String(500))
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
