"""One row per open of a card's public tracking page — a card and a moment,
nothing that identifies a person or a device. Read by the Stats pipeline
widget's "Suivi client" block."""

from datetime import datetime

from sqlalchemy import DateTime, Index, Integer
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class AitoTrackingView(Base):
    __tablename__ = "aito_tracking_views"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(Integer, nullable=False)
    viewed_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    __table_args__ = (
        Index("ix_aito_tracking_views_viewed_at", "viewed_at"),
        Index("ix_aito_tracking_views_project_id", "project_id"),
    )
