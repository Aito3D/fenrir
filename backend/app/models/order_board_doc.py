"""Everything the Order Board stores, in one table.

``salesorder`` / ``purchaseorder`` / ``item`` rows are a local copy of Zoho
Books documents (``header`` = the list row, ``detail`` = the full document
once fetched; an item keeps its whole document in ``header``). The single
``("state", "board")`` row keeps the computed board and the sync status in
``detail``. The copy is disposable: delete the rows and the next passes
rebuild it from Books.
"""

from sqlalchemy import Boolean, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from backend.app.core.database import Base


class OrderBoardDoc(Base):
    __tablename__ = "order_board_docs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    zoho_id: Mapped[str] = mapped_column(String(64), nullable=False)
    header: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # A candidate whose detail is missing or older than its header.
    pending: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    __table_args__ = (UniqueConstraint("kind", "zoho_id", name="uq_order_board_docs_kind_zoho_id"),)
