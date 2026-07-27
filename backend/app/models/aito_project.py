from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class AitoProject(Base):
    """Aito production-board project (quote -> model -> print -> finish).

    Soft-delete only: ``status`` flips to 'deleted', rows are never removed,
    so the autoincrement ``id`` doubles as a stable visible project number.
    Client fields are a snapshot taken at attach time (Zoho outages never
    affect board rendering); legacy cards migrated from localStorage have
    NULL client fields.
    """

    __tablename__ = "aito_projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    description: Mapped[str] = mapped_column(Text)
    board_column: Mapped[str] = mapped_column(String(20), index=True)  # devis|model|print|finish
    position: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)  # active|deleted
    client_id: Mapped[str | None] = mapped_column(String(50), nullable=True)
    client_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    client_phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    client_email: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
