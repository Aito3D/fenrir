from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base
from backend.app.utils.local_time import utcnow_naive


class ProjectEvent(Base):
    """One thing that happened to a Fenrir project, append-only (spec §4.4): the
    project page's Historique. Mirrors ``AitoEvent``: ``kind`` is the same kind the
    linked orders' timelines get, ``subject_label`` and ``actor`` are snapshots.

    ``ondelete`` is declared for PostgreSQL; SQLite runs without foreign-key
    enforcement here, so ``delete_project`` removes these rows explicitly.
    """

    __tablename__ = "project_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(40))
    actor: Mapped[str | None] = mapped_column(String(100), nullable=True)
    subject_label: Mapped[str | None] = mapped_column(String(200), nullable=True)
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive, index=True)
