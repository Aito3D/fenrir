"""The notification inbox: per-user rows, per-card watches, per-user preferences.

Fed by services/inbox.py from Aito events today; `family` leaves room for
printer kinds later without another table.
"""

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class Notification(Base):
    """One inbox row for one user. Generic on purpose: Aito kinds today,
    printer kinds later — `family` is what the bell filters on."""

    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(40))
    family: Mapped[str] = mapped_column(String(16))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(String(500))
    target_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    target_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    read_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class AitoWatch(Base):
    """A user following one card for the listed inbox kinds. Kept when the
    card is trashed (a restore keeps the watcher) or reaches Done."""

    __tablename__ = "aito_watches"
    __table_args__ = (UniqueConstraint("user_id", "project_id", name="uq_aito_watch_user_project"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[int] = mapped_column(Integer, index=True)
    kinds_json: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class UserInboxPreference(Base):
    """Which inbox kinds a user wants (and hears). No row = defaults."""

    __tablename__ = "user_inbox_preferences"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), unique=True)
    kinds_json: Mapped[list] = mapped_column(JSON, default=list)
    sound_kinds_json: Mapped[list] = mapped_column(JSON, default=list)
    auto_watch: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
