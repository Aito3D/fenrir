from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text, func
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
    client_is_company: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    # Snapshot of the Zoho quote this project was imported from; NULL on cards
    # created by hand. quote_total is the quote's own total, not the project's.
    quote_id: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)
    quote_number: Mapped[str | None] = mapped_column(String(50), nullable=True)
    quote_date: Mapped[str | None] = mapped_column(String(10), nullable=True)
    quote_total: Mapped[float | None] = mapped_column(Float, nullable=True)
    quote_url: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # The quote's salesperson, snapshotted at import like the other quote
    # fields. NULL on hand-made cards and on projects imported before this
    # column existed — Zoho is never re-queried to backfill.
    quote_salesperson: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # The quote's Zoho status (draft/sent/viewed/accepted/declined/expired) as
    # it stood at import. A snapshot like the rest, which means it can go
    # stale: accepting a quote in Zoho does not update the card. That is the
    # trade for a board that renders with Zoho unreachable and costs no
    # request per card.
    quote_status: Mapped[str | None] = mapped_column(String(30), nullable=True)
    # Username of the webapp user who created the card, snapshotted rather than
    # referenced so it survives that user being renamed or deleted. NULL when
    # auth is disabled, and for API-key requests, which carry no user identity.
    created_by: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
