from datetime import datetime
from typing import Literal

from sqlalchemy import Boolean, DateTime, Float, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base

CardState = Literal["progress", "finished"]


class KanbanCard(Base):
    """Kanban card for the Todo board."""

    __tablename__ = "kanban_cards"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    quote_id: Mapped[str] = mapped_column(String(50))
    quote_name: Mapped[str] = mapped_column(String(100))
    client_id: Mapped[str] = mapped_column(String(50))
    client_name: Mapped[str] = mapped_column(String(200))
    client_phone: Mapped[str] = mapped_column(String(50), default="")
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    is_approved: Mapped[bool] = mapped_column(Boolean, default=False)
    file_id: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)
    archive_id: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)
    column: Mapped[str] = mapped_column(String(20), default="backlog")
    state: Mapped[str] = mapped_column(String(20), default="progress")
    sort_order: Mapped[float] = mapped_column(Float, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
