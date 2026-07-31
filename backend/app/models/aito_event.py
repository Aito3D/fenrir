from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String, Text, func
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class AitoEvent(Base):
    """One thing that happened to an Aito project, append-only.

    Two timestamps because they answer different questions. ``occurred_at`` is
    when the thing HAPPENED — for a mirrored Zoho comment that is Books'
    timestamp, not ours, which is the whole point of mirroring rather than
    inferring: the poller only knows when it noticed. ``created_at`` is when we
    wrote the row, and exists so a clock disagreement between us and Books is
    diagnosable rather than invisible.

    DEPTH IS NOT STORED HERE. Story/Detail/Everything is derived from ``kind``
    by the registry in services/aito_events.py. Storing it would freeze every
    historical row at the classification it had the day it was written: the
    moment 'task.added' is promoted from Detail to Story, every existing row
    would need a data migration to agree. ``actor_class`` IS stored, because it
    states a fact about the event (who caused it), not a judgment about how to
    show it.

    ``project_id`` is deliberately NOT a foreign key: projects soft-delete and
    their history must outlive a trashing, the same reason ``created_by`` on
    AitoProject is a snapshot rather than a reference.

    ``subject_label`` is likewise a snapshot. "Paul edited Socle" must stay
    true after that task is renamed or deleted.
    """

    __tablename__ = "aito_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(Integer, index=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    # NULL means instantaneous. Set only by the coalescing path, where it marks
    # the end of the window several edits were folded into.
    occurred_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    kind: Mapped[str] = mapped_column(String(40), index=True)
    # 'user' | 'client' | 'system' — drives the timeline's dot colour.
    actor_class: Mapped[str] = mapped_column(String(10))
    # Snapshotted username, or the Zoho contact's name. NULL when auth is
    # disabled, for API-key requests, and for anything the worker did alone.
    actor_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    subject_type: Mapped[str | None] = mapped_column(String(20), nullable=True)  # project|task
    subject_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    subject_label: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # [{"field": "impression_cost", "from": 4200, "to": 5600}]
    changes: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # Kind-specific extras: HTTP status, retry count, amounts, {"cause": "rule"}.
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The mirror's idempotency key. UNIQUE, and nullable so our own events —
    # which is most of them — can all sit here as NULL: SQLite permits any
    # number of NULLs in a unique column.
    zoho_comment_id: Mapped[str | None] = mapped_column(String(50), nullable=True, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    # The read path is always "this project, newest first". id breaks ties so
    # the keyset cursor is stable when several events share a timestamp, which
    # a backfill makes routine rather than rare.
    __table_args__ = (Index("ix_aito_events_project_occurred", "project_id", "occurred_at", "id"),)
