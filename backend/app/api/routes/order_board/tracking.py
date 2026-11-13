"""Pickup SMS and order tracking routes of the Order Board."""

from datetime import datetime
from typing import Literal

from fastapi import BackgroundTasks, Depends, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.aito import (
    _track_rate_hit,
    _track_rate_limited,
)
from backend.app.api.routes.order_board._common import _by, _logged, _require_order, _run, logger, router
from backend.app.core import database as core_database
from backend.app.core.auth import RequireAdminIfAuthEnabled, RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.models.user import User
from backend.app.services import (
    order_board_actions,
    order_board_sms,
    order_board_tracking,
)
from backend.app.services.aito_events import utc_now_naive
from backend.app.services.order_board_actions._common import _log


@router.get("/orders/{salesorder_id}/sms-draft")
async def get_pickup_sms_draft(
    salesorder_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequireAdminIfAuthEnabled(),
) -> dict:
    """The pickup SMS text for this order, from a fixed template (no AI, no Zoho call). Admins only."""
    return await _run(order_board_sms.draft(db, salesorder_id))


class SmsSentBody(BaseModel):
    # The draft's payment link, sent only when the text that went out still holds its URL.
    payment_link_id: int | None = None


@router.post("/orders/{salesorder_id}/sms")
async def record_pickup_sms(
    salesorder_id: str,
    body: SmsSentBody | None = None,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequireAdminIfAuthEnabled(),
) -> dict:
    """Mark the order as contacted after the browser sent the pickup SMS through the relay on the
    operator's Mac (scripts/sms_relay_mac.py); the server never sends it. Admins only. Returns the row."""
    row = await _run(order_board_actions.stamp_contact(db, salesorder_id, _by(user) or ""))
    link = await db.get(AitoPaymentLink, body.payment_link_id) if body and body.payment_link_id else None
    if link is not None and link.salesorder_id == salesorder_id and link.heimdall_id and link.status == "pending":
        await _log(db, salesorder_id, "payment_link.sent", _by(user), amount=link.amount, document=link.document_number)
    _logged(user, salesorder_id, "pickup_sms")
    return row


# --- The customer's public tracking page ------------------------------------------------------------------------


@router.get("/orders/{salesorder_id}/tracking-link")
async def get_order_tracking_link(
    salesorder_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    """The order's public tracking link, minting its code on first use. ``tracking_url`` is null while the
    external URL setting is empty."""
    await _require_order(db, salesorder_id)
    return {"tracking_url": await order_board_tracking.tracking_url(db, salesorder_id)}


class OrderTrackingLine(BaseModel):
    name: str
    quantity: float
    status: Literal["ready", "preparing", "to_prepare", "waiting", "handed_over"]
    # A day or a naive UTC moment; null when the hand-over day is not known for sure.
    handed_on: str | None


class OrderTrackingCounts(BaseModel):
    """Lines not handed over yet, and how many of them are ready / waiting for stock."""

    open: int
    ready: int
    waiting: int


class OrderTrackingPayment(BaseModel):
    currency: str
    total: int
    paid: int
    left: int


class OrderTrackingResponse(BaseModel):
    """Everything the public page shows, and nothing else: no id, no contact, no price per line, no stock."""

    reference: str
    date: str | None
    state: Literal["received", "preparing", "partly_ready", "ready", "handed_over"]
    stage: Literal["received", "preparing", "ready", "handed_over"]
    lines: list[OrderTrackingLine]
    counts: OrderTrackingCounts
    pickup: bool
    payment: OrderTrackingPayment | None
    pay_url: str | None
    updated_at: datetime


async def _log_tracking_view(salesorder_id: str, now: datetime) -> None:
    """After the response, on its own session: the log never slows nor breaks the page it measures."""
    try:
        async with core_database.async_session() as session:
            await order_board_tracking.log_view(session, salesorder_id, now)
    except Exception:  # noqa: BLE001
        logger.warning("Order board: tracking view log failed for %s", salesorder_id, exc_info=True)


@router.get("/track/{token}", response_model=OrderTrackingResponse)
async def get_order_tracking(
    token: str,
    request: Request,
    response: Response,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db, scope="function"),
) -> dict | JSONResponse:
    """The customer's public tracking page of an order. No auth: the code is the credential, and the auth
    middleware exempts this prefix. Same throttle (and the same buckets) as the Aito cards' page: a miss is
    reserved at arrival and handed back on a hit. Unknown, cancelled and expired all get the same 404."""
    response.headers["Cache-Control"] = "no-store"
    admitted = _track_rate_limited(request)
    if admitted is None:
        return JSONResponse(
            status_code=429,
            content={"detail": "Trop de tentatives"},
            headers={"Cache-Control": "no-store", "Retry-After": "60"},
        )
    now = utc_now_naive()
    try:
        found = await order_board_tracking.compute(db, token, now)
    except BaseException:
        _track_rate_hit(*admitted)  # never answered hit-or-miss: not a guess
        raise
    if found is None:
        # Not HTTPException: its handler would drop the no-store header.
        return JSONResponse(
            status_code=404, content={"detail": "Lien introuvable"}, headers={"Cache-Control": "no-store"}
        )
    _track_rate_hit(*admitted)
    salesorder_id, data = found
    background_tasks.add_task(_log_tracking_view, salesorder_id, now)
    return data


# --- Payments: a payment link or the counter terminal, on the order's invoice or its quote's retainer ---------
