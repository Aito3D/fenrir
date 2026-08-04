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
    board_column: Mapped[str] = mapped_column(String(20), index=True)  # devis|waiting|scan|model|print|finish|done
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
    # When the quote last transitioned INTO 'accepted' — the client's
    # go-ahead. Stamped only by services/aito_quote_status.adopt_quote_status
    # (the sites where an acceptance is news); restore-from-trash deliberately
    # bypasses the helper so an old acceptance is never restamped. Survives a
    # later decline (ignored while the status is not 'accepted'). NULL on
    # cards imported already-accepted and on pre-migration rows without a
    # quote.accepted event: the card's age then falls back to created_at.
    quote_accepted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Username of the webapp user who created the card, snapshotted rather than
    # referenced so it survives that user being renamed or deleted. NULL when
    # auth is disabled, and for API-key requests, which carry no user identity.
    created_by: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # Outbox state for the Zoho push. 'idle' (ours, nothing to do right now —
    # freshly created and not yet quoted, or synced and up to date) |
    # 'pending' (the worker owes this project a write) | 'error' (gave up, see
    # quote_sync_error) | 'locked' (the quote has been invoiced, or the org's
    # tax setting makes further writes unsafe; edits stay local) | 'unmanaged'
    # (a legacy/imported card this feature must never touch — see
    # routes/aito.py:_mark_pending_if_ours, the ONLY state that guard treats
    # as "not ours"). 'pending' with a NULL quote_id means "create the quote".
    quote_sync_state: Mapped[str] = mapped_column(String(20), default="idle", server_default="idle", index=True)
    # True once Books reports the estimate invoiced (is_transaction_created /
    # invoiced_amount > 0). Sticky: an invoice is accounting and does not
    # un-happen. Separate from quote_sync_state == 'locked', which also covers
    # tax-exclusive quotes — the board's "this job is billed, archive it" glow
    # must not fire for those.
    quote_invoiced: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    quote_sync_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    quote_sync_failures: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # The estimate's last_modified_time as Zoho reported it on our last write.
    # Written here, read by the Phase 2 poller to suppress our own echo.
    quote_synced_at: Mapped[str | None] = mapped_column(String(30), nullable=True)
    # quote_status as it stood before the project was trashed, so restoring can
    # put it back. Zoho has no /status/draft, so a quote that was a draft
    # cannot be recovered and this stays the record of what it was.
    quote_status_before_trash: Mapped[str | None] = mapped_column(String(30), nullable=True)
    # Why the reconciler is blocked, if it is. This is the status reconciler's
    # OWN record and no other subsystem's: only aito_quote_sync writes a value
    # here (recorded by the status reconciler, cleared everywhere else via its
    # _clear_block helper), and set_quote_status clears it. That ownership is
    # the whole point: before these existed, the reconciler recorded its state
    # inside quote_sync_error — a field owned by the line-item sync path — and
    # then read that same field back as evidence of what had happened, which
    # produced five defects across four review rounds.
    #   'conflict' — both sides made a decision and they disagree.
    #   'rejected' — Books refused the status push we attempted.
    quote_status_block: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # Books' status at the moment the block was recorded. Our side is simply
    # quote_status, which is always current, because EVERY site that writes
    # quote_status clears both of these in the same breath: set_quote_status
    # (routes/aito.py) inline, and every writer inside aito_quote_sync via its
    # _clear_block helper. Keep that true of any new writer — a block left
    # behind by a status change describes an attempt that no longer exists,
    # and would suppress a push that ought to be retried.
    quote_status_remote: Mapped[str | None] = mapped_column(String(30), nullable=True)
    # The estimate's last_modified_time as it stood when the comment mirror
    # last pulled, and when that pull happened. Read by the mirror's fetch
    # policy (services/aito_quote_sync.py): pull comments only when the
    # watermark has moved, or when the last pull is more than 4 hours old.
    zoho_comments_watermark: Mapped[str | None] = mapped_column(String(30), nullable=True)
    zoho_comments_checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
