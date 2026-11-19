"""Each time an HMS fault appeared on a printer, for the printer's error history.

A row is added when the notification de-duplication in
``main._take_new_hms_faults`` first sees a fault that counts, and closed
(``cleared_at``, the last time it was seen) when that tracking forgets it.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class HmsFaultOccurrence(Base):
    __tablename__ = "hms_fault_occurrences"
    __table_args__ = (Index("ix_hms_fault_occurrences_printer_seen", "printer_id", "first_seen"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    printer_id: Mapped[int] = mapped_column(Integer, ForeignKey("printers.id", ondelete="CASCADE"), nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    severity: Mapped[int] = mapped_column(Integer, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    first_seen: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    cleared_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
