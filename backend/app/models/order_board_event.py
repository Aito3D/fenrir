from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String, Text, func
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class OrderBoardEvent(Base):
    """One thing that happened to a Zoho Books sales order, append-only.

    Mirrors AitoEvent: depth (story/detail/trace) is derived from ``kind`` by
    the registry in services/order_board_events.py, never stored. ``salesorder_id``
    is a Books id, not a foreign key: orders live in Zoho, not here.
    """

    __tablename__ = "order_board_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    salesorder_id: Mapped[str] = mapped_column(String(64))
    occurred_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    kind: Mapped[str] = mapped_column(String(48), index=True)
    # 'user' | 'client' | 'system'
    actor_class: Mapped[str] = mapped_column(String(16))
    actor_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # [{"field": "...", "from": ..., "to": ...}]
    changes: Mapped[list | None] = mapped_column(JSON, nullable=True)
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (Index("ix_order_board_events_so_occurred", "salesorder_id", "occurred_at", "id"),)
