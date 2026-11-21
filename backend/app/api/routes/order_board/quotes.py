"""Product quotes (Zoho Books estimates) on the Order Board."""

from fastapi import Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.order_board._common import _by, _logged, _run, router
from backend.app.api.routes.order_board.fulfilment import CounterLine, CounterOrderBody
from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.user import User
from backend.app.services import order_board_actions, order_board_sync


class QuoteLine(CounterLine):
    line_id: str | None = Field(default=None, min_length=1, max_length=64)


class QuoteEditBody(BaseModel):
    customer_id: str = Field(min_length=1, max_length=64)
    lines: list[QuoteLine] = Field(min_length=1, max_length=200)


@router.get("/quotes")
async def get_quotes(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    """The quote rows from the local copy (no Zoho call)."""
    return await order_board_sync.read_quotes(db)


async def _quotes_after(db: AsyncSession, estimate_id: str) -> dict:
    return {"quotes": await order_board_sync.read_quotes(db), "estimate_id": estimate_id}


@router.post("/quotes", status_code=201)
async def create_quote(
    body: CounterOrderBody,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    """A new quote: created as a draft estimate in Books, then stored."""
    estimate_id = await _run(
        order_board_actions.create_quote(
            db,
            body.customer_id,
            [line.model_dump(exclude_none=True) for line in body.lines],
            str(body.client_ref),
            by=_by(user),
        )
    )
    _logged(user, estimate_id, "create_quote")
    return await _quotes_after(db, estimate_id)


@router.put("/quotes/{estimate_id}")
async def edit_quote(
    estimate_id: str,
    body: QuoteEditBody,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    await _run(
        order_board_actions.edit_quote(
            db,
            estimate_id,
            body.customer_id,
            [line.model_dump(exclude_none=True) for line in body.lines],
            by=_by(user),
        )
    )
    _logged(user, estimate_id, "edit_quote")
    return await _quotes_after(db, estimate_id)


@router.post("/quotes/{estimate_id}/decline")
async def decline_quote(
    estimate_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    await _run(order_board_actions.decline_quote(db, estimate_id, by=_by(user)))
    _logged(user, estimate_id, "decline_quote")
    return await _quotes_after(db, estimate_id)


@router.post("/quotes/{estimate_id}/reopen")
async def reopen_quote(
    estimate_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    await _run(order_board_actions.reopen_quote(db, estimate_id, by=_by(user)))
    _logged(user, estimate_id, "reopen_quote")
    return await _quotes_after(db, estimate_id)


async def _quote_order_after(db: AsyncSession, salesorder_id: str) -> dict:
    return {
        "quotes": await order_board_sync.read_quotes(db),
        "board": await order_board_sync.read_board(db),
        "row": await order_board_sync.find_board_row(db, salesorder_id),
        "salesorder_id": salesorder_id,
    }


@router.post("/quotes/{estimate_id}/accept")
async def accept_quote(
    estimate_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    """Mark the quote accepted and create its sales order in Books."""
    salesorder_id = await _run(order_board_actions.accept_quote(db, estimate_id, by=_by(user)))
    _logged(user, estimate_id, "accept_quote")
    return await _quote_order_after(db, salesorder_id)


@router.post("/quotes/{estimate_id}/order")
async def create_order_from_quote(
    estimate_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    """Create the sales order of a quote already accepted."""
    salesorder_id = await _run(order_board_actions.create_order_from_quote(db, estimate_id, by=_by(user)))
    _logged(user, estimate_id, "create_order_from_quote")
    return await _quote_order_after(db, salesorder_id)


class UndoAcceptBody(BaseModel):
    salesorder_id: str = Field(min_length=1, max_length=64)


@router.post("/quotes/{estimate_id}/undo-accept")
async def undo_accept_quote(
    estimate_id: str,
    body: UndoAcceptBody,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    """Delete the quote's new order in Books and mark the quote sent again."""
    await _run(order_board_actions.undo_accept(db, estimate_id, body.salesorder_id, by=_by(user)))
    _logged(user, estimate_id, "undo_accept_quote")
    return {"quotes": await order_board_sync.read_quotes(db), "board": await order_board_sync.read_board(db)}
