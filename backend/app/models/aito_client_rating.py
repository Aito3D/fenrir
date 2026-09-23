"""One row per Zoho customer: their payment rating as last computed.

A cache, not a ledger — keyed on the customer rather than the card because a
rating is a fact about the customer (the drawer needs it for a contact with
no card yet, and five cards of one customer must not carry five copies).
Written only by services/aito_client_rating.read_client_rating; rows are
never deleted, so a customer gone from Books keeps a harmless stale row.
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class AitoClientRating(Base):
    __tablename__ = "aito_client_ratings"

    customer_id: Mapped[str] = mapped_column(String(50), primary_key=True)
    tier: Mapped[str] = mapped_column(String(10), nullable=False)  # good|medium|bad|new
    reason: Mapped[str] = mapped_column(String(20), nullable=False)  # overdue|chronic|new|punctual|mixed
    settled_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    on_time_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    overdue_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    past_due_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    worst_overdue_days: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    worst_overdue_number: Mapped[str | None] = mapped_column(String(50), nullable=True)
    # Scored under the company profile (Books `customer_sub_type` = business).
    is_company: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    # Naive UTC, like every other Aito timestamp.
    computed_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
