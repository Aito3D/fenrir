"""Product quotes (Zoho Books estimates) on the Order Board."""

from datetime import datetime
from typing import Literal

from fastapi import Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.aito import _check_zoho_email_rate_limit
from backend.app.api.routes.order_board._common import (
    _by,
    _guarded_email,
    _logged,
    _pdf,
    _run,
    _with_default_email,
    router,
)
from backend.app.api.routes.order_board.board import OrderEventPage, events_page
from backend.app.api.routes.order_board.documents import DocumentEmailBody
from backend.app.api.routes.order_board.fulfilment import CounterLine, CounterOrderBody
from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.user import User
from backend.app.services import order_board_actions, order_board_sync
from backend.app.services.zoho import ZohoAmbiguous, ZohoUnreachable


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


@router.get("/quotes/{estimate_id}/pdf")
async def get_quote_pdf(
    estimate_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> Response:
    pdf, number = await _run(order_board_actions.quote_pdf(db, estimate_id))
    return _pdf(pdf, f"{number}.pdf")


@router.get("/quotes/{estimate_id}/email")
async def get_quote_email(
    estimate_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    """What Books would email for the quote; its first offered address is preselected."""
    return _with_default_email(await _run(order_board_actions.quote_email_content(db, estimate_id)), None)


@router.post("/quotes/{estimate_id}/email")
async def send_quote_email(
    estimate_id: str,
    body: DocumentEmailBody,
    request: Request,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    """Email the quote through Books, only to an address Books offers for it; Books marks it sent."""
    _check_zoho_email_rate_limit(request, user)
    content = await _run(order_board_actions.quote_email_content(db, estimate_id))  # 404 before any send
    to = body.to.strip()
    # Re-read, never taken from the request: otherwise any holder of orders:update could mail anyone.
    await _guarded_email(
        "quote",
        estimate_id,
        to,
        content,
        "That address is not a recipient of this quote",
        lambda: order_board_actions.email_quote(db, estimate_id, to, by=_by(user)),
        db=db,
        salesorder_id=estimate_id,
        doc_kind="estimate",
        keep_armed=(ZohoUnreachable, ZohoAmbiguous),
    )
    _logged(user, estimate_id, "email_quote")
    return await _quotes_after(db, estimate_id)


@router.get("/quotes/{estimate_id}/events", response_model=OrderEventPage)
async def list_quote_events(
    estimate_id: str,
    depth: Literal["story", "detail", "everything"] = "detail",
    before: int | None = None,
    before_at: datetime | None = None,
    limit: int = 50,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> OrderEventPage:
    """The quote's timeline, newest first; paged as the order's."""
    if await order_board_sync.find_quote(db, estimate_id) is None:
        raise HTTPException(status_code=404, detail="Quote not found.")
    return await events_page(db, estimate_id, depth, before, before_at, limit)
