"""One OSB payment link minted through Heimdall for an Aito quote.

A ledger, not a cache: a row is written BEFORE the create call (a
reservation, ``heimdall_id`` NULL) so a crash between the POST and the commit
can be retried with the same ``idempotency_key`` — Heimdall replays it rather
than minting a second link. The project's CURRENT link is the newest row with
``superseded_at`` NULL; a replaced link (expired, cancelled, refused while the
quote was still open) keeps its row as history. Spec:
docs/superpowers/specs/2026-09-12-aito-heimdall-payment-links-design.md §3.1.
"""

from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class AitoPaymentLink(Base):
    __tablename__ = "aito_payment_links"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(Integer, nullable=False)
    # `aito:{project_id}:{n}`, sent verbatim as Heimdall's Idempotency-Key.
    idempotency_key: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    # NULL while the create is in flight. Many NULLs may coexist under the
    # unique index (SQLite and Postgres both allow it) — that is what makes
    # a reservation representable at all.
    heimdall_id: Mapped[str | None] = mapped_column(String(36), nullable=True, unique=True)
    reference: Mapped[str] = mapped_column(String(64), nullable=False)
    # Integer XPF francs — what Heimdall holds.
    amount: Mapped[int] = mapped_column(Integer, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="XPF", server_default="XPF")
    # ISO calendar day the link ends (Heimdall closes it at 23:59:59.999 UTC).
    expires_on: Mapped[str] = mapped_column(String(10), nullable=False)
    url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Heimdall's unified status: pending | paid | failed | cancelled | expired.
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending", server_default="pending")
    paid_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    sync_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    sync_failures: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("ix_aito_payment_links_project_id", "project_id"),
        Index("ix_aito_payment_links_status", "status"),
    )
