"""One card charge on the Heimdall terminal, started from a project card.

Mirrors `aito_payment_link.py`: a row is a RESERVATION first (`heimdall_id`
NULL, `status` pending) and only becomes a Heimdall payment once the create
was answered — a crash between the two commits is replayed under the same
`idempotency_key` instead of charging twice. `status` is Heimdall's unified
vocabulary; `booking_*` mirrors Heimdall's separate write-back to Zoho Books
and never decides whether the money was taken.
"""

from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class AitoTerminalPayment(Base):
    __tablename__ = "aito_terminal_payments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(Integer, nullable=False)
    # quote | invoice — which Books document Heimdall books the money against.
    document_kind: Mapped[str] = mapped_column(String(10), nullable=False)
    # Zoho's own document id (never the human number) and the number for display.
    document_id: Mapped[str] = mapped_column(String(50), nullable=False)
    document_number: Mapped[str] = mapped_column(String(64), nullable=False)
    # `aito-tpe:{project_id}:{n}`, sent verbatim as Heimdall's Idempotency-Key.
    idempotency_key: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    heimdall_id: Mapped[str | None] = mapped_column(String(36), nullable=True, unique=True)
    # Integer XPF francs: requested, and what the terminal reported taking.
    amount: Mapped[int] = mapped_column(Integer, nullable=False)
    amount_confirmed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending", server_default="pending")
    native_state: Mapped[str | None] = mapped_column(String(30), nullable=True)
    booking_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    booking_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    zoho_payment_id: Mapped[str | None] = mapped_column(String(50), nullable=True)
    sync_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    settled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("ix_aito_terminal_payments_project_id", "project_id"),
        Index("ix_aito_terminal_payments_status", "status"),
    )
