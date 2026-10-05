from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class AitoTaskDelivery(Base):
    """Which project revisions a task delivered (spec §1.6, §4.3). Nothing locks:
    the record answers "client A got Support R3" while R4 is made for client B.
    A delivered revision counts as used (its files freeze, it can't be deleted)."""

    __tablename__ = "aito_task_deliveries"

    task_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    revision_id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
